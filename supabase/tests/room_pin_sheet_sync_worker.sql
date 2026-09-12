begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('f1360000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create temp table sheet_sync_test_rooms as
select row_number() over(order by r.room_number,r.id)::integer slot,r.id
from public.rooms r
where not exists (
  select 1 from private.room_pin_revisions revision where revision.room_id=r.id
)
order by r.room_number,r.id
limit 7;
do $$ begin
  if (select count(*) from pg_temp.sheet_sync_test_rooms)<>7 then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_TEST_ROOMS_UNAVAILABLE';
  end if;
end $$;
create function pg_temp.room_id(n integer) returns uuid language sql stable as $$
  select id from pg_temp.sheet_sync_test_rooms where slot=n
$$;
create function pg_temp.sheet_row(p_room_id uuid) returns bigint language sql stable as $$
  select sheet_row from (
    select id,(row_number() over(order by room_number,id)+1)::bigint sheet_row
    from public.rooms
  ) ranked where id=p_room_id
$$;
create function pg_temp.install_pin(p_room uuid,p_actor uuid,p_version bigint,p_environment text default 'test',p_project text default 'local')
returns void language plpgsql as $$
declare revision_id uuid:=gen_random_uuid();
begin
  insert into private.room_pin_revisions(id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,
    key_version,aad_environment,aad_project_ref,recorded_by,recorded_by_role,source)
  values(revision_id,p_room,p_version,1,digest(p_room::text||p_version::text||'cipher','sha256'),
    substring(digest(p_room::text||p_version::text||'nonce','sha256') for 12),
    substring(digest(p_room::text||p_version::text||'tag','sha256') for 16),
    'test-fixture',p_environment,p_project,p_actor,'admin','admin_initial_entry');
  insert into private.room_current_pin(room_id,pin_revision_id,pin_version)
  values(p_room,revision_id,p_version)
  on conflict(room_id) do update set pin_revision_id=excluded.pin_revision_id,
    pin_version=excluded.pin_version,updated_at=clock_timestamp();
  insert into private.room_pin_sheet_sync_outbox(room_id,pin_version,sync_status,reason_code)
  values(p_room,p_version,'verified','PIN_CHANGE_CONFIRMED');
end $$;

insert into auth.users(id) values(pg_temp.pid(101));
create temp table sheet_sync_test_actor(profile_id uuid not null);
do $$
declare existing_developer uuid;
begin
  select id into existing_developer from public.profiles
  where role='developer' and status='active' and must_change_password=false
  order by created_at,id limit 1;
  if existing_developer is null then
    insert into auth.users(id) values(pg_temp.pid(104));
    perform public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),
      'sheet developer','sheet developer','0040','sheet-bootstrap-hash','sheet-bootstrap-key');
    existing_developer:=pg_temp.pid(4);
  end if;
  insert into pg_temp.sheet_sync_test_actor(profile_id) values(existing_developer);
end $$;
create function pg_temp.developer_id() returns uuid language sql stable as $$
  select profile_id from pg_temp.sheet_sync_test_actor
$$;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values(pg_temp.pid(1),pg_temp.pid(101),'sheet worker admin','sheet worker admin',
  'sheet-worker-admin','sheet-worker-admin',0,'admin','active',false);

-- Standalone runs may follow the committed concurrency fixture. Isolate this
-- transaction without persisting any cleanup of the existing worker ledger.
update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=clock_timestamp(),
  claim_id=null,claimed_at=null,claim_expires_at=null,lease_fence=null,
  provider_write_started_at=null,last_error_code=null
where status in ('pending','processing','failed');
update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,
  lease_expires_at=null,blocked_reason_code=null,updated_at=clock_timestamp()
where singleton=true;

select ok((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='private.room_pin_sheet_sync_worker_state'::regclass),'worker state uses forced RLS');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
  where oid='private.room_pin_sheet_sync_heartbeat'::regclass),'heartbeat uses forced RLS');
select ok(not has_table_privilege('service_role','private.room_pin_sheet_sync_worker_state','SELECT'),
  'service role cannot read raw singleton state');
