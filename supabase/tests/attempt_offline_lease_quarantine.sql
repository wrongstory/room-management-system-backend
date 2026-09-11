begin;
select no_plan();
create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
 select ('7c000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.cid(100+n) from generate_series(1,32) n;
select public.bootstrap_first_developer_profile(pg_temp.cid(32),pg_temp.cid(132),'오프라인 개발자','오프라인 개발자','0032','offline-developer-hash','offline-developer-bootstrap');
update public.profiles set must_change_password=false where id=pg_temp.cid(32);
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.cid(n),pg_temp.cid(100+n),'offline-'||n,'offline-'||n,'offline-'||n,'offline-'||n,0,
 case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,31) n;
insert into auth.sessions(id,user_id) select pg_temp.cid(200+n),pg_temp.cid(100+n) from generate_series(1,32) n;
create function pg_temp.cfixture(n integer,p_start timestamptz default '2040-03-01 10:00+09') returns jsonb language plpgsql as $$
declare room uuid; d date:=(p_start at time zone 'Asia/Seoul')::date;
begin
 select id into room from public.rooms order by room_number offset n limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
 available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.cid(300+n),room,'additional','manual_room_request','offline-'||n,d,d,
 d::timestamp at time zone 'Asia/Seoul',(d+1)::timestamp at time zone 'Asia/Seoul','notified',2,'{}',10000,'{}',pg_temp.cid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.cid(400+n),pg_temp.cid(300+n),pg_temp.cid(n+1),n,2,p_start-interval '1 hour',pg_temp.cid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
 values(pg_temp.cid(500+n),pg_temp.cid(300+n),pg_temp.cid(400+n),pg_temp.cid(n+1),1,'scheduled',2,'{}',jsonb_build_object('roomId',room));
 return private.start_attempt_with_lease_at(pg_temp.cid(n+1),pg_temp.cid(201+n),pg_temp.cid(500+n),1,pg_temp.cid(400+n),2,
 'offline-start-'||n,repeat('a',64),p_start);
