begin;
select no_plan();
create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
 select ('30000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,4)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),'photo developer','photo developer','0030','photo-bootstrap-hash','photo-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'photo-'||n,'photo-'||n,'photo-'||n,'photo-'||n,0,
 case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,3)n;
create function pg_temp.slots(n integer,p_tv boolean default true) returns jsonb language sql immutable as $$
 select jsonb_agg(jsonb_build_object('slotKey',case when p_tv and i=1 then 'tv-on' else 'slot-'||i end,
  'required',i<n,'displayOrder',i-1,'sectionKey','synthetic-section','label','합성 사진','description','정책 seed 아님',
  'instanceNumber',1,'instanceCount',1) order by i)
 from generate_series(1,n)i
$$;
create function pg_temp.snapshot(v integer,n integer,p_tv boolean default true,p_type text default 'standard') returns jsonb language sql immutable as $$
 select jsonb_build_object('templateVersionId',pg_temp.pid(200),'version',v,'roomTypeCode',p_type,'cleaningKind','checkout','slots',pg_temp.slots(n,p_tv))
$$;
select ok(private.photo_snapshot_valid(pg_temp.snapshot(7,10)),'v7 standard requires 10 slots');
select ok(private.photo_snapshot_valid(pg_temp.snapshot(7,11,true,'premium')),'v7 premium requires 11 slots');
select ok(private.photo_snapshot_valid(pg_temp.snapshot(7,13,true,'oceanPremium')),'v7 ocean premium requires 13 slots');
select ok(private.photo_snapshot_valid(pg_temp.snapshot(7,15,true,'oceanFamily')),'v7 ocean family requires 15 slots');
select ok(not private.photo_snapshot_valid(pg_temp.snapshot(7,9)),'v7 wrong count fails closed');
select ok(not private.photo_snapshot_valid(pg_temp.snapshot(7,10,false)),'v7 missing required tv-on fails closed');
select ok(private.photo_snapshot_valid(pg_temp.snapshot(6,9,false)),'v6 explicit historical slots are not retrofitted with tv-on or v7 count');
select ok(not private.photo_snapshot_valid(pg_temp.snapshot(1,0)),'empty legacy snapshot is not zero-photo completion');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(7,10),'{roomTypeCode}','null')),'JSON null room type is invalid');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(7,10),'{templateVersionId}','null')),'JSON null identity is invalid');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(7,10),'{cleaningKind}','null')),'JSON null kind is invalid');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(6,1),'{slots,0,required}','false')),'all optional is unconfigured, no guessed required slot');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(7,10),'{slots,1,slotKey}','"tv-on"')),'duplicate slot key rejected');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(7,10),'{slots,1,displayOrder}','0')),'duplicate display order rejected');
select ok(not private.photo_snapshot_valid(jsonb_set(pg_temp.snapshot(7,10),'{slots,1,displayOrder}','100')),'technical display order cap enforced');

-- Synthetic non-checkout slots test the generic model, not an approved operational template.
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(200),id,'additional',7,'published',1,pg_temp.slots(2,false),pg_temp.pid(1) from public.room_types where code='standard';
select is((select count(*) from private.photo_template_slots where template_version_id=pg_temp.pid(200)),2::bigint,'published explicit template is materialized as stable slot rows');
select throws_ok($$update public.cleaning_template_versions set photo_slots='[]' where id=pg_temp.pid(200)$$,'55000','PHOTO_TEMPLATE_IMMUTABLE','published template payload is immutable');
select throws_ok($$delete from public.cleaning_template_versions where id=pg_temp.pid(200)$$,'55000','PHOTO_TEMPLATE_IMMUTABLE','template deletion prohibited');
select throws_ok($$update private.photo_template_slots set required=false where template_version_id=pg_temp.pid(200)$$,'55000','PHOTO_MODEL_IMMUTABLE','normalized template slots immutable');

