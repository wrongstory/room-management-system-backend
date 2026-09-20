begin;
select no_plan();

select has_table('private','photo_retention_records','authoritative photo retention ledger exists');
select has_table('private','photo_retention_links','typed domain retention links exist');

select ok(not has_table_privilege(role_name,'private.photo_retention_records','SELECT'),
  role_name||' cannot read raw retention ledger')
from unnest(array['anon','authenticated','service_role']) role_name;
select ok(not has_table_privilege(role_name,'private.photo_retention_links','SELECT'),
  role_name||' cannot read raw domain link ledger')
from unnest(array['anon','authenticated','service_role']) role_name;

with helper(signature) as (values
  ('private.attach_photo_retention_link(uuid,text,text,uuid,uuid)'),
  ('private.assert_photo_retention_link(text,text,uuid,uuid)'),
  ('private.refresh_photo_retention_record(uuid)'),
  ('private.photo_retention_metadata(uuid)'),
  ('private.photo_media_usable(uuid,timestamptz)')
)
select ok(not has_function_privilege(role_name,signature,'EXECUTE'),
  role_name||' cannot call private retention primitive '||signature)
from helper cross join unnest(array['anon','authenticated','service_role']) role_name;

select throws_ok(
  $$select private.assert_photo_retention_link('unknown','unknown','00000000-0000-4000-8000-000000000001',null)$$,
  '23514','PHOTO_RETENTION_KIND_UNSUPPORTED','unsupported domain kind fails closed'
);
select throws_ok(
  $$select private.assert_photo_retention_link('complaint','complaint_case','00000000-0000-4000-8000-000000000001',null)$$,
  '23514','PHOTO_RETENTION_ENTITY_INVALID','unknown typed entity fails closed'
);

set local session_replication_role = replica;
insert into public.room_issues(
  id,room_id,category,severity,status,reported_by,resolved_by,resolved_at,resolution_reason_code
) values (
  'f0080000-0000-4000-8000-000000000001','f0080000-0000-4000-8000-000000000002',
  'retention-test','warning','resolved','f0080000-0000-4000-8000-000000000003',
  'f0080000-0000-4000-8000-000000000004','2036-01-02T03:04:05Z','ISSUE_RESOLVED'
);
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
  template_snapshot,room_snapshot
) values
  ('f0080000-0000-4000-8000-000000000010','f0080000-0000-4000-8000-000000000011',
   'f0080000-0000-4000-8000-000000000012','f0080000-0000-4000-8000-000000000013',1,
   'interrupted',1,'{}','{}'),
  ('f0080000-0000-4000-8000-000000000014','f0080000-0000-4000-8000-000000000015',
   'f0080000-0000-4000-8000-000000000016','f0080000-0000-4000-8000-000000000017',1,
   'scheduled',1,'{}','{}');
insert into private.attempt_handover_events(
  previous_attempt_id,next_attempt_id,actor_profile_id,reason_code,occurred_at
) values (
  'f0080000-0000-4000-8000-000000000010','f0080000-0000-4000-8000-000000000014',
  'f0080000-0000-4000-8000-000000000004','ADMIN_HANDOVER','2036-02-03T04:05:06Z'
);
insert into private.offline_completion_events(
  id,lease_id,actor_profile_id,event_id,request_hash,occurred_at,server_offset_ms,
  normalized_occurred_at,received_at,metadata_expires_at,outcome,reason_code,response_payload
) values
  ('f0080000-0000-4000-8000-000000000020','f0080000-0000-4000-8000-000000000021',
   'f0080000-0000-4000-8000-000000000013','f0080000-0000-4000-8000-000000000022',repeat('a',64),
   '1999-01-01T00:00:00Z',0,'1999-01-01T00:00:00Z','2036-03-04T05:05:00Z','2037-03-04T05:05:00Z',
   'quarantined','CLOCK_CONFLICT','{}'),
  ('f0080000-0000-4000-8000-000000000023','f0080000-0000-4000-8000-000000000024',
   'f0080000-0000-4000-8000-000000000013','f0080000-0000-4000-8000-000000000025',repeat('b',64),
   '1999-01-01T00:00:00Z',0,'1999-01-01T00:00:00Z','2036-03-04T05:05:00Z','2037-03-04T05:05:00Z',
   'quarantined','CLOCK_CONFLICT','{}');
