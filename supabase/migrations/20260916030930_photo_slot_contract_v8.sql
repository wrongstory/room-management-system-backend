-- #179: adopt the confirmed frontend checkout-photo slot contract for newly
-- published templates without rewriting v7 templates or any frozen target,
-- attempt, submission, or inspection snapshot.

create or replace function private.normalized_checkout_template_slots(p_slots jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_slot jsonb;
  v_count integer;
  v_keys text[];
begin
  if jsonb_typeof(p_slots) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;
  v_count := jsonb_array_length(p_slots);
  if v_count not between 1 and 100 then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;

  for v_slot in select value from jsonb_array_elements(p_slots) loop
    if jsonb_typeof(v_slot) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
    end if;
    select array_agg(key order by key) into v_keys from jsonb_object_keys(v_slot) key;
    -- maxPhotos is required by the v8 snapshot validator below, but remains
    -- optional during normalization so an exact pre-v8 idempotency receipt can
    -- still replay before new-version validation without rewriting its payload.
    if not (v_slot ?& array['slotKey', 'displayOrder', 'required', 'label'])
      or exists (
        select 1 from unnest(v_keys) key
        where key <> all(array[
          'slotKey', 'displayOrder', 'required', 'label', 'maxPhotos',
          'description', 'section', 'instanceKey'
        ])
      )
      or jsonb_typeof(v_slot -> 'slotKey') is distinct from 'string'
      or (v_slot ->> 'slotKey') !~ '^[a-z][a-z0-9-]{0,79}$'
      or jsonb_typeof(v_slot -> 'displayOrder') is distinct from 'number'
      or (v_slot ->> 'displayOrder') !~ '^(0|[1-9][0-9]*)$'
      or (v_slot ->> 'displayOrder')::integer > 99
      or jsonb_typeof(v_slot -> 'required') is distinct from 'boolean'
      or (v_slot ? 'maxPhotos' and (
        jsonb_typeof(v_slot -> 'maxPhotos') is distinct from 'number'
        or (v_slot ->> 'maxPhotos') !~ '^[1-9][0-9]*$'
        or (v_slot ->> 'maxPhotos')::integer > 10
      ))
      or jsonb_typeof(v_slot -> 'label') is distinct from 'string'
      or char_length(v_slot ->> 'label') not between 1 and 80
      or btrim(v_slot ->> 'label') <> v_slot ->> 'label'
      or (v_slot ? 'description' and (
        jsonb_typeof(v_slot -> 'description') is distinct from 'string'
        or char_length(v_slot ->> 'description') not between 1 and 200
        or btrim(v_slot ->> 'description') <> v_slot ->> 'description'
      ))
      or (v_slot ? 'section' and (
        jsonb_typeof(v_slot -> 'section') is distinct from 'string'
        or char_length(v_slot ->> 'section') not between 1 and 80
        or btrim(v_slot ->> 'section') <> v_slot ->> 'section'
      ))
      or (v_slot ? 'instanceKey' and (
        jsonb_typeof(v_slot -> 'instanceKey') is distinct from 'string'
        or (v_slot ->> 'instanceKey') !~ '^[a-z][a-z0-9-]{0,79}$'
      )) then
      raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
    end if;
  end loop;

  if (select count(distinct value ->> 'slotKey') from jsonb_array_elements(p_slots)) <> v_count
    or (select count(distinct (value ->> 'displayOrder')::integer) from jsonb_array_elements(p_slots)) <> v_count
    or (select min((value ->> 'displayOrder')::integer) from jsonb_array_elements(p_slots)) <> 0
    or (select max((value ->> 'displayOrder')::integer) from jsonb_array_elements(p_slots)) <> v_count - 1 then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;

  return (
    select jsonb_agg(value order by (value ->> 'displayOrder')::integer, value ->> 'slotKey')
    from jsonb_array_elements(p_slots)
  );
exception
  when invalid_text_representation or numeric_value_out_of_range then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
end
$$;
revoke all on function private.normalized_checkout_template_slots(jsonb)
  from public, anon, authenticated, service_role;

create or replace function private.photo_snapshot_valid(p_snapshot jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare
  s jsonb;
  n integer;
  expected integer;
  version_number integer;
  has_any_max_photos boolean;
  has_all_max_photos boolean;
  uses_a_contract boolean;
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object'
    or jsonb_typeof(p_snapshot->'templateVersionId') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'roomTypeCode') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'cleaningKind') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'slots') is distinct from 'array'
    or jsonb_typeof(p_snapshot->'version') is distinct from 'number'
    or (p_snapshot->>'version') !~ '^[1-9][0-9]*$'
    or (p_snapshot->>'templateVersionId') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or p_snapshot->>'roomTypeCode' not in ('standard','premium','oceanPremium','oceanFamily')
    or p_snapshot->>'cleaningKind' not in ('checkout','stayover','additional','reclean')
    or not (p_snapshot ?& array['templateVersionId','version','roomTypeCode','cleaningKind','slots']) then return false; end if;
  version_number:=(p_snapshot->>'version')::integer;
  n:=jsonb_array_length(p_snapshot->'slots');
  if n<1 or n>100 then return false; end if;
  select bool_or(value ? 'maxPhotos'), bool_and(value ? 'maxPhotos')
  into has_any_max_photos, has_all_max_photos
  from jsonb_array_elements(p_snapshot->'slots');
  if p_snapshot->>'cleaningKind'='checkout' and version_number>=7 and (
    has_any_max_photos is distinct from has_all_max_photos
    or (version_number<8 and has_any_max_photos)
  ) then return false; end if;
  uses_a_contract:=p_snapshot->>'cleaningKind'='checkout'
    and version_number>=8 and has_all_max_photos;
  for s in select value from jsonb_array_elements(p_snapshot->'slots') loop
    if jsonb_typeof(s) is distinct from 'object'
      or not(s ?& array['slotKey','required','displayOrder'])
      or jsonb_typeof(s->'slotKey') is distinct from 'string'
      or (s->>'slotKey') !~ '^[a-z][a-z0-9-]{0,79}$'
      or jsonb_typeof(s->'required') is distinct from 'boolean'
      or jsonb_typeof(s->'displayOrder') is distinct from 'number'
      or (s->>'displayOrder') !~ '^(0|[1-9][0-9]*)$'
      or (s->>'displayOrder')::integer>99
      or (s ? 'maxPhotos' and (
        jsonb_typeof(s->'maxPhotos') is distinct from 'number'
        or (s->>'maxPhotos') !~ '^[1-9][0-9]*$'
        or (s->>'maxPhotos')::integer>10
      )) then return false; end if;
  end loop;
  if (select count(distinct value->>'slotKey') from jsonb_array_elements(p_snapshot->'slots'))<>n
    or (select count(distinct (value->>'displayOrder')::integer) from jsonb_array_elements(p_snapshot->'slots'))<>n then return false; end if;
  if not exists(select 1 from jsonb_array_elements(p_snapshot->'slots') where (value->>'required')::boolean) then return false; end if;
  if p_snapshot->>'cleaningKind'='checkout' and version_number>=7 then
    expected:=case p_snapshot->>'roomTypeCode'
      when 'standard' then case when uses_a_contract then 9 else 10 end
      when 'premium' then case when uses_a_contract then 10 else 11 end
      when 'oceanPremium' then case when uses_a_contract then 12 else 13 end
      else case when uses_a_contract then 14 else 15 end end;
    if n<>expected or (select count(*) from jsonb_array_elements(p_snapshot->'slots') where (value->>'required')::boolean)<>expected-1 then return false; end if;
    if (select count(*) from jsonb_array_elements(p_snapshot->'slots') where value->>'slotKey'='tv-on' and (value->>'required')::boolean)<>1 then return false; end if;
    if uses_a_contract and (
      exists(select 1 from jsonb_array_elements(p_snapshot->'slots') where value->>'slotKey'='entry-number')
      or (select count(*) from jsonb_array_elements(p_snapshot->'slots') where value->>'slotKey'='entry-storage' and (value->>'required')::boolean)<>1
      or (select count(*) from jsonb_array_elements(p_snapshot->'slots') where value->>'slotKey'='extra-proof' and not (value->>'required')::boolean and (value->>'displayOrder')::integer=expected-1 and jsonb_typeof(value->'maxPhotos')='number' and value->>'maxPhotos'='10')<>1
      or exists(select 1 from jsonb_array_elements(p_snapshot->'slots') where value->>'slotKey'<>'extra-proof' and (jsonb_typeof(value->'maxPhotos') is distinct from 'number' or value->>'maxPhotos'<>'1'))
    ) then return false; end if;
  end if;
  return true;
