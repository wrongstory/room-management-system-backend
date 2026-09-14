begin;
\ir room_pin_fixture.psql
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('91000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,6)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(6),pg_temp.pid(106),'submission developer','submission developer','0031','submission-bootstrap-hash','submission-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'submission-'||n,'submission-'||n,'submission-'||n,'submission-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,
  (case when n=4 then 'inactive' when n=5 then 'upload_only' else 'active' end)::public.account_status,false
from generate_series(1,5)n;

create function pg_temp.slots() returns jsonb language sql immutable as $$
 select jsonb_build_array(jsonb_build_object('slotKey','proof','required',true,'displayOrder',0,
  'sectionKey','submission','label','완료 증빙','description','합성 테스트 증빙','instanceNumber',1,'instanceCount',1))
$$;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(200),id,'additional',6,'published',30,pg_temp.slots(),pg_temp.pid(1) from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(201),id,'reclean',6,'published',25,pg_temp.slots(),pg_temp.pid(1) from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(202),id,'checkout',6,'published',30,pg_temp.slots(),pg_temp.pid(1) from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(203),id,'stayover',6,'published',30,pg_temp.slots(),pg_temp.pid(1) from public.room_types where code='standard';

create function pg_temp.fixture(n integer,p_maid integer default 2,p_status public.attempt_status default 'field_completed',p_fee integer default 12000,p_kind public.cleaning_kind default 'additional')
returns void language plpgsql as $$
declare room_row public.rooms; snapshot jsonb; started timestamptz:=clock_timestamp()-interval '2 hours';
begin
 select * into room_row from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset n limit 1;
 snapshot:=jsonb_build_object('id',case when p_kind='stayover' then pg_temp.pid(203) else pg_temp.pid(200) end,'version',6,'durationMinutes',30,'photoSlots',pg_temp.slots());
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
   available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.pid(300+n),room_row.id,p_kind,case when p_kind='stayover' then 'stayover_request' else 'manual_room_request' end,'submission-target-'||n,current_date,current_date,
   started-interval '1 hour',clock_timestamp()+interval '1 day','notified',2,
   jsonb_build_object('id',(select id from public.room_types where code='standard'),'code','standard'),
   p_fee,snapshot,pg_temp.pid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,is_current,notified_at,changed_by)
 values(pg_temp.pid(400+n),pg_temp.pid(300+n),pg_temp.pid(p_maid),current_date,n+1,2,true,started-interval '1 hour',pg_temp.pid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
   started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
 values(pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(p_maid),1,p_status,2,
   case when p_status='scheduled' then null else started end,
   case when p_status='field_completed' then started+interval '1 hour' end,
   case when p_status='field_completed' then started+interval '1 hour' end,
   snapshot,jsonb_build_object('roomId',room_row.id,'roomNumber',room_row.room_number));
end $$;
create function pg_temp.slot(n integer) returns uuid language sql stable as $$
 select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(300+n) and slot_key='proof'
$$;
create function pg_temp.photo(n integer,p_actor integer default 2,p_revision bigint default 0) returns uuid language sql as $$
 select private.record_validated_attempt_photo(pg_temp.pid(p_actor),pg_temp.pid(500+n),pg_temp.slot(n),p_revision,
   repeat(substr(n::text,1,1),64),'image/jpeg',100,clock_timestamp()-interval '10 minutes')
$$;
create function pg_temp.submit(n integer,p_actor integer default 2,p_revision bigint default 0,p_key text default null) returns jsonb language sql as $$
 select public.create_cleaning_submission(pg_temp.pid(p_actor),pg_temp.pid(500+n),gen_random_uuid(),p_revision,0,
   coalesce(p_key,'submission-key-'||n),repeat(substr(n::text,1,1),64))
$$;

select pg_temp.fixture(1); select pg_temp.fixture(2); select pg_temp.fixture(3); select pg_temp.fixture(4);
select pg_temp.fixture(5); select pg_temp.fixture(6,2,'scheduled'); select pg_temp.fixture(7); select pg_temp.fixture(8,3);
select pg_temp.fixture(14,2,'field_completed',0);
select is((select count(*) from public.cleaning_submissions),0::bigint,'field_completed alone creates no submission');
select is((select count(*) from public.earnings),0::bigint,'field_completed alone creates no earning');
select is((select count(*) from public.notifications),0::bigint,'field_completed alone creates no notification');
select throws_ok($$select pg_temp.submit(4)$$,'55000','PHOTO_EVIDENCE_INCOMPLETE','required current evidence is mandatory');

select pg_temp.photo(1); select pg_temp.photo(2); select pg_temp.photo(3); select pg_temp.photo(5); select pg_temp.photo(7); select pg_temp.photo(8,3);
select pg_temp.photo(14);
create temp table submission_results(label text primary key,value jsonb);
insert into submission_results values('approve',pg_temp.submit(1));
select is((select value->>'version' from submission_results where label='approve'),'1','first submission version is immutable version one');
select is((select value->>'currentRevision' from submission_results where label='approve'),'1','first submission advances current pointer CAS');
select is((select count(*) from private.submission_photo_bindings where submission_id=(select (value->>'id')::uuid from submission_results where label='approve')),1::bigint,'submission seals exact current photo set');
select is((public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='approve'))
  ->'reviewContext'->>'cleaningTargetId')::uuid,pg_temp.pid(301),
  'admin detail identifies the immutable cleaning work item');
