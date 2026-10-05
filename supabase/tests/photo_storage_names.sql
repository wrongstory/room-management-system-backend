begin;
select no_plan();
-- BEGIN NAMED PHOTO SHARED FIXTURE
-- Synthetic rollback-only fixture. No Google calls, real media or credentials.
create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('38300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,4)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),
  'names developer','names developer','0383','names-bootstrap-hash','names-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'names-'||n,'names-'||n,'names-'||n,'names-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,3)n;
insert into auth.sessions(id,user_id) select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,4)n;

create function pg_temp.legacy_slots(p_key text default 'extra-proof') returns jsonb language sql immutable as $$
  select jsonb_build_array(jsonb_build_object('slotKey',p_key,'required',true,
    'displayOrder',0,'label','합성 과거 슬롯'))
$$;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(200),id,'additional',9,'published',1,private.flat_cleaning_photo_slots(),pg_temp.pid(1)
from public.room_types where code='standard';
-- Historical targets still bind real, chosen immutable catalog versions.
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(201),id,'additional',6,'retired',1,pg_temp.legacy_slots(),pg_temp.pid(1)
from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(202),id,'additional',5,'retired',1,pg_temp.legacy_slots('cleaning-proof'),pg_temp.pid(1)
from public.room_types where code='standard';
create function pg_temp.fixture(n integer,p_legacy boolean default false,p_legacy_key text default 'extra-proof') returns void language plpgsql as $$
declare room_row public.rooms; snapshot jsonb;
begin
  select * into room_row from public.rooms
    where room_type_id=(select id from public.room_types where code='standard')
    order by room_number offset n limit 1;
  snapshot:=case when p_legacy then jsonb_build_object(
      'id',pg_temp.pid(case when p_legacy_key='cleaning-proof' then 202 else 201 end),
      'version',case when p_legacy_key='cleaning-proof' then 5 else 6 end,
      'photoSlots',pg_temp.legacy_slots(p_legacy_key),'durationMinutes',1)
    else jsonb_build_object('id',pg_temp.pid(200),'version',9,
      'photoSlots',private.flat_cleaning_photo_slots(),'durationMinutes',1) end;
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by)
  values(pg_temp.pid(300+n),room_row.id,'additional','manual_room_request','names-target-'||n,
    (clock_timestamp() at time zone 'Asia/Seoul')::date,(clock_timestamp() at time zone 'Asia/Seoul')::date,
    'notified',2,jsonb_build_object('code','standard'),10000,snapshot,pg_temp.pid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
  values(pg_temp.pid(400+n),pg_temp.pid(300+n),pg_temp.pid(2),n,2,clock_timestamp()-interval '2 hours',pg_temp.pid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
  values(pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(2),1,'field_completed',2,
    snapshot,jsonb_build_object('roomId',room_row.id),clock_timestamp()-interval '2 hours',
    clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour');
end;
$$;
select pg_temp.fixture(n) from generate_series(1,4)n;
select pg_temp.fixture(5,true);
select pg_temp.fixture(6);
select pg_temp.fixture(7,true,'cleaning-proof');
create temp table flow(n integer primary key,operation jsonb,context jsonb,named jsonb);
create function pg_temp.prepare(n integer,p_slot_key text,p_mime text default 'image/jpeg')
returns void language plpgsql as $$
declare slot_id uuid; admission jsonb; operation_row jsonb; context_row jsonb; folder_row jsonb;
begin
  select id into slot_id from private.target_photo_slot_snapshots
    where cleaning_target_id=pg_temp.pid(300+n) and slot_key=p_slot_key;
  if n in (5,7) then
    admission:=public.admit_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(500+n),
      pg_temp.pid(400+n),2,slot_id,0,lpad(n::text,64,'0'));
    operation_row:=public.begin_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),
      (admission->>'admissionId')::uuid,repeat('a',64),p_mime,100,lpad(n::text,64,'0'),repeat('b',64));
  else
    admission:=public.admit_photo_collection_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(500+n),
      pg_temp.pid(400+n),2,slot_id,pg_temp.pid(600+n),0,0,lpad(n::text,64,'0'));
    operation_row:=public.begin_admitted_photo_collection_upload(pg_temp.pid(2),pg_temp.pid(902),
      (admission->>'admissionId')::uuid,repeat('a',64),p_mime,100,lpad(n::text,64,'0'),repeat('b',64));
  end if;
  perform public.claim_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),
    (operation_row->>'operationId')::uuid,repeat('c',64));
  context_row:=public.get_photo_provider_context(pg_temp.pid(2),pg_temp.pid(902),
    (operation_row->>'operationId')::uuid,1,repeat('c',64));
  perform public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),
    (operation_row->>'operationId')::uuid,1,repeat('c',64),'date','synthetic_root_383','synthetic_date_383_'||n);
  folder_row:=public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),
    (operation_row->>'operationId')::uuid,1,repeat('c',64),'room','synthetic_root_383','synthetic_room_383_'||n);
  insert into flow values(n,operation_row,context_row || jsonb_build_object('reservedFolderId',folder_row->>'folderId'),null);
