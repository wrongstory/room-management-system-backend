begin;
select no_plan();
create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
 select ('83000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.pid(100+n) from generate_series(1,4)n;
select public.bootstrap_first_developer_profile(pg_temp.pid(4),pg_temp.pid(104),'photo developer','photo developer','0030','photo-bootstrap-hash','photo-bootstrap-key');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.pid(n),pg_temp.pid(100+n),'photo-'||n,'photo-'||n,'photo-'||n,'photo-'||n,0,
 case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,3)n;
create function pg_temp.slots(n integer,p_tv boolean default true) returns jsonb language sql immutable as $$
 select jsonb_agg(jsonb_build_object('slotKey',case when p_tv and i=1 then 'tv-on' else 'slot-'||i end,
  'required',i<n,'displayOrder',i-1,'sectionKey','synthetic-section','label','합성 사진','description','정책 seed 아님',
  'instanceNumber',1,'instanceCount',1) order by i)
 from generate_series(1,n)i
$$;
create function pg_temp.snapshot(v integer,n integer,p_tv boolean default true,p_type text default 'standard') returns jsonb language sql immutable as $$
 select jsonb_build_object('templateVersionId',pg_temp.pid(200),'version',v,'roomTypeCode',p_type,'cleaningKind','checkout','slots',pg_temp.slots(n,p_tv))
$$;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.pid(200),id,'additional',7,'published',1,pg_temp.slots(10,false),pg_temp.pid(1) from public.room_types where code='standard';
create function pg_temp.photo_fixture(n integer,p_maid integer default 2,p_legacy boolean default false,p_notified boolean default true)
returns void language plpgsql as $$
declare r public.rooms; snapshot jsonb;
begin
 select * into r from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset n limit 1;
 snapshot:=case when p_legacy then jsonb_build_object('id',pg_temp.pid(999),'version',1,'photoSlots','[]'::jsonb)
  else jsonb_build_object('id',pg_temp.pid(200),'version',7,'photoSlots',pg_temp.slots(10,false),'durationMinutes',1) end;
 insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
 values(pg_temp.pid(300+n),r.id,'additional','manual_room_request','photo-target-'||n,current_date,current_date,
  case when p_notified then 'notified' else 'draft_assigned' end::public.cleaning_target_status,2,
  jsonb_build_object('code','standard'),10000,snapshot,pg_temp.pid(1));
 insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
 values(pg_temp.pid(400+n),pg_temp.pid(300+n),pg_temp.pid(p_maid),n+1,2,case when p_notified then clock_timestamp()-interval '2 hours' end,pg_temp.pid(1));
 insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,
  template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
 values(pg_temp.pid(500+n),pg_temp.pid(300+n),pg_temp.pid(400+n),pg_temp.pid(p_maid),1,'field_completed',2,
  snapshot,jsonb_build_object('roomId',r.id),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour');
end; $$;

select pg_temp.photo_fixture(1);
select pg_temp.photo_fixture(2,3);
insert into auth.sessions(id,user_id) select pg_temp.pid(900+n),pg_temp.pid(100+n) from generate_series(1,3)n;
create function pg_temp.slot(n integer,k text default 'slot-1') returns uuid language sql stable as $$
 select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.pid(300+n) and slot_key=k
$$;
create function pg_temp.upload(n integer,k integer,rev bigint default 0,p_actor integer default 2,p_slot text default 'slot-1')
returns jsonb language sql as $$
 select public.begin_photo_upload(pg_temp.pid(p_actor),pg_temp.pid(900+p_actor),pg_temp.pid(500+n),pg_temp.pid(400+n),2,
 pg_temp.slot(n,p_slot),rev,repeat('a',64),'image/jpeg',100,lpad(k::text,64,'0'),repeat('b',64))
$$;
create temp table operations(label text primary key,result jsonb);
insert into operations values('first',pg_temp.upload(1,1));
create function pg_temp.op(label text) returns uuid language sql stable as $$ select (result->>'operationId')::uuid from operations where operations.label=$1 $$;
select is((select result->>'status' from operations where label='first'),'reserved','begin reserves operation only');
select is(pg_temp.upload(1,1)->>'operationId',pg_temp.op('first')::text,'same scoped digest replays operation');
select is((select count(*) from private.photo_upload_operations),1::bigint,'retry has one operation');
select is((select count(*) from private.photo_provider_objects),1::bigint,'one stable provider object identity');
select is((select count(*) from private.attempt_photo_versions),0::bigint,'no photo without provider success');
select throws_ok($$select pg_temp.upload(1,1,1)$$,'23505','IDEMPOTENCY_KEY_REUSED','same hash but changed actual payload rejected');
select throws_ok($$select pg_temp.upload(1,2)$$,'55000','PHOTO_UPLOAD_IN_FLIGHT','one unfinished slot');
select throws_ok($$select pg_temp.upload(1,1,0,3)$$,'42501','PHOTO_ACCESS_REQUIRED','other maid rejected');
select throws_ok($$select pg_temp.upload(1,1,0,1)$$,'42501','CAPABILITY_ACCESS_REQUIRED','admin cannot fabricate maid upload');
select is(public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),repeat('c',64))->>'leaseVersion','1','first claim has fence one');
create temp table first_claim as select public.get_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first')) result;
select is(public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),repeat('c',64)),
 (select result from first_claim),'same claimant does not extend lease');
