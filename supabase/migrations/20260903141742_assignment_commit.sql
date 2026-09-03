create table private.notification_outbox (
  id bigint generated always as identity primary key,
  notification_id uuid not null
    references public.notifications(id) on delete restrict,
  channel text not null check (channel = 'web_push'),
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'processing', 'delivered', 'failed')),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_attempt_at timestamptz,
  delivered_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  unique (notification_id, channel),
  check (
    (delivery_status = 'delivered' and delivered_at is not null)
    or (delivery_status <> 'delivered' and delivered_at is null)
  )
);

alter table private.notification_outbox enable row level security;

create index notification_outbox_pending_idx
on private.notification_outbox (next_attempt_at, id)
where delivery_status = 'pending';

revoke all on table private.notification_outbox from public, anon, authenticated;
revoke all on sequence private.notification_outbox_id_seq from public, anon, authenticated;
grant select, insert, update on table private.notification_outbox to service_role;
grant usage, select on sequence private.notification_outbox_id_seq to service_role;

create function private.prevent_notified_assignment_unavailability()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not new.available and exists (
    select 1
    from public.availability_versions version
    join public.cleaning_assignments assignment
      on assignment.maid_profile_id = version.maid_profile_id
      and assignment.service_date = new.work_date
      and assignment.is_current
      and assignment.notified_at is not null
    join public.cleaning_targets target
      on target.id = assignment.cleaning_target_id
      and target.status = 'notified'
    where version.id = new.availability_version_id
      and version.is_current
      and version.status = 'submitted'
  ) then
    raise exception using
      errcode = '40001',
      message = 'ASSIGNMENT_AVAILABILITY_STALE';
  end if;
  return new;
end;
$$;

revoke all on function private.prevent_notified_assignment_unavailability()
from public, anon, authenticated;

create trigger availability_days_protect_notified_assignments
before insert or update of available, work_date, availability_version_id
on public.availability_days
for each row execute function private.prevent_notified_assignment_unavailability();

