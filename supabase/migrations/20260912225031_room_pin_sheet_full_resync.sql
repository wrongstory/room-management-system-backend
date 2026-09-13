-- Issue #137 Phase C source: authenticated operator visibility and a fenced,
-- DB-authoritative 121-room full-board repair. Hosted mappings, secrets, ACL,
-- Edge deployment and Cron remain release/production gates.

create table private.room_pin_sheet_full_resync_runs (
  id uuid primary key default gen_random_uuid(),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  actor_role_snapshot public.app_role not null check (actor_role_snapshot in ('developer','admin')),
  expected_fence bigint not null check (expected_fence >= 0),
  reconciles_blocked_fence bigint check (reconciles_blocked_fence is null or reconciles_blocked_fence >= 0),
  aad_environment text not null check (aad_environment ~ '^[A-Za-z0-9._:-]{1,80}$'),
  aad_project_ref text not null check (aad_project_ref ~ '^[A-Za-z0-9._:-]{1,80}$'),
  target_identity_digest text not null check (target_identity_digest ~ '^[0-9a-f]{64}$'),
  snapshot_room_count integer not null check (snapshot_room_count = 121),
  status text not null default 'pending' check (status in (
    'pending','processing','succeeded','failed','operator_blocked','superseded'
  )),
  claim_id uuid,
  claimed_at timestamptz,
  claim_expires_at timestamptz,
  lease_fence bigint check (lease_fence is null or lease_fence > 0),
  provider_write_started_at timestamptz,
  retry_count integer not null default 0 check (retry_count between 0 and 8),
  next_attempt_at timestamptz not null default clock_timestamp(),
  last_error_code text check (last_error_code is null or last_error_code in (
    'RATE_LIMITED','PROVIDER_UNAVAILABLE','AUTHENTICATION_FAILED','AUTHORIZATION_FAILED',
    'PROVIDER_CONFIGURATION_ERROR','PROVIDER_RESPONSE_INVALID','WRITE_OUTCOME_UNCERTAIN',
    'DB_SETTLE_UNCERTAIN','RETRY_EXHAUSTED','SNAPSHOT_STALE'
  )),
  idempotency_key text not null check (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  requested_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  unique (actor_profile_id,idempotency_key),
  check ((claim_id is null)=(claimed_at is null)),
  check (claim_expires_at is null or claimed_at is not null and claim_expires_at>claimed_at),
  check (status<>'processing' or claim_id is not null and claim_expires_at is not null and lease_fence is not null),
  check (status in ('pending','processing','failed') or completed_at is not null)
);

alter table private.room_pin_revisions
  add constraint room_pin_revisions_full_resync_identity_unique
  unique (id,room_id,pin_version);

create table private.room_pin_sheet_full_resync_items (
  run_id uuid not null references private.room_pin_sheet_full_resync_runs(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  room_number_snapshot text not null check (room_number_snapshot ~ '^[A-Za-z0-9]{1,32}$'),
  sheet_row integer not null check (sheet_row between 2 and 122),
  pin_revision_id uuid,
  pin_version bigint not null check (pin_version >= 0),
  sync_status text not null check (sync_status in ('verified','mismatch','unconfigured')),
  effective_at timestamptz not null,
  reason_code text not null check (reason_code='FULL_RESYNC_REPAIR'),
  primary key (run_id,room_id),
  unique (run_id,room_number_snapshot),
  unique (run_id,sheet_row),
  foreign key (pin_revision_id,room_id,pin_version)
    references private.room_pin_revisions(id,room_id,pin_version) on delete restrict,
  check ((pin_revision_id is null)=(pin_version=0)),
  check (sync_status<>'verified' or pin_revision_id is not null)
);

create index room_pin_sheet_full_resync_claim_idx
on private.room_pin_sheet_full_resync_runs(status,next_attempt_at,requested_at,id);
create index room_pin_sheet_full_resync_actor_idx
on private.room_pin_sheet_full_resync_runs(actor_profile_id,requested_at desc);
create index room_pin_sheet_full_resync_item_room_idx
on private.room_pin_sheet_full_resync_items(room_id);
create index room_pin_sheet_full_resync_item_revision_idx
on private.room_pin_sheet_full_resync_items(pin_revision_id) where pin_revision_id is not null;

alter table private.room_pin_sheet_full_resync_runs enable row level security;
alter table private.room_pin_sheet_full_resync_runs force row level security;
alter table private.room_pin_sheet_full_resync_items enable row level security;
alter table private.room_pin_sheet_full_resync_items force row level security;
revoke all on table private.room_pin_sheet_full_resync_runs from public,anon,authenticated,service_role;
revoke all on table private.room_pin_sheet_full_resync_items from public,anon,authenticated,service_role;

create function private.guard_room_pin_sheet_full_resync_run() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or new.id<>old.id or new.actor_profile_id<>old.actor_profile_id
    or new.actor_role_snapshot<>old.actor_role_snapshot or new.expected_fence<>old.expected_fence
    or new.reconciles_blocked_fence is distinct from old.reconciles_blocked_fence
    or new.aad_environment<>old.aad_environment or new.aad_project_ref<>old.aad_project_ref
    or new.target_identity_digest<>old.target_identity_digest
    or new.snapshot_room_count<>old.snapshot_room_count or new.idempotency_key<>old.idempotency_key
    or new.request_hash<>old.request_hash or new.requested_at<>old.requested_at
    or (old.status in ('succeeded','superseded') and new is distinct from old) then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_FULL_RESYNC_IMMUTABLE';
  end if;
  return new;
end $$;
revoke all on function private.guard_room_pin_sheet_full_resync_run()
from public,anon,authenticated,service_role;
create trigger room_pin_sheet_full_resync_run_guard before update or delete
on private.room_pin_sheet_full_resync_runs for each row
execute function private.guard_room_pin_sheet_full_resync_run();

create trigger room_pin_sheet_full_resync_items_append_only before update or delete
on private.room_pin_sheet_full_resync_items for each row
execute function private.prevent_append_only_mutation();

create function private.assert_room_pin_sheet_operator(p_actor uuid,p_session uuid)
returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if actor.id is null or actor.status<>'active' or actor.role not in ('developer','admin') then
    raise exception using errcode='42501',message='ROOM_PIN_SHEET_OPERATOR_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  if p_session is null or not public.is_active_auth_session(actor.auth_user_id,p_session) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  perform 1 from auth.sessions where id=p_session and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  return actor;
end $$;
revoke all on function private.assert_room_pin_sheet_operator(uuid,uuid)
from public,anon,authenticated,service_role;

create function public.request_room_pin_sheet_full_resync(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_fence bigint,
  p_expected_environment text,p_expected_project_ref text,
  p_expected_target_identity_digest text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles;
  state private.room_pin_sheet_sync_worker_state;
  v_run_id uuid:=gen_random_uuid();
  at_time timestamptz:=clock_timestamp();
  response jsonb;
  room_count integer;
  pending_count integer;
begin
  if p_expected_fence is null or p_expected_fence<0
    or p_expected_environment is null or p_expected_environment !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_project_ref is null or p_expected_project_ref !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_target_identity_digest is null
    or p_expected_target_identity_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  actor:=private.assert_room_pin_sheet_operator(p_actor_profile_id,p_session_id);
  response:=private.replay_command(actor.id,'room_pin_sheet.full_resync',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;

  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.lease_fence<>p_expected_fence then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_FULL_RESYNC_STALE';
  end if;
  if state.status='leased' and state.lease_expires_at>at_time then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_WORKER_BUSY';
  end if;
  if state.status='leased' and state.lease_expires_at<=at_time and (
    exists(select 1 from private.room_pin_sheet_sync_outbox o
      where o.status='processing' and o.claim_id=state.claim_id and o.lease_fence=state.lease_fence
        and o.provider_write_started_at is not null)
    or exists(select 1 from private.room_pin_sheet_full_resync_runs f
      where f.status='processing' and f.claim_id=state.claim_id and f.lease_fence=state.lease_fence
        and f.provider_write_started_at is not null)
  ) then
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code='WRITE_OUTCOME_UNCERTAIN',updated_at=at_time
    where singleton=true returning * into state;
  elsif state.status='leased' and state.lease_expires_at<=at_time then
    update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,
      lease_expires_at=null,blocked_reason_code=null,updated_at=at_time
    where singleton=true returning * into state;
  end if;
  if state.status='operator_blocked' then
    update private.room_pin_sheet_full_resync_runs set status='superseded',completed_at=at_time
    where status in ('pending','failed') and provider_write_started_at is null;
  else
    select count(*)::integer into pending_count
    from private.room_pin_sheet_full_resync_runs
    where status in ('pending','processing','failed')
      and coalesce(last_error_code,'')<>'RETRY_EXHAUSTED';
    if pending_count>0 then
      raise exception using errcode='55000',message='ROOM_PIN_SHEET_FULL_RESYNC_PENDING';
    end if;
  end if;
  select count(*)::integer into room_count from public.rooms;
  if room_count<>121 then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_ROOM_MASTER_INVALID';
  end if;

  insert into private.room_pin_sheet_full_resync_runs(
    id,actor_profile_id,actor_role_snapshot,expected_fence,reconciles_blocked_fence,
    aad_environment,aad_project_ref,target_identity_digest,snapshot_room_count,idempotency_key,request_hash,requested_at
  ) values(
    v_run_id,actor.id,actor.role,p_expected_fence,
    case when state.status='operator_blocked' then state.lease_fence else null end,
    p_expected_environment,p_expected_project_ref,p_expected_target_identity_digest,room_count,p_idempotency_key,p_request_hash,at_time
  );

  insert into private.room_pin_sheet_full_resync_items(
    run_id,room_id,room_number_snapshot,sheet_row,pin_revision_id,pin_version,
    sync_status,effective_at,reason_code
  )
  select v_run_id,ranked.id,ranked.room_number,ranked.sheet_row,current_pin.pin_revision_id,
    coalesce(current_pin.pin_version,0),private.current_pin_sync_status(ranked.id),at_time,'FULL_RESYNC_REPAIR'
  from (
    select r.id,r.room_number,(row_number() over(order by r.room_number,r.id)+1)::integer sheet_row
    from public.rooms r
  ) ranked
  left join private.room_current_pin current_pin on current_pin.room_id=ranked.id;

  if (select count(*) from private.room_pin_sheet_full_resync_items item where item.run_id=v_run_id)<>121 then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_ROOM_MASTER_INVALID';
  end if;
  response:=jsonb_build_object('status','pending','roomCount',room_count,'version',state.lease_fence);
  insert into public.audit_events(
    actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,after_state,request_hash,idempotency_key
  ) values(
    actor.id,actor.display_name,'room_pin_sheet.full_resync_requested','room_pin_sheet_full_resync',v_run_id,
    at_time,'FULL_RESYNC_REQUESTED',jsonb_build_object(
      'status','pending','roomCount',room_count,'expectedFence',state.lease_fence,
      'reconciliation',state.status='operator_blocked'
    ),p_request_hash,private.audit_command_key(actor.id,'room_pin_sheet.full_resync',p_idempotency_key)
  );
  perform private.complete_command(actor.id,'room_pin_sheet.full_resync',p_idempotency_key,
    p_request_hash,v_run_id,response);
  return response;
end $$;

create function private.room_pin_sheet_full_resync_context(p_run_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object(
    'runId',run.id,'leaseFence',run.lease_fence,'items',coalesce(jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'roomId',item.room_id,'roomNumber',item.room_number_snapshot,'sheetRow',item.sheet_row,
        'pinVersion',item.pin_version,'syncStatus',item.sync_status,'effectiveAt',item.effective_at,
        'reasonCode',item.reason_code,
        'envelope',case when revision.id is null then null else jsonb_build_object(
          'envelopeFormat',revision.envelope_format,'keyVersion',revision.key_version,
          'ciphertextBase64',replace(encode(revision.ciphertext,'base64'),E'\n',''),
          'nonceBase64',replace(encode(revision.nonce,'base64'),E'\n',''),
          'authTagBase64',replace(encode(revision.auth_tag,'base64'),E'\n',''),
          'aadEnvironment',revision.aad_environment,'aadProjectRef',revision.aad_project_ref
        ) end
      )) order by item.sheet_row
    ),'[]'::jsonb)
  )
  from private.room_pin_sheet_full_resync_runs run
  join private.room_pin_sheet_full_resync_items item on item.run_id=run.id
  left join private.room_pin_revisions revision on revision.id=item.pin_revision_id
  where run.id=p_run_id
  group by run.id,run.lease_fence
$$;
revoke all on function private.room_pin_sheet_full_resync_context(uuid)
from public,anon,authenticated,service_role;

create function public.claim_room_pin_sheet_full_resync(
  p_claim_id uuid,p_expected_environment text,p_expected_project_ref text,
  p_expected_target_identity_digest text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  at_time timestamptz:=clock_timestamp();
  state private.room_pin_sheet_sync_worker_state;
  run private.room_pin_sheet_full_resync_runs;
begin
  if p_claim_id is null or p_expected_environment is null or p_expected_project_ref is null
    or p_expected_environment !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_project_ref !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_target_identity_digest is null
    or p_expected_target_identity_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_CLAIM_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.status='leased' and state.lease_expires_at>at_time and state.claim_id<>p_claim_id then
    return jsonb_build_object('status','busy','leaseFence',state.lease_fence);
  end if;
  if state.status='leased' and state.lease_expires_at<=at_time and (
    exists(select 1 from private.room_pin_sheet_sync_outbox o
      where o.status='processing' and o.claim_id=state.claim_id and o.lease_fence=state.lease_fence
        and o.provider_write_started_at is not null)
    or exists(select 1 from private.room_pin_sheet_full_resync_runs f
      where f.status='processing' and f.claim_id=state.claim_id and f.lease_fence=state.lease_fence
        and f.provider_write_started_at is not null)
  ) then
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code='WRITE_OUTCOME_UNCERTAIN',updated_at=at_time
    where singleton=true;
    return jsonb_build_object('status','operator_blocked','leaseFence',state.lease_fence);
  end if;
  update private.room_pin_sheet_full_resync_runs set status='pending',claim_id=null,claimed_at=null,
    claim_expires_at=null,lease_fence=null
  where status='processing' and claim_expires_at<=at_time and provider_write_started_at is null;

  select * into run from private.room_pin_sheet_full_resync_runs
  where status in ('pending','failed') and next_attempt_at<=at_time
    and coalesce(last_error_code,'')<>'RETRY_EXHAUSTED'
  order by requested_at,id limit 1 for update skip locked;
  if run.id is null then
    return jsonb_build_object(
      'status',case when state.status='operator_blocked' then 'operator_blocked' else 'empty' end,
      'leaseFence',state.lease_fence
    );
  end if;
  if state.status='operator_blocked' and run.reconciles_blocked_fence is distinct from state.lease_fence then
    return jsonb_build_object('status','operator_blocked','leaseFence',state.lease_fence);
  end if;
  if run.aad_environment<>p_expected_environment or run.aad_project_ref<>p_expected_project_ref
    or run.target_identity_digest<>p_expected_target_identity_digest then
    update private.room_pin_sheet_full_resync_runs set status='operator_blocked',
      last_error_code='PROVIDER_CONFIGURATION_ERROR',completed_at=at_time where id=run.id;
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code='PROVIDER_CONFIGURATION_ERROR',updated_at=at_time
    where singleton=true;
    return jsonb_build_object('status','operator_blocked','leaseFence',state.lease_fence);
  end if;
  update private.room_pin_sheet_sync_worker_state set status='leased',claim_id=p_claim_id,
    lease_fence=lease_fence+1,lease_expires_at=at_time+interval '2 minutes',
    blocked_reason_code=null,updated_at=at_time where singleton=true returning * into state;
  update private.room_pin_sheet_full_resync_runs set status='processing',claim_id=p_claim_id,
    claimed_at=at_time,claim_expires_at=state.lease_expires_at,lease_fence=state.lease_fence,
    provider_write_started_at=null,last_error_code=null where id=run.id;
  return jsonb_build_object('status','claimed','leaseFence',state.lease_fence,
    'operation',private.room_pin_sheet_full_resync_context(run.id));
end $$;

create function public.renew_room_pin_sheet_full_resync(
  p_run_id uuid,p_claim_id uuid,p_lease_fence bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
begin
  if p_run_id is null or p_claim_id is null or p_lease_fence is null then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_RENEW_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence
    or state.lease_expires_at<=at_time or not exists(
      select 1 from private.room_pin_sheet_full_resync_runs run where run.id=p_run_id
        and run.status='processing' and run.claim_id=p_claim_id and run.lease_fence=p_lease_fence
    ) then raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST'; end if;
  update private.room_pin_sheet_sync_worker_state set lease_expires_at=at_time+interval '2 minutes',updated_at=at_time
    where singleton=true returning * into state;
  update private.room_pin_sheet_full_resync_runs set claim_expires_at=state.lease_expires_at where id=p_run_id;
  return jsonb_build_object('status','leased','leaseFence',state.lease_fence,'expiresAt',state.lease_expires_at);
end $$;

create function public.authorize_room_pin_sheet_full_resync_write(
  p_run_id uuid,p_claim_id uuid,p_lease_fence bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  at_time timestamptz:=clock_timestamp();
  state private.room_pin_sheet_sync_worker_state;
  run private.room_pin_sheet_full_resync_runs;
  changed boolean;
begin
  if p_run_id is null or p_claim_id is null or p_lease_fence is null or p_lease_fence<1 then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_AUTHORIZE_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  select * into run from private.room_pin_sheet_full_resync_runs where id=p_run_id for update;
  if run.id is null then raise exception using errcode='P0002',message='ROOM_PIN_SHEET_FULL_RESYNC_NOT_FOUND'; end if;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence
    or state.lease_expires_at<=at_time or run.status<>'processing' or run.claim_id<>p_claim_id
    or run.lease_fence<>p_lease_fence or run.claim_expires_at<=at_time then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  select exists(
    select 1 from private.room_pin_sheet_full_resync_items item
    left join public.rooms room on room.id=item.room_id
    left join private.room_current_pin current_pin on current_pin.room_id=item.room_id
    where item.run_id=p_run_id and (
      room.id is null or room.room_number<>item.room_number_snapshot
      or private.current_pin_sync_status(item.room_id)<>item.sync_status
      or coalesce(current_pin.pin_version,0)<>item.pin_version
      or current_pin.pin_revision_id is distinct from item.pin_revision_id
    )
  ) or (select count(*) from public.rooms)<>121
    or (select count(*) from private.room_pin_sheet_full_resync_items where run_id=p_run_id)<>121
  into changed;
  if changed then
    update private.room_pin_sheet_full_resync_runs set status='superseded',claim_id=null,
      claimed_at=null,claim_expires_at=null,lease_fence=null,last_error_code='SNAPSHOT_STALE',completed_at=at_time
      where id=p_run_id;
    return jsonb_build_object('status','superseded');
  end if;
  update private.room_pin_sheet_full_resync_runs set provider_write_started_at=at_time where id=p_run_id;
  return jsonb_build_object('status','authorized','leaseFence',p_lease_fence);
end $$;

create function public.settle_room_pin_sheet_full_resync(
  p_run_id uuid,p_claim_id uuid,p_lease_fence bigint,p_outcome text,p_reason_code text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  at_time timestamptz:=clock_timestamp();
  state private.room_pin_sheet_sync_worker_state;
  run private.room_pin_sheet_full_resync_runs;
  delay_seconds integer;
begin
  if p_run_id is null or p_claim_id is null or p_lease_fence is null or p_lease_fence<1
    or p_outcome not in ('succeeded','retryable','operator_blocked')
    or (p_outcome='succeeded' and p_reason_code is not null)
    or (p_outcome='retryable' and coalesce(p_reason_code,'') not in ('RATE_LIMITED','PROVIDER_UNAVAILABLE'))
    or (p_outcome='operator_blocked' and coalesce(p_reason_code,'') not in (
      'AUTHENTICATION_FAILED','AUTHORIZATION_FAILED','PROVIDER_CONFIGURATION_ERROR',
      'PROVIDER_RESPONSE_INVALID','WRITE_OUTCOME_UNCERTAIN','DB_SETTLE_UNCERTAIN'
    )) then raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_SETTLE_INVALID'; end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  select * into run from private.room_pin_sheet_full_resync_runs where id=p_run_id for update;
  if run.id is null then raise exception using errcode='P0002',message='ROOM_PIN_SHEET_FULL_RESYNC_NOT_FOUND'; end if;
  if run.status='succeeded' and p_outcome='succeeded' then
    return jsonb_build_object('status','succeeded','roomCount',run.snapshot_room_count);
  end if;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence
    or state.lease_expires_at<=at_time or run.status<>'processing' or run.claim_id<>p_claim_id
    or run.lease_fence<>p_lease_fence then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  if p_outcome='succeeded' and run.provider_write_started_at is null then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_FULL_RESYNC_NOT_AUTHORIZED';
  end if;
  if p_outcome='succeeded' then
    update private.room_pin_sheet_full_resync_runs set status='succeeded',completed_at=at_time,
      last_error_code=null where id=p_run_id;
    -- The full-board write repairs exactly the snapshot authorized immediately
    -- before the provider call. A v50 uncertain settle clears lease_fence, so
    -- fence equality alone cannot identify every repaired outbox row. Match the
    -- immutable room snapshot and the provider linearization bound for every
    -- successful full-board write, including an ordinary maintenance run.
    -- Any PIN change committed after authorization has a later outbox row and
    -- must remain claimable for incremental convergence.
    update private.room_pin_sheet_sync_outbox outbox set
      status='superseded',completed_at=at_time,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null
    where outbox.status in ('pending','processing','failed')
      and outbox.created_at<=run.provider_write_started_at
      and exists(
        select 1 from private.room_pin_sheet_full_resync_items item
        where item.run_id=p_run_id and item.room_id=outbox.room_id
      );
    if run.reconciles_blocked_fence is not null then
      update private.room_pin_sheet_full_resync_runs set status='superseded',completed_at=at_time
      where id<>p_run_id and status in ('processing','failed','operator_blocked')
        and lease_fence=run.reconciles_blocked_fence;
    end if;
    insert into public.audit_events(
      actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
      effective_at,reason_code,after_state,idempotency_key
    ) select profile.id,profile.display_name,'room_pin_sheet.full_resync_succeeded',
      'room_pin_sheet_full_resync',run.id,at_time,'FULL_RESYNC_SUCCEEDED',
      jsonb_build_object('status','succeeded','roomCount',run.snapshot_room_count,'leaseFence',p_lease_fence),
      private.audit_command_key(run.actor_profile_id,'room_pin_sheet.full_resync.succeeded',run.id::text)
    from public.profiles profile where profile.id=run.actor_profile_id;
  elsif p_outcome='retryable' then
    delay_seconds:=least(3600,30*(2^least(run.retry_count,7))::integer)+
      (get_byte(extensions.digest(convert_to(run.id::text||(run.retry_count+1)::text,'UTF8'),'sha256'),0)%16);
    update private.room_pin_sheet_full_resync_runs set
      status=case when retry_count+1>=8 then 'operator_blocked' else 'failed' end,
      retry_count=retry_count+1,next_attempt_at=at_time+make_interval(secs=>delay_seconds),
      last_error_code=case when retry_count+1>=8 then 'RETRY_EXHAUSTED' else p_reason_code end,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,
      provider_write_started_at=null,completed_at=case when retry_count+1>=8 then at_time else null end
    where id=p_run_id;
    if run.retry_count+1>=8 then
      update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
        lease_expires_at=null,blocked_reason_code='RETRY_EXHAUSTED',updated_at=at_time where singleton=true;
    end if;
  else
    update private.room_pin_sheet_full_resync_runs set status='operator_blocked',last_error_code=p_reason_code,
      completed_at=at_time where id=p_run_id;
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code=p_reason_code,updated_at=at_time where singleton=true;
  end if;
  return jsonb_build_object(
    'status',case when (select status from private.room_pin_sheet_sync_worker_state where singleton)='operator_blocked'
      then 'operator_blocked' else (select status from private.room_pin_sheet_full_resync_runs where id=p_run_id) end,
    'roomCount',run.snapshot_room_count
  );
end $$;

-- This is intentionally narrower than the normal settle RPC. It is used only
-- after the provider confirmed a full-board write but the success settle was
-- not durably observed. If even this call fails, the preserved write marker is
-- detected by lease-expiry reconciliation on the next claim.
create function public.block_room_pin_sheet_full_resync_after_settle_failure(
  p_run_id uuid,p_claim_id uuid,p_lease_fence bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
  run private.room_pin_sheet_full_resync_runs;
begin
  if p_run_id is null or p_claim_id is null or p_lease_fence is null or p_lease_fence<1 then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_BLOCK_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  select * into run from private.room_pin_sheet_full_resync_runs where id=p_run_id for update;
  if run.id is null or run.status<>'processing' or run.claim_id<>p_claim_id
    or run.lease_fence<>p_lease_fence or run.provider_write_started_at is null
    or state.lease_fence<>p_lease_fence then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  update private.room_pin_sheet_full_resync_runs set status='operator_blocked',
    last_error_code='DB_SETTLE_UNCERTAIN',completed_at=at_time where id=p_run_id;
  update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
    lease_expires_at=null,blocked_reason_code='DB_SETTLE_UNCERTAIN',updated_at=at_time where singleton=true;
  return jsonb_build_object('status','operator_blocked','roomCount',run.snapshot_room_count);
end $$;

create function public.get_room_pin_sheet_sync_status(p_actor_profile_id uuid,p_session_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor public.profiles;
  state private.room_pin_sheet_sync_worker_state;
  pending_count integer;
  failed_count integer;
  oldest_pending timestamptz;
  last_success timestamptz;
  last_error text;
  at_time timestamptz:=clock_timestamp();
begin
  actor:=private.assert_room_pin_sheet_operator(p_actor_profile_id,p_session_id);
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true;
  select least(coalesce(sum(value),0),1000)::integer,min(pending_at) into pending_count,oldest_pending
  from (
    select 1 value,o.created_at pending_at from private.room_pin_sheet_sync_outbox o
      where o.status in ('pending','processing')
    union all
    select run.snapshot_room_count,run.requested_at from private.room_pin_sheet_full_resync_runs run
      where run.status in ('pending','processing')
  ) pending;
  select least(coalesce(sum(value),0),1000)::integer into failed_count from (
    select 1 value from private.room_pin_sheet_sync_outbox o where o.status='failed'
    union all
    select run.snapshot_room_count from private.room_pin_sheet_full_resync_runs run
      where run.status in ('failed','operator_blocked')
  ) failed;
  select max(completed_at) into last_success from (
    select o.completed_at from private.room_pin_sheet_sync_outbox o where o.status='succeeded'
    union all
    select run.completed_at from private.room_pin_sheet_full_resync_runs run where run.status='succeeded'
  ) successes;
  select candidate.error_code into last_error from (
    select state.blocked_reason_code error_code,state.updated_at occurred_at
      where state.blocked_reason_code is not null
    union all
    select run.last_error_code,coalesce(run.completed_at,run.requested_at)
      from private.room_pin_sheet_full_resync_runs run where run.last_error_code is not null
    union all
    select o.last_error_code,coalesce(o.completed_at,o.claimed_at,o.created_at)
      from private.room_pin_sheet_sync_outbox o where o.last_error_code is not null
    union all
    select heartbeat.error_code,heartbeat.recorded_at
      from private.room_pin_sheet_sync_heartbeat heartbeat where heartbeat.error_code is not null
  ) candidate order by candidate.occurred_at desc nulls last limit 1;
  return jsonb_build_object(
    'pending',pending_count,'failed',failed_count,'operatorBlocked',state.status='operator_blocked',
    'oldestPendingAt',oldest_pending,'lastSuccessAt',last_success,'lastErrorCode',last_error,
    'version',state.lease_fence,'checkedAt',at_time
  );
end $$;

-- Extend the existing developer audit allowlist without exposing request
-- hashes, target identity digests, provider material, or PIN/envelope data.
alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_room_pin_full_resync;
revoke all on function private.list_developer_audit_events_before_room_pin_full_resync(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;

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
  id uuid,event_type text,entity_type text,entity_id uuid,actor_profile_id uuid,
  actor_display_name text,effective_at timestamptz,recorded_at timestamptz,
  reason_code text,summary jsonb
) language plpgsql security definer set search_path='' as $$
declare
  v_full_types constant text[]:=array[
    'room_pin_sheet.full_resync_requested','room_pin_sheet.full_resync_succeeded'
  ];
  v_previous_types text[];
  v_from timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  v_to timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types),0)=0 then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then v_previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into v_previous_types
    from unnest(p_event_types) requested where not requested=any(v_full_types);
    if cardinality(v_previous_types)=0 then v_previous_types:=array['account.created']; end if;
  end if;
  return query select merged.* from (
    select previous.* from private.list_developer_audit_events_before_room_pin_full_resync(
      p_actor_profile_id,v_previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,audit.actor_profile_id,
      audit.actor_display_name_snapshot,audit.effective_at,audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'status',audit.after_state->>'status',
        'roomCount',audit.after_state->'roomCount',
        'reconciliation',case when audit.event_type='room_pin_sheet.full_resync_requested'
          then audit.after_state->'reconciliation' else null end
      ))
    from public.audit_events audit
    where audit.event_type=any(v_full_types)
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=v_from and audit.recorded_at<=v_to
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc limit p_limit
  ) merged order by merged.recorded_at desc,merged.id desc limit p_limit;
end $$;

create or replace function public.record_room_pin_sheet_sync_heartbeat(
  p_claim_id uuid,p_lease_fence bigint,p_status text,p_claimed integer,p_projected integer,
  p_already_current integer,p_superseded integer,p_retrying integer,p_blocked integer,
  p_error_code text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
begin
  if p_claim_id is null or p_lease_fence is null or p_status is null or
    p_claimed is null or p_projected is null or p_already_current is null or
    p_superseded is null or p_retrying is null or p_blocked is null or
    p_status not in ('succeeded','degraded','failed','operator_blocked') or
    least(p_claimed,p_projected,p_already_current,p_superseded,p_retrying,p_blocked)<0 or
    greatest(p_claimed,p_projected,p_already_current,p_superseded,p_retrying,p_blocked)>10 or
    p_projected+p_already_current+p_superseded+p_retrying+p_blocked>p_claimed or
    (p_error_code is not null and p_error_code !~ '^[A-Z0-9_]{2,80}$') then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_HEARTBEAT_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.lease_fence<>p_lease_fence or (state.status='leased' and state.claim_id<>p_claim_id) then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  if state.status='operator_blocked' and (p_status<>'operator_blocked' or p_blocked<1) then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_FALSE_GREEN_HEARTBEAT';
  end if;
  if state.status='leased' and (
    exists(select 1 from private.room_pin_sheet_sync_outbox o
      where o.status='processing' and o.claim_id=p_claim_id and o.lease_fence=p_lease_fence
        and o.provider_write_started_at is not null)
    or exists(select 1 from private.room_pin_sheet_full_resync_runs run
      where run.status='processing' and run.claim_id=p_claim_id and run.lease_fence=p_lease_fence
        and run.provider_write_started_at is not null)
  ) then raise exception using errcode='55000',message='ROOM_PIN_SHEET_UNSETTLED_WRITE'; end if;
  update private.room_pin_sheet_sync_outbox set status='pending',claim_id=null,claimed_at=null,
    claim_expires_at=null,lease_fence=null
  where status='processing' and claim_id=p_claim_id and lease_fence=p_lease_fence
    and provider_write_started_at is null;
  update private.room_pin_sheet_full_resync_runs set status='pending',claim_id=null,claimed_at=null,
    claim_expires_at=null,lease_fence=null
  where status='processing' and claim_id=p_claim_id and lease_fence=p_lease_fence
    and provider_write_started_at is null;
  insert into private.room_pin_sheet_sync_heartbeat(singleton,status,claimed,projected,already_current,
    superseded,retrying,blocked,error_code,recorded_at)
  values(true,p_status,p_claimed,p_projected,p_already_current,p_superseded,p_retrying,p_blocked,p_error_code,at_time)
  on conflict(singleton) do update set status=excluded.status,claimed=excluded.claimed,
    projected=excluded.projected,already_current=excluded.already_current,superseded=excluded.superseded,
    retrying=excluded.retrying,blocked=excluded.blocked,error_code=excluded.error_code,recorded_at=excluded.recorded_at;
  if state.status='leased' then
    update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,lease_expires_at=null,
      blocked_reason_code=null,updated_at=at_time where singleton=true;
  end if;
  return jsonb_build_object('status',p_status,'recordedAt',at_time);
end $$;

revoke all on function public.request_room_pin_sheet_full_resync(uuid,uuid,bigint,text,text,text,text,text)
from public,anon,authenticated;
revoke all on function public.claim_room_pin_sheet_full_resync(uuid,text,text,text)
from public,anon,authenticated;
revoke all on function public.renew_room_pin_sheet_full_resync(uuid,uuid,bigint)
from public,anon,authenticated;
revoke all on function public.authorize_room_pin_sheet_full_resync_write(uuid,uuid,bigint)
from public,anon,authenticated;
revoke all on function public.settle_room_pin_sheet_full_resync(uuid,uuid,bigint,text,text)
from public,anon,authenticated;
revoke all on function public.block_room_pin_sheet_full_resync_after_settle_failure(uuid,uuid,bigint)
from public,anon,authenticated;
revoke all on function public.get_room_pin_sheet_sync_status(uuid,uuid)
from public,anon,authenticated;
revoke all on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated;
grant execute on function public.request_room_pin_sheet_full_resync(uuid,uuid,bigint,text,text,text,text,text) to service_role;
grant execute on function public.claim_room_pin_sheet_full_resync(uuid,text,text,text) to service_role;
grant execute on function public.renew_room_pin_sheet_full_resync(uuid,uuid,bigint) to service_role;
grant execute on function public.authorize_room_pin_sheet_full_resync_write(uuid,uuid,bigint) to service_role;
grant execute on function public.settle_room_pin_sheet_full_resync(uuid,uuid,bigint,text,text) to service_role;
grant execute on function public.block_room_pin_sheet_full_resync_after_settle_failure(uuid,uuid,bigint) to service_role;
grant execute on function public.get_room_pin_sheet_sync_status(uuid,uuid) to service_role;
grant execute on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) to service_role;

comment on table private.room_pin_sheet_full_resync_runs is
  'Fenced server-owned full-board repair command. Contains safe status and runtime identity only; no PIN, envelope, Google token, credential, raw response, or Sheet payload.';
comment on table private.room_pin_sheet_full_resync_items is
  'Immutable 121-room identity/version snapshot. Envelopes remain referenced in the existing private revision ledger and are never copied here.';
