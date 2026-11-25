-- #620. Use the actual business commands and capture the transaction-local
-- publish boundary. The separately approved live socket check covers WAL
-- delivery and the managed Realtime service.
begin;
select no_plan();

create temp table captured_live_updates(topic text not null, payload jsonb not null);
create or replace function private.publish_live_update(p_payload jsonb, p_topic text)
returns void language plpgsql set search_path = ''
as $$
begin
  insert into pg_temp.captured_live_updates(topic, payload) values (p_topic, p_payload);
end;
$$;

create function pg_temp.live_id(n integer) returns uuid language sql immutable as $$
  select ('62000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

create function pg_temp.live_day() returns date language sql stable as $$
  select (transaction_timestamp() at time zone 'Asia/Seoul')::date+1
$$;

insert into auth.users(id)
select pg_temp.live_id(100+n) from generate_series(1,6) n;
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id, login_id_normalized,
  login_sequence, role, status, must_change_password
)
select pg_temp.live_id(n), pg_temp.live_id(100+n), 'live-update-fixture-'||n, 'live-update-fixture-'||n,
  'live-update-fixture-'||n, 'live-update-fixture-'||n, 0,
  (case when n=1 then 'admin' else 'maid' end)::public.app_role,
  (case when n=6 then 'inactive' else 'active' end)::public.account_status, n=5
from generate_series(1,6) n;
insert into auth.sessions(id, user_id, not_after)
select pg_temp.live_id(200+n), pg_temp.live_id(100+n), clock_timestamp()+interval '1 hour'
from generate_series(1,6) n;
insert into auth.sessions(id, user_id, not_after) values
  (pg_temp.live_id(207), pg_temp.live_id(102), clock_timestamp()+interval '1 hour'),
  (pg_temp.live_id(208), pg_temp.live_id(102), clock_timestamp()-interval '1 hour');

-- Derive the topic exactly as the signed-in frontend does.
create function pg_temp.topic(n integer) returns text language sql immutable as $$
  select 'rms-updates-v1:' || encode(sha256(convert_to(pg_temp.live_id(n)::text, 'UTF8')), 'hex')
$$;
create function pg_temp.live_claim(p_user integer, p_session text) returns text language sql as $$
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', pg_temp.live_id(p_user), 'role', 'authenticated', 'session_id', p_session
  )::text, true)
$$;

select ok(not has_function_privilege('anon', 'private.can_receive_live_updates(text)', 'EXECUTE'),
  'anonymous requests have no receiver authorization grant');
select ok(not has_function_privilege(role, 'private.publish_live_update(jsonb,text)', 'EXECUTE')
    and not has_function_privilege(role, 'private.send_live_update(uuid,text,uuid)', 'EXECUTE'),
  role || ' cannot invoke the publisher')
from unnest(array['anon','authenticated','service_role']) role;
select ok(not has_table_privilege('authenticated', 'public.notifications', 'SELECT'),
  'raw notification contents stay behind the existing API');

set local role authenticated;
select pg_temp.live_claim(102, pg_temp.live_id(202)::text);
select ok(private.can_receive_live_updates(pg_temp.topic(202)), 'A can join the exact current session topic');
select ok(not private.can_receive_live_updates(pg_temp.topic(203)), 'A cannot join the B topic');
select ok(not private.can_receive_live_updates(pg_temp.topic(207)), 'a different session for A gets its own topic');
select pg_temp.live_claim(103, pg_temp.live_id(202)::text);
select ok(not private.can_receive_live_updates(pg_temp.topic(202)), 'session ownership is checked even for an exact topic');
select pg_temp.live_claim(102, pg_temp.live_id(208)::text);
select ok(not private.can_receive_live_updates(pg_temp.topic(208)), 'hard-expired session denied');
select pg_temp.live_claim(102, 'malformed');
select ok(not private.can_receive_live_updates(pg_temp.topic(202)), 'malformed claim denied without throwing');
select pg_temp.live_claim(105, pg_temp.live_id(205)::text);
select ok(not private.can_receive_live_updates(pg_temp.topic(205)), 'temporary-password account denied');
select pg_temp.live_claim(106, pg_temp.live_id(206)::text);
select ok(not private.can_receive_live_updates(pg_temp.topic(206)), 'inactive account denied');
select pg_temp.live_claim(101, pg_temp.live_id(201)::text);
select ok(private.can_receive_live_updates(pg_temp.topic(201)), 'admin can join their own inbox topic');
reset role;
select set_config('request.jwt.claims', '{}', true);

