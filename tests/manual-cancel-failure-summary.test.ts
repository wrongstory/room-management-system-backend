import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { manualCancelFailureSummary, manualCancelRaceErrorSummary, manualCancelSqlState, testManualCleaningCancelConcurrency } from '../scripts/test-manual-cleaning-cancel-concurrency.mjs';
import { assertRoomReadyRaceDenied } from '../scripts/test-room-ready-correction-concurrency.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn(() => { throw new Error('DB forbidden'); }),
  spawn: vi.fn(() => { throw new Error('DB forbidden'); }) }));

describe('safe manual/READY failure diagnostics without DB', () => {
  it('preserves only the code through the real localSql failure boundary with a mocked child', async () => {
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      throw Object.assign(new Error('PRIVATE_QUERY'), { stderr: 'ERROR:  23514\n', detail: 'PRIVATE_ROW' });
    });
    const client = { supabaseUrl: 'http://127.0.0.1' } as unknown as Parameters<typeof testManualCleaningCancelConcurrency>[0];
    const error = await testManualCleaningCancelConcurrency(client).catch(error => error);
    expect(error.message).toBe('MANUAL_CANCEL_LOCAL_SQL_FAILED');
    expect(execFileSync).toHaveBeenLastCalledWith('docker', expect.arrayContaining(['-v','VERBOSITY=sqlstate']),
      expect.objectContaining({ input: 'select count(*) from public.profiles;', encoding: 'utf8', timeout: 30000,
        stdio: ['pipe','pipe','pipe'] }));
    const summary = manualCancelFailureSummary(error,'fixture-and-races');
    expect(summary.sqlState).toBe('23514');
    expect(summary.sourceLine).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toMatch(/PRIVATE/);
    expect(error.cause).toBeUndefined();
  });
  it.each(['ERROR:  23514\n', 'psql:stdin:9: ERROR:  23514\r\n'])('extracts only an allowlisted SQLSTATE line', stderr => {
    expect(manualCancelSqlState(stderr)).toBe('23514');
  });
  it.each([null, {}, '', 'ERROR: SECRET', 'ERROR: 23514 private row', '23514', 'ERROR: 00000', 'ERROR: P9999'])('rejects unsupported or unsanitized errors', stderr => {
    expect(manualCancelSqlState(stderr)).toBeNull();
  });
  it('retains fixed caller lines and SQLSTATE while omitting messages, SQL, paths and private fields', () => {
    const error = Object.assign(new Error('PRIVATE_PIN_AND_SQL'), { sqlState: '23514', stderr: 'PRIVATE_ROW',
      detail: 'PRIVATE_DETAIL', stack: 'PRIVATE_PATH\n at localSql (file:///private/test-manual-cleaning-cancel-concurrency.mjs:38:2)\n at ready (file:///private/test-room-ready-correction-concurrency.mjs:121:3)' });
    expect(manualCancelFailureSummary(error,'room-ready-correction-races')).toEqual({
      phase: 'room-ready-correction-races', kind: 'VALIDATION_FAILED', sourceLine: 38, readySourceLine: 121, sqlState: '23514' });
    expect(JSON.stringify(manualCancelFailureSummary(error,'PRIVATE_PHASE'))).not.toMatch(/PRIVATE/);
  });
  it('keeps assertion classification and returns null for unknown SQLSTATE/stack', () => {
    const error = new assert.AssertionError({ message: 'PRIVATE' });
    error.stack = 'PRIVATE';
    expect(manualCancelFailureSummary(error,'fixture-and-races')).toEqual({ phase: 'fixture-and-races',
      kind: 'ASSERTION_FAILED', sourceLine: null, readySourceLine: null, sqlState: null });
    expect(manualCancelFailureSummary({ sqlState: 'SECRET' }, 'unknown').sqlState).toBeNull();
  });
});