exception when invalid_text_representation or numeric_value_out_of_range then return false;
end; $$;
revoke all on function private.photo_snapshot_valid(jsonb) from public,anon,authenticated,service_role;

create or replace function public.publish_checkout_cleaning_template(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_room_type_code text,
  p_expected_version integer,
  p_duration_minutes integer,
  p_slots jsonb,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles%rowtype;
  v_room_type public.room_types%rowtype;
  v_current public.cleaning_template_versions%rowtype;
  v_template public.cleaning_template_versions%rowtype;
  v_template_id uuid := gen_random_uuid();
  v_current_version integer;
  v_next_version integer;
  v_max_version bigint;
  v_slots jsonb;
  v_snapshot jsonb;
  v_response jsonb;
begin
  v_actor := private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true);
  if p_room_type_code is null
    or p_room_type_code not in ('standard', 'premium', 'oceanPremium', 'oceanFamily')
    or p_expected_version is null or p_expected_version < 0
    or (p_duration_minutes is not null and p_duration_minutes not between 1 and 10080) then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE';
  end if;
  v_slots := private.normalized_checkout_template_slots(p_slots);

  v_response := private.replay_command(
    p_actor_profile_id,
    'cleaning_template.publish_checkout',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then return v_response; end if;

  -- A completed pre-A command may replay above with its exact maxPhotos-less
  -- request. Once no receipt exists, every fresh publication must use the
  -- complete A-contract metadata; historical shape is never a publication
  -- fallback merely because its version/count remains readable.
  if exists (
    select 1 from jsonb_array_elements(v_slots) slot
    where not (slot ? 'maxPhotos')
  ) then
    raise exception using errcode = '23514', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cleaning-template:checkout:' || p_room_type_code, 0));
  select * into v_room_type from public.room_types where code = p_room_type_code for share;
  if not found then raise exception using errcode = 'P0002', message = 'ROOM_TYPE_NOT_FOUND'; end if;

  select * into v_current
  from public.cleaning_template_versions
  where room_type_id = v_room_type.id and cleaning_kind = 'checkout' and status = 'published'
  for update;
  v_current_version := case when found then v_current.version else 0 end;
  if v_current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'CLEANING_TEMPLATE_VERSION_CONFLICT';
  end if;

  select coalesce(max(version), 0)::bigint into v_max_version
  from public.cleaning_template_versions
  where room_type_id = v_room_type.id and cleaning_kind = 'checkout';
  if v_max_version >= 2147483647 then
    raise exception using errcode = '22003', message = 'CLEANING_TEMPLATE_VERSION_EXHAUSTED';
  end if;
  v_next_version := greatest(v_max_version + 1, 8)::integer;

  v_snapshot := jsonb_build_object(
    'templateVersionId', v_template_id, 'version', v_next_version,
    'roomTypeCode', v_room_type.code, 'cleaningKind', 'checkout', 'slots', v_slots
  );
  if not private.photo_snapshot_valid(v_snapshot) then
    raise exception using errcode = '23514', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;

  update public.cleaning_template_versions set status = 'retired' where id = v_current.id;
  insert into public.cleaning_template_versions(
    id, room_type_id, cleaning_kind, version, status, duration_minutes,
    photo_slots, published_at, created_by
  ) values (
    v_template_id, v_room_type.id, 'checkout', v_next_version, 'published',
    p_duration_minutes, v_slots, statement_timestamp(), p_actor_profile_id
  ) returning * into v_template;

  if (select count(*) from private.photo_template_slots slot where slot.template_version_id = v_template.id) <> jsonb_array_length(v_slots)
    or exists (
      (select value from jsonb_array_elements(v_slots))
      except
      (select slot.slot_snapshot from private.photo_template_slots slot where slot.template_version_id = v_template.id)
    ) then
    raise exception using errcode = '23514', message = 'CLEANING_TEMPLATE_NORMALIZATION_FAILED';
  end if;

  v_response := private.checkout_cleaning_template_projection(v_room_type, v_template) -> 'currentPublished';
  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, idempotency_key
  ) values (
    p_actor_profile_id, v_actor.display_name, 'cleaning_template.published',
    'cleaning_template_version', v_template.id, v_template.published_at,
    jsonb_strip_nulls(jsonb_build_object(
      'roomTypeCode', v_room_type.code, 'cleaningKind', 'checkout',
      'version', v_template.version, 'durationMinutes', v_template.duration_minutes,
      'slotCount', jsonb_array_length(v_slots)
    )),
    private.audit_command_key(p_actor_profile_id, 'cleaning_template.publish_checkout', p_idempotency_key)
  );
  perform private.complete_command(
    p_actor_profile_id, 'cleaning_template.publish_checkout', p_idempotency_key,
    p_request_hash, v_template.id, v_response
  );
  return v_response;
end
$$;

revoke all on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) to service_role;

comment on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) is '#179 scoped CAS/idempotent immutable checkout photo-template publication. New A-contract publications start at v8 and use 9/10/12/14 slots; pre-A v7+ history without maxPhotos remains valid and untouched.';
