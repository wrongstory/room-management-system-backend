-- #7A: online own-maid execution only. No lease/PIN, handover or submission.
alter table public.cleaning_attempts
  add column execution_version bigint not null default 1
    check (execution_version > 0);

create function private.attempt_execution_projection(p_attempt public.cleaning_attempts)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'attemptId',p_attempt.id,'cleaningTargetId',p_attempt.cleaning_target_id,
    'assignmentId',p_attempt.assignment_id,'maidProfileId',p_attempt.maid_profile_id,
    'assignmentRevision',p_attempt.assignment_revision,'executionVersion',p_attempt.execution_version,
    'status',p_attempt.status,'startedAt',p_attempt.started_at,
    'fieldCompletedAt',p_attempt.field_completed_at,'endedAt',p_attempt.ended_at,
    'effectiveAt',coalesce(p_attempt.field_completed_at,p_attempt.started_at,p_attempt.created_at),
    'recordedAt',p_attempt.updated_at
  );
$$;
revoke all on function private.attempt_execution_projection(public.cleaning_attempts)
  from public,anon,authenticated,service_role;

-- This transitional guard deliberately does not acquire the reservation lock:
-- account commands already own the profile row. #7B owns limited-capability UX.
create function private.guard_running_maid_account_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.role='maid' and (new.role is distinct from old.role or new.status is distinct from old.status)
    and exists(select 1 from public.cleaning_attempts a where a.maid_profile_id=old.id and a.status='in_progress') then
    raise exception using errcode='55000',message='ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_running_maid_account_change() from public,anon,authenticated,service_role;
create trigger profiles_running_maid_guard before update of role,status on public.profiles
  for each row execute function private.guard_running_maid_account_change();

-- CAS and physical timestamps cannot be rewritten once execution starts.
create function private.guard_attempt_execution_version()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.status<>'scheduled' and new.status='scheduled'
    or old.status not in ('scheduled','in_progress') and new.status='in_progress' then
    raise exception using errcode='23514',message='ATTEMPT_INVALID_TRANSITION';
  end if;
  if new.execution_version is distinct from old.execution_version then
    if new.execution_version<>old.execution_version+1
      or not ((old.status='scheduled' and new.status='in_progress')
           or (old.status='in_progress' and new.status='field_completed')) then
      raise exception using errcode='23514',message='ATTEMPT_VERSION_CONFLICT';
    end if;
  elsif (old.status='scheduled' and new.status='in_progress')
     or (old.status='in_progress' and new.status='field_completed') then
    raise exception using errcode='23514',message='ATTEMPT_VERSION_CONFLICT';
  end if;
  if old.started_at is not null and new.started_at is distinct from old.started_at
    or old.field_completed_at is not null and new.field_completed_at is distinct from old.field_completed_at
    or old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception using errcode='23514',message='ATTEMPT_EXECUTION_TIMESTAMP_IMMUTABLE';
  end if;
  if old.status='scheduled' and new.status='in_progress' then
    if new.started_at is null or new.field_completed_at is not null or new.ended_at is not null then
      raise exception using errcode='23514',message='ATTEMPT_INVALID_TRANSITION';
    end if;
  elsif old.status='in_progress' and new.status='field_completed' then
    if new.started_at is null or new.field_completed_at is null or new.ended_at is distinct from new.field_completed_at
      or new.field_completed_at<new.started_at then
      raise exception using errcode='23514',message='ATTEMPT_INVALID_TRANSITION';
    end if;
  end if;
  if new.execution_version is distinct from old.execution_version then
    new.updated_at:=clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function private.guard_attempt_execution_version() from public,anon,authenticated,service_role;
create trigger cleaning_attempts_zz_execution_guard before update on public.cleaning_attempts
  for each row execute function private.guard_attempt_execution_version();

