-- #7B: session-bound, server-owned limited work grants. No bearer capability,
-- upload implementation, PIN, offline lease or submission is introduced here.
alter table public.profiles add column account_lifecycle_version bigint not null default 1
  check (account_lifecycle_version > 0);

create table private.attempt_capability_grants (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  attempt_id uuid not null references public.cleaning_attempts(id) on delete restrict,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  assignment_revision bigint not null check (assignment_revision > 0),
  kind text not null check (kind in ('finish_current','upload_submit','evidence_upload')),
  allowed_actions text[] not null,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  granted_by uuid not null references public.profiles(id) on delete restrict,
  unique(attempt_id,kind),
  check ((kind='finish_current' and allowed_actions=array['complete_field_work']::text[]
      and expires_at=issued_at+interval '2 hours')
    or (kind='upload_submit' and allowed_actions=array['upload_evidence','validate_evidence','submit']::text[]
      and expires_at=issued_at+interval '24 hours')
    or (kind='evidence_upload' and allowed_actions=array['upload_evidence','validate_evidence']::text[]
      and expires_at=issued_at+interval '24 hours'))
);
create index attempt_capability_actor_idx on private.attempt_capability_grants(actor_profile_id,attempt_id);
create index attempt_capability_assignment_idx on private.attempt_capability_grants(assignment_id);
create index attempt_capability_granted_by_idx on private.attempt_capability_grants(granted_by);
create table private.attempt_capability_revocations (
  capability_id uuid primary key references private.attempt_capability_grants(id) on delete restrict,
  revoked_at timestamptz not null,
  reason_code text not null check(reason_code in ('FIELD_COMPLETED','HANDOVER','ACCOUNT_CHANGED')),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict
);
create index attempt_capability_revocation_actor_idx on private.attempt_capability_revocations(actor_profile_id);
create table private.attempt_handover_events (
  previous_attempt_id uuid primary key references public.cleaning_attempts(id) on delete restrict,
  next_attempt_id uuid not null unique references public.cleaning_attempts(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  reason_code text not null check(reason_code in ('ADMIN_HANDOVER','DEACTIVATION_HANDOVER')),
  occurred_at timestamptz not null
);
create index attempt_handover_actor_idx on private.attempt_handover_events(actor_profile_id);
alter table private.attempt_capability_grants enable row level security;
alter table private.attempt_capability_revocations enable row level security;
alter table private.attempt_handover_events enable row level security;
revoke all on private.attempt_capability_grants,private.attempt_capability_revocations,private.attempt_handover_events
  from public,anon,authenticated,service_role;

create function private.guard_attempt_capability_ledger()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='ATTEMPT_CAPABILITY_IMMUTABLE';
end; $$;
revoke all on function private.guard_attempt_capability_ledger() from public,anon,authenticated,service_role;
create trigger attempt_capability_immutable before update or delete on private.attempt_capability_grants
  for each row execute function private.guard_attempt_capability_ledger();
create trigger attempt_capability_revocation_immutable before update or delete on private.attempt_capability_revocations
  for each row execute function private.guard_attempt_capability_ledger();
create trigger attempt_handover_immutable before update or delete on private.attempt_handover_events
  for each row execute function private.guard_attempt_capability_ledger();

create function private.guard_attempt_capability_identity()
returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from public.cleaning_attempts a where a.id=new.attempt_id
    and a.maid_profile_id=new.actor_profile_id and a.assignment_id=new.assignment_id
    and a.assignment_revision=new.assignment_revision) then
    raise exception using errcode='23514',message='CAPABILITY_ACCESS_REQUIRED';
  end if;
  return new;
end; $$;
revoke all on function private.guard_attempt_capability_identity() from public,anon,authenticated,service_role;
create trigger attempt_capability_identity before insert on private.attempt_capability_grants
  for each row execute function private.guard_attempt_capability_identity();

create function private.attempt_capability_projection(p_cap private.attempt_capability_grants)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('capabilityId',p_cap.id,'attemptId',p_cap.attempt_id,
    'assignmentId',p_cap.assignment_id,'assignmentRevision',p_cap.assignment_revision,
    'kind',p_cap.kind,'allowedActions',to_jsonb(p_cap.allowed_actions),
    'issuedAt',p_cap.issued_at,'expiresAt',p_cap.expires_at,
    'revokedAt',(select r.revoked_at from private.attempt_capability_revocations r where r.capability_id=p_cap.id));
$$;
revoke all on function private.attempt_capability_projection(private.attempt_capability_grants)
  from public,anon,authenticated,service_role;

create function private.assert_attempt_actor_session(p_actor uuid,p_session uuid,p_admin boolean)
returns public.profiles language plpgsql stable security definer set search_path='' as $$
declare p public.profiles%rowtype;
begin
  select * into p from public.profiles where id=p_actor;
  if not found or (p_admin and (p.role<>'admin' or p.status<>'active')) then
    raise exception using errcode='42501',message='ADMIN_REQUIRED';
  end if;
  if not p_admin and (p.role<>'maid' or p.status not in ('active','deactivation_pending','upload_only')) then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED';
  end if;
  if p.must_change_password then raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  if p_session is null or not public.is_active_auth_session(p.auth_user_id,p_session) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  return p;
end; $$;
revoke all on function private.assert_attempt_actor_session(uuid,uuid,boolean) from public,anon,authenticated,service_role;

create function private.issue_attempt_capability(p_attempt public.cleaning_attempts,p_kind text,p_actor uuid,p_at timestamptz)
returns private.attempt_capability_grants language plpgsql set search_path='' as $$
declare g private.attempt_capability_grants%rowtype;
begin
  -- Even a different command key can never renew the same attempt/kind window.
  select * into g from private.attempt_capability_grants where attempt_id=p_attempt.id and kind=p_kind;
  if found then return g; end if;
  insert into private.attempt_capability_grants(actor_profile_id,attempt_id,assignment_id,assignment_revision,
    kind,allowed_actions,issued_at,expires_at,granted_by)
  values(p_attempt.maid_profile_id,p_attempt.id,p_attempt.assignment_id,p_attempt.assignment_revision,p_kind,
    case p_kind when 'finish_current' then array['complete_field_work']::text[]
      when 'upload_submit' then array['upload_evidence','validate_evidence','submit']::text[]
      else array['upload_evidence','validate_evidence']::text[] end,
    p_at,p_at+case when p_kind='finish_current' then interval '2 hours' else interval '24 hours' end,p_actor)
  returning * into g;
  return g;
end; $$;
revoke all on function private.issue_attempt_capability(public.cleaning_attempts,text,uuid,timestamptz)
  from public,anon,authenticated,service_role;

