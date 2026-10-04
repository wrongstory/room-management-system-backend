begin;
select no_plan();

-- PAYROLL_WORK_DETAILS_FIXTURE_BEGIN
create function pg_temp.work_id(n integer) returns uuid language sql immutable as $$
  select ('f3240000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.work_week(n integer) returns date language sql stable as $$
  select date_trunc('week',statement_timestamp() at time zone 'Asia/Seoul')::date+n*7
$$;
insert into auth.users(id) select pg_temp.work_id(100+n) from generate_series(1,12)n;
select public.bootstrap_first_developer_profile(pg_temp.work_id(5),pg_temp.work_id(105),
  'work-dev','work-dev','0324',repeat('d',64),'payroll-work-developer');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password) values
  (pg_temp.work_id(1),pg_temp.work_id(101),'work-admin','work-admin','work-admin','work-admin',0,'admin','active',false),
  (pg_temp.work_id(2),pg_temp.work_id(102),'work-maid','work-maid','work-maid','work-maid',0,'maid','active',false),
  (pg_temp.work_id(3),pg_temp.work_id(103),'work-other','work-other','work-other','work-other',0,'maid','active',false),
  (pg_temp.work_id(4),pg_temp.work_id(104),'work-admin-b','work-admin-b','work-admin-b','work-admin-b',0,'admin','active',false),
  (pg_temp.work_id(6),pg_temp.work_id(106),'work-temp','work-temp','work-temp','work-temp',0,'admin','active',true),
  (pg_temp.work_id(7),pg_temp.work_id(107),'work-inactive','work-inactive','work-inactive','work-inactive',0,'admin','inactive',false),
  (pg_temp.work_id(8),pg_temp.work_id(108),'work-departed','work-departed','work-departed','work-departed',0,'maid','departed',false),
  (pg_temp.work_id(9),pg_temp.work_id(109),'work-upload','work-upload','work-upload','work-upload',0,'maid','upload_only',false),
  (pg_temp.work_id(10),pg_temp.work_id(110),'work-pending','work-pending','work-pending','work-pending',0,'maid','deactivation_pending',false),
  (pg_temp.work_id(11),pg_temp.work_id(111),'work-empty','work-empty','work-empty','work-empty',0,'maid','active',false),
  (pg_temp.work_id(12),pg_temp.work_id(112),'work-temp-maid','work-temp-maid','work-temp-maid','work-temp-maid',0,'maid','active',true);
insert into auth.sessions(id,user_id) select pg_temp.work_id(400+n),pg_temp.work_id(100+n)
  from generate_series(1,12)n;

create function pg_temp.work_add_earning(n integer,p_maid integer,p_day date,p_amount integer,
  p_snapshot jsonb default null) returns uuid language plpgsql as $$
declare room public.rooms; at_time timestamptz:=least(
  (p_day::timestamp+time '12:00') at time zone 'Asia/Seoul',statement_timestamp());
begin
  select * into room from public.rooms where room_type_id=(select id from public.room_types where code='standard')
    order by room_number limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by) values(pg_temp.work_id(1000+n),room.id,'additional',
    'manual_room_request','payroll-work-'||n,p_day,p_day,at_time-interval '2 hours',at_time+interval '2 hours',
    'approved',1,jsonb_build_object('id',room.room_type_id,'code','standard','name','Frozen standard'),
    p_amount,'{}',pg_temp.work_id(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,
    sequence_number,revision,is_current,notified_at,changed_by) values(pg_temp.work_id(2000+n),
    pg_temp.work_id(1000+n),pg_temp.work_id(p_maid),p_day,n+1,1,true,at_time-interval '2 hours',pg_temp.work_id(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
    attempt_number,status,assignment_revision,started_at,field_completed_at,ended_at,
    template_snapshot,room_snapshot) values(pg_temp.work_id(3000+n),pg_temp.work_id(1000+n),
    pg_temp.work_id(2000+n),pg_temp.work_id(p_maid),1,'approved',1,at_time-interval '1 hour',
    at_time,at_time,'{}',coalesce(p_snapshot,jsonb_build_object('roomId',room.id,'roomNumber',room.room_number,
      'roomType',jsonb_build_object('code','standard','name','Frozen standard'))));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,
    status,photo_manifest,submitted_by,submitted_at) values(pg_temp.work_id(4000+n),
    pg_temp.work_id(3000+n),pg_temp.work_id(6000+n),1,'approved','{}',pg_temp.work_id(p_maid),at_time);
  insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
    values(pg_temp.work_id(7000+n),pg_temp.work_id(4000+n),'approved','QUALITY_OK',pg_temp.work_id(1),at_time);
  insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,
    base_amount,bomb_room_bonus) values(pg_temp.work_id(5000+n),pg_temp.work_id(4000+n),
    pg_temp.work_id(4000+n),pg_temp.work_id(p_maid),p_day,p_amount,0);
  return pg_temp.work_id(5000+n);
end $$;
select pg_temp.work_add_earning(1,2,pg_temp.work_week(-4)+1,10000);
select pg_temp.work_add_earning(n,2,pg_temp.work_week(-4)+1,1000) from generate_series(100,160)n;
select pg_temp.work_add_earning(2,3,pg_temp.work_week(-6)+1,12000);
select pg_temp.work_add_earning(3,3,pg_temp.work_week(-6)+2,12000);
select pg_temp.work_add_earning(4,2,pg_temp.work_week(-1)+6,7000);
select pg_temp.work_add_earning(5,2,pg_temp.work_week(0),8000);
-- Canonical legacy omission vs explicitly unknown/malformed snapshot values.
select pg_temp.work_add_earning(6,2,pg_temp.work_week(-5),1000,'{}');
select pg_temp.work_add_earning(7,2,pg_temp.work_week(-5),1000,
  '{"roomNumber":42,"roomType":{"code":null,"name":null}}');
select pg_temp.work_add_earning(8,2,pg_temp.work_week(-5),1000,
  '{"roomNumber":"","roomType":[]}');
select pg_temp.work_add_earning(9,2,pg_temp.work_week(-5),1000,
  '{"roomType":{"name":""},"code":"wrong-flat"}');
select pg_temp.work_add_earning(10,2,pg_temp.work_week(-5),1000,
  '{"roomNumber":"  ","roomType":{"code":"  ","name":"  "}}');
select pg_temp.work_add_earning(11,2,pg_temp.work_week(-5),1000,
  jsonb_build_object('roomType',jsonb_build_object('code','standard','name',repeat('이름',1001))));

-- Valid historical typed complaint/compensation graph, with ordered past KST
-- instants. Every production FK/trigger is active; no clock wait or bypass.
create function pg_temp.work_compensation(n integer,p_amount integer) returns uuid language plpgsql as $$
declare original public.cleaning_targets; day date:=pg_temp.work_week(-3)+1;
  at_time timestamptz:=(day::timestamp+time '12:00') at time zone 'Asia/Seoul';