select ok(public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='approve'))
  ->'reviewContext' @> jsonb_build_object('cleaningKind','additional','serviceDate',current_date::text,'maidProfileId',pg_temp.pid(2)),
  'admin detail includes safe service date, kind and maid identity from frozen work records');
select ok(not ((select result from public.list_cleaning_submissions(pg_temp.pid(2),pg_temp.pid(501),false) result limit 1) ? 'reviewContext'),
  'maid submission history never exposes admin review context or other-maid identity');

-- Real reservation/manual-stayover commands omit roomNumber from the target
-- type snapshot. Review context must therefore use the immutable notified
-- assignment snapshot, never live room master or a synthetic target field.
create temp table stayover_review_case(room_id uuid,reservation_id uuid,target_id uuid,assignment_id uuid,attempt_id uuid);
insert into stayover_review_case
select room.id,pg_temp.pid(816),pg_temp.pid(316),pg_temp.pid(416),pg_temp.pid(516)
from public.rooms room
where room.room_type_id=(select id from public.room_types where code='standard')
order by room.room_number offset 16 limit 1;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select room_id,'verified',1,'TEST',pg_temp.pid(1),clock_timestamp() from stayover_review_case;
select pg_temp.install_room_pin_fixture(room_id,pg_temp.pid(1),1) from stayover_review_case;
select public.create_reservation(pg_temp.pid(1),reservation_id,room_id,
  date_trunc('minute',clock_timestamp())-interval '1 day',date_trunc('minute',clock_timestamp())+interval '1 day',2,null,
  (select state_version from public.rooms room where room.id=stayover_review_case.room_id),
  'submission-stayover-reservation',repeat('f',64)) from stayover_review_case;
update public.reservations set actual_check_in_at=check_in_at
where id=(select reservation_id from stayover_review_case);
select public.create_manual_cleaning_request(pg_temp.pid(1),target_id,room_id,reservation_id,'stayover',
  ((date_trunc('minute',clock_timestamp())-interval '2 hours') at time zone 'Asia/Seoul')::date,
  date_trunc('minute',clock_timestamp())-interval '2 hours',
  date_trunc('minute',clock_timestamp())+interval '6 hours',
  (select state_version from public.rooms room where room.id=stayover_review_case.room_id),'STAYOVER_TEST',
  'submission-stayover-target',repeat('f',64)) from stayover_review_case;
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,changed_by)
select assignment_id,target_id,pg_temp.pid(2),96,1,true,clock_timestamp()-interval '3 hours',pg_temp.pid(1)
from stayover_review_case;
update public.cleaning_targets set status='notified' where id=(select target_id from stayover_review_case);
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
 started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
select c.attempt_id,t.id,c.assignment_id,pg_temp.pid(2),1,'field_completed',1,
 clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour',
 t.template_snapshot,jsonb_build_object('roomId',t.room_id)
from stayover_review_case c join public.cleaning_targets t on t.id=c.target_id;
select private.record_validated_attempt_photo(pg_temp.pid(2),attempt_id,
  (select id from private.target_photo_slot_snapshots slot where slot.cleaning_target_id=stayover_review_case.target_id and slot.slot_key='proof'),
  0,repeat('f',64),'image/jpeg',100,clock_timestamp()-interval '30 minutes') from stayover_review_case;
insert into submission_results
select 'stayover-context',public.create_cleaning_submission(pg_temp.pid(2),attempt_id,gen_random_uuid(),0,0,
  'submission-stayover-submit',repeat('f',64)) from stayover_review_case;
select ok(not ((select room_type_snapshot from public.cleaning_targets where id=(select target_id from stayover_review_case)) ? 'roomNumber'),
  'real stayover target does not provide a room number snapshot fallback');
select is(public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='stayover-context'))
  ->'reviewContext'->>'roomNumber',
  (select notified_room_number_snapshot from public.cleaning_assignments where id=(select assignment_id from stayover_review_case)),
  'stayover review context uses the immutable notified assignment room snapshot');
