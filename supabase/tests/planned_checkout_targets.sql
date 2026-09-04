begin;
select no_plan();
insert into auth.users(id) values ('a1000000-0000-4000-8000-000000000001'),('a1000000-0000-4000-8000-000000000002');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password) values
('a2000000-0000-4000-8000-000000000001','a1000000-0000-4000-8000-000000000001','계획 관리자','계획 관리자','계획 관리자','계획 관리자',0,'admin','active',false),
('a2000000-0000-4000-8000-000000000002','a1000000-0000-4000-8000-000000000002','계획 메이드','계획 메이드','계획 메이드','계획 메이드',0,'maid','active',false);
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select id,'checkout',1,'published',60,'[]',now(),'a2000000-0000-4000-8000-000000000001' from public.room_types;
create temp table plans(label text primary key,reservation_id uuid,target_id uuid,room_id uuid,assignment_id uuid,result jsonb);
create function pg_temp.make_plan(p_label text,p_out timestamptz,p_in timestamptz default null) returns uuid language plpgsql as $$
declare room public.rooms%rowtype; rid uuid:=gen_random_uuid(); tid uuid; response jsonb;
begin
 select * into room from public.rooms r where not exists(select 1 from plans p where p.room_id=r.id) order by room_number limit 1;
 insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
 values(room.id,'verified',1,'TEST','a2000000-0000-4000-8000-000000000001',now());
 response:=public.create_reservation('a2000000-0000-4000-8000-000000000001',rid,room.id,
   coalesce(p_in,((p_out at time zone 'Asia/Seoul')::date-1 + time '16:00') at time zone 'Asia/Seoul'),
   p_out,2,null,room.state_version,'planning-create-'||p_label,repeat('a',64));
 select planned_cleaning_target_id into tid from public.checkout_cleaning_obligations where reservation_id=rid;
 insert into plans values(p_label,rid,tid,room.id,null,response);
 return tid;
end; $$;
create function pg_temp.assign_plan(p_label text) returns void language plpgsql as $$
declare p plans%rowtype; t public.cleaning_targets%rowtype; v uuid; w date; response jsonb;
begin
 select * into p from plans where label=p_label;
 select * into t from public.cleaning_targets where id=p.target_id;
 w:=t.effective_service_date-(extract(isodow from t.effective_service_date)::int-1);
 select id into v from public.availability_versions where maid_profile_id='a2000000-0000-4000-8000-000000000002' and week_start=w and is_current;
 if v is null then
  insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at)
  values('a2000000-0000-4000-8000-000000000002',w,1,now()) returning id into v;
  insert into public.availability_days(availability_version_id,work_date,available)
  select v,w+i,true from generate_series(0,6) i;
 end if;
 response:=public.save_cleaning_assignment_draft('a2000000-0000-4000-8000-000000000001',t.id,
 'a2000000-0000-4000-8000-000000000002',(select count(*)::int+1 from public.cleaning_assignments),t.assignment_version,
 'planning-draft-'||p_label||'-'||t.assignment_version,repeat('b',64));
 update plans set assignment_id=(response->>'assignmentId')::uuid where label=p_label;
end; $$;
create function pg_temp.notify_plan(p_label text,p_at timestamptz) returns jsonb language plpgsql as $$
declare t public.cleaning_targets%rowtype;
begin
 select * into t from public.cleaning_targets where id=(select target_id from plans where label=p_label);
 return private.commit_and_notify_assignments_at('a2000000-0000-4000-8000-000000000001',
 t.effective_service_date,private.assignment_commit_impact_at(t.effective_service_date,p_at)->>'impactFingerprint',
 jsonb_build_array(jsonb_build_object('cleaningTargetId',t.id,'expectedAssignmentVersion',t.assignment_version,'expectedAvailabilityVersion',1)),
 'planning-notify-'||p_label,repeat('c',64),p_at);
end; $$;

