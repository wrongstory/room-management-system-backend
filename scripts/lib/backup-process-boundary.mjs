import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, basename } from 'node:path';
import { execPath, platform } from 'node:process';
import { types } from 'node:util';

// Node propagates NODE_V8_COVERAGE and Windows libuv adds omitted essential
// variables from the parent. Explicit empty values suppress both implicit paths.
const PROBE_ENV = Object.freeze({
  TZ: 'UTC', NODE_NO_WARNINGS: '1', NODE_V8_COVERAGE: '', NODE_OPTIONS: '',
  HOMEDRIVE: '', HOMEPATH: '', LOGONSERVER: '', PATH: '', SYSTEMDRIVE: '',
  SYSTEMROOT: 'C:\\Windows', TEMP: '', USERDOMAIN: '', USERNAME: '', USERPROFILE: '', WINDIR: 'C:\\Windows',
});
// No command/path/argv/environment/input callback is accepted. These programs cannot
// spawn descendants or access files/network/credentials. This is NOT a dump executor.
const PROBES = Object.freeze({
  'stdio-success': "process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('synthetic stdout\\n');process.stderr.write('synthetic stderr\\n');});",
  'nonzero-exit': "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('synthetic failure, never a report\\n');process.exitCode=7;});",
  'stdout-limit': "process.stdin.resume();const b=Buffer.alloc(1024,65);setInterval(()=>process.stdout.write(b),1);",
  'stderr-limit': "process.stdin.resume();const b=Buffer.alloc(1024,66);setInterval(()=>process.stderr.write(b),1);",
  'stdin-stall': "process.stdin.pause();setInterval(()=>{},1000);",
  'whole-deadline': "process.stdin.resume();setInterval(()=>{},1000);",
  'environment-isolation': `const expected=${JSON.stringify(PROBE_ENV)};const e=process.env;const k=Object.keys(e);const ok=k.length===Object.keys(expected).length&&k.every(n=>Object.hasOwn(expected,n)&&e[n]===expected[n]);process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write('synthetic environment verdict\\n');process.exitCode=ok?0:9;});`,
});
const LIMITS = Object.freeze({
  wholeDeadlineMs: Object.freeze([20, 5000, 2000]),
  stdinDeadlineMs: Object.freeze([10, 2000, 1000]),
  terminationDeadlineMs: Object.freeze([10, 1000, 500]),
  maxStdoutBytes: Object.freeze([0, 65536, 8192]),
  maxStderrBytes: Object.freeze([0, 65536, 8192]),
  stdinBytes: Object.freeze([0, 1048576, 64]),
});

function limitsOf(value) {
  if (value === undefined) value = {};
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  const output = Object.create(null);
  if (keys.some((key) => typeof key !== 'string' || !Object.hasOwn(LIMITS, key))) return null;
  for (const key of Object.keys(LIMITS)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && (!descriptor.enumerable || !('value' in descriptor))) return null;
    const [minimum, maximum, fallback] = LIMITS[key];
    const candidate = descriptor ? descriptor.value : fallback;
    if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) return null;
    output[key] = candidate;
  }
  if (output.stdinDeadlineMs > output.wholeDeadlineMs) return null;
  return output;
}

function report(code, state = {}) {
  return Object.freeze({
    mode: 'INTERNAL_SYNTHETIC_PROBE', code,
    spawned: state.spawned === true,
    closeObserved: state.closeObserved === true,
    terminationRequested: state.terminationRequested === true,
    stdinAccepted: state.stdinAccepted === true,
    stdoutBytes: state.stdoutBytes ?? 0,
    stderrBytes: state.stderrBytes ?? 0,
  });
}

async function supportedRuntime(isCurrent) {
  if (!isAbsolute(execPath) || !/^node(?:\.exe)?$/iu.test(basename(execPath))) return false;
  if (platform !== 'win32') return true;
  // This synthetic-only Windows branch supports the verified C:\Windows layout,
  // not arbitrary installations or caller paths. Metadata only; no DLL bytes/env.
  try {
    for (const path of ['C:\\', 'C:\\Windows', 'C:\\Windows\\System32', 'C:\\Windows\\System32\\kernel32.dll']) {
      if (!isCurrent()) return false;
      const metadata = await lstat(path);
      if (!isCurrent()) return false;
      if (metadata.isSymbolicLink() || (path.endsWith('.dll') ? !metadata.isFile() : !metadata.isDirectory())) return false;
      const canonical = await realpath(path);
      if (!isCurrent() || canonical.toLowerCase() !== path.toLowerCase()) return false;
    }
    return true;
  } catch { return false; }
}