insert into private.offline_event_resolutions(
  id,event_record_id,actor_profile_id,resolution,idempotency_key,request_hash,response_payload,metadata_expires_at
) values
  ('f0080000-0000-4000-8000-000000000026','f0080000-0000-4000-8000-000000000020',
   'f0080000-0000-4000-8000-000000000004','record_only','retention-valid',repeat('c',64),
   jsonb_build_object('effectiveAt','2036-03-04T05:06:07Z','rawClientOccurredAt','1999-01-01T00:00:00Z'),
   '2037-03-04T05:05:00Z'),
  ('f0080000-0000-4000-8000-000000000027','f0080000-0000-4000-8000-000000000023',
   'f0080000-0000-4000-8000-000000000004','record_only','retention-invalid',repeat('d',64),
   jsonb_build_object('effectiveAt','raw-client-clock'),
   '2037-03-04T05:05:00Z');
insert into public.complaint_cases(
  id,room_id,cleaning_target_id,cleaning_attempt_id,submission_id,inspection_decision_id,
  original_earning_id,maid_profile_id,category,status,version,current_decision_id,first_decided_at,
  response_deadline,received_by,received_at,updated_at
) values (
  'f0080000-0000-4000-8000-000000000030','f0080000-0000-4000-8000-000000000031',
  'f0080000-0000-4000-8000-000000000032','f0080000-0000-4000-8000-000000000010',
  'f0080000-0000-4000-8000-000000000033','f0080000-0000-4000-8000-000000000034',
  'f0080000-0000-4000-8000-000000000035','f0080000-0000-4000-8000-000000000013',
  'cleanliness_general','closed',2,'f0080000-0000-4000-8000-000000000036',
  '2036-04-01T00:00:00Z','2036-04-08T00:00:00Z','f0080000-0000-4000-8000-000000000004',
  '2036-03-31T00:00:00Z','2036-08-01T00:00:00Z'
);
insert into public.complaint_case_events(
  complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,occurred_at
) values (
  'f0080000-0000-4000-8000-000000000030','closed','acknowledged','closed',2,
  'f0080000-0000-4000-8000-000000000004','2036-04-02T06:07:08Z'
);
set local session_replication_role = origin;

select is(
  (select retention_starts_at from private.assert_photo_retention_link(
    'room_issue','room_issue','f0080000-0000-4000-8000-000000000001',null)),
  '2036-01-02T03:04:05Z'::timestamptz,
  'resolved room issue uses the authoritative resolved_at anchor (schema-ready; no photo attach API yet)'
);
select is(
  (select expires_at from private.assert_photo_retention_link(
    'room_issue','room_issue','f0080000-0000-4000-8000-000000000001',null)),
  '2036-01-02T03:04:05Z'::timestamptz + interval '180 days',
  'resolved room issue expires exactly 180 days after authoritative resolved_at'
);
select is(
  (select expires_at from private.assert_photo_retention_link(
    'interruption','attempt_handover','f0080000-0000-4000-8000-000000000010',
    'f0080000-0000-4000-8000-000000000013')),
  '2036-08-01T04:05:06Z'::timestamptz,
  'admin interruption handover expires exactly 180 days after immutable occurred_at'
);
select is(
  (select retention_starts_at from private.assert_photo_retention_link(
    'sync_conflict','offline_event','f0080000-0000-4000-8000-000000000020',null)),
  '2036-03-04T05:06:07Z'::timestamptz,
  'offline conflict uses the server-owned resolution effectiveAt instead of raw client time'
);
select is(
  (select expires_at from private.assert_photo_retention_link(
    'sync_conflict','offline_event','f0080000-0000-4000-8000-000000000020',null)),
  '2036-03-04T05:06:07Z'::timestamptz + interval '180 days',
  'resolved sync conflict expires exactly 180 days after server-owned resolution time'
);
select is(
  (select retention_starts_at from private.assert_photo_retention_link(
    'complaint','complaint_case','f0080000-0000-4000-8000-000000000030',null)),
  '2036-04-02T06:07:08Z'::timestamptz,
  'complaint retention uses immutable closed event rather than mutable updated_at'
);
select is(
  (select expires_at from private.assert_photo_retention_link(
    'complaint','complaint_case','f0080000-0000-4000-8000-000000000030',null)),
  '2036-04-02T06:07:08Z'::timestamptz + interval '180 days',
  'closed complaint expires exactly 180 days after immutable closed event'
);
select throws_ok(
  $$select private.assert_photo_retention_link('sync_conflict','offline_event','f0080000-0000-4000-8000-000000000023',null)$$,
  '23514','PHOTO_RETENTION_ENTITY_INVALID','malformed raw resolution anchor fails closed'
);

