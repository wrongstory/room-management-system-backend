-- #108 exposes only a bounded, actor-bound notification projection. The raw
-- ledger stays outside the Data API, while RLS remains a second line of defence.

create index notifications_recipient_occurred_id_idx
on public.notifications (recipient_profile_id, occurred_at desc, id desc);

drop policy if exists notifications_read_scoped on public.notifications;
drop policy if exists notifications_update_own on public.notifications;

create function private.notification_rls_actor_is_recipient(p_recipient_profile_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_auth_user_id uuid;
  v_session_text text;
  v_session_id uuid;
begin
  v_auth_user_id := auth.uid();
  v_session_text := auth.jwt() ->> 'session_id';
  if v_auth_user_id is null or v_session_text is null or v_session_text = '' then
    return false;
  end if;
  begin
    v_session_id := v_session_text::uuid;
  exception when invalid_text_representation then
    return false;
  end;
  return exists (
    select 1
    from public.profiles actor
    join auth.sessions session
      on session.id = v_session_id
     and session.user_id = actor.auth_user_id
     and (session.not_after is null or session.not_after > current_timestamp)
    where actor.id = p_recipient_profile_id
      and actor.auth_user_id = v_auth_user_id
      and actor.status = 'active'
      and not actor.must_change_password
      and actor.role in ('admin', 'maid')
  );
end
$$;

revoke all on function private.notification_rls_actor_is_recipient(uuid)
from public, anon, authenticated, service_role;
grant execute on function private.notification_rls_actor_is_recipient(uuid) to authenticated;

create policy notifications_read_own_defense
on public.notifications
for select
to authenticated
using (
  (select private.notification_rls_actor_is_recipient(notifications.recipient_profile_id))
);

-- Raw REST/GraphQL access would reveal grouping and deduplication internals.
-- App-owned SECURITY DEFINER RPCs below are the only read/update surface.
revoke select, update on table public.notifications
from public, anon, authenticated, service_role;

create function private.guard_notification_ledger()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'NOTIFICATION_DELETE_FORBIDDEN';
  end if;

  if new.id is distinct from old.id
    or new.recipient_profile_id is distinct from old.recipient_profile_id
    or new.category is distinct from old.category
    or new.title is distinct from old.title
    or new.body is distinct from old.body
    or new.room_id is distinct from old.room_id
    or new.cleaning_target_id is distinct from old.cleaning_target_id
    or new.dedupe_key is distinct from old.dedupe_key
    or new.group_key is distinct from old.group_key
    or new.requires_action is distinct from old.requires_action
    or new.occurred_at is distinct from old.occurred_at
    or new.created_at is distinct from old.created_at then
    raise exception using errcode = '55000', message = 'NOTIFICATION_CONTENT_IMMUTABLE';
  end if;

  if old.read_at is not null and new.read_at is distinct from old.read_at then
    raise exception using errcode = '55000', message = 'NOTIFICATION_READ_AT_IMMUTABLE';
  end if;
  if old.read_at is null and new.read_at is not null then
    if current_user <> 'postgres'
      or coalesce(current_setting('app.notification_write_mode', true), '') <> 'mark_read' then
      raise exception using errcode = '42501', message = 'NOTIFICATION_MARK_READ_COMMAND_REQUIRED';
    end if;
    new.read_at := clock_timestamp();
  end if;

  if old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at then
    raise exception using errcode = '55000', message = 'NOTIFICATION_RESOLVED_AT_IMMUTABLE';
  end if;
  if old.resolved_at is null and new.resolved_at is not null and current_user <> 'postgres' then
    raise exception using errcode = '42501', message = 'NOTIFICATION_DOMAIN_RESOLUTION_REQUIRED';
  end if;

  return new;
end
$$;

revoke all on function private.guard_notification_ledger()
from public, anon, authenticated, service_role;

create trigger notification_ledger_guard
before update or delete on public.notifications
for each row execute function private.guard_notification_ledger();

create function private.assert_notification_actor(
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
    and actor.role in ('admin', 'maid');

  if v_actor.id is null then
    raise exception using errcode = '42501', message = 'NOTIFICATION_ACCESS_REQUIRED';
  end if;
  return v_actor;
end
$$;

revoke all on function private.assert_notification_actor(uuid, uuid)
from public, anon, authenticated, service_role;

create function private.notification_public_projection(p_notice public.notifications)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', p_notice.id,
    'category', p_notice.category,
    'title', p_notice.title,
    'body', p_notice.body,
    'roomId', p_notice.room_id,
    'cleaningTargetId', p_notice.cleaning_target_id,
    'requiresAction', p_notice.requires_action,
    'readAt', p_notice.read_at,
    'resolvedAt', p_notice.resolved_at,
    'occurredAt', p_notice.occurred_at
  )
$$;

revoke all on function private.notification_public_projection(public.notifications)
from public, anon, authenticated, service_role;

create function public.list_notifications_page(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_after_occurred_at timestamptz default null,
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
  v_last_occurred_at timestamptz;
  v_last_id uuid;
begin
  v_actor := private.assert_notification_actor(p_actor_profile_id, p_session_id);
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception using errcode = '22023', message = 'NOTIFICATION_PAGE_LIMIT_INVALID';
  end if;
  if (p_after_occurred_at is null) <> (p_after_id is null)
    or (p_after_occurred_at is not null and not isfinite(p_after_occurred_at)) then
    raise exception using errcode = '22023', message = 'INVALID_NOTIFICATION_CURSOR';
  end if;

  with page as (
    select notice.*
    from public.notifications notice
    where notice.recipient_profile_id = v_actor.id
      and (
        p_after_occurred_at is null
        or (notice.occurred_at, notice.id) < (p_after_occurred_at, p_after_id)
      )
    order by notice.occurred_at desc, notice.id desc
    limit p_limit + 1
  ), kept as (
    select * from page
    order by occurred_at desc, id desc
    limit p_limit
  )
  select
    coalesce(
      jsonb_agg(private.notification_public_projection(kept) order by kept.occurred_at desc, kept.id desc),
      '[]'::jsonb
    ),
    (select count(*) > p_limit from page),
    (select occurred_at from kept order by occurred_at, id limit 1),
    (select id from kept order by occurred_at, id limit 1)
  into v_rows, v_has_more, v_last_occurred_at, v_last_id
  from kept;

  return jsonb_build_object(
    'notifications', v_rows,
    'hasMore', coalesce(v_has_more, false),
    'lastOccurredAt', case when v_has_more then v_last_occurred_at else null end,
    'lastId', case when v_has_more then v_last_id else null end
  );
end
$$;

create function public.mark_notification_read(
  p_actor_profile_id uuid,
  p_session_id uuid,
  p_notification_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.profiles;
  v_notice public.notifications;
  v_previous_write_mode text;
begin
  v_actor := private.assert_notification_actor(p_actor_profile_id, p_session_id);

  select notice.*
  into v_notice
  from public.notifications notice
  where notice.id = p_notification_id
    and notice.recipient_profile_id = v_actor.id
  for update;

  if v_notice.id is null then
    raise exception using errcode = 'P0002', message = 'NOTIFICATION_NOT_FOUND';
  end if;

  if v_notice.read_at is null then
    v_previous_write_mode := current_setting('app.notification_write_mode', true);
    perform set_config('app.notification_write_mode', 'mark_read', true);
    begin
      update public.notifications notice
      set read_at = clock_timestamp()
      where notice.id = v_notice.id
      returning notice.* into v_notice;
    exception when others then
      perform set_config('app.notification_write_mode', coalesce(v_previous_write_mode, ''), true);
      raise;
    end;
    perform set_config('app.notification_write_mode', coalesce(v_previous_write_mode, ''), true);
  end if;

  return private.notification_public_projection(v_notice);
end
$$;

revoke all on function public.list_notifications_page(uuid, uuid, timestamptz, uuid, integer),
  public.mark_notification_read(uuid, uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.list_notifications_page(uuid, uuid, timestamptz, uuid, integer),
  public.mark_notification_read(uuid, uuid, uuid)
to service_role;

comment on function public.list_notifications_page(uuid, uuid, timestamptz, uuid, integer) is
'#108 service-only own notification projection; bounded occurred_at/id descending keyset.';
comment on function public.mark_notification_read(uuid, uuid, uuid) is
'#108 service-only monotonic server-time markRead; replay and concurrent calls preserve the first readAt.';
