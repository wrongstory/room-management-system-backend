-- #384: actual admitted provider/finalize chains, not direct model acceptance.
-- Synthetic DB acknowledgements below do not call Drive or verify image bytes.
-- Every fixture rolls back; production constraints/triggers and 30/min limits stay on.
begin;
set local search_path = public, extensions;
select no_plan();

-- BEGIN PHOTO CONTEXT SHARED FIXTURE
create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
  select ('88384000-0000-4000-8000-' || lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.cid(100+n) from generate_series(1,4)n;
select public.bootstrap_first_developer_profile(pg_temp.cid(4),pg_temp.cid(104),
  'collection context developer','collection context developer','0384',
  'collection-context-bootstrap-hash','collection-context-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.cid(n),pg_temp.cid(100+n),'collection-context-'||n,'collection-context-'||n,
  'collection-context-'||n,'collection-context-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false
from generate_series(1,3)n;
insert into auth.sessions(id,user_id)
select pg_temp.cid(900+n),pg_temp.cid(100+n) from generate_series(1,4)n;

create function pg_temp.ordinary_slots() returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object('slotKey','slot-'||n,'required',n<10,
    'displayOrder',n-1,'label','historical synthetic proof') order by n)
  from generate_series(1,10)n
$$;
create function pg_temp.v8_slots() returns jsonb language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'slotKey',case when n=1 then 'tv-on' when n=2 then 'entry-storage'
      when n=9 then 'extra-proof' else 'slot-'||n end,
    'required',n<9,'displayOrder',n-1,'label','historical synthetic proof',
    'maxPhotos',case when n=9 then 10 else 1 end) order by n)
  from generate_series(1,9)n
$$;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,
  status,duration_minutes,photo_slots,created_by)
select pg_temp.cid(200),id,'additional',9,'published',1,
  private.flat_cleaning_photo_slots(),pg_temp.cid(1)
from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,
  status,duration_minutes,photo_slots,created_by)
select pg_temp.cid(201),id,'additional',7,'retired',1,pg_temp.ordinary_slots(),pg_temp.cid(1)
from public.room_types where code='standard';
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,
  status,duration_minutes,photo_slots,created_by)
select pg_temp.cid(202),id,'checkout',8,'published',null,pg_temp.v8_slots(),pg_temp.cid(1)
from public.room_types where code='standard';
create temp table context_fixture(n integer primary key,target_id uuid,
  assignment_id uuid,attempt_id uuid);
create function pg_temp.additional_fixture(n integer,legacy boolean) returns void
language plpgsql as $$
declare room_row public.rooms; snapshot jsonb; day date;
begin
  select * into strict room_row from public.rooms
    where room_type_id=(select id from public.room_types where code='standard')
    order by room_number offset n limit 1;
  day:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
  snapshot:=jsonb_build_object('id',pg_temp.cid(case when legacy then 201 else 200 end),
    'version',case when legacy then 7 else 9 end,'durationMinutes',1,
    'photoSlots',case when legacy then pg_temp.ordinary_slots() else private.flat_cleaning_photo_slots() end);
  insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,status,assignment_version,
    room_type_snapshot,fee_snapshot,template_snapshot,created_by)
  values(pg_temp.cid(300+n),room_row.id,'additional','manual_room_request','context-target-'||n,
    day,day,'notified',2,jsonb_build_object('code','standard'),10000,snapshot,pg_temp.cid(1));
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,
    sequence_number,revision,notified_at,changed_by)
  values(pg_temp.cid(400+n),pg_temp.cid(300+n),pg_temp.cid(2),n,2,
    clock_timestamp()-interval '2 hours',pg_temp.cid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
    attempt_number,status,assignment_revision,template_snapshot,room_snapshot,
    started_at,field_completed_at,ended_at)
  values(pg_temp.cid(500+n),pg_temp.cid(300+n),pg_temp.cid(400+n),pg_temp.cid(2),
    1,'field_completed',2,snapshot,jsonb_build_object('roomId',room_row.id),
    clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',
    clock_timestamp()-interval '1 hour');
  insert into context_fixture values(n,pg_temp.cid(300+n),pg_temp.cid(400+n),pg_temp.cid(500+n));
end
$$;
select pg_temp.additional_fixture(1,false);
select pg_temp.additional_fixture(2,true);