select is((select count(*) from public.inspection_decisions),0::bigint,'submission itself creates no review decision');
select is((select count(*) from public.earnings),0::bigint,'submission itself creates no earning');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(3),pg_temp.pid(501),gen_random_uuid(),1,0,'other-maid-key',repeat('a',64))$$,
 '42501','SUBMISSION_ACCESS_REQUIRED','other maid cannot submit another attempt');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(1),pg_temp.pid(501),gen_random_uuid(),1,0,'admin-submit-key',repeat('b',64))$$,
 '42501','SUBMISSION_ACCESS_REQUIRED','admin cannot fabricate a maid submission');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(6),pg_temp.pid(501),gen_random_uuid(),1,0,'developer-submit-key',repeat('c',64))$$,
 '42501','SUBMISSION_ACCESS_REQUIRED','developer cannot submit');

-- Account lifecycle capability is checked by the public submission command,
-- not inferred from helper-only coverage.
update public.profiles set status='active' where id in (pg_temp.pid(4),pg_temp.pid(5));
select pg_temp.fixture(9,5); select pg_temp.fixture(10,5); select pg_temp.fixture(11,5);
select pg_temp.fixture(12,5); select pg_temp.fixture(13,4); select pg_temp.fixture(17,5);
select pg_temp.photo(9,5); select pg_temp.photo(10,5); select pg_temp.photo(11,5); select pg_temp.photo(12,5); select pg_temp.photo(13,4); select pg_temp.photo(17,5);
update public.profiles set status='upload_only' where id=pg_temp.pid(5);
update public.profiles set status='inactive' where id=pg_temp.pid(4);
insert into private.attempt_capability_grants(id,actor_profile_id,attempt_id,assignment_id,assignment_revision,kind,allowed_actions,issued_at,expires_at,granted_by)
values
 (pg_temp.pid(909),pg_temp.pid(5),pg_temp.pid(509),pg_temp.pid(409),2,'upload_submit',array['upload_evidence','validate_evidence','submit'],now()-interval '1 minute',now()+interval '23 hours 59 minutes',pg_temp.pid(1)),
 (pg_temp.pid(910),pg_temp.pid(5),pg_temp.pid(510),pg_temp.pid(410),2,'evidence_upload',array['upload_evidence','validate_evidence'],now()-interval '1 minute',now()+interval '23 hours 59 minutes',pg_temp.pid(1)),
 (pg_temp.pid(911),pg_temp.pid(5),pg_temp.pid(511),pg_temp.pid(411),2,'upload_submit',array['upload_evidence','validate_evidence','submit'],now()-interval '25 hours',now()-interval '1 hour',pg_temp.pid(1)),
 (pg_temp.pid(912),pg_temp.pid(5),pg_temp.pid(512),pg_temp.pid(412),2,'upload_submit',array['upload_evidence','validate_evidence','submit'],now()-interval '1 minute',now()+interval '23 hours 59 minutes',pg_temp.pid(1)),
 (pg_temp.pid(917),pg_temp.pid(5),pg_temp.pid(517),pg_temp.pid(417),2,'finish_current',array['complete_field_work'],now()-interval '1 minute',now()+interval '119 minutes',pg_temp.pid(1));
insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
values(pg_temp.pid(912),clock_timestamp(),'ACCOUNT_CHANGED',pg_temp.pid(1));
select is((public.create_cleaning_submission(pg_temp.pid(5),pg_temp.pid(509),gen_random_uuid(),0,0,
  'upload-only-live-submit',repeat('a',64)))->>'status','submitted',
  'upload_only maid with exact live upload_submit capability may submit owned completed work');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(5),pg_temp.pid(510),gen_random_uuid(),0,0,
  'evidence-only-submit',repeat('b',64))$$,'42501','CAPABILITY_ACCESS_REQUIRED',
  'evidence_upload capability never grants submission');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(5),pg_temp.pid(511),gen_random_uuid(),0,0,
  'expired-upload-submit',repeat('c',64))$$,'42501','CAPABILITY_ACCESS_REQUIRED',
  'expired upload_submit capability cannot submit');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(5),pg_temp.pid(512),gen_random_uuid(),0,0,
  'revoked-upload-submit',repeat('d',64))$$,'42501','CAPABILITY_ACCESS_REQUIRED',
  'revoked upload_submit capability cannot submit');
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(4),pg_temp.pid(513),gen_random_uuid(),0,0,
  'inactive-submit',repeat('e',64))$$,'42501','SUBMISSION_ACCESS_REQUIRED',
  'inactive maid without a live capability cannot submit');
