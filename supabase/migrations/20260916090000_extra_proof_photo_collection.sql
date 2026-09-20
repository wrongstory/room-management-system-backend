-- #180: v8+ checkout extra-proof current evidence collection (0..10).
-- Legacy/v7 and every ordinary slot keep the existing single-current-pointer contract.

create table private.attempt_photo_collection_states (
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  revision bigint not null check (revision > 0),
  primary key (cleaning_attempt_id, target_photo_slot_id),
  foreign key (cleaning_attempt_id, cleaning_target_id)
    references public.cleaning_attempts(id, cleaning_target_id) on delete restrict,
  foreign key (target_photo_slot_id, cleaning_target_id)
    references private.target_photo_slot_snapshots(id, cleaning_target_id) on delete restrict
);

create table private.attempt_photo_collection_items (
  id uuid primary key,
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  display_order integer not null check (display_order between 0 and 9),
  revision bigint not null check (revision > 0),
  active boolean not null,
  photo_version_id uuid,
  photo_version bigint,
  unique (id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id),
  foreign key (cleaning_attempt_id, cleaning_target_id)
    references public.cleaning_attempts(id, cleaning_target_id) on delete restrict,
  foreign key (target_photo_slot_id, cleaning_target_id)
    references private.target_photo_slot_snapshots(id, cleaning_target_id) on delete restrict,
  foreign key (photo_version_id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, photo_version)
    references private.attempt_photo_versions(id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, version) on delete restrict,
  check ((active and photo_version_id is not null and photo_version is not null)
    or (not active and photo_version_id is null and photo_version is null))
);
create unique index attempt_photo_collection_active_order_idx
  on private.attempt_photo_collection_items(cleaning_attempt_id, target_photo_slot_id, display_order)
  where active;
create index attempt_photo_collection_items_slot_idx
  on private.attempt_photo_collection_items(cleaning_attempt_id, target_photo_slot_id, active, display_order);
create index attempt_photo_collection_items_photo_idx
  on private.attempt_photo_collection_items(photo_version_id) where photo_version_id is not null;

create table private.attempt_photo_collection_changes (
  id uuid primary key default gen_random_uuid(),
  cleaning_attempt_id uuid not null,
  cleaning_target_id uuid not null,
  target_photo_slot_id uuid not null,
  collection_revision bigint not null check (collection_revision > 0),
  photo_item_id uuid not null,
  item_revision bigint not null check (item_revision > 0),
  display_order integer not null check (display_order between 0 and 9),
  change_type text not null check (change_type in ('appended', 'replaced', 'deleted')),
  photo_version_id uuid,
  photo_version bigint,
  occurred_at timestamptz not null default clock_timestamp(),
  unique (cleaning_attempt_id, target_photo_slot_id, collection_revision),
  unique (photo_item_id, item_revision),
  foreign key (photo_item_id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id)
    references private.attempt_photo_collection_items(id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id) on delete restrict,
  foreign key (photo_version_id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, photo_version)
    references private.attempt_photo_versions(id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, version) on delete restrict,
  check ((change_type = 'deleted' and photo_version_id is null and photo_version is null)
    or (change_type <> 'deleted' and photo_version_id is not null and photo_version is not null))
);
create index attempt_photo_collection_changes_slot_idx
  on private.attempt_photo_collection_changes(cleaning_attempt_id, target_photo_slot_id, collection_revision);

create table private.photo_collection_commands (
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  command_type text not null check (command_type = 'photo.collection.delete'),
  idempotency_key_digest text not null check (idempotency_key_digest ~ '^[0-9a-f]{64}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  photo_item_id uuid not null,
  response_payload jsonb not null,
  completed_at timestamptz not null default clock_timestamp(),
  primary key (actor_profile_id, command_type, idempotency_key_digest)
);

alter table private.attempt_photo_versions
  add column collection_item_id uuid,
  add column item_revision bigint,
  add constraint attempt_photo_versions_collection_pair_check
    check ((collection_item_id is null) = (item_revision is null)),
  add constraint attempt_photo_versions_item_revision_check
    check (item_revision is null or item_revision > 0);
create unique index attempt_photo_versions_collection_item_revision_idx
  on private.attempt_photo_versions(collection_item_id, item_revision)
  where collection_item_id is not null;

alter table private.submission_photo_bindings
  drop constraint submission_photo_bindings_pkey,
  add column collection_item_id uuid,
  add column item_revision bigint,
  add column item_display_order integer,
  add constraint submission_photo_bindings_collection_shape_check check (
    (collection_item_id is null and item_revision is null and item_display_order is null)
    or (collection_item_id is not null and item_revision > 0 and item_display_order between 0 and 9)
  ),
  add constraint submission_photo_bindings_pkey primary key (submission_id, target_photo_slot_id, photo_version_id);
create index submission_photo_bindings_collection_item_idx
  on private.submission_photo_bindings(collection_item_id) where collection_item_id is not null;

alter table private.photo_upload_admissions
  add column collection_item_id uuid,
  add column expected_item_revision bigint,
  add constraint photo_upload_admissions_collection_pair_check check (
    (collection_item_id is null and expected_item_revision is null)
    or (collection_item_id is not null and expected_item_revision between 0 and 9007199254740990)
  );
alter table private.photo_upload_operations
  drop constraint photo_upload_operations_command_type_check,
  add column collection_item_id uuid,
  add column expected_item_revision bigint,
  add constraint photo_upload_operations_command_type_check
    check (command_type in ('photo.upload', 'photo.collection.upload')),
  add constraint photo_upload_operations_collection_shape_check check (
    (command_type = 'photo.upload' and collection_item_id is null and expected_item_revision is null)
    or (command_type = 'photo.collection.upload' and collection_item_id is not null
      and expected_item_revision between 0 and 9007199254740990)
  );

alter table private.attempt_photo_collection_states enable row level security;
alter table private.attempt_photo_collection_items enable row level security;
alter table private.attempt_photo_collection_changes enable row level security;
alter table private.photo_collection_commands enable row level security;
revoke all on table private.attempt_photo_collection_states, private.attempt_photo_collection_items,
  private.attempt_photo_collection_changes, private.photo_collection_commands
  from public, anon, authenticated, service_role;

create function private.photo_collection_append_only()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'PHOTO_MODEL_IMMUTABLE';
end
$$;
revoke all on function private.photo_collection_append_only() from public, anon, authenticated, service_role;
create trigger photo_collection_change_immutable before update or delete on private.attempt_photo_collection_changes
for each row execute function private.photo_collection_append_only();
create trigger photo_collection_command_immutable before update or delete on private.photo_collection_commands
for each row execute function private.photo_collection_append_only();

create function private.photo_slot_max_photos(p_slot uuid, p_target uuid)
returns integer language sql stable set search_path = '' as $$
  select case
    when s.slot_key = 'extra-proof'
      and s.slot_snapshot ? 'maxPhotos'
      and jsonb_typeof(s.slot_snapshot -> 'maxPhotos') = 'number'
      and (s.slot_snapshot ->> 'maxPhotos')::integer = 10
      and c.ready
      and (c.frozen_snapshot ->> 'version')::integer >= 8
      and c.frozen_snapshot ->> 'cleaningKind' = 'checkout'
    then 10 else 1 end
  from private.target_photo_slot_snapshots s
  join private.target_photo_snapshot_contracts c on c.cleaning_target_id = s.cleaning_target_id
  where s.id = p_slot and s.cleaning_target_id = p_target
$$;
revoke all on function private.photo_slot_max_photos(uuid, uuid) from public, anon, authenticated, service_role;

create function private.guard_photo_collection_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'PHOTO_MODEL_IMMUTABLE';
  end if;
  if private.photo_slot_max_photos(new.target_photo_slot_id, new.cleaning_target_id) <> 10 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
  end if;
  if tg_op = 'INSERT' then
    if new.revision <> 1 then
      raise exception using errcode = '40001', message = 'PHOTO_COLLECTION_VERSION_CONFLICT';
    end if;
  elsif new.cleaning_attempt_id <> old.cleaning_attempt_id
    or new.cleaning_target_id <> old.cleaning_target_id
    or new.target_photo_slot_id <> old.target_photo_slot_id
    or new.revision <> old.revision + 1 then
    raise exception using errcode = '40001', message = 'PHOTO_COLLECTION_VERSION_CONFLICT';
  end if;
  return new;
end
$$;
revoke all on function private.guard_photo_collection_state() from public, anon, authenticated, service_role;
create trigger photo_collection_state_guard before insert or update or delete on private.attempt_photo_collection_states
for each row execute function private.guard_photo_collection_state();

create function private.guard_photo_collection_item()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'PHOTO_MODEL_IMMUTABLE';
  end if;
  if private.photo_slot_max_photos(new.target_photo_slot_id, new.cleaning_target_id) <> 10 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
  end if;
  if tg_op = 'INSERT' then
    if new.revision <> 1 or not new.active then
      raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
    end if;
  elsif new.id <> old.id or new.cleaning_attempt_id <> old.cleaning_attempt_id
    or new.cleaning_target_id <> old.cleaning_target_id
    or new.target_photo_slot_id <> old.target_photo_slot_id
    or new.display_order <> old.display_order or new.revision <> old.revision + 1 or not old.active then
    raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
  end if;
  if new.active and not exists (
    select 1 from private.attempt_photo_versions p
    where p.id = new.photo_version_id
      and p.collection_item_id = new.id and p.item_revision = new.revision
      and p.validation_status = 'verified' and p.purge_after > clock_timestamp()
      and not exists (select 1 from private.attempt_photo_purge_states x where x.photo_version_id = p.id)
  ) then
    raise exception using errcode = '23514', message = 'PHOTO_NOT_VERIFIED';
  end if;
  return new;
end
$$;
revoke all on function private.guard_photo_collection_item() from public, anon, authenticated, service_role;
create trigger photo_collection_item_guard before insert or update or delete on private.attempt_photo_collection_items
for each row execute function private.guard_photo_collection_item();

create function private.guard_photo_collection_upload_shape()
returns trigger language plpgsql set search_path = '' as $$
declare max_photos integer;
begin
  max_photos := private.photo_slot_max_photos(new.target_photo_slot_id, new.cleaning_target_id);
  if max_photos is null then
    raise exception using errcode = '23514', message = 'PHOTO_SLOT_INVALID';
  end if;
  if new.collection_item_id is null and max_photos <> 1 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_ROUTE_REQUIRED';
  end if;
  if new.collection_item_id is not null and max_photos <> 10 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
  end if;
  return new;
end
$$;
revoke all on function private.guard_photo_collection_upload_shape() from public, anon, authenticated, service_role;
create trigger photo_admission_collection_shape before insert on private.photo_upload_admissions
for each row execute function private.guard_photo_collection_upload_shape();
create trigger photo_operation_collection_shape before insert on private.photo_upload_operations
for each row execute function private.guard_photo_collection_upload_shape();

create or replace function private.photo_upload_projection(p_operation uuid)
returns jsonb language sql stable set search_path = '' as $$
select jsonb_build_object(
  'operationId', o.id,
  'objectId', obj.id,
  'attemptId', o.cleaning_attempt_id,
  'targetSlotId', o.target_photo_slot_id,
  'photoItemId', o.collection_item_id,
  'status', s.status,
  'leaseVersion', s.lease_version,
  'leaseExpiresAt', s.lease_expires_at,
  'photoId', a.photo_version_id,
  'photoVersion', p.version,
  'collectionRevision', case when o.collection_item_id is null then null
    when a.photo_version_id is null then o.expected_photo_revision else o.expected_photo_revision + 1 end,
  'itemRevision', case when o.collection_item_id is null then null
    when a.photo_version_id is null then o.expected_item_revision else o.expected_item_revision + 1 end,
  'uploadedAt', obj.uploaded_at,
  'purgeAfter', obj.purge_after,
  'compensationAllowed', s.status = 'compensation_pending' and a.operation_id is null and obj.provider_locator is not null
)
from private.photo_upload_operations o
join private.photo_upload_states s on s.operation_id = o.id
join private.photo_provider_objects obj on obj.operation_id = o.id
left join private.photo_upload_acceptances a on a.operation_id = o.id
left join private.attempt_photo_versions p on p.id = a.photo_version_id
where o.id = p_operation
$$;

create or replace function private.guard_photo_admission_binding()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1
    from private.photo_upload_admissions ad
    join private.photo_upload_operations o on o.id = new.operation_id
    where ad.id = new.admission_id
      and ad.actor_profile_id = o.actor_profile_id
      and ad.cleaning_attempt_id = o.cleaning_attempt_id
      and ad.cleaning_target_id = o.cleaning_target_id
      and ad.assignment_id = o.assignment_id
      and ad.assignment_revision = o.assignment_revision
      and ad.target_photo_slot_id = o.target_photo_slot_id
      and ad.expected_photo_revision = o.expected_photo_revision
      and ad.collection_item_id is not distinct from o.collection_item_id
      and ad.expected_item_revision is not distinct from o.expected_item_revision
      and ad.idempotency_key_digest = o.idempotency_key_digest
      and o.created_at >= ad.created_at and o.created_at < ad.expires_at
  ) then
    raise exception using errcode = '23514', message = 'PHOTO_OPERATION_INVALID';
  end if;
  return new;