-- A historical, fully materialized checkout graph: no execution guard is disabled.
do $$ declare room_row public.rooms; target_row public.cleaning_targets; checkout_at timestamptz;
  day date:=(clock_timestamp() at time zone 'Asia/Seoul')::date;
begin
  select * into strict room_row from public.rooms
    where room_type_id=(select id from public.room_types where code='standard')
    order by room_number offset 3 limit 1;
  checkout_at:=((day-1)+time '11:00') at time zone 'Asia/Seoul';
  perform public.create_reservation_v2(pg_temp.cid(1),pg_temp.cid(803),room_row.id,'standard',
    ((day-2)+time '16:00') at time zone 'Asia/Seoul',checkout_at,2,null,
    room_row.state_version,'context-v8-reservation',repeat('9',64));
  update public.reservations set status='checked_out',actual_checkout_at=checkout_at
    where id=pg_temp.cid(803);
  update public.checkout_cleaning_obligations set status='available'
    where reservation_id=pg_temp.cid(803);
  select * into strict target_row from public.cleaning_targets where reservation_id=pg_temp.cid(803);
  update public.cleaning_targets set status='notified',assignment_version=2
    where id=target_row.id returning * into target_row;
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,
    sequence_number,revision,notified_at,changed_by)
  values(pg_temp.cid(403),target_row.id,pg_temp.cid(2),3,2,
    clock_timestamp()-interval '2 hours',pg_temp.cid(1));
  insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,
    attempt_number,status,assignment_revision,template_snapshot,room_snapshot,
    started_at,field_completed_at,ended_at)
  values(pg_temp.cid(503),target_row.id,pg_temp.cid(403),pg_temp.cid(2),1,'field_completed',2,
    target_row.template_snapshot,jsonb_build_object('roomId',room_row.id),
    clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',
    clock_timestamp()-interval '1 hour');
  insert into context_fixture values(3,target_row.id,pg_temp.cid(403),pg_temp.cid(503));
end $$;

-- BEGIN PHOTO CONTEXT RPC HELPERS
create function pg_temp.slot(n integer,key text) returns uuid language sql stable as $$
  select s.id from private.target_photo_slot_snapshots s join context_fixture f on f.target_id=s.cleaning_target_id
  where f.n=$1 and s.slot_key=$2
$$;
create function pg_temp.admit(n integer,k integer,key text,item integer,cr bigint,ir bigint default 0)
returns jsonb language sql as $$
  select public.admit_photo_collection_upload(pg_temp.cid(2),pg_temp.cid(902),f.attempt_id,
    f.assignment_id,2,pg_temp.slot($1,$3),pg_temp.cid(10000+$4),$5,$6,lpad($2::text,64,'0'))
  from context_fixture f where f.n=$1
$$;
create function pg_temp.open_upload(n integer,k integer,key text,item integer,cr bigint,ir bigint default 0)
returns jsonb language plpgsql as $$
declare admission jsonb; op jsonb; f context_fixture;
begin
  perform public.refresh_photo_storage_quota(clock_timestamp(),1000);
  select * into strict f from context_fixture where context_fixture.n=$1;
  if item is null then
    admission:=public.admit_photo_upload(pg_temp.cid(2),pg_temp.cid(902),f.attempt_id,
      f.assignment_id,2,pg_temp.slot(n,key),cr,lpad(k::text,64,'0'));
    op:=public.begin_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),
      (admission->>'admissionId')::uuid,repeat('a',64),'image/jpeg',100,lpad(k::text,64,'0'),repeat('b',64));
  else
    admission:=pg_temp.admit(n,k,key,item,cr,ir);
    op:=public.begin_admitted_photo_collection_upload(pg_temp.cid(2),pg_temp.cid(902),
      (admission->>'admissionId')::uuid,repeat('a',64),'image/jpeg',100,lpad(k::text,64,'0'),repeat('b',64));
  end if;
  return public.claim_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),(op->>'operationId')::uuid,repeat('c',64));
end
$$;
create function pg_temp.finish_upload(n integer,k integer,op jsonb) returns jsonb language plpgsql as $$
declare context jsonb; room_folder text; result jsonb; oid uuid:=(op->>'operationId')::uuid;
  lease integer:=(op->>'leaseVersion')::integer;