update public.profiles set status='deactivation_pending' where id=pg_temp.pid(5);
select throws_ok($$select public.create_cleaning_submission(pg_temp.pid(5),pg_temp.pid(517),gen_random_uuid(),0,0,
  'deactivation-pending-submit',repeat('f',64))$$,'42501','SUBMISSION_ACCESS_REQUIRED',
  'deactivation_pending finish_current capability never grants submission');
update public.profiles set status='upload_only' where id=pg_temp.pid(5);

select lives_ok($$select public.record_authorization_denial(
  pg_temp.pid(1),'edge.authorization.attempts','BOMB_REPORT_ACCESS_REQUIRED')$$,
  'bomb report denial uses the bounded source-controlled activity ledger');
select lives_ok($$select public.record_authorization_denial(
  pg_temp.pid(5),'edge.authorization.attempts','SUBMISSION_ACCESS_REQUIRED')$$,
  'limited upload_only submit denial uses the bounded source-controlled activity ledger');
select is((select count(*) from private.actor_authorization_denial_aggregates
  where actor_profile_id=pg_temp.pid(1) and source='edge.authorization.attempts'
    and reason_code='BOMB_REPORT_ACCESS_REQUIRED'),1::bigint,
  'bomb report denial creates one bounded aggregate row');
select is((select count(*) from private.actor_authorization_denial_aggregates
  where actor_profile_id=pg_temp.pid(5) and source='edge.authorization.attempts'
    and reason_code='SUBMISSION_ACCESS_REQUIRED'),1::bigint,
  'submission denial creates one bounded aggregate row');
select ok(not exists(select 1 from information_schema.columns
  where table_schema='private' and table_name='actor_authorization_denial_aggregates'
    and column_name in ('request_body','raw_url','raw_ip','access_token','session_token','authorization_header')),
  'denial aggregate has no raw request, URL, IP, token or authorization fields');

-- A scheduled owner may preserve bomb evidence/report before field work, but it
-- cannot satisfy full submission completeness until evidence is captured after start.
select pg_temp.photo(6);
insert into submission_results values('scheduled-report',public.report_bomb_room(pg_temp.pid(2),pg_temp.pid(506),array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(506))],
 '시작 전 발견한 특이 상태','scheduled-bomb-key',repeat('d',64)));
select is((select value->>'evidenceCount' from submission_results where label='scheduled-report'),'1','scheduled assigned maid can report bomb evidence');
select ok(not private.photo_attempt_complete(pg_temp.pid(506),clock_timestamp()),'pre-start bomb evidence cannot become full submission proof');
select throws_ok($$select public.report_bomb_room(pg_temp.pid(3),pg_temp.pid(506),array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(506))],
 '다른 메이드','other-bomb-key',repeat('e',64))$$,'42501','SUBMISSION_ACCESS_REQUIRED','other maid cannot read or replay report command');

-- Resubmission keeps old immutable versions and rejects stale review.
insert into submission_results values('first-v',pg_temp.submit(5));
select pg_temp.photo(5,2,1);
insert into submission_results values('second-v',pg_temp.submit(5,2,1,'submission-key-5-v2'));
select is((select status::text from public.cleaning_submissions where id=(select (value->>'id')::uuid from submission_results where label='first-v')),'superseded','prior current submission is superseded');
select is((select value->>'version' from submission_results where label='second-v'),'2','replacement creates a second immutable version');
select is((public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='first-v'))
  ->'photos'->0->>'photoId')::uuid,
  (select id from private.attempt_photo_versions where cleaning_attempt_id=pg_temp.pid(505) and version=1),
  'superseded detail preserves the immutable first photo binding');
select is((public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='second-v'))
  ->'photos'->0->>'photoId')::uuid,
  (select id from private.attempt_photo_versions where cleaning_attempt_id=pg_temp.pid(505) and version=2),
  'current resubmission detail exposes the new immutable photo binding');
select isnt((public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='first-v'))
  ->'photos'->0->>'photoId'),
  (public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='second-v'))
  ->'photos'->0->>'photoId'),
  'resubmission never rewrites the old submission evidence identity');
select ok(not (public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='second-v'))
  ->'photos'->0 ?| array['providerLocator','sha256','fileName','requestHash']),
  'admin photo projection contains no provider locator, hash, file name or request hash');
select throws_ok($$select public.approve_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='first-v'),
 'QUALITY_OK','stale-review-key',repeat('f',64))$$,'40001','STALE_VERSION','stale submission review is rejected with the product contract code');
select throws_ok($$select public.approve_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='approve'),
 'ARBITRARY_BUT_VALID_FORMAT','invalid-reason-key',repeat('9',64))$$,'55000','INSPECTION_INVALID_TRANSITION','regex-valid unapproved inspection reason is rejected');

