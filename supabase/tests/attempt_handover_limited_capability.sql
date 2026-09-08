begin;
select no_plan();
create function pg_temp.bid(n integer) returns uuid language sql immutable as $$
 select ('7b000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
create temp table b_clock as select date_trunc('minute',clock_timestamp()) as at_time;
create function pg_temp.btime() returns timestamptz language sql stable as $$ select at_time from b_clock $$;
insert into auth.users(id) select pg_temp.bid(100+n) from generate_series(1,12) n;
insert into auth.users(id) values(pg_temp.bid(113));
select public.bootstrap_first_developer_profile(pg_temp.bid(13),pg_temp.bid(113),'인계 개발자','인계 개발자','0013','handover-developer-hash','handover-developer-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.bid(n),pg_temp.bid(100+n),'handover-'||n,'handover-'||n,'handover-'||n,'handover-'||n,0,
 case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,12) n;
insert into auth.sessions(id,user_id) select pg_temp.bid(200+n),pg_temp.bid(100+n) from generate_series(1,12) n;
create function pg_temp.bfixture(n integer,maid integer,p_date date default null,p_started boolean default true,p_null_due boolean default false)
returns void language plpgsql as $$
declare room uuid; day date:=coalesce(p_date,(pg_temp.btime() at time zone 'Asia/Seoul')::date);
begin
 select id into room from public.rooms order by room_number offset n limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.bid(300+n),room,'additional','manual_room_request','handover-'||n,day,day,
  day::timestamp at time zone 'Asia/Seoul',case when not p_null_due then (day+1)::timestamp at time zone 'Asia/Seoul'-interval '1 second' end,
  'notified',2,'{}',10000,'{}',pg_temp.bid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.bid(400+n),pg_temp.bid(300+n),pg_temp.bid(maid),n,2,pg_temp.btime(),pg_temp.bid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot)
 values(pg_temp.bid(500+n),pg_temp.bid(300+n),pg_temp.bid(400+n),pg_temp.bid(maid),1,'scheduled',2,'{}',jsonb_build_object('roomId',room));
 if p_started then
  perform private.execute_cleaning_attempt_at(pg_temp.bid(maid),pg_temp.bid(500+n),1,pg_temp.bid(400+n),2,
    'handover-fixture-start-'||n,repeat('a',64),'start',pg_temp.btime());
 end if;
end; $$;
select pg_temp.bfixture(1,2);
select pg_temp.bfixture(2,3);
select pg_temp.bfixture(3,4);
select pg_temp.bfixture(4,5,(pg_temp.btime() at time zone 'Asia/Seoul')::date-1,false);
select pg_temp.bfixture(5,6,null,false);
select pg_temp.bfixture(6,7);
select pg_temp.bfixture(7,8);
select pg_temp.bfixture(8,9);
create function pg_temp.bmanage(n integer,action text,p_version bigint default 2,p_profile_version bigint default 1,
 p_key text default null,p_hash text default null,p_at timestamptz default null,p_payload jsonb default '{}')
returns jsonb language sql as $$
 select private.manage_cleaning_attempt_lifecycle_at(pg_temp.bid(1),pg_temp.bid(201),pg_temp.bid(500+n),p_version,
  pg_temp.bid(400+n),2,p_profile_version,action,p_payload,
  case action when 'allow_finish' then 'DEACTIVATION_FINISH_CURRENT' when 'allow_upload' then 'DEACTIVATION_UPLOAD_ONLY'
    when 'expire_scheduled' then 'SCHEDULE_EXPIRED' else case when (p_payload->>'deactivateOld')::boolean then 'DEACTIVATION_HANDOVER' else 'ADMIN_HANDOVER' end end,
  coalesce(p_key,'handover-'||action||'-'||n),coalesce(p_hash,repeat('a',64)),coalesce(p_at,pg_temp.btime())) $$;
create function pg_temp.bcomplete(n integer,maid integer,p_key text default null,p_at timestamptz default null)
returns jsonb language sql as $$
 select private.complete_limited_attempt_at(pg_temp.bid(maid),pg_temp.bid(200+maid),pg_temp.bid(500+n),2,pg_temp.bid(400+n),2,
  coalesce(p_key,'limited-complete-'||n),repeat('a',64),coalesce(p_at,pg_temp.btime()+interval '1 minute')) $$;
