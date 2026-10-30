import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { assignmentMemoCommand, assignmentMemoLocalConnection, assertAssignmentMemoHistory,
  assertAssignmentMemoRace, assertAssignmentMemoResponse, closeAssignmentMemoConnections } from '../scripts/test-assignment-instruction-concurrency.mjs';

vi.mock('pg', () => ({ Client: vi.fn(() => { throw new Error('Actual DB forbidden in source preparation tests'); }) }));
const read = (file: string) => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const source = read('scripts/test-assignment-instruction-concurrency.mjs');
const require = createRequire(import.meta.url);
const id = (n: number) => `53410000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = () => ({ kind: 'prestart', actor: id(1), target: id(2), maid: id(3), assignment: id(4),
  version: 2, sequence: 1, day: '2026-10-31', key: 'memo534-test-command', memo: '수건 2개' });
const value = () => ({ assignmentId: id(5), instructionMemo: '수건 2개', revision: 3 });
const race = () => ({ first: { ok: true, value: value() }, second: { ok: false, error: 'ASSIGNMENT_VERSION_CONFLICT' },
  observedBlocking: true, firstPid: 123, secondPid: 124 });
const rows = () => [{ id: id(4), revision: '2', instruction_memo: '수건 1개', is_current: false },
  { id: id(5), revision: '3', instruction_memo: null, is_current: true }];
const syntheticUrl = (parts: Partial<Pick<URL, 'protocol' | 'hostname' | 'port' | 'pathname' | 'username' | 'password' | 'search' | 'hash'>> = {}) => {
  const url = new URL(`${parts.protocol ?? 'postgresql:'}//127.0.0.1:54322/postgres`);
  url.username = 'postgres';
  url.password = 'synthetic-fixture-only';
  Object.assign(url, parts);
  return url.href;
};

