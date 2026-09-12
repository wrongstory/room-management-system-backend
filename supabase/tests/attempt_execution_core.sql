begin;
select no_plan();
create function pg_temp.eid(n integer) returns uuid language sql immutable as $$
 select ('7a000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.eid(n+100) from generate_series(1,6) n;
select public.bootstrap_first_developer_profile(pg_temp.eid(6),pg_temp.eid(106),'수행 개발자','수행 개발자','0006','execution-hash','execution-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.eid(n),pg_temp.eid(n+100),'execution-'||n,'execution-'||n,'execution-'||n,'execution-'||n,0,
 case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,5) n;
create function pg_temp.execution_fixture(n integer,p_maid integer default 2,p_due timestamptz default '2040-03-01 15:00+09',
 p_notified boolean default true,p_include_attempt boolean default true,p_room_snapshot jsonb default null)
returns void language plpgsql as $$
declare v_room uuid;
begin
 select id into v_room from public.rooms order by room_number offset n limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.eid(300+n),v_room,'additional','manual_room_request','execution-'||n,'2040-03-01','2040-03-01',
  '2040-03-01 09:00+09',p_due,case when p_notified then 'notified' else 'draft_assigned' end::public.cleaning_target_status,
  2,'{}',10000,'{}',pg_temp.eid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.eid(400+n),pg_temp.eid(300+n),pg_temp.eid(p_maid),n,2,
  case when p_notified then '2040-03-01 08:00+09'::timestamptz end,pg_temp.eid(1));
 if p_include_attempt then
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot)
 values(pg_temp.eid(500+n),pg_temp.eid(300+n),pg_temp.eid(400+n),pg_temp.eid(p_maid),1,'scheduled',2,'{}',
  coalesce(p_room_snapshot,jsonb_build_object('roomId',v_room)));
 end if;
end;
$$;
select pg_temp.execution_fixture(n) from generate_series(1,11) n;
select pg_temp.execution_fixture(12,3);
select pg_temp.execution_fixture(14,4,'2040-03-01 15:00+09',false);
select pg_temp.execution_fixture(15,4,'2040-03-01 15:00+09',true,true,'{}');
select pg_temp.execution_fixture(16,4,'2040-03-01 15:00+09',true,false);
create function pg_temp.run_execution(n integer,p_action text,p_version bigint default 1,p_key text default null,p_hash text default null,
 p_actor integer default 2,p_at timestamptz default '2040-03-01 10:00+09') returns jsonb language sql as $$
 select private.execute_cleaning_attempt_at(pg_temp.eid(p_actor),pg_temp.eid(500+n),p_version,pg_temp.eid(400+n),2,
  coalesce(p_key,'execution-'||p_action||'-'||n),coalesce(p_hash,repeat('a',64)),p_action,p_at)
$$;
create temp table execution_result(label text primary key,value jsonb);
create function pg_temp.execution_ledgers() returns jsonb language sql as $$
 select jsonb_build_object('attempts',(select jsonb_agg(a order by id) from public.cleaning_attempts a),
  'targets',(select jsonb_agg(t order by id) from public.cleaning_targets t),
  'audit',(select jsonb_agg(e order by id) from public.audit_events e),
  'receipts',(select jsonb_agg(c order by id) from private.command_executions c),
  'notices',(select jsonb_agg(n order by id) from public.notifications n))
$$;

