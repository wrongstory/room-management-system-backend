import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATOMIC_FIXTURE_SUITE_NAME, ATOMIC_FIXTURE_TARGETS } from '../scripts/fixtures/migration-readonly/atomic-fixture-targets.mjs';
import { ATOMIC_REPORT_MAX_BYTES, parseAtomicFixtureReport, readAtomicFixtureReport, runAtomicFixtureChild } from '../scripts/lib/migration-atomic-report.mjs';

const marker = 'SYNTHETIC_SENSITIVE_SQL_PASSWORD_PATH_AND_STACK';
const temporary = resolve(tmpdir());
const directories = [];
const encode = value => Buffer.from(JSON.stringify(value));
function pathFor(bytes) {
  const directory = mkdtempSync(join(temporary, 'rms-atomic-report-unit-'));
  directories.push(directory);
  const path = join(directory, 'report.json');
  if (bytes !== undefined) writeFileSync(path, bytes);
  return path;
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    // Only exact test-created children of this OS temporary directory.
    expect(dirname(resolve(directory))).toBe(temporary);
    rmSync(directory, { recursive: true, force: true });
  }
});
function reportWith(statuses = Array(8).fill('passed')) {
  const failed = statuses.filter(value => value === 'failed').length;
  const pending = statuses.filter(value => ['pending', 'skipped'].includes(value)).length;
  const todo = statuses.filter(value => value === 'todo').length;
  return { numTotalTestSuites: 2, numPassedTestSuites: failed ? 0 : 2,
    numFailedTestSuites: failed ? 2 : 0, numPendingTestSuites: 0,
    numTotalTests: 8, numPassedTests: 8 - failed - pending - todo, numFailedTests: failed,
    numPendingTests: pending, numTodoTests: todo, success: failed === 0,
    testResults: [{ status: failed ? 'failed' : 'passed', name: marker, message: marker,
      assertionResults: ATOMIC_FIXTURE_TARGETS.map((item, index) => ({ ancestorTitles: [ATOMIC_FIXTURE_SUITE_NAME],
        title: item.title, fullName: item.fullName, status: statuses[index], failureMessages: [marker],
        location: { line: marker, column: marker }, meta: { rawSql: marker, rawPath: marker } })) }],
    snapshot: { stack: marker, actual: marker, expected: marker }, coverageMap: { path: marker } };
}
const parsed = report => parseAtomicFixtureReport(encode(report));
const childError = fields => Object.assign(new Error(marker), { stdout: marker, stderr: marker, output: [marker],
  spawnargs: [marker], input: marker, cause: new Error(marker), ...fields });
function runFake(reportBytes, error) {
  const logs = [];
  const execute = vi.fn(() => { if (error) throw error; return marker; });
  let result;
  let caught;
  try { result = runAtomicFixtureChild({ file: marker, args: [marker], options: { timeout: 90000 },
    reportPath: pathFor(reportBytes), emit: line => logs.push(line), execute }); }
  catch (error) { caught = error; }
  return { result, caught, logs, execute };
}
function expectSafeFailure(outcome) {
  expect(outcome.execute).toHaveBeenCalledTimes(1);
  expect(outcome.caught?.message).toBe('ISOLATED_ATOMIC_FIXTURE_FAILED');
  expect(outcome.caught?.cause).toBeUndefined();
  expect(outcome.caught?.stdout).toBeUndefined();
  expect(outcome.caught?.stderr).toBeUndefined();
  expect(JSON.stringify(outcome.logs)).not.toContain(marker);
  expect(String(outcome.caught?.stack)).not.toContain(marker);
  expect(outcome.result).toBeUndefined();
}

