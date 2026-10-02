import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { manualCancelFixture, manualCancelId as id } from './test-manual-cleaning-cancel-concurrency.mjs';

// Disposable local93→current94-contract upgrade only. The shared actual request
// fixture preserves SQL dollar quoting, including the encrypted PIN fixture.
// No remote database, receipt hydration, ledger repair or secret logging.
const cli = 'node_modules/supabase/dist/supabase.js';
const psqlArgs = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt',
  '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const baseline = '20261002042113';
const added = '20261002074234';
const expectedMigrationCount = JSON.parse(readFileSync('supabase/migration-manifest.dev.json', 'utf8')).totalCount;
assert(Number.isSafeInteger(expectedMigrationCount) && expectedMigrationCount >= 94);
const protectedTables = [
  'public.rooms', 'public.room_types', 'public.profiles', 'public.reservations', 'public.cleaning_targets',
  'public.checkout_cleaning_obligations', 'public.cleaning_assignments', 'public.cleaning_attempts',
  'public.cleaning_target_schedule_revisions', 'public.availability_versions', 'public.availability_days',
  'public.audit_events', 'private.command_executions', 'public.notifications', 'private.notification_groups',
  'private.notification_delivery_outbox', 'private.notification_outbox', 'public.room_pin_access_leases',
  'private.room_pin_revisions', 'private.room_current_pin', 'private.room_pin_assignment_entitlements',
  'private.room_pin_reveal_leases', 'private.actor_activity_events'
];
// Only exact source-controlled tokens may escape captured subprocess output.
// Raw stdout/stderr, SQL statements, DETAILS and error objects remain private.
const knownDomainCodes = new Set([
  'ACTIVE_ACCOUNT_REQUIRED', 'ADMIN_REQUIRED', 'ACTIVE_MAID_REQUIRED',
  'PASSWORD_CHANGE_REQUIRED', 'SESSION_REVOKED', 'CLEANING_TARGET_NOT_FOUND',
  'ASSIGNMENT_INPUT_INVALID', 'ASSIGNMENT_SEQUENCE_INVALID', 'ASSIGNMENT_SEQUENCE_CONFLICT',
  'ASSIGNMENT_VERSION_INVALID', 'ASSIGNMENT_VERSION_CONFLICT', 'ASSIGNMENT_TARGET_STATE_INVALID',
  'ASSIGNMENT_SCHEDULE_INVALID', 'ASSIGNMENT_MAID_UNAVAILABLE', 'ASSIGNMENT_DRAFT_STALE_SCHEDULE',
  'ASSIGNMENT_COMMIT_NOT_ALLOWED', 'ASSIGNMENT_COMMIT_ITEMS_INVALID', 'ASSIGNMENT_COMMIT_ITEMS_DUPLICATED',
  'ASSIGNMENT_IMPACT_INVALID', 'ASSIGNMENT_IMPACT_CHANGED', 'ASSIGNMENT_AVAILABILITY_STALE',
  'ASSIGNMENT_COMMIT_LIMIT_EXCEEDED', 'ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED', 'ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED',
  'ASSIGNMENT_TARGET_READ_INVALID', 'CLEANING_WORKFLOW_REPLAN_REQUIRED', 'CLEANING_WORKFLOW_CANCEL_CONFLICT',
  'NOTIFICATION_TYPED_WRITER_COVERAGE_GAP', 'NOTIFICATION_CATALOG_CONTRACT_VIOLATION',
  'NOTIFICATION_PROVENANCE_INVALID', 'NOTIFICATION_GROUP_SCOPE_REQUIRED', 'NOTIFICATION_DEDUPE_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED', 'INVALID_IDEMPOTENCY_KEY', 'INVALID_REQUEST_HASH',
  'INVALID_MANUAL_CLEANING_REQUEST', 'CLEANING_REQUEST_TIME_CONFLICT', 'STAYOVER_ACCESS_WINDOW_INVALID',
  'ROOM_PIN_UNCONFIGURED', 'PIN_ENTITLEMENT_REQUIRED', 'ROOM_PIN_MISMATCH_UNRESOLVED',
  'AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS',
]);
const fixtureSteps = new Map([
  ['SHARED', 'version-93-fixture:shared'],
  ['ADDITIONAL', 'version-93-fixture:additional-request'],
  ['STAYOVER', 'version-93-fixture:stayover-request'],
  ['UNASSIGNED', 'version-93-fixture:unassigned-request'],
  ['AVAILABILITY', 'version-93-fixture:availability'],
  ['OLD_DRAFT', 'version-93-fixture:old-draft'],
  ['NEW_DRAFT', 'version-93-fixture:new-draft'],
  ['COMMIT', 'version-93-fixture:commit'],
]);
function sql(input) {
  try {
    return execFileSync('docker', psqlArgs, { input, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
  } catch (failure) {
    const stderr = failure?.stderr?.toString() ?? '';
    const stdout = failure?.stdout?.toString() ?? '';
    const code = stderr.match(/(?:^|\n)(?:psql:[^\r\n]*:\s*)?ERROR:\s+([A-Z][A-Z0-9_]{1,79})\s*(?:\r?\n|$)/)?.[1];
    for (const line of stdout.split(/\r?\n/)) {
      const step = line.match(/^ASSIGNMENT_METADATA_STEP_([A-Z_]+)$/)?.[1];
      if (fixtureSteps.has(step)) phase = fixtureSteps.get(step);
    }
    const error = new Error('ASSIGNMENT_METADATA_UPGRADE_SQL_FAILED');
    error.stableDomainCode = knownDomainCodes.has(code) ? code : null;
    throw error;
  }
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
const serviceDate = '2041-06-07';
const commandAt = '2041-06-07 09:00+09';
const impactSql = `select private.assignment_commit_impact_at('${serviceDate}','${commandAt}');`;
const commitSql = (n, fingerprint, key) => `select private.commit_and_notify_assignments_at(
  '${id(1)}','${serviceDate}','${fingerprint}',jsonb_build_array(jsonb_build_object(
    'cleaningTargetId','${id(1000 + n)}','expectedAssignmentVersion',2,'expectedAvailabilityVersion',1)),
  '${key}',repeat('a',64),'${commandAt}');`;
const metadataKeys = ['cleaningKind', 'sourceKind', 'roomTypeSnapshot', 'roomTypeCode', 'roomTypeName',
  'elevatorZone', 'feeSnapshot', 'originalServiceDate', 'effectiveServiceDate', 'rolloverCount',
  'rolloverReason', 'canCancel', 'cancelReasonCode'];
let resetStarted = false;
let phase = 'local-identity';
try {
  const localStatus = JSON.parse(execFileSync(process.execPath, [cli, 'status', '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  assert(['localhost', '127.0.0.1'].includes(new URL(localStatus.API_URL).hostname),
    'Only the disposable local database can be reset');
  resetStarted = true;
  phase = 'version-93-fixture';
  reset(baseline);
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), '93',
    'Upgrade baseline must have exactly93 migrations');
  sql(`begin;
    \\echo ASSIGNMENT_METADATA_STEP_SHARED
    ${manualCancelFixture()}
    -- Display names are TEXT snapshots, not bounded optimizer classifiers.
    update public.room_types set name=name||repeat('N',1001);
    \\echo ASSIGNMENT_METADATA_STEP_ADDITIONAL
    select pg_temp.manual_cancel_fixture(1,'additional','unassigned',false);
    \\echo ASSIGNMENT_METADATA_STEP_STAYOVER
    select pg_temp.manual_cancel_fixture(2,'stayover','unassigned',false);
    \\echo ASSIGNMENT_METADATA_STEP_UNASSIGNED
    select pg_temp.manual_cancel_fixture(3,'additional','unassigned',false);
    \\echo ASSIGNMENT_METADATA_STEP_AVAILABILITY
    insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
    values('${id(901)}','${id(2)}',date '${serviceDate}'-(extract(isodow from date '${serviceDate}')::int-1),
      1,clock_timestamp());
    insert into public.availability_days(availability_version_id,work_date,available)
    select '${id(901)}',date '${serviceDate}'-(extract(isodow from date '${serviceDate}')::int-1)+d,
      date '${serviceDate}'-(extract(isodow from date '${serviceDate}')::int-1)+d=date '${serviceDate}'
    from generate_series(0,6) d;
    \\echo ASSIGNMENT_METADATA_STEP_OLD_DRAFT
    select public.save_cleaning_assignment_draft('${id(1)}','${id(1001)}','${id(2)}',1,1,
      'assignment-read-upgrade-old-draft',repeat('3',64));
    \\echo ASSIGNMENT_METADATA_STEP_NEW_DRAFT
    select public.save_cleaning_assignment_draft('${id(1)}','${id(1002)}','${id(2)}',2,1,
      'assignment-read-upgrade-future-draft',repeat('4',64));
    \\echo ASSIGNMENT_METADATA_STEP_COMMIT
    commit;`);
  phase = 'version-93-initial-impact';
  const originalImpact = JSON.parse(sql(impactSql));
  assert.equal(originalImpact.committableDrafts.length, 2, 'Baseline has two actual committable drafts');
  const oldFingerprint = originalImpact.impactFingerprint;
  phase = 'version-93-old-receipt-create';
  const oldReceipt = JSON.parse(sql(commitSql(1, oldFingerprint, 'assignment-read-upgrade-old-receipt')));
  assert.equal(oldReceipt.notifiedAssignments.length, 1);
  assert(metadataKeys.every((key) => !Object.hasOwn(oldReceipt.notifiedAssignments[0], key)),
    'Pre94 successful commit receipt really predates every additive metadata key');
  phase = 'version-93-post-commit-impact';
  const priorImpact = JSON.parse(sql(impactSql));
  phase = 'version-93-preview';
  const priorPreview = JSON.parse(sql(`select private.assignment_preview_snapshot_at('${id(1)}',
    '${serviceDate}','${commandAt}');`));
  phase = 'version-93-history-digest';
  const preserved = digest();
  phase = '93-to-current-install';
  execFileSync(process.execPath, [cli, 'migration', 'up', '--local'], { stdio: 'inherit' });
  assert.equal(sql('select count(*) from supabase_migrations.schema_migrations;'), String(expectedMigrationCount));
  assert.equal(sql(`select exists(select 1 from supabase_migrations.schema_migrations where version='${added}');`), 't');
  assert.equal(digest(), preserved, '93→94 leaves exact snapshot/assignment/schedule/receipt/audit/PIN/notification history unchanged');
  phase = 'read-only-and-fingerprint';
  const afterImpact = JSON.parse(sql(impactSql));
  assert.equal(afterImpact.impactFingerprint, priorImpact.impactFingerprint,
    'Additive display metadata cannot invalidate unchanged commit impact fingerprint');
  const stripMetadata = (rows) => rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([key]) => !metadataKeys.includes(key))));
  for (const key of ['committableDrafts', 'blockedDrafts', 'remainingUnassignedTargets']) {
    assert.deepEqual(stripMetadata(afterImpact[key]), priorImpact[key],
      'Installation preserves every original impact row field');
  }
  const afterPreview = JSON.parse(sql(`select private.assignment_preview_snapshot_at('${id(1)}',
    '${serviceDate}','${commandAt}');`));
  assert.deepEqual(afterPreview.sequenceReservations, priorPreview.sequenceReservations,
    'Read metadata does not change occupied sequence reservations');
  assert.equal(digest(), preserved, 'Projection reads never backfill receipt or source evidence');
  assert.equal(sql(`select bool_and(not has_function_privilege(role_name,signature,'EXECUTE'))
    from unnest(array['anon','authenticated','service_role']) role_name cross join unnest(array[
    'private.assignment_target_read_metadata(uuid,uuid)','private.assignment_target_read_rows(jsonb)',
    'private.assignment_commit_read_metadata(jsonb)']) signature;`), 't', 'No runtime raw-helper EXECUTE is introduced');
  assert.equal(sql(`select bool_and(provolatile='s' and prosecdef) from pg_proc where oid in(
    'private.assignment_target_read_metadata(uuid,uuid)'::regprocedure,
    'private.assignment_target_read_rows(jsonb)'::regprocedure,'private.assignment_commit_read_metadata(jsonb)'::regprocedure);`),
  't', 'All additive helpers are STABLE read-only definer functions');
  sql(`begin read only; select private.assignment_target_read_metadata('${id(1001)}');
    select private.assignment_commit_impact_at('${serviceDate}','${commandAt}');
    select private.assignment_preview_snapshot_at('${id(1)}','${serviceDate}','${commandAt}'); rollback;`);
  phase = 'old-receipt-exact-replay';
  assert.deepEqual(JSON.parse(sql(commitSql(1, oldFingerprint, 'assignment-read-upgrade-old-receipt'))), oldReceipt,
    'Pre94 successful commit receipt replays exact response without current metadata hydration');
  assert.equal(digest(), preserved, 'Exact legacy replay has zero effects and no historical metadata backfill');
  phase = 'new-response-metadata';
  const newResponse = JSON.parse(sql(commitSql(2, afterImpact.impactFingerprint, 'assignment-read-upgrade-new-receipt')));
  const card = newResponse.notifiedAssignments[0];
  assert.equal(newResponse.notifiedAssignments.length, 1);
  assert(metadataKeys.every((key) => Object.hasOwn(card, key)), 'New commit card has every additive key');
  assert.equal(card.cleaningTargetId, id(1002));
  assert.equal(card.targetAssignmentVersion, 2);
  assert.equal(card.cleaningKind, 'stayover');
  assert.equal(card.sourceKind, 'stayover_request');
  assert.equal(card.originalServiceDate, serviceDate);
  assert.equal(card.effectiveServiceDate, serviceDate);
  assert.equal(card.rolloverCount, 0);
  assert.equal(card.rolloverReason, null);
  assert.equal(card.canCancel, true);
  assert.equal(card.cancelReasonCode, null);
  const targetSnapshot = JSON.parse(sql(`select json_build_object('code',room_type_snapshot->>'code',
    'name',room_type_snapshot->>'name','elevatorZone',room_type_snapshot->>'elevatorZone',
    'fee',fee_snapshot) from public.cleaning_targets where id='${id(1002)}';`));
  assert.deepEqual(card.roomTypeSnapshot, { code: targetSnapshot.code, name: targetSnapshot.name,
    elevatorZone: targetSnapshot.elevatorZone });
  assert.equal(card.roomTypeCode, targetSnapshot.code);
  assert.equal(card.roomTypeName, targetSnapshot.name);
  assert(card.roomTypeName.length > 1000, 'New receipt preserves a valid long historical display name without an arbitrary cap');
  assert.equal(card.elevatorZone, targetSnapshot.elevatorZone);
  assert.equal(card.feeSnapshot, targetSnapshot.fee);
  const afterNewCommand = digest();
  assert.deepEqual(JSON.parse(sql(commitSql(2, afterImpact.impactFingerprint, 'assignment-read-upgrade-new-receipt'))), newResponse,
    'New metadata is frozen in its own receipt on exact replay');
  assert.equal(digest(), afterNewCommand, 'New exact replay cannot add another assignment, notice, outbox or audit');
  console.log(`Assignment target read metadata contract94 / upgrade93→${expectedMigrationCount}: PASS; exact history/old receipt and impact fingerprint preserved, no backfill, new snapshot response verified.`);
} catch (error) {
  const sourceLine = error instanceof Error ? error.stack?.match(/test-assignment-target-read-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
  console.error(`Assignment metadata upgrade FAIL: ${JSON.stringify({ phase,
    kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
    stable_domain_code: error instanceof Error && knownDomainCodes.has(error.stableDomainCode) ? error.stableDomainCode : null,
    sourceLine: sourceLine ? Number(sourceLine) : null })}`);
  process.exitCode = 1;
} finally {
  if (resetStarted) {
    try { reset(); } catch { console.error('Assignment metadata upgrade fresh cleanup FAIL'); process.exitCode = 1; }
  }
}
