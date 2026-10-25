-- #411 synthetic RPC/constraint regression. Actual SQL execution requires release approval.
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

create function pg_temp.batch(k integer,key text,cr bigint) returns jsonb language sql as $$
  select public.admit_photo_collection_upload_batch(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(501),pg_temp.cid(401),2,
    pg_temp.slot(1,key),cr,jsonb_build_array(
      jsonb_build_object('photoItemId',pg_temp.cid(10000+k),'expectedItemRevision',0,'keyDigest',lpad(k::text,64,'0')),
      jsonb_build_object('photoItemId',pg_temp.cid(10001+k),'expectedItemRevision',0,'keyDigest',lpad((k+1)::text,64,'0'))),
    lpad(('9'||k)::text,64,'0'),repeat('b',64))
$$;
select ok(not has_function_privilege('authenticated',
  'public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)','execute'),
  'authenticated cannot call the service batch RPC');
select ok(has_function_privilege('service_role',
  'public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)','execute'),
  'service role RPC still requires caller actor/session validation');
select public.refresh_photo_storage_quota(clock_timestamp(),1000);

savepoint pair;
insert into flow values(-1,jsonb_build_object('minute',date_trunc('minute',clock_timestamp())));
insert into flow values(0,pg_temp.batch(1,'cleaning-proof',0));
select is((select count(*) from private.photo_upload_admissions),2::bigint,'both pre-decode reservations commit together');
select is((select coalesce(sum(occurrence_count),0) from private.photo_upload_admission_limits),0::bigint,'metadata-only creation does not double-charge the binary CPU budget');
select is((private.photo_quota_context(clock_timestamp())->>'pendingBytes')::bigint,614400::bigint,'both conservative byte reservations count');
select is(pg_temp.batch(1,'cleaning-proof',0),(select result from flow where k=0),'same batch metadata replays the exact pair');
select throws_ok($$select pg_temp.admit(1,99,'cleaning-proof',99,0)$$,'55000','PHOTO_UPLOAD_IN_FLIGHT','third unrelated member remains blocked');
insert into flow values(1,pg_temp.open_upload(1,1,'cleaning-proof',1,0));
insert into flow values(2,pg_temp.open_upload(1,2,'cleaning-proof',2,0));
select ok((select case when minute_started_at=pg_temp.value(-1,'minute')::timestamptz
  then occurrence_count=4 else occurrence_count between 1 and 4 end from private.photo_upload_admission_limits
  where actor_profile_id=pg_temp.cid(2)),'metadata replay and both binary requests consume the unchanged admission rate, respecting real minute rollover');
select is((select count(*) from private.photo_upload_states where status='reserved'),2::bigint,'both fixed operations can hold a transfer claim');
select throws_ok($$select public.claim_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),
  pg_temp.value(1,'operationId')::uuid,repeat('d',64))$$,'55000','PHOTO_UPLOAD_IN_FLIGHT','same member cannot obtain a second concurrent claim');
-- Complete in reverse order; original expected revisions and identities stay immutable.
insert into flow values(12,pg_temp.finish_upload(1,2,(select result from flow where k=2)));
select ok(not private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'one accepted file cannot hide the other reserved member from submission');
select throws_ok($$select public.delete_photo_collection_item(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(501),pg_temp.cid(401),2,
  pg_temp.slot(1,'cleaning-proof'),pg_temp.cid(10002),1,1,repeat('d',64),repeat('e',64))$$,
  '55000','PHOTO_UPLOAD_IN_FLIGHT','existing deletion remains blocked by sibling upload');
select ok(public.get_photo_provider_context(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(1,'operationId')::uuid,1,repeat('c',64)) ? 'operationId',
  'only exact accepted sibling proof admits provider context after collection advance');
