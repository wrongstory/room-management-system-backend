-- #28 Attempt Activation: notified assignment -> scheduled attempt and missed-work rollover.
-- This migration adds only service-owned commands. Maid field start remains #7.

create index cleaning_targets_assignment_lifecycle_due_idx
on public.cleaning_targets (effective_service_date, due_at, id)
where status in ('unassigned', 'notified');

create index cleaning_attempts_room_workflow_lookup_idx
on public.cleaning_attempts (status, cleaning_target_id, id)
where status in ('scheduled', 'in_progress', 'field_completed', 'upload_pending', 'submitted');

create function private.assignment_activation_result(
  p_status text,
  p_reason_code text,
  p_target public.cleaning_targets,
  p_assignment public.cleaning_assignments default null,
  p_attempt public.cleaning_attempts default null
)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'status', p_status,
    'reasonCode', p_reason_code,
    'cleaningTargetId', p_target.id,
    'assignmentId', p_assignment.id,
    'attemptId', p_attempt.id,
    'maidProfileId', p_assignment.maid_profile_id,
    'serviceDate', p_target.effective_service_date,
    'assignmentRevision', p_assignment.revision,
    'attemptNumber', p_attempt.attempt_number,
    'targetAssignmentVersion', p_target.assignment_version,
    'carryoverCount', p_target.carryover_count
  ));
$$;

revoke all on function private.assignment_activation_result(
  text, text, public.cleaning_targets, public.cleaning_assignments, public.cleaning_attempts
) from public, anon, authenticated;

create function private.activation_reason_at(
  p_target public.cleaning_targets,
  p_assignment public.cleaning_assignments,
  p_command_at timestamptz
)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (p_command_at at time zone 'Asia/Seoul')::date;
begin
  if p_target.status <> 'notified' then
    return 'ASSIGNMENT_NOT_NOTIFIED';
  end if;
  if p_assignment.id is null
    or not p_assignment.is_current
    or p_assignment.notified_at is null then
    return 'ASSIGNMENT_NOT_NOTIFIED';
  end if;
  if p_assignment.cleaning_target_id is distinct from p_target.id
    or p_assignment.revision is distinct from p_target.assignment_version
    or p_assignment.service_date is distinct from p_target.effective_service_date
    or p_assignment.available_from_snapshot is distinct from p_target.available_from
    or p_assignment.due_at_snapshot is distinct from p_target.due_at then
    return 'ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if p_target.effective_service_date > v_today then
    return 'CLEANING_SERVICE_DATE_NOT_DUE';
  end if;
  if p_target.effective_service_date < v_today then
    return 'CLEANING_SERVICE_DATE_EXPIRED';
  end if;
  if p_target.available_from is null or p_target.available_from > p_command_at then
    return 'CLEANING_WINDOW_NOT_OPEN';
  end if;
  if p_target.due_at is not null and p_target.due_at <= p_command_at then
    return 'CLEANING_WINDOW_EXPIRED';
  end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_assignment.maid_profile_id
      and profile.role = 'maid'
      and profile.status = 'active'
  ) then
    return 'ASSIGNMENT_MAID_UNAVAILABLE';
  end if;

  if p_target.cleaning_kind = 'checkout' then
    if p_target.source not in ('scheduled_checkout', 'manual_checkout')
      or not exists (
        select 1
        from public.checkout_cleaning_obligations obligation
        join public.reservations reservation
          on reservation.id = obligation.reservation_id
         and reservation.room_id = obligation.room_id
        where obligation.id = p_target.checkout_obligation_id
          and obligation.planned_cleaning_target_id = p_target.id
          and obligation.current_cleaning_target_id = p_target.id
          and obligation.status in ('materialized', 'completed')
          and reservation.id = p_target.reservation_id
          and reservation.room_id = p_target.room_id
          and reservation.status = 'checked_out'
          and reservation.actual_checkout_at is not null
          and reservation.actual_checkout_at <= p_command_at
          and p_target.available_from <= p_command_at
      ) then
      return 'CHECKOUT_NOT_MATERIALIZED';
    end if;
  elsif p_target.source = 'stayover_request' and p_target.cleaning_kind = 'stayover' then
    if not exists (
      select 1 from public.reservations reservation
      where reservation.id = p_target.reservation_id
        and reservation.room_id = p_target.room_id
        and reservation.status = 'active'
        and reservation.actual_check_in_at is not null
        and reservation.actual_checkout_at is null
        and p_target.available_from >= reservation.actual_check_in_at
        and p_target.due_at is not null
        and p_target.due_at <= reservation.check_out_at
        and p_target.available_from < p_target.due_at
    ) then
      return 'ATTEMPT_ACTIVATION_NOT_ALLOWED';
    end if;
  elsif p_target.source = 'manual_room_request' and p_target.cleaning_kind = 'additional' then
    if exists (
      select 1 from public.reservations reservation
      where reservation.room_id = p_target.room_id
        and reservation.status = 'active'
        and tstzrange(
          coalesce(reservation.actual_check_in_at, reservation.check_in_at),
          case
            when reservation.actual_check_in_at is not null
              and reservation.actual_checkout_at is null then 'infinity'::timestamptz
            else coalesce(reservation.actual_checkout_at, reservation.check_out_at)
          end,
          '[)'
        ) && tstzrange(
          p_target.available_from,
          coalesce(
            p_target.due_at,
            p_target.available_from + make_interval(
              mins => coalesce(nullif(p_target.template_snapshot ->> 'durationMinutes', '')::integer, 1)
            )
          ),
          '[)'
        )
    ) then
      return 'ATTEMPT_ACTIVATION_NOT_ALLOWED';
    end if;
  elsif p_target.source = 'inspection_reclean' and p_target.cleaning_kind = 'reclean' then
    if p_target.fee_snapshot <> 0
      or p_target.reclean_of_attempt_id is null
      or p_target.reclean_maid_profile_id is distinct from p_assignment.maid_profile_id
      or not exists (
        select 1 from public.cleaning_attempts original_attempt
        where original_attempt.id = p_target.reclean_of_attempt_id
          and original_attempt.maid_profile_id = p_target.reclean_maid_profile_id
          and original_attempt.status = 'rejected'
      ) then
      return 'RECLEAN_MAID_IMMUTABLE';
    end if;
  else
    return 'ATTEMPT_ACTIVATION_NOT_ALLOWED';
  end if;

  if exists (
    select 1
    from public.cleaning_attempts previous_attempt
    join public.cleaning_targets previous_target
      on previous_target.id = previous_attempt.cleaning_target_id
    where previous_target.room_id = p_target.room_id
      and previous_target.id <> p_target.id
      and previous_attempt.status in (
        'scheduled', 'in_progress', 'field_completed', 'upload_pending', 'submitted'
      )
      and (
        coalesce(previous_target.available_from, '-infinity'::timestamptz),
        previous_target.created_at,
        previous_target.id
      ) < (
        coalesce(p_target.available_from, 'infinity'::timestamptz),
        p_target.created_at,
        p_target.id
      )
  ) then
    return 'PREVIOUS_ROOM_WORKFLOW_ACTIVE';
  end if;

  return null;
