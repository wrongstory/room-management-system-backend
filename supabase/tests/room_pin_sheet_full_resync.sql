begin;
select no_plan();

create function pg_temp.fid(n integer) returns uuid language sql immutable as $$
  select ('f1370000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create temp table full_resync_rooms as
select row_number() over(order by room_number,id)::integer slot,id,room_number
from public.rooms order by room_number,id;
create function pg_temp.room_id(n integer) returns uuid language sql stable as $$
  select id from pg_temp.full_resync_rooms where slot=n
$$;
create function pg_temp.install_pin(p_room uuid,p_actor uuid,p_version bigint) returns uuid
language plpgsql as $$
declare revision_id uuid:=gen_random_uuid();
begin
  insert into private.room_pin_revisions(id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,
    key_version,aad_environment,aad_project_ref,recorded_by,recorded_by_role,source)
  values(revision_id,p_room,p_version,1,digest(p_room::text||p_version::text||'cipher','sha256'),
    substring(digest(p_room::text||p_version::text||'nonce','sha256') for 12),
    substring(digest(p_room::text||p_version::text||'tag','sha256') for 16),
    'test-fixture','local','local',p_actor,'admin','admin_initial_entry');
  insert into private.room_current_pin(room_id,pin_revision_id,pin_version)
  values(p_room,revision_id,p_version)
  on conflict(room_id) do update set pin_revision_id=excluded.pin_revision_id,
    pin_version=excluded.pin_version,updated_at=clock_timestamp();
  return revision_id;
end $$;

insert into auth.users(id) values(pg_temp.fid(101)),(pg_temp.fid(102)),(pg_temp.fid(103)),(pg_temp.fid(104));
insert into auth.sessions(id,user_id) values
  (pg_temp.fid(201),pg_temp.fid(101)),(pg_temp.fid(202),pg_temp.fid(102)),
  (pg_temp.fid(203),pg_temp.fid(103)),(pg_temp.fid(204),pg_temp.fid(104));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values
  (pg_temp.fid(4),pg_temp.fid(104),'audit developer','audit developer','admin','admin',0,'developer','active',false),
  (pg_temp.fid(1),pg_temp.fid(101),'full resync admin','full resync admin','full-resync-admin','full-resync-admin',0,'admin','active',false),
  (pg_temp.fid(2),pg_temp.fid(102),'full resync maid','full resync maid','full-resync-maid','full-resync-maid',0,'maid','active',false),
  (pg_temp.fid(3),pg_temp.fid(103),'retry admin','retry admin','full-resync-retry','full-resync-retry',0,'admin','active',false);
create temp table full_resync_developer as select pg_temp.fid(4) id;

update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=clock_timestamp(),
  claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,
  provider_write_started_at=null,last_error_code=null
where status in ('pending','processing','failed');
update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,
  lease_expires_at=null,blocked_reason_code=null,updated_at=clock_timestamp()
where singleton=true;

select is((select count(*)::integer from pg_temp.full_resync_rooms),121,'fixture has exact 121-room master');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='private.room_pin_sheet_full_resync_runs'::regclass),'full resync run ledger uses forced RLS');
select ok(not has_table_privilege('service_role','private.room_pin_sheet_full_resync_items','SELECT'),
  'service role cannot read the raw immutable snapshot table');
select ok(has_function_privilege('service_role',
  'public.request_room_pin_sheet_full_resync(uuid,uuid,bigint,text,text,text,text,text)','EXECUTE'),
  'service role may call the authenticated operator command');
select ok(not has_function_privilege('authenticated',
  'public.request_room_pin_sheet_full_resync(uuid,uuid,bigint,text,text,text,text,text)','EXECUTE'),
  'authenticated Data API role cannot bypass the server command');
select throws_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,0,'local','local',repeat('a',64),'maid-request-0001',repeat('b',64))$sql$,
  pg_temp.fid(2),pg_temp.fid(202)),'42501','ROOM_PIN_SHEET_OPERATOR_REQUIRED',
  'maid cannot request full-board repair');

