-- #396 SOURCE PREPARED ONLY. No connection/execution in source validation.
-- These fixtures run only in the separately approved final fresh DB transaction.
begin;
select no_plan();
create function pg_temp.admission_id(n integer) returns uuid language sql immutable as $$
  select ('f3961300-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid;
$$;
insert into auth.users(id) values(pg_temp.admission_id(1)),(pg_temp.admission_id(2));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.admission_id(11),pg_temp.admission_id(1),'admission-admin','admission-admin',
  'admission-admin','admission-admin',0,'admin','active',false),
  (pg_temp.admission_id(12),pg_temp.admission_id(2),'admission-maid','admission-maid',
  'admission-maid','admission-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id,not_after)
values(pg_temp.admission_id(21),pg_temp.admission_id(1),null),
  (pg_temp.admission_id(22),pg_temp.admission_id(2),null);

select is(public.get_operation_admission_control('synthetic-target')->>'mode','INACTIVE',
  'missing control preserves ordinary business, not reset readiness');
select ok(private.operation_http_route('previewAssignments') is null,'read-only preview has no write lease');
select ok(private.operation_http_route('markNotificationRead') is null,'atomic dispatch never takes an opaque outer lease');
select ok(not has_function_privilege('authenticated',
  'public.acquire_operation_http_admission(text,bigint,text,uuid,uuid,text,text,timestamptz,text,text,text,jsonb)',
  'EXECUTE'),'public caller cannot claim service authority');
select ok(not has_table_privilege('service_role','private.developer_operation_admissions','UPDATE'),
  'service cannot directly mark completed');
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle)
values('synthetic-target',repeat('a',64),120,'PROVISIONING');
select is(public.get_operation_admission_control('other-target')->>'mode','UNKNOWN','target mismatch never becomes inactive');

create function pg_temp.acquire_http(n integer,route text default 'createReservation',
  command text default 'reservation.create',request_hash text default repeat('c',64))
returns jsonb language sql volatile as $$
  select public.acquire_operation_http_admission('synthetic-target',1,route,pg_temp.admission_id(11),
    pg_temp.admission_id(1),pg_temp.admission_id(21)::text,lpad(n::text,64,'0'),
    clock_timestamp()+interval '1 minute',command,'synthetic-command-key',request_hash,null);
$$;
select throws_ok($q$select pg_temp.acquire_http(1,'previewAssignments')$q$,
  '42501','OPERATION_IDENTITY_REJECTED','unknown/read-only route cannot acquire');