create function pg_temp.photo_fixture(n integer,p_maid integer default 2,p_legacy boolean default false,p_notified boolean default true)
returns void language plpgsql as $$
declare r public.rooms; snapshot jsonb;
begin
 select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset n limit 1;
 snapshot:=case when p_legacy then jsonb_build_object('id',pg_temp.pid(999),'version',1,'photoSlots','[]'::jsonb)
  else jsonb_build_object('id',pg_temp.pid(200),'version',7,'photoSlots',pg_temp.slots(2,false),'durationMinutes',1) end;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.pid(300+n),r.id,'additional','manual_room_request','photo-target-'||n,current_date,current_date,
  case when p_notified then 'notified' else 'draft_assigned' end::public.cleaning_target_status,2,
  jsonb_build_object('code','standard'),10000,snapshot,pg_temp.pid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.pid(400+n),pg_temp.pid(300+n),pg_temp.pid(p_maid),n+1,2,case when p_notified then clock_timestamp()-interval '2 hours' end,pg_temp.pid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
  template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
 values(pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(p_maid),1,'field_completed',2,
  snapshot,jsonb_build_object('roomId',r.id),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour');
end; $$;
select pg_temp.photo_fixture(1);
select pg_temp.photo_fixture(2,3);
select pg_temp.photo_fixture(3,2,true);
select pg_temp.photo_fixture(4,2,false,false);
create function pg_temp.slot(n integer,k text default 'slot-1') returns uuid language sql stable as $$
 select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(300+n) and slot_key=k
$$;
select is((select count(*) from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(301)),2::bigint,'target creation snapshots normalized slot rows');
select ok((select frozen_snapshot->'slots'->0->>'label'='합성 사진' from private.target_photo_snapshot_contracts where cleaning_target_id=pg_temp.pid(301)),'full label/description/section metadata preserved in frozen JSON');
select ok((select slot_snapshot->>'sectionKey'='synthetic-section' and slot_snapshot->>'label'='합성 사진'
  and slot_snapshot->>'description'='정책 seed 아님' and slot_snapshot->>'instanceNumber'='1' and slot_snapshot->>'instanceCount'='1'
  from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(301) and slot_key='slot-1'),'normalized slot row retains full section/label/description/repeated instance object');
select ok(not (select ready from private.target_photo_snapshot_contracts where cleaning_target_id=pg_temp.pid(303)),'legacy empty target remains readable but unconfigured for evidence');
select ok(not private.photo_attempt_complete(pg_temp.pid(503),clock_timestamp()),'legacy empty target is incomplete');
select ok(not private.photo_attempt_complete(pg_temp.pid(501),clock_timestamp()),'ready slots without photos are incomplete');
select throws_ok($$insert into private.target_photo_slot_snapshots(cleaning_target_id,template_version_id,slot_key,display_order,required)
 values(pg_temp.pid(301),pg_temp.pid(200),'invented-slot',90,true)$$,'23514','PHOTO_SLOT_INVALID','no invented slot beyond frozen snapshot');
select throws_ok($$insert into private.target_photo_slot_snapshots(cleaning_target_id,template_version_id,slot_key,display_order,required,slot_snapshot)
 select cleaning_target_id,template_version_id,slot_key,display_order,required,jsonb_set(slot_snapshot,'{label}','"변조"')
 from private.target_photo_slot_snapshots where id=pg_temp.slot(1)$$,'23514','PHOTO_SLOT_INVALID','metadata-only target slot forgery rejected before duplicate-key check');
select throws_ok($$insert into private.photo_template_slots(template_version_id,slot_key,display_order,required,slot_snapshot)
 select template_version_id,slot_key,display_order,required,jsonb_set(slot_snapshot,'{description}','"변조"')
 from private.photo_template_slots where template_version_id=pg_temp.pid(200) and slot_key='slot-1'$$,'23514','PHOTO_SLOT_INVALID','metadata-only template slot forgery rejected');
select throws_ok($$update public.cleaning_targets set template_snapshot='{}' where id=pg_temp.pid(301)$$,'55000','PHOTO_TARGET_SNAPSHOT_IMMUTABLE','target JSON snapshot cannot be rewritten');

create temp table photo_results(label text primary key,id uuid);
insert into photo_results values('first',private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),0,repeat('a',64),'image/jpeg',100,clock_timestamp()-interval '30 minutes'));
select ok(private.photo_attempt_complete(pg_temp.pid(501),clock_timestamp()),'verified required photo completes model even with optional slot empty');
-- Explicit corruption drill, not a production path: restore the append-only trigger immediately.
savepoint photo_slot_corruption;
drop trigger photo_model_append_only on private.target_photo_slot_snapshots;
delete from private.target_photo_slot_snapshots where id=pg_temp.slot(1,'slot-2');
select ok(not private.photo_attempt_complete(pg_temp.pid(501),clock_timestamp()),'missing normalized optional row fails complete-set validation even when required photo exists');
rollback to savepoint photo_slot_corruption;
release savepoint photo_slot_corruption;
select throws_ok($$delete from private.target_photo_slot_snapshots where id=pg_temp.slot(1,'slot-2')$$,'55000','PHOTO_MODEL_IMMUTABLE','corruption drill restores real immutable trigger');
savepoint empty_slot_corruption;
drop trigger photo_model_append_only on private.target_photo_slot_snapshots;
delete from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(302);
select ok(not private.photo_attempt_complete(pg_temp.pid(502),clock_timestamp()),'ready frozen contract with zero normalized rows cannot use vacuous completeness');
rollback to savepoint empty_slot_corruption;
release savepoint empty_slot_corruption;
select is((select count(*) from private.attempt_photo_changes where cleaning_attempt_id=pg_temp.pid(501)),1::bigint,'pointer mutation atomically appends history');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),0,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'40001','PHOTO_VERSION_CONFLICT','reusing stale CAS cannot create another version');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(3),pg_temp.pid(501),pg_temp.slot(1),1,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'42501','PHOTO_ACCESS_REQUIRED','other maid denied');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(1),pg_temp.pid(501),pg_temp.slot(1),1,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'42501','PHOTO_ACCESS_REQUIRED','admin cannot fabricate maid evidence');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(4),pg_temp.pid(501),pg_temp.slot(1),1,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'42501','PHOTO_ACCESS_REQUIRED','developer cannot fabricate maid evidence');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(2),0,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'23514','PHOTO_SLOT_INVALID','another target slot rejected');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(504),pg_temp.slot(4),0,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'42501','CAPABILITY_ACCESS_REQUIRED','never-notified assignment cannot use evidence helper');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),null,0,repeat('a',64),'image/jpeg',100,clock_timestamp())$$,'23514','PHOTO_SLOT_INVALID','NULL template evidence slot rejected');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),1,repeat('a',64),'image/jpeg',100,clock_timestamp()+interval '1 hour')$$,'23514','PHOTO_UPLOAD_TIME_INVALID','future upload time cannot extend retention');

insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,photo_manifest,submitted_by)
values(pg_temp.pid(601),pg_temp.pid(501),pg_temp.pid(701),1,'{"legacyClaim":"not trusted"}',pg_temp.pid(2));
select is(private.bind_submission_photo_model(pg_temp.pid(2),pg_temp.pid(601),0),1::bigint,'owner-only model binding links existing canonical submission');
select is((select count(*) from private.submission_photo_bindings where submission_id=pg_temp.pid(601)),1::bigint,'submitted binding contains verified current version only');
select throws_ok($$update public.cleaning_submissions set photo_manifest='[]' where id=pg_temp.pid(601)$$,'55000','SUBMISSION_PAYLOAD_IMMUTABLE','unconsumed submission payload is immutable');
select throws_ok($$delete from public.cleaning_submissions where id=pg_temp.pid(601)$$,'55000','SUBMISSION_PAYLOAD_IMMUTABLE','submission deletion prohibited');
select throws_ok($$update private.submission_photo_bindings set photo_version=9 where submission_id=pg_temp.pid(601)$$,'55000','PHOTO_MODEL_IMMUTABLE','submission membership immutable');
select throws_ok($$delete from private.submission_photo_bindings where submission_id=pg_temp.pid(601)$$,'55000','PHOTO_MODEL_IMMUTABLE','submission membership cannot be deleted');
select throws_ok($$insert into private.submission_photo_bindings select * from private.submission_photo_bindings where submission_id=pg_temp.pid(601)$$,'55000','SUBMISSION_PHOTO_BINDING_INVALID','sealed membership cannot append even duplicate photo');