create or replace function private.guard_running_maid_account_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.account_lifecycle_version<>old.account_lifecycle_version then
    raise exception using errcode='23514',message='ACCOUNT_VERSION_CONFLICT';
  end if;
  if new.role is distinct from old.role or new.status is distinct from old.status then
    if old.role='maid' and exists(select 1 from public.cleaning_attempts a where a.maid_profile_id=old.id and a.status='in_progress') then
      if not (old.status='active' and new.status='deactivation_pending' and new.role='maid'
        and exists(select 1 from private.attempt_capability_grants g join public.cleaning_attempts a on a.id=g.attempt_id
          where g.actor_profile_id=old.id and g.kind='finish_current' and g.expires_at>clock_timestamp()
            and a.status='in_progress' and not exists(select 1 from private.attempt_capability_revocations r where r.capability_id=g.id))) then
        raise exception using errcode='55000',message='ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED';
      end if;
    end if;
    new.account_lifecycle_version:=old.account_lifecycle_version+1;
    -- A terminal/generic account change permanently revokes all grants. Restoring
    -- an account later cannot resurrect a previously authorized limited action.
    if new.role<>'maid' or new.status in ('inactive','departed')
      or (old.status in ('deactivation_pending','upload_only') and new.status='active') then
      insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
      select g.id,clock_timestamp(),'ACCOUNT_CHANGED',old.id from private.attempt_capability_grants g
      where g.actor_profile_id=old.id on conflict(capability_id) do nothing;
    end if;
  end if;
  return new;
end; $$;
drop trigger profiles_running_maid_guard on public.profiles;
create trigger profiles_running_maid_guard before update on public.profiles
  for each row execute function private.guard_running_maid_account_change();

create or replace function private.guard_attempt_execution_version()
returns trigger language plpgsql set search_path='' as $$
declare changed boolean;
begin
  if old.status<>'scheduled' and new.status='scheduled'
    or old.status not in ('scheduled','in_progress') and new.status='in_progress' then
    raise exception using errcode='23514',message='ATTEMPT_INVALID_TRANSITION';
  end if;
  changed:=(old.status='scheduled' and new.status in ('in_progress','superseded'))
    or (old.status='in_progress' and new.status in ('field_completed','interrupted'));
  -- Existing reservation/manual-request cancellation commands already retire an
  -- unstarted attempt. Preserve that supported command without a new caller CAS.
  if old.status='scheduled' and new.status='superseded' and new.execution_version=old.execution_version then
    new.execution_version:=old.execution_version+1;
  end if;
  if new.execution_version is distinct from old.execution_version then
    if not changed or new.execution_version<>old.execution_version+1 then
      raise exception using errcode='23514',message='ATTEMPT_VERSION_CONFLICT';
    end if;
  elsif changed then raise exception using errcode='23514',message='ATTEMPT_VERSION_CONFLICT'; end if;
  if old.started_at is not null and new.started_at is distinct from old.started_at
    or old.field_completed_at is not null and new.field_completed_at is distinct from old.field_completed_at
    or old.ended_at is not null and new.ended_at is distinct from old.ended_at then
    raise exception using errcode='23514',message='ATTEMPT_EXECUTION_TIMESTAMP_IMMUTABLE';
  end if;
  if changed then
    if new.status='in_progress' and (new.started_at is null or new.field_completed_at is not null or new.ended_at is not null)
      or new.status='field_completed' and (new.started_at is null or new.field_completed_at is null
        or new.ended_at is distinct from new.field_completed_at or new.field_completed_at<new.started_at)
      or new.status='interrupted' and (new.started_at is null or new.field_completed_at is not null
        or new.ended_at is null or new.ended_at<new.started_at or new.end_reason is null)
      or new.status='superseded' and (new.started_at is not null or new.field_completed_at is not null
        or new.ended_at is null or new.end_reason is null) then
      raise exception using errcode='23514',message='ATTEMPT_INVALID_TRANSITION';
    end if;
    new.updated_at:=clock_timestamp();
  end if;
  return new;
end; $$;

create function private.live_attempt_capability(p_actor uuid,p_attempt uuid,p_revision bigint,p_action text,p_at timestamptz)
returns private.attempt_capability_grants language plpgsql stable set search_path='' as $$
declare g private.attempt_capability_grants%rowtype; a public.cleaning_attempts%rowtype; p public.profiles%rowtype;
begin
  select * into p from public.profiles where id=p_actor;
  select * into a from public.cleaning_attempts where id=p_attempt and maid_profile_id=p_actor and assignment_revision=p_revision;
  if not found or p.role<>'maid' or p.status not in ('active','deactivation_pending','upload_only') then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED';
  end if;
  select c.* into g from private.attempt_capability_grants c where c.actor_profile_id=p_actor
    and c.attempt_id=p_attempt and c.assignment_id=a.assignment_id and c.assignment_revision=p_revision
    and c.issued_at<=p_at and c.expires_at>p_at and (p_action is null or p_action=any(c.allowed_actions))
    and not exists(select 1 from private.attempt_capability_revocations r where r.capability_id=c.id)
    and ((c.kind='finish_current' and p.status='deactivation_pending' and a.status='in_progress')
      or (c.kind='upload_submit' and p.status='upload_only' and a.status in ('field_completed','upload_pending'))
      or (c.kind='evidence_upload' and p.status in ('active','upload_only') and a.status='interrupted'))
    and (c.kind='evidence_upload' or exists(select 1 from public.cleaning_assignments s join public.cleaning_targets t on t.id=s.cleaning_target_id
      where s.id=a.assignment_id and s.is_current and s.notified_at is not null and s.revision=a.assignment_revision
        and t.assignment_version=s.revision and t.status<>'cancelled'))
    order by c.issued_at desc limit 1;
  if not found then raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  return g;
end; $$;
revoke all on function private.live_attempt_capability(uuid,uuid,bigint,text,timestamptz) from public,anon,authenticated,service_role;

create function public.get_limited_cleaning_attempt(p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_assignment_revision bigint)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.profiles%rowtype; a public.cleaning_attempts%rowtype; g private.attempt_capability_grants%rowtype;
begin
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  g:=private.live_attempt_capability(p_actor_profile_id,p_attempt_id,p_assignment_revision,null,statement_timestamp());
  select * into a from public.cleaning_attempts where id=p_attempt_id;
  return jsonb_build_object('attempt',private.attempt_execution_projection(a),'capability',private.attempt_capability_projection(g),'profileStatus',p.status);
end; $$;
revoke all on function public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint) from public,anon,authenticated;
grant execute on function public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint) to service_role;

create function public.get_cleaning_attempt_lifecycle_impact(p_actor_profile_id uuid,p_session_id uuid,p_assignment_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare a public.cleaning_attempts%rowtype; p public.profiles%rowtype; g private.attempt_capability_grants%rowtype; t public.cleaning_targets%rowtype;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  select a1.* into a from public.cleaning_attempts a1 join public.cleaning_assignments s on s.id=a1.assignment_id
    where s.id=p_assignment_id and s.is_current and s.notified_at is not null and a1.status<>'superseded'
    order by a1.attempt_number desc limit 1;
  if not found then raise exception using errcode='42501',message='ATTEMPT_ACCESS_REQUIRED'; end if;
  select * into p from public.profiles where id=a.maid_profile_id;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id;
  select * into g from private.attempt_capability_grants where attempt_id=a.id order by issued_at desc limit 1;
  return jsonb_build_object('attempt',private.attempt_execution_projection(a),'profileStatus',p.status,
    'profileVersion',p.account_lifecycle_version,'targetAssignmentVersion',t.assignment_version,
    'capability',case when g.id is not null then private.attempt_capability_projection(g) end);
end; $$;
revoke all on function public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid) to service_role;

