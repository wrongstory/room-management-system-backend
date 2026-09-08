-- #83 DB-only storage workflow. No Drive HTTP, binary validation, photo read or purge worker.
-- The trusted server adapter must independently validate bytes and the provider acknowledgement.
create table private.photo_upload_operations (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  command_type text not null default 'photo.upload' check(command_type='photo.upload'),
  idempotency_key_digest text not null check(idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  assignment_revision bigint not null check(assignment_revision>0),
  target_photo_slot_id uuid not null,
  expected_photo_revision bigint not null check(expected_photo_revision between 0 and 9007199254740990),
  sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
  mime_type text not null check(mime_type in ('image/jpeg','image/webp')),
  size_bytes integer not null check(size_bytes between 1 and 307200),
  created_at timestamptz not null default clock_timestamp(),
  unique(actor_profile_id,command_type,idempotency_key_digest),
  foreign key(cleaning_attempt_id,cleaning_target_id) references public.cleaning_attempts(id,cleaning_target_id) on delete restrict,
  foreign key(target_photo_slot_id,cleaning_target_id) references private.target_photo_slot_snapshots(id,cleaning_target_id) on delete restrict
);
create index photo_upload_assignment_idx on private.photo_upload_operations(assignment_id);
create index photo_upload_attempt_idx on private.photo_upload_operations(cleaning_attempt_id,created_at);
create index photo_upload_target_idx on private.photo_upload_operations(cleaning_target_id);
create index photo_upload_slot_idx on private.photo_upload_operations(target_photo_slot_id,cleaning_target_id);
create table private.photo_provider_objects (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null unique references private.photo_upload_operations(id) on delete restrict,
  provider text not null default 'google_drive' check(provider='google_drive'),
  provider_locator text check(provider_locator ~ '^[A-Za-z0-9_-]{10,200}$'),
  uploaded_at timestamptz,
  purge_after timestamptz,
  check((provider_locator is null and uploaded_at is null and purge_after is null) or
    (provider_locator is not null and uploaded_at is not null and isfinite(uploaded_at)
      and purge_after is not null and purge_after=uploaded_at+interval '168 hours')),
  unique(provider,provider_locator),
  unique(id,operation_id)
);
create table private.photo_upload_states (
  operation_id uuid primary key references private.photo_upload_operations(id) on delete restrict,
  cleaning_attempt_id uuid not null references public.cleaning_attempts(id) on delete restrict,
  target_photo_slot_id uuid not null references private.target_photo_slot_snapshots(id) on delete restrict,
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  status text not null default 'reserved' check(status in ('reserved','provider_succeeded','accepted','reconciliation_pending','compensation_pending','compensated')),
  lease_version integer not null default 0 check(lease_version between 0 and 8),
  lease_claim_digest text check(lease_claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  revision integer not null default 1 check(revision>0),
  updated_at timestamptz not null default clock_timestamp()
);
-- A terminal reconciliation fence releases the business slot, but never loses the candidate identity.
create unique index photo_upload_slot_inflight_idx on private.photo_upload_states(cleaning_attempt_id,target_photo_slot_id)
  where status in ('reserved','provider_succeeded');
create index photo_upload_actor_inflight_idx on private.photo_upload_states(actor_profile_id,status);
create index photo_upload_slot_state_idx on private.photo_upload_states(target_photo_slot_id);
create index photo_upload_reconcile_idx on private.photo_upload_states(status,lease_expires_at,operation_id);
create table private.photo_upload_acceptances (
  operation_id uuid primary key references private.photo_upload_operations(id) on delete restrict,
  object_id uuid not null unique,
  photo_version_id uuid not null unique references private.attempt_photo_versions(id) on delete restrict,
  accepted_at timestamptz not null default clock_timestamp(),
  foreign key(object_id,operation_id) references private.photo_provider_objects(id,operation_id) on delete restrict
);
create table private.photo_upload_events (
  id uuid primary key default gen_random_uuid(),
  operation_id uuid not null references private.photo_upload_operations(id) on delete restrict,
  revision integer not null,
  state text not null check(state in ('reserved','provider_succeeded','accepted','reconciliation_pending','compensation_pending','compensated')),
  lease_version integer not null check(lease_version between 0 and 8),
  occurred_at timestamptz not null default clock_timestamp(),
  unique(operation_id,revision)
);
-- One durable rate row per existing actor; saturation does not append denial events or new UUID rows.
create table private.photo_upload_rate_limits (
  actor_profile_id uuid primary key references public.profiles(id) on delete restrict,
  minute_started_at timestamptz not null,
  occurrence_count integer not null check(occurrence_count between 1 and 30)
);
create function private.guard_photo_storage_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='photo_provider_objects' and tg_op='UPDATE' then
    if old.provider_locator is null and new.provider_locator is not null
      and new.id=old.id and new.operation_id=old.operation_id and new.provider=old.provider then
      return new;
    end if;
  end if;
  raise exception using errcode='55000',message='PHOTO_STORAGE_IMMUTABLE';
end; $$;
revoke all on function private.guard_photo_storage_immutable() from public,anon,authenticated,service_role;
create function private.guard_photo_storage_state() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='PHOTO_STORAGE_IMMUTABLE'; end if;
  if not exists(select 1 from private.photo_upload_operations o where o.id=new.operation_id
    and o.cleaning_attempt_id=new.cleaning_attempt_id and o.target_photo_slot_id=new.target_photo_slot_id and o.actor_profile_id=new.actor_profile_id) then
    raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  if tg_op='UPDATE' then
    if (to_jsonb(new)-array['status','lease_version','lease_claim_digest','lease_expires_at','revision','updated_at']) is distinct from
      (to_jsonb(old)-array['status','lease_version','lease_claim_digest','lease_expires_at','revision','updated_at'])
      or new.revision<>old.revision+1 or new.lease_version<old.lease_version or new.lease_version>old.lease_version+1
      or (old.status='accepted') or (old.status='compensated')
      or (old.status in ('reconciliation_pending','compensation_pending') and new.status in ('reserved','provider_succeeded','accepted')) then
      raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  end if;
  if new.status='accepted' and not exists(select 1 from private.photo_upload_acceptances where operation_id=new.operation_id) then
    raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  if new.status in ('reconciliation_pending','compensation_pending','compensated') and exists(select 1 from private.photo_upload_acceptances where operation_id=new.operation_id) then
    raise exception using errcode='55000',message='PHOTO_OPERATION_ACCEPTED'; end if;
  if new.status in ('provider_succeeded','accepted','compensation_pending','compensated') and not exists(
    select 1 from private.photo_provider_objects where operation_id=new.operation_id and provider_locator is not null) then
    raise exception using errcode='23514',message='PHOTO_PROVIDER_RESULT_REQUIRED'; end if;
  new.updated_at:=clock_timestamp();
  return new;
end; $$;
revoke all on function private.guard_photo_storage_state() from public,anon,authenticated,service_role;
create trigger photo_upload_state_guard before insert or update or delete on private.photo_upload_states
for each row execute function private.guard_photo_storage_state();
create function private.append_photo_storage_event() returns trigger language plpgsql set search_path='' as $$
begin
  insert into private.photo_upload_events(operation_id,revision,state,lease_version)
    values(new.operation_id,new.revision,new.status,new.lease_version);
  return new;
end; $$;
revoke all on function private.append_photo_storage_event() from public,anon,authenticated,service_role;
create trigger photo_upload_state_event after insert or update on private.photo_upload_states
for each row execute function private.append_photo_storage_event();
create function private.guard_photo_upload_acceptance() returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from private.photo_upload_operations o join private.photo_upload_states s on s.operation_id=o.id
    join private.photo_provider_objects obj on obj.operation_id=o.id join private.attempt_photo_versions p on p.id=new.photo_version_id
    where o.id=new.operation_id and obj.id=new.object_id and s.status='provider_succeeded'
      and p.cleaning_attempt_id=o.cleaning_attempt_id and p.cleaning_target_id=o.cleaning_target_id
      and p.target_photo_slot_id=o.target_photo_slot_id and p.version=o.expected_photo_revision+1
      and p.sha256=o.sha256 and p.mime_type=o.mime_type and p.size_bytes=o.size_bytes
      and p.uploaded_at=obj.uploaded_at and p.purge_after=obj.purge_after and p.validation_status='verified') then
    raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  return new;
end; $$;
revoke all on function private.guard_photo_upload_acceptance() from public,anon,authenticated,service_role;
create trigger photo_upload_acceptance_guard before insert on private.photo_upload_acceptances
for each row execute function private.guard_photo_upload_acceptance();
do $$ declare t text; begin
  foreach t in array array['photo_upload_operations','photo_provider_objects','photo_upload_acceptances','photo_upload_events'] loop
    execute format('create trigger photo_storage_immutable before update or delete on private.%I for each row execute function private.guard_photo_storage_immutable()',t);
  end loop;
  foreach t in array array['photo_upload_operations','photo_provider_objects','photo_upload_states','photo_upload_acceptances','photo_upload_events','photo_upload_rate_limits'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',t);
  end loop;
end; $$;

create function private.photo_upload_projection(p_operation uuid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('operationId',o.id,'objectId',obj.id,'attemptId',o.cleaning_attempt_id,'targetSlotId',o.target_photo_slot_id,
  'status',s.status,'leaseVersion',s.lease_version,'leaseExpiresAt',s.lease_expires_at,
  'photoId',a.photo_version_id,'photoVersion',p.version,'uploadedAt',obj.uploaded_at,'purgeAfter',obj.purge_after,
  'compensationAllowed',s.status='compensation_pending' and a.operation_id is null and obj.provider_locator is not null)
from private.photo_upload_operations o join private.photo_upload_states s on s.operation_id=o.id
join private.photo_provider_objects obj on obj.operation_id=o.id
left join private.photo_upload_acceptances a on a.operation_id=o.id left join private.attempt_photo_versions p on p.id=a.photo_version_id
where o.id=p_operation
$$;
revoke all on function private.photo_upload_projection(uuid) from public,anon,authenticated,service_role;

create function private.assert_photo_upload_actor(p_actor uuid,p_session uuid,p_attempt uuid)
returns public.cleaning_attempts language plpgsql set search_path='' as $$
declare p public.profiles; a public.cleaning_attempts;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into p from public.profiles where id=p_actor for no key update;
  perform private.assert_attempt_actor_session(p_actor,p_session,false);
  perform 1 from auth.sessions where id=p_session and user_id=p.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  a:=private.assert_photo_model_actor(p_actor,p_attempt,'upload_evidence');
  return a;
end; $$;
revoke all on function private.assert_photo_upload_actor(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.begin_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_assignment_id uuid,
  p_assignment_revision bigint,p_target_slot_id uuid,p_expected_photo_revision bigint,p_sha256 text,p_mime_type text,p_size_bytes integer,
  p_idempotency_key_digest text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; o private.photo_upload_operations; at_time timestamptz; bucket private.photo_upload_rate_limits;
begin
  if p_idempotency_key_digest is null or p_idempotency_key_digest !~ '^[0-9a-f]{64}$' or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' or p_mime_type is null or p_mime_type not in ('image/jpeg','image/webp')
    or p_size_bytes is null or p_size_bytes not between 1 and 307200 or p_expected_photo_revision is null or p_expected_photo_revision not between 0 and 9007199254740990 then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  a:=private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  select * into o from private.photo_upload_operations where actor_profile_id=p_actor_profile_id and command_type='photo.upload' and idempotency_key_digest=p_idempotency_key_digest;
  if o.id is not null then
    if o.request_hash<>p_request_hash or row(o.cleaning_attempt_id,o.assignment_id,o.assignment_revision,o.target_photo_slot_id,o.expected_photo_revision,o.sha256,o.mime_type,o.size_bytes)
      is distinct from row(p_attempt_id,p_assignment_id,p_assignment_revision,p_target_slot_id,p_expected_photo_revision,p_sha256,p_mime_type,p_size_bytes) then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    return private.photo_upload_projection(o.id);
  end if;
  if a.assignment_id is distinct from p_assignment_id or a.assignment_revision is distinct from p_assignment_revision then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
  if not exists(select 1 from private.target_photo_slot_snapshots s join private.target_photo_snapshot_contracts c on c.cleaning_target_id=s.cleaning_target_id
    where s.id=p_target_slot_id and s.cleaning_target_id=a.cleaning_target_id and c.ready) then
    raise exception using errcode='23514',message='PHOTO_SLOT_INVALID'; end if;
  if coalesce((select revision from private.attempt_photo_current where cleaning_attempt_id=a.id and target_photo_slot_id=p_target_slot_id),0)<>p_expected_photo_revision then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;
  if exists(select 1 from private.photo_upload_states where cleaning_attempt_id=a.id and target_photo_slot_id=p_target_slot_id and status in ('reserved','provider_succeeded')) then
    raise exception using errcode='55000',message='PHOTO_UPLOAD_IN_FLIGHT'; end if;
  if (select count(*) from private.photo_upload_states where actor_profile_id=p_actor_profile_id and status in ('reserved','provider_succeeded'))>=8 then
    raise exception using errcode='54000',message='PHOTO_UPLOAD_LIMIT_EXCEEDED'; end if;
  at_time:=clock_timestamp();
  select * into bucket from private.photo_upload_rate_limits where actor_profile_id=p_actor_profile_id;
  if bucket.minute_started_at=date_trunc('minute',at_time) and bucket.occurrence_count>=30 then
    -- RAISE rolls back statements, therefore saturated denials perform no durable write.
    raise exception using errcode='54000',message='PHOTO_UPLOAD_RATE_LIMITED'; end if;
  insert into private.photo_upload_rate_limits(actor_profile_id,minute_started_at,occurrence_count)
    values(p_actor_profile_id,date_trunc('minute',at_time),1) on conflict(actor_profile_id) do update
    set minute_started_at=excluded.minute_started_at,occurrence_count=case when photo_upload_rate_limits.minute_started_at=excluded.minute_started_at then photo_upload_rate_limits.occurrence_count+1 else 1 end;
  insert into private.photo_upload_operations(actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,cleaning_target_id,
    assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,sha256,mime_type,size_bytes)
  values(p_actor_profile_id,p_idempotency_key_digest,p_request_hash,a.id,a.cleaning_target_id,a.assignment_id,a.assignment_revision,
    p_target_slot_id,p_expected_photo_revision,p_sha256,p_mime_type,p_size_bytes) returning * into o;
  insert into private.photo_provider_objects(operation_id) values(o.id);
  insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id)
    values(o.id,a.id,p_target_slot_id,p_actor_profile_id);
  return private.photo_upload_projection(o.id);
end; $$;

create function public.get_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o private.photo_upload_operations;
begin
  select * into o from private.photo_upload_operations where id=p_operation_id and actor_profile_id=p_actor_profile_id;
  if o.id is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);
  return private.photo_upload_projection(o.id);
end; $$;

create function public.claim_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o private.photo_upload_operations; s private.photo_upload_states; at_time timestamptz;
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' then raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  select * into o from private.photo_upload_operations where id=p_operation_id and actor_profile_id=p_actor_profile_id;
  if o.id is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);
  select * into s from private.photo_upload_states where operation_id=o.id for update;
  at_time:=clock_timestamp();
  if s.status='accepted' then return private.photo_upload_projection(o.id); end if;
  if s.status not in ('reserved','provider_succeeded') then raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  if s.lease_expires_at>at_time then
    if s.lease_claim_digest<>p_claim_digest then raise exception using errcode='55000',message='PHOTO_UPLOAD_IN_FLIGHT'; end if;
    return private.photo_upload_projection(o.id);
  end if;
  if s.lease_version>=8 then raise exception using errcode='54000',message='PHOTO_UPLOAD_LEASE_LIMIT'; end if;
  update private.photo_upload_states set lease_version=lease_version+1,lease_claim_digest=p_claim_digest,
    lease_expires_at=at_time+interval '5 minutes',revision=revision+1 where operation_id=o.id;
  return private.photo_upload_projection(o.id);
end; $$;

-- Worker RPC: records an already completed, independently validated external upload; no user credential persists.
create function public.record_photo_provider_success(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_provider_locator text,p_uploaded_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.photo_upload_states; obj private.photo_provider_objects; o private.photo_upload_operations; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into s from private.photo_upload_states where operation_id=p_operation_id for update;
  select * into obj from private.photo_provider_objects where operation_id=p_operation_id for update;
  select * into o from private.photo_upload_operations where id=p_operation_id;
  at_time:=clock_timestamp();
  if o.id is null then raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' or p_provider_locator is null or p_provider_locator !~ '^[A-Za-z0-9_-]{10,200}$' or p_uploaded_at is null or not isfinite(p_uploaded_at)
    or p_uploaded_at<o.created_at or p_uploaded_at>at_time then
    raise exception using errcode='23514',message='PHOTO_PROVIDER_RESULT_INVALID'; end if;
  if s.status='accepted' and obj.provider_locator=p_provider_locator and obj.uploaded_at=p_uploaded_at then
    return private.photo_upload_projection(o.id); end if;
  if s.lease_version is distinct from p_lease_version or s.lease_claim_digest is distinct from p_claim_digest or p_lease_version<1 or s.lease_expires_at is null or s.lease_expires_at<=at_time then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  if s.status not in ('reserved','provider_succeeded','reconciliation_pending') then
    raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  if obj.provider_locator is not null then
    if obj.provider_locator<>p_provider_locator or obj.uploaded_at<>p_uploaded_at then
      raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
    return private.photo_upload_projection(o.id);
  end if;
  if exists(select 1 from private.photo_provider_objects where provider='google_drive' and provider_locator=p_provider_locator) then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  update private.photo_provider_objects set provider_locator=p_provider_locator,uploaded_at=p_uploaded_at,purge_after=p_uploaded_at+interval '168 hours' where id=obj.id;
  update private.photo_upload_states set status=case when status='reconciliation_pending' then 'compensation_pending' else 'provider_succeeded' end,
    revision=revision+1 where operation_id=o.id;
  return private.photo_upload_projection(o.id);
end; $$;

create function public.finalize_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o private.photo_upload_operations; s private.photo_upload_states; obj private.photo_provider_objects; photo uuid; at_time timestamptz; p public.profiles;
begin
  select * into o from private.photo_upload_operations where id=p_operation_id and actor_profile_id=p_actor_profile_id;
  if o.id is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);
  select * into s from private.photo_upload_states where operation_id=o.id for update;
  select * into obj from private.photo_provider_objects where operation_id=o.id for update;
  at_time:=clock_timestamp();
  if s.status='accepted' then return private.photo_upload_projection(o.id); end if;
  if s.status not in ('reserved','provider_succeeded') then raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  if s.lease_version is distinct from p_lease_version or s.lease_claim_digest is distinct from p_claim_digest or p_lease_version<1 or s.lease_expires_at is null or s.lease_expires_at<=at_time then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  if s.status<>'provider_succeeded' or obj.provider_locator is null then raise exception using errcode='55000',message='PHOTO_PROVIDER_RESULT_REQUIRED'; end if;
  photo:=private.record_validated_attempt_photo(o.actor_profile_id,o.cleaning_attempt_id,o.target_photo_slot_id,o.expected_photo_revision,
    o.sha256,o.mime_type,o.size_bytes,obj.uploaded_at);
  insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id) values(o.id,obj.id,photo);
  update private.photo_upload_states set status='accepted',revision=revision+1 where operation_id=o.id;
  select * into p from public.profiles where id=o.actor_profile_id;
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,recorded_at,idempotency_key,after_state)
  values('photo.upload_accepted','cleaning_attempt',o.cleaning_attempt_id,p.id,p.display_name,obj.uploaded_at,clock_timestamp(),
    'photo-upload-'||o.id::text,jsonb_build_object('cleaningTargetId',o.cleaning_target_id,'attemptId',o.cleaning_attempt_id,
      'photoId',photo,'targetSlotId',o.target_photo_slot_id,'photoVersion',o.expected_photo_revision+1,'uploadedAt',obj.uploaded_at,'purgeAfter',obj.purge_after));
  return private.photo_upload_projection(o.id);