create function pg_temp.bledgers() returns jsonb language sql stable as $$
 select jsonb_build_object('profiles',(select jsonb_agg(p order by id) from public.profiles p),
  'attempts',(select jsonb_agg(a order by id) from public.cleaning_attempts a),
  'targets',(select jsonb_agg(t order by id) from public.cleaning_targets t),
  'assignments',(select jsonb_agg(s order by id) from public.cleaning_assignments s),
  'reservations',(select jsonb_agg(r order by id) from public.reservations r),
  'obligations',(select jsonb_agg(o order by id) from public.checkout_cleaning_obligations o),
  'schedules',(select jsonb_agg(s order by id) from public.cleaning_target_schedule_revisions s),
  'audit',(select jsonb_agg(e order by id) from public.audit_events e),
  'receipts',(select jsonb_agg(c order by id) from private.command_executions c),
  'grants',(select jsonb_agg(g order by id) from private.attempt_capability_grants g),
  'revocations',(select jsonb_agg(r order by capability_id) from private.attempt_capability_revocations r),
  'notices',(select jsonb_agg(n order by id) from public.notifications n),
  'outbox',(select jsonb_agg(o order by id) from private.notification_outbox o)) $$;
create temp table b_result(label text primary key,value jsonb);
select is((public.get_cleaning_attempt_lifecycle_impact(pg_temp.bid(1),pg_temp.bid(201),pg_temp.bid(401))->>'profileVersion')::int,1,'admin reads exact lifecycle CAS');
select throws_ok($$select public.get_cleaning_attempt_lifecycle_impact(pg_temp.bid(2),pg_temp.bid(202),pg_temp.bid(401))$$,
 '42501','ADMIN_REQUIRED','maid cannot inspect administrator lifecycle view');
select throws_ok($$select public.get_cleaning_attempt_lifecycle_impact(pg_temp.bid(1),pg_temp.bid(202),pg_temp.bid(401))$$,
 '42501','SESSION_REVOKED','session of another actor cannot authorize admin command');
