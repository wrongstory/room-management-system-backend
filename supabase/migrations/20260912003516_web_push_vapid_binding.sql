-- Issue #112: immutable VAPID revision binding and delivery activation health.
-- This migration intentionally creates no cron job, Vault secret, pg_net call, or production data.

alter table private.web_push_subscription_revisions
  add column vapid_key_version text
  check (vapid_key_version is null or vapid_key_version ~ '^[A-Za-z0-9._-]{1,32}$');

comment on column private.web_push_subscription_revisions.vapid_key_version is
'#112 immutable VAPID signing-key version selected by the server during registration. NULL is legacy/unbound and must never be guessed.';

create function private.bind_web_push_vapid_key_version()
returns trigger language plpgsql set search_path='' as $$
declare v_version text:=current_setting('app.web_push_vapid_key_version',true);
begin
  if tg_op<>'INSERT' or coalesce(current_setting('app.web_push_writer_mode',true),'')<>'typed_v1'
    or v_version is null or v_version !~ '^[A-Za-z0-9._-]{1,32}$' then
    raise exception using errcode='55000',message='WEB_PUSH_VAPID_BINDING_REQUIRED';
  end if;
  new.vapid_key_version:=v_version;
  return new;
end $$;
revoke all on function private.bind_web_push_vapid_key_version() from public,anon,authenticated,service_role;

create trigger a_web_push_subscription_revision_vapid_binding
before insert on private.web_push_subscription_revisions for each row
execute function private.bind_web_push_vapid_key_version();

alter function public.register_web_push_subscription(
  uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text
) rename to register_web_push_subscription_unbound_legacy;

revoke all on function public.register_web_push_subscription_unbound_legacy(
  uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text
) from public,anon,authenticated,service_role;

