/** Server-internal owner-receipt consumption. Never creates approvals or executes reset effects. */
import { execFile } from 'node:child_process';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { copyMigrationData, exactMigrationKeys } from '../../../scripts/lib/migration-evidence-input.mjs';
import { requestHash } from '../../lib/command.js';
import { createResetReceipt, inspectResetReceiptRetry } from './reset-receipt.js';

const execute = promisify(execFile);
const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().min(0).max(8640000000000000);
const decision = z.object({ threadId: uuid, turnId: uuid }).strict();
const approval = z.object({ format: z.literal('reset-owner-approval-v1'), approvalId: uuid,
  action: z.literal('EXECUTE_EXACT_RESET_ONCE'), requestSha256: hash, commandHash: hash,
  projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  issuedAtMs: time, expiresAtMs: time, humanDecision: decision }).strict();
export interface ResetApprovalRequest {
  readonly format: 'reset-approval-request-v1';
  readonly requestSha256: string;
  readonly commandHash: string;
  readonly projectRef: string;
  readonly sourceCommit: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}
const requests = new WeakMap<ResetApprovalRequest, { attempted: boolean }>();
const fail = (): never => { throw new Error('RESET_APPROVAL_UNAVAILABLE'); };

/** Creates a non-authorizing request fingerprint, never an approval document.
 * Caller facts must come from reviewed server inputs; hashes do not prove live state.
 * Weak ownership rejects clones/arbitrary hash objects within this process. */
export function prepareResetApprovalRequest(command: unknown, nowMs: number): ResetApprovalRequest {
  try {
    const copied = copyMigrationData(command) as Record<string, unknown>;
    const receipt = createResetReceipt(copied, copied.createdAt as number);
    if (!inspectResetReceiptRetry(receipt, copied, nowMs).valid || nowMs >= receipt.expiresAt) return fail();
    const binding = copied.binding as Record<string, string>;
    const result = Object.freeze({ format: 'reset-approval-request-v1' as const,
      requestSha256: requestHash({ format: 'reset-approval-request-v1', command: copied }),
      commandHash: receipt.commandHash, projectRef: binding.projectRef as string, sourceCommit: binding.sourceCommit as string,
      createdAtMs: receipt.createdAt, expiresAtMs: receipt.expiresAt });
    requests.set(result, { attempted: false });
    return result;
  } catch { return fail(); }
}
export function resetApprovalDirectory() { return join(homedir(), '.codex', 'approvals', 'room-management-resets'); }
async function ownerWritableOnly(path: string, stat: Stats) {
  // Same operational ACL boundary as #378: current owner/SYSTEM/Administrators.
  // No actual conversation lookup or protection from a malicious same owner.
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) return fail();
    return;
  }
  const script = `$ErrorActionPreference='Stop'; $p='${path.replaceAll("'", "''")}'; $acl=Get-Acl -LiteralPath $p;
    $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    if($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $current){exit 2};
    $mask=[System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership;
    foreach($r in $acl.Access){if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $mask)){
      $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
      if($sid -ne $current -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544'){exit 3}}}; [Console]::Write('OWNER_ONLY')`;
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 3000, maxBuffer: 1024, windowsHide: true, encoding: 'utf8' });
  if (result.stdout !== 'OWNER_ONLY') return fail();
}
function validateDocument(raw: Buffer, request: ResetApprovalRequest, approvalId: string, nowMs: number) {
  const original = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  const data = copyMigrationData(JSON.parse(original));
  if (original !== `${JSON.stringify(data, null, 2)}\n`) return fail();
  const d = approval.parse(data);
  if (d.approvalId !== approvalId || d.requestSha256 !== request.requestSha256 || d.commandHash !== request.commandHash
    || d.projectRef !== request.projectRef || d.sourceCommit !== request.sourceCommit
    || d.issuedAtMs < request.createdAtMs || d.issuedAtMs > nowMs || d.expiresAtMs <= nowMs
    || d.expiresAtMs > request.expiresAtMs || d.expiresAtMs <= d.issuedAtMs) return fail();
  return d;
}

/** Consumes an EXISTING operator record written only after exact human approval.
 * No TTL default/approval writer/public route/DB or provider call exists here.
 * One request instance permits one attempt. Cross-process replay is blocked by wx.
 * Native I/O may outlive observation timeout: the marker is never removed, even
 * after error, crash, cancellation or unknown downstream outcome. */
export async function consumeResetApproval(input: {
  request: ResetApprovalRequest; approvalId: string; runId: string; ioBudgetMs: number;
}) {
  try { exactMigrationKeys(input, ['request', 'approvalId', 'runId', 'ioBudgetMs']); } catch { return fail(); }
  const state = requests.get(input.request);
  if (!state || state.attempted) return fail();
  state.attempted = true;
  const request = input.request;
  const { approvalId, runId, ioBudgetMs } = input;
  if (!uuid.safeParse(approvalId).success || !uuid.safeParse(runId).success
    || !Number.isSafeInteger(ioBudgetMs) || ioBudgetMs < 1 || ioBudgetMs > 30000) return fail();
  const started = performance.now();
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => { if (expired || performance.now() - started >= ioBudgetMs) return fail(); };
  const work = async () => {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    let raw: Buffer | undefined;
    try {
      check();
      const root = resolve(resetApprovalDirectory()); const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) return fail();
      await ownerWritableOnly(root, rootStat); check();
      const path = join(root, `${approvalId}.json`); const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 8192 || await realpath(path) !== path) return fail();
      await ownerWritableOnly(path, before); check();
      file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return fail();
      raw = Buffer.alloc(opened.size); let offset = 0;
      while (offset < raw.length) {
        check(); const read = await file.read(raw, offset, raw.length - offset, offset);
        if (read.bytesRead < 1) return fail(); offset += read.bytesRead;
      }
      const document = validateDocument(raw, request, approvalId, Date.now()); raw.fill(0); check();
      const after = await file.stat(); const current = await lstat(path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
        || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()
        || current.size !== before.size || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) return fail();
      const consumedAtMs = Date.now();
      if (consumedAtMs < document.issuedAtMs || consumedAtMs >= document.expiresAtMs) return fail();
      check();
      // Creation is the durable no-reuse boundary, even if write/sync/close fails.
      const marker = await open(join(root, `${approvalId}.consumed.json`), 'wx', 0o600);
      try {
        check();
        await marker.writeFile(`${JSON.stringify({ format: 'reset-approval-consumed-v1', approvalId, runId,
          requestSha256: request.requestSha256, commandHash: request.commandHash, consumedAtMs,
          humanDecisionHash: requestHash(document.humanDecision) })}\n`);
        await marker.sync(); check();
      } finally { await marker.close(); }
      // Flush the new directory entry on POSIX. Windows file fsync is the supported
      // API boundary; it is not a promise of storage survival after power loss.
      if (process.platform !== 'win32') {
        const directory = await open(root, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
        try { await directory.sync(); } finally { await directory.close(); }
      }
      check();
      const finishedAtMs = Date.now();
      if (finishedAtMs < consumedAtMs || finishedAtMs >= document.expiresAtMs) return fail();
      return Object.freeze({ status: 'CONSUMED' as const, approvalId, runId, requestSha256: request.requestSha256,
        commandHash: request.commandHash, consumedAtMs, executionEnabled: false as const, retryExecutionAllowed: false as const });
    } finally {
      raw?.fill(0);
      if (file) { try { await file.close(); } catch { /* fixed outer error; no native path output */ } }
    }
  };
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { expired = true; reject(new Error()); }, ioBudgetMs);
    })]);
  } catch { return fail(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}