end;
$$;

revoke all on function private.activation_reason_at(
  public.cleaning_targets, public.cleaning_assignments, timestamptz
) from public, anon, authenticated;

create function private.activate_cleaning_attempt_at(
  p_actor_profile_id uuid,
  p_cleaning_target_id uuid,
  p_command_at timestamptz,
  p_expected_assignment_id uuid default null,
  p_expected_assignment_version bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.cleaning_targets%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_existing public.cleaning_attempts%rowtype;
  v_attempt public.cleaning_attempts%rowtype;
  v_reason text;
  v_attempt_number integer;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_target
  from public.cleaning_targets target
  where target.id = p_cleaning_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_TARGET_NOT_FOUND';
  end if;

  select * into v_assignment
  from public.cleaning_assignments assignment
  where assignment.cleaning_target_id = v_target.id
    and assignment.is_current
  for update;

  if (p_expected_assignment_id is not null
      and v_assignment.id is distinct from p_expected_assignment_id)
    or (p_expected_assignment_version is not null
      and v_target.assignment_version is distinct from p_expected_assignment_version) then
    return private.assignment_activation_result(
      'blocked', 'ASSIGNMENT_VERSION_CONFLICT', v_target, v_assignment, null
    );
  end if;

  select * into v_existing
  from public.cleaning_attempts attempt
  where attempt.cleaning_target_id = v_target.id
    and attempt.status <> 'superseded'
  order by attempt.attempt_number desc
  limit 1
  for update;

  if v_existing.id is not null then
    if v_assignment.id is not null
      and v_existing.assignment_id = v_assignment.id
      and v_existing.maid_profile_id = v_assignment.maid_profile_id
      and v_existing.assignment_revision = v_assignment.revision then
      return private.assignment_activation_result(
        'alreadyActive', 'ATTEMPT_ALREADY_ACTIVE', v_target, v_assignment, v_existing
      );
    end if;
    return private.assignment_activation_result(
      'blocked', 'ASSIGNMENT_VERSION_CONFLICT', v_target, v_assignment, v_existing
    );
  end if;

  v_reason := private.activation_reason_at(v_target, v_assignment, p_command_at);
  if v_reason is not null then
    return private.assignment_activation_result(
      case when v_reason in (
        'CLEANING_SERVICE_DATE_NOT_DUE', 'CLEANING_SERVICE_DATE_EXPIRED',
        'CLEANING_WINDOW_NOT_OPEN', 'CLEANING_WINDOW_EXPIRED', 'CHECKOUT_NOT_MATERIALIZED'
      ) then 'notReady' else 'blocked' end,
      v_reason,
      v_target,
      v_assignment,
      null
    );
  end if;

  select coalesce(max(attempt.attempt_number), 0) + 1 into v_attempt_number
  from public.cleaning_attempts attempt
  where attempt.cleaning_target_id = v_target.id;

  insert into public.cleaning_attempts (
    cleaning_target_id,
    assignment_id,
    maid_profile_id,
    attempt_number,
    status,
    assignment_revision,
    template_snapshot,
    room_snapshot,
    created_at,
    updated_at
  )
  select
    v_target.id,
    v_assignment.id,
    v_assignment.maid_profile_id,
    v_attempt_number,
    'scheduled',
    v_assignment.revision,
    v_target.template_snapshot,
    v_target.room_type_snapshot || jsonb_build_object(
      'roomId', room.id,
      'roomNumber', room.room_number,
      'elevatorZone', room.elevator_zone
    ),
    p_command_at,
    p_command_at
  from public.rooms room
  where room.id = v_target.room_id
  returning * into v_attempt;

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    after_state,
    idempotency_key
  )
  select
    actor.id,
    actor.display_name,
    'assignment.attempt_activated',
    'cleaning_attempt',
    v_attempt.id,
    p_command_at,
    jsonb_build_object(
      'cleaningTargetId', v_target.id,
      'assignmentId', v_assignment.id,
      'attemptId', v_attempt.id,
      'maidProfileId', v_assignment.maid_profile_id,
      'serviceDate', v_target.effective_service_date,
      'assignmentRevision', v_assignment.revision,
      'attemptNumber', v_attempt.attempt_number,
      'targetAssignmentVersion', v_target.assignment_version
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'assignment.attempt_activated.' || v_attempt.id::text,
      v_target.id::text || ':' || v_assignment.revision::text
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  return private.assignment_activation_result(
    'activated', null, v_target, v_assignment, v_attempt
  );
end;
$$;

revoke all on function private.activate_cleaning_attempt_at(uuid, uuid, timestamptz, uuid, bigint)
from public, anon, authenticated;

create function private.rollover_cleaning_target_at(
  p_actor_profile_id uuid,
  p_cleaning_target_id uuid,
  p_command_at timestamptz,
  p_expected_assignment_id uuid default null,
  p_expected_assignment_version bigint default null,
  p_expected_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.cleaning_targets%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_old_date date;
  v_new_date date;
  v_day_delta integer;
  v_window_end timestamptz;
  v_notification_id uuid;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_target
  from public.cleaning_targets target
  where target.id = p_cleaning_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_TARGET_NOT_FOUND';
  end if;

  select * into v_assignment
  from public.cleaning_assignments assignment
  where assignment.cleaning_target_id = v_target.id
    and assignment.is_current
  for update;

  if (p_expected_assignment_id is not null
      and v_assignment.id is distinct from p_expected_assignment_id)
    or (p_expected_assignment_id is null and v_assignment.id is not null)
    or (p_expected_assignment_version is not null
      and v_target.assignment_version is distinct from p_expected_assignment_version)
    or (p_expected_service_date is not null
      and v_target.effective_service_date is distinct from p_expected_service_date) then
    return private.assignment_activation_result(
      'notReady', 'ASSIGNMENT_VERSION_CONFLICT', v_target, v_assignment, null
    );
  end if;

  if exists (
    select 1 from public.cleaning_attempts attempt
    where attempt.cleaning_target_id = v_target.id
      and attempt.status <> 'superseded'
  ) then
    return private.assignment_activation_result(
      'blocked', 'ROLLOVER_NOT_ALLOWED', v_target, v_assignment, null
    );
  end if;

  if v_target.status not in ('unassigned', 'notified')
    or (v_target.status = 'unassigned' and v_assignment.id is not null)
    or (v_target.status = 'notified' and (
      v_assignment.id is null
      or v_assignment.notified_at is null
      or v_assignment.revision <> v_target.assignment_version
    )) then
    return private.assignment_activation_result(
      'notReady', 'ROLLOVER_NOT_ALLOWED', v_target, v_assignment, null
    );
  end if;

  if v_target.cleaning_kind = 'checkout' and not exists (
    select 1
    from public.checkout_cleaning_obligations obligation
    join public.reservations reservation on reservation.id = obligation.reservation_id
    where obligation.id = v_target.checkout_obligation_id
      and obligation.current_cleaning_target_id = v_target.id
      and obligation.status in ('materialized', 'completed')
      and reservation.status = 'checked_out'
      and reservation.actual_checkout_at is not null
  ) then
    return private.assignment_activation_result(
      'notReady', 'CHECKOUT_NOT_MATERIALIZED', v_target, v_assignment, null
    );
  end if;

  v_window_end := coalesce(
    v_target.due_at,
    ((v_target.effective_service_date + 1)::timestamp at time zone 'Asia/Seoul')
  );
  if v_window_end > p_command_at then
    return private.assignment_activation_result(
      'notReady', 'CLEANING_WINDOW_NOT_EXPIRED', v_target, v_assignment, null
    );
  end if;

  v_old_date := v_target.effective_service_date;
  v_new_date := v_old_date + 1;
  v_day_delta := v_new_date - v_old_date;

  if v_assignment.id is not null then
    update public.cleaning_assignments
    set is_current = false,
        ended_at = p_command_at,
        change_reason_code = 'ROLLED_OVER_NOT_STARTED'
    where id = v_assignment.id
      and is_current;

    update public.notifications
    set resolved_at = coalesce(resolved_at, p_command_at)
    where cleaning_target_id = v_target.id
      and recipient_profile_id = v_assignment.maid_profile_id
      and requires_action
      and resolved_at is null;
  end if;

  update public.cleaning_targets
  set effective_service_date = v_new_date,
      available_from = case
        when available_from is null then null
        else available_from + make_interval(days => v_day_delta)
      end,
      due_at = case
        when due_at is null then null
        else due_at + make_interval(days => v_day_delta)
      end,
      carryover_count = carryover_count + 1,
      assignment_version = assignment_version + 1,
      status = 'unassigned',
      updated_at = p_command_at
  where id = v_target.id
  returning * into v_target;

  if v_target.cleaning_kind = 'checkout' then
    update public.checkout_cleaning_obligations
    set effective_service_date = v_target.effective_service_date,
        available_from = v_target.available_from,
        due_at = v_target.due_at,
        version = version + 1,
        updated_at = p_command_at
    where id = v_target.checkout_obligation_id
      and current_cleaning_target_id = v_target.id;
  end if;

  insert into public.cleaning_target_schedule_revisions (
    cleaning_target_id,
    revision,
    effective_service_date,
    available_from,
    due_at,
    reason_code,
    changed_by,
    recorded_at
  ) values (
    v_target.id,
    v_target.assignment_version,
    v_target.effective_service_date,
    v_target.available_from,
    v_target.due_at,
    case when v_assignment.id is null
      then 'ROLLED_OVER_UNASSIGNED'
      else 'ROLLED_OVER_NOT_STARTED'
    end,
    p_actor_profile_id,
    p_command_at
  );

  if v_assignment.id is not null then
    insert into public.notifications (
      recipient_profile_id,
      category,
      title,
      body,
      room_id,
      cleaning_target_id,
      dedupe_key,
      requires_action,
      occurred_at
    ) values (
      v_assignment.maid_profile_id,
      'cleaning_assignment_rolled_over',
      '미착수 청소 배정이 이월되었습니다',
      '미착수 청소 배정이 다음 업무일의 재배정 대상으로 변경되었습니다.',
      v_target.room_id,
      v_target.id,
      'assignment-rollover:' || v_assignment.id::text,
      false,
      p_command_at
    ) returning id into v_notification_id;

    insert into private.notification_outbox (
      notification_id, channel, delivery_status, next_attempt_at, created_at
    ) values (
      v_notification_id, 'web_push', 'pending', p_command_at, p_command_at
    );
  end if;

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    after_state,
    idempotency_key
  )
  select
    actor.id,
    actor.display_name,
    'assignment.rolled_over',
    'cleaning_target',
    v_target.id,
    p_command_at,
    case when v_assignment.id is null
      then 'ROLLED_OVER_UNASSIGNED'
      else 'ROLLED_OVER_NOT_STARTED'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'cleaningTargetId', v_target.id,
      'assignmentId', v_assignment.id,
      'maidProfileId', v_assignment.maid_profile_id,
      'serviceDate', v_target.effective_service_date,
      'assignmentRevision', v_assignment.revision,
      'targetAssignmentVersion', v_target.assignment_version,
      'rolloverFromDate', v_old_date,
      'rolloverToDate', v_new_date,
      'carryoverCount', v_target.carryover_count,
      'reasonCode', case when v_assignment.id is null
        then 'ROLLED_OVER_UNASSIGNED'
        else 'ROLLED_OVER_NOT_STARTED'
      end
    )),
    private.audit_command_key(
      p_actor_profile_id,
      'assignment.rolled_over.' || v_target.id::text,
      v_old_date::text || ':' || v_target.assignment_version::text
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'rolledOver',
    'cleaningTargetId', v_target.id,
    'assignmentId', v_assignment.id,
    'maidProfileId', v_assignment.maid_profile_id,
    'rolloverFromDate', v_old_date,
    'rolloverToDate', v_new_date,
    'carryoverCount', v_target.carryover_count,
    'targetAssignmentVersion', v_target.assignment_version,
    'reasonCode', case when v_assignment.id is null
      then 'ROLLED_OVER_UNASSIGNED'
      else 'ROLLED_OVER_NOT_STARTED'
    end
  ));