-- A retryable failed run remains the single logical command; a different key
-- cannot enqueue a second provider write while its backoff is pending.
select pg_temp.install_pin(pg_temp.room_id(2),pg_temp.fid(3),1);
insert into private.room_pin_sheet_sync_outbox(
  id,room_id,pin_version,sync_status,reason_code,status,created_at
) values(
  pg_temp.fid(304),pg_temp.room_id(2),1,'verified','PIN_CHANGE_CONFIRMED','pending',
  clock_timestamp()-interval '1 second'
);
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'retry-full-request-0001',repeat('1',64))$sql$,
  pg_temp.fid(3),pg_temp.fid(203),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton)),
  'initial retry fixture command is accepted');
create temp table retry_claim(value jsonb);
insert into retry_claim values(public.claim_room_pin_sheet_full_resync(pg_temp.fid(390),'local','local',repeat('a',64)));
select lives_ok(format($sql$select public.settle_room_pin_sheet_full_resync(%L,%L,%s,'retryable','PROVIDER_UNAVAILABLE')$sql$,
  ((select value#>>'{operation,runId}' from retry_claim))::uuid,pg_temp.fid(390),
  ((select value->>'leaseFence' from retry_claim))::bigint),'retryable provider failure enters bounded backoff');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'degraded',1,0,0,0,1,0,'PROVIDER_UNAVAILABLE')$sql$,
  pg_temp.fid(390),((select value->>'leaseFence' from retry_claim))::bigint),'retry fixture releases singleton');
select throws_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'retry-full-request-0002',repeat('2',64))$sql$,
  pg_temp.fid(3),pg_temp.fid(203),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton)),
  '55000','ROOM_PIN_SHEET_FULL_RESYNC_PENDING','different key cannot duplicate a retryable full run');
select is((select count(*)::integer from private.room_pin_sheet_full_resync_runs where actor_profile_id=pg_temp.fid(3)),1,
  'retryable full resync retains exactly one run');
update private.room_pin_sheet_full_resync_runs set next_attempt_at=clock_timestamp()-interval '1 second'
where actor_profile_id=pg_temp.fid(3) and status='failed';
create temp table retry_claim_2(value jsonb);
insert into retry_claim_2 values(public.claim_room_pin_sheet_full_resync(pg_temp.fid(391),'local','local',repeat('a',64)));
select is((select value->>'status' from retry_claim_2),'claimed','the single failed run is reclaimed after backoff');
select is(public.authorize_room_pin_sheet_full_resync_write(
  ((select value#>>'{operation,runId}' from retry_claim_2))::uuid,pg_temp.fid(391),
  ((select value->>'leaseFence' from retry_claim_2))::bigint
)->>'status','authorized','retry obtains one final provider permit');
select is(public.settle_room_pin_sheet_full_resync(
  ((select value#>>'{operation,runId}' from retry_claim_2))::uuid,pg_temp.fid(391),
  ((select value->>'leaseFence' from retry_claim_2))::bigint,'succeeded',null
)->>'status','succeeded','ordinary full-board success settles once');
select is((select status from private.room_pin_sheet_sync_outbox where id=pg_temp.fid(304)),'superseded',
  'ordinary full-board success prevents a duplicate incremental provider write');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.fid(391),((select value->>'leaseFence' from retry_claim_2))::bigint),'ordinary full-board fixture releases singleton');

select pg_temp.install_pin(pg_temp.room_id(1),pg_temp.fid(1),1);
insert into private.room_pin_sheet_sync_outbox(
  id,room_id,pin_version,sync_status,reason_code,status,last_error_code,
  provider_write_started_at,completed_at,created_at
) values(
  pg_temp.fid(301),pg_temp.room_id(1),1,'verified','PIN_CHANGE_CONFIRMED','failed',
  'DB_SETTLE_UNCERTAIN',clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 minute',
  clock_timestamp()-interval '2 minutes'
);
update private.room_pin_sheet_sync_worker_state set status='operator_blocked',
  blocked_reason_code='DB_SETTLE_UNCERTAIN',updated_at=clock_timestamp() where singleton=true;
select pg_temp.install_pin(pg_temp.room_id(1),pg_temp.fid(1),2);
insert into private.room_pin_sheet_sync_outbox(
  id,room_id,pin_version,sync_status,reason_code,status,created_at
) values(
  pg_temp.fid(303),pg_temp.room_id(1),2,'verified','PIN_CHANGE_CONFIRMED','pending',
  clock_timestamp()-interval '1 second'
);

create temp table requested(value jsonb);
insert into requested values(public.request_room_pin_sheet_full_resync(
  pg_temp.fid(1),pg_temp.fid(201),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton),
  'local','local',repeat('a',64),
  'full-resync-request-0001',repeat('b',64)
));
select is((select value->>'status' from requested),'pending','operator command enqueues one full resync');
select is((select value->>'roomCount' from requested),'121','command reports the exact bounded room count');
select is((select count(*)::integer from private.room_pin_sheet_full_resync_items
  where run_id=(select id from private.room_pin_sheet_full_resync_runs
    where actor_profile_id=pg_temp.fid(1) and idempotency_key='full-resync-request-0001')),121,
  'snapshot contains every room exactly once');
select is((select min(sheet_row) from private.room_pin_sheet_full_resync_items),2,
  'deterministic snapshot begins at row 2');
select is((select max(sheet_row) from private.room_pin_sheet_full_resync_items),122,
  'deterministic snapshot ends at row 122');
select is(public.request_room_pin_sheet_full_resync(
  pg_temp.fid(1),pg_temp.fid(201),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton),
  'local','local',repeat('a',64),
  'full-resync-request-0001',repeat('b',64)
), (select value from requested),'same key and target marker replays the command response');
select throws_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('c',64),'full-resync-request-0001',repeat('d',64))$sql$,
  pg_temp.fid(1),pg_temp.fid(201),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton)),
  '23505','IDEMPOTENCY_KEY_REUSED',
  'changed target marker cannot replay an earlier command key');

