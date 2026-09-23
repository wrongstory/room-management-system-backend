begin;
select no_plan();

create function pg_temp.hid(n integer) returns uuid language sql immutable as $$
  select ('e2040000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) select pg_temp.hid(n) from generate_series(101,103) n;
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.hid(1),pg_temp.hid(101),'이력 관리자','이력 관리자','history-admin','history-admin',0,'admin','active',false),
  (pg_temp.hid(2),pg_temp.hid(102),'이력 메이드 A','이력 메이드 a','history-maid-a','history-maid-a',0,'maid','active',false),
  (pg_temp.hid(3),pg_temp.hid(103),'이력 메이드 B','이력 메이드 b','history-maid-b','history-maid-b',0,'maid','active',false);
insert into auth.sessions(id,user_id) values
  (pg_temp.hid(201),pg_temp.hid(101)),(pg_temp.hid(202),pg_temp.hid(102)),
  (pg_temp.hid(203),pg_temp.hid(103));

create function pg_temp.make_history_attempt(
  n integer, p_room_id uuid, p_maid_id uuid, p_completed_at timestamptz
) returns uuid language plpgsql as $$
declare target_id uuid:=pg_temp.hid(1000+n); assignment_id uuid:=pg_temp.hid(2000+n); attempt_id uuid:=pg_temp.hid(3000+n);
  room_record record; type_record record;
begin
  select * into room_record from public.rooms where id=p_room_id;
  select * into type_record from public.room_types where id=room_record.room_type_id;
  insert into public.cleaning_targets(
    id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
    available_from,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by
  ) values(
    target_id,p_room_id,'additional','manual_room_request','history:'||n,
    (p_completed_at at time zone 'Asia/Seoul')::date,(p_completed_at at time zone 'Asia/Seoul')::date,
    p_completed_at-interval '1 hour','approved',1,
    jsonb_build_object('id',type_record.id,'code',type_record.code,'name',type_record.name,
      'roomNumber',room_record.room_number,'elevatorZone',room_record.elevator_zone),
    type_record.base_cleaning_fee,'{}'::jsonb,pg_temp.hid(1)
  );
  insert into public.cleaning_assignments(
    id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,changed_by
  ) values(assignment_id,target_id,p_maid_id,1,1,true,p_completed_at-interval '2 hours',pg_temp.hid(1));
  insert into public.cleaning_attempts(
    id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
    started_at,field_completed_at,ended_at,template_snapshot,room_snapshot
  ) values(
    attempt_id,target_id,assignment_id,p_maid_id,1,'field_completed',1,
    p_completed_at-interval '30 minutes',p_completed_at,p_completed_at,'{}'::jsonb,
    jsonb_build_object('id',type_record.id,'code',type_record.code,'name',type_record.name,
      'roomId',room_record.id,'roomNumber',room_record.room_number,'elevatorZone',room_record.elevator_zone)
  );
  return attempt_id;
end $$;

select pg_temp.make_history_attempt(1,(select id from public.rooms order by room_number limit 1),pg_temp.hid(2),'2026-09-13 00:00:00+09');
select pg_temp.make_history_attempt(2,(select id from public.rooms order by room_number offset 1 limit 1),pg_temp.hid(2),'2026-09-19 23:59:59+09');
select pg_temp.make_history_attempt(3,(select id from public.rooms order by room_number offset 2 limit 1),pg_temp.hid(3),'2026-09-19 12:00:00+09');
select pg_temp.make_history_attempt(4,(select id from public.rooms order by room_number offset 3 limit 1),pg_temp.hid(2),'2026-09-20 00:00:00+09');

-- Projection-only media fixtures. Replica mode avoids exercising upload/submission
-- commands here; their own suites cover those workflows. The first binding has a
-- retention-v2 row whose NULL expiry is meaningful while the second represents a
-- legacy binding with no retention row and therefore uses purge_after.
set local session_replication_role = replica;
insert into public.cleaning_submissions(
  id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,
  issue_snapshot,candle_count,submitted_by,submitted_at
) values
  (pg_temp.hid(4001),pg_temp.hid(3001),pg_temp.hid(4101),1,'submitted','{}','[]',0,pg_temp.hid(2),'2026-09-13 00:05:00+09'),
  (pg_temp.hid(4002),pg_temp.hid(3002),pg_temp.hid(4102),1,'submitted','{}','[]',0,pg_temp.hid(2),'2026-09-20 00:04:59+09');
insert into private.attempt_photo_versions(
  id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,
  validation_status,sha256,mime_type,size_bytes,uploaded_at,purge_after
) values
  (pg_temp.hid(5201),pg_temp.hid(3001),pg_temp.hid(1001),pg_temp.hid(5101),1,
    'verified',repeat('a',64),'image/jpeg',100,'2026-09-13 00:03:00+09','2026-09-20 00:03:00+09'),
  (pg_temp.hid(5202),pg_temp.hid(3002),pg_temp.hid(1002),pg_temp.hid(5102),1,
    'verified',repeat('b',64),'image/jpeg',100,'2026-09-20 00:02:00+09','2026-09-27 00:02:00+09');
