import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type BackupProcessProbeLimits,
  runBackupProcessProbe,
} from '../scripts/lib/backup-process-boundary.mjs';

const control = vi.hoisted(() => ({
  calls: 0,
  fake: null as null | (() => ChildProcessWithoutNullStreams),
  options: null as unknown,
  executable: '',
  args: [] as string[],
  metadata: 'actual' as 'actual' | 'synthetic' | 'lstat-hang' | 'realpath-hang' | 'reject' | 'exhausted',
  pendingResolve: null as null | (() => void),
  metadataCalls: 0,
  exhausted: false,
}));
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:process')>();
  return { ...actual, get platform() { return control.metadata === 'actual' ? actual.platform : 'win32'; } };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: (path: string) => {
      control.metadataCalls += 1;
      if (control.metadata === 'actual') return actual.lstat(path);
      if (control.metadata === 'reject') return Promise.reject(new Error('private metadata failure'));
      const metadata = { isSymbolicLink: () => false, isFile: () => path.endsWith('.dll'), isDirectory: () => !path.endsWith('.dll') };
      if (control.metadata === 'lstat-hang') return new Promise((resolve) => { control.pendingResolve = () => resolve(metadata); });
      return Promise.resolve(metadata);
    },
    realpath: (path: string) => {
      control.metadataCalls += 1;
      if (control.metadata === 'actual') return actual.realpath(path);
      if (control.metadata === 'realpath-hang') return new Promise((resolve) => { control.pendingResolve = () => resolve(path); });
      if (control.metadata === 'exhausted') control.exhausted = true;
      return Promise.resolve(path);
    },
  };
});
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: (executable: string, args: string[], options: unknown) => {
      control.calls += 1; control.executable = executable; control.args = args; control.options = options;
      if (control.fake) return control.fake();
      return actual.spawn(executable, args, options as Parameters<typeof actual.spawn>[2]);
    },
  };
});
afterEach(() => {
  control.calls = 0; control.fake = null; control.options = null;
  control.metadata = 'actual'; control.pendingResolve = null; control.metadataCalls = 0; control.exhausted = false;
  vi.restoreAllMocks(); vi.useRealTimers();
});

function fakeChild() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true), unref: vi.fn(),
  });
  return child;
}
const quick: BackupProcessProbeLimits = { wholeDeadlineMs: 150, stdinDeadlineMs: 100, terminationDeadlineMs: 150 };
// Real OS startup competes with other Vitest workers and is not a 100ms contract.
// Use the unchanged supervisor defaults for actual children; exact short deadlines
// are independently asserted below with controlled streams and a virtual clock.
const actualChild: BackupProcessProbeLimits = {
  wholeDeadlineMs: 2000, stdinDeadlineMs: 1000, terminationDeadlineMs: 500,
};

function controlledChild(acceptInput: boolean) {
  const child = fakeChild();
  Object.assign(child.stdin, {
    end: (_input: Buffer, callback: (error?: Error) => void) => {
      if (acceptInput) queueMicrotask(() => callback());
      return child.stdin;
    },
  });
  child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; });
  control.fake = () => { queueMicrotask(() => child.emit('spawn')); return child; };
  control.metadata = 'synthetic';
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  return child;
}