end;
$$;
create function pg_temp.reserve(n integer,p_old boolean default false) returns jsonb language plpgsql as $$
declare context_row jsonb; operation_id uuid;
begin
  select context into context_row from flow where flow.n=$1;
  operation_id:=(context_row->>'operationId')::uuid;
  if p_old then
    return public.reserve_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),operation_id,
      1,repeat('c',64),'synthetic_file_383_'||n,context_row->>'reservedFolderId');
  end if;
  return public.reserve_named_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),operation_id,
    1,repeat('c',64),'synthetic_file_383_'||n,context_row->>'reservedFolderId');
end;
$$;
-- END NAMED PHOTO SHARED FIXTURE

select is(private.photo_storage_file_name('2030-01-02','cleaning-proof','350',1,'image/jpeg'),
  '2030-01-02_일반방_350_01.jpg','minimum two digits and normalized JPEG extension');
select is(private.photo_storage_file_name('2030-01-02','bomb-proof','350',99,'image/webp'),
  '2030-01-02_폭탄방_350_99.webp','bomb-proof classification and WebP extension');
select is(private.photo_storage_file_name('2030-01-02','issue-proof','350',100,'image/jpeg'),
  '2030-01-02_특이사항_350_100.jpg','100 is not truncated or reused as 10');
select is(private.photo_storage_file_name('2030-01-02','cleaning-proof','350',9223372036854775807,'image/jpeg'),
  '2030-01-02_일반방_350_9223372036854775807.jpg','bigint number is not a JS numeric identity');
select throws_ok($$select private.photo_storage_file_name('2030-01-02','extra-proof','350',1,'image/jpeg')$$,
  '23514','PHOTO_STORAGE_NAME_INVALID','never infer an ambiguous historical extra-proof category');
select throws_ok($$select private.photo_storage_file_name('2030-01-02','cleaning-proof','350/../../',1,'image/jpeg')$$,
  '23514','PHOTO_STORAGE_NAME_INVALID','room snapshot cannot become a path');
select throws_ok($$select private.photo_storage_file_name('2030-01-02','cleaning-proof','350',0,'image/jpeg')$$,
  '23514','PHOTO_STORAGE_NAME_INVALID','zero naming number is invalid');
select throws_ok($$select private.photo_storage_file_name('2030-01-02','cleaning-proof','350',1,'image/heic')$$,
  '23514','PHOTO_STORAGE_NAME_INVALID','original MIME is not a stored-file extension');
select throws_ok($$select private.photo_storage_file_name('infinity','cleaning-proof','350',1,'image/jpeg')$$,
  '23514','PHOTO_STORAGE_NAME_INVALID','nonfinite date is invalid');

select public.refresh_photo_storage_quota(clock_timestamp(),1000);
select pg_temp.prepare(1,'cleaning-proof');
select pg_temp.prepare(2,'bomb-proof','image/webp');
select pg_temp.prepare(3,'issue-proof');
select pg_temp.prepare(4,'cleaning-proof');
select pg_temp.prepare(5,'extra-proof');
select pg_temp.prepare(6,'cleaning-proof');
select pg_temp.prepare(7,'cleaning-proof');
select is((select count(*) from private.photo_storage_names),0::bigint,'no automatic filename backfill');
select ok(context ? 'fileName' and context->'fileName'='null'::jsonb,
  'context has a nullable filename before identity reservation') from flow;
update flow set named=pg_temp.reserve(n) where n between 1 and 3;
select is((select count(*) from private.photo_storage_names),3::bigint,'one immutable binding per new canonical identity');
select is(named->>'fileName',private.photo_storage_file_name((named->>'uploadDate')::date,named->>'slotKey',
  named->>'roomNumber',(select naming_number from private.photo_storage_names where operation_id=(named->>'operationId')::uuid),named->>'mimeType'),
  'server filename derives from frozen date/room/slot and normalized MIME '||n) from flow where n between 1 and 3;
select is(pg_temp.reserve(n)->>'fileName',named->>'fileName','same candidate retries the exact frozen filename '||n)
  from flow where n between 1 and 3;
select is((select count(distinct naming_number) from private.photo_storage_names),3::bigint,'global naming numbers are unique');
select is((select count(distinct file_name) from private.photo_storage_names),3::bigint,'actual names remain globally distinct');
select ok(not (select seqcycle from pg_sequence where seqrelid='private.photo_storage_name_number'::regclass),
  'global sequence never cycles');
select throws_ok($$select public.reserve_named_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),
  (select (context->>'operationId')::uuid from flow where n=1),1,repeat('c',64),
  'synthetic_changed_383',(select context->>'reservedFolderId' from flow where n=1))$$,
  '23505','PHOTO_PROVIDER_IDENTITY_CONFLICT','named retry still rejects a different candidate ID');
select is((pg_temp.reserve(4,true))->'fileName','null'::jsonb,'old API reserves UUID-compatible identity without a name');
update flow set named=pg_temp.reserve(4) where n=4;
select is((select named->'fileName' from flow where n=4),'null'::jsonb,'new API does not rename an existing UUID identity');
update flow set named=pg_temp.reserve(5) where n=5;
select is((select named->'fileName' from flow where n=5),'null'::jsonb,'historical extra-proof remains unclassified and UUID-compatible');
update flow set named=pg_temp.reserve(7) where n=7;
select is((select named->'fileName' from flow where n=7),'null'::jsonb,'historical same-key cleaning-proof is not mistaken for a canonical v9 contract');
select is((select count(*) from private.photo_storage_names),3::bigint,'legacy paths never allocate filename bindings');

