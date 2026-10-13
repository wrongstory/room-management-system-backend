begin;
select no_plan();
create function pg_temp.mid(n integer) returns uuid language sql immutable as $$
 select ('44600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.mid(101)),(pg_temp.mid(102));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password) values
 (pg_temp.mid(1),pg_temp.mid(101),'자정 관리자','자정 관리자','자정 관리자','자정 관리자',0,'admin','active',false),
 (pg_temp.mid(2),pg_temp.mid(102),'자정 메이드','자정 메이드','자정 메이드','자정 메이드',0,'maid','active',false);
create function pg_temp.mid_target(n integer,day date,state public.cleaning_target_status default 'unassigned')
returns uuid language plpgsql as $$
declare room uuid;
begin
 select id into room from public.rooms order by room_number offset n limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
 effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.mid(300+n),room,'additional','manual_room_request','midnight-'||n,day,day,
 day::timestamp at time zone 'Asia/Seoul',(day::timestamp at time zone 'Asia/Seoul')+interval '15 hours',state,2,
 jsonb_build_object('code','standard'),16000,'{}',pg_temp.mid(1));
 if state in ('notified','draft_assigned') then
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
 values(pg_temp.mid(400+n),pg_temp.mid(300+n),pg_temp.mid(2),n,2,pg_temp.mid(1),
 case when state='notified' then (day::timestamp at time zone 'Asia/Seoul')-interval '1 day' end);
 end if;
 return pg_temp.mid(300+n);
end $$;
select pg_temp.mid_target(1,'2040-12-31');
select pg_temp.mid_target(2,'2040-12-31','notified');
select pg_temp.mid_target(3,'2041-01-01','notified');
select pg_temp.mid_target(4,'2040-12-31','draft_assigned');
select pg_temp.mid_target(n,'2040-12-31','notified') from generate_series(5,9) n;
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
 assignment_revision,template_snapshot,room_snapshot)
 select pg_temp.mid(500+n),pg_temp.mid(300+n),pg_temp.mid(400+n),pg_temp.mid(2),1,
 state::public.attempt_status,2,'{}','{}' from (values
 (5,'scheduled'),(6,'in_progress'),(7,'field_completed'),(8,'upload_pending'),(9,'submitted')) v(n,state);
-- Original work date is old, but immutable notice explicitly plans tomorrow.
select pg_temp.mid_target(10,'2040-12-31','notified');
insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,effective_at,after_state)
select pg_temp.mid(1),'자정 관리자','assignment.notified','cleaning_assignment',a.id,'2040-12-31 12:00+09',
 jsonb_build_object('assignmentId',a.id,'cleaningTargetId',a.cleaning_target_id,'maidProfileId',a.maid_profile_id,
 'revision',a.revision,'serviceDate','2041-01-02') from public.cleaning_assignments a where id=pg_temp.mid(410);
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),pg_temp.mid(310),'2041-01-01 00:00+09',2)->>'status',
 'notReady','old source with future notified planning day keeps its owner');
create temp table protected_before as select id,to_jsonb(t) value from public.cleaning_targets t
 where id in(pg_temp.mid(303),pg_temp.mid(306),pg_temp.mid(307),pg_temp.mid(308),pg_temp.mid(309));
-- Public scheduler enables the typed writer through replay_command. Direct
-- clock-controlled helpers must use that same mode to exercise real dispatch.
select set_config('app.notification_writer_mode','typed_v1',true);
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),pg_temp.mid(301),
 '2040-12-31 23:59:59+09',2)->>'status','notReady','dueAt expiry does not roll before KST midnight');
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),pg_temp.mid(301),
 '2040-12-31 15:00:00+00',2)->>'status','rolledOver','UTC15 equals KST00: exact year boundary');
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),pg_temp.mid(301),
 '2041-01-01 00:00+09',2)->>'reasonCode','ASSIGNMENT_VERSION_CONFLICT','old CAS cannot repeat rollover');
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),pg_temp.mid(301),
 '2041-01-01 00:00+09',3)->>'status','notReady','fresh CAS on the same day is a no-op');
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),pg_temp.mid(300+n),
 '2041-01-01 00:00+09',2)->>'status','rolledOver','unstarted notified/draft/scheduled rolls case '||n)
 from unnest(array[2,4,5]) n;
