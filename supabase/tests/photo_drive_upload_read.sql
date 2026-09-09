begin;
select no_plan();
create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
select ('84000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,4)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),'drive developer','drive developer','0040','drive-bootstrap-hash','drive-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'drive-'||n,'drive-'||n,'drive-'||n,'drive-'||n,0,
case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,3)n;
insert into auth.sessions(id,user_id) select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,4)n;
create function pg_temp.slots() returns jsonb language sql immutable as $$
select jsonb_agg(jsonb_build_object('slotKey','slot-'||i,'required',i<10,'displayOrder',i-1,'label','합성 증빙')) from generate_series(1,10)i $$;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(200),id,'additional',7,'published',1,pg_temp.slots(),pg_temp.pid(1) from public.room_types where code='standard';
create function pg_temp.fixture(n integer,p_maid integer default 2,p_completed_ago interval default interval '1 hour') returns void language plpgsql as $$
declare r public.rooms; sn jsonb;
begin
select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset n limit 1;
sn:=jsonb_build_object('id',pg_temp.pid(200),'version',7,'photoSlots',pg_temp.slots(),'durationMinutes',1);
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
values(pg_temp.pid(300+n),r.id,'additional','manual_room_request','drive-target-'||n,
 ((clock_timestamp()-p_completed_ago-interval '1 hour') at time zone 'Asia/Seoul')::date,
 ((clock_timestamp()-p_completed_ago-interval '1 hour') at time zone 'Asia/Seoul')::date,
 'notified',2,jsonb_build_object('code','standard'),10000,sn,pg_temp.pid(1));
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
values(pg_temp.pid(400+n),pg_temp.pid(300+n),pg_temp.pid(p_maid),n+1,2,clock_timestamp()-p_completed_ago-interval '1 hour',pg_temp.pid(1));
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
values(pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(p_maid),1,'field_completed',2,sn,jsonb_build_object('roomId',r.id),clock_timestamp()-p_completed_ago-interval '1 hour',clock_timestamp()-p_completed_ago,clock_timestamp()-p_completed_ago);
end; $$;
select pg_temp.fixture(1);
select pg_temp.fixture(2,3);
create function pg_temp.slot(n integer,k text default 'slot-1') returns uuid language sql stable as $$
select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(300+n) and slot_key=k $$;
create function pg_temp.admit(k integer,p_actor integer default 2,p_slot text default 'slot-1',p_rev bigint default 0) returns jsonb language sql as $$
select public.admit_photo_upload(pg_temp.pid(p_actor),pg_temp.pid(900+p_actor),pg_temp.pid(501),pg_temp.pid(401),2,pg_temp.slot(1,p_slot),p_rev,lpad(k::text,64,'0')) $$;
create temp table flow(label text primary key,result jsonb);
create function pg_temp.val(label text,k text) returns text language sql stable as $$select result->>$2 from flow where flow.label=$1 $$;
create function pg_temp.begin_upload(label text,k integer) returns jsonb language sql as $$
select public.begin_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val(label,'admissionId')::uuid,repeat('a',64),'image/jpeg',100,lpad(k::text,64,'0'),repeat('b',64)) $$;
select throws_ok($$select pg_temp.admit(1)$$,'55000','PHOTO_STORAGE_QUOTA_UNAVAILABLE','unknown account quota denies before decoding');
select is((select count(*) from private.photo_upload_admissions),0::bigint,'unknown quota writes no admission');
select throws_ok($$select public.refresh_photo_storage_quota('infinity',100)$$,'23514','PHOTO_QUOTA_SNAPSHOT_INVALID','nonfinite quota clock rejected');
select throws_ok($$select public.refresh_photo_storage_quota(clock_timestamp(),-1)$$,'23514','PHOTO_QUOTA_SNAPSHOT_INVALID','negative usage rejected');
select public.refresh_photo_storage_quota(clock_timestamp(),10000000000);
insert into flow values('admission',pg_temp.admit(1));
select is(pg_temp.val('admission','quotaWarning'),'true','decimal 10GB full-account warning');
select is((pg_temp.admit(1)->>'admissionId'),pg_temp.val('admission','admissionId'),'same binding replays one reservation');
select is((select count(*) from private.photo_upload_admissions),1::bigint,'same key has one durable reserved slot');
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','307200','predecode reserves max output bytes');
select throws_ok($$select pg_temp.admit(2)$$,'55000','PHOTO_UPLOAD_IN_FLIGHT','rotating key cannot create second slot reservation');
select throws_ok($$select pg_temp.admit(1,2,'slot-2')$$,'23505','IDEMPOTENCY_KEY_REUSED','same key cannot change slot');
select throws_ok($$select pg_temp.admit(1,3)$$,'42501','PHOTO_ACCESS_REQUIRED','other maid denied before decode');
select throws_ok($$select pg_temp.admit(1,1)$$,'42501','CAPABILITY_ACCESS_REQUIRED','business admin cannot upload for maid');
select throws_ok($$select pg_temp.admit(1,4)$$,'42501','CAPABILITY_ACCESS_REQUIRED','developer cannot upload');
select public.refresh_photo_storage_quota(clock_timestamp(),11999692800);
select throws_ok($$select pg_temp.admit(2,2,'slot-2')$$,'54000','PHOTO_STORAGE_QUOTA_EXCEEDED','pending bytes counted at exact 12GB block boundary');
select public.refresh_photo_storage_quota(clock_timestamp(),1000);
select throws_ok($$select public.refresh_photo_storage_quota(clock_timestamp()-interval '30 seconds',0)$$,'40001','PHOTO_QUOTA_SNAPSHOT_STALE','out-of-order refresh cannot overwrite newer usage');
savepoint stale_quota;
update private.photo_storage_quota_snapshot set request_started_at=clock_timestamp()-interval '61 seconds';
select throws_ok($$select pg_temp.admit(2,2,'slot-2')$$,'55000','PHOTO_STORAGE_QUOTA_UNAVAILABLE','61-second provider snapshot fails closed');
rollback to stale_quota;
insert into flow values('operation',pg_temp.begin_upload('admission',1));
select is(pg_temp.begin_upload('admission',1), (select result from flow where label='operation'),'same canonical upload retries operation');
select is((select count(*) from private.photo_upload_admission_bindings),1::bigint,'admission binding is exactly once');
select public.claim_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,repeat('c',64));
insert into flow values('context',public.get_photo_provider_context(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64)));
select ok((select result->'providerFileId'='null'::jsonb from flow where label='context'),'provider context starts without fabricated file identity');
select ok((select result->>'roomNumber'=(select notified_room_number_snapshot from public.cleaning_assignments where id=pg_temp.pid(401)) from flow where label='context'),'folder room comes from notified snapshot');
select throws_ok($$select public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'room','synthetic_root_84','synthetic_drive_folder_84')$$,
  '23514','PHOTO_FOLDER_PARENT_REQUIRED','room folder requires a reserved date parent');