create temp table full_claim(value jsonb);
insert into full_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(401),'local','local',repeat('a',64)
));
select is((select value->>'status' from full_claim),'claimed','reconciliation full run owns the singleton fence');
select is(jsonb_array_length((select value#>'{operation,items}' from full_claim)),121,
  'worker receives one bounded immutable 121-room snapshot');
select ok(not (select value#>'{operation}' from full_claim)::text ~* '(credential|access.?token|private.?key|google.?response)',
  'claim contains no provider credential, token, or raw response');
select is(public.claim_room_pin_sheet_sync(pg_temp.fid(402),10,'local','local')->>'status','busy',
  'incremental worker cannot race a full-board writer');

create temp table full_ids as select
  ((value#>>'{operation,runId}'))::uuid run_id,
  ((value->>'leaseFence'))::bigint fence from full_claim;
select throws_ok(format($sql$select public.settle_room_pin_sheet_full_resync(%L,%L,%s,'succeeded',null)$sql$,
  (select run_id from full_ids),pg_temp.fid(401),(select fence from full_ids)),
  '55000','ROOM_PIN_SHEET_FULL_RESYNC_NOT_AUTHORIZED',
  'success cannot settle before the final provider permit marker');
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from full_ids),pg_temp.fid(401),(select fence from full_ids)
)->>'status','authorized','full-board write receives a final snapshot/fence permit');

-- A newer PIN committed after the full-board permit must remain incremental work.
select pg_temp.install_pin(pg_temp.room_id(1),pg_temp.fid(1),3);
insert into private.room_pin_sheet_sync_outbox(
  id,room_id,pin_version,sync_status,reason_code,status,created_at
) values(
  pg_temp.fid(302),pg_temp.room_id(1),3,'verified','PIN_CHANGE_CONFIRMED','pending',
  clock_timestamp()+interval '1 millisecond'
);
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from full_ids),pg_temp.fid(401),(select fence from full_ids),'succeeded',null
)->>'status','succeeded','provider-confirmed full-board snapshot settles once');
create temp table full_resync_audit as
select * from public.list_developer_audit_events(
  (select id from pg_temp.full_resync_developer),
  array['room_pin_sheet.full_resync_requested','room_pin_sheet.full_resync_succeeded'],
  pg_temp.fid(1),null,null,null,null,10
);
select is((select count(*)::integer from pg_temp.full_resync_audit),2,
  'developer audit allowlist includes requested and succeeded full-resync events');
select ok(not exists(select 1 from pg_temp.full_resync_audit
  where summary::text ~* '(request.?hash|target|digest|pin|cipher|envelope|credential|token|spreadsheet|tab|google)'),
  'developer audit summary excludes request hashes, target markers, PIN and provider material');
