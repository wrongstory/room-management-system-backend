-- Issue #136 Phase B: fenced, one-way Google Sheets projection. Credentials
-- and plaintext PINs stay in the Edge runtime and never enter PostgreSQL.

alter table private.room_pin_sheet_sync_outbox
  add column lease_fence bigint,
  add column provider_write_started_at timestamptz;

create table private.room_pin_sheet_sync_worker_state (
  singleton boolean primary key default true check (singleton),
  status text not null default 'idle' check (status in ('idle','leased','operator_blocked')),
  claim_id uuid,
  lease_fence bigint not null default 0 check (lease_fence >= 0),
  lease_expires_at timestamptz,
  blocked_reason_code text check (blocked_reason_code is null or blocked_reason_code in (
    'AUTHENTICATION_FAILED','AUTHORIZATION_FAILED','PROVIDER_CONFIGURATION_ERROR',
    'WRITE_OUTCOME_UNCERTAIN','PROVIDER_RESPONSE_INVALID','DB_SETTLE_UNCERTAIN',
    'RETRY_EXHAUSTED'
  )),
  updated_at timestamptz not null default clock_timestamp(),
  check ((status='leased')=(claim_id is not null and lease_expires_at is not null)),
  check ((status='operator_blocked')=(blocked_reason_code is not null))
);
insert into private.room_pin_sheet_sync_worker_state(singleton) values(true);

create table private.room_pin_sheet_sync_heartbeat (
  singleton boolean primary key default true check (singleton),
  status text not null check (status in ('succeeded','degraded','failed','operator_blocked')),
  claimed integer not null check (claimed between 0 and 10),
  projected integer not null check (projected between 0 and 10),
  already_current integer not null check (already_current between 0 and 10),
  superseded integer not null check (superseded between 0 and 10),
  retrying integer not null check (retrying between 0 and 10),
  blocked integer not null check (blocked between 0 and 10),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{2,80}$'),
  recorded_at timestamptz not null default clock_timestamp()
);

alter table private.room_pin_sheet_sync_worker_state enable row level security;
alter table private.room_pin_sheet_sync_worker_state force row level security;
alter table private.room_pin_sheet_sync_heartbeat enable row level security;
alter table private.room_pin_sheet_sync_heartbeat force row level security;
revoke all on table private.room_pin_sheet_sync_worker_state from public,anon,authenticated,service_role;
revoke all on table private.room_pin_sheet_sync_heartbeat from public,anon,authenticated,service_role;

create function private.guard_room_pin_sheet_sync_worker_state() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or new.singleton is distinct from old.singleton or
    new.lease_fence<old.lease_fence or new.lease_fence>old.lease_fence+1 then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_WORKER_STATE_INVALID';
  end if;
  return new;
end $$;
revoke all on function private.guard_room_pin_sheet_sync_worker_state() from public,anon,authenticated,service_role;
create trigger room_pin_sheet_sync_worker_state_guard before update or delete
on private.room_pin_sheet_sync_worker_state for each row
execute function private.guard_room_pin_sheet_sync_worker_state();

create function private.guard_room_pin_sheet_sync_heartbeat() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' or (tg_op='UPDATE' and new.singleton is distinct from old.singleton) then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_HEARTBEAT_INVALID';
  end if;
  return new;
end $$;
revoke all on function private.guard_room_pin_sheet_sync_heartbeat() from public,anon,authenticated,service_role;
create trigger room_pin_sheet_sync_heartbeat_guard before update or delete
on private.room_pin_sheet_sync_heartbeat for each row
execute function private.guard_room_pin_sheet_sync_heartbeat();

