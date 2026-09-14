-- #29: confirmed capacity policy is separate from the read-only preview snapshot.
-- No confirmed policy is seeded; demo/template durations are never a fallback.
create table public.assignment_duration_policy_versions (
  id uuid primary key default gen_random_uuid(),
  version bigint not null unique check (version > 0),
  status text not null check (status in ('draft','confirmed','retired')),
  standard_minutes integer not null check (standard_minutes > 0),
  premium_minutes integer not null check (premium_minutes > 0),
  ocean_premium_minutes integer not null check (ocean_premium_minutes > 0),
  ocean_family_minutes integer not null check (ocean_family_minutes > 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  confirmed_by uuid references public.profiles(id) on delete restrict,
  confirmed_at timestamptz,
  check ((status = 'draft' and confirmed_by is null and confirmed_at is null)
    or (status in ('confirmed','retired') and confirmed_by is not null and confirmed_at is not null))
);
create unique index assignment_duration_policy_one_confirmed
  on public.assignment_duration_policy_versions ((true)) where status = 'confirmed';
create index assignment_duration_policy_created_by_idx
  on public.assignment_duration_policy_versions(created_by);
create index assignment_duration_policy_confirmed_by_idx
  on public.assignment_duration_policy_versions(confirmed_by);
alter table public.assignment_duration_policy_versions enable row level security;
-- RPC-only. Even business administrators cannot directly mutate configuration.
revoke all on public.assignment_duration_policy_versions from public,anon,authenticated,service_role;

create function private.protect_assignment_duration_policy()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode='23514',message='ASSIGNMENT_DURATION_POLICY_IMMUTABLE';
  end if;
  if (to_jsonb(new) - 'status') is distinct from (to_jsonb(old) - 'status')
    or old.status <> 'confirmed' or new.status <> 'retired' then
    raise exception using errcode='23514',message='ASSIGNMENT_DURATION_POLICY_IMMUTABLE';
  end if;
  return new;
end;
$$;
revoke all on function private.protect_assignment_duration_policy() from public,anon,authenticated;
create trigger assignment_duration_policy_immutable
  before update or delete on public.assignment_duration_policy_versions
  for each row execute function private.protect_assignment_duration_policy();

create function private.assignment_duration_policy_projection(p_policy public.assignment_duration_policy_versions)
returns jsonb language sql stable set search_path = '' as $$
  select case when p_policy.id is null then null else jsonb_build_object(
    'id',p_policy.id,'version',p_policy.version,'status',p_policy.status,
    'standardMinutes',p_policy.standard_minutes,'premiumMinutes',p_policy.premium_minutes,
    'oceanPremiumMinutes',p_policy.ocean_premium_minutes,'oceanFamilyMinutes',p_policy.ocean_family_minutes,
    'createdAt',p_policy.created_at,'confirmedAt',p_policy.confirmed_at) end
$$;
revoke all on function private.assignment_duration_policy_projection(public.assignment_duration_policy_versions)
  from public,anon,authenticated;

-- Existing mutation assert_room_admin acquires FOR SHARE. Read-only preview
-- validates the same latest role/status in its consistent snapshot without locks.
create function private.assert_assignment_preview_admin(p_actor_profile_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_role public.app_role;
begin
  select role into v_role from public.profiles where id=p_actor_profile_id and status='active';
  if not found then raise exception using errcode='42501',message='ACTIVE_ACCOUNT_REQUIRED'; end if;
  if v_role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
end;
$$;
revoke all on function private.assert_assignment_preview_admin(uuid) from public,anon,authenticated;

create function public.get_assignment_duration_policy(p_actor_profile_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_policy public.assignment_duration_policy_versions;
begin
  perform private.assert_assignment_preview_admin(p_actor_profile_id);
  select * into v_policy from public.assignment_duration_policy_versions where status='confirmed';
  return private.assignment_duration_policy_projection(v_policy);
end;
$$;
revoke all on function public.get_assignment_duration_policy(uuid) from public,anon,authenticated;
grant execute on function public.get_assignment_duration_policy(uuid) to service_role;

create function public.confirm_assignment_duration_policy(
  p_actor_profile_id uuid,p_expected_version bigint,p_standard_minutes integer,
  p_premium_minutes integer,p_ocean_premium_minutes integer,p_ocean_family_minutes integer,
  p_idempotency_key text,p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_response jsonb;
  v_current bigint;
  v_policy public.assignment_duration_policy_versions;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_expected_version is null or p_expected_version < 0
    or p_standard_minutes is null or p_standard_minutes <= 0
    or p_premium_minutes is null or p_premium_minutes <= 0
    or p_ocean_premium_minutes is null or p_ocean_premium_minutes <= 0
    or p_ocean_family_minutes is null or p_ocean_family_minutes <= 0 then
    raise exception using errcode='22023',message='INVALID_ASSIGNMENT_DURATION_POLICY';
  end if;
  v_response := private.replay_command(p_actor_profile_id,'assignment.confirm_duration_policy',p_idempotency_key,p_request_hash);
  if v_response is not null then return v_response; end if;
  perform pg_advisory_xact_lock(hashtextextended('assignment-duration-policy',0));
  select coalesce(max(version),0) into v_current from public.assignment_duration_policy_versions;
  if v_current <> p_expected_version then
    raise exception using errcode='40001',message='ASSIGNMENT_DURATION_POLICY_VERSION_CONFLICT';
  end if;
  update public.assignment_duration_policy_versions set status='retired' where status='confirmed';
  insert into public.assignment_duration_policy_versions(
    version,status,standard_minutes,premium_minutes,ocean_premium_minutes,ocean_family_minutes,
    created_by,confirmed_by,confirmed_at
  ) values (v_current+1,'confirmed',p_standard_minutes,p_premium_minutes,p_ocean_premium_minutes,
    p_ocean_family_minutes,p_actor_profile_id,p_actor_profile_id,statement_timestamp()) returning * into v_policy;
  v_response := private.assignment_duration_policy_projection(v_policy);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,after_state,idempotency_key)
  select p_actor_profile_id,p.display_name,'assignment.duration_policy_confirmed','assignment_duration_policy',
    v_policy.id,v_policy.confirmed_at,jsonb_build_object('policyVersion',v_policy.version,'status','confirmed',
      'standardMinutes',p_standard_minutes,'premiumMinutes',p_premium_minutes,
      'oceanPremiumMinutes',p_ocean_premium_minutes,'oceanFamilyMinutes',p_ocean_family_minutes),
    private.audit_command_key(p_actor_profile_id,'assignment.confirm_duration_policy',p_idempotency_key)
  from public.profiles p where p.id=p_actor_profile_id;
  perform private.complete_command(p_actor_profile_id,'assignment.confirm_duration_policy',p_idempotency_key,
    p_request_hash,v_policy.id,v_response);
  return v_response;
end;
$$;
revoke all on function public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)
  from public,anon,authenticated;
grant execute on function public.confirm_assignment_duration_policy(uuid,bigint,integer,integer,integer,integer,text,text)
  to service_role;

-- Mirrors #26 planned/materialized and #28 execution source predicates, without
-- pretending an unassigned target is already a notified assignment. The nullable
-- additional window uses ONLY confirmed duration, never the legacy template fallback.
create function private.assignment_preview_source_reason(
  p_target public.cleaning_targets,p_duration_minutes integer,p_command_at timestamptz
)
returns text language plpgsql stable security definer set search_path = '' as $$
begin
  if p_target.available_from is null or not isfinite(p_target.available_from)
    or (p_target.due_at is not null and (not isfinite(p_target.due_at) or p_target.due_at <= p_target.available_from))
    or (p_target.available_from at time zone 'Asia/Seoul')::date <> p_target.effective_service_date then
    return 'ASSIGNMENT_PREVIEW_INVALID_SCHEDULE';
  end if;
  if p_target.due_at is not null and p_target.due_at <= p_command_at then return 'ASSIGNMENT_WINDOW_EXPIRED'; end if;
  if p_target.cleaning_kind='checkout' and p_target.source in ('scheduled_checkout','manual_checkout') then
    if not exists (
      select 1 from public.reservations r join public.checkout_cleaning_obligations o
        on o.reservation_id=r.id and o.room_id=r.room_id
      where o.id=p_target.checkout_obligation_id and r.id=p_target.reservation_id and r.room_id=p_target.room_id
        and o.planned_cleaning_target_id=p_target.id
        and o.effective_service_date=p_target.effective_service_date
        and o.available_from is not distinct from p_target.available_from
        and o.due_at is not distinct from p_target.due_at
        and ((r.status='checked_out' and r.actual_checkout_at is not null and o.status='materialized'
              and o.current_cleaning_target_id=p_target.id)
          or (p_target.source='scheduled_checkout' and r.status='active' and r.actual_checkout_at is null
              and r.check_out_at=p_target.available_from and o.status='private'
              and o.current_cleaning_target_id is null))
    ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  elsif p_target.source='stayover_request' and p_target.cleaning_kind='stayover' then
    if not exists (select 1 from public.reservations r where r.id=p_target.reservation_id
      and r.room_id=p_target.room_id and r.status='active' and r.actual_check_in_at is not null
      and r.actual_checkout_at is null and p_target.available_from >= r.actual_check_in_at
      and p_target.due_at is not null and p_target.due_at <= r.check_out_at
    ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  elsif p_target.source='manual_room_request' and p_target.cleaning_kind='additional' then
    if p_target.due_at is null and p_duration_minutes is null then
      return 'ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED';
    end if;
    if exists (select 1 from public.reservations r where r.room_id=p_target.room_id and r.status='active'
      and tstzrange(coalesce(r.actual_check_in_at,r.check_in_at),
        case when r.actual_check_in_at is not null and r.actual_checkout_at is null
          then 'infinity'::timestamptz else coalesce(r.actual_checkout_at,r.check_out_at) end,'[)')
      && tstzrange(p_target.available_from,
        coalesce(p_target.due_at,p_target.available_from+make_interval(mins=>p_duration_minutes)),'[)')
    ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
  elsif p_target.source='inspection_reclean' and p_target.cleaning_kind='reclean' then
    if p_target.fee_snapshot <> 0 or p_target.reclean_maid_profile_id is null or not exists (
      select 1 from public.cleaning_attempts a where a.id=p_target.reclean_of_attempt_id
        and a.maid_profile_id=p_target.reclean_maid_profile_id and a.status='rejected'
    ) then return 'RECLEAN_MAID_IMMUTABLE'; end if;
  else return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID';
  end if;
  return null;
end;
$$;
revoke all on function private.assignment_preview_source_reason(public.cleaning_targets,integer,timestamptz)
  from public,anon,authenticated;

create index cleaning_targets_preview_date_idx
  on public.cleaning_targets(effective_service_date,id)
  where status not in ('cancelled','approved');

create function private.assignment_preview_snapshot_at(
  p_actor_profile_id uuid,p_service_date date,p_command_at timestamptz
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy public.assignment_duration_policy_versions;
  v_targets jsonb;
  v_maids jsonb;
begin
  perform private.assert_assignment_preview_admin(p_actor_profile_id);
  if p_command_at is null or not isfinite(p_command_at) or p_service_date is null or not isfinite(p_service_date)
    or p_service_date not in ((p_command_at at time zone 'Asia/Seoul')::date,(p_command_at at time zone 'Asia/Seoul')::date+1) then
    raise exception using errcode='22023',message='ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED';
  end if;
  select * into v_policy from public.assignment_duration_policy_versions where status='confirmed';
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
        from (select reservation.* from public.reservations reservation
          where reservation.room_id=t.room_id and reservation.status='active'
            and reservation.check_in_at < coalesce(t.due_at, 'infinity'::timestamptz)
            and (reservation.check_out_at > t.available_from or
              (reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null))
          order by reservation.id limit 123) schedule),'[]'::jsonb)),
    'currentAssignment',case when a.id is null then null else jsonb_build_object(
      'assignmentId',a.id,'maidProfileId',a.maid_profile_id,'sequenceNumber',a.sequence_number,'revision',a.revision,
      'serviceDate',a.service_date,'availableFrom',a.available_from_snapshot,'dueAt',a.due_at_snapshot,
      'targetAssignmentVersion',t.assignment_version,'notifiedAt',a.notified_at) end,
    'activeAttempt',case when att.id is null then null else jsonb_build_object(
      'attemptId',att.id,'maidProfileId',att.maid_profile_id,'status',att.status,'startedAt',att.started_at,'endedAt',att.ended_at) end,
    'blockedReason',case
      when att.id is not null and t.effective_service_date<>p_service_date then 'ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED'
      when t.room_type_snapshot->>'code' is null or t.room_type_snapshot->>'code' not in ('standard','premium','oceanPremium','oceanFamily')
        then 'ASSIGNMENT_PREVIEW_ROOM_TYPE_UNKNOWN'
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
      else private.assignment_preview_source_reason(t,
        case t.room_type_snapshot->>'code' when 'standard' then v_policy.standard_minutes
          when 'premium' then v_policy.premium_minutes when 'oceanPremium' then v_policy.ocean_premium_minutes
          when 'oceanFamily' then v_policy.ocean_family_minutes end,p_command_at) end
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
    and attempt.status<>'superseded' order by attempt.attempt_number desc limit 1) att on true;
  if jsonb_array_length(v_targets)>242 then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;
  if exists (select 1 from jsonb_array_elements(v_targets) item
    where jsonb_array_length(item->'domainIdentity'->'roomReservations')>122) then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;
  return jsonb_build_object('serviceDate',p_service_date,'planningAt',p_command_at,
    'durationPolicy',private.assignment_duration_policy_projection(v_policy),'maids',v_maids,'targets',v_targets);
end;
$$;
revoke all on function private.assignment_preview_snapshot_at(uuid,date,timestamptz) from public,anon,authenticated;

create function public.get_assignment_preview_snapshot(p_actor_profile_id uuid,p_service_date date)
returns jsonb language sql stable security definer set search_path = '' as $$
  select private.assignment_preview_snapshot_at(p_actor_profile_id,p_service_date,statement_timestamp())
$$;
revoke all on function public.get_assignment_preview_snapshot(uuid,date) from public,anon,authenticated;
grant execute on function public.get_assignment_preview_snapshot(uuid,date) to service_role;

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