-- Bomb report evidence is an immutable selected subset exposed only by admin detail.
insert into submission_results values('bomb-report',public.report_bomb_room(pg_temp.pid(2),pg_temp.pid(503),
 array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(503))],
 '폭탄방 합성 메모','bomb-report-key',repeat('1',64)));
insert into submission_results values('bomb-submission',pg_temp.submit(3));
select is((select ((public.get_cleaning_submission(pg_temp.pid(1),(value->>'id')::uuid)->'bombReport'->'evidencePhotoIds'->>0)::uuid)
  from submission_results where label='bomb-submission'),
 (select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(503)),'admin detail receives exact sealed evidence photo ID');
select ok(not (public.get_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='bomb-submission'))::text ~* 'locator|requestHash|sha256'),
 'admin detail excludes provider locator, hash and command request hash');
select throws_ok($$select public.approve_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='bomb-submission'),
 'QUALITY_OK','bomb-approve-too-early',repeat('2',64))$$,'55000','BOMB_DECISION_REQUIRED','bomb predecision is required before final review');
select throws_ok($$select public.decide_bomb_room(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='bomb-submission'),
 'approved','ARBITRARY_BUT_VALID_FORMAT','invalid-bomb-reason-key',repeat('8',64))$$,'22023','INVALID_BOMB_DECISION','regex-valid unapproved bomb reason is rejected');
insert into submission_results values('bomb-decision',public.decide_bomb_room(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='bomb-submission'),
 'approved','BOMB_CONFIRMED','bomb-decision-key',repeat('3',64)));
insert into submission_results values('bomb-approved',public.approve_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='bomb-submission'),
 'QUALITY_OK','bomb-approve-key',repeat('4',64)));
select is((select base_amount from public.earnings where submission_id=(select (value->>'id')::uuid from submission_results where label='bomb-submission')),12000,'approved submission earns frozen base fee');
select is((select bomb_room_bonus from public.earnings where submission_id=(select (value->>'id')::uuid from submission_results where label='bomb-submission')),12000,'approved bomb decision adds exactly one frozen-fee bonus');
select ok((select e.bomb_room_decision_id=d.id from public.earnings e join private.bomb_room_decisions d on d.submission_id=e.submission_id
 where e.submission_id=(select (value->>'id')::uuid from submission_results where label='bomb-submission')),'earning retains immutable approved bomb decision source');
select is(public.approve_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='bomb-submission'),
 'QUALITY_OK','bomb-approve-key',repeat('4',64)),(select value from submission_results where label='bomb-approved'),'approval retry replays exact logical result after terminal transition');
select is((select count(*) from public.earnings where submission_id=(select (value->>'id')::uuid from submission_results where label='bomb-submission')),1::bigint,'approval retry cannot duplicate earning');
select ok(not (select requires_action from public.notifications
  where event_family like 'inspection.%approved' and source_entity_id=(select value->>'decisionId' from submission_results where label='bomb-approved')),
  'approval notification is informational and creates no false unresolved action');
select is(public.report_bomb_room(pg_temp.pid(2),pg_temp.pid(503),array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(503))],
 '폭탄방 합성 메모','bomb-report-key',repeat('1',64)),(select value from submission_results where label='bomb-report'),'bomb report retry remains replayable after approval');

insert into submission_results values('zero-fee-report',public.report_bomb_room(pg_temp.pid(2),pg_temp.pid(514),
 array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(514))],
 '0원 원청소 폭탄방 증빙','zero-fee-report-key',repeat('0',64)));
insert into submission_results values('zero-fee-submission',pg_temp.submit(14));
select public.decide_bomb_room(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='zero-fee-submission'),
 'approved','BOMB_CONFIRMED','zero-fee-bomb-decision',repeat('0',64));
select public.approve_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='zero-fee-submission'),
 'QUALITY_OK','zero-fee-approve',repeat('0',64));
select ok((select base_amount=0 and bomb_room_bonus=0 and bomb_room_decision_id is not null
  from public.earnings where submission_id=(select (value->>'id')::uuid from submission_results where label='zero-fee-submission')),
 'zero-fee source preserves approved bomb provenance with bonus exactly equal to frozen base');

select pg_temp.fixture(15); select pg_temp.photo(15);
insert into submission_results values('sealed-report',public.report_bomb_room(pg_temp.pid(2),pg_temp.pid(515),
 array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.pid(515))],
 '버전에 고정되는 신고','sealed-report-key',repeat('a',64)));
insert into submission_results values('sealed-submission',pg_temp.submit(15));
select pg_temp.photo(15,2,1);
select throws_ok($$select pg_temp.submit(15,2,1,'sealed-resubmit-key')$$,
 '55000','BOMB_REPORT_SEALED','bomb report and evidence never move to another immutable submission version');