select is((public.get_current_cleaning_attempt(pg_temp.eid(2),pg_temp.eid(401))->>'executionVersion')::int,1,'current notified owner obtains execution CAS');
select is(public.get_current_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(416)),null::jsonb,'own current notified assignment without attempt returns null');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(414))$$,'42501','ATTEMPT_ACCESS_REQUIRED','own never-notified draft is not an execution read');
select throws_ok($$select pg_temp.run_execution(15,'start',1,null,null,4)$$,'40001','ASSIGNMENT_VERSION_CONFLICT','missing legacy room snapshot is fail-closed, no current-room fallback');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(3),pg_temp.eid(401))$$,'42501','ATTEMPT_ACCESS_REQUIRED','other maid cannot enumerate attempt');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(1),pg_temp.eid(401))$$,'42501','MAID_REQUIRED','business admin cannot use maid execution read');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(6),pg_temp.eid(401))$$,'42501','MAID_REQUIRED','developer cannot use business execution');
select throws_ok($$select pg_temp.run_execution(1,'complete_field_work')$$,'55000','ATTEMPT_INVALID_TRANSITION','scheduled cannot complete without start');
select throws_ok($$select pg_temp.run_execution(1,'start',2)$$,'40001','ATTEMPT_VERSION_CONFLICT','stale execution CAS fails closed');
select ok(array[
    coalesce(current_setting('app.notification_writer_mode',true),''),
    coalesce(current_setting('app.notification_terminal_kind',true),''),
    coalesce(current_setting('app.notification_terminal_id',true),''),
    coalesce(current_setting('app.notification_legacy_suppressed_count',true),''),
    coalesce(current_setting('app.notification_typed_emit_count',true),'')
  ]=array['','','','',''],
  'failed start leaves writer, terminal, and counter GUCs clear');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,null,3)$$,'42501','ATTEMPT_ACCESS_REQUIRED','start requires exact owner');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,null,1)$$,'42501','MAID_REQUIRED','admin cannot start');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,null,6)$$,'42501','MAID_REQUIRED','developer cannot start');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,null,2,'2040-03-01 08:59+09')$$,'55000','CLEANING_WINDOW_NOT_OPEN','start before availableFrom rejected');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,null,2,'2040-03-01 15:00+09')$$,'55000','CLEANING_WINDOW_EXPIRED','start at due boundary rejected');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,null,2,'2040-03-02 10:00+09')$$,'55000','CLEANING_SERVICE_DATE_EXPIRED','yesterday scheduled cannot silently start');
select private.emit_notification_v1('assignment.commit_notified',pg_temp.eid(1),pg_temp.eid(2),
  'cleaning_assignment',pg_temp.eid(401)::text,'현재 배정','청소를 시작해 주세요.',
  (select room_id from public.cleaning_targets where id=pg_temp.eid(301)),pg_temp.eid(301),pg_temp.eid(301),'2040-03-01 09:00+09');
select private.emit_notification_v1('reservation.extension_revoked',pg_temp.eid(1),pg_temp.eid(2),
  'cleaning_assignment',pg_temp.eid(401)::text,'현재 배정 기록','기록 보존 알림입니다.',
  (select room_id from public.cleaning_targets where id=pg_temp.eid(301)),pg_temp.eid(301),pg_temp.eid(301),'2040-03-01 09:01+09');
select private.emit_notification_v1('assignment.commit_notified',pg_temp.eid(1),pg_temp.eid(2),
  'cleaning_assignment',pg_temp.eid(402)::text,'다른 배정','다른 배정 알림입니다.',
  (select room_id from public.cleaning_targets where id=pg_temp.eid(302)),pg_temp.eid(302),pg_temp.eid(302),'2040-03-01 09:02+09');
select private.emit_notification_v1('assignment.commit_notified',pg_temp.eid(1),pg_temp.eid(3),
  'cleaning_assignment',pg_temp.eid(412)::text,'다른 메이드 배정','다른 메이드 알림입니다.',
  (select room_id from public.cleaning_targets where id=pg_temp.eid(312)),pg_temp.eid(312),pg_temp.eid(312),'2040-03-01 09:03+09');
select ok((select count(*)=4 from public.notifications where contract_version=1
    and source_entity_id in (pg_temp.eid(401)::text,pg_temp.eid(402)::text,pg_temp.eid(412)::text))
  and (select count(*)=4 from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
    where n.source_entity_id in (pg_temp.eid(401)::text,pg_temp.eid(402)::text,pg_temp.eid(412)::text)),
  'start resolver fixtures contain four inbox rows and actionable plus informational deliveries');
