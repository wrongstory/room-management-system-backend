import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { manualCancelFixture, manualCancelId as id } from './test-manual-cleaning-cancel-concurrency.mjs';
import { assertUpgradeNotificationCatalog, upgradeHistorySnapshotSql } from './lib/upgrade-notification-catalog-compatibility.mjs';

// Disposable local94→current only. Capture every baseline public/private table
// and column, so nullable additions cannot hide any original history mutation.
const cli = 'node_modules/supabase/dist/supabase.js';
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261002074234';
const added = '20261002101126';
const expectedCount = JSON.parse(readFileSync('supabase/migration-manifest.dev.json', 'utf8')).totalCount;
assert(Number.isSafeInteger(expectedCount) && expectedCount >= 95);
const serviceDate = '2041-06-07';
const commandAt = '2041-06-07 09:00+09';
const impactSql = `select private.assignment_commit_impact_at('${serviceDate}','${commandAt}');`;
const commitSql = (n, fingerprint, key) => `select private.commit_and_notify_assignments_at(
  '${id(1)}','${serviceDate}','${fingerprint}',jsonb_build_array(jsonb_build_object(
  'cleaningTargetId','${id(1000 + n)}','expectedAssignmentVersion',2,'expectedAvailabilityVersion',1)),
  '${key}',repeat('a',64),'${commandAt}');`;
const incidentSignature = 'public.decide_checkout_presence_incident(uuid,uuid,uuid,bigint,text,text,text,timestamptz,jsonb,text,text)';
const sourceUpdate = `    perform set_config('app.reservation_segment_writer_mode','schedule_change_v1',true);
    update public.reservations set check_out_at=p_new_checkout_at,status='active',actual_checkout_at=null,
      version=version+1,updated_by=p_actor_profile_id where id=r.id returning * into r;
    perform set_config('app.reservation_segment_writer_mode',coalesce(previous_segment_mode,''),true);
`;
const sourceBoundary = `  update public.cleaning_targets set effective_service_date=next_date,available_from=next_from,due_at=next_due,
`;
let phase = 'local-identity';
let resetStarted = false;
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
  } catch {
    // Do not expose SQL, PIN envelopes, identities, payloads or raw subprocess errors.
    throw new Error('ASSIGNMENT_SCHEDULE_UPGRADE_SQL_FAILED');
  }
}
function reset(version) {
  const args = [cli, 'db', 'reset', '--local', '--no-seed'];
  if (version) args.push('--version', version);
  execFileSync(process.execPath, args, { stdio: 'inherit' });
}
function historyShape() {
  return JSON.parse(sql(`select coalesce(jsonb_agg(jsonb_build_object('table',table_name,
    'columns',columns) order by table_name),'[]') from (
    select format('%I.%I',n.nspname,c.relname) table_name,
      jsonb_agg(a.attname order by a.attnum) columns
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    join pg_attribute a on a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
    where n.nspname in('public','private') and c.relkind='r'
    group by n.nspname,c.relname) tables;`));
}
function snapshot(shape, excludeApprovedAddition = false) {
  return JSON.parse(sql(upgradeHistorySnapshotSql(shape, expectedCount, excludeApprovedAddition)));
}
function digest(shape) {
  return snapshot(shape).digest;
}
function preservedDigest(shape, baselineCatalog) {
  const current = snapshot(shape, true);
  // Validate the complete unfiltered catalog from the SAME statement before
  // accepting the digest that excludes only the exact approved111 addition.
  assertUpgradeNotificationCatalog(baselineCatalog, current.catalog, expectedCount);
  return current.digest;
}
const scheduleRead = (assignments, includeCurrent) => `select public.get_assignment_schedule_read(
  '${id(2)}','${id(202)}',array[${assignments.map((value) => `'${value}'::uuid`).join(',')}],${includeCurrent},'maid');`;