select throws_ok($$select public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),repeat('d',64))$$,'55000','PHOTO_UPLOAD_IN_FLIGHT','different worker cannot share active fence');
select throws_ok($$select public.finalize_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),1,repeat('c',64))$$,'55000','PHOTO_PROVIDER_RESULT_REQUIRED','cannot finalize unacknowledged object');
select throws_ok($$select public.record_photo_provider_success(pg_temp.op('first'),1,repeat('d',64),'synthetic_drive_one',clock_timestamp())$$,'40001','PHOTO_UPLOAD_FENCE_CONFLICT','provider callback verifies claimant identity');
select is(public.record_photo_provider_success(pg_temp.op('first'),1,repeat('c',64),'synthetic_drive_one',clock_timestamp())->>'status','provider_succeeded','trusted synthetic provider success recorded');
select throws_ok($$select public.reconcile_photo_upload(pg_temp.op('first'),repeat('d',64))$$,'55000','PHOTO_UPLOAD_IN_FLIGHT','live upload cannot be retired by cleanup');
select is((select count(*) from private.attempt_photo_versions),0::bigint,'provider acknowledgement alone is not business acceptance');
-- Audit failure must roll back photo/current/acceptance/state atomically.
create function pg_temp.fail_photo_audit() returns trigger language plpgsql as $$ begin
 if new.event_type='photo.upload_accepted' then raise exception 'synthetic audit failure'; end if; return new; end $$;
