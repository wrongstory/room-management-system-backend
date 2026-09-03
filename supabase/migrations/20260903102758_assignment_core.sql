alter table public.cleaning_assignments
  add column service_date date,
  add column available_from_snapshot timestamptz,
  add column due_at_snapshot timestamptz;

update public.cleaning_assignments a
set service_date = t.effective_service_date,
    available_from_snapshot = t.available_from,
    due_at_snapshot = t.due_at
from public.cleaning_targets t
where t.id = a.cleaning_target_id;

alter table public.cleaning_assignments
  alter column service_date set not null,
  add constraint cleaning_assignments_snapshot_window_check check (
    due_at_snapshot is null
    or available_from_snapshot is null
    or due_at_snapshot >= available_from_snapshot
  );

create unique index cleaning_assignments_current_maid_date_sequence
on public.cleaning_assignments (maid_profile_id, service_date, sequence_number)
where is_current;

create index cleaning_assignments_service_date_current_idx
on public.cleaning_assignments (service_date, is_current, maid_profile_id);

alter table private.actor_authorization_denial_aggregates
  drop constraint actor_authorization_denial_aggregates_source_check,
  drop constraint actor_authorization_denial_aggregates_reason_code_check,
  add constraint actor_authorization_denial_aggregates_source_check check (
    source in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
  ),
  add constraint actor_authorization_denial_aggregates_reason_code_check check (
    reason_code in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    )
  );

create or replace function public.record_authorization_denial(
  p_actor_profile_id uuid,
  p_source text,
  p_reason_code text,
  p_occurred_at timestamptz default clock_timestamp()
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles%rowtype;
  v_bucket timestamptz;
begin
  if p_occurred_at is null
    or abs(extract(epoch from (clock_timestamp() - p_occurred_at))) > 300
    or p_source not in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'AVAILABILITY_ACCESS_REQUIRED',
      'DEVELOPER_REQUIRED',
      'MAID_REQUIRED',
      'PASSWORD_CHANGE_REQUIRED'
    ) then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_EVENT';
  end if;

  select * into v_profile
  from public.profiles profile
  where profile.id = p_actor_profile_id
    and profile.status = 'active';
  if not found then
    raise exception using errcode = '22023', message = 'INVALID_ACTIVITY_ACTOR';
  end if;

  v_bucket := date_trunc('minute', p_occurred_at);

  insert into private.actor_authorization_denial_aggregates (
    actor_profile_id,
    actor_role_snapshot,
    category,
    event_type,
    outcome,
    source,
    reason_code,
    bucket_started_at,
    occurrence_count,
    first_occurred_at,
    last_occurred_at
  ) values (
    v_profile.id,
    v_profile.role,
    'authorization',
    'authorization.denied',
    'denied',
    p_source,
    p_reason_code,
    v_bucket,
    1,
    p_occurred_at,
    p_occurred_at
  )
  on conflict (actor_profile_id, source, reason_code, bucket_started_at)
  do update set
    occurrence_count = least(
      private.actor_authorization_denial_aggregates.occurrence_count + 1,
      600
    ),
    last_occurred_at = greatest(
      private.actor_authorization_denial_aggregates.last_occurred_at,
      excluded.last_occurred_at
    );

  delete from private.actor_authorization_denial_aggregates aggregate
  where aggregate.id in (
    select expired.id
    from private.actor_authorization_denial_aggregates expired
    where expired.bucket_started_at < v_bucket - interval '31 days'
    order by expired.bucket_started_at
    limit 64
  );
end;
$$;

revoke all on function public.record_authorization_denial(uuid, text, text, timestamptz)
from public, anon, authenticated;
grant execute on function public.record_authorization_denial(uuid, text, text, timestamptz)
to service_role;

create function private.enforce_cleaning_assignment_snapshot()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  v_target public.cleaning_targets%rowtype;
begin
  if tg_op = 'UPDATE' then
    if new.cleaning_target_id is distinct from old.cleaning_target_id
      or new.maid_profile_id is distinct from old.maid_profile_id
      or new.sequence_number is distinct from old.sequence_number
      or new.revision is distinct from old.revision
      or new.service_date is distinct from old.service_date
      or new.available_from_snapshot is distinct from old.available_from_snapshot
      or new.due_at_snapshot is distinct from old.due_at_snapshot
      or new.changed_by is distinct from old.changed_by
      or new.created_at is distinct from old.created_at then
      raise exception using
        errcode = '23514',
        message = 'ASSIGNMENT_SNAPSHOT_IMMUTABLE';
    end if;
    return new;
  end if;

  select * into v_target
  from public.cleaning_targets t
  where t.id = new.cleaning_target_id;

  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_TARGET_NOT_FOUND';
  end if;

  -- Older server commands predate the snapshot columns. The trigger fills omitted
  -- values while still rejecting any caller-supplied snapshot that disagrees.
  if new.service_date is null then
    new.service_date := v_target.effective_service_date;
  end if;
  if new.available_from_snapshot is null then
    new.available_from_snapshot := v_target.available_from;
  end if;
  if new.due_at_snapshot is null then
    new.due_at_snapshot := v_target.due_at;
  end if;

  if new.service_date is distinct from v_target.effective_service_date
    or new.available_from_snapshot is distinct from v_target.available_from
    or new.due_at_snapshot is distinct from v_target.due_at then
    raise exception using
      errcode = '23514',
      message = 'ASSIGNMENT_SNAPSHOT_MISMATCH';
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_cleaning_assignment_snapshot()
from public, anon, authenticated;

