-- #396 PREPARED ONLY: synthetic rollback-only SQL. No real provider or DB execution.
begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('f1340000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
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
create function pg_temp.install_pin(p_room uuid,p_actor uuid,p_version bigint,p_environment text default 'synthetic',p_project text default 'aaaaaaaaaaaaaaaaaaaa')
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

select ok(not has_function_privilege('anon','public.claim_operation_pin_incremental(text,text,timestamptz,uuid,text,text,text)','EXECUTE'),
  'anonymous caller cannot acquire worker authority');
select ok(not has_function_privilege('authenticated','public.dispatch_operation_pin_incremental(text,uuid,text,text,jsonb)','EXECUTE'),
  'authenticated caller cannot dispatch provider settlement');
select ok(not has_function_privilege('service_role','private.assert_operation_pin_admission(text,uuid,text)','EXECUTE'),
  'private owner verifier is not callable by runtime');
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values(repeat('a',20),repeat('a',64),120,'PROVISIONING');
create temp table pin_admissions(n integer primary key,value jsonb);
create function pg_temp.claim(n integer) returns jsonb language plpgsql as $$
declare result jsonb;
begin
  result:=public.claim_operation_pin_incremental(repeat('a',20),repeat(n::text,64),clock_timestamp()+interval '1 minute',
    pg_temp.pid(200+n),'synthetic',repeat('a',20),repeat('d',64));
  insert into pg_temp.pin_admissions values(n,result); return result;
end $$;
create function pg_temp.dispatch(n integer,action text,args jsonb) returns jsonb language sql as $$
  select public.dispatch_operation_pin_incremental(repeat('a',20),(value->>'admissionId')::uuid,repeat(n::text,64),action,
    args||jsonb_build_object('p_claim_id',pg_temp.pid(200+n),'p_lease_fence',value->'claim'->'leaseFence'))
  from pg_temp.pin_admissions where pin_admissions.n=dispatch.n
$$;
create function pg_temp.item_args(n integer) returns jsonb language sql as $$
  select jsonb_build_object('p_outbox_id',value#>'{claim,items,0,outboxId}',
    'p_expected_pin_version',value#>'{claim,items,0,pinVersion}') from pg_temp.pin_admissions where pin_admissions.n=item_args.n
$$;
create function pg_temp.complete(n integer) returns jsonb language sql as $$
  select public.complete_operation_pin_incremental(repeat('a',20),(value->>'admissionId')::uuid,repeat(n::text,64))
  from pg_temp.pin_admissions where pin_admissions.n=complete.n
$$;
create function pg_temp.heartbeat(n integer,claimed integer,projected integer,superseded integer default 0) returns jsonb language sql as $$
  select pg_temp.dispatch(n,'HEARTBEAT',jsonb_build_object('p_status','succeeded','p_claimed',claimed,'p_projected',projected,
    'p_already_current',0,'p_superseded',superseded,'p_retrying',0,'p_blocked',0,'p_error_code',null))
$$;

select is(pg_temp.claim(1)#>>'{claim,status}','claimed','empty invocation really acquires the singleton');
select throws_ok($q$select pg_temp.complete(1)$q$,'42501','OPERATION_PIN_TERMINAL_UNVERIFIED','claim success is not heartbeat completion');
select lives_ok($q$select pg_temp.heartbeat(1,0,0)$q$,'empty invocation records its own heartbeat atomically');
select lives_ok($q$select pg_temp.complete(1)$q$,'empty known-terminal invocation completes');
select throws_ok($q$select public.claim_operation_pin_incremental(repeat('a',20),repeat('2',64),clock_timestamp()+interval '1 minute',
  pg_temp.pid(201),'synthetic',repeat('a',20),repeat('d',64))$q$,'23505',
  'duplicate key value violates unique constraint "operation_pin_claim_once"','another invocation cannot reuse an earlier claim identity');

select pg_temp.install_pin(pg_temp.room_id(1),pg_temp.pid(1),1);
select is(jsonb_array_length(pg_temp.claim(2)#>'{claim,items}'),1,'current PIN claim captured with immutable admission context');
select throws_ok($q$select public.dispatch_operation_pin_incremental(repeat('a',20),
  (select (value->>'admissionId')::uuid from pin_admissions where n=2),repeat('3',64),'RENEW',
  jsonb_build_object('p_claim_id',pg_temp.pid(202),'p_lease_fence',1))$q$,
  '42501','OPERATION_PIN_ADMISSION_REJECTED','another nonce cannot borrow this admission');
select throws_ok($q$select pg_temp.dispatch(2,'UNREVIEWED',jsonb_build_object())$q$,
  '22023','OPERATION_PIN_DISPATCH_INVALID','no arbitrary dispatch names');
select throws_ok($q$select pg_temp.dispatch(2,'AUTHORIZE',pg_temp.item_args(2)||jsonb_build_object('raw_secret','synthetic'))$q$,
  '22023','OPERATION_PIN_DISPATCH_INVALID','unknown JSON arguments never enter provider evidence');
select is(pg_temp.dispatch(2,'AUTHORIZE',pg_temp.item_args(2))->>'status','authorized','exact current fence authorizes one synthetic effect');
select throws_ok($q$select pg_temp.dispatch(2,'AUTHORIZE',pg_temp.item_args(2))$q$,
  '42501','OPERATION_PIN_WRITE_ALREADY_STARTED','duplicate authorization cannot repeat an ambiguous write');
select is(pg_temp.dispatch(2,'SETTLE',pg_temp.item_args(2)||jsonb_build_object('p_outcome','succeeded','p_reason_code',null))->>'status',
  'succeeded','synthetic known provider result is observed in the same settle transaction');
select throws_ok($q$select pg_temp.complete(2)$q$,'42501','OPERATION_PIN_TERMINAL_UNVERIFIED','item terminal still needs its own heartbeat');
select pg_temp.heartbeat(2,1,1);
update private.developer_operation_control set maintenance='REQUESTED',version=version+1 where singleton;
select throws_ok($q$select pg_temp.claim(3)$q$,'42501','OPERATION_ADMISSION_REJECTED','requested maintenance prevents claim and mutation');
select lives_ok($q$select pg_temp.complete(2)$q$,'already terminal invocation may drain after maintenance request');
update private.developer_operation_control set maintenance='OPEN',version=version+1 where singleton;

-- Unknown old provider result must not be promoted by a newer current PIN.
select pg_temp.install_pin(pg_temp.room_id(2),pg_temp.pid(1),1);
select pg_temp.claim(3);
select pg_temp.dispatch(3,'AUTHORIZE',pg_temp.item_args(3));
select pg_temp.install_pin(pg_temp.room_id(2),pg_temp.pid(1),2);
select is(pg_temp.dispatch(3,'SETTLE',pg_temp.item_args(3)||jsonb_build_object('p_outcome','retryable','p_reason_code','PROVIDER_UNAVAILABLE'))->>'status',
  'superseded','old implementation may supersede a newer-PIN unknown result');
select is((select worker_context#>>'{items,0,terminal}' from private.developer_operation_admissions
  where id=(select (value->>'admissionId')::uuid from pin_admissions where n=3)),'UNKNOWN','admission preserves original unknown provider observation');
select pg_temp.heartbeat(3,1,0,1);
select throws_ok($q$select pg_temp.complete(3)$q$,'42501','OPERATION_PIN_TERMINAL_UNVERIFIED','successful latest heartbeat cannot resolve unknown effect');
select pg_temp.claim(4);
select pg_temp.dispatch(4,'AUTHORIZE',pg_temp.item_args(4));
select pg_temp.dispatch(4,'SETTLE',pg_temp.item_args(4)||jsonb_build_object('p_outcome','succeeded','p_reason_code',null));
select pg_temp.heartbeat(4,1,1);
select lives_ok($q$select pg_temp.complete(4)$q$,'later exact known effect can complete its own admission');
select throws_ok($q$select pg_temp.complete(3)$q$,'42501','OPERATION_PIN_TERMINAL_UNVERIFIED','later projection cannot be borrowed by older uncertain run');

-- The old settle idempotent shortcut must not be borrowed by a stale admission.
select pg_temp.install_pin(pg_temp.room_id(3),pg_temp.pid(1),1);
select pg_temp.claim(5);
select pg_temp.dispatch(5,'AUTHORIZE',pg_temp.item_args(5));
select public.settle_room_pin_sheet_sync((select (value#>>'{claim,items,0,outboxId}')::uuid from pin_admissions where n=5),
  pg_temp.pid(205),(select (value#>>'{claim,leaseFence}')::bigint from pin_admissions where n=5),1,'succeeded',null);
select throws_ok($q$select pg_temp.dispatch(5,'SETTLE',pg_temp.item_args(5)||jsonb_build_object('p_outcome','succeeded','p_reason_code',null))$q$,
  '42501','OPERATION_PIN_FENCE_REJECTED','mutable terminal shortcut is not same-transaction receipt');
select pg_temp.heartbeat(5,1,1);
select throws_ok($q$select pg_temp.complete(5)$q$,'42501','OPERATION_PIN_TERMINAL_UNVERIFIED','unobserved legacy settlement remains unresolved');

-- A pending full-board request is held without claiming or mutating it.
insert into private.room_pin_sheet_full_resync_runs(id,actor_profile_id,actor_role_snapshot,expected_fence,recovery_root_run_id,
  aad_environment,aad_project_ref,target_identity_digest,snapshot_room_count,idempotency_key,request_hash)
select pg_temp.pid(300),pg_temp.pid(1),'admin',lease_fence,pg_temp.pid(300),'synthetic',repeat('a',20),repeat('d',64),121,
  'pin-admission-hold',repeat('f',64) from private.room_pin_sheet_sync_worker_state where singleton;
select throws_ok($q$select pg_temp.claim(6)$q$,'42501','OPERATION_PIN_FULL_RESYNC_HOLD','full-resync stays outside incremental authority');
select is((select status from private.room_pin_sheet_full_resync_runs where id=pg_temp.pid(300)),'pending','HOLD never invokes full-resync claim');
select is((select count(*)::integer from private.developer_operation_admissions where worker_context->>'claimId'=pg_temp.pid(206)::text),0,
  'claim rejection rolls back its tentative admission');
update private.developer_operation_admissions set created_at=clock_timestamp()-interval '2 minutes',deadline_at=clock_timestamp()-interval '1 minute'
where id=(select (value->>'admissionId')::uuid from pin_admissions where n=3);
select is(private.collect_developer_operation_gates()->>'expiredUnfinishedAdmissions','1','expiry still does not clear ambiguous provider effect');
select * from finish();
rollback;