create trigger synthetic_photo_audit before insert on public.audit_events for each row execute function pg_temp.fail_photo_audit();
select throws_ok($$select public.finalize_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),1,repeat('c',64))$$,'P0001','synthetic audit failure','audit failure aborts whole finalize');
select is((select count(*) from private.attempt_photo_versions),0::bigint,'failed finalize leaves no photo');
select is((select count(*) from private.attempt_photo_current),0::bigint,'failed finalize leaves no pointer');
select is((select count(*) from private.photo_upload_acceptances),0::bigint,'failed finalize leaves no accepted marker');
drop trigger synthetic_photo_audit on public.audit_events;
update operations set result=public.finalize_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),1,repeat('c',64)) where label='first';
select is((select result->>'status' from operations where label='first'),'accepted','finalize accepts photo');
select is(public.finalize_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'),1,repeat('c',64)),(select result from operations where label='first'),'lost response replay same logical result');
select is((select count(*) from private.attempt_photo_versions),1::bigint,'finalize replay creates exactly one photo');
select is((select count(*) from public.audit_events where event_type='photo.upload_accepted'),1::bigint,'exactly one business audit');
select ok((select purge_after=uploaded_at+interval '168 hours' from private.attempt_photo_versions),'first successful upload clock fixed at exactly seven days');
select ok(not ((select result from operations where label='first')::text like '%synthetic_drive%'),'public-safe DTO excludes provider locator');
select ok(not ((select result from operations where label='first') ?| array['requestHash','sha256','sessionId','idempotencyKey','idempotencyKeyDigest','leaseClaimDigest']),'safe result excludes credentials/hashes/claim identity');
select is((select count(*) from public.list_developer_audit_events(pg_temp.pid(4),array['photo.upload_accepted'])),1::bigint,'developer audit allowlist includes accepted photo');
select ok((select summary ?& array['photoId','targetSlotId','photoVersion','uploadedAt','purgeAfter'] and not summary ?| array['providerLocator','sha256','requestHash']
 from public.list_developer_audit_events(pg_temp.pid(4),array['photo.upload_accepted'])),'developer summary is explicitly allowlisted');
select throws_ok($$select public.settle_photo_compensation(pg_temp.op('first'),1,repeat('c',64),'deleted')$$,'55000','PHOTO_OPERATION_ACCEPTED','accepted is never compensation');
select is(public.reconcile_photo_upload(pg_temp.op('first'),repeat('d',64))->>'status','accepted','worker sees accepted without user session');
select private.clear_attempt_photo(pg_temp.pid(2),pg_temp.pid(501),pg_temp.slot(1),1);
select is(public.reconcile_photo_upload(pg_temp.op('first'),repeat('d',64))->>'compensationAllowed','false','clear/current absence does not erase accepted history');
insert into operations values('second',pg_temp.upload(1,2,2));
select public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('second'),repeat('c',64));
select throws_ok($$select public.record_photo_provider_success(pg_temp.op('second'),1,repeat('c',64),'synthetic_drive_one',clock_timestamp())$$,'23505','PHOTO_PROVIDER_IDENTITY_CONFLICT','same provider locator cannot be rebound to another operation');
select public.record_photo_provider_success(pg_temp.op('second'),1,repeat('c',64),'synthetic_drive_two',clock_timestamp());
-- Owner-only local clock fixture: no production/test-mode RPC.
update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id=pg_temp.op('second');
select is(public.reconcile_photo_upload(pg_temp.op('second'),repeat('d',64))->>'status','compensation_pending','explicit retirement fence makes never-accepted known object eligible');
select throws_ok($$select public.finalize_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('second'),1,repeat('c',64))$$,'55000','PHOTO_OPERATION_TERMINAL','cleanup retirement prevents delayed finalize');
select throws_ok($$select public.settle_photo_compensation(pg_temp.op('second'),1,repeat('c',64),'deleted')$$,'40001','PHOTO_UPLOAD_FENCE_CONFLICT','old upload claimant cannot settle cleanup');
select is(public.settle_photo_compensation(pg_temp.op('second'),2,repeat('d',64),'not_found')->>'status','compensated','404 treated as compensation success');
select is(public.settle_photo_compensation(pg_temp.op('second'),2,repeat('d',64),'not_found')->>'status','compensated','settle replay creates no duplicate logical effect');
insert into operations values('unknown',pg_temp.upload(1,3,2));
select is(public.reconcile_photo_upload(pg_temp.op('unknown'),repeat('d',64))->>'status','reconciliation_pending','unknown provider result remains a reconciliation case');
select is(public.reconcile_photo_upload(pg_temp.op('unknown'),repeat('d',64))->>'compensationAllowed','false','unknown is never delete permission');
select throws_ok($$select public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('unknown'),repeat('c',64))$$,'55000','PHOTO_OPERATION_TERMINAL','retired unknown cannot restart business upload');
select is(public.record_photo_provider_success(pg_temp.op('unknown'),1,repeat('d',64),'synthetic_drive_unknown',clock_timestamp())->>'status','compensation_pending','independent known provider evidence can settle retired unknown candidate');
-- Existing account/session transitions never make a previously accepted object look orphaned.
delete from auth.sessions where id=pg_temp.pid(902);
select throws_ok($$select public.get_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('first'))$$,'42501','SESSION_REVOKED','user replay requires latest session');
select is(public.reconcile_photo_upload(pg_temp.op('first'),repeat('d',64))->>'status','accepted','worker accepted history survives session revocation');
insert into auth.sessions(id,user_id) values(pg_temp.pid(902),pg_temp.pid(102));
update public.profiles set status='inactive' where id=pg_temp.pid(2);
select throws_ok($$select pg_temp.upload(1,9,2)$$,'42501','CAPABILITY_ACCESS_REQUIRED','inactive owner cannot open operation');
select is(public.reconcile_photo_upload(pg_temp.op('first'),repeat('d',64))->>'compensationAllowed','false','account deactivation never turns accepted into orphan');
update public.profiles set status='active' where id=pg_temp.pid(2);
-- Same raw digest across actors is an independent scope.
insert into operations values('other',pg_temp.upload(2,1,0,3));
select isnt(pg_temp.op('other'),pg_temp.op('first'),'different actor digest scope independent');
select public.claim_photo_upload(pg_temp.pid(3),pg_temp.pid(903),pg_temp.op('other'),repeat('c',64));
select public.record_photo_provider_success(pg_temp.op('other'),1,repeat('c',64),'synthetic_drive_other',clock_timestamp());
select private.manage_cleaning_attempt_lifecycle_at(pg_temp.pid(1),pg_temp.pid(901),pg_temp.pid(502),1,pg_temp.pid(402),2,
 (select account_lifecycle_version from public.profiles where id=pg_temp.pid(3)),
 'allow_upload','{}','DEACTIVATION_UPLOAD_ONLY','photo83-allow-upload',repeat('e',64),null);
