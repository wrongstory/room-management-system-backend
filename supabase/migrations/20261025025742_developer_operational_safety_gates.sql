-- #396: unconfigured is UNKNOWN. This migration does NOT initialize a project,
-- choose a reauthentication TTL, request maintenance, start operation or reset data.
create table private.developer_operation_control (
  singleton boolean primary key default true check (singleton),
  target_ref text not null check (target_ref ~ '^[a-z0-9][a-z0-9-]{2,63}$'),
  policy_hash text not null check (policy_hash ~ '^[0-9a-f]{64}$'),
  reauth_ttl_seconds integer not null check (reauth_ttl_seconds > 0),
  lifecycle text not null check (lifecycle in ('UNKNOWN', 'PROVISIONING', 'STARTED')),
  maintenance text not null default 'OPEN' check (maintenance in ('OPEN', 'REQUESTED')),
  version bigint not null default 1 check (version > 0),
  started_at timestamptz,
  check ((lifecycle = 'STARTED') = (started_at is not null))
);

create table private.developer_operation_reauth (
  id uuid primary key default gen_random_uuid(),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  actor_profile_id uuid not null,
  auth_user_id uuid not null,
  session_digest text not null,
  password_version text not null,
  target_ref text not null,
  policy_hash text not null,
  control_version bigint not null,
  action text not null check (action in ('RESET_REVIEW', 'REQUEST_MAINTENANCE', 'RESUME_ADMISSION', 'START_OPERATION')),
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  state text not null default 'CHALLENGE' check (state in ('CHALLENGE', 'PROBE_VERIFIED', 'READY', 'CONSUMED')),
  probe_session_digest text unique,
  verified_at timestamptz,
  consumed_at timestamptz,
  check (expires_at > created_at),
  check ((state = 'CHALLENGE') = (probe_session_digest is null)),
  check ((state in ('READY', 'CONSUMED')) = (verified_at is not null)),
  check ((state = 'CONSUMED') = (consumed_at is not null))
);
create index developer_operation_reauth_actor_idx
  on private.developer_operation_reauth(actor_profile_id, expires_at);

create table private.developer_operation_admissions (
  id uuid primary key default gen_random_uuid(),
  control_version bigint not null,
  kind text not null check (kind in ('BUSINESS_WRITE', 'AUTH_WRITE', 'BACKGROUND_WORKER')),
  owner_digest text not null check (owner_digest ~ '^[0-9a-f]{64}$'),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null,
  completed_at timestamptz,
  unique(owner_digest, nonce_hash),
  check (deadline_at > created_at)
);
create index developer_operation_admissions_unfinished_idx
  on private.developer_operation_admissions(created_at) where completed_at is null;

create table private.developer_operation_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default clock_timestamp(),
  control_version bigint not null,
  actor_profile_id uuid not null,
  action text not null check (action in ('REQUEST_MAINTENANCE', 'RESUME_ADMISSION', 'START_OPERATION')),
  receipt_id uuid not null unique references private.developer_operation_reauth(id)
);
-- No FK to account tables: these security receipts survive a later approved reset.
alter table private.developer_operation_control enable row level security;
alter table private.developer_operation_reauth enable row level security;
alter table private.developer_operation_admissions enable row level security;
alter table private.developer_operation_events enable row level security;
revoke all on private.developer_operation_control, private.developer_operation_reauth,
  private.developer_operation_admissions, private.developer_operation_events
  from public, anon, authenticated, service_role;

create function private.protect_developer_operation_control()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'OPERATION_CONTROL_IMMUTABLE';
  end if;
  if old.target_ref is distinct from new.target_ref
    or new.version <> old.version + 1
    or (old.lifecycle = 'STARTED' and (new.lifecycle <> 'STARTED'
      or new.started_at is distinct from old.started_at)) then
    raise exception using errcode = '42501', message = 'OPERATION_CONTROL_TRANSITION_REJECTED';
  end if;
  return new;
end;
$$;
create trigger protect_developer_operation_control
before update or delete on private.developer_operation_control
for each row execute function private.protect_developer_operation_control();

create function private.protect_developer_operation_events()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception using errcode = '42501', message = 'OPERATION_EVENTS_APPEND_ONLY';
end;
$$;
create trigger protect_developer_operation_events
before update or delete on private.developer_operation_events
for each row execute function private.protect_developer_operation_events();

create function private.operation_secret_digest(p_value text)
returns text language sql immutable strict set search_path = pg_catalog as $$
  select encode(extensions.digest('developer-operation-v1:' || p_value, 'sha256'), 'hex');
$$;

