import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const fixture = readFileSync(new URL('fixtures/room-pin-nonce-upgrade-v52.sql', import.meta.url));
const supabaseCli = fileURLToPath(new URL('../node_modules/supabase/dist/supabase.js', import.meta.url));
const container = 'supabase_db_room-management-system-backend';
const psqlBase = [
  'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'postgres',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: 'utf8', ...options });
}

function resetToV52() {
  run(process.execPath, [
    supabaseCli, 'db', 'reset', '--local', '--no-seed', '--version', '20260913041707',
  ], { stdio: 'inherit' });
}

function psql(input, variables = {}) {
  const args = [...psqlBase];
  for (const [name, value] of Object.entries(variables)) args.push('-v', `${name}=${value}`);
  return run('docker', args, { input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function historySnapshot() {
  return psql(`select jsonb_build_object(
    'leases', (select count(*) from private.room_pin_change_leases),
    'revisions', (select count(*) from private.room_pin_revisions),
    'statuses', (select jsonb_object_agg(status,count) from (
      select status,count(*) count from private.room_pin_change_leases group by status
    ) values_by_status),
    'identity', encode(extensions.digest(convert_to(
      coalesce((select jsonb_agg(to_jsonb(history) order by kind,id)::text from (
        select 'lease' kind,id,room_id,proposed_pin_version pin_version,status,key_version,
          encode(nonce,'hex') nonce,encode(ciphertext,'hex') ciphertext,
          encode(auth_tag,'hex') auth_tag,aad_environment,aad_project_ref
        from private.room_pin_change_leases
        union all
        select 'revision',id,room_id,pin_version,'immutable',key_version,
          encode(nonce,'hex'),encode(ciphertext,'hex'),encode(auth_tag,'hex'),
          aad_environment,aad_project_ref
        from private.room_pin_revisions
      ) history), '[]'), 'UTF8'), 'sha256'), 'hex')
  )::text`);
}

let passed = false;
try {
  resetToV52();
  psql(fixture, { inject_conflict: 1 });
  const conflictedBefore = historySnapshot();
  let conflictError = '';
  try {
    run(process.execPath, [supabaseCli, 'migration', 'up', '--local'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    conflictError = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
  }
  assert(
    conflictError.includes('ROOM_PIN_HISTORICAL_NONCE_REUSE'),
    'v52 historical cross-flow nonce collision must fail closed with a stable code',
  );
  assert(
    psql("select to_regclass('private.room_pin_nonce_reservations') is null") === 't',
    'failed migration must roll the nonce registry DDL back atomically',
  );
  assert(
    historySnapshot() === conflictedBefore,
    'failed upgrade must not delete or rewrite conflicting lease/revision evidence',
  );

  // Start a separate clean v52 upgrade instead of deleting the conflicting
  // evidence. This also proves all normal historical states are preserved.
  resetToV52();
  psql(fixture, { inject_conflict: 0 });
  const cleanBefore = historySnapshot();
  run(process.execPath, [supabaseCli, 'migration', 'up', '--local'], { stdio: 'inherit' });
  assert(historySnapshot() === cleanBefore, 'successful upgrade must preserve all v52 PIN history bytes and states');
  assert(
    psql('select count(*) from private.room_pin_nonce_reservations') === '5',
    'prepared/expired/rolled-back, confirmed pair, and direct revision backfill to five logical reservations',
  );
  assert(
    psql(`select count(*) from private.room_pin_nonce_reservations reservation
      where reservation.key_version='upgrade-v1'
        and reservation.nonce=substring(digest('upgrade-confirmed-nonce','sha256') for 12)`) === '1',
    'confirmed lease and matching revision share one backfilled reservation',
  );
  assert(
    psql(`select relrowsecurity and relforcerowsecurity
      from pg_class where oid='private.room_pin_nonce_reservations'::regclass`) === 't',
    'backfilled nonce registry keeps FORCE RLS',
  );
  passed = true;
  process.stdout.write('room PIN nonce 52 -> 53 upgrade compatibility: PASS\n');
} finally {
  try {
    run(process.execPath, [supabaseCli, 'db', 'reset', '--local', '--no-seed'], { stdio: 'inherit' });
  } catch (restoreError) {
    process.stderr.write(`failed to restore full local migration state: ${restoreError}\n`);
    if (passed) process.exitCode = 1;
  }
}