begin
  context:=public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),oid,lease,repeat('c',64));
  perform public.reserve_photo_drive_folder(pg_temp.cid(2),pg_temp.cid(902),oid,lease,repeat('c',64),
    'date','synthetic_context_root','synthetic_context_date');
  context:=public.reserve_photo_drive_folder(pg_temp.cid(2),pg_temp.cid(902),oid,lease,repeat('c',64),
    'room','synthetic_context_root','synthetic_context_room_'||n);
  room_folder:=context->>'folderId';
  perform public.reserve_photo_provider_identity(pg_temp.cid(2),pg_temp.cid(902),oid,lease,repeat('c',64),
    'synthetic_context_file_'||k,room_folder);
  -- Model the acknowledgement of matching immutable provider identity/createdTime only.
  perform public.record_admitted_photo_provider_success(oid,lease,repeat('c',64),
    'synthetic_context_file_'||k,(select reserved_at from private.photo_drive_identities where operation_id=oid));
  result:=public.finalize_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),oid,lease,repeat('c',64));
  if result->>'status' is distinct from 'accepted' then raise exception 'CONTEXT_CHAIN_NOT_ACCEPTED'; end if;
  return result;
end
$$;
-- END PHOTO CONTEXT RPC HELPERS
create temp table flow(k integer primary key,result jsonb);
create function pg_temp.value(k integer,key text) returns text language sql stable as $$
  select result->>$2 from flow where flow.k=$1
$$;
-- END PHOTO CONTEXT SHARED FIXTURE

-- Defensive fixtures are not public admission success cases: owner-only INSERT
-- models immutable historical/corrupt CAS metadata without disabling any guard.
-- throws_ok catches the getter error and rolls back every row in this helper.
create function pg_temp.defensive_getter(n integer,k integer,key text,item integer,cr bigint,ir bigint)
returns jsonb language plpgsql as $$
declare f context_fixture; at_time timestamptz:=clock_timestamp(); admission_id uuid;
  operation_id uuid;
begin
  select * into strict f from context_fixture where context_fixture.n=$1;
  insert into private.photo_upload_admissions(actor_profile_id,cleaning_attempt_id,
    cleaning_target_id,assignment_id,assignment_revision,target_photo_slot_id,
    expected_photo_revision,idempotency_key_digest,created_at,expires_at,quota_revision,
    collection_item_id,expected_item_revision)
  values(pg_temp.cid(2),f.attempt_id,f.target_id,f.assignment_id,2,pg_temp.slot(n,key),
    cr,lpad(k::text,64,'0'),at_time,at_time+interval '5 minutes',
    (select revision from private.photo_storage_quota_snapshot where provider='google_drive'),
    pg_temp.cid(10000+item),ir) returning id into admission_id;
  insert into private.photo_upload_operations(actor_profile_id,command_type,
    idempotency_key_digest,request_hash,cleaning_attempt_id,cleaning_target_id,
    assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,
    sha256,mime_type,size_bytes,created_at,collection_item_id,expected_item_revision)
  values(pg_temp.cid(2),'photo.collection.upload',lpad(k::text,64,'0'),repeat('b',64),
    f.attempt_id,f.target_id,f.assignment_id,2,pg_temp.slot(n,key),cr,repeat('a',64),
    'image/jpeg',100,at_time,pg_temp.cid(10000+item),ir) returning id into operation_id;
  insert into private.photo_provider_objects(operation_id) values(operation_id);
  insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id)
  values(operation_id,f.attempt_id,pg_temp.slot(n,key),pg_temp.cid(2));
  insert into private.photo_upload_admission_bindings(admission_id,operation_id)
  values(admission_id,operation_id);
  perform public.claim_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),operation_id,repeat('c',64));
  return public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),operation_id,1,repeat('c',64));
end
$$;

select is(private.photo_slot_max_photos(pg_temp.slot(1,'cleaning-proof'),pg_temp.cid(301)),20,'v9 general evidence capacity is 20');
select is(private.photo_slot_max_photos(pg_temp.slot(2,'slot-1'),pg_temp.cid(302)),1,'historical ordinary evidence remains single-current');
select is(private.photo_slot_max_photos(pg_temp.slot(3,'extra-proof'),(select target_id from context_fixture where n=3)),10,'v8 extra-proof remains a 10-photo collection');
select ok(not has_function_privilege('anon','public.get_photo_provider_context(uuid,uuid,uuid,integer,text)','execute')
  and not has_function_privilege('authenticated','public.get_photo_provider_context(uuid,uuid,uuid,integer,text)','execute')
  and has_function_privilege('service_role','public.get_photo_provider_context(uuid,uuid,uuid,integer,text)','execute'),
  'provider context retains server-only execute ACL');