select throws_ok($$select public.reserve_named_photo_provider_identity(pg_temp.pid(3),pg_temp.pid(903),
  (select (context->>'operationId')::uuid from flow where n=6),1,repeat('c',64),
  'synthetic_file_383_6',(select context->>'reservedFolderId' from flow where n=6))$$,
  '42501','PHOTO_ACCESS_REQUIRED','another maid cannot reserve a readable name');
select throws_ok($$select public.reserve_named_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),
  (select (context->>'operationId')::uuid from flow where n=6),2,repeat('c',64),
  'synthetic_file_383_6',(select context->>'reservedFolderId' from flow where n=6))$$,
  '40001','PHOTO_UPLOAD_FENCE_CONFLICT','stale fence never creates a name');
select throws_ok($$select public.reserve_named_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),
  (select (context->>'operationId')::uuid from flow where n=6),1,repeat('c',64),
  'synthetic_file_383_6','synthetic_missing_folder_383')$$,
  '23514','PHOTO_FOLDER_PARENT_REQUIRED','new wrapper retains folder winner validation');
savepoint expired_session;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.pid(902);
select throws_ok($$select pg_temp.reserve(6)$$,'42501','SESSION_REVOKED','session hard-expiry still blocks name reservation');
rollback to expired_session;
select is((select count(*) from private.photo_storage_names),3::bigint,'denied actor/session/fence/folder requests have no name side effects');
select ok(not exists(select 1 from private.photo_drive_identities
  where operation_id=(select (context->>'operationId')::uuid from flow where n=6)),
  'denied requests do not reserve an external file candidate');
select throws_ok($$update private.photo_storage_names set file_name=file_name$$,
  '55000','PHOTO_STORAGE_IMMUTABLE','filename UPDATE is forbidden even when unchanged');
select throws_ok($$delete from private.photo_storage_names$$,
  '55000','PHOTO_STORAGE_IMMUTABLE','filename/number bindings are never deleted');
select throws_ok($$insert into private.photo_storage_names(object_id,operation_id,naming_number,upload_date,room_number,slot_key,mime_type,file_name)
  select (named->>'objectId')::uuid,(named->>'operationId')::uuid,9000000000000000001,
    (named->>'uploadDate')::date,named->>'roomNumber','bomb-proof',named->>'mimeType',
    private.photo_storage_file_name((named->>'uploadDate')::date,'bomb-proof',named->>'roomNumber',9000000000000000001,named->>'mimeType')
  from flow where n=4$$,'23514','PHOTO_STORAGE_NAME_INVALID','binding cannot substitute a different frozen slot category');
select throws_ok($$insert into private.photo_storage_names(object_id,operation_id,naming_number,upload_date,room_number,slot_key,mime_type,file_name)
  select (named->>'objectId')::uuid,(named->>'operationId')::uuid,9000000000000000001,
    (named->>'uploadDate')::date,named->>'roomNumber',named->>'slotKey',named->>'mimeType','not-a-canonical-name.jpg'
  from flow where n=4$$,'23514',null,'CHECK rejects a forged filename even with valid frozen snapshot fields');

-- The worker consumes the same durable name after uncertain provider results.
savepoint worker_context;
-- Rollback-only clock simulation retains the real revision/event guard.
-- The authoritative reserved -> reconciliation_pending transition uses the RPC.
update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
  where operation_id=(select (context->>'operationId')::uuid from flow where n=1);
select public.reconcile_admitted_photo_upload((select (context->>'operationId')::uuid from flow where n=1),repeat('d',64));
select is(public.get_photo_reconciliation_context((select (context->>'operationId')::uuid from flow where n=1),2,repeat('d',64))->>'fileName',
  (select named->>'fileName' from flow where n=1),'reconciliation receives the exact frozen name');
rollback to worker_context;
select public.record_admitted_photo_provider_success((select (context->>'operationId')::uuid from flow where n=1),
  1,repeat('c',64),'synthetic_file_383_1',(select reserved_at from private.photo_drive_identities
    where operation_id=(select (context->>'operationId')::uuid from flow where n=1)));
update flow set operation=public.finalize_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),
  (context->>'operationId')::uuid,1,repeat('c',64)) where n=1;
select is(public.authorize_photo_read(pg_temp.pid(1),pg_temp.pid(901),
  (select (operation->>'photoId')::uuid from flow where n=1))->>'fileName',
  (select named->>'fileName' from flow where n=1),'authorized admin read context has the immutable name');
select is(public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),
  (select (operation->>'photoId')::uuid from flow where n=1))->>'fileName',
  (select named->>'fileName' from flow where n=1),'actual performer read context has the immutable name');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(3),pg_temp.pid(903),
  (select (operation->>'photoId')::uuid from flow where n=1))$$,
  '42501','PHOTO_ACCESS_REQUIRED','another maid cannot obtain filename/read context');
select ok(not public.get_photo_reconciliation_context((select (context->>'operationId')::uuid from flow where n=1),99,repeat('f',64)) ? 'fileName',
  'accepted worker shortcut stays locator/name-free');
select ok(not public.get_photo_reconciliation_context((select (context->>'operationId')::uuid from flow where n=1),99,repeat('f',64)) ? 'providerFileId',
  'accepted worker shortcut still has no deletion locator');
