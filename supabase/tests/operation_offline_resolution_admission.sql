-- #396 PREPARED ONLY. Synthetic rollback-only terminal matching fixtures.
-- Actual migration/PLpgSQL/pgTAP execution requires the separate final DB approval.
begin;
select no_plan();
create function pg_temp.offline_admission_id(n integer) returns uuid language sql immutable as $$
  select ('f3961410-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id) values(pg_temp.offline_admission_id(1)),(pg_temp.offline_admission_id(2));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.offline_admission_id(11),pg_temp.offline_admission_id(1),'offline-admission-admin','offline-admission-admin',
  'offline-admission-admin','offline-admission-admin',0,'admin','active',false),
  (pg_temp.offline_admission_id(12),pg_temp.offline_admission_id(2),'offline-admission-maid','offline-admission-maid',
  'offline-admission-maid','offline-admission-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id,not_after) values
  (pg_temp.offline_admission_id(21),pg_temp.offline_admission_id(1),null),
  (pg_temp.offline_admission_id(22),pg_temp.offline_admission_id(2),null);
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values('synthetic-target',repeat('a',64),300,'PROVISIONING');
-- Minimal synthetic FK parents, not a copied operational event or new business execution.
create function pg_temp.offline_admission_fixture(n integer) returns void language plpgsql as $$
declare v_room uuid; v_at timestamptz:=clock_timestamp(); v_day date:=(v_at at time zone 'Asia/Seoul')::date;
begin
  select id into v_room from public.rooms order by room_number offset n limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
    available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
  values(pg_temp.offline_admission_id(100+n),v_room,'additional','manual_room_request','offline-admission-'||n,v_day,v_day,
    v_day::timestamp at time zone 'Asia/Seoul',(v_day+1)::timestamp at time zone 'Asia/Seoul',
    'notified',2,'{}',10000,'{}',pg_temp.offline_admission_id(11));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
  values(pg_temp.offline_admission_id(200+n),pg_temp.offline_admission_id(100+n),pg_temp.offline_admission_id(12),n,2,v_at,
    pg_temp.offline_admission_id(11));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
    assignment_revision,template_snapshot,room_snapshot)
  values(pg_temp.offline_admission_id(300+n),pg_temp.offline_admission_id(100+n),pg_temp.offline_admission_id(200+n),
    pg_temp.offline_admission_id(12),1,'scheduled',2,'{}',jsonb_build_object('roomId',v_room));
  insert into private.offline_work_leases(id,actor_profile_id,attempt_id,assignment_id,assignment_revision,execution_version,
    profile_version,issued_at,expires_at,metadata_expires_at)
  values(pg_temp.offline_admission_id(400+n),pg_temp.offline_admission_id(12),pg_temp.offline_admission_id(300+n),
    pg_temp.offline_admission_id(200+n),2,1,1,v_at,v_at+interval '2 hours',v_at+interval '90 days');
  insert into private.offline_completion_events(id,lease_id,actor_profile_id,event_id,request_hash,occurred_at,server_offset_ms,
    normalized_occurred_at,received_at,metadata_expires_at,outcome,reason_code,response_payload)
  values(pg_temp.offline_admission_id(500+n),pg_temp.offline_admission_id(400+n),pg_temp.offline_admission_id(12),
    pg_temp.offline_admission_id(600+n),repeat('c',64),v_at,0,v_at,v_at,v_at+interval '90 days','quarantined','CLOCK_CONFLICT','{}');
end;
$$;
select pg_temp.offline_admission_fixture(n) from generate_series(1,3) n;
select ok(not has_function_privilege('anon',
  'public.acquire_operation_offline_resolution_admission(text,bigint,uuid,uuid,text,text,timestamptz,text,text,text)','EXECUTE'),
  'anon cannot acquire');
select ok(not has_function_privilege('authenticated',
  'public.complete_operation_offline_resolution_admission(uuid,text,uuid,uuid,text,uuid,text)','EXECUTE'),
  'authenticated cannot forge completion');
select ok(has_function_privilege('service_role',
  'public.complete_operation_offline_resolution_admission(uuid,text,uuid,uuid,text,uuid,text)','EXECUTE'),
  'trusted transport alone can ask the database to observe a terminal');
