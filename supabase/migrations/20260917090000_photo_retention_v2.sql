-- #9 Stage 1: domain-anchored photo media retention.
-- Provider bytes are temporary. Immutable application metadata and domain
-- evidence links remain after the provider object is purged.
-- This semantic nullable-retention expansion is published by the source
-- OpenAPI 0.4.0 release candidate; production 0.3.0 is unchanged here.

create table private.photo_retention_records (
  object_id uuid primary key references private.photo_provider_objects(id) on delete restrict,
  operation_id uuid not null unique references private.photo_upload_operations(id) on delete restrict,
  photo_version_id uuid unique references private.attempt_photo_versions(id) on delete restrict,
  performer_maid_profile_id uuid references public.profiles(id) on delete restrict,
  effective_policy_kind text not null check (effective_policy_kind in (
    'cleaning_submission','room_issue','complaint','interruption','sync_conflict','mixed','orphan'
  )),
  retention_starts_at timestamptz,
  expires_at timestamptz,
  purged_at timestamptz,
  media_availability text not null check (media_availability in ('available','purged','unavailable')),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default clock_timestamp(),
  check (retention_starts_at is null or isfinite(retention_starts_at)),
  check (expires_at is null or isfinite(expires_at)),
  check (purged_at is null or isfinite(purged_at)),
  check ((effective_policy_kind = 'orphan') = (retention_starts_at is not null and expires_at is not null)
    or effective_policy_kind <> 'orphan'),
  check ((media_availability = 'purged') = (purged_at is not null)),
  check (expires_at is null or retention_starts_at is not null),
  check (expires_at is null or expires_at >= retention_starts_at)
);
create index photo_retention_due_idx on private.photo_retention_records(expires_at, object_id)
  where media_availability = 'available' and expires_at is not null;
create index photo_retention_performer_idx on private.photo_retention_records(performer_maid_profile_id, object_id);

-- A provider DELETE is authorized only after an exact, durable permit has
-- been recorded.  The marker remains present across uncertain provider
-- outcomes and retries so a domain link can never be attached after bytes may
-- already have been removed.
alter table private.photo_purge_jobs
  add column delete_prepared_version integer,
  add column delete_prepared_claim_digest text,
  add column delete_prepared_expires_at timestamptz,
  add column delete_prepared_at timestamptz,
  add constraint photo_purge_delete_prepared_check check (
    (delete_prepared_version is null and delete_prepared_claim_digest is null
      and delete_prepared_expires_at is null and delete_prepared_at is null)
    or (delete_prepared_version between 1 and 8
      and delete_prepared_claim_digest ~ '^[0-9a-f]{64}$'
      and isfinite(delete_prepared_expires_at) and isfinite(delete_prepared_at))
  );

create table private.photo_retention_links (
  id uuid primary key default gen_random_uuid(),
  object_id uuid not null references private.photo_retention_records(object_id) on delete restrict,
  policy_kind text not null check (policy_kind in (
    'cleaning_submission','room_issue','complaint','interruption','sync_conflict'
  )),
  domain_kind text not null check (domain_kind in (
    'cleaning_attempt','cleaning_submission','room_issue','complaint_case','attempt_handover','offline_event'
  )),
  domain_id uuid not null,
  performer_maid_profile_id uuid references public.profiles(id) on delete restrict,
  retention_starts_at timestamptz,
  expires_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  retired_at timestamptz,
  check (retention_starts_at is null or isfinite(retention_starts_at)),
  check (expires_at is null or isfinite(expires_at)),
  check (expires_at is null or (retention_starts_at is not null and expires_at > retention_starts_at)),
  check ((active and retired_at is null) or (not active and retired_at is not null)),
  unique (object_id, policy_kind, domain_kind, domain_id)
);
create index photo_retention_links_object_active_idx on private.photo_retention_links(object_id, active, expires_at);
create index photo_retention_links_domain_idx on private.photo_retention_links(policy_kind, domain_kind, domain_id);

alter table private.photo_retention_records enable row level security;
alter table private.photo_retention_links enable row level security;
revoke all on table private.photo_retention_records from public, anon, authenticated, service_role;
revoke all on table private.photo_retention_links from public, anon, authenticated, service_role;

create function private.photo_media_usable(p_photo_version_id uuid, p_as_of timestamptz)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(isfinite(p_as_of) and exists (
    select 1
    from private.attempt_photo_versions photo
    left join private.photo_upload_acceptances acceptance on acceptance.photo_version_id = photo.id
    left join private.photo_retention_records retention on retention.object_id = acceptance.object_id
    where photo.id = p_photo_version_id and photo.validation_status = 'verified'
      and not exists (select 1 from private.attempt_photo_purge_states purged where purged.photo_version_id = photo.id)
      and case when retention.object_id is null
        then photo.purge_after > p_as_of
        else retention.media_availability = 'available'
          and (retention.expires_at is null or retention.expires_at > p_as_of)
      end
  ), false)
$$;
revoke all on function private.photo_media_usable(uuid,timestamptz) from public, anon, authenticated, service_role;

