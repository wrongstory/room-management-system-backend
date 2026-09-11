-- #110 private Web Push subscription revision ledger. Provider delivery remains disabled.

create table private.web_push_subscriptions (
  id uuid primary key,
  profile_id uuid not null references public.profiles(id) on delete restrict,
  status text not null check (status in ('active','retired')),
  version integer not null check (version >= 1),
  current_revision_id uuid not null,
  active_endpoint_digest text,
  active_session_digest text,
  expiration_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  retired_at timestamptz,
  check (
    (status='active' and active_endpoint_digest ~ '^[0-9a-f]{64}$'
      and active_session_digest ~ '^[0-9a-f]{64}$' and retired_at is null)
    or
    (status='retired' and active_endpoint_digest is null
      and active_session_digest is null and retired_at is not null)
  )
);

create unique index web_push_subscriptions_active_endpoint_uidx
  on private.web_push_subscriptions(active_endpoint_digest)
  where status='active';
create unique index web_push_subscriptions_active_session_uidx
  on private.web_push_subscriptions(profile_id,active_session_digest)
  where status='active';
create index web_push_subscriptions_profile_status_idx
  on private.web_push_subscriptions(profile_id,status,updated_at desc,id desc);
create index web_push_subscriptions_retired_purge_idx
  on private.web_push_subscriptions(retired_at,id) where status='retired';

create table private.web_push_subscription_revisions (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references private.web_push_subscriptions(id) on delete restrict,
  revision_no integer not null check (revision_no >= 1),
  profile_id uuid not null references public.profiles(id) on delete restrict,
  endpoint_digest text not null check (endpoint_digest ~ '^[0-9a-f]{64}$'),
  session_digest text not null check (session_digest ~ '^[0-9a-f]{64}$'),
  material_digest text not null check (material_digest ~ '^[0-9a-f]{64}$'),
  expiration_at timestamptz,
  key_version text not null check (key_version ~ '^[A-Za-z0-9._-]{1,32}$'),
  created_at timestamptz not null,
  unique(subscription_id,revision_no)
);
create index web_push_subscription_revisions_retention_idx
  on private.web_push_subscription_revisions(subscription_id,created_at,id);
create index web_push_subscription_revisions_profile_idx
  on private.web_push_subscription_revisions(profile_id,created_at,id);

alter table private.web_push_subscriptions
  add constraint web_push_subscriptions_current_revision_fk
  foreign key(current_revision_id) references private.web_push_subscription_revisions(id)
  on delete restrict deferrable initially deferred;
create index web_push_subscriptions_current_revision_idx
  on private.web_push_subscriptions(current_revision_id) where current_revision_id is not null;

create table private.web_push_subscription_secrets (
  revision_id uuid primary key references private.web_push_subscription_revisions(id) on delete restrict,
  ciphertext bytea not null check (octet_length(ciphertext) between 1 and 16384),
  nonce bytea not null check (octet_length(nonce)=12),
  auth_tag bytea not null check (octet_length(auth_tag)=16),
  created_at timestamptz not null
);

create table private.web_push_subscription_events (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null,
  reason_code text not null check (reason_code in ('registered','material_rotated','session_rotated','endpoint_rotated','user_requested')),
  occurred_at timestamptz not null
);
create index web_push_subscription_events_subscription_idx
  on private.web_push_subscription_events(subscription_id,occurred_at,id);

create table private.web_push_registration_limits (
  profile_id uuid primary key references public.profiles(id) on delete restrict,
  window_started_at timestamptz not null,
  accepted_count smallint not null check (accepted_count between 0 and 10),
  updated_at timestamptz not null
);

alter table private.web_push_subscriptions enable row level security;
alter table private.web_push_subscription_revisions enable row level security;
alter table private.web_push_subscription_secrets enable row level security;
alter table private.web_push_subscription_events enable row level security;
alter table private.web_push_registration_limits enable row level security;

revoke all on private.web_push_subscriptions,private.web_push_subscription_revisions,
  private.web_push_subscription_secrets,private.web_push_subscription_events,
  private.web_push_registration_limits from public,anon,authenticated,service_role;