select is((select count(*) from private.bomb_room_report_seals
  where report_id=(select (value->>'id')::uuid from submission_results where label='sealed-report')),1::bigint,
 'failed bomb-bearing resubmit leaves the original immutable report seal unchanged');
select is(
  (select array_agg((item->>'submittedAt')::timestamptz) from public.list_cleaning_submissions(pg_temp.pid(1),null,true) item),
  (select array_agg((item->>'submittedAt')::timestamptz order by (item->>'submittedAt')::timestamptz,item->>'id')
    from public.list_cleaning_submissions(pg_temp.pid(1),null,true) item),
  'bounded inspection queue is oldest-first so newer submissions cannot starve older work');

-- Rejection atomically notifies the reclean owned by the original active maid.
-- It becomes visible immediately but #28 remains the only attempt activation owner.
insert into submission_results values('reject-submission',pg_temp.submit(2));
insert into submission_results values('rejected',public.reject_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='reject-submission'),
 'QUALITY_REWORK','reject-key',repeat('5',64)));
select ok((select target.cleaning_kind='reclean' and target.source='inspection_reclean' and target.status='notified'
  and target.fee_snapshot=0 and target.reclean_maid_profile_id=pg_temp.pid(2)
  and target.reclean_of_attempt_id=pg_temp.pid(502) and target.reclean_of_submission_id=(select (value->>'id')::uuid from submission_results where label='reject-submission')
  from public.cleaning_targets target where target.id=(select (value->>'recleanTargetId')::uuid from submission_results where label='rejected')),
 'reject creates one zero-fee reclean target with exact origin chain and original maid');
select ok((select assignment.maid_profile_id=pg_temp.pid(2) and assignment.is_current and assignment.notified_at is not null
  and assignment.notified_room_id_snapshot is not null and assignment.notified_room_number_snapshot is not null
  from public.cleaning_assignments assignment where assignment.id=(select (value->>'recleanAssignmentId')::uuid from submission_results where label='rejected')),
 'reclean ownership is fixed and notification captures an immutable room snapshot');
select is((select count(*) from public.cleaning_attempts attempt
  where attempt.cleaning_target_id=(select (value->>'recleanTargetId')::uuid from submission_results where label='rejected')),
  0::bigint,'rejection does not create an attempt before the normal activation worker');
select is((select count(*) from public.cleaning_targets target
  join public.cleaning_assignments assignment on assignment.cleaning_target_id=target.id and assignment.is_current
  where target.id=(select (value->>'recleanTargetId')::uuid from submission_results where label='rejected')
    and target.status='notified' and assignment.notified_at is not null
    and assignment.maid_profile_id=target.reclean_maid_profile_id),1::bigint,
  'notified reclean is eligible for the normal activation scan without availability reassignment');
select set_config('test.reclean_assignment_id',
  (select value->>'recleanAssignmentId' from submission_results where label='rejected'),true);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.pid(102)::text,true);
select is((select count(*) from public.cleaning_assignments assignment
  where assignment.id=current_setting('test.reclean_assignment_id')::uuid),
  1::bigint,'original maid can read the automatically notified reclean assignment through RLS');
reset role;
select is((select count(*) from public.earnings where submission_id=(select (value->>'id')::uuid from submission_results where label='reject-submission')),0::bigint,'rejection creates no earning');
select ok((select requires_action from public.notifications
  where event_family='inspection.original_rejected_reclean_created'
    and source_entity_id=(select value->>'decisionId' from submission_results where label='rejected')),
  'rejection notification remains actionable for the required reclean');
select is(public.reject_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='reject-submission'),
 'QUALITY_REWORK','reject-key',repeat('5',64)),(select value from submission_results where label='rejected'),'rejection retry replays without duplicate reclean');
select is((select count(*) from public.cleaning_targets where reclean_of_submission_id=(select (value->>'id')::uuid from submission_results where label='reject-submission')),1::bigint,'rejection exactly once creates one reclean target');

-- A checkout obligation may be completed by an approved terminal descendant,
-- including more than one rejected reclean, without rewriting its root target.
create temp table checkout_chain(label text primary key,value uuid);
do $$ declare room_row public.rooms; v_reservation_id uuid:=pg_temp.pid(800); v_target_id uuid; v_assignment_id uuid:=pg_temp.pid(801);
  attempt_id uuid:=pg_temp.pid(802); submission jsonb; first_reject jsonb; first_reclean uuid;
  reclean_attempt_one uuid:=pg_temp.pid(803); reclean_submission_one jsonb; second_reject jsonb; second_reclean uuid;
  reclean_attempt_two uuid:=pg_temp.pid(804); reclean_submission_two jsonb; current_assignment public.cleaning_assignments;
