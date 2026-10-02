import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { safeRpcResultSummary, waitForLocalPostgrestReady } from './lib/local-postgrest-test-readiness.mjs';

const id = (n) => `34300000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const cli = 'node_modules/supabase/dist/supabase.js';

function resetFreshDatabase() {
  execFileSync(process.execPath, [
    cli, 'db', 'reset', '--local', '--no-seed'
  ], { stdio: 'inherit' });
}

function localSupabaseStatus() {
  const status = JSON.parse(execFileSync(
    process.execPath,
    [cli, 'status', '--output', 'json'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  ));
  assert(['localhost', '127.0.0.1'].includes(new URL(status.API_URL).hostname),
    'Standalone complaint attention reset requires disposable local Supabase');
  return status;
}

function markedFixture() {
  const source = readFileSync('supabase/tests/complaint_response_attention.sql', 'utf8');
  const beginMarker = '-- BEGIN COMPLAINT RESPONSE ATTENTION UPGRADE FIXTURE';
  const endMarker = '-- END COMPLAINT RESPONSE ATTENTION UPGRADE FIXTURE';
  const begin = source.indexOf(beginMarker);
  const end = source.indexOf(endMarker);
  assert(begin >= 0 && end > begin, 'Complaint attention concurrency fixture markers must exist');
  const fixture = source.slice(begin + beginMarker.length, end)
    .split(/\r?\n/)
    .filter((line) => !/^\s*select\s+(?:no_plan\(\)|plan\([^;]*\)|(?:\*\s+from\s+)?finish\(\))\s*;\s*$/i.test(line))
    .join('\n');
  assert(fixture.includes('create function pg_temp.attention_case('),
    'Concurrency fixture must contain the source-controlled case helper');
  assert(fixture.includes('select pg_temp.attention_case(5);'),
    'Concurrency fixture must contain unanswered, corrected and answered orderings');
  assert(!/\b(?:no_plan|plan|finish)\s*\(/i.test(fixture),
    'Extracted fixture cannot execute TAP planning or finish statements');
  return fixture;
}

export async function testComplaintResponseAttentionConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname),
    'Complaint attention races require disposable local Supabase');
  const sql = (input) => execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000
  }).trim();
  const templateDigest = () => sql(`select coalesce(md5(string_agg(row_to_json(t)::text,'|' order by t.id)),'EMPTY')
    from public.cleaning_template_versions t where t.status='published';`);
  const publishedBefore = templateDigest();
  sql(`begin; ${markedFixture()}
    select pg_temp.attention_case(7);
    select pg_temp.attention_case(8,false,false);
    select pg_temp.attention_case(9,false,false);
    select pg_temp.attention_case(10,false,false);
    commit;`);
  assert.equal(templateDigest(), publishedBefore,
    'Attention fixture creates no published template that can collide with later retention fixtures');

  const caseId = (n) => sql(`select id from public.complaint_cases where original_earning_id='${id(50000 + n)}';`);
  const cases = Object.fromEntries([1, 2, 3, 4, 5, 7, 8, 9, 10].map((n) => [n, caseId(n)]));
  for (const value of Object.values(cases)) {
    assert.match(value, /^[0-9a-f-]{36}$/, 'Fixture must expose every complaint case identity');
  }
  const future = sql(`select (max(response_deadline)+interval '1 second')::text
    from public.complaint_cases where id in ('${cases[1]}','${cases[2]}','${cases[7]}');`);
  const schedulerArgs = (key, hash = 'f'.repeat(64), actor = id(1)) => ({
    p_actor_profile_id: actor,
    p_as_of: future,
    p_idempotency_key: key,
    p_request_hash: hash
  });
  const attentionSummary = () => JSON.parse(sql(`select json_build_object(
    'admins',(select count(*) from public.profiles
      where role='admin' and status='active' and not must_change_password),
    'events',(select count(*) from private.complaint_response_attention_events),
    'recipients',(select count(*) from private.complaint_response_attention_recipients),
    'notices',(select count(*) from public.notifications where event_family='complaint.response_attention_admin'),
    'deliveries',(select count(*) from private.notification_delivery_outbox where event_family='complaint.response_attention_admin'),
    'groups',(select count(*) from private.notification_groups where group_family='complaint_response_attention'),
    'cursor',(select last_case_id from private.complaint_response_attention_scan_cursor),
    'valid',not exists(select 1 from private.complaint_response_attention_events e
      join private.complaint_response_attention_recipients r on r.event_id=e.id
      left join public.notifications n on n.event_family='complaint.response_attention_admin'
        and n.source_entity_id=e.id::text and n.recipient_profile_id=r.recipient_profile_id
      left join private.notification_delivery_outbox o on o.notification_id=n.id
      where n.id is null or n.actor_profile_id<>e.actor_profile_id or n.requires_action
        or n.category<>'complaint_response_attention' or n.deep_link_kind<>'complaintCase'
        or n.deep_link_entity_id<>e.complaint_case_id or n.room_id<>e.room_id
        or n.cleaning_target_id<>e.cleaning_target_id
        or n.title<>'컴플레인 응답 지연 확인'
        or n.body<>'최초 판정에 대한 메이드 응답이 아직 없습니다. 사건 현황을 확인해 주세요.'
        or not exists(select 1 from public.profiles p where p.id=n.recipient_profile_id
          and p.role='admin' and p.status='active' and not p.must_change_password)
        or not private.notification_source_is_valid(n.event_family,n.actor_profile_id,
          n.recipient_profile_id,n.source_entity_id,n.room_id,n.cleaning_target_id,n.deep_link_entity_id)
        or ((r.push_expected and o.id is null) or (not r.push_expected and o.id is not null)))
  );`));

  const rollbackKey = `attention-rollback-${randomUUID()}`;
  const beforeFailure = attentionSummary();
  sql(`begin;
    create function pg_temp.attention_fail_outbox() returns trigger language plpgsql as $$
    begin
      if new.event_family='complaint.response_attention_admin' then
        raise exception using errcode='23514',message='ATTENTION_TEST_OUTBOX_FAILURE';
      end if;
      return new;
    end $$;
    create trigger attention_test_outbox_failure before insert on private.notification_delivery_outbox
      for each row execute function pg_temp.attention_fail_outbox();
    do $test$ begin
      perform public.process_due_assignment_lifecycle('${id(1)}','${future}'::timestamptz,
        '${rollbackKey}',repeat('f',64));
      raise exception using errcode='P0001',message='EXPECTED_ATTENTION_FAILURE';
    exception when check_violation then
      if sqlerrm<>'ATTENTION_TEST_OUTBOX_FAILURE' then raise; end if;
    end $test$;
    drop trigger attention_test_outbox_failure on private.notification_delivery_outbox;
    commit;`);
  assert.deepEqual(attentionSummary(), beforeFailure,
    'Outbox failure rolls back event, enrollment, notice, outbox, group and scan cursor together');
  assert.equal(sql(`select count(*) from private.command_executions where actor_profile_id='${id(1)}'
    and command_type='assignment.process_due_lifecycle' and idempotency_key='${rollbackKey}';`), '0',
  'Failed scheduler transaction cannot commit its receipt');

  const sameKey = await Promise.all(Array.from({ length: 8 }, () =>
    client.rpc('process_due_assignment_lifecycle', schedulerArgs(rollbackKey))));
  assert(sameKey.every((response) => !response.error),
    'Concurrent retry of the rolled-back scheduler key must succeed in every session');
  for (const response of sameKey) {
    assert.deepEqual(response.data, sameKey[0].data,
      'Concurrent same-key scheduler requests replay one exact receipt');
  }
  assert.equal(sameKey[0].data.complaintAttentionCount, 3,
    'One scheduler winner detects the three unanswered fixture cases');
  assert.equal(sql(`select count(*) from private.command_executions where actor_profile_id='${id(1)}'
    and command_type='assignment.process_due_lifecycle' and idempotency_key='${rollbackKey}';`), '1',
  'Concurrent same-key scheduler creates one receipt');
  const detectedState = attentionSummary();
  assert.equal(detectedState.events, 3, 'Exactly three initially unanswered cases create evidence');
  assert.equal(detectedState.recipients, 3 * detectedState.admins,
    'Each event enrolls every active password-complete business admin exactly once');
  assert.equal(detectedState.notices, 3 * detectedState.admins,
    'Each enrollment creates one inbox row');
  assert.equal(detectedState.deliveries, 3 * (detectedState.admins - 1),
    'Only the scheduler actor is excluded from each push fanout');
  assert.equal(detectedState.groups, 3 * detectedState.admins,
    'Distinct complaint rooms create one fixed group per event recipient');
  assert.equal(detectedState.valid, true,
    'Every attention row has safe UUID provenance, role, link, content and push shape');

  const repeated = await Promise.all(Array.from({ length: 4 }, () =>
    client.rpc('process_due_assignment_lifecycle', schedulerArgs(`attention-repeat-${randomUUID()}`, 'e'.repeat(64), id(3)))));
  assert(repeated.every((response) => !response.error && response.data.complaintAttentionCount === 0),
    'Repeated new keys and a different valid actor observe existing evidence without duplicating it');
  assert.deepEqual(attentionSummary(), detectedState,
    'Repeated detection preserves exact event, recipient, notice, outbox, group and cursor identities');

  const detectorFirstBefore = sql(`select row_to_json(e)::text
    from private.complaint_response_attention_events e where e.complaint_case_id='${cases[1]}';`);
  const responseRace = await Promise.all([
    client.rpc('respond_to_complaint', {
      p_actor_profile_id: id(2), p_complaint_id: cases[1], p_expected_version: 3,
      p_response_type: 'acknowledged', p_appeal_reason_code: null,
      p_idempotency_key: `attention-response-a-${randomUUID()}`, p_request_hash: 'a'.repeat(64)
    }),
    client.rpc('respond_to_complaint', {
      p_actor_profile_id: id(2), p_complaint_id: cases[1], p_expected_version: 3,
      p_response_type: 'appealed', p_appeal_reason_code: 'timeline_mismatch',
      p_idempotency_key: `attention-response-b-${randomUUID()}`, p_request_hash: 'b'.repeat(64)
    })
  ]);
  assert.equal(responseRace.filter((response) => !response.error).length, 1,
    'Two different response keys have exactly one version-CAS winner');
  const loser = responseRace.find((response) => response.error);
  assert.equal(loser?.error?.code, '40001', 'Response CAS loser reports STALE_VERSION');
  assert.equal(loser?.error?.message, 'STALE_VERSION', 'Response CAS loser preserves stable error message');
  assert.equal(sql(`select row_to_json(e)::text from private.complaint_response_attention_events e
    where e.complaint_case_id='${cases[1]}';`), detectorFirstBefore,
  'Detector-first event remains immutable after the valid late response');
  assert.equal(sql(`select d.decision_version from public.complaint_maid_responses r
    join public.complaint_decisions d on d.id=r.decision_id where r.complaint_case_id='${cases[1]}';`), '1',
  'Late response remains bound to the initial decision');
  assert.equal(sql(`select count(*) from private.complaint_response_attention_events
    where complaint_case_id in ('${cases[3]}','${cases[4]}','${cases[5]}');`), '0',
  'Response-first, terminal and appealed-before-detector cases never gain late attention evidence');

  const corrected = JSON.parse(sql(`select json_build_object(
    'initialVersion',initial.decision_version,'currentVersion',current.decision_version,
    'caseVersion',e.case_version,
    'thresholdPreserved',e.response_deadline=e.first_decided_at+interval '7 days'
  ) from private.complaint_response_attention_events e
    join public.complaint_decisions initial on initial.id=e.initial_decision_id
    join public.complaint_decisions current on current.id=e.current_decision_id
  where e.complaint_case_id='${cases[2]}';`));
  assert.deepEqual(corrected, {
    initialVersion: 1, currentVersion: 2, caseVersion: 4, thresholdPreserved: true
  }, 'Correction-before-detector preserves the initial threshold and typed initial/current decision snapshots');

  const decideCase = async (n) => {
    const reviewed = await client.rpc('start_complaint_review', {
      p_actor_profile_id: id(1), p_complaint_id: cases[n], p_expected_version: 1,
      p_idempotency_key: `attention-race-review-${n}-${randomUUID()}`, p_request_hash: 'c'.repeat(64)
    });
    assert.equal(reviewed.error, null, `Race case ${n} review must succeed through the public RPC`);
    const decided = await client.rpc('decide_complaint_case', {
      p_actor_profile_id: id(1), p_complaint_id: cases[n], p_expected_version: 2,
      p_finding: 'confirmed', p_penalty_score: 0, p_rework_required: false,
      p_idempotency_key: `attention-race-decide-${n}-${randomUUID()}`, p_request_hash: 'd'.repeat(64)
    });
    assert.equal(decided.error, null, `Race case ${n} decision must succeed through the public RPC`);
    return sql(`select (response_deadline+interval '1 second')::text
      from public.complaint_cases where id='${cases[n]}';`);
  };
  const raceResponse = (n) => client.rpc('respond_to_complaint', {
    p_actor_profile_id: id(2), p_complaint_id: cases[n], p_expected_version: 3,
    p_response_type: 'acknowledged', p_appeal_reason_code: null,
    p_idempotency_key: `attention-order-response-${n}-${randomUUID()}`, p_request_hash: '6'.repeat(64)
  });
  const raceDetection = (n, asOf) => client.rpc('process_due_assignment_lifecycle', {
    ...schedulerArgs(`attention-order-detect-${n}-${randomUUID()}`, '7'.repeat(64), id(1)),
    p_as_of: asOf
  });

  const detectorFirstAt = await decideCase(8);
  const detectorFirstRace = await Promise.all([
    raceDetection(8, detectorFirstAt),
    raceResponse(8)
  ]);
  assert(detectorFirstRace.every((response) => !response.error),
    'Detector-first launch and public maid response both serialize successfully');
  const responseFirstAt = await decideCase(9);
  const responseFirstRace = await Promise.all([
    raceResponse(9),
    raceDetection(9, responseFirstAt)
  ]);
  assert(responseFirstRace.every((response) => !response.error),
    'Response-first launch and public detector both serialize successfully');
  for (const n of [8, 9]) {
    const ordering = JSON.parse(sql(`select json_build_object(
      'responses',(select count(*) from public.complaint_maid_responses where complaint_case_id='${cases[n]}'),
      'events',(select count(*) from private.complaint_response_attention_events where complaint_case_id='${cases[n]}'),
      'initialBinding',(select d.decision_version=1 from public.complaint_maid_responses r
        join public.complaint_decisions d on d.id=r.decision_id where r.complaint_case_id='${cases[n]}')
    );`));
    assert.equal(ordering.responses, 1, `Ordering case ${n} keeps one actual response`);
    assert([0, 1].includes(ordering.events), `Ordering case ${n} has zero-or-one valid observation by lock order`);
    assert.equal(ordering.initialBinding, true, `Ordering case ${n} response remains bound to the initial decision`);
    const afterResponse = await client.rpc('process_due_assignment_lifecycle', {
      ...schedulerArgs(`attention-order-followup-${n}-${randomUUID()}`, '8'.repeat(64), id(1)),
      p_as_of: n === 8 ? detectorFirstAt : responseFirstAt
    });
    assert.equal(afterResponse.error, null, `Ordering case ${n} follow-up detector succeeds`);
    assert.equal(sql(`select count(*) from private.complaint_response_attention_events
      where complaint_case_id='${cases[n]}';`), String(ordering.events),
    `Ordering case ${n} cannot gain attention evidence after response`);
  }

  const correctionAt = await decideCase(10);
  const correctionRace = await Promise.all([
    client.rpc('correct_complaint_decision', {
      p_actor_profile_id: id(1), p_complaint_id: cases[10], p_expected_version: 3,
      p_finding: 'false', p_penalty_score: 0, p_rework_required: false,
      p_idempotency_key: `attention-correction-race-${randomUUID()}`, p_request_hash: '9'.repeat(64)
    }),
    raceDetection(10, correctionAt)
  ]);
  assert(correctionRace.every((response) => !response.error),
    'Correction and actual lifecycle detector serialize successfully in either lock order');
  const correctionObservation = JSON.parse(sql(`select json_build_object(
    'eventCount',count(e.id),'initialVersions',array_agg(initial.decision_version),
    'currentVersions',array_agg(current.decision_version),'caseVersions',array_agg(e.case_version),
    'thresholds',bool_and(e.response_deadline=e.first_decided_at+interval '7 days')
  ) from private.complaint_response_attention_events e
    join public.complaint_decisions initial on initial.id=e.initial_decision_id
    join public.complaint_decisions current on current.id=e.current_decision_id
  where e.complaint_case_id='${cases[10]}';`));
  assert.equal(correctionObservation.eventCount, 1,
    'Correction/detector race creates exactly one attention observation');
  assert.deepEqual(correctionObservation.initialVersions, [1],
    'Correction/detector race always binds the immutable initial decision');
  assert([1, 2].includes(correctionObservation.currentVersions[0]),
    'Observation freezes the valid current decision from whichever command won the lock');
  assert.equal(correctionObservation.caseVersions[0], correctionObservation.currentVersions[0] + 2,
    'Frozen case version matches the observed current-decision version');
  assert.equal(correctionObservation.thresholds, true,
    'Correction/detector race preserves the initial seven-day threshold');
  const correctedResponse = await client.rpc('respond_to_complaint', {
    p_actor_profile_id: id(2), p_complaint_id: cases[10], p_expected_version: 4,
    p_response_type: 'acknowledged', p_appeal_reason_code: null,
    p_idempotency_key: `attention-correction-response-${randomUUID()}`, p_request_hash: '1'.repeat(64)
  });
  assert.equal(correctedResponse.error, null,
    'Maid may respond to the initial decision after the correction/detector race');
  assert.equal(sql(`select d.decision_version from public.complaint_maid_responses r
    join public.complaint_decisions d on d.id=r.decision_id where r.complaint_case_id='${cases[10]}';`), '1',
  'Post-correction response remains bound to the initial decision');
  const correctionFollowup = await client.rpc('process_due_assignment_lifecycle', {
    ...schedulerArgs(`attention-correction-followup-${randomUUID()}`, '0'.repeat(64), id(1)),
    p_as_of: correctionAt
  });
  assert.equal(correctionFollowup.error, null, 'Post-correction detector follow-up succeeds');
  assert.equal(sql(`select count(*) from private.complaint_response_attention_events
    where complaint_case_id='${cases[10]}';`), '1',
  'Correction cannot reset the threshold or create a second event');
  assert.equal(attentionSummary().valid, true,
    'All race-order event sources, links, recipients and outbox shapes remain valid after responses and correction');
  assert.equal(templateDigest(), publishedBefore,
    'Normal fixture completion leaves the published template set byte-equivalent for later suites');
  console.log('Complaint response attention concurrency: rollback/retry, same-key receipt, dedupe/group fanout, response ordering and CAS PASS.');
}

async function runStandalone() {
  let phase = 'local-status';
  let resetStarted = false;
  let rpcSequence = 0;
  const rpcFailures = [];
  try {
    const status = localSupabaseStatus();
    phase = 'fresh-reset';
    resetStarted = true;
    resetFreshDatabase();
    phase = 'read-only-api-readiness';
    const ready = await waitForLocalPostgrestReady({
      apiUrl: status.API_URL, apiKey: status.SECRET_KEY
    });
    console.log(`Complaint attention read-only API readiness PASS: attempts=${ready.attempts}`);
    const client = createClient(status.API_URL, status.SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    const observedClient = {
      supabaseUrl: client.supabaseUrl,
      rpc: async (name, args) => {
        const sequence = ++rpcSequence;
        const rpc = ['process_due_assignment_lifecycle', 'respond_to_complaint',
          'start_complaint_review', 'decide_complaint_case', 'correct_complaint_decision']
          .includes(name) ? name : 'OTHER_RPC';
        try {
          const result = await client.rpc(name, args);
          if (result.error) {
            const summary = { sequence, rpc, ...safeRpcResultSummary(result) };
            rpcFailures.push(summary);
            console.error(`Complaint attention RPC result: ${JSON.stringify(summary)}`);
          }
          return result;
        } catch {
          const summary = { sequence, rpc, status: null, code: null };
          rpcFailures.push(summary);
          console.error(`Complaint attention RPC transport failure: ${JSON.stringify(summary)}`);
          // Let every concurrent call settle before the unchanged all-success assertion fails.
          return { data: null, error: { code: 'LOCAL_RPC_TRANSPORT_FAILURE',
            message: 'LOCAL_RPC_TRANSPORT_FAILURE' }, status: 0 };
        }
      }
    };
    phase = 'fixture-and-rpc-races';
    await testComplaintResponseAttentionConcurrency(observedClient);
  } catch (error) {
    // Never dump AssertionError.actual, RPC bodies, request arguments, or raw stack/messages.
    const sourceLine = error instanceof Error
      ? error.stack?.match(/test-complaint-response-attention-concurrency\.mjs:(\d+):\d+/)?.[1]
      : undefined;
    console.error(`Complaint attention validation FAIL: ${JSON.stringify({
      phase, kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
      sourceLine: sourceLine ? Number(sourceLine) : null, rpcFailures
    })}`);
    if (phase === 'read-only-api-readiness' && error?.summary) {
      console.error(`Complaint attention readiness result: ${JSON.stringify({
        ...safeRpcResultSummary({ status: error.summary.status,
          error: { code: error.summary.code } })
      })}`);
    }
    if (resetStarted) {
      try {
        const counts = execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
          'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
          input: `select json_build_array(
            (select count(*) from private.complaint_response_attention_events),
            (select count(*) from private.complaint_response_attention_recipients),
            (select count(*) from public.notifications where event_family='complaint.response_attention_admin'),
            (select count(*) from private.command_executions where command_type='assignment.process_due_lifecycle'));`,
          encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000
        }).trim();
        const parsed = JSON.parse(counts);
        if (!Array.isArray(parsed) || parsed.length !== 4 ||
            !parsed.every(value => Number.isSafeInteger(value) && value >= 0)) throw new Error('INVALID_COUNTS');
        console.error(`Complaint attention pre-cleanup counts: ${JSON.stringify(parsed)}`);
      } catch {
        console.error('Complaint attention pre-cleanup counts: UNAVAILABLE');
      }
    }
    process.exitCode = 1;
  } finally {
    if (resetStarted) {
      try { resetFreshDatabase(); } catch {
        console.error('Complaint attention cleanup FAIL');
        process.exitCode = 1;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runStandalone();
}