end; $$;
create temp table c_results(label text primary key,value jsonb);
insert into c_results select 'start-'||n,pg_temp.cfixture(n) from generate_series(1,18)n;
insert into c_results values('start-19',pg_temp.cfixture(19,'2040-03-01 23:50+09'));
insert into c_results values('start-20',pg_temp.cfixture(20,'2010-03-01 10:00+09'));
create function pg_temp.lease(n integer) returns uuid language sql stable as $$
 select (value#>>'{lease,leaseId}')::uuid from c_results where label='start-'||n $$;
create function pg_temp.csync(n integer,p_occurred timestamptz default '2040-03-01 10:30+09',p_at timestamptz default '2040-03-01 10:31+09',
 p_offset bigint default 0,p_event uuid default null,p_version bigint default 2) returns jsonb language sql as $$
 select private.sync_attempt_event_at(pg_temp.cid(n+1),pg_temp.cid(201+n),pg_temp.lease(n),coalesce(p_event,pg_temp.cid(600+n)),
 p_version,p_occurred,p_offset,p_at) $$;
create function pg_temp.qid(n integer) returns uuid language sql stable as $$
 select id from private.offline_completion_events where lease_id=pg_temp.lease(n) $$;
create function pg_temp.cresolve(n integer,action text,p_key text default null,p_version bigint default null,p_at timestamptz default '2040-03-01 13:00+09')
returns jsonb language sql as $$
 select private.resolve_offline_quarantine_with_notifications_at(pg_temp.cid(1),pg_temp.cid(201),pg_temp.qid(n),action,p_version,
 case action when 'record_only' then 'OFFLINE_RECORD_ONLY' when 'reject_effect' then 'OFFLINE_REJECT_EFFECT' else 'OFFLINE_CORRECTION_APPROVED' end,
 coalesce(p_key,'offline-resolve-'||n),repeat('b',64),p_at) $$;
create function pg_temp.cledgers() returns jsonb language sql stable as $$
 select jsonb_build_object('attempts',(select jsonb_agg(x order by id)from public.cleaning_attempts x),
 'audit',(select jsonb_agg(x order by id)from public.audit_events x),'receipts',(select jsonb_agg(x order by id)from private.command_executions x),
 'events',(select jsonb_agg(x order by id)from private.offline_completion_events x),'resolution',(select jsonb_agg(x order by id)from private.offline_event_resolutions x),
 'leases',(select jsonb_agg(x order by id)from private.offline_work_leases x),
 'revocations',(select jsonb_agg(x order by lease_id)from private.offline_work_lease_revocations x),
 'notices',(select jsonb_agg(x order by id)from public.notifications x),
 'outbox',(select jsonb_agg(x order by id)from private.notification_outbox x),
 'typedOutbox',(select jsonb_agg(x order by id)from private.notification_delivery_outbox x)) $$;

select is((select count(*)::int from private.offline_work_leases),20,'online starts atomically issue one lease per attempt');
select is((select expires_at-issued_at from private.offline_work_leases where id=pg_temp.lease(1)),interval '2 hours','lease hard TTL exactly 2h');
select is((select metadata_expires_at-issued_at from private.offline_work_leases where id=pg_temp.lease(1)),interval '90 days','metadata horizon anchored to original server issuance');
select is(private.start_attempt_with_lease_at(pg_temp.cid(2),pg_temp.cid(202),pg_temp.cid(501),1,pg_temp.cid(401),2,
 'offline-start-1',repeat('a',64),'2040-03-01 10:01+09')->'lease',(select value->'lease' from c_results where label='start-1'),'same start key preserves lease identity/expiry');
select throws_ok($$select private.start_attempt_with_lease_at(pg_temp.cid(2),pg_temp.cid(202),pg_temp.cid(501),2,pg_temp.cid(401),2,
 'offline-start-renew',repeat('a',64),'2040-03-01 10:02+09')$$,'55000','ATTEMPT_INVALID_TRANSITION','new start key cannot renew already started lease');
select ok(not exists(select 1 from private.command_executions where response_payload::text like '%leaseId%'),'permanent start receipt contains attempt only, no lease metadata');
insert into c_results values('success',pg_temp.csync(1));
select is((select value->>'outcome'from c_results where label='success'),'applied','valid current owner offline completion applies');
select is((select field_completed_at from public.cleaning_attempts where id=pg_temp.cid(501)),'2040-03-01 10:30+09'::timestamptz,'physical completion uses verified normalized event time');
select is(pg_temp.csync(1),(select value from c_results where label='success'),'same successful event replays exact logical response');
select is((select execution_version::int from public.cleaning_attempts where id=pg_temp.cid(501)),3,'replay never advances execution CAS twice');
select is((select count(*)::int from public.audit_events where entity_id=pg_temp.cid(501) and event_type='cleaning.field_completed'),1,'offline completion audit exactly once');
select throws_ok($$select pg_temp.csync(1,'2040-03-01 10:31+09')$$,'23505','OFFLINE_EVENT_CONFLICT','same event changed canonical payload conflicts');
select throws_ok($$select pg_temp.csync(1,'2040-03-01 10:30+09','2040-03-01 10:31+09',0,pg_temp.cid(1601))$$,
 '23505','OFFLINE_EVENT_CONFLICT','different event identity cannot create second completion slot');
select is((pg_temp.csync(2,'2040-03-01 10:30+09','2040-03-01 12:00+09')->>'reasonCode'),'LEASE_EXPIRED','exact lease expiry quarantines despite completion before expiry');
select is((select status::text from public.cleaning_attempts where id=pg_temp.cid(502)),'in_progress','quarantine has no physical completion effect');
select is(pg_temp.csync(2,'2040-03-01 10:30+09','2040-03-01 12:00+09'),pg_temp.csync(2,'2040-03-01 10:30+09','2040-03-01 12:00+09'),'quarantine retry remains quarantined');
select is((pg_temp.csync(3,'2040-03-01 10:32+09')->>'reasonCode'),'CLOCK_CONFLICT','future completion time cannot become effective before actual server reception');
select is((pg_temp.csync(4,'2040-03-01 10:30+09','2040-03-01 10:31+09',300001)->>'reasonCode'),'CLOCK_CONFLICT','clock skew greater than five minutes quarantines');
select is((pg_temp.csync(5,'2040-03-01 09:59+09')->>'reasonCode'),'CLOCK_CONFLICT','completion before online start quarantines');
select is((pg_temp.csync(6,'2040-03-01 10:30+09','2040-03-01 10:40+09',300000)->>'outcome'),'applied','exact positive five minute offset accepted within actual time');
select is((pg_temp.csync(7,'2040-03-01 10:30+09','2040-03-01 10:40+09',-300000)->>'outcome'),'applied','exact negative five minute offset accepted within actual time');
select is((pg_temp.csync(19,'2040-03-01 23:59+09','2040-03-02 00:01+09')->>'reasonCode'),'KST_DATE_CONFLICT','midnight receive boundary requires admin confirmation, not automatic date attribution');
select is((pg_temp.cresolve(19,'correction_link',null,2,'2040-03-02 00:03+09')#>>'{attempt,fieldCompletedAt}')::timestamptz,
 '2040-03-01 23:59+09'::timestamptz,'explicit correction confirms normalized original day, not server receive day');
select is((pg_temp.cresolve(2,'correction_link',null,2)->>'resolution'),'correction_link','admin can validate late completion on still-current in-progress attempt');
select is((select field_completed_at from public.cleaning_attempts where id=pg_temp.cid(502)),'2040-03-01 10:30+09'::timestamptz,'correction has no arbitrary correctedAt input');
select is(pg_temp.cresolve(2,'correction_link',null,2),pg_temp.cresolve(2,'correction_link',null,2),'same correction response is stable within metadata horizon');
select throws_ok($$select pg_temp.cresolve(3,'record_only','offline-resolve-2')$$,'23505','IDEMPOTENCY_KEY_REUSED','admin raw resolution key reused for another quarantine conflicts');
select throws_ok($$select private.resolve_offline_quarantine_at(pg_temp.cid(1),pg_temp.cid(201),pg_temp.qid(2),'correction_link',2,
 'OFFLINE_CORRECTION_APPROVED','offline-resolve-2',repeat('e',64),'2040-03-01 13:00+09')$$,
 '23505','IDEMPOTENCY_KEY_REUSED','same quarantine/key changed canonical resolution payload conflicts');
select throws_ok($$select pg_temp.cresolve(2,'reject_effect','offline-other-decision')$$,'55000','OFFLINE_EVENT_ALREADY_RESOLVED','terminal correction decision cannot be rewritten');
select throws_ok($$select pg_temp.cresolve(4,'correction_link',null,2)$$,'55000','OFFLINE_CLOCK_UNVERIFIABLE','admin cannot legitimize unverifiable offset or supply a free-form timestamp');
select is(pg_temp.cresolve(4,'record_only')->>'resolution','record_only','unverifiable clock can be retained as record only');
select throws_ok($$select pg_temp.cresolve(4,'correction_link','offline-second-decision',2)$$,'55000','OFFLINE_EVENT_ALREADY_RESOLVED','record-only never promotes automatically or via second resolution');
select is(pg_temp.cresolve(5,'reject_effect')->>'resolution','reject_effect','admin can reject effect without mutating attempt');
select is((select status::text from public.cleaning_attempts where id=pg_temp.cid(505)),'in_progress','rejected event did not complete work');
select is((pg_temp.cresolve(3,'correction_link',null,2,'2040-03-01 10:35+09')#>>'{attempt,fieldCompletedAt}')::timestamptz,
 '2040-03-01 10:32+09'::timestamptz,'future clock quarantine requires explicit later current-time revalidation');

insert into c_results values('before-unknown',pg_temp.cledgers());
select throws_ok($$select private.sync_attempt_event_at(pg_temp.cid(9),pg_temp.cid(209),pg_temp.cid(9999),pg_temp.cid(1608),2,
 '2040-03-01 10:30+09',0,'2040-03-01 10:31+09')$$,'42501','OFFLINE_LEASE_UNKNOWN','never-issued lease is rejected without quarantine');
select throws_ok($$select private.sync_attempt_event_at(pg_temp.cid(9),pg_temp.cid(209),pg_temp.lease(9),pg_temp.cid(1609),2,
 '2040-03-01 10:30+09',0,'2040-03-01 10:31+09')$$,'42501','OFFLINE_LEASE_UNKNOWN','issued lease of another maid is not proof of ownership');
select is(pg_temp.cledgers(),(select value from c_results where label='before-unknown'),'unknown/foreign lease creates no domain or metadata row');
select throws_ok($$select private.sync_attempt_event_at(pg_temp.cid(9),pg_temp.cid(210),pg_temp.lease(8),pg_temp.cid(1608),2,
 '2040-03-01 10:30+09',0,'2040-03-01 10:31+09')$$,'42501','SESSION_REVOKED','another session cannot authorize owned lease');
select throws_ok($$select private.sync_attempt_event_at(pg_temp.cid(1),pg_temp.cid(201),pg_temp.lease(8),pg_temp.cid(1608),2,
 '2040-03-01 10:30+09',0,'2040-03-01 10:31+09')$$,'42501','CAPABILITY_ACCESS_REQUIRED','admin cannot ingest maid events');
select throws_ok($$select private.sync_attempt_event_at(pg_temp.cid(32),pg_temp.cid(232),pg_temp.lease(8),pg_temp.cid(1608),2,
 '2040-03-01 10:30+09',0,'2040-03-01 10:31+09')$$,'42501','CAPABILITY_ACCESS_REQUIRED','developer cannot ingest maid events');

select private.manage_cleaning_attempt_lifecycle_at(pg_temp.cid(1),pg_temp.cid(201),pg_temp.cid(508),2,pg_temp.cid(408),2,1,
 'allow_finish','{}','DEACTIVATION_FINISH_CURRENT','offline-limit-8',repeat('c',64),'2040-03-01 10:10+09');
select is(pg_temp.csync(8)->>'reasonCode','LEASE_REVOKED','limited deactivation revokes old general offline execution lease');
select is((pg_temp.cresolve(8,'correction_link',null,2,'2040-03-01 10:40+09')#>>'{attempt,status}'),'field_completed','admin correction respects current valid one-job-finish capability');
select is((select status::text from public.profiles where id=pg_temp.cid(9)),'upload_only','limited correction consumes finish grant and atomically enters upload-only');
select is((select count(*)::int from private.attempt_capability_grants where attempt_id=pg_temp.cid(508) and kind='upload_submit'),1,'limited correction issues upload capability once');
select is((select count(*)::int from public.notifications where event_family='capability.upload_submit_offline_resolution_issued'
  and source_entity_id=(select id::text from private.attempt_capability_grants where attempt_id=pg_temp.cid(508) and kind='upload_submit')),1,
  'offline correction emits one exact typed capability notice');
select is((select count(*)::int from public.notifications n
  where n.event_family='capability.upload_submit_offline_resolution_issued'
    and private.notification_public_projection(n)->'deepLink'=jsonb_build_object('kind','cleaningTarget','entityId',pg_temp.cid(308))),1,
  'offline capability notice exposes the exact cleaning-target deep link');
select is((select count(*)::int from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
  where n.event_family='capability.upload_submit_offline_resolution_issued' and n.source_entity_id=(select id::text
    from private.attempt_capability_grants where attempt_id=pg_temp.cid(508) and kind='upload_submit')),0,
  'offline correction leaves the recipient upload-only, so the typed notice is inbox-only');
select ok(not exists(select 1 from public.notifications where contract_version is null
  and dedupe_key=(select 'attempt-capability:'||id::text from private.attempt_capability_grants
    where attempt_id=pg_temp.cid(508) and kind='upload_submit')),
  'offline typed cutover suppresses the matching legacy notification');
select is(current_setting('app.notification_writer_mode',true),'','offline writer wrapper clears typed mode after success');
select is(pg_temp.csync(9,'2040-03-01 10:30+09','2040-03-01 12:01+09')->>'reasonCode','LEASE_EXPIRED','second late event available for terminal-state correction check');
select private.execute_cleaning_attempt_at(pg_temp.cid(10),pg_temp.cid(509),2,pg_temp.cid(409),2,'offline-online-complete-9',repeat('d',64),'complete_field_work','2040-03-01 12:02+09');
select throws_ok($$select pg_temp.cresolve(9,'correction_link',null,3)$$,'55000','ATTEMPT_INVALID_TRANSITION','already-completed timestamp cannot be corrected/overwritten');
select is(pg_temp.csync(10,'2040-03-01 10:30+09','2040-03-01 12:01+09')->>'outcome','quarantined','stale CAS fixture is quarantined');
select throws_ok($$select pg_temp.cresolve(10,'correction_link',null,99)$$,'40001','ATTEMPT_VERSION_CONFLICT','correction requires latest execution CAS');

-- Denial floods never create unbounded rows, even when UUIDs change each call.
do $$ begin for n in 1..1000 loop
 begin perform pg_temp.csync(2,'2040-03-01 10:30+09','2040-03-01 12:00+09',0,pg_temp.cid(10000+n));
 exception when unique_violation then null; end;
end loop; end $$;
select is((select count(*)::int from private.offline_completion_events where lease_id=pg_temp.lease(2)),1,'1000 rotating UUIDs on known lease still occupy one canonical slot');
select ok(not exists(select 1 from public.audit_events where after_state::text like '%7c000000-0000-4000-8000-00000000060%'
 or after_state ?| array['eventId','requestHash','serverOffsetMs','occurredAt','receivedAt']), 'raw client UUID/hash/clock metadata absent from permanent audit');
select ok(not exists(select 1 from private.command_executions where command_type like '%offline%' or response_payload::text like '%quarantineId%'),
 'offline event and resolution response are not copied to permanent command receipts');
select ok(not exists(select 1 from private.offline_completion_events where response_payload ?| array['password','token','refreshToken','authorization','phone','guestName','pin','rawBody','clientIp']),
 'event response has no secret/PII/raw body fields');
select is((select count(*)::int from public.cleaning_submissions),0,'offline completion/correction creates no submission');
select is((select count(*)::int from public.earnings),0,'offline completion/correction creates no earnings');

select throws_ok($$select public.get_offline_event_quarantine(pg_temp.cid(2),pg_temp.cid(202),pg_temp.qid(2))$$,'42501','ADMIN_REQUIRED','maid cannot read quarantine');
select throws_ok($$select public.get_offline_event_quarantine(pg_temp.cid(32),pg_temp.cid(232),pg_temp.qid(2))$$,'42501','ADMIN_REQUIRED','developer cannot use administrator quarantine actions');
select is(public.get_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),pg_temp.qid(2))->>'resolution','correction_link','admin reads safe resolution state');
select ok(not public.get_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),pg_temp.qid(2)) ?| array['eventId','requestHash','serverOffsetMs','response_payload'],
 'admin projection excludes raw event metadata and stored response');
select throws_ok($$select public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'2040-01-01','2040-03-01',100,null,null)$$,
 '22023','INVALID_OFFLINE_QUERY','quarantine query hard cap31days');