create function private.guard_web_push_ledgers()
returns trigger language plpgsql set search_path='' as $$
begin
  if coalesce(current_setting('app.web_push_writer_mode',true),'') <> 'typed_v1' then
    raise exception using errcode='55000',message='WEB_PUSH_LEDGER_IMMUTABLE';
  end if;
  return case when tg_op='DELETE' then old else new end;
end $$;
revoke all on function private.guard_web_push_ledgers() from public,anon,authenticated,service_role;

create trigger web_push_subscriptions_guard before insert or update or delete
on private.web_push_subscriptions for each row execute function private.guard_web_push_ledgers();
create trigger web_push_subscription_revisions_guard before insert or update or delete
on private.web_push_subscription_revisions for each row execute function private.guard_web_push_ledgers();
create trigger web_push_subscription_secrets_guard before insert or update or delete
on private.web_push_subscription_secrets for each row execute function private.guard_web_push_ledgers();
create trigger web_push_subscription_events_guard before insert or update or delete
on private.web_push_subscription_events for each row execute function private.guard_web_push_ledgers();
create trigger web_push_registration_limits_guard before insert or update or delete
on private.web_push_registration_limits for each row execute function private.guard_web_push_ledgers();

create function private.web_push_result(p_row private.web_push_subscriptions)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',p_row.id,'version',p_row.version,'status',p_row.status,
    'createdAt',p_row.created_at,'updatedAt',p_row.updated_at,'retiredAt',p_row.retired_at
  )
$$;
revoke all on function private.web_push_result(private.web_push_subscriptions)
from public,anon,authenticated,service_role;

create function private.consume_web_push_registration_limit(p_profile_id uuid,p_now timestamptz)
returns void language plpgsql set search_path=pg_catalog,private as $$
declare v_limit private.web_push_registration_limits%rowtype;
begin
  insert into private.web_push_registration_limits(profile_id,window_started_at,accepted_count,updated_at)
  values(p_profile_id,date_trunc('minute',p_now),1,p_now)
  on conflict(profile_id) do nothing;
  select * into v_limit from private.web_push_registration_limits where profile_id=p_profile_id for update;
  if v_limit.window_started_at < date_trunc('minute',p_now) then
    update private.web_push_registration_limits set window_started_at=date_trunc('minute',p_now),accepted_count=1,updated_at=p_now
    where profile_id=p_profile_id;
  elsif v_limit.accepted_count >= 10 then
    raise exception using errcode='P0001',message='WEB_PUSH_RATE_LIMITED';
  elsif v_limit.accepted_count <> 1 or v_limit.updated_at <> p_now then
    update private.web_push_registration_limits set accepted_count=accepted_count+1,updated_at=p_now
    where profile_id=p_profile_id;
  end if;
end $$;
revoke all on function private.consume_web_push_registration_limit(uuid,timestamptz)
from public,anon,authenticated,service_role;