insert into flow values(11,pg_temp.finish_upload(1,1,(select result from flow where k=1)));
select is((select count(*) from private.photo_upload_acceptances),2::bigint,'both accepted once despite reverse completion');
select is((select count(distinct provider_file_id) from private.photo_drive_identities),2::bigint,'each immutable operation keeps its own provider identity');
select is((select max(revision) from private.attempt_photo_collection_states),2::bigint,'two serialized final CAS increments');
select is(pg_temp.value(11,'collectionRevision'),'2','receipt uses actual accepted collection revision');
select is(pg_temp.value(12,'collectionRevision'),'1','earlier receipt remains its original accepted revision');
select ok((select bool_and(expected_photo_revision=0) from private.photo_upload_operations),'request CAS metadata is never rewritten');
select is((select count(*) from private.photo_retention_records where effective_policy_kind='cleaning_submission'),2::bigint,'both use existing cleaning retention bindings');
select ok(private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'completion resumes after both terminal acceptances');
select is(public.finalize_admitted_photo_upload(pg_temp.cid(2),pg_temp.cid(902),pg_temp.value(1,'operationId')::uuid,1,repeat('c',64)),
  (select result from flow where k=11),'lost final response replays exact second acceptance');
select throws_ok($$select public.admit_photo_collection_upload_batch(pg_temp.cid(2),pg_temp.cid(902),pg_temp.cid(501),pg_temp.cid(401),2,
  pg_temp.slot(1,'cleaning-proof'),0,jsonb_build_array(
    jsonb_build_object('photoItemId',pg_temp.cid(10001),'expectedItemRevision',0,'keyDigest',lpad('1',64,'0')),
    jsonb_build_object('photoItemId',pg_temp.cid(10002),'expectedItemRevision',0,'keyDigest',lpad('2',64,'0'))),
  lpad('91',64,'0'),repeat('d',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','batch receipt cannot change request hash');
rollback to pair;

savepoint quota;
select public.refresh_photo_storage_quota(clock_timestamp(),11999500000);
select throws_ok($$select pg_temp.batch(1,'cleaning-proof',0)$$,'54000','PHOTO_STORAGE_QUOTA_EXCEEDED','second member quota failure rolls back first reservation');
select is((select count(*) from private.photo_upload_admissions),0::bigint,'failed pair leaves no admission');
select is((select count(*) from private.photo_upload_batches),0::bigint,'failed pair leaves no batch receipt');
select is((select count(*) from private.photo_upload_batch_members),0::bigint,'failed pair leaves no orphan membership');
rollback to quota;

savepoint capacity;
do $$ begin for n in 1..9 loop
  insert into flow values(n,pg_temp.finish_upload(1,n,pg_temp.open_upload(1,n,'bomb-proof',n,n-1)));
end loop; end $$;
select throws_ok($$select pg_temp.batch(100,'bomb-proof',9)$$,'54000','PHOTO_COLLECTION_LIMIT_EXCEEDED','two reservations cannot turn optional max10 into11');
select is((select count(*) from private.photo_upload_batches),0::bigint,'capacity failure is atomic');
rollback to capacity;

savepoint general_capacity;
do $$ begin for n in 1..19 loop
  insert into flow values(n,pg_temp.finish_upload(1,n,pg_temp.open_upload(1,n,'cleaning-proof',n,n-1)));
end loop; end $$;
select throws_ok($$select pg_temp.batch(100,'cleaning-proof',19)$$,'54000','PHOTO_COLLECTION_LIMIT_EXCEEDED','two reservations cannot turn general max20 into21');
select is((select count(*) from private.photo_upload_batches),0::bigint,'general capacity failure leaves no pair');
rollback to general_capacity;

savepoint full_general_pairs;
insert into flow values(0,jsonb_build_object('minute',date_trunc('minute',clock_timestamp())));
do $$ declare first_op jsonb; second_op jsonb; k integer; begin
  for pair in 1..10 loop
    k:=pair*2-1;
    perform pg_temp.batch(k,'cleaning-proof',k-1);
    first_op:=pg_temp.open_upload(1,k,'cleaning-proof',k,k-1);
    second_op:=pg_temp.open_upload(1,k+1,'cleaning-proof',k+1,k-1);
    insert into flow values(k+1,pg_temp.finish_upload(1,k+1,second_op));
    insert into flow values(k,pg_temp.finish_upload(1,k,first_op));
  end loop;
end $$;
select is((select count(*) from private.attempt_photo_collection_items where active),20::bigint,'ten pairs reach the unchanged general20 limit');
select ok((select case when minute_started_at=pg_temp.value(0,'minute')::timestamptz
  then occurrence_count=20 else occurrence_count between 1 and 20 end from private.photo_upload_admission_limits
  where actor_profile_id=pg_temp.cid(2)),'twenty binary requests consume20 rather than40 CPU admissions, respecting real minute rollover');
select is((select count(*) from private.photo_upload_acceptances),20::bigint,'twenty per-file acceptance records survive reverse pair completion');
select ok(private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'complete twenty-photo collection can submit');
rollback to full_general_pairs;

savepoint partial_decode_failure;
insert into flow values(0,pg_temp.batch(1,'cleaning-proof',0));
-- A bad binary fails in the adapter before begin; its committed admission remains
-- unbound. The valid sibling still reaches its own accepted state and retention.
insert into flow values(2,pg_temp.open_upload(1,2,'cleaning-proof',2,0));
insert into flow values(12,pg_temp.finish_upload(1,2,(select result from flow where k=2)));
select is((select count(*) from private.photo_upload_operations),1::bigint,'unstarted failed decode has no provider operation');
select ok(not private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()),'unstarted member blocks early submission until its admission expires');
select ok(private.photo_attempt_complete(pg_temp.cid(501),clock_timestamp()+interval '6 minutes'),'existing five-minute unstarted expiry does not permanently block one valid accepted file');
insert into flow values(1,pg_temp.open_upload(1,1,'cleaning-proof',1,0));
insert into flow values(11,pg_temp.finish_upload(1,1,(select result from flow where k=1)));
select is(pg_temp.value(11,'collectionRevision'),'2','same key retry before expiry uses sibling proof and converges');
select is((select count(*) from private.photo_upload_acceptances),2::bigint,'partial failure recovery preserves sibling acceptance');
rollback to partial_decode_failure;

savepoint expired_unstarted;
-- Historical immutable admission fixture; no constraint/trigger is disabled and
-- no existing reservation timestamp is mutated to manufacture an expiry.
insert into private.photo_upload_batches(id,actor_profile_id,idempotency_key_digest,request_hash)
  values(pg_temp.cid(999),pg_temp.cid(2),lpad('91',64,'0'),repeat('b',64));
insert into private.photo_upload_batch_members(batch_id,actor_profile_id,item_index,idempotency_key_digest)
  select pg_temp.cid(999),pg_temp.cid(2),i-1,lpad(i::text,64,'0') from generate_series(1,2)i;
with at_time as materialized(select clock_timestamp()-interval '6 minutes' as created)
insert into private.photo_upload_admissions(actor_profile_id,cleaning_attempt_id,cleaning_target_id,
  assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,idempotency_key_digest,
  created_at,expires_at,quota_revision,collection_item_id,expected_item_revision)
select pg_temp.cid(2),attempt_id,target_id,assignment_id,2,pg_temp.slot(1,'cleaning-proof'),0,
  lpad(i::text,64,'0'),at_time.created,at_time.created+interval '5 minutes',
  1,pg_temp.cid(10000+i),0 from context_fixture cross join at_time cross join generate_series(1,2)i where n=1;
select throws_ok($$select public.begin_admitted_photo_collection_upload(pg_temp.cid(2),pg_temp.cid(902),
  (select id from private.photo_upload_admissions where idempotency_key_digest=lpad('1',64,'0')),
  repeat('a',64),'image/jpeg',100,lpad('1',64,'0'),repeat('b',64))$$,
  '55000','PHOTO_ADMISSION_EXPIRED','expired unstarted reservation cannot create an operation');
select is((select count(*) from private.photo_upload_operations),0::bigint,'expiry failure creates no provider identity or operation');
rollback to expired_unstarted;

savepoint session;
insert into flow values(0,pg_temp.batch(1,'cleaning-proof',0));
delete from auth.sessions where id=pg_temp.cid(902);
select throws_ok($$select pg_temp.open_upload(1,1,'cleaning-proof',1,0)$$,'42501','SESSION_REVOKED','old batch reservation never replaces a live session');
rollback to session;

select * from finish();
rollback;
