import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const destination = resolve(root, 'supabase/functions/deno.lock');
const entrypoints = ['api', 'reservation-scheduler', 'photo-purge', 'notification-delivery', 'room-pin-sheet-sync']
  .map(name => `supabase/functions/${name}/index.ts`);
const runtimePackages = ['@supabase/auth-js@2.112.4', '@supabase/functions-js@2.112.4', '@supabase/phoenix@0.4.5',
  '@supabase/postgrest-js@2.112.4', '@supabase/realtime-js@2.112.4', '@supabase/storage-js@2.112.4',
  '@supabase/supabase-js@2.112.4', 'iceberg-js@0.8.1', 'tslib@2.8.1'];
export function validateEdgeRuntimeLock(runtime, validation) {
  assert.equal(runtime.version, '4');
  assert.deepEqual(runtime.specifiers, { 'npm:@supabase/supabase-js@2.112.4': '2.112.4' });
  assert.deepEqual(runtime.workspace, { dependencies: ['npm:@supabase/supabase-js@2.112.4'] });
  assert.deepEqual(Object.keys(runtime).sort(), ['npm', 'specifiers', 'version', 'workspace']);
  assert.deepEqual(Object.keys(runtime.npm).sort(), [...runtimePackages].sort(), 'Runtime lock cannot embed test/type-only packages');
  for (const name of runtimePackages) assert.deepEqual(runtime.npm[name], validation.npm[name], 'Runtime and frozen validation dependency bytes must agree');
}
export function generateEdgeRuntimeLock(check = false) {
  const base = resolve(root, '.tmp'); mkdirSync(base, { recursive: true });
  assert.equal(realpathSync(base), base);
  const temporary = mkdtempSync(resolve(base, 'edge-runtime-lock-'));
  try {
    const lock = `${relative(root, temporary).replaceAll('\\', '/')}/runtime.lock`;
    // Verification must not re-resolve compatible transitive releases. Seed the
    // reviewed bytes before Deno runs, including on a completely cold cache.
    if (check) writeFileSync(resolve(root, lock), readFileSync(destination));
    const result = spawnSync('docker', ['run', '--rm', '-v', `${root}:/workspace`, '-w', '/workspace', image,
      'deno', 'install', '--entrypoint', '--config', 'supabase/functions/deno.json', '--lock', lock,
      check ? '--frozen' : '--frozen=false', ...entrypoints], { cwd: root, encoding: 'utf8', timeout: 120000 });
    if (result.error || result.status !== 0) throw new Error('Pinned runtime lock generation failed');
    const bytes = readFileSync(resolve(root, lock), 'utf8').replaceAll('\r\n', '\n');
    validateEdgeRuntimeLock(JSON.parse(bytes), JSON.parse(readFileSync(resolve(root, 'supabase/functions/post-approval-report.deno.lock'), 'utf8')));
    if (check) assert.equal(readFileSync(destination, 'utf8').replaceAll('\r\n', '\n'), bytes, 'Runtime lock drift; regenerate from the five actual entrypoints');
    else writeFileSync(destination, bytes);
    console.log(`Edge runtime lock ${check ? 'check' : 'generation'} PASS: five entrypoints, nine exact runtime packages; validation lock preserved`);
  } finally {
    assert.equal(dirname(temporary), base); assert.equal(realpathSync(temporary), temporary);
    assert(basename(temporary).startsWith('edge-runtime-lock-'));
    rmSync(temporary, { recursive: true, force: false });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert(process.argv.slice(2).length <= 1 && process.argv.slice(2).every(value => value === '--check'));
  generateEdgeRuntimeLock(process.argv.includes('--check'));
}