begin
 select * into room_row from public.rooms room where room.room_type_id=(select id from public.room_types where code='standard')
   and not exists(select 1 from public.cleaning_targets target where target.room_id=room.id) order by room.room_number limit 1;
 insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
 values(room_row.id,'verified',1,'TEST',pg_temp.pid(1),clock_timestamp());
 perform pg_temp.install_room_pin_fixture(room_row.id,pg_temp.pid(1),1);
 perform public.create_reservation(pg_temp.pid(1),v_reservation_id,room_row.id,date_trunc('minute',clock_timestamp())-interval '1 day',
   date_trunc('minute',clock_timestamp())+interval '1 day',2,null,room_row.state_version,'checkout-chain-create',repeat('7',64));
 update public.reservations set actual_check_in_at=check_in_at where id=v_reservation_id;
 perform public.manual_checkout_reservation(pg_temp.pid(1),v_reservation_id,1,'TEST',date_trunc('minute',clock_timestamp()),'checkout-chain-manual',repeat('7',64));
 select obligation.current_cleaning_target_id into v_target_id from public.checkout_cleaning_obligations obligation where obligation.reservation_id=v_reservation_id;
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,is_current,notified_at,changed_by)
 select v_assignment_id,v_target_id,pg_temp.pid(2),target.effective_service_date,90,target.assignment_version,true,clock_timestamp(),pg_temp.pid(1)
   from public.cleaning_targets target where target.id=v_target_id;
 update public.cleaning_targets set status='notified' where id=v_target_id;
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
   started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
 select attempt_id,target.id,v_assignment_id,pg_temp.pid(2),1,'field_completed',target.assignment_version,
   clock_timestamp()-interval '20 minutes',clock_timestamp()-interval '10 minutes',clock_timestamp()-interval '10 minutes',target.template_snapshot,target.room_type_snapshot
 from public.cleaning_targets target where target.id=v_target_id;
 perform private.record_validated_attempt_photo(pg_temp.pid(2),attempt_id,
   (select id from private.target_photo_slot_snapshots where cleaning_target_id=v_target_id),0,repeat('7',64),'image/jpeg',100,clock_timestamp()-interval '5 minutes');
 submission:=public.create_cleaning_submission(pg_temp.pid(2),attempt_id,gen_random_uuid(),0,0,'checkout-chain-submit',repeat('7',64));
 first_reject:=public.reject_cleaning_submission(pg_temp.pid(1),(submission->>'id')::uuid,'QUALITY_REWORK','checkout-chain-reject-1',repeat('7',64));
 first_reclean:=(first_reject->>'recleanTargetId')::uuid;
 select * into current_assignment from public.cleaning_assignments where cleaning_target_id=first_reclean and is_current;
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
   started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
 select reclean_attempt_one,target.id,current_assignment.id,pg_temp.pid(2),1,'field_completed',current_assignment.revision,
   target.available_from,target.available_from,target.available_from,target.template_snapshot,target.room_type_snapshot
 from public.cleaning_targets target where target.id=first_reclean;
 perform private.record_validated_attempt_photo(pg_temp.pid(2),reclean_attempt_one,
   (select id from private.target_photo_slot_snapshots where cleaning_target_id=first_reclean),0,repeat('8',64),'image/jpeg',100,clock_timestamp());
 reclean_submission_one:=public.create_cleaning_submission(pg_temp.pid(2),reclean_attempt_one,gen_random_uuid(),0,0,'checkout-chain-submit-r1',repeat('8',64));
 second_reject:=public.reject_cleaning_submission(pg_temp.pid(1),(reclean_submission_one->>'id')::uuid,'QUALITY_REWORK','checkout-chain-reject-2',repeat('8',64));
 second_reclean:=(second_reject->>'recleanTargetId')::uuid;
 select * into current_assignment from public.cleaning_assignments where cleaning_target_id=second_reclean and is_current;
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
   started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
 select reclean_attempt_two,target.id,current_assignment.id,pg_temp.pid(2),1,'field_completed',current_assignment.revision,
   target.available_from,target.available_from,target.available_from,target.template_snapshot,target.room_type_snapshot
 from public.cleaning_targets target where target.id=second_reclean;
 perform private.record_validated_attempt_photo(pg_temp.pid(2),reclean_attempt_two,
   (select id from private.target_photo_slot_snapshots where cleaning_target_id=second_reclean),0,repeat('9',64),'image/jpeg',100,clock_timestamp());
 reclean_submission_two:=public.create_cleaning_submission(pg_temp.pid(2),reclean_attempt_two,gen_random_uuid(),0,0,'checkout-chain-submit-r2',repeat('9',64));
 perform public.approve_cleaning_submission(pg_temp.pid(1),(reclean_submission_two->>'id')::uuid,'QUALITY_OK','checkout-chain-approve',repeat('9',64));
 insert into checkout_chain values('reservation',v_reservation_id),('root',v_target_id),('reclean-one',first_reclean),('reclean-two',second_reclean),('final-submission',(reclean_submission_two->>'id')::uuid);