describe('internal synthetic backup process boundary, not a production executor', () => {
  it.each(['stdio-success', 'environment-isolation'] as const)('runs fixed %s without inherited environment/output reports', async (probe) => {
    const value = await runBackupProcessProbe(probe, { wholeDeadlineMs: 1000, stdinDeadlineMs: 900 });
    expect(value.code).toBe('COMPLETED');
    expect(value).toMatchObject({ spawned: true, closeObserved: true, stdinAccepted: true, terminationRequested: false });
    expect(Object.isFrozen(value)).toBe(true);
    expect(control.options).toEqual({ shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: {
      TZ: 'UTC', NODE_NO_WARNINGS: '1', NODE_V8_COVERAGE: '', NODE_OPTIONS: '',
      HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', PATH: '', SYSTEMDRIVE: '',
      SYSTEMROOT: 'C:\\Windows', TEMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', WINDIR: 'C:\\Windows',
    } });
    expect(control.executable).toBe(process.execPath);
    expect(control.args.slice(0, 2)).toEqual(['--input-type=commonjs', '--eval']);
    expect(JSON.stringify(value)).not.toContain('synthetic stdout');
    expect(JSON.stringify(value)).not.toContain('synthetic environment verdict');
  });
  it('returns only a fixed nonzero verdict, never stderr/native error content', async () => {
    const value = await runBackupProcessProbe('nonzero-exit', { wholeDeadlineMs: 1000, stdinDeadlineMs: 900 });
    expect(value.code).toBe('PROCESS_EXIT_NONZERO');
    expect(value.closeObserved).toBe(true);
    expect(value.stderrBytes).toBeGreaterThan(0);
    expect(JSON.stringify(value)).not.toContain('synthetic failure');
    expect(Object.keys(value)).toEqual(['mode', 'code', 'spawned', 'closeObserved', 'terminationRequested', 'stdinAccepted', 'stdoutBytes', 'stderrBytes']);
  });
  it.each([['stdout-limit', 'STDOUT_LIMIT', 'stdoutBytes'], ['stderr-limit', 'STDERR_LIMIT', 'stderrBytes']] as const)(
    'stops and confirms owned child close on %s byte cap', async (probe, code, count) => {
      const value = await runBackupProcessProbe(probe, { ...actualChild, maxStdoutBytes: 32, maxStderrBytes: 32 });
      expect(value.code).toBe(code);
      expect(value[count]).toBe(33);
      expect(value).toMatchObject({ spawned: true, closeObserved: true, terminationRequested: true });
    },
  );
  it('bounds blocked stdin and confirms close after kill', async () => {
    const value = await runBackupProcessProbe('stdin-stall', { ...actualChild, stdinBytes: 1048576 });
    expect(value.code).toBe('STDIN_DEADLINE');
    expect(value).toMatchObject({ spawned: true, closeObserved: true, terminationRequested: true, stdinAccepted: false });
  });
  it('bounds whole process lifetime independently of accepted stdin', async () => {
    const value = await runBackupProcessProbe('whole-deadline', actualChild);
    expect(value.code).toBe('PROCESS_DEADLINE');
    expect(value).toMatchObject({ spawned: true, closeObserved: true, terminationRequested: true, stdinAccepted: true });
  });
  it.each([['stdout-limit', 'stdout', 'STDOUT_LIMIT', 'stdoutBytes'], ['stderr-limit', 'stderr', 'STDERR_LIMIT', 'stderrBytes']] as const)(
    'enforces exact %s cap before either short deadline on controlled accepted stdin', async (probe, stream, code, count) => {
      const child = controlledChild(true);
      const pending = runBackupProcessProbe(probe, { ...quick, maxStdoutBytes: 32, maxStderrBytes: 32 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(99);
      expect(child.kill).not.toHaveBeenCalled();
      (child[stream] as PassThrough).write(Buffer.alloc(32, 65));
      expect(child.kill).not.toHaveBeenCalled();
      (child[stream] as PassThrough).write(Buffer.alloc(1, 65));
      const value = await pending;
      expect(value).toMatchObject({ code, spawned: true, closeObserved: true, terminationRequested: true, stdinAccepted: true });
      expect(value[count]).toBe(33);
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
      await vi.advanceTimersByTimeAsync(1000);
      expect(child.unref).not.toHaveBeenCalled();
    },
  );
  it('enforces the 100ms stdin deadline exactly, independently of OS startup', async () => {
    const child = controlledChild(false);
    const pending = runBackupProcessProbe('stdin-stall', quick);
    await vi.advanceTimersByTimeAsync(99);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const value = await pending;
    expect(value).toMatchObject({ code: 'STDIN_DEADLINE', spawned: true, closeObserved: true, terminationRequested: true, stdinAccepted: false });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.unref).not.toHaveBeenCalled();
  });
  it('enforces the 150ms whole deadline after accepted stdin, independently of OS startup', async () => {
    const child = controlledChild(true);
    const pending = runBackupProcessProbe('whole-deadline', quick);
    await vi.advanceTimersByTimeAsync(149);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const value = await pending;
    expect(value).toMatchObject({ code: 'PROCESS_DEADLINE', spawned: true, closeObserved: true, terminationRequested: true, stdinAccepted: true });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(1000);
    expect(child.unref).not.toHaveBeenCalled();
  });
  it.each([null, [], 1, { arbitraryCommand: 'never executed' }, { shell: true }, { env: {} },
    { stdinBytes: -1 }, { stdinBytes: 1048577 }, { wholeDeadlineMs: Infinity }, { wholeDeadlineMs: 5001 },
    { stdinDeadlineMs: 2001 }, { terminationDeadlineMs: 1001 }, { maxStderrBytes: 65537 },
    { wholeDeadlineMs: 20, stdinDeadlineMs: 21 }])('rejects invalid/expansive configuration before spawn: %j', async (input) => {
    const value = await runBackupProcessProbe('stdio-success', input as BackupProcessProbeLimits);
    expect(value.code).toBe('INVALID_LIMITS');
    expect(control.calls).toBe(0);
  });
  it('rejects proxy/accessor/symbol/inherited configurations without getter/trap calls', async () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, 'stdinBytes', { enumerable: true, get() { calls += 1; throw new Error('never report'); } });
    const proxy = new Proxy({}, { ownKeys() { calls += 1; throw new Error('never report'); } });
    const revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const value of [accessor, proxy, revoked.proxy, { [Symbol('unknown')]: 0 }, Object.create({ stdinBytes: 1 })]) {
      expect((await runBackupProcessProbe('stdio-success', value)).code).toBe('INVALID_LIMITS');
    }
    expect(calls).toBe(0); expect(control.calls).toBe(0);
  });
  it.each(['constructor', '__proto__', '', 'powershell', 'stdio-success --eval unexpected'])('rejects arbitrary program %s', async (probe) => {
    expect((await runBackupProcessProbe(probe as 'stdio-success')).code).toBe('INVALID_PROBE');
    expect(control.calls).toBe(0);
  });
  it('discards a synchronous spawn exception and never echoes its cause', async () => {
    control.fake = () => { throw new Error('native private error must not escape'); };
    const value = await runBackupProcessProbe('stdio-success');
    expect(value).toMatchObject({ code: 'SPAWN_FAILED', spawned: false, closeObserved: false });
    expect(JSON.stringify(value)).not.toContain('private');
  });
  it('does not equate a kill request or exit with confirmed close', async () => {
    const child = fakeChild(); control.fake = () => child;
    child.kill = vi.fn(() => { child.emit('exit', 0, null); return true; });
    const value = await runBackupProcessProbe('whole-deadline', { ...quick, wholeDeadlineMs: 20, stdinDeadlineMs: 10, terminationDeadlineMs: 10 });
    expect(value).toMatchObject({ code: 'PROCESS_STOP_UNCONFIRMED', closeObserved: false, terminationRequested: true });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    expect(child.unref).toHaveBeenCalledTimes(1);
    child.emit('close', 0, null);
  });
  it('preserves a fixed async spawn failure only when close was observed', async () => {
    const child = fakeChild();
    control.fake = () => { queueMicrotask(() => child.emit('error', new Error('private native spawn failure'))); return child; };
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', -1, null)); return true; });
    const value = await runBackupProcessProbe('stdio-success', quick);
    expect(value).toMatchObject({ code: 'SPAWN_FAILED', spawned: false, closeObserved: true, terminationRequested: true });
    expect(JSON.stringify(value)).not.toContain('private');
  });
  it.each(['stdin', 'stdout', 'stderr'] as const)('safely stops a failed %s stream and awaits close', async (stream) => {
    const child = fakeChild();
    control.fake = () => { queueMicrotask(() => child[stream].emit('error', new Error('private stream error'))); return child; };
    child.kill = vi.fn(() => { queueMicrotask(() => child.emit('close', null, 'SIGKILL')); return true; });
    const value = await runBackupProcessProbe('stdio-success', quick);
    expect(value).toMatchObject({ code: stream === 'stdin' ? 'STDIN_FAILED' : 'OUTPUT_FAILED', closeObserved: true, terminationRequested: true });
    expect(JSON.stringify(value)).not.toContain('private');
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });
  it('kill errors remain unconfirmed fixed failures, not raw native exceptions', async () => {
    const child = fakeChild(); control.fake = () => child;
    child.kill = vi.fn(() => { throw new Error('private native kill error'); });
    const value = await runBackupProcessProbe('whole-deadline', { wholeDeadlineMs: 20, stdinDeadlineMs: 10, terminationDeadlineMs: 10 });
    expect(value).toMatchObject({ code: 'PROCESS_STOP_UNCONFIRMED', closeObserved: false, terminationRequested: true });
    expect(JSON.stringify(value)).not.toContain('private');
    child.emit('close', null, 'SIGKILL');
  });
  it('a synchronous close racing kill clears all termination timers', async () => {
    const child = fakeChild(); control.fake = () => child;
    child.kill = vi.fn(() => { child.emit('close', null, 'SIGKILL'); return true; });
    const value = await runBackupProcessProbe('whole-deadline', { wholeDeadlineMs: 20, stdinDeadlineMs: 10, terminationDeadlineMs: 10 });
    expect(value).toMatchObject({ code: 'PROCESS_DEADLINE', closeObserved: true, terminationRequested: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(child.unref).not.toHaveBeenCalled();
  });
  it('accepts exact own data-only zero stdin limits without inherited options', async () => {
    const limits = Object.assign(Object.create(null), { stdinBytes: 0 });
    const value = await runBackupProcessProbe('stdio-success', limits);
    expect(value).toMatchObject({ code: 'COMPLETED', closeObserved: true, stdinAccepted: true });
  });
  it.each(['lstat-hang', 'realpath-hang'] as const)('bounds %s preflight and never uses late completion or spawns', async (mode) => {
    control.metadata = mode;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const pending = runBackupProcessProbe('stdio-success', { wholeDeadlineMs: 20, stdinDeadlineMs: 10 });
    await vi.advanceTimersByTimeAsync(25);
    const value = await pending;
    expect(value).toMatchObject({ code: 'PRECHECK_DEADLINE', spawned: false, closeObserved: false, terminationRequested: false });
    expect(control.calls).toBe(0);
    const before = control.metadataCalls;
    expect(control.pendingResolve).not.toBeNull();
    control.pendingResolve?.();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(control.calls).toBe(0);
    expect(control.metadataCalls).toBe(before);
  });
  it('discards native preflight rejection as a fixed no-spawn runtime failure', async () => {
    control.metadata = 'reject';
    const value = await runBackupProcessProbe('stdio-success', quick);
    expect(value).toMatchObject({ code: 'UNTRUSTED_RUNTIME', spawned: false });
    expect(control.calls).toBe(0);
    expect(JSON.stringify(value)).not.toContain('private');
  });
  it('refuses spawn when preflight exhausts the monotonic call budget before timers fire', async () => {
    control.metadata = 'exhausted';
    vi.spyOn(performance, 'now').mockImplementation(() => control.exhausted ? 25 : 0);
    const value = await runBackupProcessProbe('stdio-success', { wholeDeadlineMs: 20, stdinDeadlineMs: 10 });
    expect(value).toMatchObject({ code: 'PRECHECK_DEADLINE', spawned: false });
    expect(control.calls).toBe(0);
  });
});