insert into flow values('date_folder',public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'date','synthetic_root_84','synthetic_date_folder_84'));
select is(public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'date','synthetic_root_84','synthetic_losing_date_84')->>'folderId','synthetic_date_folder_84','different date candidate replays immutable scope winner');
insert into flow values('room_folder',public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'room','synthetic_root_84','synthetic_drive_folder_84'));
select is(pg_temp.val('room_folder','parentFolderId'),'synthetic_date_folder_84','room folder is bound to the exact date winner');
select is((select count(*) from private.photo_drive_folder_bindings where operation_id=pg_temp.val('operation','operationId')::uuid),1::bigint,'room reservation creates the durable operation-folder barrier before file identity');
select is(private.maybe_retire_photo_folder((select id from private.photo_drive_folder_identities where provider_folder_id='synthetic_drive_folder_84'),clock_timestamp()),false,'reserved upload barrier prevents room-folder retirement before file identity');
select is(public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'room','synthetic_root_84','synthetic_losing_room_84')->>'folderId','synthetic_drive_folder_84','different room candidate replays immutable scope winner');
select is((select count(*) from private.photo_drive_folder_identities),2::bigint,'losing candidate IDs are never persisted');
select throws_ok($$select public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'date','synthetic_other_root_84','synthetic_next_date_84')$$,
  '23505','PHOTO_PROVIDER_IDENTITY_CONFLICT','existing date cannot change its root parent');
select throws_ok($$select public.reserve_photo_drive_folder(pg_temp.pid(3),pg_temp.pid(903),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'date','synthetic_root_84','synthetic_intruder_84')$$,
  '42501','PHOTO_ACCESS_REQUIRED','folder registry validates operation ownership');
select throws_ok($$select public.reserve_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'synthetic_drive_file_84','synthetic_unregistered_84')$$,
  '23514','PHOTO_FOLDER_PARENT_REQUIRED','file identity cannot bypass the room folder winner');