begin
  select * into original from public.cleaning_targets where id=pg_temp.work_id(1000+n);
  insert into public.complaint_cases(id,room_id,cleaning_target_id,cleaning_attempt_id,submission_id,
    inspection_decision_id,original_earning_id,maid_profile_id,category,status,version,received_by,received_at,updated_at)
    values(pg_temp.work_id(8000+n),original.room_id,original.id,pg_temp.work_id(3000+n),pg_temp.work_id(4000+n),
      pg_temp.work_id(7000+n),pg_temp.work_id(5000+n),pg_temp.work_id(3),'cleanliness_general',
      'received',1,pg_temp.work_id(1),at_time-interval '3 hours',at_time-interval '3 hours');
  insert into public.complaint_case_events(complaint_case_id,event_type,to_status,case_version,actor_profile_id,occurred_at)
    values(pg_temp.work_id(8000+n),'received','received',1,pg_temp.work_id(1),at_time-interval '3 hours');
  update public.complaint_cases set status='under_review',version=2,updated_at=at_time-interval '150 minutes'
    where id=pg_temp.work_id(8000+n);
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,occurred_at)
    values(pg_temp.work_id(8000+n),'review_started','received','under_review',2,pg_temp.work_id(1),at_time-interval '150 minutes');
  insert into public.complaint_decisions(id,complaint_case_id,decision_version,decision_kind,finding,
    penalty_score,rework_required,decided_by,decided_at) values(pg_temp.work_id(9000+n),
      pg_temp.work_id(8000+n),1,'initial','confirmed',0,true,pg_temp.work_id(1),at_time-interval '2 hours');
  update public.complaint_cases set status='decided',current_decision_id=pg_temp.work_id(9000+n),version=3,
    first_decided_at=at_time-interval '2 hours',response_deadline=at_time-interval '2 hours'+interval '7 days',
    updated_at=at_time-interval '2 hours' where id=pg_temp.work_id(8000+n);
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
    actor_profile_id,decision_id,occurred_at) values(pg_temp.work_id(8000+n),'decided','under_review','decided',
      3,pg_temp.work_id(1),pg_temp.work_id(9000+n),at_time-interval '2 hours');
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by,complaint_compensation_decision_id) values(pg_temp.work_id(10000+n),
      original.room_id,'reclean','post_approval_complaint_reclean','work-comp-'||n,day,day,
      at_time-interval '90 minutes',at_time+interval '1 hour','approved',1,original.room_type_snapshot,
      0,'{}',pg_temp.work_id(1),pg_temp.work_id(11000+n));
  insert into public.complaint_compensation_decisions(id,complaint_case_id,complaint_decision_id,
    original_cleaning_target_id,rework_cleaning_target_id,original_maid_profile_id,assignee_maid_profile_id,
    original_base_fee_snapshot,compensation_amount,source_case_version,decided_by,decided_at)
    values(pg_temp.work_id(11000+n),pg_temp.work_id(8000+n),pg_temp.work_id(9000+n),original.id,
      pg_temp.work_id(10000+n),pg_temp.work_id(3),pg_temp.work_id(2),12000,p_amount,3,
      pg_temp.work_id(1),at_time-interval '90 minutes');
  update public.complaint_cases set current_compensation_decision_id=pg_temp.work_id(11000+n),version=4,
    updated_at=at_time-interval '90 minutes' where id=pg_temp.work_id(8000+n);
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
    actor_profile_id,decision_id,compensation_decision_id,occurred_at) values(pg_temp.work_id(8000+n),
      'rework_materialized','decided','decided',4,pg_temp.work_id(1),pg_temp.work_id(9000+n),
      pg_temp.work_id(11000+n),at_time-interval '90 minutes');
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,
    revision,is_current,notified_at,changed_by) values(pg_temp.work_id(12000+n),pg_temp.work_id(10000+n),
      pg_temp.work_id(2),day,n,1,true,at_time-interval '90 minutes',pg_temp.work_id(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
    values(pg_temp.work_id(13000+n),pg_temp.work_id(10000+n),pg_temp.work_id(12000+n),pg_temp.work_id(2),
      1,'approved',1,at_time-interval '1 hour',at_time-interval '10 minutes',at_time-interval '10 minutes','{}',
      jsonb_build_object('roomId',original.room_id,'roomNumber','frozen-room','code','standard','name','Frozen standard'));
  insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,
    photo_manifest,submitted_by,submitted_at) values(pg_temp.work_id(14000+n),pg_temp.work_id(13000+n),
      pg_temp.work_id(15000+n),1,'approved','{}',pg_temp.work_id(2),at_time-interval '5 minutes');
  insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
    values(pg_temp.work_id(16000+n),pg_temp.work_id(14000+n),'approved','QUALITY_OK',pg_temp.work_id(1),at_time);
  insert into public.compensation_entitlements(id,compensation_decision_id,complaint_case_id,complaint_decision_id,
    original_cleaning_target_id,rework_cleaning_target_id,maid_profile_id,cleaning_attempt_id,submission_id,
    inspection_decision_id,amount,entitled_at) values(pg_temp.work_id(17000+n),pg_temp.work_id(11000+n),
      pg_temp.work_id(8000+n),pg_temp.work_id(9000+n),original.id,pg_temp.work_id(10000+n),pg_temp.work_id(2),
      pg_temp.work_id(13000+n),pg_temp.work_id(14000+n),pg_temp.work_id(16000+n),p_amount,at_time);
  insert into public.earnings(id,compensation_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount)
    values(pg_temp.work_id(18000+n),pg_temp.work_id(17000+n),pg_temp.work_id(14000+n),pg_temp.work_id(2),day,p_amount);
  return pg_temp.work_id(18000+n);
end $$;
select pg_temp.work_compensation(2,0);
select pg_temp.work_compensation(3,6000);

create function pg_temp.work_slots() returns jsonb language sql immutable as $$
  select '[{"slotKey":"proof","required":true,"displayOrder":0,"sectionKey":"submission",
    "label":"Proof","description":"Synthetic proof","instanceNumber":1,"instanceCount":1}]'::jsonb
$$;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,
  duration_minutes,photo_slots,created_by) select pg_temp.work_id(21001),id,'additional',6,'published',30,
    pg_temp.work_slots(),pg_temp.work_id(1) from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,
  duration_minutes,photo_slots,created_by) select pg_temp.work_id(21002),id,'reclean',6,'published',30,
    pg_temp.work_slots(),pg_temp.work_id(1) from public.room_types where code='standard';
