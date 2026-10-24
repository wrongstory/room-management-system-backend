export type BackupProcessProbe =
  | 'stdio-success' | 'nonzero-exit' | 'stdout-limit' | 'stderr-limit'
  | 'stdin-stall' | 'whole-deadline' | 'environment-isolation';
export type BackupProcessProbeCode =
  | 'COMPLETED' | 'INVALID_PROBE' | 'INVALID_LIMITS' | 'UNTRUSTED_RUNTIME' | 'PRECHECK_DEADLINE'
  | 'SPAWN_FAILED' | 'PROBE_MEMORY_UNAVAILABLE' | 'STDIN_FAILED' | 'OUTPUT_FAILED' | 'STDIN_DEADLINE'
  | 'STDOUT_LIMIT' | 'STDERR_LIMIT' | 'PROCESS_DEADLINE'
  | 'PROCESS_EXIT_NONZERO' | 'PROCESS_STOP_UNCONFIRMED';
export interface BackupProcessProbeLimits {
  /** Integer 20..5000ms for metadata preflight + child lifetime. Default 2000; stdin deadline must not exceed it. */
  wholeDeadlineMs?: number;
  /** Integer 10..2000ms. Default 1000; counts parent pipe acceptance, not child processing. */
  stdinDeadlineMs?: number;
  /** Integer 10..1000ms after an owned-child kill request. Default 500. */
  terminationDeadlineMs?: number;
  /** Integer 0..65536 bytes per stream, default 8192. No output content is retained. */
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  /** Integer 0..1MiB. Internal constant synthetic bytes, never caller data. Default 64. */
  stdinBytes?: number;
}
export interface BackupProcessProbeReport {
  readonly mode: 'INTERNAL_SYNTHETIC_PROBE';
  readonly code: BackupProcessProbeCode;
  readonly spawned: boolean;
  /** Actual ChildProcess close event, not just exit or a successful kill request. */
  readonly closeObserved: boolean;
  readonly terminationRequested: boolean;
  readonly stdinAccepted: boolean;
  /** Counts saturate at each configured cap + 1. */
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}
/**
 * Only seven fixed secret-free Node programs. Absolute current Node executable,
 * no shell and constant cleared environment; no command/path/argv/env/callback/data input.
 * Windows only supports the verified C:\Windows layout after fixed directory/DLL
 * regular-file, symlink and realpath metadata checks; no parent env is read.
 * Implicit libuv/Node inherited variables are explicitly shadowed with constants.
 * Non-Windows CI uses current Node without Windows path metadata checks.
 * Preflight timeout returns PRECHECK_DEADLINE with no child. Pending OS metadata IO
 * cannot itself be cancelled, but late results cannot continue checks or spawn.
 * Child termination confirmation has its own additional bounded deadline.
 * Not a production supervisor, credential transport, dump or restore API.
 */
export function runBackupProcessProbe(
  probe: BackupProcessProbe,
  options?: BackupProcessProbeLimits,
): Promise<Readonly<BackupProcessProbeReport>>;
