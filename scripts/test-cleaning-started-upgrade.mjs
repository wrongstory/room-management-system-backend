import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Only the disposable local synthetic database; parent db:test owns scheduling.
const cli = 'node_modules/supabase/dist/supabase.js';
const run = (command, args, input) => execFileSync(command, args, {
  encoding: 'utf8', input, stdio: input ? ['pipe', 'pipe', 'pipe'] : 'inherit'
});
const sql = (input) => run('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input).trim();
const id = (n) => `30830000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const start = (n, actor) => `select public.start_cleaning_attempt('${id(actor)}','${id(3000 + n)}',1,
  '${id(2000 + n)}',2,'started-upgrade-${n}',repeat('a',64));`;
const snapshot = () => sql(`select md5(string_agg(data,'|' order by data)) from (
  select row_to_json(t)::text data from public.cleaning_targets t union all
  select row_to_json(a)::text from public.cleaning_assignments a union all
  select row_to_json(a)::text from public.cleaning_attempts a union all
  select row_to_json(e)::text from public.audit_events e union all
  select row_to_json(n)::text from public.notifications n union all
  select row_to_json(g)::text from private.notification_groups g union all
  select row_to_json(o)::text from private.notification_delivery_outbox o union all
  select row_to_json(c)::text from private.command_executions c
) preserved;`);
try {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20261001012526']);
  const fixtureSource = readFileSync('supabase/tests/cleaning_started_notifications.sql', 'utf8');
  assert(fixtureSource.includes('create function pg_temp.sid('), 'Started upgrade fixture entry must exist');
  const fixture = fixtureSource.slice(fixtureSource.indexOf('create function pg_temp.sid('))
    .split('create function pg_temp.start_rpc(')[0];
  assert(fixture.includes('select pg_temp.start_fixture(2,6);'), 'Started upgrade fixture boundary must exist');
  sql(`begin; ${fixture} commit;`);
  const completedStart = JSON.parse(sql(start(1, 3)));
  sql(`select public.complete_cleaning_attempt_field_work('${id(3)}','${id(3001)}',2,
    '${id(2001)}',2,'started-upgrade-complete',repeat('b',64));`);
  const runningStart = JSON.parse(sql(start(2, 6)));
  assert.equal(sql("select count(*) from public.audit_events where event_type='cleaning.attempt_started';"), '2');
  assert.equal(sql("select count(*) from public.notifications where event_family='cleaning.started_admin';"), '0');
  const before = snapshot();
  run(process.execPath, [cli, 'migration', 'up', '--local']);
  assert.equal(snapshot(), before, '87→88 preserves every old attempt, audit, inbox, outbox, group and receipt byte');
  assert.equal(sql("select count(*) from public.notifications where event_family='cleaning.started_admin';"), '0',
    'Installing the dispatcher never backfills historical start notifications');
  assert.deepEqual(JSON.parse(sql(start(1, 3))), completedStart, 'Completed attempt still replays original start receipt');
  assert.deepEqual(JSON.parse(sql(start(2, 6))), runningStart, 'Running attempt still replays original start receipt');
  assert.equal(snapshot(), before, 'Old public RPC replay cannot manufacture new start history');
  console.log('Cleaning started upgrade 87→88: PASS; completed/running history and exact receipts preserved; no backfill.');
} finally {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed']);
}