insert into photo_results values('second',private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),1,repeat('b',64),'image/webp',200,clock_timestamp()-interval '10 minutes'));
select is((select photo_version_id from private.submission_photo_bindings where submission_id=pg_temp.pid(601)),(select id from photo_results where label='first'),'retake leaves prior submission bound to original photo');
select is((select count(*) from private.attempt_photo_versions where cleaning_attempt_id=pg_temp.pid(501)),2::bigint,'retake preserves prior immutable version');
select throws_ok($$update private.attempt_photo_versions set uploaded_at=clock_timestamp() where id=(select id from photo_results where label='first')$$,'55000','PHOTO_MODEL_IMMUTABLE','retry cannot refresh immutable upload clock');
update public.cleaning_submissions set status='superseded',superseded_at=clock_timestamp() where id=pg_temp.pid(601);
insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,photo_manifest,submitted_by)
values(pg_temp.pid(602),pg_temp.pid(501),pg_temp.pid(702),2,'[]',pg_temp.pid(2));
select is(private.bind_submission_photo_model(pg_temp.pid(2),pg_temp.pid(602),1),2::bigint,'resubmission advances current pointer CAS without creating another domain submission');
select is((select photo_version_id from private.submission_photo_bindings where submission_id=pg_temp.pid(602)),(select id from photo_results where label='second'),'new submission links current version');
select is((select count(*) from private.attempt_photo_versions where cleaning_attempt_id=pg_temp.pid(501)),2::bigint,'resubmission does not copy/re-upload files');
select throws_ok($$select private.bind_submission_photo_model(pg_temp.pid(2),pg_temp.pid(602),1)$$,'40001','SUBMISSION_VERSION_CONFLICT','submission pointer stale CAS rejected');
select is(private.clear_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),2),3::bigint,'clear writes a null current pointer revision without deleting evidence');
select ok(not private.photo_attempt_complete(pg_temp.pid(501),clock_timestamp()),'clear makes required slot incomplete');
select is((select count(*) from private.submission_photo_bindings where submission_id in (pg_temp.pid(601),pg_temp.pid(602))),2::bigint,'clear preserves both prior submissions');
select is((select count(*) from private.attempt_photo_changes where cleaning_attempt_id=pg_temp.pid(501)),3::bigint,'replace/clear history is append-only');

insert into photo_results values('third',private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),3,repeat('c',64),'image/jpeg',150,clock_timestamp()-interval '1 minute'));
select ok(not private.photo_attempt_complete(pg_temp.pid(501),(select purge_after from private.attempt_photo_versions where id=(select id from photo_results where label='third'))),'exact seven-day expiry is incomplete');
select throws_ok($$insert into private.attempt_photo_purge_states values((select id from photo_results where label='third'),clock_timestamp())$$,'23514','PHOTO_PURGE_TIME_INVALID','purge cannot be recorded before deadline');
insert into private.attempt_photo_purge_states select id,purge_after from private.attempt_photo_versions where id=(select id from photo_results where label='third');
select ok(not private.photo_attempt_complete(pg_temp.pid(501),clock_timestamp()),'purged current version cannot count as evidence');
create function pg_temp.reject_photo_history() returns trigger language plpgsql as $$
begin raise exception using errcode='55000',message='TEST_PHOTO_HISTORY_FAILURE'; end; $$;
create trigger test_photo_history_failure before insert on private.attempt_photo_changes
for each row execute function pg_temp.reject_photo_history();
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),4,repeat('e',64),'image/jpeg',100,clock_timestamp())$$,
 '55000','TEST_PHOTO_HISTORY_FAILURE','history append failure rolls back photo version and pointer together');
drop trigger test_photo_history_failure on private.attempt_photo_changes;
select is((select count(*) from private.attempt_photo_versions where cleaning_attempt_id=pg_temp.pid(501)),3::bigint,'failed history leaves no orphan photo version');
select is((select revision from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(501) and target_photo_slot_id=pg_temp.slot(1)),4::bigint,'failed history preserves old pointer CAS');