create function pg_temp.work_attempt(n integer,p_status public.attempt_status,p_fee integer default 12000,
  p_day date default pg_temp.work_week(0)) returns uuid language plpgsql as $$
declare room public.rooms; snapshot jsonb; at_time timestamptz:=least(
  (p_day::timestamp+time '12:00') at time zone 'Asia/Seoul',statement_timestamp());
begin
  select * into room from public.rooms where room_type_id=(select id from public.room_types where code='standard')
    order by room_number offset n limit 1;
  snapshot:=jsonb_build_object('id',pg_temp.work_id(21001),'version',6,'durationMinutes',30,'photoSlots',pg_temp.work_slots());
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by) values(pg_temp.work_id(22000+n),room.id,'additional',
      'manual_room_request','work-attempt-'||n,p_day,p_day,at_time-interval '2 hours',at_time+interval '2 hours',
      'notified',1,jsonb_build_object('id',room.room_type_id,'code','standard','name','Frozen workflow'),
      p_fee,snapshot,pg_temp.work_id(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,
    revision,is_current,notified_at,changed_by) values(pg_temp.work_id(23000+n),pg_temp.work_id(22000+n),
      pg_temp.work_id(2),p_day,200+n,1,true,at_time-interval '2 hours',pg_temp.work_id(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
    values(pg_temp.work_id(24000+n),pg_temp.work_id(22000+n),pg_temp.work_id(23000+n),pg_temp.work_id(2),1,
      p_status,1,case when p_status<>'scheduled' then at_time-interval '1 hour' end,
      case when p_status in ('field_completed','upload_pending') then at_time end,
      case when p_status in ('field_completed','upload_pending') then at_time end,snapshot,
      jsonb_build_object('roomId',room.id,'roomNumber',room.room_number,'code','standard','name','Frozen workflow'));
  return pg_temp.work_id(24000+n);
end $$;
-- Mirror an actually accepted provider object, as in the existing submission
-- domain suite. The production validation triggers remain enabled throughout.
create function pg_temp.work_accept_photo() returns trigger language plpgsql as $$
declare attempt public.cleaning_attempts; v_operation_id uuid:=gen_random_uuid(); object_id uuid:=gen_random_uuid();
begin
  select * into strict attempt from public.cleaning_attempts where id=new.cleaning_attempt_id;
  insert into private.photo_upload_operations(id,actor_profile_id,command_type,idempotency_key_digest,request_hash,
    cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,target_photo_slot_id,
    expected_photo_revision,sha256,mime_type,size_bytes) values(v_operation_id,attempt.maid_profile_id,'photo.upload',
      encode(extensions.digest(new.id::text||':key','sha256'),'hex'),
      encode(extensions.digest(new.id::text||':request','sha256'),'hex'),new.cleaning_attempt_id,
      new.cleaning_target_id,attempt.assignment_id,attempt.assignment_revision,new.target_photo_slot_id,
      new.version-1,new.sha256,new.mime_type,new.size_bytes);
  insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
    values(object_id,v_operation_id,'fixture_'||replace(new.id::text,'-',''),new.uploaded_at,new.purge_after);
  insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,
    status,lease_version,revision) values(v_operation_id,new.cleaning_attempt_id,new.target_photo_slot_id,
      attempt.maid_profile_id,'provider_succeeded',0,1);
  insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id)
    values(v_operation_id,object_id,new.id);
  update private.photo_upload_states set status='accepted',revision=revision+1
    where private.photo_upload_states.operation_id=v_operation_id;
  return new;
end $$;
create trigger work_accept_photo after insert on private.attempt_photo_versions
  for each row execute function pg_temp.work_accept_photo();
create function pg_temp.work_photo(n integer) returns uuid language sql as $$
  select private.record_validated_attempt_photo(pg_temp.work_id(2),pg_temp.work_id(24000+n),
    (select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.work_id(22000+n)
      and slot_key='proof'),0,repeat('a',64),'image/jpeg',100,clock_timestamp()-interval '5 minutes')
$$;
create function pg_temp.work_submit(n integer) returns jsonb language sql as $$
  select public.create_cleaning_submission(pg_temp.work_id(2),pg_temp.work_id(24000+n),
    pg_temp.work_id(25000+n),0,0,'work-submit-'||n,repeat('b',64))
$$;
select pg_temp.work_attempt(1,'scheduled');
select pg_temp.work_attempt(2,'in_progress');
select pg_temp.work_attempt(3,'field_completed');
select pg_temp.work_attempt(4,'upload_pending');
select pg_temp.work_attempt(5,'field_completed');
select pg_temp.work_attempt(6,'field_completed');
select pg_temp.work_attempt(7,'field_completed');
select pg_temp.work_attempt(8,'field_completed');
select pg_temp.work_attempt(9,'field_completed');
select pg_temp.work_attempt(10,'field_completed',0,pg_temp.work_week(-1)+1);
select pg_temp.work_photo(n) from generate_series(5,9)n;
select pg_temp.work_photo(10);
create temporary table work_results(label text primary key,value jsonb);
insert into work_results values('pending',pg_temp.work_submit(5)),('rejected',pg_temp.work_submit(6));
insert into work_results values('zero-pending',pg_temp.work_submit(10));
insert into work_results values('bomb-report',public.report_bomb_room(pg_temp.work_id(2),pg_temp.work_id(24007),
  array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.work_id(24007))],
  'Synthetic bomb proof','work-bomb-report',repeat('c',64)));
insert into work_results values('bomb',pg_temp.work_submit(7));
insert into work_results values('bomb-decision',public.decide_bomb_room(pg_temp.work_id(1),
  (select (value->>'id')::uuid from work_results where label='bomb'),'approved','BOMB_CONFIRMED',
  'work-bomb-decision',repeat('d',64)));
insert into work_results values('ordinary',pg_temp.work_submit(8));
insert into work_results values('pending-bomb-report',public.report_bomb_room(pg_temp.work_id(2),pg_temp.work_id(24009),
  array[(select photo_version_id from private.attempt_photo_current where cleaning_attempt_id=pg_temp.work_id(24009))],
  'Synthetic pending bomb proof','work-pending-bomb-report',repeat('e',64)));
insert into work_results values('pending-bomb',pg_temp.work_submit(9));
insert into work_results values('pending-bomb-decision',public.decide_bomb_room(pg_temp.work_id(1),
  (select (value->>'id')::uuid from work_results where label='pending-bomb'),'approved','BOMB_CONFIRMED',
  'work-pending-bomb-decision',repeat('f',64)));