select public.reserve_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'synthetic_drive_file_84','synthetic_drive_folder_84');
select is((select count(*) from private.photo_drive_identities),1::bigint,'pre-generated file identity persisted before external create');
select is((select count(*) from private.photo_provider_objects where uploaded_at is not null),0::bigint,'identity reservation is not provider success');
select lives_ok($$select public.reserve_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'synthetic_drive_file_84','synthetic_drive_folder_84')$$,'same pre-generated ID replay');
select throws_ok($$select public.reserve_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'synthetic_drive_rotated_84','synthetic_drive_folder_84')$$,'23505','PHOTO_PROVIDER_IDENTITY_CONFLICT','timeout cannot rotate file ID');
select throws_ok($$select public.record_admitted_photo_provider_success(pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'unreserved_drive_file_84',clock_timestamp())$$,'23505','PHOTO_PROVIDER_IDENTITY_CONFLICT','success must match pre-reserved identity');
-- An external file existed before about refresh, but its DB acknowledgement arrives later.
-- Google createdTime must not be mistaken for the DB success observation watermark.
select public.refresh_photo_storage_quota(clock_timestamp(),1000);
select public.record_admitted_photo_provider_success(pg_temp.val('operation','operationId')::uuid,1,repeat('c',64),'synthetic_drive_file_84',
 (select reserved_at from private.photo_drive_identities where operation_id=pg_temp.val('operation','operationId')::uuid));
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','307200','late DB success stays reserved even when Google createdTime predates snapshot');
update flow set result=public.finalize_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','operationId')::uuid,1,repeat('c',64)) where label='operation';
select is(pg_temp.val('operation','status'),'accepted','same actual-upload KST date is accepted normally');
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','307200','acceptance does not prematurely release quota before new about response');
select public.refresh_photo_storage_quota(clock_timestamp(),1100);
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','0','refresh started after provider success absorbs exactly prior bytes');
select is(private.photo_quota_context(clock_timestamp())->>'usageBytes','1100','full provider usage retained after absorption');
select is(public.authorize_photo_read(pg_temp.pid(1),pg_temp.pid(901),pg_temp.val('operation','photoId')::uuid)->>'providerFileId','synthetic_drive_file_84','active exact admin receives internal read context');
select is(public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','photoId')::uuid)->>'photoId',pg_temp.val('operation','photoId'),'current active owner may read accepted photo');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(3),pg_temp.pid(903),pg_temp.val('operation','photoId')::uuid)$$,'42501','PHOTO_ACCESS_REQUIRED','other maid cannot enumerate photo');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(4),pg_temp.pid(904),pg_temp.val('operation','photoId')::uuid)$$,'42501','PHOTO_ACCESS_REQUIRED','developer is not business admin');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(9999))$$,'42501','PHOTO_ACCESS_REQUIRED','unknown ID has uniform access denial');
select private.clear_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),1);
select lives_ok($$select public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','photoId')::uuid)$$,'current clear does not erase accepted historical version read');
savepoint revoked_read;
delete from auth.sessions where id=pg_temp.pid(902);
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','photoId')::uuid)$$,'42501','SESSION_REVOKED','read validates latest Auth session');
select is(public.get_photo_reconciliation_context(pg_temp.val('operation','operationId')::uuid,99,repeat('f',64))->>'status','accepted','worker accepted fact survives user session revoke');
select ok(not public.get_photo_reconciliation_context(pg_temp.val('operation','operationId')::uuid,99,repeat('f',64)) ? 'providerFileId','accepted worker fact never includes deletion locator');
rollback to revoked_read;
savepoint limited_read;
update public.profiles set status='upload_only' where id=pg_temp.pid(2);
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','photoId')::uuid)$$,'42501','PHOTO_ACCESS_REQUIRED','upload-only does not grant original photo read');
rollback to limited_read;
savepoint old_assignment;
update public.cleaning_assignments set is_current=false,ended_at=clock_timestamp() where id=pg_temp.pid(401);
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('operation','photoId')::uuid)$$,'42501','PHOTO_ACCESS_REQUIRED','historical notified access is not current photo-read ownership');
rollback to old_assignment;
select ok(not (select result from flow where label='operation') ?| array['providerFileId','providerFolderId','sha256','sessionId'],'user upload result remains provider-free');
select ok(not exists(select 1 from public.audit_events where after_state::text like '%synthetic_drive%'),'audit contains no provider identity');
select is(jsonb_array_length(public.get_attempt_photo_slots(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501))->'slots'),10,'safe slot projection exposes fixed bounded slot set');
select is(public.get_attempt_photo_slots(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501))#>>'{slots,0,currentRevision}','2','slot projection provides current photo CAS');
select is(public.get_attempt_photo_slots(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501))#>>'{slots,0,uploadStatus}','cleared','clear is separate from missing/history');
select throws_ok($$select public.get_attempt_photo_slots(pg_temp.pid(3),pg_temp.pid(903),pg_temp.pid(501))$$,'42501','PHOTO_ACCESS_REQUIRED','slot projection rejects other maid');
select throws_ok($$select public.get_attempt_photo_slots(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(501))$$,'42501','CAPABILITY_ACCESS_REQUIRED','upload slot projection is not admin impersonation');
select ok(not public.get_attempt_photo_slots(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501))::text like '%synthetic_drive%','slot projection contains no provider metadata');
-- An expired admission with no operation proves external create was never possible; same key cannot renew it.
insert into private.photo_upload_admissions(actor_profile_id,cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,
target_photo_slot_id,expected_photo_revision,idempotency_key_digest,created_at,expires_at,quota_revision)
select pg_temp.pid(2),pg_temp.pid(501),pg_temp.pid(301),pg_temp.pid(401),2,pg_temp.slot(1),2,lpad('999',64,'0'),at_time-interval '10 minutes',at_time-interval '5 minutes',1
from (select clock_timestamp() at_time) anchor;
select throws_ok($$select pg_temp.admit(999,2,'slot-1',2)$$,'55000','PHOTO_ADMISSION_EXPIRED','expired unbound admission cannot renew its key');
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','0','expired pre-provider admission releases no unknown external bytes');
insert into flow values('unknown_admission',pg_temp.admit(20,2,'slot-2'));
insert into flow values('unknown_operation',pg_temp.begin_upload('unknown_admission',20));
select public.claim_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('unknown_operation','operationId')::uuid,repeat('c',64));
select public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('unknown_operation','operationId')::uuid,1,repeat('c',64),'room','synthetic_root_84','synthetic_losing_unknown_room_84');
select public.reserve_photo_provider_identity(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('unknown_operation','operationId')::uuid,1,repeat('c',64),'synthetic_drive_unknown_84','synthetic_drive_folder_84');
update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id=pg_temp.val('unknown_operation','operationId')::uuid;
select throws_ok($$select public.get_photo_provider_context(pg_temp.pid(2),pg_temp.pid(902),pg_temp.val('unknown_operation','operationId')::uuid,1,repeat('c',64))$$,'40001','PHOTO_UPLOAD_FENCE_CONFLICT','post-expiry worker context cannot issue a new create');
select public.reconcile_admitted_photo_upload(pg_temp.val('unknown_operation','operationId')::uuid,repeat('d',64));
select is(public.get_photo_reconciliation_context(pg_temp.val('unknown_operation','operationId')::uuid,2,repeat('d',64))->>'compensationAllowed','false','unknown remote outcome is not deletion permission');
select is(public.get_photo_reconciliation_context(pg_temp.val('unknown_operation','operationId')::uuid,2,repeat('d',64))->>'providerFileId','synthetic_drive_unknown_84','reconciliation retries exact reserved file identity');
select public.refresh_photo_storage_quota(clock_timestamp(),1100);
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','307200','new quota snapshot cannot absorb unknown object bytes');
select public.record_admitted_photo_provider_success(pg_temp.val('unknown_operation','operationId')::uuid,2,repeat('d',64),'synthetic_drive_unknown_84',clock_timestamp());
select is(public.get_photo_reconciliation_context(pg_temp.val('unknown_operation','operationId')::uuid,2,repeat('d',64))->>'compensationAllowed','true','known never-accepted retired object gets fenced cleanup context');
savepoint orphan_eighth_failure;
do $$ begin for i in 1..7 loop update private.photo_orphan_purge_jobs set status='retry',lease_version=lease_version+1,
  next_attempt_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
  where operation_id=pg_temp.val('unknown_operation','operationId')::uuid; end loop; end $$;
