import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const id = (n) => `30860000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function markedFixture() {
  const source = readFileSync('supabase/tests/cleaning_report_notifications.sql', 'utf8');
  const beginMarker = '-- BEGIN CLEANING REPORT NOTIFICATION UPGRADE FIXTURE';
  const endMarker = '-- END CLEANING REPORT NOTIFICATION UPGRADE FIXTURE';
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  assert(begin >= 0 && end > begin, 'Cleaning report notification concurrency fixture markers must exist');
  const fixture = source.slice(begin + beginMarker.length, end);
  assert(fixture.includes('select pg_temp.report_fixture(3);'), 'Concurrency fixture must include three isolated attempts');
  return fixture;
}

export async function testCleaningReportNotificationConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname),
    'Cleaning report notification races require disposable local Supabase');
  const sql = (input) => execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000
  }).trim();
  const fixture = markedFixture();
  sql(`begin; ${fixture} commit;`);

  const photo = (attemptNumber, slot) => sql(`select i.photo_version_id from private.attempt_photo_collection_items i
    join private.target_photo_slot_snapshots s on s.id=i.target_photo_slot_id
    where i.cleaning_attempt_id='${id(3000 + attemptNumber)}' and i.active and s.slot_key='${slot}';`);
  const bombPhoto1 = photo(1, 'bomb-proof');
  const issuePhoto2 = photo(2, 'issue-proof');
  const bombPhoto3 = photo(3, 'bomb-proof');
  for (const value of [bombPhoto1, issuePhoto2, bombPhoto3]) {
    assert.match(value, /^[0-9a-f-]{36}$/, 'Fixture must expose an accepted incident photo version');
  }
  const bombArgs = (attemptNumber, evidenceId, key, requestHash = 'b'.repeat(64), actor = id(2)) => ({
    p_actor_profile_id: actor,
    p_attempt_id: id(3000 + attemptNumber),
    p_evidence_photo_ids: [evidenceId],
    p_memo: 'sensitive-concurrency-memo',
    p_idempotency_key: key,
    p_request_hash: requestHash
  });
  const issueArgs = (key, requestHash = 'c'.repeat(64), actor = id(2)) => ({
    p_actor_profile_id: actor,
    p_attempt_id: id(3002),
    p_evidence_photo_ids: [issuePhoto2],
    p_memo: 'sensitive-concurrency-memo',
    p_idempotency_key: key,
    p_request_hash: requestHash
  });
  const expectError = (response, code, message) => {
    assert(response.error, `Expected ${message}`);
    assert.equal(response.error.code, code, `${message} SQLSTATE`);
    assert.equal(response.error.message, message);
  };
  const reportSummary = (family, sourceId, attemptNumber) => JSON.parse(sql(`select json_build_object(
    'adminCount',(select count(*) from public.profiles where role='admin'),
    'pushAdminCount',(select count(*) from public.profiles where role='admin' and status='active' and not must_change_password),
    'notices',count(distinct n.id),'deliveries',count(distinct o.id),
    'recipientCount',count(distinct n.recipient_profile_id),
    'valid',bool_and(not n.requires_action and n.resolved_at is null and n.actor_profile_id='${id(2)}'
      and n.cleaning_target_id='${id(1000 + attemptNumber)}' and n.deep_link_kind='cleaningTarget'
      and n.deep_link_entity_id='${id(1000 + attemptNumber)}' and n.title not like '%sensitive-concurrency-memo%'
      and n.body not like '%sensitive-concurrency-memo%'),
    'ids',json_agg(distinct n.id order by n.id)
    )
    from public.notifications n left join private.notification_delivery_outbox o on o.notification_id=n.id
    where n.event_family='${family}' and n.source_entity_id='${sourceId}';`));
  const verifyReport = (family, sourceId, attemptNumber) => {
    const state = reportSummary(family, sourceId, attemptNumber);
    assert.equal(state.notices, state.adminCount, 'Exactly one report inbox row per business admin');
    assert.equal(state.recipientCount, state.adminCount, 'Report fanout contains no duplicate admin recipient');
    assert.equal(state.deliveries, state.pushAdminCount, 'Only active password-complete admins receive report push intents');
    assert.equal(state.valid, true, 'Every report notice has an exact safe source, link and informational shape');
    return state;
  };

  expectError(await client.rpc('report_bomb_room',
    bombArgs(1, bombPhoto1, randomUUID(), 'b'.repeat(64), id(3))), '42501', 'SUBMISSION_ACCESS_REQUIRED');
  expectError(await client.rpc('report_attempt_room_issue',
    issueArgs(randomUUID(), 'c'.repeat(64), id(3))), '42501', 'SUBMISSION_ACCESS_REQUIRED');

  const bombKey = randomUUID();
  const sameBomb = await Promise.all(Array.from({ length: 8 }, () =>
    client.rpc('report_bomb_room', bombArgs(1, bombPhoto1, bombKey))));
  assert(sameBomb.every((response) => !response.error), 'Concurrent same-key bomb reports must all replay successfully');
  for (const response of sameBomb) {
    assert.deepEqual(response.data, sameBomb[0].data, 'Concurrent same-key bomb report returns one immutable receipt');
  }
  const bombState = verifyReport('bomb.reported_admin', sameBomb[0].data.id, 1);
  assert.equal(sql(`select count(*) from private.bomb_room_reports where cleaning_attempt_id='${id(3001)}';`), '1',
    'Same-key race creates one bomb report');
  assert.equal(sql(`select count(*) from public.audit_events where event_type='submission.bomb_reported'
    and entity_id='${sameBomb[0].data.id}';`), '1', 'Same-key race creates one immutable bomb audit');
  assert.equal(sql(`select count(*) from private.command_executions where actor_profile_id='${id(2)}'
    and command_type='submission.report_bomb_room' and idempotency_key='${bombKey}';`), '1',
  'Same-key race creates one receipt');

  const newKeyFailures = await Promise.all(Array.from({ length: 4 }, () =>
    client.rpc('report_bomb_room', bombArgs(1, bombPhoto1, randomUUID()))));
  for (const response of newKeyFailures) expectError(response, '22023', 'INVALID_BOMB_REPORT');
  assert.deepEqual(reportSummary('bomb.reported_admin', sameBomb[0].data.id, 1), bombState,
    'Repeated new keys cannot duplicate or replace report notices');

  const issueKey = randomUUID();
  const sameIssue = await Promise.all(Array.from({ length: 6 }, () =>
    client.rpc('report_attempt_room_issue', issueArgs(issueKey))));
  assert(sameIssue.every((response) => !response.error), 'Concurrent same-key room issues must all replay successfully');
  for (const response of sameIssue) {
    assert.deepEqual(response.data, sameIssue[0].data, 'Concurrent same-key room issue returns one immutable receipt');
  }
  verifyReport('room_issue.reported_admin', sameIssue[0].data.id, 2);
  assert.equal(sql(`select count(*) from private.attempt_room_issue_reports where cleaning_attempt_id='${id(3002)}';`), '1',
    'Same-key race creates one room-issue report');

  const submissionKey = randomUUID();
  const submission = await client.rpc('create_cleaning_submission', {
    p_actor_profile_id: id(2), p_attempt_id: id(3001), p_client_submission_id: randomUUID(),
    p_expected_revision: 0, p_candle_count: 0, p_idempotency_key: submissionKey,
    p_request_hash: 'd'.repeat(64)
  });
  assert.equal(submission.error, null, 'Bomb fixture must produce a current immutable submission');
  const maidDecision = await client.rpc('decide_bomb_room', {
    p_actor_profile_id: id(2), p_submission_id: submission.data.id, p_decision: 'approved',
    p_reason_code: 'BOMB_CONFIRMED', p_idempotency_key: randomUUID(), p_request_hash: 'e'.repeat(64)
  });
  expectError(maidDecision, '42501', 'ADMIN_REQUIRED');
  const decisionRace = await Promise.all(Array.from({ length: 6 }, () => client.rpc('decide_bomb_room', {
    p_actor_profile_id: id(1), p_submission_id: submission.data.id, p_decision: 'approved',
    p_reason_code: 'BOMB_CONFIRMED', p_idempotency_key: randomUUID(), p_request_hash: 'e'.repeat(64)
  })));
  const decisionWinners = decisionRace.filter((response) => !response.error);
  assert.equal(decisionWinners.length, 1, 'Different-key decision CAS race has exactly one valid winner');
  for (const response of decisionRace.filter((item) => item.error)) {
    expectError(response, '40001', 'BOMB_DECISION_ALREADY_RECORDED');
  }
  const decisionId = decisionWinners[0].data.id;
  const decisionState = JSON.parse(sql(`select json_build_object(
    'decisions',(select count(*) from private.bomb_room_decisions where submission_id='${submission.data.id}'),
    'audits',(select count(*) from public.audit_events where event_type='inspection.bomb_decided' and entity_id='${decisionId}'),
    'notices',count(distinct n.id),'deliveries',count(distinct o.id),'recipients',count(distinct n.recipient_profile_id),
    'valid',bool_and(n.recipient_profile_id='${id(2)}' and n.actor_profile_id='${id(1)}'
      and not n.requires_action and n.resolved_at is null and n.deep_link_kind='submission'
      and n.deep_link_entity_id='${submission.data.id}' and n.title not like '%sensitive-concurrency-memo%'
      and n.body not like '%sensitive-concurrency-memo%')
    )
    from public.notifications n left join private.notification_delivery_outbox o on o.notification_id=n.id
    where n.event_family='bomb.decided_maid' and n.source_entity_id='${decisionId}';`));
  assert.equal(decisionState.decisions, 1, 'Decision CAS persists one immutable decision');
  assert.equal(decisionState.audits, 1, 'Decision CAS persists one immutable audit');
  assert.equal(decisionState.notices, 1, 'Decision winner creates one notice for the original maid');
  assert.equal(decisionState.deliveries, 1, 'Active original maid receives one decision push intent');
  assert.equal(decisionState.recipients, 1, 'Decision fanout cannot escape to another role or maid');
  assert.equal(decisionState.valid, true, 'Decision notice preserves exact actor, recipient and safe submission link');

  const rollbackKey = randomUUID();
  sql(`begin;
    create function pg_temp.fail_report_delivery() returns trigger language plpgsql as $$
    begin
      if new.event_family='bomb.reported_admin' then
        raise exception using errcode='23514',message='REPORT_CONCURRENCY_TEST_FAILURE';
      end if;
      return new;
    end $$;
    create trigger fail_report_delivery before insert on private.notification_delivery_outbox
      for each row execute function pg_temp.fail_report_delivery();
    do $$ begin
      perform public.report_bomb_room('${id(2)}','${id(3003)}',array['${bombPhoto3}'::uuid],
        'sensitive-concurrency-memo','${rollbackKey}',repeat('f',64));
      raise exception using errcode='P0001',message='EXPECTED_REPORT_FAILURE';
    exception when check_violation then
      if sqlerrm<>'REPORT_CONCURRENCY_TEST_FAILURE' then raise; end if;
    end $$;
    drop trigger fail_report_delivery on private.notification_delivery_outbox;
    do $$ begin
      if exists(select 1 from private.bomb_room_reports where cleaning_attempt_id='${id(3003)}')
        or exists(select 1 from public.audit_events where event_type='submission.bomb_reported'
          and after_state->>'attemptId'='${id(3003)}')
        or exists(select 1 from private.command_executions where actor_profile_id='${id(2)}'
          and command_type='submission.report_bomb_room' and idempotency_key='${rollbackKey}')
        or exists(select 1 from public.notifications where cleaning_target_id='${id(1003)}') then
        raise exception using errcode='P0001',message='REPORT_FAILURE_DID_NOT_ROLL_BACK';
      end if;
    end $$;
    commit;`);
  const retryAfterRollback = await client.rpc('report_bomb_room',
    bombArgs(3, bombPhoto3, rollbackKey, 'f'.repeat(64)));
  assert.equal(retryAfterRollback.error, null, 'Rolled-back idempotency key remains reusable by the original command');
  verifyReport('bomb.reported_admin', retryAfterRollback.data.id, 3);
  const fixtureTemplateState = () => JSON.parse(sql(`select json_build_object(
    'status',(select status::text from public.cleaning_template_versions where id='${id(200)}'),
    'targetSnapshots',(select count(*) from public.cleaning_targets where id in
      ('${id(1001)}','${id(1002)}','${id(1003)}')
      and template_snapshot->>'id'='${id(200)}' and template_snapshot->>'version'='9'),
    'attemptSnapshots',(select count(*) from public.cleaning_attempts where id in
      ('${id(3001)}','${id(3002)}','${id(3003)}')
      and template_snapshot->>'id'='${id(200)}' and template_snapshot->>'version'='9')
  );`));
  const publishedFixture = fixtureTemplateState();
  assert.equal(publishedFixture.status, 'published', 'Concurrency fixture owns the exact published v9 template');
  assert.equal(publishedFixture.targetSnapshots, 3, 'All fixture targets retain the exact immutable v9 snapshot');
  assert.equal(publishedFixture.attemptSnapshots, 3, 'All fixture attempts retain the exact immutable v9 snapshot');
  assert.equal(sql(`update public.cleaning_template_versions set status='retired'
    where id='${id(200)}' and status='published' returning status::text;`), 'retired',
  'Concurrency fixture retires only its exact published template row');
  assert.deepEqual(fixtureTemplateState(), {...publishedFixture,status:'retired'},
    'Retiring the fixture template preserves every target and attempt snapshot');
  console.log('Cleaning report notifications: same-key/new-key report races, decision CAS and atomic rollback PASS.');
}