insert into work_results values('bomb-approval',public.approve_cleaning_submission(pg_temp.work_id(1),
  (select (value->>'id')::uuid from work_results where label='bomb'),'QUALITY_OK','work-bomb-approval',repeat('1',64))),
  ('ordinary-approval',public.approve_cleaning_submission(pg_temp.work_id(1),
  (select (value->>'id')::uuid from work_results where label='ordinary'),'QUALITY_OK','work-ordinary-approval',repeat('2',64))),
  ('rejection',public.reject_cleaning_submission(pg_temp.work_id(1),
  (select (value->>'id')::uuid from work_results where label='rejected'),'QUALITY_REWORK','work-rejection',repeat('3',64)));
-- An actual newly notified inspection reclean is not an attempt-zero synthetic
-- expected earning. Stage its legitimate scheduled attempt without starting it.
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
  status,assignment_revision,template_snapshot,room_snapshot)
select pg_temp.work_id(26000),t.id,a.id,a.maid_profile_id,1,'scheduled',a.revision,t.template_snapshot,
  t.room_type_snapshot||jsonb_build_object('roomId',t.room_id,'roomNumber','unpaid-reclean')
from work_results result join public.cleaning_targets t on t.id=(result.value->>'recleanTargetId')::uuid
  join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current where result.label='rejection';

-- Larger historical workflow pages use distinct nonstandard rooms, so they do
-- not invent simultaneously live workflows on the same room. Legacy empty
-- photo contracts remain unreadiness metadata, never synthetic photo proof.
create function pg_temp.work_large_workflow(n integer,p_variant text default 'eligible')
returns void language plpgsql as $$
declare room record; day date:=pg_temp.work_week(-2)+1;
  at_time timestamptz:=(day::timestamp+time '12:00') at time zone 'Asia/Seoul';
