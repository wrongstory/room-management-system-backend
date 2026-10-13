-- #446: requested planning day selects availability; immutable work dates remain unchanged.
-- Source only until explicit approval of local/CI/production migration execution.
-- Exact immutable notification evidence carries the requested day independently
-- of the original work schedule. No historical assignment rows are rewritten.
create function private.assignment_requested_planning_date(p_assignment public.cleaning_assignments)
returns date language sql stable security definer set search_path='' as $$
  with recursive lineage(item) as (
    select p_assignment
    union all
    select predecessor from lineage
    join public.cleaning_assignments predecessor
      on predecessor.cleaning_target_id=(lineage.item).cleaning_target_id
      and predecessor.revision=(lineage.item).revision-1
      and predecessor.maid_profile_id=(lineage.item).maid_profile_id
      and predecessor.sequence_number=(lineage.item).sequence_number
      and predecessor.ended_at is not null and not predecessor.is_current
      and predecessor.notified_at is not null and (lineage.item).notified_at is not null
    join public.cleaning_target_schedule_revisions schedule
      on schedule.cleaning_target_id=(lineage.item).cleaning_target_id
      and schedule.revision=(lineage.item).revision
      and schedule.effective_service_date=(lineage.item).service_date
      and schedule.available_from is not distinct from (lineage.item).available_from_snapshot
      and schedule.due_at is not distinct from (lineage.item).due_at_snapshot
    where (predecessor.change_reason_code='MANUAL_CHECKOUT_RESCHEDULE' and schedule.reason_code='MANUAL_CHECKOUT')
      or (predecessor.change_reason_code='RESERVATION_SCHEDULE_CHANGED' and schedule.reason_code='RESERVATION_SCHEDULE_CHANGED')
  )
  select greatest(p_assignment.service_date,coalesce((select coalesce(audit.after_state->>'planningDate',audit.after_state->>'serviceDate')::date
    from lineage join public.cleaning_assignments predecessor on predecessor.id=(lineage.item).id
    join public.audit_events audit on audit.entity_id=predecessor.id
    where (audit.event_type='assignment.notified' or
      (audit.event_type='assignment.prestart_changed' and audit.after_state ? 'planningDate'))
      and audit.entity_type='cleaning_assignment'
      and audit.after_state->>'assignmentId'=predecessor.id::text
      and audit.after_state->>'cleaningTargetId'=predecessor.cleaning_target_id::text
      and audit.after_state->>'maidProfileId'=predecessor.maid_profile_id::text
      and audit.after_state->>'revision'=predecessor.revision::text
    order by predecessor.revision desc,audit.recorded_at desc,audit.id desc limit 1),p_assignment.service_date))
$$;
revoke all on function private.assignment_requested_planning_date(public.cleaning_assignments)
from public,anon,authenticated,service_role;

create index audit_assignment_planning_changed_idx on public.audit_events(entity_id)
where event_type='assignment.prestart_changed' and entity_type='cleaning_assignment';

do $planning$
declare
  patch record;
  function_oid oid;
  definition text;
  before_catalog jsonb;
  after_catalog jsonb;
begin
  for patch in select * from (values
    ('private.assignment_planning_includes_date(date,date,timestamptz)',
      $old$p_planning_date=(p_command_at at time zone 'Asia/Seoul')::date$old$,
      $new$p_planning_date in ((p_command_at at time zone 'Asia/Seoul')::date,
        (p_command_at at time zone 'Asia/Seoul')::date+1)$new$),
    ('private.assignment_preview_snapshot_at(uuid,date,timestamptz)',
      $old$p_service_date=v_today and target.effective_service_date<v_today$old$,
      $new$p_service_date in (v_today,v_today+1) and target.effective_service_date<p_service_date$new$),
    ('private.assignment_preview_snapshot_at(uuid,date,timestamptz)',
      $old$p_service_date=v_today and t.effective_service_date<v_today$old$,
      $new$p_service_date in (v_today,v_today+1) and t.effective_service_date<p_service_date$new$),
    ('private.activation_reason_at(public.cleaning_targets,public.cleaning_assignments,timestamptz)',
      $old$  reason:=private.activation_reason_at_before_stay_segments(p_target,p_assignment,p_command_at);$old$,
      $new$  if private.assignment_requested_planning_date(p_assignment)>(p_command_at at time zone 'Asia/Seoul')::date then
    return 'CLEANING_SERVICE_DATE_NOT_DUE';
  end if;
  reason:=private.activation_reason_at_before_stay_segments(p_target,p_assignment,p_command_at);$new$),
    ('private.prevent_notified_assignment_unavailability()',
      $old$assignment.service_date=new.work_date$old$,
      $new$assignment.service_date=new.work_date
        or private.assignment_requested_planning_date(assignment)=new.work_date$new$)
  ) changes(signature, old_text, new_text) loop
    function_oid := to_regprocedure(patch.signature);
    if function_oid is null then raise exception 'ASSIGNMENT_PLANNING_FUNCTION_MISSING'; end if;
    select replace(pg_get_functiondef(p.oid), E'\r\n', E'\n'), to_jsonb(p)-'prosrc'
      into strict definition, before_catalog from pg_proc p where p.oid=function_oid;
    if (length(definition)-length(replace(definition,patch.old_text,'')))/length(patch.old_text)<>1 then
      raise exception 'ASSIGNMENT_PLANNING_SOURCE_DRIFT';
    end if;
    execute replace(definition,patch.old_text,patch.new_text);
    select to_jsonb(p)-'prosrc' into strict after_catalog from pg_proc p where p.oid=function_oid;
    if after_catalog is distinct from before_catalog then
      raise exception 'ASSIGNMENT_PLANNING_CATALOG_DRIFT';
    end if;
  end loop;