create function private.assert_developer_operation_actor(p_actor uuid, p_auth uuid, p_session text)
returns void language plpgsql volatile security definer set search_path = pg_catalog as $$
declare v_context jsonb;
begin
  v_context := public.get_active_auth_context(p_auth, p_session);
  if v_context ->> 'code' is distinct from 'OK'
    or v_context #>> '{profile,id}' is distinct from p_actor::text
    or v_context #>> '{profile,role}' is distinct from 'developer'
    or v_context #>> '{profile,must_change_password}' is distinct from 'false'
    or not exists (select 1 from public.profiles p where p.id = p_actor and p.auth_user_id = p_auth
      and p.deactivated_at is null and (p.locked_until is null or p.locked_until <= clock_timestamp()))
    or (select count(*) from public.profiles where role = 'developer') <> 1 then
    raise exception using errcode = '42501', message = 'OPERATION_ACTOR_REJECTED';
  end if;
end;
$$;

create function public.begin_developer_operation_reauth(
  p_actor uuid, p_auth uuid, p_session text, p_target text, p_version bigint, p_action text
) returns jsonb language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_control private.developer_operation_control; v_nonce text; v_id uuid; v_expiry timestamptz;
begin
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
  select * into v_control from private.developer_operation_control where singleton for update;
  if not found or v_control.target_ref is distinct from p_target
    or v_control.version is distinct from p_version or v_control.lifecycle <> 'PROVISIONING'
    or p_action is null or p_action not in ('RESET_REVIEW', 'REQUEST_MAINTENANCE', 'RESUME_ADMISSION', 'START_OPERATION') then
    raise exception using errcode = '42501', message = 'OPERATION_CONTROL_UNAVAILABLE';
  end if;
  v_nonce := encode(extensions.gen_random_bytes(32), 'hex');
  v_expiry := clock_timestamp() + v_control.reauth_ttl_seconds * interval '1 second';
  insert into private.developer_operation_reauth(nonce_hash, actor_profile_id, auth_user_id,
    session_digest, password_version, target_ref, policy_hash, control_version, action, expires_at)
  values (private.operation_secret_digest(v_nonce), p_actor, p_auth,
    private.operation_secret_digest(p_session), public.get_auth_password_version(p_auth),
    p_target, v_control.policy_hash, p_version, p_action, v_expiry) returning id into v_id;
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
  return jsonb_build_object('challengeId', v_id, 'nonce', v_nonce, 'expiresAt', v_expiry);
end;
$$;

-- This is a trusted DB check, not a boolean asserted by an HTTP caller. No Auth
-- credential, token or AMR payload leaves the DB. AMR schema: upstream Supabase
-- Auth migration 20221003041349_add_mfa_schema.up.sql (password method).
create function public.verify_developer_operation_probe(
  p_actor uuid, p_auth uuid, p_session text, p_challenge uuid, p_nonce text, p_probe_session uuid
) returns void language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_receipt private.developer_operation_reauth; v_control private.developer_operation_control;
begin
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
  select * into v_control from private.developer_operation_control where singleton for update;
  select * into v_receipt from private.developer_operation_reauth where id = p_challenge for update;
  if v_receipt.id is null or v_control.singleton is null
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or v_receipt.state <> 'CHALLENGE' or v_receipt.expires_at <= clock_timestamp()
    or v_receipt.actor_profile_id is distinct from p_actor or v_receipt.auth_user_id is distinct from p_auth
    or v_receipt.session_digest is distinct from private.operation_secret_digest(p_session)
    or v_receipt.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or v_receipt.control_version <> v_control.version or v_receipt.target_ref <> v_control.target_ref
    or v_receipt.policy_hash <> v_control.policy_hash or v_control.lifecycle <> 'PROVISIONING'
    or v_receipt.password_version is distinct from public.get_auth_password_version(p_auth)
    or p_probe_session::text is not distinct from p_session
    or not exists (select 1 from auth.sessions s join auth.mfa_amr_claims a on a.session_id = s.id
      where s.id = p_probe_session and s.user_id = p_auth and s.created_at >= v_receipt.created_at
        and s.created_at <= clock_timestamp() and (s.not_after is null or s.not_after > clock_timestamp())
        and a.authentication_method = 'password' and a.created_at >= v_receipt.created_at
        and a.created_at <= clock_timestamp()) then
    raise exception using errcode = '42501', message = 'OPERATION_REAUTH_REJECTED';
  end if;
  update private.developer_operation_reauth set state = 'PROBE_VERIFIED',
    probe_session_digest = private.operation_secret_digest(p_probe_session::text) where id = p_challenge;
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
end;
$$;

