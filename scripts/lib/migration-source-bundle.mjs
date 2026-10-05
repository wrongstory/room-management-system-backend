/** #378 local immutable Git evidence only. No DB, SQL accessor or execution API. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, normalize, relative } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createMigrationSqlPlan, SQL_PLAN_MAX_BYTES, SQL_PLAN_TIMEOUT_MS } from './migration-sql-plan.mjs';

export const SOURCE_BUNDLE_MODE = 'LOCAL_GIT_SOURCE_ONLY';
export const SOURCE_BUNDLE_MAX_TOTAL_MS = 120_000;
export const SOURCE_BUNDLE_MAX_GIT_MS = 10_000;
const maxFiles = 512;
const maxTreeBytes = 2 * 1024 * 1024;
const maxBundleBytes = 32 * 1024 * 1024;
const sourceKeys = ['projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256'];
const owned = new WeakMap();
const safeErrors = new WeakMap();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const gitHash = (kind, value) => createHash('sha1').update(`${kind} ${value.length}\0`).update(value).digest('hex');

function fail(code) { const error = new Error(code); safeErrors.set(error, code); throw error; }
function data(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail('SOURCE_BUNDLE_INPUT_INVALID');
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('SOURCE_BUNDLE_INPUT_INVALID');
    copy[key] = descriptor.value;
  }
  return copy;
}
function hash(value, length = 64) {
  if (typeof value !== 'string' || !new RegExp(`^[a-f0-9]{${length}}$`, 'u').test(value)) fail('SOURCE_BUNDLE_INPUT_INVALID');
  return value;
}
function source(value) {
  const copy = data(value, sourceKeys);
  if (typeof copy.projectRef !== 'string' || typeof copy.sourceRef !== 'string'
    || copy.sourceRef.length > 128 || !/^[a-z]{20}$/u.test(copy.projectRef)
    || !/^refs\/heads\/(?:main|release\/v\d+\.\d+\.\d+)$/u.test(copy.sourceRef)) fail('SOURCE_BUNDLE_INPUT_INVALID');
  for (const key of ['headSha1', 'treeSha1']) hash(copy[key], 40);
  for (const key of ['manifestSha256', 'historySha256']) hash(copy[key]);
  return Object.freeze(copy);
}
function sameSource(a, b) { return sourceKeys.every((key) => a[key] === b[key]); }
function text(raw) {
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { fail('SOURCE_BUNDLE_ENCODING_INVALID'); }
  if (value.includes('\0') || !Buffer.from(value, 'utf8').equals(raw)) fail('SOURCE_BUNDLE_ENCODING_INVALID');
  return value;
}
function sqlPath(value) {
  if (typeof value !== 'string' || !/^supabase\/migrations\/\d{14}_[a-z0-9_]+\.sql$/u.test(value)) fail('SOURCE_BUNDLE_PATH_INVALID');
  return value;
}
function list(value, maximum = maxFiles) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail('SOURCE_BUNDLE_INPUT_INVALID');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail('SOURCE_BUNDLE_INPUT_INVALID');
    return descriptor.value;
  });
}
function unique(rows, key) {
  if (new Set(rows.map(key)).size !== rows.length) fail('SOURCE_BUNDLE_DUPLICATE');
}
function extent(value) {
  const result = data(value, ['startByte', 'endByte', 'sha256']);
  if (!Number.isSafeInteger(result.startByte) || !Number.isSafeInteger(result.endByte)
    || result.startByte < 0 || result.endByte <= result.startByte) fail('SOURCE_BUNDLE_INPUT_INVALID');
  hash(result.sha256);
  return Object.freeze(result);
}
function input(value) {
  const copy = data(value, ['repositoryPath', 'expectedSource', 'manifestPath', 'parserMajor', 'planPaths', 'wrapperApprovals', 'lfCopyApprovals', 'limits']);
  if (typeof copy.repositoryPath !== 'string' || !isAbsolute(copy.repositoryPath)
    || copy.repositoryPath.includes('\0') || copy.repositoryPath.length > 2048) fail('SOURCE_BUNDLE_PATH_INVALID');
  copy.repositoryPath = normalize(copy.repositoryPath);
  copy.expectedSource = source(copy.expectedSource);
  if (typeof copy.manifestPath !== 'string'
    || !/^supabase\/migration-manifest\.(?:dev|v\d+\.\d+\.\d+)\.json$/u.test(copy.manifestPath)) fail('SOURCE_BUNDLE_PATH_INVALID');
  if (![15, 17].includes(copy.parserMajor)) fail('SOURCE_BUNDLE_VERSION_UNSUPPORTED');
  copy.planPaths = list(copy.planPaths).map(sqlPath);
  if (copy.planPaths.length < 1) fail('SOURCE_BUNDLE_INPUT_INVALID');
  unique(copy.planPaths, (path) => path);
  copy.wrapperApprovals = list(copy.wrapperApprovals).map((row) => {
    const item = data(row, ['path', 'approval']);
    item.path = sqlPath(item.path);
    const approval = data(item.approval, ['modelSource', 'sqlSha256', 'begin', 'commit']);
    approval.modelSource = source(approval.modelSource); hash(approval.sqlSha256);
    approval.begin = extent(approval.begin); approval.commit = extent(approval.commit);
    if (!sameSource(approval.modelSource, copy.expectedSource) || !copy.planPaths.includes(item.path)) fail('SOURCE_BUNDLE_APPROVAL_MISMATCH');
    return Object.freeze({ path: item.path, approval: Object.freeze(approval) });
  });
  unique(copy.wrapperApprovals, (row) => row.path);
  copy.lfCopyApprovals = list(copy.lfCopyApprovals).map((row) => {
    const item = data(row, ['path', 'temporaryPath', 'modelSource', 'gitBlobSha1', 'gitRawSha256', 'canonicalSha256', 'temporarySha256', 'normalization']);
    item.path = sqlPath(item.path); item.modelSource = source(item.modelSource);
    hash(item.gitBlobSha1, 40);
    for (const key of ['gitRawSha256', 'canonicalSha256', 'temporarySha256']) hash(item[key]);
    if (typeof item.temporaryPath !== 'string' || !isAbsolute(item.temporaryPath) || item.temporaryPath.includes('\0')
      || item.temporaryPath.length > 2048 || item.normalization !== 'CRLF_TO_LF_EXACT'
      || !sameSource(item.modelSource, copy.expectedSource) || !copy.planPaths.includes(item.path)) fail('SOURCE_BUNDLE_APPROVAL_MISMATCH');
    item.temporaryPath = normalize(item.temporaryPath);
    return Object.freeze(item);
  });
  unique(copy.lfCopyApprovals, (row) => row.path);
  unique(copy.lfCopyApprovals, (row) => row.temporaryPath.toLowerCase());
  copy.limits = data(copy.limits, ['totalMs', 'gitProcessMs']);
  if (!Number.isSafeInteger(copy.limits.totalMs) || copy.limits.totalMs < 1 || copy.limits.totalMs > SOURCE_BUNDLE_MAX_TOTAL_MS
    || !Number.isSafeInteger(copy.limits.gitProcessMs) || copy.limits.gitProcessMs < 1 || copy.limits.gitProcessMs > SOURCE_BUNDLE_MAX_GIT_MS
    || copy.limits.gitProcessMs > copy.limits.totalMs) fail('SOURCE_BUNDLE_LIMIT_INVALID');
  return copy;
}
function remaining(deadline, reserve = 0) {
  const value = deadline - performance.now() - reserve;
  if (value <= 0) fail('SOURCE_BUNDLE_DEADLINE');
  return value;
}
function gitEnvironment() {
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (typeof process.env[key] === 'string') env[key] = process.env[key];
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_ATTR_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
}
async function git(repositoryPath, args, deadline, limitMs, maxBytes) {
  const duration = Math.max(1, Math.floor(Math.min(limitMs, remaining(deadline))));
  const processDeadline = Math.min(deadline, performance.now() + duration);
  return new Promise((resolve, reject) => {
    let child; let timer; let settled = false; let failure = null; let chunks = []; let size = 0;
    const finish = (code, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer); chunks = [];
      if (code) { const error = new Error(code); safeErrors.set(error, code); reject(error); }
      else resolve(result);
    };
    const stop = (code) => {
      if (failure || settled) return;
      failure = code;
      // Only this call's owned child. Never a supplied PID or another process.
      try { child.kill('SIGKILL'); } catch { /* fixed safe error below */ }
      finish(code);
    };
    try {
      child = spawn('git', ['--no-pager', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repositoryPath, ...args],
        { shell: false, windowsHide: true, env: gitEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });
      timer = setTimeout(() => stop(performance.now() >= deadline ? 'SOURCE_BUNDLE_DEADLINE' : 'SOURCE_BUNDLE_GIT_TIMEOUT'), duration);
      child.stderr.resume();
      child.stdout.on('data', (chunk) => {
        if (settled) return;
        if (performance.now() >= processDeadline) { stop('SOURCE_BUNDLE_GIT_TIMEOUT'); return; }
        size += chunk.length;
        if (size > maxBytes) { stop('SOURCE_BUNDLE_GIT_OUTPUT_LIMIT'); return; }
        chunks.push(Buffer.from(chunk));
      });
      child.once('error', () => finish('SOURCE_BUNDLE_GIT_FAILED'));
      child.once('close', (code) => {
        if (settled) return;
        if (performance.now() >= deadline) return finish('SOURCE_BUNDLE_DEADLINE');
        if (performance.now() >= processDeadline) return finish('SOURCE_BUNDLE_GIT_TIMEOUT');
        if (code !== 0) return finish('SOURCE_BUNDLE_GIT_FAILED');
        finish(null, Buffer.concat(chunks));
      });
    } catch { finish('SOURCE_BUNDLE_GIT_FAILED'); }
  });
}
function gitLine(raw) {
  const value = text(raw);
  if (!value.endsWith('\n')) fail('SOURCE_BUNDLE_GIT_OUTPUT_INVALID');
  const line = value.endsWith('\r\n') ? value.slice(0, -2) : value.slice(0, -1);
  if (line.includes('\r') || line.includes('\n')) fail('SOURCE_BUNDLE_GIT_OUTPUT_INVALID');
  return line;
}
async function observe(run, expected, repositoryPath) {
  const top = gitLine(await run(['rev-parse', '--show-toplevel'], 2050));
  if (!isAbsolute(top) || !samePath(top, repositoryPath) || !samePath(await realpath(top), repositoryPath)) fail('SOURCE_BUNDLE_REPOSITORY_UNSAFE');
  const format = gitLine(await run(['rev-parse', '--show-object-format'], 32));
  if (format !== 'sha1') fail('SOURCE_BUNDLE_GIT_FORMAT_UNSUPPORTED');
  const head = gitLine(await run(['rev-parse', '--verify', 'HEAD^{commit}'], 64));
  // Detached CI checkouts may have no local approved ref. An already-unrelated
  // HEAD is source drift regardless; never ask a missing ref to classify it.
  if (head !== expected.headSha1) fail('SOURCE_BUNDLE_SOURCE_DRIFT');
  const ref = gitLine(await run(['rev-parse', '--verify', `${expected.sourceRef}^{commit}`], 64));
  const tree = gitLine(await run(['rev-parse', '--verify', 'HEAD^{tree}'], 64));
  if (head !== expected.headSha1 || ref !== head || tree !== expected.treeSha1) fail('SOURCE_BUNDLE_SOURCE_DRIFT');
}
function binaryTree(raw) {
  if (raw.length < 1) fail('SOURCE_BUNDLE_TREE_INVALID');
  const entries = new Map();
  let offset = 0; let previousOrder = null;
  while (offset < raw.length) {
    if (entries.size >= maxFiles + 4096) fail('SOURCE_BUNDLE_TREE_INVALID');
    const space = raw.indexOf(32, offset); const nul = raw.indexOf(0, space + 1);
    if (space < offset + 1 || space - offset > 6 || nul <= space + 1 || nul + 21 > raw.length) fail('SOURCE_BUNDLE_TREE_INVALID');
    const mode = raw.subarray(offset, space).toString('ascii');
    if (!['40000', '100644', '100755', '120000', '160000'].includes(mode)
      || !Buffer.from(mode, 'ascii').equals(raw.subarray(offset, space))) fail('SOURCE_BUNDLE_TREE_INVALID');
    const basename = text(raw.subarray(space + 1, nul));
    if (basename === '.' || basename === '..' || basename.includes('/') || basename.includes('\\')
      || [...basename].some((character) => character.codePointAt(0) < 32 || character.codePointAt(0) === 127)) fail('SOURCE_BUNDLE_PATH_INVALID');
    if (entries.has(basename)) fail('SOURCE_BUNDLE_DUPLICATE');
    const order = Buffer.concat([raw.subarray(space + 1, nul), Buffer.from(mode === '40000' ? '/' : '\0')]);
    if (previousOrder && Buffer.compare(previousOrder, order) >= 0) fail('SOURCE_BUNDLE_TREE_INVALID');
    previousOrder = order;
    entries.set(basename, { mode, oid: raw.subarray(nul + 1, nul + 21).toString('hex'), basename });
    offset = nul + 21;
  }
  return entries;
}
async function sourceTree(run, rootOid, manifestPath) {
  const readTree = async (oid) => {
    const raw = await run(['cat-file', 'tree', oid], maxTreeBytes);
    if (gitHash('tree', raw) !== oid) fail('SOURCE_BUNDLE_TREE_HASH_MISMATCH');
    return binaryTree(raw);
  };
  const root = await readTree(rootOid);
  const supabase = root.get('supabase');
  if (supabase?.mode !== '40000') fail('SOURCE_BUNDLE_TREE_UNSAFE');
  const supabaseTree = await readTree(supabase.oid);
  const migrationDirectory = supabaseTree.get('migrations');
  if (migrationDirectory?.mode !== '40000') fail('SOURCE_BUNDLE_TREE_UNSAFE');
  const manifest = supabaseTree.get(manifestPath.slice('supabase/'.length));
  if (manifest?.mode !== '100644') fail('SOURCE_BUNDLE_MANIFEST_MISSING');
  const migrations = [];
  for (const item of (await readTree(migrationDirectory.oid)).values()) {
    if (item.mode !== '100644') fail('SOURCE_BUNDLE_TREE_UNSAFE');
    const path = sqlPath(`supabase/migrations/${item.basename}`);
    migrations.push({ ...item, path });
  }
  if (migrations.length < 1 || migrations.length > maxFiles) fail('SOURCE_BUNDLE_TREE_INVALID');
  migrations.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { manifest, migrations };
}
function canonicalBytes(raw) {
  const original = text(raw);
  const canonical = original.replaceAll('\r\n', '\n');
  if (canonical.includes('\r')) fail('SOURCE_BUNDLE_ENCODING_INVALID');
  return Buffer.from(canonical, 'utf8');
}
function manifestBytes(raw) {
  let result;
  const original = text(raw);
  try { result = JSON.parse(original); } catch { fail('SOURCE_BUNDLE_MANIFEST_INVALID'); }
  const manifest = data(result, ['schemaVersion', 'release', 'hashAlgorithm', 'totalCount', 'baseline', 'pending', 'head', 'migrations']);
  // Exact generator serialization prevents duplicate JSON keys / ambiguous decoding.
  if (original !== `${JSON.stringify(result, null, 2)}\n` || manifest.schemaVersion !== 1
    || typeof manifest.release !== 'string' || !/^(?:dev|v\d+\.\d+\.\d+)$/u.test(manifest.release)
    || manifest.hashAlgorithm !== 'sha256-lf-utf8' || !Number.isSafeInteger(manifest.totalCount)
    || manifest.totalCount < 1 || manifest.totalCount > maxFiles) fail('SOURCE_BUNDLE_MANIFEST_INVALID');
  manifest.migrations = list(manifest.migrations).map((item, index) => {
    const row = data(item, ['order', 'name', 'sha256']); hash(row.sha256);
    if (row.order !== index + 1 || typeof row.name !== 'string' || !/^[a-z0-9_]+$/u.test(row.name)) fail('SOURCE_BUNDLE_MANIFEST_INVALID');
    return row;
  });
  unique(manifest.migrations, (row) => row.name);
  manifest.baseline = data(manifest.baseline, ['count', 'head']);
  manifest.pending = data(manifest.pending, ['count', 'first', 'head']);
  const baseline = manifest.baseline.count;
  if (manifest.migrations.length !== manifest.totalCount || !Number.isSafeInteger(baseline) || baseline < 0 || baseline > manifest.totalCount
    || manifest.baseline.head !== (baseline === 0 ? null : manifest.migrations[baseline - 1].name)
    || manifest.pending.count !== manifest.totalCount - baseline
    || manifest.pending.first !== (baseline === manifest.totalCount ? null : manifest.migrations[baseline].name)
    || manifest.pending.head !== (baseline === manifest.totalCount ? null : manifest.migrations.at(-1).name)
    || manifest.head !== manifest.migrations.at(-1).name) fail('SOURCE_BUNDLE_MANIFEST_INVALID');
  return manifest;
}
function outside(repositoryPath, target) {
  const path = relative(repositoryPath, target);
  return path !== '' && (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(path));
}
function samePath(a, b) {
  return process.platform === 'win32' ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b);
}
async function lfCopy(row, repositoryPath, original, canonical, deadline) {
  if (sha256(original) !== row.gitRawSha256 || sha256(canonical) !== row.canonicalSha256
    || row.temporarySha256 !== row.canonicalSha256) fail('SOURCE_BUNDLE_LF_MAPPING_MISMATCH');
  remaining(deadline);
  // No writes and no caller-created memory buffers. Reject redirected file paths.
  const resolved = await realpath(row.temporaryPath);
  if (!samePath(resolved, row.temporaryPath) || !outside(repositoryPath, resolved)) fail('SOURCE_BUNDLE_TEMP_PATH_UNSAFE');
  const before = await lstat(resolved);
  if (!before.isFile() || before.isSymbolicLink() || before.size < 1 || before.size > SQL_PLAN_MAX_BYTES) fail('SOURCE_BUNDLE_TEMP_PATH_UNSAFE');
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail('SOURCE_BUNDLE_TEMP_DRIFT');
    const raw = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < raw.length) {
      remaining(deadline);
      const { bytesRead } = await handle.read(raw, offset, raw.length - offset, offset);
      if (bytesRead < 1) fail('SOURCE_BUNDLE_TEMP_DRIFT'); offset += bytesRead;
    }
    const after = await handle.stat(); const pathAfter = await lstat(resolved);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || pathAfter.dev !== stat.dev || pathAfter.ino !== stat.ino || pathAfter.isSymbolicLink()
      || sha256(raw) !== row.temporarySha256 || !raw.equals(canonical)) fail('SOURCE_BUNDLE_TEMP_DRIFT');
    remaining(deadline);
    return raw;
  } finally { await handle.close(); }
}