insert into execution_result values('start',pg_temp.run_execution(1,'start'));
select is((select value->>'status' from execution_result where label='start'),'in_progress','scheduled starts online');
select is((select execution_version::int from public.cleaning_attempts where id=pg_temp.eid(501)),2,'start increments version once');
select ok((select resolved_at is not null from public.notifications
    where event_family='assignment.commit_notified' and source_entity_id=pg_temp.eid(401)::text)
  and (select resolved_at is null from public.notifications
    where event_family='reservation.extension_revoked' and source_entity_id=pg_temp.eid(401)::text)
  and (select bool_and(resolved_at is null) from public.notifications
    where event_family='assignment.commit_notified' and source_entity_id in (pg_temp.eid(402)::text,pg_temp.eid(412)::text)),
  'start resolves only the current assignment actionable notice');
select ok((select count(*)=4 from public.notifications where contract_version=1
    and source_entity_id in (pg_temp.eid(401)::text,pg_temp.eid(402)::text,pg_temp.eid(412)::text))
  and (select count(*)=4 from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
    where n.source_entity_id in (pg_temp.eid(401)::text,pg_temp.eid(402)::text,pg_temp.eid(412)::text)),
  'resolver-only start creates no notification or delivery row');
create temp table start_resolution as select resolved_at from public.notifications
where event_family='assignment.commit_notified' and source_entity_id=pg_temp.eid(401)::text;
select ok(array[
    coalesce(current_setting('app.notification_writer_mode',true),''),
    coalesce(current_setting('app.notification_terminal_kind',true),''),
    coalesce(current_setting('app.notification_terminal_id',true),''),
    coalesce(current_setting('app.notification_legacy_suppressed_count',true),''),
    coalesce(current_setting('app.notification_typed_emit_count',true),'')
  ]=array['','','','',''],
  'successful start clears writer, terminal, and counter GUCs');
select is((select pg_temp.run_execution(1,'start')), (select value from execution_result where label='start'),'same key/hash replays exact logical start result');
select is((select count(*)::int from public.audit_events where event_type='cleaning.attempt_started'),1,'start replay appends no duplicate audit');
select is((select resolved_at from public.notifications where event_family='assignment.commit_notified'
    and source_entity_id=pg_temp.eid(401)::text),(select resolved_at from start_resolution),
  'start replay preserves the first resolvedAt');
select ok(array[
    coalesce(current_setting('app.notification_writer_mode',true),''),
    coalesce(current_setting('app.notification_terminal_kind',true),''),
    coalesce(current_setting('app.notification_terminal_id',true),''),
    coalesce(current_setting('app.notification_legacy_suppressed_count',true),''),
    coalesce(current_setting('app.notification_typed_emit_count',true),'')
  ]=array['','','','',''],
  'start replay leaves writer, terminal, and counter GUCs clear');