-- Validate the full proposed interval, never an invented one-minute duration.
create function private.assert_handover_schedule(p_target public.cleaning_targets,p_date date,p_from timestamptz,p_due timestamptz)
returns void language plpgsql stable set search_path='' as $$
declare r public.reservations%rowtype; next_in timestamptz;
begin
  if p_date is null or p_from is null or p_due is null or p_from>=p_due
    or (p_from at time zone 'Asia/Seoul')::date<>p_date
    or p_due>(p_date+1)::timestamp at time zone 'Asia/Seoul' then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
  end if;
  if p_target.cleaning_kind='checkout' and p_target.source in ('scheduled_checkout','manual_checkout') then
    select * into r from public.reservations where id=p_target.reservation_id and room_id=p_target.room_id;
    if r.id is null or r.status<>'checked_out' or r.actual_checkout_at is null or p_from<r.actual_checkout_at
      or not exists(select 1 from public.checkout_cleaning_obligations o where o.id=p_target.checkout_obligation_id
        and o.reservation_id=r.id and o.room_id=r.room_id and o.planned_cleaning_target_id=p_target.id
        and o.current_cleaning_target_id=p_target.id and o.status in ('materialized','completed')) then
      raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED';
    end if;
    select min(check_in_at) into next_in from public.reservations where room_id=p_target.room_id and status='active'
      and check_in_at>=r.actual_checkout_at;
    if next_in is not null and p_due>next_in-interval '30 minutes' then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
    end if;
  elsif p_target.cleaning_kind='stayover' and p_target.source='stayover_request' then
    if not exists(select 1 from public.reservations where id=p_target.reservation_id and room_id=p_target.room_id
      and status='active' and actual_check_in_at is not null and actual_checkout_at is null
      and p_from>=actual_check_in_at and p_due<=check_out_at) then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
    end if;
  elsif not (p_target.cleaning_kind='additional' and p_target.source='manual_room_request') then
    raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE';
  end if;
  if p_target.cleaning_kind in ('checkout','additional') and exists(select 1 from public.reservations r1
    where r1.room_id=p_target.room_id and r1.status='active'
      and tstzrange(coalesce(r1.actual_check_in_at,r1.check_in_at),case when r1.actual_check_in_at is not null
        and r1.actual_checkout_at is null then 'infinity'::timestamptz else coalesce(r1.actual_checkout_at,r1.check_out_at) end,'[)')
      && tstzrange(p_from,p_due,'[)')) then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
  end if;
end; $$;
revoke all on function private.assert_handover_schedule(public.cleaning_targets,date,timestamptz,timestamptz)
  from public,anon,authenticated,service_role;

create function private.assert_expired_attempt_replan(p_target public.cleaning_targets,p_maid uuid)
returns void language plpgsql stable set search_path='' as $$
declare next_date date:=p_target.effective_service_date+1;
  next_from timestamptz:=p_target.available_from+interval '1 day';
  next_due timestamptz:=p_target.due_at+interval '1 day'; r public.reservations%rowtype;
begin
  if next_from is null or (next_from at time zone 'Asia/Seoul')::date<>next_date
    or (next_due is not null and (next_due<=next_from or next_due>(next_date+1)::timestamp at time zone 'Asia/Seoul')) then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
  if p_target.cleaning_kind='reclean' and p_target.source='inspection_reclean' then
    if p_target.reclean_maid_profile_id is distinct from p_maid or p_target.fee_snapshot<>0
      or not exists(select 1 from public.cleaning_attempts where id=p_target.reclean_of_attempt_id
        and maid_profile_id=p_maid and status='rejected') then
      raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE'; end if;
  elsif next_due is not null then
    perform private.assert_handover_schedule(p_target,next_date,next_from,next_due);
    return;
  elsif p_target.cleaning_kind='checkout' and p_target.source in ('scheduled_checkout','manual_checkout') then
    select * into r from public.reservations where id=p_target.reservation_id and room_id=p_target.room_id;
    if r.id is null or r.status<>'checked_out' or r.actual_checkout_at is null or next_from<r.actual_checkout_at
      or not exists(select 1 from public.checkout_cleaning_obligations o where o.id=p_target.checkout_obligation_id
        and o.planned_cleaning_target_id=p_target.id and o.current_cleaning_target_id=p_target.id
        and o.reservation_id=r.id and o.status in ('materialized','completed')) then
      raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED'; end if;
  elsif not (p_target.cleaning_kind='additional' and p_target.source='manual_room_request') then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
  end if;
  -- NULL is preserved, not guessed. An unbounded interval is safe only if no
  -- active reservation can overlap it. Reclean also respects next check-in buffer.
  if exists(select 1 from public.reservations x where x.room_id=p_target.room_id and x.status='active'
    and tstzrange(coalesce(x.actual_check_in_at,x.check_in_at),case when x.actual_check_in_at is not null
      and x.actual_checkout_at is null then 'infinity'::timestamptz else coalesce(x.actual_checkout_at,x.check_out_at) end,'[)')
      && tstzrange(next_from,coalesce(next_due,'infinity'::timestamptz),'[)'))
    or (p_target.cleaning_kind in ('checkout','reclean') and exists(select 1 from public.reservations x
      where x.room_id=p_target.room_id and x.status='active' and x.check_in_at>=next_from
        and (next_due is null or next_due>x.check_in_at-interval '30 minutes'))) then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
end; $$;
revoke all on function private.assert_expired_attempt_replan(public.cleaning_targets,uuid) from public,anon,authenticated,service_role;

create function private.notice_attempt_capability(p_grant private.attempt_capability_grants,p_target public.cleaning_targets)
returns void language plpgsql set search_path='' as $$
declare notice_id uuid; notice_key text:='attempt-capability:'||p_grant.id::text;
begin
  if exists(select 1 from public.notifications where dedupe_key=notice_key) then return; end if;
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,dedupe_key,requires_action)
  values(p_grant.actor_profile_id,'cleaning_capability_changed','업무 권한 변경 안내',
    '기존 업무의 제한된 수행 또는 증빙 권한이 변경되었습니다. 앱에서 만료 시각을 확인해 주세요.',
    p_target.room_id,p_target.id,notice_key,true) returning id into notice_id;
  insert into private.notification_outbox(notification_id,channel,delivery_status) values(notice_id,'web_push','pending');
end; $$;
revoke all on function private.notice_attempt_capability(private.attempt_capability_grants,public.cleaning_targets)
  from public,anon,authenticated,service_role;

