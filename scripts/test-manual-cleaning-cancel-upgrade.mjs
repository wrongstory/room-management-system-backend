import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { manualCancelFixture, manualCancelId as id } from './test-manual-cleaning-cancel-concurrency.mjs';

// Exact 92→93 disposable local upgrade. No remote project, history repair,
// generated credential, provider call, or source migration rewrite is permitted.
const cli = 'node_modules/supabase/dist/supabase.js';
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261001210323';
const added = '20261002042113';
const protectedTables = [
  'public.rooms', 'public.profiles', 'public.reservations', 'public.cleaning_targets',
  'public.checkout_cleaning_obligations', 'public.cleaning_assignments', 'public.cleaning_attempts',
  'public.cleaning_target_schedule_revisions', 'public.audit_events', 'private.command_executions',
  'public.notifications', 'private.notification_groups', 'private.notification_delivery_outbox',
  'private.notification_outbox', 'public.room_pin_access_leases', 'private.room_pin_revisions',
  'private.room_current_pin', 'private.room_pin_assignment_entitlements', 'private.room_pin_reveal_leases',
  'private.actor_activity_events'
];
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
  } catch { throw new Error('MANUAL_CANCEL_UPGRADE_SQL_FAILED'); }
}
function reset(version) {
  const args = [cli, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}
function digest() {
  return sql(`select md5(string_agg(tag||':'||data,'|' order by tag,data)) from (
    ${protectedTables.map((table) => `select '${table}' tag,row_to_json(t)::text data from ${table} t`).join(' union all ')}
    ) history;`);
}
const command = (n, legacy = false, key = `manual-upgrade-cancel-${n}`) => legacy
  ? `select public.cancel_manual_cleaning_request('${id(1)}','${id(1000 + n)}',
      (select assignment_version from public.cleaning_targets where id='${id(1000 + n)}'),
      'CUSTOM_CANCEL_REASON','${key}',repeat('3',64));`
  : `select public.cancel_manual_cleaning_request_with_session('${id(1)}','${id(201)}','${id(1000 + n)}',
      (select assignment_version from public.cleaning_targets where id='${id(1000 + n)}'),
      'CUSTOM_CANCEL_REASON','${key}',repeat('3',64));`;
let resetStarted = false;
let phase = 'local-identity';
try {
  const localStatus = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(localStatus.API_URL).hostname), 'Only the disposable local database can be reset');
  resetStarted = true;
  phase = 'version-92-fixture';
  reset(baseline);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '92', 'Upgrade baseline must have exactly 92 migrations');
  sql(`begin; ${manualCancelFixture()}
    select pg_temp.manual_cancel_fixture(1,'additional','unassigned',false);
    select pg_temp.manual_cancel_fixture(2);
    select pg_temp.manual_cancel_fixture(3,'stayover','notified',true);
    select pg_temp.manual_cancel_fixture(4);
    insert into public.room_pin_access_leases(id,room_id,cleaning_target_id,assignment_id,attempt_id,pin_version,issued_to,
      issued_at,expires_at,revealed_at)
    select '${id(5002)}',room_id,id,'${id(2002)}','${id(3002)}',1,'${id(2)}',
      clock_timestamp()-interval '2 minutes',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '90 seconds'
    from public.cleaning_targets where id='${id(1002)}';
    create temp table upgrade_reveals(n integer primary key,value jsonb);
    insert into upgrade_reveals select n,public.begin_room_pin_reveal('${id(2)}','${id(202)}',room_id,
      pg_temp.cancel_id(2000+n),null,null,pg_temp.cancel_id(6000+n))
    from generate_series(3,4) n join public.cleaning_targets t on t.id=pg_temp.cancel_id(1000+n);
    select public.finalize_room_pin_reveal('${id(2)}','${id(202)}',t.room_id,(value->>'lease_id')::uuid,'${id(6003)}')
    from upgrade_reveals join public.cleaning_targets t on t.id='${id(1003)}' where n=3;
    commit;`);
  const oldReceipt = JSON.parse(sql(command(1, true, 'manual-upgrade-old-receipt')));
  const preserved = digest();
  const oldCancellationCount = sql("select count(*) from public.notifications where event_family='cleaning_request.cancelled_revoked';");
  sql(`do $probe$ begin
    begin
      perform public.cancel_manual_cleaning_request('${id(1)}','${id(1002)}',2,'CUSTOM_CANCEL_REASON',
        'manual-upgrade-old-pin-denied',repeat('4',64));
      raise exception 'EXPECTED_LEGACY_PIN_REJECTION';
    exception when check_violation then
      if sqlerrm<>'CLEANING_REQUEST_CANCEL_CONFLICT' then raise; end if;
    end;
  end $probe$;`);
  assert.equal(digest(), preserved, 'Legacy PIN rejection writes no cancellation effects');
  phase = '92-to-93-install';
  execFileSync(process.execPath, [cli, 'migration', 'up', '--local'], { stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '93');
  assert.equal(sql(`select exists(select 1 from supabase_migrations.schema_migrations where version='${added}');`), 't');
  assert.equal(digest(), preserved, '92→93 preserves exact target/schedule/snapshot/PIN/receipt/audit/notification history');
  assert.equal(sql("select count(*) from public.notifications where event_family='cleaning_request.cancelled_revoked';"), oldCancellationCount,
    'Installation never backfills cancellation notices');
  assert.equal(sql(`select has_function_privilege('service_role',
    'public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)','EXECUTE');`), 'f',
  'Sessionless legacy command loses runtime EXECUTE');
  assert.equal(sql(`select has_function_privilege('service_role',
    'public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text)','EXECUTE');`), 't');
  phase = 'old-receipt-replay';
  assert.deepEqual(JSON.parse(sql(`select public.cancel_manual_cleaning_request_with_session('${id(1)}','${id(201)}','${id(1001)}',1,
    'CUSTOM_CANCEL_REASON','manual-upgrade-old-receipt',repeat('3',64));`)), oldReceipt,
  'Pre-93 completed receipt replays exact public response through the new session guard');
  assert.equal(digest(), preserved, 'Old receipt replay cannot add evidence or backfill an audit assignment identity');
  phase = 'new-command-probes';
  for (const n of [2, 3, 4]) assert.equal(JSON.parse(sql(command(n))).status, 'cancelled',
    'New session-aware command allows an unstarted manual request regardless of legacy/finalized/open PIN evidence');
  const newEffects = JSON.parse(sql(`select json_build_object(
    'audits',(select count(*) from public.audit_events where entity_id in('${id(1002)}','${id(1003)}','${id(1004)}')
      and event_type='cleaning.manual_request.cancelled' and after_state->>'cancelledAssignmentId' in('${id(2002)}','${id(2003)}','${id(2004)}')),
    'notices',(select count(*) from public.notifications where cleaning_target_id in('${id(1002)}','${id(1003)}','${id(1004)}')
      and event_family='cleaning_request.cancelled_revoked'),
    'deliveries',(select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
      where n.cleaning_target_id in('${id(1002)}','${id(1003)}','${id(1004)}') and n.event_family='cleaning_request.cancelled_revoked'),
    'endedEntitlements',(select count(*) from private.room_pin_assignment_entitlements where assignment_id in('${id(2002)}','${id(2003)}','${id(2004)}') and ended_at is not null),
    'legacyClosed',(select revoked_at is not null and revealed_at is not null from public.room_pin_access_leases where id='${id(5002)}'),
    'finalizedPreserved',exists(select 1 from private.room_pin_reveal_leases where assignment_id='${id(2003)}' and finalized_at is not null and revoked_at is null),
    'openClosed',exists(select 1 from private.room_pin_reveal_leases where assignment_id='${id(2004)}' and finalized_at is null and revoked_at is not null));`));
  assert.deepEqual(newEffects, { audits: 3, notices: 3, deliveries: 3, endedEntitlements: 3,
    legacyClosed: true, finalizedPreserved: true, openClosed: true }, 'New cancellation effects bind exact owners and close only future PIN access');
  console.log('Manual cleaning cancellation upgrade 92→93: PASS; exact old history/receipt preserved, no backfill, new policy verified.');
} catch (error) {
  const sourceLine = error instanceof Error ? error.stack?.match(/test-manual-cleaning-cancel-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Manual cancellation upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
    sourceLine: sourceLine ? Number(sourceLine) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try { reset(); } catch { console.error('Manual cancellation upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
}