-- A stale extra optional binding must not be sealed after the current pointer is cleared.
select private.record_validated_attempt_photo(pg_temp.pid(3),pg_temp.pid(502),pg_temp.slot(2),0,repeat('a',64),'image/jpeg',100,clock_timestamp());
select private.record_validated_attempt_photo(pg_temp.pid(3),pg_temp.pid(502),pg_temp.slot(2,'slot-2'),0,repeat('b',64),'image/jpeg',100,clock_timestamp());
insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,photo_manifest,submitted_by)
values(pg_temp.pid(604),pg_temp.pid(502),pg_temp.pid(704),1,'[]',pg_temp.pid(3));
insert into private.submission_photo_bindings(submission_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version_id,photo_version)
select pg_temp.pid(604),cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version_id,photo_version from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(502);
select private.clear_attempt_photo(pg_temp.pid(3),pg_temp.pid(502),pg_temp.slot(2,'slot-2'),1);
select ok(private.photo_attempt_complete(pg_temp.pid(502),clock_timestamp()),'clearing optional current leaves required evidence complete');
select throws_ok($$insert into private.submission_photo_binding_sets values(pg_temp.pid(604),pg_temp.pid(502),2,clock_timestamp())$$,
 '55000','PHOTO_EVIDENCE_INCOMPLETE','seal rejects stale extra optional binding using reverse set difference');

-- Exact composite identities apply even to privileged model inserts.
select throws_ok($$insert into private.attempt_photo_versions(cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,sha256,mime_type,size_bytes,uploaded_at,purge_after)
 values(pg_temp.pid(502),pg_temp.pid(301),pg_temp.slot(1),1,repeat('d',64),'image/jpeg',100,now(),now()+interval '7 days')$$,'23503',null,'attempt/target composite FK rejects another attempt');
select throws_ok($$insert into private.attempt_photo_versions(cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,sha256,mime_type,size_bytes,uploaded_at,purge_after)
 values(pg_temp.pid(501),pg_temp.pid(301),pg_temp.slot(2),5,repeat('d',64),'image/jpeg',100,now(),now()+interval '7 days')$$,'23503',null,'slot/target composite FK rejects foreign target slot');
select throws_ok($$insert into private.attempt_photo_versions(cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,sha256,mime_type,size_bytes,uploaded_at,purge_after)
 values(pg_temp.pid(501),pg_temp.pid(301),null,5,repeat('d',64),'image/jpeg',100,now(),now()+interval '7 days')$$,'23502',null,'NULL slot cannot bypass uniqueness');

update public.cleaning_template_versions set status='retired' where id=pg_temp.pid(200);
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(201),id,'additional',8,'published',1,pg_temp.slots(3,false),pg_temp.pid(1) from public.room_types where code='standard';
select is((select count(*) from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(301)),2::bigint,'new template version does not change old target slots');
select is((select template_snapshot->>'version' from public.cleaning_attempts where id=pg_temp.pid(501)),'7','attempt snapshot stays on prior version');
select is((select status::text from public.cleaning_attempts where id=pg_temp.pid(501)),'field_completed','model helpers do not advance execution/submission/review state');
select is((select count(*) from public.inspection_decisions),0::bigint,'model does not create review');
select is((select count(*) from public.earnings),0::bigint,'model does not create earnings');
select is((select count(*) from public.notifications),0::bigint,'model does not dispatch business notifications');

-- Actual reservation/manual target creators use the common snapshot bridge, including retries.
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(202),id,'checkout',7,'published',1,pg_temp.slots(10),pg_temp.pid(1) from public.room_types where code='standard';
create temp table photo_source_results(label text primary key,value jsonb);
do $$ declare r public.rooms; day date:=(clock_timestamp() at time zone 'Asia/Seoul')::date+10; response jsonb; begin
 select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset 8 limit 1;
 insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
 values(r.id,'verified',1,'TEST',pg_temp.pid(1),clock_timestamp());
 response:=public.create_reservation(pg_temp.pid(1),pg_temp.pid(801),r.id,(day+time '16:00') at time zone 'Asia/Seoul',
  (day+1+time '11:00') at time zone 'Asia/Seoul',2,null,r.state_version,'photo-reservation-create',repeat('a',64));
 insert into photo_source_results values('reservation',response);
 perform public.create_reservation(pg_temp.pid(1),pg_temp.pid(801),r.id,(day+time '16:00') at time zone 'Asia/Seoul',
  (day+1+time '11:00') at time zone 'Asia/Seoul',2,null,r.state_version,'photo-reservation-create',repeat('a',64));
 select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset 9 limit 1;
 response:=public.create_manual_cleaning_request(pg_temp.pid(1),pg_temp.pid(802),r.id,null,'additional',day,
  (day+time '10:00') at time zone 'Asia/Seoul',(day+time '11:00') at time zone 'Asia/Seoul',r.state_version,
  'TEST','photo-manual-create',repeat('b',64));
 insert into photo_source_results values('manual',response);
 perform public.create_manual_cleaning_request(pg_temp.pid(1),pg_temp.pid(802),r.id,null,'additional',day,
  (day+time '10:00') at time zone 'Asia/Seoul',(day+time '11:00') at time zone 'Asia/Seoul',r.state_version,
  'TEST','photo-manual-create',repeat('b',64));
