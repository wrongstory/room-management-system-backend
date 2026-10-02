import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// Only the fresh synthetic local Supabase database; never a linked remote.
const cli = 'node_modules/supabase/dist/supabase.js';
const run = (command, args, input) => execFileSync(command, args, {
  encoding: 'utf8', input, stdio: input ? ['pipe', 'pipe', 'pipe'] : 'inherit'
});
const sql = (input) => run('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input).trim();
const snapshot = () => sql(`select md5(string_agg(data,'|' order by data)) from (
  select row_to_json(t)::text data from public.cleaning_targets t union all
  select (to_jsonb(a)-'notified_reservation_schedule_snapshot')::text from public.cleaning_assignments a union all
  select row_to_json(a)::text from public.cleaning_attempts a union all
  select (to_jsonb(r)-'reservation_schedule_snapshot')::text from public.cleaning_target_schedule_revisions r union all
  select row_to_json(n)::text from public.notifications n union all
  select row_to_json(e)::text from public.audit_events e union all
  select row_to_json(r)::text from private.command_executions r
) preserved;`);

try {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20260928095656']);
  const fixture = readFileSync('supabase/tests/assignment_attempt_activation.sql', 'utf8')
    .split('-- Today, tomorrow, inactive maid, past unassigned and past notified fixtures.')[0]
    .replace('select no_plan();', '')
    .replace('\\ir room_pin_fixture.psql', () => readFileSync('supabase/tests/room_pin_fixture.psql', 'utf8'));
  assert(fixture.includes('create function pg_temp.add_target('), 'Source-controlled legacy fixture boundary must exist');
  sql(`create extension if not exists pgtap with schema extensions; set search_path=public,extensions;
    ${fixture}
    select pg_temp.add_target(4,'unassigned','2037-09-30','2037-09-30 09:00+09','2037-09-30 15:00+09');
    select pg_temp.add_target(5,'notified','2037-09-30','2037-09-30 09:00+09','2037-09-30 15:00+09');
    select pg_temp.add_target(6,'notified','2037-09-30','2037-09-30 08:00+09','2037-09-30 14:00+09');
    insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
      attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
    select pg_temp.pid(506),t.id,pg_temp.pid(406),pg_temp.pid(2),1,'scheduled',2,t.template_snapshot,
      jsonb_build_object('roomId',t.room_id) from public.cleaning_targets t where t.id=pg_temp.pid(306);
    commit;`);
  const before = snapshot();
  run(process.execPath, [cli, 'migration', 'up', '--local']);
  assert.equal(snapshot(), before, 'Upgrade must not rewrite historical or overdue business rows');
  const response = JSON.parse(sql(`select public.process_due_assignment_lifecycle(
    '28000000-0000-4000-8000-000000000001','2037-10-01 11:00+09',
    'overdue-upgrade-preserve',repeat('f',64));`));
  assert.equal(response.rolledOverCount, 0);
  assert.deepEqual(response.rolloverResults, []);
  assert.equal(response.activatedCount, 1);
  assert.equal(response.alreadyActiveCount, 1);
  assert.equal(response.overdueCount, 3);
  assert.equal(sql('select count(*) from private.cleaning_overdue_events;'), '3');
  assert.equal(sql("select count(*) from public.notifications where event_family='cleaning.overdue_admin';"), '3');
  assert.equal(sql("select count(*) from private.notification_delivery_outbox where event_family='cleaning.overdue_admin';"), '0');
  const overdueHistory = sql(`select md5(string_agg(row_to_json(e)::text,'|' order by e.id))
    from private.cleaning_overdue_events e;`);
  const later = JSON.parse(sql(`select public.process_due_assignment_lifecycle(
    '28000000-0000-4000-8000-000000000001','2037-10-02 11:00+09',
    'overdue-upgrade-later',repeat('e',64));`));
  assert.equal(later.overdueCount, 0);
  assert.equal(sql(`select md5(string_agg(row_to_json(e)::text,'|' order by e.id))
    from private.cleaning_overdue_events e;`), overdueHistory, 'A later day must reuse original overdue evidence');
  assert.equal(sql("select count(*) from public.notifications where event_family='cleaning.overdue_admin';"), '3');
  assert.equal(sql(`select bool_and(effective_service_date='2037-09-30' and assignment_version=2 and carryover_count=0)
    from public.cleaning_targets where id in (
    '28000000-0000-4000-8000-000000000304','28000000-0000-4000-8000-000000000305',
    '28000000-0000-4000-8000-000000000306');`), 't');
  assert.equal(sql(`select count(*) from public.cleaning_attempts
    where cleaning_target_id='28000000-0000-4000-8000-000000000305'
    and assignment_id='28000000-0000-4000-8000-000000000405' and status='scheduled';`), '1');
  assert.equal(sql(`select status from public.cleaning_attempts
    where id='28000000-0000-4000-8000-000000000506';`), 'scheduled');
  assert.equal(sql(`select count(*) from public.cleaning_target_schedule_revisions
    where reason_code='ROLLED_OVER_NOT_STARTED';`), '0');
  console.log('Cleaning overdue upgrade 85→88: PASS; original schedules/owners/history preserved, durable overdue dedupe without rollover; no historical start backfill.');
} finally {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed']);
}
