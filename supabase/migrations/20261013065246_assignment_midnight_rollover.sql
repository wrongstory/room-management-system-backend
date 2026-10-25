-- #446: KST midnight retires only unfinished, unstarted assignment responsibility.
-- Original reservation/access/deadline snapshots are not shifted by a calendar day.
-- No data backfill: the existing scheduler catches up using append-only evidence.
create index audit_assignment_rollover_plan_idx on public.audit_events(entity_id, recorded_at desc, id desc)
where event_type='assignment.rolled_over' and entity_type='cleaning_target';

create function private.assignment_current_planning_date(
  p_target public.cleaning_targets, p_assignment public.cleaning_assignments
) returns date language sql stable security definer set search_path='' as $$
  select greatest(p_target.effective_service_date,
    private.assignment_requested_planning_date(p_assignment),
    (select (audit.after_state->>'rolloverToDate')::date from public.audit_events audit
      where audit.entity_id=p_target.id and audit.entity_type='cleaning_target'
        and audit.event_type='assignment.rolled_over'
        and (audit.after_state->>'targetAssignmentVersion')::bigint<=p_target.assignment_version
      order by (audit.after_state->>'targetAssignmentVersion')::bigint desc,audit.id desc limit 1))
$$;
revoke all on function private.assignment_current_planning_date(public.cleaning_targets,public.cleaning_assignments)
from public,anon,authenticated,service_role;