select throws_ok($$select public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'2040-03-01','2040-03-02',101,null,null)$$,
 '22023','INVALID_OFFLINE_QUERY','quarantine page cap100');
insert into c_results values('page1',public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'2040-03-01','2040-03-03',2,null,null));
select is(jsonb_array_length((select value->'items'from c_results where label='page1')),2,'quarantine cursor page respects limit');
select ok((select value->'nextCursor' <> 'null'::jsonb from c_results where label='page1'),'extra row produces a cursor');
insert into c_results select 'page2',public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'2040-03-01','2040-03-03',2,
 (value#>>'{nextCursor,receivedAt}')::timestamptz,(value#>>'{nextCursor,id}')::uuid) from c_results where label='page1';
select ok(not exists(select 1 from jsonb_array_elements((select value->'items'from c_results where label='page1'))a
 cross join jsonb_array_elements((select value->'items'from c_results where label='page2'))b where a->>'quarantineId'=b->>'quarantineId'),
 'second cursor page never duplicates first page records');
select throws_ok($$select public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'2040-03-01','2040-03-03',2,'2040-03-01',null)$$,
 '22023','INVALID_OFFLINE_QUERY','cursor timestamp without matching ID is rejected');
select throws_ok($$select public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'-infinity','2040-03-03',2,null,null)$$,
 '22023','INVALID_OFFLINE_QUERY','non-finite query interval rejected');