select is((select count(*) from private.photo_storage_names),3::bigint,'finalize and worker retries preserve the original bindings');

-- Named and historical UUID identities share the real cleanup authorities.
-- All timestamps below belong only to this rollback-only synthetic fixture.
-- No Google DELETE, production data, immutable upload clock, or trigger is changed.
-- Initial fresh-clock fixture failed PHOTO_PURGE_TIME_INVALID: an old issue
-- anchor cannot make a newly uploaded immutable photo purge clock old. Keep that
-- guard and the original fresh n1/4 identities untouched. Insert independent,
-- internally consistent historical accepted metadata once, as in the existing
-- photo_drive_upload_read historical fixture. Reservation RPC coverage above is
-- separate; the historical name binding is a synthetic owner-only model fixture.
create function pg_temp.historical_cleanup_photo(n integer,p_named boolean) returns void language plpgsql as $$
declare
  room_row public.rooms; snapshot jsonb; slot uuid;
  operation_id uuid:=pg_temp.pid(7000+n); object_id uuid:=pg_temp.pid(7100+n);
  photo_id uuid:=pg_temp.pid(7200+n); naming_number bigint; file_name text;
  uploaded timestamptz:=(date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')
    at time zone 'Asia/Seoul')-interval '182 days'+interval '12 hours';
  provider_file text:='synthetic_historical_file_383_'||n;
  provider_folder text:='synthetic_historical_room_383_'||n;
begin
  select * into room_row from public.rooms
    where room_type_id=(select id from public.room_types where code='standard')
    order by room_number offset n limit 1;
  snapshot:=jsonb_build_object('id',pg_temp.pid(200),'version',9,
    'photoSlots',private.flat_cleaning_photo_slots(),'durationMinutes',1);
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by)
  values(pg_temp.pid(300+n),room_row.id,'additional','manual_room_request','names-historical-'||n,
    (uploaded at time zone 'Asia/Seoul')::date,(uploaded at time zone 'Asia/Seoul')::date,
    'notified',2,jsonb_build_object('code','standard'),10000,snapshot,pg_temp.pid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
  values(pg_temp.pid(400+n),pg_temp.pid(300+n),pg_temp.pid(2),n,2,uploaded-interval '4 hours',pg_temp.pid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
    status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
  values(pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(2),1,'field_completed',2,
    snapshot,jsonb_build_object('roomId',room_row.id),uploaded-interval '3 hours',
    uploaded-interval '2 hours',uploaded-interval '2 hours');
  select id into slot from private.target_photo_slot_snapshots
    where cleaning_target_id=pg_temp.pid(300+n) and slot_key='cleaning-proof';
  insert into private.photo_upload_admissions(id,actor_profile_id,cleaning_attempt_id,cleaning_target_id,
    assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,
    collection_item_id,expected_item_revision,idempotency_key_digest,created_at,expires_at,quota_revision)
  values(pg_temp.pid(6900+n),pg_temp.pid(2),pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),2,
    slot,0,pg_temp.pid(600+n),0,lpad((7000+n)::text,64,'0'),uploaded-interval '2 minutes',
    uploaded+interval '3 minutes',1);
  insert into private.photo_upload_operations(id,command_type,actor_profile_id,idempotency_key_digest,
    request_hash,cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,
    target_photo_slot_id,expected_photo_revision,collection_item_id,expected_item_revision,
    sha256,mime_type,size_bytes,created_at)
  values(operation_id,'photo.collection.upload',pg_temp.pid(2),lpad((7000+n)::text,64,'0'),repeat('a',64),
    pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),2,slot,0,pg_temp.pid(600+n),0,
    repeat('a',64),'image/jpeg',100,uploaded-interval '1 minute');
  insert into private.photo_upload_admission_bindings(admission_id,operation_id,bound_at)
  values(pg_temp.pid(6900+n),operation_id,uploaded-interval '1 minute');
  insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
  values(object_id,operation_id,provider_file,uploaded,uploaded+interval '168 hours');
  insert into private.photo_drive_identities(object_id,operation_id,provider_file_id,provider_folder_id,
    upload_date,room_number,reserved_at)
  values(object_id,operation_id,provider_file,provider_folder,(uploaded at time zone 'Asia/Seoul')::date,
    room_row.room_number,uploaded-interval '1 minute');
  if p_named then
    naming_number:=nextval('private.photo_storage_name_number'::regclass);
    file_name:=private.photo_storage_file_name((uploaded at time zone 'Asia/Seoul')::date,
      'cleaning-proof',room_row.room_number,naming_number,'image/jpeg');
    insert into private.photo_storage_names(object_id,operation_id,naming_number,upload_date,room_number,slot_key,mime_type,file_name)
    values(object_id,operation_id,naming_number,(uploaded at time zone 'Asia/Seoul')::date,
      room_row.room_number,'cleaning-proof','image/jpeg',file_name);
  end if;
  insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,status)
  values(operation_id,pg_temp.pid(500+n),slot,pg_temp.pid(2),'provider_succeeded');
  insert into private.attempt_photo_versions(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,
    version,validation_status,sha256,mime_type,size_bytes,uploaded_at,purge_after,collection_item_id,item_revision)
  values(photo_id,pg_temp.pid(500+n),pg_temp.pid(300+n),slot,1,'verified',repeat('a',64),'image/jpeg',100,
    uploaded,uploaded+interval '168 hours',pg_temp.pid(600+n),1);
  insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id)
  values(operation_id,object_id,photo_id);
  update private.photo_upload_states set status='accepted',revision=revision+1
  where photo_upload_states.operation_id=pg_temp.pid(7000+n);
  insert into flow values(n,private.photo_upload_projection(operation_id),
    jsonb_build_object('operationId',operation_id,'objectId',object_id),jsonb_build_object('fileName',file_name));
