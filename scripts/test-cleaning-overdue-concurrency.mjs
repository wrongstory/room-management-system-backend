import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

function assert(value, message) {
  if (!value) throw new Error(message);
}

export async function testCleaningOverdueConcurrency(client, actorProfileId) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname),
    'overdue race requires synthetic local Supabase');
  const sql = (input) => execFileSync('docker', [
    'exec', '-i', 'supabase_db_room-management-system-backend',
    'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'
  ], { input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
  const targetId = randomUUID();
  const recipientId = randomUUID();
  const authId = randomUUID();
  const asOf = new Date().toISOString();
  const date = new Date(Date.parse(asOf) + 9 * 3_600_000 - 86_400_000).toISOString().slice(0, 10);
  sql(`insert into auth.users(id) values('${authId}');
    insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
      login_id,login_id_normalized,login_sequence,role,status,must_change_password)
    values('${recipientId}','${authId}','overdue-admin','overdue-admin',
      'overdue-${recipientId}','overdue-${recipientId}',0,'admin','active',false);
    insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
      original_service_date,effective_service_date,available_from,due_at,status,
      room_type_snapshot,fee_snapshot,template_snapshot,created_by)
    values('${targetId}',(select id from public.rooms order by id limit 1),'additional',
      'manual_room_request','overdue-race-${targetId}','${date}','${date}',
      '${asOf}'::timestamptz-interval '2 days','${asOf}'::timestamptz-interval '1 day',
      'unassigned','{}',0,'{}','${actorProfileId}');`);
  const snapshot = () => sql(`select row_to_json(t)::text from public.cleaning_targets t where id='${targetId}'`);
  const before = snapshot();
  const keys = Array.from({ length: 8 }, () => `overdue-race-${randomUUID()}`);
  const results = await Promise.all(keys.map((key) => client.rpc('process_due_assignment_lifecycle', {
    p_actor_profile_id: actorProfileId,
    p_as_of: asOf,
    p_idempotency_key: key,
    p_request_hash: 'a'.repeat(64)
  })));
  assert(results.every((r) => !r.error && Number.isInteger(r.data?.overdueCount)),
    'parallel overdue scheduler commands must succeed with bounded integer results');
  assert(snapshot() === before, 'overdue scan must not modify target, owner, date, fee or version');
  const summary = JSON.parse(sql(`select json_build_object(
    'events',(select count(*) from private.cleaning_overdue_events where cleaning_target_id='${targetId}'),
    'enrollments',count(r.recipient_profile_id),'notices',count(n.id),'deliveries',count(o.id),
    'activeAdmins',(select count(*) from public.profiles where role='admin' and status='active' and not must_change_password),
    'actorNotices',count(n.id) filter(where n.recipient_profile_id='${actorProfileId}'),
    'actorDeliveries',count(o.id) filter(where n.recipient_profile_id='${actorProfileId}'),
    'recipientNotices',count(n.id) filter(where n.recipient_profile_id='${recipientId}'),
    'recipientDeliveries',count(o.id) filter(where n.recipient_profile_id='${recipientId}'),
    'dedupe',count(distinct n.dedupe_key),
    'noticeIds',coalesce(json_agg(n.id order by n.id),'[]'::json))
    from private.cleaning_overdue_events e
    join private.cleaning_overdue_recipients r on r.event_id=e.id
    left join public.notifications n on n.event_family='cleaning.overdue_admin'
      and n.source_entity_id=e.id::text and n.recipient_profile_id=r.recipient_profile_id
    left join private.notification_delivery_outbox o on o.notification_id=n.id
    where e.cleaning_target_id='${targetId}'`));
  assert(summary.events === 1 && summary.enrollments === summary.activeAdmins &&
    summary.notices === summary.activeAdmins && summary.deliveries === summary.activeAdmins - 1,
  'parallel scan must converge to one event and exactly one inbox/outbox per eligible non-self admin');
  assert(summary.actorNotices === 1 && summary.actorDeliveries === 0 &&
    summary.recipientNotices === 1 && summary.recipientDeliveries === 1,
  'self inbox is preserved and only self push is suppressed');
  const replay = await client.rpc('process_due_assignment_lifecycle', {
    p_actor_profile_id: actorProfileId, p_as_of: asOf,
    p_idempotency_key: keys[0], p_request_hash: 'a'.repeat(64)
  });
  assert(!replay.error && JSON.stringify(replay.data) === JSON.stringify(results[0].data),
    'completed scheduler receipt must replay exactly');
  const noticeIds = sql(`select coalesce(json_agg(id order by id),'[]'::json)::text
    from public.notifications where event_family='cleaning.overdue_admin' and cleaning_target_id='${targetId}'`);
  assert(JSON.stringify(JSON.parse(noticeIds)) === JSON.stringify(summary.noticeIds),
    'receipt replay must preserve every notification identity');
  const raw = await client.from('cleaning_overdue_events').select('*');
  assert(raw.error, 'private overdue evidence is not exposed through the public Data API');
  const maidId = randomUUID();
  const maidAuthId = randomUUID();
  // First forward-page candidate even after other domain fixtures accumulate.
  const raceTarget = `00000000-0000-4000-8000-${randomUUID().slice(-12)}`;
  const assignmentId = randomUUID();
  const attemptId = randomUUID();
  sql(`insert into auth.users(id) values('${maidAuthId}');
    insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
      login_id,login_id_normalized,login_sequence,role,status,must_change_password)
    values('${maidId}','${maidAuthId}','overdue-maid','overdue-maid',
      'overdue-${maidId}','overdue-${maidId}',0,'maid','active',false);
    insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
      original_service_date,effective_service_date,available_from,due_at,status,assignment_version,
      room_type_snapshot,fee_snapshot,template_snapshot,created_by)
    values('${raceTarget}',(select id from public.rooms order by id offset 100 limit 1),'additional',
      'manual_room_request','overdue-complete-race-${raceTarget}','${date}','${date}',
      '${asOf}'::timestamptz-interval '2 days','${asOf}'::timestamptz-interval '1 day',
      'in_progress',1,'{}',0,'{}','${actorProfileId}');
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,
      sequence_number,revision,notified_at,changed_by)
    values('${assignmentId}','${raceTarget}','${maidId}',1,1,'${asOf}'::timestamptz-interval '2 days','${actorProfileId}');
    insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
      attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at)
    select '${attemptId}',id,'${assignmentId}','${maidId}',1,'in_progress',1,'{}',
      jsonb_build_object('roomId',room_id),'${asOf}'::timestamptz-interval '2 hours'
    from public.cleaning_targets where id='${raceTarget}';
    update private.cleaning_overdue_scan_cursor
    set last_target_id='00000000-0000-4000-8000-000000000000' where singleton;`);
  const completionKey = `overdue-complete-${randomUUID()}`;
  const [detection, completion] = await Promise.all([
    client.rpc('process_due_assignment_lifecycle', {
      p_actor_profile_id: actorProfileId, p_as_of: asOf,
      p_idempotency_key: `overdue-detect-${randomUUID()}`, p_request_hash: 'b'.repeat(64)
    }),
    client.rpc('complete_cleaning_attempt_field_work', {
      p_actor_profile_id: maidId, p_attempt_id: attemptId, p_expected_execution_version: 1,
      p_expected_assignment_id: assignmentId, p_expected_assignment_revision: 1,
      p_idempotency_key: completionKey, p_request_hash: 'c'.repeat(64)
    })
  ]);
  assert(!detection.error && !completion.error,
    `detection/physical completion must both serialize successfully: ${detection.error?.code ?? 'ok'}/${completion.error?.code ?? 'ok'}`);
  const raceSummary = JSON.parse(sql(`select json_build_object(
    'events',(select count(*) from private.cleaning_overdue_events where cleaning_target_id='${raceTarget}'),
    'status',a.status,'maid',a.maid_profile_id,'assignment',a.assignment_id,
    'completed',a.field_completed_at is not null,'attempts',(select count(*) from public.cleaning_attempts where cleaning_target_id='${raceTarget}'))
    from public.cleaning_attempts a where a.id='${attemptId}'`));
  assert([0, 1].includes(raceSummary.events) && raceSummary.status === 'field_completed' &&
    raceSummary.maid === maidId && raceSummary.assignment === assignmentId && raceSummary.completed && raceSummary.attempts === 1,
  'either valid race order must preserve physical completion, ownership and one attempt; overdue is observation only');
  const followup = await client.rpc('process_due_assignment_lifecycle', {
    p_actor_profile_id: actorProfileId, p_as_of: asOf,
    p_idempotency_key: `overdue-after-${randomUUID()}`, p_request_hash: 'd'.repeat(64)
  });
  assert(!followup.error && Number(sql(`select count(*) from private.cleaning_overdue_events where cleaning_target_id='${raceTarget}'`)) === raceSummary.events,
    'completed work must never gain new overdue evidence on a later scan');
  console.log('Cleaning overdue concurrency passed: 8 actual RPC sessions, one immutable target event, exact admin fanout, self-push suppression, original business rows and response replay preserved.');
  console.log('Cleaning overdue/physical completion race passed: both commands complete, original ownership/attempt retained, zero or one historical observation, no post-completion event.');
}