create function private.manage_cleaning_attempt_lifecycle_at(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_expected_profile_version bigint,
  p_action text,p_payload jsonb,p_reason_code text,p_idempotency_key text,p_request_hash text,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype; maid public.profiles%rowtype; a public.cleaning_attempts%rowtype;
  na public.cleaning_attempts%rowtype; s public.cleaning_assignments%rowtype; ns public.cleaning_assignments%rowtype;
  t public.cleaning_targets%rowtype; g private.attempt_capability_grants%rowtype;
  at_time timestamptz; cmd text; event_name text; replay jsonb; result jsonb; rollover jsonb; reason text;
  next_maid uuid; next_sequence integer; next_date date; next_from timestamptz; next_due timestamptz;
  deactivate_old boolean; wk date;
begin
  actor:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  if p_action is null or p_action not in ('allow_finish','allow_upload','interrupt_handover','expire_scheduled')
    or p_expected_execution_version is null or p_expected_execution_version<1
    or p_expected_assignment_revision is null or p_expected_assignment_revision<1
    or p_expected_profile_version is null or p_expected_profile_version<1
    or p_expected_assignment_id is null or p_attempt_id is null or jsonb_typeof(p_payload) is distinct from 'object'
    or p_reason_code is null then raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND'; end if;
  if p_action='interrupt_handover' then
    if (select array_agg(k order by k) from jsonb_object_keys(p_payload) k)
      is distinct from array['availableFrom','deactivateOld','dueAt','maidProfileId','sequenceNumber','serviceDate']::text[]
      or jsonb_typeof(p_payload->'deactivateOld')<>'boolean'
      or jsonb_typeof(p_payload->'sequenceNumber')<>'number' then
      raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND'; end if;
    begin
      next_maid:=(p_payload->>'maidProfileId')::uuid; next_sequence:=(p_payload->>'sequenceNumber')::integer;
      next_date:=(p_payload->>'serviceDate')::date; next_from:=(p_payload->>'availableFrom')::timestamptz;
      next_due:=(p_payload->>'dueAt')::timestamptz; deactivate_old:=(p_payload->>'deactivateOld')::boolean;
    exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
      raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND';
    end;
    if next_maid is null or next_sequence is null or next_sequence<1 or deactivate_old is null
      or p_reason_code<>(case when deactivate_old then 'DEACTIVATION_HANDOVER' else 'ADMIN_HANDOVER' end) then
      raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND'; end if;
  elsif p_payload<>'{}'::jsonb or p_reason_code<>(case p_action when 'allow_finish' then 'DEACTIVATION_FINISH_CURRENT'
      when 'allow_upload' then 'DEACTIVATION_UPLOAD_ONLY' else 'SCHEDULE_EXPIRED' end) then
    raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND';
  end if;
  cmd:='cleaning.lifecycle.'||p_action;
  replay:=private.replay_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into a from public.cleaning_attempts where id=p_attempt_id;
  if not found then raise exception using errcode='42501',message='ATTEMPT_ACCESS_REQUIRED'; end if;
  -- All involved profiles in UUID order; no lock-order inversion with #7A.
  -- NO KEY UPDATE serializes role/status and #7A's FOR SHARE, while allowing
  -- FK KEY SHARE taken by availability/audit inserts (avoids lock inversion).
  perform 1 from public.profiles where id in (p_actor_profile_id,a.maid_profile_id,next_maid) order by id for no key update;
  actor:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  select * into maid from public.profiles where id=a.maid_profile_id;
  perform 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  select * into s from public.cleaning_assignments where id=a.assignment_id for update;
  select * into a from public.cleaning_attempts where id=p_attempt_id for update;
  at_time:=coalesce(p_command_at,clock_timestamp());
  if a.assignment_id<>p_expected_assignment_id or a.assignment_revision<>p_expected_assignment_revision
    or (p_action<>'expire_scheduled' and maid.role<>'maid') then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
  -- Saved receipts are responses only. They do not recreate grants or extend TTL.
  if replay is not null then return replay; end if;
  if maid.account_lifecycle_version<>p_expected_profile_version then
    raise exception using errcode='40001',message='ACCOUNT_VERSION_CONFLICT'; end if;
  if a.execution_version<>p_expected_execution_version then
    raise exception using errcode='40001',message='ATTEMPT_VERSION_CONFLICT'; end if;
  if not s.is_current or s.notified_at is null or t.assignment_version<>s.revision
    or s.revision<>a.assignment_revision or t.status='cancelled'
    or (a.room_snapshot->>'roomId') is distinct from t.room_id::text
    or s.notified_room_id_snapshot is distinct from t.room_id then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
  if p_action<>'expire_scheduled' and maid.status not in ('active','deactivation_pending','upload_only') then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  if p_action='allow_finish' then
    if a.status<>'in_progress' or maid.status not in ('active','deactivation_pending') then
      raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
    g:=private.issue_attempt_capability(a,'finish_current',p_actor_profile_id,at_time);
    if g.expires_at<=at_time or exists(select 1 from private.attempt_capability_revocations where capability_id=g.id) then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
    update public.profiles set status='deactivation_pending' where id=maid.id returning * into maid;
    perform private.notice_attempt_capability(g,t);
    event_name:='cleaning.finish_current_allowed';
  elsif p_action='allow_upload' then
    if a.status not in ('field_completed','upload_pending') or maid.status not in ('active','upload_only') then
      raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
    g:=private.issue_attempt_capability(a,'upload_submit',p_actor_profile_id,at_time);
    if g.expires_at<=at_time or exists(select 1 from private.attempt_capability_revocations where capability_id=g.id) then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
    update public.profiles set status='upload_only' where id=maid.id returning * into maid;
    perform private.notice_attempt_capability(g,t);
    event_name:='cleaning.upload_only_allowed';
  elsif p_action='expire_scheduled' then
    if a.status<>'scheduled' or a.started_at is not null or a.field_completed_at is not null or a.ended_at is not null
      or least(coalesce(t.due_at,'infinity'::timestamptz),(t.effective_service_date+1)::timestamp at time zone 'Asia/Seoul')>at_time then
      raise exception using errcode='55000',message='CLEANING_WINDOW_NOT_EXPIRED'; end if;
    perform private.assert_expired_attempt_replan(t,a.maid_profile_id);
    update public.cleaning_attempts set status='superseded',ended_at=at_time,end_reason='SCHEDULE_EXPIRED',
      execution_version=execution_version+1 where id=a.id returning * into a;
    rollover:=private.rollover_cleaning_target_at(p_actor_profile_id,t.id,at_time,s.id,t.assignment_version,t.effective_service_date);
    if rollover->>'status'<>'rolledOver' then
      raise exception using errcode='55000',message='ROLLOVER_NOT_ALLOWED'; end if;
    event_name:='cleaning.scheduled_expired';
  else
    if a.status<>'in_progress' or a.started_at is null or a.started_at>at_time
      or next_maid=a.maid_profile_id then raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
    if t.cleaning_kind='reclean' or t.source='inspection_reclean' then
      raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE'; end if;
    if next_date is distinct from (at_time at time zone 'Asia/Seoul')::date or next_from>at_time or next_due<=at_time then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
    perform private.assert_handover_schedule(t,next_date,next_from,next_due);
    if not exists(select 1 from public.profiles where id=next_maid and role='maid' and status='active') then
      raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    wk:=next_date-(extract(isodow from next_date)::integer-1);
    perform pg_advisory_xact_lock(hashtextextended('availability:'||next_maid::text||':'||wk::text,0));
    at_time:=coalesce(p_command_at,clock_timestamp());
    if next_date is distinct from (at_time at time zone 'Asia/Seoul')::date or next_from>at_time or next_due<=at_time then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
    if not exists(select 1 from public.availability_versions v join public.availability_days d on d.availability_version_id=v.id
      where v.maid_profile_id=next_maid and v.week_start=wk and v.is_current and d.work_date=next_date and d.available) then
      raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if exists(select 1 from public.cleaning_assignments where is_current and maid_profile_id=next_maid
      and service_date=next_date and sequence_number=next_sequence) then
      raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT'; end if;
    update public.cleaning_attempts set status='interrupted',ended_at=at_time,end_reason=p_reason_code,
      execution_version=execution_version+1 where id=a.id returning * into a;
    insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
      select id,at_time,'HANDOVER',p_actor_profile_id from private.attempt_capability_grants
      where attempt_id=a.id and kind in ('finish_current','upload_submit') on conflict(capability_id) do nothing;
    update public.cleaning_assignments set is_current=false,ended_at=at_time,change_reason_code=p_reason_code where id=s.id;
    update public.cleaning_targets set effective_service_date=next_date,available_from=next_from,due_at=next_due,
      assignment_version=assignment_version+1,status='notified' where id=t.id returning * into t;
    if t.cleaning_kind='checkout' then
      update public.checkout_cleaning_obligations set effective_service_date=next_date,available_from=next_from,due_at=next_due,
        version=version+1 where id=t.checkout_obligation_id and current_cleaning_target_id=t.id;
    end if;
    insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by)
      values(t.id,t.assignment_version,next_date,next_from,next_due,p_reason_code,p_actor_profile_id);
    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
      values(t.id,next_maid,next_sequence,t.assignment_version,p_actor_profile_id,at_time) returning * into ns;
    reason:=private.activation_reason_at(t,ns,at_time);
    if reason is not null then raise exception using errcode='55000',message=reason; end if;
    insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
      template_snapshot,room_snapshot)
      select t.id,ns.id,next_maid,coalesce(max(attempt_number),0)+1,'scheduled',ns.revision,a.template_snapshot,a.room_snapshot
      from public.cleaning_attempts where cleaning_target_id=t.id returning * into na;
    insert into private.attempt_handover_events(previous_attempt_id,next_attempt_id,actor_profile_id,reason_code,occurred_at)
      values(a.id,na.id,p_actor_profile_id,p_reason_code,at_time);
    g:=private.issue_attempt_capability(a,'evidence_upload',p_actor_profile_id,at_time);
    if deactivate_old or maid.status='deactivation_pending' then
      update public.profiles set status='upload_only' where id=maid.id returning * into maid;
    end if;
    update public.notifications set resolved_at=coalesce(resolved_at,at_time) where cleaning_target_id=t.id
      and recipient_profile_id=a.maid_profile_id and requires_action;
    perform private.prestart_notice(a.maid_profile_id,t,'cleaning_assignment_revoked','handover-old:'||a.id::text,false);
    perform private.prestart_notice(next_maid,t,'cleaning_assignment_notified','handover-new:'||na.id::text,true);
    event_name:='cleaning.interrupted_handover';
  end if;
  result:=jsonb_build_object('attempt',private.attempt_execution_projection(a),
    'capability',case when g.id is not null then private.attempt_capability_projection(g) end,
    'nextAttempt',case when na.id is not null then private.attempt_execution_projection(na) end,
    'profileStatus',maid.status,'profileVersion',maid.account_lifecycle_version,'effectiveAt',at_time,'recordedAt',clock_timestamp());
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
    effective_at,recorded_at,reason_code,after_state,idempotency_key)
  values(event_name,'cleaning_attempt',a.id,p_actor_profile_id,actor.display_name,at_time,clock_timestamp(),p_reason_code,
    private.attempt_execution_projection(a)||jsonb_build_object('capabilityKind',g.kind,'expiresAt',g.expires_at,
      'profileStatus',maid.status,'profileVersion',maid.account_lifecycle_version,'nextAttemptId',na.id),
    private.audit_command_key(p_actor_profile_id,cmd,p_idempotency_key));
  perform private.complete_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash,a.id,result);
  return result;
