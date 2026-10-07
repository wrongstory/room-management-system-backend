-- #383: freeze human-readable names only with newly reserved v9 Drive identities.
-- Existing identities and historical slot keys stay unnamed/UUID-compatible.
-- No backfill, provider rename, external request, retention or permission change.
create sequence private.photo_storage_name_number as bigint minvalue 1 no cycle cache 1;
revoke all on sequence private.photo_storage_name_number from public, anon, authenticated, service_role;

create function private.photo_storage_file_name(
  p_upload_date date, p_slot_key text, p_room_number text,
  p_naming_number bigint, p_mime_type text
) returns text language plpgsql immutable set search_path = '' as $$
declare category text; number_text text;
begin
  if p_upload_date is null or not isfinite(p_upload_date) or extract(year from p_upload_date) not between 1 and 9999
    or p_room_number is null or p_room_number !~ '^[0-9]{3}$'
    or p_naming_number is null or p_naming_number < 1
    or p_mime_type is null or p_mime_type not in ('image/jpeg', 'image/webp') then
    raise exception using errcode = '23514', message = 'PHOTO_STORAGE_NAME_INVALID';
  end if;
  category := case p_slot_key
    when 'cleaning-proof' then '일반방'
    when 'bomb-proof' then '폭탄방'
    when 'issue-proof' then '특이사항'
    else null end;
  if category is null then
    raise exception using errcode = '23514', message = 'PHOTO_STORAGE_NAME_INVALID';
  end if;
  -- lpad(text, 2, '0') alone truncates 100 to 10. Never truncate the number.
  number_text := case when p_naming_number < 10 then '0' else '' end || p_naming_number::text;
  return lpad(extract(year from p_upload_date)::integer::text,4,'0') || '-' ||
    lpad(extract(month from p_upload_date)::integer::text,2,'0') || '-' ||
    lpad(extract(day from p_upload_date)::integer::text,2,'0') || '_' || category || '_' || p_room_number || '_' ||
    number_text || case p_mime_type when 'image/jpeg' then '.jpg' else '.webp' end;
end;
$$;
revoke all on function private.photo_storage_file_name(date,text,text,bigint,text)
  from public, anon, authenticated, service_role;

create table private.photo_storage_names (
  object_id uuid primary key references private.photo_drive_identities(object_id) on delete restrict,
  operation_id uuid not null unique,
  naming_number bigint not null unique check (naming_number > 0),
  upload_date date not null check (isfinite(upload_date)),
  room_number text not null check (room_number ~ '^[0-9]{3}$'),
  slot_key text not null check (slot_key in ('cleaning-proof', 'bomb-proof', 'issue-proof')),
  mime_type text not null check (mime_type in ('image/jpeg', 'image/webp')),
  file_name text not null unique,
  created_at timestamptz not null default clock_timestamp() check (isfinite(created_at)),
  foreign key (object_id, operation_id)
    references private.photo_provider_objects(id, operation_id) on delete restrict,
  check (file_name = private.photo_storage_file_name(upload_date,slot_key,room_number,naming_number,mime_type))
);
-- The object PK and operation UNIQUE cover both FK lookup paths.
alter sequence private.photo_storage_name_number owned by private.photo_storage_names.naming_number;
alter table private.photo_storage_names enable row level security;
revoke all on table private.photo_storage_names from public, anon, authenticated, service_role;
create trigger photo_storage_names_immutable before update or delete on private.photo_storage_names
  for each row execute function private.guard_photo_drive_immutable();

create function private.guard_photo_storage_name_binding()
returns trigger language plpgsql set search_path = '' as $$
declare identity_row private.photo_drive_identities; operation_row private.photo_upload_operations;
  frozen_slot_key text;
begin
  select * into identity_row from private.photo_drive_identities
    where object_id = new.object_id and operation_id = new.operation_id;
  select * into operation_row from private.photo_upload_operations where id = new.operation_id;
  select slot_key into frozen_slot_key from private.target_photo_slot_snapshots
    where id = operation_row.target_photo_slot_id and cleaning_target_id = operation_row.cleaning_target_id;
  if identity_row.object_id is null or operation_row.id is null
    or not exists(select 1 from private.target_photo_snapshot_contracts contract
      where contract.cleaning_target_id = operation_row.cleaning_target_id and contract.ready
        and (contract.frozen_snapshot->>'version')::integer >= 9
        and contract.frozen_snapshot->'slots' = private.flat_cleaning_photo_slots())
    or row(new.upload_date,new.room_number,new.slot_key,new.mime_type) is distinct from
      row(identity_row.upload_date,identity_row.room_number,frozen_slot_key,operation_row.mime_type) then
    raise exception using errcode = '23514', message = 'PHOTO_STORAGE_NAME_INVALID';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_photo_storage_name_binding()
  from public, anon, authenticated, service_role;
