-- #305/#308: business deadlines are reminders, not permission expiry.
-- Append-only upgrade: retain original schedules, identities, receipts and history.
-- Typed overdue notices and past-unassigned planning are separate follow-up work.
-- Patch only the known deadline clauses; abort on source drift instead of silently
-- replacing an unexpected implementation or weakening a source/security guard.
do $upgrade$
declare patch record; definition text;
begin
  for patch in select * from (values
    ('private.assignment_preview_source_reason(public.cleaning_targets,integer,timestamptz)',
      E'  if p_target.due_at is not null and p_target.due_at<=p_command_at then\n    return ''ASSIGNMENT_WINDOW_EXPIRED'';\n  end if;', ''),
    ('private.assignment_preview_source_reason_before_stay_segments(public.cleaning_targets,integer,timestamptz)',
      '  if p_target.due_at is not null and p_target.due_at<=p_command_at then return ''ASSIGNMENT_WINDOW_EXPIRED''; end if;', ''),
    ('private.assignment_commit_candidates_at_before_stay_segments(date,timestamptz)',
      E'      when target.due_at is not null and target.due_at <= p_command_at\n        then ''ASSIGNMENT_WINDOW_EXPIRED''', ''),
    ('private.assignment_commit_candidates_at(date,timestamptz)',
      E'      when candidate.reason_code=''ASSIGNMENT_WINDOW_EXPIRED''\n        then candidate.reason_code\n', ''),
    ('private.assignment_commit_candidates_at(date,timestamptz)',
      '      and (target.due_at is null or target.due_at>p_command_at)',
      E'      and p_service_date in ((p_command_at at time zone ''Asia/Seoul'')::date,\n        (p_command_at at time zone ''Asia/Seoul'')::date + 1)'),
    ('private.activation_reason_at_before_stay_segments(public.cleaning_targets,public.cleaning_assignments,timestamptz)',
      '  if p_target.effective_service_date < v_today then return ''CLEANING_SERVICE_DATE_EXPIRED''; end if;', ''),
    ('private.activation_reason_at_before_stay_segments(public.cleaning_targets,public.cleaning_assignments,timestamptz)',
      '  if p_target.due_at is not null and p_target.due_at <= p_command_at then return ''CLEANING_WINDOW_EXPIRED''; end if;', ''),
    ('private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)',
      'p_action not in (''allow_finish'',''allow_upload'',''interrupt_handover'',''expire_scheduled'')',
      'p_action not in (''allow_finish'',''allow_upload'',''interrupt_handover'')')
  ) as changes(signature,old_text,new_text)
  loop
    -- PostgreSQL preserves the checkout's function-body line endings. Normalize
    -- CRLF only; the exact single-clause drift assertion remains unchanged.
    definition := replace(pg_get_functiondef(patch.signature::regprocedure),E'\r\n',E'\n');
    if strpos(definition,patch.old_text)=0
      or strpos(substr(definition,strpos(definition,patch.old_text)+length(patch.old_text)),patch.old_text)>0 then
      raise exception 'CLEANING_OVERDUE_SOURCE_DRIFT: %',patch.signature;
    end if;
    execute replace(definition,patch.old_text,patch.new_text);
  end loop;
end
$upgrade$;

