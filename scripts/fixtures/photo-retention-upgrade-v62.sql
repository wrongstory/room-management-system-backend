insert into auth.users(id) values
  ('f0090000-0000-4000-8000-000000000101'),
  ('f0090000-0000-4000-8000-000000000102');
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  ('f0090000-0000-4000-8000-000000000001','f0090000-0000-4000-8000-000000000101','retention admin','retention admin','retention-admin','retention-admin',0,'admin','active',false),
  ('f0090000-0000-4000-8000-000000000002','f0090000-0000-4000-8000-000000000102','retention maid','retention maid','retention-maid','retention-maid',0,'maid','active',false);

insert into public.cleaning_template_versions(
  id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by
)
select 'f0090000-0000-4000-8000-000000000200',id,'additional',7,'published',30,
  (select jsonb_agg(jsonb_build_object(
    'slotKey','retention-'||n,'required',n<=4,'displayOrder',n-1,'label','보존 '||n
  ) order by n) from generate_series(1,10)n),
  'f0090000-0000-4000-8000-000000000001'
from public.room_types where code='standard';

insert into public.cleaning_targets(
  id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by
)
select 'f0090000-0000-4000-8000-000000000300',room.id,'additional','manual_room_request',
  'retention-upgrade',current_date,current_date,'notified',1,jsonb_build_object('code','standard'),
  10000,jsonb_build_object(
    'id','f0090000-0000-4000-8000-000000000200','version',7,
    'durationMinutes',30,'photoSlots',(select photo_slots from public.cleaning_template_versions where id='f0090000-0000-4000-8000-000000000200')
  ),'f0090000-0000-4000-8000-000000000001'
from public.rooms room
where room.room_type_id=(select id from public.room_types where code='standard')
order by room.room_number limit 1;
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by
) values (
  'f0090000-0000-4000-8000-000000000400','f0090000-0000-4000-8000-000000000300',
  'f0090000-0000-4000-8000-000000000002',1,1,clock_timestamp()-interval '11 days',
  'f0090000-0000-4000-8000-000000000001'
);
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
  template_snapshot,room_snapshot,started_at,field_completed_at,ended_at
)
select 'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000300',
  'f0090000-0000-4000-8000-000000000400','f0090000-0000-4000-8000-000000000002',
  1,'field_completed',1,target.template_snapshot,jsonb_build_object('roomId',target.room_id),
  clock_timestamp()-interval '11 days',clock_timestamp()-interval '10 days',clock_timestamp()-interval '10 days'
from public.cleaning_targets target where id='f0090000-0000-4000-8000-000000000300';

set session_replication_role=replica;
do $$
declare n integer; slot_id uuid; uploaded timestamptz:=clock_timestamp()-interval '10 days';
begin
  for n in 1..4 loop
    select id into slot_id from private.target_photo_slot_snapshots
    where cleaning_target_id='f0090000-0000-4000-8000-000000000300'
      and slot_key='retention-'||n;
    insert into private.photo_upload_operations(
      id,actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,cleaning_target_id,
      assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,sha256,mime_type,size_bytes,created_at
    ) values (
      ('f0090000-0000-4000-8000-'||lpad((600+n)::text,12,'0'))::uuid,
      'f0090000-0000-4000-8000-000000000002',lpad((600+n)::text,64,'0'),repeat('a',64),
      'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000300',
      'f0090000-0000-4000-8000-000000000400',1,slot_id,0,repeat('b',64),'image/jpeg',100,uploaded
    );
    insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
    values(
      ('f0090000-0000-4000-8000-'||lpad((700+n)::text,12,'0'))::uuid,
      ('f0090000-0000-4000-8000-'||lpad((600+n)::text,12,'0'))::uuid,
      'synthetic_retention_'||n,uploaded,uploaded+interval '168 hours'
    );
    insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,status)
    values(
      ('f0090000-0000-4000-8000-'||lpad((600+n)::text,12,'0'))::uuid,
      'f0090000-0000-4000-8000-000000000500',slot_id,
      'f0090000-0000-4000-8000-000000000002','accepted'
    );
    insert into private.attempt_photo_versions(
      id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,validation_status,
      sha256,mime_type,size_bytes,uploaded_at,purge_after
    ) values(
      ('f0090000-0000-4000-8000-'||lpad((800+n)::text,12,'0'))::uuid,
      'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000300',
      slot_id,1,'verified',repeat('b',64),'image/jpeg',100,uploaded,uploaded+interval '168 hours'
    );
    insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id)
    values(
      ('f0090000-0000-4000-8000-'||lpad((600+n)::text,12,'0'))::uuid,
      ('f0090000-0000-4000-8000-'||lpad((700+n)::text,12,'0'))::uuid,
      ('f0090000-0000-4000-8000-'||lpad((800+n)::text,12,'0'))::uuid
    );
    if n in (1,4) then
      insert into private.attempt_photo_current(
        cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,revision,photo_version_id,photo_version
      ) values(
        'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000300',
        slot_id,1,('f0090000-0000-4000-8000-'||lpad((800+n)::text,12,'0'))::uuid,1
      );
    end if;
    insert into private.photo_purge_jobs(
      object_id,operation_id,photo_version_id,purge_after,status,lease_version,claim_digest,
      lease_expires_at,next_attempt_at,last_reason_code,purged_at,outcome,revision
    ) values(
      ('f0090000-0000-4000-8000-'||lpad((700+n)::text,12,'0'))::uuid,
      ('f0090000-0000-4000-8000-'||lpad((600+n)::text,12,'0'))::uuid,
      ('f0090000-0000-4000-8000-'||lpad((800+n)::text,12,'0'))::uuid,
      uploaded+interval '168 hours',
      case n when 1 then 'claimed' when 3 then 'blocked' when 4 then 'purged' else 'pending' end,
      case n when 1 then 2 when 3 then 8 else 0 end,
      case when n in (1,3) then repeat(n::text,64) end,
      case when n in (1,3) then clock_timestamp()+interval '10 minutes' end,
      uploaded+interval '168 hours',
      case when n=3 then 'RETRY_EXHAUSTED' end,
      case when n=4 then uploaded+interval '8 days' end,
      case when n=4 then 'deleted' end,1
    );
  end loop;