end; $$;
select is((select count(*) from private.target_photo_slot_snapshots s join public.cleaning_targets t on t.id=s.cleaning_target_id where t.reservation_id=pg_temp.pid(801)),10::bigint,'reservation creation/retry creates exactly one 10-slot planned snapshot');
select is((select count(*) from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(802)),3::bigint,'manual request/retry snapshots current explicit v8 exactly once');
select ok((select status='private' and current_cleaning_target_id is null from public.checkout_cleaning_obligations where reservation_id=pg_temp.pid(801)),'photo slots do not materialize planned checkout obligation');
select is((select count(*) from public.cleaning_attempts a join public.cleaning_targets t on t.id=a.cleaning_target_id where t.reservation_id=pg_temp.pid(801)),0::bigint,'photo snapshot does not create pre-checkout attempt');

-- Real #7A/#7B start/handover path: old evidence capability is attempt-scoped, never current submission.
insert into auth.sessions(id,user_id) values(pg_temp.pid(901),pg_temp.pid(101));
do $$ declare r public.rooms; t public.cleaning_targets; v uuid; wk date; at_time timestamptz:=clock_timestamp(); response jsonb; begin
 select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset 5 limit 1;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,available_from,due_at,
  status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.pid(305),r.id,'additional','manual_room_request','photo-handover-target',(at_time at time zone 'Asia/Seoul')::date,(at_time at time zone 'Asia/Seoul')::date,
  (at_time at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul',((at_time at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul',
  'notified',2,jsonb_build_object('code','standard'),10000,jsonb_build_object('id',pg_temp.pid(201),'version',8,'photoSlots',pg_temp.slots(3,false),'durationMinutes',1),pg_temp.pid(1)) returning * into t;
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.pid(405),t.id,pg_temp.pid(2),50,2,at_time,pg_temp.pid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
 values(pg_temp.pid(505),t.id,pg_temp.pid(405),pg_temp.pid(2),1,'scheduled',2,t.template_snapshot,jsonb_build_object('roomId',r.id));
 perform private.execute_cleaning_attempt_at(pg_temp.pid(2),pg_temp.pid(505),1,pg_temp.pid(405),2,'photo-old-start',repeat('a',64),'start',null);
 perform private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(505),pg_temp.slot(5),0,repeat('a',64),'image/jpeg',100,clock_timestamp());
 wk:=t.effective_service_date-(extract(isodow from t.effective_service_date)::integer-1);
 insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at) values(pg_temp.pid(3),wk,1,at_time) returning id into v;
 insert into public.availability_days(availability_version_id,work_date,available) select v,wk+i,true from generate_series(0,6)i;
 response:=private.manage_cleaning_attempt_lifecycle_at(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(505),2,pg_temp.pid(405),2,
  (select account_lifecycle_version from public.profiles where id=pg_temp.pid(2)), 'interrupt_handover',
  jsonb_build_object('maidProfileId',pg_temp.pid(3),'sequenceNumber',50,'serviceDate',t.effective_service_date,
    'availableFrom',at_time,'dueAt',t.due_at,'deactivateOld',false),'ADMIN_HANDOVER','photo-handover-command',repeat('c',64),null);
 insert into photo_source_results values('handover',response);