set local session_replication_role = replica;
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values(
  'f0080000-0000-4000-8000-000000000013','f0080000-0000-4000-8000-000000000043',
  'retention fixture maid','retention fixture maid','retention-fixture-maid',
  'retention-fixture-maid',0,'maid','active',false
);
insert into private.photo_upload_operations(
  id,actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,cleaning_target_id,
  assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,sha256,mime_type,
  size_bytes,created_at
) values(
  'f0080000-0000-4000-8000-000000000041','f0080000-0000-4000-8000-000000000013',
  repeat('4',64),repeat('5',64),'f0080000-0000-4000-8000-000000000010',
  'f0080000-0000-4000-8000-000000000011','f0080000-0000-4000-8000-000000000012',1,
  'f0080000-0000-4000-8000-000000000042',0,repeat('6',64),'image/jpeg',100,
  '2035-12-01T00:00:00Z'
);
insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
values(
  'f0080000-0000-4000-8000-000000000040','f0080000-0000-4000-8000-000000000041',
  'retention_multi_link_fixture','2035-12-01T00:00:00Z','2035-12-08T00:00:00Z'
);
insert into private.photo_retention_records(
  object_id,operation_id,effective_policy_kind,retention_starts_at,expires_at,media_availability
) values(
  'f0080000-0000-4000-8000-000000000040','f0080000-0000-4000-8000-000000000041',
  'orphan','2035-12-01T00:00:00Z','2035-12-31T00:00:00Z','available'
);
set local session_replication_role = origin;

select private.attach_photo_retention_link(
  'f0080000-0000-4000-8000-000000000040','room_issue','room_issue',
  'f0080000-0000-4000-8000-000000000001',null
);
select private.attach_photo_retention_link(
  'f0080000-0000-4000-8000-000000000040','complaint','complaint_case',
  'f0080000-0000-4000-8000-000000000030',null
);
select is(
  (select expires_at from private.photo_retention_records
    where object_id='f0080000-0000-4000-8000-000000000040'),
  '2036-04-02T06:07:08Z'::timestamptz + interval '180 days',
  'multiple active links retain media until the maximum authoritative expiry'
);

select private.attach_photo_retention_link(
  'f0080000-0000-4000-8000-000000000040','cleaning_submission','cleaning_attempt',
  'f0080000-0000-4000-8000-000000000010','f0080000-0000-4000-8000-000000000013'
);
select ok(
  (select effective_policy_kind='mixed' and retention_starts_at is null and expires_at is null
   from private.photo_retention_records
   where object_id='f0080000-0000-4000-8000-000000000040'),
  'one pending active link takes precedence over all finite anchors and protects provider bytes'
);

select is(
  (select count(*) from information_schema.columns
    where table_schema='private' and table_name='attempt_photo_versions' and column_name='purge_after'),
  1::bigint,'legacy purge clock remains as immutable compatibility history'
);
select is(
  (select count(*) from private.photo_retention_records where media_availability='purged' and purged_at is null),
  0::bigint,'purged media can never lose its terminal timestamp'
);
select is(
  (select count(*) from private.photo_retention_records
    where effective_policy_kind='cleaning_submission' and expires_at is not null and retention_starts_at is null),
  0::bigint,'anchored cleaning retention always has its immutable start timestamp'
);

set local role authenticated;
select throws_ok($$select * from private.photo_retention_records$$,'42501',null,
  'Data API cannot enumerate photo retention metadata');
select throws_ok($$select private.attach_photo_retention_link(null,null,null,null,null)$$,'42501',null,
  'authenticated caller cannot attach an arbitrary retention entity');
reset role;

set local role service_role;
select throws_ok($$select * from private.photo_retention_links$$,'42501',null,
  'service role cannot bypass app-owned retention projection');
select throws_ok($$select private.attach_photo_retention_link(null,null,null,null,null)$$,'42501',null,
  'service role cannot invoke generic retention attachment');
reset role;

select * from finish();
rollback;