select throws_ok($$select public.list_offline_event_quarantine(pg_temp.cid(1),pg_temp.cid(201),'2040-03-01','2040-03-03',2,'infinity',pg_temp.cid(1))$$,
 '22023','INVALID_OFFLINE_QUERY','non-finite cursor rejected');
select is((select count(*)::int from public.list_developer_audit_events(pg_temp.cid(32),array['cleaning.offline_event_resolved'],null,
 '2040-03-01','2040-03-03',null,null,100)),6,'developer can query allowlisted resolution audit independently of raw quarantine');

-- Audit failure must undo physical completion + receipt and leave the event absent.
create function pg_temp.fail_offline_audit() returns trigger language plpgsql as $$ begin
 if new.entity_id=pg_temp.cid(511) and new.event_type='cleaning.field_completed' then raise exception 'OFFLINE_AUDIT_FAILURE'; end if;
 return new; end $$;
create trigger fail_offline_audit before insert on public.audit_events for each row execute function pg_temp.fail_offline_audit();
insert into c_results values('before-audit-failure',pg_temp.cledgers());
select throws_ok($$select pg_temp.csync(11)$$,'P0001','OFFLINE_AUDIT_FAILURE','audit failure aborts entire offline completion');
select is(pg_temp.cledgers(),(select value from c_results where label='before-audit-failure'),'audit failure leaves no attempt/event/receipt/outbox change');
drop trigger fail_offline_audit on public.audit_events;
create function pg_temp.fail_resolution_audit() returns trigger language plpgsql as $$ begin
 if new.entity_id=pg_temp.cid(510) and new.event_type='cleaning.offline_event_resolved' then raise exception 'RESOLUTION_AUDIT_FAILURE'; end if;
 return new; end $$;
