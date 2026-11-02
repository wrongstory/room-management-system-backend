import { execFile, fork } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it, vi } from 'vitest';
import { superviseMigrationProcess } from '../scripts/lib/migration-process-supervisor.mjs';

const path = process.platform === 'win32' ? 'C:\\synthetic\\request.json' : '/synthetic/request.json';
const argv = ['apply', '--request', path, '--approval-id', '10000000-0000-4000-8000-000000000001'];
const fixturePath = fileURLToPath(new URL('./fixtures/migration-watchdog-child.mjs', import.meta.url));
const input = text => { const stream = new PassThrough(); stream.end(text ?? '{"password":"synthetic-only"}'); return stream; };
const successful = () => ({ mode: 'APPLY_RESULT', classification: 'APPLIED', code: 'MIGRATION_SUPERVISOR_COMPLETE', appliedCount: 1, pendingCount: 1,
  requestSha256: 'a'.repeat(64), runId: '20000000-0000-4000-8000-000000000001', elapsedMs: 1, retryAllowed: false, evidenceScope: 'TRUSTED_ADAPTER_RESULTS', fullDbProofRunId: 1 });
function fake(options = {}) {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null; child.unref = vi.fn(); child.disconnect = vi.fn();
  child.kill = vi.fn(signal => { if (!options.noExit) queueMicrotask(() => { child.signalCode = signal; child.emit('exit', null, signal); }); return !options.noExit; });
  child.send = vi.fn((message, callback) => {
    callback?.();
    if (message.type === 'START') {
      child.nonce = message.nonce;
      queueMicrotask(() => child.emit('message', { type: 'INPUT_READY', nonce: child.nonce }));
    } else if (message.type === 'INPUT_ARMED') {
      child.stdin.resume(); child.stdin.once('end', () => {
        if (!options.noExecution) child.emit('message', { type: 'EXECUTION_READY', nonce: child.nonce, requestSha256: 'a'.repeat(64), overallMs: options.overallMs ?? 100 });
      });
    } else if (message.type === 'EXECUTION_ARMED') {
      options.onArmed?.(child);
      if (!options.noResult) queueMicrotask(() => {
        child.emit('message', { type: 'RESULT', nonce: child.nonce, result: options.result ?? successful() });
        if (!options.linger) queueMicrotask(() => { child.exitCode = options.exitCode ?? 0; child.emit('exit', child.exitCode, null); });
      });
    }
  });
  return child;
}
const runFake = (child, extra = {}) => superviseMigrationProcess({ launch: () => { queueMicrotask(() => child.emit('message', { type: 'READY_TO_START' })); return child; },
  args: argv, input: input(), preflightMs: 200, executionMaxMs: 200, closeMs: 30, ...extra });