insert into private.submission_photo_bindings(
  submission_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version_id,photo_version
) values
  (pg_temp.hid(4001),pg_temp.hid(3001),pg_temp.hid(1001),pg_temp.hid(5101),pg_temp.hid(5201),1),
  (pg_temp.hid(4002),pg_temp.hid(3002),pg_temp.hid(1002),pg_temp.hid(5102),pg_temp.hid(5202),1);
insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at) values
  (pg_temp.hid(4001),pg_temp.hid(3001),1,'2026-09-13 00:05:00+09'),
  (pg_temp.hid(4002),pg_temp.hid(3002),1,'2026-09-20 00:04:59+09');
insert into private.submission_current_pointers(cleaning_attempt_id,submission_id,revision) values
  (pg_temp.hid(3001),pg_temp.hid(4001),1),(pg_temp.hid(3002),pg_temp.hid(4002),1);
insert into private.photo_upload_operations(
  id,actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,
  cleaning_target_id,assignment_id,assignment_revision,target_photo_slot_id,
  expected_photo_revision,sha256,mime_type,size_bytes
) values(
  pg_temp.hid(5301),pg_temp.hid(2),repeat('c',64),repeat('d',64),pg_temp.hid(3001),
  pg_temp.hid(1001),pg_temp.hid(2001),1,pg_temp.hid(5101),0,repeat('a',64),'image/jpeg',100
);
insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after) values(
  pg_temp.hid(5401),pg_temp.hid(5301),'history-object-001','2026-09-13 00:03:00+09','2026-09-20 00:03:00+09'
);
insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id,accepted_at) values(
  pg_temp.hid(5301),pg_temp.hid(5401),pg_temp.hid(5201),'2026-09-13 00:04:00+09'
);
insert into private.photo_retention_records(
  object_id,operation_id,photo_version_id,performer_maid_profile_id,effective_policy_kind,
  retention_starts_at,expires_at,purged_at,media_availability
) values(
  pg_temp.hid(5401),pg_temp.hid(5301),pg_temp.hid(5201),pg_temp.hid(2),'cleaning_submission',
  null,null,null,'available'
);
set local session_replication_role = origin;

select is(
  jsonb_array_length(public.list_cleaning_history(pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',null,null,100,null,null)->'items'),
  3,
  'admin sees exactly KST D-6 through D and excludes the next KST day'
);
select is(
  jsonb_array_length(public.list_cleaning_history(pg_temp.hid(2),pg_temp.hid(202),'2026-09-19',null,null,100,null,null)->'items'),
  2,
  'maid sees only own actually completed attempts'
);
select throws_ok(
  $$select public.list_cleaning_history(pg_temp.hid(2),pg_temp.hid(202),'2026-09-19',pg_temp.hid(3),null,100,null,null)$$,
  '42501','CLEANING_HISTORY_MAID_SCOPE_REQUIRED','maid cannot filter another maid'
);
select is(
  (public.list_cleaning_history(pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',pg_temp.hid(3),null,100,null,null)#>>'{items,0,performerDisplayName}'),
  '이력 메이드 B',
  'admin maid filter returns the safe current performer label'
);
select is(
  (public.list_cleaning_history(pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',pg_temp.hid(3),null,100,null,null)#>>'{items,0,roomTypeCode}'),
  (select room_snapshot ->> 'code' from public.cleaning_attempts where id=pg_temp.hid(3003)),
  'legacy top-level attempt snapshot keeps its room type label'
);
select is(
  jsonb_array_length(public.list_cleaning_history(
    pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',null,
    (select room_snapshot ->> 'roomNumber' from public.cleaning_attempts where id=pg_temp.hid(3003)),
    100,null,null
  )->'items'),
  1,
  'admin query searches the immutable room snapshot'
);
select is(
  (select item ->> 'expiresAt'
   from jsonb_array_elements(public.list_cleaning_history(
     pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',null,null,100,null,null
   )->'items') item
   where item ->> 'attemptId' = pg_temp.hid(3001)::text),
  null::text,
  'retention-v2 row preserves meaningful NULL expiry instead of using legacy purge_after'
);
select is(
  (select (item ->> 'expiresAt')::timestamptz
   from jsonb_array_elements(public.list_cleaning_history(
     pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',null,null,100,null,null
   )->'items') item
   where item ->> 'attemptId' = pg_temp.hid(3002)::text),
  '2026-09-27 00:02:00+09'::timestamptz,
  'legacy binding without a retention row falls back to immutable purge_after'
);
select ok(
  (public.list_cleaning_history(pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',null,null,1,null,null)->>'nextCursor') is not null,
  'bounded first page returns a stable continuation position'
);
select is(
  (public.list_cleaning_history(pg_temp.hid(1),pg_temp.hid(201),'2026-09-19',null,null,1,
    '2026-09-19 12:00:00+09',pg_temp.hid(3003))#>>'{items,0,attemptId}')::uuid,
  pg_temp.hid(3001),
  'timestamp plus stable attempt id cursor has no duplicate'
);
select ok(
  has_function_privilege('service_role','public.list_cleaning_history(uuid,uuid,date,uuid,text,integer,timestamptz,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','public.list_cleaning_history(uuid,uuid,date,uuid,text,integer,timestamptz,uuid)','EXECUTE'),
  'only service role executes the app-owned history projection'
);

select * from finish();
rollback;