end;
$$;

revoke all on function private.rollover_cleaning_target_at(uuid, uuid, timestamptz, uuid, bigint, date)
from public, anon, authenticated;

create function private.process_due_assignment_lifecycle_at(
  p_actor_profile_id uuid,
  p_as_of timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
  v_item record;
  v_result jsonb;
  v_activation_results jsonb := '[]'::jsonb;
  v_rollover_results jsonb := '[]'::jsonb;
  v_activated integer := 0;
  v_already_active integer := 0;
  v_blocked integer := 0;
  v_not_ready integer := 0;
  v_rolled_over integer := 0;
  v_today date;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_as_of is null then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_ACTIVATION_TIME_REQUIRED';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id,
    'assignment.process_due_lifecycle',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  v_today := (p_as_of at time zone 'Asia/Seoul')::date;

  for v_item in
    select target.id, assignment.id as assignment_id,
      target.assignment_version, target.effective_service_date
    from public.cleaning_targets target
    left join public.cleaning_assignments assignment
      on assignment.cleaning_target_id = target.id and assignment.is_current
    where target.status = 'notified'
      and target.effective_service_date = v_today
    order by target.available_from nulls last, target.id
  loop
    v_result := private.activate_cleaning_attempt_at(
      p_actor_profile_id, v_item.id, p_as_of,
      v_item.assignment_id, v_item.assignment_version
    );
    v_activation_results := v_activation_results || jsonb_build_array(v_result);
    case v_result ->> 'status'
      when 'activated' then v_activated := v_activated + 1;
      when 'alreadyActive' then v_already_active := v_already_active + 1;
      when 'blocked' then v_blocked := v_blocked + 1;
      else v_not_ready := v_not_ready + 1;
    end case;
  end loop;

  for v_item in
    select target.id, assignment.id as assignment_id,
      target.assignment_version, target.effective_service_date
    from public.cleaning_targets target
    left join public.cleaning_assignments assignment
      on assignment.cleaning_target_id = target.id and assignment.is_current
    where target.status in ('unassigned', 'notified')
      and target.effective_service_date <= v_today
      and coalesce(
        target.due_at,
        ((target.effective_service_date + 1)::timestamp at time zone 'Asia/Seoul')
      ) <= p_as_of
    order by target.effective_service_date, target.id
  loop
    v_result := private.rollover_cleaning_target_at(
      p_actor_profile_id, v_item.id, p_as_of,
      v_item.assignment_id, v_item.assignment_version, v_item.effective_service_date
    );
    if v_result ->> 'status' = 'rolledOver' then
      v_rollover_results := v_rollover_results || jsonb_build_array(v_result);
      v_rolled_over := v_rolled_over + 1;
    end if;
  end loop;

  v_response := jsonb_build_object(
    'asOf', p_as_of,
    'serviceDate', v_today,
    'activatedCount', v_activated,
    'alreadyActiveCount', v_already_active,
    'blockedCount', v_blocked,
    'notReadyCount', v_not_ready,
    'rolledOverCount', v_rolled_over,
    'activationResults', v_activation_results,
    'rolloverResults', v_rollover_results
  );

  perform private.complete_command(
    p_actor_profile_id,
    'assignment.process_due_lifecycle',
    p_idempotency_key,
    p_request_hash,
    null,
    v_response
  );
  return v_response;
end;
$$;

revoke all on function private.process_due_assignment_lifecycle_at(
  uuid, timestamptz, text, text
) from public, anon, authenticated;

create function public.process_due_assignment_lifecycle(
  p_actor_profile_id uuid,
  p_as_of timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.process_due_assignment_lifecycle_at(
    p_actor_profile_id,
    p_as_of,
    p_idempotency_key,
    p_request_hash
  );
$$;

revoke all on function public.process_due_assignment_lifecycle(
  uuid, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.process_due_assignment_lifecycle(
  uuid, timestamptz, text, text
) to service_role;

create function private.enforce_cleaning_attempt_snapshot_immutability()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.cleaning_target_id is distinct from old.cleaning_target_id
    or new.assignment_id is distinct from old.assignment_id
    or new.maid_profile_id is distinct from old.maid_profile_id
    or new.attempt_number is distinct from old.attempt_number
    or new.assignment_revision is distinct from old.assignment_revision
    or new.template_snapshot is distinct from old.template_snapshot
    or new.room_snapshot is distinct from old.room_snapshot
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '23514', message = 'ATTEMPT_SNAPSHOT_IMMUTABLE';
  end if;
  return new;
end;
$$;

revoke all on function private.enforce_cleaning_attempt_snapshot_immutability()
from public, anon, authenticated;

create trigger cleaning_attempts_snapshot_immutable
before update on public.cleaning_attempts
for each row execute function private.enforce_cleaning_attempt_snapshot_immutability();

create or replace function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
)
returns table (
  id uuid,
  event_type text,
  entity_type text,
  entity_id uuid,
  actor_profile_id uuid,
  actor_display_name text,
  effective_at timestamptz,
  recorded_at timestamptz,
  reason_code text,
  summary jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_allowed constant text[] := array[
    'account.bootstrap_developer_created','account.bootstrap_admin_created','account.created',
    'account.role_changed','account.status_changed','account.unlocked',
    'account.password_reset_requested','account.password_changed','availability.submitted',
    'availability.change_requested','availability.change_decided','assignment.draft_saved',
    'assignment.notified','assignment.prestart_changed','assignment.prestart_unassigned',
    'assignment.cancellation_requested','assignment.cancellation_decided',
    'assignment.attempt_activated','assignment.rolled_over',
    'reservation.created','reservation.changed','reservation.cancelled',
    'reservation.manual_checkout','reservation.scheduled_check_in',
    'reservation.scheduled_checkout','reservation.guest_name_retention_purged',
    'cleaning.manual_request.created','cleaning.manual_request.cancelled',
    'room.master_data_changed','room.create_block','room.release_block',
    'room.set_candle_count','room.report_issue','room.resolve_issue','room.record_pin_sync'
  ];
  v_selected text[] := coalesce(p_event_types, v_allowed);
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);
  if p_limit not between 1 and 100
    or v_from > v_to
    or v_to - v_from > interval '31 days'
    or (p_before_recorded_at is null) <> (p_before_id is null)
    or coalesce(cardinality(v_selected), 0) not between 1 and cardinality(v_allowed)
    or exists (select 1 from unnest(v_selected) requested where not requested = any (v_allowed)) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  return query
  select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
    audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
    case
      when audit.event_type like 'account.%' then jsonb_strip_nulls(jsonb_build_object(
        'displayName',audit.after_state->>'displayName','loginId',audit.after_state->>'loginId',
        'role',audit.after_state->>'role','status',audit.after_state->>'status',
        'mustChangePassword',audit.after_state->'mustChangePassword'))
      when audit.event_type like 'availability.%' then jsonb_strip_nulls(jsonb_build_object(
        'maidProfileId',audit.after_state->>'maidProfileId','weekStart',audit.after_state->>'weekStart',
        'version',audit.after_state->'version','sourceVersion',audit.after_state->'sourceVersion',
        'status',audit.after_state->>'status','approvedVersionId',audit.after_state->>'approvedVersionId'))
      when audit.event_type = 'assignment.draft_saved' then jsonb_strip_nulls(jsonb_build_object(
        'cleaningTargetId',audit.after_state->>'cleaningTargetId','maidProfileId',audit.after_state->>'maidProfileId',
        'serviceDate',audit.after_state->>'serviceDate','sequenceNumber',audit.after_state->'sequenceNumber',
        'revision',audit.after_state->'revision','targetAssignmentVersion',audit.after_state->'targetAssignmentVersion'))
      when audit.event_type like 'assignment.%' then jsonb_strip_nulls(jsonb_build_object(
        'cleaningTargetId',audit.after_state->>'cleaningTargetId','assignmentId',audit.after_state->>'assignmentId',
        'previousAssignmentId',audit.after_state->>'previousAssignmentId',
        'previousMaidProfileId',audit.after_state->>'previousMaidProfileId',
        'attemptId',audit.after_state->>'attemptId','maidProfileId',audit.after_state->>'maidProfileId',
        'serviceDate',audit.after_state->>'serviceDate','sequenceNumber',audit.after_state->'sequenceNumber',
        'revision',audit.after_state->'revision','assignmentRevision',audit.after_state->'assignmentRevision',
        'attemptNumber',audit.after_state->'attemptNumber',
        'targetAssignmentVersion',audit.after_state->'targetAssignmentVersion',
        'requestId',audit.after_state->>'requestId','decision',audit.after_state->>'decision',
        'rolloverFromDate',audit.after_state->>'rolloverFromDate',
        'rolloverToDate',audit.after_state->>'rolloverToDate',
        'carryoverCount',audit.after_state->'carryoverCount','reasonCode',audit.after_state->>'reasonCode'))
      when audit.event_type like 'reservation.%' then jsonb_strip_nulls(jsonb_build_object(
        'roomId',audit.after_state->>'room_id','status',audit.after_state->>'status',
        'version',audit.after_state->'version','checkInAt',audit.after_state->>'check_in_at',
        'checkOutAt',audit.after_state->>'check_out_at','purgedCount',audit.after_state->'purged_count'))
      when audit.event_type like 'cleaning.%' then jsonb_strip_nulls(jsonb_build_object(
        'roomId',audit.after_state->>'room_id','reservationId',audit.after_state->>'reservation_id',
        'cleaningKind',audit.after_state->>'cleaning_kind','status',audit.after_state->>'status',
        'serviceDate',audit.after_state->>'service_date','availableFrom',audit.after_state->>'available_from',
        'dueAt',audit.after_state->>'due_at','version',audit.after_state->'version'))
      when audit.event_type like 'room.%' then jsonb_strip_nulls(jsonb_build_object(
        'roomTypeId',audit.after_state->>'roomTypeId','elevatorZone',audit.after_state->>'elevatorZone',
        'dataStatus',audit.after_state->>'dataStatus','stateVersion',audit.after_state->'stateVersion',
        'blockId',audit.after_state->>'blockId','active',audit.after_state->'active',
        'count',audit.after_state->'count','issueId',audit.after_state->>'issueId',
        'category',audit.after_state->>'category','severity',audit.after_state->>'severity',
        'blocksGuestAssignment',audit.after_state->'blocksGuestAssignment','status',audit.after_state->>'status',
        'pinSyncEventId',audit.after_state->>'pinSyncEventId','syncStatus',audit.after_state->>'syncStatus',
        'pinVersion',audit.after_state->'pinVersion'))
      else '{}'::jsonb
    end
  from public.audit_events audit
  where audit.event_type = any(v_selected)
    and audit.recorded_at >= v_from and audit.recorded_at <= v_to
    and (p_filter_actor_profile_id is null or audit.actor_profile_id = p_filter_actor_profile_id)
    and (p_before_recorded_at is null
      or (audit.recorded_at,audit.id) < (p_before_recorded_at,p_before_id))
  order by audit.recorded_at desc,audit.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;
