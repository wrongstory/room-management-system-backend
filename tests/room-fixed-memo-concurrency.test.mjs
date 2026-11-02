import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { assertRoomFixedMemoRace, observeRoomFixedMemoLock, roomFixedMemoCommand,
  withRoomFixedMemoCleanup } from '../scripts/test-room-fixed-memo-concurrency.mjs';

vi.mock('pg', () => ({ Client: vi.fn(() => { throw new Error('Actual DB forbidden in source-only tests'); }) }));
const id = n => `55100000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = () => ({ actor: id(1), session: id(2), room: id(3), version: 0,
  memo: '매주 화요일 청소', key: 'memo551-synthetic-command' });
const committed = { room: id(3), version: 1, memo: '매주 화요일 청소' };
const first = () => ({ ok: true, value: { roomId: id(3), version: 1,
  memo: '매주 화요일 청소', updatedAt: '2026-11-02T00:00:00.000Z' } });
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

describe('#551 prepared actual concurrency (DB/SQL NOT RUN)', () => {
  it('imports without constructing or connecting a DB client', () => {
    expect(Client).not.toHaveBeenCalled();
  });

  it('binds all caller values and separates logical identity from retry keys/session', () => {
    const text = "수건 '); select 1; --";
    const command = roomFixedMemoCommand({ ...input(), memo: text });
    expect(command.text).not.toContain(text);
    expect(command.text).not.toContain(id(1));
    expect(command.values).toContain(text);
    expect(command.text.match(/\$\d+/g)).toHaveLength(command.values.length);
    expect(roomFixedMemoCommand({ ...input(), memo: text, key: 'memo551-another', session: id(4) }).hash).toBe(command.hash);
    for (const patch of [{ memo: null }, { memo: '' }, { version: 1 }, { room: id(5) }, { actor: id(6) }]) {
      expect(roomFixedMemoCommand({ ...input(), ...patch }).hash).not.toBe(roomFixedMemoCommand(input()).hash);
    }
    for (const patch of [{ memo: undefined }, { actor: "'; select 1" }, { version: -1 },
      { version: Number.MAX_SAFE_INTEGER }, { key: 'arbitrary' }]) {
      expect(() => roomFixedMemoCommand({ ...input(), ...patch })).toThrow();
    }
  });

  it('requires a real blocker/waiter observation before releasing the winning transaction', async () => {
    let now = 0;
    const events = [];
    const probe = vi.fn(async (blocker, waiter) => {
      events.push(['probe', blocker, waiter]);
      return now >= 40;
    });
    await observeRoomFixedMemoLock(probe, 11, 12, {
      now: () => now, pause: async ms => { events.push(['wait', ms]); now += ms; }, barrierMs: 100,
    });
    expect(probe).toHaveBeenCalledTimes(3);
    expect(events).toEqual([['probe', 11, 12], ['wait', 20], ['probe', 11, 12], ['wait', 20], ['probe', 11, 12]]);
    await expect(observeRoomFixedMemoLock(probe, 11, 11)).rejects.toThrow('FIXED_MEMO_DISTINCT_SESSIONS_REQUIRED');
  });

  it('fails when no lock is observed within the bound or the observation itself fails', async () => {
    let now = 0;
    const probe = vi.fn(async () => false);
    await expect(observeRoomFixedMemoLock(probe, 11, 12, {
      now: () => now, pause: async ms => { now += ms; }, barrierMs: 40,
    })).rejects.toThrow('FIXED_MEMO_CONTENDER_LOCK_NOT_OBSERVED');
    expect(probe).toHaveBeenCalledTimes(2);
    const failure = new Error('synthetic observer unavailable');
    await expect(observeRoomFixedMemoLock(async () => { throw failure; }, 11, 12)).rejects.toBe(failure);
  });

  it('accepts only the exact domain outcome and an unchanged successful replay', () => {
    for (const [expected, code, error] of [['cas', '40001', 'STALE_VERSION'],
      ['key', '23505', 'IDEMPOTENCY_KEY_REUSED'], ['revoked', '42501', 'SESSION_REVOKED']]) {
      expect(() => assertRoomFixedMemoRace(first(), { ok: false, code, error }, expected, committed)).not.toThrow();
      for (const bad of [{ ok: true, value: first().value }, { ok: false, code: '40P01', error: 'deadlock' },
        { ok: false, code: '57014', error: 'timeout' }, { ok: false, code: '40001', error: 'UNKNOWN' }]) {
        expect(() => assertRoomFixedMemoRace(first(), bad, expected, committed)).toThrow();
      }
    }
    expect(() => assertRoomFixedMemoRace(first(), first(), 'replay', committed)).not.toThrow();
    expect(() => assertRoomFixedMemoRace(first(), { ok: true, value: { ...first().value, updatedAt: 'changed' } }, 'replay', committed)).toThrow();
    expect(() => assertRoomFixedMemoRace({ ok: true, value: { ...first().value, version: 2 } }, first(), 'replay', committed)).toThrow();
    const cleared = { ok: true, value: { ...first().value, version: 2, memo: null } };
    expect(() => assertRoomFixedMemoRace(cleared, { ok: false, code: '40001', error: 'STALE_VERSION' },
      'cas', { ...committed, version: 2, memo: null })).not.toThrow();
    const { memo: _memo, ...missing } = cleared.value;
    expect(() => assertRoomFixedMemoRace({ ok: true, value: missing }, first(), 'replay', { ...committed, memo: null })).toThrow();
  });

  it('stops work before cleanup and preserves both work and cleanup failures', async () => {
    const workFailure = new Error('synthetic race failed'), cleanupFailure = new Error('synthetic socket close failed');
    let state;
    const cleanup = vi.fn(async () => {
      expect(state.stopped).toBe(true);
      throw cleanupFailure;
    });
    const result = withRoomFixedMemoCleanup(async signal => { state = signal; throw workFailure; }, cleanup);
    await expect(result).rejects.toMatchObject({ message: 'FIXED_MEMO_WORK_AND_CLEANUP_FAILED', errors: [workFailure, cleanupFailure] });
    expect(cleanup).toHaveBeenCalledOnce();
    await expect(withRoomFixedMemoCleanup(async () => {}, async () => { throw cleanupFailure; })).rejects.toBe(cleanupFailure);
  });

  it('bounds stalled work, closes owned connections, and also bounds a stalled close', async () => {
    vi.useFakeTimers();
    try {
      let state;
      const cleanup = vi.fn(async () => { expect(state.stopped).toBe(true); });
      const work = withRoomFixedMemoCleanup(async signal => { state = signal; await new Promise(() => {}); }, cleanup,
        { workMs: 50, cleanupMs: 20 });
      const workAssertion = expect(work).rejects.toThrow('FIXED_MEMO_WORK_TIMEOUT');
      await vi.advanceTimersByTimeAsync(50);
      await workAssertion;
      expect(cleanup).toHaveBeenCalledOnce();
      const close = withRoomFixedMemoCleanup(async () => {}, async () => new Promise(() => {}), { workMs: 50, cleanupMs: 20 });
      const closeAssertion = expect(close).rejects.toThrow('FIXED_MEMO_CLEANUP_TIMEOUT');
      await vi.advanceTimersByTimeAsync(20);
      await closeAssertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('parses all fixed SQL with PostgreSQL17 grammar without installing or calling any SQL', async () => {
    const require = createRequire(import.meta.url);
    const { parse } = require('@pgsql/parser/v17');
    expect((await parse(roomFixedMemoCommand(input()).text)).stmts).toHaveLength(1);
    const source = read('scripts/test-room-fixed-memo-concurrency.mjs');
    const literals = [...source.matchAll(/query\([^,]+,\s*(?:'([^']*)'|"([^"]*)"|`((?:[^`$]|\$(?!\{))*)`)/g)];
    const statements = literals.map(match => match[1] ?? match[2] ?? match[3] ?? '');
    expect(statements.some(sql => sql.includes('pg_stat_activity'))).toBe(true);
    expect(statements.some(sql => sql.includes('private.command_executions'))).toBe(true);
    for (const statement of statements) expect((await parse(statement)).stmts.length).toBeGreaterThan(0);
    const runner = read('scripts/test-reservation-concurrency.mjs');
    expect(runner).toContain('await testRoomFixedMemoConcurrency(status.DB_URL,actorProfileId);');
    expect(JSON.parse(read('package.json')).scripts['db:test:concurrency'].split(' && ')).toHaveLength(13);
    expect(source).not.toMatch(/execFile|spawn\(|process\.argv|supabase.*start|db[', ]+reset/);
    expect(Client).not.toHaveBeenCalled();
  });
});
