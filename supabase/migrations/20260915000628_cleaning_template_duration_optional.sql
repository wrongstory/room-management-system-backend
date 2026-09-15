-- #165: checkout photo templates do not invent an expected cleaning duration.
-- Actual work duration is derived from attempt timestamps, while assignment
-- planning continues to use the separately confirmed duration-policy ledger.

alter table public.cleaning_template_versions
  alter column duration_minutes drop not null;

alter table public.cleaning_template_versions
  add constraint cleaning_template_duration_scope
  check (cleaning_kind = 'checkout' or duration_minutes is not null);

comment on column public.cleaning_template_versions.duration_minutes is
  'Optional legacy/planning metadata for checkout templates. Actual cleaning duration is derived from cleaning_attempts.started_at and field_completed_at; assignment preview uses assignment_duration_policy_versions.';

create or replace function public.publish_checkout_cleaning_template(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_type_code text,
  p_expected_version integer,
  p_duration_minutes integer,
  p_slots jsonb,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_room_type public.room_types%rowtype;
  v_current public.cleaning_template_versions%rowtype;
  v_template public.cleaning_template_versions%rowtype;
  v_template_id uuid := gen_random_uuid();
  v_current_version integer;
  v_next_version integer;
  v_max_version bigint;
  v_slots jsonb;
  v_snapshot jsonb;
  v_response jsonb;
begin
  v_actor := private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true);
  if p_room_type_code is null
    or p_room_type_code not in ('standard', 'premium', 'oceanPremium', 'oceanFamily')
    or p_expected_version is null or p_expected_version < 0
    or (p_duration_minutes is not null and p_duration_minutes not between 1 and 10080) then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE';
  end if;
  v_slots := private.normalized_checkout_template_slots(p_slots);

  v_response := private.replay_command(
    p_actor_profile_id,
    'cleaning_template.publish_checkout',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('cleaning-template:checkout:' || p_room_type_code, 0)
  );
  select * into v_room_type
  from public.room_types
  where code = p_room_type_code
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_TYPE_NOT_FOUND';
  end if;

  select * into v_current
  from public.cleaning_template_versions
  where room_type_id = v_room_type.id
    and cleaning_kind = 'checkout'
    and status = 'published'
  for update;
  v_current_version := case when found then v_current.version else 0 end;
  if v_current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'CLEANING_TEMPLATE_VERSION_CONFLICT';
  end if;

  select coalesce(max(version), 0)::bigint
  into v_max_version
  from public.cleaning_template_versions
  where room_type_id = v_room_type.id and cleaning_kind = 'checkout';
  if v_max_version >= 2147483647 then
    raise exception using errcode = '22003', message = 'CLEANING_TEMPLATE_VERSION_EXHAUSTED';
  end if;
  v_next_version := greatest(v_max_version + 1, 7)::integer;

  v_snapshot := jsonb_build_object(
    'templateVersionId', v_template_id,
    'version', v_next_version,
    'roomTypeCode', v_room_type.code,
    'cleaningKind', 'checkout',
    'slots', v_slots
  );
  if not private.photo_snapshot_valid(v_snapshot) then
    raise exception using errcode = '23514', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;

  update public.cleaning_template_versions
  set status = 'retired'
  where id = v_current.id;

  insert into public.cleaning_template_versions(
    id, room_type_id, cleaning_kind, version, status, duration_minutes,
    photo_slots, published_at, created_by
  ) values (
    v_template_id, v_room_type.id, 'checkout', v_next_version, 'published',
    p_duration_minutes, v_slots, statement_timestamp(), p_actor_profile_id
  ) returning * into v_template;

  if (select count(*) from private.photo_template_slots slot
      where slot.template_version_id = v_template.id) <> jsonb_array_length(v_slots)
    or exists (
      (select value from jsonb_array_elements(v_slots))
      except
      (select slot.slot_snapshot from private.photo_template_slots slot
       where slot.template_version_id = v_template.id)
    ) then
    raise exception using errcode = '23514', message = 'CLEANING_TEMPLATE_NORMALIZATION_FAILED';
  end if;

  v_response := private.checkout_cleaning_template_projection(v_room_type, v_template)
    -> 'currentPublished';
  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, idempotency_key
  ) values (
    p_actor_profile_id, v_actor.display_name, 'cleaning_template.published',
    'cleaning_template_version', v_template.id, v_template.published_at,
    jsonb_strip_nulls(jsonb_build_object(
      'roomTypeCode', v_room_type.code,
      'cleaningKind', 'checkout',
      'version', v_template.version,
      'durationMinutes', v_template.duration_minutes,
      'slotCount', jsonb_array_length(v_slots)
    )),
    private.audit_command_key(
      p_actor_profile_id,
      'cleaning_template.publish_checkout',
      p_idempotency_key
    )
  );
  perform private.complete_command(
    p_actor_profile_id,
    'cleaning_template.publish_checkout',
    p_idempotency_key,
    p_request_hash,
    v_template.id,
    v_response
  );
  return v_response;
