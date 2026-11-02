import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

export const SOURCE_PROJECT = 'aodikrxcczbogjpsjwjt';
export const RECOVERY_PROJECT = 'matalcofimnhuzslfhdd';
export const MAX_BYTES = 32 * 1024 * 1024;
const uuid = z.string().uuid();
const time = z.iso.datetime({ offset: true }).max(40).refine(v => (v.match(/\.(\d+)/)?.[1]?.length ?? 0) <= 6);
// PostgreSQL timestamps have microsecond precision; Date.parse alone truncates it.
const instant = (v: string) => BigInt(Date.parse(v.replace(/\.\d+/, ''))) * 1000n
  + BigInt((v.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0'));
const version = z.string().regex(/^[1-9]\d{0,18}$/).refine(v => BigInt(v) <= 9223372036854775807n);
const code = z.string().regex(/^[A-Z0-9_]{1,80}$/);
const type = z.enum(['standard', 'long_stay']);
const piiEnvelope = z.strictObject({ version: z.literal(1), keyVersion: z.string().min(1).max(256),
  iv: z.string().base64().refine(v => Buffer.from(v, 'base64').length === 12),
  tag: z.string().base64().refine(v => Buffer.from(v, 'base64').length === 16),
  ciphertext: z.string().base64().min(4).max(4096) });
const guestCipher = z.string().max(16384).refine(v => {
  try { return piiEnvelope.safeParse(JSON.parse(v)).success; } catch { return false; }
}).nullable();
const fields = {
  rooms: { id: uuid, room_number: z.string().min(1).max(30) },
  reservations: {
    id: uuid, room_id: uuid, reservation_type: type, check_in_at: time, check_out_at: time.nullable(),
    guest_count: z.number().int().positive(), status: z.enum(['active', 'cancelled', 'checked_out']),
    guest_name_encrypted: guestCipher, version,
    actual_check_in_at: time.nullable(), actual_checkout_at: time.nullable(), cancelled_at: time.nullable(),
    created_by: uuid, updated_by: uuid, created_at: time, updated_at: time,
  },
  schedules: { id: uuid, reservation_id: uuid, version, room_id: uuid, reservation_type: type,
    check_in_at: time, check_out_at: time.nullable(), guest_count: z.number().int().positive(),
    reason_code: code, actor_profile_id: uuid, effective_at: time, recorded_at: time },
  stays: { id: uuid, reservation_id: uuid, reservation_type: type,
    status: z.enum(['scheduled', 'active', 'completed', 'cancelled']), scheduled_check_in_at: time,
    scheduled_check_out_at: time.nullable(), actual_check_in_at: time.nullable(), actual_checkout_at: time.nullable(),
    version, created_at: time, updated_at: time },
  segments: { id: uuid, stay_id: uuid, room_id: uuid, starts_at: time, ends_at: time.nullable(),
    source_reservation_id: uuid, move_event_id: uuid.nullable(), retired_at: time.nullable(),
    terminal_reason_code: code.nullable(), version, created_at: time, updated_at: time },
  moves: { id: uuid, reservation_id: uuid, stay_id: uuid.nullable(), from_room_id: uuid, to_room_id: uuid,
    effective_at: time, mode: z.enum(['BEFORE_CHECKIN', 'DURING_STAY']), reason_code: code,
    actor_profile_id: uuid, reservation_version: version, source_room_version: version, target_room_version: version,
    created_at: time },
  occupancy: { id: uuid, room_id: uuid, reservation_id: uuid, event_type: z.string().regex(/^[a-z_]{1,80}$/),
    effective_at: time, recorded_at: time, actor_profile_id: uuid, reason_code: code },
  corrections: { id: uuid, room_id: uuid, reservation_id: uuid, stay_id: uuid,
    replaced_segment_id: uuid.nullable(), successor_segment_id: uuid.nullable(), occupied: z.boolean(),
    effective_at: time, actor_profile_id: uuid, reason_code: code, room_state_version: version, recorded_at: time },
};
const schema = z.strictObject({ format: z.literal('rms-reservations-v1'), sourceProject: z.literal(SOURCE_PROJECT),
  capturedAt: time, tables: z.strictObject({
    rooms: z.array(z.strictObject(fields.rooms)).max(100000),
    reservations: z.array(z.strictObject(fields.reservations)).max(100000),
    schedules: z.array(z.strictObject(fields.schedules)).max(100000),
    stays: z.array(z.strictObject(fields.stays)).max(100000),
    segments: z.array(z.strictObject(fields.segments)).max(100000),
    moves: z.array(z.strictObject(fields.moves)).max(100000),
    occupancy: z.array(z.strictObject(fields.occupancy)).max(100000),
    corrections: z.array(z.strictObject(fields.corrections)).max(100000),
  }) });
export type ReservationBackup = z.infer<typeof schema>;
export function invariant(ok: unknown, code = 'RESERVATION_BACKUP_INVALID'): asserts ok {
  if (!ok) throw new Error(code);
}
const sources = { rooms: 'public.rooms', reservations: 'public.reservations',
  schedules: 'public.reservation_schedule_revisions', stays: 'private.reservation_stays',
  segments: 'private.stay_room_segments', moves: 'private.reservation_room_move_events',
  occupancy: 'public.room_occupancy_events', corrections: 'private.room_occupancy_corrections' };
// Static identifiers only, no caller-supplied SQL; bigint identities stay decimal strings.
export const SNAPSHOT_SQL = `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='60s'; SET LOCAL lock_timeout='5s'; SET LOCAL timezone='UTC';
SELECT jsonb_build_object('format','rms-reservations-v1','sourceProject','${SOURCE_PROJECT}',
 'capturedAt',transaction_timestamp(),'tables',jsonb_build_object(${Object.entries(fields).map(([name, shape]) =>
  `'${name}',(SELECT coalesce(jsonb_agg(row ORDER BY id),'[]'::jsonb) FROM (SELECT ${Object.keys(shape).map(key =>
    key === 'version' || key.endsWith('_version') ? `${key}::text AS ${key}` : key === 'room_number' ? `${key}::text AS ${key}` : key
  ).join(',')} FROM ${sources[name as keyof typeof sources]} LIMIT 100001) row)`
).join(',')}));
ROLLBACK;`;

export function validateBackup(input: unknown): ReservationBackup {
  const parsed = schema.safeParse(input);
  invariant(parsed.success);
  const data = parsed.data;
  const t = data.tables;
  const reservationMap = new Map(t.reservations.map(r => [r.id, r]));
  const stayMap = new Map(t.stays.map(r => [r.id, r]));
  const moveMap = new Map(t.moves.map(r => [r.id, r]));
  const segmentMap = new Map(t.segments.map(r => [r.id, r]));
  const maps = Object.fromEntries(Object.entries(t).map(([name, rows]) => {
    const map = new Map(rows.map(row => [row.id, row]));
    invariant(map.size === rows.length);
    return [name, map];
  }));
  invariant(new Set(t.rooms.map(r => r.room_number)).size === t.rooms.length);
  const room = (id: string) => invariant(maps.rooms?.has(id));
  const reservation = (id: string) => { const row = reservationMap.get(id); invariant(row); return row; };
  const stay = (id: string, res: string) => { const row = stayMap.get(id); invariant(row?.reservation_id === res); return row; };
  invariant(new Set(t.stays.map(r => r.reservation_id)).size === t.stays.length);
  invariant(new Set(t.schedules.map(r => `${r.reservation_id}/${r.version}`)).size === t.schedules.length);
  const scheduled = new Set(t.schedules.map(r => r.reservation_id));
  const stayed = new Set(t.stays.map(r => r.reservation_id));
  const segmented = new Set(t.segments.map(r => r.stay_id));
  const interval = (start: string, end: string | null, kind: string) => invariant(
    end === null ? kind === 'long_stay' : instant(end) > instant(start));
  for (const r of t.reservations) {
    room(r.room_id);
    interval(r.check_in_at, r.check_out_at, r.reservation_type);
    invariant(scheduled.has(r.id));
    if (r.status === 'active') invariant(stayed.has(r.id));
  }
  for (const r of t.schedules) {
    const parent = reservation(r.reservation_id); room(r.room_id);
    invariant(parent.reservation_type === r.reservation_type);
    interval(r.check_in_at, r.check_out_at, r.reservation_type);
  }
  for (const r of t.stays) {
    invariant(reservation(r.reservation_id).reservation_type === r.reservation_type && segmented.has(r.id));
    interval(r.scheduled_check_in_at, r.scheduled_check_out_at, r.reservation_type);
  }
  for (const r of t.moves) {
    reservation(r.reservation_id); room(r.from_room_id); room(r.to_room_id);
    invariant(r.from_room_id !== r.to_room_id && (r.mode !== 'DURING_STAY' || r.stay_id !== null));
    if (r.stay_id !== null) stay(r.stay_id, r.reservation_id);
  }
  for (const r of t.segments) {
    const res = reservation(r.source_reservation_id); stay(r.stay_id, res.id); room(r.room_id);
    invariant(r.ends_at === null ? res.reservation_type === 'long_stay' : instant(r.ends_at) >= instant(r.starts_at));
    if (r.move_event_id !== null) {
      const move = moveMap.get(r.move_event_id); invariant(move?.reservation_id === res.id && move.stay_id === r.stay_id);
    }
  }
  for (const r of t.occupancy) { reservation(r.reservation_id); room(r.room_id); }
  for (const r of t.corrections) {
    reservation(r.reservation_id); stay(r.stay_id, r.reservation_id); room(r.room_id);
    for (const id of [r.replaced_segment_id, r.successor_segment_id]) if (id !== null) {
      const segment = segmentMap.get(id); invariant(segment?.stay_id === r.stay_id && segment.room_id === r.room_id);
    }
  }
  // Half-open ranges: a zero-length historic segment occupies no time.
  for (const groupBy of ['room_id', 'stay_id'] as const) {
    const groups = new Map<string, typeof t.segments>();
    for (const s of t.segments.filter(s => s.retired_at === null && (s.ends_at === null || instant(s.starts_at) !== instant(s.ends_at)))) {
      const group = groups.get(s[groupBy]) ?? []; group.push(s); groups.set(s[groupBy], group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => instant(a.starts_at) < instant(b.starts_at) ? -1 : instant(a.starts_at) > instant(b.starts_at) ? 1 : 0);
      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1]; const next = group[i]; invariant(prev && next);
        invariant(prev.ends_at !== null && instant(prev.ends_at) <= instant(next.starts_at));
      }
    }
  }
  return data;
}