create trigger fail_resolution_audit before insert on public.audit_events for each row execute function pg_temp.fail_resolution_audit();
insert into c_results values('before-resolution-failure',pg_temp.cledgers());
select throws_ok($$select pg_temp.cresolve(10,'correction_link',null,2)$$,'P0001','RESOLUTION_AUDIT_FAILURE','resolution audit failure aborts correction after attempted physical completion');
select is(pg_temp.cledgers(),(select value from c_results where label='before-resolution-failure'),'failed resolution rolls back attempt/physical audit/lease revocation/decision/receipt');
drop trigger fail_resolution_audit on public.audit_events;

select throws_ok($$update private.offline_work_leases set expires_at=expires_at+interval '1 hour' where id=pg_temp.lease(1)$$,
 '55000','OFFLINE_METADATA_IMMUTABLE','lease TTL and identity cannot be altered');
select throws_ok($$delete from private.offline_completion_events where lease_id=pg_temp.lease(1)$$,
 '55000','OFFLINE_METADATA_IMMUTABLE','unexpired event cannot be deleted');
select throws_ok($$update private.offline_event_resolutions set resolution='record_only' where event_record_id=pg_temp.qid(2)$$,
 '55000','OFFLINE_METADATA_IMMUTABLE','resolution is append-only');
