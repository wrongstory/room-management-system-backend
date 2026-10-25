/** External watchdog. Never loads the pg driver or treats a killed child as DB rollback proof. */
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { copyMigrationData, exactMigrationKeys } from './migration-evidence-input.mjs';

const childPath = fileURLToPath(new URL('../migration-execution-child.mjs', import.meta.url));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const resultCodes = new Set(['COMPLETE', 'APPROVAL_TOO_SHORT', 'DEADLINE', 'PRESTATE_MISMATCH', 'STATE_UNKNOWN', 'CLOSE_FAILED', 'STOPPED'].map(code => `MIGRATION_SUPERVISOR_${code}`));
function argumentsFor(args) {
  if (!Array.isArray(args) || !['plan', 'apply'].includes(args[0]) || args[1] !== '--request'
    || typeof args[2] !== 'string' || args[2].length > 4096 || !isAbsolute(args[2])
    || args[0] === 'plan' && args.length !== 3
    || args[0] === 'apply' && (args.length !== 5 || args[3] !== '--approval-id' || !uuid.test(args[4]))) throw new Error('MIGRATION_EXECUTION_FAILED');
  return Object.freeze([...args]);
}
function safeResult(input, mode) {
  const value = copyMigrationData(input);
  if (mode === 'plan') {
    exactMigrationKeys(value, ['mode', 'request', 'bundleSha256', 'sourceBound', 'pendingCount', 'expectedFinalHistorySha256', 'liveDatabaseObserved']);
    exactMigrationKeys(value.request, ['mode', 'requestSha256', 'sourceSha256', 'pendingCount', 'remoteEvidenceAuthenticated', 'approvalAuthenticated']);
    if (value.mode !== 'PLAN_ONLY' || value.sourceBound !== true || value.liveDatabaseObserved !== false
      || value.request.mode !== 'EXACT_RELEASE_REQUEST' || value.request.remoteEvidenceAuthenticated !== false || value.request.approvalAuthenticated !== false
      || value.request.pendingCount !== value.pendingCount) throw new Error();
    for (const hash of [value.bundleSha256, value.expectedFinalHistorySha256, value.request.requestSha256, value.request.sourceSha256]) if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error();
  } else {
    exactMigrationKeys(value, ['mode', 'classification', 'code', 'appliedCount', 'pendingCount', 'requestSha256', 'runId', 'elapsedMs', 'retryAllowed', 'evidenceScope', 'fullDbProofRunId']);
    if (value.mode !== 'APPLY_RESULT' || !['APPLIED', 'NOT_APPLIED', 'UNKNOWN', 'NOT_STARTED'].includes(value.classification)
      || !resultCodes.has(value.code) || value.retryAllowed !== false || value.evidenceScope !== 'TRUSTED_ADAPTER_RESULTS'
      || !/^[a-f0-9]{64}$/u.test(value.requestSha256) || !uuid.test(value.runId)
      || !Number.isSafeInteger(value.appliedCount) || value.appliedCount < 0 || value.appliedCount > value.pendingCount
      || !Number.isSafeInteger(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 120500
      || !Number.isSafeInteger(value.fullDbProofRunId) || value.fullDbProofRunId < 1
      || value.code === 'MIGRATION_SUPERVISOR_COMPLETE' && (value.classification !== 'APPLIED' || value.appliedCount !== value.pendingCount)) throw new Error();
  }
  if (!Number.isSafeInteger(value.pendingCount) || value.pendingCount < 1 || value.pendingCount > 10000) throw new Error();
  return value;
}

/** Internal testable ownership core; public CLI uses only the fixed launcher below. */
export function superviseMigrationProcess({ launch, args, input, preflightMs, executionMaxMs, closeMs }) {
  const argv = argumentsFor(args);
  for (const [value, maximum] of [[preflightMs, 240000], [executionMaxMs, 120000], [closeMs, 500]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error('MIGRATION_PROCESS_LIMIT_INVALID');
  }
  if (typeof launch !== 'function') throw new Error('MIGRATION_PROCESS_LIMIT_INVALID');
  return new Promise(resolve => {
    const nonce = randomUUID(); const started = performance.now(); const absoluteEnd = started + preflightMs + executionMaxMs;
    let child; let deadlineTimer; let closeTimer; let inputTimer; let result; let stopCode; let settled = false; let exited = false;
    let booted = false; let inputStarted = false; let executionStarted = false; let requestSha256; let inputBytes = 0; let inputEnded = argv[0] === 'plan'; let currentDeadline;
    const finish = value => {
      if (settled) return; settled = true; clearTimeout(deadlineTimer); clearTimeout(closeTimer); clearTimeout(inputTimer);
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted); process.removeListener('exit', emergencyExit);
      input?.removeListener('data', onInput); input?.removeListener('end', onInputEnd); input?.removeListener('error', onInputError);
      if (!exited) { child?.unref(); try { child?.disconnect(); } catch { /* no native details */ } }
      child?.stdin?.destroy(); child?.stdout?.destroy(); child?.stderr?.destroy(); resolve(value);
    };
    const stopped = () => finish(Object.freeze({ mode: 'PROCESS_STOPPED', classification: 'UNKNOWN', code: stopCode,
      retryAllowed: false, childExitConfirmed: exited, backendTerminationVerified: false, stateReadbackVerified: false }));
    const stop = code => {
      if (settled || stopCode) return; stopCode = code; clearTimeout(deadlineTimer); clearTimeout(inputTimer);
      if (argv[0] === 'apply') input?.destroy();
      child?.stdin?.destroy();
      // Only this ChildProcess handle is eligible. Never a caller PID, process group, tree, or DB backend PID.
      if (child && !exited && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL'); } catch { /* absence of exit confirmation remains UNKNOWN */ }
      }
      if (exited || !child) { stopped(); return; }
      closeTimer = setTimeout(stopped, closeMs);
    };
    const arm = end => {
      clearTimeout(deadlineTimer);
      currentDeadline = Math.min(end, absoluteEnd);
      deadlineTimer = setTimeout(() => stop('MIGRATION_PROCESS_DEADLINE'), Math.max(1, Math.ceil(currentDeadline - performance.now())));
    };
    const send = message => {
      try { child.send(message, error => { if (error) stop('MIGRATION_PROCESS_IPC_FAILED'); }); }
      catch { stop('MIGRATION_PROCESS_IPC_FAILED'); }
    };
    function onInput(chunk) {
      if (settled || stopCode) return;
      const bytes = Buffer.from(chunk); inputBytes += bytes.length;
      if (inputBytes > 196608) { bytes.fill(0); stop('MIGRATION_PROCESS_INPUT_FAILED'); return; }
      try {
        const writable = child.stdin.write(bytes, error => { bytes.fill(0); if (error) stop('MIGRATION_PROCESS_INPUT_FAILED'); });
        if (!writable) input.pause();
      } catch { bytes.fill(0); stop('MIGRATION_PROCESS_INPUT_FAILED'); }
    }
    function onInputEnd() { inputEnded = true; clearTimeout(inputTimer); child?.stdin?.end(); }
    function onInputError() { stop('MIGRATION_PROCESS_INPUT_FAILED'); }
    function interrupted() { stop('MIGRATION_PROCESS_INTERRUPTED'); }
    function emergencyExit() { if (!exited && child?.exitCode === null && child?.signalCode === null) { try { child.kill('SIGKILL'); } catch { /* never signal an unrelated process */ } } }
    process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted); process.once('exit', emergencyExit);
    arm(started + preflightMs);
    try { child = launch(); } catch { stop('MIGRATION_PROCESS_START_FAILED'); return; }
    if (!child?.stdin || !child.stdout || !child.stderr || typeof child.send !== 'function') { stop('MIGRATION_PROCESS_START_FAILED'); return; }
    child.stdin.on('error', onInputError); child.stdin.on('drain', () => { if (!stopCode && !settled) input?.resume(); });
    // Only the bounded IPC protocol can carry a result. Never relay raw child output/errors.
    child.stdout.on('data', () => stop('MIGRATION_PROCESS_OUTPUT_REJECTED'));
    child.stderr.on('data', () => stop('MIGRATION_PROCESS_OUTPUT_REJECTED'));
    child.stdout.on('error', () => stop('MIGRATION_PROCESS_OUTPUT_REJECTED'));
    child.stderr.on('error', () => stop('MIGRATION_PROCESS_OUTPUT_REJECTED'));
    child.on('error', () => stop('MIGRATION_PROCESS_START_FAILED'));
    child.on('disconnect', () => { if (!result && !stopCode) stop('MIGRATION_PROCESS_IPC_FAILED'); });
    child.on('exit', (code, signal) => {
      exited = true;
      if (stopCode) { stopped(); return; }
      if (code === 0 && signal === null && result) finish(result);
      else { stopCode = 'MIGRATION_PROCESS_EXIT_FAILED'; stopped(); }
    });
    child.on('message', raw => {
      if (settled || stopCode) return;
      if (performance.now() >= currentDeadline) { stop('MIGRATION_PROCESS_DEADLINE'); return; }
      try {
        const message = copyMigrationData(raw);
        if (!booted) {
          exactMigrationKeys(message, ['type']); if (message.type !== 'READY_TO_START') throw new Error(); booted = true;
          send({ type: 'START', nonce, args: argv });
          if (argv[0] === 'plan') child.stdin.end();
          return;
        }
        if (message.nonce !== nonce) throw new Error();
        if (message.type === 'INPUT_READY') {
          exactMigrationKeys(message, ['type', 'nonce']);
          if (argv[0] !== 'apply' || inputStarted || executionStarted || !input || input.isTTY || input.destroyed) throw new Error();
          inputStarted = true;
          input.on('error', onInputError); input.on('end', onInputEnd); input.on('data', onInput);
          inputTimer = setTimeout(() => stop('MIGRATION_PROCESS_INPUT_FAILED'), 30000);
          send({ type: 'INPUT_ARMED', nonce }); return;
        }
        if (message.type === 'EXECUTION_READY') {
          exactMigrationKeys(message, ['type', 'nonce', 'requestSha256', 'overallMs']);
          if (argv[0] !== 'apply' || !inputStarted || executionStarted || result || !inputEnded || !/^[a-f0-9]{64}$/u.test(message.requestSha256)
            || !Number.isSafeInteger(message.overallMs) || message.overallMs < 1 || message.overallMs > executionMaxMs) throw new Error();
          executionStarted = true; requestSha256 = message.requestSha256; arm(performance.now() + message.overallMs);
          send({ type: 'EXECUTION_ARMED', nonce, requestSha256 }); return;
        }
        exactMigrationKeys(message, ['type', 'nonce', 'result']);
        if (message.type !== 'RESULT' || result || argv[0] === 'apply' && !executionStarted) throw new Error();
        result = safeResult(message.result, argv[0]);
        if (argv[0] === 'apply' && result.requestSha256 !== requestSha256) throw new Error();
        // A successful result with a stuck process is still not a completed invocation.
        arm(Math.min(currentDeadline, performance.now() + closeMs));
      } catch { stop('MIGRATION_PROCESS_PROTOCOL_FAILED'); }
    });
  });
}

export function runMigrationProcess(args, input = process.stdin) {
  const argv = argumentsFor(args);
  if (process.execArgv.length !== 0 || process.env.NODE_OPTIONS || process.env.NODE_PATH) throw new Error('MIGRATION_EXECUTION_FAILED');
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  return superviseMigrationProcess({ args: argv, input, preflightMs: 240000, executionMaxMs: 120000, closeMs: 500,
    launch: () => fork(childPath, [], { execPath: process.execPath, execArgv: [], env, windowsHide: true,
      detached: false, serialization: 'json', stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }) });
}