end
$$;

create or replace function private.guard_photo_upload_acceptance()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not exists (
    select 1
    from private.photo_upload_operations o
    join private.photo_upload_states s on s.operation_id = o.id
    join private.photo_provider_objects obj on obj.operation_id = o.id
    join private.attempt_photo_versions p on p.id = new.photo_version_id
    where o.id = new.operation_id and obj.id = new.object_id and s.status = 'provider_succeeded'
      and p.cleaning_attempt_id = o.cleaning_attempt_id and p.cleaning_target_id = o.cleaning_target_id
      and p.target_photo_slot_id = o.target_photo_slot_id and p.version = o.expected_photo_revision + 1
      and p.collection_item_id is not distinct from o.collection_item_id
      and p.item_revision is not distinct from case when o.collection_item_id is null then null else o.expected_item_revision + 1 end
      and p.sha256 = o.sha256 and p.mime_type = o.mime_type and p.size_bytes = o.size_bytes
      and p.uploaded_at = obj.uploaded_at and p.purge_after = obj.purge_after and p.validation_status = 'verified'
  ) then
    raise exception using errcode = '23514', message = 'PHOTO_OPERATION_INVALID';
  end if;
  return new;
end
$$;

create function private.record_validated_collection_photo(
  p_actor uuid,
  p_attempt uuid,
  p_slot uuid,
  p_item uuid,
  p_expected_collection_revision bigint,
  p_expected_item_revision bigint,
  p_sha256 text,
  p_mime text,
  p_size integer,
  p_uploaded_at timestamptz
)
returns uuid language plpgsql set search_path = '' as $$
declare
  a public.cleaning_attempts;
  state_row private.attempt_photo_collection_states;
  item_row private.attempt_photo_collection_items;
  result_id uuid;
  next_collection_revision bigint;
  next_item_revision bigint;
  selected_order integer;
  at_time timestamptz;