create function private.assignment_commit_candidates_at(
  p_service_date date,
  p_command_at timestamptz
)
returns table (
  target_id uuid,
  room_id uuid,
  room_number text,
  target_assignment_version bigint,
  target_status public.cleaning_target_status,
  target_available_from timestamptz,
  target_due_at timestamptz,
  assignment_id uuid,
  maid_profile_id uuid,
  maid_display_name text,
  assignment_service_date date,
  sequence_number integer,
  assignment_revision bigint,
  assignment_available_from timestamptz,
  assignment_due_at timestamptz,
  assignment_notified_at timestamptz,
  availability_version integer,
  availability_day_available boolean,
  reason_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    target.id,
    target.room_id,
    room.room_number,
    target.assignment_version,
    target.status,
    target.available_from,
    target.due_at,
    assignment.id,
    assignment.maid_profile_id,
    maid.display_name,
    assignment.service_date,
    assignment.sequence_number,
    assignment.revision,
    assignment.available_from_snapshot,
    assignment.due_at_snapshot,
    assignment.notified_at,
    availability.version,
    day.available,
    case
      when target.status = 'unassigned' then null
      when p_service_date not in (
        (p_command_at at time zone 'Asia/Seoul')::date,
        (p_command_at at time zone 'Asia/Seoul')::date + 1
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when assignment.id is null or assignment.notified_at is not null
        then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when assignment.revision <> target.assignment_version
        or assignment.service_date <> target.effective_service_date
        or assignment.service_date <> p_service_date
        or assignment.available_from_snapshot is distinct from target.available_from
        or assignment.due_at_snapshot is distinct from target.due_at
        then 'ASSIGNMENT_DRAFT_STALE_SCHEDULE'
      when exists (
        select 1
        from public.cleaning_attempts attempt
        where attempt.cleaning_target_id = target.id
          and attempt.status <> 'superseded'
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when maid.id is null or maid.role <> 'maid' or maid.status <> 'active'
        then 'ASSIGNMENT_MAID_UNAVAILABLE'
      when availability.id is null then 'ASSIGNMENT_AVAILABILITY_REQUIRED'
      when day.available is distinct from true then 'ASSIGNMENT_MAID_UNAVAILABLE'
      when target.due_at is not null and target.due_at <= p_command_at
        then 'ASSIGNMENT_WINDOW_EXPIRED'
      when target.source in ('scheduled_checkout', 'manual_checkout') and not exists (
        select 1
        from public.reservations reservation
        join public.checkout_cleaning_obligations obligation
          on obligation.id = target.checkout_obligation_id
          and obligation.reservation_id = reservation.id
          and obligation.room_id = reservation.room_id
        where reservation.id = target.reservation_id
          and reservation.room_id = target.room_id
          and reservation.status = 'checked_out'
          and reservation.actual_checkout_at is not null
          and obligation.status = 'materialized'
          and obligation.current_cleaning_target_id = target.id
          and obligation.effective_service_date = target.effective_service_date
          and obligation.available_from is not distinct from target.available_from
          and obligation.due_at is not distinct from target.due_at
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source = 'stayover_request' and not exists (
        select 1
        from public.reservations reservation
        where reservation.id = target.reservation_id
          and reservation.room_id = target.room_id
          and reservation.status = 'active'
          and reservation.actual_check_in_at is not null
          and reservation.actual_checkout_at is null
          and target.cleaning_kind = 'stayover'
          and target.available_from is not null
          and target.due_at is not null
          and target.available_from >= reservation.actual_check_in_at
          and target.due_at <= reservation.check_out_at
          and target.available_from < target.due_at
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source = 'manual_room_request' and (
        target.cleaning_kind <> 'additional'
        or target.available_from is null
        or exists (
          select 1
          from public.reservations reservation
          where reservation.room_id = target.room_id
            and reservation.status = 'active'
            and tstzrange(
              coalesce(reservation.actual_check_in_at, reservation.check_in_at),
              case
                when reservation.actual_check_in_at is not null
                  and reservation.actual_checkout_at is null
                  then 'infinity'::timestamptz
                else coalesce(reservation.actual_checkout_at, reservation.check_out_at)
              end,
              '[)'
            ) && tstzrange(
              target.available_from,
              coalesce(
                target.due_at,
                target.available_from + make_interval(
                  mins => coalesce(
                    nullif(target.template_snapshot ->> 'durationMinutes', '')::integer,
                    1
                  )
                )
              ),
              '[)'
            )
        )
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source = 'inspection_reclean' and (
        target.cleaning_kind <> 'reclean'
        or target.reclean_of_attempt_id is null
        or target.reclean_maid_profile_id is distinct from assignment.maid_profile_id
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source not in (
        'scheduled_checkout',
        'manual_checkout',
        'stayover_request',
        'manual_room_request',
        'inspection_reclean'
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      else null
    end
  from public.cleaning_targets target
  join public.rooms room on room.id = target.room_id
  left join public.cleaning_assignments assignment
    on assignment.cleaning_target_id = target.id
    and assignment.is_current
  left join public.profiles maid on maid.id = assignment.maid_profile_id
  left join lateral (
    select version_row.*
    from public.availability_versions version_row
    where version_row.maid_profile_id = assignment.maid_profile_id
      and version_row.week_start = p_service_date
        - (extract(isodow from p_service_date)::integer - 1)
      and version_row.is_current
      and version_row.status = 'submitted'
    limit 1
  ) availability on true
  left join public.availability_days day
    on day.availability_version_id = availability.id
    and day.work_date = p_service_date
  where target.effective_service_date = p_service_date
    and target.status in ('unassigned', 'draft_assigned')
$$;

revoke all on function private.assignment_commit_candidates_at(date, timestamptz)
from public, anon, authenticated;

create function private.assignment_commit_impact_at(
  p_service_date date,
  p_command_at timestamptz
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_fingerprint_payload jsonb;
  v_fingerprint text;
  v_committable jsonb;
  v_blocked jsonb;
  v_unassigned jsonb;
begin
  if p_service_date is null or p_command_at is null then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
  end if;

  select
    coalesce(jsonb_agg(jsonb_build_object(
      'cleaningTargetId', candidate.target_id,
      'targetAssignmentVersion', candidate.target_assignment_version,
      'targetStatus', candidate.target_status,
      'availableFrom', candidate.target_available_from,
      'dueAt', candidate.target_due_at,
      'assignmentId', candidate.assignment_id,
      'revision', candidate.assignment_revision,
      'maidProfileId', candidate.maid_profile_id,
      'availabilityVersion', candidate.availability_version,
      'available', candidate.availability_day_available,
      'reasonCode', candidate.reason_code
    ) order by candidate.target_id), '[]'::jsonb)
  into v_fingerprint_payload
  from private.assignment_commit_candidates_at(p_service_date, p_command_at) candidate;

  v_fingerprint := encode(
    extensions.digest(
      jsonb_build_object(
        'serviceDate', p_service_date,
        'items', v_fingerprint_payload
      )::text,
      'sha256'
    ),
    'hex'
  );

  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', candidate.assignment_id,
    'cleaningTargetId', candidate.target_id,
    'roomId', candidate.room_id,
    'roomNumber', candidate.room_number,
    'maidProfileId', candidate.maid_profile_id,
    'maidDisplayName', candidate.maid_display_name,
    'serviceDate', candidate.assignment_service_date,
    'sequenceNumber', candidate.sequence_number,
    'revision', candidate.assignment_revision,
    'targetAssignmentVersion', candidate.target_assignment_version,
    'expectedAvailabilityVersion', candidate.availability_version,
    'availableFrom', candidate.assignment_available_from,
    'dueAt', candidate.assignment_due_at
  ) order by candidate.sequence_number, candidate.target_id), '[]'::jsonb)
  into v_committable
  from private.assignment_commit_candidates_at(p_service_date, p_command_at) candidate
  where candidate.target_status = 'draft_assigned'
    and candidate.reason_code is null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'assignmentId', candidate.assignment_id,
    'cleaningTargetId', candidate.target_id,
    'roomId', candidate.room_id,
    'roomNumber', candidate.room_number,
    'maidProfileId', candidate.maid_profile_id,
    'maidDisplayName', candidate.maid_display_name,
    'serviceDate', p_service_date,
    'sequenceNumber', candidate.sequence_number,
    'revision', candidate.assignment_revision,
    'targetAssignmentVersion', candidate.target_assignment_version,
    'currentAvailabilityVersion', candidate.availability_version,
    'reasonCodes', jsonb_build_array(candidate.reason_code),
    'availableFrom', candidate.target_available_from,
    'dueAt', candidate.target_due_at
  ) order by candidate.sequence_number nulls last, candidate.target_id), '[]'::jsonb)
  into v_blocked
  from private.assignment_commit_candidates_at(p_service_date, p_command_at) candidate
  where candidate.target_status = 'draft_assigned'
    and candidate.reason_code is not null;

  select coalesce(jsonb_agg(jsonb_build_object(
    'cleaningTargetId', candidate.target_id,
    'roomId', candidate.room_id,
    'roomNumber', candidate.room_number,
    'serviceDate', p_service_date,
    'status', candidate.target_status,
    'targetAssignmentVersion', candidate.target_assignment_version,
    'availableFrom', candidate.target_available_from,
    'dueAt', candidate.target_due_at
  ) order by candidate.room_number, candidate.target_id), '[]'::jsonb)
  into v_unassigned
  from private.assignment_commit_candidates_at(p_service_date, p_command_at) candidate
  where candidate.target_status = 'unassigned';

  return jsonb_build_object(
    'serviceDate', p_service_date,
    'impactFingerprint', v_fingerprint,
    'committableDrafts', v_committable,
    'blockedDrafts', v_blocked,
    'remainingUnassignedTargets', v_unassigned
  );
end;
$$;

revoke all on function private.assignment_commit_impact_at(date, timestamptz)
from public, anon, authenticated;

create function public.get_assignment_commit_impact(
  p_actor_profile_id uuid,
  p_service_date date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.assert_room_admin(p_actor_profile_id);
  return private.assignment_commit_impact_at(p_service_date, clock_timestamp());
end;
$$;

create function private.commit_and_notify_assignments_at(
  p_actor_profile_id uuid,
  p_service_date date,
  p_expected_impact_fingerprint text,
  p_items jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_command_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
  v_impact jsonb;
  v_after_impact jsonb;
  v_item jsonb;
  v_candidate record;
  v_lock record;
  v_notification_id uuid;
  v_notified jsonb := '[]'::jsonb;
  v_week_start date;
begin
  perform private.assert_room_admin(p_actor_profile_id);

  if p_command_at is null
    or p_service_date not in (
      (p_command_at at time zone 'Asia/Seoul')::date,
      (p_command_at at time zone 'Asia/Seoul')::date + 1
    ) then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
  end if;
  if p_expected_impact_fingerprint is null
    or p_expected_impact_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_IMPACT_INVALID';
  end if;
  if jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 121 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_ITEMS_INVALID';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) <> 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(item) key)
        <> array[
          'cleaningTargetId',
          'expectedAssignmentVersion',
          'expectedAvailabilityVersion'
        ]::text[]
      or jsonb_typeof(item -> 'cleaningTargetId') <> 'string'
      or (item ->> 'cleaningTargetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item -> 'expectedAssignmentVersion') <> 'number'
      or (item ->> 'expectedAssignmentVersion') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(item -> 'expectedAvailabilityVersion') <> 'number'
      or (item ->> 'expectedAvailabilityVersion') !~ '^[1-9][0-9]*$'
  ) then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_ITEMS_INVALID';
  end if;
  if (
    select count(*) <> count(distinct item ->> 'cleaningTargetId')
    from jsonb_array_elements(p_items) item
  ) then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_ITEMS_DUPLICATED';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id,
    'assignment.commit_notify',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'assignment-commit:' || p_service_date::text,
    0
  ));

  for v_lock in
    select target.id
    from public.cleaning_targets target
    where target.effective_service_date = p_service_date
      and target.status in ('unassigned', 'draft_assigned')
    order by target.id
    for update
  loop
    null;
  end loop;

  for v_lock in
    select assignment.id
    from public.cleaning_assignments assignment
    join public.cleaning_targets target
      on target.id = assignment.cleaning_target_id
    where target.effective_service_date = p_service_date
      and target.status = 'draft_assigned'
      and assignment.is_current
    order by assignment.cleaning_target_id
    for update of assignment
  loop
    null;
  end loop;

  v_week_start := p_service_date
    - (extract(isodow from p_service_date)::integer - 1);
  for v_lock in
    select distinct assignment.maid_profile_id
    from public.cleaning_assignments assignment
    join public.cleaning_targets target
      on target.id = assignment.cleaning_target_id
    where target.effective_service_date = p_service_date
      and target.status = 'draft_assigned'
      and assignment.is_current
    order by assignment.maid_profile_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'availability:' || v_lock.maid_profile_id::text || ':' || v_week_start::text,
      0
    ));
    perform 1
    from public.availability_versions availability
    where availability.maid_profile_id = v_lock.maid_profile_id
      and availability.week_start = v_week_start
      and availability.is_current
    for update;
  end loop;

  v_impact := private.assignment_commit_impact_at(p_service_date, p_command_at);
  if v_impact ->> 'impactFingerprint' <> p_expected_impact_fingerprint then
    raise exception using errcode = '40001', message = 'ASSIGNMENT_IMPACT_CHANGED';
  end if;

  for v_item in
    select item
    from jsonb_array_elements(p_items) item
    order by item ->> 'cleaningTargetId'
  loop
    select * into v_candidate
    from private.assignment_commit_candidates_at(p_service_date, p_command_at) candidate
    where candidate.target_id = (v_item ->> 'cleaningTargetId')::uuid;

    if not found or v_candidate.target_status <> 'draft_assigned' then
      raise exception using errcode = '23514', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
    end if;
    if v_candidate.reason_code is not null then
      raise exception using errcode = '23514', message = v_candidate.reason_code;
    end if;
    if v_candidate.target_assignment_version
      <> (v_item ->> 'expectedAssignmentVersion')::bigint then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
    end if;
    if v_candidate.availability_version
      <> (v_item ->> 'expectedAvailabilityVersion')::integer then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_AVAILABILITY_STALE';
    end if;

    update public.cleaning_assignments assignment
    set notified_at = p_command_at
    where assignment.id = v_candidate.assignment_id
      and assignment.is_current
      and assignment.notified_at is null;
    if not found then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
    end if;

    update public.cleaning_targets target
    set status = 'notified'
    where target.id = v_candidate.target_id
      and target.status = 'draft_assigned'
      and target.assignment_version = v_candidate.target_assignment_version;
    if not found then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
    end if;

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
      v_candidate.maid_profile_id,
      'cleaning_assignment_notified',
      format('%s호 청소 배정', v_candidate.room_number),
      format(
        '%s · %s번째 청소가 배정되었습니다.',
        p_service_date,
        v_candidate.sequence_number
      ),
      v_candidate.room_id,
      v_candidate.target_id,
      'assignment-notified:' || v_candidate.assignment_id::text
        || ':' || v_candidate.assignment_revision::text,
      true,
      p_command_at
    ) returning id into v_notification_id;

    insert into private.notification_outbox (
      notification_id,
      channel,
      delivery_status,
      next_attempt_at,
      created_at
    ) values (
      v_notification_id,
      'web_push',
      'pending',
      p_command_at,
      p_command_at
    );

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      actor.id,
      actor.display_name,
      'assignment.notified',
      'cleaning_assignment',
      v_candidate.assignment_id,
      p_command_at,
      jsonb_build_object(
        'cleaningTargetId', v_candidate.target_id,
        'assignmentId', v_candidate.assignment_id,
        'maidProfileId', v_candidate.maid_profile_id,
        'serviceDate', p_service_date,
        'sequenceNumber', v_candidate.sequence_number,
        'revision', v_candidate.assignment_revision
      ),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'assignment.commit_notify.' || v_candidate.assignment_id::text,
        p_idempotency_key
      )
    from public.profiles actor
    where actor.id = p_actor_profile_id;

    v_notified := v_notified || jsonb_build_array(jsonb_build_object(
      'assignmentId', v_candidate.assignment_id,
      'cleaningTargetId', v_candidate.target_id,
      'roomId', v_candidate.room_id,
      'roomNumber', v_candidate.room_number,
      'maidProfileId', v_candidate.maid_profile_id,
      'maidDisplayName', v_candidate.maid_display_name,
      'serviceDate', p_service_date,
      'sequenceNumber', v_candidate.sequence_number,
      'revision', v_candidate.assignment_revision,
      'targetAssignmentVersion', v_candidate.target_assignment_version,
      'expectedAvailabilityVersion', v_candidate.availability_version,
      'availableFrom', v_candidate.assignment_available_from,
      'dueAt', v_candidate.assignment_due_at,
      'notifiedAt', p_command_at
    ));
  end loop;

  v_after_impact := private.assignment_commit_impact_at(p_service_date, p_command_at);
  v_response := jsonb_build_object(
    'serviceDate', p_service_date,
    'notifiedAssignments', v_notified,
    'remainingDrafts', v_after_impact -> 'committableDrafts',
    'blockedDrafts', v_after_impact -> 'blockedDrafts',
    'unassignedTargets', v_after_impact -> 'remainingUnassignedTargets',
    'impactFingerprint', v_after_impact ->> 'impactFingerprint'
  );

  perform private.complete_command(
    p_actor_profile_id,
    'assignment.commit_notify',
    p_idempotency_key,
    p_request_hash,
    null,
    v_response
  );
  return v_response;