select pg_temp.make_plan('notified','2034-10-02 11:00+09');
select is((select count(*)::int from public.cleaning_targets where reservation_id=(select reservation_id from plans where label='notified')),1,'A reservation creates exactly one planned target');
select ok((select status='private' and current_cleaning_target_id is null and planned_cleaning_target_id is not null from public.checkout_cleaning_obligations where reservation_id=(select reservation_id from plans where label='notified')),'planning does not materialize the private obligation');
select is(public.create_reservation('a2000000-0000-4000-8000-000000000001',(select reservation_id from plans where label='notified'),(select room_id from plans where label='notified'),'2034-10-01 16:00+09','2034-10-02 11:00+09',2,null,1,'planning-create-notified',repeat('a',64)),(select result from plans where label='notified'),'reservation retry replays the same target-bearing transaction');
select pg_temp.assign_plan('notified');
select ok(exists(select 1 from private.assignment_commit_candidates_at('2034-10-02','2034-10-01 09:00+09') where target_id=(select target_id from plans where label='notified') and reason_code is null),'tomorrow scheduled private plan is committable');
select pg_temp.notify_plan('notified','2034-10-01 09:00+09');
select is((select count(*)::int from private.notification_outbox),1,'one notification outbox item');
select is((select count(*)::int from public.cleaning_attempts),0,'notify never creates attempts');

select ok(not ('CLEANING_REQUIRED'=any(private.room_block_reason_codes(
 (select room_id from plans where label='notified'),'2034-09-30 09:00+09',false,false))),'private planned target does not activate room cleaning-required projection');
select throws_ok($test$ insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,assignment_revision,status,template_snapshot,room_snapshot)
select target_id,assignment_id,'a2000000-0000-4000-8000-000000000002',1,2,'superseded','{}','{}' from plans where label='notified' $test$,'23514','CHECKOUT_NOT_MATERIALIZED','superseded label cannot bypass pre-checkout attempt creation guard');

select throws_ok($test$ insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,assignment_revision,template_snapshot,room_snapshot)
select target_id,assignment_id,'a2000000-0000-4000-8000-000000000002',1,2,'{}','{}' from plans where label='notified' $test$,'23514','CHECKOUT_NOT_MATERIALIZED','B checkout plan cannot create any attempt');
select throws_ok($test$ insert into public.room_pin_access_leases(room_id,reservation_id,cleaning_target_id,assignment_id,attempt_id,pin_version,issued_to,issued_at,expires_at)
select room_id,reservation_id,target_id,assignment_id,gen_random_uuid(),1,'a2000000-0000-4000-8000-000000000002',now(),now()+interval '1 hour' from plans where label='notified' $test$,'23514','CHECKOUT_NOT_MATERIALIZED','B checkout plan cannot issue/reveal PIN');

select throws_ok($test$ select public.change_reservation('a2000000-0000-4000-8000-000000000001',reservation_id,room_id,'2034-10-01 16:00+09','2034-10-02 12:00+09',2,'keep',null,1,'TEST','planning-change-notified',repeat('d',64)) from plans where label='notified' $test$,'23514','CLEANING_WORKFLOW_REPLAN_REQUIRED','E notified plan requires explicit replan');
select public.process_due_reservation_transitions('a2000000-0000-4000-8000-000000000001','2034-10-02 11:00+09','planning-scheduler-1',repeat('e',64));
select ok((select current_cleaning_target_id=planned_cleaning_target_id and status='materialized' from public.checkout_cleaning_obligations where reservation_id=(select reservation_id from plans where label='notified')),'C scheduled checkout promotes exactly the same identity');
select ok((select is_current and notified_at is not null from public.cleaning_assignments where id=(select assignment_id from plans where label='notified')),'C original notified assignment revision is preserved');
select public.process_due_reservation_transitions('a2000000-0000-4000-8000-000000000001','2034-10-02 11:00+09','planning-scheduler-1',repeat('e',64));
select is((select count(*)::int from public.cleaning_targets where reservation_id=(select reservation_id from plans where label='notified')),1,'scheduler retry adds no target');
select is((select count(*)::int from public.cleaning_attempts),0,'C promotion leaves attempt activation to #28');