create function public.get_current_cleaning_attempt(p_actor_profile_id uuid,p_assignment_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_profile public.profiles%rowtype; v_assignment public.cleaning_assignments%rowtype;
  v_attempt public.cleaning_attempts%rowtype;
begin
  select * into v_profile from public.profiles where id=p_actor_profile_id and status='active';
  if not found or v_profile.role<>'maid' then
    raise exception using errcode='42501',message='MAID_REQUIRED';
  end if;
  if v_profile.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  select * into v_assignment from public.cleaning_assignments
    where id=p_assignment_id and maid_profile_id=p_actor_profile_id and is_current and notified_at is not null;
  if not found then raise exception using errcode='42501',message='ATTEMPT_ACCESS_REQUIRED'; end if;
  select * into v_attempt from public.cleaning_attempts
    where assignment_id=v_assignment.id and maid_profile_id=p_actor_profile_id
      and assignment_revision=v_assignment.revision and status<>'superseded'
    order by attempt_number desc limit 1;
  if not found then return null; end if;
  return private.attempt_execution_projection(v_attempt);
end;
$$;
revoke all on function public.get_current_cleaning_attempt(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_current_cleaning_attempt(uuid,uuid) to service_role;

-- Owner-only clock seam supports deterministic DB regression, never a client clock.
create function private.execute_cleaning_attempt_at(
  p_actor_profile_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,
  p_idempotency_key text,p_request_hash text,p_action text,p_command_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles%rowtype; v_attempt public.cleaning_attempts%rowtype;
  v_target public.cleaning_targets%rowtype; v_assignment public.cleaning_assignments%rowtype;
  v_command text; v_event text; v_replay jsonb; v_result jsonb; v_reason text;
  v_command_at timestamptz;
begin
  if p_action not in ('start','complete_field_work') or p_action is null
    or p_expected_execution_version is null or p_expected_execution_version<1
    or p_expected_assignment_revision is null or p_expected_assignment_revision<1
    or p_expected_assignment_id is null or p_attempt_id is null then
    raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND';
  end if;
  select * into v_profile from public.profiles where id=p_actor_profile_id and status='active';
  if not found or v_profile.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  v_command:='cleaning.attempt.'||p_action;
  v_event:=case when p_action='start' then 'cleaning.attempt_started' else 'cleaning.field_completed' end;
  v_replay:=private.replay_command(p_actor_profile_id,v_command,p_idempotency_key,p_request_hash);
  -- Shared domain lock first; the account guard only owns its profile row.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_profile from public.profiles where id=p_actor_profile_id and status='active' for share;
  if not found or v_profile.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  if v_profile.must_change_password then raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  select * into v_attempt from public.cleaning_attempts where id=p_attempt_id and maid_profile_id=p_actor_profile_id;
  if not found then raise exception using errcode='42501',message='ATTEMPT_ACCESS_REQUIRED'; end if;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id for update;
  select * into v_assignment from public.cleaning_assignments where id=v_attempt.assignment_id for update;
  select * into v_attempt from public.cleaning_attempts where id=p_attempt_id for update;
  v_command_at:=coalesce(p_command_at,clock_timestamp());
  if not v_assignment.is_current or v_assignment.notified_at is null
    or v_assignment.maid_profile_id<>p_actor_profile_id
    or v_assignment.id<>p_expected_assignment_id
    or v_assignment.revision<>p_expected_assignment_revision
    or v_attempt.assignment_revision<>v_assignment.revision
    or v_target.assignment_version<>v_assignment.revision
    or v_target.status='cancelled' then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if v_replay is not null then return v_replay; end if;
  if v_attempt.execution_version<>p_expected_execution_version then
    raise exception using errcode='40001',message='ATTEMPT_VERSION_CONFLICT';
  end if;
  if p_action='start' then
    if v_attempt.status<>'scheduled' then raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
    v_reason:=private.activation_reason_at(v_target,v_assignment,v_command_at);
    if v_reason is not null then raise exception using errcode='55000',message=v_reason; end if;
    if v_assignment.notified_room_id_snapshot is distinct from v_target.room_id
      or (v_attempt.room_snapshot->>'roomId') is distinct from v_target.room_id::text then
      raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
    end if;
    -- Recheck actual start instant, including delayed starts with an open-ended
    -- additional window. No invented duration/default is used for this check.
    if v_target.cleaning_kind='additional' and exists(
      select 1 from public.reservations r where r.room_id=v_target.room_id and r.status='active'
      and coalesce(r.actual_check_in_at,r.check_in_at)<=v_command_at
      and (case when r.actual_check_in_at is not null and r.actual_checkout_at is null then 'infinity'::timestamptz
        else coalesce(r.actual_checkout_at,r.check_out_at) end)>v_command_at
    ) then raise exception using errcode='55000',message='ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if exists(select 1 from public.cleaning_attempts a where a.maid_profile_id=p_actor_profile_id and a.status='in_progress') then
      raise exception using errcode='55000',message='MAID_ALREADY_IN_PROGRESS';
    end if;
    update public.cleaning_attempts set status='in_progress',started_at=v_command_at,
      execution_version=execution_version+1 where id=p_attempt_id returning * into v_attempt;
    update public.cleaning_targets set status='in_progress' where id=v_target.id;
  else
    -- Completion acknowledges actual field work. It must not reapply today's
    -- activation window or reject an ordinary checkout after a stayover start.
    if v_attempt.status<>'in_progress' or v_attempt.started_at is null or v_attempt.started_at>v_command_at then
      raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION';
    end if;
    update public.cleaning_attempts set status='field_completed',field_completed_at=v_command_at,ended_at=v_command_at,
      execution_version=execution_version+1 where id=p_attempt_id returning * into v_attempt;
  end if;
  v_result:=private.attempt_execution_projection(v_attempt);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
    effective_at,recorded_at,after_state,idempotency_key)
  values(v_event,'cleaning_attempt',v_attempt.id,p_actor_profile_id,v_profile.display_name,
    v_command_at,clock_timestamp(),v_result,private.audit_command_key(p_actor_profile_id,v_command,p_idempotency_key));
  perform private.complete_command(p_actor_profile_id,v_command,p_idempotency_key,p_request_hash,p_attempt_id,v_result);
  return v_result;
end;
$$;
revoke all on function private.execute_cleaning_attempt_at(uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz)
  from public,anon,authenticated,service_role;

create function public.start_cleaning_attempt(
  p_actor_profile_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path = '' as $$
  select private.execute_cleaning_attempt_at(p_actor_profile_id,p_attempt_id,p_expected_execution_version,
    p_expected_assignment_id,p_expected_assignment_revision,p_idempotency_key,p_request_hash,'start',null);
$$;
create function public.complete_cleaning_attempt_field_work(
  p_actor_profile_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path = '' as $$
  select private.execute_cleaning_attempt_at(p_actor_profile_id,p_attempt_id,p_expected_execution_version,
    p_expected_assignment_id,p_expected_assignment_revision,p_idempotency_key,p_request_hash,'complete_field_work',null);
$$;
revoke all on function public.start_cleaning_attempt(uuid,uuid,bigint,uuid,bigint,text,text),
  public.complete_cleaning_attempt_field_work(uuid,uuid,bigint,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.start_cleaning_attempt(uuid,uuid,bigint,uuid,bigint,text,text),
  public.complete_cleaning_attempt_field_work(uuid,uuid,bigint,uuid,bigint,text,text) to service_role;

alter table private.actor_authorization_denial_aggregates
  drop constraint actor_authorization_denial_aggregates_source_check,
  drop constraint actor_authorization_denial_aggregates_reason_code_check,
  add constraint actor_authorization_denial_aggregates_source_check check (
    source in (
      'edge.authorization.accounts',
      'edge.authorization.developer',
      'edge.authorization.availability',
      'edge.authorization.assignments',
      'edge.authorization.attempts',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
  ),
  add constraint actor_authorization_denial_aggregates_reason_code_check check (
    reason_code in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
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
      'edge.authorization.attempts',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
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
    'assignment.attempt_activated','assignment.rolled_over','assignment.duration_policy_confirmed',
    'cleaning.attempt_started','cleaning.field_completed',
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
      when audit.event_type = 'assignment.duration_policy_confirmed' then jsonb_strip_nulls(jsonb_build_object(
        'policyVersion',audit.after_state->'policyVersion','status',audit.after_state->>'status',
        'standardMinutes',audit.after_state->'standardMinutes','premiumMinutes',audit.after_state->'premiumMinutes',
        'oceanPremiumMinutes',audit.after_state->'oceanPremiumMinutes','oceanFamilyMinutes',audit.after_state->'oceanFamilyMinutes'))
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
      when audit.event_type in ('cleaning.attempt_started','cleaning.field_completed') then jsonb_strip_nulls(jsonb_build_object(
        'attemptId',audit.after_state->>'attemptId','cleaningTargetId',audit.after_state->>'cleaningTargetId',
        'assignmentId',audit.after_state->>'assignmentId','maidProfileId',audit.after_state->>'maidProfileId',
        'assignmentRevision',audit.after_state->'assignmentRevision','executionVersion',audit.after_state->'executionVersion',
        'status',audit.after_state->>'status','startedAt',audit.after_state->>'startedAt',
        'fieldCompletedAt',audit.after_state->>'fieldCompletedAt','endedAt',audit.after_state->>'endedAt'))
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
