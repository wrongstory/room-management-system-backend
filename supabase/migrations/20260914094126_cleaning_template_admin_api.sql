-- #156: active business administrators can inspect and publish immutable
-- checkout cleaning-template versions. No operational template values are
-- seeded by source; reservations continue to fail closed until configured.

-- Template catalog access is RPC-only. The service-role adapters identify the
-- JWT actor/session and the RPC repeats the live session/password/role checks.
drop policy if exists templates_read_active on public.cleaning_template_versions;
revoke all on public.cleaning_template_versions from public, anon, authenticated, service_role;

create function private.checkout_cleaning_template_projection(
  p_room_type public.room_types,
  p_template public.cleaning_template_versions
) returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'roomTypeCode', (p_room_type).code,
    'roomTypeName', (p_room_type).name,
    'cleaningKind', 'checkout',
    'configured', (p_template).id is not null,
    'expectedVersion', coalesce((p_template).version, 0),
    'currentPublished', case when (p_template).id is null then null else jsonb_build_object(
      'id', (p_template).id,
      'version', (p_template).version,
      'status', (p_template).status,
      'durationMinutes', (p_template).duration_minutes,
      'slots', (p_template).photo_slots,
      'publishedAt', (p_template).published_at,
      'createdAt', (p_template).created_at
    ) end
  )
$$;
revoke all on function private.checkout_cleaning_template_projection(
  public.room_types, public.cleaning_template_versions
) from public, anon, authenticated, service_role;

create function private.normalized_checkout_template_slots(p_slots jsonb)
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
    if not (v_slot ?& array['slotKey', 'displayOrder', 'required', 'label'])
      or exists (
        select 1 from unnest(v_keys) key
        where key <> all(array[
          'slotKey', 'displayOrder', 'required', 'label',
          'description', 'section', 'instanceKey'
        ])
      )
      or jsonb_typeof(v_slot -> 'slotKey') is distinct from 'string'
      or (v_slot ->> 'slotKey') !~ '^[a-z][a-z0-9-]{0,79}$'
      or jsonb_typeof(v_slot -> 'displayOrder') is distinct from 'number'
      or (v_slot ->> 'displayOrder') !~ '^(0|[1-9][0-9]*)$'
      or (v_slot ->> 'displayOrder')::integer > 99
      or jsonb_typeof(v_slot -> 'required') is distinct from 'boolean'
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

create function public.list_checkout_cleaning_templates(
  p_actor_profile_id uuid,
  p_session_id uuid
) returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_templates jsonb;
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true);
  select jsonb_agg(
    private.checkout_cleaning_template_projection(room_type, published)
    order by case room_type.code
      when 'standard' then 1 when 'premium' then 2
      when 'oceanPremium' then 3 when 'oceanFamily' then 4 else 5 end
  ) into v_templates
  from public.room_types room_type
  left join public.cleaning_template_versions published
    on published.room_type_id = room_type.id
   and published.cleaning_kind = 'checkout'
   and published.status = 'published'
  where room_type.code in ('standard', 'premium', 'oceanPremium', 'oceanFamily');

  if jsonb_array_length(coalesce(v_templates, '[]'::jsonb)) <> 4 then
    raise exception using errcode = '23514', message = 'ROOM_TYPE_CATALOG_INVALID';
  end if;
  return jsonb_build_object('cleaningKind', 'checkout', 'roomTypes', v_templates);
end
$$;