select is((select status::text from public.profiles where id=pg_temp.pid(3)),'upload_only','actual lifecycle grants exact upload capability');
select is(public.finalize_photo_upload(pg_temp.pid(3),pg_temp.pid(903),pg_temp.op('other'),1,repeat('c',64))->>'status','accepted','valid upload-only capability finalizes its own frozen attempt');
insert into operations values('limited',pg_temp.upload(2,45,1,3));
select public.claim_photo_upload(pg_temp.pid(3),pg_temp.pid(903),pg_temp.op('limited'),repeat('c',64));
select public.record_photo_provider_success(pg_temp.op('limited'),1,repeat('c',64),'synthetic_drive_limited',clock_timestamp());
insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
select id,clock_timestamp(),'ACCOUNT_CHANGED',pg_temp.pid(1) from private.attempt_capability_grants
where attempt_id=pg_temp.pid(502) and kind='upload_submit';
select throws_ok($$select public.finalize_photo_upload(pg_temp.pid(3),pg_temp.pid(903),pg_temp.op('limited'),1,repeat('c',64))$$,'42501','CAPABILITY_ACCESS_REQUIRED','revoked capability cannot finalize provider success');
select is(public.reconcile_photo_upload(pg_temp.op('other'),repeat('d',64))->>'status','accepted','old accepted survives capability revocation');
update public.profiles set status='active' where id=pg_temp.pid(3);
select private.clear_attempt_photo(pg_temp.pid(3),pg_temp.pid(502),pg_temp.slot(2),1);
select throws_ok($$select public.finalize_photo_upload(pg_temp.pid(3),pg_temp.pid(903),pg_temp.op('limited'),1,repeat('c',64))$$,'40001','PHOTO_VERSION_CONFLICT','current pointer changed after provider success fails finalize CAS');
select is((select status from private.photo_upload_states where operation_id=pg_temp.op('limited')),'provider_succeeded','stale finalize preserves provider success for reconciliation');
select is((select count(*) from private.photo_upload_acceptances where operation_id=pg_temp.op('limited')),0::bigint,'stale finalize does not create acceptance');
select throws_ok($$select public.begin_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501),pg_temp.pid(401),2,
 pg_temp.slot(1),2,repeat('a',64),'image/jpeg',307201,repeat('e',64),repeat('b',64))$$,'23514','PHOTO_UPLOAD_INVALID','DB enforces 300KiB metadata bound');
select throws_ok($$select public.begin_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501),pg_temp.pid(401),2,
 pg_temp.slot(1),2,repeat('a',64),'image/png',100,repeat('e',64),repeat('b',64))$$,'23514','PHOTO_UPLOAD_INVALID','DB rejects unsupported MIME metadata');
select throws_ok($$select public.begin_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.pid(501),pg_temp.pid(401),2,
 pg_temp.slot(1),2,repeat('a',64),'image/jpeg',100,'raw-key-not-a-digest',repeat('b',64))$$,'23514','PHOTO_UPLOAD_INVALID','raw key is not accepted in digest input');
-- Technical inflight and minute bounds; rejected requests append no operation/security row.
select pg_temp.upload(1,20+n,0,2,'slot-'||n) from generate_series(2,9)n;
select throws_ok($$select pg_temp.upload(1,40,0,2,'slot-10')$$,'54000','PHOTO_UPLOAD_LIMIT_EXCEEDED','actor inflight cap eight');
update private.photo_upload_rate_limits set occurrence_count=30,minute_started_at=date_trunc('minute',clock_timestamp()) where actor_profile_id=pg_temp.pid(3);
select throws_ok($$select pg_temp.upload(2,41,0,3,'slot-2')$$,'54000','PHOTO_UPLOAD_RATE_LIMITED','fixed minute limit fails without individual denied rows');
select is((select occurrence_count from private.photo_upload_rate_limits where actor_profile_id=pg_temp.pid(3)),30,'saturated limiter count stays bounded');
-- Expired leases can be reclaimed only finitely and never accept old worker callbacks.
do $$ declare v integer; oid uuid; begin
 select id into oid from private.photo_upload_operations where actor_profile_id=pg_temp.pid(2) and idempotency_key_digest=lpad('22',64,'0');
 perform public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),oid,repeat('c',64));
 for v in 2..8 loop
   update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id=oid;
   perform public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),oid,lpad(v::text,64,'0'));
 end loop;
 update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id=oid;
 insert into operations values('exhausted',private.photo_upload_projection(oid));
