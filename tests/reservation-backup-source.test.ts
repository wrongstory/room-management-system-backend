import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
import { readReservationSnapshot } from '../scripts/lib/reservation-backup-source.js';
import { SNAPSHOT_SQL, SOURCE_PROJECT } from '../scripts/lib/reservation-backup.js';

function child() {
  const emitter = new EventEmitter();
  const process = Object.assign(emitter, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(),
    kill: vi.fn(() => { queueMicrotask(() => emitter.emit('close', null)); return true; }) });
  mocks.spawn.mockReturnValue(process);
  return process;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('bounded read-only backup process', () => {
  it('passes credentials in environment, fixed SQL on stdin and never as CLI arguments', async () => {
    const proc = child(); let sql = ''; proc.stdin.on('data', value => { sql += value.toString(); });
    const pending = readReservationSnapshot({ PGPASSWORD: 'synthetic-password' });
    proc.stdout.write(JSON.stringify({ format: 'rms-reservations-v1', sourceProject: SOURCE_PROJECT,
      capturedAt: '2026-10-24T00:00:00Z', tables: { rooms: [], reservations: [], schedules: [], stays: [], segments: [], moves: [], occupancy: [], corrections: [] } }));
    proc.emit('close', 0);
    expect((await pending).tables.reservations).toEqual([]);
    expect(sql).toBe(SNAPSHOT_SQL);
    expect(mocks.spawn.mock.calls[0]?.[1]).toEqual(['-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1']);
    expect(JSON.stringify(mocks.spawn.mock.calls[0]?.[1])).not.toContain('synthetic-password');
  });
  it('suppresses SQL error text and rejects failed or malformed output', async () => {
    let proc = child(); let pending = readReservationSnapshot({});
    proc.stderr.write('sensitive SQL detail'); proc.emit('close', 1);
    await expect(pending).rejects.toThrow('RESERVATION_BACKUP_SOURCE_FAILED');
    proc = child(); pending = readReservationSnapshot({});
    proc.stdout.write('private malformed output'); proc.emit('close', 0);
    await expect(pending).rejects.toThrow('RESERVATION_BACKUP_SOURCE_INVALID');
  });
  it('kills and rejects a stalled child after the finite deadline', async () => {
    vi.useFakeTimers(); const proc = child(); const pending = readReservationSnapshot({});
    const rejected = expect(pending).rejects.toThrow('RESERVATION_BACKUP_SOURCE_FAILED');
    await vi.advanceTimersByTimeAsync(90000); await rejected;
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });
  it('terminates excessive stderr without exposing its contents', async () => {
    const proc = child(); const pending = readReservationSnapshot({});
    proc.stderr.write(Buffer.alloc(65537));
    await expect(pending).rejects.toThrow('RESERVATION_BACKUP_SOURCE_FAILED');
    expect(proc.kill).toHaveBeenCalled();
  });
});