create function private.room_pin_sheet_sync_context(p_outbox_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  with ranked_rooms as (
    select id,room_number,(row_number() over(order by room_number,id)+1)::integer sheet_row
    from public.rooms
  ), context as (
    select o.id outbox_id,o.room_id,c.pin_version,r.room_number,r.sheet_row,
      p.envelope_format,p.key_version,p.ciphertext,p.nonce,p.auth_tag,
      p.aad_environment,p.aad_project_ref,o.created_at effective_at,
      o.sync_status,o.reason_code,o.lease_fence
    from private.room_pin_sheet_sync_outbox o
    join private.room_current_pin c on c.room_id=o.room_id
    join private.room_pin_revisions p on p.id=c.pin_revision_id and p.room_id=c.room_id
      and p.pin_version=c.pin_version
    join ranked_rooms r on r.id=o.room_id where o.id=p_outbox_id
  )
  select jsonb_build_object(
    'outboxId',outbox_id,'roomId',room_id,'roomNumber',room_number,
    'sheetRow',sheet_row,'pinVersion',pin_version,'envelopeFormat',envelope_format,
    'keyVersion',key_version,'ciphertextBase64',replace(encode(ciphertext,'base64'),E'\n',''),
    'nonceBase64',replace(encode(nonce,'base64'),E'\n',''),
    'authTagBase64',replace(encode(auth_tag,'base64'),E'\n',''),
    'aadEnvironment',aad_environment,'aadProjectRef',aad_project_ref,
    'effectiveAt',effective_at,'syncStatus',sync_status,'reasonCode',reason_code,
    'leaseFence',lease_fence
  ) from context
$$;
revoke all on function private.room_pin_sheet_sync_context(uuid) from public,anon,authenticated,service_role;

create function public.claim_room_pin_sheet_sync(
  p_claim_id uuid,p_limit integer,p_expected_environment text,p_expected_project_ref text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
  candidate record; chosen private.room_pin_sheet_sync_outbox;
  current_row private.room_current_pin; revision private.room_pin_revisions;
  items jsonb:='[]'::jsonb; blocked integer:=0;
begin
  if p_claim_id is null or p_limit is null or p_limit not between 1 and 10 or
    p_expected_environment is null or p_expected_project_ref is null or
    p_expected_environment !~ '^[A-Za-z0-9._:-]{1,80}$' or
    p_expected_project_ref !~ '^[A-Za-z0-9._:-]{1,80}$' then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_CLAIM_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.status='operator_blocked' then
    return jsonb_build_object('status','operator_blocked','items',items,'blocked',1,'leaseFence',state.lease_fence);
  end if;
  if state.status='leased' and state.lease_expires_at>at_time and state.claim_id<>p_claim_id then
    return jsonb_build_object('status','busy','items',items,'blocked',0,'leaseFence',state.lease_fence);
  end if;
  if state.status='leased' and state.lease_expires_at<=at_time and exists(
    select 1 from private.room_pin_sheet_sync_outbox o
    where o.claim_id=state.claim_id and o.lease_fence=state.lease_fence
      and o.status='processing' and o.provider_write_started_at is not null
  ) then
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code='WRITE_OUTCOME_UNCERTAIN',updated_at=at_time
    where singleton=true;
    return jsonb_build_object('status','operator_blocked','items',items,'blocked',1,'leaseFence',state.lease_fence);
  end if;
  update private.room_pin_sheet_sync_outbox set status='pending',claim_id=null,claimed_at=null,
    claim_expires_at=null,lease_fence=null
  where status='processing' and claim_expires_at<=at_time and provider_write_started_at is null;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_expires_at<=at_time then
    update private.room_pin_sheet_sync_worker_state set status='leased',claim_id=p_claim_id,
      lease_fence=lease_fence+1,lease_expires_at=at_time+interval '2 minutes',
      blocked_reason_code=null,updated_at=at_time where singleton=true returning * into state;
  end if;
  for candidate in
    select o.room_id,min(o.created_at) first_created
    from private.room_pin_sheet_sync_outbox o
    where o.status in ('pending','failed') and o.next_attempt_at<=at_time
      and coalesce(o.last_error_code,'')<>'RETRY_EXHAUSTED'
    group by o.room_id order by min(o.created_at),o.room_id limit p_limit
  loop
    select * into current_row from private.room_current_pin where room_id=candidate.room_id;
    if current_row.room_id is null then
      update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=at_time,
        claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,last_error_code=null
      where room_id=candidate.room_id and status in ('pending','failed');
      continue;
    end if;
    select * into revision from private.room_pin_revisions where id=current_row.pin_revision_id;
    if revision.id is null or revision.aad_environment<>p_expected_environment or
      revision.aad_project_ref<>p_expected_project_ref then
      update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
        lease_expires_at=null,blocked_reason_code='PROVIDER_CONFIGURATION_ERROR',updated_at=at_time
      where singleton=true;
      blocked:=1; exit;
    end if;
    update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=at_time,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,last_error_code=null
    where room_id=candidate.room_id and pin_version<current_row.pin_version
      and status in ('pending','failed');
    select * into chosen from private.room_pin_sheet_sync_outbox
    where room_id=candidate.room_id and pin_version=current_row.pin_version
      and status in ('pending','failed') and next_attempt_at<=at_time
      and coalesce(last_error_code,'')<>'RETRY_EXHAUSTED'
    order by created_at desc,id desc limit 1 for update skip locked;
    if chosen.id is null then continue; end if;
    update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=at_time,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,last_error_code=null
    where room_id=chosen.room_id and pin_version=chosen.pin_version and id<>chosen.id
      and status in ('pending','failed');
    update private.room_pin_sheet_sync_outbox set status='processing',claim_id=p_claim_id,
      claimed_at=at_time,claim_expires_at=state.lease_expires_at,lease_fence=state.lease_fence,
      provider_write_started_at=null,last_error_code=null where id=chosen.id;
    items:=items||jsonb_build_array(private.room_pin_sheet_sync_context(chosen.id));
  end loop;
  return jsonb_build_object('status',case when blocked>0 then 'operator_blocked' else 'claimed' end,
    'items',items,'blocked',blocked,'leaseFence',state.lease_fence);
end $$;

create function public.renew_room_pin_sheet_sync_run(p_claim_id uuid,p_lease_fence bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
begin
  if p_claim_id is null or p_lease_fence is null then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_RENEW_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence or
    state.lease_expires_at<=at_time then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  update private.room_pin_sheet_sync_worker_state set lease_expires_at=at_time+interval '2 minutes',updated_at=at_time
    where singleton=true returning * into state;
  update private.room_pin_sheet_sync_outbox set claim_expires_at=state.lease_expires_at
    where status='processing' and claim_id=p_claim_id and lease_fence=p_lease_fence;
  return jsonb_build_object('status','leased','leaseFence',state.lease_fence,'expiresAt',state.lease_expires_at);
end $$;

create function public.authorize_room_pin_sheet_write(
  p_outbox_id uuid,p_claim_id uuid,p_lease_fence bigint,p_expected_pin_version bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
  job private.room_pin_sheet_sync_outbox; current_row private.room_current_pin;
begin
  if p_outbox_id is null or p_claim_id is null or p_lease_fence is null or
    p_expected_pin_version is null or p_lease_fence<1 or p_expected_pin_version<1 then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_AUTHORIZE_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  select * into job from private.room_pin_sheet_sync_outbox where id=p_outbox_id for update;
  if job.id is null then
    raise exception using errcode='P0002',message='ROOM_PIN_SHEET_OUTBOX_NOT_FOUND';
  end if;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence or
    state.lease_expires_at<=at_time or job.status<>'processing' or job.claim_id<>p_claim_id or
    job.lease_fence<>p_lease_fence or job.claim_expires_at<=at_time then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  select * into current_row from private.room_current_pin where room_id=job.room_id;
  if current_row.pin_version is distinct from p_expected_pin_version or job.pin_version<>p_expected_pin_version then
    update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=at_time,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,last_error_code=null
    where id=job.id;
    return jsonb_build_object('status','superseded');
  end if;
  update private.room_pin_sheet_sync_outbox set provider_write_started_at=at_time where id=job.id;
  return jsonb_build_object('status','authorized','leaseFence',p_lease_fence);
end $$;

create function public.settle_room_pin_sheet_sync(
  p_outbox_id uuid,p_claim_id uuid,p_lease_fence bigint,p_expected_pin_version bigint,
  p_outcome text,p_reason_code text default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
  job private.room_pin_sheet_sync_outbox; current_row private.room_current_pin; delay_seconds integer;
begin
  if p_outbox_id is null or p_claim_id is null or p_lease_fence is null or
    p_expected_pin_version is null or p_lease_fence<1 or p_expected_pin_version<1 or
    p_outcome is null or p_outcome not in ('succeeded','already_current','superseded','retryable','operator_blocked') or
    (p_outcome in ('succeeded','already_current','superseded') and p_reason_code is not null) or
    (p_outcome='retryable' and coalesce(p_reason_code,'') not in ('RATE_LIMITED','PROVIDER_UNAVAILABLE')) or
    (p_outcome='operator_blocked' and coalesce(p_reason_code,'') not in (
      'AUTHENTICATION_FAILED','AUTHORIZATION_FAILED','PROVIDER_CONFIGURATION_ERROR',
      'WRITE_OUTCOME_UNCERTAIN','PROVIDER_RESPONSE_INVALID','DB_SETTLE_UNCERTAIN')) then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_SETTLE_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  select * into job from private.room_pin_sheet_sync_outbox where id=p_outbox_id for update;
  if job.id is null then
    raise exception using errcode='P0002',message='ROOM_PIN_SHEET_OUTBOX_NOT_FOUND';
  end if;
  if job.status in ('succeeded','superseded') and p_outcome in ('succeeded','already_current','superseded') then
    return jsonb_build_object('status',job.status,'pinVersion',job.pin_version);
  end if;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence or
    state.lease_expires_at<=at_time or job.status<>'processing' or job.claim_id<>p_claim_id or
    job.lease_fence<>p_lease_fence then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  select * into current_row from private.room_current_pin where room_id=job.room_id;
  if current_row.pin_version is distinct from p_expected_pin_version then p_outcome:='superseded'; end if;
  if p_outcome in ('succeeded','already_current','superseded') then
    update private.room_pin_sheet_sync_outbox set
      status=case when p_outcome='superseded' then 'superseded' else 'succeeded' end,
      completed_at=at_time,claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,
      provider_write_started_at=null,last_error_code=null where id=job.id;
  elsif p_outcome='retryable' then
    delay_seconds:=least(3600,30*(2^least(job.retry_count,7))::integer)+
      (get_byte(extensions.digest(convert_to(job.id::text||(job.retry_count+1)::text,'UTF8'),'sha256'),0)%16);
    update private.room_pin_sheet_sync_outbox set status='failed',retry_count=retry_count+1,
      next_attempt_at=at_time+make_interval(secs=>delay_seconds),
      last_error_code=case when retry_count+1>=8 then 'RETRY_EXHAUSTED' else p_reason_code end,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,
      provider_write_started_at=null where id=job.id;
    if job.retry_count+1>=8 then
      update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
        lease_expires_at=null,blocked_reason_code='RETRY_EXHAUSTED',updated_at=at_time
      where singleton=true;
    end if;
  else
    if coalesce(p_reason_code,'') not in (
      'AUTHENTICATION_FAILED','AUTHORIZATION_FAILED','PROVIDER_CONFIGURATION_ERROR',
      'WRITE_OUTCOME_UNCERTAIN','PROVIDER_RESPONSE_INVALID','DB_SETTLE_UNCERTAIN'
    ) then raise exception using errcode='22023',message='ROOM_PIN_SHEET_SETTLE_INVALID'; end if;
    update private.room_pin_sheet_sync_outbox set status='failed',last_error_code=p_reason_code,
      claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null where id=job.id;
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code=p_reason_code,updated_at=at_time where singleton=true;
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true;
  return jsonb_build_object(
    'status',case when state.status='operator_blocked' then 'operator_blocked'
      else (select status from private.room_pin_sheet_sync_outbox where id=job.id) end,
    'pinVersion',job.pin_version);
end $$;

create function public.record_room_pin_sheet_sync_heartbeat(
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
  if state.status='leased' and exists(
    select 1 from private.room_pin_sheet_sync_outbox o
    where o.status='processing' and o.claim_id=p_claim_id and o.lease_fence=p_lease_fence
      and o.provider_write_started_at is not null
  ) then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_UNSETTLED_WRITE';
  end if;
  update private.room_pin_sheet_sync_outbox set status='pending',claim_id=null,claimed_at=null,
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

-- Phase C may expose a reviewed operator command. Phase B keeps this service-only
-- primitive so an uncertain write can never resume merely because a lease expired.
create function public.resume_room_pin_sheet_sync_after_reconciliation(
  p_expected_fence bigint,p_reconciliation_code text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
begin
  if p_expected_fence is null or p_reconciliation_code is null or
    p_reconciliation_code not in ('SHEET_READBACK_CONFIRMED','SHEET_REPAIRED_FROM_CURRENT') then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_RECONCILIATION_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.status<>'operator_blocked' or state.lease_fence<>p_expected_fence then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_RECONCILIATION_STALE';
  end if;
  update private.room_pin_sheet_sync_outbox set status='failed',next_attempt_at=at_time,
    provider_write_started_at=null,last_error_code='RECONCILIATION_REQUIRED',
    claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null
  where status='processing' or (status='failed' and provider_write_started_at is not null);
  update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,lease_expires_at=null,
    blocked_reason_code=null,updated_at=at_time where singleton=true;
  return jsonb_build_object('status','resumed','leaseFence',state.lease_fence);
end $$;

create function public.get_developer_room_pin_sheet_sync_status(p_actor_profile_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare state private.room_pin_sheet_sync_worker_state; heartbeat private.room_pin_sheet_sync_heartbeat;
  due_count integer; retry_count integer; blocked_count integer; expired_count integer;
  oldest_due timestamptz; status_value text; at_time timestamptz:=clock_timestamp();
begin
  perform private.assert_active_developer(p_actor_profile_id);
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true;
  select * into heartbeat from private.room_pin_sheet_sync_heartbeat where singleton=true;
  select least(count(*) filter(where status in ('pending','failed') and next_attempt_at<=at_time),1000)::integer,
    least(count(*) filter(where status='failed' and last_error_code in (
      'RATE_LIMITED','PROVIDER_UNAVAILABLE','RECONCILIATION_REQUIRED'
    )),1000)::integer,
    least(count(*) filter(where status='failed' and coalesce(last_error_code,'') not in (
      'RATE_LIMITED','PROVIDER_UNAVAILABLE','RECONCILIATION_REQUIRED'
    )),1000)::integer,
    least(count(*) filter(where status='processing' and claim_expires_at<=at_time),1000)::integer,
    min(next_attempt_at) filter(where status in ('pending','failed') and next_attempt_at<=at_time)
  into due_count,retry_count,blocked_count,expired_count,oldest_due
  from private.room_pin_sheet_sync_outbox where status in ('pending','failed','processing');
  status_value:=case
    when state.status='operator_blocked' or blocked_count>0 then 'operator_blocked'
    when heartbeat.singleton is null then 'awaiting_first_run'
    when heartbeat.status='failed' then 'failed'
    when heartbeat.status in ('degraded','operator_blocked') or heartbeat.recorded_at<at_time-interval '5 minutes'
      or expired_count>0 or (oldest_due is not null and oldest_due<at_time-interval '5 minutes') then 'degraded'
    else 'healthy' end;
  return jsonb_build_object('status',status_value,
    'lastHeartbeat',case when heartbeat.singleton is null then null else jsonb_build_object(
      'status',heartbeat.status,'claimed',heartbeat.claimed,'projected',heartbeat.projected,
      'alreadyCurrent',heartbeat.already_current,'superseded',heartbeat.superseded,
      'retrying',heartbeat.retrying,'blocked',heartbeat.blocked,
      'errorCode',heartbeat.error_code,'recordedAt',heartbeat.recorded_at) end,
    'backlog',jsonb_build_object('due',due_count,'retrying',retry_count,'blocked',blocked_count,
      'expiredLeases',expired_count,'oldestDueAt',oldest_due),
    'worker',jsonb_build_object('operatorBlocked',state.status='operator_blocked',
      'blockedReasonCode',state.blocked_reason_code),'checkedAt',at_time);
end $$;

revoke all on function public.claim_room_pin_sheet_sync(uuid,integer,text,text) from public,anon,authenticated;
revoke all on function public.renew_room_pin_sheet_sync_run(uuid,bigint) from public,anon,authenticated;
revoke all on function public.authorize_room_pin_sheet_write(uuid,uuid,bigint,bigint) from public,anon,authenticated;
revoke all on function public.settle_room_pin_sheet_sync(uuid,uuid,bigint,bigint,text,text) from public,anon,authenticated;
revoke all on function public.record_room_pin_sheet_sync_heartbeat(uuid,bigint,text,integer,integer,integer,integer,integer,integer,text) from public,anon,authenticated;
revoke all on function public.resume_room_pin_sheet_sync_after_reconciliation(bigint,text) from public,anon,authenticated;
revoke all on function public.get_developer_room_pin_sheet_sync_status(uuid) from public,anon,authenticated;
grant execute on function public.claim_room_pin_sheet_sync(uuid,integer,text,text) to service_role;
grant execute on function public.renew_room_pin_sheet_sync_run(uuid,bigint) to service_role;
grant execute on function public.authorize_room_pin_sheet_write(uuid,uuid,bigint,bigint) to service_role;
grant execute on function public.settle_room_pin_sheet_sync(uuid,uuid,bigint,bigint,text,text) to service_role;
grant execute on function public.record_room_pin_sheet_sync_heartbeat(uuid,bigint,text,integer,integer,integer,integer,integer,integer,text) to service_role;
grant execute on function public.resume_room_pin_sheet_sync_after_reconciliation(bigint,text) to service_role;
grant execute on function public.get_developer_room_pin_sheet_sync_status(uuid) to service_role;

comment on table private.room_pin_sheet_sync_worker_state is
  'Global fenced singleton. Uncertain provider writes remain operator-blocked until explicit reconciliation.';
comment on table private.room_pin_sheet_sync_heartbeat is
  'Bounded safe worker observability. Never stores PIN, Sheet cells, token, credential, or provider response.';