insert into flow values('orphan_eighth_claim',public.claim_due_photo_orphan_purges(repeat('a',64),1));
select is(public.settle_photo_orphan_purge(pg_temp.val('unknown_operation','operationId')::uuid,8,repeat('a',64),'retryable','PROVIDER_ERROR')->>'status','blocked','eighth orphan provider failure settles as blocked');
rollback to orphan_eighth_failure;
savepoint orphan_retry_exhausted;
do $$ begin for i in 1..8 loop update private.photo_orphan_purge_jobs set status='retry',lease_version=lease_version+1,
  next_attempt_at=clock_timestamp()-interval '1 second',lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
  where operation_id=pg_temp.val('unknown_operation','operationId')::uuid; end loop; end $$;
insert into flow values('orphan_retry_blocked',public.claim_due_photo_orphan_purges(repeat('5',64),1));
select is((select result->>'blocked' from flow where label='orphan_retry_blocked'),'1','retry-exhausted orphan claim reports its bounded blocked transition');
select is((select jsonb_array_length(result->'items') from flow where label='orphan_retry_blocked'),0,'retry-exhausted orphan is not returned as provider work');
select is((select status from private.photo_orphan_purge_jobs where operation_id=pg_temp.val('unknown_operation','operationId')::uuid),'blocked','retry-exhausted orphan becomes durable blocked');
rollback to orphan_retry_exhausted;
select public.settle_admitted_photo_compensation(pg_temp.val('unknown_operation','operationId')::uuid,2,repeat('d',64),'deleted');
select is(private.photo_quota_context(clock_timestamp())->>'pendingBytes','0','confirmed compensation permits conservative reservation release');
-- Actual #7B upload-only capability opens upload metadata only, never the original-photo read route.
select private.manage_cleaning_attempt_lifecycle_at(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(502),1,pg_temp.pid(402),2,
 (select account_lifecycle_version from public.profiles where id=pg_temp.pid(3)),
 'allow_upload','{}','DEACTIVATION_UPLOAD_ONLY','photo84-allow-upload',repeat('e',64),null);
select is((select status::text from public.profiles where id=pg_temp.pid(3)),'upload_only','real lifecycle established limited state');
select is(jsonb_array_length(public.get_attempt_photo_slots(pg_temp.pid(3),pg_temp.pid(903),pg_temp.pid(502))->'slots'),10,'limited upload capability can discover only its own slot IDs');
insert into flow values('limited_admission',public.admit_photo_upload(pg_temp.pid(3),pg_temp.pid(903),pg_temp.pid(502),pg_temp.pid(402),2,pg_temp.slot(2),0,repeat('e',64)));
select is(pg_temp.val('limited_admission','reservedBytes'),'307200','limited upload capability passes predecode admission');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(3),pg_temp.pid(903),pg_temp.val('operation','photoId')::uuid)$$,'42501','PHOTO_ACCESS_REQUIRED','real upload-only grant still never authorizes original read');
insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
select id,clock_timestamp(),'ACCOUNT_CHANGED',pg_temp.pid(1) from private.attempt_capability_grants where attempt_id=pg_temp.pid(502) and kind='upload_submit';
select throws_ok($$select public.get_attempt_photo_slots(pg_temp.pid(3),pg_temp.pid(903),pg_temp.pid(502))$$,'42501','CAPABILITY_ACCESS_REQUIRED','slot RPC revalidates capability revocation');
select lives_ok($$select public.record_authorization_denial(pg_temp.pid(3),'edge.authorization.photos','PHOTO_ACCESS_REQUIRED')$$,'limited denied photo read uses bounded source-controlled activity');
select is((select count(*) from private.actor_authorization_denial_aggregates where actor_profile_id=pg_temp.pid(3) and source='edge.authorization.photos'),1::bigint,'photo denial stored only as aggregate');
select throws_ok($$select public.record_authorization_denial(pg_temp.pid(3),'edge.authorization.rooms','PHOTO_ACCESS_REQUIRED')$$,'22023','INVALID_ACTIVITY_ACTOR','limited photo activity exception does not broaden general source permissions');
savepoint decode_rate;
update private.photo_upload_admission_limits set occurrence_count=30,minute_started_at=date_trunc('minute',clock_timestamp()) where actor_profile_id=pg_temp.pid(2);
select throws_ok($$select pg_temp.admit(1)$$,'54000','PHOTO_UPLOAD_RATE_LIMITED','same-key replay cannot bypass bounded decode rate');
select is((select occurrence_count from private.photo_upload_admission_limits where actor_profile_id=pg_temp.pid(2)),30,'rejected decode leaves saturation unchanged');
rollback to decode_rate;
-- A genuine historical model fixture has work before upload, immutable accepted metadata,
-- and no #84 admission (legacy acceptance); no protected row/trigger is rewritten.
select pg_temp.fixture(3,2,interval '9 days');
create function pg_temp.historical_photo(n integer,p_upload_age interval) returns uuid language plpgsql as $$
declare oid uuid:=pg_temp.pid(7000+n); object_id uuid:=pg_temp.pid(7100+n); photo uuid:=pg_temp.pid(7200+n);
  uploaded timestamptz:=clock_timestamp()-p_upload_age; slot uuid:=pg_temp.slot(3,'slot-'||n);