async function withinDeadline(action, deadline) {
  let timer;
  try {
    return await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error('SOURCE_BUNDLE_DEADLINE'); safeErrors.set(error, error.message); reject(error);
      }, Math.max(1, Math.ceil(remaining(deadline))));
    })]);
  } finally { clearTimeout(timer); }
}

/** Identity/provenance only, never an execution or operational approval capability. */
export function isOwnedMigrationSourceBundle(value) { return owned.has(value); }

/** Build from immutable local Git objects; caller claims and mutable SQL buffers are not accepted. */
export async function createMigrationSourceBundle(value) {
  try {
    const options = input(value);
    const deadline = performance.now() + options.limits.totalMs;
    return await withinDeadline(() => build(options, deadline), deadline);
  } catch (error) {
    // Never forward native Git paths/stdout/stderr, SQL, credentials or foreign error metadata.
    throw new Error(safeErrors.get(error) ?? 'SOURCE_BUNDLE_FAILED');
  }
}
async function build(options, deadline) {
    const repositoryPath = await realpath(options.repositoryPath); remaining(deadline);
    if (!samePath(repositoryPath, options.repositoryPath)) fail('SOURCE_BUNDLE_REPOSITORY_UNSAFE');
    const run = (args, maxBytes) => git(repositoryPath, args, deadline, options.limits.gitProcessMs, maxBytes);
    await observe(run, options.expectedSource, repositoryPath);
    const tree = await sourceTree(run, options.expectedSource.treeSha1, options.manifestPath);
    const rawManifest = await run(['cat-file', 'blob', tree.manifest.oid], SQL_PLAN_MAX_BYTES);
    if (gitHash('blob', rawManifest) !== tree.manifest.oid || sha256(rawManifest) !== options.expectedSource.manifestSha256) fail('SOURCE_BUNDLE_MANIFEST_HASH_MISMATCH');
    const manifest = manifestBytes(rawManifest);
    if (tree.migrations.length !== manifest.totalCount) fail('SOURCE_BUNDLE_FILE_SET_MISMATCH');
    const rows = []; const privatePlans = []; const privateBytes = []; let totalBytes = rawManifest.length; let selectedIndex = 0;
    for (const [index, entry] of tree.migrations.entries()) {
      remaining(deadline);
      const name = /^supabase\/migrations\/(\d{14})_([a-z0-9_]+)\.sql$/u.exec(entry.path);
      const expected = manifest.migrations[index];
      if (!name || expected.name !== name[2] || (index > 0 && name[1] <= rows[index - 1].version)) fail('SOURCE_BUNDLE_FILE_SET_MISMATCH');
      const original = await run(['cat-file', 'blob', entry.oid], SQL_PLAN_MAX_BYTES);
      if (original.length < 1 || gitHash('blob', original) !== entry.oid) fail('SOURCE_BUNDLE_BLOB_HASH_MISMATCH');
      totalBytes += original.length;
      if (totalBytes > maxBundleBytes) fail('SOURCE_BUNDLE_SIZE_INVALID');
      const canonical = canonicalBytes(original);
      if (sha256(canonical) !== expected.sha256) fail('SOURCE_BUNDLE_CANONICAL_HASH_MISMATCH');
      let plan = null; let inputMode = 'RAW_GIT_BLOB'; let raw = original;
      if (options.planPaths.includes(entry.path)) {
        if (options.planPaths[selectedIndex++] !== entry.path) fail('SOURCE_BUNDLE_PLAN_ORDER_MISMATCH');
        const lf = options.lfCopyApprovals.find((row) => row.path === entry.path);
        if (lf) {
          if (lf.gitBlobSha1 !== entry.oid) fail('SOURCE_BUNDLE_LF_MAPPING_MISMATCH');
          raw = await lfCopy(lf, repositoryPath, original, canonical, deadline); inputMode = 'APPROVED_EXACT_LF_COPY';
        }
        // Reserve the existing parser's finite worst-case bound. It has no public cancellation accessor.
        remaining(deadline, SQL_PLAN_TIMEOUT_MS + options.limits.gitProcessMs * 5);
        const wrapper = options.wrapperApprovals.find((row) => row.path === entry.path)?.approval ?? null;
        plan = await createMigrationSqlPlan({ sqlBytes: raw, parserMajor: options.parserMajor,
          expectedSource: options.expectedSource, observedSource: options.expectedSource,
          expectedSqlSha256: sha256(raw), wrapperApproval: wrapper });
        remaining(deadline);
        privatePlans.push(plan); privateBytes.push(Buffer.from(raw));
      }
      rows.push(Object.freeze({ path: entry.path, version: name[1], order: expected.order, name: expected.name, gitBlobSha1: entry.oid,
        gitRawSha256: sha256(original), canonicalSha256: expected.sha256, gitByteLength: original.length,
        inputMode, plan }));
    }
    if (selectedIndex !== options.planPaths.length) fail('SOURCE_BUNDLE_PLAN_MISSING');
    await observe(run, options.expectedSource, repositoryPath); remaining(deadline);
    const bundle = Object.freeze({ mode: SOURCE_BUNDLE_MODE, executionAllowed: false, operationalApproval: false,
      DBHistoryVerified: false, fullStateVerified: false, sourceEvidenceVerified: true,
      sourceEvidenceScope: 'LOCAL_GIT_OBJECT_MATCH_ONLY', remoteSourceVerified: false, sourceReviewRequired: true,
      checkoutSqlVerified: false, historyHashIsCallerClaim: true, projectIdentityIsCallerClaim: true,
      modelSource: options.expectedSource, manifestPath: options.manifestPath, manifestBlobSha1: tree.manifest.oid,
      parserMajor: options.parserMajor, totalCount: rows.length, plannedCount: privatePlans.length,
      files: Object.freeze(rows), bundleSha256: sha256(JSON.stringify({ format: 'local-git-source-bundle-v1',
        modelSource: options.expectedSource, manifestPath: options.manifestPath, parserMajor: options.parserMajor,
        files: rows.map((row) => ({ path: row.path, gitBlobSha1: row.gitBlobSha1, gitRawSha256: row.gitRawSha256,
          canonicalSha256: row.canonicalSha256, inputMode: row.inputMode,
          planSqlSha256: row.plan?.sqlSha256 ?? null, statementsSha256: row.plan?.statementsSha256 ?? null })) })) });
    owned.set(bundle, { privatePlans, privateBytes });
    return bundle;
}
