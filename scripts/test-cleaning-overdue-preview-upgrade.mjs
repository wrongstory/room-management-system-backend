import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Disposable local synthetic database only. db:test serializes all reset users.
const cli = 'node_modules/supabase/dist/supabase.js';
const run = (command, args, input) => execFileSync(command, args, {
  encoding: 'utf8', input, stdio: input ? ['pipe', 'pipe', 'pipe'] : 'inherit'
});
const sql = (input) => run('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
  'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'], input).trim();
const tables = ['public.cleaning_targets', 'public.cleaning_assignments', 'public.cleaning_attempts',
  'public.cleaning_target_schedule_revisions', 'public.availability_versions', 'public.availability_days',
  'public.audit_events', 'public.notifications', 'private.notification_outbox', 'private.notification_delivery_outbox',
  'private.notification_groups', 'private.command_executions', 'public.reservations', 'public.checkout_cleaning_obligations'];
const snapshot = () => sql(`select md5(string_agg(data,'|' order by data)) from (
  ${tables.map((name) => `select '${name}:'||(to_jsonb(row)-array['reservation_schedule_snapshot','notified_reservation_schedule_snapshot'])::text data from ${name} row`).join(' union all ')}
) preserved;`);
const id = (n) => `30840000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const preview = (day = '2038-06-07') => JSON.parse(sql(`select private.assignment_preview_snapshot_at(
  '${id(1)}','${day}','2038-06-07 08:00+09');`));

try {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20261001024524']);
  const source = readFileSync('supabase/tests/cleaning_overdue_preview.sql', 'utf8');
  const marker = '-- END OVERDUE PREVIEW FIXTURE';
  assert(source.includes(marker), 'Source-controlled fixture boundary must exist');
  const fixture = source.split(marker)[0].replace('begin;', '').replace('select no_plan();', '');
  assert(fixture.includes("select pg_temp.preview_fixture(14,'2038-06-07','unassigned');"),
    'Full overdue fixture must precede assertions');
  sql(`begin; ${fixture} commit;`);
  const before = snapshot();
  const previous = preview();
  assert.equal(previous.targets.length, 4, '88 snapshot omits old no-attempt candidates');
  assert.equal(previous.targets.find((t) => t.cleaningTargetId === id(1004)).blockedReason,
    'ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED');
  assert.equal(previous.sequenceReservations, undefined, '88 has no occupancy metadata');
  assert.equal(snapshot(), before, '88 preview itself remains read-only');

  run(process.execPath, [cli, 'migration', 'up', '--local']);
  assert.equal(snapshot(), before, '88→89 preserves every old row, including snapshots, owners and receipts');
  const current = preview();
  assert.equal(current.targets.length, 8, '89 includes bounded old unfinished candidates on today');
  for (const n of [1001, 1002, 1003, 1004]) {
    const t = current.targets.find((item) => item.cleaningTargetId === id(n));
    assert(t, 'Old target retained');
    assert.equal(t.serviceDate, '2038-06-06', 'Original service date remains immutable');
    assert.equal(t.blockedReason, null, 'Date passage alone is not a blocker');
  }
  assert.equal(current.sequenceReservations.find((slot) => slot.maidProfileId === id(3) &&
    slot.serviceDate === '2038-06-06').maxSequenceNumber, 60, 'Terminal current assignment slots remain occupied');
  assert.equal(current.targets.find((t) => t.cleaningTargetId === id(1013)).blockedReason,
    'ASSIGNMENT_DRAFT_STALE_SCHEDULE', 'Real snapshot staleness remains blocked');
  assert.equal(current.targets.find((t) => t.cleaningTargetId === id(1014)).blockedReason,
    'PREVIOUS_ROOM_WORKFLOW_ACTIVE', 'Real previous room workflow remains blocked');
  const tomorrow = preview('2038-06-08');
  assert.deepEqual(tomorrow.targets.map(t => t.cleaningTargetId).sort(),
    [1001,1002,1003,1004,1005,1006,1011,1012,1013,1014].map(id).sort(),
    'Latest head includes tomorrow and unfinished backlog, not approved/cancelled history');
  assert.equal(snapshot(), before, 'Installing and reading89 cannot rewrite history or produce notifications');
  console.log('Cleaning overdue preview upgrade88→latest: PASS; exact history preserved, today4→8, tomorrow10, terminal max60, no writes.');
} finally {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed']);
}
