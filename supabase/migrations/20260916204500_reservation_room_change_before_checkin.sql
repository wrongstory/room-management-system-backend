-- Issue #187 Phase B: BEFORE_CHECKIN reservation room-change preview and commit.
-- The existing reservation identity and schedule are preserved. DURING_STAY,
-- stay/segment storage, and any published/assigned cleaning workflow remain
-- outside this phase and fail closed.

create function private.reservation_room_move_outcome_at(
  p_room_id uuid,
  p_at timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public, private
as $$
  select jsonb_build_object(
    'occupancyStatus', case when state.occupied then 'OCCUPIED' else 'VACANT' end,
    'readinessStatus', readiness.readiness_status,
    'stateVersion', room.state_version
  )
  from public.rooms room
  cross join lateral (
    select
      reasons.reason_codes,
      'OCCUPIED' = any(reasons.reason_codes) as occupied,
      private.current_pin_sync_status(room.id) as pin_status
    from (
      select private.room_block_reason_codes(room.id, p_at, true, true) as reason_codes
    ) reasons
  ) state
  cross join lateral private.room_reservation_lifecycle_at(room.id, p_at) lifecycle
  cross join lateral private.room_readiness_axes_at(
    state.reason_codes,
    state.pin_status,
    lifecycle.current_checkin_pending
  ) readiness
  where room.id = p_room_id
$$;

revoke all on function private.reservation_room_move_outcome_at(uuid, timestamptz)
from public, anon, authenticated, service_role;

create function private.reservation_room_move_state(
  p_reservation_id uuid,
  p_target_room_id uuid,
  p_evaluated_at timestamptz,
  p_expires_at timestamptz,
  p_effective_at timestamptz,
  p_reason_code text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_source_room public.rooms%rowtype;
  v_target_room public.rooms%rowtype;
  v_preparation public.preparation_obligations%rowtype;
  v_obligation public.checkout_cleaning_obligations%rowtype;
  v_target public.cleaning_targets%rowtype;
  v_mode text;
  v_rejections text[] := array[]::text[];
  v_blocking_reasons text[] := array[]::text[];
  v_block_reasons text[] := array[]::text[];
  v_assignment_count integer := 0;
  v_current_assignment_count integer := 0;
  v_notified_assignment_count integer := 0;
  v_attempt_count integer := 0;
  v_active_pin_lease_count integer := 0;
  v_overlap boolean := false;
  v_impact_payload jsonb;
  v_fingerprint text;
  v_source_outcome jsonb;
  v_target_outcome jsonb;
begin
  select * into v_reservation
  from public.reservations
  where id = p_reservation_id;
  if not found then
    return null;
  end if;

  select * into strict v_source_room
  from public.rooms
  where id = v_reservation.room_id;
  select * into v_target_room
  from public.rooms
  where id = p_target_room_id;
  if not found then
    return null;
  end if;

  select * into strict v_preparation
  from public.preparation_obligations
  where id = v_reservation.preparation_obligation_id;
  select * into strict v_obligation
  from public.checkout_cleaning_obligations
  where id = v_reservation.checkout_obligation_id;
  select * into v_target
  from public.cleaning_targets
  where id = v_obligation.planned_cleaning_target_id;

  v_mode := case
    when v_reservation.status = 'active'
      and v_reservation.actual_check_in_at is null
      and v_reservation.actual_checkout_at is null
      and p_evaluated_at < v_reservation.check_in_at
      then 'BEFORE_CHECKIN'
    else 'DURING_STAY'
  end;

  if v_mode = 'DURING_STAY' then
    v_rejections := array_append(v_rejections, 'DURING_STAY_NOT_SUPPORTED');
  end if;
  if v_reservation.status <> 'active' then
    v_rejections := array_append(v_rejections, 'RESERVATION_NOT_ACTIVE');
  end if;
  if v_reservation.room_id = p_target_room_id then
    v_rejections := array_append(v_rejections, 'SAME_ROOM');
  end if;
  if v_obligation.status <> 'private'
    or v_obligation.current_cleaning_target_id is not null then
    v_rejections := array_append(v_rejections, 'CLEANING_WORKFLOW_PUBLIC');
  end if;
  if v_target.id is null
    or v_target.checkout_obligation_id is distinct from v_obligation.id
    or v_target.reservation_id is distinct from v_reservation.id
    or v_target.room_id is distinct from v_reservation.room_id
    or v_target.status <> 'unassigned' then
    v_rejections := array_append(v_rejections, 'PLANNED_CHECKOUT_NOT_PRIVATE');
  end if;

  if v_target.id is not null then
    select
      count(*)::integer,
      count(*) filter (where assignment.is_current)::integer,
      count(*) filter (where assignment.notified_at is not null)::integer
    into v_assignment_count, v_current_assignment_count, v_notified_assignment_count
    from public.cleaning_assignments assignment
    where assignment.cleaning_target_id = v_target.id;

    select count(*)::integer into v_attempt_count
    from public.cleaning_attempts attempt
    where attempt.cleaning_target_id = v_target.id;

    select count(*)::integer into v_active_pin_lease_count
    from public.room_pin_access_leases lease
    where lease.revoked_at is null
      and (
        lease.reservation_id = v_reservation.id
        or lease.cleaning_target_id = v_target.id
      );
  end if;

  if v_assignment_count > 0 then
    v_rejections := array_append(v_rejections, 'CLEANING_WORKFLOW_ASSIGNED');
  end if;
  if v_notified_assignment_count > 0 then
    v_rejections := array_append(v_rejections, 'CLEANING_WORKFLOW_NOTIFIED');
  end if;
  if v_attempt_count > 0 then
    v_rejections := array_append(v_rejections, 'CLEANING_WORKFLOW_STARTED');
  end if;
  if v_active_pin_lease_count > 0 then
    v_rejections := array_append(v_rejections, 'ACTIVE_PIN_ACCESS_EXISTS');
  end if;

  v_block_reasons := private.room_block_reason_codes(
    p_target_room_id,
    p_evaluated_at,
    false,
    false
  );
  if exists (
    select 1
    from public.room_operation_blocks block
    where block.room_id = p_target_room_id
      and block.released_at is null
      and block.starts_at < v_reservation.check_out_at
      and (block.ends_at is null or block.ends_at > v_reservation.check_in_at)
  ) and not ('OPERATION_BLOCKED' = any(v_block_reasons)) then
    v_block_reasons := array_append(v_block_reasons, 'OPERATION_BLOCKED');
  end if;
  if cardinality(v_block_reasons) > 0 then
    v_rejections := array_append(v_rejections, 'TARGET_ROOM_BLOCKED');
  end if;

  select exists (
    select 1
    from public.reservations other_reservation
    where other_reservation.room_id = p_target_room_id
      and other_reservation.id <> v_reservation.id
      and other_reservation.status = 'active'
      and other_reservation.check_in_at < v_reservation.check_out_at
      and other_reservation.check_out_at > v_reservation.check_in_at
  ) into v_overlap;
  if v_overlap then
    v_rejections := array_append(v_rejections, 'RESERVATION_OVERLAP');
  end if;

  if 'DURING_STAY_NOT_SUPPORTED' = any(v_rejections) then
    v_blocking_reasons := array_append(v_blocking_reasons, 'DURING_STAY_NOT_SUPPORTED');
  end if;
  if v_rejections && array[
    'RESERVATION_NOT_ACTIVE', 'SAME_ROOM', 'PLANNED_CHECKOUT_NOT_PRIVATE'
  ]::text[] then
    v_blocking_reasons := array_append(v_blocking_reasons, 'ROOM_CHANGE_PREVIEW_STALE');
  end if;
  if v_rejections && array[
    'CLEANING_WORKFLOW_PUBLIC', 'CLEANING_WORKFLOW_ASSIGNED',
    'CLEANING_WORKFLOW_NOTIFIED', 'CLEANING_WORKFLOW_STARTED'
  ]::text[] then
    v_blocking_reasons := array_append(v_blocking_reasons, 'CLEANING_ASSIGNMENT_LOCKED');
  end if;
  if 'ACTIVE_PIN_ACCESS_EXISTS' = any(v_rejections) then
    v_blocking_reasons := array_append(v_blocking_reasons, 'PIN_LEASE_ACTIVE');
  end if;
  if 'TARGET_ROOM_BLOCKED' = any(v_rejections) then
    v_blocking_reasons := array_append(v_blocking_reasons, 'TARGET_ROOM_BLOCKED');
  end if;
  if 'RESERVATION_OVERLAP' = any(v_rejections) then
    v_blocking_reasons := array_append(v_blocking_reasons, 'TARGET_ROOM_OVERLAP');
  end if;

  v_source_outcome := private.reservation_room_move_outcome_at(
    v_reservation.room_id,
    p_evaluated_at
  );
  v_target_outcome := private.reservation_room_move_outcome_at(
    p_target_room_id,
    p_evaluated_at
  );

  v_impact_payload := jsonb_build_object(
    'contractVersion', 1,
    'reservation', jsonb_build_array(
      v_reservation.id,
      v_reservation.room_id,
      v_reservation.check_in_at,
      v_reservation.check_out_at,
      v_reservation.guest_count,
      v_reservation.status,
      v_reservation.version,
      v_reservation.actual_check_in_at,
      v_reservation.actual_checkout_at
    ),
    'sourceRoom', jsonb_build_array(v_source_room.id, v_source_room.state_version),
    'targetRoom', jsonb_build_array(v_target_room.id, v_target_room.state_version),
    'preparation', jsonb_build_array(
      v_preparation.id,
      v_preparation.room_id,
      v_preparation.status,
      v_preparation.version,
      v_preparation.current_attempt_id,
      v_preparation.approved_submission_id
    ),
    'checkoutObligation', jsonb_build_array(
      v_obligation.id,
      v_obligation.room_id,
      v_obligation.status,
      v_obligation.version,
      v_obligation.planned_cleaning_target_id,
      v_obligation.current_cleaning_target_id
    ),
    'plannedTarget', jsonb_build_array(
      v_target.id,
      v_target.room_id,
      v_target.status,
      v_target.assignment_version,
      v_target.available_from,
      v_target.due_at
    ),
    'workflowCounts', jsonb_build_array(
      v_assignment_count,
      v_current_assignment_count,
      v_notified_assignment_count,
      v_attempt_count,
      v_active_pin_lease_count
    ),
    'targetBlockReasons', to_jsonb(v_block_reasons),
    'sourceOutcome', v_source_outcome,
    'targetOutcome', v_target_outcome,
    'overlap', v_overlap,
    'mode', v_mode,
    'evaluatedAt', p_evaluated_at,
    'expiresAt', p_expires_at,
    'effectiveAt', p_effective_at,
    'reasonCode', p_reason_code
  );
  v_fingerprint := encode(
    extensions.digest(convert_to(v_impact_payload::text, 'UTF8'), 'sha256'),
    'hex'
  );

  return jsonb_build_object(
    'mode', v_mode,
    'eligible', cardinality(v_rejections) = 0,
    'rejectionReasonCodes', to_jsonb(v_rejections),
    'blockingReasonCodes', to_jsonb(v_blocking_reasons),
    'warnings', '[]'::jsonb,
    'targetBlockReasonCodes', to_jsonb(v_block_reasons),
    'sourceOutcome', v_source_outcome,
    'targetOutcome', v_target_outcome,
    'impactFingerprint', v_fingerprint,
    'evaluatedAt', p_evaluated_at,
    'expiresAt', p_expires_at,
    'effectiveAt', p_effective_at,
    'reservationId', v_reservation.id,
    'reservationVersion', v_reservation.version,
    'sourceRoomId', v_reservation.room_id,
    'sourceRoomVersion', v_source_room.state_version,
    'targetRoomId', p_target_room_id,
    'targetRoomVersion', v_target_room.state_version,
    'checkInAt', v_reservation.check_in_at,
    'checkOutAt', v_reservation.check_out_at,
    'guestCount', v_reservation.guest_count,
    'preparationObligationId', v_preparation.id,
    'checkoutObligationId', v_obligation.id,
    'checkoutObligationVersion', v_obligation.version,
    'plannedCheckoutTargetId', v_target.id,
    'plannedCheckoutTargetVersion', v_target.assignment_version
  );
end
$$;

revoke all on function private.reservation_room_move_state(
  uuid, uuid, timestamptz, timestamptz, timestamptz, text
) from public, anon, authenticated, service_role;

create function private.reservation_room_move_conflict_detail(
  p_reservation_id uuid,
  p_source_room_id uuid,
  p_target_room_id uuid
)
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_reservation_version bigint;
  v_current_source_room_id uuid;
  v_source_room_version bigint;
  v_target_room_version bigint;
begin
  select reservation.version, reservation.room_id
  into v_reservation_version, v_current_source_room_id
  from public.reservations reservation
  where reservation.id = p_reservation_id;

  select room.state_version into v_source_room_version
  from public.rooms room
  where room.id = coalesce(p_source_room_id, v_current_source_room_id);

  select room.state_version into v_target_room_version
  from public.rooms room
  where room.id = p_target_room_id;

  return jsonb_build_object(
    'reloadResources', jsonb_build_array(
      'reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'
    ),
    'latestVersions', jsonb_build_object(
      'reservationVersion', v_reservation_version,
      'sourceRoomVersion', v_source_room_version,
      'targetRoomVersion', v_target_room_version
    )
  )::text;
end
$$;

revoke all on function private.reservation_room_move_conflict_detail(
  uuid, uuid, uuid
) from public, anon, authenticated, service_role;

create function public.preview_reservation_room_move(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_target_room_id uuid,
  p_expected_reservation_version bigint,
  p_expected_source_room_version bigint,
  p_expected_target_room_version bigint,
  p_effective_at timestamptz,
  p_reason_code text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_evaluated_at timestamptz := clock_timestamp();
  v_expires_at timestamptz;
  v_reservation public.reservations%rowtype;
  v_effective_at timestamptz;
  v_source_room_version bigint;
  v_target_room_version bigint;
  v_result jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_expires_at := v_evaluated_at + interval '5 minutes';

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if p_reason_code not in (
    'GUEST_REQUEST',
    'ROOM_UNAVAILABLE',
    'OPERATIONAL_ADJUSTMENT'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_MOVE_REASON';
  end if;
  v_effective_at := coalesce(p_effective_at, v_reservation.check_in_at);
  if v_effective_at <> v_reservation.check_in_at then
    raise exception using errcode = '22023', message = 'INVALID_MOVE_EFFECTIVE_AT';
  end if;
  select state_version into v_source_room_version
  from public.rooms
  where id = v_reservation.room_id;
  select state_version into v_target_room_version
  from public.rooms
  where id = p_target_room_id;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  if v_reservation.version <> p_expected_reservation_version then
    raise exception using
      errcode = '40001',
      message = 'RESERVATION_VERSION_CONFLICT',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_reservation.room_id, p_target_room_id
      );
  end if;
  if v_source_room_version <> p_expected_source_room_version then
    raise exception using
      errcode = '40001',
      message = 'SOURCE_ROOM_VERSION_CONFLICT',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_reservation.room_id, p_target_room_id
      );
  end if;
  if v_target_room_version <> p_expected_target_room_version then
    raise exception using
      errcode = '40001',
      message = 'TARGET_ROOM_VERSION_CONFLICT',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_reservation.room_id, p_target_room_id
      );
  end if;

  v_result := private.reservation_room_move_state(
    p_reservation_id,
    p_target_room_id,
    v_evaluated_at,
    v_expires_at,
    v_effective_at,
    p_reason_code
  );
  if v_result is null then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  return v_result;
end
$$;

revoke all on function public.preview_reservation_room_move(
  uuid, uuid, uuid, bigint, bigint, bigint, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.preview_reservation_room_move(
  uuid, uuid, uuid, bigint, bigint, bigint, timestamptz, text
) to service_role;

create function private.guard_reservation_room_move_authority()
returns trigger
language plpgsql
set search_path = pg_catalog
as $$
begin
  if new.room_id is distinct from old.room_id
    and coalesce(
      current_setting('app.reservation_room_move_writer_mode', true),
      ''
    ) <> 'before_checkin_v1' then
    raise exception using
      errcode = '23514',
      message = 'RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED',
      detail = private.reservation_room_move_conflict_detail(
        old.id, old.room_id, new.room_id
      );
  end if;
  return new;
end
$$;

revoke all on function private.guard_reservation_room_move_authority()
from public, anon, authenticated, service_role;

create trigger aa_reservation_room_move_authority
before update of room_id on public.reservations
for each row execute function private.guard_reservation_room_move_authority();

create function public.commit_reservation_room_move(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_target_room_id uuid,
  p_expected_reservation_version bigint,
  p_expected_source_room_version bigint,
  p_expected_target_room_version bigint,
  p_preview_evaluated_at timestamptz,
  p_preview_expires_at timestamptz,
  p_effective_at timestamptz,
  p_impact_fingerprint text,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_now timestamptz;
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_preparation public.preparation_obligations%rowtype;
  v_obligation public.checkout_cleaning_obligations%rowtype;
  v_target public.cleaning_targets%rowtype;
  v_source_room_id uuid;
  v_source_room_version bigint;
  v_target_room_version bigint;
  v_state jsonb;
  v_current_state jsonb;
  v_response jsonb;
  v_before jsonb;
  v_after jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);

  -- Replay is intentionally first: a completed same-key/same-payload command
  -- remains replayable after the preview TTL. A different hash still conflicts.
  begin
    v_response := private.replay_command(
      p_actor_profile_id,
      'reservation.room_move',
      p_idempotency_key,
      p_request_hash
    );
  exception
    when unique_violation then
      if sqlerrm = 'IDEMPOTENCY_KEY_REUSED' then
        raise exception using
          errcode = '23505',
          message = 'IDEMPOTENCY_KEY_REUSED',
          detail = private.reservation_room_move_conflict_detail(
            p_reservation_id, null, p_target_room_id
          );
      end if;
      raise;
  end;
  if v_response is not null then
    return v_response;
  end if;

  v_now := clock_timestamp();
  if p_reason_code not in (
    'GUEST_REQUEST',
    'ROOM_UNAVAILABLE',
    'OPERATIONAL_ADJUSTMENT'
  ) then
    raise exception using errcode = '22023', message = 'INVALID_ROOM_MOVE_REASON';
  end if;
  if p_impact_fingerprint is null
    or p_impact_fingerprint !~ '^[0-9a-f]{64}$'
    or p_preview_evaluated_at > v_now
    or p_preview_expires_at <> p_preview_evaluated_at + interval '5 minutes' then
    raise exception using errcode = '22023', message = 'ROOM_MOVE_PREVIEW_INVALID';
  end if;
  if p_preview_expires_at <= v_now then
    raise exception using
      errcode = '40001',
      message = 'ROOM_CHANGE_PREVIEW_STALE',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, null, p_target_room_id
      );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('room-management:reservation-command', 0)
  );

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  v_source_room_id := v_reservation.room_id;

  -- Room rows are always locked in UUID order before any conflict response so
  -- the safe latestVersions metadata is from the same authoritative snapshot.
  perform 1
  from public.rooms room
  where room.id in (v_source_room_id, p_target_room_id)
  order by room.id
  for update;
  if (select count(*) from public.rooms room
      where room.id in (v_source_room_id, p_target_room_id)) <
      (case when v_source_room_id = p_target_room_id then 1 else 2 end) then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  select state_version into v_source_room_version
  from public.rooms where id = v_source_room_id;
  select state_version into v_target_room_version
  from public.rooms where id = p_target_room_id;

  if v_source_room_id = p_target_room_id then
    raise exception using
      errcode = '23514',
      message = 'MOVE_ALREADY_APPLIED',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;
  if p_effective_at is null or p_effective_at <> v_reservation.check_in_at then
    raise exception using errcode = '22023', message = 'INVALID_MOVE_EFFECTIVE_AT';
  end if;
  if v_reservation.version <> p_expected_reservation_version then
    raise exception using
      errcode = '40001',
      message = 'RESERVATION_VERSION_CONFLICT',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;

  if v_source_room_version <> p_expected_source_room_version then
    raise exception using
      errcode = '40001',
      message = 'SOURCE_ROOM_VERSION_CONFLICT',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;
  if v_target_room_version <> p_expected_target_room_version then
    raise exception using
      errcode = '40001',
      message = 'TARGET_ROOM_VERSION_CONFLICT',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;

  select * into strict v_preparation
  from public.preparation_obligations
  where id = v_reservation.preparation_obligation_id
  for update;
  select * into strict v_obligation
  from public.checkout_cleaning_obligations
  where id = v_reservation.checkout_obligation_id
  for update;
  select * into strict v_target
  from public.cleaning_targets
  where id = v_obligation.planned_cleaning_target_id
  for update;
  perform 1 from public.cleaning_assignments assignment
  where assignment.cleaning_target_id = v_target.id
  order by assignment.id for update;
  perform 1 from public.cleaning_attempts attempt
  where attempt.cleaning_target_id = v_target.id
  order by attempt.id for update;
  perform 1 from public.room_pin_access_leases lease
  where lease.reservation_id = v_reservation.id
    or lease.cleaning_target_id = v_target.id
  order by lease.id for update;

  v_state := private.reservation_room_move_state(
    p_reservation_id,
    p_target_room_id,
    p_preview_evaluated_at,
    p_preview_expires_at,
    p_effective_at,
    p_reason_code
  );
  if v_state ->> 'impactFingerprint' <> p_impact_fingerprint then
    raise exception using
      errcode = '40001',
      message = 'ROOM_CHANGE_PREVIEW_STALE',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;
  if (v_state ->> 'mode') = 'DURING_STAY' then
    raise exception using
      errcode = '23514',
      message = 'DURING_STAY_NOT_SUPPORTED',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;
  if not coalesce((v_state ->> 'eligible')::boolean, false) then
    if (v_state -> 'rejectionReasonCodes') ? 'RESERVATION_OVERLAP' then
      raise exception using
        errcode = '23P01',
        message = 'TARGET_ROOM_OVERLAP',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    elsif (v_state -> 'rejectionReasonCodes') ? 'ACTIVE_PIN_ACCESS_EXISTS' then
      raise exception using
        errcode = '23514',
        message = 'PIN_LEASE_ACTIVE',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    elsif (v_state -> 'rejectionReasonCodes') ?| array[
      'CLEANING_WORKFLOW_PUBLIC', 'PLANNED_CHECKOUT_NOT_PRIVATE',
      'CLEANING_WORKFLOW_ASSIGNED', 'CLEANING_WORKFLOW_NOTIFIED',
      'CLEANING_WORKFLOW_STARTED'
    ] then
      raise exception using
        errcode = '23514',
        message = 'CLEANING_ASSIGNMENT_LOCKED',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    elsif (v_state -> 'rejectionReasonCodes') ? 'TARGET_ROOM_BLOCKED' then
      raise exception using
        errcode = '23514',
        message = 'TARGET_ROOM_BLOCKED',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    else
      raise exception using
        errcode = '40001',
        message = 'ROOM_CHANGE_PREVIEW_STALE',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    end if;
  end if;

  -- Re-evaluate time-dependent overlap/block/readiness immediately before DML.
  v_current_state := private.reservation_room_move_state(
    p_reservation_id,
    p_target_room_id,
    v_now,
    v_now + interval '5 minutes',
    p_effective_at,
    p_reason_code
  );
  if (v_current_state ->> 'mode') = 'DURING_STAY' then
    raise exception using
      errcode = '23514',
      message = 'DURING_STAY_NOT_SUPPORTED',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
  end if;
  if not coalesce((v_current_state ->> 'eligible')::boolean, false) then
    if (v_current_state -> 'rejectionReasonCodes') ? 'RESERVATION_OVERLAP' then
      raise exception using
        errcode = '23P01',
        message = 'TARGET_ROOM_OVERLAP',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    elsif (v_current_state -> 'rejectionReasonCodes') ? 'ACTIVE_PIN_ACCESS_EXISTS' then
      raise exception using
        errcode = '23514',
        message = 'PIN_LEASE_ACTIVE',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    elsif (v_current_state -> 'rejectionReasonCodes') ?| array[
      'CLEANING_WORKFLOW_PUBLIC', 'PLANNED_CHECKOUT_NOT_PRIVATE',
      'CLEANING_WORKFLOW_ASSIGNED', 'CLEANING_WORKFLOW_NOTIFIED',
      'CLEANING_WORKFLOW_STARTED'
    ] then
      raise exception using
        errcode = '23514',
        message = 'CLEANING_ASSIGNMENT_LOCKED',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    elsif (v_current_state -> 'rejectionReasonCodes') ? 'TARGET_ROOM_BLOCKED' then
      raise exception using
        errcode = '23514',
        message = 'TARGET_ROOM_BLOCKED',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    else
      raise exception using
        errcode = '40001',
        message = 'ROOM_CHANGE_PREVIEW_STALE',
        detail = private.reservation_room_move_conflict_detail(
          p_reservation_id, v_source_room_id, p_target_room_id
        );
    end if;
  end if;

  v_before := jsonb_build_object(
    'mode', 'BEFORE_CHECKIN',
    'reservationId', v_reservation.id,
    'reservationVersion', v_reservation.version,
    'sourceRoomId', v_source_room_id,
    'targetRoomId', p_target_room_id,
    'checkoutObligationId', v_obligation.id,
    'plannedCheckoutTargetId', v_target.id
  );

  perform set_config(
    'app.reservation_room_move_writer_mode',
    'before_checkin_v1',
    true
  );
  update public.reservations
  set room_id = p_target_room_id,
      version = version + 1,
      updated_by = p_actor_profile_id
  where id = v_reservation.id
  returning * into v_updated;

  update public.preparation_obligations
  set room_id = p_target_room_id,
      status = 'invalidated',
      approved_submission_id = null,
      invalidated_reason_code = 'RESERVATION_ROOM_CHANGED',
      version = version + 1
  where id = v_preparation.id;

  -- The existing deferred composite FK and sync trigger move this exact planned
  -- target identity. No target, assignment, attempt, or lease is recreated.
  update public.checkout_cleaning_obligations
  set room_id = p_target_room_id,
      version = version + 1
  where id = v_obligation.id;

  insert into public.reservation_schedule_revisions (
    reservation_id,
    version,
    room_id,
    check_in_at,
    check_out_at,
    guest_count,
    reason_code,
    actor_profile_id,
    effective_at
  ) values (
    v_updated.id,
    v_updated.version,
    v_updated.room_id,
    v_updated.check_in_at,
    v_updated.check_out_at,
    v_updated.guest_count,
    p_reason_code,
    p_actor_profile_id,
    v_now
  );

  update public.rooms
  set state_version = state_version + 1
  where id in (v_source_room_id, p_target_room_id);
  select state_version into v_source_room_version
  from public.rooms where id = v_source_room_id;
  select state_version into v_target_room_version
  from public.rooms where id = p_target_room_id;
  select refreshed_target.* into strict v_target
  from public.cleaning_targets refreshed_target
  where refreshed_target.id = v_target.id;

  v_after := jsonb_build_object(
    'mode', 'BEFORE_CHECKIN',
    'reservationId', v_updated.id,
    'reservationVersion', v_updated.version,
    'sourceRoomId', v_source_room_id,
    'targetRoomId', p_target_room_id,
    'sourceRoomVersion', v_source_room_version,
    'targetRoomVersion', v_target_room_version,
    'checkoutObligationId', v_obligation.id,
    'plannedCheckoutTargetId', v_target.id,
    'plannedCheckoutTargetVersion', v_target.assignment_version
  );
  v_response := jsonb_build_object(
    'reservation', private.reservation_response(v_updated),
    'mode', 'BEFORE_CHECKIN',
    'evaluatedAt', p_preview_evaluated_at,
    'expiresAt', p_preview_expires_at,
    'effectiveAt', p_effective_at,
    'movedAt', v_now,
    'sourceRoomId', v_source_room_id,
    'targetRoomId', p_target_room_id,
    'sourceRoomVersion', v_source_room_version,
    'targetRoomVersion', v_target_room_version,
    'plannedCheckoutTargetId', v_target.id,
    'plannedCheckoutTargetVersion', v_target.assignment_version,
    'sourceOutcome', private.reservation_room_move_outcome_at(
      v_source_room_id,
      v_now
    ),
    'targetOutcome', private.reservation_room_move_outcome_at(
      p_target_room_id,
      v_now
    )
  );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    profile.id,
    profile.display_name,
    'reservation.room_moved',
    'reservation',
    v_updated.id,
    v_now,
    p_reason_code,
    v_before,
    v_after,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'reservation.room_move',
      p_idempotency_key
    )
  from public.profiles profile
  where profile.id = p_actor_profile_id;

  -- No approved non-self recipient exists for a private, never-assigned target,
  -- so this command intentionally creates no notification or push outbox row.
  perform private.complete_command(
    p_actor_profile_id,
    'reservation.room_move',
    p_idempotency_key,
    p_request_hash,
    v_updated.id,
    v_response
  );
  return v_response;
