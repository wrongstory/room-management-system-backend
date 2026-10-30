-- #532 isolated synthetic regression. Execution requires separate explicit DB approval.
begin;
select no_plan();
create function pg_temp.ready_id(n integer) returns uuid language sql immutable as $$
  select ('53200000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.ready_id(101)),(pg_temp.ready_id(102)),(pg_temp.ready_id(103));
select public.bootstrap_first_developer_profile(pg_temp.ready_id(3),pg_temp.ready_id(103),
  'ready-developer','ready-developer','0532','ready-fixture-phone-hash','ready-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values(pg_temp.ready_id(1),pg_temp.ready_id(101),'ready-admin','ready-admin','ready-admin','ready-admin',0,'admin','active',false),
  (pg_temp.ready_id(2),pg_temp.ready_id(102),'ready-maid','ready-maid','ready-maid','ready-maid',0,'maid','active',false);
insert into auth.sessions(id,user_id) values(pg_temp.ready_id(201),pg_temp.ready_id(101)),(pg_temp.ready_id(202),pg_temp.ready_id(102));
insert into public.rooms(id,room_number,room_type_id,elevator_zone,data_status)
select pg_temp.ready_id(10),'9532',id,'A','verified' from public.room_types where active order by code limit 1;
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by)
select room_type_id,k,532,'published',case when k='checkout' then null else 30 end,private.flat_cleaning_photo_slots(),clock_timestamp(),pg_temp.ready_id(1)
from public.rooms cross join unnest(array['additional','checkout']::public.cleaning_kind[]) k where id=pg_temp.ready_id(10);
select public.create_manual_cleaning_request(pg_temp.ready_id(1),pg_temp.ready_id(20),pg_temp.ready_id(10),null,'additional',
  (clock_timestamp() at time zone 'Asia/Seoul')::date,
  date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul',
  (date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')+interval '23 hours 59 minutes') at time zone 'Asia/Seoul',
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'SYNTHETIC_READY_TEST','ready-create',repeat('1',64));
update public.cleaning_targets set assignment_version=2,status='notified' where id=pg_temp.ready_id(20);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
values(pg_temp.ready_id(30),pg_temp.ready_id(20),pg_temp.ready_id(2),1,2,clock_timestamp(),pg_temp.ready_id(1));
select private.emit_notification_v1('assignment.commit_notified',pg_temp.ready_id(1),pg_temp.ready_id(2),
  'cleaning_assignment',pg_temp.ready_id(30)::text,'합성 배정','합성 배정 확인',pg_temp.ready_id(10),pg_temp.ready_id(20),pg_temp.ready_id(20),clock_timestamp());
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.ready_id(40),id,pg_temp.ready_id(30),pg_temp.ready_id(2),1,'scheduled',2,template_snapshot,
  room_type_snapshot||jsonb_build_object('roomId',room_id) from public.cleaning_targets where id=pg_temp.ready_id(20);
-- Synthetic physical history: real production fixtures are never used.
update public.cleaning_attempts set status='in_progress',execution_version=execution_version+1,started_at=clock_timestamp()
where id=pg_temp.ready_id(40);
update public.cleaning_targets set status='in_progress' where id=pg_temp.ready_id(20);
update public.cleaning_attempts set status='field_completed',execution_version=execution_version+1,
  field_completed_at=statement_timestamp(),ended_at=statement_timestamp() where id=pg_temp.ready_id(40);
create temp table ready_saved(key text primary key,value jsonb);
insert into ready_saved values('physical',(select to_jsonb(a) from public.cleaning_attempts a where id=pg_temp.ready_id(40))),
  ('earnings',jsonb_build_object('count',(select count(*) from public.earnings))),
  ('preview',public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10)));
create function pg_temp.ready_apply(p_confirm boolean default true,p_ack boolean default true,p_key text default 'ready-apply',
  p_value jsonb default null,p_hash text default repeat('a',64)) returns jsonb language plpgsql as $$
declare p jsonb:=coalesce(p_value,(select value from ready_saved where key='preview'));
begin return public.apply_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),
  (p->>'roomStateVersion')::bigint,p->>'impactFingerprint',(p->>'evaluatedAt')::timestamptz,(p->>'expiresAt')::timestamptz,
  p_confirm,p_ack,false,'ADMIN_ROOM_READY_CORRECTION',p_key,p_hash); end $$;
