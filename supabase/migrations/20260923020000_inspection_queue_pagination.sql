-- Issue #170: bounded, stable inspection queue pagination.
-- The existing history/list RPC remains unchanged for backwards compatibility.

create index cleaning_submissions_pending_queue_idx
on public.cleaning_submissions (submitted_at, id)
where status = 'submitted';

create function private.assert_inspection_queue_actor(
  p_actor_profile_id uuid,
  p_session_id uuid
)
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
begin
  select actor.*
  into v_actor
  from public.profiles actor
  join auth.sessions session
    on session.id = p_session_id
   and session.user_id = actor.auth_user_id
   and (session.not_after is null or session.not_after > current_timestamp)
  where actor.id = p_actor_profile_id
    and actor.status = 'active'
    and not actor.must_change_password
    and actor.role = 'admin';

  if v_actor.id is null then
    raise exception using errcode = '42501', message = 'ADMIN_REQUIRED';
  end if;
  return v_actor;
end
$$;

revoke all on function private.assert_inspection_queue_actor(uuid, uuid)
from public, anon, authenticated, service_role;

create function public.list_cleaning_inspections_page(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_after_submitted_at timestamptz default null,
  p_after_id uuid default null,
  p_limit integer default 50
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_rows jsonb;
  v_has_more boolean;
  v_last_submitted_at timestamptz;
  v_last_id uuid;
begin
  v_actor := private.assert_inspection_queue_actor(p_actor_profile_id, p_session_id);

  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'INSPECTION_PAGE_LIMIT_INVALID';
  end if;
  if (p_after_submitted_at is null) <> (p_after_id is null)
    or (p_after_submitted_at is not null and not isfinite(p_after_submitted_at)) then
    raise exception using errcode = '22023', message = 'INVALID_INSPECTION_CURSOR';
  end if;

  with page as (
    select submission.id, submission.submitted_at
    from public.cleaning_submissions submission
    where submission.status = 'submitted'
      and (
        p_after_submitted_at is null
        or (submission.submitted_at, submission.id) > (p_after_submitted_at, p_after_id)
      )
    order by submission.submitted_at, submission.id
    limit p_limit + 1
  ), kept as (
    select *
    from page
    order by submitted_at, id
    limit p_limit
  )
  select
    coalesce(
      jsonb_agg(
        private.submission_projection(kept.id)
          || jsonb_build_object(
            'reviewContext', private.submission_review_context(kept.id)
          )
        order by kept.submitted_at, kept.id
      ),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page),
    (select submitted_at from kept order by submitted_at desc, id desc limit 1),
    (select id from kept order by submitted_at desc, id desc limit 1)
  into v_rows, v_has_more, v_last_submitted_at, v_last_id
  from kept;

  return jsonb_build_object(
    'submissions', v_rows,
    'hasMore', coalesce(v_has_more, false),
    'lastSubmittedAt', case when v_has_more then v_last_submitted_at else null end,
    'lastId', case when v_has_more then v_last_id else null end
  );
end
$$;

revoke all on function public.list_cleaning_inspections_page(
  uuid, uuid, timestamptz, uuid, integer
)
from public, anon, authenticated;

grant execute on function public.list_cleaning_inspections_page(
  uuid, uuid, timestamptz, uuid, integer
)
to service_role;
