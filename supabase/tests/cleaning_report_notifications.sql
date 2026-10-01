begin;
-- BEGIN CLEANING REPORT NOTIFICATION UPGRADE FIXTURE
create function pg_temp.rid(n integer) returns uuid language sql immutable as $$
 select ('30860000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.rid(100+n) from generate_series(1,7) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password)
select pg_temp.rid(n),pg_temp.rid(100+n),'report-'||n,'report-'||n,'report-'||n,'report-'||n,0,
 case when n in(2,3,7) then 'maid' else 'admin' end::public.app_role,
 case when n=4 then 'inactive' else 'active' end::public.account_status,n=5 from generate_series(1,7) n;
insert into auth.sessions(id,user_id) values(pg_temp.rid(201),pg_temp.rid(101)),(pg_temp.rid(202),pg_temp.rid(102));
-- Historical non-checkout template metadata remains required by the old DB
-- contract; this value is never an assignment capacity or execution cutoff.
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.rid(200),id,'additional',9,'published',1,private.flat_cleaning_photo_slots(),pg_temp.rid(1)
from public.room_types where code='standard';
create function pg_temp.report_fixture(n integer,p_maid integer default 2) returns void language plpgsql as $$
declare room public.rooms; snapshot jsonb; at_time timestamptz:=clock_timestamp()-interval '2 hours';
begin
 select * into room from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset n limit 1;
 snapshot:=jsonb_build_object('id',pg_temp.rid(200),'version',9,'photoSlots',private.flat_cleaning_photo_slots());
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
 available_from,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.rid(1000+n),room.id,'additional','manual_room_request','report-fixture-'||n,
 (at_time at time zone 'Asia/Seoul')::date,(at_time at time zone 'Asia/Seoul')::date,at_time,'notified',2,
 jsonb_build_object('code','standard'),10000,snapshot,pg_temp.rid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.rid(2000+n),pg_temp.rid(1000+n),pg_temp.rid(p_maid),n,2,at_time,pg_temp.rid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
 template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
 values(pg_temp.rid(3000+n),pg_temp.rid(1000+n),pg_temp.rid(2000+n),pg_temp.rid(p_maid),1,'field_completed',2,
 snapshot,jsonb_build_object('roomId',room.id),at_time,at_time+interval '1 hour',at_time+interval '1 hour');
end $$;
create function pg_temp.accept_direct_submission_photo() returns trigger
language plpgsql as $$
declare
  attempt_row public.cleaning_attempts;
  v_operation_id uuid := gen_random_uuid();
  v_object_id uuid := gen_random_uuid();
begin
  select * into strict attempt_row from public.cleaning_attempts where id = new.cleaning_attempt_id;
  insert into private.photo_upload_operations(
    id, actor_profile_id, command_type, idempotency_key_digest, request_hash,
    cleaning_attempt_id, cleaning_target_id, assignment_id, assignment_revision,
    target_photo_slot_id, expected_photo_revision, sha256, mime_type, size_bytes,
    collection_item_id, expected_item_revision
  ) values (
    v_operation_id, attempt_row.maid_profile_id,
    case when new.collection_item_id is null then 'photo.upload' else 'photo.collection.upload' end,
    encode(extensions.digest(new.id::text || ':submission-fixture-key', 'sha256'), 'hex'),
    encode(extensions.digest(new.id::text || ':submission-fixture-request', 'sha256'), 'hex'),
    new.cleaning_attempt_id, new.cleaning_target_id, attempt_row.assignment_id,
    attempt_row.assignment_revision, new.target_photo_slot_id, new.version - 1,
    new.sha256, new.mime_type, new.size_bytes, new.collection_item_id,
    case when new.collection_item_id is null then null else new.item_revision - 1 end
  );
  insert into private.photo_provider_objects(
    id, operation_id, provider_locator, uploaded_at, purge_after
  ) values (
    v_object_id, v_operation_id, 'fixture_' || replace(new.id::text, '-', ''),
    new.uploaded_at, new.purge_after
  );
  insert into private.photo_upload_states(
    operation_id, cleaning_attempt_id, target_photo_slot_id, actor_profile_id,
    status, lease_version, revision
  ) values (
    v_operation_id, new.cleaning_attempt_id, new.target_photo_slot_id,
    attempt_row.maid_profile_id, 'provider_succeeded', 0, 1
  );
  insert into private.photo_upload_acceptances(operation_id, object_id, photo_version_id)
  values(v_operation_id, v_object_id, new.id);
  update private.photo_upload_states
  set status = 'accepted', revision = revision + 1
  where private.photo_upload_states.operation_id = v_operation_id;
  return new;
end $$;
create trigger accept_direct_submission_photo
after insert on private.attempt_photo_versions
for each row execute function pg_temp.accept_direct_submission_photo();


create function pg_temp.report_photo(n integer,p_slot text,p_item integer) returns uuid language plpgsql as $$
declare result uuid;
begin
 select private.record_validated_collection_photo(pg_temp.rid(2),pg_temp.rid(3000+n),
 (select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.rid(1000+n) and slot_key=p_slot),
 pg_temp.rid(p_item),0,0,repeat('a',64),'image/jpeg',100,clock_timestamp()-interval '10 minutes') into result;
 return result;
end $$;
select pg_temp.report_fixture(1); select pg_temp.report_fixture(2); select pg_temp.report_fixture(3);
create temp table report_photos(n integer,slot text,id uuid);
insert into report_photos values(1,'cleaning-proof',pg_temp.report_photo(1,'cleaning-proof',4001)),
 (1,'bomb-proof',pg_temp.report_photo(1,'bomb-proof',4002)),
 (2,'issue-proof',pg_temp.report_photo(2,'issue-proof',4003)),
 (3,'bomb-proof',pg_temp.report_photo(3,'bomb-proof',4004));
create function pg_temp.bomb_rpc(n integer,p_actor integer default 2,p_key text default 'report-bomb-command',p_hash text default null)
returns jsonb language sql as $$
 select public.report_bomb_room(pg_temp.rid(p_actor),pg_temp.rid(3000+n),
 array[(select id from report_photos where report_photos.n=$1 and slot='bomb-proof')],
 'sensitive-memo-sentinel',p_key,coalesce(p_hash,repeat('b',64))) $$;
create function pg_temp.issue_rpc(p_actor integer default 2,p_key text default 'report-issue-command',p_hash text default null)
returns jsonb language sql as $$
 select public.report_attempt_room_issue(pg_temp.rid(p_actor),pg_temp.rid(3002),
 array[(select id from report_photos where n=2 and slot='issue-proof')],
 'sensitive-memo-sentinel',p_key,coalesce(p_hash,repeat('c',64))) $$;
create temp table report_results(label text primary key,value jsonb);
-- END CLEANING REPORT NOTIFICATION UPGRADE FIXTURE
select no_plan();
select is((select count(*) from private.notification_event_catalog),59::bigint,'report families and later attention family preserve all 55 old families');
select is((select count(distinct category) from private.notification_event_catalog),42::bigint,'additive report and attention public categories');
select ok((select bool_and(not requires_action and push_eligible and resolver_kind='none')
 from private.notification_event_catalog where event_family in ('bomb.reported_admin','room_issue.reported_admin','bomb.decided_maid')),
 'report and decision push do not invent action-required workflow');
select throws_ok($$select pg_temp.bomb_rpc(1,3)$$,'42501','SUBMISSION_ACCESS_REQUIRED','other maid cannot report');
select throws_ok($$select pg_temp.bomb_rpc(1,1)$$,'42501','SUBMISSION_ACCESS_REQUIRED','admin cannot act as reporting maid');
select throws_ok($$select pg_temp.issue_rpc(3)$$,'42501','SUBMISSION_ACCESS_REQUIRED','other maid cannot report room issue');
update public.profiles set status='inactive' where id=pg_temp.rid(2);
select throws_ok($$select pg_temp.bomb_rpc(1)$$,'42501','SUBMISSION_ACCESS_REQUIRED','inactive maid cannot report');
update public.profiles set status='upload_only' where id=pg_temp.rid(2);
select throws_ok($$select pg_temp.bomb_rpc(1)$$,'42501','BOMB_REPORT_ACCESS_REQUIRED','upload-only grant does not create bomb report permission');
select throws_ok($$select pg_temp.issue_rpc()$$,'42501','ROOM_ISSUE_REPORT_ACCESS_REQUIRED','upload-only cannot report room issue');
update public.profiles set status='active',must_change_password=true where id=pg_temp.rid(2);
select throws_ok($$select pg_temp.bomb_rpc(1)$$,'42501','SUBMISSION_ACCESS_REQUIRED','password-incomplete maid cannot report');
update public.profiles set must_change_password=false where id=pg_temp.rid(2);
insert into report_results values('bomb',pg_temp.bomb_rpc(1)),('issue',pg_temp.issue_rpc());
select is((select count(*) from public.notifications where event_family='bomb.reported_admin'),4::bigint,'bomb report immediately notifies all business admins');
select is((select count(*) from public.notifications where event_family='room_issue.reported_admin'),4::bigint,'room issue immediately notifies all business admins');
select is((select count(*) from private.notification_delivery_outbox where event_family='bomb.reported_admin'),2::bigint,'bomb push only active password-complete nonself admins');
select is((select count(*) from private.notification_delivery_outbox where event_family='room_issue.reported_admin'),2::bigint,'room issue push excludes inactive and password-incomplete admins');
select ok((select bool_and(n.actor_profile_id=pg_temp.rid(2) and n.source_entity_kind='bomb_room_report'
 and n.source_entity_id=(select value->>'id' from report_results where label='bomb')
 and n.category='bomb_room_reported' and n.room_id=t.room_id and n.cleaning_target_id=t.id
 and n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id=t.id and n.occurred_at=a.recorded_at
 and not n.requires_action and n.resolved_at is null)
 from public.notifications n join public.cleaning_targets t on t.id=n.cleaning_target_id
 join public.audit_events a on a.entity_id=(select (value->>'id')::uuid from report_results where label='bomb')
 and a.event_type='submission.bomb_reported' where n.event_family='bomb.reported_admin'),
 'bomb notices bind exact immutable source, actor, target, category and audit time');
select ok((select bool_and(n.actor_profile_id=pg_temp.rid(2) and n.source_entity_kind='attempt_room_issue_report'
 and n.source_entity_id=(select value->>'id' from report_results where label='issue')
 and n.category='room_issue_reported' and n.room_id=t.room_id and n.cleaning_target_id=t.id
 and n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id=t.id and n.occurred_at=a.recorded_at
 and not n.requires_action and n.resolved_at is null)
 from public.notifications n join public.cleaning_targets t on t.id=n.cleaning_target_id
 join public.audit_events a on a.after_state->>'issueId'=(select value->>'id' from report_results where label='issue')
 and a.event_type='room.report_issue' where n.event_family='room_issue.reported_admin'),
 'room issue notices bind exact immutable source, actor, target, category and audit time');
select is(pg_temp.bomb_rpc(1),(select value from report_results where label='bomb'),'same key bomb receipt replays');
select is(pg_temp.issue_rpc(),(select value from report_results where label='issue'),'same key room issue receipt replays');
select throws_ok($$select pg_temp.bomb_rpc(1,2,'report-bomb-command',repeat('d',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','bomb receipt payload conflict');
select throws_ok($$select pg_temp.issue_rpc(2,'report-issue-command',repeat('d',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','issue receipt payload conflict');
select throws_ok($$select pg_temp.bomb_rpc(1,2,'report-bomb-new-key')$$,'22023','INVALID_BOMB_REPORT','new key cannot regenerate bomb report');
select is((select count(*) from public.notifications where event_family='bomb.reported_admin'),4::bigint,'replays do not regenerate notices');
insert into auth.users(id) values(pg_temp.rid(108));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
 login_sequence,role,status,must_change_password)
values(pg_temp.rid(8),pg_temp.rid(108),'late-admin','late-admin','late-admin','late-admin',0,'admin','active',false);
select is(pg_temp.bomb_rpc(1),(select value from report_results where label='bomb'),'late admin creation does not change replay');
select is((select count(*) from public.notifications where event_family='bomb.reported_admin' and recipient_profile_id=pg_temp.rid(8)),0::bigint,'replay does not backfill late admin');
insert into report_results values('submission',public.create_cleaning_submission(pg_temp.rid(2),pg_temp.rid(3001),
 pg_temp.rid(5001),0,0,'report-submission-command',repeat('d',64)));
create function pg_temp.decision_rpc(p_actor integer default 1,p_key text default 'report-decision-command',p_hash text default null)
returns jsonb language sql as $$
 select public.decide_bomb_room(pg_temp.rid(p_actor),(select (value->>'id')::uuid from report_results where label='submission'),
 'approved','BOMB_CONFIRMED',p_key,coalesce(p_hash,repeat('e',64))) $$;
select throws_ok($$select pg_temp.decision_rpc(2)$$,'42501','ADMIN_REQUIRED','maid cannot decide bomb report');
select throws_ok($$select pg_temp.decision_rpc(5)$$,'42501','ADMIN_REQUIRED','password-incomplete admin cannot decide');
update public.profiles set status='inactive' where id=pg_temp.rid(1);
select throws_ok($$select pg_temp.decision_rpc()$$,'42501','ADMIN_REQUIRED','inactive admin cannot decide');
update public.profiles set status='active' where id=pg_temp.rid(1);
insert into report_results values('decision',pg_temp.decision_rpc());
select is((select count(*) from public.notifications where event_family='bomb.decided_maid'),1::bigint,'bomb predecision immediately informs original report maid');
select is((select count(*) from private.notification_delivery_outbox where event_family='bomb.decided_maid'),1::bigint,'active original maid receives informational decision push');
select is((select recipient_profile_id from public.notifications where event_family='bomb.decided_maid'),pg_temp.rid(2),'decision never targets other maid');
select ok((select n.actor_profile_id=pg_temp.rid(1) and n.source_entity_kind='bomb_room_decision'
 and n.source_entity_id=(select value->>'id' from report_results where label='decision')
 and n.category='bomb_room_decided' and n.deep_link_kind='submission'
 and n.occurred_at=a.recorded_at and not n.requires_action and n.resolved_at is null
 from public.notifications n join public.audit_events a on a.entity_id=(select (value->>'id')::uuid from report_results where label='decision')
 and a.event_type='inspection.bomb_decided' where n.event_family='bomb.decided_maid'),
 'decision notice binds exact immutable admin decision and audit time');
select is(pg_temp.decision_rpc(),(select value from report_results where label='decision'),'decision replay keeps same immutable result');
select throws_ok($$select pg_temp.decision_rpc(1,'report-decision-new-key')$$,'40001','BOMB_DECISION_ALREADY_RECORDED','new key cannot recreate decision');
select is((select count(*) from public.earnings),0::bigint,'bomb decision alone creates no earning');
select is((select count(*) from public.inspection_decisions),0::bigint,'bomb predecision does not finalize inspection');
select ok(not exists(select 1 from public.notifications where body like '%sensitive-memo-sentinel%' or title like '%sensitive-memo-sentinel%'),
 'notice never copies memo');
select ok((select bool_and(n.deep_link_kind='cleaningTarget' and n.deep_link_entity_id=n.cleaning_target_id)
 from public.notifications n where event_family in ('bomb.reported_admin','room_issue.reported_admin')),'report links only safe public target IDs');
select is((select deep_link_entity_id from public.notifications where event_family='bomb.decided_maid'),
 (select (value->>'id')::uuid from report_results where label='submission'),'decision links only public submission ID');
select ok((select bool_and(not has_function_privilege(role,f,'EXECUTE')) from unnest(array['anon','authenticated','service_role']) role
 cross join unnest(array['private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)',
 'private.notification_source_is_valid_before_cleaning_reports(text,uuid,uuid,text,uuid,uuid,uuid)',
 'private.dispatch_cleaning_report_decision_notification()']) f),'new private source and dispatch helpers deny runtime execution');
-- Force a delivery insert failure: report/audit/inbox/groups/receipt must all roll back.
create function pg_temp.fail_report_delivery() returns trigger language plpgsql as $$
begin if new.event_family='bomb.reported_admin' then raise exception using errcode='23514',message='REPORT_TEST_FAILURE'; end if; return new; end $$;
create trigger fail_report_delivery before insert on private.notification_delivery_outbox for each row execute function pg_temp.fail_report_delivery();
select throws_ok($$select pg_temp.bomb_rpc(3,2,'report-bomb-atomic-fail')$$,'23514','REPORT_TEST_FAILURE','notification failure rejects entire original command');
select is((select count(*) from private.bomb_room_reports where cleaning_attempt_id=pg_temp.rid(3003)),0::bigint,'failed notification rolls back report');
select is((select count(*) from public.audit_events where event_type='submission.bomb_reported' and after_state->>'attemptId'=pg_temp.rid(3003)::text),0::bigint,'failed notification rolls back audit');
select is((select count(*) from private.command_executions where idempotency_key='report-bomb-atomic-fail'),0::bigint,'failed notification rolls back receipt');
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.rid(1003)),0::bigint,'failed notification rolls back inbox');
drop trigger fail_report_delivery on private.notification_delivery_outbox;
select lives_ok($$select pg_temp.bomb_rpc(3,2,'report-bomb-atomic-fail')$$,'same key succeeds after atomic rollback');
-- Exact current GUC does not make an immutable historical source replay eligible.
select set_config('app.notification_terminal_kind','audit_event',true);
select set_config('app.notification_terminal_id',(select id::text from public.audit_events where event_type='inspection.bomb_decided'),true);
select ok(not private.notification_source_is_valid('bomb.decided_maid',pg_temp.rid(1),pg_temp.rid(3),
 (select value->>'id' from report_results where label='decision'),
 (select room_id from public.cleaning_targets where id=pg_temp.rid(1001)),pg_temp.rid(1001),
 (select (value->>'id')::uuid from report_results where label='submission')),'forged decision recipient is denied');
select ok(not private.notification_source_is_valid('bomb.decided_maid',pg_temp.rid(6),pg_temp.rid(2),
 (select value->>'id' from report_results where label='decision'),
 (select room_id from public.cleaning_targets where id=pg_temp.rid(1001)),pg_temp.rid(1001),
 (select (value->>'id')::uuid from report_results where label='submission')),'forged decision actor is denied');
select throws_ok($$insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
 actor_display_name_snapshot,effective_at,reason_code,after_state)
 select event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,reason_code,after_state
 from public.audit_events where event_type='inspection.bomb_decided'$$,'23514','NOTIFICATION_PROVENANCE_INVALID','duplicate audit cannot backfill decision notice');
select is((select count(*) from public.notifications where event_family='bomb.decided_maid'),1::bigint,'duplicate audit attempt leaves original notice unchanged');
select set_config('app.notification_terminal_id',(select id::text from public.audit_events where event_type='room.report_issue'),true);
select ok(not private.notification_source_is_valid('room_issue.reported_admin',pg_temp.rid(2),pg_temp.rid(3),
 (select value->>'id' from report_results where label='issue'),
 (select room_id from public.cleaning_targets where id=pg_temp.rid(1002)),pg_temp.rid(1002),pg_temp.rid(1002)),
 'room issue cannot target a different maid');
select ok(not private.notification_source_is_valid('room_issue.reported_admin',pg_temp.rid(2),pg_temp.rid(1),
 (select value->>'id' from report_results where label='issue'),
 (select room_id from public.cleaning_targets where id=pg_temp.rid(1001)),pg_temp.rid(1002),pg_temp.rid(1002)),
 'room issue cannot bind a different room');
select ok(not private.notification_source_is_valid('room_issue.reported_admin',pg_temp.rid(2),pg_temp.rid(1),
 (select value->>'id' from report_results where label='issue'),
 (select room_id from public.cleaning_targets where id=pg_temp.rid(1002)),pg_temp.rid(1002),pg_temp.rid(1001)),
 'room issue cannot link a different target');
select ok(not private.notification_source_is_valid('bomb.reported_admin',pg_temp.rid(2),pg_temp.rid(1),
 (select value->>'id' from report_results where label='issue'),
 (select room_id from public.cleaning_targets where id=pg_temp.rid(1002)),pg_temp.rid(1002),pg_temp.rid(1002)),
 'typed source cannot be relabelled across report families');
select ok(not private.notification_source_is_valid('bomb.reported_admin',pg_temp.rid(2),pg_temp.rid(1),
 'malformed-identity',pg_temp.rid(1002),pg_temp.rid(1002),pg_temp.rid(1002)),
 'malformed UUID returns false without raw database error');
select throws_ok($$insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
 actor_display_name_snapshot,effective_at,after_state)
 select event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state
 from public.audit_events where event_type='room.report_issue'$$,'23514','NOTIFICATION_PROVENANCE_INVALID','duplicate room report audit cannot backfill notices');
-- Different room-issue key represents a genuinely new report, not a replay.
select lives_ok($$select pg_temp.issue_rpc(2,'report-issue-new-source')$$,'new issue key creates separate immutable report');
select is((select count(*) from private.attempt_room_issue_reports where cleaning_attempt_id=pg_temp.rid(3002)),2::bigint,'separate issue reports keep separate provenance');
select is((select count(*) from public.notifications where event_family='room_issue.reported_admin'),9::bigint,'second source notifies existing and late business admins once');
-- A report's original subject is immutable even after account state/role changes.
select pg_temp.report_photo(3,'cleaning-proof',4005);
insert into report_results values('self-submission',public.create_cleaning_submission(pg_temp.rid(2),pg_temp.rid(3003),
 pg_temp.rid(5003),0,0,'report-self-submission',repeat('d',64)));
update public.profiles set role='admin' where id=pg_temp.rid(2);
insert into report_results values('self-decision',public.decide_bomb_room(pg_temp.rid(2),
 (select (value->>'id')::uuid from report_results where label='self-submission'),
 'approved','BOMB_CONFIRMED','report-self-decision',repeat('e',64)));
select is((select count(*) from public.notifications where event_family='bomb.decided_maid'
 and source_entity_id=(select value->>'id' from report_results where label='self-decision')),
 1::bigint,'self decision preserves immutable original-report inbox subject');
select is((select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.event_family='bomb.decided_maid' and n.source_entity_id=(select value->>'id' from report_results where label='self-decision')),
 0::bigint,'self action never creates push even after role transition');
update public.profiles set role='maid' where id=pg_temp.rid(2);
select pg_temp.report_fixture(4);
insert into report_photos values(4,'cleaning-proof',pg_temp.report_photo(4,'cleaning-proof',4006)),
 (4,'bomb-proof',pg_temp.report_photo(4,'bomb-proof',4007));
select pg_temp.bomb_rpc(4,2,'report-inactive-subject-bomb');
insert into report_results values('inactive-submission',public.create_cleaning_submission(pg_temp.rid(2),pg_temp.rid(3004),
 pg_temp.rid(5004),0,0,'report-inactive-submission',repeat('d',64)));
update public.profiles set status='inactive' where id=pg_temp.rid(2);
insert into report_results values('inactive-decision',public.decide_bomb_room(pg_temp.rid(1),
 (select (value->>'id')::uuid from report_results where label='inactive-submission'),
 'rejected','BOMB_NOT_CONFIRMED','report-inactive-decision',repeat('e',64)));
select is((select count(*) from public.notifications where event_family='bomb.decided_maid'
 and source_entity_id=(select value->>'id' from report_results where label='inactive-decision')),
 1::bigint,'inactive original maid still retains decision inbox history');
select is((select count(*) from private.notification_delivery_outbox o join public.notifications n on n.id=o.notification_id
 where n.event_family='bomb.decided_maid' and n.source_entity_id=(select value->>'id' from report_results where label='inactive-decision')),
 0::bigint,'inactive original maid does not receive decision push');
select * from finish();
rollback;
