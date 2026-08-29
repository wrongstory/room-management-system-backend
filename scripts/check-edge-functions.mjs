import { spawnSync } from 'node:child_process';

const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const sourcePaths = [
  'supabase/functions/_shared/runtime.ts',
  'supabase/functions/api/index.ts',
  'supabase/functions/reservation-scheduler/index.ts'
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

runDeno(['fmt', '--check', ...sourcePaths]);
runDeno([
  'check',
  '--frozen',
  '--config',
  'supabase/functions/deno.json',
  ...sourcePaths.slice(1)
]);