describe('bounded atomic fixture report diagnostics without a child or database', () => {
  it('accepts exactly eight passed fixed cases and discards all non-allowlisted report fields', () => {
    const result = parsed(reportWith());
    expect(result).toEqual({ phase: 'ATOMIC_REPORT', status: 'PASSED', total: 8, passed: 8, failed: 0,
      pending: 0, todo: 0, cases: Array.from({ length: 8 }, (_, index) => ({ id: index + 1, status: 'PASSED' })) });
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain(ATOMIC_FIXTURE_SUITE_NAME);
  });
  it('maps failures to stable numeric IDs regardless of report order', () => {
    const value = reportWith(['passed', 'failed', 'passed', 'failed', 'passed', 'passed', 'passed', 'passed']);
    value.testResults[0].assertionResults.reverse();
    const result = parsed(value);
    expect(result.status).toBe('FAILED');
    expect(result.failed).toBe(2);
    expect(result.cases.filter(item => item.status === 'FAILED').map(item => item.id)).toEqual([2, 4]);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
  it.each(['pending', 'skipped', 'todo'])('does not accept a nominally successful report with a %s case', status => {
    expect(parsed(reportWith([status, ...Array(7).fill('passed')])).status).toBe('FAILED');
  });
  it('reports a failed module with no collected cases without inferring a raw error cause', () => {
    const value = { numTotalTestSuites: 1, numPassedTestSuites: 0, numFailedTestSuites: 1, numPendingTestSuites: 0,
      numTotalTests: 0, numPassedTests: 0, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, success: false,
      testResults: [{ assertionResults: [], status: 'failed', name: marker, message: marker }] };
    expect(parsed(value)).toEqual({ phase: 'ATOMIC_COLLECTION', status: 'FAILED', total: 0 });
  });
  it('keeps an after-all failure even when all eight assertions passed', () => {
    const value = reportWith();
    Object.assign(value, { success: false, numPassedTestSuites: 1, numFailedTestSuites: 1 });
    value.testResults[0].status = 'failed';
    expect(parsed(value).status).toBe('FAILED');
  });
  it.each([
    ['unknown title', value => { value.testResults[0].assertionResults[0].title = marker; }],
    ['unknown full name', value => { value.testResults[0].assertionResults[0].fullName = marker; }],
    ['unknown ancestor', value => { value.testResults[0].assertionResults[0].ancestorTitles = [marker]; }],
    ['extra ancestor', value => { value.testResults[0].assertionResults[0].ancestorTitles.push(marker); }],
    ['duplicate case', value => { value.testResults[0].assertionResults[1] = value.testResults[0].assertionResults[0]; }],
    ['missing case', value => { value.testResults[0].assertionResults.pop(); }],
    ['extra case', value => { value.testResults[0].assertionResults.push(value.testResults[0].assertionResults[0]); }],
    ['unknown case status', value => { value.testResults[0].assertionResults[0].status = marker; }],
    ['prototype case status', value => { value.testResults[0].assertionResults[0].status = 'constructor'; }],
    ['unknown suite status', value => { value.testResults[0].status = marker; }],
    ['duplicate suite', value => { value.testResults.push(value.testResults[0]); }],
    ['missing suite', value => { value.testResults = []; }],
    ['string success', value => { value.success = 'true'; }],
    ['false success', value => { value.success = false; }],
    ['count mismatch', value => { value.numPassedTests = 7; }],
    ['assertion mismatch', value => { value.testResults[0].assertionResults[0].status = 'failed'; }],
    ['suite count mismatch', value => { value.numPassedTestSuites = 1; }],
    ['extra suite count', value => { value.numTotalTestSuites = 3; value.numPassedTestSuites = 3; }],
    ['invalid suite outcome', value => { value.testResults[0].status = 'failed'; }],
    ['null assertion', value => { value.testResults[0].assertionResults[0] = null; }],
    ['array assertion', value => { value.testResults[0].assertionResults[0] = []; }],
    ['array suite', value => { value.testResults[0] = []; }],
    ['nonarray assertions', value => { value.testResults[0].assertionResults = marker; }],
    ['negative count', value => { value.numPassedTests = -1; }],
    ['fractional count', value => { value.numTotalTests = 8.1; }],
    ['string count', value => { value.numPassedTests = '8'; }],
  ])('rejects %s with one fixed code and no report text', (_name, mutate) => {
    const value = reportWith(); mutate(value);
    expect(parsed(value)).toEqual({ phase: 'ATOMIC_REPORT', status: 'INVALID' });
  });
  it.each([null, [], true, 7, marker])('rejects invalid report root %#', value => {
    expect(parsed(value)).toEqual({ phase: 'ATOMIC_REPORT', status: 'INVALID' });
  });
  it('handles malformed and invalid UTF-8 input without exposing parser error excerpts', () => {
    for (const bytes of [Buffer.from(`{"${marker}`), Buffer.from([0xff]), Buffer.alloc(0)]) {
      expect(parseAtomicFixtureReport(bytes)).toEqual({ phase: 'ATOMIC_REPORT', status: 'MALFORMED' });
    }
  });
  it('bounds bytes before parsing and rejects nonbyte input', () => {
    expect(parseAtomicFixtureReport(Buffer.alloc(ATOMIC_REPORT_MAX_BYTES + 1))).toEqual({ phase: 'ATOMIC_REPORT', status: 'OVERSIZED' });
    expect(parseAtomicFixtureReport(marker)).toEqual({ phase: 'ATOMIC_REPORT', status: 'INVALID' });
  });
  it('reads a valid bounded file; missing, malformed, directory and oversized reports are fixed codes', () => {
    expect(readAtomicFixtureReport(pathFor(encode(reportWith()))).status).toBe('PASSED');
    expect(readAtomicFixtureReport(pathFor()).status).toBe('MISSING');
    expect(readAtomicFixtureReport(pathFor(Buffer.from(marker))).status).toBe('MALFORMED');
    expect(readAtomicFixtureReport(dirname(pathFor())).status).toBe('UNREADABLE');
    expect(readAtomicFixtureReport(pathFor(Buffer.alloc(ATOMIC_REPORT_MAX_BYTES + 1))).status).toBe('OVERSIZED');
  });
  it('accepts a report exactly at the byte ceiling but never one byte over', () => {
    const bytes = encode(reportWith());
    const exact = Buffer.concat([bytes, Buffer.alloc(ATOMIC_REPORT_MAX_BYTES - bytes.length, 0x20)]);
    expect(readAtomicFixtureReport(pathFor(exact)).status).toBe('PASSED');
    expect(readAtomicFixtureReport(pathFor(Buffer.concat([exact, Buffer.from(' ')]))).status).toBe('OVERSIZED');
  });
  it('retains one child invocation, timeout and output capture on success', () => {
    const outcome = runFake(encode(reportWith()));
    expect(outcome.result.status).toBe('PASSED'); expect(outcome.caught).toBeUndefined();
    expect(outcome.logs).toEqual([]); expect(outcome.execute).toHaveBeenCalledTimes(1);
    expect(outcome.execute).toHaveBeenCalledWith(marker, [marker], {
      encoding: 'utf8', timeout: 90000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  });
  it.each([
    [{ status: 1, pid: 1 }, 'EXIT_FAILED'],
    [{ code: 'ENOENT', pid: 0 }, 'LAUNCH_FAILED'],
    [{ code: 'EACCES', pid: 0 }, 'LAUNCH_FAILED'],
    [{ code: 'ETIMEDOUT', pid: 1 }, 'TIMEOUT'],
    [{ code: marker, status: null, signal: marker, pid: 1 }, 'COMMAND_FAILED'],
  ])('preserves failed child status %# even with an eight-pass report', (fields, expected) => {
    const outcome = runFake(encode(reportWith()), childError(fields));
    expectSafeFailure(outcome);
    expect(JSON.parse(outcome.logs[0])).toEqual({ phase: 'ATOMIC_CHILD', status: expected });
    expect(JSON.parse(outcome.logs[1]).status).toBe('PASSED');
  });
  it('prints only sanitized counts/case IDs for a failing child report', () => {
    const outcome = runFake(encode(reportWith(['failed', ...Array(7).fill('passed')])), childError({ status: 1 }));
    expectSafeFailure(outcome);
    expect(JSON.parse(outcome.logs[1])).toMatchObject({ status: 'FAILED', total: 8, passed: 7, failed: 1,
      cases: [{ id: 1, status: 'FAILED' }, ...Array.from({ length: 7 }, (_, i) => ({ id: i + 2, status: 'PASSED' }))] });
  });
  it.each([
    [undefined, 'MISSING'], [Buffer.from(marker), 'MALFORMED'],
    [Buffer.alloc(ATOMIC_REPORT_MAX_BYTES + 1), 'OVERSIZED'],
    [encode({ success: true, message: marker }), 'INVALID'],
    [encode(reportWith(['failed', ...Array(7).fill('passed')])), 'FAILED'],
  ])('does not promote nominal child success with an unusable report %#', (bytes, expected) => {
    const outcome = runFake(bytes);
    expectSafeFailure(outcome);
    expect(JSON.parse(outcome.logs[0])).toEqual({ phase: 'ATOMIC_CHILD', status: 'PASSED' });
    expect(JSON.parse(outcome.logs[1]).status).toBe(expected);
  });
  it('keeps the same actual command, eight-case check, 90-second child bound and source preservation', () => {
    const source = readFileSync(new URL('../scripts/test-migration-readonly-postgres-tls.mjs', import.meta.url), 'utf8');
    expect(source.match(/runAtomicFixtureChild\(\{/gu)).toHaveLength(1);
    expect(source).toContain("args:[join(root,'node_modules','vitest','vitest.mjs'),'run','--config',");
    expect(source).toContain("join(fixtures,'atomic-vitest.config.mjs'),'--reporter=json','--outputFile',atomicReport]");
    expect(source).toContain('timeout:90000');
    expect(source).toContain("atomic.status==='PASSED' && atomic.total===8 && atomic.passed===8 && atomic.pending===0");
    expect(source).toContain("'scripts/lib/migration-atomic-report.mjs','scripts/fixtures/migration-readonly/atomic-fixture-targets.mjs'");
  });
});