begin
  select r.id,r.room_number,r.room_type_id,type.code,type.name into strict room
    from public.rooms r join public.room_types type on type.id=r.room_type_id
    where type.code<>'standard' order by r.room_number offset n-300 limit 1;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by) values(pg_temp.work_id(22000+n),room.id,'additional',
      'manual_room_request','work-large-'||n,day,day,at_time-interval '2 hours',at_time+interval '2 hours',
      case when p_variant='cancelled' then 'cancelled' when p_variant in ('noncurrent','interrupted','superseded')
        then 'unassigned' when p_variant='unnotified' then 'draft_assigned' else 'notified' end::public.cleaning_target_status,
      1,jsonb_build_object('id',room.room_type_id,'code',room.code,'name',room.name),1000,'{}',pg_temp.work_id(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,service_date,sequence_number,
    revision,is_current,notified_at,ended_at,changed_by) values(pg_temp.work_id(23000+n),pg_temp.work_id(22000+n),
      pg_temp.work_id(2),day,n,1,true,
      case when p_variant<>'unnotified' then at_time-interval '2 hours' end,
      null,pg_temp.work_id(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,started_at,ended_at,end_reason,template_snapshot,room_snapshot)
    values(pg_temp.work_id(24000+n),pg_temp.work_id(22000+n),pg_temp.work_id(23000+n),pg_temp.work_id(2),1,
      case when p_variant='interrupted' then 'interrupted' when p_variant='superseded' then 'superseded'
        else 'scheduled' end::public.attempt_status,1,
      case when p_variant='interrupted' then at_time-interval '1 hour' end,
      case when p_variant in ('interrupted','superseded') then at_time end,
      case when p_variant in ('interrupted','superseded') then 'MAID_UNAVAILABLE' end,'{}',
      jsonb_build_object('roomId',room.id,'roomNumber',room.room_number,'code',room.code,'name',room.name));
  -- Identity creation is checked against the then-current assignment. Retire
  -- that immutable responsibility only afterwards, preserving the past row.
  if p_variant in ('noncurrent','interrupted','superseded') then
    update public.cleaning_assignments set is_current=false,ended_at=at_time
      where id=pg_temp.work_id(23000+n);
  end if;
end $$;
select pg_temp.work_large_workflow(n) from generate_series(300,353)n;
select pg_temp.work_large_workflow(354,'cancelled');
select pg_temp.work_large_workflow(355,'noncurrent');
select pg_temp.work_large_workflow(356,'interrupted');
select pg_temp.work_large_workflow(357,'superseded');
select pg_temp.work_large_workflow(358,'unnotified');
set constraints all immediate;
set constraints all deferred;
-- PAYROLL_WORK_DETAILS_FIXTURE_END

create function pg_temp.work_read(p_week integer default 0,p_kind text default 'earnings',p_limit integer default 25,
  p_after_date date default null,p_after_id uuid default null,p_maid integer default 2)
returns jsonb language sql stable as $$
  select public.list_payroll_work_details_page(pg_temp.work_id(1),pg_temp.work_id(401),'admin',
    pg_temp.work_week(p_week),pg_temp.work_id(p_maid),p_kind,p_after_date,p_after_id,p_limit)
$$;
create function pg_temp.work_all(p_week integer,p_kind text,p_maid integer default 2)
returns jsonb language plpgsql stable as $$
declare page jsonb; result jsonb:='[]'; last_date date; last_id uuid; pages integer:=0;
begin
  loop
    page:=pg_temp.work_read(p_week,p_kind,25,last_date,last_id,p_maid);
    result:=result||(page->'entries'); pages:=pages+1;
    if pages>100 then raise exception 'unbounded work fixture page'; end if;
    exit when not (page->>'hasMore')::boolean;
    last_date:=(page->>'lastEntryDate')::date; last_id:=(page->>'lastEntryId')::uuid;
  end loop;
  return result;
end $$;
create function pg_temp.work_state() returns text language plpgsql as $$
declare item record; pieces text[]:='{}'; value text;
begin
  for item in select n.nspname schema_name,c.relname table_name from pg_class c
    join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private')
      and c.relkind='r' order by n.nspname,c.relname loop
    execute format('select coalesce(string_agg(to_jsonb(t)::text,''|'' order by to_jsonb(t)::text),'''') from %I.%I t',
      item.schema_name,item.table_name) into value;
    pieces:=array_append(pieces,item.schema_name||'.'||item.table_name||':'||value);
  end loop;
  return md5(array_to_string(pieces,'|'));
end $$;
create temporary table work_checkpoints(label text primary key,value jsonb);
insert into work_checkpoints values('initial',to_jsonb(pg_temp.work_state())),
  ('earnings',(select jsonb_agg(to_jsonb(e) order by id) from public.earnings e)),
  ('empty',pg_temp.work_read(0,'earnings',25,null,null,11));
select is(jsonb_array_length(pg_temp.work_read(-4)->'entries'),25,'default earning page is bounded to 25');
select is(jsonb_array_length(pg_temp.work_read(-4,'earnings',50)->'entries'),50,'maximum earning page is exactly 50');
select is(jsonb_array_length(pg_temp.work_all(-4,'earnings')),62,'all earning cursor pages retain every actual tied-date row');
select is((select count(distinct row->>'entryId') from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row),
  62::bigint,'keyset pages do not repeat earning IDs');
select is((select sum((row->>'totalAmount')::bigint) from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row),
  71000::numeric,'all-page actual earning sum is exact');
select is(pg_temp.work_read(-4)->'summary'->>'accrualAmount','71000','accrual includes all actual earnings, not the first page');
select is((select sum((row->>'itemContributionAmount')::bigint) from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row),
  (pg_temp.work_read(-4)->'summary'->>'totalAmount')::numeric,'item membership exactly reconciles existing total');
select is((select row->>'submissionId' from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row
  where row->>'entryId'=pg_temp.work_id(5001)::text),pg_temp.work_id(4001)::text,
  'earning detail uses its immutable submission even without a current pointer');
select is((select row->>'attemptId' from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row
  where row->>'entryId'=pg_temp.work_id(5001)::text),pg_temp.work_id(3001)::text,'earning FK resolves the exact attempt');
select is((select row->>'inspectionDecisionId' from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row
  where row->>'entryId'=pg_temp.work_id(5001)::text),pg_temp.work_id(7001)::text,'earning FK resolves the exact approved decision');
select is((select row->>'roomTypeName' from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row
  where row->>'entryId'=pg_temp.work_id(5001)::text),'Frozen standard','earning name is frozen snapshot metadata');
select is(pg_temp.work_read(0)->'summary'->>'cycleStatus','open','conceptual cycle stays OPEN');
select is(pg_temp.work_read(0)->'summary'->>'cycleVersion','0','conceptual cycle has version zero');
select is(pg_temp.work_read(0)->'summary'->'cycleId','null'::jsonb,'read does not fabricate a cycle ID');
select is(pg_temp.work_read(0)->'summary'->'lockedAmount','null'::jsonb,'unlocked conceptual cycle has no locked amount');
select is(pg_temp.work_read(0)->'summary'->>'offsetSettled','false','conceptual cycle is not economically frozen');
select is((select value->>'hasMore' from work_checkpoints where label='empty'),'false','empty page has no continuation');
select is((select value->'lastEntryDate' from work_checkpoints where label='empty'),'null'::jsonb,'empty page date is null');
select is((select value->'lastEntryId' from work_checkpoints where label='empty'),'null'::jsonb,'empty page ID is null');
select is((select value->'entries' from work_checkpoints where label='empty'),'[]'::jsonb,'empty page has exact empty array');
select is(pg_temp.work_read(-4,'earnings',50,(pg_temp.work_week(-4)+1),pg_temp.work_id(5160))->>'hasMore','false',
  'cursor beyond the last row is empty and terminal');
select is((select row->>'entryDate' from jsonb_array_elements(pg_temp.work_all(-1,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5004)::text),(pg_temp.work_week(-1)+6)::text,'Sunday KST remains in previous week');
select is((select row->>'entryDate' from jsonb_array_elements(pg_temp.work_all(0,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5005)::text),pg_temp.work_week(0)::text,'Monday KST belongs to current readable week');
select is((select row->>'totalAmount' from jsonb_array_elements(pg_temp.work_all(-3,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(18002)::text),'0','a zero-KRW compensation remains an actual earning row');
select is((select row->>'earningSource' from jsonb_array_elements(pg_temp.work_all(-3,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(18002)::text),'compensation','zero compensation has typed earning provenance');
select is((select row->>'feeSnapshot' from jsonb_array_elements(pg_temp.work_all(-3,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(18003)::text),'0','compensation target fee stays zero');
select is((select row->>'baseAmount' from jsonb_array_elements(pg_temp.work_all(-3,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(18003)::text),'6000','compensation earning uses actual fixed compensation, not target fee');
select is(pg_temp.work_read(-3)->'summary'->>'accrualAmount','6000','zero and positive compensation reconcile existing accrual');
select is((select row->>'roomTypeCode' from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5006)::text),'standard','legacy omitted type falls back only to frozen target');
select is((select row->'roomTypeCode' from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5007)::text),'null'::jsonb,'explicit snapshot null is preserved');
select is((select row->'roomNumber' from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5007)::text),'null'::jsonb,'numeric snapshot room number is not stringified');
select is((select row->'roomTypeName' from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5008)::text),'null'::jsonb,'malformed nested snapshot is not repaired from live catalog');
select is((select row->>'roomTypeCode' from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5009)::text),'standard','missing nested key uses frozen target, not conflicting flat label');
select is((select row->'roomTypeName' from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5009)::text),'null'::jsonb,'empty explicit snapshot name stays unknown');
select ok((select row->'roomTypeName'='null'::jsonb and row->'roomTypeCode'='null'::jsonb
    and row->'roomNumber'='null'::jsonb from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5010)::text),'blank snapshot fields stay unknown, not live fallback');
select is((select length(row->>'roomTypeName') from jsonb_array_elements(pg_temp.work_all(-5,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5011)::text),2002,'valid long frozen labels have no invented 100-character limit');

select is((select row->>'baseAmount' from jsonb_array_elements(pg_temp.work_all(0,'earnings'))row
  where row->>'attemptId'=pg_temp.work_id(24007)::text),'12000','bomb approval retains frozen base');
select is((select row->>'bombRoomBonus' from jsonb_array_elements(pg_temp.work_all(0,'earnings'))row
  where row->>'attemptId'=pg_temp.work_id(24007)::text),'12000','bomb approval adds exactly one frozen bonus');
select is((select row->>'totalAmount' from jsonb_array_elements(pg_temp.work_all(0,'earnings'))row
  where row->>'attemptId'=pg_temp.work_id(24007)::text),'24000','approved bomb total is exactly two times base');
select is((select row->>'bombRoomBonus' from jsonb_array_elements(pg_temp.work_all(0,'earnings'))row
  where row->>'attemptId'=pg_temp.work_id(24008)::text),'0','ordinary approval has no synthetic bonus');
select is((select row->>'submissionId' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24005)::text),(select value->>'id' from work_results where label='pending'),
  'pending workflow resolves current immutable submission pointer');
select is((select row->>'inspectionDecision' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24006)::text),'rejected','rejection is shown separately from confirmed earning');
select is((select row->'earningId' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24006)::text),'null'::jsonb,'rejection is not represented as a fake zero earning');
select is((select row->>'expectedContributionAmount' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24006)::text),'0','rejected attempt is excluded from expected contribution');
select is((select row->>'expectedBombContributionAmount' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24009)::text),'12000','pending bomb source retains the exact existing expected bonus predicate');
select is((select row->>'pendingContributionAmount' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24009)::text),'24000','pending bomb is expected only, never confirmed earning');
select is((select row->>'sourceKind' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(26000)::text),'inspection_reclean','unpaid reclean is an actual separate workflow row');
select is((select row->>'expectedContributionAmount' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(26000)::text),'0','inspection reclean contributes no expected money');
select ok(not exists(select 1 from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->'baseAmount'<>'null'::jsonb or row->'bombRoomBonus'<>'null'::jsonb or row->'totalAmount'<>'null'::jsonb),
  'unearned workflow actual money fields are all explicitly null');
select is((select count(*) from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId' in (pg_temp.work_id(24007)::text,pg_temp.work_id(24008)::text)),0::bigint,
  'actual earned attempts never appear in workflow a second time');
select is((select sum((row->>'expectedContributionAmount')::bigint) from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row),
  ((pg_temp.work_read(0)->'summary'->>'expectedAmount')::bigint
    -(pg_temp.work_read(0)->'summary'->>'accrualAmount')::bigint)::numeric,
  'all workflow contribution totals exactly reconcile expected minus actual accrual');
select is((select sum((row->>'pendingContributionAmount')::bigint) from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row),
  (pg_temp.work_read(0)->'summary'->>'pendingAmount')::numeric,'pending amount reconciles the existing aggregate exactly');
select is((select count(*) from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where (row->>'includedInPendingCount')::boolean),(pg_temp.work_read(0)->'summary'->>'pendingCount')::bigint,
  'pending count reconciles the exact existing aggregate');
select is(pg_temp.work_read(0)->'summary'->>'pendingCount','2','only the two actual pending submissions contribute');
select is(pg_temp.work_read(0)->'summary'->>'pendingAmount','36000','pending ordinary plus approved-bomb expected sum is exact');
select is(jsonb_array_length(pg_temp.work_read(-2,'workflow',50)->'entries'),50,'maximum workflow page is bounded to 50');
select is(jsonb_array_length(pg_temp.work_all(-2,'workflow')),58,'all tied-date workflow pages retain every actual notified attempt');
select is((select count(distinct row->>'entryId') from jsonb_array_elements(pg_temp.work_all(-2,'workflow'))row),
  58::bigint,'workflow keyset pages have no duplicate IDs');
select is((select sum((row->>'expectedContributionAmount')::bigint) from jsonb_array_elements(pg_temp.work_all(-2,'workflow'))row),
  54000::numeric,'workflow eligible contributions across more than 50 rows are exact');
select is(pg_temp.work_read(-2,'workflow')->'summary'->>'expectedAmount','54000',
  'all-page workflow amount equals existing aggregate including historical exclusions');
select is((select row->>'attemptStatus' from jsonb_array_elements(pg_temp.work_all(-2,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24356)::text),'interrupted','interrupted history is preserved as informational workflow');
select is((select row->>'attemptStatus' from jsonb_array_elements(pg_temp.work_all(-2,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24357)::text),'superseded','superseded history is preserved as informational workflow');
select is((select count(*) from jsonb_array_elements(pg_temp.work_all(-2,'workflow'))row
  where row->>'attemptId' in (pg_temp.work_id(24354)::text,pg_temp.work_id(24355)::text,
    pg_temp.work_id(24356)::text,pg_temp.work_id(24357)::text)
    and row->>'expectedContributionAmount'='0' and row->>'pendingContributionAmount'='0'
    and row->>'includedInPendingCount'='false'),4::bigint,
  'cancelled/noncurrent/interrupted/superseded workflows contribute no expected or pending amounts');
select is((select count(*) from jsonb_array_elements(pg_temp.work_all(-2,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24358)::text),0::bigint,'unnotified legacy attempt is not exposed as a notified job');
select is((select row->>'includedInPendingCount' from jsonb_array_elements(pg_temp.work_all(-1,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24010)::text),'true','actual zero-fee submitted workflow still contributes one pending count');
select is((select row->>'pendingContributionAmount' from jsonb_array_elements(pg_temp.work_all(-1,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(24010)::text),'0','zero-fee submitted workflow adds no fabricated money');
select is(pg_temp.work_read(-1,'workflow')->'summary'->>'pendingCount','1','zero-fee pending count reconciles the existing aggregate');
select is(pg_temp.work_read(-1,'workflow')->'summary'->>'pendingAmount','0','zero-fee pending amount reconciles the existing aggregate');
select is(to_jsonb(pg_temp.work_state()),(select value from work_checkpoints where label='initial'),
  'every read leaves all complete public/private rows byte-exact including money, PIN, retention and receipts');

-- Frozen PAID membership and late approval/carried source stay separate.
insert into work_results values('payment-start',public.start_payroll_cycle(pg_temp.work_id(1),pg_temp.work_id(2),
  pg_temp.work_week(-4),0,'work-payment-start',repeat('4',64)));
select pg_temp.work_add_earning(170,2,pg_temp.work_week(-4)+2,9000);
select is(pg_temp.work_read(-4)->'summary'->>'totalAmount','71000','late approval does not alter locked item total');
select is(pg_temp.work_read(-4)->'summary'->>'accrualAmount','80000','late approval remains in its actual earned-on accrual');
select is(pg_temp.work_read(-4)->'summary'->>'lateEarningAmount','9000','late approval has separate payable-late membership');
select is((select sum((row->>'lateContributionAmount')::bigint) from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row),
  9000::numeric,'all-page late contribution sum is exact');
insert into work_results values('paid',public.record_payroll_payment_paid(pg_temp.work_id(1),
  (select id from public.payroll_payment_attempts where payroll_cycle_id=(select (value->>'cycleId')::uuid
    from work_results where label='payment-start')),
  (select version from public.payroll_cycles where maid_profile_id=pg_temp.work_id(2) and week_start=pg_temp.work_week(-4)),
  'bank_transfer','WORK-324-A1','work-payment-paid',repeat('5',64)));
insert into work_checkpoints values('paid-cycle',(select to_jsonb(c) from public.payroll_cycles c
  where maid_profile_id=pg_temp.work_id(2) and week_start=pg_temp.work_week(-4))),
  ('paid-items',(select jsonb_agg(to_jsonb(i) order by earning_id) from public.payroll_items i));
select public.carry_late_payroll_earning(pg_temp.work_id(1),pg_temp.work_id(5170),0,'work-late-carry',repeat('6',64));
select is(pg_temp.work_read(-4)->'summary'->>'cycleStatus','paid','paid state is not mislabeled unpaid');
select is(pg_temp.work_read(-4)->'summary'->>'lockedAmount','71000','paid locked amount stays authoritative');
select is(pg_temp.work_read(-4)->'summary'->>'lateEarningAmount','0','already carried earning is removed from late membership');
select is(pg_temp.work_read(-4)->'summary'->>'accrualAmount','80000','carried earning keeps original historical accrual');
select is((select row->>'lateCarried' from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5170)::text),'true','actual carried provenance is visible without adjustment duplication');
select is((select row->>'itemContributionAmount' from jsonb_array_elements(pg_temp.work_all(-4,'earnings'))row
  where row->>'earningId'=pg_temp.work_id(5170)::text),'0','carried late earning contributes no original payable item');
select is(pg_temp.work_read(-3)->'summary'->>'adjustmentAmount','9000','next-week carry appears only in existing adjustment aggregate');
select is(pg_temp.work_read(-3)->'summary'->>'payableAmount','15000','existing 6000 compensation plus 9000 adjustment is not double-added');
select is((select to_jsonb(c) from public.payroll_cycles c where maid_profile_id=pg_temp.work_id(2)
  and week_start=pg_temp.work_week(-4)),(select value from work_checkpoints where label='paid-cycle'),
  'late carry and detail reads preserve the complete PAID cycle snapshot');
select is((select jsonb_agg(to_jsonb(i) order by earning_id) from public.payroll_items i),
  (select value from work_checkpoints where label='paid-items'),'late carry and detail reads preserve all locked items');
insert into work_checkpoints values('before-catalog',pg_temp.work_read(-4));
update public.room_types set name=name||'-changed',base_cleaning_fee=base_cleaning_fee+1 where code='standard';
select is(pg_temp.work_read(-4),(select value from work_checkpoints where label='before-catalog'),
  'live catalog name/fee changes never rewrite frozen detail or historical amounts');

select public.carry_forward_payroll_cycle(pg_temp.work_id(1),pg_temp.work_id(11),pg_temp.work_week(-7),0,
  'work-empty-offset',repeat('7',64));
select pg_temp.work_add_earning(200,11,pg_temp.work_week(-7)+1,1000);
select is(pg_temp.work_read(-7,'earnings',25,null,null,11)->'summary'->>'cycleStatus','open',
  'offset-settled cycle retains OPEN status rather than fabricating PAID');
select is(pg_temp.work_read(-7,'earnings',25,null,null,11)->'summary'->>'offsetSettled','true',
  'offset-settled OPEN cycle exposes its independent economic-freeze axis');
select is(pg_temp.work_read(-7,'earnings',25,null,null,11)->'summary'->>'totalAmount','0',
  'post-offset late earning does not join frozen items');
select is(pg_temp.work_read(-7,'earnings',25,null,null,11)->'summary'->>'lateEarningAmount','1000',
  'post-offset late earning has the exact existing late aggregate membership');
select is((pg_temp.work_read(-7,'earnings',25,null,null,11)->'entries'->0)->>'lateContributionAmount','1000',
  'offset OPEN status does not misclassify late earning as a current payable candidate');
select is((pg_temp.work_read(-7,'earnings',25,null,null,11)->'entries'->0)->>'itemContributionAmount','0',
  'post-offset late earning contributes zero to the frozen item total');

-- Finish the sole in-progress work before legitimately starting the original
-- maid's inspection reclean, then use normal completion/photo/approval commands.
select public.complete_cleaning_attempt_field_work(pg_temp.work_id(2),pg_temp.work_id(24002),1,
  pg_temp.work_id(23002),1,'work-finish-active',repeat('8',64));
select public.start_cleaning_attempt(pg_temp.work_id(2),pg_temp.work_id(26000),1,
  (select assignment_id from public.cleaning_attempts where id=pg_temp.work_id(26000)),1,
  'work-start-reclean',repeat('9',64));
select public.complete_cleaning_attempt_field_work(pg_temp.work_id(2),pg_temp.work_id(26000),2,
  (select assignment_id from public.cleaning_attempts where id=pg_temp.work_id(26000)),1,
  'work-complete-reclean',repeat('a',64));
select private.record_validated_attempt_photo(pg_temp.work_id(2),pg_temp.work_id(26000),
  (select slot.id from private.target_photo_slot_snapshots slot
    join public.cleaning_attempts attempt on attempt.cleaning_target_id=slot.cleaning_target_id
    where attempt.id=pg_temp.work_id(26000) and slot.slot_key='proof'),0,repeat('a',64),
  'image/jpeg',100,clock_timestamp());
insert into work_results values('reclean-submission',public.create_cleaning_submission(pg_temp.work_id(2),
  pg_temp.work_id(26000),pg_temp.work_id(26001),0,0,'work-reclean-submit',repeat('b',64)));
insert into work_results values('reclean-approval',public.approve_cleaning_submission(pg_temp.work_id(1),
  (select (value->>'id')::uuid from work_results where label='reclean-submission'),'QUALITY_OK',
  'work-reclean-approval',repeat('c',64)));
select is((select row->>'attemptStatus' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(26000)::text),'approved','approved unpaid inspection reclean stays in workflow detail');
select is((select row->>'inspectionDecision' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(26000)::text),'approved','approved unpaid workflow retains exact inspection evidence');
select is((select row->'earningId' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(26000)::text),'null'::jsonb,'approved inspection reclean does not fabricate a zero earning');
select is((select count(*) from public.earnings e join public.cleaning_submissions s on s.id=e.submission_id
  where s.cleaning_attempt_id=pg_temp.work_id(26000)),0::bigint,'the original maid approved reclean has exactly zero earning rows');
select is((select row->>'expectedContributionAmount' from jsonb_array_elements(pg_temp.work_all(0,'workflow'))row
  where row->>'attemptId'=pg_temp.work_id(26000)::text),'0','approved unpaid reclean adds no expected or payable money');

select is(public.list_payroll_work_details_page(pg_temp.work_id(2),pg_temp.work_id(402),'maid',
  pg_temp.work_week(-4),pg_temp.work_id(2),'earnings'),pg_temp.work_read(-4),
  'active self maid receives the same safe historical detail');
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(2),pg_temp.work_id(402),'maid',
  pg_temp.work_week(0),pg_temp.work_id(3),'earnings')$$,'42501','PAYROLL_ACCESS_REQUIRED','maid cannot read another maid');
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(2),pg_temp.work_id(402),'admin',
  pg_temp.work_week(0),pg_temp.work_id(2),'earnings')$$,'42501','PAYROLL_ACCESS_REQUIRED','stale expected admin role cannot shape a maid read');
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(1),pg_temp.work_id(401),'maid',
  pg_temp.work_week(0),pg_temp.work_id(2),'earnings')$$,'42501','PAYROLL_ACCESS_REQUIRED','stale expected maid role cannot shape admin read');
select throws_ok(format('select public.list_payroll_work_details_page(%L,%L,%L,%L,%L,%L)',
  pg_temp.work_id(n),pg_temp.work_id(400+n),case when n=7 then 'admin' when n=5 then 'developer' else 'maid' end,
  pg_temp.work_week(0),pg_temp.work_id(11),'earnings'),'42501','PAYROLL_ACCESS_REQUIRED',
  'developer/inactive/departed/limited actor is rejected even on empty result: '||n) from unnest(array[5,7,8,9,10])n;
select throws_ok(format('select public.list_payroll_work_details_page(%L,%L,%L,%L,%L,%L)',
  pg_temp.work_id(n),pg_temp.work_id(400+n),case when n=6 then 'admin' else 'maid' end,
  pg_temp.work_week(0),pg_temp.work_id(n),'earnings'),'42501','PASSWORD_CHANGE_REQUIRED',
  'temporary-password actor is rejected: '||n) from unnest(array[6,12])n;
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(999),pg_temp.work_id(401),'admin',
  pg_temp.work_week(0),pg_temp.work_id(11),'earnings')$$,'42501','PAYROLL_ACCESS_REQUIRED','missing actor is rejected');
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(1),null,'admin',
  pg_temp.work_week(0),pg_temp.work_id(11),'earnings')$$,'42501','SESSION_REVOKED','missing session is rejected');
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(1),pg_temp.work_id(404),'admin',
  pg_temp.work_week(0),pg_temp.work_id(11),'earnings')$$,'42501','SESSION_REVOKED','foreign admin session is rejected');
select throws_ok($$select public.list_payroll_work_details_page(pg_temp.work_id(1),pg_temp.work_id(499),'admin',
  pg_temp.work_week(0),pg_temp.work_id(11),'earnings')$$,'42501','SESSION_REVOKED','revoked unknown session is rejected');
update auth.sessions set not_after=statement_timestamp()-interval '1 second' where id=pg_temp.work_id(401);
select throws_ok($$select pg_temp.work_read()$$,'42501','SESSION_REVOKED','expired actor-owned session is rejected');
create function pg_temp.work_equal_expiry() returns jsonb language plpgsql as $$
begin update auth.sessions set not_after=statement_timestamp() where id=pg_temp.work_id(401);
  return pg_temp.work_read(); end $$;
select throws_ok($$select pg_temp.work_equal_expiry()$$,'42501','SESSION_REVOKED','strict session expiry equality is rejected');
update auth.sessions set not_after=statement_timestamp()+interval '1 hour' where id=pg_temp.work_id(401);
select lives_ok($$select pg_temp.work_read()$$,'future actor-owned session expiry is accepted');
update auth.sessions set not_after=null where id=pg_temp.work_id(401);
select lives_ok($$select pg_temp.work_read()$$,'null actor-owned session expiry is accepted');
select lives_ok($$select pg_temp.work_read(0,'earnings',25,null,null,8)$$,'admin may read departed maid history');
select lives_ok($$select pg_temp.work_read(0,'earnings',25,null,null,9)$$,'admin may read inactive limited-status maid history');
select throws_ok($$select pg_temp.work_read(0,'earnings',25,null,null,1)$$,'P0002','PAYROLL_MAID_NOT_FOUND','admin ID is not a maid ledger');
select throws_ok($$select pg_temp.work_read(0,'earnings',25,null,null,999)$$,'P0002','PAYROLL_MAID_NOT_FOUND','unknown maid ledger is not fabricated');
select throws_ok($$select pg_temp.work_read(1)$$,'22023','PAYROLL_WEEK_NOT_CLOSED','future KST week is rejected');
select throws_ok(format('select public.list_payroll_work_details_page(%L,%L,%L,%L,%L,%L)',
  pg_temp.work_id(1),pg_temp.work_id(401),'admin',bad_date,pg_temp.work_id(2),'earnings'),
  '22023','PAYROLL_WEEK_MUST_START_MONDAY','invalid date rejected: '||coalesce(bad_date,'null'))
from unnest(array[null::text,'infinity','-infinity','0001-01-01 BC','10000-01-03',
  (pg_temp.work_week(0)+1)::text])bad_date;
select throws_ok(format('select pg_temp.work_read(0,%L)',bad_kind),'22023','PAYROLL_PAGE_KIND_INVALID',
  'invalid family rejected: '||coalesce(bad_kind,'null')) from unnest(array[null::text,'items','lateEarnings','bad'])bad_kind;
select throws_ok(format('select pg_temp.work_read(0,%L,%s)','earnings',coalesce(bad_limit::text,'null')),
  '22023','PAYROLL_PAGE_LIMIT_INVALID','invalid size rejected: '||coalesce(bad_limit::text,'null'))
from unnest(array[null::integer,0,-1,51])bad_limit;
select throws_ok($$select pg_temp.work_read(0,'earnings',25,pg_temp.work_week(0),null)$$,
  '22023','PAYROLL_CURSOR_INVALID','unpaired date cursor rejected');
select throws_ok($$select pg_temp.work_read(0,'earnings',25,null,pg_temp.work_id(5001))$$,
  '22023','PAYROLL_CURSOR_INVALID','unpaired ID cursor rejected');
select throws_ok($$select pg_temp.work_read(0,'earnings',25,pg_temp.work_week(-1),pg_temp.work_id(5001))$$,
  '22023','PAYROLL_CURSOR_INVALID','cursor outside requested week rejected');
select throws_ok($$select pg_temp.work_read(0,'earnings',25,'infinity',pg_temp.work_id(5001))$$,
  '22023','PAYROLL_CURSOR_INVALID','infinite cursor date rejected');
select ok(not (pg_temp.work_read(-3)::text ~* 'compensationDecisionId|originalMaid|assigneeMaid|provider|locator|photo|memo|requestHash|sessionId|authUser|pin'),
  'public projection does not leak raw compensation cross-maid identities, photos, PIN or authorization bindings');
select ok(not has_function_privilege(role_name,
  'public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)','EXECUTE'),
  role_name||' cannot invoke service-owned RPC') from unnest(array['anon','authenticated'])role_name;
select ok(has_function_privilege('service_role',
  'public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)','EXECUTE'),
  'service_role has exact RPC execute privilege');
select is((select provolatile::text from pg_proc where oid=
  'public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)'::regprocedure),
  's','RPC is STABLE and preserves one statement snapshot');
select ok((select prosecdef and proconfig=array['search_path=""'] from pg_proc where oid=
  'public.list_payroll_work_details_page(uuid,uuid,text,date,uuid,text,date,uuid,integer)'::regprocedure),
  'SECURITY DEFINER uses an empty search path');
set local role service_role;
select lives_ok($$select pg_temp.work_read()$$,'real service role may execute an authorized read');
reset role;
set local role authenticated;
select throws_ok($$select pg_temp.work_read()$$,'42501',
  'permission denied for function list_payroll_work_details_page','authenticated direct RPC execution is denied');
reset role;
set constraints all immediate;
select * from finish();
rollback;