end
$$;

revoke all on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) to service_role;

comment on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) is '#165 scoped CAS/idempotent immutable checkout photo-template publication. duration is optional and never inferred; actual work duration and assignment planning remain separate ledgers.';

-- Manual request creation is planning, not proof that another job has ended.
-- Compare only explicit target windows; an open-ended checkout must never be
-- converted into an invented one-minute interval. Actual execution is guarded
-- independently by current room work and checkout-presence state below.
create or replace function public.create_manual_cleaning_request(
  p_actor_profile_id uuid,
  p_target_id uuid,
  p_room_id uuid,
  p_reservation_id uuid,
  p_cleaning_kind public.cleaning_kind,
  p_service_date date,
  p_available_from timestamptz,
  p_due_at timestamptz,
  p_expected_room_version bigint,
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
  v_room public.rooms%rowtype;
  v_room_type public.room_types%rowtype;
  v_template public.cleaning_template_versions%rowtype;
  v_stay public.reservations%rowtype;
  v_target public.cleaning_targets%rowtype;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'cleaning.manual_request.create',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  if p_cleaning_kind not in ('stayover', 'additional')
    or (p_available_from at time zone 'Asia/Seoul')::date <> p_service_date
    or (p_due_at is not null and p_due_at <= p_available_from) then
    raise exception using errcode = '22023', message = 'INVALID_MANUAL_CLEANING_REQUEST';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  select * into v_room_type from public.room_types where id = v_room.room_type_id;
  select * into v_template
  from public.cleaning_template_versions t
  where t.room_type_id = v_room.room_type_id
    and t.cleaning_kind = p_cleaning_kind
    and t.status = 'published';
  if not found then
    raise exception using errcode = '23514', message = 'CLEANING_TEMPLATE_NOT_CONFIGURED';
  end if;

  if p_cleaning_kind = 'stayover' then
    select * into v_stay
    from public.reservations r
    where r.id = p_reservation_id
      and r.room_id = p_room_id
      and r.status = 'active'
      and r.actual_check_in_at is not null
      and r.actual_checkout_at is null
    for update;
    if not found then
      raise exception using errcode = '23514', message = 'ACTIVE_STAY_RESERVATION_REQUIRED';
    end if;
    if p_due_at is null
      or p_available_from < v_stay.actual_check_in_at
      or p_available_from >= p_due_at
      or p_due_at > v_stay.check_out_at then
      raise exception using errcode = '23514', message = 'STAYOVER_ACCESS_WINDOW_INVALID';
    end if;
  elsif p_reservation_id is not null and not exists (
    select 1 from public.reservations r
    where r.id = p_reservation_id and r.room_id = p_room_id
  ) then
    raise exception using errcode = '23514', message = 'RESERVATION_ROOM_MISMATCH';
  elsif exists (
    select 1
    from public.reservations r
    where r.room_id = p_room_id
      and r.status = 'active'
      and tstzrange(
        coalesce(r.actual_check_in_at, r.check_in_at),
        case
          when r.actual_check_in_at is not null and r.actual_checkout_at is null
            then 'infinity'::timestamptz
          else coalesce(r.actual_checkout_at, r.check_out_at)
        end,
        '[)'
      ) && tstzrange(
        p_available_from,
        coalesce(
          p_due_at,
          p_available_from + make_interval(mins => v_template.duration_minutes)
        ),
        '[)'
      )
  ) then
    raise exception using errcode = '23514', message = 'VACANT_ROOM_REQUIRED';
  end if;

  if exists (
    select 1
    from public.cleaning_targets t
    where t.room_id = p_room_id
      and t.status not in ('approved', 'cancelled')
      and t.available_from is not null
      and t.due_at is not null
      and tstzrange(t.available_from, t.due_at, '[)') && tstzrange(
        p_available_from,
        coalesce(
          p_due_at,
          p_available_from + make_interval(mins => v_template.duration_minutes)
        ),
        '[)'
      )
  ) then
    raise exception using errcode = '23P01', message = 'CLEANING_REQUEST_TIME_CONFLICT';
  end if;

  insert into public.cleaning_targets (
    id,
    room_id,
    reservation_id,
    cleaning_kind,
    source,
    source_key,
    original_service_date,
    effective_service_date,
    available_from,
    due_at,
    room_type_snapshot,
    fee_snapshot,
    template_snapshot,
    created_by
  ) values (
    p_target_id,
    p_room_id,
    p_reservation_id,
    p_cleaning_kind,
    case when p_cleaning_kind = 'stayover' then 'stayover_request' else 'manual_room_request' end,
    'manual-cleaning-request:' || p_target_id::text,
    p_service_date,
    p_service_date,
    p_available_from,
    p_due_at,
    jsonb_build_object(
      'id', v_room_type.id,
      'code', v_room_type.code,
      'name', v_room_type.name,
      'defaultDurationMinutes', v_room_type.default_duration_minutes
    ),
    v_room_type.base_cleaning_fee,
    jsonb_build_object(
      'id', v_template.id,
      'version', v_template.version,
      'durationMinutes', v_template.duration_minutes,
      'photoSlots', v_template.photo_slots
    ),
    p_actor_profile_id
  ) returning * into v_target;

  insert into public.cleaning_target_schedule_revisions (
    cleaning_target_id,
    revision,
    effective_service_date,
    available_from,
    due_at,
    reason_code,
    changed_by
  ) values (
    v_target.id,
    v_target.assignment_version,
    v_target.effective_service_date,
    v_target.available_from,
    v_target.due_at,
    p_reason_code,
    p_actor_profile_id
  );

  update public.rooms set state_version = state_version + 1 where id = p_room_id;

  v_response := jsonb_build_object(
    'id', v_target.id,
    'room_id', v_target.room_id,
    'reservation_id', v_target.reservation_id,
    'cleaning_kind', v_target.cleaning_kind,
    'status', v_target.status,
    'service_date', v_target.effective_service_date,
    'available_from', v_target.available_from,
    'due_at', v_target.due_at,
    'version', v_target.assignment_version
  );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'cleaning.manual_request.created',
    'cleaning_target',
    v_target.id,
    now(),
    p_reason_code,
    v_response,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'cleaning.manual_request.create',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'cleaning.manual_request.create',
    p_idempotency_key,
    p_request_hash,
    v_target.id,
    v_response
  );
  return v_response;