insert into public.availability_versions(maid_profile_id, week_start, version, submitted_at)
select pg_temp.live_id(n), pg_temp.live_day()-(extract(isodow from pg_temp.live_day())::integer-1), 1, now()
from generate_series(2,3) n;
insert into public.availability_days(availability_version_id, work_date, available)
select v.id, v.week_start+d, true from public.availability_versions v cross join generate_series(0,6) d
where v.maid_profile_id in (pg_temp.live_id(2),pg_temp.live_id(3));
insert into public.cleaning_targets(
  id, room_id, cleaning_kind, source, source_key, original_service_date, effective_service_date,
  available_from, due_at, status, room_type_snapshot, fee_snapshot, template_snapshot, created_by
)
select pg_temp.live_id(301), id, 'additional', 'manual_room_request', 'live-update-fixture',
  pg_temp.live_day(), pg_temp.live_day(), pg_temp.live_day()::timestamp at time zone 'Asia/Seoul',
  (pg_temp.live_day()+1)::timestamp at time zone 'Asia/Seoul'-interval '1 second',
  'unassigned', '{}', 10000, '{"durationMinutes":60}', pg_temp.live_id(1)
from public.rooms order by room_number limit 1;

select public.save_cleaning_assignment_draft_with_instruction(
  pg_temp.live_id(1), pg_temp.live_id(301), pg_temp.live_id(2), 1, 1,
  'live-update-draft', repeat('a',64), '수건 두 장'
);
select is((select count(*) from captured_live_updates), 0::bigint,
  'saving a draft does not wake any maid session');

create temp table live_impact as
select public.get_assignment_commit_impact(pg_temp.live_id(1), pg_temp.live_day()) as value;
select public.commit_and_notify_assignments(
  pg_temp.live_id(1), pg_temp.live_day(), value->>'impactFingerprint',
  (select jsonb_agg(jsonb_build_object(
    'cleaningTargetId', item->>'cleaningTargetId',
    'expectedAssignmentVersion', (item->>'targetAssignmentVersion')::bigint,
    'expectedAvailabilityVersion', (item->>'expectedAvailabilityVersion')::bigint
  )) from jsonb_array_elements(value->'committableDrafts') item
  where item->>'cleaningTargetId'=pg_temp.live_id(301)::text),
  'live-update-notify', repeat('b',64)
) from live_impact;

select is((select count(*) from captured_live_updates
    where payload->'changed'='["assignments"]'::jsonb
      and topic in (pg_temp.topic(202),pg_temp.topic(207))), 2::bigint,
  'a committed assignment wakes both live sessions for the assigned maid');
select is((select count(*) from captured_live_updates
    where payload->'changed'='["notifications"]'::jsonb and payload ? 'notificationId'
      and topic in (pg_temp.topic(202),pg_temp.topic(207))), 2::bigint,
  'each live session gets the same new notification identity for sound deduplication');
select is((select count(distinct payload->>'notificationId') from captured_live_updates
    where payload ? 'notificationId'), 1::bigint, 'one new inbox notification across two sessions');
select ok(not exists(select 1 from captured_live_updates
    where topic not in (pg_temp.topic(202),pg_temp.topic(207))),
  'admin, other maid and expired session get no signal for A');
select ok(not exists(select 1 from captured_live_updates
    where payload->'version' <> '1'::jsonb or not (payload ? 'eventId') or
      payload - array['version','eventId','changed','notificationId'] <> '{}'::jsonb),
  'payload contains only the public invalidation contract');