create trigger cleaning_assignments_enforce_snapshot
before insert or update on public.cleaning_assignments
for each row execute function private.enforce_cleaning_assignment_snapshot();

create function public.save_cleaning_assignment_draft(
  p_actor_profile_id uuid,
  p_cleaning_target_id uuid,
  p_maid_profile_id uuid,
  p_sequence_number integer,
  p_expected_assignment_version bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_target public.cleaning_targets%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
  v_revision bigint;
begin
  perform private.assert_room_admin(p_actor_profile_id);

  if p_sequence_number is null or p_sequence_number <= 0 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_SEQUENCE_INVALID';
  end if;
  if p_expected_assignment_version is null or p_expected_assignment_version <= 0 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_VERSION_INVALID';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id,
    'assignment.save_draft',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  select * into v_target
  from public.cleaning_targets t
  where t.id = p_cleaning_target_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_TARGET_NOT_FOUND';
  end if;
  if v_target.status not in ('unassigned', 'draft_assigned') then
    raise exception using errcode = '23514', message = 'ASSIGNMENT_TARGET_STATE_INVALID';
  end if;
  if v_target.assignment_version <> p_expected_assignment_version then
    raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_maid_profile_id
      and p.role = 'maid'
      and p.status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_MAID_REQUIRED';
  end if;

  v_revision := v_target.assignment_version + 1;

  update public.cleaning_assignments a
  set is_current = false,
      ended_at = v_now,
      change_reason_code = 'DRAFT_REVISED'
  where a.cleaning_target_id = p_cleaning_target_id
    and a.is_current;

  insert into public.cleaning_assignments (
    cleaning_target_id,
    maid_profile_id,
    service_date,
    sequence_number,
    revision,
    is_current,
    available_from_snapshot,
    due_at_snapshot,
    changed_by,
    created_at
  ) values (
    p_cleaning_target_id,
    p_maid_profile_id,
    v_target.effective_service_date,
    p_sequence_number,
    v_revision,
    true,
    v_target.available_from,
    v_target.due_at,
    p_actor_profile_id,
    v_now
  )
  returning * into v_assignment;

  update public.cleaning_targets
  set status = 'draft_assigned',
      assignment_version = v_revision
  where id = p_cleaning_target_id;

  select jsonb_build_object(
    'assignmentId', v_assignment.id,
    'cleaningTargetId', v_assignment.cleaning_target_id,
    'roomId', t.room_id,
    'roomNumber', r.room_number,
    'maidProfileId', v_assignment.maid_profile_id,
    'maidDisplayName', maid.display_name,
    'serviceDate', v_assignment.service_date,
    'sequenceNumber', v_assignment.sequence_number,
    'revision', v_assignment.revision,
    'isCurrent', v_assignment.is_current,
    'targetAssignmentVersion', v_revision,
    'availableFrom', v_assignment.available_from_snapshot,
    'dueAt', v_assignment.due_at_snapshot,
    'notifiedAt', v_assignment.notified_at,
    'endedAt', v_assignment.ended_at,
    'createdAt', v_assignment.created_at
  ) into v_response
  from public.cleaning_targets t
  join public.rooms r on r.id = t.room_id
  join public.profiles maid on maid.id = v_assignment.maid_profile_id
  where t.id = v_assignment.cleaning_target_id;

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
    'assignment.draft_saved',
    'cleaning_assignment',
    v_assignment.id,
    v_now,
    jsonb_build_object(
      'cleaningTargetId', v_assignment.cleaning_target_id,
      'maidProfileId', v_assignment.maid_profile_id,
      'serviceDate', v_assignment.service_date,
      'sequenceNumber', v_assignment.sequence_number,
      'revision', v_assignment.revision,
      'targetAssignmentVersion', v_revision,
      'requestHash', p_request_hash
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'assignment.save_draft',
      p_idempotency_key
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'assignment.save_draft',
    p_idempotency_key,
    p_request_hash,
    v_assignment.id,
    v_response
  );

  return v_response;
end;
$$;

revoke all on function public.save_cleaning_assignment_draft(
  uuid, uuid, uuid, integer, bigint, text, text
) from public, anon, authenticated;
grant execute on function public.save_cleaning_assignment_draft(
  uuid, uuid, uuid, integer, bigint, text, text
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
    or coalesce(cardinality(v_selected), 0) not between 1 and 28
    or exists (
      select 1 from unnest(v_selected) requested
      where not requested = any (v_allowed)
    ) then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;

  return query
  select
    ae.id,
    ae.event_type,
    ae.entity_type,
    ae.entity_id,
    ae.actor_profile_id,
    ae.actor_display_name_snapshot,
    ae.effective_at,
    ae.recorded_at,
    ae.reason_code,
    case
      when ae.event_type like 'account.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'displayName', ae.after_state ->> 'displayName',
          'loginId', ae.after_state ->> 'loginId',
          'role', ae.after_state ->> 'role',
          'status', ae.after_state ->> 'status',
          'mustChangePassword', ae.after_state -> 'mustChangePassword'
        ))
      when ae.event_type like 'availability.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'maidProfileId', ae.after_state ->> 'maidProfileId',
          'weekStart', ae.after_state ->> 'weekStart',
          'version', ae.after_state -> 'version',
          'sourceVersion', ae.after_state -> 'sourceVersion',
          'status', ae.after_state ->> 'status',
          'approvedVersionId', ae.after_state ->> 'approvedVersionId'
        ))
      when ae.event_type = 'assignment.draft_saved' then
        jsonb_strip_nulls(jsonb_build_object(
          'cleaningTargetId', ae.after_state ->> 'cleaningTargetId',
          'maidProfileId', ae.after_state ->> 'maidProfileId',
          'serviceDate', ae.after_state ->> 'serviceDate',
          'sequenceNumber', ae.after_state -> 'sequenceNumber',
          'revision', ae.after_state -> 'revision',
          'targetAssignmentVersion', ae.after_state -> 'targetAssignmentVersion'
        ))
      when ae.event_type like 'reservation.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', ae.after_state ->> 'room_id',
          'status', ae.after_state ->> 'status',
          'version', ae.after_state -> 'version',
          'checkInAt', ae.after_state ->> 'check_in_at',
          'checkOutAt', ae.after_state ->> 'check_out_at',
          'purgedCount', ae.after_state -> 'purged_count'
        ))
      when ae.event_type like 'cleaning.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomId', ae.after_state ->> 'room_id',
          'reservationId', ae.after_state ->> 'reservation_id',
          'cleaningKind', ae.after_state ->> 'cleaning_kind',
          'status', ae.after_state ->> 'status',
          'serviceDate', ae.after_state ->> 'service_date',
          'availableFrom', ae.after_state ->> 'available_from',
          'dueAt', ae.after_state ->> 'due_at',
          'version', ae.after_state -> 'version'
        ))
      when ae.event_type like 'room.%' then
        jsonb_strip_nulls(jsonb_build_object(
          'roomTypeId', ae.after_state ->> 'roomTypeId',
          'elevatorZone', ae.after_state ->> 'elevatorZone',
          'dataStatus', ae.after_state ->> 'dataStatus',
          'stateVersion', ae.after_state -> 'stateVersion',
          'blockId', ae.after_state ->> 'blockId',
          'active', ae.after_state -> 'active',
          'count', ae.after_state -> 'count',
          'issueId', ae.after_state ->> 'issueId',
          'category', ae.after_state ->> 'category',
          'severity', ae.after_state ->> 'severity',
          'blocksGuestAssignment', ae.after_state -> 'blocksGuestAssignment',
          'status', ae.after_state ->> 'status',
          'pinSyncEventId', ae.after_state ->> 'pinSyncEventId',
          'syncStatus', ae.after_state ->> 'syncStatus',
          'pinVersion', ae.after_state -> 'pinVersion'
        ))
      else '{}'::jsonb
    end
  from public.audit_events ae
  where ae.event_type = any (v_selected)
    and ae.recorded_at >= v_from
    and ae.recorded_at <= v_to
    and (p_filter_actor_profile_id is null
      or ae.actor_profile_id = p_filter_actor_profile_id)
    and (
      p_before_recorded_at is null
      or (ae.recorded_at, ae.id) < (p_before_recorded_at, p_before_id)
    )
  order by ae.recorded_at desc, ae.id desc
  limit p_limit;
end;
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;