create trigger photo_storage_names_binding before insert on private.photo_storage_names
  for each row execute function private.guard_photo_storage_name_binding();

-- Change only one known JSON return fragment per existing function. Keep every
-- actor/session, capability, fence, CAS, quota, retention and accepted guard.
-- CREATE OR REPLACE preserves the existing function identities and ACLs.
do $context_upgrade$
declare patch record; definition text; old_source text; new_source text; fragment_count integer;
begin
  for patch in select * from (values
    ('public.get_photo_provider_context(uuid,uuid,uuid,integer,text)',
      '''providerFileId'',ident.provider_file_id,''providerFolderId'',ident.provider_folder_id',
      '''fileName'',(select name.file_name from private.photo_storage_names name where name.object_id=obj.id),''providerFileId'',ident.provider_file_id,''providerFolderId'',ident.provider_folder_id'),
    ('public.get_photo_reconciliation_context(uuid,integer,text)',
      '''providerFileId'',ident.provider_file_id,''providerFolderId'',ident.provider_folder_id',
      '''fileName'',(select name.file_name from private.photo_storage_names name where name.object_id=obj.id),''providerFileId'',ident.provider_file_id,''providerFolderId'',ident.provider_folder_id'),
    ('public.authorize_photo_read(uuid,uuid,uuid)',
      '''photoId'', p.id, ''providerFileId'', obj.provider_locator, ''sha256'', p.sha256,',
      '''photoId'', p.id, ''fileName'', (select name.file_name from private.photo_storage_names name where name.object_id = obj.id), ''providerFileId'', obj.provider_locator, ''sha256'', p.sha256,')
  ) as changes(signature,old_fragment,new_fragment)
  loop
    select replace(prosrc,E'\r\n',E'\n'), replace(pg_get_functiondef(oid),E'\r\n',E'\n')
      into strict old_source, definition from pg_proc where oid = patch.signature::regprocedure;
    fragment_count := (length(old_source)-length(replace(old_source,patch.old_fragment,''))) / length(patch.old_fragment);
    if fragment_count <> 1 or strpos(old_source,'''fileName''') > 0
      or (length(definition)-length(replace(definition,old_source,''))) / length(old_source) <> 1 then
      raise exception 'PHOTO_STORAGE_NAME_SOURCE_DRIFT: %', patch.signature;
    end if;
    new_source := replace(old_source,patch.old_fragment,patch.new_fragment);
    execute replace(definition,old_source,new_source);
  end loop;
end;
$context_upgrade$;

create function public.reserve_named_photo_provider_identity(
  p_actor_profile_id uuid, p_session_id uuid, p_operation_id uuid,
  p_lease_version integer, p_claim_digest text,
  p_provider_file_id text, p_provider_folder_id text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare context jsonb; had_identity boolean; number_value bigint;
begin
  -- Existing domain -> actor/session -> attempt -> state/object locks come first.
  context := public.get_photo_provider_context(
    p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
  select exists(select 1 from private.photo_drive_identities where operation_id = p_operation_id)
    into had_identity;
  -- Always validate the candidate/folder, including named and legacy retries.
  context := public.reserve_photo_provider_identity(
    p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest,
    p_provider_file_id,p_provider_folder_id);
  if had_identity or context->>'slotKey' not in ('cleaning-proof','bomb-proof','issue-proof')
    or context->>'slotKey' is null
    or not exists(select 1 from private.photo_upload_operations operation_row
      join private.target_photo_snapshot_contracts contract on contract.cleaning_target_id = operation_row.cleaning_target_id
      where operation_row.id = p_operation_id and contract.ready
        and (contract.frozen_snapshot->>'version')::integer >= 9
        and contract.frozen_snapshot->'slots' = private.flat_cleaning_photo_slots()) then
    return context;
  end if;
  number_value := nextval('private.photo_storage_name_number'::regclass);
  insert into private.photo_storage_names(
    object_id,operation_id,naming_number,upload_date,room_number,slot_key,mime_type,file_name
  ) values (
    (context->>'objectId')::uuid,p_operation_id,number_value,
    (context->>'uploadDate')::date,context->>'roomNumber',context->>'slotKey',context->>'mimeType',
    private.photo_storage_file_name((context->>'uploadDate')::date,context->>'slotKey',
      context->>'roomNumber',number_value,context->>'mimeType')
  );
  -- Return only after rechecking the current live actor/session and upload fence.
  return public.get_photo_provider_context(
    p_actor_profile_id,p_session_id,p_operation_id,p_lease_version,p_claim_digest);
end;
$$;
revoke all on function public.reserve_named_photo_provider_identity(uuid,uuid,uuid,integer,text,text,text)
  from public, anon, authenticated, service_role;
grant execute on function public.reserve_named_photo_provider_identity(uuid,uuid,uuid,integer,text,text,text)
  to service_role;