create temp table notice_to_read as
select id from public.notifications
where recipient_profile_id=pg_temp.live_id(2) and cleaning_target_id=pg_temp.live_id(301)
order by occurred_at desc, id limit 1;
truncate captured_live_updates;
select public.mark_notification_read(pg_temp.live_id(2), pg_temp.live_id(202), id) from notice_to_read;
select public.mark_notification_read(pg_temp.live_id(2), pg_temp.live_id(202), id) from notice_to_read;
select is((select count(*) from captured_live_updates), 2::bigint,
  'read followed by a retry broadcasts only once per live session');
select ok(not exists(select 1 from captured_live_updates
  where payload->'changed'<>'["notifications"]'::jsonb or payload ? 'notificationId'),
  'read receipts refresh the badge without a new-alert sound identity');

delete from auth.sessions where id=pg_temp.live_id(207);
set local role authenticated;
select pg_temp.live_claim(102, pg_temp.live_id(207)::text);
select ok(not private.can_receive_live_updates(pg_temp.topic(207)), 'revoked session cannot rejoin');
reset role;
select set_config('request.jwt.claims', '{}', true);

create function pg_temp.change_live_assignment(p_recipient integer, p_key text, p_memo text)
returns jsonb language sql as $$
  select public.change_cleaning_assignment_for_plan_with_instruction(
    pg_temp.live_id(1), a.cleaning_target_id, a.id, a.revision, pg_temp.live_id(p_recipient),
    a.sequence_number, 'OPERATIONAL_CHANGE', p_key, encode(sha256(convert_to(p_key,'UTF8')),'hex'),
    pg_temp.live_day(), p_memo, null, null
  ) from public.cleaning_assignments a where a.cleaning_target_id=pg_temp.live_id(301) and a.is_current
$$;

truncate captured_live_updates;
savepoint simulated_rollback;
select pg_temp.change_live_assignment(2,'live-update-aborted','저장 취소');
rollback to simulated_rollback;
select is((select count(*) from captured_live_updates), 0::bigint, 'rolled back memo produces no observable publish row');
select is((select instruction_memo from public.cleaning_assignments
    where cleaning_target_id=pg_temp.live_id(301) and is_current), '수건 두 장',
  'the rolled back command keeps the previous visible memo');

select pg_temp.change_live_assignment(2,'live-update-memo','수건 세 장');
select ok(exists(select 1 from captured_live_updates
    where payload->'changed'='["assignments"]'::jsonb and topic=pg_temp.topic(202)),
  'a notified memo-only revision wakes the current maid');
select ok(not exists(select 1 from captured_live_updates where topic<>pg_temp.topic(202)),
  'memo update sends nothing to the revoked session or any other profile');

truncate captured_live_updates;
select pg_temp.change_live_assignment(3,'live-update-reassign','수건 세 장');
select is((select count(distinct topic) from captured_live_updates
    where payload->'changed'='["assignments"]'::jsonb), 2::bigint,
  'both the prior and replacement maid receive assignment invalidation');
select ok(not exists(select 1 from captured_live_updates
    where topic not in (pg_temp.topic(202),pg_temp.topic(203))),
  'the reassignment cannot wake either unrelated maid sessions or a revoked one');

truncate captured_live_updates;
select public.unassign_cleaning_assignment_prestart(
  pg_temp.live_id(1), a.cleaning_target_id, a.id, a.revision,
  'OPERATIONAL_CHANGE', 'live-update-unassign', repeat('c',64)
) from public.cleaning_assignments a where a.cleaning_target_id=pg_temp.live_id(301) and a.is_current;
select ok(exists(select 1 from captured_live_updates
    where payload->'changed'='["assignments"]'::jsonb and topic=pg_temp.topic(203)),
  'unassign signals the last notified maid even without a replacement');
select ok(not exists(select 1 from captured_live_updates where topic<>pg_temp.topic(203)),
  'unassign and notice resolution wake only the last notified recipient');

select * from finish();
rollback;