end; $$;

-- Internal reconciliation does not require the former user's live session. Accepted evidence is permanent history,
-- even after clear/replace/handover/revocation. Unknown provider outcome is never permission to delete.
create function public.reconcile_photo_upload(p_operation_id uuid,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.photo_upload_states; obj private.photo_provider_objects; at_time timestamptz;
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' then raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into s from private.photo_upload_states where operation_id=p_operation_id for update;
  select * into obj from private.photo_provider_objects where operation_id=p_operation_id for update;
  if s.operation_id is null then raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  if exists(select 1 from private.photo_upload_acceptances where operation_id=p_operation_id) then return private.photo_upload_projection(p_operation_id); end if;
  at_time:=clock_timestamp();
  if s.status='compensated' then return private.photo_upload_projection(p_operation_id); end if;
  if s.lease_expires_at>at_time then
    if s.status in ('reconciliation_pending','compensation_pending') and s.lease_claim_digest=p_claim_digest then return private.photo_upload_projection(p_operation_id); end if;
    raise exception using errcode='55000',message='PHOTO_UPLOAD_IN_FLIGHT'; end if;
  if s.lease_version>=8 then raise exception using errcode='54000',message='PHOTO_UPLOAD_LEASE_LIMIT'; end if;
  -- This transaction explicitly retires business finalization and takes a new fence before exposing a candidate.
  update private.photo_upload_states set status=case when obj.provider_locator is null then 'reconciliation_pending' else 'compensation_pending' end,
    lease_version=lease_version+1,lease_claim_digest=p_claim_digest,lease_expires_at=at_time+interval '5 minutes',revision=revision+1 where operation_id=p_operation_id;
  return private.photo_upload_projection(p_operation_id);
end; $$;

create function public.settle_photo_compensation(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s private.photo_upload_states; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into s from private.photo_upload_states where operation_id=p_operation_id for update;
  at_time:=clock_timestamp();
  if s.operation_id is null then raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  if exists(select 1 from private.photo_upload_acceptances where operation_id=p_operation_id) then raise exception using errcode='55000',message='PHOTO_OPERATION_ACCEPTED'; end if;
  if p_outcome is null or p_outcome not in ('deleted','not_found') then raise exception using errcode='23514',message='PHOTO_COMPENSATION_INVALID'; end if;
  if s.status='compensated' then return private.photo_upload_projection(p_operation_id); end if;
  if s.status<>'compensation_pending' then raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  if s.lease_version is distinct from p_lease_version or s.lease_claim_digest is distinct from p_claim_digest or p_lease_version<1 or s.lease_expires_at is null or s.lease_expires_at<=at_time then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  update private.photo_upload_states set status='compensated',revision=revision+1 where operation_id=p_operation_id;
  return private.photo_upload_projection(p_operation_id);
end; $$;

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)'::regprocedure,
    'public.get_photo_upload(uuid,uuid,uuid)'::regprocedure,'public.claim_photo_upload(uuid,uuid,uuid,text)'::regprocedure,
    'public.record_photo_provider_success(uuid,integer,text,text,timestamptz)'::regprocedure,
    'public.finalize_photo_upload(uuid,uuid,uuid,integer,text)'::regprocedure,'public.reconcile_photo_upload(uuid,text)'::regprocedure,
    'public.settle_photo_compensation(uuid,integer,text,text)'::regprocedure] loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end; $$;

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
    'cleaning.offline_event_resolved','photo.upload_accepted',
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
      when audit.event_type='photo.upload_accepted' then jsonb_build_object(
        'cleaningTargetId',audit.after_state->>'cleaningTargetId','attemptId',audit.after_state->>'attemptId',
        'photoId',audit.after_state->>'photoId','targetSlotId',audit.after_state->>'targetSlotId',
        'photoVersion',audit.after_state->'photoVersion','uploadedAt',audit.after_state->>'uploadedAt','purgeAfter',audit.after_state->>'purgeAfter')
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