select ok(not has_table_privilege('authenticated','private.room_pin_sheet_sync_outbox','SELECT'),
  'authenticated cannot read encrypted PIN sync work');
select ok(has_function_privilege('service_role','public.claim_room_pin_sheet_sync(uuid,integer,text,text)','EXECUTE'),
  'service role can use bounded claim RPC');
select ok(not has_function_privilege('authenticated','public.claim_room_pin_sheet_sync(uuid,integer,text,text)','EXECUTE'),
  'authenticated cannot claim PIN projection work');
select ok(not has_function_privilege('anon','public.resume_room_pin_sheet_sync_after_reconciliation(bigint,text)','EXECUTE'),
  'anon cannot resume operator-blocked projection');
select ok(has_function_privilege('service_role','public.get_developer_room_pin_sheet_sync_status(uuid)','EXECUTE'),
  'service role can read app-owned safe worker status');
select ok(not has_function_privilege('authenticated','public.get_developer_room_pin_sheet_sync_status(uuid)','EXECUTE'),
  'authenticated cannot call worker status through Data API');
select throws_ok($$select public.claim_room_pin_sheet_sync(pg_temp.pid(299),10,null,'local')$$,
  '22023','ROOM_PIN_SHEET_CLAIM_INVALID','NULL environment never returns encrypted context');
select throws_ok($$select public.claim_room_pin_sheet_sync(pg_temp.pid(299),10,'test',null)$$,
  '22023','ROOM_PIN_SHEET_CLAIM_INVALID','NULL project ref never returns encrypted context');
select throws_ok($$select public.renew_room_pin_sheet_sync_run(null,null)$$,
  '22023','ROOM_PIN_SHEET_RENEW_INVALID','renew rejects NULL identity and fence');
select throws_ok($$select public.authorize_room_pin_sheet_write(null,null,null,null)$$,
  '22023','ROOM_PIN_SHEET_AUTHORIZE_INVALID','authorize rejects NULL required parameters');
select throws_ok(format($sql$select public.authorize_room_pin_sheet_write(%L,%L,1,1)$sql$,
  pg_temp.pid(298),pg_temp.pid(299)),'P0002','ROOM_PIN_SHEET_OUTBOX_NOT_FOUND',
  'authorize rejects a non-existent outbox before nullable row checks');
select throws_ok($$select public.settle_room_pin_sheet_sync(null,null,null,null,null,null)$$,
  '22023','ROOM_PIN_SHEET_SETTLE_INVALID','settle rejects NULL required parameters');
select throws_ok(format($sql$select public.settle_room_pin_sheet_sync(%L,%L,1,1,'succeeded','RATE_LIMITED')$sql$,
  pg_temp.pid(298),pg_temp.pid(299)),'22023','ROOM_PIN_SHEET_SETTLE_INVALID',
  'successful outcome rejects a contradictory reason before row access');
select throws_ok(format($sql$select public.settle_room_pin_sheet_sync(%L,%L,1,1,'retryable','RAW_PROVIDER_ERROR')$sql$,
  pg_temp.pid(298),pg_temp.pid(299)),'22023','ROOM_PIN_SHEET_SETTLE_INVALID',
  'retry outcome accepts only source-controlled reason codes');
select throws_ok(format($sql$select public.settle_room_pin_sheet_sync(%L,%L,1,1,'succeeded',null)$sql$,
  pg_temp.pid(298),pg_temp.pid(299)),'P0002','ROOM_PIN_SHEET_OUTBOX_NOT_FOUND',
  'settle rejects a non-existent outbox before replay or lease checks');
select throws_ok($$select public.record_room_pin_sheet_sync_heartbeat(null,null,null,null,null,null,null,null,null,null)$$,
  '22023','ROOM_PIN_SHEET_HEARTBEAT_INVALID','heartbeat rejects NULL identity, status, fence and counts');
select throws_ok($$select public.record_room_pin_sheet_sync_heartbeat(pg_temp.pid(299),1,'succeeded',0,1,0,0,0,0,null)$$,
  '22023','ROOM_PIN_SHEET_HEARTBEAT_INVALID','heartbeat outcome counters cannot exceed the claimed workload');