end;
$$;

-- The execution decision is state based. Unknown planned duration never grants
-- or denies execution; current same-room work and an unresolved #133 incident do.
create or replace function private.activation_reason_at(
  p_target public.cleaning_targets,
  p_assignment public.cleaning_assignments,
  p_command_at timestamptz
) returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_today date := (p_command_at at time zone 'Asia/Seoul')::date;
  v_comp public.complaint_compensation_decisions;
  v_case public.complaint_cases;
  v_decision public.complaint_decisions;
begin
  if p_target.status <> 'notified' then return 'ASSIGNMENT_NOT_NOTIFIED'; end if;
  if p_assignment.id is null or not p_assignment.is_current or p_assignment.notified_at is null then
    return 'ASSIGNMENT_NOT_NOTIFIED';
  end if;
  if p_assignment.cleaning_target_id is distinct from p_target.id
    or p_assignment.revision is distinct from p_target.assignment_version
    or p_assignment.service_date is distinct from p_target.effective_service_date
    or p_assignment.available_from_snapshot is distinct from p_target.available_from
    or p_assignment.due_at_snapshot is distinct from p_target.due_at then
    return 'ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if p_target.effective_service_date > v_today then return 'CLEANING_SERVICE_DATE_NOT_DUE'; end if;
  if p_target.effective_service_date < v_today then return 'CLEANING_SERVICE_DATE_EXPIRED'; end if;
  if p_target.available_from is null or p_target.available_from > p_command_at then return 'CLEANING_WINDOW_NOT_OPEN'; end if;
  if p_target.due_at is not null and p_target.due_at <= p_command_at then return 'CLEANING_WINDOW_EXPIRED'; end if;
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_assignment.maid_profile_id
      and profile.role = 'maid'
      and profile.status = 'active'
  ) then return 'ASSIGNMENT_MAID_UNAVAILABLE'; end if;

  if exists (
    select 1
    from public.checkout_presence_incidents incident
    where incident.room_id = p_target.room_id
      and incident.status = 'open'
  ) then return 'CHECKOUT_INCIDENT_OPEN'; end if;

  if exists (
    select 1
    from public.cleaning_attempts running_attempt
    join public.cleaning_targets running_target
      on running_target.id = running_attempt.cleaning_target_id
    where running_target.room_id = p_target.room_id
      and running_target.id <> p_target.id
      and running_attempt.status = 'in_progress'
  ) then return 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'; end if;

  if p_target.cleaning_kind = 'checkout' then
    if p_target.source not in ('scheduled_checkout', 'manual_checkout') or not exists (
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
    ) then return 'CHECKOUT_NOT_MATERIALIZED'; end if;
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
    ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  elsif p_target.source = 'manual_room_request' and p_target.cleaning_kind = 'additional' then
    if exists (
      select 1 from public.reservations reservation
      where reservation.room_id = p_target.room_id
        and reservation.status = 'active'
        and coalesce(reservation.actual_check_in_at, reservation.check_in_at) <= p_command_at
        and case
          when reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
            then 'infinity'::timestamptz
          else coalesce(reservation.actual_checkout_at, reservation.check_out_at)
        end > p_command_at
    ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
  elsif p_target.source = 'inspection_reclean' and p_target.cleaning_kind = 'reclean' then
    if p_target.fee_snapshot <> 0
      or p_target.reclean_of_attempt_id is null
      or p_target.reclean_maid_profile_id is distinct from p_assignment.maid_profile_id
      or not exists (
        select 1 from public.cleaning_attempts original_attempt
        where original_attempt.id = p_target.reclean_of_attempt_id
          and original_attempt.maid_profile_id = p_target.reclean_maid_profile_id
          and original_attempt.status = 'rejected'
      ) then return 'RECLEAN_MAID_IMMUTABLE'; end if;
  elsif p_target.source = 'post_approval_complaint_reclean' and p_target.cleaning_kind = 'reclean' then
    select * into v_comp
    from public.complaint_compensation_decisions
    where id = p_target.complaint_compensation_decision_id;
    select * into v_case from public.complaint_cases where id = v_comp.complaint_case_id;
    select * into v_decision from public.complaint_decisions where id = v_case.current_decision_id;
    if v_comp.id is null
      or v_case.current_compensation_decision_id is distinct from v_comp.id
      or v_comp.assignee_maid_profile_id is distinct from p_assignment.maid_profile_id
      or v_decision.finding <> 'confirmed'
      or not v_decision.rework_required
      or p_target.fee_snapshot <> 0 then
      return 'COMPLAINT_REWORK_DECISION_STALE';
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
      and previous_attempt.status in ('scheduled', 'in_progress', 'field_completed', 'upload_pending', 'submitted')
      and (
        coalesce(previous_target.available_from, '-infinity'::timestamptz),
        previous_target.created_at,
        previous_target.id
      ) < (
        coalesce(p_target.available_from, 'infinity'::timestamptz),
        p_target.created_at,
        p_target.id
      )
  ) then return 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'; end if;
  return null;
end
$$;