select throws_ok($$select pg_temp.bmanage(1,'allow_finish',1)$$,'40001','ATTEMPT_VERSION_CONFLICT','lifecycle requires execution CAS');
select throws_ok($$select pg_temp.bmanage(1,'allow_finish',2,99)$$,'40001','ACCOUNT_VERSION_CONFLICT','lifecycle requires profile CAS');
insert into b_result values('finish-grant',pg_temp.bmanage(1,'allow_finish'));
select is((select status::text from public.profiles where id=pg_temp.bid(2)),'deactivation_pending','one job finish enters pending status');
select is((select account_lifecycle_version::int from public.profiles where id=pg_temp.bid(2)),2,'pending transition increments lifecycle version');
select is(pg_temp.bmanage(1,'allow_finish'),(select value from b_result where label='finish-grant'),'lost grant response replays despite changed profile CAS');
select is((select count(*)::int from private.attempt_capability_grants where attempt_id=pg_temp.bid(501)),1,'grant replay creates one immutable grant');
select is((select expires_at-issued_at from private.attempt_capability_grants where attempt_id=pg_temp.bid(501)),interval '2 hours','finish grant hard TTL is two hours');
select is(pg_temp.bmanage(1,'allow_finish',2,2,'handover-new-key')#>>'{capability,expiresAt}',
 (select value#>>'{capability,expiresAt}' from b_result where label='finish-grant'),'different key cannot renew capability TTL');
select ok(exists(select 1 from auth.sessions where id=pg_temp.bid(202)),'limited transition preserves existing Auth session');
select throws_ok($$select public.get_current_cleaning_attempt(pg_temp.bid(2),pg_temp.bid(401))$$,'42501','MAID_REQUIRED','general active-only query remains denied');
select throws_ok($$select public.start_cleaning_attempt(pg_temp.bid(2),pg_temp.bid(501),2,pg_temp.bid(401),2,'no-general',repeat('a',64))$$,
 '42501','MAID_REQUIRED','pending user cannot regain general start permission');
select lives_ok($$select public.get_limited_cleaning_attempt(pg_temp.bid(2),pg_temp.bid(202),pg_temp.bid(501),2)$$,'valid session sees only its limited attempt');
select throws_ok($$select public.get_limited_cleaning_attempt(pg_temp.bid(3),pg_temp.bid(203),pg_temp.bid(501),2)$$,
 '42501','CAPABILITY_ACCESS_REQUIRED','other maid cannot use known attempt ID as credential');
select throws_ok($$select pg_temp.bcomplete(1,2,'handover-expired',pg_temp.btime()+interval '2 hours')$$,
 '42501','CAPABILITY_ACCESS_REQUIRED','finish at exact expiry is rejected');
select throws_ok($$update private.attempt_capability_grants set expires_at=expires_at+interval '1 day'$$,
 '55000','ATTEMPT_CAPABILITY_IMMUTABLE','grant expiration cannot be extended by UPDATE');
select throws_ok($$delete from private.attempt_capability_grants$$,'55000','ATTEMPT_CAPABILITY_IMMUTABLE','grant ledger cannot be deleted');
insert into b_result values('complete',pg_temp.bcomplete(1,2));
select is((select status::text from public.cleaning_attempts where id=pg_temp.bid(501)),'field_completed','limited finish physically completes without photo requirement');
select is((select status::text from public.profiles where id=pg_temp.bid(2)),'upload_only','limited finish atomically enters upload_only');
select is((select value#>>'{capability,kind}' from b_result where label='complete'),'upload_submit','completion grants exact attempt upload/submit contract only');
select is((select expires_at-issued_at from private.attempt_capability_grants where attempt_id=pg_temp.bid(501) and kind='upload_submit'),interval '24 hours','upload TTL is exactly 24 hours');
select is(pg_temp.bcomplete(1,2),(select value from b_result where label='complete'),'lost limited completion response replays in upload_only');
select is((select count(*)::int from private.attempt_capability_revocations),1,'finish capability is revoked exactly once');
select throws_ok($$update private.attempt_capability_revocations set revoked_at=clock_timestamp()$$,
 '55000','ATTEMPT_CAPABILITY_IMMUTABLE','revocation is immutable');
select throws_ok($$select pg_temp.bcomplete(1,2,'complete-different-key')$$,'42501','CAPABILITY_ACCESS_REQUIRED','new command cannot consume revoked finish capability');
select is((select count(*)::int from public.cleaning_submissions),0,'limited finish does not submit evidence');
select is((select count(*)::int from public.earnings),0,'limited finish does not create earnings');
select is((select count(*)::int from public.room_pin_access_leases),0,'limited grant creates no PIN lease');
select is((select count(*)::int from public.submission_photos),0,'limited grant does not invent uploaded evidence');
insert into b_result values('ledger',pg_temp.bledgers());
select throws_ok($$select pg_temp.bmanage(5,'expire_scheduled',1)$$,'55000','CLEANING_WINDOW_NOT_EXPIRED','unexpired scheduled cannot be retired');
select is(pg_temp.bledgers(),(select value from b_result where label='ledger'),'rejected expiry changes no business/audit/outbox/capability ledger');
insert into b_result values('expired',pg_temp.bmanage(4,'expire_scheduled',1));
select is((select status::text from public.cleaning_attempts where id=pg_temp.bid(504)),'superseded','never-started expired attempt preserved as superseded');
select ok((select started_at is null and field_completed_at is null and execution_version=2 from public.cleaning_attempts where id=pg_temp.bid(504)),
 'expiry records no physical work and advances CAS');
select is((select status::text from public.cleaning_targets where id=pg_temp.bid(304)),'unassigned','expiry reopens next-day assignment');
select ok((select not is_current from public.cleaning_assignments where id=pg_temp.bid(404)),'expired current assignment ends without DELETE');
select is((select original_service_date<effective_service_date from public.cleaning_targets where id=pg_temp.bid(304)),true,'rollover preserves original service date');

-- Give a different active maid explicit availability for a genuine handover.
insert into public.availability_versions(id,maid_profile_id,week_start,version,is_current,submitted_at)
values(pg_temp.bid(800),pg_temp.bid(10),(pg_temp.btime() at time zone 'Asia/Seoul')::date-(extract(isodow from pg_temp.btime() at time zone 'Asia/Seoul')::int-1),1,true,pg_temp.btime());
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+n,true from public.availability_versions v cross join generate_series(0,6) n where v.id=pg_temp.bid(800);
create function pg_temp.bhandover_payload(p_deactivate boolean default false) returns jsonb language sql stable as $$
 select jsonb_build_object('maidProfileId',pg_temp.bid(10),'sequenceNumber',50,'serviceDate',(pg_temp.btime() at time zone 'Asia/Seoul')::date,
  'availableFrom',date_trunc('day',pg_temp.btime() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul',
  'dueAt',(((pg_temp.btime() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul')-interval '1 second','deactivateOld',p_deactivate) $$;
insert into b_result values('handover',pg_temp.bmanage(2,'interrupt_handover',2,1,null,null,null,pg_temp.bhandover_payload()));
select is((select status::text from public.cleaning_attempts where id=pg_temp.bid(502)),'interrupted','old attempt interrupted atomically');
select is((select value#>>'{nextAttempt,status}' from b_result where label='handover'),'scheduled','new owner receives scheduled not in-progress attempt');
select is((select status::text from public.profiles where id=pg_temp.bid(3)),'active','normal handover does not silently deactivate old maid');
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.bid(302)),2,'handover preserves old and creates exactly one new attempt');
select is((select count(*)::int from private.attempt_handover_events),1,'handover provenance append is atomic');
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.bid(302)),2,'old/new notifications created exactly once');
select is((select count(*)::int from private.notification_outbox o join public.notifications n on n.id=o.notification_id where n.cleaning_target_id=pg_temp.bid(302)),2,'notifications and outbox commit together');
select is((select value#>>'{capability,kind}' from b_result where label='handover'),'evidence_upload','old attempt receives evidence-only rights');
select throws_ok($$select private.live_attempt_capability(pg_temp.bid(3),pg_temp.bid(502),2,'submit',pg_temp.btime())$$,
 '42501','CAPABILITY_ACCESS_REQUIRED','old partial evidence cannot submit current result');
select throws_ok($$select pg_temp.bcomplete(2,3)$$,'42501','CAPABILITY_ACCESS_REQUIRED','old handover attempt cannot complete');
select is(pg_temp.bmanage(2,'interrupt_handover',2,1,null,null,null,pg_temp.bhandover_payload()),
 (select value from b_result where label='handover'),'handover replay does not duplicate next attempt');
select lives_ok($$select public.get_limited_cleaning_attempt(pg_temp.bid(3),pg_temp.bid(203),pg_temp.bid(502),2)$$,'active old maid may inspect evidence-only grant');
select throws_ok($$delete from private.attempt_handover_events$$,'55000','ATTEMPT_CAPABILITY_IMMUTABLE','handover chain cannot be deleted');
update public.profiles set status='inactive' where id=pg_temp.bid(3);
update public.profiles set status='active' where id=pg_temp.bid(3);
select throws_ok($$select public.get_limited_cleaning_attempt(pg_temp.bid(3),pg_temp.bid(203),pg_temp.bid(502),2)$$,
 '42501','CAPABILITY_ACCESS_REQUIRED','account restoration never resurrects revoked evidence grant');
delete from auth.sessions where id=pg_temp.bid(202);
select throws_ok($$select pg_temp.bcomplete(1,2)$$,'42501','SESSION_REVOKED','revoked session cannot replay completed command');

select ok(not exists(select 1 from private.attempt_capability_grants g where to_jsonb(g)::text like '%'||pg_temp.bid(202)::text||'%'),
 'session ID is not persisted in capability ledger');
select ok(not exists(select 1 from public.audit_events e where e.after_state::text like '%'||pg_temp.bid(202)::text||'%'),
 'session ID is absent from domain audit');
select ok(not exists(select 1 from private.command_executions c where to_jsonb(c)::text like '%'||pg_temp.bid(202)::text||'%'),
 'session ID is absent from command receipts');
select ok(not has_table_privilege(role,tab,'SELECT,INSERT,UPDATE,DELETE'),'private ledger inaccessible to '||role||' '||tab)
from unnest(array['anon','authenticated','service_role']) role cross join unnest(array[
 'private.attempt_capability_grants','private.attempt_capability_revocations','private.attempt_handover_events']) tab;
select ok(not has_function_privilege(role,sig,'EXECUTE'),'privileged RPC denied to '||role||' '||sig)
from unnest(array['anon','authenticated']) role cross join unnest(array[
 'public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid)',
 'public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint)',
 'public.manage_cleaning_attempt_lifecycle(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text)',
 'public.complete_limited_cleaning_attempt_field_work(uuid,uuid,uuid,bigint,uuid,bigint,text,text)']) sig;
select ok(has_function_privilege('service_role',sig,'EXECUTE'),'service RPC callable '||sig)
from unnest(array['public.get_cleaning_attempt_lifecycle_impact(uuid,uuid,uuid)',
 'public.get_limited_cleaning_attempt(uuid,uuid,uuid,bigint)',
 'public.manage_cleaning_attempt_lifecycle(uuid,uuid,uuid,bigint,uuid,bigint,bigint,text,jsonb,text,text,text)',
 'public.complete_limited_cleaning_attempt_field_work(uuid,uuid,uuid,bigint,uuid,bigint,text,text)']) sig;
-- Nested A -> B -> C retains each interrupted history, but only the live leaf
-- blocks reassignment. A later expiry must not strand the target forever.
select private.execute_cleaning_attempt_at(pg_temp.bid(10),
 (select (value#>>'{nextAttempt,attemptId}')::uuid from b_result where label='handover'),1,
 (select (value#>>'{nextAttempt,assignmentId}')::uuid from b_result where label='handover'),3,
 'nested-start-child',repeat('d',64),'start',pg_temp.btime());
insert into public.availability_versions(id,maid_profile_id,week_start,version,is_current,submitted_at)
values(pg_temp.bid(801),pg_temp.bid(11),(pg_temp.btime() at time zone 'Asia/Seoul')::date-(extract(isodow from pg_temp.btime() at time zone 'Asia/Seoul')::int-1),1,true,pg_temp.btime());
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+n,true from public.availability_versions v cross join generate_series(0,6) n where v.id=pg_temp.bid(801);
insert into b_result values('nested',private.manage_cleaning_attempt_lifecycle_at(pg_temp.bid(1),pg_temp.bid(201),
 (select (value#>>'{nextAttempt,attemptId}')::uuid from b_result where label='handover'),2,
 (select (value#>>'{nextAttempt,assignmentId}')::uuid from b_result where label='handover'),3,1,
 'interrupt_handover',pg_temp.bhandover_payload()||jsonb_build_object('maidProfileId',pg_temp.bid(11),'sequenceNumber',51),
 'ADMIN_HANDOVER','nested-handover-child',repeat('d',64),pg_temp.btime()));
select is((select count(*)::int from public.cleaning_attempts a where cleaning_target_id=pg_temp.bid(302)
 and private.attempt_blocks_assignment(a)),1,'nested history leaves exactly one live blocking attempt');
select is((select count(*)::int from private.attempt_handover_events),2,'nested provenance has two immutable forward links');
select throws_ok($$insert into private.attempt_handover_events(previous_attempt_id,next_attempt_id,actor_profile_id,reason_code,occurred_at)
 values(pg_temp.bid(503),pg_temp.bid(506),pg_temp.bid(1),'ADMIN_HANDOVER',pg_temp.btime())$$,
 '23514','HANDOVER_IDENTITY_INVALID','wrong target or non-interrupted proof cannot hide live work');
insert into b_result values('nested-expiry',private.manage_cleaning_attempt_lifecycle_at(pg_temp.bid(1),pg_temp.bid(201),
 (select (value#>>'{nextAttempt,attemptId}')::uuid from b_result where label='nested'),1,
 (select (value#>>'{nextAttempt,assignmentId}')::uuid from b_result where label='nested'),4,1,
 'expire_scheduled','{}','SCHEDULE_EXPIRED','nested-expire-leaf',repeat('d',64),
 ((pg_temp.btime() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul'));
select is((select count(*)::int from public.cleaning_attempts a where cleaning_target_id=pg_temp.bid(302)
 and private.attempt_blocks_assignment(a)),0,'superseded leaf frees nested target without deleting prior evidence');
select is((select status::text from public.cleaning_targets where id=pg_temp.bid(302)),'unassigned','nested expiry reopens target');
select public.save_cleaning_assignment_draft(pg_temp.bid(1),pg_temp.bid(302),pg_temp.bid(11),51,5,'nested-new-draft',repeat('e',64));
insert into public.availability_versions(id,maid_profile_id,week_start,version,is_current,submitted_at)
select pg_temp.bid(802),pg_temp.bid(11),d-(extract(isodow from d)::int-1),1,true,pg_temp.btime()
from (select (pg_temp.btime() at time zone 'Asia/Seoul')::date+1 d) x
where not exists(select 1 from public.availability_versions where maid_profile_id=pg_temp.bid(11) and week_start=d-(extract(isodow from d)::int-1));
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+n,true from public.availability_versions v cross join generate_series(0,6) n where v.id=pg_temp.bid(802);
select is((select reason_code from private.assignment_commit_candidates_at((pg_temp.btime() at time zone 'Asia/Seoul')::date+1,
 ((pg_temp.btime() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul') where target_id=pg_temp.bid(302)),null::text,
 'new draft is committable despite proven interrupted ancestors');
select private.commit_and_notify_assignments_at(pg_temp.bid(1),t.effective_service_date,
 private.assignment_commit_impact_at(t.effective_service_date,t.available_from)->>'impactFingerprint',
 jsonb_build_array(jsonb_build_object('cleaningTargetId',t.id,'expectedAssignmentVersion',t.assignment_version,'expectedAvailabilityVersion',1)),
 'nested-renotify-target',repeat('e',64),t.available_from) from public.cleaning_targets t where id=pg_temp.bid(302);
select private.activate_cleaning_attempt_at(pg_temp.bid(1),t.id,t.available_from) from public.cleaning_targets t where id=pg_temp.bid(302);
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.bid(302)),4,
 'next-day notified target creates exactly one new attempt after superseded leaf');
select private.activate_cleaning_attempt_at(pg_temp.bid(1),t.id,t.available_from) from public.cleaning_targets t where id=pg_temp.bid(302);
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.bid(302)),4,'activation retry adds no duplicate attempt');
update public.cleaning_attempts set status='interrupted',ended_at=pg_temp.btime(),end_reason='ADMIN_HANDOVER',execution_version=execution_version+1
where id=pg_temp.bid(508);
select ok(private.attempt_blocks_assignment(a),'orphan interrupted remains blocking without provenance') from public.cleaning_attempts a where id=pg_temp.bid(508);

-- Admin retirement grants nothing to inactive/departed/former-maid owners.
select pg_temp.bfixture(9,12,(pg_temp.btime() at time zone 'Asia/Seoul')::date-1,false,true);
update public.profiles set status='inactive' where id=pg_temp.bid(12);
select lives_ok($$select pg_temp.bmanage(9,'expire_scheduled',1,2)$$,'inactive owner does not strand never-started work');
select ok((select due_at is null from public.cleaning_targets where id=pg_temp.bid(309)),'NULL due is preserved rather than guessed');
select is((select status::text from public.profiles where id=pg_temp.bid(12)),'inactive','expiry never reactivates inactive owner');
select pg_temp.bfixture(10,6,(pg_temp.btime() at time zone 'Asia/Seoul')::date-1,false);
update public.profiles set status='inactive' where id=pg_temp.bid(6);
update public.profiles set status='departed' where id=pg_temp.bid(6);
select lives_ok($$select pg_temp.bmanage(10,'expire_scheduled',1,3)$$,'departed owner does not strand never-started work');
select pg_temp.bfixture(11,5,(pg_temp.btime() at time zone 'Asia/Seoul')::date-1,false);
update public.profiles set role='admin' where id=pg_temp.bid(5);
select lives_ok($$select pg_temp.bmanage(11,'expire_scheduled',1,2)$$,'historical owner role change does not grant permission or strand retirement');
select is((select count(*)::int from private.attempt_capability_grants where attempt_id in (pg_temp.bid(509),pg_temp.bid(510),pg_temp.bid(511))),0,
 'retirement creates no capability for inactive/departed/former maid');

-- Reclean expiration keeps the original maid and source; it is not a handover.
update public.cleaning_attempts set status='rejected' where id=pg_temp.bid(508);
update public.cleaning_assignments set is_current=false,ended_at=pg_temp.btime(),change_reason_code='INSPECTION_REJECTED' where id=pg_temp.bid(408);
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
 available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by,reclean_of_attempt_id,reclean_maid_profile_id)
select pg_temp.bid(312),room_id,'reclean','inspection_reclean','handover-reclean',(pg_temp.btime() at time zone 'Asia/Seoul')::date-1,
 (pg_temp.btime() at time zone 'Asia/Seoul')::date-1,((pg_temp.btime() at time zone 'Asia/Seoul')::date-1)::timestamp at time zone 'Asia/Seoul',
 null,'notified',2,'{}',0,'{}',pg_temp.bid(1),pg_temp.bid(508),pg_temp.bid(9) from public.cleaning_targets where id=pg_temp.bid(308);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
values(pg_temp.bid(412),pg_temp.bid(312),pg_temp.bid(9),99,2,pg_temp.btime(),pg_temp.bid(1));
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.bid(512),pg_temp.bid(312),pg_temp.bid(412),pg_temp.bid(9),1,'scheduled',2,'{}',jsonb_build_object('roomId',room_id)
from public.cleaning_targets where id=pg_temp.bid(312);
select lives_ok($$select pg_temp.bmanage(12,'expire_scheduled',1)$$,'reclean original maid may retire unstarted expired attempt');
select ok((select reclean_maid_profile_id=pg_temp.bid(9) and reclean_of_attempt_id=pg_temp.bid(508) and fee_snapshot=0 and due_at is null
 from public.cleaning_targets where id=pg_temp.bid(312)),'reclean identity zero fee and NULL deadline stay unchanged');

-- Force an audit failure and verify the entire handover/outbox/profile transaction
-- rolls back. A server error must never leave an interrupted owner without successor.
create function pg_temp.bfail_audit() returns trigger language plpgsql as $$ begin
 if new.event_type='cleaning.interrupted_handover' then raise exception 'TEST_AUDIT_UNAVAILABLE'; end if; return new; end $$;
create trigger b_fail_audit before insert on public.audit_events for each row execute function pg_temp.bfail_audit();
insert into b_result values('atomic-before',pg_temp.bledgers());
select throws_ok($$select pg_temp.bmanage(3,'interrupt_handover',2,1,null,null,null,
 pg_temp.bhandover_payload(true)||jsonb_build_object('sequenceNumber',77))$$,'P0001','TEST_AUDIT_UNAVAILABLE','handover fails when audit append fails');
select is(pg_temp.bledgers(),(select value from b_result where label='atomic-before'),'failed audit rolls back attempts/assignments/profile/grants/notifications/outbox/receipts');
drop trigger b_fail_audit on public.audit_events;
select pg_temp.bmanage(6,'allow_finish');
select throws_ok($$select pg_temp.bmanage(6,'allow_finish',2,2,'expired-grant-new-key',null,pg_temp.btime()+interval '2 hours')$$,
 '42501','CAPABILITY_ACCESS_REQUIRED','expired finish grant cannot be reissued with a new key');
select throws_ok($$update public.profiles set status='inactive' where id=pg_temp.bid(7)$$,
 '55000','ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED','generic deactivation cannot replace pending running-work lifecycle');
select pg_temp.bmanage(6,'interrupt_handover',2,2,null,null,null,pg_temp.bhandover_payload(true)||jsonb_build_object('sequenceNumber',78));
select is((select status::text from public.profiles where id=pg_temp.bid(7)),'upload_only','explicit deactivation handover leaves old maid upload-only');
select throws_ok($$select pg_temp.bcomplete(6,7)$$,'42501','CAPABILITY_ACCESS_REQUIRED','handover permanently invalidates prior finish command');
select private.execute_cleaning_attempt_at(pg_temp.bid(8),pg_temp.bid(507),2,pg_temp.bid(407),2,
 'upload-only-physical-complete',repeat('f',64),'complete_field_work',pg_temp.btime());
select pg_temp.bmanage(7,'allow_upload',3);
select is((select status::text from public.profiles where id=pg_temp.bid(8)),'upload_only','already completed maid may receive explicit upload-only permission');
select throws_ok($$select private.live_attempt_capability(pg_temp.bid(8),pg_temp.bid(507),2,'upload_evidence',pg_temp.btime()+interval '24 hours')$$,
 '42501','CAPABILITY_ACCESS_REQUIRED','upload grant expires at exact 24-hour boundary');
select is((select count(*)::int from public.list_developer_audit_events(pg_temp.bid(13),array['cleaning.interrupted_handover'],pg_temp.bid(1))),3,
 'developer can filter successful handover domain audit by admin actor');
select ok(not exists(select 1 from public.list_developer_audit_events(pg_temp.bid(13),array['cleaning.interrupted_handover']) e
 where e.summary ?| array['before_state','after_state','requestHash','requestBody','sessionId','password','accessToken','phone','roomSnapshot','templateSnapshot']),
 'developer lifecycle audit exposes safe summary, no raw state/PII/credential');
select lives_ok($$select public.record_authorization_denial(pg_temp.bid(2),'edge.authorization.attempts','CAPABILITY_ACCESS_REQUIRED')$$,
 'limited-profile denial can append bounded authorization aggregate');
select is((select count(*)::int from private.actor_authorization_denial_aggregates where actor_profile_id=pg_temp.bid(2)
 and source='edge.authorization.attempts' and reason_code='CAPABILITY_ACCESS_REQUIRED'),1,'dedicated limited denial is bounded by existing aggregate key');
select throws_ok($$select public.record_authorization_denial(pg_temp.bid(2),'edge.authorization.rooms','ADMIN_REQUIRED')$$,
 '22023','INVALID_ACTIVITY_ACTOR','limited activity exception does not broaden unrelated source/status contracts');
insert into public.reservations(id,room_id,check_in_at,check_out_at,guest_count,status,created_by,updated_by)
select pg_temp.bid(901),room_id,((pg_temp.btime() at time zone 'Asia/Seoul')::date+1+time '10:00') at time zone 'Asia/Seoul',
 ((pg_temp.btime() at time zone 'Asia/Seoul')::date+2+time '12:00') at time zone 'Asia/Seoul',1,'active',pg_temp.bid(1),pg_temp.bid(1)
from public.cleaning_targets where id=pg_temp.bid(305);
insert into b_result values('replan-source-before',pg_temp.bledgers());
select throws_ok($$select pg_temp.bmanage(5,'expire_scheduled',1,3,'replan-source-conflict',null,
 ((pg_temp.btime() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul')$$,
 '23514','ASSIGNMENT_SCHEDULE_INVALID','next-day replan cannot overlap active reservation');
select is(pg_temp.bledgers(),(select value from b_result where label='replan-source-before'),
 'failed next-day source validation has zero retirement/audit/receipt/outbox/schedule mutations');
insert into public.reservations(id,room_id,check_in_at,check_out_at,actual_check_in_at,guest_count,status,created_by,updated_by)
select pg_temp.bid(902),room_id,pg_temp.btime()-interval '1 hour',pg_temp.btime()+interval '1 day',pg_temp.btime()-interval '1 hour',
 1,'active',pg_temp.bid(1),pg_temp.bid(1) from public.cleaning_targets where id=pg_temp.bid(303);
insert into b_result values('handover-source-before',pg_temp.bledgers());
select throws_ok($$select pg_temp.bmanage(3,'interrupt_handover',2,1,'handover-source-conflict',null,null,
 pg_temp.bhandover_payload(true)||jsonb_build_object('sequenceNumber',77))$$,'23514','ASSIGNMENT_SCHEDULE_INVALID',
 'handover cannot bypass current actual reservation occupancy');
select is(pg_temp.bledgers(),(select value from b_result where label='handover-source-before'),
 'invalid occupied handover leaves owner/current attempt/evidence/capability/audit/outbox unchanged');
-- Complete the circular reservation/obligation fixture inside this transaction;
-- do not let rollback hide a deferred FK or seven-day availability violation.
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select distinct room.room_type_id,'checkout'::public.cleaning_kind,1,'published',60,'[]'::jsonb,pg_temp.btime(),pg_temp.bid(1)
from public.reservations r join public.rooms room on room.id=r.room_id
where r.id in (pg_temp.bid(901),pg_temp.bid(902));
insert into public.preparation_obligations(id,reservation_id,room_id)
select preparation_obligation_id,id,room_id from public.reservations where id in (pg_temp.bid(901),pg_temp.bid(902));
insert into public.checkout_cleaning_obligations(id,reservation_id,room_id,original_service_date,effective_service_date,available_from,created_by)
select checkout_obligation_id,id,room_id,(check_out_at at time zone 'Asia/Seoul')::date,
 (check_out_at at time zone 'Asia/Seoul')::date,check_out_at,pg_temp.bid(1)
from public.reservations where id in (pg_temp.bid(901),pg_temp.bid(902));
select private.ensure_planned_checkout_target(checkout_obligation_id) from public.reservations where id in (pg_temp.bid(901),pg_temp.bid(902));
set constraints all immediate;
select * from finish();
rollback;
