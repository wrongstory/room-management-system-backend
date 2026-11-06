-- #616: read dates from the exact assignment revision. An ended revision never
-- inherits a later target rollover. The snapshot and the earnings ledger are immutable.
create function private.assignment_report_day(t public.cleaning_targets,a public.cleaning_assignments)
returns date language sql stable set search_path='' as $$
  select case when a.is_current then private.assignment_current_planning_date(t,a)
              else private.assignment_requested_planning_date(a) end
$$;
revoke all on function private.assignment_report_day(public.cleaning_targets,public.cleaning_assignments)
from public,anon,authenticated,service_role;

-- Apply only the reviewed date substitutions to the installed function bodies.
-- Preserve every other filter, output field, cursor tie-breaker, grant and function attribute.
do $dates$
declare patch record; oid_before oid; definition text; catalog_before jsonb;
begin
  for patch in select * from (values
    ('private.assignment_prestart_command_for_plan(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text,date)',
      'planning_day:=coalesce(p_planning_date,private.assignment_requested_planning_date(a));',
      'planning_day:=coalesce(p_planning_date,private.assignment_report_day(t,a));',1),
    ('private.assignment_prestart_command_for_plan_with_instruction(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text,date,text)',
      'planning_day:=coalesce(p_planning_date,private.assignment_requested_planning_date(a));',
      'planning_day:=coalesce(p_planning_date,private.assignment_report_day(t,a));',1),
    ('public.list_work_history(uuid,uuid,date,uuid,integer,uuid)', E'from public.cleaning_assignments assignment\n    join scoped_maids',
      E'from public.cleaning_assignments assignment\n    left join public.cleaning_targets target on target.id=assignment.cleaning_target_id\n    join scoped_maids',1),
    ('public.list_work_history(uuid,uuid,date,uuid,integer,uuid)', 'assignment.service_date as work_date',
      'private.assignment_report_day(target,assignment) as work_date',1),
    ('public.list_work_history(uuid,uuid,date,uuid,integer,uuid)', 'assignment.service_date between p_week_start and p_week_start + 6',
      'assignment.service_date <= p_week_start + 6 and private.assignment_report_day(target,assignment) between p_week_start and p_week_start + 6',1),
    ('private.project_payroll_cycle_bounded(date,uuid,integer)',
      'coalesce((a.field_completed_at at time zone ''Asia/Seoul'')::date,t.effective_service_date)',
      'coalesce((a.field_completed_at at time zone ''Asia/Seoul'')::date,private.assignment_report_day(t,assignment))',2),
    ('public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)',
      'coalesce((a.field_completed_at at time zone ''Asia/Seoul'')::date,t.effective_service_date)',
      'coalesce((a.field_completed_at at time zone ''Asia/Seoul'')::date,private.assignment_report_day(t,assignment))',3)
  ) changes(signature,old_text,new_text,expected) loop
    oid_before:=patch.signature::regprocedure;
    select replace(pg_get_functiondef(p.oid),E'\r\n',E'\n'),to_jsonb(p)-'prosrc'
      into strict definition,catalog_before from pg_proc p where p.oid=oid_before;
    if (length(definition)-length(replace(definition,patch.old_text,'')))/length(patch.old_text)<>patch.expected then
      raise exception 'ASSIGNMENT_REPORT_DATE_SOURCE_DRIFT: %',patch.signature;
    end if;
    execute replace(definition,patch.old_text,patch.new_text);
    if (select to_jsonb(p)-'prosrc' from pg_proc p where p.oid=oid_before) is distinct from catalog_before then
      raise exception 'ASSIGNMENT_REPORT_DATE_CATALOG_DRIFT';
    end if;
  end loop;
end $dates$;

create function public.list_assignment_rows_for_planning_date(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_actor_role text,p_date date,
  p_maid_profile_id uuid,p_include_history boolean
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles; result jsonb;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  if actor.id is null or actor.status<>'active' or actor.role not in ('admin','maid')
    or actor.role::text is distinct from p_expected_actor_role or
    (actor.role='maid' and p_maid_profile_id is not null and p_maid_profile_id<>actor.id) then
    raise exception using errcode='42501',message='ASSIGNMENT_ACCESS_REQUIRED';
  end if;
  perform private.assert_attempt_actor_session(actor.id,p_session_id,actor.role='admin');
  if p_date is null or not isfinite(p_date) or p_include_history is null then
    raise exception using errcode='22023',message='ASSIGNMENT_DATE_INVALID';
  end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.sequence_number,s.revision,s.id),'[]'::jsonb) into result
  from (
    select a.id,a.cleaning_target_id,a.maid_profile_id,a.service_date,a.sequence_number,a.revision,
      a.is_current,a.available_from_snapshot,a.due_at_snapshot,a.notified_at,a.notified_room_id_snapshot,
      a.notified_room_number_snapshot,a.ended_at,a.created_at,a.instruction_memo
    from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
    where (p_include_history or a.is_current) and a.service_date<=p_date
      and (actor.role='admin' or (a.maid_profile_id=actor.id and a.notified_at is not null))
      and (p_maid_profile_id is null or a.maid_profile_id=p_maid_profile_id)
      and private.assignment_report_day(t,a)=p_date
    order by a.sequence_number,a.revision,a.id limit 1001
  ) s;
  if jsonb_array_length(result)>1000 then raise exception using errcode='54000',message='ASSIGNMENT_QUERY_LIMIT'; end if;
  return result;
end $$;
revoke all on function public.list_assignment_rows_for_planning_date(uuid,uuid,text,date,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.list_assignment_rows_for_planning_date(uuid,uuid,text,date,uuid,boolean) to service_role;

-- A notified task protects availability on its planned day, including after a
-- change. Checking the original service date as well would pin the wrong week.
create or replace function private.prevent_notified_assignment_unavailability()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if not new.available and exists (
    select 1 from public.availability_versions version
    join public.cleaning_assignments assignment on assignment.maid_profile_id=version.maid_profile_id
      and assignment.is_current and assignment.notified_at is not null
    join public.cleaning_targets target on target.id=assignment.cleaning_target_id and target.status='notified'
    where version.id=new.availability_version_id and version.is_current and version.status='submitted'
      and private.assignment_report_day(target,assignment)=new.work_date
  ) then raise exception using errcode='40001',message='ASSIGNMENT_AVAILABILITY_STALE'; end if;
  return new;
end $$;
