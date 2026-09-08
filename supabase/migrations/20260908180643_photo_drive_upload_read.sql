-- #84: private pre-decode admission, conservative provider quota accounting,
-- persist-before-create Drive identity, and authenticated app-photo read context.
-- No Google calls, credentials, public file URLs, purge worker, or production data.
create table private.photo_storage_quota_snapshot (
  provider text primary key check(provider='google_drive'),
  request_started_at timestamptz not null check(isfinite(request_started_at)),
  recorded_at timestamptz not null check(isfinite(recorded_at) and recorded_at>=request_started_at),
  usage_bytes bigint not null check(usage_bytes between 0 and 9007199254740991),
  revision bigint not null check(revision>0)
);
create table private.photo_upload_admissions (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  assignment_revision bigint not null check(assignment_revision>0),
  target_photo_slot_id uuid not null,
  expected_photo_revision bigint not null check(expected_photo_revision between 0 and 9007199254740990),
  idempotency_key_digest text not null check(idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  reserved_bytes integer not null default 307200 check(reserved_bytes=307200),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  quota_revision bigint not null check(quota_revision>0),
  check(isfinite(created_at) and expires_at=created_at+interval '5 minutes'),
  unique(actor_profile_id,idempotency_key_digest),
  unique(id,actor_profile_id),
  foreign key(cleaning_attempt_id,cleaning_target_id) references public.cleaning_attempts(id,cleaning_target_id) on delete restrict,
  foreign key(target_photo_slot_id,cleaning_target_id) references private.target_photo_slot_snapshots(id,cleaning_target_id) on delete restrict
);
create index photo_admission_attempt_slot_idx on private.photo_upload_admissions(cleaning_attempt_id,target_photo_slot_id,expires_at);
create index photo_admission_actor_expiry_idx on private.photo_upload_admissions(actor_profile_id,expires_at);
create index photo_admission_target_idx on private.photo_upload_admissions(cleaning_target_id);
create index photo_admission_assignment_idx on private.photo_upload_admissions(assignment_id);
create index photo_admission_slot_idx on private.photo_upload_admissions(target_photo_slot_id,cleaning_target_id);
create table private.photo_upload_admission_bindings (
  admission_id uuid primary key references private.photo_upload_admissions(id) on delete restrict,
  operation_id uuid not null unique references private.photo_upload_operations(id) on delete restrict,
  bound_at timestamptz not null default clock_timestamp()
);
create table private.photo_upload_admission_limits (
  actor_profile_id uuid primary key references public.profiles(id) on delete restrict,
  minute_started_at timestamptz not null,
  occurrence_count integer not null check(occurrence_count between 1 and 30)
);
create table private.photo_drive_identities (
  object_id uuid primary key,
  operation_id uuid not null unique,
  provider_file_id text not null unique check(provider_file_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  provider_folder_id text not null check(provider_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  upload_date date not null,
  room_number text not null check(room_number ~ '^[0-9]{3}$'),
  reserved_at timestamptz not null default clock_timestamp(),
  foreign key(object_id,operation_id) references private.photo_provider_objects(id,operation_id) on delete restrict
);
-- Folder candidates are reserved before Drive create. Different workers must use
-- the same committed winner; a losing generated ID is never sent to Drive.
create table private.photo_drive_folder_identities (
  id uuid primary key default gen_random_uuid(),
  upload_date date not null,
  scope_room_number text not null check(scope_room_number='' or scope_room_number ~ '^[0-9]{3}$'),
  provider_folder_id text not null unique check(provider_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  parent_folder_id text not null check(parent_folder_id ~ '^[A-Za-z0-9_-]{10,200}$'),
  parent_registry_id uuid references private.photo_drive_folder_identities(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique(upload_date,scope_room_number),
  check(provider_folder_id<>parent_folder_id),
  check((scope_room_number='' and parent_registry_id is null) or (scope_room_number<>'' and parent_registry_id is not null))
);
create index photo_drive_folder_parent_idx on private.photo_drive_folder_identities(parent_registry_id);
create function private.guard_photo_drive_immutable() returns trigger language plpgsql set search_path='' as $$
begin raise exception using errcode='55000',message='PHOTO_STORAGE_IMMUTABLE'; end; $$;
revoke all on function private.guard_photo_drive_immutable() from public,anon,authenticated,service_role;
do $$ declare t text; begin
  foreach t in array array['photo_upload_admissions','photo_upload_admission_bindings','photo_drive_identities','photo_drive_folder_identities'] loop
    execute format('create trigger photo_drive_immutable before update or delete on private.%I for each row execute function private.guard_photo_drive_immutable()',t);
  end loop;
  foreach t in array array['photo_storage_quota_snapshot','photo_upload_admissions','photo_upload_admission_bindings','photo_upload_admission_limits','photo_drive_identities','photo_drive_folder_identities'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',t);
  end loop;
end; $$;

create function private.guard_photo_admission_binding() returns trigger language plpgsql set search_path='' as $$
begin
  if not exists(select 1 from private.photo_upload_admissions ad join private.photo_upload_operations o on o.id=new.operation_id
    where ad.id=new.admission_id and ad.actor_profile_id=o.actor_profile_id and ad.cleaning_attempt_id=o.cleaning_attempt_id
      and ad.cleaning_target_id=o.cleaning_target_id and ad.assignment_id=o.assignment_id and ad.assignment_revision=o.assignment_revision
      and ad.target_photo_slot_id=o.target_photo_slot_id and ad.expected_photo_revision=o.expected_photo_revision
      and ad.idempotency_key_digest=o.idempotency_key_digest and o.created_at>=ad.created_at and o.created_at<ad.expires_at) then
    raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  return new;
end; $$;
revoke all on function private.guard_photo_admission_binding() from public,anon,authenticated,service_role;
create trigger photo_admission_binding_guard before insert on private.photo_upload_admission_bindings
for each row execute function private.guard_photo_admission_binding();
create function private.guard_photo_reserved_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='photo_drive_identities' then
    if not exists(select 1 from private.photo_upload_admission_bindings where operation_id=new.operation_id)
      or exists(select 1 from private.photo_drive_folder_identities where provider_folder_id=new.provider_file_id)
      or exists(select 1 from private.photo_provider_objects where provider_locator=new.provider_file_id and operation_id<>new.operation_id) then
      raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  else
    if new.provider_locator is not null and (exists(select 1 from private.photo_drive_identities where provider_file_id=new.provider_locator and operation_id<>new.operation_id)
      or exists(select 1 from private.photo_drive_identities where operation_id=new.operation_id and provider_file_id<>new.provider_locator)) then
      raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  end if;
  return new;
end; $$;
revoke all on function private.guard_photo_reserved_identity() from public,anon,authenticated,service_role;
create trigger photo_reserved_identity_guard before insert on private.photo_drive_identities
for each row execute function private.guard_photo_reserved_identity();
create trigger photo_provider_reserved_identity_guard before insert or update on private.photo_provider_objects
for each row execute function private.guard_photo_reserved_identity();

create function private.guard_photo_folder_parent() returns trigger language plpgsql set search_path='' as $$
begin
  if new.scope_room_number<>'' and not exists(select 1 from private.photo_drive_folder_identities d
    where d.id=new.parent_registry_id and d.scope_room_number='' and d.upload_date=new.upload_date and d.provider_folder_id=new.parent_folder_id) then
    raise exception using errcode='23514',message='PHOTO_FOLDER_PARENT_REQUIRED'; end if;
  if exists(select 1 from private.photo_drive_identities where provider_file_id=new.provider_folder_id)
    or exists(select 1 from private.photo_provider_objects where provider_locator=new.provider_folder_id) then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  return new;
end; $$;
revoke all on function private.guard_photo_folder_parent() from public,anon,authenticated,service_role;
create trigger photo_drive_folder_parent_guard before insert on private.photo_drive_folder_identities
for each row execute function private.guard_photo_folder_parent();

-- All entry points first use the existing domain lock, then quota/admission rows.
-- Refresh's request-start watermark prevents an older HTTP response replacing newer usage.
create function public.refresh_photo_storage_quota(p_request_started_at timestamptz,p_usage_bytes bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare q private.photo_storage_quota_snapshot; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into q from private.photo_storage_quota_snapshot where provider='google_drive' for update;
  at_time:=clock_timestamp();
  if p_request_started_at is null or not isfinite(p_request_started_at) or p_request_started_at>at_time
    or p_request_started_at<=at_time-interval '60 seconds' or p_usage_bytes is null or p_usage_bytes not between 0 and 9007199254740991 then
    raise exception using errcode='23514',message='PHOTO_QUOTA_SNAPSHOT_INVALID'; end if;
  if q.provider is not null and p_request_started_at<=q.request_started_at then
    raise exception using errcode='40001',message='PHOTO_QUOTA_SNAPSHOT_STALE'; end if;
  insert into private.photo_storage_quota_snapshot(provider,request_started_at,recorded_at,usage_bytes,revision)
    values('google_drive',p_request_started_at,at_time,p_usage_bytes,1)
    on conflict(provider) do update set request_started_at=excluded.request_started_at,recorded_at=excluded.recorded_at,
      usage_bytes=excluded.usage_bytes,revision=photo_storage_quota_snapshot.revision+1 returning * into q;
  return jsonb_build_object('revision',q.revision,'observedAt',q.request_started_at,'usageBytes',q.usage_bytes,
    'warning',q.usage_bytes>=10000000000,'blocked',q.usage_bytes>=12000000000);
end; $$;

create function private.photo_quota_context(p_at timestamptz) returns jsonb language plpgsql stable set search_path='' as $$
declare q private.photo_storage_quota_snapshot; pending bigint;
begin
  select * into q from private.photo_storage_quota_snapshot where provider='google_drive';
  if q.provider is null or q.request_started_at>p_at or q.request_started_at<=p_at-interval '60 seconds' then
    raise exception using errcode='55000',message='PHOTO_STORAGE_QUOTA_UNAVAILABLE'; end if;
  select coalesce(sum(ad.reserved_bytes),0)::bigint into pending from private.photo_upload_admissions ad
    left join private.photo_upload_admission_bindings b on b.admission_id=ad.id
    left join private.photo_provider_objects obj on obj.operation_id=b.operation_id
    left join private.photo_upload_states st on st.operation_id=b.operation_id
    where (b.operation_id is not null or ad.expires_at>p_at)
      and coalesce(st.status,'reserved')<>'compensated'
      -- Full provider usage absorbs ONLY uploads completed before this refresh STARTED.
      -- Accepted-after-snapshot, in-flight and unknown bytes remain reserved indefinitely.
      and (obj.uploaded_at is null or obj.uploaded_at>=q.request_started_at
        -- Google createdTime may precede a delayed acknowledgement. Do not debit
        -- an already-returned quota snapshot until DB had actually observed the success.
        or not exists(select 1 from private.photo_upload_events ev where ev.operation_id=b.operation_id
          and ev.state in ('provider_succeeded','compensation_pending') and ev.occurred_at<q.request_started_at));
  return jsonb_build_object('revision',q.revision,'usageBytes',q.usage_bytes,'pendingBytes',pending,
    'effectiveBytes',q.usage_bytes+pending,'warning',q.usage_bytes+pending>=10000000000);
end; $$;
revoke all on function private.photo_quota_context(timestamptz) from public,anon,authenticated,service_role;

create function public.admit_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_assignment_id uuid,
  p_assignment_revision bigint,p_target_slot_id uuid,p_expected_photo_revision bigint,p_idempotency_key_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; ad private.photo_upload_admissions; lim private.photo_upload_admission_limits;
  q jsonb; at_time timestamptz;
begin
  if p_idempotency_key_digest is null or p_idempotency_key_digest !~ '^[0-9a-f]{64}$'
    or p_expected_photo_revision is null or p_expected_photo_revision not between 0 and 9007199254740990 then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  a:=private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  at_time:=clock_timestamp();
  select * into ad from private.photo_upload_admissions where actor_profile_id=p_actor_profile_id and idempotency_key_digest=p_idempotency_key_digest;
  if ad.id is not null and row(ad.cleaning_attempt_id,ad.assignment_id,ad.assignment_revision,ad.target_photo_slot_id,ad.expected_photo_revision)
    is distinct from row(p_attempt_id,p_assignment_id,p_assignment_revision,p_target_slot_id,p_expected_photo_revision) then
    raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  if ad.id is not null and ad.expires_at<=at_time and not exists(select 1 from private.photo_upload_admission_bindings where admission_id=ad.id) then
    raise exception using errcode='55000',message='PHOTO_ADMISSION_EXPIRED'; end if;
  if ad.id is null then
    if a.assignment_id is distinct from p_assignment_id or a.assignment_revision is distinct from p_assignment_revision then
      raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
    if not exists(select 1 from private.target_photo_slot_snapshots sl join private.target_photo_snapshot_contracts c on c.cleaning_target_id=sl.cleaning_target_id
      where sl.id=p_target_slot_id and sl.cleaning_target_id=a.cleaning_target_id and c.ready) then
      raise exception using errcode='23514',message='PHOTO_SLOT_INVALID'; end if;
    if coalesce((select revision from private.attempt_photo_current where cleaning_attempt_id=a.id and target_photo_slot_id=p_target_slot_id),0)<>p_expected_photo_revision then
      raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;
    if exists(select 1 from private.photo_upload_admissions x left join private.photo_upload_admission_bindings b on b.admission_id=x.id
      left join private.photo_upload_states s on s.operation_id=b.operation_id where x.cleaning_attempt_id=a.id and x.target_photo_slot_id=p_target_slot_id
      and ((b.operation_id is null and x.expires_at>at_time) or s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending'))) then
      raise exception using errcode='55000',message='PHOTO_UPLOAD_IN_FLIGHT'; end if;
    if (select count(*) from private.photo_upload_admissions x left join private.photo_upload_admission_bindings b on b.admission_id=x.id
      left join private.photo_upload_states s on s.operation_id=b.operation_id where x.actor_profile_id=p_actor_profile_id
      and ((b.operation_id is null and x.expires_at>at_time) or s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending')))>=8 then
      raise exception using errcode='54000',message='PHOTO_UPLOAD_LIMIT_EXCEEDED'; end if;
  end if;
  q:=private.photo_quota_context(at_time);
  if ad.id is null and (q->>'effectiveBytes')::bigint+307200>=12000000000 then
    raise exception using errcode='54000',message='PHOTO_STORAGE_QUOTA_EXCEEDED'; end if;
  -- Every pre-decode request, including the same key, consumes the bounded CPU admission rate.
  select * into lim from private.photo_upload_admission_limits where actor_profile_id=p_actor_profile_id;
  if lim.minute_started_at=date_trunc('minute',at_time) and lim.occurrence_count>=30 then
    raise exception using errcode='54000',message='PHOTO_UPLOAD_RATE_LIMITED'; end if;
  insert into private.photo_upload_admission_limits values(p_actor_profile_id,date_trunc('minute',at_time),1)
    on conflict(actor_profile_id) do update set minute_started_at=excluded.minute_started_at,
      occurrence_count=case when photo_upload_admission_limits.minute_started_at=excluded.minute_started_at then photo_upload_admission_limits.occurrence_count+1 else 1 end;
  if ad.id is null then
    insert into private.photo_upload_admissions(actor_profile_id,cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,
      target_photo_slot_id,expected_photo_revision,idempotency_key_digest,created_at,expires_at,quota_revision)
    values(p_actor_profile_id,a.id,a.cleaning_target_id,a.assignment_id,a.assignment_revision,p_target_slot_id,p_expected_photo_revision,
      p_idempotency_key_digest,at_time,at_time+interval '5 minutes',(q->>'revision')::bigint) returning * into ad;
  end if;
  return jsonb_build_object('admissionId',ad.id,'expiresAt',ad.expires_at,'reservedBytes',ad.reserved_bytes,
    'quotaWarning',(q->>'warning')::boolean);
end; $$;

create function public.begin_admitted_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_admission_id uuid,
  p_sha256 text,p_mime_type text,p_size_bytes integer,p_idempotency_key_digest text,p_request_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ad private.photo_upload_admissions; result jsonb; op uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into ad from private.photo_upload_admissions where id=p_admission_id and actor_profile_id=p_actor_profile_id;
  if ad.id is null or ad.idempotency_key_digest is distinct from p_idempotency_key_digest then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,ad.cleaning_attempt_id);
  select operation_id into op from private.photo_upload_admission_bindings where admission_id=ad.id;
  if op is null and ad.expires_at<=clock_timestamp() then raise exception using errcode='55000',message='PHOTO_ADMISSION_EXPIRED'; end if;
  result:=public.begin_photo_upload(p_actor_profile_id,p_session_id,ad.cleaning_attempt_id,ad.assignment_id,ad.assignment_revision,
    ad.target_photo_slot_id,ad.expected_photo_revision,p_sha256,p_mime_type,p_size_bytes,p_idempotency_key_digest,p_request_hash);
  if op is null then insert into private.photo_upload_admission_bindings(admission_id,operation_id) values(ad.id,(result->>'operationId')::uuid);
  elsif op<>(result->>'operationId')::uuid then raise exception using errcode='23514',message='PHOTO_OPERATION_INVALID'; end if;
  return result;
end; $$;

create function private.assert_admitted_photo_operation(p_operation uuid) returns void language plpgsql set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if not exists(select 1 from private.photo_upload_admission_bindings where operation_id=p_operation) then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
end; $$;
revoke all on function private.assert_admitted_photo_operation(uuid) from public,anon,authenticated,service_role;
create function public.get_admitted_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_admitted_photo_operation(p_operation_id); return public.get_photo_upload(p_actor_profile_id,p_session_id,p_operation_id); end; $$;
create function public.claim_admitted_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_admitted_photo_operation(p_operation_id); return public.claim_photo_upload(p_actor_profile_id,p_session_id,p_operation_id,p_claim_digest); end; $$;
create function public.finalize_admitted_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uploaded timestamptz; folder_date date;
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  perform public.get_photo_upload(p_actor_profile_id,p_session_id,p_operation_id);
  select obj.uploaded_at,ident.upload_date into uploaded,folder_date
    from private.photo_provider_objects obj left join private.photo_drive_identities ident on ident.object_id=obj.id
    where obj.operation_id=p_operation_id for update of obj;
  -- The folder represents the actual Google createdTime KST date, not request time.
  -- Keep a known mismatched candidate/clock immutable for fenced reconciliation;
  -- never accept it, rotate its identity, move it, or fabricate another upload time.
  if uploaded is not null and folder_date is distinct from (uploaded at time zone 'Asia/Seoul')::date then
    raise exception using errcode='55000',message='PHOTO_PROVIDER_DATE_MISMATCH'; end if;
  return public.finalize_photo_upload(p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
end; $$;

-- PRIVATE CONTEXT: callers must never forward this object into HTTP DTOs/logs.
create function public.get_photo_provider_context(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare o private.photo_upload_operations; st private.photo_upload_states; ident private.photo_drive_identities; q jsonb;
  a public.cleaning_attempts; ass public.cleaning_assignments; obj private.photo_provider_objects; at_time timestamptz;
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  select * into o from private.photo_upload_operations where id=p_operation_id and actor_profile_id=p_actor_profile_id;
  if o.id is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  a:=private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,o.cleaning_attempt_id);
  select * into st from private.photo_upload_states where operation_id=o.id for update;
  select * into obj from private.photo_provider_objects where operation_id=o.id for update;
  select * into ass from public.cleaning_assignments where id=o.assignment_id;
  select * into ident from private.photo_drive_identities where operation_id=o.id;
  at_time:=clock_timestamp();
  if st.lease_version is distinct from p_lease_version or st.lease_claim_digest is distinct from p_claim_digest
    or st.lease_expires_at is null or st.lease_expires_at<=at_time or p_lease_version<1 then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  if st.status not in ('reserved','provider_succeeded') then raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  if a.assignment_id<>o.assignment_id or a.assignment_revision<>o.assignment_revision
    or coalesce((select revision from private.attempt_photo_current where cleaning_attempt_id=a.id and target_photo_slot_id=o.target_photo_slot_id),0)<>o.expected_photo_revision then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;
  if ass.notified_room_number_snapshot is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  if st.status='reserved' then
    q:=private.photo_quota_context(at_time);
    if (q->>'effectiveBytes')::bigint>=12000000000 then
      raise exception using errcode='54000',message='PHOTO_STORAGE_QUOTA_EXCEEDED'; end if;
  end if;
  return jsonb_build_object('operationId',o.id,'objectId',obj.id,'attemptId',a.id,
    'slotKey',(select slot_key from private.target_photo_slot_snapshots where id=o.target_photo_slot_id),
    'roomNumber',coalesce(ident.room_number,ass.notified_room_number_snapshot),
    'uploadDate',coalesce(ident.upload_date,(at_time at time zone 'Asia/Seoul')::date),
    'sha256',o.sha256,'mimeType',o.mime_type,'sizeBytes',o.size_bytes,
    'providerFileId',ident.provider_file_id,'providerFolderId',ident.provider_folder_id);
end; $$;

create function public.reserve_photo_drive_folder(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,
  p_lease_version integer,p_claim_digest text,p_scope text,p_root_folder_id text,p_candidate_folder_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb; day date; room text; parent_id text; parent_row uuid; winner private.photo_drive_folder_identities;
begin
  if p_scope is null or p_scope not in ('date','room') or p_root_folder_id is null or p_root_folder_id !~ '^[A-Za-z0-9_-]{10,200}$'
    or p_candidate_folder_id is null or p_candidate_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  ctx:=public.get_photo_provider_context(p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
  day:=(ctx->>'uploadDate')::date; room:=case when p_scope='date' then '' else ctx->>'roomNumber' end;
  parent_id:=p_root_folder_id;
  if p_scope='room' then
    select id,provider_folder_id into parent_row,parent_id from private.photo_drive_folder_identities
      where upload_date=day and scope_room_number='' and parent_folder_id=p_root_folder_id;
    if parent_row is null then raise exception using errcode='23514',message='PHOTO_FOLDER_PARENT_REQUIRED'; end if;
  end if;
  if exists(select 1 from private.photo_drive_folder_identities where provider_folder_id=p_candidate_folder_id
    and (upload_date<>day or scope_room_number<>room)) then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  insert into private.photo_drive_folder_identities(upload_date,scope_room_number,provider_folder_id,parent_folder_id,parent_registry_id)
    values(day,room,p_candidate_folder_id,parent_id,parent_row) on conflict(upload_date,scope_room_number) do nothing;
  select * into winner from private.photo_drive_folder_identities where upload_date=day and scope_room_number=room;
  if winner.parent_folder_id<>parent_id or winner.parent_registry_id is distinct from parent_row then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  return jsonb_build_object('scope',p_scope,'folderId',winner.provider_folder_id,'parentFolderId',winner.parent_folder_id,
    'uploadDate',winner.upload_date,'roomNumber',nullif(winner.scope_room_number,''));
end; $$;

create function public.reserve_photo_provider_identity(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,
  p_lease_version integer,p_claim_digest text,p_provider_file_id text,p_provider_folder_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb; ident private.photo_drive_identities;
begin
  if p_provider_file_id is null or p_provider_file_id !~ '^[A-Za-z0-9_-]{10,200}$'
    or p_provider_folder_id is null or p_provider_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception using errcode='23514',message='PHOTO_PROVIDER_RESULT_INVALID'; end if;
  ctx:=public.get_photo_provider_context(p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
  if not exists(select 1 from private.photo_drive_folder_identities where provider_folder_id=p_provider_folder_id
    and upload_date=(ctx->>'uploadDate')::date and scope_room_number=ctx->>'roomNumber') then
    raise exception using errcode='23514',message='PHOTO_FOLDER_PARENT_REQUIRED'; end if;
  select * into ident from private.photo_drive_identities where operation_id=p_operation_id;
  if ident.object_id is not null then
    if ident.provider_file_id<>p_provider_file_id or ident.provider_folder_id<>p_provider_folder_id then
      raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  else
    if exists(select 1 from private.photo_drive_identities where provider_file_id=p_provider_file_id)
      or exists(select 1 from private.photo_provider_objects where provider_locator=p_provider_file_id and operation_id<>p_operation_id) then
      raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
    insert into private.photo_drive_identities(object_id,operation_id,provider_file_id,provider_folder_id,upload_date,room_number)
      values((ctx->>'objectId')::uuid,p_operation_id,p_provider_file_id,p_provider_folder_id,(ctx->>'uploadDate')::date,ctx->>'roomNumber');
  end if;
  return public.get_photo_provider_context(p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
end; $$;

create function public.record_admitted_photo_provider_success(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_provider_locator text,p_uploaded_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  if not exists(select 1 from private.photo_drive_identities where operation_id=p_operation_id and provider_file_id=p_provider_locator) then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  return public.record_photo_provider_success(p_operation_id,p_lease_version,p_claim_digest,p_provider_locator,p_uploaded_at);
end; $$;
create function public.reconcile_admitted_photo_upload(p_operation_id uuid,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_admitted_photo_operation(p_operation_id); return public.reconcile_photo_upload(p_operation_id,p_claim_digest); end; $$;
create function public.settle_admitted_photo_compensation(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin perform private.assert_admitted_photo_operation(p_operation_id); return public.settle_photo_compensation(p_operation_id,p_lease_version,p_claim_digest,p_outcome); end; $$;

-- Fenced worker context is independent of the previous user's live credentials.
-- Accepted is always discoverable, but never includes deletion context.
create function public.get_photo_reconciliation_context(p_operation_id uuid,p_lease_version integer,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare st private.photo_upload_states; obj private.photo_provider_objects; ident private.photo_drive_identities; o private.photo_upload_operations;
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  select * into st from private.photo_upload_states where operation_id=p_operation_id for update;
  select * into obj from private.photo_provider_objects where operation_id=p_operation_id for update;
  if exists(select 1 from private.photo_upload_acceptances where operation_id=p_operation_id) then
    return jsonb_build_object('operationId',p_operation_id,'status','accepted','compensationAllowed',false); end if;
  if st.lease_version is distinct from p_lease_version or st.lease_claim_digest is distinct from p_claim_digest
    or st.lease_expires_at is null or st.lease_expires_at<=clock_timestamp() or p_lease_version<1 then
    raise exception using errcode='40001',message='PHOTO_UPLOAD_FENCE_CONFLICT'; end if;
  if st.status not in ('reconciliation_pending','compensation_pending') then raise exception using errcode='55000',message='PHOTO_OPERATION_TERMINAL'; end if;
  select * into ident from private.photo_drive_identities where operation_id=p_operation_id;
  select * into o from private.photo_upload_operations where id=p_operation_id;
  return jsonb_build_object('operationId',o.id,'objectId',obj.id,'status',st.status,
    'compensationAllowed',st.status='compensation_pending' and obj.provider_locator is not null,
    'providerFileId',ident.provider_file_id,'providerFolderId',ident.provider_folder_id,
    'sha256',o.sha256,'mimeType',o.mime_type,'sizeBytes',o.size_bytes,
    'uploadedAt',obj.uploaded_at,'purgeAfter',obj.purge_after);
end; $$;

create function public.get_attempt_photo_slots(p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; p public.profiles; ass public.cleaning_assignments; t public.cleaning_targets;
  may_read boolean; at_time timestamptz; slot_rows jsonb;
begin
  a:=private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  select * into p from public.profiles where id=p_actor_profile_id;
  select * into ass from public.cleaning_assignments where id=a.assignment_id;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id;
  at_time:=clock_timestamp();
  if not exists(select 1 from private.target_photo_snapshot_contracts where cleaning_target_id=a.cleaning_target_id and ready) then
    raise exception using errcode='23514',message='PHOTO_SLOT_INVALID'; end if;
  may_read:=p.status='active' and ass.is_current and ass.ended_at is null and ass.notified_at is not null
    and ass.revision=a.assignment_revision and t.assignment_version=a.assignment_revision and t.status<>'cancelled'
    and a.status not in ('interrupted','superseded');
  select jsonb_agg(jsonb_build_object('slotId',sl.id,'slotKey',sl.slot_key,'required',sl.required,'displayOrder',sl.display_order,
    'currentRevision',coalesce(cur.revision,0),
    'uploadStatus',case when cur.photo_version_id is null then case when cur.revision is null then 'missing' else 'cleared' end
      when purge.photo_version_id is not null then 'purged' when ph.purge_after<=at_time then 'expired' else ph.validation_status end,
    'photoId',case when may_read and acc.photo_version_id is not null and ph.validation_status='verified'
      and ph.purge_after>at_time and purge.photo_version_id is null then ph.id else null end)
    order by sl.display_order,sl.id) into slot_rows
  from private.target_photo_slot_snapshots sl
  left join private.attempt_photo_current cur on cur.cleaning_attempt_id=a.id and cur.target_photo_slot_id=sl.id
  left join private.attempt_photo_versions ph on ph.id=cur.photo_version_id
  left join private.attempt_photo_purge_states purge on purge.photo_version_id=ph.id
  left join private.photo_upload_acceptances acc on acc.photo_version_id=ph.id
  where sl.cleaning_target_id=a.cleaning_target_id;
  return jsonb_build_object('attemptId',a.id,'assignmentId',a.assignment_id,'assignmentRevision',a.assignment_revision,'slots',coalesce(slot_rows,'[]'::jsonb));
end; $$;

create function public.authorize_photo_read(p_actor_profile_id uuid,p_session_id uuid,p_photo_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; p private.attempt_photo_versions; a public.cleaning_attempts;
  ass public.cleaning_assignments; target public.cleaning_targets; obj private.photo_provider_objects; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into actor from public.profiles where id=p_actor_profile_id for no key update;
  if actor.id is null or actor.role not in ('admin','maid') or actor.status<>'active' or actor.must_change_password then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  perform 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id for share;
  if not found or not public.is_active_auth_session(actor.auth_user_id,p_session_id) then
    raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  select * into p from private.attempt_photo_versions where id=p_photo_id;
  select objrow.* into obj from private.photo_upload_acceptances acc join private.photo_provider_objects objrow on objrow.id=acc.object_id where acc.photo_version_id=p_photo_id;
  if p.id is null or obj.id is null or obj.provider_locator is null then raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  select * into a from public.cleaning_attempts where id=p.cleaning_attempt_id for share;
  select * into ass from public.cleaning_assignments where id=a.assignment_id;
  select * into target from public.cleaning_targets where id=a.cleaning_target_id;
  at_time:=clock_timestamp();
  if p.validation_status<>'verified' or p.purge_after is null or p.purge_after<=at_time
    or exists(select 1 from private.attempt_photo_purge_states where photo_version_id=p.id) then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  if actor.role='maid' and (a.maid_profile_id<>actor.id or ass.maid_profile_id<>actor.id or not ass.is_current
    or ass.ended_at is not null or ass.notified_at is null or ass.revision<>a.assignment_revision
    or target.assignment_version<>a.assignment_revision or target.status='cancelled'
    or a.status in ('superseded','interrupted')) then
    raise exception using errcode='42501',message='PHOTO_ACCESS_REQUIRED'; end if;
  return jsonb_build_object('photoId',p.id,'providerFileId',obj.provider_locator,'sha256',p.sha256,
    'mimeType',p.mime_type,'sizeBytes',p.size_bytes,'purgeAfter',p.purge_after);
end; $$;

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
      'edge.authorization.photos',
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
      'PHOTO_ACCESS_REQUIRED',
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
      'edge.authorization.photos',
      'edge.authorization.reservations',
      'edge.authorization.rooms'
    )
    or p_reason_code not in (
      'ACCOUNT_MANAGER_REQUIRED',
      'ADMIN_REQUIRED',
      'ASSIGNMENT_ACCESS_REQUIRED',
      'ATTEMPT_ACCESS_REQUIRED',
      'CAPABILITY_ACCESS_REQUIRED',
      'PHOTO_ACCESS_REQUIRED',
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
      and ((p_source='edge.authorization.attempts' and p_reason_code='CAPABILITY_ACCESS_REQUIRED')
        or (p_source='edge.authorization.photos' and p_reason_code in ('PHOTO_ACCESS_REQUIRED','CAPABILITY_ACCESS_REQUIRED')))));
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

-- Legacy #83 primitives remain owner-callable for narrow wrappers / rollback fixture contracts.
-- No service-role path may bypass the #84 pre-decode quota and reserved identity boundary.
do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)'::regprocedure,
    'public.get_photo_upload(uuid,uuid,uuid)'::regprocedure,'public.claim_photo_upload(uuid,uuid,uuid,text)'::regprocedure,
    'public.record_photo_provider_success(uuid,integer,text,text,timestamptz)'::regprocedure,
    'public.finalize_photo_upload(uuid,uuid,uuid,integer,text)'::regprocedure,'public.reconcile_photo_upload(uuid,text)'::regprocedure,
    'public.settle_photo_compensation(uuid,integer,text,text)'::regprocedure] loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',f);
  end loop;
  foreach f in array array[
    'public.refresh_photo_storage_quota(timestamptz,bigint)'::regprocedure,
    'public.admit_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text)'::regprocedure,
    'public.begin_admitted_photo_upload(uuid,uuid,uuid,text,text,integer,text,text)'::regprocedure,
    'public.get_admitted_photo_upload(uuid,uuid,uuid)'::regprocedure,
    'public.claim_admitted_photo_upload(uuid,uuid,uuid,text)'::regprocedure,
    'public.finalize_admitted_photo_upload(uuid,uuid,uuid,integer,text)'::regprocedure,
    'public.get_photo_provider_context(uuid,uuid,uuid,integer,text)'::regprocedure,
    'public.reserve_photo_drive_folder(uuid,uuid,uuid,integer,text,text,text,text)'::regprocedure,
    'public.reserve_photo_provider_identity(uuid,uuid,uuid,integer,text,text,text)'::regprocedure,
    'public.record_admitted_photo_provider_success(uuid,integer,text,text,timestamptz)'::regprocedure,
    'public.reconcile_admitted_photo_upload(uuid,text)'::regprocedure,
    'public.settle_admitted_photo_compensation(uuid,integer,text,text)'::regprocedure,
    'public.get_photo_reconciliation_context(uuid,integer,text)'::regprocedure,
    'public.get_attempt_photo_slots(uuid,uuid,uuid)'::regprocedure,
    'public.authorize_photo_read(uuid,uuid,uuid)'::regprocedure] loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end; $$;