select ok(not has_table_privilege('service_role','private.offline_event_resolutions','INSERT'),
  'service cannot manufacture the proof row');
select ok(not has_table_privilege('service_role','private.developer_operation_admissions','UPDATE'),
  'service cannot manufacture a command binding');
create function pg_temp.offline_admission_acquire(n integer,resolution text default 'record_only',
  key text default 'offline-admission-key-1',hash text default repeat('d',64)) returns jsonb language sql volatile as $$
  select public.acquire_operation_offline_resolution_admission('synthetic-target',1,pg_temp.offline_admission_id(11),
    pg_temp.offline_admission_id(1),pg_temp.offline_admission_id(21)::text,lpad(n::text,64,'0'),
    clock_timestamp()+interval '1 minute',resolution,key,hash);
$$;
select throws_ok($q$select pg_temp.offline_admission_acquire(1,null)$q$,'22023','OPERATION_COMMAND_BINDING_REJECTED','null resolution rejected');
select throws_ok($q$select pg_temp.offline_admission_acquire(1,'RECORD_ONLY')$q$,'22023','OPERATION_COMMAND_BINDING_REJECTED','resolution exact case');
select throws_ok($q$select pg_temp.offline_admission_acquire(1,'record_only',null)$q$,'22023','OPERATION_COMMAND_BINDING_REJECTED','null key rejected');
select throws_ok($q$select pg_temp.offline_admission_acquire(1,'record_only','offline-admission-key-1',null)$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','null hash rejected');
select throws_ok($q$select public.acquire_operation_offline_resolution_admission('synthetic-target',1,
  pg_temp.offline_admission_id(12),pg_temp.offline_admission_id(2),pg_temp.offline_admission_id(22)::text,repeat('f',64),
  clock_timestamp()+interval '1 minute','record_only','offline-admission-key-1',repeat('d',64))$q$,
  '42501','ADMIN_REQUIRED','maid cannot acquire administrator resolution');
create temp table offline_admitted as
  select 1 as n,pg_temp.offline_admission_acquire(1) as receipt
  union all select 2,pg_temp.offline_admission_acquire(2,'reject_effect','offline-admission-key-2')
  union all select 3,pg_temp.offline_admission_acquire(3,'correction_link','offline-admission-key-3')
  union all select 4,pg_temp.offline_admission_acquire(4,'record_only','offline-wrong-key')
  union all select 5,pg_temp.offline_admission_acquire(5,'record_only','offline-admission-key-1',repeat('e',64))
  union all select 6,pg_temp.offline_admission_acquire(6);
create function pg_temp.offline_admission_complete(n integer,q integer default 1,resolution text default 'record_only',
  nonce text default null,actor uuid default pg_temp.offline_admission_id(11)) returns jsonb language sql volatile as $$
  select public.complete_operation_offline_resolution_admission(
    (select (a.receipt->>'admissionId')::uuid from offline_admitted a where a.n=$1),
    coalesce(nonce,lpad(n::text,64,'0')),actor,pg_temp.offline_admission_id(1),pg_temp.offline_admission_id(21)::text,
    pg_temp.offline_admission_id(500+q),resolution);
$$;
select is((select count(*) from offline_admitted where receipt->>'completionMode'='OFFLINE_RESOLUTION'),6::bigint,
  'all resolution admissions require their own exact terminal');
select throws_ok($q$select pg_temp.offline_admission_complete(1)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'HTTP success or an absent/purged terminal cannot release the admission');
-- Direct inserts represent already committed terminal observations, not actual
-- business execution. Existing offline domain tests separately cover effects.
insert into private.offline_event_resolutions(event_record_id,actor_profile_id,resolution,idempotency_key,request_hash,
  response_payload,metadata_expires_at)
select e.id,pg_temp.offline_admission_id(11),case n when 1 then 'record_only' when 2 then 'reject_effect' else 'correction_link' end,
  'offline-admission-key-'||n,repeat('d',64),'{}',e.metadata_expires_at
from generate_series(1,3) n join private.offline_completion_events e on e.id=pg_temp.offline_admission_id(500+n);
create temp table offline_terminal_before as select jsonb_agg(r order by r.id) as snapshot from private.offline_event_resolutions r;
select throws_ok($q$select pg_temp.offline_admission_complete(1,2)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','another target cannot complete');
select throws_ok($q$select pg_temp.offline_admission_complete(1,1,'reject_effect')$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','another resolution cannot complete');
select throws_ok($q$select pg_temp.offline_admission_complete(1,1,'record_only',repeat('f',64))$q$,
  '42501','OPERATION_COMPLETION_UNVERIFIED','another nonce cannot complete');
select throws_ok($q$select pg_temp.offline_admission_complete(1,1,'record_only',null,pg_temp.offline_admission_id(12))$q$,
  '42501','OPERATION_COMPLETION_UNVERIFIED','another actor cannot use a matching terminal');
select throws_ok($q$select pg_temp.offline_admission_complete(4)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','another key cannot complete');
select throws_ok($q$select pg_temp.offline_admission_complete(5)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','another hash cannot complete');
select throws_ok($q$select public.complete_operation_http_admission(
  (select (receipt->>'admissionId')::uuid from offline_admitted where n=1),lpad('1',64,'0'),
  pg_temp.offline_admission_id(11),pg_temp.offline_admission_id(1),pg_temp.offline_admission_id(21)::text)$q$,
  '42501','OPERATION_COMPLETION_UNVERIFIED','offline terminal is not a generic command_execution receipt');
update public.profiles set must_change_password=true where id=pg_temp.offline_admission_id(11);
select throws_ok($q$select pg_temp.offline_admission_complete(6)$q$,'42501',null,'latest password-change requirement still blocks completion');
update public.profiles set must_change_password=false where id=pg_temp.offline_admission_id(11);
update public.profiles set role='maid' where id=pg_temp.offline_admission_id(11);
select throws_ok($q$select pg_temp.offline_admission_complete(6)$q$,'42501','ADMIN_REQUIRED',
  'an existing terminal does not preserve a revoked administrator role');
update public.profiles set role='admin' where id=pg_temp.offline_admission_id(11);
update auth.sessions set not_after=clock_timestamp()-interval '1 minute' where id=pg_temp.offline_admission_id(21);
select throws_ok($q$select pg_temp.offline_admission_complete(6)$q$,'42501','OPERATION_IDENTITY_REJECTED',
  'an existing terminal does not bypass an expired session');
update auth.sessions set not_after=null where id=pg_temp.offline_admission_id(21);
create temp table offline_password_before as select encrypted_password from auth.users where id=pg_temp.offline_admission_id(1);
update auth.users set encrypted_password='synthetic-password-version-change' where id=pg_temp.offline_admission_id(1);
select throws_ok($q$select pg_temp.offline_admission_complete(6)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'a changed Auth password version invalidates the original admission');
update auth.users set encrypted_password=(select encrypted_password from offline_password_before) where id=pg_temp.offline_admission_id(1);
update private.developer_operation_control set maintenance='REQUESTED',version=version+1;
select throws_ok($q$select pg_temp.offline_admission_acquire(7)$q$,'42501','OPERATION_ADMISSION_REJECTED','maintenance blocks a new admission');
select lives_ok($q$select pg_temp.offline_admission_complete(1)$q$,'exact terminal remains observable after maintenance starts');
select lives_ok($q$select pg_temp.offline_admission_complete(2,2,'reject_effect')$q$,'reject-effect terminal completes without new business effects');
select lives_ok($q$select pg_temp.offline_admission_complete(3,3,'correction_link')$q$,'correction terminal completes without replaying correction');
select lives_ok($q$select pg_temp.offline_admission_complete(6)$q$,'older/replayed matching terminal completes a new admission');
select throws_ok($q$select pg_temp.offline_admission_complete(1)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','admission completion is one-time');
select is((select jsonb_agg(r order by r.id) from private.offline_event_resolutions r),
  (select snapshot from offline_terminal_before),'observation preserves every terminal byte');
select is((select count(*) from private.command_executions where command_type like 'offline.quarantine.%'),0::bigint,
  'observation creates no permanent duplicate command receipt');
select is(private.collect_developer_operation_gates()->>'coverage','NOT_INTEGRATED','one offline route does not claim whole reset coverage');
select * from finish();
rollback;
