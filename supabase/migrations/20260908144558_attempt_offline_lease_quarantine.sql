-- #7C: server-issued offline completion lease; event data has a hard 90-day
-- horizon. No client event identity/clock/hash is copied to permanent receipts.
create table private.offline_work_leases (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  attempt_id uuid not null unique references public.cleaning_attempts(id) on delete restrict,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  assignment_revision bigint not null check(assignment_revision>0),
  execution_version bigint not null check(execution_version>0),
  profile_version bigint not null check(profile_version>0),
  version bigint not null default 1 check(version=1),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  metadata_expires_at timestamptz not null,
  unique(id,actor_profile_id,metadata_expires_at),
  unique(id,metadata_expires_at),
  check(expires_at=issued_at+interval '2 hours'),
  check(metadata_expires_at=issued_at+interval '90 days')
);
create index offline_lease_actor_idx on private.offline_work_leases(actor_profile_id,attempt_id);
create index offline_lease_assignment_idx on private.offline_work_leases(assignment_id);
create index offline_lease_expiry_idx on private.offline_work_leases(metadata_expires_at,id);
create table private.offline_work_lease_revocations (
  lease_id uuid primary key references private.offline_work_leases(id) on delete restrict,
  revoked_at timestamptz not null,
  reason_code text not null check(reason_code in('ACCOUNT_CHANGED','ATTEMPT_CHANGED')),
  metadata_expires_at timestamptz not null
);
alter table private.offline_work_lease_revocations add foreign key(lease_id,metadata_expires_at)
  references private.offline_work_leases(id,metadata_expires_at) on delete restrict;