select is((select value->>'canApply' from ready_saved where key='preview'),'true','unapproved field completion can be corrected');
select is((select value->>'requiresEarningAcknowledgement' from ready_saved where key='preview'),'true','physical work needs earning acknowledgement');
select throws_ok($$select pg_temp.ready_apply(false,true,'no-confirm')$$,'55000','ROOM_READY_CONFIRMATION_REQUIRED','confirmation required');
select throws_ok($$select pg_temp.ready_apply(true,false,'no-earnings')$$,'55000','ROOM_READY_EARNING_ACKNOWLEDGEMENT_REQUIRED','earning acknowledgement required');
select throws_ok($$select pg_temp.ready_apply(true,true,'forged-time',
  (select value||jsonb_build_object('evaluatedAt',clock_timestamp()-interval '1 minute','expiresAt',clock_timestamp()+interval '4 minutes')
   from ready_saved where key='preview'))$$,'40001','ROOM_READY_PREVIEW_STALE','stale preview cannot refresh its own clock');
select throws_ok($$select public.override_room_display_status(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),'READY',
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'SYNTHETIC_READY_TEST','label-only',repeat('b',64))$$,
  '55000','ROOM_READY_CORRECTION_REQUIRED','legacy READY cannot hide live cleaning');
select lives_ok($$insert into ready_saved values('result',pg_temp.ready_apply())$$,'confirmed correction applies');
select is((select status::text from public.cleaning_targets where id=pg_temp.ready_id(20)),'cancelled','target soft cancellation');
select is((select to_jsonb(a) from public.cleaning_attempts a where id=pg_temp.ready_id(40)),
  (select value from ready_saved where key='physical'),'finished physical history preserved');
select is((select is_current from public.cleaning_assignments where id=pg_temp.ready_id(30)),false,'assignment authority ended');
select is(private.room_current_cleaning_required_at(pg_temp.ready_id(10),clock_timestamp()),false,'cleaning readiness is actually cleared');
select ok((select private.room_ready_cancelled_attempt(a) from public.cleaning_attempts a where id=pg_temp.ready_id(40)),
  'cancelled attempt no longer blocks subsequent work through exact correction evidence');
select is((select count(*)::text from public.earnings),(select value->>'count' from ready_saved where key='earnings'),'no new earning');
select is((select count(*) from public.notifications where source_entity_kind='cleaning_assignment' and source_entity_id=pg_temp.ready_id(30)::text
  and requires_action and resolved_at is null),0::bigint,'previous assignment action notice resolved');
