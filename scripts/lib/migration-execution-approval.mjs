/** One-use, owner-protected operational approval. This module never creates approval documents. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { copyMigrationData, exactMigrationKeys } from './migration-evidence-input.mjs';
import { migrationReleaseConfiguration, validateMigrationApprovalReceipt } from './migration-release-preflight.mjs';

const execute = promisify(execFile);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export function migrationApprovalDirectory() { return join(homedir(), '.codex', 'approvals', 'room-management-migrations'); }
async function requireOwnerOnly(path, stat) {
  if (process.platform !== 'win32') {
    if (typeof process.getuid !== 'function' || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) throw new Error();
    return;
  }
  const script = `$ErrorActionPreference='Stop'; $p=${`'${path.replaceAll("'", "''")}'`}; $acl=Get-Acl -LiteralPath $p;
    $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
    $owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
    if($owner -ne $current){exit 2};
    $mask=[System.Security.AccessControl.FileSystemRights]::Write -bor [System.Security.AccessControl.FileSystemRights]::Delete -bor [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor [System.Security.AccessControl.FileSystemRights]::TakeOwnership;
    foreach($r in $acl.Access){if($r.AccessControlType -eq 'Allow' -and ($r.FileSystemRights -band $mask)){
      $sid=$r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;
      if($sid -ne $current -and $sid -ne 'S-1-5-18' -and $sid -ne 'S-1-5-32-544'){exit 3}}}; [Console]::Write('OWNER_ONLY')`;
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { timeout: 3000, maxBuffer: 1024, windowsHide: true, encoding: 'utf8' });
  if (result.stdout !== 'OWNER_ONLY') throw new Error();
}

/** Existing file must be written only after the exact operation receives explicit human approval. */
export async function consumeMigrationApproval({ approvalId, request, runId }) {
  let file;
  try {
    if (!uuid.test(approvalId) || !uuid.test(runId)) throw new Error();
    const configuration = migrationReleaseConfiguration(request);
    const root = resolve(migrationApprovalDirectory());
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || await realpath(root) !== root) throw new Error();
    await requireOwnerOnly(root, rootStat);
    const path = join(root, `${approvalId}.json`);
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > 8192 || await realpath(path) !== path) throw new Error();
    await requireOwnerOnly(path, before);
    file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await file.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error();
    const raw = Buffer.alloc(opened.size); let offset = 0;
    while (offset < raw.length) { const read = await file.read(raw, offset, raw.length - offset, offset); if (read.bytesRead < 1) throw new Error(); offset += read.bytesRead; }
    const original = raw.toString('utf8');
    const document = copyMigrationData(JSON.parse(original)); raw.fill(0);
    if (original !== `${JSON.stringify(document, null, 2)}\n`) throw new Error();
    exactMigrationKeys(document, ['approvalId', 'requestSha256', 'projectRef', 'headSha1', 'manifestSha256', 'issuedAtMs', 'expiresAtMs', 'action', 'humanDecision']);
    exactMigrationKeys(document.humanDecision, ['threadId', 'turnId']);
    if (document.approvalId !== approvalId || document.requestSha256 !== request.requestSha256
      || document.projectRef !== configuration.policy.expectedSource.projectRef || document.headSha1 !== configuration.policy.expectedSource.headSha1
      || document.manifestSha256 !== configuration.policy.expectedSource.manifestSha256
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(document.humanDecision.threadId)
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(document.humanDecision.turnId)) throw new Error();
    const receipt = validateMigrationApprovalReceipt({ request, runId, nowMs: Date.now(), receipt: { requestSha256: document.requestSha256, runId,
      issuedAtMs: document.issuedAtMs, expiresAtMs: document.expiresAtMs, action: document.action } });
    const after = await file.stat(); const current = await lstat(path);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink()) throw new Error();
    // Durable consumption occurs before any DB connection. Never delete/reuse this marker after failure.
    const marker = await open(join(root, `${approvalId}.consumed.json`), 'wx', 0o600);
    try { await marker.writeFile(JSON.stringify({ approvalId, runId, requestSha256: request.requestSha256, consumedAtMs: Date.now() })); await marker.sync(); }
    finally { await marker.close(); }
    return receipt;
  } catch { throw new Error('MIGRATION_APPROVAL_UNAVAILABLE'); }
  finally { if (file) { try { await file.close(); } catch { /* no native path/error output */ } } }
}
