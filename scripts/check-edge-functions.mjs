import { spawnSync } from 'node:child_process';

const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const sourcePaths = [
  'supabase/functions/_shared/runtime.ts',
  'supabase/functions/_shared/account-api.ts',
  'supabase/functions/_shared/openapi.ts',
  'supabase/functions/_shared/room-api.ts',
  'supabase/functions/api/index.ts',
  'supabase/functions/reservation-scheduler/index.ts'
];
const testPaths = [
  'supabase/functions/_shared/account-api.deno.ts',
  'supabase/functions/_shared/openapi.deno.ts',
  'supabase/functions/_shared/room-api.deno.ts'
];

function runDeno(args) {
  const result = spawnSync('docker', [
    'run',
    '--rm',
    '-v',
    `${process.cwd()}:/workspace`,
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
    process.exit(result.status ?? 1);
  }
}

runDeno(['fmt', '--check', ...sourcePaths, ...testPaths]);
runDeno([
  'check',
  '--frozen',
  '--config',
  'supabase/functions/deno.json',
  ...sourcePaths.slice(3)
]);
runDeno([
  'test',
  '--allow-env=ACCOUNT_PHONE_PEPPER',
  '--frozen',
  '--config',
  'supabase/functions/deno.json',
  ...testPaths
]);