create function public.finish_developer_operation_reauth(
  p_actor uuid, p_auth uuid, p_session text, p_challenge uuid, p_nonce text
) returns void language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_receipt private.developer_operation_reauth; v_control private.developer_operation_control;
begin
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
  select * into v_control from private.developer_operation_control where singleton for update;
  select * into v_receipt from private.developer_operation_reauth where id = p_challenge for update;
  if v_receipt.id is null or v_control.singleton is null
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or v_receipt.state <> 'PROBE_VERIFIED' or v_receipt.expires_at <= clock_timestamp()
    or v_receipt.actor_profile_id is distinct from p_actor or v_receipt.auth_user_id is distinct from p_auth
    or v_receipt.session_digest is distinct from private.operation_secret_digest(p_session)
    or v_receipt.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or v_receipt.control_version <> v_control.version or v_receipt.target_ref <> v_control.target_ref
    or v_receipt.policy_hash <> v_control.policy_hash or v_control.lifecycle <> 'PROVISIONING'
    or v_receipt.password_version is distinct from public.get_auth_password_version(p_auth)
    or exists (select 1 from auth.sessions s where s.user_id = p_auth
      and private.operation_secret_digest(s.id::text) = v_receipt.probe_session_digest) then
    raise exception using errcode = '42501', message = 'OPERATION_REAUTH_REJECTED';
  end if;
  update private.developer_operation_reauth set state = 'READY', verified_at = clock_timestamp()
    where id = p_challenge;
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
end;
$$;

-- Internal transition capability. No service role grant or HTTP route can
-- activate these transitions until the exact deployment/policy is approved.
-- RESET_REVIEW receipts intentionally have no reset/delete consumer here.
create function private.transition_developer_operation(
  p_actor uuid, p_auth uuid, p_session text, p_challenge uuid, p_nonce text, p_action text
) returns bigint language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_receipt private.developer_operation_reauth; v_control private.developer_operation_control; v_version bigint;
begin
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
  select * into v_control from private.developer_operation_control where singleton for update;
  select * into v_receipt from private.developer_operation_reauth where id = p_challenge for update;
  if v_receipt.id is null or v_control.singleton is null
    or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or v_receipt.state <> 'READY' or v_receipt.expires_at <= clock_timestamp()
    or v_receipt.actor_profile_id is distinct from p_actor or v_receipt.auth_user_id is distinct from p_auth
    or v_receipt.session_digest is distinct from private.operation_secret_digest(p_session)
    or v_receipt.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
    or v_receipt.action is distinct from p_action or v_receipt.control_version <> v_control.version
    or v_receipt.target_ref <> v_control.target_ref or v_receipt.policy_hash <> v_control.policy_hash
    or v_receipt.password_version is distinct from public.get_auth_password_version(p_auth)
    or v_control.lifecycle <> 'PROVISIONING'
    or p_action is null or p_action not in ('REQUEST_MAINTENANCE', 'RESUME_ADMISSION', 'START_OPERATION')
    or (p_action = 'REQUEST_MAINTENANCE' and v_control.maintenance <> 'OPEN')
    or (p_action = 'RESUME_ADMISSION' and v_control.maintenance <> 'REQUESTED')
    or (p_action = 'START_OPERATION' and v_control.maintenance <> 'OPEN') then
    raise exception using errcode = '42501', message = 'OPERATION_TRANSITION_REJECTED';
  end if;
  update private.developer_operation_control set version = version + 1,
    maintenance = case p_action when 'REQUEST_MAINTENANCE' then 'REQUESTED'
      when 'RESUME_ADMISSION' then 'OPEN' else maintenance end,
    lifecycle = case when p_action = 'START_OPERATION' then 'STARTED' else lifecycle end,
    started_at = case when p_action = 'START_OPERATION' then clock_timestamp() else started_at end
    where singleton returning version into v_version;
  update private.developer_operation_reauth set state = 'CONSUMED', consumed_at = clock_timestamp()
    where id = p_challenge;
  insert into private.developer_operation_events(control_version, actor_profile_id, action, receipt_id)
    values (v_version, p_actor, p_action, p_challenge);
  perform private.assert_developer_operation_actor(p_actor, p_auth, p_session);
  return v_version;
end;
$$;

-- Admission primitives must be held across the *entire* effect by an integrated
-- trusted adapter. Deadline expiry is UNKNOWN, never completion or permission
-- to start another external effect. These functions are not wired to all paths.
create function private.acquire_developer_operation_admission(
  p_target text, p_version bigint, p_kind text, p_owner_digest text, p_nonce text, p_deadline timestamptz
) returns uuid language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
declare v_control private.developer_operation_control; v_id uuid;
begin
  select * into v_control from private.developer_operation_control where singleton for update;
  if not found or v_control.target_ref is distinct from p_target
    or v_control.version is distinct from p_version or v_control.lifecycle = 'UNKNOWN'
    or v_control.maintenance <> 'OPEN' or p_nonce is null or p_nonce !~ '^[0-9a-f]{64}$'
    or p_deadline is null or not isfinite(p_deadline) or p_deadline <= clock_timestamp() then
    raise exception using errcode = '42501', message = 'OPERATION_ADMISSION_REJECTED';
  end if;
  insert into private.developer_operation_admissions(control_version, kind, owner_digest, nonce_hash, deadline_at)
    values (p_version, p_kind, p_owner_digest, private.operation_secret_digest(p_nonce), p_deadline)
    returning id into v_id;
  return v_id;