/** Bounded, secret-free synthetic probes only. No production execution API or CLI. */
export async function runBackupProcessProbe(probe, options) {
  if (typeof probe !== 'string' || !Object.hasOwn(PROBES, probe)) return report('INVALID_PROBE');
  let limits;
  try { limits = limitsOf(options); } catch { return report('INVALID_LIMITS'); }
  if (!limits) return report('INVALID_LIMITS');
  const startedAt = performance.now();
  const remaining = () => limits.wholeDeadlineMs - (performance.now() - startedAt);
  let precheckActive = true;
  let precheckTimer;
  // OS metadata IO itself cannot be cancelled. The caller is bounded, and a late
  // completion is ignored and cannot continue checking paths or spawn a child.
  const runtimeCheck = supportedRuntime(() => precheckActive && remaining() > 0)
    .then((valid) => valid ? 'SUPPORTED' : 'UNTRUSTED_RUNTIME', () => 'UNTRUSTED_RUNTIME');
  const precheck = await Promise.race([
    runtimeCheck,
    new Promise((resolve) => {
      precheckTimer = setTimeout(() => {
        precheckActive = false;
        resolve('PRECHECK_DEADLINE');
      }, Math.max(0, remaining()));
    }),
  ]);
  precheckActive = false;
  clearTimeout(precheckTimer);
  if (precheck === 'PRECHECK_DEADLINE' || remaining() <= 0) return report('PRECHECK_DEADLINE');
  if (precheck !== 'SUPPORTED') return report('UNTRUSTED_RUNTIME');

  return new Promise((resolve) => {
    const state = {
      spawned: false, closeObserved: false, terminationRequested: false,
      stdinAccepted: false, stdoutBytes: 0, stderrBytes: 0,
    };
    let input;
    try { input = Buffer.alloc(limits.stdinBytes, 90); }
    catch { resolve(report('PROBE_MEMORY_UNAVAILABLE')); return; }
    let child;
    let failure;
    let settled = false;
    let stdinTimer;
    let terminationTimer;
    let wholeTimer;

    function finish(code) {
      if (settled) return;
      settled = true;
      clearTimeout(stdinTimer);
      clearTimeout(terminationTimer);
      clearTimeout(wholeTimer);
      input.fill(0);
      resolve(report(code, state));
    }
    function stop(code) {
      if (settled || state.closeObserved) return;
      if (!failure) failure = code;
      clearTimeout(stdinTimer);
      clearTimeout(wholeTimer);
      if (state.terminationRequested) return;
      state.terminationRequested = true;
      terminationTimer = setTimeout(() => {
        // A kill request/exit event is not proof of stdio+process close. Fail closed.
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          try { stream.destroy(); } catch { /* Never forward native output/error. */ }
        }
        try { child.unref(); } catch { /* Never forward native output/error. */ }
        finish('PROCESS_STOP_UNCONFIRMED');
      }, limits.terminationDeadlineMs);
      // Install the close deadline before kill: close can race with this request.
      // Only the returned, owned ChildProcess handle is signalled; never a caller PID.
      try { child.kill('SIGKILL'); } catch { /* Native messages are discarded. */ }
    }
    function output(stream, chunk) {
      if (settled || failure) return;
      const field = stream === 'stdout' ? 'stdoutBytes' : 'stderrBytes';
      const cap = stream === 'stdout' ? limits.maxStdoutBytes : limits.maxStderrBytes;
      // Content is never decoded, accumulated, returned, or printed. Counts saturate.
      state[field] = Math.min(cap + 1, state[field] + chunk.length);
      if (state[field] > cap) stop(stream === 'stdout' ? 'STDOUT_LIMIT' : 'STDERR_LIMIT');
    }
    if (remaining() <= 0) { finish('PRECHECK_DEADLINE'); return; }
    try {
      child = spawn(execPath, ['--input-type=commonjs', '--eval', PROBES[probe]], {
        shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
        // Deliberately no parent process.env read/spread or caller environment input.
        env: { ...PROBE_ENV },
      });
    } catch {
      finish('SPAWN_FAILED');
      return;
    }
    child.on('error', () => stop('SPAWN_FAILED'));
    child.stdin.on('error', () => stop('STDIN_FAILED'));
    child.stdout.on('error', () => stop('OUTPUT_FAILED'));
    child.stderr.on('error', () => stop('OUTPUT_FAILED'));
    child.stdout.on('data', (chunk) => output('stdout', chunk));
    child.stderr.on('data', (chunk) => output('stderr', chunk));
    child.once('close', (exitCode, signal) => {
      state.closeObserved = true;
      if (settled) return;
      if (failure) finish(failure);
      else if (exitCode !== 0 || signal !== null) finish('PROCESS_EXIT_NONZERO');
      else if (!state.stdinAccepted) finish('STDIN_FAILED');
      else finish('COMPLETED');
    });
    wholeTimer = setTimeout(() => stop('PROCESS_DEADLINE'), Math.max(0, remaining()));
    child.once('spawn', () => {
      state.spawned = true;
      if (settled || failure) return;
      stdinTimer = setTimeout(() => stop('STDIN_DEADLINE'), limits.stdinDeadlineMs);
      try {
        child.stdin.end(input, (error) => {
          if (settled || failure) return;
          if (error) { stop('STDIN_FAILED'); return; }
          state.stdinAccepted = true;
          clearTimeout(stdinTimer);
          input.fill(0);
        });
      } catch { stop('STDIN_FAILED'); }
    });
  });
}