end $$;

insert into public.cleaning_submissions(
  id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by,submitted_at,superseded_at
) values(
  'f0090000-0000-4000-8000-000000000900','f0090000-0000-4000-8000-000000000500',
  'f0090000-0000-4000-8000-000000000901',1,'approved','{}',
  'f0090000-0000-4000-8000-000000000002',clock_timestamp()-interval '9 days',
  clock_timestamp()-interval '7 days'
);
insert into private.submission_photo_bindings(
  submission_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version_id,photo_version
)
select 'f0090000-0000-4000-8000-000000000900','f0090000-0000-4000-8000-000000000500',
  'f0090000-0000-4000-8000-000000000300',target_photo_slot_id,
  'f0090000-0000-4000-8000-000000000802',1
from private.attempt_photo_versions where id='f0090000-0000-4000-8000-000000000802';
insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at)
values('f0090000-0000-4000-8000-000000000900','f0090000-0000-4000-8000-000000000500',1,clock_timestamp()-interval '9 days');
insert into public.inspection_decisions(id,submission_id,decision,reason_code,decided_by,decided_at)
values(
  'f0090000-0000-4000-8000-000000000902','f0090000-0000-4000-8000-000000000900',
  'approved','QUALITY_OK','f0090000-0000-4000-8000-000000000001',clock_timestamp()-interval '8 days'
);
-- A newer reclean submission is current while the approved prior submission
-- remains immutable historical evidence with its own decidedAt retention.
insert into public.cleaning_submissions(
  id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by,submitted_at
) values(
  'f0090000-0000-4000-8000-000000000910','f0090000-0000-4000-8000-000000000500',
  'f0090000-0000-4000-8000-000000000911',2,'submitted','{}',
  'f0090000-0000-4000-8000-000000000002',clock_timestamp()-interval '6 days'
);
insert into private.submission_photo_bindings(
  submission_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,photo_version_id,photo_version
)
select 'f0090000-0000-4000-8000-000000000910','f0090000-0000-4000-8000-000000000500',
  'f0090000-0000-4000-8000-000000000300',target_photo_slot_id,
  'f0090000-0000-4000-8000-000000000801',1
from private.attempt_photo_versions where id='f0090000-0000-4000-8000-000000000801';
insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at)
values('f0090000-0000-4000-8000-000000000910','f0090000-0000-4000-8000-000000000500',1,clock_timestamp()-interval '6 days');
insert into private.submission_current_pointers(cleaning_attempt_id,submission_id,revision)
values('f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000910',2);
insert into private.attempt_photo_purge_states(photo_version_id,purged_at)
values('f0090000-0000-4000-8000-000000000804',clock_timestamp()-interval '2 days');
insert into public.audit_events(
  event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,effective_at,after_state,idempotency_key
) values(
  'photo.upload_accepted','photo_version','f0090000-0000-4000-8000-000000000802',
  'f0090000-0000-4000-8000-000000000002','retention maid',clock_timestamp()-interval '10 days',
  jsonb_build_object('photoId','f0090000-0000-4000-8000-000000000802'),
  'photo-retention-upgrade-audit'
);
insert into private.command_executions(
  actor_profile_id,command_type,idempotency_key,request_hash,entity_id,response_payload,completed_at
) values(
  'f0090000-0000-4000-8000-000000000002','photo.upload','photo-retention-upgrade',repeat('c',64),
  'f0090000-0000-4000-8000-000000000802',jsonb_build_object('photoId','f0090000-0000-4000-8000-000000000802'),
  clock_timestamp()-interval '10 days'
);
set session_replication_role=origin;
