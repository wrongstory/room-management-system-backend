import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Disposable local synthetic database only; db:test serializes reset users.
const cli = 'node_modules/supabase/dist/supabase.js';
const container = 'supabase_db_room-management-system-backend';
const psqlArgs = ['exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'postgres'];
const run = (command, args, input) => execFileSync(command, args, {
  encoding: 'utf8', input, stdio: input ? ['pipe', 'pipe', 'pipe'] : 'inherit'
});
const sql = (input) => run('docker', psqlArgs, input).trim();
const id = (n) => `30850000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const tables = ['public.cleaning_targets', 'public.cleaning_assignments', 'public.cleaning_attempts',
  'public.cleaning_target_schedule_revisions', 'public.availability_versions', 'public.availability_days',
  'public.audit_events', 'public.notifications', 'private.notification_outbox', 'private.notification_delivery_outbox',
  'private.notification_groups', 'private.command_executions', 'public.reservations', 'public.checkout_cleaning_obligations'];
const snapshot = () => sql(`select md5(string_agg(data,'|' order by data)) from (
  ${tables.map((name) => `select '${name}:'||row_to_json(row)::text data from ${name} row`).join(' union all ')}
) preserved;`);
const impact = (day = '2038-06-07') => JSON.parse(sql(`select private.assignment_commit_impact_at('${day}','2038-06-07 08:00+09');`));
const commit = (target, fingerprint, key, version = 1) => `select private.commit_and_notify_assignments_at(
  '${id(1)}','2038-06-07','${fingerprint}',
  '[{"cleaningTargetId":"${id(1000 + target)}","expectedAssignmentVersion":2,"expectedAvailabilityVersion":${version}}]',
  '${key}',repeat('a',64),'2038-06-07 08:00+09');`;
const submit = (maid, key, version = 1) => `select private.submit_weekly_availability_at(
  '${id(maid)}','2038-06-07',array['2038-06-08'::date],${version},'${key}','2038-06-07 08:00+09');`;
const startSql = (input) => {
  const child = spawn('docker', psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  child.stdin.end(input);
  return { done, child };
};
// Observe the holder's actual transaction state, not a guessed launch delay.
const waitForHolder = async (name) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
      and wait_event='PgSleep' and xact_start is not null);`) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Local race holder did not reach its locked post-command state: ${name}`);
};
const waitForContenderLock = async (name) => {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}'
      and wait_event_type='Lock' and xact_start is not null);`) === 't') return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Local race contender was not observed blocked on the holder's transaction: ${name}`);
};