end;
$$;

revoke all on function private.commit_and_notify_assignments_at(
  uuid, date, text, jsonb, text, text, timestamptz
) from public, anon, authenticated;

create function public.commit_and_notify_assignments(
  p_actor_profile_id uuid,
  p_service_date date,
  p_expected_impact_fingerprint text,
  p_items jsonb,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.commit_and_notify_assignments_at(
    p_actor_profile_id,
    p_service_date,
    p_expected_impact_fingerprint,
    p_items,
    p_idempotency_key,
    p_request_hash,
    clock_timestamp()
  )
$$;

revoke all on function public.get_assignment_commit_impact(uuid, date)
from public, anon, authenticated;
revoke all on function public.commit_and_notify_assignments(
  uuid, date, text, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.get_assignment_commit_impact(uuid, date)
to service_role;
grant execute on function public.commit_and_notify_assignments(
  uuid, date, text, jsonb, text, text
) to service_role;

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
    'account.bootstrap_developer_created',
    'account.bootstrap_admin_created',
    'account.created',
    'account.role_changed',
    'account.status_changed',
    'account.unlocked',
    'account.password_reset_requested',
    'account.password_changed',
    'availability.submitted',
    'availability.change_requested',
    'availability.change_decided',
    'assignment.draft_saved',
    'assignment.notified',
    'reservation.created',
    'reservation.changed',
    'reservation.cancelled',
    'reservation.manual_checkout',
    'reservation.scheduled_check_in',
    'reservation.scheduled_checkout',
    'reservation.guest_name_retention_purged',
    'cleaning.manual_request.created',
    'cleaning.manual_request.cancelled',
    'room.master_data_changed',
    'room.create_block',
    'room.release_block',
    'room.set_candle_count',
    'room.report_issue',
    'room.resolve_issue',
    'room.record_pin_sync'
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
    or coalesce(cardinality(v_selected), 0) not between 1 and 29
    or exists (
      select 1 from unnest(v_selected) requested
      where not requested = any (v_allowed)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  return query
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
    case
      when audit.event_type like 'account.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'displayName', audit.after_state ->> 'displayName',
          'loginId', audit.after_state ->> 'loginId',
          'role', audit.after_state ->> 'role',
          'status', audit.after_state ->> 'status',
          'mustChangePassword', audit.after_state -> 'mustChangePassword'
        ))
      when audit.event_type like 'availability.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'maidProfileId', audit.after_state ->> 'maidProfileId',
          'weekStart', audit.after_state ->> 'weekStart',
          'version', audit.after_state -> 'version',
          'sourceVersion', audit.after_state -> 'sourceVersion',
          'status', audit.after_state ->> 'status',
          'approvedVersionId', audit.after_state ->> 'approvedVersionId'
        ))
      when audit.event_type = 'assignment.draft_saved' then
        jsonb_strip_nulls(jsonb_build_object(
          'cleaningTargetId', audit.after_state ->> 'cleaningTargetId',
          'maidProfileId', audit.after_state ->> 'maidProfileId',
          'serviceDate', audit.after_state ->> 'serviceDate',
          'sequenceNumber', audit.after_state -> 'sequenceNumber',
          'revision', audit.after_state -> 'revision',
          'targetAssignmentVersion', audit.after_state -> 'targetAssignmentVersion'
        ))
      when audit.event_type = 'assignment.notified' then
        jsonb_strip_nulls(jsonb_build_object(
          'cleaningTargetId', audit.after_state ->> 'cleaningTargetId',
          'assignmentId', audit.after_state ->> 'assignmentId',
          'maidProfileId', audit.after_state ->> 'maidProfileId',
          'serviceDate', audit.after_state ->> 'serviceDate',
          'sequenceNumber', audit.after_state -> 'sequenceNumber',
          'revision', audit.after_state -> 'revision'
        ))
      when audit.event_type like 'reservation.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', audit.after_state ->> 'room_id',
          'status', audit.after_state ->> 'status',
          'version', audit.after_state -> 'version',
          'checkInAt', audit.after_state ->> 'check_in_at',
          'checkOutAt', audit.after_state ->> 'check_out_at',
          'purgedCount', audit.after_state -> 'purged_count'
        ))
      when audit.event_type like 'cleaning.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', audit.after_state ->> 'room_id',
          'reservationId', audit.after_state ->> 'reservation_id',
          'cleaningKind', audit.after_state ->> 'cleaning_kind',
          'status', audit.after_state ->> 'status',
          'serviceDate', audit.after_state ->> 'service_date',
          'availableFrom', audit.after_state ->> 'available_from',
          'dueAt', audit.after_state ->> 'due_at',
          'version', audit.after_state -> 'version'
        ))
      when audit.event_type like 'room.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomTypeId', audit.after_state ->> 'roomTypeId',
          'elevatorZone', audit.after_state ->> 'elevatorZone',
          'dataStatus', audit.after_state ->> 'dataStatus',
          'stateVersion', audit.after_state -> 'stateVersion',
          'blockId', audit.after_state ->> 'blockId',
          'active', audit.after_state -> 'active',
          'count', audit.after_state -> 'count',
          'issueId', audit.after_state ->> 'issueId',
          'category', audit.after_state ->> 'category',
          'severity', audit.after_state ->> 'severity',
          'blocksGuestAssignment', audit.after_state -> 'blocksGuestAssignment',
          'status', audit.after_state ->> 'status',
          'pinSyncEventId', audit.after_state ->> 'pinSyncEventId',
          'syncStatus', audit.after_state ->> 'syncStatus',
          'pinVersion', audit.after_state -> 'pinVersion'
        ))
      else '{}'::jsonb
    end
  from public.audit_events audit
  where audit.event_type = any (v_selected)
    and audit.recorded_at >= v_from
    and audit.recorded_at <= v_to
    and (p_filter_actor_profile_id is null
      or audit.actor_profile_id = p_filter_actor_profile_id)
    and (
      p_before_recorded_at is null
      or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id)
    )
  order by audit.recorded_at desc, audit.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;
