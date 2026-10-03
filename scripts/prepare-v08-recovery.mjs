import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

// This is a recovery artifact, not a second implementation or a deployment command.
export const recoveryBaseCommit = '1780728a02144c0816565ba091e43a8b3e126c4f';
export const recoveryAdapterPath = 'supabase/functions/_shared/reservation-api.ts';
// The pinned Edge re-export has this one I/O-free, import-free shared source dependency.
export const recoverySharedSourcePaths = Object.freeze(['src/modules/assignments/assignment-preview-core.ts']);
export const recoveryAssetNames = Object.freeze(['magick.NOTICE', 'magick.d.ts', 'magick.js', 'magick.ts', 'magick.wasm.gz']);
const denoImage = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const edgeImage = 'public.ecr.aws/supabase/edge-runtime:v1.74.3@sha256:c52405002a890ca9fcf77978671c57f3a988e03174afb277f84ac65bc917013c';
const canvasPrefix = Buffer.from('type HTMLCanvasElement = never;\ntype CanvasRenderingContext2DSettings = never;\n');
const wrapper = Buffer.from('// Generated pinned @imagemagick/magick-wasm 0.0.43; license: magick.NOTICE.\n// @ts-types="./magick.d.ts"\nexport * from "./magick.js";\n');
const purpose = '#364 migration 93-compatible old-main API recovery';
const deployment = Object.freeze({ function: 'api', entrypoint: 'supabase/functions/api/index.ts', config: 'supabase/config.toml', verifyJwt: false, staticFiles: Object.freeze(['supabase/functions/api/assets/magick.wasm.gz', 'supabase/functions/api/assets/magick.NOTICE']), otherFunctions: 'preserved only; do not deploy', secrets: 'not copied; existing hosted values only' });
const initialValidation = Object.freeze({ status: 'NOT RUN', database: 'NOT RUN; no database access', deployment: 'NOT RUN' });
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const normalized = bytes => bytes.toString('utf8').replace(/\r\n?/g, '\n');
const blobId = bytes => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');

export function checkedRelativePath(path) {
  if (typeof path !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(path) || isAbsolute(path)
    || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe recovery source path');
  }
  return path;
}

export function checkedChild(root, path) {
  const destination = resolve(root, checkedRelativePath(path));
  const inside = relative(root, destination);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('Recovery path escapes root');
  return destination;
}

function regularFile(root, path) {
  const destination = checkedChild(root, path);
  let current = root;
  for (const part of path.split('/')) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || realpathSync(current) !== current) throw new Error('Recovery symlink is forbidden');
  }
  if (!lstatSync(destination).isFile()) throw new Error('Recovery source is not a regular file');
  return readFileSync(destination);
}

function git(workspace, args, input) {
  const result = spawnSync('git', args, { cwd: workspace, input, maxBuffer: 32 * 1024 * 1024, timeout: 30000 });
  if (result.error || result.status !== 0) throw new Error('Recovery fixed Git snapshot is unavailable');
  return result.stdout;
}