select throws_ok($$select pg_temp.run_execution(1,'start',1,null,repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','same scope different hash conflicts');
select throws_ok($$select pg_temp.run_execution(2,'start')$$,'55000','MAID_ALREADY_IN_PROGRESS','same maid cannot start another room');
select throws_ok($$update public.profiles set status='inactive' where id=pg_temp.eid(2)$$,'55000','ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED','generic deactivate cannot strand running attempt');
select throws_ok($$update public.profiles set status='upload_only' where id=pg_temp.eid(2)$$,'55000','ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED','upload-only cannot bypass pending lifecycle policy');
select throws_ok($$update public.profiles set role='admin' where id=pg_temp.eid(2)$$,'55000','ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED','role change cannot strand running attempt');
select lives_ok($$select pg_temp.run_execution(12,'start',1,null,null,3)$$,'different maid can execute in parallel');
select throws_ok($$update public.cleaning_attempts set started_at=started_at+interval '1 second' where id=pg_temp.eid(501)$$,
 '23514','ATTEMPT_EXECUTION_TIMESTAMP_IMMUTABLE','start timestamp immutable');
select throws_ok($$update public.cleaning_attempts set execution_version=99 where id=pg_temp.eid(501)$$,
 '23514','ATTEMPT_VERSION_CONFLICT','arbitrary version update rejected');
select throws_ok($$update public.cleaning_attempts set template_snapshot='{"secret":"no"}' where id=pg_temp.eid(501)$$,
 '23514','ATTEMPT_SNAPSHOT_IMMUTABLE','frozen execution template immutable');
insert into execution_result values('complete',pg_temp.run_execution(1,'complete_field_work',2,null,null,2,'2040-03-02 01:00+09'));
select is((select value->>'status' from execution_result where label='complete'),'field_completed','field completion crosses midnight and due without photo requirement');
select ok((select started_at='2040-03-01 10:00+09' and field_completed_at='2040-03-02 01:00+09' and ended_at=field_completed_at and execution_version=3
 from public.cleaning_attempts where id=pg_temp.eid(501)),'completion freezes physical end and advances CAS');
select is(pg_temp.run_execution(1,'complete_field_work',2),(select value from execution_result where label='complete'),'complete replay survives old CAS and lost response');
select is((select count(*)::int from public.audit_events where event_type='cleaning.field_completed'),1,'complete replay appends one audit only');
select ok((select count(*)=1 and bool_and(not requires_action)
  from public.notifications where event_family='cleaning.field_completed_admin'
    and source_entity_id=pg_temp.eid(501)::text and recipient_profile_id=pg_temp.eid(1)),
  'online field completion emits one informational inbox notification to the active admin');
select is((select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
  where n.event_family='cleaning.field_completed_admin' and n.source_entity_id=pg_temp.eid(501)::text),1::bigint,
  'online field completion enqueues informational push independently of requiresAction');
select is((select count(*)::int from public.cleaning_submissions),0,'physical completion creates no submission');
select is((select count(*)::int from public.earnings),0,'physical completion creates no earning');
select is((select count(*)::int from public.room_pin_access_leases),0,'no PIN lease is created');
select is((select count(*)::int from public.notifications where source_entity_kind='cleaning_submission'),0,
 'physical completion creates no premature submission notification');
select throws_ok($$update public.cleaning_attempts set status='in_progress' where id=pg_temp.eid(501)$$,'23514','ATTEMPT_INVALID_TRANSITION','field completed cannot return to in-progress');
select throws_ok($$update public.cleaning_attempts set ended_at=ended_at+interval '1 second' where id=pg_temp.eid(501)$$,
 '23514','ATTEMPT_EXECUTION_TIMESTAMP_IMMUTABLE','physical completion end timestamp immutable');
select lives_ok($$update public.profiles set status='inactive' where id=pg_temp.eid(2)$$,'after field completion generic account transition resumes');
select throws_ok($$select pg_temp.run_execution(1,'complete_field_work',2)$$,'42501','MAID_REQUIRED','inactive actor cannot replay privileged command');
update public.profiles set status='active',must_change_password=true where id=pg_temp.eid(2);
select throws_ok($$select pg_temp.run_execution(2,'start')$$,'42501','PASSWORD_CHANGE_REQUIRED','temporary password blocks execution');
update public.profiles set must_change_password=false where id=pg_temp.eid(2);
select lives_ok($$select pg_temp.run_execution(2,'start')$$,'completed maid may start next assignment');
select lives_ok($$select pg_temp.run_execution(2,'complete_field_work',2)$$,'same timestamp start/complete allowed without fabricated duration');

-- A delayed additional start must inspect the actual instant, not a duration fallback.
select pg_temp.execution_fixture(13,4,null);
insert into public.reservations(id,room_id,check_in_at,check_out_at,guest_count,status,created_by,updated_by)
select pg_temp.eid(701),room_id,'2040-03-01 09:30+09','2040-03-02 11:00+09',1,'active',pg_temp.eid(1),pg_temp.eid(1)
from public.cleaning_targets where id=pg_temp.eid(313);
select throws_ok($$select pg_temp.run_execution(13,'start',1,null,null,4)$$,'55000','ATTEMPT_ACTIVATION_NOT_ALLOWED','occupied additional work is rejected at actual start');

-- All mutations/audits/receipts roll back together on append failure.
create function pg_temp.fail_execution_audit() returns trigger language plpgsql as $$
begin if new.event_type='cleaning.attempt_started' then raise exception 'EXECUTION_AUDIT_TEST_FAILURE'; end if; return new; end
$$;
create trigger test_fail_execution_audit before insert on public.audit_events for each row execute function pg_temp.fail_execution_audit();
insert into execution_result values('beforeFailure',pg_temp.execution_ledgers());
select throws_ok($$select pg_temp.run_execution(4,'start')$$,'P0001','EXECUTION_AUDIT_TEST_FAILURE','audit append failure rejects entire start');
select is(pg_temp.execution_ledgers(),(select value from execution_result where label='beforeFailure'),'audit failure leaves all business ledgers unchanged');
drop trigger test_fail_execution_audit on public.audit_events;
select lives_ok($$select pg_temp.run_execution(4,'start')$$,'failed atomic command can retry same key');

select is((select count(*)::int from public.list_developer_audit_events(pg_temp.eid(6),array['cleaning.attempt_started','cleaning.field_completed'],pg_temp.eid(2))),5,
 'developer can filter maid execution domain audits');
select ok(not exists(select 1 from public.list_developer_audit_events(pg_temp.eid(6),array['cleaning.attempt_started','cleaning.field_completed']) e
 where summary ?| array['requestHash','before_state','after_state','roomSnapshot','templateSnapshot','guestName','pin','phone','token','requestBody']),
 'developer summary exposes only approved execution metadata');
select ok(not has_function_privilege('anon','public.start_cleaning_attempt(uuid,uuid,bigint,uuid,bigint,text,text)','execute')
 and not has_function_privilege('authenticated','public.complete_cleaning_attempt_field_work(uuid,uuid,bigint,uuid,bigint,text,text)','execute')
 and has_function_privilege('service_role','public.get_current_cleaning_attempt(uuid,uuid)','execute'), 'public RPC grants are service-only');
select ok(not has_function_privilege('service_role','private.execute_cleaning_attempt_at(uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz)','execute'),
 'caller-supplied clock seam is owner-only');
select ok(not has_table_privilege('authenticated','public.cleaning_attempts','update'), 'client cannot bypass execution RPC');
select lives_ok($$select public.record_authorization_denial(pg_temp.eid(2),'edge.authorization.attempts','ATTEMPT_ACCESS_REQUIRED')$$,
 'attempt authorization denial uses bounded existing aggregate');

-- A real scheduler checkout is legal while its stayover field work is running.
create temp table stay_case as select pg_temp.eid(702) reservation_id,pg_temp.eid(320) target_id,
 id room_id,room_type_id from public.rooms order by room_number offset 30 limit 1;
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select distinct room_type_id,kind::public.cleaning_kind,1,'published',60,'[]'::jsonb,now(),pg_temp.eid(1)
from stay_case cross join (values('checkout'),('stayover')) kinds(kind);
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select room_id,'verified',1,'EXECUTION_TEST',pg_temp.eid(1),now() from stay_case;
select public.create_reservation(pg_temp.eid(1),reservation_id,room_id,'2040-02-28 16:00+09','2040-03-01 11:00+09',
 1,null,(select state_version from public.rooms where id=room_id),'execution-stay-reservation',repeat('c',64)) from stay_case;
update public.reservations set actual_check_in_at=check_in_at where id=(select reservation_id from stay_case);
select public.create_manual_cleaning_request(pg_temp.eid(1),target_id,room_id,reservation_id,'stayover','2040-03-01',
 '2040-03-01 09:00+09','2040-03-01 10:30+09',(select state_version from public.rooms where id=room_id),
 'EXECUTION_TEST','execution-stay-request',repeat('d',64)) from stay_case;
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select pg_temp.eid(420),target_id,pg_temp.eid(5),20,2,'2040-03-01 08:00+09',pg_temp.eid(1) from stay_case;
update public.cleaning_targets set status='notified',assignment_version=2 where id=(select target_id from stay_case);
select private.activate_cleaning_attempt_at(pg_temp.eid(1),target_id,'2040-03-01 09:30+09') from stay_case;
create temp table stay_attempt as select id from public.cleaning_attempts where cleaning_target_id=(select target_id from stay_case);
select lives_ok($$select private.execute_cleaning_attempt_at(pg_temp.eid(5),(select id from stay_attempt),1,
 pg_temp.eid(420),2,'execution-stay-start',repeat('e',64),'start','2040-03-01 10:00+09')$$,'valid occupied stayover can start');
select lives_ok($$select public.process_due_reservation_transitions(pg_temp.eid(1),'2040-03-01 11:01+09',
 'execution-stay-scheduler',repeat('f',64))$$,'scheduler can end reservation during running stayover');
select is((select status from public.reservations where id=(select reservation_id from stay_case)),'checked_out',
 'real scheduler records checkout without rewriting running stayover');
select lives_ok($$select private.execute_cleaning_attempt_at(pg_temp.eid(5),(select id from stay_attempt),2,
 pg_temp.eid(420),2,'execution-stay-complete',repeat('1',64),'complete_field_work','2040-03-01 11:30+09')$$,
 'same stayover attempt can complete after checkout and old window expiry');
select is((select status::text from public.cleaning_attempts where id=(select id from stay_attempt)),'field_completed',
 'normal checkout does not strand actual field completion');

-- #7A offers no limited capability: every non-active account remains blocked.
update public.profiles set status='deactivation_pending' where id=pg_temp.eid(4);
select throws_ok($$select public.start_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(513),1,pg_temp.eid(413),2,
 'execution-pending-denied',repeat('2',64))$$,'42501','MAID_REQUIRED','deactivation_pending cannot use general start');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(413))$$,
 '42501','MAID_REQUIRED','deactivation_pending cannot use general current attempt read');