select ok((select prosecdef and provolatile='v' and prorettype='jsonb'::regtype
  and proconfig @> array['search_path=""']
  from pg_proc where oid='public.get_photo_provider_context(uuid,uuid,uuid,integer,text)'::regprocedure),
  'provider context retains SECURITY DEFINER, VOLATILE, jsonb and empty search_path');

savepoint general_twenty;
do $$ begin for n in 1..20 loop
  insert into flow values(n,pg_temp.finish_upload(1,n,pg_temp.open_upload(1,n,'cleaning-proof',n,n-1)));
end loop; end $$;
select is((select count(*) from flow where result->>'status'='accepted'),20::bigint,'all 20 general photos complete the public provider chain');
select is((select expected_photo_revision from private.photo_upload_operations where id=pg_temp.value(2,'operationId')::uuid),1::bigint,'second operation uses collection revision one');
select is((select revision from private.attempt_photo_collection_states where cleaning_attempt_id=pg_temp.cid(501)),20::bigint,'each full finalize advances collection revision once');
select is((select count(*) from private.attempt_photo_collection_items where cleaning_attempt_id=pg_temp.cid(501) and active),20::bigint,'20 active stable items exist');
select ok((select bool_and(revision=1) from private.attempt_photo_collection_items where cleaning_attempt_id=pg_temp.cid(501)),'each new item has revision one');
select is((select count(*) from private.attempt_photo_current where cleaning_attempt_id=pg_temp.cid(501)),0::bigint,'collection uploads never create an ordinary pointer');
select is((select count(*) from private.photo_upload_acceptances),20::bigint,'one acceptance per admitted full chain');
select is((select count(*) from private.attempt_photo_collection_changes),20::bigint,'one immutable change per admitted full chain');
select ok(private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'general proof is complete without optional evidence');
select throws_ok($$select pg_temp.admit(1,21,'cleaning-proof',21,20)$$,'54000','PHOTO_COLLECTION_LIMIT_EXCEEDED','21st general item is rejected before provider reservation');
select is((select count(*) from private.photo_drive_identities),20::bigint,'over-cap request adds no provider identity');
select is((select count(*) from private.attempt_photo_versions),20::bigint,'over-cap request adds no immutable photo version');
select ok(not exists(select 1 from flow where result ?| array['providerFileId','providerFolderId','sha256','sessionId','fileName']),
  'public upload projections remain provider/credential/name free');
rollback to general_twenty;

savepoint optional_bomb;
do $$ begin for n in 1..10 loop
  insert into flow values(200+n,pg_temp.finish_upload(1,200+n,pg_temp.open_upload(1,200+n,'bomb-proof',200+n,n-1)));
end loop; end $$;
select is((select count(*) from private.attempt_photo_collection_items where active),10::bigint,'bomb evidence supports 10 actual provider chains');
select throws_ok($$select pg_temp.admit(1,211,'bomb-proof',211,10)$$,'54000','PHOTO_COLLECTION_LIMIT_EXCEEDED','11th bomb evidence is rejected');
select ok(not private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'bomb evidence cannot substitute for required general proof');
rollback to optional_bomb;
savepoint optional_issue;
do $$ begin for n in 1..10 loop
  insert into flow values(300+n,pg_temp.finish_upload(1,300+n,pg_temp.open_upload(1,300+n,'issue-proof',300+n,n-1)));
end loop; end $$;
select is((select count(*) from private.attempt_photo_collection_items where active),10::bigint,'issue evidence supports 10 actual provider chains');
select throws_ok($$select pg_temp.admit(1,311,'issue-proof',311,10)$$,'54000','PHOTO_COLLECTION_LIMIT_EXCEEDED','11th issue evidence is rejected');
select ok(not private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'issue evidence cannot substitute for required general proof');
rollback to optional_issue;