/** Separate read model, never INSERT into business tables or recreate Auth/cleaning. */
export function restoreReadModel(input: unknown, now = new Date()): ReservationBackup {
  const data = validateBackup(input);
  for (const r of data.tables.reservations) {
    const anchor = r.status === 'cancelled' ? r.cancelled_at : r.actual_checkout_at;
    if (anchor && instant(anchor) + 180n * 86400000000n <= BigInt(now.getTime()) * 1000n) r.guest_name_encrypted = null;
  }
  return data;
}
const magic = Buffer.from('RMSRES01');
export function encryptBackup(input: unknown, key: Buffer): Buffer {
  invariant(key.length === 32, 'RESERVATION_BACKUP_KEY_INVALID');
  const plain = Buffer.from(JSON.stringify(validateBackup(input)));
  invariant(plain.length <= MAX_BYTES, 'RESERVATION_BACKUP_TOO_LARGE');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(magic);
  try { return Buffer.concat([magic, nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]); }
  finally { plain.fill(0); }
}
export function decryptBackup(packet: Buffer, key: Buffer): ReservationBackup {
  invariant(packet.length > 36 && packet.length <= MAX_BYTES + 36 && packet.subarray(0, 8).equals(magic));
  invariant(key.length === 32, 'RESERVATION_BACKUP_KEY_INVALID');
  let plain: Buffer | undefined;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, packet.subarray(8, 20));
    decipher.setAAD(magic); decipher.setAuthTag(packet.subarray(-16));
    plain = Buffer.concat([decipher.update(packet.subarray(20, -16)), decipher.final()]);
    return validateBackup(JSON.parse(plain.toString('utf8')));
  } catch { throw new Error('RESERVATION_BACKUP_INVALID'); }
  finally { plain?.fill(0); }
}