describe('#534 actual race source preparation (actual SQL/concurrency NOT RUN)', () => {
  it('does no DB work on import and only admits the exact local database', () => {
    expect(Client).not.toHaveBeenCalled();
    expect(assignmentMemoLocalConnection(syntheticUrl())).toMatchObject({
      host: '127.0.0.1', port: 54322, database: 'postgres', ssl: false, statement_timeout: 5000,
      lock_timeout: 4000, idle_in_transaction_session_timeout: 15000, connectionTimeoutMillis: 3000,
    });
    for (const url of [undefined, syntheticUrl({ protocol: 'https:' }),
      syntheticUrl({ hostname: 'db.example.invalid' }), syntheticUrl({ port: '5432' }),
      syntheticUrl({ pathname: '/production' }), syntheticUrl({ username: 'other' }),
      syntheticUrl({ password: '' }), syntheticUrl({ search: '?host=remote' }), syntheticUrl({ hash: '#remote' })]) {
      expect(() => assignmentMemoLocalConnection(url)).toThrow();
    }
  });

  it('binds all caller values, distinguishes clear from omit, and hashes content independently from keys', () => {
    const unsafeText = "수건 '); select 1; --";
    const original = assignmentMemoCommand({ ...input(), memo: unsafeText });
    expect(original.text).not.toContain(unsafeText);
    expect(original.text).not.toContain(id(1));
    expect(original.values).toContain(unsafeText);
    expect(original.text.match(/\$\d+/g)).toHaveLength(original.values.length);
    expect(assignmentMemoCommand({ ...input(), memo: unsafeText, key: 'memo534-different-key' }).hash).toBe(original.hash);
    expect(assignmentMemoCommand({ ...input(), memo: '다른 메모' }).hash).not.toBe(original.hash);
    const { memo: _memo, ...omitted } = input();
    const cleared = assignmentMemoCommand({ ...input(), memo: null });
    const legacy = assignmentMemoCommand(omitted);
    expect(cleared.hash).not.toBe(legacy.hash);
    expect(cleared.text).toContain('p_instruction_memo =>');
    expect(legacy.text).not.toContain('p_instruction_memo =>');
    for (const patch of [{ kind: 'arbitrary_rpc' }, { actor: "'; select 1" }, { version: 0 },
      { sequence: Number.MAX_SAFE_INTEGER + 1 }, { key: "memo534-';select 1" }, { memo: {} }]) {
      expect(() => assignmentMemoCommand({ ...input(), ...patch })).toThrow();
    }
  });

  it('does not retain credentials in malformed URL or percent-decoding errors', () => {
    const marker = 'synthetic-credential-marker';
    for (const url of [syntheticUrl({ password: marker }).replace('127.0.0.1', '[broken'),
      syntheticUrl({ password: `${marker}%ZZ` })]) {
      let failure: unknown;
      try { assignmentMemoLocalConnection(url); } catch (error) { failure = error; }
      if (!(failure instanceof Error)) throw new Error('Expected a sanitized local-target error');
      expect(failure.message).toBe('MEMO_LOCAL_TARGET_REQUIRED');
      expect(inspect(failure)).not.toContain(marker);
      expect(Object.hasOwn(failure, 'input')).toBe(false);
      expect(Object.hasOwn(failure, 'cause')).toBe(false);
    }
  });

  it('refuses unobserved sessions, generic errors, false replay and absent committed-result identity', () => {
    expect(() => assertAssignmentMemoRace(race(), 'cas')).not.toThrow();
    expect(() => assertAssignmentMemoRace({ ...race(), second: { ok: false, error: 'IDEMPOTENCY_KEY_REUSED' } }, 'key')).not.toThrow();
    expect(() => assertAssignmentMemoRace({ ...race(), second: { ok: true, value: value() } }, 'replay')).not.toThrow();
    for (const patch of [{ observedBlocking: false }, { secondPid: 123 }, { firstPid: 0 },
      { first: { ok: true, value: {} } }, { first: { ok: false } },
      { second: { ok: true, value: value() } }, { second: { ok: false, error: '40P01' } },
      { second: { ok: false, error: '57014' } }, { second: { ok: false, error: 'UNEXPECTED_DATABASE_ERROR' } }]) {
      expect(() => assertAssignmentMemoRace({ ...race(), ...patch }, 'cas')).toThrow();
    }
    expect(() => assertAssignmentMemoRace({ ...race(), second: { ok: true, value: { ...value(), instructionMemo: null } } }, 'replay')).toThrow();
    expect(() => assertAssignmentMemoRace(race(), 'any-error')).toThrow();
  });

  it('rejects overwritten history, null resurrection, missing revisions, and multiple current rows', () => {
    expect(() => assertAssignmentMemoHistory(rows(), ['수건 1개', null])).not.toThrow();
    for (const changed of [[], rows().slice(1), [...rows(), rows()[1]],
      rows().map((row, i) => i === 0 ? { ...row, instruction_memo: '바뀐 과거' } : row),
      rows().map((row, i) => i === 1 ? { ...row, instruction_memo: '수건 1개' } : row),
      rows().map(row => ({ ...row, is_current: true })),
      rows().map((row, i) => i === 1 ? { ...row, revision: '4' } : row)]) {
      expect(() => assertAssignmentMemoHistory(changed, ['수건 1개', null])).toThrow();
    }
  });

  it('matches the successful response to the actual stored revision including an explicit null', () => {
    const expected = { assignment: id(5), target: id(2), version: 3, memo: null };
    const response = { assignmentId: id(5), cleaningTargetId: id(2), revision: 3, targetAssignmentVersion: 3, instructionMemo: null };
    expect(() => assertAssignmentMemoResponse(response, expected)).not.toThrow();
    const { instructionMemo: _memo, ...missing } = response;
    for (const changed of [missing, { ...response, assignmentId: id(4) }, { ...response, cleaningTargetId: id(8) },
      { ...response, instructionMemo: '옛 메모' }, { ...response, revision: 2 }, { ...response, targetAssignmentVersion: 2 }]) {
      expect(() => assertAssignmentMemoResponse(changed, expected)).toThrow();
    }
  });

  it('ends every owned connection and propagates rollback or end failures', async () => {
    const make = (busy = false) => ({ connected: true, busy, failed: false,
      client: { query: vi.fn(async () => ({})), end: vi.fn(async () => {}) } });
    const idle = make(), active = make(true), broken = make();
    broken.client.query.mockRejectedValueOnce(new Error('synthetic rollback failure'));
    await expect(closeAssignmentMemoConnections([idle, active, broken])).rejects.toThrow('MEMO_CONNECTION_CLEANUP_FAILED');
    expect(idle.client.query).toHaveBeenCalledWith('rollback');
    expect(active.client.query).not.toHaveBeenCalled();
    for (const entry of [idle, active, broken]) expect(entry.client.end).toHaveBeenCalledOnce();
    const failedEnd = make(); failedEnd.client.end.mockRejectedValueOnce(new Error('synthetic close failure'));
    await expect(closeAssignmentMemoConnections([failedEnd])).rejects.toThrow('MEMO_CONNECTION_CLEANUP_FAILED');
  });

  it.each([15, 17])('parses real RPC statements and fixture SQL with PostgreSQL %i grammar only', async version => {
    const parser = require(`@pgsql/parser/v${version}`) as { parse(sql: string): Promise<{ stmts: unknown[] }> };
    for (const kind of ['draft', 'prestart', 'plan']) {
      const { memo: _memo, ...omitted } = input();
      for (const variant of [omitted, { ...input(), memo: null }, input()]) {
        expect((await parser.parse(assignmentMemoCommand({ ...variant, kind }).text)).stmts).toHaveLength(1);
      }
    }
    // Extract the module's fixed SQL literals. Caller values are separate binds;
    // dynamic RPC statements are constructed and parsed individually above.
    const literals = [...source.matchAll(/query\([^,]+,\s*(?:'([^']*)'|"([^"]*)"|`((?:[^`$]|\$(?!\{))*)`)/g)];
    const statements = literals.map(match => match[1] ?? match[2] ?? match[3] ?? '');
    expect(statements.some(statement => statement.includes('insert into public.cleaning_assignments'))).toBe(true);
    expect(statements.some(statement => statement.includes('pg_stat_activity'))).toBe(true);
    for (const statement of statements) expect((await parser.parse(statement)).stmts.length).toBeGreaterThan(0);
    // SQL parsing does not install functions, execute PL/pgSQL, or prove a race.
  });

  it('adds a call inside the existing aggregate without any reset or independent execution entry', () => {
    const runner = read('scripts/test-reservation-concurrency.mjs');
    expect(runner).toContain('await testAssignmentInstructionConcurrency(status.DB_URL,actorProfileId);');
    const scripts = JSON.parse(read('package.json')).scripts;
    expect(scripts['db:test:concurrency'].split(' && ')).toHaveLength(12);
    expect(source).not.toMatch(/db[', ]+reset|supabase.*start|execFile|spawn\(|process\.argv/);
    expect(source).toContain('pg_blocking_pids(pid)');
    expect(source).toContain('MEMO_EXACTLY_ONE_COMMAND_AUDIT');
    expect(source).toContain('new AggregateError([failure, error]');
    expect(Client).not.toHaveBeenCalled();
  });
});
