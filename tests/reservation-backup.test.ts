import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptBackup, encryptBackup, restoreReadModel, SNAPSHOT_SQL, SOURCE_PROJECT, validateBackup,
  type ReservationBackup } from '../scripts/lib/reservation-backup.js';
import { backupDay, createBackupStore, saveReservationBackup, type BackupStore } from '../scripts/lib/reservation-backup-storage.js';
import { sourceEnvironment } from '../scripts/lib/reservation-backup-source.js';

const id = (n: number) => `12000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const now = new Date('2026-10-24T18:00:00.000Z');
function fixture(): ReservationBackup {
  const date = '2026-10-24T00:00:00Z';
  return { format: 'rms-reservations-v1', sourceProject: SOURCE_PROJECT, capturedAt: now.toISOString(), tables: {
    rooms: [{ id: id(1), room_number: '142' }],
    reservations: [{ id: id(2), room_id: id(1), reservation_type: 'long_stay', check_in_at: date, check_out_at: null,
      guest_count: 2, status: 'active', guest_name_encrypted: null, version: '9007199254740993', actual_check_in_at: date,
      actual_checkout_at: null, cancelled_at: null, created_by: id(90), updated_by: id(90), created_at: date, updated_at: date }],
    stays: [{ id: id(3), reservation_id: id(2), reservation_type: 'long_stay', status: 'active', scheduled_check_in_at: date,
      scheduled_check_out_at: null, actual_check_in_at: date, actual_checkout_at: null, version: '1', created_at: date, updated_at: date }],
    segments: [{ id: id(4), stay_id: id(3), room_id: id(1), starts_at: date, ends_at: null,
      source_reservation_id: id(2), move_event_id: null, retired_at: null, terminal_reason_code: null, version: '1', created_at: date, updated_at: date }],
    schedules: [{ id: id(6), reservation_id: id(2), version: '1', room_id: id(1), reservation_type: 'long_stay',
      check_in_at: date, check_out_at: null, guest_count: 2, reason_code: 'CREATED', actor_profile_id: id(90), effective_at: date, recorded_at: date }],
    moves: [], occupancy: [], corrections: [],
  } };
}
class MemoryStore implements BackupStore {
  files = new Map<string, Buffer>();
  removed: string[] = [];
  failUpload = false;
  corruptRead = false;
  publicBucket = false;
  async assertPrivate() { if (this.publicBucket) throw new Error('public'); }
  async list() { return [...this.files].map(([name, data]) => ({ name, size: data.length })); }
  async get(name: string) { const bytes = this.files.get(name); if (!bytes) throw new Error('missing');
    return this.corruptRead ? Buffer.from('corrupt') : Buffer.from(bytes); }
  async create(name: string, bytes: Buffer) { if (this.failUpload || this.files.has(name)) throw new Error('upload'); this.files.set(name, Buffer.from(bytes)); }
  async remove(names: string[]) { this.removed.push(...names); for (const name of names) this.files.delete(name); }
}
describe('reservation-only backup', () => {
  it('round-trips encrypted archive and exact bigint without exposing plaintext', () => {
    const key = randomBytes(32); const data = fixture(); const packet = encryptBackup(data, key);
    expect(packet.subarray(0, 8).toString()).toBe('RMSRES01');
    expect(decryptBackup(packet, key)).toEqual(data);
    expect(decryptBackup(packet, key).tables.reservations[0]?.version).toBe('9007199254740993');
    expect(encryptBackup(data, key).equals(packet)).toBe(false);
  });
  it('rejects modified ciphertext/tag/header and wrong key without leaked details', () => {
    const key = randomBytes(32); const packet = encryptBackup(fixture(), key);
    for (const offset of [0, 15, 25, packet.length - 1]) {
      const changed = Buffer.from(packet); changed[offset] = (changed[offset] ?? 0) ^ 1;
      expect(() => decryptBackup(changed, key)).toThrow('RESERVATION_BACKUP_INVALID');
    }
    expect(() => decryptBackup(packet, randomBytes(32))).toThrow('RESERVATION_BACKUP_INVALID');
  });
  it('rejects extra fields, omitted fields, wrong types, duplicate identities, and orphans', () => {
    const cases = [
      (v: ReturnType<typeof fixture>) => Object.assign(v.tables.reservations[0] ?? {}, { pin: 'forbidden' }),
      (v: ReturnType<typeof fixture>) => { v.tables.rooms = []; },
      (v: ReturnType<typeof fixture>) => { v.tables.reservations.push(structuredClone(v.tables.reservations[0]!)); },
      (v: ReturnType<typeof fixture>) => { v.tables.segments[0]!.source_reservation_id = id(50); },
      (v: ReturnType<typeof fixture>) => { v.tables.reservations[0]!.version = '9223372036854775808'; },
      (v: ReturnType<typeof fixture>) => { v.tables.reservations[0]!.check_in_at = '2026-02-30T00:00:00Z'; },
      (v: ReturnType<typeof fixture>) => { v.tables.stays = []; v.tables.segments = []; },
      (v: ReturnType<typeof fixture>) => { v.tables.schedules = []; },
      (v: ReturnType<typeof fixture>) => { v.tables.segments = []; },
    ];
    for (const change of cases) { const data = fixture(); change(data); expect(() => validateBackup(data)).toThrow(); }
    const data = fixture(); const raw = JSON.parse(JSON.stringify(data)); delete raw.tables.rooms;
    expect(() => validateBackup(raw)).toThrow();
  });
  it('allows zero-length and adjacent history but rejects overlapping active segments', () => {
    const data = fixture(); const first = data.tables.segments[0]!;
    data.tables.segments.push({ ...first, id: id(5), ends_at: first.starts_at });
    expect(() => validateBackup(data)).not.toThrow();
    data.tables.segments[1]!.ends_at = null;
    expect(() => validateBackup(data)).toThrow();
    first.ends_at = '2026-10-25T00:00:00Z'; data.tables.segments[1]!.starts_at = first.ends_at;
    expect(() => validateBackup(data)).not.toThrow();
  });
  it('restores only a read model and does not resurrect expired guest PII', () => {
    const data = fixture(); const r = data.tables.reservations[0]!;
    r.status = 'checked_out'; r.actual_checkout_at = '2026-01-01T00:00:00Z';
    r.guest_name_encrypted = JSON.stringify({ version: 1, keyVersion: 'synthetic', iv: Buffer.alloc(12).toString('base64'),
      tag: Buffer.alloc(16).toString('base64'), ciphertext: Buffer.from('synthetic').toString('base64') });
    expect(restoreReadModel(data, now).tables.reservations[0]?.guest_name_encrypted).toBeNull();
    expect(data.tables.reservations[0]?.guest_name_encrypted).not.toBeNull();
  });
  it('preserves microsecond occupancy overlap checks', () => {
    const data = fixture(); const s = data.tables.segments[0]!;
    s.starts_at = '2026-10-24T00:00:00.000001Z'; s.ends_at = '2026-10-24T00:00:00.000003Z';
    data.tables.segments.push({ ...s, id: id(5), starts_at: '2026-10-24T00:00:00.000002Z' });
    expect(() => validateBackup(data)).toThrow();
    data.tables.segments[1]!.starts_at = s.ends_at;
    expect(() => validateBackup(data)).not.toThrow();
  });
  it('permits pre-stay-ledger cancelled history but requires active reservation provenance', () => {
    const data = fixture(); data.tables.reservations[0]!.status = 'cancelled';
    data.tables.stays = []; data.tables.segments = [];
    expect(() => validateBackup(data)).not.toThrow();
    data.tables.reservations[0]!.status = 'active';
    expect(() => validateBackup(data)).toThrow();
  });
  it('uses fixed read-only snapshot and excludes authentication, PIN, photos and arbitrary JSON', () => {
    expect(SNAPSHOT_SQL).toContain('REPEATABLE READ READ ONLY');
    expect(SNAPSHOT_SQL).toContain('private.stay_room_segments');
    expect(SNAPSHOT_SQL).not.toMatch(/auth\.|room_pin|photo_|payroll|before_state|after_state|SELECT \*/);
    expect(SNAPSHOT_SQL).toContain('version::text');
  });
  it('restricts source to production project, session port and full TLS verification', () => {
    const connection = new URL(`postgresql://db.${SOURCE_PROJECT}.supabase.co:5432/postgres`);
    connection.username = 'postgres'; connection.password = 'synthetic'; const valid = connection.toString();
    expect(sourceEnvironment(valid, '/cert.pem').PGSSLMODE).toBe('verify-full');
    for (const url of [valid.replace(SOURCE_PROJECT, 'aaaaaaaaaaaaaaaaaaaa'), `${valid}?sslmode=disable`, valid.replace(':5432', ':6543'), valid.replace('/postgres', '/other')]) {
      expect(() => sourceEnvironment(url, '/cert.pem')).toThrow();
    }
    expect(sourceEnvironment(valid, '/cert.pem')).not.toHaveProperty('SUPABASE_SERVICE_ROLE_KEY');
  });
  it('uploads once, verifies readback, and safely replays the same KST day', async () => {
    const key = randomBytes(32); const store = new MemoryStore();
    expect(backupDay(now)).toBe('2026-10-25');
    expect((await saveReservationBackup(fixture(), key, store, now)).status).toBe('verified-new');
    const before = Buffer.from(store.files.get('2026-10-25.rms')!);
    expect((await saveReservationBackup(fixture(), key, store, now)).status).toBe('verified-existing');
    expect(store.files.get('2026-10-25.rms')).toEqual(before);
  });
  it.each(['failUpload', 'corruptRead', 'publicBucket'] as const)('preserves prior success on %s', async flag => {
    const key = randomBytes(32); const store = new MemoryStore(); const old = fixture(); old.capturedAt = '2026-10-01T18:00:00Z';
    const oldBytes = encryptBackup(old, key); store.files.set('2026-10-02.rms', oldBytes); store[flag] = true;
    await expect(saveReservationBackup(fixture(), key, store, now)).rejects.toThrow();
    expect(store.removed).toEqual([]); expect(store.files.get('2026-10-02.rms')).toEqual(oldBytes);
  });
  it('cleans expired authenticated archives only after new success and preserves recent ones', async () => {
    const key = randomBytes(32); const store = new MemoryStore();
    for (const date of ['2026-10-01', '2026-10-20']) {
      const old = fixture(); old.capturedAt = `${date}T00:00:00Z`; store.files.set(`${date}.rms`, encryptBackup(old, key));
    }
    await saveReservationBackup(fixture(), key, store, now);
    expect(store.removed).toEqual(['2026-10-01.rms']); expect(store.files.has('2026-10-20.rms')).toBe(true);
  });
  it('rejects public storage and does not echo provider errors', async () => {
    const store = createBackupStore('synthetic-token-for-testing-only', async () => new Response(JSON.stringify({ id: 'reservation-backups', public: true })));
    await expect(store.assertPrivate()).rejects.toThrow('RESERVATION_BACKUP_BUCKET_NOT_PRIVATE');
    const bad = createBackupStore('synthetic-token-for-testing-only', async () => new Response('private-provider-body', { status: 403 }));
    await expect(bad.assertPrivate()).rejects.toThrow('RESERVATION_BACKUP_STORAGE_FAILED');
  });
  it('refuses malformed old archive deletion, stale capture and forged storage paths', async () => {
    const key = randomBytes(32); const store = new MemoryStore();
    store.files.set('2026-10-01.rms', Buffer.alloc(100));
    await expect(saveReservationBackup(fixture(), key, store, now)).rejects.toThrow();
    expect(store.removed).toEqual([]);
    const stale = fixture(); stale.capturedAt = '2026-10-01T00:00:00Z';
    await expect(saveReservationBackup(stale, key, new MemoryStore(), now)).rejects.toThrow();
    const badPath = new MemoryStore(); badPath.files.set('../production.rms', Buffer.alloc(100));
    await expect(saveReservationBackup(fixture(), key, badPath, now)).rejects.toThrow();
    expect(badPath.files.size).toBe(1);
  });
});