begin
  a := private.assert_photo_model_actor(p_actor, p_attempt, 'upload_evidence');
  -- Serializes the first collection row as well as later revisions. Locking the
  -- nullable state row alone cannot protect two concurrent initial appends.
  perform 1 from public.cleaning_attempts where id = a.id for update;
  at_time := clock_timestamp();
  if p_uploaded_at is null or not isfinite(p_uploaded_at) or p_uploaded_at > at_time
    or p_uploaded_at + interval '168 hours' <= at_time then
    raise exception using errcode = '23514', message = 'PHOTO_UPLOAD_TIME_INVALID';
  end if;
  if private.photo_slot_max_photos(p_slot, a.cleaning_target_id) <> 10 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
  end if;

  select * into state_row from private.attempt_photo_collection_states
    where cleaning_attempt_id = a.id and target_photo_slot_id = p_slot for update;
  if p_expected_collection_revision is null or p_expected_collection_revision < 0
    or coalesce(state_row.revision, 0) <> p_expected_collection_revision then
    raise exception using errcode = '40001', message = 'PHOTO_COLLECTION_VERSION_CONFLICT';
  end if;
  select * into item_row from private.attempt_photo_collection_items where id = p_item for update;
  if p_expected_item_revision = 0 then
    if item_row.id is not null then
      raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
    end if;
    if (select count(*) from private.attempt_photo_collection_items i
      where i.cleaning_attempt_id = a.id and i.target_photo_slot_id = p_slot and i.active) >= 10 then
      raise exception using errcode = '54000', message = 'PHOTO_COLLECTION_LIMIT_EXCEEDED';
    end if;
    select candidate into selected_order
    from generate_series(0, 9) candidate
    where not exists (
      select 1 from private.attempt_photo_collection_items i
      where i.cleaning_attempt_id = a.id and i.target_photo_slot_id = p_slot
        and i.active and i.display_order = candidate
    ) order by candidate limit 1;
    next_item_revision := 1;
  else
    if item_row.id is null or not item_row.active
      or item_row.cleaning_attempt_id <> a.id or item_row.target_photo_slot_id <> p_slot
      or item_row.revision <> p_expected_item_revision then
      raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
    end if;
    selected_order := item_row.display_order;
    next_item_revision := p_expected_item_revision + 1;
  end if;
  next_collection_revision := p_expected_collection_revision + 1;

  insert into private.attempt_photo_versions(
    cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, version,
    validation_status, sha256, mime_type, size_bytes, uploaded_at, purge_after,
    collection_item_id, item_revision
  ) values (
    a.id, a.cleaning_target_id, p_slot, next_collection_revision,
    'verified', p_sha256, p_mime, p_size, p_uploaded_at, p_uploaded_at + interval '168 hours',
    p_item, next_item_revision
  ) returning id into result_id;

  if state_row.revision is null then
    insert into private.attempt_photo_collection_states(cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, revision)
      values (a.id, a.cleaning_target_id, p_slot, 1);
  else
    update private.attempt_photo_collection_states set revision = next_collection_revision
      where cleaning_attempt_id = a.id and target_photo_slot_id = p_slot;
  end if;
  if item_row.id is null then
    insert into private.attempt_photo_collection_items(
      id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, display_order,
      revision, active, photo_version_id, photo_version
    ) values (p_item, a.id, a.cleaning_target_id, p_slot, selected_order, 1, true, result_id, next_collection_revision);
  else
    update private.attempt_photo_collection_items
      set revision = next_item_revision, photo_version_id = result_id, photo_version = next_collection_revision
      where id = p_item;
  end if;
  insert into private.attempt_photo_collection_changes(
    cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, collection_revision,
    photo_item_id, item_revision, display_order, change_type, photo_version_id, photo_version
  ) values (
    a.id, a.cleaning_target_id, p_slot, next_collection_revision,
    p_item, next_item_revision, selected_order,
    case when item_row.id is null then 'appended' else 'replaced' end,
    result_id, next_collection_revision
  );
  return result_id;
end
$$;
revoke all on function private.record_validated_collection_photo(uuid, uuid, uuid, uuid, bigint, bigint, text, text, integer, timestamptz)
  from public, anon, authenticated, service_role;

create or replace function private.record_validated_attempt_photo(
  p_actor uuid, p_attempt uuid, p_slot uuid, p_expected_revision bigint,
  p_sha256 text, p_mime text, p_size integer, p_uploaded_at timestamptz
)
returns uuid language plpgsql set search_path = '' as $$
declare a public.cleaning_attempts; c private.attempt_photo_current; result_id uuid; at_time timestamptz;
begin
  a := private.assert_photo_model_actor(p_actor, p_attempt, 'upload_evidence');
  at_time := clock_timestamp();
  if p_uploaded_at is null or not isfinite(p_uploaded_at) or p_uploaded_at > at_time
    or p_uploaded_at + interval '168 hours' <= at_time then
    raise exception using errcode = '23514', message = 'PHOTO_UPLOAD_TIME_INVALID';
  end if;
  if private.photo_slot_max_photos(p_slot, a.cleaning_target_id) is null then
    raise exception using errcode = '23514', message = 'PHOTO_SLOT_INVALID';
  end if;
  if private.photo_slot_max_photos(p_slot, a.cleaning_target_id) <> 1 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_ROUTE_REQUIRED';
  end if;
  select * into c from private.attempt_photo_current
    where cleaning_attempt_id = p_attempt and target_photo_slot_id = p_slot;
  if p_expected_revision is null or p_expected_revision < 0 or coalesce(c.revision, 0) <> p_expected_revision then
    raise exception using errcode = '40001', message = 'PHOTO_VERSION_CONFLICT';
  end if;
  insert into private.attempt_photo_versions(
    cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, version,
    validation_status, sha256, mime_type, size_bytes, uploaded_at, purge_after
  ) values (
    p_attempt, a.cleaning_target_id, p_slot, p_expected_revision + 1,
    'verified', p_sha256, p_mime, p_size, p_uploaded_at, p_uploaded_at + interval '168 hours'
  ) returning id into result_id;
  if c.revision is null then
    insert into private.attempt_photo_current(
      cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, revision, photo_version_id, photo_version
    ) values (p_attempt, a.cleaning_target_id, p_slot, 1, result_id, 1);
  else
    update private.attempt_photo_current
      set revision = p_expected_revision + 1, photo_version_id = result_id, photo_version = p_expected_revision + 1
      where cleaning_attempt_id = p_attempt and target_photo_slot_id = p_slot;
  end if;
  return result_id;
end
$$;