create function public.register_web_push_subscription(
  p_actor_profile_id uuid,p_session_id uuid,p_proposed_subscription_id uuid,
  p_expected_subscription_id uuid,p_expected_version integer,
  p_endpoint_digest text,p_session_digest text,p_material_digest text,
  p_expiration_at timestamptz,p_key_version text,
  p_ciphertext_base64 text,p_nonce_base64 text,p_auth_tag_base64 text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare
  v_profile public.profiles%rowtype;
  v_existing private.command_executions%rowtype;
  v_subscription private.web_push_subscriptions%rowtype;
  v_collision private.web_push_subscriptions%rowtype;
  v_revision_id uuid:=gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_reason text;
  v_result jsonb;
begin
  perform set_config('app.web_push_writer_mode','typed_v1',true);
  begin
    if p_idempotency_key is null or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$'
      or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
      or p_endpoint_digest !~ '^[0-9a-f]{64}$' or p_session_digest !~ '^[0-9a-f]{64}$'
      or p_material_digest !~ '^[0-9a-f]{64}$' or p_key_version !~ '^[A-Za-z0-9._-]{1,32}$'
      or (p_expiration_at is not null and p_expiration_at <= v_now)
      or (p_expected_subscription_id is null) <> (p_expected_version is null)
      or p_expected_version is not null and p_expected_version < 1
      or octet_length(decode(p_nonce_base64,'base64'))<>12
      or octet_length(decode(p_auth_tag_base64,'base64'))<>16
      or octet_length(decode(p_ciphertext_base64,'base64')) not between 1 and 16384 then
      raise exception using errcode='22023',message='INVALID_WEB_PUSH_SUBSCRIPTION';
    end if;

    select * into v_profile from public.profiles where id=p_actor_profile_id for update;
    if not found or v_profile.role::text not in ('admin','maid') or v_profile.status::text<>'active'
      or v_profile.must_change_password then
      raise exception using errcode='42501',message='WEB_PUSH_ACCESS_REQUIRED';
    end if;
    perform 1 from auth.sessions where id=p_session_id and user_id=v_profile.auth_user_id for share;
    if not found then raise exception using errcode='28000',message='WEB_PUSH_SESSION_REVOKED'; end if;

    perform pg_advisory_xact_lock(hashtextextended(p_actor_profile_id::text||':web-push:'||p_idempotency_key,0));
    select * into v_existing from private.command_executions where actor_profile_id=p_actor_profile_id
      and command_type='web_push.register' and idempotency_key=p_idempotency_key;
    if found then
      if v_existing.request_hash<>p_request_hash then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
      perform set_config('app.web_push_writer_mode','',true);
      return v_existing.response_payload;
    end if;

    perform private.consume_web_push_registration_limit(p_actor_profile_id,v_now);
    -- Every active-membership mutation takes this one bounded lock. The coarse
    -- protocol trades registration throughput for deterministic lock ordering;
    -- delivery reads are unaffected and registration is already profile-limited.
    perform pg_advisory_xact_lock(hashtextextended('web-push:membership:v1',0));
    select * into v_collision from private.web_push_subscriptions
    where status='active' and active_endpoint_digest=p_endpoint_digest for update;

    if p_expected_subscription_id is null then
      if found then
        if v_collision.profile_id<>p_actor_profile_id then
          raise exception using errcode='23505',message='WEB_PUSH_ENDPOINT_CONFLICT';
        end if;
        select * into v_subscription from private.web_push_subscriptions where id=v_collision.id;
        if v_subscription.active_session_digest=p_session_digest
          and exists(select 1 from private.web_push_subscription_revisions r where r.id=v_subscription.current_revision_id
            and r.material_digest=p_material_digest and r.expiration_at is not distinct from p_expiration_at) then
          v_result:=private.web_push_result(v_subscription);
          insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload)
          values(p_actor_profile_id,'web_push.register',p_idempotency_key,p_request_hash,v_subscription.id,v_result);
          perform set_config('app.web_push_writer_mode','',true);
          return v_result;
        end if;
        raise exception using errcode='40001',message='WEB_PUSH_CAS_REQUIRED';
      end if;
      if exists(select 1 from private.web_push_subscriptions where profile_id=p_actor_profile_id
        and status='active' and active_session_digest=p_session_digest) then
        raise exception using errcode='40001',message='WEB_PUSH_CAS_REQUIRED';
      end if;
      if (select count(*) from private.web_push_subscriptions where profile_id=p_actor_profile_id and status='active')>=5 then
        raise exception using errcode='23505',message='WEB_PUSH_PROFILE_LIMIT';
      end if;
      insert into private.web_push_subscriptions(id,profile_id,status,version,current_revision_id,
        active_endpoint_digest,active_session_digest,expiration_at,created_at,updated_at)
      values(p_proposed_subscription_id,p_actor_profile_id,'active',1,v_revision_id,
        p_endpoint_digest,p_session_digest,p_expiration_at,v_now,v_now)
      returning * into v_subscription;
      v_reason:='registered';
    else
      select * into v_subscription from private.web_push_subscriptions
      where id=p_expected_subscription_id and profile_id=p_actor_profile_id for update;
      if not found or v_subscription.status<>'active' then raise exception using errcode='P0002',message='WEB_PUSH_SUBSCRIPTION_CONFLICT'; end if;
      if v_subscription.version<>p_expected_version then raise exception using errcode='40001',message='WEB_PUSH_STALE_VERSION'; end if;
      if v_collision.id is not null and v_collision.id<>v_subscription.id then
        raise exception using errcode='23505',message='WEB_PUSH_ENDPOINT_CONFLICT';
      end if;
      v_reason:=case when v_subscription.active_endpoint_digest<>p_endpoint_digest then 'endpoint_rotated'
        when v_subscription.active_session_digest<>p_session_digest then 'session_rotated' else 'material_rotated' end;
      delete from private.web_push_subscription_secrets where revision_id=v_subscription.current_revision_id;
      update private.web_push_subscriptions set version=version+1,current_revision_id=v_revision_id,
        active_endpoint_digest=p_endpoint_digest,active_session_digest=p_session_digest,
        expiration_at=p_expiration_at,updated_at=v_now
      where id=v_subscription.id returning * into v_subscription;
    end if;

    insert into private.web_push_subscription_revisions(id,subscription_id,revision_no,profile_id,
      endpoint_digest,session_digest,material_digest,expiration_at,key_version,created_at)
    values(v_revision_id,v_subscription.id,v_subscription.version,p_actor_profile_id,
      p_endpoint_digest,p_session_digest,p_material_digest,p_expiration_at,p_key_version,v_now);
    insert into private.web_push_subscription_secrets(revision_id,ciphertext,nonce,auth_tag,created_at)
    values(v_revision_id,decode(p_ciphertext_base64,'base64'),decode(p_nonce_base64,'base64'),decode(p_auth_tag_base64,'base64'),v_now);
    insert into private.web_push_subscription_events(subscription_id,reason_code,occurred_at)
    values(v_subscription.id,v_reason,v_now);
    v_result:=private.web_push_result(v_subscription);
    insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload)
    values(p_actor_profile_id,'web_push.register',p_idempotency_key,p_request_hash,v_subscription.id,v_result);
    perform set_config('app.web_push_writer_mode','',true);
    return v_result;
  exception when others then
    perform set_config('app.web_push_writer_mode','',true); raise;
  end;