select pg_temp.make_plan('unassigned','2035-10-02 11:00+09');
select public.change_reservation('a2000000-0000-4000-8000-000000000001',reservation_id,room_id,'2035-10-01 16:00+09','2035-10-02 12:00+09',2,'keep',null,1,'TEST','planning-change-unassigned',repeat('d',64)) from plans where label='unassigned';
select ok((select available_from='2035-10-02 12:00+09'::timestamptz and assignment_version=2 from public.cleaning_targets where id=(select target_id from plans where label='unassigned')),'E unassigned schedule changes with CAS revision');

select pg_temp.make_plan('draft','2035-10-02 11:00+09');
select pg_temp.assign_plan('draft');
select public.change_reservation('a2000000-0000-4000-8000-000000000001',reservation_id,room_id,'2035-10-01 16:00+09','2035-10-02 12:00+09',2,'keep',null,1,'TEST','planning-change-draft',repeat('d',64)) from plans where label='draft';
select is((select reason_code from private.assignment_commit_candidates_at('2035-10-02','2035-10-01 09:00+09') where target_id=(select target_id from plans where label='draft')),'ASSIGNMENT_DRAFT_STALE_SCHEDULE','E old draft snapshot is explicitly stale');
select pg_temp.assign_plan('draft');
select pg_temp.notify_plan('draft','2035-10-01 09:00+09');
select public.cancel_reservation('a2000000-0000-4000-8000-000000000001',reservation_id,2,'TEST','planning-cancel-draft',repeat('f',64)) from plans where label='draft';
select ok((select status='cancelled' from public.cleaning_targets where id=(select target_id from plans where label='draft')),'F planned target soft cancelled');
select is((select count(*)::int from public.cleaning_assignments where cleaning_target_id=(select target_id from plans where label='draft') and is_current),0,'F no ghost current assignment');
select is((select count(*)::int from public.notifications where cleaning_target_id=(select target_id from plans where label='draft') and category='cleaning_assignment_revoked'),1,'F cancellation retains notification and adds revocation');
select ok((select planned_cleaning_target_id=(select target_id from plans where label='draft') from public.checkout_cleaning_obligations where reservation_id=(select reservation_id from plans where label='draft')),'cancelled planned identity preserved');

select pg_temp.make_plan('manual',((now() at time zone 'Asia/Seoul')::date+1+time '11:00') at time zone 'Asia/Seoul',date_trunc('minute',now())-interval '1 day');
update public.reservations set actual_check_in_at=check_in_at where id=(select reservation_id from plans where label='manual');
select pg_temp.assign_plan('manual');
select pg_temp.notify_plan('manual',now());
select public.manual_checkout_reservation('a2000000-0000-4000-8000-000000000001',reservation_id,1,'TEST',date_trunc('minute',now()),'planning-manual-1',repeat('9',64)) from plans where label='manual';
select is((select count(*)::int from public.cleaning_targets where reservation_id=(select reservation_id from plans where label='manual')),1,'D early manual checkout reuses one target');
select ok((select not is_current from public.cleaning_assignments where id=(select assignment_id from plans where label='manual')),'D old assignment immutable revision closed');
select ok((select effective_service_date=(now() at time zone 'Asia/Seoul')::date and original_service_date=(now() at time zone 'Asia/Seoul')::date+1 from public.cleaning_targets where id=(select target_id from plans where label='manual')),'D original plan retained and actual service date updated');
select is((select count(*)::int from public.cleaning_target_schedule_revisions where cleaning_target_id=(select target_id from plans where label='manual') and reason_code='MANUAL_CHECKOUT'),1,'D one access schedule revision');
select is((select count(*)::int from public.cleaning_attempts),0,'D no attempt creation before #28 activation');

