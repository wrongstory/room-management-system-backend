-- #204: bounded, snapshot-only cleaning completion history for admin/maid UI.
-- Room labels are read only from the attempt snapshot. The performer label is
-- the current safe profile display name because older attempts have no
-- immutable performer-name snapshot; the API documents this distinction.

create index cleaning_attempts_history_completed_idx
  on public.cleaning_attempts(field_completed_at desc, id desc)
  where field_completed_at is not null;

create index cleaning_attempts_history_maid_idx
  on public.cleaning_attempts(maid_profile_id, field_completed_at desc, id desc)
  where field_completed_at is not null;

create function public.list_cleaning_history(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_date date,
  p_maid_profile_id uuid default null,
  p_query text default null,
  p_limit integer default 50,
  p_cursor_field_completed_at timestamptz default null,
  p_cursor_attempt_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  actor public.profiles%rowtype;
  normalized_query text := nullif(btrim(p_query), '');
  window_start timestamptz;
  window_end timestamptz;
  result jsonb;
begin
  select * into actor
  from public.profiles
  where id = p_actor_profile_id;

  if not found
    or actor.role not in ('admin', 'maid')
    or actor.status <> 'active'
    or actor.must_change_password
  then
    raise exception using errcode = '42501', message = 'CLEANING_HISTORY_ACCESS_REQUIRED';
  end if;

  if p_session_id is null
    or not public.is_active_auth_session(actor.auth_user_id, p_session_id)
  then
    raise exception using errcode = '42501', message = 'ACTIVE_SESSION_REQUIRED';
  end if;

  if actor.role = 'maid'
    and p_maid_profile_id is not null
    and p_maid_profile_id <> actor.id
  then
    raise exception using errcode = '42501', message = 'CLEANING_HISTORY_MAID_SCOPE_REQUIRED';
  end if;

  if p_date is null
    or p_limit is null or p_limit < 1 or p_limit > 100
    or (p_query is not null and (normalized_query is null or char_length(normalized_query) > 80))
    or ((p_cursor_field_completed_at is null) <> (p_cursor_attempt_id is null))
    or (p_cursor_field_completed_at is not null and not isfinite(p_cursor_field_completed_at))
  then
    raise exception using errcode = '22023', message = 'INVALID_CLEANING_HISTORY_QUERY';
  end if;

  window_start := (p_date - 6)::timestamp at time zone 'Asia/Seoul';
  window_end := (p_date + 1)::timestamp at time zone 'Asia/Seoul';

  with candidates as materialized (
    select a.*
    from public.cleaning_attempts a
    where a.field_completed_at >= window_start
      and a.field_completed_at < window_end
      and (actor.role = 'admin' or a.maid_profile_id = actor.id)
      and (p_maid_profile_id is null or a.maid_profile_id = p_maid_profile_id)
      and (
        normalized_query is null
        or position(lower(normalized_query) in lower(coalesce(a.room_snapshot ->> 'roomNumber', ''))) > 0
        or position(lower(normalized_query) in lower(coalesce(a.room_snapshot #>> '{roomType,code}', a.room_snapshot ->> 'code', ''))) > 0
        or position(lower(normalized_query) in lower(coalesce(a.room_snapshot #>> '{roomType,name}', a.room_snapshot ->> 'name', ''))) > 0
        or exists (
          select 1 from public.profiles performer
          where performer.id = a.maid_profile_id
            and position(lower(normalized_query) in lower(performer.display_name)) > 0
        )
      )
      and (
        p_cursor_field_completed_at is null
        or (a.field_completed_at, a.id) < (p_cursor_field_completed_at, p_cursor_attempt_id)
      )
    order by a.field_completed_at desc, a.id desc
    limit p_limit + 1
  ), page as materialized (
    select * from candidates
    order by field_completed_at desc, id desc
    limit p_limit
  ), projected as (
    select
      a.id as attempt_id,
      jsonb_build_object(
        'submissionId', s.id,
        'attemptId', a.id,
        'cleaningTargetId', a.cleaning_target_id,
        'roomId', t.room_id,
        'roomNumber', a.room_snapshot ->> 'roomNumber',
        'roomTypeCode', coalesce(a.room_snapshot #>> '{roomType,code}', a.room_snapshot ->> 'code'),
        'roomTypeName', coalesce(a.room_snapshot #>> '{roomType,name}', a.room_snapshot ->> 'name'),
        'performerProfileId', a.maid_profile_id,
        'performerDisplayName', performer.display_name,
        'cleaningKind', t.cleaning_kind,
        'originalServiceDate', t.original_service_date,
        'serviceDate', t.effective_service_date,
        'startedAt', a.started_at,
        'fieldCompletedAt', a.field_completed_at,
        'submittedAt', s.submitted_at,
        'inspectionStatus', case
          when s.id is null then 'not_submitted'
          when d.id is null then 'pending'
          else d.decision
        end,
        'decidedAt', d.decided_at,
        'photoCount', coalesce(seal.photo_count, 0),
        'mediaAvailability', case
          when s.id is null then 'not_submitted'
          when coalesce(media.photo_count, 0) = 0 then 'unavailable'
          when media.available_count = media.photo_count then 'available'
          when media.purged_count = media.photo_count then 'purged'
          else 'unavailable'
        end,
        'expiresAt', media.expires_at,
        'baseFeeSnapshot', t.fee_snapshot,
        'earningTotalAmount', e.total_amount
      ) as item
    from page a
    join public.cleaning_targets t on t.id = a.cleaning_target_id
    join public.profiles performer on performer.id = a.maid_profile_id
    left join private.submission_current_pointers cp on cp.cleaning_attempt_id = a.id
    left join public.cleaning_submissions s on s.id = cp.submission_id
    left join private.submission_photo_binding_sets seal on seal.submission_id = s.id
    left join public.inspection_decisions d on d.submission_id = s.id
    left join public.earnings e on e.submission_id = s.id
    left join lateral (
      select
        count(*)::integer as photo_count,
        count(*) filter (where coalesce(r.media_availability,
          case when purge.photo_version_id is not null then 'purged'
               when pv.purge_after > clock_timestamp() then 'available'
               else 'unavailable' end) = 'available')::integer as available_count,
        count(*) filter (where coalesce(r.media_availability,
          case when purge.photo_version_id is not null then 'purged'
               when pv.purge_after > clock_timestamp() then 'available'
               else 'unavailable' end) = 'purged')::integer as purged_count,
        min(coalesce(r.expires_at, pv.purge_after)) as expires_at
      from private.submission_photo_bindings b
      join private.attempt_photo_versions pv on pv.id = b.photo_version_id
      left join private.photo_upload_acceptances acceptance on acceptance.photo_version_id = pv.id
      left join private.photo_retention_records r on r.object_id = acceptance.object_id
      left join private.attempt_photo_purge_states purge on purge.photo_version_id = pv.id
      where b.submission_id = s.id
    ) media on true
    order by a.field_completed_at desc, a.id desc
  )
  select jsonb_build_object(
    'date', p_date,
    'fromDate', p_date - 6,
    'toDate', p_date,
    'items', coalesce(jsonb_agg(projected.item order by page.field_completed_at desc, page.id desc), '[]'::jsonb),
    'nextCursor', case when (select count(*) from candidates) > p_limit then
      jsonb_build_object(
        'fieldCompletedAt', (select field_completed_at from page order by field_completed_at, id limit 1),
        'attemptId', (select id from page order by field_completed_at, id limit 1)
      ) else null end
  ) into result
  from page
  left join projected on projected.attempt_id = page.id;

  return coalesce(result, jsonb_build_object(
    'date', p_date,
    'fromDate', p_date - 6,
    'toDate', p_date,
    'items', '[]'::jsonb,
    'nextCursor', null
  ));
end;
$$;

revoke all on function public.list_cleaning_history(
  uuid, uuid, date, uuid, text, integer, timestamptz, uuid
) from public, anon, authenticated;
grant execute on function public.list_cleaning_history(
  uuid, uuid, date, uuid, text, integer, timestamptz, uuid
) to service_role;
