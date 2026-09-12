-- Issue #131 Phase A: encrypted, immutable room PIN revisions and a two-step
-- physical-lock change protocol. PostgreSQL receives only envelope material;
-- canonical credentials and encryption keys remain in trusted runtimes.

create table private.room_pin_revisions (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  pin_version bigint not null check (pin_version > 0),
  envelope_format smallint not null check (envelope_format = 1),
  ciphertext bytea not null check (octet_length(ciphertext) between 1 and 256),
  nonce bytea not null check (octet_length(nonce) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  key_version text not null check (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  aad_environment text not null check (aad_environment ~ '^[A-Za-z0-9._:-]{1,80}$'),
  aad_project_ref text not null check (aad_project_ref ~ '^[A-Za-z0-9._:-]{1,80}$'),
  recorded_by uuid not null references public.profiles(id) on delete restrict,
  recorded_by_role public.app_role not null check (recorded_by_role in ('admin','maid')),
  source text not null check (source in (
    'admin_initial_entry','admin_physical_change','maid_cleaning_change','actual_pin_reentry'
  )),
  assignment_id uuid references public.cleaning_assignments(id) on delete restrict,
  attempt_id uuid references public.cleaning_attempts(id) on delete restrict,
  authoritative_access_lease_id uuid references public.room_pin_access_leases(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (room_id, pin_version),
  check ((source = 'maid_cleaning_change') = (
    assignment_id is not null and attempt_id is not null and authoritative_access_lease_id is not null
  )),
  check (source = 'maid_cleaning_change' or (
    assignment_id is null and attempt_id is null and authoritative_access_lease_id is null
  ))
);
create index room_pin_revision_recorded_by_idx on private.room_pin_revisions(recorded_by);
create index room_pin_revision_assignment_idx on private.room_pin_revisions(assignment_id)
where assignment_id is not null;
create index room_pin_revision_attempt_idx on private.room_pin_revisions(attempt_id)
where attempt_id is not null;
create index room_pin_revision_access_lease_idx on private.room_pin_revisions(authoritative_access_lease_id)
where authoritative_access_lease_id is not null;

create table private.room_current_pin (
  room_id uuid primary key references public.rooms(id) on delete restrict,
  pin_revision_id uuid not null unique references private.room_pin_revisions(id) on delete restrict,
  pin_version bigint not null check (pin_version > 0),
  updated_at timestamptz not null default clock_timestamp(),
  unique (room_id, pin_version),
  foreign key (room_id, pin_version)
    references private.room_pin_revisions(room_id, pin_version) on delete restrict
);

create table private.room_pin_change_leases (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  expected_pin_version bigint not null check (expected_pin_version >= 0),
  proposed_pin_version bigint not null check (proposed_pin_version = expected_pin_version + 1),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  actor_role_snapshot public.app_role not null check (actor_role_snapshot in ('admin','maid')),
  assignment_id uuid references public.cleaning_assignments(id) on delete restrict,
  attempt_id uuid references public.cleaning_attempts(id) on delete restrict,
  authoritative_access_lease_id uuid references public.room_pin_access_leases(id) on delete restrict,
  reason_code text not null check (reason_code in (
    'ADMIN_INITIAL_PIN','ADMIN_PHYSICAL_CHANGE','MAID_CLEANING_CHANGE','ACTUAL_PIN_REENTRY'
  )),
  envelope_format smallint not null check (envelope_format = 1),
  ciphertext bytea not null check (octet_length(ciphertext) between 1 and 256),
  nonce bytea not null check (octet_length(nonce) = 12),
  auth_tag bytea not null check (octet_length(auth_tag) = 16),
  key_version text not null check (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  aad_environment text not null check (aad_environment ~ '^[A-Za-z0-9._:-]{1,80}$'),
  aad_project_ref text not null check (aad_project_ref ~ '^[A-Za-z0-9._:-]{1,80}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  status text not null check (status in ('prepared','confirmed','expired','rolled_back','resolved_by_reentry')),
  prepared_at timestamptz not null,
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  resolved_at timestamptz,
  check (expires_at > prepared_at and expires_at <= prepared_at + interval '5 minutes'),
  check ((actor_role_snapshot = 'maid') = (
    assignment_id is not null and attempt_id is not null and authoritative_access_lease_id is not null
  )),
  check (actor_role_snapshot = 'maid' or (
    assignment_id is null and attempt_id is null and authoritative_access_lease_id is null
  )),
  check ((status = 'confirmed') = (confirmed_at is not null)),
  unique (key_version, nonce),
  unique (actor_profile_id, idempotency_key)
);

create unique index room_pin_change_one_unresolved_per_room
on private.room_pin_change_leases(room_id) where status = 'prepared';
create index room_pin_change_room_idx on private.room_pin_change_leases(room_id);
create index room_pin_change_actor_idx
on private.room_pin_change_leases(actor_profile_id, prepared_at desc);
create index room_pin_change_assignment_idx
on private.room_pin_change_leases(assignment_id) where assignment_id is not null;
create index room_pin_change_attempt_idx
on private.room_pin_change_leases(attempt_id) where attempt_id is not null;
create index room_pin_change_access_lease_idx
on private.room_pin_change_leases(authoritative_access_lease_id) where authoritative_access_lease_id is not null;

create table private.room_pin_reveal_leases (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  pin_revision_id uuid not null references private.room_pin_revisions(id) on delete restrict,
  pin_version bigint not null check (pin_version > 0),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  actor_role_snapshot public.app_role not null check (actor_role_snapshot in ('admin','maid')),
  assignment_id uuid references public.cleaning_assignments(id) on delete restrict,
  attempt_id uuid references public.cleaning_attempts(id) on delete restrict,
  authoritative_access_lease_id uuid references public.room_pin_access_leases(id) on delete restrict,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  finalized_at timestamptz,
  request_id uuid not null,
  check (expires_at > issued_at and expires_at <= issued_at + interval '30 seconds'),
  check ((actor_role_snapshot = 'maid') = (
    assignment_id is not null and attempt_id is not null and authoritative_access_lease_id is not null
  )),
  check (actor_role_snapshot = 'maid' or (
    assignment_id is null and attempt_id is null and authoritative_access_lease_id is null
  )),
  unique (room_id, pin_version, id)
);
create index room_pin_reveal_actor_idx
on private.room_pin_reveal_leases(actor_profile_id, issued_at desc);
create index room_pin_reveal_revision_idx on private.room_pin_reveal_leases(pin_revision_id);
create index room_pin_reveal_assignment_idx on private.room_pin_reveal_leases(assignment_id)
where assignment_id is not null;
create index room_pin_reveal_attempt_idx on private.room_pin_reveal_leases(attempt_id)
where attempt_id is not null;
create index room_pin_reveal_access_lease_idx on private.room_pin_reveal_leases(authoritative_access_lease_id)
where authoritative_access_lease_id is not null;

create table private.room_pin_sheet_sync_outbox (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references public.rooms(id) on delete restrict,
  pin_version bigint not null check (pin_version > 0),
  sync_status text not null check (sync_status in ('verified','mismatch')),
  reason_code text not null check (reason_code in ('PIN_CHANGE_CONFIRMED','PHYSICAL_ROLLBACK_CONFIRMED')),
  status text not null default 'pending' check (status in ('pending','processing','succeeded','failed','superseded')),
  claim_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  retry_count integer not null default 0 check (retry_count between 0 and 20),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{2,80}$'),
  completed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (room_id, pin_version, reason_code),
  check ((claim_id is null) = (claimed_at is null)),
  check (claim_expires_at is null or claimed_at is not null and claim_expires_at > claimed_at)
);
create index room_pin_sheet_sync_claim_idx
on private.room_pin_sheet_sync_outbox(status, next_attempt_at, created_at, id);

alter table private.room_pin_revisions enable row level security;
alter table private.room_pin_revisions force row level security;
alter table private.room_current_pin enable row level security;
alter table private.room_current_pin force row level security;
alter table private.room_pin_change_leases enable row level security;
alter table private.room_pin_change_leases force row level security;
alter table private.room_pin_reveal_leases enable row level security;
alter table private.room_pin_reveal_leases force row level security;
alter table private.room_pin_sheet_sync_outbox enable row level security;
alter table private.room_pin_sheet_sync_outbox force row level security;

revoke all on table private.room_pin_revisions from public,anon,authenticated,service_role;
revoke all on table private.room_current_pin from public,anon,authenticated,service_role;
revoke all on table private.room_pin_change_leases from public,anon,authenticated,service_role;
revoke all on table private.room_pin_reveal_leases from public,anon,authenticated,service_role;
revoke all on table private.room_pin_sheet_sync_outbox from public,anon,authenticated,service_role;

-- A legacy/public sync event is not proof that an encrypted credential exists.
-- Do not backfill fabricated PIN material during upgrade.
create or replace function private.current_pin_sync_status(p_room_id uuid)
returns text language sql stable security definer set search_path='' as $$
  with latest as (
    select e.sync_status,e.pin_version
    from public.room_pin_sync_events e where e.room_id=p_room_id
    order by e.recorded_at desc,e.id desc limit 1
  ), current_pin as (
    select p.pin_version from private.room_current_pin p where p.room_id=p_room_id
  )
  select case
    when exists(select 1 from private.room_pin_change_leases l
      where l.room_id=p_room_id and l.status in ('prepared','expired')) then 'mismatch'
    when not exists(select 1 from current_pin) then 'unconfigured'
    when (select sync_status from latest)='verified'
      and (select pin_version from latest)=(select pin_version from current_pin) then 'verified'
    when (select sync_status from latest)='unconfigured' then 'unconfigured'
    else 'mismatch'
  end
$$;
revoke all on function private.current_pin_sync_status(uuid) from public,anon,authenticated,service_role;

create trigger room_pin_revisions_append_only
before update or delete on private.room_pin_revisions
for each row execute function private.prevent_append_only_mutation();
create trigger room_pin_sheet_sync_outbox_no_delete
before delete on private.room_pin_sheet_sync_outbox
for each row execute function private.prevent_append_only_mutation();

create function private.guard_room_pin_sheet_sync_outbox_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.id<>old.id or new.room_id<>old.room_id or new.pin_version<>old.pin_version
    or new.sync_status<>old.sync_status or new.reason_code<>old.reason_code
    or new.created_at<>old.created_at then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_OUTBOX_IDENTITY_IMMUTABLE';
  end if;
  return new;
end $$;
revoke all on function private.guard_room_pin_sheet_sync_outbox_update()
from public,anon,authenticated,service_role;
create trigger room_pin_sheet_sync_outbox_identity_immutable
before update on private.room_pin_sheet_sync_outbox
for each row execute function private.guard_room_pin_sheet_sync_outbox_update();

-- Extend the immutable sensitive-access ledger with the room PIN source. The
-- finalization RPC below inserts only a room UUID and source-controlled fields.
alter table private.actor_activity_events
  drop constraint actor_activity_events_source_check,
  add constraint actor_activity_events_source_check check (source in (
    'edge.auth.login','edge.sensitive.reservation_guest_name','edge.sensitive.room_pin'
  ));

create function private.assert_room_pin_actor_session(p_actor uuid,p_session uuid)
returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if not found or actor.status<>'active' then
    raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  if p_session is null or not public.is_active_auth_session(actor.auth_user_id,p_session) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  perform 1 from auth.sessions where id=p_session and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  return actor;
end $$;
revoke all on function private.assert_room_pin_actor_session(uuid,uuid)
from public,anon,authenticated,service_role;

create function private.assert_room_pin_actor_work(
  p_actor uuid,p_session uuid,p_room uuid,p_assignment uuid,p_attempt uuid,p_access_lease uuid,
  p_pin_version bigint,p_mode text,p_at timestamptz
) returns public.profiles
language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles%rowtype;
  target public.cleaning_targets%rowtype;
  assignment public.cleaning_assignments%rowtype;
  attempt public.cleaning_attempts%rowtype;
  access_lease public.room_pin_access_leases%rowtype;
  target_id uuid;
begin
  if p_mode not in ('change','reveal') then
    raise exception using errcode='22023',message='INVALID_PIN_OPERATION_MODE';
  end if;
  actor:=private.assert_room_pin_actor_session(p_actor,p_session);

  if actor.role='admin' then
    if p_assignment is not null or p_attempt is not null or p_access_lease is not null then
      raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
    end if;
    return actor;
  end if;
  if actor.role<>'maid' or p_assignment is null or p_attempt is null
    or p_access_lease is null or p_pin_version is null then
    raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
  end if;
  select cleaning_target_id into target_id from public.cleaning_assignments where id=p_assignment;
  select * into target from public.cleaning_targets where id=target_id for update;
  select * into assignment from public.cleaning_assignments where id=p_assignment for update;
  select * into attempt from public.cleaning_attempts where id=p_attempt for update;
  if assignment.id is null or target.id is null or attempt.id is null
    or assignment.maid_profile_id<>actor.id or not assignment.is_current
    or assignment.notified_at is null or assignment.revision<>target.assignment_version
    or assignment.notified_room_id_snapshot is distinct from p_room
    or target.room_id<>p_room or target.status in ('cancelled','approved')
    or attempt.assignment_id<>assignment.id or attempt.cleaning_target_id<>target.id
    or attempt.maid_profile_id<>actor.id
    or attempt.status not in ('scheduled','in_progress')
    or target.available_from is null or target.available_from>p_at then
    raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
  end if;
  if p_mode='change' and attempt.status<>'in_progress' then
    raise exception using errcode='42501',message='PIN_CHANGE_IN_PROGRESS_REQUIRED';
  end if;
  if p_mode in ('change','reveal') then
    select * into access_lease from public.room_pin_access_leases where id=p_access_lease for update;
    if access_lease.id is null or access_lease.room_id<>p_room
      or access_lease.cleaning_target_id<>target.id or access_lease.assignment_id<>assignment.id
      or access_lease.attempt_id<>attempt.id or access_lease.issued_to<>actor.id
      or access_lease.pin_version<>p_pin_version or access_lease.revoked_at is not null
      or access_lease.issued_at>p_at or access_lease.expires_at<=p_at then
      raise exception using errcode='42501',message='PIN_ACCESS_LEASE_REQUIRED';
    end if;
  end if;
  return actor;
end $$;
revoke all on function private.assert_room_pin_actor_work(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz)
from public,anon,authenticated,service_role;

create function private.room_pin_source(p_reason text) returns text
language sql immutable set search_path='' as $$
  select case p_reason
    when 'ADMIN_INITIAL_PIN' then 'admin_initial_entry'
    when 'ADMIN_PHYSICAL_CHANGE' then 'admin_physical_change'
    when 'MAID_CLEANING_CHANGE' then 'maid_cleaning_change'
    when 'ACTUAL_PIN_REENTRY' then 'actual_pin_reentry'
  end
$$;
revoke all on function private.room_pin_source(text) from public,anon,authenticated,service_role;

create function public.get_room_pin_change_context(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_expected_pin_version bigint,
  p_assignment_id uuid default null,p_attempt_id uuid default null,p_access_lease_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare room public.rooms; current_pin private.room_current_pin; at_time timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  perform private.assert_room_pin_actor_work(p_actor_profile_id,p_session_id,p_room_id,
    p_assignment_id,p_attempt_id,p_access_lease_id,p_expected_pin_version,'change',at_time);
  if coalesce(current_pin.pin_version,0)<>p_expected_pin_version then
    raise exception using errcode='40001',message='STALE_PIN_VERSION';
  end if;
  return jsonb_build_object('room_id',room.id,'room_number',room.room_number,
    'current_pin_version',coalesce(current_pin.pin_version,0),'proposed_pin_version',p_expected_pin_version+1);
end $$;

create function public.prepare_room_pin_change(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_expected_pin_version bigint,
  p_room_number_snapshot text,
  p_assignment_id uuid,p_attempt_id uuid,p_access_lease_id uuid,p_reason_code text,p_envelope_format smallint,
  p_ciphertext_base64 text,p_nonce_base64 text,p_auth_tag_base64 text,p_key_version text,
  p_aad_environment text,p_aad_project_ref text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles; room public.rooms; current_pin private.room_current_pin;
  lease private.room_pin_change_leases; at_time timestamptz:=clock_timestamp();
  ciphertext bytea; nonce bytea; tag bytea;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if p_room_number_snapshot is null or room.room_number<>p_room_number_snapshot then
    raise exception using errcode='40001',message='ROOM_NUMBER_CHANGED';
  end if;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  select * into lease from private.room_pin_change_leases
    where actor_profile_id=p_actor_profile_id and idempotency_key=p_idempotency_key for update;
  if lease.id is not null then
    actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
    if lease.room_id<>p_room_id or lease.request_hash<>p_request_hash
      then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED';
    end if;
    return jsonb_build_object('lease_id',lease.id,'room_id',lease.room_id,
      'current_pin_version',lease.expected_pin_version,'proposed_pin_version',lease.proposed_pin_version,
      'status','prepared','expires_at',lease.expires_at,'replay',true,
      'envelope_format',lease.envelope_format,'ciphertext_base64',encode(lease.ciphertext,'base64'),
      'nonce_base64',encode(lease.nonce,'base64'),'auth_tag_base64',encode(lease.auth_tag,'base64'),
      'key_version',lease.key_version,'aad_environment',lease.aad_environment,
      'aad_project_ref',lease.aad_project_ref);
  end if;
  if p_idempotency_key is null or p_idempotency_key!~'^[A-Za-z0-9._:-]{8,128}$'
    or p_request_hash is null or p_request_hash!~'^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='INVALID_PIN_COMMAND';
  end if;
  actor:=private.assert_room_pin_actor_work(p_actor_profile_id,p_session_id,p_room_id,
    p_assignment_id,p_attempt_id,p_access_lease_id,p_expected_pin_version,'change',at_time);
  if p_reason_code not in ('ADMIN_INITIAL_PIN','ADMIN_PHYSICAL_CHANGE','MAID_CLEANING_CHANGE','ACTUAL_PIN_REENTRY')
    or (actor.role='maid' and p_reason_code<>'MAID_CLEANING_CHANGE')
    or (actor.role='admin' and p_reason_code='MAID_CLEANING_CHANGE') then
    raise exception using errcode='22023',message='INVALID_PIN_CHANGE_REASON';
  end if;
  if coalesce(current_pin.pin_version,0)<>p_expected_pin_version then
    raise exception using errcode='40001',message='STALE_PIN_VERSION';
  end if;
  update private.room_pin_change_leases set status='expired',resolved_at=at_time
    where room_id=p_room_id and status='prepared' and expires_at<=at_time;
  if (p_reason_code='ADMIN_INITIAL_PIN' and p_expected_pin_version<>0)
    or (p_expected_pin_version=0 and p_reason_code not in ('ADMIN_INITIAL_PIN','ACTUAL_PIN_REENTRY'))
    or (p_reason_code='ACTUAL_PIN_REENTRY' and not exists(
      select 1 from private.room_pin_change_leases where room_id=p_room_id and status='expired'
    )) then
    raise exception using errcode='23514',message='INVALID_PIN_CHANGE_REASON';
  end if;
  if exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared') then
    raise exception using errcode='55000',message='PIN_CHANGE_IN_PROGRESS';
  end if;
  if p_reason_code<>'ACTUAL_PIN_REENTRY' and exists(
    select 1 from private.room_pin_change_leases where room_id=p_room_id and status='expired'
  ) then
    raise exception using errcode='55000',message='ROOM_PIN_MISMATCH_UNRESOLVED';
  end if;
  begin
    ciphertext:=decode(p_ciphertext_base64,'base64'); nonce:=decode(p_nonce_base64,'base64'); tag:=decode(p_auth_tag_base64,'base64');
  exception when others then raise exception using errcode='22023',message='INVALID_PIN_ENVELOPE'; end;
  if p_envelope_format<>1 or octet_length(ciphertext) not between 1 and 256
    or octet_length(nonce)<>12 or octet_length(tag)<>16 or p_key_version!~'^[A-Za-z0-9._-]{1,32}$'
    or p_aad_environment!~'^[A-Za-z0-9._:-]{1,80}$'
    or p_aad_project_ref!~'^[A-Za-z0-9._:-]{1,80}$' then
    raise exception using errcode='22023',message='INVALID_PIN_ENVELOPE';
  end if;
  insert into private.room_pin_change_leases(room_id,expected_pin_version,proposed_pin_version,
    actor_profile_id,actor_role_snapshot,assignment_id,attempt_id,authoritative_access_lease_id,reason_code,
    envelope_format,ciphertext,nonce,auth_tag,key_version,aad_environment,aad_project_ref,
    request_hash,idempotency_key,status,prepared_at,expires_at)
  values(p_room_id,p_expected_pin_version,p_expected_pin_version+1,actor.id,actor.role,
    p_assignment_id,p_attempt_id,p_access_lease_id,p_reason_code,p_envelope_format,ciphertext,nonce,tag,p_key_version,
    p_aad_environment,p_aad_project_ref,
    p_request_hash,p_idempotency_key,'prepared',at_time,at_time+interval '5 minutes') returning * into lease;
  insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at,recorded_at)
    values(p_room_id,'mismatch',null,'PIN_PHYSICAL_CHANGE_PREPARED',actor.id,at_time,at_time);
  update public.rooms set state_version=state_version+1 where id=p_room_id;
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.pin_change_prepared','room',p_room_id,at_time,p_reason_code,
    jsonb_build_object('leaseId',lease.id,'pinVersion',lease.proposed_pin_version,'status','mismatch'),
    p_request_hash,private.audit_command_key(actor.id,'room.pin_change.prepare',p_idempotency_key));
  return jsonb_build_object('lease_id',lease.id,'room_id',lease.room_id,
    'current_pin_version',lease.expected_pin_version,'proposed_pin_version',lease.proposed_pin_version,
    'status',lease.status,'expires_at',lease.expires_at,'replay',false);
end $$;

create function public.confirm_room_pin_change(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_lease_id uuid,
  p_expected_pin_version bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles; room public.rooms; current_pin private.room_current_pin;
  lease private.room_pin_change_leases; revision_id uuid:=gen_random_uuid();
  rotated_access public.room_pin_access_leases; new_access_lease_id uuid;
  at_time timestamptz:=clock_timestamp(); response jsonb; source text;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  select * into lease from private.room_pin_change_leases where id=p_lease_id and room_id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if lease.id is null then raise exception using errcode='P0002',message='PIN_CHANGE_LEASE_NOT_FOUND'; end if;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if lease.actor_profile_id<>actor.id then
    raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
  end if;
  response:=private.replay_command(actor.id,'room.pin_change.confirm',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  actor:=private.assert_room_pin_actor_work(p_actor_profile_id,p_session_id,p_room_id,
    lease.assignment_id,lease.attempt_id,lease.authoritative_access_lease_id,
    lease.expected_pin_version,'change',at_time);
  if lease.status<>'prepared' then raise exception using errcode='55000',message='PIN_CHANGE_LEASE_NOT_PREPARED'; end if;
  if lease.expires_at<=at_time then
    update private.room_pin_change_leases set status='expired',resolved_at=at_time where id=lease.id;
    raise exception using errcode='55000',message='PIN_CHANGE_LEASE_EXPIRED';
  end if;
  if coalesce(current_pin.pin_version,0)<>p_expected_pin_version
    or lease.expected_pin_version<>p_expected_pin_version then
    raise exception using errcode='40001',message='STALE_PIN_VERSION';
  end if;
  source:=private.room_pin_source(lease.reason_code);
  insert into private.room_pin_revisions(id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,
    key_version,aad_environment,aad_project_ref,recorded_by,recorded_by_role,source,assignment_id,attempt_id,
    authoritative_access_lease_id,created_at)
  values(revision_id,p_room_id,lease.proposed_pin_version,lease.envelope_format,lease.ciphertext,lease.nonce,
    lease.auth_tag,lease.key_version,lease.aad_environment,lease.aad_project_ref,actor.id,actor.role,source,
    lease.assignment_id,lease.attempt_id,
    lease.authoritative_access_lease_id,at_time);
  insert into private.room_current_pin(room_id,pin_revision_id,pin_version,updated_at)
    values(p_room_id,revision_id,lease.proposed_pin_version,at_time)
  on conflict(room_id) do update set pin_revision_id=excluded.pin_revision_id,
    pin_version=excluded.pin_version,updated_at=excluded.updated_at
    where private.room_current_pin.pin_version=p_expected_pin_version;
  if not found then raise exception using errcode='40001',message='STALE_PIN_VERSION'; end if;
  update private.room_pin_change_leases set status='confirmed',confirmed_at=at_time,resolved_at=at_time where id=lease.id;
  if lease.reason_code='ACTUAL_PIN_REENTRY' then
    update private.room_pin_change_leases set status='resolved_by_reentry',resolved_at=at_time
      where room_id=p_room_id and id<>lease.id and status='expired';
  end if;
  insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at,recorded_at)
    values(p_room_id,'verified',lease.proposed_pin_version,'PIN_CHANGE_CONFIRMED',actor.id,at_time,at_time);
  if actor.role='maid' then
    update public.room_pin_access_leases set revoked_at=at_time,revoke_reason_code='PIN_VERSION_SUPERSEDED'
      where id=lease.authoritative_access_lease_id and revoked_at is null and expires_at>at_time
      returning * into rotated_access;
    if rotated_access.id is null then
      raise exception using errcode='42501',message='PIN_REVEAL_AUTHORIZATION_CHANGED';
    end if;
    insert into public.room_pin_access_leases(room_id,reservation_id,cleaning_target_id,assignment_id,
      attempt_id,pin_version,issued_to,issued_at,expires_at)
    values(rotated_access.room_id,rotated_access.reservation_id,rotated_access.cleaning_target_id,
      rotated_access.assignment_id,rotated_access.attempt_id,lease.proposed_pin_version,
      rotated_access.issued_to,at_time,rotated_access.expires_at)
    returning id into new_access_lease_id;
  end if;
  insert into private.room_pin_sheet_sync_outbox(room_id,pin_version,sync_status,reason_code,next_attempt_at)
    values(p_room_id,lease.proposed_pin_version,'verified','PIN_CHANGE_CONFIRMED',at_time);
  update public.rooms set state_version=state_version+1 where id=p_room_id;
  response:=jsonb_strip_nulls(jsonb_build_object('lease_id',lease.id,'room_id',p_room_id,
    'pin_version',lease.proposed_pin_version,'access_lease_id',new_access_lease_id,
    'status','confirmed','confirmed_at',at_time));
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.pin_change_confirmed','room',p_room_id,at_time,'PIN_CHANGE_CONFIRMED',
    jsonb_build_object('leaseId',lease.id,'pinVersion',lease.proposed_pin_version,'status','verified'),
    p_request_hash,private.audit_command_key(actor.id,'room.pin_change.confirm',p_idempotency_key));
  perform private.complete_command(actor.id,'room.pin_change.confirm',p_idempotency_key,p_request_hash,p_room_id,response);
  return response;
end $$;

create function public.rollback_room_pin_change(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_lease_id uuid,
  p_expected_pin_version bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room public.rooms; current_pin private.room_current_pin;
  lease private.room_pin_change_leases; at_time timestamptz:=clock_timestamp(); response jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  select * into lease from private.room_pin_change_leases where id=p_lease_id and room_id=p_room_id for update;
  actor:=private.assert_room_pin_actor_work(p_actor_profile_id,p_session_id,p_room_id,null,null,null,null,'reveal',at_time);
  if actor.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  response:=private.replay_command(actor.id,'room.pin_change.rollback',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if lease.id is null or lease.status not in ('prepared','expired') then
    raise exception using errcode='55000',message='PIN_CHANGE_LEASE_NOT_RESOLVABLE';
  end if;
  if current_pin.pin_version is null or current_pin.pin_version<>p_expected_pin_version then
    raise exception using errcode='40001',message='STALE_PIN_VERSION';
  end if;
  update private.room_pin_change_leases set status='rolled_back',resolved_at=at_time
    where room_id=p_room_id and (id=lease.id or status='expired');
  insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at,recorded_at)
    values(p_room_id,'verified',current_pin.pin_version,'PHYSICAL_ROLLBACK_CONFIRMED',actor.id,at_time,at_time);
  insert into private.room_pin_sheet_sync_outbox(room_id,pin_version,sync_status,reason_code,next_attempt_at)
    values(p_room_id,current_pin.pin_version,'verified','PHYSICAL_ROLLBACK_CONFIRMED',at_time)
    on conflict(room_id,pin_version,reason_code) do nothing;
  update public.rooms set state_version=state_version+1 where id=p_room_id;
  response:=jsonb_build_object('lease_id',lease.id,'room_id',p_room_id,'pin_version',current_pin.pin_version,
    'status','rolled_back','resolved_at',at_time);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.pin_mismatch_resolved','room',p_room_id,at_time,'PHYSICAL_ROLLBACK_CONFIRMED',
    jsonb_build_object('leaseId',lease.id,'pinVersion',current_pin.pin_version,'status','verified'),
    p_request_hash,private.audit_command_key(actor.id,'room.pin_change.rollback',p_idempotency_key));
  perform private.complete_command(actor.id,'room.pin_change.rollback',p_idempotency_key,p_request_hash,p_room_id,response);
  return response;
end $$;

create function public.begin_room_pin_reveal(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_assignment_id uuid,
  p_attempt_id uuid,p_access_lease_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room public.rooms; current_pin private.room_current_pin;
  revision private.room_pin_revisions; lease private.room_pin_reveal_leases;
  at_time timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  if private.current_pin_sync_status(p_room_id)<>'verified'
    or exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared') then
    raise exception using errcode='55000',message='ROOM_PIN_MISMATCH_UNRESOLVED';
  end if;
  if current_pin.pin_revision_id is null then raise exception using errcode='P0002',message='ROOM_PIN_UNCONFIGURED'; end if;
  actor:=private.assert_room_pin_actor_work(p_actor_profile_id,p_session_id,p_room_id,
    p_assignment_id,p_attempt_id,p_access_lease_id,current_pin.pin_version,'reveal',at_time);
  select * into revision from private.room_pin_revisions where id=current_pin.pin_revision_id;
  insert into private.room_pin_reveal_leases(room_id,pin_revision_id,pin_version,actor_profile_id,
    actor_role_snapshot,assignment_id,attempt_id,authoritative_access_lease_id,issued_at,expires_at,request_id)
  values(p_room_id,revision.id,revision.pin_version,actor.id,actor.role,p_assignment_id,p_attempt_id,p_access_lease_id,
    at_time,at_time+interval '30 seconds',p_request_id) returning * into lease;
  return jsonb_build_object('lease_id',lease.id,'room_id',p_room_id,'room_number',room.room_number,'pin_version',revision.pin_version,
    'expires_at',lease.expires_at,'envelope_format',revision.envelope_format,
    'ciphertext_base64',encode(revision.ciphertext,'base64'),'nonce_base64',encode(revision.nonce,'base64'),
    'auth_tag_base64',encode(revision.auth_tag,'base64'),'key_version',revision.key_version,
    'aad_environment',revision.aad_environment,'aad_project_ref',revision.aad_project_ref);
end $$;

create function public.finalize_room_pin_reveal(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_reveal_lease_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room public.rooms; current_pin private.room_current_pin; lease private.room_pin_reveal_leases;
  at_time timestamptz:=clock_timestamp(); activity_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  select * into lease from private.room_pin_reveal_leases where id=p_reveal_lease_id and room_id=p_room_id for update;
  if lease.id is null then raise exception using errcode='P0002',message='PIN_REVEAL_LEASE_NOT_FOUND'; end if;
  actor:=private.assert_room_pin_actor_work(p_actor_profile_id,p_session_id,p_room_id,
    lease.assignment_id,lease.attempt_id,lease.authoritative_access_lease_id,
    current_pin.pin_version,'reveal',at_time);
  if lease.actor_profile_id<>actor.id or lease.request_id<>p_request_id
    or lease.finalized_at is not null or lease.expires_at<=at_time
    or current_pin.pin_revision_id<>lease.pin_revision_id or current_pin.pin_version<>lease.pin_version
    or private.current_pin_sync_status(p_room_id)<>'verified'
    or exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared') then
    raise exception using errcode='42501',message='PIN_REVEAL_AUTHORIZATION_CHANGED';
  end if;
  update private.room_pin_reveal_leases set finalized_at=at_time where id=lease.id;
  update public.room_pin_access_leases set revealed_at=coalesce(revealed_at,at_time)
    where id=lease.authoritative_access_lease_id and revoked_at is null and expires_at>at_time;
  if actor.role='maid' and not found then
    raise exception using errcode='42501',message='PIN_REVEAL_AUTHORIZATION_CHANGED';
  end if;
  insert into private.actor_activity_events(actor_profile_id,actor_role_snapshot,category,event_type,outcome,
    source,resource_type,resource_id,reason_code,request_id,occurred_at)
  values(actor.id,actor.role,'sensitive_access','sensitive.read','succeeded','edge.sensitive.room_pin',
    'room',p_room_id,null,p_request_id::text,at_time) returning id into activity_id;
  return jsonb_build_object('room_id',p_room_id,'pin_version',lease.pin_version,
    'reveal_lease_id',lease.id,'activity_id',activity_id,'finalized_at',at_time);
end $$;

create function private.guard_room_number_pin_reissue() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.room_number is distinct from old.room_number and (
    exists(select 1 from private.room_current_pin where room_id=old.id)
    or exists(select 1 from private.room_pin_change_leases where room_id=old.id and status='prepared')
  ) then raise exception using errcode='55000',message='ROOM_PIN_REISSUE_REQUIRED'; end if;
  return new;
end $$;
revoke all on function private.guard_room_number_pin_reissue() from public,anon,authenticated,service_role;
create trigger rooms_room_number_pin_reissue
before update of room_number on public.rooms
for each row execute function private.guard_room_number_pin_reissue();

-- Developer audit reads expose only a source-controlled nonsecret summary for
-- PIN lifecycle events. Envelope material and request hashes remain private.
alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_room_pin;
revoke all on function private.list_developer_audit_events_before_room_pin(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;

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
set search_path = ''
as $$
declare
  v_pin_types constant text[]:=array[
    'room.pin_change_prepared','room.pin_change_confirmed','room.pin_mismatch_resolved'
  ];
  v_previous_types text[];
  v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types),0)=0 then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    v_previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into v_previous_types
    from unnest(p_event_types) requested where not requested=any(v_pin_types);
    if cardinality(v_previous_types)=0 then v_previous_types:=array['account.created']; end if;
  end if;

  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_room_pin(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'roomId',audit.entity_id,'leaseId',audit.after_state->>'leaseId',
        'pinVersion',audit.after_state->'pinVersion','status',audit.after_state->>'status'))
    from public.audit_events audit
    where audit.event_type=any(v_pin_types)
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end;
$$;

revoke all on function public.get_room_pin_change_context(uuid,uuid,uuid,bigint,uuid,uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function public.prepare_room_pin_change(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,smallint,text,text,text,text,text,text,text,text)
from public,anon,authenticated,service_role;
revoke all on function public.confirm_room_pin_change(uuid,uuid,uuid,uuid,bigint,text,text)
from public,anon,authenticated,service_role;
revoke all on function public.rollback_room_pin_change(uuid,uuid,uuid,uuid,bigint,text,text)
from public,anon,authenticated,service_role;
revoke all on function public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function public.finalize_room_pin_reveal(uuid,uuid,uuid,uuid,uuid)
from public,anon,authenticated,service_role;

grant execute on function public.get_room_pin_change_context(uuid,uuid,uuid,bigint,uuid,uuid,uuid) to service_role;
grant execute on function public.prepare_room_pin_change(uuid,uuid,uuid,bigint,text,uuid,uuid,uuid,text,smallint,text,text,text,text,text,text,text,text) to service_role;
grant execute on function public.confirm_room_pin_change(uuid,uuid,uuid,uuid,bigint,text,text) to service_role;
grant execute on function public.rollback_room_pin_change(uuid,uuid,uuid,uuid,bigint,text,text) to service_role;
grant execute on function public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.finalize_room_pin_reveal(uuid,uuid,uuid,uuid,uuid) to service_role;

comment on table private.room_pin_revisions is
  'Immutable AES-256-GCM envelope revisions. Stores bounded nonsecret AAD context, never plaintext, keys, full AAD bytes, verifiers, HMACs, phones, or free-form material.';
comment on table private.room_pin_sheet_sync_outbox is
  'Phase-B foundation only: nonsecret room/version/status/reason/claim metadata. No Google provider call in Phase A.';