-- Boundary fixture only: #28's activation command is deliberately not implemented.
insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,assignment_revision,template_snapshot,room_snapshot)
select t.id,a.id,a.maid_profile_id,1,a.revision,t.template_snapshot,t.room_type_snapshot
from public.cleaning_targets t join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
where t.id=(select target_id from plans where label='manual');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=(select target_id from plans where label='manual')),1,'materialized actual checkout permits future #28 activation boundary');
select throws_ok($test$ insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,assignment_revision,template_snapshot,room_snapshot)
select t.id,a.id,a.maid_profile_id,1,a.revision,t.template_snapshot,t.room_type_snapshot
from public.cleaning_targets t join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
where t.id=(select target_id from plans where label='manual') $test$,'23505',null,'same target attempt number remains exactly-once');
select ok(not has_function_privilege('anon','private.ensure_planned_checkout_target(uuid)','EXECUTE')
 and not has_function_privilege('authenticated','private.ensure_planned_checkout_target(uuid)','EXECUTE'),
 'clients cannot invoke internal planning helper');
-- #27 재배정은 planned target/obligation을 materialize하지 않는다.
select pg_temp.make_plan('prestart','2036-10-02 11:00+09');
select pg_temp.assign_plan('prestart');
select pg_temp.notify_plan('prestart','2036-10-01 09:00+09');
select lives_ok($test$ select public.change_cleaning_assignment_prestart(
 'a2000000-0000-4000-8000-000000000001',target_id,assignment_id,2,
 'a2000000-0000-4000-8000-000000000002',100,'SEQUENCE_CHANGED','planning-prestart-change',repeat('8',64))
 from plans where label='prestart' $test$,'future notified checkout permits prestart revision');
select is((select count(*)::int from public.cleaning_targets where reservation_id=(select reservation_id from plans where label='prestart')),1,'prestart never replaces planned target identity');
select ok((select status='private' and current_cleaning_target_id is null
 and planned_cleaning_target_id=(select target_id from plans where label='prestart')
 from public.checkout_cleaning_obligations where reservation_id=(select reservation_id from plans where label='prestart')),'prestart retains private obligation/current null');
select ok((select not is_current from public.cleaning_assignments where id=(select assignment_id from plans where label='prestart')),'old notified revision preserved/closed');
update plans p set assignment_id=a.id from public.cleaning_assignments a where p.label='prestart' and a.cleaning_target_id=p.target_id and a.is_current;
select throws_ok($test$ select public.change_cleaning_assignment_prestart(
 'a2000000-0000-4000-8000-000000000001',target_id,assignment_id,3,
 'a2000000-0000-4000-8000-000000000002',100,'SCHEDULE_CHANGED','planning-prestart-time',repeat('7',64),'2036-10-02 12:00+09')
 from plans where label='prestart' $test$,'23514','ASSIGNMENT_SCHEDULE_INVALID','prestart cannot override checkout source time');
select throws_ok($test$ insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,assignment_revision,template_snapshot,room_snapshot)
select target_id,assignment_id,'a2000000-0000-4000-8000-000000000002',1,3,'{}','{}' from plans where label='prestart' $test$,'23514','CHECKOUT_NOT_MATERIALIZED','reassigned plan cannot start attempt');
select throws_ok($test$ insert into public.room_pin_access_leases(room_id,reservation_id,cleaning_target_id,assignment_id,attempt_id,pin_version,issued_to,issued_at,expires_at)
select room_id,reservation_id,target_id,assignment_id,gen_random_uuid(),1,'a2000000-0000-4000-8000-000000000002',now(),now()+interval '1 hour'
from plans where label='prestart' $test$,'23514','CHECKOUT_NOT_MATERIALIZED','reassigned plan cannot issue PIN');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=(select target_id from plans where label='prestart')),0,'prestart creates no attempt');
set constraints all immediate;
select * from finish();
rollback;
