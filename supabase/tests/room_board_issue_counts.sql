-- #416 final approved DB gate only. This file is not evidence of an executed test.
begin;
select plan(4);

-- Recover the pinned prior RPC as a transaction-local comparison function.
do $baseline$
declare
  source text;
  definition text;
begin
  select replace(prosrc, E'\r\n', E'\n'),
    replace(pg_get_functiondef(oid), E'\r\n', E'\n') into strict source, definition
  from pg_proc where oid = 'public.get_room_board_projection(uuid,uuid,date,uuid)'::regprocedure;
  definition := replace(definition, source,
    replace(replace(source,
      $new$      issue_counts.issue_count,
      issue_counts.blocking_issue_count,$new$,
      $old$      private.room_board_issue_count_at(room.id, v_evaluated_at, false) as issue_count,
      private.room_board_issue_count_at(room.id, v_evaluated_at, true) as blocking_issue_count,$old$),
      $new$  ) display_reservation
  cross join lateral (
    select count(*)::integer as issue_count,
      count(*) filter (where issue.blocks_guest_assignment)::integer as blocking_issue_count
    from public.room_issues issue
    where issue.room_id = room.id
      and issue.reported_at <= v_evaluated_at
      and (issue.resolved_at is null or issue.resolved_at > v_evaluated_at)
  ) issue_counts
  cross join lateral ($new$,
      $old$  ) display_reservation
  cross join lateral ($old$));
  definition := replace(definition, 'public.get_room_board_projection(', 'pg_temp.room_board_before(');
  execute definition;
  if (select md5(replace(prosrc, E'\r\n', E'\n')) from pg_proc
    where oid = 'pg_temp.room_board_before(uuid,uuid,date,uuid)'::regprocedure)
    <> 'dbcb3d36a8ee29447ca04854b6ad8909' then
    raise exception 'ISSUE_COUNTS_TEST_BASELINE_DRIFT';
  end if;
end;
$baseline$;

insert into auth.users(id) values ('b4160000-0000-4000-8000-000000000001');
insert into public.profiles(id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status, must_change_password)
values ('b4160000-0000-4000-8000-000000000002', 'b4160000-0000-4000-8000-000000000001',
  'issue count fixture', 'issue count fixture', 'issue count fixture', 'issue count fixture',
  0, 'admin', 'active', false);
insert into auth.sessions(id, user_id)
values ('b4160000-0000-4000-8000-000000000003', 'b4160000-0000-4000-8000-000000000001');
insert into public.rooms(id, room_number, room_type_id, elevator_zone)
select r.id, r.number, t.id, 'A' from public.room_types t cross join (values
  ('b4160000-0000-4000-8000-000000000004'::uuid, '981'),
  ('b4160000-0000-4000-8000-000000000005'::uuid, '982')) r(id, number)
where t.code = 'premium';

create temporary table issue_count_cutoff as
select ((statement_timestamp() at time zone 'Asia/Seoul')::date + 1)::timestamp
  at time zone 'Asia/Seoul' as at;
-- Exact report/resolution boundaries, future report, resolved-after-cutoff,
-- and both blocking and non-blocking rows. Room982 intentionally has none.
insert into public.room_issues(room_id, category, severity, blocks_guest_assignment,
  reported_by, reported_at, status, resolved_by, resolved_at, resolution_reason_code)
select 'b4160000-0000-4000-8000-000000000004', 'FACILITY', 'warning', sample.blocking,
  'b4160000-0000-4000-8000-000000000002', cutoff.at + sample.report_offset,
  case when sample.resolve_offset is null then 'open' else 'resolved' end,
  case when sample.resolve_offset is null then null else 'b4160000-0000-4000-8000-000000000002'::uuid end,
  cutoff.at + sample.resolve_offset,
  case when sample.resolve_offset is null then null else 'FIXTURE_RESOLVED' end
from issue_count_cutoff cutoff cross join (values
  (false, interval '-2 days', null::interval),
  (true, interval '-1 day', null::interval),
  (true, interval '0', null::interval),
  (false, interval '-2 days', interval '1 microsecond'),
  (true, interval '-2 days', interval '0'),
  (true, interval '-2 days', interval '-1 microsecond'),
  (true, interval '1 microsecond', null::interval)
) sample(blocking, report_offset, resolve_offset);

select is(private.room_board_issue_count_at('b4160000-0000-4000-8000-000000000004',
  (select at from issue_count_cutoff), false), 4, 'cutoff includes four unresolved-at-time issues');
select is(private.room_board_issue_count_at('b4160000-0000-4000-8000-000000000004',
  (select at from issue_count_cutoff), true), 2, 'cutoff includes two blocking issues');

-- Both functions execute in the same statement: statement_timestamp and all
-- 36 response fields are compared without masking the server/evaluation clock.
set local role service_role;
create temporary table issue_count_comparison as
select dates.day_offset, room.id, to_jsonb(candidate) as candidate, to_jsonb(baseline) as baseline
from (values (-2), (-1), (0), (1), (2)) dates(day_offset)
cross join (values ('b4160000-0000-4000-8000-000000000004'::uuid),
  ('b4160000-0000-4000-8000-000000000005'::uuid)) room(id)
cross join lateral public.get_room_board_projection(
  'b4160000-0000-4000-8000-000000000002', 'b4160000-0000-4000-8000-000000000003',
  (statement_timestamp() at time zone 'Asia/Seoul')::date + dates.day_offset, room.id) candidate
cross join lateral pg_temp.room_board_before(
  'b4160000-0000-4000-8000-000000000002', 'b4160000-0000-4000-8000-000000000003',
  (statement_timestamp() at time zone 'Asia/Seoul')::date + dates.day_offset, room.id) baseline;
select is((select count(*)::integer from issue_count_comparison), 10,
  'both empty and populated rooms survive all five service dates');
select is((select count(*)::integer from issue_count_comparison where candidate is distinct from baseline),
  0, 'complete room board response equals pinned baseline for past/live/future dates');
select * from finish();
rollback;