select is(pg_temp.ready_apply(),(select value from ready_saved where key='result'),'same receipt replay');
select throws_ok($$select pg_temp.ready_apply(true,true,'ready-apply',null,repeat('c',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','different request hash cannot replay');
select is((select count(*) from public.audit_events where event_type='room.ready_corrected' and entity_id=pg_temp.ready_id(10)),1::bigint,
  'single immutable correction evidence');
select ok(not has_function_privilege('authenticated','public.apply_room_ready_correction(uuid,uuid,uuid,bigint,text,timestamptz,timestamptz,boolean,boolean,boolean,text,text,text)','EXECUTE'),
  'authenticated cannot call privileged mutation directly');
select is(public.list_room_events(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),30)->'items'->0->>'eventType',
  'room.ready_corrected','correction appears in room history');
select is((select array_agg(k order by k) from jsonb_object_keys(public.list_room_events(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10),30)->'items'->0->'summary') k),
  array['cancelledCleaningCount','candlesCleared','releasedOperationBlockCount','resolvedRoomIssueCount','roomStateVersion'],
  'history summary exposes only five safe keys');
select is((select count(*) from public.list_developer_audit_events(pg_temp.ready_id(3),array['room.ready_corrected'])),1::bigint,
  'developer correction event filter works');
select throws_ok($$select * from public.list_developer_audit_events(pg_temp.ready_id(1),array['room.ready_corrected'])$$,
  '42501','DEVELOPER_REQUIRED','administrator cannot use developer audit endpoint');

-- Reproduce the reported checkout obligation with no next stay, then try a new booking.
select public.create_reservation(pg_temp.ready_id(1),pg_temp.ready_id(50),pg_temp.ready_id(10),
  clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',1,null,
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'old-stay',repeat('d',64));
update public.reservations set actual_check_in_at=check_in_at where id=pg_temp.ready_id(50);
select public.manual_checkout_reservation(pg_temp.ready_id(1),pg_temp.ready_id(50),
  (select version from public.reservations where id=pg_temp.ready_id(50)),
  'SYNTHETIC_READY_TEST',clock_timestamp(),'old-stay-checkout',repeat('d',64));
insert into ready_saved values('checkout-target',
  (select to_jsonb(current_cleaning_target_id) from public.checkout_cleaning_obligations where reservation_id=pg_temp.ready_id(50)));
update public.cleaning_targets set status='notified',assignment_version=assignment_version+1
where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select pg_temp.ready_id(60),id,pg_temp.ready_id(2),2,assignment_version,clock_timestamp(),pg_temp.ready_id(1)
from public.cleaning_targets where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.ready_id(70),id,pg_temp.ready_id(60),pg_temp.ready_id(2),1,'scheduled',assignment_version,
  template_snapshot,room_type_snapshot||jsonb_build_object('roomId',room_id)
from public.cleaning_targets where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
update public.cleaning_attempts set status='in_progress',execution_version=execution_version+1,started_at=clock_timestamp()
where id=pg_temp.ready_id(70);
update public.cleaning_targets set status='in_progress' where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target');
update public.cleaning_attempts set status='field_completed',execution_version=execution_version+1,
  field_completed_at=statement_timestamp(),ended_at=statement_timestamp() where id=pg_temp.ready_id(70);
select is((select due_at from public.cleaning_targets where id=(select (value#>>'{}')::uuid from ready_saved where key='checkout-target')),
  null::timestamptz,'checkout has no next-reservation due time');
create function pg_temp.ready_next_booking() returns jsonb language sql as $$
  select public.create_reservation(pg_temp.ready_id(1),pg_temp.ready_id(51),pg_temp.ready_id(10),
    clock_timestamp()+interval '1 hour',clock_timestamp()+interval '2 days',1,null,
    (select state_version from public.rooms where id=pg_temp.ready_id(10)),'next-stay',repeat('e',64))
$$;
select throws_ok($$select pg_temp.ready_next_booking()$$,'23514','CLEANING_DUE_REPLAN_REQUIRED','original next-booking conflict reproduced');
update ready_saved set value=public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10)) where key='preview';
select lives_ok($$select pg_temp.ready_apply(true,true,'checkout-ready',null,repeat('f',64))$$,'automatic checkout correction applies atomically');
set constraints all immediate;
select is((select status::text from public.checkout_cleaning_obligations where reservation_id=pg_temp.ready_id(50)),
  'cancelled','automatic obligation and target cancelled together');
set constraints all deferred;
select public.create_manual_cleaning_request(pg_temp.ready_id(1),pg_temp.ready_id(80),pg_temp.ready_id(10),null,'additional',
  (clock_timestamp() at time zone 'Asia/Seoul')::date,clock_timestamp(),clock_timestamp()+interval '30 minutes',
  (select state_version from public.rooms where id=pg_temp.ready_id(10)),'SYNTHETIC_READY_TEST','next-cleaning',repeat('8',64));
update public.cleaning_targets set status='notified',assignment_version=assignment_version+1 where id=pg_temp.ready_id(80);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
select pg_temp.ready_id(90),id,pg_temp.ready_id(2),3,assignment_version,clock_timestamp(),pg_temp.ready_id(1)
from public.cleaning_targets where id=pg_temp.ready_id(80);
select lives_ok($$select public.process_due_assignment_lifecycle(pg_temp.ready_id(1),clock_timestamp(),'after-correction-activate',repeat('9',64))$$,
  'public lifecycle scheduler runs after correction');
select ok(exists(select 1 from public.cleaning_attempts where cleaning_target_id=pg_temp.ready_id(80) and status='scheduled'),
  'next cleaning activates through the complete preserved-helper chain');
select lives_ok($$select pg_temp.ready_next_booking()$$,'new reservation succeeds after confirmed correction');
insert into public.assignment_change_requests(id,cleaning_target_id,assignment_id,maid_profile_id,reason_code,
  source_assignment_revision,source_target_assignment_version)
select pg_temp.ready_id(91),t.id,a.id,a.maid_profile_id,'PERSONAL_REASON',a.revision,t.assignment_version
from public.cleaning_targets t join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
where t.id=pg_temp.ready_id(80);
update ready_saved set value=public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(10)) where key='preview';
select ok((select value->'blockingReasons'?'ASSIGNMENT_CHANGE_PENDING' and not (value->>'canApply')::boolean
  from ready_saved where key='preview'),'pending assignment change requires its own existing decision procedure');
select throws_ok($$select pg_temp.ready_apply(true,true,'pending-change-blocked')$$,'55000','ROOM_READY_CORRECTION_BLOCKED',
  'correction does not silently decide a pending assignment request');

-- Two isolated synthetic histories: one already approved/earned, one submitted
-- and still awaiting inspection. Model/provider acknowledgements below contain
-- no real media and make no Drive calls. All production constraints stay enabled.
insert into public.rooms(id,room_number,room_type_id,elevator_zone,data_status)
select pg_temp.ready_id(11),'9533',room_type_id,'A','verified' from public.rooms where id=pg_temp.ready_id(10);
create temp table ready_submitted(n integer primary key,submission_id uuid not null,photo_id uuid not null);
do $$
declare n integer; room_row public.rooms; template public.cleaning_template_versions;
  at_time timestamptz:=clock_timestamp(); day date; photo uuid; submission jsonb;
begin
  select * into strict room_row from public.rooms where id=pg_temp.ready_id(11);
  select * into strict template from public.cleaning_template_versions
    where room_type_id=room_row.room_type_id and cleaning_kind='additional' and version=532;
  day:=(at_time at time zone 'Asia/Seoul')::date;
  for n in 1..2 loop
    insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
      effective_service_date,available_from,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
    select pg_temp.ready_id(1000+n),room_row.id,'additional','manual_room_request','ready-preservation-'||n,
      day,day,at_time-interval '1 hour','notified',1,
      jsonb_build_object('id',rt.id,'code',rt.code,'roomNumber',room_row.room_number),15000,
      jsonb_build_object('id',template.id,'version',template.version,'durationMinutes',template.duration_minutes,'photoSlots',template.photo_slots),
      pg_temp.ready_id(1) from public.room_types rt where rt.id=room_row.room_type_id;
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,
      revision,is_current,notified_at,changed_by)
    values(pg_temp.ready_id(2000+n),pg_temp.ready_id(1000+n),pg_temp.ready_id(2),day,10+n,1,true,
      at_time-interval '1 hour',pg_temp.ready_id(1));
    insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
      assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
    select pg_temp.ready_id(3000+n),id,pg_temp.ready_id(2000+n),pg_temp.ready_id(2),1,'field_completed',1,
      at_time-interval '30 minutes',at_time-interval '10 minutes',at_time-interval '10 minutes',template_snapshot,
      room_type_snapshot||jsonb_build_object('roomId',room_id) from public.cleaning_targets where id=pg_temp.ready_id(1000+n);
    photo:=private.record_validated_collection_photo(pg_temp.ready_id(2),pg_temp.ready_id(3000+n),
      (select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.ready_id(1000+n) and slot_key='cleaning-proof'),
      pg_temp.ready_id(4000+n),0,0,repeat(n::text,64),'image/jpeg',100,at_time-interval '5 minutes');
    insert into private.photo_upload_operations(id,actor_profile_id,command_type,idempotency_key_digest,request_hash,
      cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,target_photo_slot_id,
      expected_photo_revision,sha256,mime_type,size_bytes,collection_item_id,expected_item_revision)
    select pg_temp.ready_id(5000+n),pg_temp.ready_id(2),'photo.collection.upload',repeat(n::text,64),repeat(n::text,64),
      cleaning_attempt_id,cleaning_target_id,pg_temp.ready_id(2000+n),1,target_photo_slot_id,0,sha256,mime_type,size_bytes,
      collection_item_id,0 from private.attempt_photo_versions where id=photo;
    insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
    select pg_temp.ready_id(6000+n),pg_temp.ready_id(5000+n),'ready_preservation_object_'||n,uploaded_at,purge_after
      from private.attempt_photo_versions where id=photo;
    insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,status,lease_version,revision)
    select pg_temp.ready_id(5000+n),cleaning_attempt_id,target_photo_slot_id,pg_temp.ready_id(2),'provider_succeeded',0,1
      from private.attempt_photo_versions where id=photo;
    insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id)
      values(pg_temp.ready_id(5000+n),pg_temp.ready_id(6000+n),photo);
    update private.photo_upload_states set status='accepted',revision=revision+1 where operation_id=pg_temp.ready_id(5000+n);
    submission:=public.create_cleaning_submission_with_session(pg_temp.ready_id(2),pg_temp.ready_id(202),
      pg_temp.ready_id(3000+n),pg_temp.ready_id(7000+n),0,0,'ready-preservation-submit-'||n,repeat(n::text,64));
    insert into ready_submitted values(n,(submission->>'id')::uuid,photo);
    if n=1 then
      perform public.approve_cleaning_submission(pg_temp.ready_id(1),(submission->>'id')::uuid,
        'QUALITY_OK','ready-preservation-approve',repeat('3',64));
    end if;
  end loop;