try {
  const status = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname), 'Only disposable local database is allowed');
  resetStarted = true;
  phase = 'baseline-94';
  reset(baseline);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '94');
  sql(`begin; ${manualCancelFixture()}
    select pg_temp.manual_cancel_fixture(1,'additional','unassigned',false);
    select pg_temp.manual_cancel_fixture(2,'stayover','unassigned',false);
    select pg_temp.manual_cancel_fixture(3,'additional','notified',false);
    select pg_temp.manual_cancel_fixture(4,'stayover','draft_assigned',false);
    select pg_temp.manual_cancel_fixture(5,'additional','unassigned',false);
    select pg_temp.manual_cancel(5);
    insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
    values('${id(901)}','${id(2)}',date '${serviceDate}'-(extract(isodow from date '${serviceDate}')::int-1),
      1,clock_timestamp());
    insert into public.availability_days(availability_version_id,work_date,available)
    select '${id(901)}',date '${serviceDate}'-(extract(isodow from date '${serviceDate}')::int-1)+d,true
    from generate_series(0,6) d;
    select public.save_cleaning_assignment_draft('${id(1)}','${id(1001)}','${id(2)}',1,1,
      'schedule-upgrade-old-draft',repeat('3',64));
    select public.save_cleaning_assignment_draft('${id(1)}','${id(1002)}','${id(2)}',2,1,
      'schedule-upgrade-legacy-draft',repeat('4',64)); commit;`);
  phase = 'baseline-receipt-and-history';
  const oldImpact = JSON.parse(sql(impactSql));
  const oldReceipt = JSON.parse(sql(commitSql(1, oldImpact.impactFingerprint, 'schedule-upgrade-old-receipt')));
  assert.equal(oldReceipt.notifiedAssignments.length, 1);
  const oldAssignment = oldReceipt.notifiedAssignments[0].assignmentId;
  assert.match(oldAssignment, /^[0-9a-f-]{36}$/);
  const shape = historyShape();
  assert(!shape.find(({ table }) => table === 'public.cleaning_assignments').columns.includes('notified_reservation_schedule_snapshot'));
  assert(!shape.find(({ table }) => table === 'public.cleaning_target_schedule_revisions').columns.includes('reservation_schedule_snapshot'));
  const baselineSnapshot = snapshot(shape);
  const preserved = baselineSnapshot.digest;
  const priorImpact = JSON.parse(sql(impactSql));
  const priorIncident = JSON.parse(sql(`select to_json(pg_get_functiondef('${incidentSignature}'::regprocedure));`)).replaceAll('\r\n', '\n');
  assert.equal(priorIncident.split(sourceUpdate).length - 1, 1);
  assert.equal(priorIncident.split(sourceBoundary).length - 1, 1);
  phase = '94-to-current';
  execFileSync(process.execPath, [cli, 'migration', 'up', '--local'], { stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(expectedCount));
  assert.equal(sql(`select exists(select 1 from supabase_migrations.schema_migrations where version='${added}');`), 't');
  assert.equal(preservedDigest(shape, baselineSnapshot.catalog), preserved,
    'Every original column of every baseline public/private row remains exact except the separately verified exact111 catalog addition');
  assert.equal(sql(`select not exists(select 1 from public.cleaning_target_schedule_revisions where reservation_schedule_snapshot is not null)
    and not exists(select 1 from public.cleaning_assignments where notified_reservation_schedule_snapshot is not null);`), 't',
  'Every legacy schedule and assignment remains NULL without hydration');
  const installedIncident = JSON.parse(sql(`select to_json(pg_get_functiondef('${incidentSignature}'::regprocedure));`)).replaceAll('\r\n', '\n');
  const expectedIncident = priorIncident.replace(sourceUpdate, '').replace(sourceBoundary,
    `  if p_decision='EXTEND_CHECKOUT' then\n${sourceUpdate}  end if;\n${sourceBoundary}`);
  assert.equal(installedIncident, expectedIncident, 'Complete incident definition differs only by the exact reservation UPDATE move');
  phase = 'legacy-read-only-replay';
  const afterImpact = JSON.parse(sql(impactSql));
  assert.deepEqual(afterImpact, priorImpact, 'Read snapshot additions cannot change existing impact/fingerprint contract');
  for (const includeCurrent of [false, true]) {
    for (const card of JSON.parse(sql(scheduleRead([oldAssignment, id(2003)], includeCurrent)))) {
      assert.equal(card.scheduleSnapshot, null);
      assert.equal(card.currentDeparture, null);
    }
  }
  sql(`begin read only; ${scheduleRead([oldAssignment], true)} rollback;`);
  assert.deepEqual(JSON.parse(sql(commitSql(1, oldImpact.impactFingerprint, 'schedule-upgrade-old-receipt'))), oldReceipt,
    'Legacy successful receipt replays without adding nested snapshots');
  assert.equal(preservedDigest(shape, baselineSnapshot.catalog), preserved,
    'Legacy reads and replay have zero history/notification/audit/PIN/receipt effects; exact catalog metadata remains verified');
  phase = 'legacy-first-notification';
  const legacyNotice = JSON.parse(sql(commitSql(2, afterImpact.impactFingerprint, 'schedule-upgrade-legacy-receipt')));
  const legacyCard = JSON.parse(sql(scheduleRead([legacyNotice.notifiedAssignments[0].assignmentId], true)))[0];
  assert.equal(legacyCard.scheduleSnapshot, null, 'First notice cannot fill a legacy missing frozen plan from current reservations');
  assert.equal(legacyCard.currentDeparture, null);
  phase = 'future-plan-and-notification';
  sql(`select public.create_manual_cleaning_request('${id(1)}','${id(1006)}',
    (select room_id from public.cleaning_targets where id='${id(1005)}'),null,'additional','${serviceDate}',
    '${serviceDate} 00:00+09','${serviceDate} 23:00+09',
    (select state_version from public.rooms where id=(select room_id from public.cleaning_targets where id='${id(1005)}')),
    'SCHEDULE_UPGRADE','schedule-upgrade-new-request',repeat('b',64));
    select public.save_cleaning_assignment_draft('${id(1)}','${id(1006)}','${id(2)}',6,1,
    'schedule-upgrade-new-draft',repeat('c',64));`);
  const newImpact = JSON.parse(sql(impactSql));
  const newNotice = JSON.parse(sql(commitSql(6, newImpact.impactFingerprint, 'schedule-upgrade-new-receipt')));
  const newCard = JSON.parse(sql(scheduleRead([newNotice.notifiedAssignments[0].assignmentId], true)))[0];
  assert.equal(Object.keys(newCard.scheduleSnapshot).length, 14);
  assert.equal(newCard.scheduleSnapshot.sourceReservationVersion, null);
  assert.equal(newCard.scheduleSnapshot.plannedCheckoutAt, null);
  assert.equal(newCard.scheduleSnapshot.isScheduleUpdated, false);
  assert.equal(newCard.currentDeparture.actualCheckoutAt, null);
  assert.equal(newCard.currentDeparture.actualRoomDepartureAt, null);
  const afterNew = digest(historyShape());
  assert.deepEqual(JSON.parse(sql(commitSql(6, newImpact.impactFingerprint, 'schedule-upgrade-new-receipt'))), newNotice);
  sql(scheduleRead([newNotice.notifiedAssignments[0].assignmentId], true));
  assert.equal(digest(historyShape()), afterNew, 'New exact replay and schedule reads are side-effect free');
  console.log(`Assignment reservation schedule contract95 / upgrade94→${expectedCount}: PASS; all baseline columns/history and exact receipts preserved, legacy unknowns and future-only captures verified.`);
} catch (error) {
  const sourceLine = error instanceof Error ? error.stack?.match(/test-assignment-reservation-schedule-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Assignment schedule upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
    sourceLine: sourceLine ? Number(sourceLine) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try { reset(); } catch { console.error('Assignment schedule upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
}