end $$;

create function public.retire_web_push_subscription(
  p_actor_profile_id uuid,p_session_id uuid,p_subscription_id uuid,p_expected_version integer,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare v_profile public.profiles%rowtype; v_existing private.command_executions%rowtype;
  v_subscription private.web_push_subscriptions%rowtype; v_now timestamptz:=clock_timestamp(); v_result jsonb;
begin
  perform set_config('app.web_push_writer_mode','typed_v1',true);
  begin
    if p_expected_version is null or p_expected_version<1 or p_idempotency_key is null
      or p_idempotency_key !~ '^[A-Za-z0-9._:-]{8,128}$' or p_request_hash !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='22023',message='INVALID_WEB_PUSH_RETIRE';
    end if;
    select * into v_profile from public.profiles where id=p_actor_profile_id for update;
    if not found or v_profile.role::text not in ('admin','maid') or v_profile.status::text<>'active'
      or v_profile.must_change_password then raise exception using errcode='42501',message='WEB_PUSH_ACCESS_REQUIRED'; end if;
    perform 1 from auth.sessions where id=p_session_id and user_id=v_profile.auth_user_id for share;
    if not found then raise exception using errcode='28000',message='WEB_PUSH_SESSION_REVOKED'; end if;
    perform pg_advisory_xact_lock(hashtextextended(p_actor_profile_id::text||':web-push:'||p_idempotency_key,0));
    select * into v_existing from private.command_executions where actor_profile_id=p_actor_profile_id
      and command_type='web_push.retire' and idempotency_key=p_idempotency_key;
    if found then
      if v_existing.request_hash<>p_request_hash then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
      perform set_config('app.web_push_writer_mode','',true); return v_existing.response_payload;
    end if;
    -- Match register/rotation before any subscription row lock. This prevents
    -- endpoint-swap and rotate/retire lock-order inversions.
    perform pg_advisory_xact_lock(hashtextextended('web-push:membership:v1',0));
    select * into v_subscription from private.web_push_subscriptions
      where id=p_subscription_id and profile_id=p_actor_profile_id for update;
    if not found then raise exception using errcode='P0002',message='WEB_PUSH_SUBSCRIPTION_NOT_FOUND'; end if;
    if v_subscription.status='retired' then
      if v_subscription.version<>p_expected_version+1 then raise exception using errcode='40001',message='WEB_PUSH_STALE_VERSION'; end if;
    else
      if v_subscription.version<>p_expected_version then raise exception using errcode='40001',message='WEB_PUSH_STALE_VERSION'; end if;
      delete from private.web_push_subscription_secrets where revision_id=v_subscription.current_revision_id;
      update private.web_push_subscriptions set status='retired',version=version+1,
        active_endpoint_digest=null,active_session_digest=null,expiration_at=null,updated_at=v_now,retired_at=v_now
      where id=v_subscription.id returning * into v_subscription;
      insert into private.web_push_subscription_events(subscription_id,reason_code,occurred_at)
      values(v_subscription.id,'user_requested',v_now);
    end if;
    v_result:=private.web_push_result(v_subscription);
    insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload)
    values(p_actor_profile_id,'web_push.retire',p_idempotency_key,p_request_hash,v_subscription.id,v_result);
    perform set_config('app.web_push_writer_mode','',true); return v_result;
  exception when others then perform set_config('app.web_push_writer_mode','',true); raise; end;