-- Canonical stay segments must be checked at execution time, not only against
-- the historical planned window. A legacy source mismatch may be reconciled,
-- but it must never clear current occupancy or a previous live room workflow.
create or replace function private.activation_reason_at(
  p_target public.cleaning_targets,p_assignment public.cleaning_assignments,p_command_at timestamptz
) returns text language plpgsql stable security definer set search_path='' as $$
declare reason text;
begin
  reason:=private.activation_reason_at_before_stay_segments(p_target,p_assignment,p_command_at);
  if p_target.cleaning_kind='checkout' then
    if not (
      (p_target.source='stay_room_move_checkout' and exists(
        select 1 from private.stay_segment_checkout_obligations obligation
        where obligation.id=p_target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=p_target.id and obligation.room_id=p_target.room_id
          and obligation.status in('materialized','completed')
          and obligation.available_from<=p_command_at and p_target.available_from<=p_command_at
      )) or
      (p_target.source in('scheduled_checkout','manual_checkout') and exists(
        select 1 from public.checkout_cleaning_obligations obligation
        join public.reservations reservation on reservation.id=obligation.reservation_id
        where obligation.id=p_target.checkout_obligation_id
          and obligation.reservation_id=p_target.reservation_id
          and obligation.room_id=p_target.room_id
          and obligation.room_id=private.reservation_final_room_id(reservation.id)
          and obligation.planned_cleaning_target_id=p_target.id
          and obligation.current_cleaning_target_id=p_target.id
          and obligation.status in('materialized','completed')
          and reservation.status='checked_out' and reservation.actual_checkout_at<=p_command_at
          and p_target.available_from<=p_command_at
      ))
    ) then return 'CHECKOUT_NOT_MATERIALIZED'; end if;
    if reason='CHECKOUT_NOT_MATERIALIZED' then reason:=null; end if;
  elsif p_target.source='stayover_request' and p_target.cleaning_kind='stayover' then
    if not exists(
      select 1 from private.reservation_stays stay
      join private.stay_room_segments segment on segment.stay_id=stay.id
      join public.reservations reservation on reservation.id=stay.reservation_id
      where reservation.id=p_target.reservation_id and reservation.status='active'
        and reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
        and segment.room_id=p_target.room_id and segment.retired_at is null
        and segment.starts_at<=p_target.available_from
        and p_target.due_at is not null
        and (segment.ends_at is null or segment.ends_at>=p_target.due_at)
        and p_target.available_from<p_target.due_at
        and reservation.actual_check_in_at<=p_command_at
        and private.reservation_current_room_at(reservation.id,p_command_at)=p_target.room_id
    ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if reason='ATTEMPT_ACTIVATION_NOT_ALLOWED' then reason:=null; end if;
  elsif p_target.source='manual_room_request' and p_target.cleaning_kind='additional' then
    if p_target.due_at is not null and exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=p_target.room_id and segment.retired_at is null
        and stay.status in('scheduled','active')
        and tstzrange(segment.starts_at,segment.ends_at,'[)') &&
          tstzrange(p_target.available_from,p_target.due_at,'[)')
    ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if reason='ATTEMPT_ACTIVATION_NOT_ALLOWED' then reason:=null; end if;
  end if;
  if reason is not null then return reason; end if;
  -- A planned checkout is not proof of physical departure. Resolve the current
  -- canonical room so an overstay blocks that room, not a previously moved room.
  if p_target.cleaning_kind<>'stayover' and exists(
    select 1 from public.reservations reservation
    where reservation.status='active' and reservation.actual_check_in_at<=p_command_at
      and reservation.actual_checkout_at is null
      and private.reservation_current_room_at(reservation.id,p_command_at)=p_target.room_id
  ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  if p_target.cleaning_kind<>'stayover' and exists(
    select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    where segment.room_id=p_target.room_id and segment.retired_at is null
      and stay.status in('scheduled','active')
      and segment.starts_at<=p_command_at
      and (segment.ends_at is null or segment.ends_at>p_command_at)
  ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  if exists(
    select 1 from public.cleaning_attempts previous_attempt
    join public.cleaning_targets previous_target on previous_target.id=previous_attempt.cleaning_target_id
    where previous_target.room_id=p_target.room_id and previous_target.id<>p_target.id
      and (previous_attempt.status='in_progress' or (
        previous_attempt.status in('scheduled','field_completed','upload_pending','submitted')
        and (coalesce(previous_target.available_from,'-infinity'::timestamptz),previous_target.created_at,previous_target.id)
          < (coalesce(p_target.available_from,'infinity'::timestamptz),p_target.created_at,p_target.id)))
  ) then return 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'; end if;
  -- Scan order is an operational detail, never room workflow order. A current
  -- notified predecessor blocks even before its first attempt is materialized,
  -- including when it lives on a later UUID page or was inserted after the cursor.
  -- Terminal attempts on the exact current assignment do not resurrect old work.
  if exists(
    select 1 from public.cleaning_targets previous_target
    join public.cleaning_assignments previous_assignment
      on previous_assignment.cleaning_target_id=previous_target.id
      and previous_assignment.is_current and previous_assignment.notified_at is not null
      and previous_assignment.revision=previous_target.assignment_version
      and previous_assignment.service_date=previous_target.effective_service_date
      and previous_assignment.available_from_snapshot is not distinct from previous_target.available_from
      and previous_assignment.due_at_snapshot is not distinct from previous_target.due_at
    where previous_target.room_id=p_target.room_id and previous_target.id<>p_target.id
      and previous_target.status='notified'
      and (coalesce(previous_target.available_from,'-infinity'::timestamptz),previous_target.created_at,previous_target.id)
        < (coalesce(p_target.available_from,'infinity'::timestamptz),p_target.created_at,p_target.id)
      and (
        not exists(select 1 from public.cleaning_attempts previous_attempt
          where previous_attempt.assignment_id=previous_assignment.id
            and previous_attempt.assignment_revision=previous_assignment.revision)
        or exists(select 1 from public.cleaning_attempts previous_attempt
          where previous_attempt.assignment_id=previous_assignment.id
            and previous_attempt.assignment_revision=previous_assignment.revision
            and previous_attempt.status not in('approved','rejected','superseded')
            and private.attempt_blocks_assignment(previous_attempt))
      )
  ) then return 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'; end if;
  return null;
end
$$;
revoke all on function private.activation_reason_at(
  public.cleaning_targets,public.cleaning_assignments,timestamptz
) from public,anon,authenticated,service_role;

-- Mutable, non-business scan projection. No target/assignment/schedule is changed
-- by advancing the cursor, and response-loss replay never advances it twice.
create table private.assignment_activation_scan_cursor(
  singleton boolean primary key default true check(singleton),
  last_target_id uuid
);
alter table private.assignment_activation_scan_cursor enable row level security;
alter table private.assignment_activation_scan_cursor force row level security;
revoke all on private.assignment_activation_scan_cursor from public,anon,authenticated,service_role;
insert into private.assignment_activation_scan_cursor(singleton) values(true);
create index cleaning_targets_notified_scan_idx on public.cleaning_targets(id)
  include(effective_service_date) where status='notified';

create or replace function private.process_due_assignment_lifecycle_at(
  p_actor_profile_id uuid,p_as_of timestamptz,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  response jsonb; item record; result jsonb; results jsonb:='[]'::jsonb;
  activated integer:=0; already_active integer:=0; blocked integer:=0; not_ready integer:=0;
  today date; after_id uuid; scanned_id uuid;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_as_of is null or not isfinite(p_as_of) then
    raise exception using errcode='22023',message='ASSIGNMENT_ACTIVATION_TIME_REQUIRED';
  end if;
  response:=private.replay_command(p_actor_profile_id,'assignment.process_due_lifecycle',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  -- Same ordering as reservation/activation commands: global reservation lock,
  -- then the scheduler-only cursor row. A blocked oldest target cannot starve others.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform private.assert_room_admin(p_actor_profile_id);
  select last_target_id into after_id from private.assignment_activation_scan_cursor where singleton for update;
  today:=(p_as_of at time zone 'Asia/Seoul')::date;
  for item in
    with forward as materialized (
      select target.id from public.cleaning_targets target
      where target.status='notified' and target.effective_service_date<=today
        and (after_id is null or target.id>after_id)
      order by target.id limit 100
    ), wrapped as materialized (
      select target.id from public.cleaning_targets target
      where target.status='notified' and target.effective_service_date<=today
        and after_id is not null and target.id<=after_id
      order by target.id limit (100-(select count(*) from forward))
    ), candidates as (
      select id,0 as part from forward union all select id,1 as part from wrapped
    )
    select target.id,assignment.id as assignment_id,target.assignment_version
    from candidates join public.cleaning_targets target on target.id=candidates.id
    left join public.cleaning_assignments assignment on assignment.cleaning_target_id=target.id and assignment.is_current
    order by candidates.part,target.id
  loop
    result:=private.activate_cleaning_attempt_at(p_actor_profile_id,item.id,p_as_of,item.assignment_id,item.assignment_version);
    results:=results||jsonb_build_array(result);
    case result->>'status'
      when 'activated' then activated:=activated+1;
      when 'alreadyActive' then already_active:=already_active+1;
      when 'blocked' then blocked:=blocked+1;
      else not_ready:=not_ready+1;
    end case;
    scanned_id:=item.id;
  end loop;
  update private.assignment_activation_scan_cursor set last_target_id=scanned_id where singleton;
  response:=jsonb_build_object('asOf',p_as_of,'serviceDate',today,
    'activatedCount',activated,'alreadyActiveCount',already_active,'blockedCount',blocked,'notReadyCount',not_ready,
    'rolledOverCount',0,'activationResults',results,'rolloverResults','[]'::jsonb);
  perform private.complete_command(p_actor_profile_id,'assignment.process_due_lifecycle',p_idempotency_key,p_request_hash,null,response);
  return response;
end
$$;
revoke all on function private.process_due_assignment_lifecycle_at(uuid,timestamptz,text,text)
  from public,anon,authenticated,service_role;