export function readRecoverySnapshot(workspace) {
  const tree = git(workspace, ['ls-tree', '-rz', recoveryBaseCommit, '--', 'supabase/config.toml', 'supabase/functions', ...recoverySharedSourcePaths]).toString('utf8');
  const excluded = [];
  const entries = tree.split('\0').filter(Boolean).map(value => {
    const match = /^(\d+) (\w+) ([a-f0-9]{40})\t(.+)$/.exec(value);
    if (!match) throw new Error('Invalid recovery Git tree entry');
    const [, mode, type, oid, path] = match;
    checkedRelativePath(path);
    if (!['100644', '100755'].includes(mode) || type !== 'blob') throw new Error('Recovery tree must contain only regular blobs');
    if (path.split('/').some(part => part.startsWith('.env'))) { excluded.push(path); return null; }
    if (path !== 'supabase/config.toml' && !recoverySharedSourcePaths.includes(path)
      && !/^supabase\/functions\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.deno)?\.(?:ts|json|lock)$/.test(path)) {
      throw new Error('Recovery tree contains a non-source file');
    }
    return { path, oid, mode };
  }).filter(Boolean).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  if (!entries.some(entry => entry.path === recoveryAdapterPath) || !entries.some(entry => entry.path === 'supabase/config.toml')
    || recoverySharedSourcePaths.some(path => !entries.some(entry => entry.path === path))) throw new Error('Incomplete recovery source snapshot');
  const blobs = git(workspace, ['cat-file', '--batch'], `${entries.map(entry => entry.oid).join('\n')}\n`);
  let offset = 0;
  for (const entry of entries) {
    const end = blobs.indexOf(10, offset);
    const header = blobs.subarray(offset, end).toString('ascii');
    const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
    if (end < 0 || !match || match[1] !== entry.oid) throw new Error('Invalid recovery Git blob');
    const size = Number(match[2]);
    entry.bytes = blobs.subarray(end + 1, end + 1 + size);
    offset = end + 2 + size;
    if (entry.bytes.length !== size || blobId(entry.bytes) !== entry.oid || blobs[offset - 1] !== 10) throw new Error('Recovery Git blob checksum mismatch');
  }
  if (offset !== blobs.length) throw new Error('Unexpected recovery Git blob tail');
  return { entries, excluded, tree: git(workspace, ['rev-parse', `${recoveryBaseCommit}^{tree}`]).toString('ascii').trim() };
}

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error('Recovery adapter baseline anchor drift');
  return source.replace(before, () => after);
}

export function compatibleRecoveryAdapter(baseline, candidate) {
  let expected = normalized(baseline);
  expected = replaceOnce(expected, '  requirePasswordChanged,\n} from "./runtime.ts";', '  requirePasswordChanged,\n  verifiedRequestSessionId,\n} from "./runtime.ts";');
  const mapping = '  const mappings: Array<[string, number, string, string]> = [\n';
  expected = replaceOnce(expected, mapping, `${mapping}    [\n      "VALIDATION_ERROR",\n      400,\n      "VALIDATION_ERROR",\n      "청소 요청 취소 입력이 올바르지 않습니다.",\n    ],\n    ["SESSION_REVOKED", 401, "SESSION_REVOKED", "로그인이 필요합니다."],\n    [\n      "PASSWORD_CHANGE_REQUIRED",\n      403,\n      "PASSWORD_CHANGE_REQUIRED",\n      "비밀번호를 먼저 변경해 주세요.",\n    ],\n`);
  expected = replaceOnce(expected, '    "cancel_manual_cleaning_request",\n    {\n      p_actor_profile_id: actor.profileId,', '    "cancel_manual_cleaning_request_with_session",\n    {\n      p_actor_profile_id: actor.profileId,\n      p_session_id: verifiedRequestSessionId(request),');
  if (normalized(candidate) !== expected) throw new Error('Recovery adapter exceeds the exact 16 additions / 1 deletion allowlist');
  return Buffer.from(expected);
}

export function verifyRecoveryAssets(assets) {
  if (Object.keys(assets).sort().join(',') !== recoveryAssetNames.join(',')) throw new Error('Recovery assets must match the exact five-file allowlist');
  const pinned = {
    'magick.js': '395efa92ea32ad54c1b3e1d84f2ef21f53f60e9d6f4d7f947f1b08e0a31d20b4',
    'magick.NOTICE': '785f309bdde0dd22079361afdfdcc972419d985d8b4cd1ba4c3185e03b6aa485',
    'magick.wasm.gz': '0ec87668655bced27afa7b39764f188fe16dc947d4fb37ea10e822112867121c'
  };
  for (const [name, digest] of Object.entries(pinned)) if (sha256(assets[name]) !== digest) throw new Error('Pinned recovery asset checksum mismatch');
  const declarations = assets['magick.d.ts'];
  if (!declarations.subarray(0, canvasPrefix.length).equals(canvasPrefix)
    || sha256(declarations.subarray(canvasPrefix.length)) !== '9a09774833c1c3b48d0cf363441b4ee46f5e0ad4c8f2725c104ee807a60f8a1f'
    || !assets['magick.ts'].equals(wrapper) || assets['magick.wasm.gz'].length !== 5269861) throw new Error('Pinned recovery asset glue mismatch');
  const wasm = gunzipSync(assets['magick.wasm.gz'], { maxOutputLength: 14828458 });
  if (wasm.length !== 14828458 || sha256(wasm) !== '5a4ed1017eda113144c86ae839c22c610afebcfebfa22b1da18e00e98d78b0f7') throw new Error('Pinned recovery WASM checksum mismatch');
}

