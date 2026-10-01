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
const id = (n) => `30860000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function upgradeFixture() {
  const source = readFileSync('supabase/tests/cleaning_report_notifications.sql', 'utf8');
  const beginMarker = '-- BEGIN CLEANING REPORT NOTIFICATION UPGRADE FIXTURE';
  const endMarker = '-- END CLEANING REPORT NOTIFICATION UPGRADE FIXTURE';
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  assert(begin >= 0 && end > begin, 'Cleaning report notification upgrade fixture markers must exist');
  const fixture = source.slice(begin + beginMarker.length, end);
  assert(fixture.includes('create function pg_temp.report_fixture('), 'Report fixture helper must be inside markers');
  assert(fixture.includes('create function pg_temp.bomb_rpc('), 'Bomb RPC helper must be inside markers');
  assert(fixture.includes('create function pg_temp.issue_rpc('), 'Room-issue RPC helper must be inside markers');
  return fixture;
}

const bomb = (n, key, hash = 'b') => `select public.report_bomb_room('${id(2)}','${id(3000 + n)}',
  array[(select i.photo_version_id from private.attempt_photo_collection_items i
    join private.target_photo_slot_snapshots s on s.id=i.target_photo_slot_id
    where i.cleaning_attempt_id='${id(3000 + n)}' and i.active and s.slot_key='bomb-proof')],
  'sensitive-upgrade-memo','${key}',repeat('${hash}',64));`;
const issue = (n, key, hash = 'c') => `select public.report_attempt_room_issue('${id(2)}','${id(3000 + n)}',
  array[(select i.photo_version_id from private.attempt_photo_collection_items i
    join private.target_photo_slot_snapshots s on s.id=i.target_photo_slot_id
    where i.cleaning_attempt_id='${id(3000 + n)}' and i.active and s.slot_key='issue-proof')],
  'sensitive-upgrade-memo','${key}',repeat('${hash}',64));`;
const submission = (n, clientId, key, hash = 'd') => `select public.create_cleaning_submission(
  '${id(2)}','${id(3000 + n)}','${id(clientId)}',0,0,'${key}',repeat('${hash}',64));`;
const decision = (submissionId, key, hash = 'e') => `select public.decide_bomb_room(
  '${id(1)}','${submissionId}','approved','BOMB_CONFIRMED','${key}',repeat('${hash}',64));`;

const preservedSnapshot = () => JSON.parse(sql(`select json_build_object(
  'digest',md5(string_agg(tag||':'||data,'|' order by tag,data)),
  'bombReports',(select count(*) from private.bomb_room_reports),
  'roomIssueReports',(select count(*) from private.attempt_room_issue_reports),
  'bombDecisions',(select count(*) from private.bomb_room_decisions),
  'audits',(select count(*) from public.audit_events),
  'receipts',(select count(*) from private.command_executions),
  'notices',(select count(*) from public.notifications),
  'groups',(select count(*) from private.notification_groups),
  'deliveries',(select count(*) from private.notification_delivery_outbox)
) from (
  select 'bomb_report' tag,row_to_json(t)::text data from private.bomb_room_reports t union all
  select 'bomb_evidence',row_to_json(t)::text from private.bomb_room_report_evidence t union all
  select 'bomb_seal',row_to_json(t)::text from private.bomb_room_report_seals t union all
  select 'bomb_decision',row_to_json(t)::text from private.bomb_room_decisions t union all
  select 'room_issue_report',row_to_json(t)::text from private.attempt_room_issue_reports t union all
  select 'room_issue',row_to_json(t)::text from public.room_issues t union all
  select 'submission',row_to_json(t)::text from public.cleaning_submissions t union all
  select 'audit',row_to_json(t)::text from public.audit_events t union all
  select 'receipt',row_to_json(t)::text from private.command_executions t union all
  select 'notice',row_to_json(t)::text from public.notifications t union all
  select 'group',row_to_json(t)::text from private.notification_groups t union all
  select 'delivery',row_to_json(t)::text from private.notification_delivery_outbox t
) preserved;`));

try {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed', '--version', '20261001064101']);
  const fixture = upgradeFixture();
  sql(`begin; ${fixture}
    insert into report_photos values(3,'cleaning-proof',pg_temp.report_photo(3,'cleaning-proof',4005)),
      (3,'issue-proof',pg_temp.report_photo(3,'issue-proof',4006));
    commit;`);

  const oldBomb = JSON.parse(sql(bomb(1, 'upgrade-old-bomb')));
  const oldIssue = JSON.parse(sql(issue(2, 'upgrade-old-issue')));
  const oldSubmission = JSON.parse(sql(submission(1, 5001, 'upgrade-old-submission')));
  const oldDecision = JSON.parse(sql(decision(oldSubmission.id, 'upgrade-old-decision')));
  assert.equal(sql("select count(*) from public.notifications where event_family in ('bomb.reported_admin','room_issue.reported_admin','bomb.decided_maid');"), '0',
    'Version 90 cannot contain version 91 report notifications');
  const before = preservedSnapshot();

  run(process.execPath, [cli, 'migration', 'up', '--local']);
  assert.deepEqual(preservedSnapshot(), before,
    '90→91 preserves exact reports, decisions, audits, receipts, submissions and existing notification state');
  assert.equal(sql("select count(*) from public.notifications where event_family in ('bomb.reported_admin','room_issue.reported_admin','bomb.decided_maid');"), '0',
    'Installing version 91 never backfills historical report or decision notifications');

  assert.deepEqual(JSON.parse(sql(bomb(1, 'upgrade-old-bomb'))), oldBomb,
    'Old bomb report receipt replays the exact version 90 response');
  assert.deepEqual(JSON.parse(sql(issue(2, 'upgrade-old-issue'))), oldIssue,
    'Old room-issue receipt replays the exact version 90 response');
  assert.deepEqual(JSON.parse(sql(decision(oldSubmission.id, 'upgrade-old-decision'))), oldDecision,
    'Old bomb-decision receipt replays the exact version 90 response');
  assert.deepEqual(preservedSnapshot(), before, 'Old receipt replay cannot manufacture version 91 notifications');

  const newIssue = JSON.parse(sql(issue(3, 'upgrade-new-issue')));
  const newBomb = JSON.parse(sql(bomb(3, 'upgrade-new-bomb')));
  const newSubmission = JSON.parse(sql(submission(3, 5003, 'upgrade-new-submission')));
  const newDecision = JSON.parse(sql(decision(newSubmission.id, 'upgrade-new-decision')));
  const noticeState = JSON.parse(sql(`select json_build_object(
    'notices',count(distinct n.id),'deliveries',count(distinct o.id),
    'families',count(distinct n.event_family),'recipients',count(distinct n.recipient_profile_id),
    'valid',bool_and(not n.requires_action and n.resolved_at is null
      and n.title not like '%sensitive-upgrade-memo%' and n.body not like '%sensitive-upgrade-memo%'
      and ((n.event_family in ('bomb.reported_admin','room_issue.reported_admin')
          and n.recipient_profile_id in ('${id(1)}','${id(4)}','${id(5)}','${id(6)}')
          and n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id='${id(1003)}')
        or (n.event_family='bomb.decided_maid' and n.recipient_profile_id='${id(2)}'
          and n.deep_link_kind='submission' and n.deep_link_entity_id='${newSubmission.id}')))
    )
    from public.notifications n left join private.notification_delivery_outbox o on o.notification_id=n.id
    where (n.event_family='bomb.reported_admin' and n.source_entity_id='${newBomb.id}')
       or (n.event_family='room_issue.reported_admin' and n.source_entity_id='${newIssue.id}')
       or (n.event_family='bomb.decided_maid' and n.source_entity_id='${newDecision.id}');`));
  assert.equal(noticeState.notices, 9, 'New reports create four admin inbox rows each and decision creates one maid row');
  assert.equal(noticeState.deliveries, 5, 'Only two eligible admins per report and the active maid receive push intents');
  assert.equal(noticeState.families, 3, 'All three version 91 event families are emitted');
  assert.equal(noticeState.recipients, 5, 'Version 91 fanout reaches the exact four admins and original maid');
  assert.equal(noticeState.valid, true, 'New notices preserve safe links, roles and informational semantics');
  assert.equal(sql(`select count(*) from public.notifications where source_entity_id in ('${oldBomb.id}','${oldIssue.id}','${oldDecision.id}');`), '0',
    'New commands do not backfill old source identities');
  console.log('Cleaning report notifications upgrade 90→91: PASS; exact old history/receipts preserved, no backfill, new sources notify.');
} finally {
  run(process.execPath, [cli, 'db', 'reset', '--local', '--no-seed']);
}