end $$;
select is((select status::text from public.cleaning_targets where id=pg_temp.ready_id(1002)),
  'inspection_pending','preservation fixture uses a real current submitted cleaning');
select is((select count(*) from private.submission_photo_bindings where submission_id in(select submission_id from ready_submitted)),
  2::bigint,'both preservation submissions seal one accepted synthetic photo');
select is((select count(*) from private.photo_retention_records where object_id in(pg_temp.ready_id(6001),pg_temp.ready_id(6002))),
  2::bigint,'both synthetic photos have authoritative retention records');
select is((select count(*) from public.earnings where submission_id in(select submission_id from ready_submitted)),
  1::bigint,'preservation fixture contains an existing confirmed earning');

-- Compare complete row values, including immutable IDs, snapshots, revisions,
-- timestamps and retention anchors. Only the pending target/assignment authority
-- may change; the approved work, submission/media and financial rows must not.
create function pg_temp.ready_preserved_rows() returns jsonb language sql stable as $$
  select jsonb_build_object(
    'approvedTarget',(select to_jsonb(t) from public.cleaning_targets t where id=pg_temp.ready_id(1001)),
    'approvedAssignment',(select to_jsonb(a) from public.cleaning_assignments a where id=pg_temp.ready_id(2001)),
    'attempts',(select jsonb_agg(to_jsonb(a) order by id) from public.cleaning_attempts a where id in(pg_temp.ready_id(3001),pg_temp.ready_id(3002))),
    'submissions',(select jsonb_agg(to_jsonb(s) order by id) from public.cleaning_submissions s where id in(select submission_id from ready_submitted)),
    'pointers',(select jsonb_agg(to_jsonb(p) order by cleaning_attempt_id) from private.submission_current_pointers p where submission_id in(select submission_id from ready_submitted)),
    'seals',(select jsonb_agg(to_jsonb(s) order by submission_id) from private.submission_photo_binding_sets s where submission_id in(select submission_id from ready_submitted)),
    'bindings',(select jsonb_agg(to_jsonb(b) order by submission_id,photo_version_id) from private.submission_photo_bindings b where submission_id in(select submission_id from ready_submitted)),
    'photos',(select jsonb_agg(to_jsonb(p) order by id) from private.attempt_photo_versions p where id in(select photo_id from ready_submitted)),
    'items',(select jsonb_agg(to_jsonb(i) order by id) from private.attempt_photo_collection_items i where id in(pg_temp.ready_id(4001),pg_temp.ready_id(4002))),
    'collectionStates',(select jsonb_agg(to_jsonb(s) order by cleaning_attempt_id,target_photo_slot_id) from private.attempt_photo_collection_states s where cleaning_attempt_id in(pg_temp.ready_id(3001),pg_temp.ready_id(3002))),
    'collectionChanges',(select jsonb_agg(to_jsonb(c) order by id) from private.attempt_photo_collection_changes c where cleaning_attempt_id in(pg_temp.ready_id(3001),pg_temp.ready_id(3002))),
    'operations',(select jsonb_agg(to_jsonb(o) order by id) from private.photo_upload_operations o where id in(pg_temp.ready_id(5001),pg_temp.ready_id(5002))),
    'uploadStates',(select jsonb_agg(to_jsonb(s) order by operation_id) from private.photo_upload_states s where operation_id in(pg_temp.ready_id(5001),pg_temp.ready_id(5002))),
    'uploadEvents',(select jsonb_agg(to_jsonb(e) order by id) from private.photo_upload_events e where operation_id in(pg_temp.ready_id(5001),pg_temp.ready_id(5002))),
    'objects',(select jsonb_agg(to_jsonb(o) order by id) from private.photo_provider_objects o where id in(pg_temp.ready_id(6001),pg_temp.ready_id(6002))),
    'acceptances',(select jsonb_agg(to_jsonb(a) order by operation_id) from private.photo_upload_acceptances a where operation_id in(pg_temp.ready_id(5001),pg_temp.ready_id(5002))),
    'retention',(select jsonb_agg(to_jsonb(r) order by object_id) from private.photo_retention_records r where object_id in(pg_temp.ready_id(6001),pg_temp.ready_id(6002))),
    'retentionLinks',(select jsonb_agg(to_jsonb(l) order by id) from private.photo_retention_links l where object_id in(pg_temp.ready_id(6001),pg_temp.ready_id(6002))),
    'inspections',(select jsonb_agg(to_jsonb(i) order by id) from public.inspection_decisions i where submission_id in(select submission_id from ready_submitted)),
    'earnings',(select jsonb_agg(to_jsonb(e) order by id) from public.earnings e where submission_id in(select submission_id from ready_submitted)),
    'audit',(select jsonb_agg(to_jsonb(e) order by id) from public.audit_events e where entity_id in(select submission_id from ready_submitted))
  )