end; $$;
select is((select status::text from public.cleaning_attempts where id=pg_temp.pid(505)),'interrupted','actual handover retires old work without rewriting its snapshot');
select lives_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),pg_temp.pid(505),pg_temp.slot(5),1,repeat('b',64),'image/jpeg',100,clock_timestamp())$$,'old owner can use valid evidence-only capability after handover');
select throws_ok($$select private.assert_photo_model_actor(pg_temp.pid(2),pg_temp.pid(505),'submit')$$,'42501','CAPABILITY_ACCESS_REQUIRED','old evidence-only capability cannot submit');
select throws_ok($$select private.record_validated_attempt_photo(pg_temp.pid(2),(select (value->'nextAttempt'->>'attemptId')::uuid from photo_source_results where label='handover'),pg_temp.slot(5),0,repeat('b',64),'image/jpeg',100,clock_timestamp())$$,'42501','PHOTO_ACCESS_REQUIRED','old owner cannot attach photo to new maid attempt');
select is((select count(*) from private.attempt_photo_current where cleaning_attempt_id=(select (value->'nextAttempt'->>'attemptId')::uuid from photo_source_results where label='handover')),0::bigint,'old evidence never populates new attempt pointer');
select ok(not private.photo_attempt_complete((select (value->'nextAttempt'->>'attemptId')::uuid from photo_source_results where label='handover'),clock_timestamp()),'new attempt has no inherited complete evidence');
select is((select count(*) from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(305)),3::bigint,'handover reuses exact target slot identities without duplicate snapshot rows');
do $$ declare next_attempt public.cleaning_attempts; begin
 select * into next_attempt from public.cleaning_attempts where id=(select (value->'nextAttempt'->>'attemptId')::uuid from photo_source_results where label='handover');
 perform private.execute_cleaning_attempt_at(pg_temp.pid(3),next_attempt.id,1,next_attempt.assignment_id,next_attempt.assignment_revision,
  'photo-new-start',repeat('d',64),'start',null);
 perform private.execute_cleaning_attempt_at(pg_temp.pid(3),next_attempt.id,2,next_attempt.assignment_id,next_attempt.assignment_revision,
  'photo-new-complete',repeat('e',64),'complete_field_work',null);
end; $$;
select is((select status::text from public.cleaning_attempts where id=(select (value->'nextAttempt'->>'attemptId')::uuid from photo_source_results where label='handover')),
 'field_completed','actual physical completion succeeds without any photos');
select ok(not private.photo_attempt_complete((select (value->'nextAttempt'->>'attemptId')::uuid from photo_source_results where label='handover'),clock_timestamp()),'physical completion still cannot manufacture submission evidence');

select ok(bool_and(c.relrowsecurity),'all private model tables have RLS') from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname='private' and c.relname in ('photo_template_slots','target_photo_snapshot_contracts','target_photo_slot_snapshots','attempt_photo_versions','attempt_photo_purge_states','attempt_photo_current','attempt_photo_changes','submission_photo_bindings','submission_photo_binding_sets','submission_current_pointers');
select ok(not has_function_privilege(r,fn,'EXECUTE'),r||' cannot execute model helper '||fn)
from unnest(array['anon','authenticated','service_role'])r cross join unnest(array[
 'private.record_validated_attempt_photo(uuid,uuid,uuid,bigint,text,text,integer,timestamptz)',
 'private.clear_attempt_photo(uuid,uuid,uuid,bigint)','private.bind_submission_photo_model(uuid,uuid,bigint)',
 'private.photo_attempt_complete(uuid,timestamptz)'])fn;
select ok(not has_table_privilege(r,'private.attempt_photo_versions','SELECT,INSERT,UPDATE,DELETE'),r||' cannot read/write raw model')
from unnest(array['anon','authenticated','service_role'])r;
select ok(not has_table_privilege('service_role',t,'INSERT,UPDATE,DELETE'),'legacy raw write bypass denied: '||t)
from unnest(array['public.cleaning_submissions','public.submission_photos'])t;
set local role service_role;
select throws_ok($$select * from private.attempt_photo_versions$$,'42501',null,'actual service-role raw table read denied');
select throws_ok($$select private.photo_attempt_complete('30000000-0000-4000-8000-000000000501',now())$$,'42501',null,'actual service-role model call denied');
reset role;
set constraints all immediate;
select * from finish();
rollback;
