-- #411: two immutable admissions, one collection fence. No provider I/O or purge activation.
create table private.photo_upload_batches (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  idempotency_key_digest text not null check(idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  request_hash text not null check(request_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  unique(actor_profile_id,idempotency_key_digest),
  unique(id,actor_profile_id)
);
create table private.photo_upload_batch_members (
  batch_id uuid not null,
  actor_profile_id uuid not null,
  item_index integer not null check(item_index in (0,1)),
  idempotency_key_digest text not null,
  primary key(batch_id,item_index),
  unique(actor_profile_id,idempotency_key_digest),
  foreign key(batch_id,actor_profile_id) references private.photo_upload_batches(id,actor_profile_id) on delete restrict,
  -- Membership is installed before the two admissions within the same transaction.
  foreign key(actor_profile_id,idempotency_key_digest)
    references private.photo_upload_admissions(actor_profile_id,idempotency_key_digest)
    on delete restrict deferrable initially deferred
);
do $$ declare t text; begin
  foreach t in array array['photo_upload_batches','photo_upload_batch_members'] loop
    execute format('alter table private.%I enable row level security',t);
    execute format('revoke all on table private.%I from public,anon,authenticated,service_role',t);
    execute format('create trigger photo_batch_immutable before update or delete on private.%I for each row execute function private.guard_photo_drive_immutable()',t);
  end loop;
end $$;

create function private.photo_upload_batch_siblings(p_actor uuid,p_key text,p_other_key text)
returns boolean language sql stable set search_path='' as $$
  select exists(select 1 from private.photo_upload_batch_members a
    join private.photo_upload_batch_members b on b.batch_id=a.batch_id and b.item_index<>a.item_index
    where a.actor_profile_id=p_actor and a.idempotency_key_digest=p_key
      and b.actor_profile_id=p_actor and b.idempotency_key_digest=p_other_key)
$$;

-- No mutable request revision: only a sibling's immutable accepted photo can explain
-- the one intervening collection change. Historical retention bindings use the same proof.
create function private.photo_batch_admission_revision_matches(p_admission uuid,p_revision bigint)
returns boolean language plpgsql stable set search_path='' as $$
declare ad private.photo_upload_admissions; batch uuid; n bigint;
begin
  select * into ad from private.photo_upload_admissions where id=p_admission;
  if ad.id is null or p_revision is null then return false; end if;
  if p_revision=ad.expected_photo_revision then return true; end if;
  if p_revision<>ad.expected_photo_revision+1 then return false; end if;
  select batch_id into batch from private.photo_upload_batch_members
    where actor_profile_id=ad.actor_profile_id and idempotency_key_digest=ad.idempotency_key_digest;
  if batch is null then return false; end if;
  select count(*) into n from private.attempt_photo_collection_changes ch
    join private.photo_upload_acceptances ac on ac.photo_version_id=ch.photo_version_id
    join private.photo_upload_operations op on op.id=ac.operation_id
    join private.photo_upload_states st on st.operation_id=op.id and st.status='accepted'
    join private.photo_upload_batch_members sibling
      on sibling.actor_profile_id=op.actor_profile_id and sibling.idempotency_key_digest=op.idempotency_key_digest
    where ch.cleaning_attempt_id=ad.cleaning_attempt_id and ch.target_photo_slot_id=ad.target_photo_slot_id
      and ch.collection_revision=p_revision and ch.change_type in ('appended','replaced')
      and sibling.batch_id=batch and sibling.idempotency_key_digest<>ad.idempotency_key_digest
      and op.cleaning_attempt_id=ad.cleaning_attempt_id and op.assignment_id=ad.assignment_id
      and op.assignment_revision=ad.assignment_revision and op.target_photo_slot_id=ad.target_photo_slot_id
      and op.expected_photo_revision=ad.expected_photo_revision and op.collection_item_id<>ad.collection_item_id;
  return n=1;
end $$;
create function private.photo_batch_operation_revision_matches(p_operation uuid,p_revision bigint)
returns boolean language sql stable set search_path='' as $$
  select coalesce((select private.photo_batch_admission_revision_matches(b.admission_id,p_revision)
    from private.photo_upload_admission_bindings b where b.operation_id=p_operation),
    -- Legacy operations retain the original exact revision contract.
    (select o.expected_photo_revision=p_revision from private.photo_upload_operations o where o.id=p_operation),false)
$$;
revoke all on function private.photo_upload_batch_siblings(uuid,text,text),
  private.photo_batch_admission_revision_matches(uuid,bigint),private.photo_batch_operation_revision_matches(uuid,bigint)
  from public,anon,authenticated,service_role;

-- Fail closed on source drift; retain latest role/session/retention/extra quota patches.
create function private.patch_photo_batch_source(p_signature text,p_needle text,p_replacement text)
returns void language plpgsql set search_path='' as $$
declare src text; def text;
begin
  select replace(prosrc,E'\r\n',E'\n'),replace(pg_get_functiondef(oid),E'\r\n',E'\n') into src,def
    from pg_proc where oid=p_signature::regprocedure;
  if (length(src)-length(replace(src,p_needle,'')))/length(p_needle)<>1 then
    raise exception 'PHOTO_BATCH_SOURCE_DRIFT: %',p_signature; end if;
  execute replace(def,src,replace(src,p_needle,p_replacement));
end $$;
select private.patch_photo_batch_source('public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)',
  'where x.cleaning_attempt_id = a.id and x.target_photo_slot_id = p_target_slot_id',
  'where x.cleaning_attempt_id = a.id and x.target_photo_slot_id = p_target_slot_id
        and not private.photo_upload_batch_siblings(p_actor_profile_id,p_idempotency_key_digest,x.idempotency_key_digest)');
-- Initial metadata reservation does not decode an image. Charge each binary request
-- and every replay through the existing counter; otherwise 20 images would consume
-- 40 of the unchanged 30/min CPU budget. Only an as-yet-uncreated batch admission skips
-- the increment: its membership cannot exist outside this deferred-FK transaction.
select private.patch_photo_batch_source('public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)',
  'insert into private.photo_upload_admission_limits values (p_actor_profile_id, date_trunc(''minute'', at_time), 1)',
  'if ad.id is not null or not exists(select 1 from private.photo_upload_batch_members
    where actor_profile_id=p_actor_profile_id and idempotency_key_digest=p_idempotency_key_digest) then
  insert into private.photo_upload_admission_limits values (p_actor_profile_id, date_trunc(''minute'', at_time), 1)');
select private.patch_photo_batch_source('public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)',
  'then photo_upload_admission_limits.occurrence_count + 1 else 1 end;
  if ad.id is null then',
  'then photo_upload_admission_limits.occurrence_count + 1 else 1 end;
  end if;
  if ad.id is null then');
select private.patch_photo_batch_source('public.begin_admitted_photo_collection_upload(uuid,uuid,uuid,text,text,integer,text,text)',
  'coalesce(state_row.revision, 0) <> ad.expected_photo_revision',
  'not private.photo_batch_admission_revision_matches(ad.id,coalesce(state_row.revision,0))');
select private.patch_photo_batch_source('public.get_photo_provider_context(uuid,uuid,uuid,integer,text)',
  'coalesce((select revision from private.attempt_photo_collection_states
        where cleaning_attempt_id=a.id and target_photo_slot_id=o.target_photo_slot_id),0)<>o.expected_photo_revision',
  'not private.photo_batch_operation_revision_matches(o.id,coalesce((select revision from private.attempt_photo_collection_states
        where cleaning_attempt_id=a.id and target_photo_slot_id=o.target_photo_slot_id),0))');