update public.profiles set status='upload_only' where id=pg_temp.eid(4);
select throws_ok($$select public.start_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(513),1,pg_temp.eid(413),2,
 'execution-upload-denied',repeat('3',64))$$,'42501','MAID_REQUIRED','upload_only cannot use general start');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(413))$$,
 '42501','MAID_REQUIRED','upload_only cannot use general current attempt read');
update public.profiles set status='inactive' where id=pg_temp.eid(4);
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(413))$$,
 '42501','MAID_REQUIRED','inactive cannot use general current attempt read');
update public.profiles set status='departed' where id=pg_temp.eid(4);
select throws_ok($$select public.start_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(513),1,pg_temp.eid(413),2,
 'execution-departed-denied',repeat('4',64))$$,'42501','MAID_REQUIRED','departed cannot use general start');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.eid(4),pg_temp.eid(413))$$,
 '42501','MAID_REQUIRED','departed cannot use general current attempt read');
select ok(not has_function_privilege('anon',signature,'execute')
 and not has_function_privilege('authenticated',signature,'execute')
 and has_function_privilege('service_role',signature,'execute')
 and not exists(select 1 from pg_catalog.pg_proc p,
   lateral pg_catalog.aclexplode(coalesce(p.proacl,pg_catalog.acldefault('f',p.proowner))) acl
   where p.oid=signature::regprocedure and acl.grantee=0 and acl.privilege_type='EXECUTE'),
 'service-only exact signature; no PUBLIC inherited EXECUTE: '||signature)
from unnest(array[
 'public.get_current_cleaning_attempt(uuid,uuid)',
 'public.start_cleaning_attempt(uuid,uuid,bigint,uuid,bigint,text,text)',
 'public.complete_cleaning_attempt_field_work(uuid,uuid,bigint,uuid,bigint,text,text)'
]) signature;
select * from finish();
rollback;