end; $$;
revoke all on function private.manage_cleaning_attempt_lifecycle_at(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text,timestamptz)
  from public,anon,authenticated,service_role;
create function public.manage_cleaning_attempt_lifecycle(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_expected_profile_version bigint,
  p_action text,p_payload jsonb,p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select private.manage_cleaning_attempt_lifecycle_at(p_actor_profile_id,p_session_id,p_attempt_id,p_expected_execution_version,
    p_expected_assignment_id,p_expected_assignment_revision,p_expected_profile_version,p_action,p_payload,p_reason_code,p_idempotency_key,p_request_hash,null);
$$;
revoke all on function public.manage_cleaning_attempt_lifecycle(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text)
  from public,anon,authenticated;
grant execute on function public.manage_cleaning_attempt_lifecycle(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text) to service_role;

create function private.complete_limited_attempt_at(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a public.cleaning_attempts%rowtype; s public.cleaning_assignments%rowtype;
  t public.cleaning_targets%rowtype; g private.attempt_capability_grants%rowtype; upload_g private.attempt_capability_grants%rowtype;
  replay jsonb; result jsonb; at_time timestamptz; cmd constant text:='cleaning.limited.complete_field_work';
begin
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  if p_expected_execution_version is null or p_expected_execution_version<1 or p_expected_assignment_revision is null
    or p_expected_assignment_revision<1 or p_expected_assignment_id is null or p_attempt_id is null then
    raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND'; end if;
  replay:=private.replay_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  select * into a from public.cleaning_attempts where id=p_attempt_id and maid_profile_id=p_actor_profile_id;
  perform 1 from auth.sessions where id=p_session_id and user_id=p.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  if a.id is null then raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  select * into s from public.cleaning_assignments where id=a.assignment_id for update;
  select * into a from public.cleaning_attempts where id=p_attempt_id for update;
  at_time:=coalesce(p_command_at,clock_timestamp());
  if a.assignment_id<>p_expected_assignment_id or a.assignment_revision<>p_expected_assignment_revision
    or not s.is_current or s.notified_at is null or s.revision<>a.assignment_revision
    or t.assignment_version<>s.revision or t.status='cancelled' then
    raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
  if replay is not null then
    if a.status not in ('field_completed','upload_pending') or p.status<>'upload_only' then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
    return replay;
  end if;
  g:=private.live_attempt_capability(p_actor_profile_id,p_attempt_id,p_expected_assignment_revision,'complete_field_work',at_time);
  if a.execution_version<>p_expected_execution_version then
    raise exception using errcode='40001',message='ATTEMPT_VERSION_CONFLICT'; end if;
  if a.status<>'in_progress' or a.started_at is null or a.started_at>at_time then
    raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
  -- Actual field completion is not blocked by midnight or a normal checkout.
  update public.cleaning_attempts set status='field_completed',field_completed_at=at_time,ended_at=at_time,
    execution_version=execution_version+1 where id=a.id returning * into a;
  insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
    values(g.id,at_time,'FIELD_COMPLETED',p_actor_profile_id);
  upload_g:=private.issue_attempt_capability(a,'upload_submit',p_actor_profile_id,at_time);
  update public.profiles set status='upload_only' where id=p_actor_profile_id returning * into p;
  perform private.notice_attempt_capability(upload_g,t);
  result:=jsonb_build_object('attempt',private.attempt_execution_projection(a),
    'capability',private.attempt_capability_projection(upload_g),'nextAttempt',null,
    'profileStatus',p.status,'profileVersion',p.account_lifecycle_version,'effectiveAt',at_time,'recordedAt',clock_timestamp());
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
    effective_at,recorded_at,after_state,idempotency_key)
  values('cleaning.field_completed','cleaning_attempt',a.id,p_actor_profile_id,p.display_name,at_time,clock_timestamp(),
    private.attempt_execution_projection(a)||jsonb_build_object('capabilityKind',upload_g.kind,'expiresAt',upload_g.expires_at,
      'profileStatus',p.status,'profileVersion',p.account_lifecycle_version),private.audit_command_key(p_actor_profile_id,cmd,p_idempotency_key));
  perform private.complete_command(p_actor_profile_id,cmd,p_idempotency_key,p_request_hash,a.id,result);
  return result;
end; $$;
revoke all on function private.complete_limited_attempt_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz)
  from public,anon,authenticated,service_role;