begin
  insert into private.photo_upload_operations(id,actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,cleaning_target_id,
    assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,sha256,mime_type,size_bytes,created_at)
  values(oid,pg_temp.pid(2),lpad((7000+n)::text,64,'0'),repeat('a',64),pg_temp.pid(503),pg_temp.pid(303),pg_temp.pid(403),2,slot,0,
    repeat('a',64),'image/jpeg',100,uploaded-interval '1 minute');
  insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
    values(object_id,oid,'synthetic_historical_drive_'||n,uploaded,uploaded+interval '168 hours');
  insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,status)
    values(oid,pg_temp.pid(503),slot,pg_temp.pid(2),'provider_succeeded');
  insert into private.attempt_photo_versions(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,validation_status,sha256,mime_type,size_bytes,uploaded_at,purge_after)
    values(photo,pg_temp.pid(503),pg_temp.pid(303),slot,1,'verified',repeat('a',64),'image/jpeg',100,uploaded,uploaded+interval '168 hours');
  insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id) values(oid,object_id,photo);
  update private.photo_upload_states set status='accepted',revision=revision+1 where operation_id=oid;
  return photo;
end; $$;
select pg_temp.historical_photo(1,interval '7 days 1 second');
select ok(exists(select 1 from private.photo_upload_acceptances where photo_version_id=pg_temp.pid(7201)),'expiry fixture is truly accepted history');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(7201))$$,'42501','PHOTO_ACCESS_REQUIRED','even exact admin cannot read after exactly seven-day retention');
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(7201))$$,'42501','PHOTO_ACCESS_REQUIRED','current owner does not extend historical retention');
insert into private.attempt_photo_purge_states(photo_version_id,purged_at) values(pg_temp.pid(7201),clock_timestamp());
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(7201))$$,'42501','PHOTO_ACCESS_REQUIRED','purged accepted history remains unreadable');
select pg_temp.historical_photo(2,interval '7 days'-interval '2 seconds');
select lives_ok($$select public.authorize_photo_read(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(7202))$$,'legacy accepted photo is readable before exact seven-day boundary');
select pg_sleep(2.1);
select throws_ok($$select public.authorize_photo_read(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(7202))$$,'42501','PHOTO_ACCESS_REQUIRED','fresh server clock revokes read as seven-day boundary is crossed');
savepoint accepted_eighth_failure;
do $$ begin for i in 1..7 loop update private.photo_purge_jobs set status='retry',lease_version=lease_version+1,
  next_attempt_at=clock_timestamp()-interval '1 day',lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
  where object_id=pg_temp.pid(7102); end loop; end $$;
insert into flow values('accepted_eighth_claim',public.claim_due_photo_purges(repeat('b',64),1));
select is(public.settle_photo_purge(pg_temp.pid(7102),8,repeat('b',64),'retryable','PROVIDER_ERROR')->>'status','blocked','eighth accepted provider failure settles as blocked');
rollback to accepted_eighth_failure;
savepoint accepted_retry_exhausted;
do $$ begin for i in 1..8 loop update private.photo_purge_jobs set status='retry',lease_version=lease_version+1,
  next_attempt_at=clock_timestamp()-interval '1 day',lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1
  where object_id=pg_temp.pid(7102); end loop; end $$;
