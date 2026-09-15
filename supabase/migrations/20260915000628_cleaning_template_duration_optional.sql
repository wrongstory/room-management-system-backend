-- #165: checkout photo templates do not invent an expected cleaning duration.
-- Actual work duration is derived from attempt timestamps, while assignment
-- planning continues to use the separately confirmed duration-policy ledger.

alter table public.cleaning_template_versions
  alter column duration_minutes drop not null;

alter table public.cleaning_template_versions
  add constraint cleaning_template_duration_scope
  check (cleaning_kind = 'checkout' or duration_minutes is not null);

comment on column public.cleaning_template_versions.duration_minutes is
  'Optional legacy/planning metadata for checkout templates. Actual cleaning duration is derived from cleaning_attempts.started_at and field_completed_at; assignment preview uses assignment_duration_policy_versions.';

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
  if v_response is not null then
    return v_response;
  end if;

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
    jsonb_strip_nulls(jsonb_build_object(
      'roomTypeCode', v_room_type.code,
      'cleaningKind', 'checkout',
      'version', v_template.version,
      'durationMinutes', v_template.duration_minutes,
      'slotCount', jsonb_array_length(v_slots)
    )),
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

revoke all on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) from public, anon, authenticated;
grant execute on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) to service_role;

comment on function public.publish_checkout_cleaning_template(
  uuid, uuid, text, integer, integer, jsonb, text, text
) is '#165 scoped CAS/idempotent immutable checkout photo-template publication. duration is optional and never inferred; actual work duration and assignment planning remain separate ledgers.';