create function public.publish_checkout_cleaning_template(
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
    or p_duration_minutes is null or p_duration_minutes not between 1 and 10080 then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_TEMPLATE';
  end if;
  v_slots := private.normalized_checkout_template_slots(p_slots);

  v_response := private.replay_command(
    p_actor_profile_id,
    'cleaning_template.publish_checkout',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  -- One deterministic lock per room-type/kind serializes version allocation,
  -- retirement and publication without locking unrelated template catalogs.
  perform pg_advisory_xact_lock(
    hashtextextended('cleaning-template:checkout:' || p_room_type_code, 0)
  );
  select * into v_room_type
  from public.room_types
  where code = p_room_type_code
  for share;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_TYPE_NOT_FOUND';
  end if;

  select * into v_current
  from public.cleaning_template_versions
  where room_type_id = v_room_type.id
    and cleaning_kind = 'checkout'
    and status = 'published'
  for update;
  v_current_version := case when found then v_current.version else 0 end;
  if v_current_version <> p_expected_version then
    raise exception using errcode = '40001', message = 'CLEANING_TEMPLATE_VERSION_CONFLICT';
  end if;

  select coalesce(max(version), 0)::bigint
  into v_max_version
  from public.cleaning_template_versions
  where room_type_id = v_room_type.id and cleaning_kind = 'checkout';
  if v_max_version >= 2147483647 then
    raise exception using errcode = '22003', message = 'CLEANING_TEMPLATE_VERSION_EXHAUSTED';
  end if;
  v_next_version := greatest(v_max_version + 1, 7)::integer;

  v_snapshot := jsonb_build_object(
    'templateVersionId', v_template_id,
    'version', v_next_version,
    'roomTypeCode', v_room_type.code,
    'cleaningKind', 'checkout',
    'slots', v_slots
  );
  if not private.photo_snapshot_valid(v_snapshot) then
    raise exception using errcode = '23514', message = 'INVALID_CLEANING_TEMPLATE_SLOTS';
  end if;

  update public.cleaning_template_versions
  set status = 'retired'
  where id = v_current.id;

  insert into public.cleaning_template_versions(
    id, room_type_id, cleaning_kind, version, status, duration_minutes,
    photo_slots, published_at, created_by
  ) values (
    v_template_id, v_room_type.id, 'checkout', v_next_version, 'published',
    p_duration_minutes, v_slots, statement_timestamp(), p_actor_profile_id
  ) returning * into v_template;

  if (select count(*) from private.photo_template_slots slot
      where slot.template_version_id = v_template.id) <> jsonb_array_length(v_slots)
    or exists (
      (select value from jsonb_array_elements(v_slots))
      except
      (select slot.slot_snapshot from private.photo_template_slots slot
       where slot.template_version_id = v_template.id)
    ) then
    raise exception using errcode = '23514', message = 'CLEANING_TEMPLATE_NORMALIZATION_FAILED';
  end if;

  v_response := private.checkout_cleaning_template_projection(v_room_type, v_template)
    -> 'currentPublished';
  insert into public.audit_events(
    actor_profile_id, actor_display_name_snapshot, event_type, entity_type,
    entity_id, effective_at, after_state, idempotency_key
  ) values (
    p_actor_profile_id, v_actor.display_name, 'cleaning_template.published',
    'cleaning_template_version', v_template.id, v_template.published_at,
    jsonb_build_object(
      'roomTypeCode', v_room_type.code,
      'cleaningKind', 'checkout',
      'version', v_template.version,
      'durationMinutes', v_template.duration_minutes,
      'slotCount', jsonb_array_length(v_slots)
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'cleaning_template.publish_checkout',
      p_idempotency_key
    )
  );
  perform private.complete_command(
    p_actor_profile_id,
    'cleaning_template.publish_checkout',
    p_idempotency_key,
    p_request_hash,
    v_template.id,
    v_response
  );
  return v_response;
end
$$;

revoke all on function public.list_checkout_cleaning_templates(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.list_checkout_cleaning_templates(uuid, uuid) to service_role;
grant execute on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) to service_role;

comment on function public.list_checkout_cleaning_templates(uuid, uuid) is
  '#156 active business-admin/live-session checkout template catalog query. Returns all four room types and never invents an unconfigured template.';
comment on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) is '#156 scoped CAS/idempotent immutable checkout template publication. Existing published versions retire; no seed/fallback/notification is created.';

-- Extend the developer audit projection without exposing raw slots, request
-- hashes or source after_state. Publication is configuration, not an action
-- request, so no notification/outbox row is created.
alter function public.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid, text[], uuid, timestamptz, timestamptz, timestamptz, uuid, integer
) rename to list_developer_audit_events_before_cleaning_template;
revoke all on function private.list_developer_audit_events_before_cleaning_template(
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
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_types constant text[] := array['cleaning_template.published'];
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
    from private.list_developer_audit_events_before_cleaning_template(
      p_actor_profile_id, v_previous_types, p_filter_actor_profile_id,
      p_from, p_to, p_before_recorded_at, p_before_id, p_limit
    ) previous
    where p_event_types is null or previous.event_type = any(p_event_types)
    union all
    select audit.id, audit.event_type, audit.entity_type, audit.entity_id,
      audit.actor_profile_id, audit.actor_display_name_snapshot,
      audit.effective_at, audit.recorded_at, audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'roomTypeCode', audit.after_state ->> 'roomTypeCode',
        'cleaningKind', audit.after_state ->> 'cleaningKind',
        'version', audit.after_state -> 'version',
        'durationMinutes', audit.after_state -> 'durationMinutes',
        'slotCount', audit.after_state -> 'slotCount'
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
