-- #620: Broadcast only cache invalidations. Realtime WAL delivers on commit.
create function private.live_update_topic(p_session_id uuid)
returns text
language sql immutable strict set search_path = ''
as $$
  select 'rms-updates-v1:' || encode(sha256(convert_to(p_session_id::text, 'UTF8')), 'hex')
$$;

create function private.can_receive_live_updates(p_topic text)
returns boolean
language plpgsql stable security definer set search_path = ''
as $$
declare
  session_claim text := auth.jwt() ->> 'session_id';
begin
  if auth.uid() is null or session_claim is null
     or session_claim !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return false;
  end if;
  if p_topic is distinct from private.live_update_topic(session_claim::uuid) then
    return false;
  end if;
  return public.is_active_auth_session(auth.uid(), session_claim::uuid)
    and exists (
      select 1 from public.profiles p
      where p.auth_user_id = auth.uid() and p.role in ('maid', 'admin')
        and p.status = 'active' and not p.must_change_password
    );
end;
$$;

revoke all on function private.live_update_topic(uuid), private.can_receive_live_updates(text)
  from public, anon, authenticated, service_role;
grant execute on function private.can_receive_live_updates(text) to authenticated;

-- Realtime is optional in the isolated PostgreSQL harness. Hosted rollout
-- must verify the managed table, publisher, RLS and installed policies.
do $$
begin
  if to_regclass('realtime.messages') is not null
     and to_regprocedure('realtime.topic()') is not null then
    execute $policy$
      create policy rms_live_updates_receive on realtime.messages
      for select to authenticated
      using (
        topic = (select realtime.topic()) and extension = 'broadcast'
        and private.can_receive_live_updates((select realtime.topic()))
      )
    $policy$;
    execute $policy$
      create policy rms_live_updates_scope on realtime.messages
      as restrictive for select to public
      using (
        (
          not starts_with(coalesce(topic, ''), 'rms-updates-v1:')
          and not starts_with(coalesce((select realtime.topic()), ''), 'rms-updates-v1:')
        ) or case when current_user = 'authenticated' then
          topic = (select realtime.topic()) and extension = 'broadcast'
          and private.can_receive_live_updates((select realtime.topic()))
        else false end
      )
    $policy$;
    execute $policy$
      create policy rms_live_updates_server_only on realtime.messages
      as restrictive for insert to public
      with check (
        not starts_with(coalesce(topic, ''), 'rms-updates-v1:')
        and not starts_with(coalesce((select realtime.topic()), ''), 'rms-updates-v1:')
      )
    $policy$;
  end if;
end;
$$;

create function private.publish_live_update(p_payload jsonb, p_topic text)
returns void language plpgsql set search_path = ''
as $$
begin
  if to_regprocedure('realtime.send(jsonb,text,text,boolean)') is not null
     and exists (
       select 1 from pg_catalog.pg_class c
       where c.oid = to_regclass('realtime.messages') and c.relrowsecurity
     ) and 3 = (
       select count(*) from pg_catalog.pg_policy
       where polrelid = to_regclass('realtime.messages')
         and polname in ('rms_live_updates_receive', 'rms_live_updates_scope', 'rms_live_updates_server_only')
     ) then
    execute 'select realtime.send($1, ''changed'', $2, true)' using p_payload, p_topic;
  end if;
end;
$$;

create function private.send_live_update(p_recipient uuid, p_scope text, p_notification_id uuid default null)
returns void language plpgsql set search_path = ''
as $$
declare
  recipient_session record;
  payload jsonb := jsonb_strip_nulls(jsonb_build_object(
    'version', 1, 'eventId', gen_random_uuid(), 'changed', jsonb_build_array(p_scope),
    'notificationId', p_notification_id
  ));
begin
  -- Cached join authorization cannot admit a notification to a deleted
  -- session. Share locks order publishing with concurrent account or session
  -- revocation. A competing update can defer refresh to the recovery read.
  for recipient_session in
    select s.id
    from public.profiles p
    join auth.sessions s on s.user_id = p.auth_user_id
    where p.id = p_recipient and p.role in ('maid', 'admin')
      and p.status = 'active' and not p.must_change_password
      and (s.not_after is null or s.not_after > clock_timestamp())
    order by s.id
    for share of p, s skip locked
  loop
    perform private.publish_live_update(payload, private.live_update_topic(recipient_session.id));
  end loop;
exception
  when others then
    -- An optional invalidation cannot roll back a confirmed business command.
    raise warning 'RMS_LIVE_UPDATE_SKIPPED (%)', sqlstate;
end;
$$;

create function private.notify_live_assignment_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  before_recipient uuid;
  after_recipient uuid;
begin
  if tg_op <> 'INSERT' and old.is_current and old.notified_at is not null then
    before_recipient := old.maid_profile_id;
  end if;
  if tg_op <> 'DELETE' and new.is_current and new.notified_at is not null then
    after_recipient := new.maid_profile_id;
  end if;
  if before_recipient is distinct from after_recipient then
    if before_recipient is not null then
      perform private.send_live_update(before_recipient, 'assignments');
    end if;
    if after_recipient is not null then
      perform private.send_live_update(after_recipient, 'assignments');
    end if;
  end if;
  return null;
end;
$$;

create function private.notify_live_inbox_change()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform private.send_live_update(new.recipient_profile_id, 'notifications', new.id);
  elsif (new.read_at, new.resolved_at) is distinct from (old.read_at, old.resolved_at) then
    perform private.send_live_update(new.recipient_profile_id, 'notifications');
  end if;
  return null;
end;
$$;

revoke all on function private.publish_live_update(jsonb,text),
  private.send_live_update(uuid,text,uuid),
  private.notify_live_assignment_change(), private.notify_live_inbox_change()
from public, anon, authenticated, service_role;

create trigger assignment_live_updates
after insert or update of is_current, notified_at, maid_profile_id or delete on public.cleaning_assignments
for each row execute function private.notify_live_assignment_change();

create trigger notification_live_updates
after insert or update of read_at, resolved_at on public.notifications
for each row execute function private.notify_live_inbox_change();