select throws_ok($q$select pg_temp.acquire_http(1,'createReservation','payroll.start')$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','route cannot substitute a completed command');
select throws_ok($q$select pg_temp.acquire_http(1,'createReservation','reservation.create',null)$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','caller-hash receipt requires exact hash');
create temp table admitted as select pg_temp.acquire_http(1) as receipt;
create temp table hash_mismatch as select pg_temp.acquire_http(2,'createReservation','reservation.create',repeat('d',64)) as receipt;
create temp table opaque_login as select public.acquire_operation_http_admission('synthetic-target',1,
  'AUTH_LOGIN',null,null,null,repeat('f',64),clock_timestamp()+interval '1 minute',null,null,null,null) as receipt;
create function pg_temp.complete_http(n integer default 1) returns jsonb language sql volatile as $$
  select public.complete_operation_http_admission((select (receipt->>'admissionId')::uuid from admitted),
    lpad(n::text,64,'0'),pg_temp.admission_id(11),pg_temp.admission_id(1),pg_temp.admission_id(21)::text);
$$;
select throws_ok($q$select pg_temp.complete_http()$q$,'42501','OPERATION_COMPLETION_UNVERIFIED',
  'successful HTTP without committed receipt is not proof');
select throws_ok($q$select pg_temp.complete_http(2)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','wrong nonce cannot release');
select throws_ok($q$select public.complete_operation_http_admission((select (receipt->>'admissionId')::uuid from admitted),
  lpad('1',64,'0'),pg_temp.admission_id(12),pg_temp.admission_id(2),pg_temp.admission_id(22)::text)$q$,
  '42501','OPERATION_COMPLETION_UNVERIFIED','another valid actor/session cannot release the effect');
select throws_ok($q$select public.complete_operation_http_admission((select (receipt->>'admissionId')::uuid from opaque_login),
  repeat('f',64),null,null,null)$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','login response does not settle an opaque Auth effect');
insert into private.command_executions(actor_profile_id,command_type,idempotency_key,request_hash,
  entity_id,response_payload,completed_at)
values(pg_temp.admission_id(11),'reservation.create','synthetic-command-key',repeat('c',64),
  null,'{}',clock_timestamp()-interval '1 hour');
select throws_ok($q$select public.complete_operation_http_admission((select (receipt->>'admissionId')::uuid from hash_mismatch),
  lpad('2',64,'0'),pg_temp.admission_id(11),pg_temp.admission_id(1),pg_temp.admission_id(21)::text)$q$,
  '42501','OPERATION_COMPLETION_UNVERIFIED','old command with a different hash is not terminal proof');
update private.developer_operation_admissions set created_at=clock_timestamp()-interval '2 minutes',
  deadline_at=clock_timestamp()-interval '1 minute' where id=(select (receipt->>'admissionId')::uuid from admitted);
select is(private.collect_developer_operation_gates()->>'expiredUnfinishedAdmissions','1',
  'deadline expiry alone leaves the actual effect unknown');
update private.developer_operation_control set maintenance='REQUESTED',version=version+1;
select throws_ok($q$select pg_temp.acquire_http(2)$q$,'42501','OPERATION_ADMISSION_REJECTED',
  'maintenance/version barrier rejects new admission');
select lives_ok($q$select pg_temp.complete_http()$q$,'exact immutable replay receipt with NULL entity completes during maintenance');
select is(private.collect_developer_operation_gates()->>'expiredUnfinishedAdmissions','0',
  'a later exact terminal readback can resolve expired work without ignoring expiry');
select throws_ok($q$select pg_temp.complete_http()$q$,'42501','OPERATION_COMPLETION_UNVERIFIED','completion is consumed once');

select is(private.operation_availability_hash('submitAvailability',pg_temp.admission_id(12),
  jsonb_build_object('p_actor_profile_id',pg_temp.admission_id(12),'p_week_start','2026-10-26',
    'p_available_dates',jsonb_build_array('2026-10-28','2026-10-26'),'p_expected_version',0)),
  private.availability_request_hash(jsonb_build_object('command','availability.submit',
    'actorProfileId',pg_temp.admission_id(12),'weekStart','2026-10-26'::date,
    'availableDates',to_jsonb(array['2026-10-26'::date,'2026-10-28'::date]),'expectedVersion',0)),
  'availability uses the original typed sorted date hash');
select throws_ok($q$select private.operation_availability_hash('submitAvailability',pg_temp.admission_id(12),
  jsonb_build_object('p_actor_profile_id',pg_temp.admission_id(12),'p_week_start','2026-10-26',
    'p_available_dates',jsonb_build_array('2026-10-26','2026-10-26'),'p_expected_version',0))$q$,
  '22023','AVAILABILITY_DATES_MUST_BE_UNIQUE','duplicate date cannot be silently deduplicated');
select throws_ok($q$select private.operation_availability_hash('submitAvailability',pg_temp.admission_id(11),
  jsonb_build_object('p_actor_profile_id',pg_temp.admission_id(12),'p_week_start','2026-10-26',
    'p_available_dates','[]'::jsonb,'p_expected_version',0))$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','availability cannot substitute actor');
select throws_ok($q$select private.operation_availability_hash('submitAvailability',pg_temp.admission_id(12),
  jsonb_build_object('p_actor_profile_id',pg_temp.admission_id(12),'p_week_start','2026-10-26',
    'p_available_dates','[]'::jsonb,'p_expected_version',0,'approved',true))$q$,
  '22023','OPERATION_COMMAND_BINDING_REJECTED','arbitrary caller proof field rejected');
select is(private.operation_availability_hash('requestAvailabilityChange',pg_temp.admission_id(12),
  jsonb_build_object('p_actor_profile_id',pg_temp.admission_id(12),'p_week_start','2026-10-26',
    'p_requested_available_dates','[]'::jsonb,'p_reason_code','SYNTHETIC','p_expected_version',1)),
  private.availability_request_hash(jsonb_build_object('command','availability.change_requested',
    'actorProfileId',pg_temp.admission_id(12),'weekStart','2026-10-26'::date,
    'requestedAvailableDates','[]'::jsonb,'reasonCode','SYNTHETIC','expectedVersion',1)),
  'request-change hash retains the distinct typed payload');
select is(private.operation_availability_hash('decideAvailabilityChange',pg_temp.admission_id(11),
  jsonb_build_object('p_actor_profile_id',pg_temp.admission_id(11),'p_change_request_id',pg_temp.admission_id(31),
    'p_decision','approved','p_reason_code','SYNTHETIC','p_expected_version',1)),
  private.availability_request_hash(jsonb_build_object('command','availability.change_decided',
    'actorProfileId',pg_temp.admission_id(11),'changeRequestId',pg_temp.admission_id(31),
    'decision','approved'::public.availability_request_status,'reasonCode','SYNTHETIC','expectedVersion',1)),
  'decision hash retains UUID and enum canonicalization');
select is(private.collect_developer_operation_gates()->>'coverage','NOT_INTEGRATED',
  '65 adapters are not all-path coverage proof');
select * from finish();
rollback;
