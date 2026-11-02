import { timingSafeEqual } from 'node:crypto';
import { decryptBackup, encryptBackup, invariant, MAX_BYTES, RECOVERY_PROJECT, restoreReadModel, validateBackup } from './reservation-backup.js';

export interface BackupStore {
  assertPrivate(): Promise<void>;
  list(): Promise<{ name: string; size: number }[]>;
  get(name: string): Promise<Buffer>;
  create(name: string, bytes: Buffer): Promise<void>;
  remove(names: string[]): Promise<void>;
}
export const BUCKET = 'reservation-backups';
const namePattern = /^\d{4}-\d{2}-\d{2}\.rms$/;
export function backupDay(date: Date): string {
  return new Date(date.getTime() + 9 * 3600000).toISOString().slice(0, 10);
}
/** Never removes an old success to make room for an unverified new backup. */
export async function saveReservationBackup(input: unknown, key: Buffer, store: BackupStore, now = new Date()) {
  const data = validateBackup(input);
  const day = backupDay(now); const name = `${day}.rms`;
  invariant(backupDay(new Date(data.capturedAt)) === day && Math.abs(now.getTime() - Date.parse(data.capturedAt)) <= 5 * 60000);
  await store.assertPrivate();
  const entries = await store.list();
  invariant(entries.length < 1000 && new Set(entries.map(e => e.name)).size === entries.length);
  invariant(entries.every(e => namePattern.test(e.name) && Number.isSafeInteger(e.size) && e.size > 36 && e.size <= MAX_BYTES + 36));
  let packet: Buffer;
  let reused = false;
  if (entries.some(e => e.name === name)) { packet = await store.get(name); reused = true; }
  else {
    packet = encryptBackup(restoreReadModel(data, now), key);
    invariant(entries.reduce((n, e) => n + e.size, 0) + packet.length <= 800 * 1024 * 1024, 'RESERVATION_BACKUP_CAPACITY');
    // Immutable create; ambiguous upload errors deliberately do not cause deletion.
    await store.create(name, packet);
    const readback = await store.get(name);
    invariant(readback.length === packet.length && timingSafeEqual(readback, packet), 'RESERVATION_BACKUP_READBACK_FAILED');
  }
  const verified = decryptBackup(packet, key);
  invariant(backupDay(new Date(verified.capturedAt)) === day);
  const recovered = restoreReadModel(verified, now);
  // Prior snapshots must authenticate and match their immutable names before cleanup.
  const expired: string[] = [];
  for (const entry of entries) {
    if (entry.name === name) continue;
    const date = entry.name.slice(0, 10);
    invariant(date <= day);
    if (Date.parse(`${date}T00:00:00+09:00`) + 16 * 86400000 <= now.getTime()) {
      const old = decryptBackup(await store.get(entry.name), key);
      invariant(backupDay(new Date(old.capturedAt)) === date);
      expired.push(entry.name);
    }
  }
  if (expired.length) await store.remove(expired);
  return { status: reused ? 'verified-existing' : 'verified-new', day,
    reservationCount: recovered.tables.reservations.length, expiredCount: expired.length };
}

/** Exact recovery origin; no public URL, redirects, provider body or token logs. */
export function createBackupStore(token: string, fetcher: typeof fetch = fetch): BackupStore {
  invariant(token.length > 20 && !/[\r\n]/.test(token), 'RESERVATION_BACKUP_CONFIG_INVALID');
  const origin = `https://${RECOVERY_PROJECT}.supabase.co/storage/v1`;
  async function request(path: string, method = 'GET', body?: string | Buffer, limit = MAX_BYTES + 36) {
    const response = await fetcher(`${origin}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(60000),
      headers: { apikey: token, Authorization: `Bearer ${token}`,
        'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'x-upsert': 'false' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Uint8Array(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('RESERVATION_BACKUP_STORAGE_FAILED'); }
    const reader = response.body?.getReader(); invariant(reader);
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.byteLength; invariant(size <= limit, 'RESERVATION_BACKUP_RESPONSE_TOO_LARGE'); parts.push(chunk.value); }
      return Buffer.concat(parts);
    } finally { await reader.cancel(); }
  }
  const safeName = (name: string) => { invariant(namePattern.test(name)); return name; };
  return {
    async assertPrivate() {
      const bucket = JSON.parse((await request(`/bucket/${BUCKET}`, 'GET', undefined, 65536)).toString());
      invariant(bucket.id === BUCKET && bucket.public === false, 'RESERVATION_BACKUP_BUCKET_NOT_PRIVATE');
    },
    async list() {
      const rows = JSON.parse((await request(`/object/list/${BUCKET}`, 'POST', JSON.stringify({ prefix: '', limit: 1000, offset: 0,
        sortBy: { column: 'name', order: 'asc' } }), 1024 * 1024)).toString());
      invariant(Array.isArray(rows));
      return rows.map(row => ({ name: row.name, size: row.metadata?.size }));
    },
    get: name => request(`/object/${BUCKET}/${safeName(name)}`),
    async create(name, bytes) { await request(`/object/${BUCKET}/${safeName(name)}`, 'POST', bytes, 65536); },
    async remove(names) { await request(`/object/${BUCKET}`, 'DELETE', JSON.stringify({ prefixes: names.map(safeName) }), 1024 * 1024); },
  };
}