select ok(not exists(select 1 from pg_temp.full_resync_audit
  where (select string_agg(key,',' order by key) from jsonb_object_keys(summary) key)
    not in ('roomCount,status','reconciliation,roomCount,status')),
  'full-resync audit summary has only source-controlled safe keys');
select is((select status from private.room_pin_sheet_sync_outbox where id=pg_temp.fid(301)),'superseded',
  'fence-null uncertain outbox included in the successful snapshot is terminal');
select ok((select provider_write_started_at is not null from private.room_pin_sheet_sync_outbox where id=pg_temp.fid(301)),
  'uncertain provider-write evidence remains durable after reconciliation');
select is((select status from private.room_pin_sheet_sync_outbox where id=pg_temp.fid(303)),'superseded',
  'pre-authorize current-version outbox is covered by the full-board snapshot');
select is((select status from private.room_pin_sheet_sync_outbox where id=pg_temp.fid(302)),'pending',
  'PIN change committed after authorization remains incremental work');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.fid(401),(select fence from full_ids)),'full resync heartbeat releases the singleton');
create temp table newer_claim(value jsonb);
insert into newer_claim values(public.claim_room_pin_sheet_sync(pg_temp.fid(403),10,'local','local'));
select is((select value#>>'{items,0,pinVersion}' from newer_claim),'3',
  'incremental worker claims the post-authorization PIN version for final convergence');
select lives_ok(format($sql$select public.settle_room_pin_sheet_sync(%L,%L,%s,3,'already_current',null)$sql$,
  ((select value#>>'{items,0,outboxId}' from newer_claim))::uuid,pg_temp.fid(403),
  ((select value->>'leaseFence' from newer_claim))::bigint),'newer incremental work can settle');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,0,1,0,0,0,null)$sql$,
  pg_temp.fid(403),((select value->>'leaseFence' from newer_claim))::bigint),'incremental convergence releases the singleton');

-- Retry exhaustion must retain the exact fence that put the singleton into
-- operator-blocked. A later full-board success reconciles that one prior run,
-- but neither a newer blocked record nor the same settle replay may widen the
-- supersede set.
create temp table exhausted_recovery_evidence(old_run_id uuid,blocked_fence bigint);
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'retry-exhaustion-0001',repeat('7',64))$sql$,
  pg_temp.fid(3),pg_temp.fid(203),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton)),
  'retry-exhaustion fixture command is accepted');
do $$
declare
  i integer;
  claim_id uuid;
  claimed jsonb;
  settled jsonb;
  run_id uuid;
  fence bigint;
begin
  for i in 1..8 loop
    claim_id:=pg_temp.fid(420+i);
    claimed:=public.claim_room_pin_sheet_full_resync(claim_id,'local','local',repeat('a',64));
    if claimed->>'status'<>'claimed' then
      raise exception 'retry exhaustion claim % did not win: %',i,claimed;
    end if;
    run_id:=(claimed#>>'{operation,runId}')::uuid;
    fence:=(claimed->>'leaseFence')::bigint;
    settled:=public.settle_room_pin_sheet_full_resync(
      run_id,claim_id,fence,'retryable','PROVIDER_UNAVAILABLE'
    );
    if i<8 then
      if settled->>'status'<>'failed' then
        raise exception 'retry % did not enter failed backoff: %',i,settled;
      end if;
      perform public.record_room_pin_sheet_sync_heartbeat(
        claim_id,fence,'degraded',1,0,0,0,1,0,'PROVIDER_UNAVAILABLE'
      );
      update private.room_pin_sheet_full_resync_runs
      set next_attempt_at=clock_timestamp()-interval '1 second'
      where id=run_id;
    elsif settled->>'status'<>'operator_blocked' then
      raise exception 'eighth retry did not operator-block: %',settled;
    end if;
  end loop;
  insert into pg_temp.exhausted_recovery_evidence values(run_id,fence);
end $$;
select is((select retry_count from private.room_pin_sheet_full_resync_runs run
  join exhausted_recovery_evidence evidence on evidence.old_run_id=run.id),8,
  'full resync stops after exactly eight retryable failures');
select is((select run.lease_fence from private.room_pin_sheet_full_resync_runs run
  join exhausted_recovery_evidence evidence on evidence.old_run_id=run.id),
  (select blocked_fence from exhausted_recovery_evidence),
  'retry exhaustion preserves the reconciliation fence on the blocked run');
select is((select lease_fence from private.room_pin_sheet_sync_worker_state where singleton),
  (select blocked_fence from exhausted_recovery_evidence),
  'worker state and retry-exhausted run retain the same fence evidence');

select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'retry-recovery-0001',repeat('8',64))$sql$,
  pg_temp.fid(3),pg_temp.fid(203),(select blocked_fence from exhausted_recovery_evidence)),
  'operator may request one fenced recovery snapshot');