end;
$$;

create function private.complete_developer_operation_admission(p_id uuid, p_owner_digest text, p_nonce text)
returns void language plpgsql volatile security definer set search_path = pg_catalog
set lock_timeout = '2s' set statement_timeout = '7s' as $$
begin
  update private.developer_operation_admissions set completed_at = clock_timestamp()
    where id = p_id and owner_digest = p_owner_digest
      and nonce_hash = private.operation_secret_digest(p_nonce) and completed_at is null;
  if not found then raise exception using errcode = '42501', message = 'OPERATION_ADMISSION_REJECTED'; end if;
end;
$$;

create function private.collect_developer_operation_gates()
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select jsonb_build_object('format', 'developer-operation-gates-v1',
    'lifecycle', coalesce(c.lifecycle, 'UNKNOWN'),
    'controlVersion', c.version::text, 'maintenance', coalesce(c.maintenance, 'UNKNOWN'),
    'policyConfigured', c.singleton is not null,
    'unfinishedAdmissions', (select count(*) from private.developer_operation_admissions where completed_at is null),
    'expiredUnfinishedAdmissions', (select count(*) from private.developer_operation_admissions
      where completed_at is null and deadline_at <= statement_timestamp()),
    'unresolvedPasswordChanges', (select count(*) from private.password_change_commands
      where state in ('auth_pending', 'inconsistent', 'reset_pending')),
    'preparedPasswordResets', (select count(*) from private.password_reset_auth_markers where state = 'prepared'),
    'coverage', 'NOT_INTEGRATED', 'recentReauthentication', 'NOT_EVALUATED', 'executionEnabled', false)
  from (values (true)) as singleton(value)
  left join private.developer_operation_control c on c.singleton = singleton.value;
$$;

-- All three STABLE collectors execute in the same outer SELECT snapshot. Keep
-- the public VOLATILE wrapper's before/after live Auth checks unchanged.
create or replace function private.collect_developer_reset_impact_preview()
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select private.collect_developer_reset_inventory() || jsonb_build_object(
    'rowImpact', private.collect_developer_reset_row_impact(),
    'gateEvidence', private.collect_developer_operation_gates());
$$;
alter function private.collect_developer_reset_impact_preview() owner to postgres;
revoke all on function private.collect_developer_reset_impact_preview() from public, anon, authenticated, service_role;

revoke all on function private.protect_developer_operation_control(), private.protect_developer_operation_events(),
  private.operation_secret_digest(text), private.assert_developer_operation_actor(uuid,uuid,text),
  private.transition_developer_operation(uuid,uuid,text,uuid,text,text),
  private.acquire_developer_operation_admission(text,bigint,text,text,text,timestamptz),
  private.complete_developer_operation_admission(uuid,text,text), private.collect_developer_operation_gates()
  from public, anon, authenticated, service_role;
revoke all on function public.begin_developer_operation_reauth(uuid,uuid,text,text,bigint,text),
  public.verify_developer_operation_probe(uuid,uuid,text,uuid,text,uuid),
  public.finish_developer_operation_reauth(uuid,uuid,text,uuid,text) from public, anon, authenticated, service_role;
grant execute on function public.begin_developer_operation_reauth(uuid,uuid,text,text,bigint,text),
  public.verify_developer_operation_probe(uuid,uuid,text,uuid,text,uuid),
  public.finish_developer_operation_reauth(uuid,uuid,text,uuid,text) to service_role;

alter function private.protect_developer_operation_control() owner to postgres;
alter function private.protect_developer_operation_events() owner to postgres;
alter function private.operation_secret_digest(text) owner to postgres;
alter function private.assert_developer_operation_actor(uuid,uuid,text) owner to postgres;
alter function public.begin_developer_operation_reauth(uuid,uuid,text,text,bigint,text) owner to postgres;
alter function public.verify_developer_operation_probe(uuid,uuid,text,uuid,text,uuid) owner to postgres;
alter function public.finish_developer_operation_reauth(uuid,uuid,text,uuid,text) owner to postgres;
alter function private.transition_developer_operation(uuid,uuid,text,uuid,text,text) owner to postgres;
alter function private.acquire_developer_operation_admission(text,bigint,text,text,text,timestamptz) owner to postgres;
alter function private.complete_developer_operation_admission(uuid,text,text) owner to postgres;
alter function private.collect_developer_operation_gates() owner to postgres;