end;
$$;
select pg_temp.historical_cleanup_photo(8,true);
select pg_temp.historical_cleanup_photo(9,false);
create temp table cleanup_before as
select case f.n when 8 then 1 when 9 then 4 else f.n end n,
  (f.context->>'operationId')::uuid operation_id,(f.context->>'objectId')::uuid object_id,
  identity.provider_file_id,
  to_jsonb(names) name_binding,
  to_jsonb(identity) - array['provider_file_id','provider_folder_id'] identity_history,
  to_jsonb(acceptance) acceptance_history,to_jsonb(photo) photo_history
from flow f
join private.photo_drive_identities identity on identity.operation_id=(f.context->>'operationId')::uuid
left join private.photo_storage_names names on names.operation_id=identity.operation_id
left join private.photo_upload_acceptances acceptance on acceptance.operation_id=identity.operation_id
left join private.attempt_photo_versions photo on photo.id=acceptance.photo_version_id
where f.n in (2,5,8,9);
create temp table cleanup_results(label text primary key,result jsonb);
select ok(a.started_at<a.field_completed_at and a.field_completed_at<=o.created_at
  and o.created_at<p.uploaded_at and p.purge_after=p.uploaded_at+interval '168 hours'
  and p.purge_after<clock_timestamp() and i.reserved_at<=p.uploaded_at
  and i.upload_date=(p.uploaded_at at time zone 'Asia/Seoul')::date,
  'historical accepted fixture preserves work, identity, upload and immutable expiry clocks '||b.n)
from cleanup_before b join private.photo_upload_operations o on o.id=b.operation_id
join public.cleaning_attempts a on a.id=o.cleaning_attempt_id
join private.photo_provider_objects p on p.id=b.object_id
join private.photo_drive_identities i on i.object_id=b.object_id where b.n in (1,4);

-- These accepted versions are no longer current and are genuine orphan history.
-- Attach a typed resolved-room-issue anchor whose report and resolution clocks
-- follow the historical upload. Both immutable +168h and domain +180d expiry
-- are now in the past, without changing a protected row or disabling a trigger.
insert into public.room_issues(id,room_id,category,severity,status,reported_by,reported_at,
  resolved_by,resolved_at,resolution_reason_code)
select pg_temp.pid(800+b.n),t.room_id,'synthetic-name-cleanup','warning','resolved',pg_temp.pid(1),
  p.uploaded_at+interval '1 hour',pg_temp.pid(1),p.uploaded_at+interval '1 day','ISSUE_RESOLVED'
from cleanup_before b join private.photo_upload_operations o on o.id=b.operation_id
join public.cleaning_targets t on t.id=o.cleaning_target_id
join private.photo_provider_objects p on p.id=b.object_id where b.n in (1,4);
select private.attach_photo_retention_link(object_id,'room_issue','room_issue',pg_temp.pid(800+n),pg_temp.pid(2))
from cleanup_before where n in (1,4);
select ok(r.effective_policy_kind='room_issue' and r.retention_starts_at=i.resolved_at
  and r.expires_at=i.resolved_at+interval '180 days' and r.expires_at<clock_timestamp()
  and j.purge_after=r.expires_at and j.next_attempt_at=r.expires_at,
  'accepted queue is derived from the real typed domain anchor and refresh '||b.n)
from cleanup_before b join private.photo_retention_records r on r.object_id=b.object_id
join private.photo_purge_jobs j on j.object_id=b.object_id
join public.room_issues i on i.id=pg_temp.pid(800+b.n) where b.n in (1,4);
select ok(not exists(select 1 from private.photo_retention_links l
  where l.object_id=b.object_id and l.active and l.domain_kind='cleaning_attempt'),
  'non-current historical accepted version has no pending attempt retention link '||b.n)
from cleanup_before b where b.n in (1,4);
insert into cleanup_results values('accepted-first',public.claim_due_photo_purges(repeat('a',64),10));
select is((select jsonb_array_length(result->'items') from cleanup_results where label='accepted-first'),2,
  'named and UUID accepted objects are both actually claimed');
select ok(exists(select 1 from cleanup_results r,jsonb_array_elements(r.result->'items') item
  where r.label='accepted-first' and item->>'objectId'=b.object_id::text and item->>'leaseVersion'='1'),
  'accepted claim has the exact object and first fence '||b.n)
from cleanup_before b where b.n in (1,4);
insert into cleanup_results values('accepted-replay',public.claim_due_photo_purges(repeat('a',64),10));
select ok(exists(select 1 from cleanup_results r,jsonb_array_elements(r.result->'items') item
  where r.label='accepted-replay' and item->>'objectId'=b.object_id::text and item->>'leaseVersion'='1'),
  'same accepted claimant replays the existing fence '||b.n)
