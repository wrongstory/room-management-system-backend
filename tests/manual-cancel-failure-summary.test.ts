import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { manualCancelFailureSummary, manualCancelSqlState, testManualCleaningCancelConcurrency } from '../scripts/test-manual-cleaning-cancel-concurrency.mjs';

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