describe('bounded manual/READY contender diagnostics without DB', () => {
  const parse = (stderr: string) => manualCancelRaceErrorSummary([Buffer.from(stderr)]);
  it('assembles every byte partition before parsing one exact error header', () => {
    const stderr = Buffer.from('ERROR:  40001: ROOM_READY_PREVIEW_STALE\r\nCONTEXT: private SQL with PHOTO_ACCESS_REQUIRED\r\n');
    for (let offset = 0; offset <= stderr.length; offset += 1) {
      expect(manualCancelRaceErrorSummary([stderr.subarray(0, offset), stderr.subarray(offset)]))
        .toEqual({ code: 'ROOM_READY_PREVIEW_STALE', sqlState: '40001', diagnostic: 'EXACT_HEADER' });
    }
    expect(manualCancelRaceErrorSummary([...stderr].map(byte => Buffer.from([byte]))).code)
      .toBe('ROOM_READY_PREVIEW_STALE');
  });
  it.each([
    ['40001','ROOM_READY_PREVIEW_STALE'], ['55000','ROOM_READY_CORRECTION_BLOCKED'],
    ['55000','INSPECTION_INVALID_TRANSITION'], ['42501','PHOTO_ACCESS_REQUIRED'],
    ['42501','CAPABILITY_ACCESS_REQUIRED'], ['42501','SESSION_REVOKED']
  ])('accepts only an exact verbose header for %s/%s', (sqlState, code) => {
    expect(parse(`NOTICE: ignored\npsql:stdin:9: ERROR:  ${sqlState}: ${code}\nCONTEXT: PRIVATE\n`))
      .toEqual({ code, sqlState, diagnostic: 'EXACT_HEADER' });
    expect(parse(`FATAL:  ${sqlState}: ${code}\nLOCATION: PRIVATE\n`).code).toBe(code);
  });
  it.each([
    '', 'CONTEXT: ROOM_READY_PREVIEW_STALE\n', 'ERROR: ROOM_READY_PREVIEW_STALE\n',
    'ERROR: P9999: ROOM_READY_PREVIEW_STALE\n', 'ERROR: 42501: PRIVATE\n',
    'ERROR: 42501: PRIVATE CAPABILITY_ACCESS_REQUIRED\n',
    'ERROR: 42501: CAPABILITY_ACCESS_REQUIRED_PRIVATE\n',
    'ERROR: 42501: PRIVATE\nCONTEXT: CAPABILITY_ACCESS_REQUIRED\n',
    'psql:stdin:9: ERROR: P0001: PRIVATE: ERROR: 42501: CAPABILITY_ACCESS_REQUIRED\n',
    'psql:stdin:9: CONTEXT: PRIVATE: ERROR: 42501: CAPABILITY_ACCESS_REQUIRED\n'
  ])('does not upgrade unknown or contextual text to an expected loser', stderr => {
    expect(parse(stderr)).toEqual({ code: null, sqlState: null, diagnostic: 'UNRECOGNIZED' });
  });
  it('fails closed for ambiguous headers, byte overflow and unsupported chunks', () => {
    expect(parse('ERROR: 40001: ROOM_READY_PREVIEW_STALE\nERROR: 42501: CAPABILITY_ACCESS_REQUIRED\n'))
      .toEqual({ code: null, sqlState: null, diagnostic: 'AMBIGUOUS' });
    expect(parse('ERROR: 42501: CAPABILITY_ACCESS_REQUIRED\n' + 'x'.repeat(8192)).diagnostic).toBe('TRUNCATED');
    expect(manualCancelRaceErrorSummary([Buffer.from('ERROR: 42501: CAPABILITY_ACCESS_REQUIRED\n')], true).code).toBeNull();
    for (const chunks of [null, {}, ['ERROR: 42501: CAPABILITY_ACCESS_REQUIRED\n']]) {
      expect(manualCancelRaceErrorSummary(chunks).code).toBeNull();
    }
  });
  it.each([
    ['ready_room_cas','ROOM_READY_PREVIEW_STALE'], ['ready_approval_first','ROOM_READY_PREVIEW_STALE'],
    ['ready_correction_first','INSPECTION_INVALID_TRANSITION'], ['ready_upload_first','ROOM_READY_PREVIEW_STALE'],
    ['ready_upload_after','CAPABILITY_ACCESS_REQUIRED']
  ])('preserves nonzero and exact-code assertions for %s', (name, code) => {
    expect(() => assertRoomReadyRaceDenied({ exitCode: 1, code }, code, name)).not.toThrow();
    expect(() => assertRoomReadyRaceDenied({ exitCode: 0, code }, code, name)).toThrow();
    expect(() => assertRoomReadyRaceDenied({ exitCode: 1, code: null }, code, name)).toThrow();
  });
  it('rejects the obsolete PHOTO code and reports only the exact safe race fields', () => {
    let failure: unknown;
    try {
      assertRoomReadyRaceDenied({ exitCode: 1, code: 'PHOTO_ACCESS_REQUIRED', sqlState: '42501', diagnostic: 'EXACT_HEADER' },
        'CAPABILITY_ACCESS_REQUIRED', 'ready_upload_after');
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(assert.AssertionError);
    const summary = manualCancelFailureSummary(failure, 'room-ready-correction-races');
    expect(summary.sqlState).toBe('42501');
    expect(summary.race).toEqual({ name: 'ready_upload_after', exitCode: 1,
      expectedCode: 'CAPABILITY_ACCESS_REQUIRED', observedCode: 'PHOTO_ACCESS_REQUIRED', diagnostic: 'EXACT_HEADER' });
  });
  it('does not log private fields smuggled into race metadata', () => {
    const error = Object.assign(new Error('PRIVATE_SQL'), { sqlState: 'PRIVATE', readyRace: {
      name: 'ready_upload_after', exitCode: 999, expectedCode: 'PRIVATE', observedCode: 'PRIVATE', diagnostic: 'PRIVATE',
      output: 'PRIVATE', stderr: 'PRIVATE' } });
    const summary = manualCancelFailureSummary(error, 'room-ready-correction-races');
    expect(summary.race).toEqual({ name: 'ready_upload_after', exitCode: null, expectedCode: null, observedCode: null, diagnostic: null });
    expect(JSON.stringify(summary)).not.toContain('PRIVATE');
    error.readyRace.name = 'PRIVATE';
    expect(manualCancelFailureSummary(error, 'room-ready-correction-races').race).toBeUndefined();
  });
});