create function private.rollover_assignment_midnight_at(
  p_actor uuid,p_target uuid,p_at timestamptz,p_expected_version bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  t public.cleaning_targets; a public.cleaning_assignments; actor public.profiles;
  old_day date; next_day date; reason text; attempts jsonb; result jsonb;
begin
  perform private.assert_room_admin(p_actor);
  if p_at is null or not isfinite(p_at) then
    raise exception using errcode='22023',message='ASSIGNMENT_ACTIVATION_TIME_REQUIRED'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform private.assert_room_admin(p_actor);
  select * into t from public.cleaning_targets where id=p_target for update;
  select * into a from public.cleaning_assignments where cleaning_target_id=t.id and is_current for update;
  if t.id is null or t.assignment_version is distinct from p_expected_version then
    return jsonb_build_object('status','notReady','reasonCode','ASSIGNMENT_VERSION_CONFLICT'); end if;
  old_day:=private.assignment_current_planning_date(t,a);
  if old_day >= (p_at at time zone 'Asia/Seoul')::date then
    return jsonb_build_object('status','notReady','reasonCode','CLEANING_SERVICE_DATE_NOT_DUE'); end if;
  -- Reclean is permanently owned by its original maid, not the general allocation pool.
  -- Any actual execution or terminal evidence wins over a misleading target status.
  if t.status not in ('unassigned','draft_assigned','notified')
    or t.source='inspection_reclean' or t.cleaning_kind='reclean'
    or exists(select 1 from public.cleaning_attempts x where x.cleaning_target_id=t.id
      and private.attempt_blocks_assignment(x) and not coalesce((
        x.status='scheduled' and x.started_at is null and x.field_completed_at is null
        and x.ended_at is null and x.assignment_id=a.id and x.assignment_revision=a.revision),false)) then
    return jsonb_build_object('status','blocked','reasonCode','ROLLOVER_NOT_ALLOWED'); end if;
  if (t.status='unassigned' and a.id is not null)
    or (t.status in ('draft_assigned','notified') and (a.id is null or a.revision<>t.assignment_version))
    or (t.status='notified' and a.notified_at is null) then
    return jsonb_build_object('status','notReady','reasonCode','ASSIGNMENT_VERSION_CONFLICT'); end if;
  if private.checkout_incident_is_open(t.id,null) then
    return jsonb_build_object('status','blocked','reasonCode','ROLLOVER_NOT_ALLOWED'); end if;
  if t.cleaning_kind='checkout' and not (
    exists(select 1 from public.checkout_cleaning_obligations o
      where o.id=t.checkout_obligation_id and o.current_cleaning_target_id=t.id
        and o.status in ('materialized','completed'))
    or exists(select 1 from private.stay_segment_checkout_obligations o
      where o.id=t.stay_segment_checkout_obligation_id and o.cleaning_target_id=t.id
        and o.status in ('materialized','completed'))
  ) then return jsonb_build_object('status','notReady','reasonCode','CHECKOUT_NOT_MATERIALIZED'); end if;
  next_day:=old_day+1;
  reason:=case when a.id is null then 'ROLLED_OVER_UNASSIGNED' else 'ROLLED_OVER_NOT_STARTED' end;
  -- Preserve the unstarted attempt record and revoke its current authority via
  -- existing assignment/attempt triggers. Never rewrite an actual start or photo.
  with retired as (
    update public.cleaning_attempts set status='superseded',ended_at=p_at,
      end_reason='ROLLED_OVER_NOT_STARTED',execution_version=execution_version+1
    where cleaning_target_id=t.id and assignment_id=a.id and status='scheduled'
      and started_at is null and field_completed_at is null and ended_at is null
    returning id
  ) select coalesce(jsonb_agg(id),'[]'::jsonb) into attempts from retired;
  if a.id is not null then
    update public.notifications set resolved_at=coalesce(resolved_at,p_at)
      where cleaning_target_id=t.id and recipient_profile_id=a.maid_profile_id
        and requires_action and resolved_at is null;
    update public.cleaning_assignments set is_current=false,ended_at=p_at,change_reason_code=reason where id=a.id;
  end if;
  update public.cleaning_targets set status='unassigned',assignment_version=assignment_version+1,
    carryover_count=carryover_count+1,updated_at=p_at where id=t.id returning * into t;
  -- The source schedule is unchanged. The allocation day is separately recorded
  -- in the rollover audit, just as #447 records requested planningDate separately.
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,
    effective_service_date,available_from,due_at,reason_code,changed_by,recorded_at)
  values(t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,reason,p_actor,p_at);
  result:=jsonb_strip_nulls(jsonb_build_object('status','rolledOver','cleaningTargetId',t.id,
    'assignmentId',a.id,'maidProfileId',a.maid_profile_id,'serviceDate',t.effective_service_date,
    'assignmentRevision',a.revision,'targetAssignmentVersion',t.assignment_version,
    'rolloverFromDate',old_day,'rolloverToDate',next_day,'carryoverCount',t.carryover_count,
    'retiredAttemptIds',attempts,'reasonCode',reason));
  select * into actor from public.profiles where id=p_actor;
  -- Existing typed audit trigger resolves the old notice and emits the rollover
  -- inbox event atomically. Do not also emit a legacy notification/outbox.
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,
    entity_type,entity_id,effective_at,reason_code,after_state,idempotency_key)
  values(p_actor,actor.display_name,'assignment.rolled_over','cleaning_target',t.id,
    next_day::timestamp at time zone 'Asia/Seoul',reason,result,
    private.audit_command_key(p_actor,'assignment.rolled_over.'||t.id::text,
      old_day::text||':'||t.assignment_version::text));
  return result;
end $$;
revoke all on function private.rollover_assignment_midnight_at(uuid,uuid,timestamptz,bigint)
from public,anon,authenticated,service_role;

alter table private.assignment_activation_scan_cursor add column last_rollover_target_id uuid;
create index cleaning_targets_midnight_scan_idx on public.cleaning_targets(id)
where status in ('unassigned','draft_assigned','notified');