insert into flow values('accepted_retry_blocked',public.claim_due_photo_purges(repeat('4',64),1));
select is((select result->>'blocked' from flow where label='accepted_retry_blocked'),'1','retry-exhausted accepted claim reports its bounded blocked transition');
select is((select jsonb_array_length(result->'items') from flow where label='accepted_retry_blocked'),0,'retry-exhausted accepted photo is not returned as provider work');
select is((select status from private.photo_purge_jobs where object_id=pg_temp.pid(7102)),'blocked','retry-exhausted accepted photo becomes durable blocked');
select lives_ok($$select public.record_photo_purge_heartbeat('succeeded',0,0,0,0,0,0,0,null)$$,'a prior succeeded heartbeat can coexist with newly discovered blocked backlog');
select is(public.get_developer_photo_purge_status(pg_temp.pid(4))->>'status','degraded','blocked backlog prevents a false-green developer status');
rollback to accepted_retry_exhausted;
insert into flow values('purge_claim',public.claim_due_photo_purges(repeat('9',64),1));
select is((select result#>>'{items,0,objectId}' from flow where label='purge_claim'),pg_temp.pid(7101)::text,'oldest accepted object is claimed from the DB due clock');
select is(public.get_photo_purge_context(pg_temp.pid(7101),1,repeat('9',64))->>'providerFileId','synthetic_historical_drive_1','fenced context exposes only the exact due provider identity');
select is(public.settle_photo_purge(pg_temp.pid(7101),1,repeat('9',64),'not_found')->>'status','purged','provider 404 converges as logical purge');
select is((select provider_locator from private.photo_provider_objects where id=pg_temp.pid(7101)),null,'accepted purge clears raw locator');
select ok((select uploaded_at is not null and purge_after=uploaded_at+interval '168 hours' from private.photo_provider_objects where id=pg_temp.pid(7101)),'accepted purge preserves immutable upload and retention clocks');
select is((select count(*) from private.photo_provider_identity_tombstones where object_id=pg_temp.pid(7101)),1::bigint,'accepted purge preserves a private locator digest tombstone');
select is((select count(*) from private.photo_cleanup_events where object_id=pg_temp.pid(7101) and state='purged'),1::bigint,'callback replay emits one terminal cleanup event');
select lives_ok($$select public.settle_photo_purge(pg_temp.pid(7101),1,repeat('9',64),'not_found')$$,'same fenced 404 callback replays without a second logical purge');
select is((select count(*) from private.photo_cleanup_events where object_id=pg_temp.pid(7101) and state='purged'),1::bigint,'terminal callback replay remains exactly once');
-- Historical 23:59 reservation -> 00:00 provider create, while the worker has a
-- fresh claim now. Immutable rows are inserted once; no protected history is edited.
do $$ declare midnight timestamptz:=date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  reserved timestamptz; slot uuid:=pg_temp.slot(3,'slot-3');
begin
  reserved:=midnight-interval '1 minute';
  insert into private.photo_upload_admissions(id,actor_profile_id,cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,
    target_photo_slot_id,expected_photo_revision,idempotency_key_digest,created_at,expires_at,quota_revision)
    values(pg_temp.pid(7300),pg_temp.pid(2),pg_temp.pid(503),pg_temp.pid(303),pg_temp.pid(403),2,slot,0,repeat('7',64),reserved,reserved+interval '5 minutes',1);
  insert into private.photo_upload_operations(id,actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,cleaning_target_id,
    assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,sha256,mime_type,size_bytes,created_at)
    values(pg_temp.pid(7301),pg_temp.pid(2),repeat('7',64),repeat('a',64),pg_temp.pid(503),pg_temp.pid(303),pg_temp.pid(403),2,slot,0,repeat('a',64),'image/jpeg',100,reserved);
  insert into private.photo_provider_objects(id,operation_id) values(pg_temp.pid(7302),pg_temp.pid(7301));
  insert into private.photo_upload_states(operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,status)
    values(pg_temp.pid(7301),pg_temp.pid(503),slot,pg_temp.pid(2),'reserved');
  insert into private.photo_upload_admission_bindings(admission_id,operation_id,bound_at) values(pg_temp.pid(7300),pg_temp.pid(7301),reserved);
  insert into private.photo_drive_identities(object_id,operation_id,provider_file_id,provider_folder_id,upload_date,room_number,reserved_at)
    select pg_temp.pid(7302),pg_temp.pid(7301),'synthetic_midnight_file_84','synthetic_previous_room_84',
      (reserved at time zone 'Asia/Seoul')::date,notified_room_number_snapshot,reserved from public.cleaning_assignments where id=pg_temp.pid(403);
end; $$;
select public.claim_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(7301),repeat('c',64));
select public.refresh_photo_storage_quota(clock_timestamp(),1100);
insert into flow values('previous_date_folder',public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(7301),1,repeat('c',64),'date','synthetic_root_84','synthetic_previous_date_84'));
insert into flow values('previous_room_folder',public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(7301),1,repeat('c',64),'room','synthetic_root_84','synthetic_previous_room_84'));
select isnt(pg_temp.val('previous_date_folder','folderId'),pg_temp.val('date_folder','folderId'),'different upload dates have isolated date-folder identities');
select is(pg_temp.val('previous_room_folder','parentFolderId'),'synthetic_previous_date_84','historical room scope resolves its own date parent');
insert into private.photo_drive_folder_identities(upload_date,scope_room_number,provider_folder_id,parent_folder_id,parent_registry_id)
select upload_date,'999','synthetic_other_room_84',provider_folder_id,id from private.photo_drive_folder_identities where provider_folder_id='synthetic_date_folder_84';
select is((select count(*) from private.photo_drive_folder_identities where parent_folder_id='synthetic_date_folder_84'),2::bigint,'different room scopes do not share a folder ID');
select throws_ok($$insert into private.photo_drive_folder_identities(upload_date,scope_room_number,provider_folder_id,parent_folder_id,parent_registry_id)
  select upload_date,'998','synthetic_wrong_parent_84','synthetic_previous_date_84',id from private.photo_drive_folder_identities where provider_folder_id='synthetic_date_folder_84'$$,
  '23514','PHOTO_FOLDER_PARENT_REQUIRED','room registry rejects parent/date identity mismatch');
