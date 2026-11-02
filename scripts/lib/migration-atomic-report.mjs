import { execFileSync } from 'node:child_process';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { ATOMIC_FIXTURE_SUITE_NAME, ATOMIC_FIXTURE_TARGETS } from '../fixtures/migration-readonly/atomic-fixture-targets.mjs';

export const ATOMIC_REPORT_MAX_BYTES = 128 * 1024;
const statuses = Object.freeze({ passed: 'PASSED', failed: 'FAILED', pending: 'PENDING', skipped: 'SKIPPED', todo: 'TODO' });
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const reportStatus = status => ({ phase: 'ATOMIC_REPORT', status });

// Only fixed enums, fixed numeric case IDs and checked small counts leave this
// module. Failure text, paths, assertion values and child output never do.
export function parseAtomicFixtureReport(bytes) {
  if (!Buffer.isBuffer(bytes)) return reportStatus('INVALID');
  if (bytes.length > ATOMIC_REPORT_MAX_BYTES) return reportStatus('OVERSIZED');
  let report;
  try { report = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { return reportStatus('MALFORMED'); }
  const invalid = () => reportStatus('INVALID');
  if (!record(report) || typeof report.success !== 'boolean'
    || !Array.isArray(report.testResults) || report.testResults.length !== 1) return invalid();
  const suite = report.testResults[0];
  if (!record(suite) || !['passed', 'failed'].includes(suite.status) || !Array.isArray(suite.assertionResults)) return invalid();
  const testKeys = ['numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests'];
  const suiteKeys = ['numTotalTestSuites', 'numPassedTestSuites', 'numFailedTestSuites', 'numPendingTestSuites'];
  if (!testKeys.every(key => count(report[key], 8)) || !suiteKeys.every(key => count(report[key], 2))
    || report.numPassedTests + report.numFailedTests + report.numPendingTests + report.numTodoTests !== report.numTotalTests
    || report.numPassedTestSuites + report.numFailedTestSuites + report.numPendingTestSuites !== report.numTotalTestSuites) return invalid();
  // A failed module collected no cases. This observes collection failure, not
  // its cause (configuration, import, setup, or arbitrary raw error text).
  if (report.numTotalTests === 0 && suite.assertionResults.length === 0 && !report.success
    && suite.status === 'failed' && report.numTotalTestSuites === 1 && report.numFailedTestSuites === 1) {
    return { phase: 'ATOMIC_COLLECTION', status: 'FAILED', total: 0 };
  }
  if (report.numTotalTests !== 8 || suite.assertionResults.length !== 8 || report.numTotalTestSuites !== 2) return invalid();
  const seen = new Set();
  const cases = [];
  for (const assertion of suite.assertionResults) {
    if (!record(assertion) || typeof assertion.status !== 'string'
      || !Object.hasOwn(statuses, assertion.status)) return invalid();
    const index = ATOMIC_FIXTURE_TARGETS.findIndex(item => item.fullName === assertion.fullName && item.title === assertion.title);
    if (index < 0 || seen.has(index) || !Array.isArray(assertion.ancestorTitles)
      || assertion.ancestorTitles.length !== 1 || assertion.ancestorTitles[0] !== ATOMIC_FIXTURE_SUITE_NAME) return invalid();
    seen.add(index);
    cases.push({ id: index + 1, status: statuses[assertion.status] });
  }
  const number = status => cases.filter(item => item.status === status).length;
  if (report.numPassedTests !== number('PASSED') || report.numFailedTests !== number('FAILED')
    || report.numPendingTests !== number('PENDING') + number('SKIPPED') || report.numTodoTests !== number('TODO')
    || (suite.status === 'passed' && (report.numFailedTests !== 0 || report.numFailedTestSuites !== 0))
    || (suite.status === 'failed' && report.numFailedTestSuites === 0)
    || report.success !== (report.numFailedTestSuites === 0 && report.numFailedTests === 0)) return invalid();
  const passed = report.success && suite.status === 'passed' && report.numPassedTests === 8
    && report.numPassedTestSuites === 2 && report.numPendingTests === 0 && report.numTodoTests === 0;
  return { phase: 'ATOMIC_REPORT', status: passed ? 'PASSED' : 'FAILED', total: 8,
    passed: report.numPassedTests, failed: report.numFailedTests, pending: report.numPendingTests,
    todo: report.numTodoTests, cases: cases.sort((a, b) => a.id - b.id) };
}

export function readAtomicFixtureReport(path) {
  let fd;
  let result;
  try {
    fd = openSync(path, 'r');
    const before = fstatSync(fd);
    if (!before.isFile()) result = reportStatus('UNREADABLE');
    else if (before.size > ATOMIC_REPORT_MAX_BYTES) result = reportStatus('OVERSIZED');
    else {
      // Fixed allocation and read ceiling also bound a file that grows after stat.
      const bytes = Buffer.alloc(ATOMIC_REPORT_MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = readSync(fd, bytes, length, bytes.length - length, null);
        if (read === 0) break;
        length += read;
      }
      const after = fstatSync(fd);
      if (length > ATOMIC_REPORT_MAX_BYTES || after.size > ATOMIC_REPORT_MAX_BYTES) result = reportStatus('OVERSIZED');
      else if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || length !== after.size) result = reportStatus('CHANGED');
      else result = parseAtomicFixtureReport(bytes.subarray(0, length));
    }
  } catch (error) {
    result = reportStatus(error?.code === 'ENOENT' ? 'MISSING' : 'UNREADABLE');
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { result = reportStatus('UNREADABLE'); }
    }
  }
  return result;
}

function childFailure(error) {
  if (error?.code === 'ETIMEDOUT') return 'TIMEOUT';
  if (['ENOENT', 'EACCES', 'ENOEXEC'].includes(error?.code) && !error?.pid) return 'LAUNCH_FAILED';
  if (Number.isInteger(error?.status) && error.status !== 0) return 'EXIT_FAILED';
  return 'COMMAND_FAILED';
}

export function runAtomicFixtureChild({ file, args, options, reportPath, emit, execute = execFileSync }) {
  let childStatus = 'PASSED';
  try { execute(file, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options }); }
  catch (error) { childStatus = childFailure(error); }
  const report = readAtomicFixtureReport(reportPath);
  if (childStatus !== 'PASSED' || report.status !== 'PASSED') {
    emit(JSON.stringify({ phase: 'ATOMIC_CHILD', status: childStatus }));
    emit(JSON.stringify(report));
    // Never attach the original error/cause: execFileSync errors contain output,
    // argv and input. A nominal report cannot turn a failed child into success.
    throw new Error('ISOLATED_ATOMIC_FIXTURE_FAILED');
  }
  return report;
}