create temp table retry_recovery_run as
select id run_id from private.room_pin_sheet_full_resync_runs
where actor_profile_id=pg_temp.fid(3) and idempotency_key='retry-recovery-0001';
select is((select reconciles_blocked_fence from private.room_pin_sheet_full_resync_runs run
  join retry_recovery_run recovery on recovery.run_id=run.id),
  (select blocked_fence from exhausted_recovery_evidence),
  'recovery command binds the exact retained blocked fence');

insert into private.room_pin_sheet_full_resync_runs(
  id,actor_profile_id,actor_role_snapshot,expected_fence,recovery_root_run_id,aad_environment,aad_project_ref,
  target_identity_digest,snapshot_room_count,status,lease_fence,retry_count,last_error_code,
  idempotency_key,request_hash,requested_at,completed_at
) select pg_temp.fid(499),pg_temp.fid(3),'admin',blocked_fence,pg_temp.fid(499),'local','local',repeat('a',64),
  121,'operator_blocked',blocked_fence,8,'RETRY_EXHAUSTED','newer-blocked-0001',repeat('9',64),
  clock_timestamp()+interval '1 second',clock_timestamp()+interval '1 second'
from exhausted_recovery_evidence;

create temp table retry_recovery_claim(value jsonb);
insert into retry_recovery_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(440),'local','local',repeat('a',64)
));
select is((select value->>'status' from retry_recovery_claim),'claimed',
  'fenced recovery claims once after retry exhaustion');
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from retry_recovery_run),pg_temp.fid(440),
  ((select value->>'leaseFence' from retry_recovery_claim))::bigint
)->>'status','authorized','recovery receives one provider permit');
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from retry_recovery_run),pg_temp.fid(440),
  ((select value->>'leaseFence' from retry_recovery_claim))::bigint,'succeeded',null
)->>'status','succeeded','recovery success settles once');
select is((select status from private.room_pin_sheet_full_resync_runs run
  join exhausted_recovery_evidence evidence on evidence.old_run_id=run.id),'superseded',
  'recovery supersedes the exact prior retry-exhausted run');
select is((select run.lease_fence from private.room_pin_sheet_full_resync_runs run
  join exhausted_recovery_evidence evidence on evidence.old_run_id=run.id),
  (select blocked_fence from exhausted_recovery_evidence),
  'superseded retry-exhausted history retains its fence evidence');
select is((select status from private.room_pin_sheet_full_resync_runs where id=pg_temp.fid(499)),
  'operator_blocked','newer blocked run with the same fence remains unchanged');
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from retry_recovery_run),pg_temp.fid(440),
  ((select value->>'leaseFence' from retry_recovery_claim))::bigint,'succeeded',null
)->>'status','succeeded','replayed success settle is idempotent');
select is((select count(*)::integer from private.room_pin_sheet_full_resync_runs
  where status='superseded' and id=(select old_run_id from exhausted_recovery_evidence)),1,
  'settle replay does not duplicate or widen reconciliation');
select is((select status from private.room_pin_sheet_full_resync_runs where id=pg_temp.fid(499)),
  'operator_blocked','settle replay still leaves the newer blocked run unchanged');

update private.room_pin_sheet_full_resync_runs set status='superseded',completed_at=clock_timestamp()
where id=pg_temp.fid(499);
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.fid(440),((select value->>'leaseFence' from retry_recovery_claim))::bigint),
  'successful recovery heartbeat releases the singleton');

create temp table safe_status(value jsonb);
insert into safe_status values(public.get_room_pin_sheet_sync_status(pg_temp.fid(1),pg_temp.fid(201)));
select is((select string_agg(key,',' order by key) from safe_status,jsonb_object_keys(value) key),
  'checkedAt,failed,lastErrorCode,lastSuccessAt,oldestPendingAt,operatorBlocked,pending,version',
  'operator status exposes only the reviewed safe fields and CAS version');
