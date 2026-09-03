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