create table private.offline_completion_events (
  id uuid primary key default gen_random_uuid(),
  lease_id uuid not null unique references private.offline_work_leases(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  event_id uuid not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  server_offset_ms bigint not null,
  normalized_occurred_at timestamptz not null,
  received_at timestamptz not null,
  metadata_expires_at timestamptz not null,
  outcome text not null check(outcome in('applied','quarantined')),
  reason_code text check(reason_code in('LEASE_EXPIRED','LEASE_REVOKED','ASSIGNMENT_CHANGED','CLOCK_CONFLICT','KST_DATE_CONFLICT')),
  response_payload jsonb not null,
  unique(id,metadata_expires_at),
  unique(actor_profile_id,event_id),
  foreign key(lease_id,actor_profile_id,metadata_expires_at)
    references private.offline_work_leases(id,actor_profile_id,metadata_expires_at) on delete restrict,
  check((outcome='applied')=(reason_code is null)),
  check(received_at<metadata_expires_at)
);
create index offline_event_expiry_idx on private.offline_completion_events(metadata_expires_at,id);
create index offline_quarantine_query_idx on private.offline_completion_events(received_at desc,id desc) where outcome='quarantined';
-- Short-lived resolution replay includes no permanent duplicate of event data.
create table private.offline_event_resolutions (
  id uuid primary key default gen_random_uuid(),
  event_record_id uuid not null unique references private.offline_completion_events(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  resolution text not null check(resolution in('record_only','reject_effect','correction_link')),
  idempotency_key text not null,
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  response_payload jsonb not null,
  metadata_expires_at timestamptz not null,
  unique(actor_profile_id,idempotency_key)
);
alter table private.offline_event_resolutions add foreign key(event_record_id,metadata_expires_at)
  references private.offline_completion_events(id,metadata_expires_at) on delete restrict;
create index offline_resolution_expiry_idx on private.offline_event_resolutions(metadata_expires_at,id);

create function private.guard_offline_metadata() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' and old.metadata_expires_at<=clock_timestamp() then return old; end if;
  raise exception using errcode='55000',message='OFFLINE_METADATA_IMMUTABLE';
end; $$;
do $$ declare n text; begin
  foreach n in array array['offline_work_leases','offline_work_lease_revocations','offline_completion_events','offline_event_resolutions'] loop
    execute format('alter table private.%I enable row level security',n);
    execute format('revoke all on private.%I from public,anon,authenticated,service_role',n);
    execute format('create trigger immutable_offline_metadata before update or delete on private.%I for each row execute function private.guard_offline_metadata()',n);
  end loop;
end $$;
revoke all on function private.guard_offline_metadata() from public,anon,authenticated,service_role;

create function private.revoke_offline_work_lease() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='profiles' then
    if new.status is distinct from old.status or new.role is distinct from old.role then
      insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
      select id,clock_timestamp(),'ACCOUNT_CHANGED',metadata_expires_at from private.offline_work_leases
      where actor_profile_id=old.id and metadata_expires_at>clock_timestamp() on conflict do nothing;
    end if;
  elsif new.status is distinct from old.status or new.assignment_revision is distinct from old.assignment_revision then
    insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
    select id,clock_timestamp(),'ATTEMPT_CHANGED',metadata_expires_at from private.offline_work_leases
    where attempt_id=old.id and metadata_expires_at>clock_timestamp() on conflict do nothing;
  end if;
  return new;
end; $$;
create trigger revoke_offline_on_profile after update on public.profiles for each row execute function private.revoke_offline_work_lease();
create trigger revoke_offline_on_attempt after update on public.cleaning_attempts for each row execute function private.revoke_offline_work_lease();
revoke all on function private.revoke_offline_work_lease() from public,anon,authenticated,service_role;

create function private.offline_lease_projection(g private.offline_work_leases) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('leaseId',g.id,'version',g.version,'attemptId',g.attempt_id,'assignmentId',g.assignment_id,
  'assignmentRevision',g.assignment_revision,'issuedAt',g.issued_at,'expiresAt',g.expires_at,
  'metadataExpiresAt',g.metadata_expires_at,'allowedActions',jsonb_build_array('complete_field_work'));
$$;
create function private.start_attempt_with_lease_at(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a public.cleaning_attempts%rowtype; g private.offline_work_leases%rowtype;
  result jsonb; at_time timestamptz;
begin
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  if p.status<>'active' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  -- Same order as execution/lifecycle; no external calls inside the transaction.
  perform private.replay_command(p_actor_profile_id,'cleaning.attempt.start',p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  if p.status<>'active' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  perform 1 from auth.sessions where id=p_session_id and user_id=p.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  select * into a from public.cleaning_attempts where id=p_attempt_id;
  if a.id is null or a.maid_profile_id<>p_actor_profile_id then
    raise exception using errcode='42501',message='ATTEMPT_ACCESS_REQUIRED'; end if;
  select * into g from private.offline_work_leases where attempt_id=p_attempt_id;
  at_time:=coalesce(p_command_at,clock_timestamp());
  -- A started legacy/purged attempt never receives a newly issued lease.
  if g.id is null and a.status is distinct from 'scheduled' then
    raise exception using errcode='55000',message='OFFLINE_LEASE_ISSUANCE_CLOSED'; end if;
  if g.id is not null and at_time>=g.metadata_expires_at then
    raise exception using errcode='55000',message='OFFLINE_EVENT_EXPIRED'; end if;
  result:=private.execute_cleaning_attempt_at(p_actor_profile_id,p_attempt_id,p_expected_execution_version,
    p_expected_assignment_id,p_expected_assignment_revision,p_idempotency_key,p_request_hash,'start',p_command_at);
  at_time:=coalesce(p_command_at,clock_timestamp());
  if g.id is not null and at_time>=g.metadata_expires_at then
    raise exception using errcode='55000',message='OFFLINE_EVENT_EXPIRED'; end if;
  if g.id is null then
    select * into a from public.cleaning_attempts where id=p_attempt_id;
    insert into private.offline_work_leases(actor_profile_id,attempt_id,assignment_id,assignment_revision,execution_version,
      profile_version,issued_at,expires_at,metadata_expires_at)
    values(p_actor_profile_id,a.id,a.assignment_id,a.assignment_revision,a.execution_version,p.account_lifecycle_version,
      a.started_at,a.started_at+interval '2 hours',a.started_at+interval '90 days') returning * into g;
  end if;
  return jsonb_build_object('attempt',result,'lease',private.offline_lease_projection(g),'serverTime',coalesce(p_command_at,clock_timestamp()));
end; $$;
create function public.start_cleaning_attempt_with_lease(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
select private.start_attempt_with_lease_at(p_actor_profile_id,p_session_id,p_attempt_id,p_expected_execution_version,
  p_expected_assignment_id,p_expected_assignment_revision,p_idempotency_key,p_request_hash,null);
$$;

-- Called only after domain/profile/session/target/assignment/attempt locks.
create function private.assert_offline_current_attempt(a public.cleaning_attempts,g private.offline_work_leases)
returns void language plpgsql stable set search_path='' as $$
declare s public.cleaning_assignments%rowtype; t public.cleaning_targets%rowtype;
begin
  select * into s from public.cleaning_assignments where id=a.assignment_id;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id;
  if a.maid_profile_id<>g.actor_profile_id or a.assignment_id<>g.assignment_id or a.assignment_revision<>g.assignment_revision
    or not s.is_current or s.notified_at is null or s.revision<>g.assignment_revision or t.assignment_version<>s.revision
    or t.status='cancelled' or s.notified_room_id_snapshot is distinct from t.room_id
    or a.room_snapshot->>'roomId' is distinct from t.room_id::text then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
end; $$;

create function private.sync_attempt_event_at(
  p_actor_profile_id uuid,p_session_id uuid,p_lease_id uuid,p_event_id uuid,p_expected_execution_version bigint,
  p_occurred_at timestamptz,p_server_offset_ms bigint,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.profiles%rowtype; a public.cleaning_attempts%rowtype; g private.offline_work_leases%rowtype;
  e private.offline_completion_events%rowtype; at_time timestamptz; normalized timestamptz; reason text; h text;
  result jsonb; outcome text; server_id uuid:=gen_random_uuid();
begin
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  if p_lease_id is null or p_event_id is null or p_expected_execution_version is null or p_expected_execution_version<1
    or p_occurred_at is null or not isfinite(p_occurred_at) or p_occurred_at<'0001-01-01 00:00:00+00'::timestamptz
    or p_occurred_at>='10000-01-01 00:00:00+00'::timestamptz or p_server_offset_ms is null
    or p_server_offset_ms not between -86400000 and 86400000 then
    raise exception using errcode='22023',message='INVALID_OFFLINE_EVENT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('offline-event:'||p_actor_profile_id::text||':'||p_event_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  p:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,false);
  perform 1 from auth.sessions where id=p_session_id and user_id=p.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  select * into g from private.offline_work_leases where id=p_lease_id and actor_profile_id=p_actor_profile_id;
  if g.id is null then raise exception using errcode='42501',message='OFFLINE_LEASE_UNKNOWN'; end if;
  select * into a from public.cleaning_attempts where id=g.attempt_id;
  perform 1 from public.cleaning_targets where id=a.cleaning_target_id for update;
  perform 1 from public.cleaning_assignments where id=a.assignment_id for update;
  select * into a from public.cleaning_attempts where id=g.attempt_id for update;
  select * into g from private.offline_work_leases where id=p_lease_id for update;
  if g.id is null then raise exception using errcode='42501',message='OFFLINE_LEASE_UNKNOWN'; end if;
  at_time:=coalesce(p_command_at,clock_timestamp());
  if at_time>=g.metadata_expires_at then raise exception using errcode='55000',message='OFFLINE_EVENT_EXPIRED'; end if;
  normalized:=p_occurred_at+make_interval(secs=>p_server_offset_ms::double precision/1000);
  if normalized<'0001-01-01 00:00:00+00'::timestamptz or normalized>='10000-01-01 00:00:00+00'::timestamptz then
    raise exception using errcode='22023',message='INVALID_OFFLINE_EVENT'; end if;
  h:=encode(extensions.digest(convert_to(jsonb_build_array(p_lease_id,p_event_id,p_expected_execution_version,
    p_occurred_at,p_server_offset_ms)::text,'UTF8'),'sha256'),'hex');
  select * into e from private.offline_completion_events where actor_profile_id=p_actor_profile_id and event_id=p_event_id;
  if e.id is not null then
    if e.request_hash<>h then raise exception using errcode='23505',message='OFFLINE_EVENT_CONFLICT'; end if;
    return e.response_payload;
  end if;
  if exists(select 1 from private.offline_completion_events where lease_id=g.id) then
    raise exception using errcode='23505',message='OFFLINE_EVENT_CONFLICT'; end if;
  if at_time>=g.expires_at then reason:='LEASE_EXPIRED';
  elsif p.status<>'active' or p.account_lifecycle_version<>g.profile_version
    or exists(select 1 from private.offline_work_lease_revocations where lease_id=g.id) then reason:='LEASE_REVOKED';
  elsif a.status<>'in_progress' or a.execution_version<>p_expected_execution_version or g.execution_version<>p_expected_execution_version then
    reason:='ASSIGNMENT_CHANGED';
  end if;
  if reason is null then
    begin perform private.assert_offline_current_attempt(a,g);
    exception when sqlstate '40001' then reason:='ASSIGNMENT_CHANGED'; end;
  end if;
  if reason is null and (abs(p_server_offset_ms)>300000 or normalized<a.started_at or normalized>=g.expires_at
    or normalized>at_time or normalized<g.issued_at) then reason:='CLOCK_CONFLICT'; end if;
  if reason is null and (normalized at time zone 'Asia/Seoul')::date<>(at_time at time zone 'Asia/Seoul')::date then
    reason:='KST_DATE_CONFLICT'; end if;
  if reason is null then
    update public.cleaning_attempts set status='field_completed',field_completed_at=normalized,ended_at=normalized,
      execution_version=execution_version+1 where id=a.id returning * into a;
    -- Domain effective time is validated physical completion; raw client clock,
    -- offset, event UUID and hash stay exclusively in expiring metadata.
    insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
      effective_at,recorded_at,after_state)
    values('cleaning.field_completed','cleaning_attempt',a.id,p.id,p.display_name,normalized,at_time,
      private.attempt_execution_projection(a));
    outcome:='applied';
  else outcome:='quarantined'; end if;
  result:=jsonb_build_object('eventId',p_event_id,'outcome',outcome,'reasonCode',reason,
    'attempt',case when outcome='applied' then private.attempt_execution_projection(a) else null end,
    'quarantineId',case when outcome='quarantined' then server_id else null end,
    'receivedAt',at_time,'metadataExpiresAt',g.metadata_expires_at);
  insert into private.offline_completion_events(id,lease_id,actor_profile_id,event_id,request_hash,occurred_at,
    server_offset_ms,normalized_occurred_at,received_at,metadata_expires_at,outcome,reason_code,response_payload)
  values(server_id,g.id,p.id,p_event_id,h,p_occurred_at,p_server_offset_ms,normalized,at_time,g.metadata_expires_at,outcome,reason,result);
  return result;
end; $$;
create function public.sync_cleaning_attempt_event(
  p_actor_profile_id uuid,p_session_id uuid,p_lease_id uuid,p_event_id uuid,p_expected_execution_version bigint,
  p_occurred_at timestamptz,p_server_offset_ms bigint
) returns jsonb language sql security definer set search_path='' as $$
select private.sync_attempt_event_at(p_actor_profile_id,p_session_id,p_lease_id,p_event_id,p_expected_execution_version,p_occurred_at,p_server_offset_ms,null);
$$;

create function private.offline_quarantine_projection(e private.offline_completion_events) returns jsonb
language sql stable security definer set search_path='' as $$
select jsonb_build_object('quarantineId',e.id,'attemptId',g.attempt_id,'assignmentId',g.assignment_id,
  'assignmentRevision',g.assignment_revision,'actorProfileId',e.actor_profile_id,'reasonCode',e.reason_code,
  'occurredAt',e.normalized_occurred_at,'receivedAt',e.received_at,'metadataExpiresAt',e.metadata_expires_at,
  'resolution',r.resolution,'currentAttempt',case when s.is_current and s.notified_at is not null
    and a.assignment_revision=s.revision and t.assignment_version=s.revision and t.status<>'cancelled'
    then private.attempt_execution_projection(a) else null end)
from private.offline_work_leases g join public.cleaning_attempts a on a.id=g.attempt_id
join public.cleaning_assignments s on s.id=a.assignment_id join public.cleaning_targets t on t.id=a.cleaning_target_id
left join private.offline_event_resolutions r on r.event_record_id=e.id where g.id=e.lease_id;
$$;
create function public.get_offline_event_quarantine(p_actor_profile_id uuid,p_session_id uuid,p_quarantine_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e private.offline_completion_events%rowtype;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  select * into e from private.offline_completion_events where id=p_quarantine_id and outcome='quarantined'
    and metadata_expires_at>statement_timestamp();
  if e.id is null then raise exception using errcode='42501',message='OFFLINE_QUARANTINE_NOT_FOUND'; end if;
  return private.offline_quarantine_projection(e);
end; $$;
create function public.list_offline_event_quarantine(p_actor_profile_id uuid,p_session_id uuid,
  p_from timestamptz,p_to timestamptz,p_limit integer,p_cursor_received_at timestamptz,p_cursor_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare rows_json jsonb; next_cursor jsonb; n integer;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_from>=p_to
    or p_to-p_from>interval '31 days' or p_limit is null or p_limit not between 1 and 100
    or ((p_cursor_received_at is null)<>(p_cursor_id is null))
    or (p_cursor_received_at is not null and not isfinite(p_cursor_received_at)) then
    raise exception using errcode='22023',message='INVALID_OFFLINE_QUERY'; end if;
  select coalesce(jsonb_agg(private.offline_quarantine_projection(e) order by e.received_at desc,e.id desc),'[]'::jsonb)
    into rows_json from (select * from private.offline_completion_events where outcome='quarantined'
      and received_at>=p_from and received_at<p_to and metadata_expires_at>statement_timestamp()
      and (p_cursor_id is null or (received_at,id)<(p_cursor_received_at,p_cursor_id))
      order by received_at desc,id desc limit p_limit+1) e;
  n:=jsonb_array_length(rows_json);
  if n>p_limit then
    rows_json:=rows_json-(n-1);
    next_cursor:=jsonb_build_object('receivedAt',rows_json->(p_limit-1)->'receivedAt','id',rows_json->(p_limit-1)->'quarantineId');
  end if;
  return jsonb_build_object('items',rows_json,'nextCursor',next_cursor);
end; $$;

create function private.resolve_offline_quarantine_at(
  p_actor_profile_id uuid,p_session_id uuid,p_quarantine_id uuid,p_resolution text,p_expected_execution_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text,p_command_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype; maid public.profiles%rowtype; a public.cleaning_attempts%rowtype;
  g private.offline_work_leases%rowtype; e private.offline_completion_events%rowtype; r private.offline_event_resolutions%rowtype;
  at_time timestamptz; result jsonb; normalized timestamptz; allowed private.attempt_capability_grants%rowtype;
  upload_g private.attempt_capability_grants%rowtype;
begin
  actor:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  if p_resolution is null or p_resolution not in('record_only','reject_effect','correction_link') or p_quarantine_id is null
    or p_reason_code is distinct from (case p_resolution when 'record_only' then 'OFFLINE_RECORD_ONLY'
      when 'reject_effect' then 'OFFLINE_REJECT_EFFECT' when 'correction_link' then 'OFFLINE_CORRECTION_APPROVED' end)
    or (p_resolution='correction_link' and (p_expected_execution_version is null or p_expected_execution_version<1))
    or (p_resolution<>'correction_link' and p_expected_execution_version is not null)
    or p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='INVALID_OFFLINE_RESOLUTION'; end if;
  perform pg_advisory_xact_lock(hashtextextended('offline-resolution:'||p_actor_profile_id::text||':'||p_idempotency_key,0));
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into e from private.offline_completion_events where id=p_quarantine_id and outcome='quarantined';
  if e.id is null then raise exception using errcode='42501',message='OFFLINE_QUARANTINE_NOT_FOUND'; end if;
  perform 1 from public.profiles where id in(p_actor_profile_id,e.actor_profile_id) order by id for no key update;
  actor:=private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  perform 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  select * into g from private.offline_work_leases where id=e.lease_id;
  select * into a from public.cleaning_attempts where id=g.attempt_id;
  perform 1 from public.cleaning_targets where id=a.cleaning_target_id for update;
  perform 1 from public.cleaning_assignments where id=a.assignment_id for update;
  select * into a from public.cleaning_attempts where id=g.attempt_id for update;
  select * into g from private.offline_work_leases where id=e.lease_id for update;
  select * into e from private.offline_completion_events where id=p_quarantine_id for update;
  at_time:=coalesce(p_command_at,clock_timestamp());
  if e.id is null or g.id is null then raise exception using errcode='42501',message='OFFLINE_QUARANTINE_NOT_FOUND'; end if;
  if at_time>=e.metadata_expires_at then raise exception using errcode='55000',message='OFFLINE_EVENT_EXPIRED'; end if;
  select * into r from private.offline_event_resolutions where actor_profile_id=p_actor_profile_id and idempotency_key=p_idempotency_key;
  if r.id is not null then
    if r.event_record_id<>e.id or r.request_hash<>p_request_hash or r.resolution<>p_resolution then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return r.response_payload;
  end if;
  if exists(select 1 from private.offline_event_resolutions where event_record_id=e.id) then
    raise exception using errcode='55000',message='OFFLINE_EVENT_ALREADY_RESOLVED'; end if;
  if p_resolution='correction_link' then
    select * into maid from public.profiles where id=e.actor_profile_id;
    if maid.role<>'maid' or maid.status not in('active','deactivation_pending') or maid.must_change_password then
      raise exception using errcode='42501',message='CAPABILITY_ACCESS_REQUIRED'; end if;
    perform private.assert_offline_current_attempt(a,g);
    if a.status<>'in_progress' or a.started_at is null then
      raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
    if a.execution_version<>p_expected_execution_version then
      raise exception using errcode='40001',message='ATTEMPT_VERSION_CONFLICT'; end if;
    if maid.status='deactivation_pending' then
      allowed:=private.live_attempt_capability(maid.id,a.id,a.assignment_revision,'complete_field_work',at_time);
    end if;
    normalized:=e.normalized_occurred_at;
    if abs(e.server_offset_ms)>300000 or normalized<a.started_at or normalized<g.issued_at
      or normalized>=g.expires_at or normalized>at_time then
      raise exception using errcode='55000',message='OFFLINE_CLOCK_UNVERIFIABLE'; end if;
    update public.cleaning_attempts set status='field_completed',field_completed_at=normalized,ended_at=normalized,
      execution_version=execution_version+1 where id=a.id returning * into a;
    if allowed.id is not null then
      insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
        values(allowed.id,at_time,'FIELD_COMPLETED',actor.id);
      upload_g:=private.issue_attempt_capability(a,'upload_submit',actor.id,at_time);
      update public.profiles set status='upload_only' where id=maid.id;
      perform private.notice_attempt_capability(upload_g,(select t from public.cleaning_targets t where id=a.cleaning_target_id));
    end if;
    insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
      effective_at,recorded_at,reason_code,after_state)
    values('cleaning.field_completed','cleaning_attempt',a.id,actor.id,actor.display_name,normalized,at_time,p_reason_code,
      private.attempt_execution_projection(a));
  end if;
  -- This is the durable correction/resolution provenance. It contains only a
  -- server-owned quarantine ID and fixed decision, never the client's UUID.
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
    effective_at,recorded_at,reason_code,after_state)
  values('cleaning.offline_event_resolved','cleaning_attempt',a.id,actor.id,actor.display_name,at_time,at_time,p_reason_code,
    jsonb_build_object('offlineQuarantineId',e.id,'resolution',p_resolution));
  result:=jsonb_build_object('quarantineId',e.id,'resolution',p_resolution,
    'attempt',case when p_resolution='correction_link' then private.attempt_execution_projection(a) else null end,
    'effectiveAt',at_time,'recordedAt',at_time);
  insert into private.offline_event_resolutions(event_record_id,actor_profile_id,resolution,idempotency_key,request_hash,response_payload,metadata_expires_at)
    values(e.id,actor.id,p_resolution,p_idempotency_key,p_request_hash,result,e.metadata_expires_at);
  return result;
end; $$;
create function public.resolve_offline_event_quarantine(
  p_actor_profile_id uuid,p_session_id uuid,p_quarantine_id uuid,p_resolution text,p_expected_execution_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language sql security definer set search_path='' as $$
select private.resolve_offline_quarantine_at(p_actor_profile_id,p_session_id,p_quarantine_id,p_resolution,
  p_expected_execution_version,p_reason_code,p_idempotency_key,p_request_hash,null);
$$;

-- Not a production scheduler installation. An explicitly authorized worker can
-- call this bounded purger; no arbitrary table/date input and no audit deletion.
create function public.purge_expired_offline_metadata(p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ids uuid[]; n integer;
begin
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception using errcode='22023',message='INVALID_OFFLINE_PURGE_LIMIT'; end if;
  -- Serialize with status/attempt commands before locking lease FK parents.
  -- Profile revocation triggers only append for unexpired metadata.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select array_agg(id) into ids from (select id from private.offline_work_leases where metadata_expires_at<=clock_timestamp()
    order by metadata_expires_at,id limit p_limit for update skip locked) l;
  if ids is null then return jsonb_build_object('purgedLeases',0); end if;
  delete from private.offline_event_resolutions r using private.offline_completion_events e
    where r.event_record_id=e.id and e.lease_id=any(ids);
  delete from private.offline_completion_events where lease_id=any(ids);
  delete from private.offline_work_lease_revocations where lease_id=any(ids);
  delete from private.offline_work_leases where id=any(ids);
  get diagnostics n=row_count;
  return jsonb_build_object('purgedLeases',n);
end; $$;

revoke all on function private.offline_lease_projection(private.offline_work_leases),
  private.start_attempt_with_lease_at(uuid,uuid,uuid,bigint,uuid,bigint,text,text,timestamptz),
  private.assert_offline_current_attempt(public.cleaning_attempts,private.offline_work_leases),
  private.sync_attempt_event_at(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint,timestamptz),
  private.offline_quarantine_projection(private.offline_completion_events),
  private.resolve_offline_quarantine_at(uuid,uuid,uuid,text,bigint,text,text,text,timestamptz)
  from public,anon,authenticated,service_role;
revoke all on function public.start_cleaning_attempt_with_lease(uuid,uuid,uuid,bigint,uuid,bigint,text,text),
  public.sync_cleaning_attempt_event(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint),
  public.get_offline_event_quarantine(uuid,uuid,uuid),
  public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid),
  public.resolve_offline_event_quarantine(uuid,uuid,uuid,text,bigint,text,text,text),
  public.purge_expired_offline_metadata(integer) from public,anon,authenticated;
grant execute on function public.start_cleaning_attempt_with_lease(uuid,uuid,uuid,bigint,uuid,bigint,text,text),
  public.sync_cleaning_attempt_event(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint),
  public.get_offline_event_quarantine(uuid,uuid,uuid),
  public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid),
  public.resolve_offline_event_quarantine(uuid,uuid,uuid,text,bigint,text,text,text),
  public.purge_expired_offline_metadata(integer) to service_role;
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
    'cleaning.offline_event_resolved',
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
      when audit.event_type = 'cleaning.offline_event_resolved' then jsonb_build_object(
        'offlineQuarantineId',audit.after_state->>'offlineQuarantineId','resolution',audit.after_state->>'resolution')
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