select ok(not (select value::text from safe_status) ~* '(pin|cipher|envelope|credential|token|spreadsheet|tab|google)',
  'operator projection exposes no PIN, envelope, credential, target, token, or raw response');
select is(((select value->>'failed' from safe_status))::integer,0,
  'successful retry-exhaustion recovery clears the failed projection');
select is(((select value->>'operatorBlocked' from safe_status))::boolean,false,
  'successful retry-exhaustion recovery clears operator-blocked state');
select ok((select value->'lastErrorCode' from safe_status)='null'::jsonb,
  'successful recovery heartbeat clears the current last error projection');

-- Request-time stale-lease reconciliation must turn the provider-marked full
-- run into durable uncertain history on the exact singleton fence. The newly
-- requested recovery binds that fence and is the only run it may supersede.
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'request-stale-source-0001',repeat('1',64))$sql$,
  pg_temp.fid(1),pg_temp.fid(201),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton)),
  'request-time stale fixture command is accepted');
create temp table request_stale_source_run as
select id run_id from private.room_pin_sheet_full_resync_runs
where actor_profile_id=pg_temp.fid(1) and idempotency_key='request-stale-source-0001';
create temp table request_stale_source_claim(value jsonb);
insert into request_stale_source_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(451),'local','local',repeat('a',64)
));
select is((select value->>'status' from request_stale_source_claim),'claimed',
  'request-time stale fixture claims once');
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from request_stale_source_run),pg_temp.fid(451),
  ((select value->>'leaseFence' from request_stale_source_claim))::bigint
)->>'status','authorized','request-time stale fixture records the provider marker');
update private.room_pin_sheet_full_resync_runs set
  claimed_at=clock_timestamp()-interval '2 minutes',
  claim_expires_at=clock_timestamp()-interval '1 minute'
where id=(select run_id from request_stale_source_run);
update private.room_pin_sheet_sync_worker_state set
  lease_expires_at=clock_timestamp()-interval '1 minute'
where singleton=true;
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'request-stale-recovery-0001',repeat('2',64))$sql$,
  pg_temp.fid(1),pg_temp.fid(201),((select value->>'leaseFence' from request_stale_source_claim))::bigint),
  'request path atomically reconciles an expired provider-marked full run');
create temp table request_stale_recovery_run as
select id run_id from private.room_pin_sheet_full_resync_runs
where actor_profile_id=pg_temp.fid(1) and idempotency_key='request-stale-recovery-0001';
select is((select status from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from request_stale_source_run)),'operator_blocked',
  'request path makes the expired provider-marked run operator-blocked');
select is((select last_error_code from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from request_stale_source_run)),'WRITE_OUTCOME_UNCERTAIN',
  'request path records the uncertain provider outcome');
select ok((select completed_at is not null and provider_write_started_at is not null
  from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from request_stale_source_run)),
  'request path preserves provider and completion evidence');
select is((select lease_fence from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from request_stale_source_run)),
  ((select value->>'leaseFence' from request_stale_source_claim))::bigint,
  'request path preserves the exact stale provider fence');
select is((select reconciles_blocked_fence from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from request_stale_recovery_run)),
  ((select value->>'leaseFence' from request_stale_source_claim))::bigint,
  'request-time recovery captures the exact uncertain fence');
create temp table request_stale_recovery_claim(value jsonb);
insert into request_stale_recovery_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(452),'local','local',repeat('a',64)
));
select is((select value->>'status' from request_stale_recovery_claim),'claimed',
  'request-time uncertain recovery claims once');
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from request_stale_recovery_run),pg_temp.fid(452),
  ((select value->>'leaseFence' from request_stale_recovery_claim))::bigint
)->>'status','authorized','request-time uncertain recovery receives one permit');
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from request_stale_recovery_run),pg_temp.fid(452),
  ((select value->>'leaseFence' from request_stale_recovery_claim))::bigint,'succeeded',null
)->>'status','succeeded','request-time uncertain recovery settles');
select is((select status from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from request_stale_source_run)),'superseded',
  'request-time recovery supersedes its exact uncertain run');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.fid(452),((select value->>'leaseFence' from request_stale_recovery_claim))::bigint),
  'request-time recovery heartbeat releases the singleton');

