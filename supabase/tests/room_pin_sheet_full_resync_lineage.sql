begin;
select no_plan();

create function pg_temp.fid(n integer) returns uuid language sql immutable as $$
  select ('f1371000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;

insert into auth.users(id) values(pg_temp.fid(101));
insert into auth.sessions(id,user_id) values(pg_temp.fid(201),pg_temp.fid(101));
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values(
  pg_temp.fid(1),pg_temp.fid(101),'lineage admin','lineage admin',
  'lineage-admin','lineage-admin',0,'admin','active',false
);

update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=clock_timestamp(),
  claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,
  provider_write_started_at=null,last_error_code=null
where status in ('pending','processing','failed');
update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,
  lease_expires_at=null,blocked_reason_code=null,updated_at=clock_timestamp()
where singleton=true;

create function pg_temp.request_run(p_key text,p_target text default repeat('a',64))
returns uuid language plpgsql as $$
declare response jsonb; run_id uuid;
begin
  response:=public.request_room_pin_sheet_full_resync(
    pg_temp.fid(1),pg_temp.fid(201),
    (select lease_fence from private.room_pin_sheet_sync_worker_state where singleton),
    'local','local',p_target,p_key,
    encode(extensions.digest(convert_to(p_key,'UTF8'),'sha256'),'hex')
  );
  if response->>'status'<>'pending' then
    raise exception 'request % did not become pending: %',p_key,response;
  end if;
  select id into strict run_id from private.room_pin_sheet_full_resync_runs
  where actor_profile_id=pg_temp.fid(1) and idempotency_key=p_key;
  return run_id;
end $$;

create function pg_temp.install_next_pin() returns void language plpgsql as $$
declare target_room uuid; next_version bigint; revision_id uuid:=gen_random_uuid();
begin
  select id into target_room from public.rooms order by room_number,id limit 1;
  select coalesce(pin_version,0)+1 into next_version
  from private.room_current_pin where room_id=target_room;
  if next_version is null then next_version:=1; end if;
  insert into private.room_pin_revisions(
    id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,key_version,
    aad_environment,aad_project_ref,recorded_by,recorded_by_role,source
  ) values(
    revision_id,target_room,next_version,1,
    extensions.digest(convert_to(target_room::text||next_version::text||'cipher','UTF8'),'sha256'),
    substring(extensions.digest(convert_to(target_room::text||next_version::text||'nonce','UTF8'),'sha256') for 12),
    substring(extensions.digest(convert_to(target_room::text||next_version::text||'tag','UTF8'),'sha256') for 16),
    'test-fixture','local','local',pg_temp.fid(1),'admin','admin_initial_entry'
  );
  insert into private.room_current_pin(room_id,pin_revision_id,pin_version)
  values(target_room,revision_id,next_version)
  on conflict(room_id) do update set pin_revision_id=excluded.pin_revision_id,
    pin_version=excluded.pin_version,updated_at=clock_timestamp();
end $$;

create function pg_temp.run_lineage_case(p_mode text,p_case integer) returns void
language plpgsql as $$
declare
  key_prefix text:=format('lineage-%s-%s',replace(p_mode,'_','-'),p_case);
  root_id uuid; failed_recovery_id uuid; success_id uuid;
  claim_id uuid; late_claim_id uuid; claim jsonb; result jsonb;
  root_value uuid; failed_fence bigint; late_fence bigint;
  status_value jsonb;
begin
  perform pg_sleep(0.001);
  root_id:=pg_temp.request_run(key_prefix||'-root');
  claim_id:=gen_random_uuid();
  claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  if claim->>'status'<>'claimed' or (claim#>>'{operation,runId}')::uuid<>root_id then
    raise exception 'root claim failed for %: %',p_mode,claim;
  end if;
  result:=public.settle_room_pin_sheet_full_resync(
    root_id,claim_id,(claim->>'leaseFence')::bigint,'operator_blocked','AUTHENTICATION_FAILED'
  );
  if result->>'status'<>'operator_blocked' then
    raise exception 'root did not block for %: %',p_mode,result;
  end if;
  if (select recovery_root_run_id from private.room_pin_sheet_full_resync_runs where id=root_id)<>root_id then
    raise exception 'normal run is not its own root for %',p_mode;
  end if;

  perform pg_sleep(0.001);
  failed_recovery_id:=pg_temp.request_run(
    key_prefix||'-failed',case when p_mode='target_mismatch' then repeat('b',64) else repeat('a',64) end
  );
  if (select recovery_root_run_id from private.room_pin_sheet_full_resync_runs where id=failed_recovery_id)<>root_id then
    raise exception 'failed recovery did not inherit root for %',p_mode;
  end if;

  if p_mode='target_mismatch' then
    result:=public.claim_room_pin_sheet_full_resync(gen_random_uuid(),'local','local',repeat('a',64));
    if result->>'status'<>'operator_blocked' then
      raise exception 'target mismatch did not block: %',result;
    end if;
  else
    if p_mode='retry_exhausted' then
      update private.room_pin_sheet_full_resync_runs set retry_count=7 where id=failed_recovery_id;
    end if;
    claim_id:=gen_random_uuid();
    claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
    if claim->>'status'<>'claimed' or (claim#>>'{operation,runId}')::uuid<>failed_recovery_id then
      raise exception 'failed recovery claim failed for %: %',p_mode,claim;
    end if;
    failed_fence:=(claim->>'leaseFence')::bigint;
    if p_mode='retry_exhausted' then
      result:=public.settle_room_pin_sheet_full_resync(
        failed_recovery_id,claim_id,failed_fence,'retryable','PROVIDER_UNAVAILABLE'
      );
    elsif p_mode='provider_block' then
      result:=public.settle_room_pin_sheet_full_resync(
        failed_recovery_id,claim_id,failed_fence,'operator_blocked','AUTHORIZATION_FAILED'
      );
    elsif p_mode='db_settle_uncertain' then
      perform public.authorize_room_pin_sheet_full_resync_write(failed_recovery_id,claim_id,failed_fence);
      result:=public.block_room_pin_sheet_full_resync_after_settle_failure(
        failed_recovery_id,claim_id,failed_fence
      );
    elsif p_mode='marker_lease_expiry' then
      perform public.authorize_room_pin_sheet_full_resync_write(failed_recovery_id,claim_id,failed_fence);
      update private.room_pin_sheet_full_resync_runs set
        claimed_at=clock_timestamp()-interval '2 minutes',
        claim_expires_at=clock_timestamp()-interval '1 minute'
      where id=failed_recovery_id;
      update private.room_pin_sheet_sync_worker_state set
        lease_expires_at=clock_timestamp()-interval '1 minute' where singleton;
      result:=public.claim_room_pin_sheet_full_resync(gen_random_uuid(),'local','local',repeat('a',64));
    elsif p_mode='snapshot_stale' then
      perform pg_temp.install_next_pin();
      result:=public.authorize_room_pin_sheet_full_resync_write(
        failed_recovery_id,claim_id,failed_fence
      );
    else
      raise exception 'unknown lineage mode %',p_mode;
    end if;
    if result->>'status'<>'operator_blocked' then
      raise exception 'failed recovery did not block for %: %',p_mode,result;
    end if;
  end if;
  if (select status from private.room_pin_sheet_full_resync_runs where id=failed_recovery_id)<>'operator_blocked'
    or (select recovery_root_run_id from private.room_pin_sheet_full_resync_runs where id=failed_recovery_id)<>root_id then
    raise exception 'failed recovery lost blocked root for %',p_mode;
  end if;

  perform pg_sleep(0.001);
  success_id:=pg_temp.request_run(key_prefix||'-success');
  if (select recovery_root_run_id from private.room_pin_sheet_full_resync_runs where id=success_id)<>root_id then
    raise exception 'success recovery did not inherit root for %',p_mode;
  end if;
  late_claim_id:=claim_id;
  late_fence:=failed_fence;
  claim_id:=gen_random_uuid();
  claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  if claim->>'status'<>'claimed' or (claim#>>'{operation,runId}')::uuid<>success_id then
    raise exception 'success recovery claim failed for %: %',p_mode,claim;
  end if;
  if late_fence is not null then
    begin
      perform public.settle_room_pin_sheet_full_resync(
        failed_recovery_id,late_claim_id,late_fence,'operator_blocked','DB_SETTLE_UNCERTAIN'
      );
      raise exception 'late stale worker settled for %',p_mode;
    exception when serialization_failure then null;
    end;
  end if;
  perform public.authorize_room_pin_sheet_full_resync_write(
    success_id,claim_id,(claim->>'leaseFence')::bigint
  );
  result:=public.settle_room_pin_sheet_full_resync(
    success_id,claim_id,(claim->>'leaseFence')::bigint,'succeeded',null
  );
  if result->>'status'<>'succeeded' then
    raise exception 'success recovery did not settle for %: %',p_mode,result;
  end if;
  perform public.record_room_pin_sheet_sync_heartbeat(
    claim_id,(claim->>'leaseFence')::bigint,'succeeded',1,1,0,0,0,0,null
  );
  if exists(select 1 from private.room_pin_sheet_full_resync_runs
    where id in (root_id,failed_recovery_id) and status<>'superseded')
    or (select status from private.room_pin_sheet_full_resync_runs where id=success_id)<>'succeeded' then
    raise exception 'lineage did not converge for %',p_mode;
  end if;
  status_value:=public.get_room_pin_sheet_sync_status(pg_temp.fid(1),pg_temp.fid(201));
  if (status_value->>'pending')::integer<>0 or (status_value->>'failed')::integer<>0
    or (status_value->>'operatorBlocked')::boolean or status_value->'lastErrorCode'<>'null'::jsonb then
    raise exception 'safe status did not converge for %: %',p_mode,status_value;
  end if;
end $$;

select lives_ok($$select pg_temp.run_lineage_case('target_mismatch',1)$$,
  'A blocked, target-mismatched B, and successful C retain one root and converge');
select lives_ok($$select pg_temp.run_lineage_case('retry_exhausted',2)$$,
  'A blocked, retry-exhausted B, and successful C retain one root and converge');
select lives_ok($$select pg_temp.run_lineage_case('provider_block',3)$$,
  'A blocked, provider-blocked B, and successful C retain one root and converge');
select lives_ok($$select pg_temp.run_lineage_case('db_settle_uncertain',4)$$,
  'A blocked, settle-uncertain B, and successful C retain one root and converge');
select lives_ok($$select pg_temp.run_lineage_case('marker_lease_expiry',5)$$,
  'A blocked, marker-expired B, and successful C retain one root and converge');
select lives_ok($$select pg_temp.run_lineage_case('snapshot_stale',6)$$,
  'A blocked, snapshot-stale B, and successful C retain one root and converge');

-- Build a longer mixed lineage without intermediate success: target drift,
-- stale snapshot, and a confirmed-write/settle uncertainty must all retain the
-- original root until one final exact-fence recovery succeeds.
create function pg_temp.run_mixed_lineage() returns void language plpgsql as $$
declare root_id uuid; b_id uuid; c_id uuid; d_id uuid; e_id uuid;
  claim_id uuid; claim jsonb; fence bigint; result jsonb;
begin
  root_id:=pg_temp.request_run('mixed-lineage-root');
  claim_id:=gen_random_uuid(); claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  perform public.settle_room_pin_sheet_full_resync(root_id,claim_id,(claim->>'leaseFence')::bigint,
    'operator_blocked','AUTHENTICATION_FAILED');

  b_id:=pg_temp.request_run('mixed-lineage-target',repeat('b',64));
  result:=public.claim_room_pin_sheet_full_resync(gen_random_uuid(),'local','local',repeat('a',64));
  if result->>'status'<>'operator_blocked' then raise exception 'mixed target failure missing'; end if;

  c_id:=pg_temp.request_run('mixed-lineage-stale');
  claim_id:=gen_random_uuid(); claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  fence:=(claim->>'leaseFence')::bigint;
  perform pg_temp.install_next_pin();
  result:=public.authorize_room_pin_sheet_full_resync_write(c_id,claim_id,fence);
  if result->>'status'<>'operator_blocked' then raise exception 'mixed stale failure missing'; end if;

  d_id:=pg_temp.request_run('mixed-lineage-db-settle');
  claim_id:=gen_random_uuid(); claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  fence:=(claim->>'leaseFence')::bigint;
  perform public.authorize_room_pin_sheet_full_resync_write(d_id,claim_id,fence);
  perform public.block_room_pin_sheet_full_resync_after_settle_failure(d_id,claim_id,fence);

  e_id:=pg_temp.request_run('mixed-lineage-success');
  claim_id:=gen_random_uuid(); claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  fence:=(claim->>'leaseFence')::bigint;
  perform public.authorize_room_pin_sheet_full_resync_write(e_id,claim_id,fence);
  result:=public.settle_room_pin_sheet_full_resync(e_id,claim_id,fence,'succeeded',null);
  if result->>'status'<>'succeeded' then raise exception 'mixed lineage success failed: %',result; end if;
  perform public.record_room_pin_sheet_sync_heartbeat(claim_id,fence,'succeeded',1,1,0,0,0,0,null);
  if (select count(distinct recovery_root_run_id) from private.room_pin_sheet_full_resync_runs
      where id in (root_id,b_id,c_id,d_id,e_id))<>1
    or exists(select 1 from private.room_pin_sheet_full_resync_runs
      where id in (root_id,b_id,c_id,d_id) and status<>'superseded') then
    raise exception 'mixed lineage root or cleanup widened/narrowed incorrectly';
  end if;
end $$;
select lives_ok($$select pg_temp.run_mixed_lineage()$$,
  'mixed three-stage recovery failures retain one root until bounded final success');

select throws_ok(format($sql$update private.room_pin_sheet_full_resync_runs
  set recovery_root_run_id=%L where id=(select id from private.room_pin_sheet_full_resync_runs
    where idempotency_key='mixed-lineage-success')$sql$,pg_temp.fid(999)),
  '55000','ROOM_PIN_SHEET_FULL_RESYNC_IMMUTABLE',
  'recovery root is immutable even after successful lineage cleanup');
select throws_ok(format($sql$insert into private.room_pin_sheet_full_resync_runs(
  id,actor_profile_id,actor_role_snapshot,expected_fence,reconciles_blocked_fence,recovery_root_run_id,
  aad_environment,aad_project_ref,target_identity_digest,snapshot_room_count,idempotency_key,request_hash
) values(%L,%L,'admin',0,null,%L,'local','local',repeat('a',64),121,
  'arbitrary-child-root',repeat('f',64))$sql$,pg_temp.fid(900),pg_temp.fid(1),
  (select recovery_root_run_id from private.room_pin_sheet_full_resync_runs
    where idempotency_key='mixed-lineage-success')),
  '55000','ROOM_PIN_SHEET_FULL_RESYNC_LINEAGE_INVALID',
  'a caller cannot attach an arbitrary child to an existing recovery root');

-- The cleanup bound is intentional. More than 32 prior blocks makes the
-- provider-confirmed current run the new durable block; a new explicit command
-- then finishes the remaining prefix. An unrelated blocked root is untouched
-- and continues to prevent a false-green status.
create function pg_temp.run_bounded_lineage() returns void language plpgsql as $$
declare i integer; run_id uuid; root_id uuid; capped_id uuid; final_id uuid;
  unrelated_id uuid:=pg_temp.fid(950); claim_id uuid; claim jsonb; fence bigint;
  result jsonb; status_value jsonb;
begin
  for i in 1..34 loop
    run_id:=pg_temp.request_run(format('bounded-lineage-%s',lpad(i::text,2,'0')));
    if i=1 then root_id:=run_id;
    elsif (select recovery_root_run_id from private.room_pin_sheet_full_resync_runs where id=run_id)<>root_id then
      raise exception 'bounded lineage child % lost root',i;
    end if;
    claim_id:=gen_random_uuid();
    claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
    result:=public.settle_room_pin_sheet_full_resync(
      run_id,claim_id,(claim->>'leaseFence')::bigint,'operator_blocked','AUTHENTICATION_FAILED'
    );
    if result->>'status'<>'operator_blocked' then raise exception 'bounded block % failed',i; end if;
  end loop;
  insert into private.room_pin_sheet_full_resync_runs(
    id,actor_profile_id,actor_role_snapshot,expected_fence,recovery_root_run_id,
    aad_environment,aad_project_ref,target_identity_digest,snapshot_room_count,status,
    lease_fence,retry_count,last_error_code,idempotency_key,request_hash,requested_at,completed_at
  ) values(
    unrelated_id,pg_temp.fid(1),'admin',0,unrelated_id,'local','local',repeat('a',64),121,
    'operator_blocked',999999,0,'AUTHENTICATION_FAILED','unrelated-lineage-block',repeat('e',64),
    clock_timestamp()+interval '1 second',clock_timestamp()+interval '1 second'
  );

  capped_id:=pg_temp.request_run('bounded-lineage-capped-success');
  claim_id:=gen_random_uuid(); claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  fence:=(claim->>'leaseFence')::bigint;
  perform public.authorize_room_pin_sheet_full_resync_write(capped_id,claim_id,fence);
  result:=public.settle_room_pin_sheet_full_resync(capped_id,claim_id,fence,'succeeded',null);
  if result->>'status'<>'operator_blocked'
    or (select status from private.room_pin_sheet_full_resync_runs where id=capped_id)<>'operator_blocked'
    or (select last_error_code from private.room_pin_sheet_full_resync_runs where id=capped_id)<>'DB_SETTLE_UNCERTAIN'
    or not (select provider_write_started_at is not null from private.room_pin_sheet_full_resync_runs where id=capped_id)
    or (select count(*) from private.room_pin_sheet_full_resync_runs
      where recovery_root_run_id=root_id and status='superseded')<>32
    or (select count(*) from private.room_pin_sheet_full_resync_runs
      where recovery_root_run_id=root_id and status='operator_blocked')<>3 then
    raise exception 'bounded cleanup did not stop at 32: %',result;
  end if;
  if exists(select 1 from public.audit_events where entity_id=capped_id
    and event_type='room_pin_sheet.full_resync_succeeded') then
    raise exception 'bounded partial cleanup emitted success audit';
  end if;
  perform public.record_room_pin_sheet_sync_heartbeat(
    claim_id,fence,'operator_blocked',1,0,0,0,0,1,'DB_SETTLE_UNCERTAIN'
  );
  if public.claim_room_pin_sheet_full_resync(gen_random_uuid(),'local','local',repeat('a',64))->>'status'
      <>'operator_blocked' then
    raise exception 'capped run was automatically reclaimable';
  end if;

  final_id:=pg_temp.request_run('bounded-lineage-final-success');
  claim_id:=gen_random_uuid(); claim:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
  fence:=(claim->>'leaseFence')::bigint;
  perform public.authorize_room_pin_sheet_full_resync_write(final_id,claim_id,fence);
  result:=public.settle_room_pin_sheet_full_resync(final_id,claim_id,fence,'succeeded',null);
  if result->>'status'<>'succeeded' then raise exception 'bounded final cleanup failed: %',result; end if;
  perform public.record_room_pin_sheet_sync_heartbeat(claim_id,fence,'succeeded',1,1,0,0,0,0,null);
  if exists(select 1 from private.room_pin_sheet_full_resync_runs
      where recovery_root_run_id=root_id and status='operator_blocked')
    or (select status from private.room_pin_sheet_full_resync_runs where id=unrelated_id)<>'operator_blocked' then
    raise exception 'bounded final cleanup changed unrelated or retained lineage blocks';
  end if;
  status_value:=public.get_room_pin_sheet_sync_status(pg_temp.fid(1),pg_temp.fid(201));
  if (status_value->>'failed')::integer<>121 or (status_value->>'operatorBlocked')::boolean
    or status_value->'lastErrorCode'='null'::jsonb then
    raise exception 'unrelated blocked history was false green: %',status_value;
  end if;
  update private.room_pin_sheet_full_resync_runs set status='superseded' where id=unrelated_id;
  status_value:=public.get_room_pin_sheet_sync_status(pg_temp.fid(1),pg_temp.fid(201));
  if (status_value->>'pending')::integer<>0 or (status_value->>'failed')::integer<>0
    or (status_value->>'operatorBlocked')::boolean or status_value->'lastErrorCode'<>'null'::jsonb then
    raise exception 'isolated bounded fixture did not finally converge: %',status_value;
  end if;
end $$;
select lives_ok($$select pg_temp.run_bounded_lineage()$$,
  '33+ lineage uses a 32-row partial cleanup, blocks safely, and converges only after explicit recovery');

select * from finish();
rollback;