select private.patch_photo_batch_source('public.finalize_photo_upload(uuid,uuid,uuid,integer,text)',
  'photo := private.record_validated_collection_photo(',
  '-- Advance only the local calculation, never the immutable operation/request hash.
    if not private.photo_batch_operation_revision_matches(o.id,coalesce((select revision
      from private.attempt_photo_collection_states where cleaning_attempt_id=o.cleaning_attempt_id
      and target_photo_slot_id=o.target_photo_slot_id),0)) then
      raise exception using errcode=''40001'',message=''PHOTO_COLLECTION_VERSION_CONFLICT''; end if;
    o.expected_photo_revision:=coalesce((select revision from private.attempt_photo_collection_states
      where cleaning_attempt_id=o.cleaning_attempt_id and target_photo_slot_id=o.target_photo_slot_id),0);
    photo := private.record_validated_collection_photo(');
select private.patch_photo_batch_source('private.guard_photo_upload_acceptance()',
  'p.version = o.expected_photo_revision + 1',
  'private.photo_batch_operation_revision_matches(o.id,p.version-1)');
select private.patch_photo_batch_source('private.initialize_photo_retention_record_for_acceptance(uuid,uuid,uuid)',
  'photo.version = operation.expected_photo_revision + 1',
  'private.photo_batch_operation_revision_matches(operation.id,photo.version-1)');
select private.patch_photo_batch_source('private.bind_submission_photo_retention()',
  'photo.version = operation.expected_photo_revision + 1',
  'private.photo_batch_operation_revision_matches(operation.id,photo.version-1)');
select private.patch_photo_batch_source('private.photo_upload_projection(uuid)',
  'when a.photo_version_id is null then o.expected_photo_revision else o.expected_photo_revision + 1 end',
  'when a.photo_version_id is null then o.expected_photo_revision else p.version end');
-- The old unique slot index permits exactly one operation. Keep its lookup shape,
-- and replace uniqueness with a serialized guard allowing only the two signed members.
select private.patch_photo_batch_source('private.guard_photo_storage_state()',
  'if tg_op=''DELETE'' then',
  'if tg_op<>''DELETE'' and new.status in (''reserved'',''provider_succeeded'') then
    perform pg_advisory_xact_lock(hashtextextended(''room-management:reservation-command'',0));
    if exists(select 1 from private.photo_upload_states other
      join private.photo_upload_operations peer on peer.id=other.operation_id
      join private.photo_upload_operations current_op on current_op.id=new.operation_id
      where other.cleaning_attempt_id=new.cleaning_attempt_id and other.target_photo_slot_id=new.target_photo_slot_id
        and other.operation_id<>new.operation_id and other.status in (''reserved'',''provider_succeeded'')
        and (peer.actor_profile_id<>current_op.actor_profile_id or peer.collection_item_id is not distinct from current_op.collection_item_id
          or not private.photo_upload_batch_siblings(current_op.actor_profile_id,current_op.idempotency_key_digest,peer.idempotency_key_digest)))
      or (select count(*) from private.photo_upload_states other where other.cleaning_attempt_id=new.cleaning_attempt_id
        and other.target_photo_slot_id=new.target_photo_slot_id and other.operation_id<>new.operation_id
        and other.status in (''reserved'',''provider_succeeded''))>=2 then
      raise exception using errcode=''55000'',message=''PHOTO_UPLOAD_IN_FLIGHT''; end if;
  end if;
  if tg_op=''DELETE'' then');
drop index private.photo_upload_slot_inflight_idx;
create index photo_upload_slot_inflight_idx on private.photo_upload_states(cleaning_attempt_id,target_photo_slot_id)
  where status in ('reserved','provider_succeeded');
drop function private.patch_photo_batch_source(text,text,text);

-- Existing submission consumes this completeness predicate under the domain lock.
-- A submitted snapshot cannot silently omit the second reserved batch member.
do $$ begin
  execute replace(pg_get_functiondef('private.photo_attempt_complete(uuid,timestamptz)'::regprocedure),
    'FUNCTION private.photo_attempt_complete(', 'FUNCTION private.photo_attempt_complete_before_batch(');
end $$;
revoke all on function private.photo_attempt_complete_before_batch(uuid,timestamptz)
  from public,anon,authenticated,service_role;
create or replace function private.photo_attempt_complete(p_attempt uuid,p_as_of timestamptz)
returns boolean language sql stable set search_path='' as $$
  select private.photo_attempt_complete_before_batch(p_attempt,p_as_of) and not exists(
    select 1 from private.photo_upload_batch_members m
    join private.photo_upload_admissions ad on ad.actor_profile_id=m.actor_profile_id and ad.idempotency_key_digest=m.idempotency_key_digest
    left join private.photo_upload_admission_bindings b on b.admission_id=ad.id
    left join private.photo_upload_states st on st.operation_id=b.operation_id
    where ad.cleaning_attempt_id=p_attempt and ((b.operation_id is null and ad.expires_at>p_as_of)
      or st.status in ('reserved','provider_succeeded','reconciliation_pending','compensation_pending')))
$$;

create function public.admit_photo_collection_upload_batch(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_assignment_id uuid,
  p_assignment_revision bigint,p_target_slot_id uuid,p_expected_collection_revision bigint,
  p_items jsonb,p_idempotency_key_digest text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; b private.photo_upload_batches; item jsonb; result jsonb:='[]'; ad jsonb;
  idx integer:=0; capacity integer; append_count integer;
begin
  a:=private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  perform 1 from public.cleaning_attempts where id=a.id for update;
  if p_idempotency_key_digest is null or p_idempotency_key_digest !~ '^[0-9a-f]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_expected_collection_revision is null or p_expected_collection_revision not between 0 and 9007199254740988
    or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  if jsonb_array_length(p_items)<>2 then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(item))<>3
      or not (item ?& array['photoItemId','expectedItemRevision','keyDigest'])
      or jsonb_typeof(item->'photoItemId') is distinct from 'string'
      or item->>'photoItemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'expectedItemRevision') is distinct from 'number'
      or item->>'expectedItemRevision' !~ '^(0|[1-9][0-9]{0,15})$'
      or (item->>'expectedItemRevision')::bigint>9007199254740990
      or jsonb_typeof(item->'keyDigest') is distinct from 'string'
      or item->>'keyDigest' !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  end loop;
  if p_items->0->>'photoItemId'=p_items->1->>'photoItemId'
    or p_items->0->>'keyDigest'=p_items->1->>'keyDigest' then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  select * into b from private.photo_upload_batches
    where actor_profile_id=p_actor_profile_id and idempotency_key_digest=p_idempotency_key_digest;
  if b.id is not null and b.request_hash<>p_request_hash then
    raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  if b.id is null then
    if exists(select 1 from private.photo_upload_admissions old
      where old.actor_profile_id=p_actor_profile_id and old.idempotency_key_digest in
        (p_items->0->>'keyDigest',p_items->1->>'keyDigest')) then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    capacity:=private.photo_slot_max_photos(p_target_slot_id,a.cleaning_target_id);
    if capacity is null or capacity<=1 then
      raise exception using errcode='23514',message='PHOTO_COLLECTION_NOT_ALLOWED'; end if;
    select count(*) into append_count from jsonb_array_elements(p_items) x
      where (x->>'expectedItemRevision')::bigint=0;
    if append_count+(select count(*) from private.attempt_photo_collection_items
      where cleaning_attempt_id=a.id and target_photo_slot_id=p_target_slot_id and active)>capacity then
      raise exception using errcode='54000',message='PHOTO_COLLECTION_LIMIT_EXCEEDED'; end if;
    insert into private.photo_upload_batches(actor_profile_id,idempotency_key_digest,request_hash)
      values(p_actor_profile_id,p_idempotency_key_digest,p_request_hash) returning * into b;
    for item in select value from jsonb_array_elements(p_items) loop
      insert into private.photo_upload_batch_members values(b.id,p_actor_profile_id,idx,item->>'keyDigest');
      idx:=idx+1;
    end loop;
  end if;
  idx:=0;
  for item in select value from jsonb_array_elements(p_items) loop
    if not exists(select 1 from private.photo_upload_batch_members where batch_id=b.id
      and item_index=idx and idempotency_key_digest=item->>'keyDigest') then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    ad:=public.admit_photo_collection_upload(p_actor_profile_id,p_session_id,p_attempt_id,p_assignment_id,
      p_assignment_revision,p_target_slot_id,(item->>'photoItemId')::uuid,p_expected_collection_revision,
      (item->>'expectedItemRevision')::bigint,item->>'keyDigest');
    result:=result||jsonb_build_array(jsonb_build_object('photoItemId',item->>'photoItemId',
      'expiresAt',ad->'expiresAt','quotaWarning',ad->'quotaWarning'));
    idx:=idx+1;
  end loop;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  return jsonb_build_object('batchId',b.id,'maximumConcurrentTransfers',2,'items',result);
end $$;
revoke all on function public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)
  from public,anon,authenticated;
grant execute on function public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)
  to service_role;