create function public.register_web_push_subscription(
  p_actor_profile_id uuid,p_session_id uuid,p_proposed_subscription_id uuid,
  p_expected_subscription_id uuid,p_expected_version integer,
  p_endpoint_digest text,p_session_digest text,p_material_digest text,
  p_expiration_at timestamptz,p_key_version text,
  p_ciphertext_base64 text,p_nonce_base64 text,p_auth_tag_base64 text,
  p_idempotency_key text,p_request_hash text,p_vapid_key_version text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_previous text:=current_setting('app.web_push_vapid_key_version',true);
  v_result jsonb; v_bound text;
begin
  if p_vapid_key_version is null or p_vapid_key_version !~ '^[A-Za-z0-9._-]{1,32}$' then
    raise exception using errcode='22023',message='WEB_PUSH_VAPID_BINDING_INVALID';
  end if;
  perform set_config('app.web_push_vapid_key_version',p_vapid_key_version,true);
  begin
    v_result:=public.register_web_push_subscription_unbound_legacy(
      p_actor_profile_id,p_session_id,p_proposed_subscription_id,
      p_expected_subscription_id,p_expected_version,p_endpoint_digest,
      p_session_digest,p_material_digest,p_expiration_at,p_key_version,
      p_ciphertext_base64,p_nonce_base64,p_auth_tag_base64,p_idempotency_key,p_request_hash
    );
    select r.vapid_key_version into v_bound
    from private.web_push_subscriptions s
    join private.web_push_subscription_revisions r on r.id=s.current_revision_id
    where s.id=(v_result->>'id')::uuid;
    if v_bound is distinct from p_vapid_key_version then
      raise exception using errcode='55000',message='WEB_PUSH_VAPID_BINDING_CONFLICT';
    end if;
    perform set_config('app.web_push_vapid_key_version',coalesce(v_previous,''),true);
    return v_result;
  exception when others then
    perform set_config('app.web_push_vapid_key_version',coalesce(v_previous,''),true);
    raise;
  end;
end $$;

revoke all on function public.register_web_push_subscription(
  uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.register_web_push_subscription(
  uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text,text
) to service_role;

alter table private.notification_delivery_targets
  drop constraint notification_delivery_targets_reason_code_check;
alter table private.notification_delivery_targets
  add constraint notification_delivery_targets_reason_code_check check (reason_code is null or reason_code in (
    'STALE_NOTIFICATION','RECIPIENT_NOT_ELIGIBLE','NOTIFICATION_RESOLVED',
    'SUBSCRIPTION_EXPIRED','SUBSCRIPTION_RETIRED','REVISION_SUPERSEDED',
    'SESSION_REVOKED','ENVELOPE_UNAVAILABLE','VAPID_KEY_UNBOUND','PAYLOAD_TOO_LARGE','ENDPOINT_GONE',
    'RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','TIMEOUT','PAYLOAD_REJECTED',
    'PROVIDER_CONFIGURATION_ERROR','RETRY_EXHAUSTED'
  ));
alter table private.notification_delivery_attempt_results
  drop constraint notification_delivery_attempt_results_reason_code_check;
alter table private.notification_delivery_attempt_results
  add constraint notification_delivery_attempt_results_reason_code_check check (reason_code is null or reason_code in (
    'STALE_NOTIFICATION','RECIPIENT_NOT_ELIGIBLE','NOTIFICATION_RESOLVED',
    'SUBSCRIPTION_EXPIRED','SUBSCRIPTION_RETIRED','REVISION_SUPERSEDED',
    'SESSION_REVOKED','ENVELOPE_UNAVAILABLE','VAPID_KEY_UNBOUND','PAYLOAD_TOO_LARGE','ENDPOINT_GONE',
    'RATE_LIMITED','PROVIDER_ERROR','NETWORK_ERROR','TIMEOUT','PAYLOAD_REJECTED',
    'PROVIDER_CONFIGURATION_ERROR','RETRY_EXHAUSTED'
  ));

alter function public.get_notification_delivery_envelope(uuid,integer,text)
  rename to get_notification_delivery_envelope_unbound_legacy;
revoke all on function public.get_notification_delivery_envelope_unbound_legacy(uuid,integer,text)
  from public,anon,authenticated,service_role;

create function public.get_notification_delivery_envelope(
  p_target_id uuid,p_lease_version integer,p_claim_digest text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_target private.notification_delivery_targets;
  v_attempt private.notification_delivery_attempts; v_vapid_version text;
  v_previous text:=current_setting('app.notification_delivery_writer_mode',true);
begin
  v_result:=public.get_notification_delivery_envelope_unbound_legacy(
    p_target_id,p_lease_version,p_claim_digest
  );
  if coalesce((v_result->>'sendAllowed')::boolean,false) then
    select * into v_target from private.notification_delivery_targets where id=p_target_id for update;
    select * into v_attempt from private.notification_delivery_attempts
      where target_id=p_target_id and lease_version=p_lease_version;
    select vapid_key_version into v_vapid_version
      from private.web_push_subscription_revisions where id=v_target.subscription_revision_id;
    if v_vapid_version is null then
      perform set_config('app.notification_delivery_writer_mode','typed_v1',true);
      perform private.finish_notification_delivery_target(
        p_target_id,v_attempt.id,'dead_letter','suppressed','VAPID_KEY_UNBOUND'
      );
      perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
      return jsonb_build_object('sendAllowed',false,'reasonCode','VAPID_KEY_UNBOUND');
    end if;
    v_result:=v_result||jsonb_build_object('vapidKeyVersion',v_vapid_version);
  end if;
  return v_result;
exception when others then
  perform set_config('app.notification_delivery_writer_mode',coalesce(v_previous,''),true);
  raise;
end $$;
revoke all on function public.get_notification_delivery_envelope(uuid,integer,text)
  from public,anon,authenticated;
grant execute on function public.get_notification_delivery_envelope(uuid,integer,text) to service_role;

create function private.notification_delivery_activation_state()
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_configured boolean:=false; v_active boolean:=false; v_job_relation regclass;
begin
  v_job_relation:=to_regclass('cron.job');
  if v_job_relation is not null then
    execute format(
      'select exists(select 1 from %s where jobname=$1)',
      v_job_relation
    ) into v_configured using 'notification-delivery';
    execute format(
      'select exists(select 1 from %s where jobname=$1 and active)',
      v_job_relation
    ) into v_active using 'notification-delivery';
  end if;
  return jsonb_build_object(
    'expectedCronName','notification-delivery',
    'cronConfigured',v_configured,
    'cronActive',v_active
  );
end $$;
revoke all on function private.notification_delivery_activation_state()
  from public,anon,authenticated,service_role;

alter function public.get_developer_notification_delivery_status(uuid)
  rename to get_developer_notification_delivery_status_legacy;
revoke all on function public.get_developer_notification_delivery_status_legacy(uuid)
  from public,anon,authenticated,service_role;

create function public.get_developer_notification_delivery_status(p_actor_profile_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_result jsonb; v_activation jsonb;
begin
  v_result:=public.get_developer_notification_delivery_status_legacy(p_actor_profile_id);
  v_activation:=private.notification_delivery_activation_state();
  if not coalesce((v_activation->>'cronConfigured')::boolean,false)
    or not coalesce((v_activation->>'cronActive')::boolean,false) then
    v_result:=jsonb_set(v_result,'{status}','"degraded"'::jsonb);
  end if;
  return v_result||jsonb_build_object('activation',v_activation);
end $$;
revoke all on function public.get_developer_notification_delivery_status(uuid)
  from public,anon,authenticated;
grant execute on function public.get_developer_notification_delivery_status(uuid) to service_role;

comment on function public.register_web_push_subscription(
  uuid,uuid,uuid,uuid,integer,text,text,text,timestamptz,text,text,text,text,text,text,text
) is '#112 server-selected VAPID key version is bound exactly once to every new immutable subscription revision.';
comment on function public.get_notification_delivery_envelope(uuid,integer,text) is
'#112 returns a bound VAPID key version only for the exact fenced revision. Legacy unbound revisions are terminal and never guessed.';