end $$;

create function public.purge_retired_web_push_subscription_metadata(p_limit integer default 100)
returns integer language plpgsql security definer set search_path=pg_catalog,private as $$
declare v_count integer;
begin
  if p_limit not between 1 and 100 then raise exception using errcode='22023',message='WEB_PUSH_PURGE_LIMIT_INVALID'; end if;
  perform set_config('app.web_push_writer_mode','typed_v1',true);
  begin
    with doomed as (select id from private.web_push_subscriptions where status='retired'
      and retired_at < clock_timestamp()-interval '90 days' order by retired_at,id limit p_limit for update skip locked),
    revisions as (delete from private.web_push_subscription_revisions r using doomed d where r.subscription_id=d.id returning r.id),
    subscriptions as (delete from private.web_push_subscriptions s using doomed d where s.id=d.id returning s.id)
    select count(*) into v_count from subscriptions;
    perform set_config('app.web_push_writer_mode','',true); return v_count;
  exception when others then perform set_config('app.web_push_writer_mode','',true); raise; end;
end $$;

revoke all on function public.register_web_push_subscription(uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text)
from public,anon,authenticated;
grant execute on function public.register_web_push_subscription(uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text) to service_role;
revoke all on function public.retire_web_push_subscription(uuid,uuid,uuid,integer,text,text) from public,anon,authenticated;
grant execute on function public.retire_web_push_subscription(uuid,uuid,uuid,integer,text,text) to service_role;
revoke all on function public.purge_retired_web_push_subscription_metadata(integer) from public,anon,authenticated;
grant execute on function public.purge_retired_web_push_subscription_metadata(integer) to service_role;

comment on table private.web_push_subscription_secrets is
'#110 AES-256-GCM envelope only. Raw endpoint/key/session is forbidden; #111 may read exact current revision through a new bounded claim RPC.';
comment on function public.purge_retired_web_push_subscription_metadata(integer) is
'Bounded 90-day retired metadata purge contract. No Cron or production scheduling is enabled by #110.';
comment on function public.register_web_push_subscription(uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text) is
'All active membership mutations use one transaction-scoped global advisory lock. This intentionally bounds register/rotate/retire throughput to remove cross-row lock cycles; reads and future delivery claims do not take it.';
comment on function public.retire_web_push_subscription(uuid,uuid,uuid,integer,text,text) is
'Uses the same transaction-scoped global membership advisory lock as register/rotation before locking a subscription row.';