-- The worker claim path applies the identical stale-provider transition before
-- it can consider another provider write.
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'claim-stale-source-0001',repeat('3',64))$sql$,
  pg_temp.fid(1),pg_temp.fid(201),(select lease_fence from private.room_pin_sheet_sync_worker_state where singleton)),
  'claim-time stale fixture command is accepted');
create temp table claim_stale_source_run as
select id run_id from private.room_pin_sheet_full_resync_runs
where actor_profile_id=pg_temp.fid(1) and idempotency_key='claim-stale-source-0001';
create temp table claim_stale_source_claim(value jsonb);
insert into claim_stale_source_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(453),'local','local',repeat('a',64)
));
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from claim_stale_source_run),pg_temp.fid(453),
  ((select value->>'leaseFence' from claim_stale_source_claim))::bigint
)->>'status','authorized','claim-time stale fixture records the provider marker');
update private.room_pin_sheet_full_resync_runs set
  claimed_at=clock_timestamp()-interval '2 minutes',
  claim_expires_at=clock_timestamp()-interval '1 minute'
where id=(select run_id from claim_stale_source_run);
update private.room_pin_sheet_sync_worker_state set
  lease_expires_at=clock_timestamp()-interval '1 minute'
where singleton=true;
select is(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(454),'local','local',repeat('a',64)
)->>'status','operator_blocked','claim path blocks before another provider write');
select is((select status from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from claim_stale_source_run)),'operator_blocked',
  'claim path makes the expired provider-marked run operator-blocked');
select is((select last_error_code from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from claim_stale_source_run)),'WRITE_OUTCOME_UNCERTAIN',
  'claim path records the uncertain provider outcome');
select ok((select completed_at is not null and provider_write_started_at is not null
  from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from claim_stale_source_run)),
  'claim path preserves provider and completion evidence');
select is((select lease_fence from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from claim_stale_source_run)),
  ((select value->>'leaseFence' from claim_stale_source_claim))::bigint,
  'claim path preserves the exact stale provider fence');
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'claim-stale-recovery-0001',repeat('4',64))$sql$,
  pg_temp.fid(1),pg_temp.fid(201),((select value->>'leaseFence' from claim_stale_source_claim))::bigint),
  'claim-time uncertain run accepts an exact-fence recovery');
create temp table claim_stale_recovery_run as
select id run_id from private.room_pin_sheet_full_resync_runs
where actor_profile_id=pg_temp.fid(1) and idempotency_key='claim-stale-recovery-0001';
create temp table claim_stale_recovery_claim(value jsonb);
insert into claim_stale_recovery_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(455),'local','local',repeat('a',64)
));
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from claim_stale_recovery_run),pg_temp.fid(455),
  ((select value->>'leaseFence' from claim_stale_recovery_claim))::bigint
)->>'status','authorized','claim-time uncertain recovery receives one permit');
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from claim_stale_recovery_run),pg_temp.fid(455),
  ((select value->>'leaseFence' from claim_stale_recovery_claim))::bigint,'succeeded',null
)->>'status','succeeded','claim-time uncertain recovery settles');
select is((select status from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from claim_stale_source_run)),'superseded',
  'claim-time recovery supersedes its exact uncertain run');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.fid(455),((select value->>'leaseFence' from claim_stale_recovery_claim))::bigint),
  'claim-time recovery heartbeat releases the singleton');
create temp table stale_recovery_status(value jsonb);
insert into stale_recovery_status values(public.get_room_pin_sheet_sync_status(pg_temp.fid(1),pg_temp.fid(201)));
select is(((select value->>'pending' from stale_recovery_status))::integer,0,
  'stale-provider recovery clears pending work');
select is(((select value->>'failed' from stale_recovery_status))::integer,0,
  'stale-provider recovery clears failed work');
select is(((select value->>'operatorBlocked' from stale_recovery_status))::boolean,false,
  'stale-provider recovery clears operator-blocked state');
select ok((select value->'lastErrorCode' from stale_recovery_status)='null'::jsonb,
  'stale-provider recovery clears the current last error');