create function public.complete_limited_cleaning_attempt_field_work(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
  select private.complete_limited_attempt_at(p_actor_profile_id,p_session_id,p_attempt_id,p_expected_execution_version,
    p_expected_assignment_id,p_expected_assignment_revision,p_idempotency_key,p_request_hash,null);
$$;
revoke all on function public.complete_limited_cleaning_attempt_field_work(uuid,uuid,uuid,bigint,uuid,bigint,text,text)
  from public,anon,authenticated;
grant execute on function public.complete_limited_cleaning_attempt_field_work(uuid,uuid,uuid,bigint,uuid,bigint,text,text) to service_role;

create function private.guard_attempt_handover_identity()
returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from public.cleaning_attempts old_a join public.cleaning_attempts next_a
      on next_a.id=new.next_attempt_id join public.cleaning_assignments old_s on old_s.id=old_a.assignment_id
      join public.cleaning_assignments next_s on next_s.id=next_a.assignment_id
    where old_a.id=new.previous_attempt_id and old_a.id<>next_a.id and old_a.cleaning_target_id=next_a.cleaning_target_id
      and old_a.status='interrupted' and old_a.ended_at=new.occurred_at and not old_s.is_current and old_s.ended_at is not null
      and next_a.status='scheduled' and next_a.started_at is null and next_a.field_completed_at is null and next_a.ended_at is null
      and next_s.is_current and next_s.notified_at is not null and old_s.id<>next_s.id
      and next_a.attempt_number>old_a.attempt_number and next_a.assignment_revision>old_a.assignment_revision) then
    raise exception using errcode='23514',message='HANDOVER_IDENTITY_INVALID';
  end if;
  return new;
end; $$;
revoke all on function private.guard_attempt_handover_identity() from public,anon,authenticated,service_role;
create trigger attempt_handover_identity before insert on private.attempt_handover_events
  for each row execute function private.guard_attempt_handover_identity();

-- Only a validated, immutable handover link retires interrupted work from current
-- workflow checks. The descendant itself is still independently checked. This
-- handles A -> B -> C without treating field_completed or orphan interruption as idle.
create function private.attempt_blocks_assignment(p_attempt public.cleaning_attempts)
returns boolean language sql stable security definer set search_path='' as $$
  select p_attempt.status<>'superseded' and not (p_attempt.status='interrupted' and exists(
    select 1 from private.attempt_handover_events h join public.cleaning_attempts n on n.id=h.next_attempt_id
      join public.cleaning_assignments s on s.id=p_attempt.assignment_id
    where h.previous_attempt_id=p_attempt.id and n.id<>p_attempt.id
      and n.cleaning_target_id=p_attempt.cleaning_target_id and n.attempt_number>p_attempt.attempt_number
      and n.assignment_revision>p_attempt.assignment_revision and p_attempt.ended_at=h.occurred_at
      and not s.is_current and s.ended_at is not null));
$$;
revoke all on function private.attempt_blocks_assignment(public.cleaning_attempts) from public,anon,authenticated,service_role;

