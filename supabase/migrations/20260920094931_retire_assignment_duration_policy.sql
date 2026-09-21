-- #231: expected-time policy is retired for all new assignment previews.
-- Historical policy/template snapshots and their audit rows remain immutable.
comment on table public.assignment_duration_policy_versions is
  'Deprecated historical assignment duration policies. Read-only history; not a preview decision input.';

create or replace function public.confirm_assignment_duration_policy(
  p_actor_profile_id uuid,p_expected_version bigint,p_standard_minutes integer,
  p_premium_minutes integer,p_ocean_premium_minutes integer,p_ocean_family_minutes integer,
  p_idempotency_key text,p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform private.assert_room_admin(p_actor_profile_id);
  raise exception using errcode='0A000',message='ASSIGNMENT_DURATION_POLICY_RETIRED';
end;
$$;
revoke all on function public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)
  to service_role;
comment on function public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text) is
  'Deprecated and blocked. Historical duration policy rows are preserved but new versions cannot be confirmed.';
comment on function public.get_assignment_duration_policy(uuid) is
  'Deprecated read-only access to the last historical confirmed duration policy; never drives new previews.';

create or replace function private.assignment_preview_source_reason(
  p_target public.cleaning_targets,p_duration_minutes integer,p_command_at timestamptz
) returns text language plpgsql stable security definer set search_path='' as $$
begin
  if p_target.available_from is null or not isfinite(p_target.available_from)
    or (p_target.due_at is not null and
      (not isfinite(p_target.due_at) or p_target.due_at<=p_target.available_from))
    or (p_target.available_from at time zone 'Asia/Seoul')::date<>p_target.effective_service_date then
    return 'ASSIGNMENT_PREVIEW_INVALID_SCHEDULE';
  end if;
  if p_target.due_at is not null and p_target.due_at<=p_command_at then
    return 'ASSIGNMENT_WINDOW_EXPIRED';
  end if;
  if p_target.source='stay_room_move_checkout' then
    if p_target.cleaning_kind<>'checkout'
      or not exists(
        select 1 from private.stay_segment_checkout_obligations obligation
        join private.reservation_stays stay on stay.id=obligation.stay_id
        join private.stay_room_segments segment on segment.id=obligation.source_segment_id
        where obligation.id=p_target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=p_target.id
          and obligation.room_id=p_target.room_id
          and obligation.available_from=p_target.available_from
          and obligation.due_at is not distinct from p_target.due_at
          and obligation.status='materialized'
          and stay.reservation_id=p_target.reservation_id
          and segment.room_id=p_target.room_id
          and segment.ends_at=p_target.available_from
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  elsif p_target.cleaning_kind='checkout'
    and p_target.source in ('scheduled_checkout','manual_checkout') then
    if not exists(
        select 1
        from public.reservations reservation
        join public.checkout_cleaning_obligations obligation
          on obligation.reservation_id=reservation.id
        where obligation.id=p_target.checkout_obligation_id
          and reservation.id=p_target.reservation_id
          and obligation.room_id=p_target.room_id
          and p_target.room_id=private.reservation_final_room_id(reservation.id)
          and obligation.planned_cleaning_target_id=p_target.id
          and obligation.effective_service_date=p_target.effective_service_date
          and obligation.available_from is not distinct from p_target.available_from
          and obligation.due_at is not distinct from p_target.due_at
          and (
            (reservation.status='checked_out'
              and reservation.actual_checkout_at is not null
              and obligation.status='materialized'
              and obligation.current_cleaning_target_id=p_target.id)
            or (p_target.source='scheduled_checkout'
              and reservation.status='active'
              and reservation.actual_checkout_at is null
              and reservation.check_out_at=p_target.available_from
              and obligation.status='private'
              and obligation.current_cleaning_target_id is null)
          )
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  end if;
  if p_target.source='stayover_request' then
    if p_target.cleaning_kind<>'stayover' or p_target.due_at is null
      or not exists(
        select 1 from private.reservation_stays stay
        join private.stay_room_segments segment on segment.stay_id=stay.id
        join public.reservations reservation on reservation.id=stay.reservation_id
        where reservation.id=p_target.reservation_id and reservation.status='active'
          and reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
          and segment.room_id=p_target.room_id and segment.retired_at is null
          and segment.starts_at<=p_target.available_from
          and (segment.ends_at is null or segment.ends_at>=p_target.due_at)
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  end if;
  if p_target.source='manual_room_request' then
    if p_target.cleaning_kind<>'additional' then
      return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID';
    end if;
    -- Only an explicit [available_from,due_at) interval can be compared with
    -- reservation occupancy. An open deadline must remain open.
    if p_target.due_at is not null and exists(
        select 1 from private.stay_room_segments segment
        join private.reservation_stays stay on stay.id=segment.stay_id
        where segment.room_id=p_target.room_id and segment.retired_at is null
          and stay.status in('scheduled','active')
          and tstzrange(segment.starts_at,segment.ends_at,'[)') &&
            tstzrange(p_target.available_from,p_target.due_at,'[)')
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  end if;
  return private.assignment_preview_source_reason_before_stay_segments(
    p_target,null,p_command_at);
end;
$$;
revoke all on function private.assignment_preview_source_reason(
  public.cleaning_targets,integer,timestamptz
) from public,anon,authenticated,service_role;

create or replace function private.assignment_preview_snapshot_at(
  p_actor_profile_id uuid,p_service_date date,p_command_at timestamptz
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_targets jsonb;
  v_maids jsonb;
begin
  perform private.assert_assignment_preview_admin(p_actor_profile_id);
  if p_command_at is null or not isfinite(p_command_at) or p_service_date is null or not isfinite(p_service_date)
    or p_service_date not in ((p_command_at at time zone 'Asia/Seoul')::date,(p_command_at at time zone 'Asia/Seoul')::date+1) then
    raise exception using errcode='22023',message='ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'maidProfileId',p.id,'maidDisplayName',p.display_name,'role',p.role,'status',p.status,
    'availabilityVersion',v.version,'available',coalesce(d.available,false),
    'availabilityIdentity',jsonb_build_object('versionId',v.id,'weekStart',v.week_start,'workDate',d.work_date)
  ) order by p.id),'[]'::jsonb) into v_maids
  from (select * from public.profiles where role='maid' order by id limit 1001) p
  left join public.availability_versions v on v.maid_profile_id=p.id and v.is_current and v.status='submitted'
    and v.week_start=p_service_date-(extract(isodow from p_service_date)::integer-1)
  left join public.availability_days d on d.availability_version_id=v.id and d.work_date=p_service_date;
  if jsonb_array_length(v_maids)>1000 then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'cleaningTargetId',t.id,'roomId',t.room_id,
    'roomNumber',coalesce(t.room_type_snapshot->>'roomNumber',r.room_number),
    'roomTypeCode',coalesce(t.room_type_snapshot->>'code','unknown'),
    'elevatorZone',coalesce(t.room_type_snapshot->>'elevatorZone',r.elevator_zone,'unknown'),
    'feeSnapshot',t.fee_snapshot,'availableFrom',t.available_from,'dueAt',t.due_at,
    'serviceDate',t.effective_service_date,'status',t.status,'assignmentVersion',t.assignment_version,
    'source',t.source,'cleaningKind',t.cleaning_kind,'recleanMaidProfileId',t.reclean_maid_profile_id,
    'domainIdentity',jsonb_build_object('reservationId',t.reservation_id,'checkoutObligationId',t.checkout_obligation_id,
      'recleanOfAttemptId',t.reclean_of_attempt_id,'reservationVersion',res.version,'reservationStatus',res.status,
      'checkInAt',res.check_in_at,'checkOutAt',res.check_out_at,'actualCheckInAt',res.actual_check_in_at,
      'actualCheckoutAt',res.actual_checkout_at,'obligationStatus',o.status,'obligationVersion',o.version,
      'plannedTargetId',o.planned_cleaning_target_id,'currentTargetId',o.current_cleaning_target_id,
      'roomStateVersion',r.state_version,'originalServiceDate',t.original_service_date,'carryoverCount',t.carryover_count,
      'roomReservations',coalesce((select jsonb_agg(jsonb_build_object('id',schedule.id,'version',schedule.version,
        'status',schedule.status,'checkInAt',schedule.check_in_at,'checkOutAt',schedule.check_out_at,
        'actualCheckInAt',schedule.actual_check_in_at,'actualCheckoutAt',schedule.actual_checkout_at) order by schedule.id)
        from (select distinct on(reservation.id) reservation.*
          from public.reservations reservation
          join private.reservation_stays stay on stay.reservation_id=reservation.id
          join private.stay_room_segments segment on segment.stay_id=stay.id
          where segment.room_id=t.room_id and segment.retired_at is null
            and reservation.status='active'
            and segment.starts_at < coalesce(t.due_at,'infinity'::timestamptz)
            and segment.ends_at > t.available_from
          order by reservation.id,segment.starts_at limit 123) schedule),'[]'::jsonb)),
    'currentAssignment',case when a.id is null then null else jsonb_build_object(
      'assignmentId',a.id,'maidProfileId',a.maid_profile_id,'sequenceNumber',a.sequence_number,'revision',a.revision,
      'serviceDate',a.service_date,'availableFrom',a.available_from_snapshot,'dueAt',a.due_at_snapshot,
      'targetAssignmentVersion',t.assignment_version,'notifiedAt',a.notified_at) end,
    'activeAttempt',case when att.id is null then null else jsonb_build_object(
      'attemptId',att.id,'maidProfileId',att.maid_profile_id,'status',att.status,'startedAt',att.started_at,'endedAt',att.ended_at) end,
    'blockedReason',case
      when att.id is not null and t.effective_service_date<>p_service_date then 'ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED'
      when a.id is not null and (a.revision<>t.assignment_version or a.service_date<>t.effective_service_date
        or a.available_from_snapshot is distinct from t.available_from or a.due_at_snapshot is distinct from t.due_at)
        then 'ASSIGNMENT_DRAFT_STALE_SCHEDULE'
      when t.status in ('draft_assigned','notified') and a.id is null then 'ASSIGNMENT_PREVIEW_FIXED_ASSIGNMENT_INVALID'
      when t.status='unassigned' and a.id is not null then 'ASSIGNMENT_PREVIEW_FIXED_ASSIGNMENT_INVALID'
      when exists (
        select 1 from public.cleaning_attempts previous_attempt
        join public.cleaning_targets previous_target on previous_target.id=previous_attempt.cleaning_target_id
        where previous_target.room_id=t.room_id and previous_target.id<>t.id
          and previous_attempt.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')
          and (coalesce(previous_target.available_from,'-infinity'::timestamptz),previous_target.created_at,previous_target.id)
            < (coalesce(t.available_from,'infinity'::timestamptz),t.created_at,t.id)
      ) then 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'
      else private.assignment_preview_source_reason(t,null,p_command_at) end
  ) order by t.id),'[]'::jsonb) into v_targets
  from (
    select target.* from public.cleaning_targets target
    where (target.effective_service_date=p_service_date and target.status not in ('cancelled','approved'))
      or exists (select 1 from public.cleaning_attempts busy where busy.cleaning_target_id=target.id
        and busy.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')
        and (target.effective_service_date<=p_service_date or busy.status<>'scheduled'))
    order by target.id limit 243
  ) t
  join public.rooms r on r.id=t.room_id
  left join public.reservations res on res.id=t.reservation_id
  left join public.checkout_cleaning_obligations o on o.id=t.checkout_obligation_id
  left join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
  left join lateral (select attempt.* from public.cleaning_attempts attempt where attempt.cleaning_target_id=t.id
    and private.attempt_blocks_assignment(attempt) order by attempt.attempt_number desc limit 1) att on true;
  if jsonb_array_length(v_targets)>242 then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;
  if exists (select 1 from jsonb_array_elements(v_targets) item
    where jsonb_array_length(item->'domainIdentity'->'roomReservations')>122) then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;
  return jsonb_build_object('serviceDate',p_service_date,'planningAt',p_command_at,
    'durationPolicy',null,'durationPolicyStatus','retired','durationPolicyRequired',false,
    'maids',v_maids,'targets',v_targets);
end;
$$;
revoke all on function private.assignment_preview_snapshot_at(uuid,date,timestamptz)
  from public,anon,authenticated,service_role;