select throws_ok($$select public.resume_room_pin_sheet_sync_after_reconciliation(null,null)$$,
  '22023','ROOM_PIN_SHEET_RECONCILIATION_INVALID','resume rejects NULL fence and reconciliation code');

select pg_temp.install_pin(pg_temp.room_id(1),pg_temp.pid(1),1);
create temp table first_claim(value jsonb);
insert into first_claim values(public.claim_room_pin_sheet_sync(pg_temp.pid(201),10,'test','local'));
select is((select value->>'status' from first_claim),'claimed','first worker acquires global singleton');
select is(jsonb_array_length((select value->'items' from first_claim)),1,'first claim returns one current room');
select is((select value#>>'{items,0,pinVersion}' from first_claim),'1','claim reads current PIN version');
select is(((select value#>>'{items,0,sheetRow}' from first_claim))::bigint,
  pg_temp.sheet_row(pg_temp.room_id(1)),
  'room-number ordering deterministically maps the claimed room to its actual row');
select ok(not ((select value->'items'->0 from first_claim) ?| array['pin','credential','pinDigits','accessToken']),
  'claim exposes only encrypted context and safe identity');
select is(public.claim_room_pin_sheet_sync(pg_temp.pid(202),10,'test','local')->>'status','busy',
  'concurrent worker cannot bypass the global singleton lease');

-- Resolve the generated outbox identity from the claim, then authorize and settle it.
create temp table first_ids as select
  ((value#>>'{items,0,outboxId}'))::uuid outbox_id,
  ((value->>'leaseFence'))::bigint fence from first_claim;
select is(public.authorize_room_pin_sheet_write((select outbox_id from first_ids),pg_temp.pid(201),
  (select fence from first_ids),1)->>'status','authorized','write permit rechecks current version and fence');
select is(public.settle_room_pin_sheet_sync((select outbox_id from first_ids),pg_temp.pid(201),
  (select fence from first_ids),1,'succeeded',null)->>'status','succeeded','successful provider projection settles once');
select is(public.settle_room_pin_sheet_sync((select outbox_id from first_ids),pg_temp.pid(201),
  (select fence from first_ids),1,'succeeded',null)->>'status','succeeded','successful settle replay is idempotent');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.pid(201),(select fence from first_ids)),'heartbeat releases a successful singleton run');

-- A physical rollback keeps the same PIN version but is a later logical
-- projection event. The Sheet context must carry the rollback reason/time,
-- not the original revision creation time.
insert into private.room_pin_sheet_sync_outbox(
  id,room_id,pin_version,sync_status,reason_code,status,completed_at,created_at
) values(
  pg_temp.pid(220),pg_temp.room_id(1),1,'verified','PHYSICAL_ROLLBACK_CONFIRMED',
  'succeeded','2030-01-02 03:04:05+00','2030-01-02 03:04:05+00'
);
select is(private.room_pin_sheet_sync_context(pg_temp.pid(220))->>'reasonCode',
  'PHYSICAL_ROLLBACK_CONFIRMED','same-version rollback projects its later logical reason');
select is((private.room_pin_sheet_sync_context(pg_temp.pid(220))->>'pinVersion')::bigint,1::bigint,
  'same-version rollback retains the existing current PIN version');
select is((private.room_pin_sheet_sync_context(pg_temp.pid(220))->>'effectiveAt')::timestamptz,
  '2030-01-02 03:04:05+00'::timestamptz,'same-version rollback projects outbox event time');

-- Outbox v1 may arrive before current v2. Claim never returns v1 plaintext/context.
select pg_temp.install_pin(pg_temp.room_id(2),pg_temp.pid(1),1);
select pg_temp.install_pin(pg_temp.room_id(2),pg_temp.pid(1),2);
create temp table latest_claim(value jsonb);
insert into latest_claim values(public.claim_room_pin_sheet_sync(pg_temp.pid(203),10,'test','local'));
select is((select value#>>'{items,0,pinVersion}' from latest_claim),'2','claim coalesces to exact current version');
select is((select status from private.room_pin_sheet_sync_outbox
  where room_id=pg_temp.room_id(2) and pin_version=1),'superseded','stale outbox is terminal without provider write');
select lives_ok(format($sql$select public.settle_room_pin_sheet_sync(%L,%L,%s,2,'superseded',null)$sql$,
  ((select value#>>'{items,0,outboxId}' from latest_claim))::uuid,pg_temp.pid(203),
  ((select value->>'leaseFence' from latest_claim))::bigint),'coalesced current item can finish without provider write');

-- A mismatched production/recovery binding blocks before encrypted context leaves DB.
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'degraded',1,0,0,1,0,0,null)$sql$,
  pg_temp.pid(203),((select value->>'leaseFence' from latest_claim))::bigint),'finish coalescing run');
select pg_temp.install_pin(pg_temp.room_id(3),pg_temp.pid(1),1,'recovery','other');
select is(public.claim_room_pin_sheet_sync(pg_temp.pid(204),10,'production','prod')->>'status','operator_blocked',
  'environment/project mismatch fail-closes before worker receives envelope');
select is((select blocked_reason_code from private.room_pin_sheet_sync_worker_state where singleton),
  'PROVIDER_CONFIGURATION_ERROR','configuration mismatch is durable operator-blocked');
select lives_ok($$select public.resume_room_pin_sheet_sync_after_reconciliation(
  (select lease_fence from private.room_pin_sheet_sync_worker_state where singleton),'SHEET_READBACK_CONFIRMED')$$,
  'service-only reconciliation can explicitly resume a blocked worker');

-- The operator repaired the mismatched source by creating a new current revision
-- in this environment. Drain that room before the independent uncertainty test.
select pg_temp.install_pin(pg_temp.room_id(3),pg_temp.pid(1),2);
create temp table repaired_claim(value jsonb);
insert into repaired_claim values(public.claim_room_pin_sheet_sync(pg_temp.pid(209),10,'test','local'));
select lives_ok(format($sql$select public.settle_room_pin_sheet_sync(%L,%L,%s,2,'already_current',null)$sql$,
  ((select value#>>'{items,0,outboxId}' from repaired_claim))::uuid,pg_temp.pid(209),
  ((select value->>'leaseFence' from repaired_claim))::bigint),'repaired current revision is safely reconciled');
select lives_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,0,1,0,0,0,null)$sql$,
  pg_temp.pid(209),((select value->>'leaseFence' from repaired_claim))::bigint),'repaired run releases singleton');

-- A provider-started lease that expires has an unknowable outcome and never auto-retries.
select pg_temp.install_pin(pg_temp.room_id(4),pg_temp.pid(1),1);
create temp table uncertain_claim(value jsonb);
insert into uncertain_claim values(public.claim_room_pin_sheet_sync(pg_temp.pid(205),10,'test','local'));
create temp table uncertain_ids as select
  ((value#>>'{items,0,outboxId}'))::uuid outbox_id,
  ((value->>'leaseFence'))::bigint fence from uncertain_claim;
select lives_ok($$select public.authorize_room_pin_sheet_write((select outbox_id from uncertain_ids),
  pg_temp.pid(205),(select fence from uncertain_ids),1)$$,'provider write gets a final fenced permit');
update private.room_pin_sheet_sync_worker_state set lease_expires_at=clock_timestamp()-interval '1 second'
where singleton=true;
update private.room_pin_sheet_sync_outbox set claimed_at=clock_timestamp()-interval '3 minutes',
  claim_expires_at=clock_timestamp()-interval '1 second'
where id=(select outbox_id from uncertain_ids);
select is(public.claim_room_pin_sheet_sync(pg_temp.pid(206),10,'test','local')->>'status','operator_blocked',
  'expired provider-started write becomes uncertain instead of being reclaimed');
select is((select blocked_reason_code from private.room_pin_sheet_sync_worker_state where singleton),
  'WRITE_OUTCOME_UNCERTAIN','uncertain result is a durable global barrier');
select throws_ok(format($sql$select public.record_room_pin_sheet_sync_heartbeat(%L,%s,'succeeded',1,1,0,0,0,0,null)$sql$,
  pg_temp.pid(205),(select fence from uncertain_ids)),'55000','ROOM_PIN_SHEET_FALSE_GREEN_HEARTBEAT',
  'operator-blocked state cannot be hidden by a successful heartbeat');

-- Retry exhaustion also becomes a visible global operator barrier.
select lives_ok($$select public.resume_room_pin_sheet_sync_after_reconciliation(
  (select lease_fence from private.room_pin_sheet_sync_worker_state where singleton),'SHEET_READBACK_CONFIRMED')$$,
  'reconcile uncertain fixture before retry-exhaustion fixture');
update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=clock_timestamp(),
  provider_write_started_at=null,last_error_code=null
where room_id=pg_temp.room_id(4);
select pg_temp.install_pin(pg_temp.room_id(5),pg_temp.pid(1),1);
update private.room_pin_sheet_sync_outbox set retry_count=7
where room_id=pg_temp.room_id(5);
create temp table exhausted_claim(value jsonb);
insert into exhausted_claim values(public.claim_room_pin_sheet_sync(pg_temp.pid(207),10,'test','local'));
create temp table exhausted_ids as select
  ((value#>>'{items,0,outboxId}'))::uuid outbox_id,
  ((value->>'leaseFence'))::bigint fence from exhausted_claim;
select is(public.settle_room_pin_sheet_sync((select outbox_id from exhausted_ids),pg_temp.pid(207),
  (select fence from exhausted_ids),1,'retryable','PROVIDER_UNAVAILABLE')->>'status','operator_blocked',
  'eighth retry is terminal and explicitly reports the global operator barrier');
select is((select blocked_reason_code from private.room_pin_sheet_sync_worker_state where singleton),
  'RETRY_EXHAUSTED','retry exhaustion prevents a false-green next run');
select is(public.get_developer_room_pin_sheet_sync_status(pg_temp.developer_id())->>'status','operator_blocked',
  'safe developer status cannot false-green retry-exhausted work');
select is(public.get_developer_room_pin_sheet_sync_status(pg_temp.developer_id())#>>'{backlog,blocked}','1',
  'safe developer status returns only a bounded blocked count');
select ok(not public.get_developer_room_pin_sheet_sync_status(pg_temp.developer_id())::text like '%cipher%',
  'safe developer status exposes no encrypted context or Sheet payload');

-- Retryable backlog and operator-blocking failures remain semantically disjoint.
select pg_temp.install_pin(pg_temp.room_id(6),pg_temp.pid(1),1);
select pg_temp.install_pin(pg_temp.room_id(7),pg_temp.pid(1),1);
update private.room_pin_sheet_sync_outbox set status='failed',last_error_code='RATE_LIMITED'
where room_id=pg_temp.room_id(6) and pin_version=1;
update private.room_pin_sheet_sync_outbox set status='failed',last_error_code='AUTHORIZATION_FAILED'
where room_id=pg_temp.room_id(7) and pin_version=1;
select is(public.get_developer_room_pin_sheet_sync_status(pg_temp.developer_id())#>>'{backlog,retrying}','1',
  'safe developer status counts only retryable or explicitly reconciled work as retrying');
select is(public.get_developer_room_pin_sheet_sync_status(pg_temp.developer_id())#>>'{backlog,blocked}','2',
  'safe developer status counts authorization failure and retry exhaustion as blocked');
select isnt(public.get_developer_room_pin_sheet_sync_status(pg_temp.developer_id())->>'status','healthy',
  'operator-blocking backlog cannot be hidden by a prior successful heartbeat');

-- Every current test-board identity has a deterministic, duplicate-free row.
-- The provider unit fixture independently enforces the production 121-row cap.
select is((select count(*) from (
  select (row_number() over(order by room_number,id)+1)::integer sheet_row from public.rooms
) r),(select count(*) from public.rooms),'full board maps every current room identity');
select is((select count(distinct sheet_row) from (
  select (row_number() over(order by room_number,id)+1)::integer sheet_row from public.rooms
) r),(select count(*) from public.rooms),'full board row mapping has no duplicates');
select is((select max(sheet_row)::bigint from (
  select (row_number() over(order by room_number,id)+1)::integer sheet_row from public.rooms
) r),(select count(*)+1 from public.rooms),'full board row extent matches its identity count');

select * from finish();
rollback;