create function public.admit_photo_collection_upload(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_attempt_id uuid,
  p_assignment_id uuid,
  p_assignment_revision bigint,
  p_target_slot_id uuid,
  p_photo_item_id uuid,
  p_expected_collection_revision bigint,
  p_expected_item_revision bigint,
  p_idempotency_key_digest text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.cleaning_attempts;
  ad private.photo_upload_admissions;
  item_row private.attempt_photo_collection_items;
  lim private.photo_upload_admission_limits;
  q jsonb;
  at_time timestamptz;
begin
  if p_photo_item_id is null or p_idempotency_key_digest is null
    or p_idempotency_key_digest !~ '^[0-9a-f]{64}$'
    or p_expected_collection_revision is null or p_expected_collection_revision not between 0 and 9007199254740990
    or p_expected_item_revision is null or p_expected_item_revision not between 0 and 9007199254740990 then
    raise exception using errcode = '23514', message = 'PHOTO_UPLOAD_INVALID';
  end if;
  a := private.assert_photo_upload_actor(p_actor_profile_id, p_session_id, p_attempt_id);
  perform 1 from public.cleaning_attempts where id = a.id for update;
  at_time := clock_timestamp();
  select * into ad from private.photo_upload_admissions
    where actor_profile_id = p_actor_profile_id and idempotency_key_digest = p_idempotency_key_digest;
  if ad.id is not null and row(
    ad.cleaning_attempt_id, ad.assignment_id, ad.assignment_revision, ad.target_photo_slot_id,
    ad.collection_item_id, ad.expected_photo_revision, ad.expected_item_revision
  ) is distinct from row(
    p_attempt_id, p_assignment_id, p_assignment_revision, p_target_slot_id,
    p_photo_item_id, p_expected_collection_revision, p_expected_item_revision
  ) then
    raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
  end if;
  if ad.id is not null and ad.expires_at <= at_time
    and not exists (select 1 from private.photo_upload_admission_bindings where admission_id = ad.id) then
    raise exception using errcode = '55000', message = 'PHOTO_ADMISSION_EXPIRED';
  end if;
  if ad.id is null then
    if a.assignment_id is distinct from p_assignment_id or a.assignment_revision is distinct from p_assignment_revision then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
    end if;
    if private.photo_slot_max_photos(p_target_slot_id, a.cleaning_target_id) <> 10 then
      raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
    end if;
    if coalesce((select revision from private.attempt_photo_collection_states
      where cleaning_attempt_id = a.id and target_photo_slot_id = p_target_slot_id), 0) <> p_expected_collection_revision then
      raise exception using errcode = '40001', message = 'PHOTO_COLLECTION_VERSION_CONFLICT';
    end if;
    select * into item_row from private.attempt_photo_collection_items where id = p_photo_item_id;
    if (p_expected_item_revision = 0 and item_row.id is not null)
      or (p_expected_item_revision > 0 and (item_row.id is null or not item_row.active
        or item_row.cleaning_attempt_id <> a.id or item_row.target_photo_slot_id <> p_target_slot_id
        or item_row.revision <> p_expected_item_revision)) then
      raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
    end if;
    if p_expected_item_revision = 0 and (select count(*) from private.attempt_photo_collection_items i
      where i.cleaning_attempt_id = a.id and i.target_photo_slot_id = p_target_slot_id and i.active) >= 10 then
      raise exception using errcode = '54000', message = 'PHOTO_COLLECTION_LIMIT_EXCEEDED';
    end if;
    if exists (
      select 1 from private.photo_upload_admissions x
      left join private.photo_upload_admission_bindings b on b.admission_id = x.id
      left join private.photo_upload_states s on s.operation_id = b.operation_id
      where x.cleaning_attempt_id = a.id and x.target_photo_slot_id = p_target_slot_id
        and ((b.operation_id is null and x.expires_at > at_time)
          or s.status in ('reserved', 'provider_succeeded', 'reconciliation_pending', 'compensation_pending'))
    ) then
      raise exception using errcode = '55000', message = 'PHOTO_UPLOAD_IN_FLIGHT';
    end if;
    if (select count(*) from private.photo_upload_admissions x
      left join private.photo_upload_admission_bindings b on b.admission_id = x.id
      left join private.photo_upload_states s on s.operation_id = b.operation_id
      where x.actor_profile_id = p_actor_profile_id
        and ((b.operation_id is null and x.expires_at > at_time)
          or s.status in ('reserved', 'provider_succeeded', 'reconciliation_pending', 'compensation_pending'))) >= 8 then
      raise exception using errcode = '54000', message = 'PHOTO_UPLOAD_LIMIT_EXCEEDED';
    end if;
  end if;
  q := private.photo_quota_context(at_time);
  if ad.id is null and (q ->> 'effectiveBytes')::bigint + 307200 >= 12000000000 then
    raise exception using errcode = '54000', message = 'PHOTO_STORAGE_QUOTA_EXCEEDED';
  end if;
  select * into lim from private.photo_upload_admission_limits where actor_profile_id = p_actor_profile_id;
  if lim.minute_started_at = date_trunc('minute', at_time) and lim.occurrence_count >= 30 then
    raise exception using errcode = '54000', message = 'PHOTO_UPLOAD_RATE_LIMITED';
  end if;
  insert into private.photo_upload_admission_limits values (p_actor_profile_id, date_trunc('minute', at_time), 1)
    on conflict (actor_profile_id) do update set
      minute_started_at = excluded.minute_started_at,
      occurrence_count = case when photo_upload_admission_limits.minute_started_at = excluded.minute_started_at
        then photo_upload_admission_limits.occurrence_count + 1 else 1 end;
  if ad.id is null then
    insert into private.photo_upload_admissions(
      actor_profile_id, cleaning_attempt_id, cleaning_target_id, assignment_id, assignment_revision,
      target_photo_slot_id, expected_photo_revision, idempotency_key_digest, created_at, expires_at, quota_revision,
      collection_item_id, expected_item_revision
    ) values (
      p_actor_profile_id, a.id, a.cleaning_target_id, a.assignment_id, a.assignment_revision,
      p_target_slot_id, p_expected_collection_revision, p_idempotency_key_digest, at_time, at_time + interval '5 minutes',
      (q ->> 'revision')::bigint, p_photo_item_id, p_expected_item_revision
    ) returning * into ad;
  end if;
  return jsonb_build_object(
    'admissionId', ad.id, 'expiresAt', ad.expires_at, 'reservedBytes', ad.reserved_bytes,
    'quotaWarning', (q ->> 'warning')::boolean
  );
end
$$;

create function public.begin_admitted_photo_collection_upload(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_admission_id uuid,
  p_sha256 text,
  p_mime_type text,
  p_size_bytes integer,
  p_idempotency_key_digest text,
  p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  ad private.photo_upload_admissions;
  existing_operation_id uuid;
  existing private.photo_upload_operations;
  op private.photo_upload_operations;
  state_row private.attempt_photo_collection_states;
  item_row private.attempt_photo_collection_items;
  at_time timestamptz;
  bucket private.photo_upload_rate_limits;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  select * into ad from private.photo_upload_admissions
    where id = p_admission_id and actor_profile_id = p_actor_profile_id;
  if ad.id is null or ad.collection_item_id is null or ad.idempotency_key_digest is distinct from p_idempotency_key_digest then
    raise exception using errcode = '42501', message = 'PHOTO_ACCESS_REQUIRED';
  end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id, p_session_id, ad.cleaning_attempt_id);
  select operation_id into existing_operation_id from private.photo_upload_admission_bindings where admission_id = ad.id;
  if existing_operation_id is null and ad.expires_at <= clock_timestamp() then
    raise exception using errcode = '55000', message = 'PHOTO_ADMISSION_EXPIRED';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$'
    or p_mime_type not in ('image/jpeg', 'image/webp') or p_size_bytes not between 1 and 307200
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '23514', message = 'PHOTO_UPLOAD_INVALID';
  end if;
  if existing_operation_id is not null then
    select * into existing from private.photo_upload_operations where id = existing_operation_id;
    if existing.request_hash <> p_request_hash
      or row(existing.sha256, existing.mime_type, existing.size_bytes) is distinct from row(p_sha256, p_mime_type, p_size_bytes) then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return private.photo_upload_projection(existing.id);
  end if;
  select * into state_row from private.attempt_photo_collection_states
    where cleaning_attempt_id = ad.cleaning_attempt_id and target_photo_slot_id = ad.target_photo_slot_id;
  select * into item_row from private.attempt_photo_collection_items where id = ad.collection_item_id;
  if coalesce(state_row.revision, 0) <> ad.expected_photo_revision then
    raise exception using errcode = '40001', message = 'PHOTO_COLLECTION_VERSION_CONFLICT';
  end if;
  if (ad.expected_item_revision = 0 and item_row.id is not null)
    or (ad.expected_item_revision > 0 and (item_row.id is null or not item_row.active
      or item_row.revision <> ad.expected_item_revision)) then
    raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
  end if;
  at_time := clock_timestamp();
  select * into bucket from private.photo_upload_rate_limits where actor_profile_id = p_actor_profile_id;
  if bucket.minute_started_at = date_trunc('minute', at_time) and bucket.occurrence_count >= 30 then
    raise exception using errcode = '54000', message = 'PHOTO_UPLOAD_RATE_LIMITED';
  end if;
  insert into private.photo_upload_rate_limits(actor_profile_id, minute_started_at, occurrence_count)
    values (p_actor_profile_id, date_trunc('minute', at_time), 1)
    on conflict (actor_profile_id) do update set
      minute_started_at = excluded.minute_started_at,
      occurrence_count = case when photo_upload_rate_limits.minute_started_at = excluded.minute_started_at
        then photo_upload_rate_limits.occurrence_count + 1 else 1 end;
  insert into private.photo_upload_operations(
    actor_profile_id, command_type, idempotency_key_digest, request_hash,
    cleaning_attempt_id, cleaning_target_id, assignment_id, assignment_revision,
    target_photo_slot_id, expected_photo_revision, sha256, mime_type, size_bytes,
    collection_item_id, expected_item_revision
  ) values (
    p_actor_profile_id, 'photo.collection.upload', p_idempotency_key_digest, p_request_hash,
    ad.cleaning_attempt_id, ad.cleaning_target_id, ad.assignment_id, ad.assignment_revision,
    ad.target_photo_slot_id, ad.expected_photo_revision, p_sha256, p_mime_type, p_size_bytes,
    ad.collection_item_id, ad.expected_item_revision
  ) returning * into op;
  insert into private.photo_provider_objects(operation_id) values (op.id);
  insert into private.photo_upload_states(operation_id, cleaning_attempt_id, target_photo_slot_id, actor_profile_id)
    values (op.id, op.cleaning_attempt_id, op.target_photo_slot_id, op.actor_profile_id);
  insert into private.photo_upload_admission_bindings(admission_id, operation_id) values (ad.id, op.id);
  return private.photo_upload_projection(op.id);
end
$$;

create or replace function public.finalize_photo_upload(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_operation_id uuid,
  p_lease_version integer,
  p_claim_digest text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  o private.photo_upload_operations;
  s private.photo_upload_states;
  obj private.photo_provider_objects;
  p public.profiles;
  photo uuid;
  at_time timestamptz;
begin
  select * into o from private.photo_upload_operations where id = p_operation_id and actor_profile_id = p_actor_profile_id;
  if o.id is null then raise exception using errcode = '42501', message = 'PHOTO_ACCESS_REQUIRED'; end if;
  perform private.assert_photo_upload_actor(p_actor_profile_id, p_session_id, o.cleaning_attempt_id);
  select * into s from private.photo_upload_states where operation_id = o.id for update;
  select * into obj from private.photo_provider_objects where operation_id = o.id;
  at_time := clock_timestamp();
  if s.status = 'accepted' then return private.photo_upload_projection(o.id); end if;
  if s.status not in ('reserved', 'provider_succeeded') then
    raise exception using errcode = '55000', message = 'PHOTO_OPERATION_TERMINAL';
  end if;
  if s.lease_version is distinct from p_lease_version or s.lease_claim_digest is distinct from p_claim_digest
    or p_lease_version < 1 or s.lease_expires_at is null or s.lease_expires_at <= at_time then
    raise exception using errcode = '40001', message = 'PHOTO_UPLOAD_FENCE_CONFLICT';
  end if;
  if s.status <> 'provider_succeeded' or obj.provider_locator is null then
    raise exception using errcode = '55000', message = 'PHOTO_PROVIDER_RESULT_REQUIRED';
  end if;
  if o.collection_item_id is null then
    photo := private.record_validated_attempt_photo(
      o.actor_profile_id, o.cleaning_attempt_id, o.target_photo_slot_id, o.expected_photo_revision,
      o.sha256, o.mime_type, o.size_bytes, obj.uploaded_at
    );
  else
    photo := private.record_validated_collection_photo(
      o.actor_profile_id, o.cleaning_attempt_id, o.target_photo_slot_id, o.collection_item_id,
      o.expected_photo_revision, o.expected_item_revision,
      o.sha256, o.mime_type, o.size_bytes, obj.uploaded_at
    );
  end if;
  insert into private.photo_upload_acceptances(operation_id, object_id, photo_version_id) values (o.id, obj.id, photo);
  update private.photo_upload_states set status = 'accepted', revision = revision + 1 where operation_id = o.id;
  select * into p from public.profiles where id = o.actor_profile_id;
  insert into public.audit_events(
    event_type, entity_type, entity_id, actor_profile_id, actor_display_name_snapshot,
    effective_at, recorded_at, idempotency_key, after_state
  ) values (
    'photo.upload_accepted', 'cleaning_attempt', o.cleaning_attempt_id, p.id, p.display_name,
    obj.uploaded_at, clock_timestamp(), 'photo-upload-' || o.id::text,
    jsonb_strip_nulls(jsonb_build_object(
      'cleaningTargetId', o.cleaning_target_id, 'attemptId', o.cleaning_attempt_id,
      'photoId', photo, 'targetSlotId', o.target_photo_slot_id,
      'photoItemId', o.collection_item_id, 'photoVersion', o.expected_photo_revision + 1,
      'collectionRevision', case when o.collection_item_id is null then null else o.expected_photo_revision + 1 end,
      'itemRevision', case when o.collection_item_id is null then null else o.expected_item_revision + 1 end,
      'uploadedAt', obj.uploaded_at, 'purgeAfter', obj.purge_after
    ))
  );
  return private.photo_upload_projection(o.id);
end
$$;

create function public.delete_photo_collection_item(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_attempt_id uuid,
  p_assignment_id uuid,
  p_assignment_revision bigint,
  p_target_slot_id uuid,
  p_photo_item_id uuid,
  p_expected_collection_revision bigint,
  p_expected_item_revision bigint,
  p_idempotency_key_digest text,
  p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.cleaning_attempts;
  profile_row public.profiles;
  state_row private.attempt_photo_collection_states;
  item_row private.attempt_photo_collection_items;
  receipt private.photo_collection_commands;
  result jsonb;
  next_collection_revision bigint;
  next_item_revision bigint;
begin
  if p_photo_item_id is null or p_expected_collection_revision is null or p_expected_collection_revision < 1
    or p_expected_item_revision is null or p_expected_item_revision < 1
    or p_idempotency_key_digest is null or p_idempotency_key_digest !~ '^[0-9a-f]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_DELETE_INVALID';
  end if;
  a := private.assert_photo_upload_actor(p_actor_profile_id, p_session_id, p_attempt_id);
  perform 1 from public.cleaning_attempts where id = a.id for update;
  select * into receipt from private.photo_collection_commands
    where actor_profile_id = p_actor_profile_id and command_type = 'photo.collection.delete'
      and idempotency_key_digest = p_idempotency_key_digest;
  if receipt.actor_profile_id is not null then
    if receipt.request_hash <> p_request_hash or receipt.photo_item_id <> p_photo_item_id then
      raise exception using errcode = '23505', message = 'IDEMPOTENCY_KEY_REUSED';
    end if;
    return receipt.response_payload;
  end if;
  if a.assignment_id is distinct from p_assignment_id or a.assignment_revision is distinct from p_assignment_revision then
    raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if private.photo_slot_max_photos(p_target_slot_id, a.cleaning_target_id) <> 10 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
  end if;
  select * into state_row from private.attempt_photo_collection_states
    where cleaning_attempt_id = a.id and target_photo_slot_id = p_target_slot_id for update;
  select * into item_row from private.attempt_photo_collection_items where id = p_photo_item_id for update;
  if state_row.revision is distinct from p_expected_collection_revision then
    raise exception using errcode = '40001', message = 'PHOTO_COLLECTION_VERSION_CONFLICT';
  end if;
  if item_row.id is null or not item_row.active or item_row.cleaning_attempt_id <> a.id
    or item_row.target_photo_slot_id <> p_target_slot_id or item_row.revision <> p_expected_item_revision then
    raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
  end if;
  if exists (
    select 1 from private.photo_upload_admissions x
    left join private.photo_upload_admission_bindings b on b.admission_id = x.id
    left join private.photo_upload_states s on s.operation_id = b.operation_id
    where x.cleaning_attempt_id = a.id and x.target_photo_slot_id = p_target_slot_id
      and ((b.operation_id is null and x.expires_at > clock_timestamp())
        or s.status in ('reserved', 'provider_succeeded', 'reconciliation_pending', 'compensation_pending'))
  ) then
    raise exception using errcode = '55000', message = 'PHOTO_UPLOAD_IN_FLIGHT';
  end if;
  next_collection_revision := state_row.revision + 1;
  next_item_revision := item_row.revision + 1;
  update private.attempt_photo_collection_states set revision = next_collection_revision
    where cleaning_attempt_id = a.id and target_photo_slot_id = p_target_slot_id;
  update private.attempt_photo_collection_items
    set revision = next_item_revision, active = false, photo_version_id = null, photo_version = null
    where id = p_photo_item_id;
  insert into private.attempt_photo_collection_changes(
    cleaning_attempt_id, cleaning_target_id, target_photo_slot_id, collection_revision,
    photo_item_id, item_revision, display_order, change_type
  ) values (
    a.id, a.cleaning_target_id, p_target_slot_id, next_collection_revision,
    p_photo_item_id, next_item_revision, item_row.display_order, 'deleted'
  );
  result := jsonb_build_object(
    'attemptId', a.id, 'targetSlotId', p_target_slot_id, 'photoItemId', p_photo_item_id,
    'collectionRevision', next_collection_revision, 'itemRevision', next_item_revision, 'deleted', true
  );
  insert into private.photo_collection_commands(
    actor_profile_id, command_type, idempotency_key_digest, request_hash, photo_item_id, response_payload
  ) values (
    p_actor_profile_id, 'photo.collection.delete', p_idempotency_key_digest, p_request_hash, p_photo_item_id, result
  );
  select * into profile_row from public.profiles where id = p_actor_profile_id;
  insert into public.audit_events(
    event_type, entity_type, entity_id, actor_profile_id, actor_display_name_snapshot,
    effective_at, idempotency_key, after_state
  ) values (
    'photo.collection_item_deleted', 'cleaning_attempt', a.id, profile_row.id, profile_row.display_name,
    clock_timestamp(), 'photo-collection-delete-' || p_actor_profile_id::text || '-' || p_idempotency_key_digest,
    jsonb_build_object(
      'attemptId', a.id, 'targetSlotId', p_target_slot_id, 'photoItemId', p_photo_item_id,
      'collectionRevision', next_collection_revision, 'itemRevision', next_item_revision
    )
  );
  return result;
end
$$;

create or replace function private.photo_attempt_complete(p_attempt uuid, p_as_of timestamptz)
returns boolean language sql stable set search_path = '' as $$
select coalesce(isfinite(p_as_of) and exists (
  select 1
  from public.cleaning_attempts a
  join private.target_photo_snapshot_contracts contract on contract.cleaning_target_id = a.cleaning_target_id
  where a.id = p_attempt and a.started_at is not null and contract.ready
    and (select count(*) from private.target_photo_slot_snapshots s where s.cleaning_target_id = a.cleaning_target_id)
      = jsonb_array_length(contract.frozen_snapshot -> 'slots')
    and exists (select 1 from private.target_photo_slot_snapshots s where s.cleaning_target_id = a.cleaning_target_id and s.required)
    and not exists (
      (select value from jsonb_array_elements(contract.frozen_snapshot -> 'slots'))
      except
      (select slot_snapshot from private.target_photo_slot_snapshots s where s.cleaning_target_id = a.cleaning_target_id)
    )
    and a.template_snapshot = (select template_snapshot from public.cleaning_targets where id = a.cleaning_target_id)
    and not exists (
      select 1 from private.target_photo_slot_snapshots s
      where s.cleaning_target_id = a.cleaning_target_id and s.required
        and private.photo_slot_max_photos(s.id, a.cleaning_target_id) = 1
        and not exists (
          select 1 from private.attempt_photo_current c
          join private.attempt_photo_versions p on p.id = c.photo_version_id
          where c.cleaning_attempt_id = a.id and c.target_photo_slot_id = s.id
            and p.validation_status = 'verified' and p.uploaded_at >= a.started_at
            and p.uploaded_at <= p_as_of and p.purge_after > p_as_of
            and not exists (select 1 from private.attempt_photo_purge_states x where x.photo_version_id = p.id)
        )
    )
    and not exists (
      select 1 from private.attempt_photo_current c
      join private.attempt_photo_versions p on p.id = c.photo_version_id
      where c.cleaning_attempt_id = a.id
        and (private.photo_slot_max_photos(c.target_photo_slot_id, a.cleaning_target_id) <> 1
          or p.validation_status <> 'verified' or p.uploaded_at < a.started_at
          or p.uploaded_at > p_as_of or p.purge_after <= p_as_of
          or exists (select 1 from private.attempt_photo_purge_states x where x.photo_version_id = p.id))
    )
    and not exists (
      select 1 from private.attempt_photo_collection_items i
      join private.attempt_photo_versions p on p.id = i.photo_version_id
      where i.cleaning_attempt_id = a.id and i.active
        and (private.photo_slot_max_photos(i.target_photo_slot_id, a.cleaning_target_id) <> 10
          or p.validation_status <> 'verified' or p.uploaded_at < a.started_at
          or p.uploaded_at > p_as_of or p.purge_after <= p_as_of
          or exists (select 1 from private.attempt_photo_purge_states x where x.photo_version_id = p.id))
    )
), false)
$$;

create or replace function private.guard_submission_photo_binding()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from private.submission_photo_binding_sets where submission_id = new.submission_id) then
    raise exception using errcode = '55000', message = 'SUBMISSION_PHOTO_BINDING_INVALID';
  end if;
  if new.collection_item_id is null then
    if not exists (
      select 1 from private.attempt_photo_current c
      join private.attempt_photo_versions p on p.id = c.photo_version_id
      where c.cleaning_attempt_id = new.cleaning_attempt_id
        and c.target_photo_slot_id = new.target_photo_slot_id
        and c.photo_version_id = new.photo_version_id and c.photo_version = new.photo_version
        and c.cleaning_target_id = new.cleaning_target_id
        and p.validation_status = 'verified' and p.purge_after > clock_timestamp()
        and not exists (select 1 from private.attempt_photo_purge_states x where x.photo_version_id = p.id)
    ) then
      raise exception using errcode = '55000', message = 'SUBMISSION_PHOTO_BINDING_INVALID';
    end if;
  elsif not exists (
    select 1 from private.attempt_photo_collection_items i
    join private.attempt_photo_versions p on p.id = i.photo_version_id
    where i.id = new.collection_item_id and i.cleaning_attempt_id = new.cleaning_attempt_id
      and i.cleaning_target_id = new.cleaning_target_id and i.target_photo_slot_id = new.target_photo_slot_id
      and i.active and i.revision = new.item_revision and i.display_order = new.item_display_order
      and i.photo_version_id = new.photo_version_id and i.photo_version = new.photo_version
      and p.validation_status = 'verified' and p.purge_after > clock_timestamp()
      and not exists (select 1 from private.attempt_photo_purge_states x where x.photo_version_id = p.id)
  ) then
    raise exception using errcode = '55000', message = 'SUBMISSION_PHOTO_BINDING_INVALID';
  end if;
  return new;
end
$$;

create or replace function private.guard_submission_photo_seal()
returns trigger language plpgsql set search_path = '' as $$
begin
  if not private.photo_attempt_complete(new.cleaning_attempt_id, clock_timestamp())
    or new.photo_count <> (select count(*) from private.submission_photo_bindings where submission_id = new.submission_id)
    or exists (
      (select target_photo_slot_id, photo_version_id, photo_version, null::uuid, null::bigint, null::integer
        from private.attempt_photo_current
        where cleaning_attempt_id = new.cleaning_attempt_id and photo_version_id is not null
       union all
       select target_photo_slot_id, photo_version_id, photo_version, id, revision, display_order
        from private.attempt_photo_collection_items
        where cleaning_attempt_id = new.cleaning_attempt_id and active)
      except
      (select target_photo_slot_id, photo_version_id, photo_version, collection_item_id, item_revision, item_display_order
        from private.submission_photo_bindings where submission_id = new.submission_id)
    )
    or exists (
      (select target_photo_slot_id, photo_version_id, photo_version, collection_item_id, item_revision, item_display_order
        from private.submission_photo_bindings where submission_id = new.submission_id)
      except
      (select target_photo_slot_id, photo_version_id, photo_version, null::uuid, null::bigint, null::integer
        from private.attempt_photo_current
        where cleaning_attempt_id = new.cleaning_attempt_id and photo_version_id is not null
       union all
       select target_photo_slot_id, photo_version_id, photo_version, id, revision, display_order
        from private.attempt_photo_collection_items
        where cleaning_attempt_id = new.cleaning_attempt_id and active)
    ) then
    raise exception using errcode = '55000', message = 'PHOTO_EVIDENCE_INCOMPLETE';
  end if;
  return new;
end
$$;

create or replace function private.bind_submission_photo_model(p_actor uuid, p_submission uuid, p_expected_revision bigint)
returns bigint language plpgsql set search_path = '' as $$
declare
  s public.cleaning_submissions;
  a public.cleaning_attempts;
  current_row private.submission_current_pointers;
begin
  select * into s from public.cleaning_submissions where id = p_submission;
  if s.id is null then raise exception using errcode = '23514', message = 'SUBMISSION_INVALID'; end if;
  a := private.assert_photo_model_actor(p_actor, s.cleaning_attempt_id, 'submit');
  select * into s from public.cleaning_submissions where id = p_submission for update;
  select * into current_row from private.submission_current_pointers where cleaning_attempt_id = a.id;
  if p_expected_revision is null or p_expected_revision < 0 or coalesce(current_row.revision, 0) <> p_expected_revision then
    raise exception using errcode = '40001', message = 'SUBMISSION_VERSION_CONFLICT';
  end if;
  if s.submitted_by <> p_actor or s.status <> 'submitted'
    or s.version <= coalesce((select version from public.cleaning_submissions where id = current_row.submission_id), 0)
    or exists (select 1 from private.submission_photo_bindings where submission_id = s.id) then
    raise exception using errcode = '23514', message = 'SUBMISSION_INVALID';
  end if;
  if not private.photo_attempt_complete(a.id, clock_timestamp()) then
    raise exception using errcode = '55000', message = 'PHOTO_EVIDENCE_INCOMPLETE';
  end if;
  insert into private.submission_photo_bindings(
    submission_id, cleaning_attempt_id, cleaning_target_id, target_photo_slot_id,
    photo_version_id, photo_version, collection_item_id, item_revision, item_display_order
  )
  select s.id, a.id, a.cleaning_target_id, c.target_photo_slot_id,
    c.photo_version_id, c.photo_version, null, null, null
  from private.attempt_photo_current c
  where c.cleaning_attempt_id = a.id and c.photo_version_id is not null
  union all
  select s.id, a.id, a.cleaning_target_id, i.target_photo_slot_id,
    i.photo_version_id, i.photo_version, i.id, i.revision, i.display_order
  from private.attempt_photo_collection_items i
  where i.cleaning_attempt_id = a.id and i.active;
  insert into private.submission_photo_binding_sets(submission_id, cleaning_attempt_id, photo_count)
    select s.id, a.id, count(*) from private.submission_photo_bindings where submission_id = s.id;
  if current_row.revision is null then
    insert into private.submission_current_pointers(cleaning_attempt_id, submission_id, revision) values (a.id, s.id, 1);
  else
    update private.submission_current_pointers set submission_id = s.id, revision = p_expected_revision + 1
      where cleaning_attempt_id = a.id;
  end if;
  return p_expected_revision + 1;
end
$$;

create or replace function public.get_attempt_photo_slots(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_attempt_id uuid
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.cleaning_attempts;
  p public.profiles;
  ass public.cleaning_assignments;
  t public.cleaning_targets;
  may_read boolean;
  at_time timestamptz;
  slot_rows jsonb;
begin
  a := private.assert_photo_upload_actor(p_actor_profile_id, p_session_id, p_attempt_id);
  select * into p from public.profiles where id = p_actor_profile_id;
  select * into ass from public.cleaning_assignments where id = a.assignment_id;
  select * into t from public.cleaning_targets where id = a.cleaning_target_id;
  at_time := clock_timestamp();
  if not exists (select 1 from private.target_photo_snapshot_contracts where cleaning_target_id = a.cleaning_target_id and ready) then
    raise exception using errcode = '23514', message = 'PHOTO_SLOT_INVALID';
  end if;
  may_read := p.status = 'active' and ass.is_current and ass.ended_at is null and ass.notified_at is not null
    and ass.revision = a.assignment_revision and t.assignment_version = a.assignment_revision
    and t.status <> 'cancelled' and a.status not in ('interrupted', 'superseded');

  select jsonb_agg(jsonb_build_object(
    'slotId', sl.id,
    'slotKey', sl.slot_key,
    'required', sl.required,
    'displayOrder', sl.display_order,
    'maxPhotos', private.photo_slot_max_photos(sl.id, a.cleaning_target_id),
    'currentRevision', case when private.photo_slot_max_photos(sl.id, a.cleaning_target_id) = 10
      then coalesce(collection_state.revision, 0) else coalesce(cur.revision, 0) end,
    'collectionRevision', case when private.photo_slot_max_photos(sl.id, a.cleaning_target_id) = 10
      then coalesce(collection_state.revision, 0) else null end,
    'photoCount', case when private.photo_slot_max_photos(sl.id, a.cleaning_target_id) = 10
      then (select count(*) from private.attempt_photo_collection_items ci
        where ci.cleaning_attempt_id = a.id and ci.target_photo_slot_id = sl.id and ci.active)
      else case when cur.photo_version_id is null then 0 else 1 end end,
    'uploadStatus', case
      when private.photo_slot_max_photos(sl.id, a.cleaning_target_id) = 10 then
        case
          when not exists (select 1 from private.attempt_photo_collection_items ci
            where ci.cleaning_attempt_id = a.id and ci.target_photo_slot_id = sl.id and ci.active) then 'missing'
          when exists (select 1 from private.attempt_photo_collection_items ci
            join private.attempt_photo_purge_states cps on cps.photo_version_id = ci.photo_version_id
            where ci.cleaning_attempt_id = a.id and ci.target_photo_slot_id = sl.id and ci.active) then 'purged'
          when exists (select 1 from private.attempt_photo_collection_items ci
            join private.attempt_photo_versions cp on cp.id = ci.photo_version_id
            where ci.cleaning_attempt_id = a.id and ci.target_photo_slot_id = sl.id and ci.active and cp.purge_after <= at_time) then 'expired'
          when exists (select 1 from private.attempt_photo_collection_items ci
            join private.attempt_photo_versions cp on cp.id = ci.photo_version_id
            where ci.cleaning_attempt_id = a.id and ci.target_photo_slot_id = sl.id and ci.active and cp.validation_status <> 'verified') then 'failed'
          else 'verified'
        end
      else case when cur.photo_version_id is null then case when cur.revision is null then 'missing' else 'cleared' end
        when purge.photo_version_id is not null then 'purged'
        when ph.purge_after <= at_time then 'expired' else ph.validation_status end
      end,
    'photoId', case when private.photo_slot_max_photos(sl.id, a.cleaning_target_id) = 1
      and may_read and acc.photo_version_id is not null and ph.validation_status = 'verified'
      and ph.purge_after > at_time and purge.photo_version_id is null then ph.id else null end,
    'photos', case when private.photo_slot_max_photos(sl.id, a.cleaning_target_id) = 10 then
      coalesce((select jsonb_agg(jsonb_build_object(
        'photoItemId', ci.id,
        'itemRevision', ci.revision,
        'displayOrder', ci.display_order,
        'photoId', case when may_read and ca.photo_version_id is not null and cp.validation_status = 'verified'
          and cp.purge_after > at_time and cps.photo_version_id is null then cp.id else null end,
        'photoVersion', ci.photo_version,
        'uploadStatus', case when cps.photo_version_id is not null then 'purged'
          when cp.purge_after <= at_time then 'expired' else cp.validation_status end
      ) order by ci.display_order, ci.id)
      from private.attempt_photo_collection_items ci
      join private.attempt_photo_versions cp on cp.id = ci.photo_version_id
      left join private.attempt_photo_purge_states cps on cps.photo_version_id = cp.id
      left join private.photo_upload_acceptances ca on ca.photo_version_id = cp.id
      where ci.cleaning_attempt_id = a.id and ci.target_photo_slot_id = sl.id and ci.active), '[]'::jsonb)
    else case when cur.photo_version_id is null then '[]'::jsonb else jsonb_build_array(jsonb_build_object(
      'photoItemId', null,
      'itemRevision', cur.revision,
      'displayOrder', 0,
      'photoId', case when may_read and acc.photo_version_id is not null and ph.validation_status = 'verified'
        and ph.purge_after > at_time and purge.photo_version_id is null then ph.id else null end,
      'photoVersion', cur.photo_version,
      'uploadStatus', case when purge.photo_version_id is not null then 'purged'
        when ph.purge_after <= at_time then 'expired' else ph.validation_status end
    )) end end
  ) order by sl.display_order, sl.id) into slot_rows
  from private.target_photo_slot_snapshots sl
  left join private.attempt_photo_current cur on cur.cleaning_attempt_id = a.id and cur.target_photo_slot_id = sl.id
  left join private.attempt_photo_versions ph on ph.id = cur.photo_version_id
  left join private.attempt_photo_purge_states purge on purge.photo_version_id = ph.id
  left join private.photo_upload_acceptances acc on acc.photo_version_id = ph.id
  left join private.attempt_photo_collection_states collection_state
    on collection_state.cleaning_attempt_id = a.id and collection_state.target_photo_slot_id = sl.id
  where sl.cleaning_target_id = a.cleaning_target_id;
  return jsonb_build_object(
    'attemptId', a.id, 'assignmentId', a.assignment_id,
    'assignmentRevision', a.assignment_revision, 'slots', coalesce(slot_rows, '[]'::jsonb)
  );
end
$$;

create or replace function public.get_cleaning_submission(p_actor_profile_id uuid, p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  p public.profiles;
  s public.cleaning_submissions;
  report private.bomb_room_reports;
  evidence_count integer;
  evidence_ids uuid[];
  photos jsonb;
  photo_slots jsonb;
  result jsonb;
begin
  select * into p from public.profiles where id = p_actor_profile_id and status = 'active';
  select * into s from public.cleaning_submissions where id = p_submission_id;
  if p.id is null or p.must_change_password or s.id is null or p.role <> 'admin' then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  result := private.submission_projection(s.id)
    || jsonb_build_object('reviewContext', private.submission_review_context(s.id));
  select coalesce(jsonb_agg(jsonb_build_object(
    'photoId', binding.photo_version_id,
    'photoItemId', binding.collection_item_id,
    'itemRevision', binding.item_revision,
    'photoDisplayOrder', binding.item_display_order,
    'targetPhotoSlotId', binding.target_photo_slot_id,
    'slotKey', slot.slot_key,
    'label', slot.slot_snapshot ->> 'label',
    'displayOrder', slot.display_order,
    'required', slot.required,
    'photoVersion', binding.photo_version
  ) order by slot.display_order, coalesce(binding.item_display_order, 0), binding.photo_version_id), '[]'::jsonb)
  into photos
  from private.submission_photo_bindings binding
  join private.target_photo_slot_snapshots slot on slot.id = binding.target_photo_slot_id
  where binding.submission_id = s.id;

  select coalesce(jsonb_agg(jsonb_build_object(
    'targetPhotoSlotId', grouped.target_photo_slot_id,
    'slotKey', grouped.slot_key,
    'label', grouped.label,
    'displayOrder', grouped.display_order,
    'required', grouped.required,
    'photos', grouped.photos
  ) order by grouped.display_order, grouped.target_photo_slot_id), '[]'::jsonb)
  into photo_slots
  from (
    select slot.id as target_photo_slot_id, slot.slot_key, slot.slot_snapshot ->> 'label' as label,
      slot.display_order, slot.required,
      jsonb_agg(jsonb_build_object(
        'photoId', binding.photo_version_id,
        'photoItemId', binding.collection_item_id,
        'itemRevision', binding.item_revision,
        'displayOrder', coalesce(binding.item_display_order, 0),
        'photoVersion', binding.photo_version
      ) order by coalesce(binding.item_display_order, 0), binding.photo_version_id) as photos
    from private.submission_photo_bindings binding
    join private.target_photo_slot_snapshots slot on slot.id = binding.target_photo_slot_id
    where binding.submission_id = s.id
    group by slot.id, slot.slot_key, slot.slot_snapshot, slot.display_order, slot.required
  ) grouped;
  result := result || jsonb_build_object('photos', photos, 'photoSlots', photo_slots);
  select r.* into report from private.bomb_room_report_seals seal
    join private.bomb_room_reports r on r.id = seal.report_id where seal.submission_id = s.id;
  if report.id is not null then
    select count(*), array_agg(e.photo_version_id order by e.photo_version_id)
      into evidence_count, evidence_ids
    from private.bomb_room_report_evidence e where e.report_id = report.id;
    result := result || jsonb_build_object('bombReport', jsonb_build_object(
      'id', report.id, 'attemptId', report.cleaning_attempt_id, 'memo', report.memo,
      'evidenceCount', evidence_count, 'evidencePhotoIds', to_jsonb(evidence_ids), 'reportedAt', report.reported_at
    ));
  end if;
  return result;
end
$$;

-- Bomb reports accept any currently selected verified photo, including an
-- active item in the v8 extra-proof collection. The report still seals the
-- immutable photo version UUID rather than the mutable collection item.
create or replace function public.report_bomb_room(
  p_actor_profile_id uuid,
  p_attempt_id uuid,
  p_evidence_photo_ids uuid[],
  p_memo text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.cleaning_attempts;
  t public.cleaning_targets;
  p public.profiles;
  replay jsonb;
  result jsonb;
  rid uuid;
  report_time timestamptz;
begin
  replay := private.replay_command(
    p_actor_profile_id, 'submission.report_bomb_room', p_idempotency_key, p_request_hash
  );
  a := private.submission_receipt_actor(p_actor_profile_id, p_attempt_id);
  if replay is not null then return replay; end if;
  a := private.bomb_report_actor(p_actor_profile_id, p_attempt_id);
  select * into t from public.cleaning_targets where id = a.cleaning_target_id for update;
  select * into p from public.profiles where id = p_actor_profile_id;
  if t.source = 'inspection_reclean' then
    raise exception using errcode = '55000', message = 'BOMB_REPORT_NOT_ALLOWED';
  end if;
  if exists (select 1 from private.bomb_room_reports existing where existing.cleaning_attempt_id = a.id)
    or exists (select 1 from private.submission_current_pointers where cleaning_attempt_id = a.id)
    or p_evidence_photo_ids is null or cardinality(p_evidence_photo_ids) not between 1 and 20
    or cardinality(p_evidence_photo_ids) <> (select count(distinct x) from unnest(p_evidence_photo_ids) x)
    or nullif(btrim(p_memo), '') is null or char_length(p_memo) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_BOMB_REPORT';
  end if;
  if exists (
    select 1
    from unnest(p_evidence_photo_ids) x
    where not exists (
      select 1
      from private.attempt_photo_versions v
      where v.id = x
        and v.cleaning_attempt_id = a.id
        and v.validation_status = 'verified'
        and v.purge_after > clock_timestamp()
        and not exists (
          select 1 from private.attempt_photo_purge_states ps where ps.photo_version_id = v.id
        )
        and (
          exists (
            select 1 from private.attempt_photo_current c
            where c.cleaning_attempt_id = a.id and c.photo_version_id = v.id
          )
          or exists (
            select 1 from private.attempt_photo_collection_items i
            where i.cleaning_attempt_id = a.id and i.active and i.photo_version_id = v.id
          )
        )
    )
  ) then
    raise exception using errcode = '23514', message = 'BOMB_EVIDENCE_INVALID';
  end if;
  insert into private.bomb_room_reports(cleaning_attempt_id, reported_by, memo)
    values (a.id, p_actor_profile_id, p_memo)
    returning id, reported_at into rid, report_time;
  insert into private.bomb_room_report_evidence(report_id, photo_version_id)
    select rid, x from unnest(p_evidence_photo_ids) x;
  result := jsonb_build_object(
    'id', rid, 'attemptId', a.id,
    'evidenceCount', cardinality(p_evidence_photo_ids), 'reportedAt', report_time
  );
  insert into public.audit_events(
    event_type, entity_type, entity_id, actor_profile_id, actor_display_name_snapshot,
    effective_at, after_state, idempotency_key
  ) values (
    'submission.bomb_reported', 'bomb_room_report', rid, p.id, p.display_name, report_time,
    jsonb_build_object('attemptId', a.id, 'evidenceCount', cardinality(p_evidence_photo_ids)),
    private.audit_command_key(p_actor_profile_id, 'submission.report_bomb_room', p_idempotency_key)
  );
  perform private.complete_command(
    p_actor_profile_id, 'submission.report_bomb_room', p_idempotency_key, p_request_hash, rid, result
  );
  return result;
end
$$;

-- Extend the bounded developer audit projection. photo.upload_accepted is
-- intercepted as well so collection identity/revisions are not stripped by
-- the older single-photo projection.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_extra_proof_collection;
revoke all on function private.list_developer_audit_events_before_extra_proof_collection(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated, service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table(
  id uuid, event_type text, entity_type text, entity_id uuid,
  actor_profile_id uuid, actor_display_name text, effective_at timestamptz,
  recorded_at timestamptz, reason_code text, summary jsonb
)
language plpgsql security definer set search_path = '' as $$
declare
  v_new_types constant text[] := array['photo.upload_accepted', 'photo.collection_item_deleted'];
  v_previous_types text[];
  v_from timestamptz := coalesce(p_from, clock_timestamp() - interval '7 days');
  v_to timestamptz := coalesce(p_to, clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types), 0) = 0 then
    raise exception using errcode = '22023', message = 'INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    v_previous_types := null;
  else
    select coalesce(array_agg(requested), array[]::text[])
      into v_previous_types
    from unnest(p_event_types) requested
    where requested <> all(v_new_types);
    if cardinality(v_previous_types) = 0 then
      v_previous_types := array['account.created'];
    end if;
  end if;

  return query
  select merged.* from (
    select previous.*
    from private.list_developer_audit_events_before_extra_proof_collection(
      p_actor_profile_id, v_previous_types, p_filter_actor_profile_id,
      p_from, p_to, p_before_recorded_at, p_before_id, p_limit
    ) previous
    where previous.event_type <> all(v_new_types)
      and (p_event_types is null or previous.event_type = any(p_event_types))
    union all
    select audit.id, audit.event_type, audit.entity_type, audit.entity_id,
      audit.actor_profile_id, audit.actor_display_name_snapshot,
      audit.effective_at, audit.recorded_at, audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'cleaningTargetId', audit.after_state ->> 'cleaningTargetId',
        'attemptId', audit.after_state ->> 'attemptId',
        'targetSlotId', audit.after_state ->> 'targetSlotId',
        'photoId', audit.after_state ->> 'photoId',
        'photoItemId', audit.after_state ->> 'photoItemId',
        'photoVersion', audit.after_state -> 'photoVersion',
        'collectionRevision', audit.after_state -> 'collectionRevision',
        'itemRevision', audit.after_state -> 'itemRevision',
        'uploadedAt', audit.after_state ->> 'uploadedAt',
        'purgeAfter', audit.after_state ->> 'purgeAfter'
      ))
    from public.audit_events audit
    where audit.event_type = any(v_new_types)
      and (p_event_types is null or audit.event_type = any(p_event_types))
      and audit.recorded_at >= v_from and audit.recorded_at <= v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id = p_filter_actor_profile_id)
      and (p_before_recorded_at is null
        or (audit.recorded_at, audit.id) < (p_before_recorded_at, p_before_id))
    order by recorded_at desc, id desc
    limit p_limit
  ) merged
  order by merged.recorded_at desc, merged.id desc
  limit p_limit;
end
$$;

revoke all on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) from public, anon, authenticated;
grant execute on function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) to service_role;

revoke all on function public.admit_photo_collection_upload(uuid, uuid, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text),
  public.begin_admitted_photo_collection_upload(uuid, uuid, uuid, text, text, integer, text, text),
  public.delete_photo_collection_item(uuid, uuid, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, text)
from public, anon, authenticated;
grant execute on function public.admit_photo_collection_upload(uuid, uuid, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text),
  public.begin_admitted_photo_collection_upload(uuid, uuid, uuid, text, text, integer, text, text),
  public.delete_photo_collection_item(uuid, uuid, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, text)
to service_role;