end; $$;
select throws_ok($$select public.claim_photo_upload(pg_temp.pid(2),pg_temp.pid(902),pg_temp.op('exhausted'),repeat('e',64))$$,'54000','PHOTO_UPLOAD_LEASE_LIMIT','max eight claims is a bounded technical budget');
select throws_ok($$select public.record_photo_provider_success(pg_temp.op('exhausted'),1,repeat('c',64),'synthetic_stale_worker',clock_timestamp())$$,'40001','PHOTO_UPLOAD_FENCE_CONFLICT','original delayed worker cannot create provider metadata after takeover');
select is((select count(*) from private.photo_provider_objects where operation_id=pg_temp.op('exhausted')),1::bigint,'eight claims retain exactly one candidate identity');
select ok(not exists(select 1 from public.audit_events where event_type='photo.upload_accepted' and after_state::text like '%synthetic_drive%'),'audit has no raw provider locator');
select throws_ok($$update private.photo_upload_operations set request_hash=repeat('d',64) where id=pg_temp.op('first')$$,'55000','PHOTO_STORAGE_IMMUTABLE','receipt payload immutable');
select throws_ok($$update private.photo_provider_objects set uploaded_at=clock_timestamp() where operation_id=pg_temp.op('first')$$,'55000','PHOTO_STORAGE_IMMUTABLE','provider first-success clock immutable');
select throws_ok($$delete from private.photo_upload_acceptances where operation_id=pg_temp.op('first')$$,'55000','PHOTO_STORAGE_IMMUTABLE','accepted history cannot be removed');
select throws_ok($$delete from private.photo_upload_events$$,'55000','PHOTO_STORAGE_IMMUTABLE','reconciliation history immutable');
select throws_ok($$update private.photo_upload_states set status='compensation_pending',revision=revision+1 where operation_id=pg_temp.op('first')$$,'55000','PHOTO_OPERATION_TERMINAL','even owner state update cannot retire accepted');
select ok(bool_and(relrowsecurity),'all photo storage private tables RLS enabled') from pg_class where oid=any(array[
 'private.photo_upload_operations'::regclass,'private.photo_provider_objects'::regclass,'private.photo_upload_states'::regclass,
 'private.photo_upload_acceptances'::regclass,'private.photo_upload_events'::regclass,'private.photo_upload_rate_limits'::regclass]);
select ok(not has_table_privilege(r,t,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),'no raw table grants '||r||' '||t)
from unnest(array['anon','authenticated','service_role'])r cross join unnest(array[
 'private.photo_upload_operations','private.photo_provider_objects','private.photo_upload_states',
 'private.photo_upload_acceptances','private.photo_upload_events','private.photo_upload_rate_limits'])t;
select ok(not has_function_privilege(r,f,'EXECUTE'),'no privileged RPC '||r||' '||f)
from unnest(array['anon','authenticated'])r cross join unnest(array[
 'public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)',
 'public.get_photo_upload(uuid,uuid,uuid)','public.claim_photo_upload(uuid,uuid,uuid,text)',
 'public.record_photo_provider_success(uuid,integer,text,text,timestamptz)',
 'public.finalize_photo_upload(uuid,uuid,uuid,integer,text)','public.reconcile_photo_upload(uuid,text)',
 'public.settle_photo_compensation(uuid,integer,text,text)'])f;
select ok(has_function_privilege('service_role',f,'EXECUTE'),'service only RPC '||f)
from unnest(array[
 'public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)',
 'public.get_photo_upload(uuid,uuid,uuid)','public.claim_photo_upload(uuid,uuid,uuid,text)',
 'public.record_photo_provider_success(uuid,integer,text,text,timestamptz)',
 'public.finalize_photo_upload(uuid,uuid,uuid,integer,text)','public.reconcile_photo_upload(uuid,text)',
 'public.settle_photo_compensation(uuid,integer,text,text)'])f;
set local role authenticated;
select throws_ok($$select public.reconcile_photo_upload('00000000-0000-4000-8000-000000000001',repeat('a',64))$$,'42501',null,'authenticated direct RPC invocation denied');
select throws_ok($$select * from private.photo_upload_operations$$,'42501',null,'private Data API raw read denied');
reset role;
set local role service_role;
select throws_ok($$insert into private.photo_upload_operations(actor_profile_id) values(null)$$,'42501',null,'service role cannot direct insert');
reset role;
set constraints all immediate;
select * from finish();
rollback;