describe('#378 external process ownership/protocol with memory fakes', () => {
  it('returns the safe result only after normal child exit and preserves the secret pipe boundary', async () => {
    const child = fake(); const result = await runFake(child);
    expect(result).toEqual(successful()); expect(child.exitCode).toBe(0); expect(child.kill).not.toHaveBeenCalled();
    expect(JSON.stringify(child.send.mock.calls)).not.toContain('synthetic-only');
  });
  it('waits for actual exit even after a successful child result', async () => {
    const child = fake({ linger: true }); const result = await runFake(child);
    expect(result).toMatchObject({ mode: 'PROCESS_STOPPED', classification: 'UNKNOWN', childExitConfirmed: true, retryAllowed: false });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });
  it('does not claim backend termination or rollback after killing its child', async () => {
    const child = fake({ noResult: true, overallMs: 15 }); const result = await runFake(child);
    expect(result).toMatchObject({ code: 'MIGRATION_PROCESS_DEADLINE', classification: 'UNKNOWN', childExitConfirmed: true, backendTerminationVerified: false, stateReadbackVerified: false });
  });
  it('returns bounded UNKNOWN if OS termination cannot be confirmed', async () => {
    const child = fake({ noResult: true, noExit: true, overallMs: 15 }); const start = performance.now(); const result = await runFake(child);
    expect(result).toMatchObject({ classification: 'UNKNOWN', childExitConfirmed: false }); expect(performance.now() - start).toBeLessThan(1000);
    expect(child.kill).toHaveBeenCalledTimes(1); expect(child.unref).toHaveBeenCalledTimes(1);
  });
  it('rejects a forged result hash and never forwards extra data', async () => {
    const child = fake({ result: { ...successful(), requestSha256: 'b'.repeat(64) } });
    expect(await runFake(child)).toMatchObject({ code: 'MIGRATION_PROCESS_PROTOCOL_FAILED', classification: 'UNKNOWN' });
  });
  it.each(['stdout', 'stderr'])('rejects unexpected %s without exposing its content', async stream => {
    const child = fake({ onArmed: value => value[stream].write('SYNTHETIC_PRIVATE_OUTPUT'), noResult: true });
    const result = await runFake(child); expect(result.code).toBe('MIGRATION_PROCESS_OUTPUT_REJECTED'); expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });
  it('rejects oversized input and destroys the source stream', async () => {
    const stream = input('x'.repeat(196609)); const child = fake(); const result = await runFake(child, { input: stream });
    expect(result.code).toBe('MIGRATION_PROCESS_INPUT_FAILED'); expect(stream.destroyed).toBe(true);
  });
  it('rejects duplicate execution-arm requests without granting extra time', async () => {
    const child = fake({ noResult: true, onArmed: value => queueMicrotask(() => value.emit('message', { type: 'EXECUTION_READY', nonce: value.nonce, requestSha256: 'a'.repeat(64), overallMs: 100 })) });
    expect(await runFake(child)).toMatchObject({ code: 'MIGRATION_PROCESS_PROTOCOL_FAILED' });
  });
  it('does not read credentials before the child finishes source verification', async () => {
    const child = fake(); const stream = input(); child.send = vi.fn((_message, callback) => callback?.());
    const result = await runFake(child, { input: stream, preflightMs: 15 });
    expect(result.code).toBe('MIGRATION_PROCESS_DEADLINE'); expect(child.stdin.readableLength).toBe(0);
  });
  it('removes its signal handlers after completion', async () => {
    const before = ['SIGINT', 'SIGTERM', 'exit'].map(name => process.listenerCount(name));
    await runFake(fake()); expect(['SIGINT', 'SIGTERM', 'exit'].map(name => process.listenerCount(name))).toEqual(before);
  });
  it('does not accept nonzero exit as successful readback', async () => {
    expect(await runFake(fake({ exitCode: 1 }))).toMatchObject({ code: 'MIGRATION_PROCESS_EXIT_FAILED', classification: 'UNKNOWN' });
  });
  it('does not launch when arguments or limits are invalid', () => {
    const launch = vi.fn(); expect(() => superviseMigrationProcess({ launch, args: [], input: input(), preflightMs: 200, executionMaxMs: 200, closeMs: 30 })).toThrow();
    expect(() => superviseMigrationProcess({ launch, args: argv, input: input(), preflightMs: 0, executionMaxMs: 200, closeMs: 30 })).toThrow(); expect(launch).not.toHaveBeenCalled();
  });
});
describe('#378 actual child process watchdog, synthetic code and zero DB access', () => {
  it('accepts an actual synthetic child result only after exit', async () => {
    let child;
    const result = await superviseMigrationProcess({ args: argv, input: input(), preflightMs: 3000, executionMaxMs: 1000, closeMs: 500,
      launch: () => { child = fork(fixturePath, ['complete'], { execArgv: [], env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }); return child; } });
    expect(result).toEqual(successful()); expect(child.exitCode).toBe(0);
  });
  it('rejects direct private-child launch without IPC before loading execution code', async () => {
    const target = fileURLToPath(new URL('../scripts/migration-execution-child.mjs', import.meta.url));
    await expect(promisify(execFile)(process.execPath, [target], { env: {}, windowsHide: true, timeout: 3000 })).rejects.toMatchObject({ code: 1, stdout: '', stderr: '' });
  });
  it.each(['block-preflight', 'block-execution'])('terminates only its owned child with blocked event loop: %s', async mode => {
    let child; const messages = [];
    const start = performance.now();
    const result = await superviseMigrationProcess({ args: argv, input: input(), preflightMs: mode === 'block-preflight' ? 1200 : 3000, executionMaxMs: 100, closeMs: 500,
      launch: () => { child = fork(fixturePath, [mode], { execArgv: [], env: {}, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'ipc'] }); child.on('message', message => messages.push(message.type)); return child; } });
    expect(result).toMatchObject({ code: 'MIGRATION_PROCESS_DEADLINE', classification: 'UNKNOWN', childExitConfirmed: true, backendTerminationVerified: false, stateReadbackVerified: false });
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true); expect(performance.now() - start).toBeLessThan(5000);
    expect(messages).toContain('READY_TO_START'); if (mode === 'block-execution') expect(messages).toContain('EXECUTION_READY');
  }, 7000);
});