exception
  when exclusion_violation then
    raise exception using
      errcode = '23P01',
      message = 'TARGET_ROOM_OVERLAP',
      detail = private.reservation_room_move_conflict_detail(
        p_reservation_id, v_source_room_id, p_target_room_id
      );
end
$$;

revoke all on function public.commit_reservation_room_move(
  uuid, uuid, uuid, bigint, bigint, bigint, timestamptz, timestamptz,
  timestamptz, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.commit_reservation_room_move(
  uuid, uuid, uuid, bigint, bigint, bigint, timestamptz, timestamptz,
  timestamptz, text, text, text, text
) to service_role;

-- Extend the bounded developer audit projection with one safe room-move
-- summary. Raw command state, request hashes, guest data, and PIN data remain
-- private.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_room_move;
revoke all on function private.list_developer_audit_events_before_room_move(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated, service_role;

create function public.list_developer_audit_events(
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
set search_path = pg_catalog, public, private
as $$
declare
  v_new_event constant text := 'reservation.room_moved';
  v_selected text[] := p_event_types;
  v_previous_selected text[];
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  perform private.assert_active_developer(p_actor_profile_id);
  if p_limit not between 1 and 100
    or v_from > v_to
    or v_to - v_from > interval '31 days'
    or (p_before_recorded_at is null) <> (p_before_id is null) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  if v_selected is null then
    v_previous_selected := null;
  else
    if cardinality(v_selected) = 0
      or cardinality(v_selected) > 68 then
      raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
    end if;
    select coalesce(array_agg(value), array[]::text[])
    into v_previous_selected
    from unnest(v_selected) value
    where value <> v_new_event;
  end if;

  return query
  select merged.*
  from (
    select previous.*
    from private.list_developer_audit_events_before_room_move(
      p_actor_profile_id,
      case
        when v_selected is null then null
        when cardinality(v_previous_selected) > 0 then v_previous_selected
        else array['account.created']::text[]
      end,
      p_filter_actor_profile_id,
      v_from,
      v_to,
      p_before_recorded_at,
      p_before_id,
      p_limit
    ) previous
    where v_selected is null or previous.event_type = any(v_selected)
    union all
    select
      audit.id,
      audit.event_type,
      audit.entity_type,
      audit.entity_id,
      audit.actor_profile_id,
      audit.actor_display_name_snapshot,
      audit.effective_at,
      audit.recorded_at,
      audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'mode', audit.after_state ->> 'mode',
        'reservationId', audit.after_state ->> 'reservationId',
        'reservationVersion', audit.after_state -> 'reservationVersion',
        'sourceRoomId', audit.after_state ->> 'sourceRoomId',
        'targetRoomId', audit.after_state ->> 'targetRoomId',
        'plannedCheckoutTargetId',
          audit.after_state ->> 'plannedCheckoutTargetId'
      ))
    from public.audit_events audit
    where audit.event_type = v_new_event
      and (v_selected is null or audit.event_type = any(v_selected))
      and audit.recorded_at >= v_from
      and audit.recorded_at <= v_to
      and (
        p_filter_actor_profile_id is null
        or audit.actor_profile_id = p_filter_actor_profile_id
      )
      and (
        p_before_recorded_at is null
        or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id)
      )
    order by recorded_at desc, id desc
    limit p_limit
  ) merged
  order by merged.recorded_at desc, merged.id desc
  limit p_limit;
end
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;

comment on function public.preview_reservation_room_move(
  uuid, uuid, uuid, bigint, bigint, bigint, timestamptz, text
) is 'Read-only five-minute BEFORE_CHECKIN room-move preview. DURING_STAY and non-private cleaning workflow return stable rejection codes.';
comment on function public.commit_reservation_room_move(
  uuid, uuid, uuid, bigint, bigint, bigint, timestamptz, timestamptz,
  timestamptz, text, text, text, text
) is 'Replay-safe BEFORE_CHECKIN room move preserving reservation identity, schedule, guest count, and the existing private planned checkout target.';
