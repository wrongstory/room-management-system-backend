-- #85: server-only, bounded retention cleanup. No production schedule or provider HTTP.
-- Accepted retention and never-accepted compensation are separate authorities.
create table private.photo_purge_jobs (
  object_id uuid primary key references private.photo_provider_objects(id) on delete restrict,
  operation_id uuid not null unique references private.photo_upload_operations(id) on delete restrict,
  photo_version_id uuid not null unique references private.attempt_photo_versions(id) on delete restrict,
  purge_after timestamptz not null check(isfinite(purge_after)),
  status text not null default 'pending' check(status in ('pending','claimed','retry','blocked','purged')),
  lease_version integer not null default 0 check(lease_version between 0 and 8),
  claim_digest text check(claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null,
  last_reason_code text check(last_reason_code in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','RETRY_EXHAUSTED','REFERENCE_CONFLICT')),
  purged_at timestamptz,
  outcome text check(outcome in ('deleted','not_found')),
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default clock_timestamp(),
  check(
    (status='purged' and purged_at is not null and outcome is not null)
    or (status<>'purged' and purged_at is null and outcome is null)
  )
);
create index photo_purge_due_idx on private.photo_purge_jobs(next_attempt_at,object_id) where status in ('pending','retry','claimed');
create table private.photo_orphan_purge_jobs (
  operation_id uuid primary key references private.photo_upload_operations(id) on delete restrict,
  object_id uuid not null unique references private.photo_provider_objects(id) on delete restrict,
  status text not null default 'pending' check(status in ('pending','claimed','retry','blocked','purged')),
  lease_version integer not null default 0 check(lease_version between 0 and 8),
  claim_digest text check(claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_reason_code text check(last_reason_code in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','RETRY_EXHAUSTED','REFERENCE_CONFLICT')),
  purged_at timestamptz,
  outcome text check(outcome in ('deleted','not_found')),
  revision integer not null default 1 check(revision>0),
  created_at timestamptz not null default clock_timestamp(),
  check(
    (status='purged' and purged_at is not null and outcome is not null)
    or (status<>'purged' and purged_at is null and outcome is null)
  )
);
create index photo_orphan_purge_due_idx on private.photo_orphan_purge_jobs(next_attempt_at,operation_id) where status in ('pending','retry','claimed');
create table private.photo_folder_purge_jobs (
  folder_registry_id uuid primary key references private.photo_drive_folder_identities(id) on delete restrict,
  status text not null default 'retiring' check(status in ('retiring','claimed','retry','blocked','purged')),
  retired_at timestamptz not null default clock_timestamp(),
  lease_version integer not null default 0 check(lease_version between 0 and 8),
  claim_digest text check(claim_digest ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  next_attempt_at timestamptz not null default clock_timestamp(),
  delete_prepared_version integer,
  last_reason_code text check(last_reason_code in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','FOLDER_NOT_EMPTY','RETRY_EXHAUSTED')),
  purged_at timestamptz,
  outcome text check(outcome in ('deleted','not_found')),
  revision integer not null default 1 check(revision>0),
  check(
    (status='purged' and purged_at is not null and outcome is not null)
    or (status<>'purged' and purged_at is null and outcome is null)
  )
);
create index photo_folder_purge_due_idx on private.photo_folder_purge_jobs(next_attempt_at,folder_registry_id) where status in ('retiring','retry','claimed');
-- Persists the gap between folder reservation and file-identity insertion so a
-- midnight cleanup cannot retire a folder underneath an already fenced upload.
create table private.photo_drive_folder_bindings (
  operation_id uuid primary key references private.photo_upload_operations(id) on delete restrict,
  folder_registry_id uuid not null references private.photo_drive_folder_identities(id) on delete restrict,
  bound_at timestamptz not null default clock_timestamp()
);
create index photo_drive_folder_binding_registry_idx on private.photo_drive_folder_bindings(folder_registry_id,operation_id);
-- #84 identities predate this barrier. Bind every existing operation to the
-- exact persisted room folder before any retirement or replacement command can
-- observe the new contract. Missing/ambiguous registry rows fail the migration
-- instead of leaving an existing in-flight upload unusable.
insert into private.photo_drive_folder_bindings(operation_id,folder_registry_id)
select i.operation_id,f.id
from private.photo_drive_identities i
join private.photo_drive_folder_identities f
  on f.provider_folder_id=i.provider_folder_id
 and f.upload_date=i.upload_date
 and f.scope_room_number=i.room_number;
do $$
begin
  if exists (
    select 1
    from private.photo_drive_identities i
    left join private.photo_drive_folder_bindings b on b.operation_id=i.operation_id
    where b.operation_id is null
  ) then
    raise exception using errcode='23514',message='PHOTO_FOLDER_BINDING_BACKFILL_FAILED';
  end if;
end; $$;
create table private.photo_cleanup_events (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('accepted','orphan','folder')),
  object_id uuid references private.photo_purge_jobs(object_id) on delete restrict,
  operation_id uuid references private.photo_orphan_purge_jobs(operation_id) on delete restrict,
  folder_registry_id uuid references private.photo_folder_purge_jobs(folder_registry_id) on delete restrict,
  state text not null check(state in ('pending','retiring','claimed','retry','blocked','purged')),
  lease_version integer not null check(lease_version between 0 and 8),
  reason_code text check(reason_code in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','FOLDER_NOT_EMPTY','RETRY_EXHAUSTED','REFERENCE_CONFLICT')),
  occurred_at timestamptz not null default clock_timestamp(),
  check((kind='accepted' and object_id is not null and operation_id is null and folder_registry_id is null)
    or (kind='orphan' and object_id is null and operation_id is not null and folder_registry_id is null)
    or (kind='folder' and object_id is null and operation_id is null and folder_registry_id is not null))
);
create index photo_cleanup_object_events_idx on private.photo_cleanup_events(object_id,occurred_at);
create index photo_cleanup_operation_events_idx on private.photo_cleanup_events(operation_id,occurred_at);
create index photo_cleanup_folder_events_idx on private.photo_cleanup_events(folder_registry_id,occurred_at);
create table private.photo_quota_pending (
  admission_id uuid primary key references private.photo_upload_admissions(id) on delete restrict,
  operation_id uuid unique references private.photo_upload_operations(id) on delete restrict,
  reserved_bytes integer not null check(reserved_bytes=307200),
  expires_at timestamptz not null,
  uploaded_at timestamptz,
  provider_observed_at timestamptz
);
create index photo_quota_pending_expiry_idx on private.photo_quota_pending(expires_at) where operation_id is null;
create index photo_quota_pending_observed_idx on private.photo_quota_pending(provider_observed_at,uploaded_at) where provider_observed_at is not null;
create table private.photo_purge_heartbeat (
  singleton boolean primary key default true check(singleton),
  status text not null check(status in ('succeeded','degraded','failed')),
  claimed integer not null check(claimed between 0 and 10),
  purged integer not null check(purged between 0 and 10),
  retrying integer not null check(retrying between 0 and 10),
  blocked integer not null check(blocked between 0 and 10),
  accepted_claimed integer not null default 0 check(accepted_claimed between 0 and 10),
  orphan_claimed integer not null default 0 check(orphan_claimed between 0 and 10),
  folder_claimed integer not null default 0 check(folder_claimed between 0 and 10),
  error_code text check(error_code in ('PHOTO_PURGE_FAILED','PHOTO_PURGE_NOT_CONFIGURED')),
  recorded_at timestamptz not null default clock_timestamp()
);
do $$ declare t text; begin
  foreach t in array array['photo_purge_jobs','photo_orphan_purge_jobs','photo_folder_purge_jobs','photo_drive_folder_bindings','photo_cleanup_events','photo_quota_pending','photo_purge_heartbeat'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',t);
  end loop;
end; $$;

-- Never-accepted provider objects have their own compensation ledger and can
-- never be mistaken for accepted seven-day retention work.
create function private.enqueue_photo_orphan_purge() returns trigger language plpgsql set search_path='' as $$
declare object_row private.photo_provider_objects;
begin
  if new.status='compensation_pending' and old.status is distinct from new.status then
    select * into object_row from private.photo_provider_objects where operation_id=new.operation_id;
    if object_row.provider_locator is null or exists(select 1 from private.photo_upload_acceptances where operation_id=new.operation_id) then
      raise exception using errcode='23514',message='PHOTO_ORPHAN_REFERENCE_CONFLICT';
    end if;
    insert into private.photo_orphan_purge_jobs(operation_id,object_id,next_attempt_at)
      values(new.operation_id,object_row.id,clock_timestamp()) on conflict(operation_id) do nothing;
  end if;
  return new;
end; $$;
create trigger photo_orphan_purge_queue after update of status on private.photo_upload_states
for each row execute function private.enqueue_photo_orphan_purge();
insert into private.photo_orphan_purge_jobs(operation_id,object_id,next_attempt_at)
select s.operation_id,o.id,clock_timestamp() from private.photo_upload_states s
join private.photo_provider_objects o on o.operation_id=s.operation_id
where s.status='compensation_pending' and o.provider_locator is not null
  and not exists(select 1 from private.photo_upload_acceptances a where a.operation_id=s.operation_id)
on conflict(operation_id) do nothing;

create function private.photo_orphan_purge_projection(p_operation uuid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('operationId',operation_id,'objectId',object_id,'status',status,'leaseVersion',lease_version,
  'leaseExpiresAt',lease_expires_at,'purgedAt',purged_at,'nextAttemptAt',next_attempt_at,'reasonCode',last_reason_code)
from private.photo_orphan_purge_jobs where operation_id=p_operation $$;

create function public.claim_due_photo_orphan_purges(p_claim_digest text,p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_orphan_purge_jobs; at_time timestamptz; items jsonb:='[]'::jsonb; blocked integer:=0;
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='23514',message='PHOTO_PURGE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  at_time:=clock_timestamp();
  for j in select * from private.photo_orphan_purge_jobs where status in ('pending','retry','claimed')
    and next_attempt_at<=at_time and (lease_expires_at is null or lease_expires_at<=at_time or claim_digest=p_claim_digest)
    order by next_attempt_at,operation_id for update skip locked limit p_limit loop
    at_time:=clock_timestamp();
    if j.lease_expires_at>at_time and j.claim_digest=p_claim_digest then items:=items||jsonb_build_array(private.photo_orphan_purge_projection(j.operation_id)); continue; end if;
    if j.lease_version>=8 then
      update private.photo_orphan_purge_jobs set status='blocked',last_reason_code='RETRY_EXHAUSTED',revision=revision+1 where operation_id=j.operation_id;
      blocked:=blocked+1; continue; end if;
    update private.photo_orphan_purge_jobs set status='claimed',lease_version=lease_version+1,claim_digest=p_claim_digest,
      lease_expires_at=at_time+interval '5 minutes',last_reason_code=null,revision=revision+1 where operation_id=j.operation_id;
    items:=items||jsonb_build_array(private.photo_orphan_purge_projection(j.operation_id));
  end loop;
  return jsonb_build_object('items',items,'blocked',blocked);
end; $$;

create function public.get_photo_orphan_purge_context(p_operation_id uuid,p_lease_version integer,p_claim_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_orphan_purge_jobs; obj private.photo_provider_objects; st private.photo_upload_states; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into j from private.photo_orphan_purge_jobs where operation_id=p_operation_id for update;
  select * into obj from private.photo_provider_objects where operation_id=p_operation_id for update;
  select * into st from private.photo_upload_states where operation_id=p_operation_id for update;
  at_time:=clock_timestamp();
  if j.operation_id is null or j.status<>'claimed' or j.lease_version is distinct from p_lease_version or j.claim_digest is distinct from p_claim_digest
    or j.lease_expires_at<=at_time then raise exception using errcode='40001',message='PHOTO_PURGE_FENCE_CONFLICT'; end if;
  if exists(select 1 from private.photo_upload_acceptances where operation_id=p_operation_id) or st.status<>'compensation_pending'
    or obj.id is distinct from j.object_id or obj.provider_locator is null then
    raise exception using errcode='23514',message='PHOTO_ORPHAN_REFERENCE_CONFLICT'; end if;
  return private.photo_orphan_purge_projection(p_operation_id)||jsonb_build_object('providerFileId',obj.provider_locator);
end; $$;

create function public.settle_photo_orphan_purge(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text,p_reason_code text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_orphan_purge_jobs; at_time timestamptz; delay_seconds integer; folder_registry uuid;
begin
  if p_outcome is null or p_outcome not in ('deleted','not_found','retryable') or
    (p_outcome='retryable' and (p_reason_code is null or p_reason_code not in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR'))) or
    (p_outcome<>'retryable' and p_reason_code is not null) then raise exception using errcode='23514',message='PHOTO_PURGE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into j from private.photo_orphan_purge_jobs where operation_id=p_operation_id for update;
  if j.status='purged' and j.lease_version=p_lease_version and j.claim_digest=p_claim_digest and p_outcome in ('deleted','not_found') then
    return private.photo_orphan_purge_projection(p_operation_id); end if;
  perform public.get_photo_orphan_purge_context(p_operation_id,p_lease_version,p_claim_digest);
  at_time:=clock_timestamp();
  if p_outcome='retryable' then
    delay_seconds:=least(3600,30*(2^(j.lease_version-1))::integer)+(get_byte(extensions.digest(convert_to(j.object_id::text||j.lease_version::text,'UTF8'),'sha256'),0)%16);
    update private.photo_orphan_purge_jobs set status=case when lease_version>=8 then 'blocked' else 'retry' end,
      next_attempt_at=at_time+make_interval(secs=>delay_seconds),last_reason_code=case when lease_version>=8 then 'RETRY_EXHAUSTED' else p_reason_code end,
      lease_expires_at=at_time,revision=revision+1 where operation_id=p_operation_id;
  else
    select f.id into folder_registry from private.photo_drive_identities i join private.photo_drive_folder_identities f
      on f.provider_folder_id=i.provider_folder_id where i.operation_id=p_operation_id;
    update private.photo_upload_states set status='compensated',revision=revision+1 where operation_id=p_operation_id;
    update private.photo_orphan_purge_jobs set status='purged',purged_at=at_time,outcome=p_outcome,last_reason_code=null,revision=revision+1 where operation_id=p_operation_id;
    update private.photo_provider_objects set provider_locator=null where operation_id=p_operation_id;
    update private.photo_drive_identities set provider_file_id=null,provider_folder_id=null where operation_id=p_operation_id;
    if folder_registry is not null then perform private.maybe_retire_photo_folder(folder_registry,at_time); end if;
  end if;
  return private.photo_orphan_purge_projection(p_operation_id);
end; $$;

-- A registry row is a permanent scope identity. Retirement is a durable barrier:
-- the same date/room can never be recreated after cleanup starts.
create function private.maybe_retire_photo_folder(p_folder_registry_id uuid,p_at timestamptz) returns boolean
language plpgsql set search_path='' as $$
declare folder private.photo_drive_folder_identities; eligible boolean:=false;
begin
  select * into folder from private.photo_drive_folder_identities where id=p_folder_registry_id for update;
  if folder.id is null or folder.provider_folder_id is null or folder.upload_date >= (p_at at time zone 'Asia/Seoul')::date then return false; end if;
  if folder.scope_room_number<>'' then
    eligible:=not exists(select 1 from private.photo_drive_identities i where i.provider_folder_id=folder.provider_folder_id)
      and not exists(select 1 from private.photo_drive_folder_bindings b join private.photo_upload_states s on s.operation_id=b.operation_id
        where b.folder_registry_id=folder.id and s.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending'));
  else
    eligible:=not exists(select 1 from private.photo_drive_folder_identities child
      left join private.photo_folder_purge_jobs job on job.folder_registry_id=child.id
      where child.parent_registry_id=folder.id and (job.status is distinct from 'purged' or child.provider_folder_id is not null));
  end if;
  if eligible then
    insert into private.photo_folder_purge_jobs(folder_registry_id,retired_at,next_attempt_at)
      values(folder.id,p_at,p_at) on conflict(folder_registry_id) do nothing;
  end if;
  return eligible;
end; $$;

create function private.photo_folder_purge_projection(p_folder uuid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('folderRegistryId',folder_registry_id,'status',status,'leaseVersion',lease_version,
  'leaseExpiresAt',lease_expires_at,'retiredAt',retired_at,'purgedAt',purged_at,'nextAttemptAt',next_attempt_at,'reasonCode',last_reason_code)
from private.photo_folder_purge_jobs where folder_registry_id=p_folder $$;

create function public.claim_due_photo_folder_purges(p_claim_digest text,p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_folder_purge_jobs; f private.photo_drive_folder_identities; at_time timestamptz; items jsonb:='[]'::jsonb; blocked integer:=0;
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='23514',message='PHOTO_PURGE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  at_time:=clock_timestamp();
  for f in select * from private.photo_drive_folder_identities where provider_folder_id is not null
    and upload_date < (at_time at time zone 'Asia/Seoul')::date order by (scope_room_number='')::integer,upload_date,scope_room_number limit 100 loop
    perform private.maybe_retire_photo_folder(f.id,at_time);
  end loop;
  for j in select * from private.photo_folder_purge_jobs where status in ('retiring','retry','claimed') and next_attempt_at<=at_time
    and (lease_expires_at is null or lease_expires_at<=at_time or claim_digest=p_claim_digest)
    order by next_attempt_at,folder_registry_id for update skip locked limit p_limit loop
    at_time:=clock_timestamp();
    if j.lease_expires_at>at_time and j.claim_digest=p_claim_digest then items:=items||jsonb_build_array(private.photo_folder_purge_projection(j.folder_registry_id)); continue; end if;
    if j.lease_version>=8 then
      update private.photo_folder_purge_jobs set status='blocked',last_reason_code='RETRY_EXHAUSTED',revision=revision+1 where folder_registry_id=j.folder_registry_id;
      blocked:=blocked+1; continue; end if;
    if not private.maybe_retire_photo_folder(j.folder_registry_id,at_time) then
      update private.photo_folder_purge_jobs set status='blocked',last_reason_code='FOLDER_NOT_EMPTY',revision=revision+1 where folder_registry_id=j.folder_registry_id;
      blocked:=blocked+1; continue; end if;
    update private.photo_folder_purge_jobs set status='claimed',lease_version=lease_version+1,claim_digest=p_claim_digest,
      lease_expires_at=at_time+interval '5 minutes',delete_prepared_version=lease_version+1,last_reason_code=null,revision=revision+1
      where folder_registry_id=j.folder_registry_id;
    items:=items||jsonb_build_array(private.photo_folder_purge_projection(j.folder_registry_id));
  end loop;
  return jsonb_build_object('items',items,'blocked',blocked);
end; $$;

create function public.get_photo_folder_purge_context(p_folder_registry_id uuid,p_lease_version integer,p_claim_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_folder_purge_jobs; f private.photo_drive_folder_identities; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into j from private.photo_folder_purge_jobs where folder_registry_id=p_folder_registry_id for update;
  select * into f from private.photo_drive_folder_identities where id=p_folder_registry_id for update;
  at_time:=clock_timestamp();
  if j.folder_registry_id is null or j.status<>'claimed' or j.lease_version is distinct from p_lease_version
    or j.delete_prepared_version is distinct from p_lease_version or j.claim_digest is distinct from p_claim_digest or j.lease_expires_at<=at_time then
    raise exception using errcode='40001',message='PHOTO_PURGE_FENCE_CONFLICT'; end if;
  if not private.maybe_retire_photo_folder(f.id,at_time) or f.provider_folder_id is null or f.parent_folder_id is null then
    raise exception using errcode='23514',message='PHOTO_FOLDER_NOT_EMPTY'; end if;
  return private.photo_folder_purge_projection(f.id)||jsonb_build_object('providerFolderId',f.provider_folder_id,
    'parentFolderId',f.parent_folder_id,'scope',case when f.scope_room_number='' then 'date' else 'room' end);
end; $$;

create function public.settle_photo_folder_purge(p_folder_registry_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text,p_reason_code text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_folder_purge_jobs; f private.photo_drive_folder_identities; at_time timestamptz; delay_seconds integer;
begin
  if p_outcome is null or p_outcome not in ('deleted','not_found','not_empty','retryable') or
    (p_outcome='retryable' and (p_reason_code is null or p_reason_code not in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR'))) or
    (p_outcome<>'retryable' and p_reason_code is not null) then raise exception using errcode='23514',message='PHOTO_PURGE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into j from private.photo_folder_purge_jobs where folder_registry_id=p_folder_registry_id for update;
  if j.status='purged' and j.lease_version=p_lease_version and j.claim_digest=p_claim_digest and p_outcome in ('deleted','not_found') then
    return private.photo_folder_purge_projection(p_folder_registry_id); end if;
  perform public.get_photo_folder_purge_context(p_folder_registry_id,p_lease_version,p_claim_digest);
  at_time:=clock_timestamp();
  if p_outcome in ('retryable','not_empty') then
    delay_seconds:=case when p_outcome='not_empty' then 3600 else least(3600,30*(2^(j.lease_version-1))::integer)+(get_byte(extensions.digest(convert_to(j.folder_registry_id::text||j.lease_version::text,'UTF8'),'sha256'),0)%16) end;
    update private.photo_folder_purge_jobs set status=case when lease_version>=8 then 'blocked' else 'retry' end,
      next_attempt_at=at_time+make_interval(secs=>delay_seconds),last_reason_code=case when lease_version>=8 then 'RETRY_EXHAUSTED'
        when p_outcome='not_empty' then 'FOLDER_NOT_EMPTY' else p_reason_code end,lease_expires_at=at_time,revision=revision+1
      where folder_registry_id=p_folder_registry_id;
  else
    select * into f from private.photo_drive_folder_identities where id=p_folder_registry_id;
    update private.photo_folder_purge_jobs set status='purged',purged_at=at_time,outcome=p_outcome,last_reason_code=null,revision=revision+1
      where folder_registry_id=p_folder_registry_id;
    update private.photo_drive_folder_identities set provider_folder_id=null,parent_folder_id=null where id=p_folder_registry_id;
    if f.parent_registry_id is not null then perform private.maybe_retire_photo_folder(f.parent_registry_id,at_time); end if;
  end if;
  return private.photo_folder_purge_projection(p_folder_registry_id);
end; $$;

create function public.record_photo_purge_heartbeat(p_status text,p_claimed integer,p_purged integer,p_retrying integer,p_blocked integer,
  p_accepted_claimed integer,p_orphan_claimed integer,p_folder_claimed integer,p_error_code text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  if p_status not in ('succeeded','degraded','failed') or p_claimed not between 0 and 10 or p_purged not between 0 and 10
    or p_retrying not between 0 and 10 or p_blocked not between 0 and 10 or p_accepted_claimed not between 0 and 10
    or p_orphan_claimed not between 0 and 10 or p_folder_claimed not between 0 and 10
    or p_accepted_claimed+p_orphan_claimed+p_folder_claimed<>p_claimed
    or (p_status='failed') is distinct from (p_error_code is not null) then
    raise exception using errcode='23514',message='PHOTO_PURGE_HEARTBEAT_INVALID'; end if;
  insert into private.photo_purge_heartbeat(singleton,status,claimed,purged,retrying,blocked,accepted_claimed,orphan_claimed,folder_claimed,error_code,recorded_at)
    values(true,p_status,p_claimed,p_purged,p_retrying,p_blocked,p_accepted_claimed,p_orphan_claimed,p_folder_claimed,p_error_code,clock_timestamp())
    on conflict(singleton) do update set status=excluded.status,claimed=excluded.claimed,purged=excluded.purged,retrying=excluded.retrying,
      blocked=excluded.blocked,accepted_claimed=excluded.accepted_claimed,orphan_claimed=excluded.orphan_claimed,
      folder_claimed=excluded.folder_claimed,error_code=excluded.error_code,recorded_at=excluded.recorded_at;
  return jsonb_build_object('status',p_status,'recordedAt',(select recorded_at from private.photo_purge_heartbeat where singleton));
end; $$;

create function public.get_developer_photo_purge_status(p_actor_profile_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare h private.photo_purge_heartbeat; blocked_count integer;
begin
  perform private.assert_active_developer(p_actor_profile_id);
  select * into h from private.photo_purge_heartbeat where singleton;
  select least(1000,count(*))::integer into blocked_count from (select 1 from private.photo_purge_jobs where status='blocked'
    union all select 1 from private.photo_orphan_purge_jobs where status='blocked'
    union all select 1 from private.photo_folder_purge_jobs where status='blocked' limit 1000) q;
  return jsonb_build_object('status',case when blocked_count>0 then 'degraded' when h.singleton is null then 'awaiting_first_run' when h.status='succeeded' then 'healthy' else h.status end,
    'lastHeartbeat',case when h.singleton is null then null else jsonb_build_object('status',h.status,'claimed',h.claimed,'purged',h.purged,
      'retrying',h.retrying,'blocked',h.blocked,'acceptedClaimed',h.accepted_claimed,'orphanClaimed',h.orphan_claimed,
      'folderClaimed',h.folder_claimed,'errorCode',h.error_code,'recordedAt',h.recorded_at) end,
    'backlog',jsonb_build_object(
      'acceptedDue',least(1000,(select count(*) from (select 1 from private.photo_purge_jobs where status in ('pending','retry','claimed') and purge_after<=clock_timestamp() limit 1000) q)),
      'orphanDue',least(1000,(select count(*) from (select 1 from private.photo_orphan_purge_jobs where status in ('pending','retry','claimed') and next_attempt_at<=clock_timestamp() limit 1000) q)),
      'folderDue',least(1000,(select count(*) from (select 1 from private.photo_folder_purge_jobs where status in ('retiring','retry','claimed') and next_attempt_at<=clock_timestamp() limit 1000) q)),
      'blocked',blocked_count),
    'checkedAt',clock_timestamp());
end; $$;

-- Preserve the existing upload contract while rejecting reuse of a retired scope.
create or replace function public.reserve_photo_drive_folder(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,
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
    if parent_id is null or exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=parent_row) then
      raise exception using errcode='23514',message='PHOTO_FOLDER_RETIRED'; end if;
  end if;
  select * into winner from private.photo_drive_folder_identities where upload_date=day and scope_room_number=room for update;
  if winner.id is not null and (winner.provider_folder_id is null or exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=winner.id)) then
    raise exception using errcode='23514',message='PHOTO_FOLDER_RETIRED'; end if;
  if exists(select 1 from private.photo_drive_folder_identities where provider_folder_id=p_candidate_folder_id
    and (upload_date<>day or scope_room_number<>room)) then raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  if winner.id is null then
    insert into private.photo_drive_folder_identities(upload_date,scope_room_number,provider_folder_id,parent_folder_id,parent_registry_id)
      values(day,room,p_candidate_folder_id,parent_id,parent_row) on conflict(upload_date,scope_room_number) do nothing;
    select * into winner from private.photo_drive_folder_identities where upload_date=day and scope_room_number=room for update;
  end if;
  if winner.provider_folder_id is null or winner.parent_folder_id is distinct from parent_id or winner.parent_registry_id is distinct from parent_row
    or exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=winner.id) then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  if p_scope='room' then
    insert into private.photo_drive_folder_bindings(operation_id,folder_registry_id) values(p_operation_id,winner.id)
      on conflict(operation_id) do nothing;
    if not exists(select 1 from private.photo_drive_folder_bindings where operation_id=p_operation_id and folder_registry_id=winner.id) then
      raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  end if;
  return jsonb_build_object('scope',p_scope,'folderId',winner.provider_folder_id,'parentFolderId',winner.parent_folder_id,
    'uploadDate',winner.upload_date,'roomNumber',nullif(winner.scope_room_number,''));
end; $$;

-- Active working-set projection, not a second ledger. Removing an accounted row
-- never removes immutable admission/provider/acceptance history.
insert into private.photo_quota_pending(admission_id,operation_id,reserved_bytes,expires_at,uploaded_at,provider_observed_at)
select ad.id,b.operation_id,ad.reserved_bytes,ad.expires_at,obj.uploaded_at,
  (select min(ev.occurred_at) from private.photo_upload_events ev where ev.operation_id=b.operation_id and ev.state in ('provider_succeeded','compensation_pending'))
from private.photo_upload_admissions ad left join private.photo_upload_admission_bindings b on b.admission_id=ad.id
left join private.photo_provider_objects obj on obj.operation_id=b.operation_id left join private.photo_upload_states st on st.operation_id=b.operation_id
where (b.operation_id is not null or ad.expires_at>clock_timestamp()) and coalesce(st.status,'reserved')<>'compensated';
delete from private.photo_quota_pending p using private.photo_storage_quota_snapshot q
where p.uploaded_at<q.request_started_at and p.provider_observed_at<q.request_started_at;
create function private.sync_photo_quota_pending() returns trigger language plpgsql set search_path='' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if tg_table_name='photo_upload_admissions' then
    delete from private.photo_quota_pending where admission_id in (select admission_id from private.photo_quota_pending
      where operation_id is null and expires_at<=clock_timestamp() order by expires_at limit 100);
    insert into private.photo_quota_pending(admission_id,reserved_bytes,expires_at) values(new.id,new.reserved_bytes,new.expires_at);
  elsif tg_table_name='photo_upload_admission_bindings' then
    update private.photo_quota_pending set operation_id=new.operation_id where admission_id=new.admission_id;
  elsif tg_table_name='photo_upload_events' then
    if new.state='compensated' then delete from private.photo_quota_pending where operation_id=new.operation_id;
    elsif new.state in ('provider_succeeded','compensation_pending') then
      update private.photo_quota_pending p set uploaded_at=o.uploaded_at,provider_observed_at=coalesce(p.provider_observed_at,new.occurred_at)
        from private.photo_provider_objects o where o.operation_id=new.operation_id and p.operation_id=o.operation_id;
      delete from private.photo_quota_pending p using private.photo_storage_quota_snapshot q
        where p.operation_id=new.operation_id and p.uploaded_at<q.request_started_at and p.provider_observed_at<q.request_started_at;
    end if;
  else
    delete from private.photo_quota_pending where operation_id is null and expires_at<=clock_timestamp();
    delete from private.photo_quota_pending where uploaded_at<new.request_started_at and provider_observed_at<new.request_started_at;
  end if;
  return new;
end; $$;
create trigger photo_admission_quota_projection after insert on private.photo_upload_admissions for each row execute function private.sync_photo_quota_pending();
create trigger photo_binding_quota_projection after insert on private.photo_upload_admission_bindings for each row execute function private.sync_photo_quota_pending();
create trigger photo_event_quota_projection after insert on private.photo_upload_events for each row execute function private.sync_photo_quota_pending();
create trigger photo_refresh_quota_projection after insert or update on private.photo_storage_quota_snapshot for each row execute function private.sync_photo_quota_pending();
create or replace function private.photo_quota_context(p_at timestamptz) returns jsonb language plpgsql stable set search_path='' as $$
declare q private.photo_storage_quota_snapshot; pending bigint;
begin
  select * into q from private.photo_storage_quota_snapshot where provider='google_drive';
  if q.provider is null or q.request_started_at>p_at or q.request_started_at<=p_at-interval '60 seconds' then
    raise exception using errcode='55000',message='PHOTO_STORAGE_QUOTA_UNAVAILABLE'; end if;
  select coalesce(sum(reserved_bytes),0)::bigint into pending from private.photo_quota_pending where operation_id is not null or expires_at>p_at;
  return jsonb_build_object('revision',q.revision,'usageBytes',q.usage_bytes,'pendingBytes',pending,'effectiveBytes',q.usage_bytes+pending,
    'warning',q.usage_bytes+pending>=10000000000);
end; $$;
create trigger photo_cleanup_events_immutable before update or delete on private.photo_cleanup_events
for each row execute function private.guard_photo_drive_immutable();

create table private.photo_provider_identity_tombstones (
  locator_digest text primary key check(locator_digest ~ '^[0-9a-f]{64}$'),
  object_id uuid references private.photo_provider_objects(id) on delete restrict,
  folder_registry_id uuid references private.photo_drive_folder_identities(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  check((object_id is not null)::integer+(folder_registry_id is not null)::integer=1)
);
create index photo_identity_tombstone_object_idx on private.photo_provider_identity_tombstones(object_id);
create index photo_identity_tombstone_folder_idx on private.photo_provider_identity_tombstones(folder_registry_id);
alter table private.photo_provider_identity_tombstones enable row level security;
revoke all on private.photo_provider_identity_tombstones from public,anon,authenticated,service_role;
create trigger photo_identity_tombstones_immutable before update or delete on private.photo_provider_identity_tombstones
for each row execute function private.guard_photo_drive_immutable();
insert into private.photo_provider_identity_tombstones(locator_digest,object_id,folder_registry_id)
select distinct encode(extensions.digest(convert_to(locator,'UTF8'),'sha256'),'hex'),object_id,folder_id from (
  select provider_locator locator,id object_id,null::uuid folder_id from private.photo_provider_objects where provider_locator is not null
  union select provider_file_id,object_id,null::uuid from private.photo_drive_identities
  union select provider_folder_id,null::uuid,id from private.photo_drive_folder_identities) identities;

-- Only raw locators become nullable: immutable upload/purge clocks remain intact.
alter table private.photo_provider_objects drop constraint photo_provider_objects_check;
alter table private.photo_provider_objects add constraint photo_provider_retention_clock_check check(
  (provider_locator is null and uploaded_at is null and purge_after is null) or
  (uploaded_at is not null and isfinite(uploaded_at) and purge_after=uploaded_at+interval '168 hours'));
alter table private.photo_drive_identities alter column provider_file_id drop not null;
alter table private.photo_drive_identities alter column provider_folder_id drop not null;
alter table private.photo_drive_folder_identities alter column provider_folder_id drop not null;
alter table private.photo_drive_folder_identities alter column parent_folder_id drop not null;

create or replace function private.guard_photo_storage_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='photo_provider_objects' and tg_op='UPDATE' then
    if old.provider_locator is null and old.uploaded_at is null and new.provider_locator is not null
      and new.id=old.id and new.operation_id=old.operation_id and new.provider=old.provider then return new; end if;
    if old.provider_locator is not null and new.provider_locator is null
      and (to_jsonb(new)-'provider_locator')=(to_jsonb(old)-'provider_locator')
      and (exists(select 1 from private.photo_purge_jobs where object_id=old.id and status='purged')
        or exists(select 1 from private.photo_upload_states where operation_id=old.operation_id and status='compensated')) then return new; end if;
  end if;
  raise exception using errcode='55000',message='PHOTO_STORAGE_IMMUTABLE';
end; $$;
create or replace function private.guard_photo_drive_immutable() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='UPDATE' then
    if tg_table_name='photo_drive_identities' then
      if new.provider_file_id is null and new.provider_folder_id is null
        and (to_jsonb(new)-array['provider_file_id','provider_folder_id'])=(to_jsonb(old)-array['provider_file_id','provider_folder_id'])
        and (exists(select 1 from private.photo_purge_jobs where object_id=old.object_id and status='purged')
          or exists(select 1 from private.photo_upload_states where operation_id=old.operation_id and status='compensated')) then return new; end if;
    elsif tg_table_name='photo_drive_folder_identities' then
      if new.provider_folder_id is null and new.parent_folder_id is null
        and (to_jsonb(new)-array['provider_folder_id','parent_folder_id'])=(to_jsonb(old)-array['provider_folder_id','parent_folder_id'])
        and exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=old.id and status='purged') then return new; end if;
    end if;
  end if;
  raise exception using errcode='55000',message='PHOTO_STORAGE_IMMUTABLE';
end; $$;
create function private.capture_photo_identity_tombstone() returns trigger language plpgsql set search_path='' as $$
declare locator text; oid uuid; fid uuid; dig text; existing private.photo_provider_identity_tombstones;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if tg_table_name='photo_provider_objects' then locator:=new.provider_locator; oid:=new.id;
  elsif tg_table_name='photo_drive_identities' then locator:=new.provider_file_id; oid:=new.object_id;
  else locator:=new.provider_folder_id; fid:=new.id; end if;
  if locator is null then return new; end if;
  dig:=encode(extensions.digest(convert_to(locator,'UTF8'),'sha256'),'hex');
  insert into private.photo_provider_identity_tombstones(locator_digest,object_id,folder_registry_id) values(dig,oid,fid) on conflict do nothing;
  select * into existing from private.photo_provider_identity_tombstones where locator_digest=dig;
  if existing.object_id is distinct from oid or existing.folder_registry_id is distinct from fid then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  return new;
end; $$;
-- AFTER permits immediate FK validation of the new object/registry itself.
create trigger photo_object_tombstone after insert or update of provider_locator on private.photo_provider_objects
for each row execute function private.capture_photo_identity_tombstone();
create trigger photo_file_tombstone after insert on private.photo_drive_identities
for each row execute function private.capture_photo_identity_tombstone();
create trigger photo_folder_tombstone after insert on private.photo_drive_folder_identities
for each row execute function private.capture_photo_identity_tombstone();

create function private.guard_photo_cleanup_job() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then raise exception using errcode='55000',message='PHOTO_STORAGE_IMMUTABLE'; end if;
  if tg_op='UPDATE' and (old.status='purged' or new.revision<>old.revision+1 or new.lease_version<old.lease_version
    or new.lease_version>old.lease_version+1 or (to_jsonb(new)-array['status','lease_version','claim_digest','lease_expires_at','next_attempt_at','last_reason_code','purged_at','outcome','revision','delete_prepared_version'])
      is distinct from (to_jsonb(old)-array['status','lease_version','claim_digest','lease_expires_at','next_attempt_at','last_reason_code','purged_at','outcome','revision','delete_prepared_version'])) then
    raise exception using errcode='55000',message='PHOTO_PURGE_TERMINAL'; end if;
  if tg_table_name='photo_purge_jobs' then
    if not exists(select 1 from private.photo_upload_acceptances a join private.attempt_photo_versions p on p.id=a.photo_version_id
      join private.photo_provider_objects o on o.id=a.object_id where a.object_id=new.object_id and a.operation_id=new.operation_id
      and a.photo_version_id=new.photo_version_id and p.purge_after=new.purge_after and o.purge_after=p.purge_after) then
      raise exception using errcode='23514',message='PHOTO_PURGE_REFERENCE_CONFLICT'; end if;
    if new.status in ('claimed','purged') and new.purge_after>clock_timestamp() then
      raise exception using errcode='55000',message='PHOTO_PURGE_NOT_DUE'; end if;
  elsif tg_table_name='photo_orphan_purge_jobs' then
    if exists(select 1 from private.photo_upload_acceptances where operation_id=new.operation_id)
      or not exists(select 1 from private.photo_provider_objects o join private.photo_upload_states s on s.operation_id=o.operation_id
        where o.id=new.object_id and o.operation_id=new.operation_id and s.status in ('compensation_pending','compensated')) then
      raise exception using errcode='23514',message='PHOTO_ORPHAN_REFERENCE_CONFLICT'; end if;
  end if;
  return new;
end; $$;
create trigger photo_purge_job_guard before insert or update or delete on private.photo_purge_jobs for each row execute function private.guard_photo_cleanup_job();
create trigger photo_orphan_purge_job_guard before insert or update or delete on private.photo_orphan_purge_jobs for each row execute function private.guard_photo_cleanup_job();
create trigger photo_folder_purge_job_guard before insert or update or delete on private.photo_folder_purge_jobs for each row execute function private.guard_photo_cleanup_job();
create function private.append_photo_cleanup_event() returns trigger language plpgsql set search_path='' as $$
begin
  if tg_table_name='photo_purge_jobs' then
    insert into private.photo_cleanup_events(kind,object_id,state,lease_version,reason_code) values('accepted',new.object_id,new.status,new.lease_version,new.last_reason_code);
  elsif tg_table_name='photo_orphan_purge_jobs' then
    insert into private.photo_cleanup_events(kind,operation_id,state,lease_version,reason_code) values('orphan',new.operation_id,new.status,new.lease_version,new.last_reason_code);
  else
    insert into private.photo_cleanup_events(kind,folder_registry_id,state,lease_version,reason_code) values('folder',new.folder_registry_id,new.status,new.lease_version,new.last_reason_code);
  end if;
  return new;
end; $$;
create trigger photo_purge_job_event after insert or update on private.photo_purge_jobs for each row execute function private.append_photo_cleanup_event();
create trigger photo_orphan_purge_job_event after insert or update on private.photo_orphan_purge_jobs for each row execute function private.append_photo_cleanup_event();
create trigger photo_folder_purge_job_event after insert or update on private.photo_folder_purge_jobs for each row execute function private.append_photo_cleanup_event();
create function private.enqueue_accepted_photo_purge() returns trigger language plpgsql set search_path='' as $$
begin
  insert into private.photo_purge_jobs(object_id,operation_id,photo_version_id,purge_after,next_attempt_at)
    select new.object_id,new.operation_id,new.photo_version_id,purge_after,purge_after from private.attempt_photo_versions where id=new.photo_version_id;
  return new;
end; $$;
create trigger photo_acceptance_purge_queue after insert on private.photo_upload_acceptances for each row execute function private.enqueue_accepted_photo_purge();
insert into private.photo_purge_jobs(object_id,operation_id,photo_version_id,purge_after,next_attempt_at)
select a.object_id,a.operation_id,a.photo_version_id,p.purge_after,p.purge_after from private.photo_upload_acceptances a join private.attempt_photo_versions p on p.id=a.photo_version_id;

create function private.photo_purge_projection(p_object uuid) returns jsonb language sql stable set search_path='' as $$
select jsonb_build_object('objectId',object_id,'operationId',operation_id,'photoId',photo_version_id,'status',status,'leaseVersion',lease_version,
  'leaseExpiresAt',lease_expires_at,'purgeAfter',purge_after,'purgedAt',purged_at,'nextAttemptAt',next_attempt_at,'reasonCode',last_reason_code)
from private.photo_purge_jobs where object_id=p_object $$;
create function public.claim_due_photo_purges(p_claim_digest text,p_limit integer default 10) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_purge_jobs; at_time timestamptz; items jsonb:='[]'::jsonb; blocked integer:=0;
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode='23514',message='PHOTO_PURGE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  at_time:=clock_timestamp();
  for j in select * from private.photo_purge_jobs where purge_after<=at_time and status in ('pending','retry','claimed')
    and next_attempt_at<=at_time and (lease_expires_at is null or lease_expires_at<=at_time or claim_digest=p_claim_digest)
    order by next_attempt_at,object_id for update skip locked limit p_limit loop
    at_time:=clock_timestamp();
    if j.lease_expires_at>at_time and j.claim_digest=p_claim_digest then items:=items||jsonb_build_array(private.photo_purge_projection(j.object_id)); continue; end if;
    if j.lease_version>=8 then
      update private.photo_purge_jobs set status='blocked',last_reason_code='RETRY_EXHAUSTED',revision=revision+1 where object_id=j.object_id;
      blocked:=blocked+1; continue; end if;
    update private.photo_purge_jobs set status='claimed',lease_version=lease_version+1,claim_digest=p_claim_digest,lease_expires_at=at_time+interval '5 minutes',
      last_reason_code=null,revision=revision+1 where object_id=j.object_id;
    items:=items||jsonb_build_array(private.photo_purge_projection(j.object_id));
  end loop;
  return jsonb_build_object('items',items,'blocked',blocked);
end; $$;
create function public.get_photo_purge_context(p_object_id uuid,p_lease_version integer,p_claim_digest text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_purge_jobs; obj private.photo_provider_objects; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into j from private.photo_purge_jobs where object_id=p_object_id for update;
  select * into obj from private.photo_provider_objects where id=p_object_id for update;
  at_time:=clock_timestamp();
  if j.object_id is null or j.status<>'claimed' or j.lease_version is distinct from p_lease_version or j.claim_digest is distinct from p_claim_digest
    or j.lease_expires_at<=at_time then raise exception using errcode='40001',message='PHOTO_PURGE_FENCE_CONFLICT'; end if;
  if j.purge_after>at_time then raise exception using errcode='55000',message='PHOTO_PURGE_NOT_DUE'; end if;
  if obj.provider_locator is null or not exists(select 1 from private.photo_upload_acceptances a join private.attempt_photo_versions p on p.id=a.photo_version_id
    where a.object_id=j.object_id and a.photo_version_id=j.photo_version_id and a.operation_id=j.operation_id
      and p.purge_after=j.purge_after and p.uploaded_at=obj.uploaded_at and obj.purge_after=j.purge_after) then
    raise exception using errcode='23514',message='PHOTO_PURGE_REFERENCE_CONFLICT'; end if;
  return private.photo_purge_projection(p_object_id)||jsonb_build_object('providerFileId',obj.provider_locator);
end; $$;
create function public.settle_photo_purge(p_object_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text,p_reason_code text default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare j private.photo_purge_jobs; at_time timestamptz; delay_seconds integer; folder_registry uuid;
begin
  if p_outcome is null or p_outcome not in ('deleted','not_found','retryable') or
    (p_outcome='retryable' and (p_reason_code is null or p_reason_code not in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR'))) or
    (p_outcome<>'retryable' and p_reason_code is not null) then raise exception using errcode='23514',message='PHOTO_PURGE_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into j from private.photo_purge_jobs where object_id=p_object_id for update;
  if j.status='purged' and j.lease_version=p_lease_version and j.claim_digest=p_claim_digest and p_outcome in ('deleted','not_found') then
    return private.photo_purge_projection(p_object_id); end if;
  perform public.get_photo_purge_context(p_object_id,p_lease_version,p_claim_digest);
  at_time:=clock_timestamp();
  if p_outcome='retryable' then
    delay_seconds:=least(3600,30*(2^(j.lease_version-1))::integer)+(get_byte(extensions.digest(convert_to(j.object_id::text||j.lease_version::text,'UTF8'),'sha256'),0)%16);
    update private.photo_purge_jobs set status=case when lease_version>=8 then 'blocked' else 'retry' end,
      next_attempt_at=at_time+make_interval(secs=>delay_seconds),last_reason_code=case when lease_version>=8 then 'RETRY_EXHAUSTED' else p_reason_code end,
      lease_expires_at=at_time,revision=revision+1 where object_id=p_object_id;
  else
    select f.id into folder_registry from private.photo_drive_identities i join private.photo_drive_folder_identities f
      on f.provider_folder_id=i.provider_folder_id where i.object_id=p_object_id;
    update private.photo_purge_jobs set status='purged',purged_at=at_time,outcome=p_outcome,last_reason_code=null,revision=revision+1 where object_id=p_object_id;
    insert into private.attempt_photo_purge_states(photo_version_id,purged_at) values(j.photo_version_id,at_time) on conflict do nothing;
    update private.photo_provider_objects set provider_locator=null where id=p_object_id;
    update private.photo_drive_identities set provider_file_id=null,provider_folder_id=null where object_id=p_object_id;
    if folder_registry is not null then perform private.maybe_retire_photo_folder(folder_registry,at_time); end if;
  end if;
  return private.photo_purge_projection(p_object_id);
end; $$;

create or replace function public.reserve_photo_provider_identity(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,
  p_lease_version integer,p_claim_digest text,p_provider_file_id text,p_provider_folder_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare ctx jsonb; ident private.photo_drive_identities; folder private.photo_drive_folder_identities;
begin
  if p_provider_file_id is null or p_provider_file_id !~ '^[A-Za-z0-9_-]{10,200}$'
    or p_provider_folder_id is null or p_provider_folder_id !~ '^[A-Za-z0-9_-]{10,200}$' then
    raise exception using errcode='23514',message='PHOTO_PROVIDER_RESULT_INVALID'; end if;
  ctx:=public.get_photo_provider_context(p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
  select * into folder from private.photo_drive_folder_identities where provider_folder_id=p_provider_folder_id
    and upload_date=(ctx->>'uploadDate')::date and scope_room_number=ctx->>'roomNumber' for update;
  if folder.id is null then raise exception using errcode='23514',message='PHOTO_FOLDER_PARENT_REQUIRED'; end if;
  if exists(select 1 from private.photo_folder_purge_jobs where folder_registry_id=folder.id)
    or not exists(select 1 from private.photo_drive_folder_bindings where operation_id=p_operation_id and folder_registry_id=folder.id) then
    raise exception using errcode='23514',message='PHOTO_FOLDER_RETIRED'; end if;
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

create or replace function public.record_admitted_photo_provider_success(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_provider_locator text,p_uploaded_at timestamptz)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  if not exists(select 1 from private.photo_drive_identities where operation_id=p_operation_id and provider_file_id=p_provider_locator) then
    raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if;
  if not exists(select 1 from private.photo_drive_identities i join private.photo_drive_folder_identities f on f.provider_folder_id=i.provider_folder_id
    join private.photo_drive_folder_bindings b on b.operation_id=i.operation_id and b.folder_registry_id=f.id
    where i.operation_id=p_operation_id and i.provider_file_id=p_provider_locator and f.provider_folder_id is not null
      and not exists(select 1 from private.photo_folder_purge_jobs j where j.folder_registry_id=f.id)) then
    raise exception using errcode='23505',message='PHOTO_FOLDER_RETIRED'; end if;
  return public.record_photo_provider_success(p_operation_id,p_lease_version,p_claim_digest,p_provider_locator,p_uploaded_at);
end; $$;

create or replace function public.finalize_admitted_photo_upload(p_actor_profile_id uuid,p_session_id uuid,p_operation_id uuid,p_lease_version integer,p_claim_digest text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare uploaded timestamptz; folder_date date;
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  perform public.get_photo_upload(p_actor_profile_id,p_session_id,p_operation_id);
  select obj.uploaded_at,ident.upload_date into uploaded,folder_date
    from private.photo_provider_objects obj left join private.photo_drive_identities ident on ident.object_id=obj.id
    join private.photo_drive_folder_identities f on f.provider_folder_id=ident.provider_folder_id
    join private.photo_drive_folder_bindings b on b.operation_id=p_operation_id and b.folder_registry_id=f.id
    where obj.operation_id=p_operation_id and f.provider_folder_id is not null
      and not exists(select 1 from private.photo_folder_purge_jobs j where j.folder_registry_id=f.id) for update of obj;
  if folder_date is null then raise exception using errcode='23514',message='PHOTO_FOLDER_RETIRED'; end if;
  if uploaded is not null and folder_date is distinct from (uploaded at time zone 'Asia/Seoul')::date then
    raise exception using errcode='55000',message='PHOTO_PROVIDER_DATE_MISMATCH'; end if;
  return public.finalize_photo_upload(p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
end; $$;

-- Preserve the synchronous #84 compensation callback, but converge it into
-- the same durable orphan ledger and locator-redaction contract as the worker.
create or replace function public.settle_admitted_photo_compensation(p_operation_id uuid,p_lease_version integer,p_claim_digest text,p_outcome text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare folder_registry uuid; result jsonb; at_time timestamptz;
begin
  perform private.assert_admitted_photo_operation(p_operation_id);
  perform 1 from private.photo_provider_objects where operation_id=p_operation_id for update;
  select f.id into folder_registry from private.photo_drive_identities i join private.photo_drive_folder_identities f
    on f.provider_folder_id=i.provider_folder_id where i.operation_id=p_operation_id;
  result:=public.settle_photo_compensation(p_operation_id,p_lease_version,p_claim_digest,p_outcome);
  at_time:=clock_timestamp();
  update private.photo_orphan_purge_jobs set status='purged',purged_at=at_time,outcome=p_outcome,last_reason_code=null,revision=revision+1
    where operation_id=p_operation_id and status<>'purged';
  update private.photo_provider_objects set provider_locator=null where operation_id=p_operation_id and provider_locator is not null;
  update private.photo_drive_identities set provider_file_id=null,provider_folder_id=null where operation_id=p_operation_id and provider_file_id is not null;
  if folder_registry is not null then perform private.maybe_retire_photo_folder(folder_registry,at_time); end if;
  return result;
end; $$;

create trigger photo_drive_folder_binding_immutable before update or delete on private.photo_drive_folder_bindings
for each row execute function private.guard_photo_drive_immutable();

do $$ declare f regprocedure; begin
  foreach f in array array[
    'public.claim_due_photo_purges(text,integer)'::regprocedure,
    'public.get_photo_purge_context(uuid,integer,text)'::regprocedure,
    'public.settle_photo_purge(uuid,integer,text,text,text)'::regprocedure,
    'public.claim_due_photo_orphan_purges(text,integer)'::regprocedure,
    'public.get_photo_orphan_purge_context(uuid,integer,text)'::regprocedure,
    'public.settle_photo_orphan_purge(uuid,integer,text,text,text)'::regprocedure,
    'public.claim_due_photo_folder_purges(text,integer)'::regprocedure,
    'public.get_photo_folder_purge_context(uuid,integer,text)'::regprocedure,
    'public.settle_photo_folder_purge(uuid,integer,text,text,text)'::regprocedure,
    'public.record_photo_purge_heartbeat(text,integer,integer,integer,integer,integer,integer,integer,text)'::regprocedure,
    'public.get_developer_photo_purge_status(uuid)'::regprocedure] loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to service_role',f);
  end loop;
end; $$;
revoke all on function private.enqueue_photo_orphan_purge() from public,anon,authenticated,service_role;
revoke all on function private.maybe_retire_photo_folder(uuid,timestamptz) from public,anon,authenticated,service_role;
revoke all on function private.photo_orphan_purge_projection(uuid) from public,anon,authenticated,service_role;
revoke all on function private.photo_folder_purge_projection(uuid) from public,anon,authenticated,service_role;
revoke all on function private.photo_purge_projection(uuid) from public,anon,authenticated,service_role;
revoke all on function private.guard_photo_cleanup_job() from public,anon,authenticated,service_role;
revoke all on function private.append_photo_cleanup_event() from public,anon,authenticated,service_role;
revoke all on function private.enqueue_accepted_photo_purge() from public,anon,authenticated,service_role;
revoke all on function private.capture_photo_identity_tombstone() from public,anon,authenticated,service_role;
revoke all on function private.sync_photo_quota_pending() from public,anon,authenticated,service_role;