end $$;
select ok((select obligation.status='completed' and obligation.current_cleaning_target_id=(select value from checkout_chain where label='root')
  and obligation.completion_submission_id=(select value from checkout_chain where label='final-submission')
  from public.checkout_cleaning_obligations obligation where obligation.reservation_id=(select value from checkout_chain where label='reservation')),
 'two rejected recleans followed by approval complete checkout obligation with immutable final proof');
select ok(private.checkout_submission_proves_completion(
  (select id from public.checkout_cleaning_obligations where reservation_id=(select value from checkout_chain where label='reservation')),
  (select value from checkout_chain where label='final-submission')),'recursive checkout completion helper verifies the exact terminal descendant');
select throws_ok($$update public.checkout_cleaning_obligations set completion_submission_id=null
  where reservation_id=(select value from checkout_chain where label='reservation')$$,
  '23514','CHECKOUT_COMPLETION_PROOF_REQUIRED',
  'completed checkout cannot be newly persisted from target status without immutable approved submission proof');
select is((select count(*) from public.earnings where submission_id in (select value from checkout_chain where label in ('final-submission'))),0::bigint,
 'inspection reclean approval never creates earning');

-- Missing reclean catalog is a full rollback, never a legacy/fabricated target.
update public.cleaning_template_versions set status='retired' where id=pg_temp.pid(201);
insert into submission_results values('missing-template-submission',pg_temp.submit(7));
select throws_ok($$select public.reject_cleaning_submission(pg_temp.pid(1),(select (value->>'id')::uuid from submission_results where label='missing-template-submission'),
 'QUALITY_REWORK','missing-template-key',repeat('6',64))$$,'23514','RECLEAN_TEMPLATE_NOT_CONFIGURED','missing published reclean template fails closed');
select is((select count(*) from public.inspection_decisions where submission_id=(select (value->>'id')::uuid from submission_results where label='missing-template-submission')),0::bigint,'missing template rolls back inspection decision');
select is((select status::text from public.cleaning_submissions where id=(select (value->>'id')::uuid from submission_results where label='missing-template-submission')),'submitted','missing template preserves current submission');

select throws_ok($$update private.bomb_room_reports set memo='변조'$$,'55000','SUBMISSION_INSPECTION_IMMUTABLE','bomb report is immutable');
select throws_ok($$delete from private.bomb_room_report_evidence$$,'55000','SUBMISSION_INSPECTION_IMMUTABLE','bomb evidence selection is immutable');
select throws_ok($$update public.earnings set base_amount=0$$,'55000','APPEND_ONLY_LEDGER','earning is append-only');
select ok(bool_and(c.relrowsecurity),'private submission tables have RLS') from pg_class c join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='private' and c.relname in ('bomb_room_reports','bomb_room_report_evidence','bomb_room_report_seals','bomb_room_decisions');
select ok(not has_table_privilege(role_name,'private.bomb_room_reports','SELECT'),role_name||' cannot read raw bomb reports')
 from unnest(array['anon','authenticated','service_role']) role_name;
select ok(not has_function_privilege(role_name,signature,'EXECUTE'),role_name||' cannot execute private lifecycle helper')
 from unnest(array['anon','authenticated','service_role']) role_name cross join unnest(array[
  'private.finalize_submission_inspection(uuid,uuid,text,text,text,text)',
  'private.submission_actor(uuid,uuid)','private.submission_receipt_actor(uuid,uuid)','private.bomb_report_actor(uuid,uuid)',
  'private.submission_review_context(uuid)']) signature;
select ok(has_function_privilege('service_role','public.create_cleaning_submission(uuid,uuid,uuid,bigint,integer,text,text)','EXECUTE'),'service role can execute public submission command');
select ok(not has_function_privilege('authenticated','public.create_cleaning_submission(uuid,uuid,uuid,bigint,integer,text,text)','EXECUTE'),'authenticated cannot bypass server-owned command');
select ok(not has_function_privilege('authenticated','public.record_authorization_denial(uuid,text,text,timestamptz)','EXECUTE'),
 'authenticated cannot forge submission authorization activity');
select ok(not exists(select 1 from unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) privilege
  cross join unnest(array['public.inspection_decisions','public.earnings']) relation
  where has_table_privilege('service_role',relation,privilege)),
 'service role has no raw decision or earning mutation/DDL-adjacent grant');

select * from finish();
rollback;