end;
$planning$;

-- Keep the legacy strict response unchanged during DB-first rolling deployment.
do $read_contract$
declare definition text; original text:=$old$'scheduleSnapshot',private.assignment_schedule_public_snapshot(snapshot),'currentDeparture',current_departure)$old$;
begin
  definition:=replace(pg_get_functiondef('public.get_assignment_schedule_read(uuid,uuid,uuid[],boolean,text)'::regprocedure),E'\r\n',E'\n');
  if (length(definition)-length(replace(definition,original,'')))/length(original)<>1 then
    raise exception 'ASSIGNMENT_PLANNING_READ_SOURCE_DRIFT';
  end if;
  definition:=replace(definition,'public.get_assignment_schedule_read(', 'public.get_assignment_schedule_read_for_plan(');
  execute replace(definition,original,$new$'scheduleSnapshot',private.assignment_schedule_public_snapshot(snapshot),'currentDeparture',current_departure,
    'planningDate',private.assignment_requested_planning_date(assignment))$new$);
end $read_contract$;
revoke all on function public.get_assignment_schedule_read_for_plan(uuid,uuid,uuid[],boolean,text)
from public,anon,authenticated,service_role;
grant execute on function public.get_assignment_schedule_read_for_plan(uuid,uuid,uuid[],boolean,text) to service_role;

-- Keep every existing fresh-actor, receipt, lock, source, CAS and notification
-- check from the deployed helper. Only the availability day and explicit safe
-- audit field vary; the immutable work-date snapshots do not.
do $prestart$
declare source text; original_source text; original_definition text; args text; patch record; signature text;
begin
  signature:='private.assignment_prestart_command(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text)';
  select replace(prosrc,E'\r\n',E'\n'),pg_get_function_arguments(oid) into strict source,args
    from pg_proc where oid=signature::regprocedure;
  original_source:=source;
  original_definition:=replace(pg_get_functiondef(signature::regprocedure),E'\r\n',E'\n');
  for patch in select * from (values
    ('  wk date; admin_row record;', '  wk date; planning_day date; admin_row record;'),
    ('    wk:=t.effective_service_date-(extract(isodow from t.effective_service_date)::integer-1);',
     $new$    planning_day:=coalesce(p_planning_date,private.assignment_requested_planning_date(a));
    if p_planning_date is not null and (not isfinite(p_planning_date)
      or p_planning_date not in ((v_now at time zone 'Asia/Seoul')::date,(v_now at time zone 'Asia/Seoul')::date+1)
      or p_planning_date<t.effective_service_date) then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID';
    end if;
    wk:=planning_day-(extract(isodow from planning_day)::integer-1);$new$),
    ('d.work_date=t.effective_service_date and d.available','d.work_date=planning_day and d.available'),
    ('''targetAssignmentVersion'',t.assignment_version,''requestId'',q.id',
     '''planningDate'',planning_day,''targetAssignmentVersion'',t.assignment_version,''requestId'',q.id')
  ) changes(old_text,new_text) loop
    if (length(source)-length(replace(source,patch.old_text,'')))/length(patch.old_text)<>1 then
      raise exception 'ASSIGNMENT_PLANNING_PRESTART_SOURCE_DRIFT';
    end if;
    source:=replace(source,patch.old_text,patch.new_text);
  end loop;
  execute format('create function private.assignment_prestart_command_for_plan(%s,p_planning_date date) returns jsonb language plpgsql security definer set search_path='''' as %L',args,source);
  execute replace(original_definition,original_source,$body$
begin
  return private.assignment_prestart_command_for_plan(p_actor,p_action,p_target,p_assignment,p_version,
    p_maid,p_sequence,p_available,p_due,p_request,p_decision,p_reason,p_detail,p_key,p_hash,null);
end;
$body$);
end $prestart$;
revoke all on function private.assignment_prestart_command_for_plan(uuid,text,uuid,uuid,bigint,uuid,integer,timestamptz,timestamptz,uuid,text,text,text,text,text,date)
from public,anon,authenticated,service_role;

-- New adapter command requires the selected planning day. The old endpoint
-- remains available for compatibility; frontend planning tabs use this command.
create function public.change_cleaning_assignment_for_plan(p_actor_profile_id uuid,p_cleaning_target_id uuid,
  p_expected_current_assignment_id uuid,p_expected_assignment_version bigint,p_maid_profile_id uuid,p_sequence_number integer,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_service_date date,
  p_available_from timestamptz default null,p_due_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if p_service_date is null then raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
  return private.assignment_prestart_command_for_plan(p_actor_profile_id,'change',p_cleaning_target_id,p_expected_current_assignment_id,
    p_expected_assignment_version,p_maid_profile_id,p_sequence_number,p_available_from,p_due_at,null,null,p_reason_code,null,p_idempotency_key,p_request_hash,p_service_date);
end $$;
revoke all on function public.change_cleaning_assignment_for_plan(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,date,timestamptz,timestamptz)
from public,anon,authenticated,service_role;
grant execute on function public.change_cleaning_assignment_for_plan(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,date,timestamptz,timestamptz) to service_role;