from cleanup_before b where b.n in (1,4);
select throws_ok(format('select public.get_photo_purge_context(%L::uuid,2,%L)',object_id,repeat('a',64)),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','wrong accepted context fence is denied '||n)
from cleanup_before where n in (1,4);
select throws_ok(format('select public.settle_photo_purge(%L::uuid,1,%L,%L)',object_id,repeat('a',64),'not_found'),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','accepted callback needs a real prepared deletion permit '||n)
from cleanup_before where n in (1,4);
select is(public.get_photo_purge_context(object_id,1,repeat('a',64))->>'providerFileId',
  provider_file_id,'accepted context uses the exact ID, never its readable name '||n)
from cleanup_before where n in (1,4);
select is(public.settle_photo_purge(object_id,1,repeat('a',64),'retryable','NETWORK_ERROR')->>'status',
  'retry','uncertain accepted DELETE remains retryable without clearing identity '||n)
from cleanup_before where n in (1,4);
select is(o.provider_locator,b.provider_file_id,'retry preserves accepted locator '||b.n)
from cleanup_before b join private.photo_provider_objects o on o.id=b.object_id where b.n in (1,4);
-- Fast-forward only the mutable retry queue in this synthetic transaction.
update private.photo_purge_jobs j set next_attempt_at=clock_timestamp()-interval '1 second',revision=revision+1
from cleanup_before b where j.object_id=b.object_id and b.n in (1,4);
insert into cleanup_results values('accepted-second',public.claim_due_photo_purges(repeat('b',64),10));
select ok(exists(select 1 from cleanup_results r,jsonb_array_elements(r.result->'items') item
  where r.label='accepted-second' and item->>'objectId'=b.object_id::text and item->>'leaseVersion'='2'),
  'retry receives a new accepted deletion fence '||b.n)
from cleanup_before b where b.n in (1,4);
select throws_ok(format('select public.settle_photo_purge(%L::uuid,1,%L,%L)',object_id,repeat('a',64),'not_found'),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','late accepted callback cannot settle a newer claim '||n)
from cleanup_before where n in (1,4);
select is(public.get_photo_purge_context(object_id,2,repeat('b',64))->>'providerFileId',
  provider_file_id,'second accepted permit still addresses the original provider ID '||n)
from cleanup_before where n in (1,4);
select is(public.settle_photo_purge(object_id,2,repeat('b',64),'not_found')->>'status','purged',
  'provider 404 converges through actual accepted settle '||n)
from cleanup_before where n in (1,4);
select is(public.settle_photo_purge(object_id,2,repeat('b',64),'not_found')->>'status','purged',
  'same accepted 404 callback replays its terminal result '||n)
from cleanup_before where n in (1,4);
select throws_ok(format('select public.settle_photo_purge(%L::uuid,2,%L,%L)',object_id,repeat('f',64),'not_found'),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','terminal accepted replay still requires the exact claimant '||n)
from cleanup_before where n in (1,4);
select is((select count(*) from private.photo_cleanup_events e where e.object_id=b.object_id and e.state='purged'),
  1::bigint,'accepted 404 callback emits one terminal cleanup event '||b.n)
from cleanup_before b where b.n in (1,4);
select ok(o.provider_locator is null and i.provider_file_id is null and i.provider_folder_id is null,
  'accepted purge clears only raw provider locators '||b.n)
from cleanup_before b join private.photo_provider_objects o on o.id=b.object_id
join private.photo_drive_identities i on i.object_id=b.object_id where b.n in (1,4);
select is(to_jsonb(a),b.acceptance_history,'accepted purge retains immutable acceptance history '||b.n)
from cleanup_before b join private.photo_upload_acceptances a on a.operation_id=b.operation_id where b.n in (1,4);
select is(to_jsonb(p),b.photo_history,'accepted purge retains immutable photo version history '||b.n)
from cleanup_before b join private.photo_upload_acceptances a on a.operation_id=b.operation_id
join private.attempt_photo_versions p on p.id=a.photo_version_id where b.n in (1,4);
select is(s.status,'accepted','accepted retention cleanup never becomes compensation '||b.n)
from cleanup_before b join private.photo_upload_states s on s.operation_id=b.operation_id where b.n in (1,4);
select throws_ok(format('select public.authorize_photo_read(%L::uuid,%L::uuid,%L::uuid)',
  pg_temp.pid(1),pg_temp.pid(901),(acceptance_history->>'photo_version_id')::uuid),
  '55000','PHOTO_MEDIA_PURGED','accepted metadata remains but content is no longer readable '||n)
from cleanup_before where n in (1,4);

-- Unknown external results cannot authorize compensation, with either name form.
update private.photo_upload_states s set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
from cleanup_before b where s.operation_id=b.operation_id and b.n in (2,5);
select is(public.reconcile_admitted_photo_upload(operation_id,repeat('d',64))->>'status','reconciliation_pending',
  'lease retirement enters real unknown-result reconciliation '||n)
from cleanup_before where n in (2,5);
select is(public.get_photo_reconciliation_context(operation_id,2,repeat('d',64))->>'compensationAllowed','false',
  'unknown named/UUID outcome is never deletion authority '||n)
from cleanup_before where n in (2,5);
select is(public.get_photo_reconciliation_context(operation_id,2,repeat('d',64))->'fileName',
  coalesce(name_binding->'file_name','null'::jsonb),'uncertain reconciliation preserves the same naming contract '||n)
from cleanup_before where n in (2,5);
select throws_ok(format('select public.settle_admitted_photo_compensation(%L::uuid,2,%L,%L)',
  operation_id,repeat('d',64),'not_found'),'55000','PHOTO_OPERATION_TERMINAL',
  'unobserved provider identity cannot be compensated '||n)
from cleanup_before where n in (2,5);
select public.record_admitted_photo_provider_success(b.operation_id,2,repeat('d',64),
  'synthetic_file_383_'||b.n,i.reserved_at)
from cleanup_before b join private.photo_drive_identities i on i.operation_id=b.operation_id where b.n in (2,5);
select is(public.get_photo_reconciliation_context(operation_id,2,repeat('d',64))->>'compensationAllowed','true',
  'only independently observed never-accepted identity becomes compensable '||n)
from cleanup_before where n in (2,5);
select is(public.get_photo_reconciliation_context(operation_id,2,repeat('d',64))->'fileName',
  coalesce(name_binding->'file_name','null'::jsonb),'known compensation context reuses named/legacy identity '||n)
from cleanup_before where n in (2,5);
select throws_ok(format('select public.settle_admitted_photo_compensation(%L::uuid,1,%L,%L)',
  operation_id,repeat('c',64),'not_found'),'40001','PHOTO_UPLOAD_FENCE_CONFLICT',
  'stale business upload fence cannot settle compensation '||n)
from cleanup_before where n in (2,5);
select ok(j.next_attempt_at=o.uploaded_at+interval '30 days',
  'actual orphan enqueue preserves the authoritative thirty-day clock '||b.n)
from cleanup_before b join private.photo_orphan_purge_jobs j on j.operation_id=b.operation_id
join private.photo_provider_objects o on o.id=b.object_id where b.n in (2,5);
insert into cleanup_results values('orphan-not-due',public.claim_due_photo_orphan_purges(repeat('e',64),10));
select is((select jsonb_array_length(result->'items') from cleanup_results where label='orphan-not-due'),0,
  'fresh named and UUID orphan objects are not immediately due');
-- Owner-only clock fast-forward of the mutable queue is confined to this test.
-- The original uploaded_at/name/snapshot remains unchanged. The thirty-day
-- boundary itself is covered above; these calls exercise the expired-job worker.
update private.photo_orphan_purge_jobs j set next_attempt_at=clock_timestamp()-interval '1 second',revision=revision+1
from cleanup_before b where j.operation_id=b.operation_id and b.n in (2,5);
insert into cleanup_results values('orphan-first',public.claim_due_photo_orphan_purges(repeat('e',64),10));
select is((select jsonb_array_length(result->'items') from cleanup_results where label='orphan-first'),2,
  'named and UUID never-accepted objects are actually claimed from the orphan ledger');
select ok(exists(select 1 from cleanup_results r,jsonb_array_elements(r.result->'items') item
  where r.label='orphan-first' and item->>'operationId'=b.operation_id::text and item->>'leaseVersion'='1'),
  'orphan claim has the exact operation and first fence '||b.n)
from cleanup_before b where b.n in (2,5);
insert into cleanup_results values('orphan-replay',public.claim_due_photo_orphan_purges(repeat('e',64),10));
select ok(exists(select 1 from cleanup_results r,jsonb_array_elements(r.result->'items') item
  where r.label='orphan-replay' and item->>'operationId'=b.operation_id::text and item->>'leaseVersion'='1'),
  'same orphan claimant replays its existing fence '||b.n)
from cleanup_before b where b.n in (2,5);
select throws_ok(format('select public.get_photo_orphan_purge_context(%L::uuid,2,%L)',operation_id,repeat('e',64)),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','wrong orphan context fence is denied '||n)
from cleanup_before where n in (2,5);
select is(public.get_photo_orphan_purge_context(operation_id,1,repeat('e',64))->>'providerFileId',
  'synthetic_file_383_'||n,'orphan context uses exact persisted ID, never its readable name '||n)
from cleanup_before where n in (2,5);
select is(public.settle_photo_orphan_purge(operation_id,1,repeat('e',64),'retryable','NETWORK_ERROR')->>'status',
  'retry','uncertain orphan DELETE remains retryable '||n)
from cleanup_before where n in (2,5);
select is(o.provider_locator,'synthetic_file_383_'||b.n,'retry retains never-accepted provider identity '||b.n)
from cleanup_before b join private.photo_provider_objects o on o.id=b.object_id where b.n in (2,5);
update private.photo_orphan_purge_jobs j set next_attempt_at=clock_timestamp()-interval '1 second',revision=revision+1
from cleanup_before b where j.operation_id=b.operation_id and b.n in (2,5);
insert into cleanup_results values('orphan-second',public.claim_due_photo_orphan_purges(repeat('f',64),10));
select ok(exists(select 1 from cleanup_results r,jsonb_array_elements(r.result->'items') item
  where r.label='orphan-second' and item->>'operationId'=b.operation_id::text and item->>'leaseVersion'='2'),
  'orphan retry receives a new deletion fence '||b.n)
from cleanup_before b where b.n in (2,5);
select throws_ok(format('select public.settle_photo_orphan_purge(%L::uuid,1,%L,%L)',operation_id,repeat('e',64),'not_found'),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','late orphan callback cannot settle a newer claim '||n)
from cleanup_before where n in (2,5);
select is(public.get_photo_orphan_purge_context(operation_id,2,repeat('f',64))->>'providerFileId',
  'synthetic_file_383_'||n,'retried orphan context still uses the exact provider identity '||n)
from cleanup_before where n in (2,5);
select is(public.settle_photo_orphan_purge(operation_id,2,repeat('f',64),'not_found')->>'status','purged',
  'provider 404 converges through actual durable orphan settle '||n)
from cleanup_before where n in (2,5);
select is(public.settle_photo_orphan_purge(operation_id,2,repeat('f',64),'not_found')->>'status','purged',
  'same orphan 404 callback replays terminal result '||n)
from cleanup_before where n in (2,5);
select throws_ok(format('select public.settle_photo_orphan_purge(%L::uuid,2,%L,%L)',operation_id,repeat('e',64),'not_found'),
  '40001','PHOTO_PURGE_FENCE_CONFLICT','terminal orphan replay still requires exact claimant '||n)
from cleanup_before where n in (2,5);
select is(public.reconcile_admitted_photo_upload(operation_id,repeat('d',64))->>'status','compensated',
  'upload reconciliation observes the durable orphan compensation result '||n)
from cleanup_before where n in (2,5);
select is(public.settle_admitted_photo_compensation(operation_id,2,repeat('d',64),'not_found')->>'status','compensated',
  'admitted compensation replay converges with the durable orphan ledger '||n)
from cleanup_before where n in (2,5);
select ok(o.provider_locator is null and i.provider_file_id is null and i.provider_folder_id is null,
  'orphan compensation clears only raw provider locators '||b.n)
from cleanup_before b join private.photo_provider_objects o on o.id=b.object_id
join private.photo_drive_identities i on i.object_id=b.object_id where b.n in (2,5);
select ok(not exists(select 1 from private.photo_upload_acceptances a where a.operation_id=b.operation_id)
  and not exists(select 1 from private.photo_purge_jobs j where j.operation_id=b.operation_id),
  'never-accepted compensation does not invent accepted history or accepted purge work '||b.n)
from cleanup_before b where b.n in (2,5);
select is((select count(*) from private.photo_cleanup_events e where e.operation_id=b.operation_id and e.state='purged'),
  1::bigint,'orphan callback and admitted replay emit one terminal cleanup event '||b.n)
from cleanup_before b where b.n in (2,5);

select is(to_jsonb(names),b.name_binding,'purge/compensation preserves immutable name binding or legacy absence '||b.n)
from cleanup_before b left join private.photo_storage_names names on names.operation_id=b.operation_id;
select is(to_jsonb(i)-array['provider_file_id','provider_folder_id'],b.identity_history,
  'purge/compensation preserves reserved identity date, room and ownership history '||b.n)
from cleanup_before b join private.photo_drive_identities i on i.operation_id=b.operation_id;
select is((select count(*) from private.photo_storage_names),4::bigint,
  'all cleanup retries preserve three fresh and one historical immutable name bindings');

select ok(relrowsecurity,'name binding table has RLS') from pg_class where oid='private.photo_storage_names'::regclass;
select is((select count(*) from pg_constraint where conrelid='private.photo_storage_names'::regclass
  and contype='f' and confrelid in ('private.photo_drive_identities'::regclass,'private.photo_provider_objects'::regclass)),
  2::bigint,'name binds the reserved identity and exact object/operation pair');
select ok(not has_table_privilege(role_name,'private.photo_storage_names','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
  'no raw table grant for '||role_name) from unnest(array['anon','authenticated','service_role'])role_name;
select ok(not has_sequence_privilege(role_name,'private.photo_storage_name_number','USAGE,SELECT,UPDATE'),
  'no direct global sequence grant for '||role_name) from unnest(array['anon','authenticated','service_role'])role_name;
select ok(not has_function_privilege(role_name,'public.reserve_named_photo_provider_identity(uuid,uuid,uuid,integer,text,text,text)','EXECUTE'),
  'no public RPC execution for '||role_name) from unnest(array['anon','authenticated'])role_name;
select ok(has_function_privilege('service_role','public.reserve_named_photo_provider_identity(uuid,uuid,uuid,integer,text,text,text)','EXECUTE'),
  'only the server role has named reservation execution');
select ok(not has_function_privilege(role_name,signature,'EXECUTE'),'private name helper stays closed '||role_name||' '||signature)
from unnest(array['anon','authenticated','service_role'])role_name cross join unnest(array[
  'private.photo_storage_file_name(date,text,text,bigint,text)','private.guard_photo_storage_name_binding()'])signature;
set local role authenticated;
select throws_ok($$select public.reserve_named_photo_provider_identity(null,null,null,null,null,null,null)$$,
  '42501',null,'authenticated cannot spoof named RPC actor');
select throws_ok($$select * from private.photo_storage_names$$,'42501',null,'Data API cannot expose names');
reset role;
set local role service_role;
select throws_ok($$select * from private.photo_storage_names$$,'42501',null,'service role cannot read binding table directly');
select throws_ok($$select nextval('private.photo_storage_name_number')$$,'42501',null,'service role cannot consume/reset sequence directly');
reset role;
set constraints all immediate;
select * from finish();
rollback;