savepoint replay;
insert into flow values(401,pg_temp.finish_upload(1,401,pg_temp.open_upload(1,401,'cleaning-proof',401,0)));
select is(public.begin_admitted_photo_collection_upload(pg_temp.cid(2),pg_temp.cid(902),
  (pg_temp.admit(1,401,'cleaning-proof',401,0)->>'admissionId')::uuid,repeat('a',64),'image/jpeg',100,
  lpad('401',64,'0'),repeat('b',64)),(select result from flow where k=401),'same admission/key/binary replays accepted operation');
select is(public.finalize_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(401,'operationId')::uuid,1,repeat('c',64)),
  (select result from flow where k=401),'response-loss finalize replay returns exact accepted projection');
select throws_ok($$select public.begin_admitted_photo_collection_upload(pg_temp.cid(2),pg_temp.cid(902),
  (pg_temp.admit(1,401,'cleaning-proof',401,0)->>'admissionId')::uuid,repeat('a',64),'image/jpeg',100,
  lpad('401',64,'0'),repeat('d',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','accepted replay cannot change request hash');
select throws_ok($$select pg_temp.admit(1,401,'cleaning-proof',402,1)$$,'23505','IDEMPOTENCY_KEY_REUSED','admission key cannot change item or collection CAS');
select is((select count(*) from private.photo_upload_acceptances),1::bigint,'replays add no acceptance');
select is((select count(*) from private.photo_drive_identities),1::bigint,'replays add no provider identity');
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(401,'operationId')::uuid,1,repeat('c',64))$$,
  '55000','PHOTO_OPERATION_TERMINAL','accepted operation is not a second upload permit');
select ok(not public.get_photo_reconciliation_context(pg_temp.value(401,'operationId')::uuid,99,repeat('f',64)) ? 'providerFileId',
  'accepted worker shortcut has no deletion locator');
rollback to replay;

savepoint replacement_delete;
insert into flow values(501,pg_temp.finish_upload(1,501,pg_temp.open_upload(1,501,'cleaning-proof',501,0)));
insert into flow values(502,pg_temp.finish_upload(1,502,pg_temp.open_upload(1,502,'cleaning-proof',502,1)));
insert into flow values(503,pg_temp.finish_upload(1,503,pg_temp.open_upload(1,503,'cleaning-proof',501,2,1)));
select is((select revision from private.attempt_photo_collection_items where id=pg_temp.cid(10501)),2::bigint,'replacement advances exact item revision');
select is((select display_order from private.attempt_photo_collection_items where id=pg_temp.cid(10501)),0,'replacement preserves item display order');
select ok(pg_temp.value(503,'photoId')<>pg_temp.value(501,'photoId') and exists(
  select 1 from private.attempt_photo_versions where id=pg_temp.value(501,'photoId')::uuid),'replacement preserves earlier immutable photo');
insert into flow values(504,public.delete_photo_collection_item(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(501),pg_temp.cid(401),2,
  pg_temp.slot(1,'cleaning-proof'),pg_temp.cid(10502),3,1,lpad('504',64,'0'),repeat('e',64)));
select is(pg_temp.value(504,'collectionRevision'),'4','delete advances collection CAS after replacement');
select ok((select not active and photo_version_id is null and revision=2 from private.attempt_photo_collection_items where id=pg_temp.cid(10502)),
  'delete preserves tombstone and increments item revision');
select is(public.delete_photo_collection_item(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(501),pg_temp.cid(401),2,
  pg_temp.slot(1,'cleaning-proof'),pg_temp.cid(10502),3,1,lpad('504',64,'0'),repeat('e',64)),
  (select result from flow where k=504),'delete response-loss replays exact immutable receipt');
select throws_ok($$select public.delete_photo_collection_item(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(501),pg_temp.cid(401),2,
  pg_temp.slot(1,'cleaning-proof'),pg_temp.cid(10502),3,1,lpad('504',64,'0'),repeat('f',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','delete key cannot change hash');
select throws_ok($$select pg_temp.admit(1,505,'cleaning-proof',502,4)$$,'40001','PHOTO_ITEM_VERSION_CONFLICT','tombstone UUID cannot be reused');
select throws_ok($$select pg_temp.admit(1,506,'cleaning-proof',506,3)$$,'40001','PHOTO_COLLECTION_VERSION_CONFLICT','stale collection CAS is rejected');
select throws_ok($$select pg_temp.admit(1,507,'cleaning-proof',501,4,1)$$,'40001','PHOTO_ITEM_VERSION_CONFLICT','stale replacement item CAS is rejected');
select throws_ok($$select pg_temp.admit(1,508,'bomb-proof',501,0,2)$$,'40001','PHOTO_ITEM_VERSION_CONFLICT','item ownership cannot cross slot');
select is((select count(*) from private.attempt_photo_collection_changes where change_type='deleted'),1::bigint,'delete/rejected replays add exactly one tombstone event');
select is((select count(*) from private.photo_drive_identities),3::bigint,'stale/delete paths add no provider identity');
select throws_ok($$select pg_temp.defensive_getter(1,901,'cleaning-proof',901,3,0)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects stale collection CAS');
select throws_ok($$select pg_temp.defensive_getter(1,902,'cleaning-proof',501,4,1)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects stale item CAS');
select throws_ok($$select pg_temp.defensive_getter(1,903,'cleaning-proof',903,4,1)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects missing replacement item');
select throws_ok($$select pg_temp.defensive_getter(1,904,'cleaning-proof',501,4,0)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects append reuse of existing UUID');
select throws_ok($$select pg_temp.defensive_getter(1,905,'cleaning-proof',502,4,2)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects tombstoned item');
select throws_ok($$select pg_temp.defensive_getter(1,906,'bomb-proof',501,0,2)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects item from another slot');
select throws_ok($$select pg_temp.defensive_getter(3,907,'extra-proof',501,0,2)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects item from another attempt/target');
select throws_ok($$select pg_temp.defensive_getter(1,908,'cleaning-proof',908,4,null)$$,
  '40001','PHOTO_VERSION_CONFLICT','provider getter itself rejects nullable historical item revision');
select is((select count(*) from private.photo_upload_operations),3::bigint,'defensive getter errors roll back all owner-only synthetic operations');
rollback to replacement_delete;

savepoint security;
insert into flow values(601,pg_temp.open_upload(1,601,'cleaning-proof',601,0));
select is(public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))->>'slotKey',
  'cleaning-proof','current owner with fresh fence reaches collection context');
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(3),pg_temp.cid(903),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','PHOTO_ACCESS_REQUIRED','other maid cannot obtain provider context');
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(1),pg_temp.cid(901),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','PHOTO_ACCESS_REQUIRED','admin cannot impersonate upload owner');
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(4),pg_temp.cid(904),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','PHOTO_ACCESS_REQUIRED','developer cannot impersonate upload owner');
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,2,repeat('c',64))$$,
  '40001','PHOTO_UPLOAD_FENCE_CONFLICT','wrong lease version remains rejected');
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('d',64))$$,
  '40001','PHOTO_UPLOAD_FENCE_CONFLICT','wrong claim digest remains rejected');
savepoint revoked_session;
delete from auth.sessions where id=pg_temp.cid(902);
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','SESSION_REVOKED','revoked session remains rejected');
rollback to revoked_session;
savepoint hard_expiry;
update auth.sessions set not_after=statement_timestamp() where id=pg_temp.cid(902);
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','SESSION_REVOKED','hard expiry at current statement remains rejected');
rollback to hard_expiry;
savepoint password_gate;
update public.profiles set must_change_password=true where id=pg_temp.cid(2);
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','PASSWORD_CHANGE_REQUIRED','password-change gate remains rejected');
rollback to password_gate;
savepoint inactive_actor;
update public.profiles set status='inactive' where id=pg_temp.cid(2);
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','inactive account gains no upload permission');
rollback to inactive_actor;
savepoint limited_actor;
select private.manage_cleaning_attempt_lifecycle_at(pg_temp.cid(1),pg_temp.cid(901),pg_temp.cid(501),1,pg_temp.cid(401),2,
  (select account_lifecycle_version from public.profiles where id=pg_temp.cid(2)),
  'allow_upload','{}','DEACTIVATION_UPLOAD_ONLY','context-allow-upload',repeat('e',64),null);
select lives_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  'actual limited upload capability retains exact own collection access');
insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
select id,clock_timestamp(),'ACCOUNT_CHANGED',pg_temp.cid(1) from private.attempt_capability_grants
where attempt_id=pg_temp.cid(501) and kind='upload_submit';
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','revoked limited capability closes collection access');
rollback to limited_actor;
savepoint stale_assignment;
update public.cleaning_assignments set is_current=false,ended_at=clock_timestamp() where id=pg_temp.cid(401);
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '42501','CAPABILITY_ACCESS_REQUIRED','ended assignment remains rejected before provider identity');
rollback to stale_assignment;
savepoint expired_fence;
update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
where operation_id=pg_temp.value(601,'operationId')::uuid;
select throws_ok($$select public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,1,repeat('c',64))$$,
  '40001','PHOTO_UPLOAD_FENCE_CONFLICT','expired lease remains rejected with real revision/event guard enabled');
update flow set result=public.claim_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(601,'operationId')::uuid,repeat('c',64)) where k=601;
select is(pg_temp.value(601,'leaseVersion'),'2','same reserved operation can be reclaimed without identity rotation');
update flow set result=pg_temp.finish_upload(1,601,result) where k=601;
select is(pg_temp.value(601,'status'),'accepted','identity-free reserved retry completes the full chain');
rollback to expired_fence;
select is((select count(*) from private.photo_drive_identities),0::bigint,'denied contexts and rolled-back retries allocate no identity');
rollback to security;

savepoint legacy_ordinary;
insert into flow values(701,pg_temp.finish_upload(2,701,pg_temp.open_upload(2,701,'slot-1',null,0)));
insert into flow values(702,pg_temp.finish_upload(2,702,pg_temp.open_upload(2,702,'slot-1',null,1)));
select is((select revision from private.attempt_photo_current where cleaning_attempt_id=pg_temp.cid(502)),2::bigint,'ordinary replacement still uses single-photo CAS');
select is((select count(*) from private.attempt_photo_collection_items where cleaning_attempt_id=pg_temp.cid(502)),0::bigint,'ordinary path creates no collection item');
select ok(exists(select 1 from private.attempt_photo_versions where id=pg_temp.value(701,'photoId')::uuid),'ordinary replacement keeps historical accepted version');
select throws_ok($$select pg_temp.open_upload(2,703,'slot-1',null,1)$$,'40001','PHOTO_VERSION_CONFLICT','ordinary stale pointer CAS stays rejected');
rollback to legacy_ordinary;

savepoint legacy_v8;
do $$ begin for n in 1..10 loop
  insert into flow values(800+n,pg_temp.finish_upload(3,800+n,pg_temp.open_upload(3,800+n,'extra-proof',800+n,n-1)));
end loop; end $$;
select is((select count(*) from flow where result->>'status'='accepted'),10::bigint,'v8 extra-proof completes 10 actual admitted provider chains');
select throws_ok($$select pg_temp.admit(3,811,'extra-proof',811,10)$$,'54000','PHOTO_COLLECTION_LIMIT_EXCEEDED','v8 still rejects the eleventh item');
insert into flow values(812,pg_temp.finish_upload(3,812,pg_temp.open_upload(3,812,'extra-proof',801,10,1)));
select is((select revision from private.attempt_photo_collection_items where id=pg_temp.cid(10801)),2::bigint,'v8 replacement uses item CAS after collection revision ten');
select is(public.delete_photo_collection_item(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(503),pg_temp.cid(403),2,
  pg_temp.slot(3,'extra-proof'),pg_temp.cid(10802),11,1,lpad('813',64,'0'),repeat('e',64))->>'collectionRevision',
  '12','v8 delete preserves collection CAS and tombstone history');
select is((select count(*) from private.attempt_photo_current where cleaning_attempt_id=pg_temp.cid(503)),0::bigint,'v8 extra-proof never changes ordinary pointer');
rollback to legacy_v8;

select is((select count(*) from private.photo_upload_operations),0::bigint,'all upload groups restore the baseline fixture');
select is((select count(*) from private.photo_drive_identities),0::bigint,'all provider identity groups restore the baseline fixture');
select is((select count(*) from private.photo_upload_acceptances),0::bigint,'all acceptance groups restore the baseline fixture');
select ok(not exists(select 1 from public.audit_events where after_state::text like '%synthetic_context_file_%'),
  'provider locators are absent from audit payloads');
set constraints all immediate;
select * from finish();
rollback;