create function private.photo_retention_metadata(p_photo_version_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select case when retention.object_id is null then jsonb_build_object(
      'retentionPolicy', 'legacy_upload',
      'retentionStartsAt', photo.uploaded_at,
      'expiresAt', photo.purge_after,
      'purgedAt', purge_state.purged_at,
      'mediaAvailability', case when purge_state.photo_version_id is not null then 'purged'
        when photo.purge_after <= clock_timestamp() then 'unavailable' else 'available' end
    ) else jsonb_build_object(
      'retentionPolicy', retention.effective_policy_kind,
      'retentionStartsAt', retention.retention_starts_at,
      'expiresAt', retention.expires_at,
      'purgedAt', retention.purged_at,
      'mediaAvailability', retention.media_availability
    ) end
  from private.attempt_photo_versions photo
  left join private.photo_upload_acceptances acceptance on acceptance.photo_version_id = photo.id
  left join private.photo_retention_records retention on retention.object_id = acceptance.object_id
  left join private.attempt_photo_purge_states purge_state on purge_state.photo_version_id = photo.id
  where photo.id = p_photo_version_id
$$;
revoke all on function private.photo_retention_metadata(uuid) from public, anon, authenticated, service_role;

create function private.photo_retention_job_at(p_expires_at timestamptz)
returns timestamptz language sql immutable set search_path = '' as $$
  select coalesce(p_expires_at, '9999-12-31 23:59:59+00'::timestamptz)
$$;
revoke all on function private.photo_retention_job_at(timestamptz) from public, anon, authenticated, service_role;

create function private.refresh_photo_retention_record(p_object_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_record private.photo_retention_records;
  v_uploaded_at timestamptz;
  v_pending boolean;
  v_link_count integer;
  v_kind_count integer;
  v_kind text;
  v_start timestamptz;
  v_expires timestamptz;
  v_job_at timestamptz;
  v_media text;
begin
  select * into v_record from private.photo_retention_records where object_id = p_object_id for update;
  if v_record.object_id is null or v_record.media_availability = 'purged' then return; end if;

  select uploaded_at into v_uploaded_at from private.photo_provider_objects where id = p_object_id;
  if v_uploaded_at is null then return; end if;

  select count(*)::integer,
    bool_or(retention_starts_at is null or expires_at is null),
    count(distinct policy_kind)::integer,
    min(policy_kind),
    min(retention_starts_at),
    max(expires_at)
  into v_link_count, v_pending, v_kind_count, v_kind, v_start, v_expires
  from private.photo_retention_links
  where object_id = p_object_id and active;

  if v_link_count = 0 then
    v_kind := 'orphan';
    v_start := v_uploaded_at;
    v_expires := v_uploaded_at + interval '30 days';
  elsif v_pending then
    v_kind := case when v_kind_count = 1 then v_kind else 'mixed' end;
    v_start := null;
    v_expires := null;
  else
    v_kind := case when v_kind_count = 1 then v_kind else 'mixed' end;
  end if;

  if v_record.expires_at is distinct from v_expires and exists (
    select 1 from private.photo_purge_jobs job
    where job.object_id = p_object_id and job.delete_prepared_at is not null
  ) then
    raise exception using errcode = '55000', message = 'PHOTO_RETENTION_DELETE_PREPARED';
  end if;

  v_media := case
    when exists (select 1 from private.photo_provider_objects o where o.id = p_object_id and o.provider_locator is not null)
      then 'available'
    else 'unavailable'
  end;
  update private.photo_retention_records
  set effective_policy_kind = v_kind,
      retention_starts_at = v_start,
      expires_at = v_expires,
      media_availability = v_media,
      revision = revision + 1,
      updated_at = clock_timestamp()
  where object_id = p_object_id
    and (effective_policy_kind is distinct from v_kind
      or retention_starts_at is distinct from v_start
      or expires_at is distinct from v_expires
      or media_availability is distinct from v_media);

  -- The marker is installed only after the cleanup-job guard understands the
  -- v2 authoritative clock. Earlier calls in this same migration only build
  -- the new ledger; the final pass performs the queue reschedule.
  if to_regprocedure('private.photo_retention_v2_ready()') is null then return; end if;
  v_job_at := private.photo_retention_job_at(v_expires);
  perform set_config('app.photo_retention_reschedule', 'typed_v2', true);
  update private.photo_purge_jobs
  set purge_after = v_job_at,
      next_attempt_at = v_job_at,
      status = case when status = 'blocked' then 'blocked' else 'pending' end,
      lease_version = case when status = 'claimed' then least(8, lease_version + 1) else lease_version end,
      claim_digest = case when status = 'blocked' then claim_digest else null end,
      lease_expires_at = case when status = 'blocked' then lease_expires_at else null end,
      last_reason_code = case when status = 'blocked' then last_reason_code else null end,
      revision = revision + 1
  where object_id = p_object_id and status <> 'purged'
    and purge_after is distinct from v_job_at;
  perform set_config('app.photo_retention_reschedule', '', true);
end
$$;
revoke all on function private.refresh_photo_retention_record(uuid) from public, anon, authenticated, service_role;

create function private.assert_photo_retention_link(
  p_policy_kind text,
  p_domain_kind text,
  p_domain_id uuid,
  p_performer_maid_profile_id uuid
) returns table(retention_starts_at timestamptz, expires_at timestamptz)
language plpgsql security definer set search_path = '' as $$
declare
  v_at timestamptz;
  v_attempt_maid uuid;
begin
  if p_policy_kind = 'cleaning_submission' and p_domain_kind = 'cleaning_attempt' then
    select maid_profile_id into v_attempt_maid from public.cleaning_attempts where id = p_domain_id;
    if v_attempt_maid is null or v_attempt_maid is distinct from p_performer_maid_profile_id then
      raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID';
    end if;
    return query select null::timestamptz, null::timestamptz;
  elsif p_policy_kind = 'cleaning_submission' and p_domain_kind = 'cleaning_submission' then
    select d.decided_at, a.maid_profile_id into v_at, v_attempt_maid
    from public.cleaning_submissions s
    join public.cleaning_attempts a on a.id = s.cleaning_attempt_id
    left join public.inspection_decisions d on d.submission_id = s.id
    where s.id = p_domain_id;
    if v_attempt_maid is null or v_attempt_maid is distinct from p_performer_maid_profile_id then
      raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID';
    end if;
    return query select v_at, case when v_at is null then null else v_at + interval '168 hours' end;
  elsif p_policy_kind = 'room_issue' and p_domain_kind = 'room_issue' then
    select case when status = 'resolved' then resolved_at end into v_at
    from public.room_issues where id = p_domain_id;
    if not found then raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID'; end if;
    return query select v_at, case when v_at is null then null else v_at + interval '180 days' end;
  elsif p_policy_kind = 'complaint' and p_domain_kind = 'complaint_case' then
    select event.occurred_at into v_at
    from public.complaint_cases complaint
    join public.complaint_case_events event on event.complaint_case_id = complaint.id
      and event.event_type = 'closed' and event.to_status = 'closed'
    where complaint.id = p_domain_id and complaint.status = 'closed';
    if v_at is null then raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID'; end if;
    return query select v_at, case when v_at is null then null else v_at + interval '180 days' end;
  elsif p_policy_kind = 'interruption' and p_domain_kind = 'attempt_handover' then
    select h.occurred_at, a.maid_profile_id into v_at, v_attempt_maid
    from private.attempt_handover_events h
    join public.cleaning_attempts a on a.id = h.previous_attempt_id
    where h.previous_attempt_id = p_domain_id;
    -- attempt_handover_events is emitted only by the admin lifecycle command
    -- after the prior attempt is interrupted and the replacement is committed.
    if v_at is null or (p_performer_maid_profile_id is not null and v_attempt_maid is distinct from p_performer_maid_profile_id) then
      raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID';
    end if;
    return query select v_at, v_at + interval '180 days';
  elsif p_policy_kind = 'sync_conflict' and p_domain_kind = 'offline_event' then
    -- effectiveAt is a server-owned field of the immutable resolution receipt;
    -- raw client event time is never an anchor.
    select (r.response_payload ->> 'effectiveAt')::timestamptz into v_at
    from private.offline_completion_events e
    join private.offline_event_resolutions r on r.event_record_id = e.id
    where e.id = p_domain_id and e.outcome = 'quarantined';
    if v_at is null or not isfinite(v_at) then
      raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID';
    end if;
    return query select v_at, v_at + interval '180 days';
  else
    raise exception using errcode = '23514', message = 'PHOTO_RETENTION_KIND_UNSUPPORTED';
  end if;
exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
  raise exception using errcode = '23514', message = 'PHOTO_RETENTION_ENTITY_INVALID';
end
$$;
revoke all on function private.assert_photo_retention_link(text,text,uuid,uuid) from public, anon, authenticated, service_role;

create function private.attach_photo_retention_link(
  p_object_id uuid,
  p_policy_kind text,
  p_domain_kind text,
  p_domain_id uuid,
  p_performer_maid_profile_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare v_anchor record;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  perform 1 from private.photo_retention_records where object_id = p_object_id for update;
  if not found or not exists (
    select 1 from private.photo_retention_records
    where object_id = p_object_id and media_availability <> 'purged'
  ) then
    raise exception using errcode = '23514', message = 'PHOTO_RETENTION_OBJECT_INVALID';
  end if;
  perform 1 from private.photo_purge_jobs where object_id = p_object_id for update;
  if found and exists (
    select 1 from private.photo_purge_jobs
    where object_id = p_object_id and delete_prepared_at is not null
  ) then
    raise exception using errcode = '55000', message = 'PHOTO_RETENTION_DELETE_PREPARED';
  end if;
  select * into v_anchor from private.assert_photo_retention_link(
    p_policy_kind, p_domain_kind, p_domain_id, p_performer_maid_profile_id
  );
  insert into private.photo_retention_links(
    object_id, policy_kind, domain_kind, domain_id, performer_maid_profile_id,
    retention_starts_at, expires_at
  ) values (
    p_object_id, p_policy_kind, p_domain_kind, p_domain_id, p_performer_maid_profile_id,
    v_anchor.retention_starts_at, v_anchor.expires_at
  )
  on conflict (object_id, policy_kind, domain_kind, domain_id) do update
  set performer_maid_profile_id = excluded.performer_maid_profile_id,
      retention_starts_at = excluded.retention_starts_at,
      expires_at = excluded.expires_at,
      active = true,
      retired_at = null;
  perform private.refresh_photo_retention_record(p_object_id);
end
$$;
revoke all on function private.attach_photo_retention_link(uuid,text,text,uuid,uuid) from public, anon, authenticated, service_role;

create function private.initialize_photo_retention_record()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_acceptance private.photo_upload_acceptances; v_maid uuid;
begin
  select * into v_acceptance from private.photo_upload_acceptances where object_id = new.id;
  select a.maid_profile_id into v_maid
  from private.photo_upload_operations o
  join public.cleaning_attempts a on a.id = o.cleaning_attempt_id
  where o.id = new.operation_id;
  insert into private.photo_retention_records(
    object_id, operation_id, photo_version_id, performer_maid_profile_id,
    effective_policy_kind, retention_starts_at, expires_at, media_availability
  ) values (
    new.id, new.operation_id, v_acceptance.photo_version_id, v_maid,
    'orphan', new.uploaded_at, new.uploaded_at + interval '30 days',
    case when new.provider_locator is null then 'unavailable' else 'available' end
  ) on conflict (object_id) do update
  set photo_version_id = coalesce(excluded.photo_version_id, private.photo_retention_records.photo_version_id),
      performer_maid_profile_id = coalesce(excluded.performer_maid_profile_id, private.photo_retention_records.performer_maid_profile_id),
      media_availability = case when private.photo_retention_records.media_availability = 'purged'
        then 'purged' else excluded.media_availability end,
      revision = private.photo_retention_records.revision + 1,
      updated_at = clock_timestamp();
  perform private.refresh_photo_retention_record(new.id);
  return new;
end
$$;
revoke all on function private.initialize_photo_retention_record() from public, anon, authenticated, service_role;
create trigger photo_provider_retention_initialize
after insert or update of uploaded_at, provider_locator on private.photo_provider_objects
for each row when (new.uploaded_at is not null) execute function private.initialize_photo_retention_record();

create function private.initialize_photo_retention_record_for_acceptance(
  p_object_id uuid, p_operation_id uuid, p_photo_version_id uuid
) returns void language plpgsql security definer set search_path = '' as $$
declare v_uploaded_at timestamptz; v_maid uuid;
begin
  select object_row.uploaded_at, attempt.maid_profile_id into v_uploaded_at, v_maid
  from private.photo_upload_acceptances acceptance
  join private.photo_provider_objects object_row
    on object_row.id = acceptance.object_id
   and object_row.operation_id = acceptance.operation_id
  join private.photo_upload_operations operation on operation.id = acceptance.operation_id
  join private.photo_upload_states state on state.operation_id = operation.id
  join private.attempt_photo_versions photo on photo.id = acceptance.photo_version_id
  join public.cleaning_attempts attempt on attempt.id = photo.cleaning_attempt_id
  where acceptance.object_id = p_object_id
    and acceptance.operation_id = p_operation_id
    and acceptance.photo_version_id = p_photo_version_id
    and state.status in ('provider_succeeded', 'accepted')
    and object_row.provider_locator is not null
    and object_row.uploaded_at is not null
    and photo.validation_status = 'verified'
    and photo.cleaning_attempt_id = operation.cleaning_attempt_id
    and photo.cleaning_target_id = operation.cleaning_target_id
    and photo.target_photo_slot_id = operation.target_photo_slot_id
    and photo.version = operation.expected_photo_revision + 1
    and photo.sha256 = operation.sha256
    and photo.mime_type = operation.mime_type
    and photo.size_bytes = operation.size_bytes
    and photo.uploaded_at = object_row.uploaded_at
    and photo.purge_after = object_row.purge_after;
  if v_uploaded_at is null or v_maid is null then
    raise exception using errcode = '23514', message = 'PHOTO_RETENTION_OBJECT_INVALID';
  end if;
  insert into private.photo_retention_records(
    object_id, operation_id, photo_version_id, performer_maid_profile_id,
    effective_policy_kind, retention_starts_at, expires_at, media_availability
  ) values (
    p_object_id, p_operation_id, p_photo_version_id, v_maid,
    'orphan', v_uploaded_at, v_uploaded_at + interval '30 days', 'available'
  ) on conflict (object_id) do update
  set photo_version_id = excluded.photo_version_id,
      performer_maid_profile_id = excluded.performer_maid_profile_id,
      media_availability = case when private.photo_retention_records.media_availability = 'purged'
        then 'purged' else excluded.media_availability end,
      revision = private.photo_retention_records.revision + 1,
      updated_at = clock_timestamp();
  perform private.refresh_photo_retention_record(p_object_id);
end
$$;
revoke all on function private.initialize_photo_retention_record_for_acceptance(uuid,uuid,uuid) from public, anon, authenticated, service_role;

create function private.bind_accepted_photo_retention()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_attempt uuid; v_maid uuid;
begin
  perform private.initialize_photo_retention_record_for_acceptance(new.object_id, new.operation_id, new.photo_version_id);
  select p.cleaning_attempt_id, a.maid_profile_id into v_attempt, v_maid
  from private.attempt_photo_versions p
  join public.cleaning_attempts a on a.id = p.cleaning_attempt_id
  where p.id = new.photo_version_id;
  if exists (select 1 from private.attempt_photo_current c where c.photo_version_id = new.photo_version_id)
    or exists (select 1 from private.attempt_photo_collection_items i where i.photo_version_id = new.photo_version_id and i.active) then
    perform private.attach_photo_retention_link(new.object_id, 'cleaning_submission', 'cleaning_attempt', v_attempt, v_maid);
  end if;
  return new;
end
$$;
revoke all on function private.bind_accepted_photo_retention() from public, anon, authenticated, service_role;
create trigger zz_photo_acceptance_retention
after insert on private.photo_upload_acceptances
for each row execute function private.bind_accepted_photo_retention();

create function private.bind_submission_photo_retention()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_object uuid; v_operation uuid; v_maid uuid;
begin
  select a.object_id, a.operation_id, attempt.maid_profile_id
  into v_object, v_operation, v_maid
  from private.photo_upload_acceptances a
  join private.photo_provider_objects object_row
    on object_row.id = a.object_id and object_row.operation_id = a.operation_id
  join private.photo_upload_operations operation on operation.id = a.operation_id
  join private.photo_upload_states state on state.operation_id = operation.id and state.status = 'accepted'
  join private.attempt_photo_versions photo on photo.id = a.photo_version_id
  join public.cleaning_attempts attempt on attempt.id = photo.cleaning_attempt_id
  where a.photo_version_id = new.photo_version_id
    and photo.cleaning_attempt_id = new.cleaning_attempt_id
    and photo.cleaning_target_id = new.cleaning_target_id
    and photo.target_photo_slot_id = new.target_photo_slot_id
    and object_row.provider_locator is not null
    and object_row.uploaded_at is not null
    and photo.validation_status = 'verified'
    and photo.cleaning_attempt_id = operation.cleaning_attempt_id
    and photo.cleaning_target_id = operation.cleaning_target_id
    and photo.target_photo_slot_id = operation.target_photo_slot_id
    and photo.version = operation.expected_photo_revision + 1
    and photo.sha256 = operation.sha256
    and photo.mime_type = operation.mime_type
    and photo.size_bytes = operation.size_bytes
    and photo.uploaded_at = object_row.uploaded_at
    and photo.purge_after = object_row.purge_after;
  if v_object is null then raise exception using errcode = '23514', message = 'PHOTO_RETENTION_OBJECT_INVALID'; end if;
  if not exists (select 1 from private.photo_retention_records where object_id = v_object) then
    perform private.initialize_photo_retention_record_for_acceptance(v_object, v_operation, new.photo_version_id);
  end if;
  update private.photo_retention_links
  set active = false, retired_at = clock_timestamp()
  where object_id = v_object and policy_kind = 'cleaning_submission'
    and domain_kind = 'cleaning_attempt' and active;
  perform private.attach_photo_retention_link(v_object, 'cleaning_submission', 'cleaning_submission', new.submission_id, v_maid);
  return new;
end
$$;
revoke all on function private.bind_submission_photo_retention() from public, anon, authenticated, service_role;
create trigger submission_photo_retention_bind
after insert on private.submission_photo_bindings
for each row execute function private.bind_submission_photo_retention();

create function private.anchor_submission_photo_retention()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_object uuid;
begin
  for v_object in
    select distinct a.object_id
    from private.submission_photo_bindings b
    join private.photo_upload_acceptances a on a.photo_version_id = b.photo_version_id
    where b.submission_id = new.submission_id
  loop
    update private.photo_retention_links
    set retention_starts_at = new.decided_at,
        expires_at = new.decided_at + interval '168 hours'
    where object_id = v_object and policy_kind = 'cleaning_submission'
      and domain_kind = 'cleaning_submission' and domain_id = new.submission_id and active;
    perform private.refresh_photo_retention_record(v_object);
  end loop;
  return new;
end
$$;
revoke all on function private.anchor_submission_photo_retention() from public, anon, authenticated, service_role;
create trigger inspection_photo_retention_anchor
after insert on public.inspection_decisions
for each row execute function private.anchor_submission_photo_retention();

create function private.retire_replaced_photo_retention()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_photo uuid; v_object uuid;
begin
  if tg_table_name = 'attempt_photo_current' then
    v_photo := old.photo_version_id;
    if v_photo is null or v_photo is not distinct from new.photo_version_id then return new; end if;
  else
    v_photo := old.photo_version_id;
    if old.active and new.active and v_photo is not distinct from new.photo_version_id then return new; end if;
  end if;
  select object_id into v_object from private.photo_upload_acceptances where photo_version_id = v_photo;
  if v_object is not null and not exists (
    select 1 from private.submission_photo_bindings b
    join private.submission_current_pointers p on p.submission_id = b.submission_id
    where b.photo_version_id = v_photo
  ) then
    update private.photo_retention_links set active = false, retired_at = clock_timestamp()
    where object_id = v_object and domain_kind = 'cleaning_attempt' and active;
    perform private.refresh_photo_retention_record(v_object);
  end if;
  return new;
end
$$;
revoke all on function private.retire_replaced_photo_retention() from public, anon, authenticated, service_role;
create trigger attempt_photo_current_retention_retire
after update on private.attempt_photo_current
for each row execute function private.retire_replaced_photo_retention();
create trigger attempt_photo_collection_retention_retire
after update on private.attempt_photo_collection_items
for each row execute function private.retire_replaced_photo_retention();

-- Backfill existing provider history. A purged object remains purged and is
-- never made available merely because a new retention record now exists.
insert into private.photo_retention_records(
  object_id, operation_id, photo_version_id, performer_maid_profile_id,
  effective_policy_kind, retention_starts_at, expires_at, purged_at, media_availability
)
select o.id, o.operation_id, a.photo_version_id, attempt.maid_profile_id,
  'orphan', o.uploaded_at, o.uploaded_at + interval '30 days',
  coalesce(ps.purged_at, j.purged_at),
  case when ps.purged_at is not null or j.status = 'purged' then 'purged'
    when o.provider_locator is null then 'unavailable' else 'available' end
from private.photo_provider_objects o
left join private.photo_upload_acceptances a on a.object_id = o.id
left join private.attempt_photo_versions p on p.id = a.photo_version_id
left join public.cleaning_attempts attempt on attempt.id = p.cleaning_attempt_id
left join private.attempt_photo_purge_states ps on ps.photo_version_id = p.id
left join private.photo_purge_jobs j on j.object_id = o.id
where o.uploaded_at is not null;

insert into private.photo_retention_links(
  object_id, policy_kind, domain_kind, domain_id, performer_maid_profile_id,
  retention_starts_at, expires_at, active, retired_at
)
select distinct a.object_id, 'cleaning_submission', 'cleaning_submission', b.submission_id,
  attempt.maid_profile_id, d.decided_at,
  case when d.decided_at is null then null else d.decided_at + interval '168 hours' end,
  true,
  null::timestamptz
from private.submission_photo_bindings b
join private.photo_upload_acceptances a on a.photo_version_id = b.photo_version_id
join public.cleaning_attempts attempt on attempt.id = b.cleaning_attempt_id
join public.cleaning_submissions s on s.id = b.submission_id
left join public.inspection_decisions d on d.submission_id = b.submission_id;

-- A submission binding is immutable evidence independent of the mutable
-- current pointer.  Decided historical submissions retain bytes until their
-- own decidedAt + 168h.  A superseded submission without a final decision is
-- held indefinitely (NULL expiry) rather than misclassified as an orphan.

insert into private.photo_retention_links(
  object_id, policy_kind, domain_kind, domain_id, performer_maid_profile_id
)
select distinct a.object_id, 'cleaning_submission', 'cleaning_attempt', p.cleaning_attempt_id, attempt.maid_profile_id
from private.photo_upload_acceptances a
join private.attempt_photo_versions p on p.id = a.photo_version_id
join public.cleaning_attempts attempt on attempt.id = p.cleaning_attempt_id
where (exists (select 1 from private.attempt_photo_current c where c.photo_version_id = p.id)
    or exists (select 1 from private.attempt_photo_collection_items i where i.photo_version_id = p.id and i.active))
  and not exists (
    select 1 from private.submission_photo_bindings b
    join private.submission_current_pointers pointer on pointer.submission_id = b.submission_id
    where b.photo_version_id = p.id
  )
on conflict do nothing;

do $$ declare v_object uuid; begin
  for v_object in select object_id from private.photo_retention_records loop
    perform private.refresh_photo_retention_record(v_object);
  end loop;
end $$;

-- Retention v2 may move a legacy accepted purge job while it is still
-- non-terminal. The source-controlled helper is the only approved path.
create or replace function private.guard_photo_cleanup_job() returns trigger language plpgsql set search_path = '' as $$
declare v_retention private.photo_retention_records; v_expected timestamptz;
begin
  if tg_op = 'DELETE' then raise exception using errcode = '55000', message = 'PHOTO_STORAGE_IMMUTABLE'; end if;
  if tg_op = 'UPDATE' and (
    old.status = 'purged' or new.revision <> old.revision + 1 or new.lease_version < old.lease_version
    or new.lease_version > old.lease_version + 1
    or (to_jsonb(new) - array['status','lease_version','claim_digest','lease_expires_at','next_attempt_at',
      'last_reason_code','purged_at','outcome','revision','delete_prepared_version',
      'delete_prepared_claim_digest','delete_prepared_expires_at','delete_prepared_at','purge_after'])
      is distinct from
      (to_jsonb(old) - array['status','lease_version','claim_digest','lease_expires_at','next_attempt_at',
      'last_reason_code','purged_at','outcome','revision','delete_prepared_version',
      'delete_prepared_claim_digest','delete_prepared_expires_at','delete_prepared_at','purge_after'])
  ) then raise exception using errcode = '55000', message = 'PHOTO_PURGE_TERMINAL'; end if;
  if tg_table_name = 'photo_purge_jobs' then
    if tg_op = 'UPDATE' and new.purge_after is distinct from old.purge_after
      and coalesce(current_setting('app.photo_retention_reschedule', true), '') <> 'typed_v2' then
      raise exception using errcode = '55000', message = 'PHOTO_PURGE_TERMINAL';
    end if;
    select * into v_retention from private.photo_retention_records where object_id = new.object_id;
    if v_retention.object_id is not null and tg_op = 'UPDATE' then
      v_expected := private.photo_retention_job_at(v_retention.expires_at);
      if new.purge_after is distinct from v_expected then
        raise exception using errcode = '23514', message = 'PHOTO_PURGE_REFERENCE_CONFLICT';
      end if;
      if new.status in ('claimed','purged') and (
        v_retention.media_availability <> 'available' or v_retention.expires_at is null
        or v_retention.expires_at > clock_timestamp()
      ) then raise exception using errcode = '55000', message = 'PHOTO_PURGE_NOT_DUE'; end if;
    elsif not exists (
      select 1 from private.photo_upload_acceptances a
      join private.attempt_photo_versions p on p.id = a.photo_version_id
      join private.photo_provider_objects o on o.id = a.object_id
      where a.object_id = new.object_id and a.operation_id = new.operation_id
        and a.photo_version_id = new.photo_version_id and p.purge_after = new.purge_after
        and o.purge_after = p.purge_after
    ) then raise exception using errcode = '23514', message = 'PHOTO_PURGE_REFERENCE_CONFLICT'; end if;
  elsif tg_table_name = 'photo_orphan_purge_jobs' then
    if exists (select 1 from private.photo_upload_acceptances where operation_id = new.operation_id)
      or not exists (
        select 1 from private.photo_provider_objects o
        join private.photo_upload_states s on s.operation_id = o.operation_id
        where o.id = new.object_id and o.operation_id = new.operation_id
          and s.status in ('compensation_pending','compensated')
      ) then raise exception using errcode = '23514', message = 'PHOTO_ORPHAN_REFERENCE_CONFLICT'; end if;
  end if;
  return new;
end
$$;

create function private.photo_retention_v2_ready()
returns boolean language sql immutable set search_path = '' as $$ select true $$;
revoke all on function private.photo_retention_v2_ready() from public, anon, authenticated, service_role;

-- Re-run aggregation now that the v2 queue guard is active, then move legacy
-- never-accepted candidates from immediate deletion to uploadedAt + 30 days.
do $$ declare v_object uuid; begin
  for v_object in select object_id from private.photo_retention_records loop
    perform private.refresh_photo_retention_record(v_object);
  end loop;
end $$;
update private.photo_orphan_purge_jobs job
set next_attempt_at = object.uploaded_at + interval '30 days', revision = job.revision + 1
from private.photo_provider_objects object
where object.id = job.object_id and job.status <> 'purged'
  and job.next_attempt_at is distinct from object.uploaded_at + interval '30 days';

create or replace function private.enqueue_photo_orphan_purge() returns trigger language plpgsql set search_path = '' as $$
declare v_object private.photo_provider_objects;
begin
  if new.status = 'compensation_pending' and old.status is distinct from new.status then
    select * into v_object from private.photo_provider_objects where operation_id = new.operation_id;
    if v_object.provider_locator is null or exists (select 1 from private.photo_upload_acceptances where operation_id = new.operation_id) then
      raise exception using errcode = '23514', message = 'PHOTO_ORPHAN_REFERENCE_CONFLICT';
    end if;
    insert into private.photo_orphan_purge_jobs(operation_id, object_id, next_attempt_at)
    values (new.operation_id, v_object.id, v_object.uploaded_at + interval '30 days')
    on conflict (operation_id) do nothing;
  end if;
  return new;
end
$$;

create or replace function public.claim_due_photo_purges(p_claim_digest text, p_limit integer default 10)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare j private.photo_purge_jobs; at_time timestamptz; items jsonb := '[]'::jsonb; blocked integer := 0;
begin
  if p_claim_digest is null or p_claim_digest !~ '^[0-9a-f]{64}$' or p_limit is null or p_limit not between 1 and 10 then
    raise exception using errcode = '23514', message = 'PHOTO_PURGE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  at_time := clock_timestamp();
  for j in
    select job.* from private.photo_purge_jobs job
    join private.photo_retention_records retention on retention.object_id = job.object_id
    where retention.media_availability = 'available' and retention.expires_at is not null
      and retention.expires_at <= at_time and job.purge_after = retention.expires_at
      and job.status in ('pending','retry','claimed') and job.next_attempt_at <= at_time
      and (job.lease_expires_at is null or job.lease_expires_at <= at_time or job.claim_digest = p_claim_digest)
    order by job.next_attempt_at, job.object_id for update of job skip locked limit p_limit
  loop
    perform private.refresh_photo_retention_record(j.object_id);
    select * into j from private.photo_purge_jobs where object_id = j.object_id for update;
    if not exists (
      select 1 from private.photo_retention_records r where r.object_id = j.object_id
        and r.media_availability = 'available' and r.expires_at is not null
        and r.expires_at <= clock_timestamp() and r.expires_at = j.purge_after
    ) then continue; end if;
    at_time := clock_timestamp();
    if j.lease_expires_at > at_time and j.claim_digest = p_claim_digest then
      items := items || jsonb_build_array(private.photo_purge_projection(j.object_id)); continue;
    end if;
    if j.lease_version >= 8 then
      update private.photo_purge_jobs set status = 'blocked', last_reason_code = 'RETRY_EXHAUSTED', revision = revision + 1
      where object_id = j.object_id;
      blocked := blocked + 1; continue;
    end if;
    update private.photo_purge_jobs set status = 'claimed', lease_version = lease_version + 1,
      claim_digest = p_claim_digest, lease_expires_at = at_time + interval '5 minutes',
      last_reason_code = null, revision = revision + 1 where object_id = j.object_id;
    items := items || jsonb_build_array(private.photo_purge_projection(j.object_id));
  end loop;
  return jsonb_build_object('items', items, 'blocked', blocked);
end
$$;

create or replace function public.get_photo_purge_context(
  p_object_id uuid, p_lease_version integer, p_claim_digest text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare j private.photo_purge_jobs; obj private.photo_provider_objects; r private.photo_retention_records; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  perform private.refresh_photo_retention_record(p_object_id);
  select * into j from private.photo_purge_jobs where object_id = p_object_id for update;
  select * into obj from private.photo_provider_objects where id = p_object_id for update;
  select * into r from private.photo_retention_records where object_id = p_object_id for update;
  at_time := clock_timestamp();
  if j.object_id is null or j.status <> 'claimed' or j.lease_version is distinct from p_lease_version
    or j.claim_digest is distinct from p_claim_digest or j.lease_expires_at <= at_time then
    raise exception using errcode = '40001', message = 'PHOTO_PURGE_FENCE_CONFLICT';
  end if;
  if r.media_availability <> 'available' or r.expires_at is null or r.expires_at > at_time
    or j.purge_after is distinct from r.expires_at then
    raise exception using errcode = '55000', message = 'PHOTO_PURGE_NOT_DUE';
  end if;
  if obj.provider_locator is null or not exists (
    select 1 from private.photo_upload_acceptances a
    where a.object_id = j.object_id and a.photo_version_id = j.photo_version_id and a.operation_id = j.operation_id
  ) then raise exception using errcode = '23514', message = 'PHOTO_PURGE_REFERENCE_CONFLICT'; end if;
  if j.delete_prepared_at is null
    or j.delete_prepared_version is distinct from p_lease_version
    or j.delete_prepared_claim_digest is distinct from p_claim_digest
    or j.delete_prepared_expires_at is distinct from r.expires_at then
    update private.photo_purge_jobs
    set delete_prepared_version = p_lease_version,
        delete_prepared_claim_digest = p_claim_digest,
        delete_prepared_expires_at = r.expires_at,
        delete_prepared_at = at_time,
        revision = revision + 1
    where object_id = p_object_id;
  end if;
  return private.photo_purge_projection(p_object_id) || jsonb_build_object('providerFileId', obj.provider_locator);
end
$$;

create or replace function public.settle_photo_purge(
  p_object_id uuid, p_lease_version integer, p_claim_digest text,
  p_outcome text, p_reason_code text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare j private.photo_purge_jobs; at_time timestamptz; delay_seconds integer; folder_registry uuid;
begin
  if p_outcome is null or p_outcome not in ('deleted','not_found','retryable')
    or (p_outcome = 'retryable' and (p_reason_code is null or p_reason_code not in ('RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR')))
    or (p_outcome <> 'retryable' and p_reason_code is not null) then
    raise exception using errcode = '23514', message = 'PHOTO_PURGE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  select * into j from private.photo_purge_jobs where object_id = p_object_id for update;
  if j.status = 'purged' and j.lease_version = p_lease_version
    and j.claim_digest = p_claim_digest and p_outcome in ('deleted','not_found') then
    return private.photo_purge_projection(p_object_id);
  end if;
  at_time := clock_timestamp();
  if j.object_id is null or j.status <> 'claimed'
    or j.lease_version is distinct from p_lease_version
    or j.claim_digest is distinct from p_claim_digest
    or j.lease_expires_at <= at_time
    or j.delete_prepared_version is distinct from p_lease_version
    or j.delete_prepared_claim_digest is distinct from p_claim_digest
    or j.delete_prepared_expires_at is distinct from j.purge_after
    or j.delete_prepared_at is null then
    raise exception using errcode = '40001', message = 'PHOTO_PURGE_FENCE_CONFLICT';
  end if;
  if p_outcome = 'retryable' then
    delay_seconds := least(3600, 30 * (2 ^ (j.lease_version - 1))::integer)
      + (get_byte(extensions.digest(convert_to(j.object_id::text || j.lease_version::text, 'UTF8'), 'sha256'), 0) % 16);
    update private.photo_purge_jobs
    set status = case when lease_version >= 8 then 'blocked' else 'retry' end,
        next_attempt_at = at_time + make_interval(secs => delay_seconds),
        last_reason_code = case when lease_version >= 8 then 'RETRY_EXHAUSTED' else p_reason_code end,
        lease_expires_at = at_time,
        revision = revision + 1
    where object_id = p_object_id;
  else
    select f.id into folder_registry
    from private.photo_drive_identities i
    join private.photo_drive_folder_identities f on f.provider_folder_id = i.provider_folder_id
    where i.object_id = p_object_id;
    update private.photo_purge_jobs
    set status = 'purged', purged_at = at_time, outcome = p_outcome,
        last_reason_code = null, revision = revision + 1
    where object_id = p_object_id;
    insert into private.attempt_photo_purge_states(photo_version_id, purged_at)
    values(j.photo_version_id, at_time) on conflict do nothing;
    update private.photo_provider_objects set provider_locator = null where id = p_object_id;
    update private.photo_drive_identities set provider_file_id = null, provider_folder_id = null
    where object_id = p_object_id;
    if folder_registry is not null then perform private.maybe_retire_photo_folder(folder_registry, at_time); end if;
  end if;
  return private.photo_purge_projection(p_object_id);
end
$$;

create or replace function public.authorize_photo_read(
  p_actor_profile_id uuid, p_session_id uuid, p_photo_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor public.profiles; p private.attempt_photo_versions; obj private.photo_provider_objects;
  retention private.photo_retention_records; at_time timestamptz;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));
  select * into actor from public.profiles where id = p_actor_profile_id for no key update;
  if actor.id is null or actor.role not in ('admin','maid') or actor.status <> 'active' or actor.must_change_password then
    raise exception using errcode = '42501', message = 'PHOTO_ACCESS_REQUIRED';
  end if;
  perform 1 from auth.sessions where id = p_session_id and user_id = actor.auth_user_id for share;
  if not found or not public.is_active_auth_session(actor.auth_user_id, p_session_id) then
    raise exception using errcode = '42501', message = 'SESSION_REVOKED';
  end if;
  select * into p from private.attempt_photo_versions where id = p_photo_id;
  select o.* into obj
  from private.photo_upload_acceptances a
  join private.photo_provider_objects o on o.id = a.object_id
  where a.photo_version_id = p_photo_id;
  select r.* into retention from private.photo_retention_records r where r.object_id = obj.id;
  if p.id is null or retention.object_id is null then
    raise exception using errcode = '42501', message = 'PHOTO_ACCESS_REQUIRED';
  end if;
  at_time := clock_timestamp();
  if retention.media_availability = 'purged' then
    raise exception using errcode = '55000', message = 'PHOTO_MEDIA_PURGED';
  elsif retention.media_availability = 'unavailable' or obj.provider_locator is null then
    raise exception using errcode = '55000', message = 'PHOTO_MEDIA_UNAVAILABLE';
  elsif retention.expires_at is not null and retention.expires_at <= at_time then
    raise exception using errcode = '55000', message = 'PHOTO_MEDIA_EXPIRED';
  elsif p.validation_status <> 'verified' then
    raise exception using errcode = '55000', message = 'PHOTO_MEDIA_UNAVAILABLE';
  end if;
  if actor.role = 'maid' and retention.performer_maid_profile_id is distinct from actor.id then
    raise exception using errcode = '42501', message = 'PHOTO_ACCESS_REQUIRED';
  end if;
  return jsonb_build_object(
    'photoId', p.id, 'providerFileId', obj.provider_locator, 'sha256', p.sha256,
    'mimeType', p.mime_type, 'sizeBytes', p.size_bytes,
    'retentionPolicy', retention.effective_policy_kind,
    'retentionStartsAt', retention.retention_starts_at,
    'expiresAt', retention.expires_at,
    'purgedAt', retention.purged_at,
    'mediaAvailability', retention.media_availability
  );
end
$$;

create function private.mark_photo_retention_purged()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update private.photo_retention_records retention
  set media_availability = 'purged', purged_at = new.purged_at,
      revision = retention.revision + 1, updated_at = clock_timestamp()
  from private.photo_upload_acceptances acceptance
  where acceptance.photo_version_id = new.photo_version_id
    and retention.object_id = acceptance.object_id
    and retention.media_availability <> 'purged';
  return new;
end
$$;
revoke all on function private.mark_photo_retention_purged() from public, anon, authenticated, service_role;
create trigger attempt_photo_retention_mark_purged
after insert on private.attempt_photo_purge_states
for each row execute function private.mark_photo_retention_purged();

create or replace function private.photo_upload_projection(p_operation uuid)
returns jsonb language sql stable set search_path = '' as $$
select jsonb_build_object(
  'operationId', o.id, 'objectId', obj.id, 'attemptId', o.cleaning_attempt_id,
  'targetSlotId', o.target_photo_slot_id, 'photoItemId', o.collection_item_id,
  'status', s.status, 'leaseVersion', s.lease_version, 'leaseExpiresAt', s.lease_expires_at,
  'photoId', a.photo_version_id, 'photoVersion', p.version,
  'collectionRevision', case when o.collection_item_id is null then null
    when a.photo_version_id is null then o.expected_photo_revision else o.expected_photo_revision + 1 end,
  'itemRevision', case when o.collection_item_id is null then null
    when a.photo_version_id is null then o.expected_item_revision else o.expected_item_revision + 1 end,
  'uploadedAt', obj.uploaded_at,
  'purgeAfter', retention.expires_at,
  'retentionPolicy', retention.effective_policy_kind,
  'retentionStartsAt', retention.retention_starts_at,
  'expiresAt', retention.expires_at,
  'purgedAt', retention.purged_at,
  'mediaAvailability', retention.media_availability,
  'compensationAllowed', s.status = 'compensation_pending' and a.operation_id is null and obj.provider_locator is not null
)
from private.photo_upload_operations o
join private.photo_upload_states s on s.operation_id = o.id
join private.photo_provider_objects obj on obj.operation_id = o.id
left join private.photo_upload_acceptances a on a.operation_id = o.id
left join private.attempt_photo_versions p on p.id = a.photo_version_id
left join private.photo_retention_records retention on retention.object_id = obj.id
where o.id = p_operation
$$;

-- All current workflow validation uses the authoritative retention ledger.
-- The legacy +168h columns remain immutable compatibility evidence only.
create or replace function private.guard_photo_collection_item()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then raise exception using errcode = '55000', message = 'PHOTO_MODEL_IMMUTABLE'; end if;
  if private.photo_slot_max_photos(new.target_photo_slot_id, new.cleaning_target_id) <> 10 then
    raise exception using errcode = '23514', message = 'PHOTO_COLLECTION_NOT_ALLOWED';
  end if;
  if tg_op = 'INSERT' then
    if new.revision <> 1 or not new.active then raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT'; end if;
  elsif new.id <> old.id or new.cleaning_attempt_id <> old.cleaning_attempt_id
    or new.cleaning_target_id <> old.cleaning_target_id or new.target_photo_slot_id <> old.target_photo_slot_id
    or new.display_order <> old.display_order or new.revision <> old.revision + 1 or not old.active then
    raise exception using errcode = '40001', message = 'PHOTO_ITEM_VERSION_CONFLICT';
  end if;
  if new.active and not exists (
    select 1 from private.attempt_photo_versions photo
    where photo.id = new.photo_version_id and photo.collection_item_id = new.id
      and photo.item_revision = new.revision
      and private.photo_media_usable(photo.id, clock_timestamp())
  ) then raise exception using errcode = '23514', message = 'PHOTO_NOT_VERIFIED'; end if;
  return new;
end
$$;

create or replace function private.photo_attempt_complete(p_attempt uuid, p_as_of timestamptz)
returns boolean language sql stable set search_path = '' as $$
select coalesce(isfinite(p_as_of) and exists (
  select 1 from public.cleaning_attempts attempt
  join private.target_photo_snapshot_contracts contract on contract.cleaning_target_id = attempt.cleaning_target_id
  where attempt.id = p_attempt and attempt.started_at is not null and contract.ready
    and (select count(*) from private.target_photo_slot_snapshots slot where slot.cleaning_target_id = attempt.cleaning_target_id)
      = jsonb_array_length(contract.frozen_snapshot -> 'slots')
    and exists (select 1 from private.target_photo_slot_snapshots slot where slot.cleaning_target_id = attempt.cleaning_target_id and slot.required)
    and not exists (
      (select value from jsonb_array_elements(contract.frozen_snapshot -> 'slots'))
      except
      (select slot_snapshot from private.target_photo_slot_snapshots slot where slot.cleaning_target_id = attempt.cleaning_target_id)
    )
    and attempt.template_snapshot = (select template_snapshot from public.cleaning_targets where id = attempt.cleaning_target_id)
    and not exists (
      select 1 from private.target_photo_slot_snapshots slot
      where slot.cleaning_target_id = attempt.cleaning_target_id and slot.required
        and private.photo_slot_max_photos(slot.id, attempt.cleaning_target_id) = 1
        and not exists (
          select 1 from private.attempt_photo_current current_photo
          join private.attempt_photo_versions photo on photo.id = current_photo.photo_version_id
          where current_photo.cleaning_attempt_id = attempt.id and current_photo.target_photo_slot_id = slot.id
            and photo.uploaded_at >= attempt.started_at and photo.uploaded_at <= p_as_of
            and private.photo_media_usable(photo.id, p_as_of)
        )
    )
    and not exists (
      select 1 from private.attempt_photo_current current_photo
      join private.attempt_photo_versions photo on photo.id = current_photo.photo_version_id
      where current_photo.cleaning_attempt_id = attempt.id
        and (private.photo_slot_max_photos(current_photo.target_photo_slot_id, attempt.cleaning_target_id) <> 1
          or photo.uploaded_at < attempt.started_at or photo.uploaded_at > p_as_of
          or not private.photo_media_usable(photo.id, p_as_of))
    )
    and not exists (
      select 1 from private.attempt_photo_collection_items item
      join private.attempt_photo_versions photo on photo.id = item.photo_version_id
      where item.cleaning_attempt_id = attempt.id and item.active
        and (private.photo_slot_max_photos(item.target_photo_slot_id, attempt.cleaning_target_id) <> 10
          or photo.uploaded_at < attempt.started_at or photo.uploaded_at > p_as_of
          or not private.photo_media_usable(photo.id, p_as_of))
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
      select 1 from private.attempt_photo_current current_photo
      where current_photo.cleaning_attempt_id = new.cleaning_attempt_id
        and current_photo.target_photo_slot_id = new.target_photo_slot_id
        and current_photo.photo_version_id = new.photo_version_id
        and current_photo.photo_version = new.photo_version
        and current_photo.cleaning_target_id = new.cleaning_target_id
        and private.photo_media_usable(new.photo_version_id, clock_timestamp())
    ) then raise exception using errcode = '55000', message = 'SUBMISSION_PHOTO_BINDING_INVALID'; end if;
  elsif not exists (
    select 1 from private.attempt_photo_collection_items item
    where item.id = new.collection_item_id and item.cleaning_attempt_id = new.cleaning_attempt_id
      and item.cleaning_target_id = new.cleaning_target_id and item.target_photo_slot_id = new.target_photo_slot_id
      and item.active and item.revision = new.item_revision and item.display_order = new.item_display_order
      and item.photo_version_id = new.photo_version_id and item.photo_version = new.photo_version
      and private.photo_media_usable(new.photo_version_id, clock_timestamp())
  ) then raise exception using errcode = '55000', message = 'SUBMISSION_PHOTO_BINDING_INVALID'; end if;
  return new;
end
$$;

create or replace function private.assert_current_submission(p_submission uuid)
returns public.cleaning_submissions language plpgsql set search_path = '' as $$
declare submission public.cleaning_submissions;
begin
  select * into submission from public.cleaning_submissions where id = p_submission for update;
  if submission.id is null then raise exception using errcode = 'P0002', message = 'SUBMISSION_NOT_FOUND'; end if;
  if submission.status <> 'submitted'
    or not exists (select 1 from private.submission_current_pointers pointer
      where pointer.submission_id = submission.id and pointer.cleaning_attempt_id = submission.cleaning_attempt_id)
    or exists (select 1 from public.inspection_decisions decision where decision.submission_id = submission.id) then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if exists (
    select 1 from private.submission_photo_bindings binding
    where binding.submission_id = submission.id
      and not private.photo_media_usable(binding.photo_version_id, clock_timestamp())
  ) then raise exception using errcode = '55000', message = 'PHOTO_MEDIA_UNAVAILABLE'; end if;
  return submission;
end
$$;

revoke all on function private.guard_photo_collection_item() from public, anon, authenticated, service_role;
revoke all on function private.photo_attempt_complete(uuid,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.guard_submission_photo_binding() from public, anon, authenticated, service_role;
revoke all on function private.assert_current_submission(uuid) from public, anon, authenticated, service_role;

alter function public.get_attempt_photo_slots(uuid,uuid,uuid)
  rename to get_attempt_photo_slots_before_retention_v2;
revoke all on function public.get_attempt_photo_slots_before_retention_v2(uuid,uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.get_attempt_photo_slots(
  p_actor_profile_id uuid, p_session_id uuid, p_attempt_id uuid
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_slots jsonb := '[]'::jsonb;
  v_slot jsonb;
  v_photos jsonb;
  v_photo jsonb;
  v_photo_id uuid;
  v_metadata jsonb;
  v_status text;
begin
  v_result := public.get_attempt_photo_slots_before_retention_v2(
    p_actor_profile_id, p_session_id, p_attempt_id
  );
  for v_slot in select value from jsonb_array_elements(v_result -> 'slots') loop
    v_photos := '[]'::jsonb;
    for v_photo in select value from jsonb_array_elements(coalesce(v_slot -> 'photos', '[]'::jsonb)) loop
      if nullif(v_photo ->> 'photoItemId', '') is not null then
        select item.photo_version_id into v_photo_id
        from private.attempt_photo_collection_items item
        where item.id = (v_photo ->> 'photoItemId')::uuid and item.cleaning_attempt_id = p_attempt_id;
      else
        select current_photo.photo_version_id into v_photo_id
        from private.attempt_photo_current current_photo
        where current_photo.cleaning_attempt_id = p_attempt_id
          and current_photo.target_photo_slot_id = (v_slot ->> 'slotId')::uuid;
      end if;
      v_metadata := coalesce(private.photo_retention_metadata(v_photo_id), '{}'::jsonb);
      v_status := case
        when v_metadata ->> 'mediaAvailability' = 'purged' then 'purged'
        when v_metadata ->> 'mediaAvailability' = 'unavailable' then 'unavailable'
        when nullif(v_metadata ->> 'expiresAt', '') is not null
          and (v_metadata ->> 'expiresAt')::timestamptz <= clock_timestamp() then 'expired'
        when private.photo_media_usable(v_photo_id, clock_timestamp()) then 'verified'
        else v_photo ->> 'uploadStatus'
      end;
      v_photo := v_photo || v_metadata || jsonb_build_object(
        'photoId', case when private.photo_media_usable(v_photo_id, clock_timestamp()) then v_photo_id else null end,
        'uploadStatus', v_status
      );
      v_photos := v_photos || jsonb_build_array(v_photo);
    end loop;
    if jsonb_array_length(v_photos) = 1 then
      v_slot := v_slot || jsonb_build_object(
        'photoId', v_photos -> 0 -> 'photoId',
        'uploadStatus', v_photos -> 0 ->> 'uploadStatus',
        'retentionPolicy', v_photos -> 0 -> 'retentionPolicy',
        'retentionStartsAt', v_photos -> 0 -> 'retentionStartsAt',
        'expiresAt', v_photos -> 0 -> 'expiresAt',
        'purgedAt', v_photos -> 0 -> 'purgedAt',
        'mediaAvailability', v_photos -> 0 -> 'mediaAvailability'
      );
    end if;
    v_slots := v_slots || jsonb_build_array(jsonb_set(v_slot, '{photos}', v_photos));
  end loop;
  return jsonb_set(v_result, '{slots}', v_slots);
end
$$;
revoke all on function public.get_attempt_photo_slots(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_attempt_photo_slots(uuid,uuid,uuid) to service_role;

alter function public.get_cleaning_submission(uuid,uuid)
  rename to get_cleaning_submission_before_retention_v2;
revoke all on function public.get_cleaning_submission_before_retention_v2(uuid,uuid)
  from public, anon, authenticated, service_role;

create function public.get_cleaning_submission(p_actor_profile_id uuid, p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_result jsonb;
  v_photos jsonb := '[]'::jsonb;
  v_photo_slots jsonb := '[]'::jsonb;
  v_photo jsonb;
  v_slot jsonb;
  v_nested jsonb;
begin
  v_result := public.get_cleaning_submission_before_retention_v2(p_actor_profile_id, p_submission_id);
  for v_photo in select value from jsonb_array_elements(coalesce(v_result -> 'photos', '[]'::jsonb)) loop
    v_photo := v_photo || coalesce(private.photo_retention_metadata((v_photo ->> 'photoId')::uuid), '{}'::jsonb);
    v_photos := v_photos || jsonb_build_array(v_photo);
  end loop;
  for v_slot in select value from jsonb_array_elements(coalesce(v_result -> 'photoSlots', '[]'::jsonb)) loop
    v_nested := '[]'::jsonb;
    for v_photo in select value from jsonb_array_elements(coalesce(v_slot -> 'photos', '[]'::jsonb)) loop
      v_photo := v_photo || coalesce(private.photo_retention_metadata((v_photo ->> 'photoId')::uuid), '{}'::jsonb);
      v_nested := v_nested || jsonb_build_array(v_photo);
    end loop;
    v_photo_slots := v_photo_slots || jsonb_build_array(jsonb_set(v_slot, '{photos}', v_nested));
  end loop;
  return jsonb_set(jsonb_set(v_result, '{photos}', v_photos), '{photoSlots}', v_photo_slots);
end
$$;
revoke all on function public.get_cleaning_submission(uuid,uuid) from public, anon, authenticated;
grant execute on function public.get_cleaning_submission(uuid,uuid) to service_role;

create or replace function public.report_bomb_room(
  p_actor_profile_id uuid, p_attempt_id uuid, p_evidence_photo_ids uuid[], p_memo text,
  p_idempotency_key text, p_request_hash text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  a public.cleaning_attempts; t public.cleaning_targets; p public.profiles;
  replay jsonb; result jsonb; rid uuid; report_time timestamptz;
begin
  replay := private.replay_command(
    p_actor_profile_id, 'submission.report_bomb_room', p_idempotency_key, p_request_hash
  );
  a := private.submission_receipt_actor(p_actor_profile_id, p_attempt_id);
  if replay is not null then return replay; end if;
  a := private.bomb_report_actor(p_actor_profile_id, p_attempt_id);
  select * into t from public.cleaning_targets where id = a.cleaning_target_id for update;
  select * into p from public.profiles where id = p_actor_profile_id;
  if t.source = 'inspection_reclean' then raise exception using errcode = '55000', message = 'BOMB_REPORT_NOT_ALLOWED'; end if;
  if exists (select 1 from private.bomb_room_reports existing where existing.cleaning_attempt_id = a.id)
    or exists (select 1 from private.submission_current_pointers where cleaning_attempt_id = a.id)
    or p_evidence_photo_ids is null or cardinality(p_evidence_photo_ids) not between 1 and 20
    or cardinality(p_evidence_photo_ids) <> (select count(distinct x) from unnest(p_evidence_photo_ids) x)
    or nullif(btrim(p_memo), '') is null or char_length(p_memo) > 500 then
    raise exception using errcode = '22023', message = 'INVALID_BOMB_REPORT';
  end if;
  if exists (
    select 1 from unnest(p_evidence_photo_ids) x
    where not exists (
      select 1 from private.attempt_photo_versions photo
      where photo.id = x and photo.cleaning_attempt_id = a.id
        and private.photo_media_usable(photo.id, clock_timestamp())
        and (exists (select 1 from private.attempt_photo_current current_photo
              where current_photo.cleaning_attempt_id = a.id and current_photo.photo_version_id = photo.id)
          or exists (select 1 from private.attempt_photo_collection_items item
              where item.cleaning_attempt_id = a.id and item.active and item.photo_version_id = photo.id))
    )
  ) then raise exception using errcode = '23514', message = 'BOMB_EVIDENCE_INVALID'; end if;
  insert into private.bomb_room_reports(cleaning_attempt_id, reported_by, memo)
    values (a.id, p_actor_profile_id, p_memo) returning id, reported_at into rid, report_time;
  insert into private.bomb_room_report_evidence(report_id, photo_version_id)
    select rid, x from unnest(p_evidence_photo_ids) x;
  result := jsonb_build_object('id', rid, 'attemptId', a.id,
    'evidenceCount', cardinality(p_evidence_photo_ids), 'reportedAt', report_time);
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

revoke all on function private.photo_upload_projection(uuid) from public, anon, authenticated, service_role;
revoke all on function private.guard_photo_cleanup_job() from public, anon, authenticated, service_role;
revoke all on function private.enqueue_photo_orphan_purge() from public, anon, authenticated, service_role;