select ok((select bool_and(relrowsecurity) from pg_class where oid in('private.offline_work_leases'::regclass,
 'private.offline_work_lease_revocations'::regclass,'private.offline_completion_events'::regclass,'private.offline_event_resolutions'::regclass)),
 'all private offline tables have defense-in-depth RLS');
select ok(not exists(select 1 from unnest(array['anon','authenticated','service_role'])r cross join unnest(array[
 'private.offline_work_leases','private.offline_work_lease_revocations','private.offline_completion_events','private.offline_event_resolutions'])t
 where has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE')),'no raw private table grants even for service role');
select ok(not exists(select 1 from unnest(array['anon','authenticated'])r cross join unnest(array[
 'public.start_cleaning_attempt_with_lease(uuid,uuid,uuid,bigint,uuid,bigint,text,text)',
 'public.sync_cleaning_attempt_event(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint)',
 'public.get_offline_event_quarantine(uuid,uuid,uuid)',
 'public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid)',
 'public.resolve_offline_event_quarantine(uuid,uuid,uuid,text,bigint,text,text,text)',
 'public.purge_expired_offline_metadata(integer)'])f where has_function_privilege(r,f,'EXECUTE')),
 'all six privileged RPCs revoke anon/authenticated and inherited PUBLIC execute');
select ok((select bool_and(has_function_privilege('service_role',f,'EXECUTE'))from unnest(array[
 'public.start_cleaning_attempt_with_lease(uuid,uuid,uuid,bigint,uuid,bigint,text,text)',
 'public.sync_cleaning_attempt_event(uuid,uuid,uuid,uuid,bigint,timestamptz,bigint)',
 'public.get_offline_event_quarantine(uuid,uuid,uuid)',
 'public.list_offline_event_quarantine(uuid,uuid,timestamptz,timestamptz,integer,timestamptz,uuid)',
 'public.resolve_offline_event_quarantine(uuid,uuid,uuid,text,bigint,text,text,text)',
 'public.purge_expired_offline_metadata(integer)'])f),'all six public RPCs have exact service-only grant');

select throws_ok($$select pg_temp.csync(1,'2040-03-01 10:30+09','2040-05-30 10:00+09')$$,
 '55000','OFFLINE_EVENT_EXPIRED','exact ninety-day horizon rejects even previously successful event');
select is(pg_temp.csync(20,'2010-03-01 10:30+09','2010-03-01 12:01+09')->>'outcome','quarantined','historical owner clock fixture for expired metadata purge');
select pg_temp.cresolve(20,'record_only',null,null,'2010-03-01 12:02+09');
insert into c_results values('audit-before-purge',jsonb_build_object('n',(select count(*)from public.audit_events)));
create function pg_temp.fail_offline_purge() returns trigger language plpgsql as $$ begin
 if old.attempt_id=pg_temp.cid(520) then raise exception 'OFFLINE_PURGE_FAILURE'; end if; return old; end $$;
create trigger fail_offline_purge before delete on private.offline_work_leases for each row execute function pg_temp.fail_offline_purge();
insert into c_results values('before-purge-failure',pg_temp.cledgers());
select throws_ok($$select public.purge_expired_offline_metadata(1)$$,'P0001','OFFLINE_PURGE_FAILURE','parent lease purge failure aborts dependent metadata deletion');
select is(pg_temp.cledgers(),(select value from c_results where label='before-purge-failure'),'purge failure preserves all expiring event/resolution metadata atomically');
drop trigger fail_offline_purge on private.offline_work_leases;
select is(public.purge_expired_offline_metadata(1)->>'purgedLeases','1','allowlisted bounded purger removes one expired lease with related event/decision metadata');
select is((select count(*)::int from private.offline_work_leases where attempt_id=pg_temp.cid(520)),0,'expired lease identity is actually deleted, no permanent tombstone');
select is((select count(*)::int from private.offline_completion_events where event_id=pg_temp.cid(620)),0,'event UUID/clock/hash/response are actually removed');
select is((select count(*)from public.audit_events),(select(value->>'n')::bigint from c_results where label='audit-before-purge'),'resolution business audit remains immutable after metadata purge');
select throws_ok($$select pg_temp.csync(20,'2010-03-01 10:30+09','2010-03-01 12:01+09')$$,'42501','OFFLINE_LEASE_UNKNOWN','purged lease cannot be ingested again even with forged old client clock');
select throws_ok($$select private.start_attempt_with_lease_at(pg_temp.cid(21),pg_temp.cid(221),pg_temp.cid(520),1,pg_temp.cid(420),2,
 'offline-start-20',repeat('a',64),'2040-03-01 10:00+09')$$,'55000','OFFLINE_LEASE_ISSUANCE_CLOSED','same permanent start receipt cannot reissue lease after purge');
select is(public.purge_expired_offline_metadata(100)->>'purgedLeases','0','purger retry is idempotent and preserves unexpired metadata');
select throws_ok($$select public.purge_expired_offline_metadata(101)$$,'22023','INVALID_OFFLINE_PURGE_LIMIT','purger never accepts an unbounded batch');
select is(pg_temp.csync(12,'2040-03-01 12:00+09','2040-03-01 12:01+09')->>'reasonCode','LEASE_EXPIRED','exact TTL completion timestamp enters quarantine');
select throws_ok($$select pg_temp.cresolve(12,'correction_link',null,2)$$,'55000','OFFLINE_CLOCK_UNVERIFIABLE','correction cannot extend hard TTL at the exact expiry instant');
select throws_ok($$select pg_temp.csync(13,'9999-12-31 23:59:59+00','2040-03-01 10:31+09',86400000)$$,
 '22023','INVALID_OFFLINE_EVENT','normalized year10000 rejected before storing unrenderable quarantine timestamp');
select throws_ok($$select pg_temp.csync(13,'0001-01-01 00:00:00+00','2040-03-01 10:31+09',-86400000)$$,
 '22023','INVALID_OFFLINE_EVENT','normalized BC year rejected without clamping to a false date');
select is((select count(*)::int from private.offline_completion_events where lease_id=pg_temp.lease(13)),0,'extreme clock inputs never consume bounded canonical slot');
delete from auth.sessions where id=pg_temp.cid(202);
select throws_ok($$select pg_temp.csync(1)$$,'42501','SESSION_REVOKED','successful event receipt never bypasses revoked Auth session');
insert into auth.sessions(id,user_id) values(pg_temp.cid(202),pg_temp.cid(102));
select is(pg_temp.csync(14,'2040-03-01 10:30+09','2040-03-01 12:01+09')->>'outcome','quarantined','known late event retained before interruption');
update public.cleaning_attempts set status='interrupted',ended_at='2040-03-01 12:02+09',end_reason='ADMIN_HANDOVER',execution_version=execution_version+1 where id=pg_temp.cid(514);
select throws_ok($$select pg_temp.cresolve(14,'correction_link',null,3)$$,'55000','ATTEMPT_INVALID_TRANSITION','interrupted history cannot be restored through correction');
select is((select status::text from public.cleaning_attempts where id=pg_temp.cid(514)),'interrupted','failed correction preserves interrupted history');
select ok((select bool_and((select count(*)from jsonb_object_keys(summary))=2 and summary ?& array['offlineQuarantineId','resolution'])
 from public.list_developer_audit_events(pg_temp.cid(32),array['cleaning.offline_event_resolved'],null,'2040-03-01','2040-03-03',null,null,100)),
 'developer resolution audit exposes only server provenance and fixed resolution');
set local role authenticated;
select throws_ok($$select * from private.offline_completion_events$$,'42501',null,'authenticated Data API cannot read raw offline event table');
select throws_ok($$select public.purge_expired_offline_metadata(1)$$,'42501',null,'authenticated caller cannot execute purge RPC');
reset role;
set local role anon;
select throws_ok($$select public.get_offline_event_quarantine(null,null,null)$$,'42501',null,'anon cannot execute administrator quarantine RPC');
reset role;
set constraints all immediate;
select * from finish();
rollback;