create temp table changed_target_request(value jsonb);
insert into changed_target_request values(public.request_room_pin_sheet_full_resync(
  pg_temp.fid(1),pg_temp.fid(201),((select value->>'version' from stale_recovery_status))::bigint,
  'local','local',repeat('e',64),'full-resync-request-0002',repeat('f',64)
));
create temp table changed_target_claim(value jsonb);
insert into changed_target_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(404),'local','local',repeat('a',64)
));
select is((select value->>'status' from changed_target_claim),
  'operator_blocked','a pending command cannot silently move to a changed spreadsheet/tab identity');
select is((select blocked_reason_code from private.room_pin_sheet_sync_worker_state where singleton),
  'PROVIDER_CONFIGURATION_ERROR','target identity drift is durable operator-blocked');
select is(((select value->>'leaseFence' from changed_target_claim))::bigint,
  ((select value->>'version' from stale_recovery_status))::bigint+1,
  'target mismatch atomically advances the singleton fence');
select is((select lease_fence from private.room_pin_sheet_full_resync_runs
  where actor_profile_id=pg_temp.fid(1) and idempotency_key='full-resync-request-0002'),
  ((select value->>'leaseFence' from changed_target_claim))::bigint,
  'target-mismatched run receives the same dedicated reconciliation fence');
select lives_ok(format($sql$select public.request_room_pin_sheet_full_resync(%L,%L,%s,'local','local',repeat('a',64),'target-mismatch-recovery-0001',repeat('5',64))$sql$,
  pg_temp.fid(1),pg_temp.fid(201),((select value->>'leaseFence' from changed_target_claim))::bigint),
  'target-mismatch recovery captures its dedicated fence');
create temp table changed_target_recovery_run as
select id run_id from private.room_pin_sheet_full_resync_runs
where actor_profile_id=pg_temp.fid(1) and idempotency_key='target-mismatch-recovery-0001';
select is((select reconciles_blocked_fence from private.room_pin_sheet_full_resync_runs
  where id=(select run_id from changed_target_recovery_run)),
  ((select value->>'leaseFence' from changed_target_claim))::bigint,
  'target-mismatch recovery binds the exact advanced fence');
create temp table changed_target_recovery_claim(value jsonb);
insert into changed_target_recovery_claim values(public.claim_room_pin_sheet_full_resync(
  pg_temp.fid(456),'local','local',repeat('a',64)
));
select is(public.authorize_room_pin_sheet_full_resync_write(
  (select run_id from changed_target_recovery_run),pg_temp.fid(456),
  ((select value->>'leaseFence' from changed_target_recovery_claim))::bigint
)->>'status','authorized','target-mismatch recovery receives one permit');
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from changed_target_recovery_run),pg_temp.fid(456),
  ((select value->>'leaseFence' from changed_target_recovery_claim))::bigint,'succeeded',null
)->>'status','succeeded','target-mismatch recovery settles');
select is((select status from private.room_pin_sheet_full_resync_runs
  where actor_profile_id=pg_temp.fid(1) and idempotency_key='full-resync-request-0002'),
  'superseded','target-mismatch recovery supersedes its exact blocked run');
select is(public.settle_room_pin_sheet_full_resync(
  (select run_id from changed_target_recovery_run),pg_temp.fid(456),
  ((select value->>'leaseFence' from changed_target_recovery_claim))::bigint,'succeeded',null
)->>'status','succeeded','target-mismatch recovery settle replay is idempotent');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.fid(456),((select value->>'leaseFence' from changed_target_recovery_claim))::bigint),
  'target-mismatch recovery heartbeat releases the singleton');
create temp table target_recovery_status(value jsonb);
insert into target_recovery_status values(public.get_room_pin_sheet_sync_status(pg_temp.fid(1),pg_temp.fid(201)));
select is(((select value->>'pending' from target_recovery_status))::integer,0,
  'target-mismatch recovery clears pending work');
select is(((select value->>'failed' from target_recovery_status))::integer,0,
  'target-mismatch recovery clears failed work');
select is(((select value->>'operatorBlocked' from target_recovery_status))::boolean,false,
  'target-mismatch recovery clears operator-blocked state');
select ok((select value->'lastErrorCode' from target_recovery_status)='null'::jsonb,
  'target-mismatch recovery clears the current last error');

select * from finish();
rollback;