select lives_ok($$select public.record_admitted_photo_provider_success(pg_temp.pid(7301),1,repeat('c',64),'synthetic_midnight_file_84',
  date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')$$,'midnight callback preserves known object and true Google createdTime');
create temp table before_midnight_finalize as select (select count(*) from private.attempt_photo_versions) photos,
  (select count(*) from private.attempt_photo_current) pointers,(select count(*) from public.audit_events) audits;
select throws_ok($$select public.finalize_admitted_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(7301),1,repeat('c',64))$$,
  '55000','PHOTO_PROVIDER_DATE_MISMATCH','23:59 folder reservation cannot accept next-day 00:00 create');
select ok(not exists(select 1 from private.photo_upload_acceptances where operation_id=pg_temp.pid(7301)),'cross-day candidate has no acceptance');
select ok((select photos=(select count(*) from private.attempt_photo_versions) and pointers=(select count(*) from private.attempt_photo_current)
  and audits=(select count(*) from public.audit_events) from before_midnight_finalize),'cross-day rejection creates no photo, pointer or audit');
select is((select uploaded_at from private.photo_provider_objects where id=pg_temp.pid(7302)),
  date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul','cross-day rejection does not rewrite Google upload clock');
update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id=pg_temp.pid(7301);
select is(public.reconcile_admitted_photo_upload(pg_temp.pid(7301),repeat('d',64))->>'status','compensation_pending','known cross-day candidate follows fenced compensation only');
select is(public.settle_admitted_photo_compensation(pg_temp.pid(7301),2,repeat('d',64),'deleted')->>'status','compensated','cross-day candidate can close without acceptance or folder move');
select is((select status from private.photo_orphan_purge_jobs where operation_id=pg_temp.pid(7301)),'purged','never-accepted synchronous compensation converges into its separate durable ledger');
select ok((select provider_locator is null and uploaded_at is not null from private.photo_provider_objects where operation_id=pg_temp.pid(7301)),'orphan compensation clears locator but preserves provider observation clock');
select is((select count(*) from private.photo_folder_purge_jobs j join private.photo_drive_folder_identities f on f.id=j.folder_registry_id where f.scope_room_number<>''),1::bigint,'past room folder retires only after the operation becomes terminal');
insert into flow values('room_purge_claim',public.claim_due_photo_folder_purges(repeat('8',64),1));
select is(public.get_photo_folder_purge_context((select (result#>>'{items,0,folderRegistryId}')::uuid from flow where label='room_purge_claim'),1,repeat('8',64))->>'scope','room','room folder is prepared before its date parent');
select is(public.settle_photo_folder_purge((select (result#>>'{items,0,folderRegistryId}')::uuid from flow where label='room_purge_claim'),1,repeat('8',64),'not_found')->>'status','purged','missing room folder is idempotent cleanup success');
insert into flow values('date_purge_claim',public.claim_due_photo_folder_purges(repeat('6',64),1));
select is(public.get_photo_folder_purge_context((select (result#>>'{items,0,folderRegistryId}')::uuid from flow where label='date_purge_claim'),1,repeat('6',64))->>'scope','date','date folder is claimable only after child room retirement');
select is(public.settle_photo_folder_purge((select (result#>>'{items,0,folderRegistryId}')::uuid from flow where label='date_purge_claim'),1,repeat('6',64),'not_found')->>'status','purged','missing date folder is idempotent cleanup success');
savepoint folder_eighth_failure;
insert into private.photo_drive_folder_identities(id,upload_date,scope_room_number,provider_folder_id,parent_folder_id)
  values(pg_temp.pid(7401),(clock_timestamp() at time zone 'Asia/Seoul')::date-42,'','synthetic_retry_date_85','synthetic_root_84');
insert into private.photo_folder_purge_jobs(folder_registry_id,status,lease_version,next_attempt_at)
  values(pg_temp.pid(7401),'retry',7,clock_timestamp()-interval '1 day');
insert into flow values('folder_eighth_claim',public.claim_due_photo_folder_purges(repeat('c',64),1));
select is(public.settle_photo_folder_purge(pg_temp.pid(7401),8,repeat('c',64),'retryable','PROVIDER_ERROR')->>'status','blocked','eighth folder provider failure settles as blocked');
rollback to folder_eighth_failure;
savepoint folder_retry_exhausted;
insert into private.photo_drive_folder_identities(id,upload_date,scope_room_number,provider_folder_id,parent_folder_id)
  values(pg_temp.pid(7401),(clock_timestamp() at time zone 'Asia/Seoul')::date-42,'','synthetic_retry_date_85','synthetic_root_84');
insert into private.photo_folder_purge_jobs(folder_registry_id,status,lease_version,next_attempt_at)
  values(pg_temp.pid(7401),'retry',8,clock_timestamp()-interval '1 day');
insert into flow values('folder_retry_blocked',public.claim_due_photo_folder_purges(repeat('3',64),1));
select is((select result->>'blocked' from flow where label='folder_retry_blocked'),'1','retry-exhausted folder claim reports its bounded blocked transition');
select is((select jsonb_array_length(result->'items') from flow where label='folder_retry_blocked'),0,'retry-exhausted folder is not returned as provider work');
select is((select status from private.photo_folder_purge_jobs where folder_registry_id=pg_temp.pid(7401)),'blocked','retry-exhausted folder becomes durable blocked');
rollback to folder_retry_exhausted;
select throws_ok($$select public.reserve_photo_drive_folder(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(7301),2,repeat('d',64),'room','synthetic_root_84','synthetic_recreate_85')$$,
  '55000','PHOTO_OPERATION_TERMINAL','terminal operation cannot reopen a retired folder scope');
select lives_ok($$select public.record_photo_purge_heartbeat('succeeded',0,0,0,0,0,0,0,null)$$,'bounded worker heartbeat accepts aggregate-only status');
select is(public.get_developer_photo_purge_status(pg_temp.pid(4))#>>'{backlog,blocked}','0','developer projection exposes bounded counts without locators');
select ok(not public.get_developer_photo_purge_status(pg_temp.pid(4))::text like '%synthetic_%','developer purge status never exposes provider locators');
select throws_ok($$update private.photo_drive_identities set provider_folder_id='synthetic_other_folder'$$,'55000','PHOTO_STORAGE_IMMUTABLE','reserved parent cannot silently change');
select throws_ok($$update private.photo_drive_folder_identities set provider_folder_id='synthetic_overwrite_84'$$,'55000','PHOTO_STORAGE_IMMUTABLE','folder winner UPDATE is forbidden');
select throws_ok($$delete from private.photo_drive_folder_identities$$,'55000','PHOTO_STORAGE_IMMUTABLE','folder winner DELETE is forbidden');
select throws_ok($$delete from private.photo_upload_admissions$$,'55000','PHOTO_STORAGE_IMMUTABLE','admission receipt cannot be deleted to reset quota/key');
select throws_ok($$update private.photo_upload_admission_bindings set bound_at=clock_timestamp()$$,'55000','PHOTO_STORAGE_IMMUTABLE','quota binding immutable');
select ok(relrowsecurity,'RLS enabled '||relname) from pg_class where oid=any(array[
'private.photo_storage_quota_snapshot'::regclass,'private.photo_upload_admissions'::regclass,'private.photo_upload_admission_bindings'::regclass,
'private.photo_upload_admission_limits'::regclass,'private.photo_drive_identities'::regclass,'private.photo_drive_folder_identities'::regclass,
'private.photo_purge_jobs'::regclass,'private.photo_orphan_purge_jobs'::regclass,'private.photo_folder_purge_jobs'::regclass,
'private.photo_drive_folder_bindings'::regclass,'private.photo_cleanup_events'::regclass,'private.photo_provider_identity_tombstones'::regclass,
'private.photo_quota_pending'::regclass,'private.photo_purge_heartbeat'::regclass]);
select ok(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'no raw grant '||r||' '||t)
from unnest(array['anon','authenticated','service_role'])r cross join unnest(array[
'private.photo_storage_quota_snapshot','private.photo_upload_admissions','private.photo_upload_admission_bindings','private.photo_upload_admission_limits','private.photo_drive_identities','private.photo_drive_folder_identities',
'private.photo_purge_jobs','private.photo_orphan_purge_jobs','private.photo_folder_purge_jobs','private.photo_drive_folder_bindings','private.photo_cleanup_events','private.photo_provider_identity_tombstones','private.photo_quota_pending','private.photo_purge_heartbeat'])t;
create temp table new_functions(signature text);
insert into new_functions values
('public.refresh_photo_storage_quota(timestamptz,bigint)'),
('public.admit_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text)'),
('public.begin_admitted_photo_upload(uuid,uuid,uuid,text,text,integer,text,text)'),
('public.get_admitted_photo_upload(uuid,uuid,uuid)'),('public.claim_admitted_photo_upload(uuid,uuid,uuid,text)'),
('public.finalize_admitted_photo_upload(uuid,uuid,uuid,integer,text)'),('public.get_photo_provider_context(uuid,uuid,uuid,integer,text)'),
('public.reserve_photo_provider_identity(uuid,uuid,uuid,integer,text,text,text)'),('public.record_admitted_photo_provider_success(uuid,integer,text,text,timestamptz)'),
('public.reconcile_admitted_photo_upload(uuid,text)'),('public.settle_admitted_photo_compensation(uuid,integer,text,text)'),
('public.get_photo_reconciliation_context(uuid,integer,text)'),('public.authorize_photo_read(uuid,uuid,uuid)');
insert into new_functions values('public.get_attempt_photo_slots(uuid,uuid,uuid)');
insert into new_functions values('public.reserve_photo_drive_folder(uuid,uuid,uuid,integer,text,text,text,text)');
insert into new_functions values
('public.claim_due_photo_purges(text,integer)'),('public.get_photo_purge_context(uuid,integer,text)'),
('public.settle_photo_purge(uuid,integer,text,text,text)'),('public.claim_due_photo_orphan_purges(text,integer)'),
('public.get_photo_orphan_purge_context(uuid,integer,text)'),('public.settle_photo_orphan_purge(uuid,integer,text,text,text)'),
('public.claim_due_photo_folder_purges(text,integer)'),('public.get_photo_folder_purge_context(uuid,integer,text)'),
('public.settle_photo_folder_purge(uuid,integer,text,text,text)'),
('public.record_photo_purge_heartbeat(text,integer,integer,integer,integer,integer,integer,integer,text)'),
('public.get_developer_photo_purge_status(uuid)');
select ok(not has_function_privilege(r,signature,'EXECUTE'),'no public/inherited EXECUTE '||r||' '||signature) from new_functions cross join unnest(array['anon','authenticated'])r;
select ok(has_function_privilege('service_role',signature,'EXECUTE'),'narrow service RPC '||signature) from new_functions;
set local role authenticated;
select throws_ok($$select * from private.photo_drive_identities$$,'42501',null,'Data API cannot expose raw provider IDs');
select throws_ok($$select public.authorize_photo_read(null,null,null)$$,'42501',null,'authenticated cannot spoof RPC actor');
reset role;
set local role service_role;
select throws_ok($$select public.begin_photo_upload(null,null,null,null,null,null,null,null,null,null,null,null)$$,'42501',null,'legacy begin cannot bypass quota');
select throws_ok($$select * from private.photo_storage_quota_snapshot$$,'42501',null,'service cannot directly mutate/read quota projection');
reset role;
set constraints all immediate;
select * from finish();
rollback;
