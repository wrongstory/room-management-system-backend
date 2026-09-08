import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const sourcePaths = [
  'supabase/functions/_shared/runtime.ts',
  'supabase/functions/_shared/activity-contract.ts',
  'supabase/functions/_shared/activity-api.ts',
  'supabase/functions/_shared/account-api.ts',
  'supabase/functions/_shared/availability-api.ts',
  'supabase/functions/_shared/assignment-api.ts',
  'supabase/functions/_shared/attempt-api.ts',
  'supabase/functions/_shared/attempt-lifecycle-api.ts',
  'supabase/functions/_shared/attempt-offline-api.ts',
  'supabase/functions/_shared/photo-submission-contract.ts',
  'supabase/functions/_shared/photo-upload-contract.ts',
  'supabase/functions/_shared/photo-binary.ts',
  'supabase/functions/_shared/google-drive.ts',
  'supabase/functions/_shared/photo-service.ts',
  'supabase/functions/_shared/photo-api.ts',
  'supabase/functions/_shared/assignment-preview-core.ts',
  'supabase/functions/_shared/assignment-preview-api.ts',
  'supabase/functions/_shared/reservation-api.ts',
  'supabase/functions/_shared/developer-api.ts',
  'supabase/functions/_shared/openapi.ts',
  'supabase/functions/_shared/room-api.ts',
  'supabase/functions/api/index.ts',
  'supabase/functions/reservation-scheduler/index.ts'
];
const testPaths = [
  'supabase/functions/_shared/activity-api.deno.ts',
  'supabase/functions/_shared/account-api.deno.ts',
  'supabase/functions/_shared/availability-api.deno.ts',
  'supabase/functions/_shared/assignment-api.deno.ts',
  'supabase/functions/_shared/attempt-api.deno.ts',
  'supabase/functions/_shared/attempt-lifecycle-api.deno.ts',
  'supabase/functions/_shared/attempt-offline-api.deno.ts',
  'supabase/functions/_shared/photo-submission-contract.deno.ts',
  'supabase/functions/_shared/photo-upload-contract.deno.ts',
  'supabase/functions/_shared/photo-api.deno.ts',
  'supabase/functions/_shared/photo-binary.deno.ts',
  'supabase/functions/_shared/assignment-preview-core.deno.ts',
  'supabase/functions/_shared/assignment-preview-api.deno.ts',
  'supabase/functions/_shared/reservation-api.deno.ts',
  'supabase/functions/_shared/developer-api.deno.ts',
  'supabase/functions/_shared/openapi.deno.ts',
  'supabase/functions/_shared/room-api.deno.ts',
  'supabase/functions/api/index.deno.ts'
];

function runDeno(args, mountRoot = process.cwd()) {
  const result = spawnSync('docker', [
    'run',
    '--rm',
    '-v',
    `${mountRoot}:/workspace`,
    '-w',
    '/workspace',
    image,
    'deno',
    ...args
  ], { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Deno validation failed (${result.status ?? 1})`);
  }
}

/** CRLF checkout portability only: no syntax/spacing changes and never rewrite tracked sources. */
function cleanupFormatCopy(temporary, base) {
  if (dirname(temporary) !== base || !basename(temporary).startsWith('edge-fmt-') || realpathSync(temporary) !== temporary) throw new Error('Unsafe format cleanup target');
  rmSync(temporary, { recursive: true, force: false });
}
export function withLfFormatCopy(paths, check, workspace = process.cwd()) {
  const root = realpathSync(workspace), base = resolve(root, '.tmp');
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error('Unsafe format temporary base');
  const temporary = mkdtempSync(resolve(base, 'edge-fmt-'));
  try {
    for (const path of paths) {
      const source = resolve(root, path), sourceRelative = relative(root, source);
      if (isAbsolute(path) || !sourceRelative || sourceRelative.startsWith(`..${sep}`) || sourceRelative === '..' || isAbsolute(sourceRelative)) throw new Error('Unsafe format source path');
      const destination = resolve(temporary, sourceRelative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source, 'utf8').replaceAll('\r\n', '\n'));
    }
    return check(temporary);
  } finally {
    // Delete only the exact mkdtemp directory after rechecking its real absolute boundary.
    cleanupFormatCopy(temporary, base);
  }
}

export function verifyEdgeBundle() {
  withLfFormatCopy([], temporary => {
    const output = resolve(temporary, 'api.eszip');
    const relativeOutput = relative(process.cwd(), output).split(sep).join('/');
    const result = spawnSync('docker', ['run', '--rm', '-v', `${process.cwd()}:/workspace`, '-w', '/workspace/supabase/functions',
      'public.ecr.aws/supabase/edge-runtime:v1.74.3@sha256:c52405002a890ca9fcf77978671c57f3a988e03174afb277f84ac65bc917013c',
      'bundle', '--entrypoint', 'api/index.ts',
      '--static', 'api/assets/magick.wasm.gz',
      '--static', 'api/assets/magick.NOTICE',
      '--output', `/workspace/${relativeOutput}`, '--checksum', 'sha256', '--timeout', '60'], { stdio: 'inherit', timeout: 70000 });
    if (result.error || result.status !== 0) throw new Error('Pinned Edge bundle failed');
    const size = statSync(output).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size >= 20000000) throw new Error('Edge bundle must remain below 20,000,000 bytes');
    console.log(`Edge bundle size gate PASS: ${size} bytes`);
  });
}

function main() {
for (const args of [['--assets-only'], ['--check']]) {
  const generated = spawnSync(process.execPath, ['scripts/generate-photo-edge.mjs', ...args], { stdio: 'inherit' });
  if (generated.status !== 0) throw new Error('Photo generated asset verification failed');
}
withLfFormatCopy([...sourcePaths, ...testPaths], temporary => runDeno(['fmt', '--check', ...sourcePaths, ...testPaths], temporary));
runDeno([
  'check',
  '--frozen',
  '--config',
  'supabase/functions/deno.json',
  ...sourcePaths.slice(3)
]);
runDeno([
  'test',
  '--allow-read=supabase/functions/api/assets',
  '--allow-env=ACCOUNT_PHONE_PEPPER,RESERVATION_PII_KEY_BASE64,RESERVATION_PII_KEY_VERSION,RESERVATION_PII_KEYRING_JSON,RESERVATION_GUEST_NAME_PEPPER',
  '--frozen',
  '--config',
  'supabase/functions/deno.json',
  ...testPaths
]);
verifyEdgeBundle();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