create function private.process_assignment_midnight_rollovers_at(p_actor uuid,p_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare after_id uuid; scanned_id uuid; item record; result jsonb; results jsonb:='[]'::jsonb;
  current_version bigint; budget integer:=100;
begin
  perform private.assert_room_admin(p_actor);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select last_rollover_target_id into after_id from private.assignment_activation_scan_cursor where singleton for update;
  for item in
    with forward as materialized (
      select id from public.cleaning_targets where status in ('unassigned','draft_assigned','notified')
        and effective_service_date<(p_at at time zone 'Asia/Seoul')::date
        and (after_id is null or id>after_id) order by id limit 100
    ), wrapped as materialized (
      select id from public.cleaning_targets where status in ('unassigned','draft_assigned','notified')
        and effective_service_date<(p_at at time zone 'Asia/Seoul')::date
        and after_id is not null and id<=after_id order by id limit (100-(select count(*) from forward))
    ) select t.id,t.assignment_version from (
      select id,0 part from forward union all select id,1 part from wrapped
    ) candidates join public.cleaning_targets t on t.id=candidates.id order by candidates.part,t.id
  loop
    current_version:=item.assignment_version;
    loop
      result:=private.rollover_assignment_midnight_at(p_actor,item.id,p_at,current_version);
      exit when result->>'status'<>'rolledOver';
      results:=results||jsonb_build_array(result);
      current_version:=(result->>'targetAssignmentVersion')::bigint;
      budget:=budget-1;
      exit when budget=0;
    end loop;
    scanned_id:=item.id;
    exit when budget=0;
  end loop;
  update private.assignment_activation_scan_cursor set last_rollover_target_id=scanned_id where singleton;
  return results;
end $$;
revoke all on function private.process_assignment_midnight_rollovers_at(uuid,timestamptz)
from public,anon,authenticated,service_role;

-- Preserve existing cursor fairness, receipts, overdue and complaint detectors.
-- Rollover runs before activation; the activation guard also protects delayed cron.
do $patch$
declare patch record; definition text;
begin
  for patch in select * from (values
    ('private.process_due_assignment_lifecycle_at(uuid,timestamptz,text,text)',
      $old$  today date; after_id uuid; scanned_id uuid;$old$,
      $new$  today date; after_id uuid; scanned_id uuid; midnight_results jsonb;$new$),
    ('private.process_due_assignment_lifecycle_at(uuid,timestamptz,text,text)',
      $old$  today:=(p_as_of at time zone 'Asia/Seoul')::date;$old$,
      $new$  today:=(p_as_of at time zone 'Asia/Seoul')::date;
  midnight_results:=private.process_assignment_midnight_rollovers_at(p_actor_profile_id,p_as_of);$new$),
    ('private.process_due_assignment_lifecycle_at(uuid,timestamptz,text,text)',
      $old$'rolledOverCount',0,'activationResults',results,'rolloverResults','[]'::jsonb$old$,
      $new$'rolledOverCount',jsonb_array_length(midnight_results),'activationResults',results,'rolloverResults',midnight_results$new$),
    ('private.activation_reason_at(public.cleaning_targets,public.cleaning_assignments,timestamptz)',
      $old$  return null;
end$old$,
      $new$  if p_target.source<>'inspection_reclean' and p_target.cleaning_kind<>'reclean'
    and private.assignment_current_planning_date(p_target,p_assignment)<(p_command_at at time zone 'Asia/Seoul')::date then
    return 'ASSIGNMENT_VERSION_CONFLICT';
  end if;
  return null;
end$new$),
    ('private.dispatch_notification_from_audit()',
      $old$  elsif new.event_type='assignment.rolled_over' then
    select * into t from public.cleaning_targets where id=new.entity_id;
    select * into old_a from public.cleaning_assignments where id=nullif(new.after_state->>'assignmentId','')::uuid;
    if old_a.id is not null then$old$,
      $new$  elsif new.event_type='assignment.rolled_over' then
    select * into t from public.cleaning_targets where id=new.entity_id;
    select * into old_a from public.cleaning_assignments where id=nullif(new.after_state->>'assignmentId','')::uuid;
    if old_a.id is not null and old_a.notified_at is not null then$new$),
    ('public.get_assignment_schedule_read_for_plan(uuid,uuid,uuid[],boolean,text)',
      $old$'planningDate',private.assignment_requested_planning_date(assignment)$old$,
      $new$'planningDate',case when assignment.is_current then
        private.assignment_current_planning_date(target,assignment)
        else private.assignment_requested_planning_date(assignment) end$new$)
  ) changes(signature,old_text,new_text) loop
    definition:=replace(pg_get_functiondef(patch.signature::regprocedure),E'\r\n',E'\n');
    if (length(definition)-length(replace(definition,patch.old_text,'')))/length(patch.old_text)<>1 then
      raise exception 'ASSIGNMENT_MIDNIGHT_SOURCE_DRIFT: %',patch.signature; end if;
    execute replace(definition,patch.old_text,patch.new_text);
  end loop;
end $patch$;