export function checkedRecoveryDirectory(workspace, artifact) {
  const root = realpathSync(workspace);
  const temporary = resolve(root, '.tmp');
  if (lstatSync(temporary).isSymbolicLink() || realpathSync(temporary) !== temporary
    || dirname(artifact) !== temporary || !basename(artifact).startsWith('v08-recovery-')
    || !lstatSync(artifact).isDirectory() || lstatSync(artifact).isSymbolicLink() || realpathSync(artifact) !== artifact) {
    throw new Error('Unsafe recovery artifact directory');
  }
  return artifact;
}

function artifactFiles(root, prefix = '') {
  const files = [];
  for (const entry of readdirSync(prefix ? checkedChild(root, prefix) : root, { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    checkedRelativePath(path);
    if (entry.isSymbolicLink()) throw new Error('Recovery artifact symlink is forbidden');
    if (entry.isDirectory()) files.push(...artifactFiles(root, path));
    else if (entry.isFile()) files.push(path);
    else throw new Error('Recovery artifact contains a special file');
  }
  return files.sort();
}

export function verifyRecoveryArtifact(workspace, artifact) {
  checkedRecoveryDirectory(workspace, artifact);
  const manifest = JSON.parse(regularFile(artifact, 'recovery-manifest.json').toString('utf8'));
  const snapshot = readRecoverySnapshot(workspace);
  if (manifest.schemaVersion !== 1 || manifest.purpose !== purpose || manifest.baseCommit !== recoveryBaseCommit || manifest.baseTree !== snapshot.tree
    || !/^[a-f0-9]{40}$/.test(manifest.candidateHead) || !/^[a-f0-9]{64}$/.test(manifest.candidateWorkingAdapterSha256)
    || JSON.stringify(manifest.adapterDiff) !== JSON.stringify({ added: 16, deleted: 1 })
    || JSON.stringify(manifest.deployment) !== JSON.stringify(deployment)
    || JSON.stringify(manifest.excludedTrackedPaths) !== JSON.stringify(snapshot.excluded)
    || JSON.stringify(manifest.changedPaths) !== JSON.stringify([recoveryAdapterPath])
    || manifest.sources.length !== snapshot.entries.length) throw new Error('Recovery manifest baseline mismatch');
  for (let index = 0; index < snapshot.entries.length; index++) {
    const entry = snapshot.entries[index];
    const record = manifest.sources[index];
    const bytes = regularFile(artifact, entry.path);
    const expected = entry.path === recoveryAdapterPath ? compatibleRecoveryAdapter(entry.bytes, bytes) : entry.bytes;
    if (record.path !== entry.path || record.baseBlob !== entry.oid || record.baseSha256 !== sha256(entry.bytes)
      || record.sha256 !== sha256(bytes) || record.bytes !== bytes.length || !bytes.equals(expected)) throw new Error('Recovery source parity mismatch');
  }
  const assets = Object.fromEntries(recoveryAssetNames.map(name => [name, regularFile(artifact, `supabase/functions/api/assets/${name}`)]));
  verifyRecoveryAssets(assets);
  if (manifest.assets.length !== recoveryAssetNames.length) throw new Error('Recovery asset manifest mismatch');
  for (let index = 0; index < recoveryAssetNames.length; index++) {
    const name = recoveryAssetNames[index];
    const record = manifest.assets[index];
    if (record.path !== `supabase/functions/api/assets/${name}` || record.sha256 !== sha256(assets[name]) || record.bytes !== assets[name].length) throw new Error('Recovery asset manifest checksum mismatch');
  }
  const expectedFiles = ['recovery-manifest.json', ...manifest.sources.map(record => record.path), ...manifest.assets.map(record => record.path)];
  if (manifest.validation.status === 'PASS') {
    expectedFiles.push('validation/api.eszip');
    const bundle = regularFile(artifact, 'validation/api.eszip');
    if (manifest.validation.format !== 'PASS' || manifest.validation.typecheck !== 'PASS'
      || manifest.validation.database !== initialValidation.database || manifest.validation.deployment !== initialValidation.deployment
      || manifest.validation.openApiPaths !== 131 || manifest.validation.openApiOperations !== 141
      || manifest.validation.denoImage !== denoImage || manifest.validation.edgeImage !== edgeImage
      || bundle.length <= 0 || bundle.length >= 20000000 || manifest.validation.bundleBytes !== bundle.length
      || manifest.validation.bundleSha256 !== sha256(bundle)) throw new Error('Recovery validation manifest mismatch');
  } else if (JSON.stringify(manifest.validation) !== JSON.stringify(initialValidation)) throw new Error('Invalid recovery validation state');
  if (artifactFiles(artifact).join('\n') !== expectedFiles.sort().join('\n')) throw new Error('Recovery artifact has unexpected files');
  return manifest;
}

export function prepareV08Recovery({ workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..'), assetsRoot } = {}) {
  const root = realpathSync(workspace);
  const snapshot = readRecoverySnapshot(root);
  const baseline = snapshot.entries.find(entry => entry.path === recoveryAdapterPath);
  const rawAdapter = regularFile(root, recoveryAdapterPath);
  const adapter = compatibleRecoveryAdapter(baseline.bytes, rawAdapter);
  const assetDirectory = resolve(assetsRoot ?? resolve(root, 'supabase/functions/api/assets'));
  if (lstatSync(assetDirectory).isSymbolicLink() || realpathSync(assetDirectory) !== assetDirectory) throw new Error('Unsafe recovery asset root');
  const assets = Object.fromEntries(recoveryAssetNames.map(name => [name, regularFile(assetDirectory, name)]));
  verifyRecoveryAssets(assets);
  const config = snapshot.entries.find(entry => entry.path === 'supabase/config.toml').bytes.toString('utf8');
  const apiConfig = config.split('[functions.api]\n')[1]?.split('\n[')[0];
  if (!apiConfig?.includes('verify_jwt = false') || !apiConfig.includes('static_files = ["./functions/api/assets/magick.wasm.gz", "./functions/api/assets/magick.NOTICE"]')) throw new Error('Recovery API deployment template drift');
  const temporary = resolve(root, '.tmp');
  mkdirSync(temporary, { recursive: true });
  if (lstatSync(temporary).isSymbolicLink() || realpathSync(temporary) !== temporary) throw new Error('Unsafe recovery temporary root');
  const artifact = mkdtempSync(resolve(temporary, 'v08-recovery-'));
  checkedRecoveryDirectory(root, artifact);
  const write = (path, bytes) => { const destination = checkedChild(artifact, path); mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, bytes, { flag: 'wx' }); };
  const sources = snapshot.entries.map(entry => {
    const bytes = entry.path === recoveryAdapterPath ? adapter : entry.bytes;
    write(entry.path, bytes);
    return { path: entry.path, baseBlob: entry.oid, baseSha256: sha256(entry.bytes), sha256: sha256(bytes), bytes: bytes.length };
  });
  const manifest = {
    schemaVersion: 1, purpose,
    baseCommit: recoveryBaseCommit, baseTree: snapshot.tree,
    candidateHead: git(root, ['rev-parse', 'HEAD']).toString('ascii').trim(),
    changedPaths: [recoveryAdapterPath], adapterDiff: { added: 16, deleted: 1 },
    candidateWorkingAdapterSha256: sha256(rawAdapter), sources,
    assets: recoveryAssetNames.map(name => {
      const path = `supabase/functions/api/assets/${name}`;
      write(path, assets[name]);
      return { path, sha256: sha256(assets[name]), bytes: assets[name].length };
    }),
    excludedTrackedPaths: snapshot.excluded,
    deployment,
    validation: initialValidation
  };
  write('recovery-manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  verifyRecoveryArtifact(root, artifact);
  return { artifact, manifest, manifestSha256: sha256(readFileSync(resolve(artifact, 'recovery-manifest.json'))) };
}

export function replaceRecoveryManifest(workspace, artifact, original, manifest) {
  checkedRecoveryDirectory(workspace, artifact);
  if (!regularFile(artifact, 'recovery-manifest.json').equals(original)) throw new Error('Recovery manifest changed during validation');
  // Exclusive new file + rename replaces the directory entry, never opens an existing symlink for writing.
  const staged = checkedChild(artifact, `.manifest-ready-${randomUUID()}.json`);
  writeFileSync(staged, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  checkedRecoveryDirectory(workspace, artifact);
  if (!regularFile(artifact, 'recovery-manifest.json').equals(original)) throw new Error('Recovery manifest changed before publication');
  renameSync(staged, checkedChild(artifact, 'recovery-manifest.json'));
}

export function validateV08Recovery(workspace, artifact) {
  const manifest = verifyRecoveryArtifact(workspace, artifact);
  const originalManifest = regularFile(artifact, 'recovery-manifest.json');
  if (manifest.validation.status !== 'NOT RUN') throw new Error('Recovery validation requires a fresh prepared artifact');
  const run = args => {
    const result = spawnSync('docker', args, { stdio: 'inherit', timeout: 180000 });
    if (result.error || result.status !== 0) throw new Error('Isolated recovery Docker validation failed; artifact retained, not ready');
  };
  const sourceFiles = manifest.sources.map(record => record.path).filter(path => path.endsWith('.ts') && !path.endsWith('.deno.ts'));
  const mount = ['run', '--rm', '-v', `${artifact}:/workspace:ro`, '-w', '/workspace', denoImage, 'deno'];
  run([...mount, 'fmt', '--check', ...sourceFiles]);
  run([...mount, 'check', '--frozen', '--config', 'supabase/functions/deno.json', 'supabase/functions/api/index.ts', 'supabase/functions/reservation-scheduler/index.ts']);
  run([...mount, 'eval', '--frozen', '--config', 'supabase/functions/deno.json', 'import { openApiDocument } from "./supabase/functions/_shared/openapi.ts"; const paths = Object.values(openApiDocument.paths); const operations = paths.flatMap(path => Object.keys(path).filter(key => ["get","post","put","patch","delete","options","head","trace"].includes(key))).length; if (paths.length !== 131 || operations !== 141) throw new Error("Old-main OpenAPI count drift"); console.log("Recovery old-main OpenAPI PASS: 131/141");']);
  const output = resolve(artifact, 'validation');
  mkdirSync(output);
  run(['run', '--rm', '-v', `${artifact}:/workspace:ro`, '-v', `${output}:/output`, '-w', '/workspace/supabase/functions', edgeImage,
    'bundle', '--entrypoint', 'api/index.ts', '--static', 'api/assets/magick.wasm.gz', '--static', 'api/assets/magick.NOTICE', '--output', '/output/api.eszip', '--checksum', 'sha256', '--timeout', '60']);
  const bundle = regularFile(artifact, 'validation/api.eszip');
  if (bundle.length <= 0 || bundle.length >= 20000000) throw new Error('Recovery Edge bundle exceeds the existing 20,000,000-byte gate');
  manifest.validation = { status: 'PASS', format: 'PASS', typecheck: 'PASS', openApiPaths: 131, openApiOperations: 141, bundleBytes: bundle.length, bundleSha256: sha256(bundle), denoImage, edgeImage, database: 'NOT RUN; no database access', deployment: 'NOT RUN' };
  replaceRecoveryManifest(workspace, artifact, originalManifest, manifest);
  verifyRecoveryArtifact(workspace, artifact);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some(arg => arg !== '--validate')) throw new Error('Only --validate is supported; this script cannot deploy or select a different baseline');
  const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const prepared = prepareV08Recovery({ workspace });
  console.log(`Recovery artifact retained: ${prepared.artifact}`);
  if (process.argv.includes('--validate')) validateV08Recovery(workspace, prepared.artifact);
  console.log(`Recovery manifest SHA-256: ${sha256(readFileSync(resolve(prepared.artifact, 'recovery-manifest.json')))}`);
}