try {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20261001041801']);
  const source = readFileSync('supabase/tests/cleaning_overdue_commit.sql', 'utf8');
  const marker = '-- END OVERDUE COMMIT FIXTURE';
  assert(source.includes(marker), 'Source-controlled fixture boundary must exist');
  const fixture = source.split(marker)[0].replace('begin;', '').replace('select no_plan();', '');
  assert(fixture.includes("select pg_temp.overdue_commit_fixture(8,'2038-06-06','cancelled',80);"));
  sql(`begin; ${fixture} commit;`);
  const before = snapshot();
  assert.equal(impact().committableDrafts.length, 1, '89 only includes today draft');
  assert.equal(impact().remainingUnassignedTargets.length, 0, '89 omits old unassigned');
  assert.equal(impact('2038-06-08').committableDrafts.length, 1, '89 tomorrow exact baseline');
  assert.equal(snapshot(), before, '89 preflight is read-only');
  run(process.execPath, [cli, 'migration', 'up', '--local']);
  assert.equal(snapshot(), before, '89→90 preserves every existing business and delivery row');
  const current = impact();
  assert.equal(current.committableDrafts.length, 2, '90 includes old and today draft');
  assert.equal(current.committableDrafts.find((row) => row.cleaningTargetId === id(1002)).serviceDate,
    '2038-06-06', 'Original assignment date preserved in preflight');
  assert.equal(current.blockedDrafts.length, 2, 'Stale snapshot and today unavailable remain blocked');
  assert.equal(current.remainingUnassignedTargets[0].serviceDate, '2038-06-06');
  assert.equal(impact('2038-06-08').committableDrafts.length, 1, 'Tomorrow does not adopt old drafts');
  assert.equal(snapshot(), before, '90 install/preflight cannot rewrite history or notify');

  const holders = [];
  try {
    // Commit wins: current planning-day version is locked through notification
    // and immutable audit provenance; contender cannot remove today's availability.
    const first = startSql(`set application_name='overdue_commit_first'; begin;
      ${commit(2, current.impactFingerprint, 'overdue-race-commit-first')}
      select pg_sleep(5); commit;`);
    holders.push(first);
    await waitForHolder('overdue_commit_first');
    const availabilityContender = startSql(`set application_name='overdue_availability_contender';
      ${submit(3, 'overdue-race-availability-loses')}`);
    holders.push(availabilityContender);
    await waitForContenderLock('overdue_availability_contender');
    const [winner, loser] = await Promise.all([first.done, availabilityContender.done]);
    assert.equal(winner.code, 0, winner.stderr);
    assert.notEqual(loser.code, 0);
    assert.match(loser.stderr, /ASSIGNMENT_AVAILABILITY_STALE/);
    assert.equal(sql(`select status from public.cleaning_targets where id='${id(1002)}';`), 'notified');
    assert.equal(sql(`select version from public.availability_versions where maid_profile_id='${id(3)}'
      and week_start='2038-06-07' and is_current;`), '1');
    assert.equal(sql(`select service_date||'/'||sequence_number from public.cleaning_assignments where id='${id(2002)}';`), '2038-06-06/2');
    assert.equal(sql(`select count(*) from public.audit_events where event_type='assignment.notified'
      and entity_id='${id(2002)}' and after_state->>'serviceDate'='2038-06-07';`), '1');

    // Availability wins on an independent old draft/maid: commit waits for the
    // same current-week lock, then rejects the now-changed impact and writes zero.
    sql(`select private.submit_weekly_availability_at('${id(4)}','2038-06-07',
      array['2038-06-07'::date,'2038-06-08'::date],1,'overdue-race-setup-availability','2038-06-07 08:00+09');`);
    const secondImpact = impact();
    const second = startSql(`set application_name='overdue_availability_first'; begin;
      ${submit(4, 'overdue-race-availability-first', 2)} select pg_sleep(5); commit;`);
    holders.push(second);
    await waitForHolder('overdue_availability_first');
    const commitContender = startSql(`set application_name='overdue_commit_contender';
      ${commit(6, secondImpact.impactFingerprint, 'overdue-race-commit-loses', 2)}`);
    holders.push(commitContender);
    await waitForContenderLock('overdue_commit_contender');
    const [availabilityWinner, commitLoser] = await Promise.all([second.done, commitContender.done]);
    assert.equal(availabilityWinner.code, 0, availabilityWinner.stderr);
    assert.notEqual(commitLoser.code, 0);
    assert.match(commitLoser.stderr, /ASSIGNMENT_IMPACT_CHANGED/);
    assert.equal(sql(`select status from public.cleaning_targets where id='${id(1006)}';`), 'draft_assigned');
    assert.equal(sql(`select count(*) from public.audit_events where event_type='assignment.notified' and entity_id='${id(2006)}';`), '0');
    assert.equal(sql(`select count(*) from public.notifications where cleaning_target_id='${id(1006)}';`), '0');
    assert.equal(sql(`select count(*) from private.command_executions where idempotency_key='overdue-race-commit-loses';`), '0');
    console.log('Cleaning overdue commit upgrade89→90: PASS; exact history preserved, original dates, today availability, tomorrow exact; both real transaction race orders PASS.');
  } finally {
    for (const holder of holders) {
      if (holder.child.exitCode === null) holder.child.kill();
    }
    await Promise.allSettled(holders.map((holder) => holder.done));
  }
} finally {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed']);
}