$$;
insert into ready_saved values('preserved-submitted',pg_temp.ready_preserved_rows()),
  ('submitted-preview',public.preview_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(11)));
select is((select value->>'canApply' from ready_saved where key='submitted-preview'),'true','submitted cleaning can be corrected');
select is((select value->>'requiresEarningAcknowledgement' from ready_saved where key='submitted-preview'),'true',
  'submitted cleaning requires explicit no-new-earnings acknowledgement');
select is((select value#>'{effects,cleaningTargets}' from ready_saved where key='submitted-preview'),
  jsonb_build_array(jsonb_build_object('cleaningTargetId',pg_temp.ready_id(1002),'assignmentId',pg_temp.ready_id(2002),
    'attemptId',pg_temp.ready_id(3002),'attemptStatus','submitted','hasSubmission',true,'fieldCompleted',true)),
  'preview contains only pending submitted work and excludes approved earned work');
select lives_ok($$insert into ready_saved
  select 'submitted-result',public.apply_room_ready_correction(pg_temp.ready_id(1),pg_temp.ready_id(201),pg_temp.ready_id(11),
    (value->>'roomStateVersion')::bigint,value->>'impactFingerprint',(value->>'evaluatedAt')::timestamptz,(value->>'expiresAt')::timestamptz,
    true,true,false,'ADMIN_ROOM_READY_CORRECTION','ready-submitted-correct',repeat('4',64))
  from ready_saved where key='submitted-preview'$$,'confirmed submitted correction applies');
select is((select value->'cancelledCleaningTargetIds' from ready_saved where key='submitted-result'),
  jsonb_build_array(pg_temp.ready_id(1002)),'correction cancels only the pending submitted target');
select is((select status::text from public.cleaning_targets where id=pg_temp.ready_id(1002)),'cancelled','submitted target is softly cancelled');
select is((select is_current from public.cleaning_assignments where id=pg_temp.ready_id(2002)),false,
  'submitted assignment authority ends while history is retained');
select is(private.room_current_cleaning_required_at(pg_temp.ready_id(11),clock_timestamp()),false,'submitted correction clears current cleaning readiness');
select is(pg_temp.ready_preserved_rows(),(select value from ready_saved where key='preserved-submitted'),
  'submitted photos, sealed submission, existing confirmed earning and inspection ledgers are unchanged');
select is((select count(*) from public.earnings where submission_id=(select submission_id from ready_submitted where n=2)),
  0::bigint,'submitted correction creates no new earning');
select throws_ok($$select public.approve_cleaning_submission(pg_temp.ready_id(1),
  (select submission_id from ready_submitted where n=2),'QUALITY_OK','ready-after-cancel-approve',repeat('5',64))$$,
  '55000','INSPECTION_INVALID_TRANSITION','cancelled submitted cleaning cannot later be approved for earnings');
select throws_ok($$select public.reject_cleaning_submission(pg_temp.ready_id(1),
  (select submission_id from ready_submitted where n=2),'QUALITY_REWORK','ready-after-cancel-reject',repeat('6',64))$$,
  '55000','INSPECTION_INVALID_TRANSITION','cancelled submitted cleaning cannot later create inspection rework');
select is(pg_temp.ready_preserved_rows(),(select value from ready_saved where key='preserved-submitted'),
  'rejected follow-up inspections leave all protected rows and existing earning unchanged');
select is((select count(*) from public.inspection_decisions where submission_id=(select submission_id from ready_submitted where n=2)),
  0::bigint,'cancelled submission receives no inspection decision');
select * from finish();
rollback;