select is(private.rollover_assignment_midnight_at(pg_temp.mid(1),id,'2041-01-01 00:00+09',2)->>'status',
 case when id=pg_temp.mid(303) then 'notReady' else 'blocked' end,'next-day/physical workflow retained '||id)
 from protected_before;
select is(to_jsonb(t),b.value,'protected target is byte-equivalent '||t.id)
 from public.cleaning_targets t join protected_before b using(id);
select ok((select status='superseded' and started_at is null and execution_version=2
 from public.cleaning_attempts where id=pg_temp.mid(505)),'only scheduled attempt retires with execution CAS');
select ok((select not is_current and ended_at is not null from public.cleaning_assignments where id=pg_temp.mid(402)),
 'yesterday owner is released with immutable assignment history');
select ok((select is_current and ended_at is null from public.cleaning_assignments where id=pg_temp.mid(403)),
 'notified yesterday for today remains current');
select ok((select original_service_date='2040-12-31' and effective_service_date='2040-12-31'
 and available_from='2040-12-31 00:00+09' and due_at='2040-12-31 15:00+09' and carryover_count=1
 from public.cleaning_targets where id=pg_temp.mid(301)),'source schedule and fees are not shifted');
select is(private.assignment_current_planning_date(t,null),'2041-01-01'::date,'allocation date comes from rollover evidence')
 from public.cleaning_targets t where id=pg_temp.mid(301);
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.mid(302)
 and category='cleaning_assignment_rolled_over'),1,'typed rollover notice emitted exactly once');
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.mid(304)),0,
 'never-notified draft retirement sends no maid notification');
-- Multi-day recovery records each crossed day, not one misleading lump count.
select private.process_assignment_midnight_rollovers_at(pg_temp.mid(1),'2041-01-04 00:00+09');
select is(private.assignment_current_planning_date(t,null),'2041-01-04'::date,'missed days catch up to today')
 from public.cleaning_targets t where id=pg_temp.mid(301);
select is((select carryover_count from public.cleaning_targets where id=pg_temp.mid(301)),4,
 'each elapsed day is recorded once');
select is((select count(*)::int from public.cleaning_target_schedule_revisions
 where cleaning_target_id=pg_temp.mid(301) and reason_code='ROLLED_OVER_UNASSIGNED'),4,
 'rollover metadata count is supported by four immutable revisions');
select is(private.process_assignment_midnight_rollovers_at(pg_temp.mid(1),'2041-01-04 00:00+09'),'[]'::jsonb,
 'repeated catch-up creates no audit or notification');
-- A delayed worker has bounded transactions and catches up across repeated pages.
select pg_temp.mid_target(11,'2040-01-01');
create temp table budget_result as select private.process_assignment_midnight_rollovers_at(pg_temp.mid(1),'2041-01-04 00:00+09') result;
select is((select jsonb_array_length(result) from budget_result),100,'one catch-up invocation writes at most 100 daily transitions');
select private.process_assignment_midnight_rollovers_at(pg_temp.mid(1),'2041-01-04 00:00+09') from generate_series(1,4);
select is(private.assignment_current_planning_date(t,null),'2041-01-04'::date,'rotating bounded calls eventually reach today')
 from public.cleaning_targets t where id=pg_temp.mid(311);
select is((select carryover_count from public.cleaning_targets where id=pg_temp.mid(311)),369,
 'leap-year/month/year catch-up has exact elapsed-day count');
select throws_ok($$select private.rollover_assignment_midnight_at(pg_temp.mid(2),pg_temp.mid(301),
 '2041-01-05 00:00+09',6)$$,'42501','ADMIN_REQUIRED','maid cannot run privileged rollover');
select ok(not has_function_privilege(role,'private.rollover_assignment_midnight_at(uuid,uuid,timestamptz,bigint)','execute'),
 'no direct rollover grant for '||role) from unnest(array['anon','authenticated','service_role']) role;
select * from finish();
rollback;