-- Append-only current-work checks: only proven handover history is excluded.
create or replace function private.assignment_commit_candidates_at(
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
          and private.attempt_blocks_assignment(attempt)
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
          and (
            (reservation.status = 'checked_out'
              and reservation.actual_checkout_at is not null
              and obligation.status = 'materialized'
              and obligation.current_cleaning_target_id = target.id)
            or (target.source = 'scheduled_checkout'
              and reservation.status = 'active'
              and reservation.actual_checkout_at is null
              and reservation.check_out_at = target.available_from
              and obligation.status = 'private'
              and obligation.current_cleaning_target_id is null
              and obligation.planned_cleaning_target_id = target.id)
          )
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

create or replace function private.assignment_prestart_command(
  p_actor uuid,p_action text,p_target uuid,p_assignment uuid,p_version bigint,
  p_maid uuid,p_sequence integer,p_available timestamptz,p_due timestamptz,
  p_request uuid,p_decision text,p_reason text,p_detail text,p_key text,p_hash text
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  t public.cleaning_targets%rowtype; a public.cleaning_assignments%rowtype; next_a public.cleaning_assignments%rowtype;
  q public.assignment_change_requests%rowtype; r public.reservations%rowtype;
  cmd text; event_name text; response jsonb; summary jsonb; entity uuid;
  wk date; admin_row record; was_notified boolean; changed_schedule boolean;
  access_at timestamptz; deadline timestamptz; v_now timestamptz:=clock_timestamp();
begin
  if p_action='request' then
    if private.assert_active_actor(p_actor)<>'maid' then
      raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  else perform private.assert_room_admin(p_actor); end if;
  cmd:=case p_action when 'change' then 'assignment.prestart_change' when 'unassign' then 'assignment.prestart_unassign'
    when 'request' then 'assignment.cancellation_request' when 'decision' then 'assignment.cancellation_decision' end;
  if cmd is null or p_version is null or p_version<1 or p_assignment is null then
    raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
  if p_reason is null or not (p_reason=any(case p_action when 'request' then
    array['PERSONAL_REASON','HEALTH_REASON','MAID_UNAVAILABLE','OPERATIONAL_CHANGE']
    when 'decision' then array['APPROVED','REJECTED','OPERATIONAL_CHANGE','MAID_UNAVAILABLE']
    else array['MAID_UNAVAILABLE','SCHEDULE_CHANGED','SEQUENCE_CHANGED','OPERATIONAL_CHANGE'] end)) then
    raise exception using errcode='22023',message='ASSIGNMENT_REASON_INVALID'; end if;
  if p_detail is not null and (char_length(p_detail) not between 1 and 200 or p_detail ~ '[0-9@:/]') then
    raise exception using errcode='22023',message='ASSIGNMENT_REASON_INVALID'; end if;
  response:=private.replay_command(p_actor,cmd,p_key,p_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if p_action='decision' then
    if p_decision is null or p_decision not in ('approved','rejected') then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
    select * into q from public.assignment_change_requests where id=p_request;
    if not found then raise exception using errcode='P0002',message='ASSIGNMENT_CHANGE_REQUEST_NOT_FOUND'; end if;
    p_target:=q.cleaning_target_id;
  end if;
  select * into t from public.cleaning_targets where id=p_target for update;
  select * into a from public.cleaning_assignments where cleaning_target_id=t.id and is_current for update;
  if p_action='decision' then
    select * into q from public.assignment_change_requests where id=p_request for update;
    if q.status='superseded' then raise exception using errcode='40001',message='ASSIGNMENT_CHANGE_REQUEST_STALE'; end if;
    if q.status<>'pending' then raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_ALREADY_DECIDED'; end if;
    if q.assignment_id is distinct from a.id or q.source_target_assignment_version is distinct from t.assignment_version
      or q.assignment_id is distinct from p_assignment or q.source_target_assignment_version is distinct from p_version then
      raise exception using errcode='40001',message='ASSIGNMENT_CHANGE_REQUEST_STALE'; end if;
  end if;
  if t.id is null or a.id is null then raise exception using errcode='P0002',message='ASSIGNMENT_NOT_FOUND'; end if;
  if p_action='request' and a.maid_profile_id<>p_actor then
    raise exception using errcode='42501',message='ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED'; end if;
  if exists(select 1 from public.cleaning_attempts attempt where cleaning_target_id=t.id and private.attempt_blocks_assignment(attempt)) then
    raise exception using errcode='23514',message='ASSIGNMENT_ALREADY_STARTED'; end if;
  if t.status not in ('draft_assigned','notified') or (p_action in ('request','decision') and t.status<>'notified') then
    raise exception using errcode='23514',message='ASSIGNMENT_PRESTART_REQUIRED'; end if;
  if t.assignment_version<>p_version or a.id<>p_assignment then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
  was_notified:=t.status='notified';
  if p_action='change' then
    if p_sequence is null or p_sequence<1 or p_maid is null then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
    perform 1 from public.profiles where id=p_maid and role='maid' and status='active' for share;
    if not found then raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if t.source='inspection_reclean' and p_maid is distinct from t.reclean_maid_profile_id then
      raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE'; end if;
    wk:=t.effective_service_date-(extract(isodow from t.effective_service_date)::integer-1);
    perform pg_advisory_xact_lock(hashtextextended('availability:'||p_maid::text||':'||wk::text,0));
    if not exists(select 1 from public.availability_versions v join public.availability_days d on d.availability_version_id=v.id
      where v.maid_profile_id=p_maid and v.week_start=wk and v.is_current and d.work_date=t.effective_service_date and d.available) then
      raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if exists(select 1 from public.cleaning_assignments where is_current and id<>a.id and maid_profile_id=p_maid
      and service_date=t.effective_service_date and sequence_number=p_sequence) then
      raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT'; end if;
    access_at:=coalesce(p_available,t.available_from); deadline:=coalesce(p_due,t.due_at);
    changed_schedule:=access_at is distinct from t.available_from or deadline is distinct from t.due_at;
    if changed_schedule then
      -- 생성 command의 source-kind 조합만 허용한다. 예약/checkout 원장의 시간은 #27로 우회하지 않는다.
      if not ((t.source='manual_room_request' and t.cleaning_kind='additional')
          or (t.source='stayover_request' and t.cleaning_kind='stayover'))
        or access_at is null or deadline is null or access_at>=deadline
        or t.available_from is null or t.due_at is null
        or access_at<t.available_from or deadline>t.due_at
        or (access_at at time zone 'Asia/Seoul')::date<>t.effective_service_date
        or (deadline at time zone 'Asia/Seoul')::date<>t.effective_service_date then
        raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
      if t.cleaning_kind='stayover' then
        select * into r from public.reservations where id=t.reservation_id;
        if r.id is null or r.room_id is distinct from t.room_id
          or r.status<>'active' or r.actual_check_in_at is null or r.actual_checkout_at is not null
          or access_at<r.actual_check_in_at or deadline>r.check_out_at then
          raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
      end if;
    end if;
    update public.cleaning_assignments set is_current=false,ended_at=v_now,change_reason_code=p_reason where id=a.id;
    update public.cleaning_targets set assignment_version=assignment_version+1,available_from=access_at,due_at=deadline
      where id=t.id returning * into t;
    if changed_schedule then
      insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by)
      values(t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,p_reason,p_actor);
    end if;
    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
    values(t.id,p_maid,p_sequence,t.assignment_version,p_actor,case when was_notified then v_now end) returning * into next_a;
    if was_notified then
      update public.notifications set resolved_at=coalesce(resolved_at,v_now) where cleaning_target_id=t.id
        and recipient_profile_id=a.maid_profile_id and requires_action
        and category in ('cleaning_assignment_notified','cleaning_assignment_changed','cleaning_schedule_changed');
      if a.maid_profile_id<>p_maid then
        perform private.prestart_notice(a.maid_profile_id,t,'cleaning_assignment_revoked','prestart-revoke:'||a.id::text,false);
      end if;
      perform private.prestart_notice(p_maid,t,case when a.maid_profile_id=p_maid then 'cleaning_assignment_changed' else 'cleaning_assignment_notified' end,
        'prestart-notify:'||next_a.id::text,true);
    end if;
    event_name:='assignment.prestart_changed'; entity:=next_a.id;
    response:=private.prestart_assignment_projection(next_a.id);
  elsif p_action='request' then
    if exists(select 1 from public.assignment_change_requests where assignment_id=a.id and status='pending') then
      raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_EXISTS'; end if;
    insert into public.assignment_change_requests(cleaning_target_id,assignment_id,maid_profile_id,reason_code,reason_detail,
      source_assignment_revision,source_target_assignment_version)
    values(t.id,a.id,p_actor,p_reason,p_detail,a.revision,t.assignment_version) returning * into q;
    for admin_row in select id from public.profiles where role='admin' and status='active' order by id loop
      perform private.prestart_notice(admin_row.id,t,'assignment_cancellation_requested','assignment-request:'||q.id::text,true);
    end loop;
    event_name:='assignment.cancellation_requested'; entity:=q.id;
    response:=private.assignment_request_projection(q);
  else
    if p_action='decision' then
      -- 요청을 먼저 terminal로 만들어 source 종료 trigger가 승인 이력을 superseded로 덮지 않게 한다.
      update public.assignment_change_requests set status=p_decision,decided_by=p_actor,decided_at=v_now,decision_reason_code=p_reason
      where id=q.id returning * into q;
      update public.notifications set resolved_at=coalesce(resolved_at,v_now) where dedupe_key='assignment-request:'||q.id::text and requires_action;
    end if;
    if p_action='unassign' or p_decision='approved' then
      update public.cleaning_assignments set is_current=false,ended_at=v_now,change_reason_code=p_reason where id=a.id;
      update public.cleaning_targets set status='unassigned',assignment_version=assignment_version+1 where id=t.id returning * into t;
      if was_notified then
        update public.notifications set resolved_at=coalesce(resolved_at,v_now) where cleaning_target_id=t.id
          and recipient_profile_id=a.maid_profile_id and requires_action
          and category in ('cleaning_assignment_notified','cleaning_assignment_changed','cleaning_schedule_changed');
      end if;
    end if;
    if was_notified then
      perform private.prestart_notice(a.maid_profile_id,t,
        case when p_action='unassign' then 'cleaning_assignment_revoked'
          when p_decision='approved' then 'assignment_cancellation_approved' else 'assignment_cancellation_rejected' end,
        case when p_action='unassign' then 'prestart-revoke:'||a.id::text else 'assignment-decision:'||q.id::text end,false);
    end if;
    if p_action='unassign' then event_name:='assignment.prestart_unassigned';entity:=a.id;
      response:=private.prestart_assignment_projection(a.id);
    else event_name:='assignment.cancellation_decided';entity:=q.id;response:=private.assignment_request_projection(q);end if;
  end if;
  summary:=jsonb_strip_nulls(jsonb_build_object('cleaningTargetId',t.id,'assignmentId',coalesce(next_a.id,a.id),
    'previousAssignmentId',case when next_a.id is not null then a.id end,'maidProfileId',coalesce(next_a.maid_profile_id,a.maid_profile_id),
    'previousMaidProfileId',case when next_a.id is not null then a.maid_profile_id end,'serviceDate',t.effective_service_date,
    'sequenceNumber',coalesce(next_a.sequence_number,a.sequence_number),'revision',coalesce(next_a.revision,a.revision),
    'targetAssignmentVersion',t.assignment_version,'requestId',q.id,'decision',p_decision,'reasonCode',p_reason));
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  select p_actor,display_name,event_name,case when q.id is null then 'cleaning_assignment' else 'assignment_change_request' end,
    entity,v_now,p_reason,summary,p_hash,private.audit_command_key(p_actor,cmd,p_key) from public.profiles where id=p_actor;
  perform private.complete_command(p_actor,cmd,p_key,p_hash,entity,response);
  return response;
end;
$$;

create or replace function private.activate_cleaning_attempt_at(
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
    and private.attempt_blocks_assignment(attempt)
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

create or replace function private.rollover_cleaning_target_at(
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
  v_next_available_from timestamptz;
  v_next_due_at timestamptz;
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
      and private.attempt_blocks_assignment(attempt)
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

  v_window_end := least(coalesce(v_target.due_at,'infinity'::timestamptz),
    ((v_target.effective_service_date + 1)::timestamp at time zone 'Asia/Seoul'));
  if v_window_end > p_command_at then
    return private.assignment_activation_result(
      'notReady', 'CLEANING_WINDOW_NOT_EXPIRED', v_target, v_assignment, null
    );
  end if;

  v_old_date := v_target.effective_service_date;
  v_new_date := v_old_date + 1;
  v_day_delta := v_new_date - v_old_date;
  v_next_available_from := v_target.available_from + make_interval(days => v_day_delta);
  v_next_due_at := v_target.due_at + make_interval(days => v_day_delta);

  -- Validate the proposed source window before closing assignments or writing any side effect.
  -- Invalid stayovers remain unchanged for explicit domain resolution, never auto-cancelled.
  if v_target.source = 'stayover_request' and v_target.cleaning_kind = 'stayover' then
    if not exists (
      select 1 from public.reservations reservation
      where reservation.id = v_target.reservation_id
        and reservation.room_id = v_target.room_id
        and reservation.status = 'active'
        and reservation.actual_check_in_at is not null
        and reservation.actual_checkout_at is null
        and v_next_available_from is not null
        and v_next_due_at is not null
        and v_next_available_from < v_next_due_at
        and v_next_available_from >= reservation.actual_check_in_at
        and v_next_due_at <= reservation.check_out_at
        and (v_next_available_from at time zone 'Asia/Seoul')::date = v_new_date
    ) then
      return private.assignment_activation_result(
        'blocked', 'STAYOVER_ROLLOVER_NOT_ALLOWED', v_target, v_assignment, null
      );
    end if;
  elsif v_target.source = 'manual_room_request' and v_target.cleaning_kind = 'additional' then
    -- Same active-reservation overlap boundary as activation, evaluated on the shifted window.
    if v_next_available_from is null or exists (
      select 1 from public.reservations reservation
      where reservation.room_id = v_target.room_id
        and reservation.status = 'active'
        and tstzrange(
          coalesce(reservation.actual_check_in_at, reservation.check_in_at),
          case
            when reservation.actual_check_in_at is not null
              and reservation.actual_checkout_at is null then 'infinity'::timestamptz
            else coalesce(reservation.actual_checkout_at, reservation.check_out_at)
          end, '[)'
        ) && tstzrange(
          v_next_available_from,
          coalesce(v_next_due_at, v_next_available_from + make_interval(
            mins => coalesce(nullif(v_target.template_snapshot ->> 'durationMinutes', '')::integer, 1)
          )), '[)'
        )
    ) then
      return private.assignment_activation_result(
        'blocked', 'ADDITIONAL_ROLLOVER_NOT_ALLOWED', v_target, v_assignment, null
      );
    end if;
  end if;

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
      available_from = v_next_available_from,
      due_at = v_next_due_at,
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

create or replace function private.assignment_preview_snapshot_at(
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
    and private.attempt_blocks_assignment(attempt) order by attempt.attempt_number desc limit 1) att on true;
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



-- Preserve prior audit categories while projecting only approved lifecycle fields.
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
      'CAPABILITY_ACCESS_REQUIRED',
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
      'CAPABILITY_ACCESS_REQUIRED',
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
    and (profile.status = 'active' or (profile.role='maid' and profile.status in ('deactivation_pending','upload_only')
      and p_source='edge.authorization.attempts' and p_reason_code='CAPABILITY_ACCESS_REQUIRED'));
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
    'cleaning.finish_current_allowed','cleaning.upload_only_allowed','cleaning.interrupted_handover','cleaning.scheduled_expired',
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
      when audit.event_type in ('cleaning.attempt_started','cleaning.field_completed',
        'cleaning.finish_current_allowed','cleaning.upload_only_allowed','cleaning.interrupted_handover','cleaning.scheduled_expired') then jsonb_strip_nulls(jsonb_build_object(
        'attemptId',audit.after_state->>'attemptId','cleaningTargetId',audit.after_state->>'cleaningTargetId',
        'assignmentId',audit.after_state->>'assignmentId','maidProfileId',audit.after_state->>'maidProfileId',
        'assignmentRevision',audit.after_state->'assignmentRevision','executionVersion',audit.after_state->'executionVersion',
        'status',audit.after_state->>'status','startedAt',audit.after_state->>'startedAt',
        'fieldCompletedAt',audit.after_state->>'fieldCompletedAt','endedAt',audit.after_state->>'endedAt',
        'capabilityKind',audit.after_state->>'capabilityKind','expiresAt',audit.after_state->>'expiresAt',
        'profileStatus',audit.after_state->>'profileStatus','profileVersion',audit.after_state->'profileVersion',
        'nextAttemptId',audit.after_state->>'nextAttemptId'))
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
