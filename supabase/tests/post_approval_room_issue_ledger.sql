begin;
-- Source-authored pgTAP candidate; NOT RUN until root installs the exact dependency union.
select no_plan();
-- BEGIN POST APPROVAL ROOM ISSUE SHARED FIXTURE
create function pg_temp.lid(n integer) returns uuid language sql immutable as $$
  select ('b3360000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.lid(100+n) from generate_series(1,3) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.lid(n),pg_temp.lid(100+n),'late-issue-'||n,'late-issue-'||n,'late-issue-'||n,'late-issue-'||n,
  0,case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false from generate_series(1,3) n;
insert into auth.sessions(id,user_id,not_after) values
  (pg_temp.lid(201),pg_temp.lid(101),clock_timestamp()+interval '1 day'),
  (pg_temp.lid(202),pg_temp.lid(102),clock_timestamp()+interval '1 day'),
  (pg_temp.lid(203),pg_temp.lid(103),clock_timestamp()+interval '1 day'),
  (pg_temp.lid(204),pg_temp.lid(102),clock_timestamp()+interval '1 day'),
  (pg_temp.lid(205),pg_temp.lid(102),clock_timestamp()-interval '1 day');

-- Historical projection fixtures only: do not claim these bypassed old upload/
-- submission/inspection commands validate their workflows. New RPCs run with
-- all triggers restored below. Two sources are deliberately older than 7 days.
set local session_replication_role=replica;
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.lid(1000+n),r.id,'additional','manual_room_request','late-issue-fixture-'||n,
  (clock_timestamp() at time zone 'Asia/Seoul')::date-10,(clock_timestamp() at time zone 'Asia/Seoul')::date-10,
  clock_timestamp()-interval '10 days','approved',1,'{}',10000,'{}',pg_temp.lid(1)
from (select id,row_number() over(order by room_number)::integer n from public.rooms) r where n in(1,2);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,
  notified_at,ended_at,changed_by,service_date)
select pg_temp.lid(2000+n),pg_temp.lid(1000+n),pg_temp.lid(2),n,1,false,
  clock_timestamp()-interval '10 days',clock_timestamp()-interval '9 days',pg_temp.lid(1),
  (clock_timestamp() at time zone 'Asia/Seoul')::date-10 from generate_series(1,2) n;
update public.cleaning_assignments a set notified_room_id_snapshot=t.room_id,notified_room_number_snapshot=r.room_number
from public.cleaning_targets t join public.rooms r on r.id=t.room_id where t.id=a.cleaning_target_id and a.id in(pg_temp.lid(2001),pg_temp.lid(2002));
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
select pg_temp.lid(3000+n),t.id,pg_temp.lid(2000+n),pg_temp.lid(2),1,'field_completed',1,
  clock_timestamp()-interval '10 days',clock_timestamp()-interval '10 days'+interval '1 hour',
  clock_timestamp()-interval '9 days','{}',jsonb_build_object('roomId',t.room_id)
from generate_series(1,2) n join public.cleaning_targets t on t.id=pg_temp.lid(1000+n);
insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,
  issue_snapshot,candle_count,submitted_by,submitted_at)
select pg_temp.lid(4000+n),pg_temp.lid(3000+n),pg_temp.lid(4100+n),1,
  case when n=1 then 'submitted' else 'approved' end::public.submission_status,'{}','[]',0,
  pg_temp.lid(2),clock_timestamp()-interval '9 days' from generate_series(1,2) n;
insert into public.inspection_decisions(id,submission_id,decision,decided_by,decided_at)
values(pg_temp.lid(4502),pg_temp.lid(4002),'approved',pg_temp.lid(1),clock_timestamp()-interval '8 days');
insert into private.attempt_photo_versions(id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,version,
  validation_status,sha256,mime_type,size_bytes,uploaded_at,purge_after)
values(pg_temp.lid(5202),pg_temp.lid(3002),pg_temp.lid(1002),pg_temp.lid(5102),1,'verified',repeat('a',64),
  'image/jpeg',100,statement_timestamp()-interval '9 days',statement_timestamp()-interval '2 days');
insert into private.submission_photo_bindings(submission_id,cleaning_attempt_id,cleaning_target_id,target_photo_slot_id,
  photo_version_id,photo_version)
values(pg_temp.lid(4002),pg_temp.lid(3002),pg_temp.lid(1002),pg_temp.lid(5102),pg_temp.lid(5202),1);
insert into private.submission_photo_binding_sets(submission_id,cleaning_attempt_id,photo_count,sealed_at)
values(pg_temp.lid(4002),pg_temp.lid(3002),1,clock_timestamp()-interval '9 days');
insert into private.photo_upload_operations(id,actor_profile_id,idempotency_key_digest,request_hash,cleaning_attempt_id,
  cleaning_target_id,assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,sha256,mime_type,size_bytes)
values(pg_temp.lid(5302),pg_temp.lid(2),repeat('c',64),repeat('d',64),pg_temp.lid(3002),pg_temp.lid(1002),
  pg_temp.lid(2002),1,pg_temp.lid(5102),0,repeat('a',64),'image/jpeg',100);
insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
values(pg_temp.lid(5402),pg_temp.lid(5302),'synthetic-late-issue-old-object',statement_timestamp()-interval '9 days',statement_timestamp()-interval '2 days');
insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id,accepted_at)
values(pg_temp.lid(5302),pg_temp.lid(5402),pg_temp.lid(5202),clock_timestamp()-interval '9 days');
insert into private.photo_retention_records(object_id,operation_id,photo_version_id,performer_maid_profile_id,
  effective_policy_kind,retention_starts_at,expires_at,purged_at,media_availability)
select pg_temp.lid(5402),pg_temp.lid(5302),pg_temp.lid(5202),pg_temp.lid(2),'cleaning_submission',decided_at,
  decided_at+interval '168 hours',null,'available' from public.inspection_decisions where id=pg_temp.lid(4502);
insert into private.photo_retention_links(object_id,policy_kind,domain_kind,domain_id,performer_maid_profile_id,
  retention_starts_at,expires_at)
select object_id,'cleaning_submission','cleaning_submission',pg_temp.lid(4002),pg_temp.lid(2),retention_starts_at,expires_at
from private.photo_retention_records where object_id=pg_temp.lid(5402);
set local session_replication_role=origin;

create function pg_temp.old_digest() returns text language plpgsql as $$
declare relation text; value jsonb; result jsonb:='{}';
begin
  foreach relation in array array['public.rooms','public.cleaning_targets','public.cleaning_assignments','public.cleaning_attempts',
    'public.cleaning_submissions','public.inspection_decisions','public.earnings','public.payroll_cycles',
    'private.attempt_photo_versions','private.submission_photo_bindings','private.submission_photo_binding_sets',
    'private.photo_retention_records','private.photo_retention_links','private.attempt_room_issue_reports'] loop
    execute format('select coalesce(jsonb_agg(to_jsonb(r) order by to_jsonb(r)::text),''[]''::jsonb) from %s r',relation) into value;
    result:=result||jsonb_build_object(relation,value);
  end loop;
  return md5(result::text);
end $$;
create temp table old_checkpoint as select pg_temp.old_digest() digest,
  private.submission_projection(pg_temp.lid(4002)) old_dto;
create function pg_temp.save_late(p_actor integer default 2,p_source integer default 4002,p_client integer default 6001,
  p_revision bigint default 0,p_key text default null,p_hash text default null,p_session integer default 202)
returns jsonb language sql as $$
  select public.save_post_approval_room_issue_draft(pg_temp.lid(p_actor),pg_temp.lid(p_session),pg_temp.lid(p_source),
    pg_temp.lid(p_client),p_revision,'synthetic memo',coalesce(p_key,repeat('a',64)),coalesce(p_hash,repeat('b',64))) $$;
create temp table late_results(label text primary key,value jsonb);
-- END POST APPROVAL ROOM ISSUE SHARED FIXTURE

select is(public.get_post_approval_room_issue_source(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4001))#>>'{source,sourceStatus}',
  'submitted','submitted historical source is available without an invented 7-day deadline');
select is(public.get_post_approval_room_issue_source(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002))#>>'{source,sourceStatus}',
  'approved','active admin reads approved immutable source');
select throws_ok($$select public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','other maid cannot discover the source');
select throws_ok($$select pg_temp.save_late(p_session=>205)$$,'42501','SESSION_REVOKED','hard-expired session cannot create draft');
select throws_ok($$select pg_temp.save_late(p_actor=>3,p_session=>203)$$,'42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','other maid cannot mutate historical draft');
select throws_ok($$select private.assert_post_approval_room_issue_source(jsonb_populate_record(null::public.profiles,
  (select to_jsonb(p) from public.profiles p where id=pg_temp.lid(2))||'{"status":"upload_only"}'::jsonb),pg_temp.lid(4002))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','source authorization explicitly excludes limited profile even if another helper permits it');
insert into late_results values('first',pg_temp.save_late());
select is(pg_temp.save_late(),(select value from late_results where label='first'),'same key/payload receipt replay');
select is(pg_temp.save_late(p_session=>204),(select value from late_results where label='first'),'fresh session does not change logical receipt identity');
select throws_ok($$select pg_temp.save_late(p_source=>4001,p_hash=>repeat('c',64))$$,'23505','IDEMPOTENCY_KEY_REUSED',
  'same actor/command/key cannot select a new source payload');
select throws_ok($$select pg_temp.save_late(p_client=>6002,p_hash=>repeat('c',64))$$,'23505','IDEMPOTENCY_KEY_REUSED',
  'same actor/command/key cannot select a new client report payload');
select throws_ok($$select pg_temp.save_late(p_key=>repeat('d',64))$$,'40001','POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT',
  'different key cannot create duplicate actor/client draft at stale CAS0');
select is((pg_temp.save_late(p_revision=>1,p_key=>repeat('e',64))->'draft'->>'draftRevision')::bigint,2::bigint,
  'exact CAS advances draft and appends immutable revision');
select is((select count(*) from private.post_approval_room_issue_draft_revisions),2::bigint,'replay and conflicts do not append extra revisions');
select is((pg_temp.save_late(p_actor=>1,p_client=>6004,p_key=>repeat('6',64),p_session=>201)->'draft'->>'draftRevision')::bigint,
  1::bigint,'active admin creates a separately owned draft without impersonating original performer');
select ok(exists(select 1 from private.post_approval_room_issue_drafts where reported_by_profile_id=pg_temp.lid(1)
  and original_performer_profile_id=pg_temp.lid(2) and client_report_id=pg_temp.lid(6004)),'admin reporter and immutable original performer remain distinct');
savepoint shared_admin_draft;
insert into auth.users(id) values(pg_temp.lid(104));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values(pg_temp.lid(4),pg_temp.lid(104),'late-issue-four','late-issue-four','late-issue-four','late-issue-four',0,'admin','active',false);
insert into auth.sessions(id,user_id,not_after) values(pg_temp.lid(206),pg_temp.lid(104),clock_timestamp()+interval '1 day');
select is(public.get_post_approval_room_issue_draft(pg_temp.lid(4),pg_temp.lid(206),pg_temp.lid(4002),pg_temp.lid(6004))#>>'{draft,draftRevision}',
  '1','another live admin recovers the same creator draft');
select is(pg_temp.save_late(p_actor=>4,p_client=>6004,p_revision=>1,p_key=>repeat('7',64),p_session=>206)#>>'{draft,draftRevision}',
  '2','another admin edits the same draft with exact CAS');
select is((select reported_by_profile_id from private.post_approval_room_issue_drafts where client_report_id=pg_temp.lid(6004)),pg_temp.lid(1),
  'shared edit never overwrites original admin creator');
select is((select actor_profile_id from private.post_approval_room_issue_draft_revisions r join private.post_approval_room_issue_drafts d on d.id=r.draft_id
  where d.client_report_id=pg_temp.lid(6004) and r.revision=2),pg_temp.lid(4),'immutable memo revision records actual second admin');
select throws_ok($$select pg_temp.save_late(p_actor=>1,p_client=>6004,p_revision=>1,p_key=>repeat('8',64),p_session=>201)$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT','original creator cannot overwrite another admin using stale CAS');
select throws_ok($$select pg_temp.save_late(p_actor=>4,p_client=>6004,p_key=>repeat('8',64),p_session=>206)$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT','second admin CAS0 does not fork a shadow draft');
select is(pg_temp.save_late(p_actor=>4,p_client=>6004,p_revision=>1,p_key=>repeat('7',64),p_session=>206)#>>'{draft,draftRevision}',
  '2','second admin replays its own receipt without another revision');
select is((select count(*) from private.post_approval_room_issue_drafts where source_submission_id=pg_temp.lid(4002) and client_report_id=pg_temp.lid(6004)),
  1::bigint,'source/client identity remains singular across admins');
select throws_ok($$select pg_temp.save_late(p_client=>6004,p_revision=>2,p_key=>repeat('8',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','performer maid cannot hijack an admin-created draft');
select throws_ok($$select public.get_post_approval_room_issue_draft(pg_temp.lid(4),pg_temp.lid(205),pg_temp.lid(4002),pg_temp.lid(6004))$$,
  '42501','SESSION_REVOKED','shared admin lookup still requires its own live session');
-- Synthetic role change isolates request-time authorization, not the account
-- lifecycle command. Keep the original live session and restore via savepoint.
set local session_replication_role=replica;
update public.profiles set role='maid' where id=pg_temp.lid(4);
set local session_replication_role=origin;
select throws_ok($$select public.get_post_approval_room_issue_draft(pg_temp.lid(4),pg_temp.lid(206),pg_temp.lid(4002),pg_temp.lid(6004))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded admin cannot read another creator draft with its old live session');
select throws_ok($$select pg_temp.save_late(p_actor=>4,p_client=>6004,p_revision=>2,p_key=>repeat('8',64),p_session=>206)$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded admin cannot append another shared draft revision');
select throws_ok($$select pg_temp.save_late(p_actor=>4,p_client=>6004,p_revision=>1,p_key=>repeat('7',64),p_session=>206)$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','old successful admin receipt does not bypass current maid role');
select throws_ok($$select public.finalize_post_approval_room_issue_report(pg_temp.lid(4),pg_temp.lid(206),pg_temp.lid(4002),pg_temp.lid(6004),
  2,1,'synthetic memo',jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(6204),'revision',1,'displayOrder',0)),repeat('8',64),repeat('9',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded admin finalization is denied before evidence validation');
select is((select count(*) from private.post_approval_room_issue_draft_revisions r join private.post_approval_room_issue_drafts d on d.id=r.draft_id
  where d.client_report_id=pg_temp.lid(6004)),2::bigint,'denied downgraded commands leave prior revisions intact');
rollback to shared_admin_draft;
select throws_ok($$update private.post_approval_room_issue_draft_revisions set memo='replacement'$$,'55000','POST_APPROVAL_ROOM_ISSUE_IMMUTABLE','revision history cannot be overwritten');
select throws_ok($$delete from private.post_approval_room_issue_drafts$$,'55000','POST_APPROVAL_ROOM_ISSUE_IMMUTABLE','draft ledger cannot be deleted');
select throws_ok($$update private.post_approval_room_issue_drafts set source_submission_id=pg_temp.lid(4001),draft_revision=draft_revision+1$$,
  '55000','POST_APPROVAL_ROOM_ISSUE_IMMUTABLE','source tuple cannot be rebound');
select throws_ok($$select public.finalize_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6001),
  2,1,'synthetic memo','[{"evidenceId":"b3360000-0000-4000-8000-000000005202","revision":1,"displayOrder":0}]',repeat('f',64),repeat('a',64))$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID','old photo ID cannot bypass actual typed evidence provenance');
select is((select count(*) from private.post_approval_room_issue_reports),0::bigint,'blocked finalization creates no report');
select is((select count(*) from private.command_executions where command_type='post_approval_room_issue.finalize'),0::bigint,'blocked finalization creates no success receipt');
select throws_ok($$insert into private.post_approval_room_issue_reports(draft_id,source_submission_id,client_report_id,reported_by_profile_id,
  draft_created_by_profile_id,original_performer_profile_id,memo,draft_revision,evidence_revision,evidence_count)
select id,source_submission_id,client_report_id,reported_by_profile_id,reported_by_profile_id,original_performer_profile_id,memo,draft_revision,1,1
from private.post_approval_room_issue_drafts; set constraints all immediate;$$,'23514','POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID','caller-injected count cannot create verified report evidence');

-- Synthetic AFTER-receipt expiry proves the final guard rolls back all writes.
-- This is not a parallel lock-wait race test; the latter remains a separate gate.
create function pg_temp.expire_late_session() returns trigger language plpgsql as $$ begin
  if new.command_type='post_approval_room_issue.draft' and new.idempotency_key=repeat('9',64) then
    update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.lid(202);
  end if;
  return new;
end $$;
create trigger expire_late_session after insert on private.command_executions for each row execute function pg_temp.expire_late_session();
select throws_ok($$select pg_temp.save_late(p_client=>6003,p_key=>repeat('9',64))$$,'42501','SESSION_REVOKED',
  'expiry at completion rolls back draft, history, audit and receipt');
select is((select count(*) from private.post_approval_room_issue_drafts where client_report_id=pg_temp.lid(6003)),0::bigint,'late-expired command leaves no draft');
select is((select count(*) from private.command_executions where command_type='post_approval_room_issue.draft' and idempotency_key=repeat('9',64)),0::bigint,'late-expired command leaves no receipt');
drop trigger expire_late_session on private.command_executions;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.lid(202);
select throws_ok($$select pg_temp.save_late()$$,'42501','SESSION_REVOKED','successful receipt cannot bypass newly expired session');
update auth.sessions set not_after=clock_timestamp()+interval '1 day' where id=pg_temp.lid(202);
update public.profiles set must_change_password=true where id=pg_temp.lid(2);
select throws_ok($$select pg_temp.save_late()$$,'42501','PASSWORD_CHANGE_REQUIRED','successful receipt cannot bypass password-change requirement');
update public.profiles set must_change_password=false where id=pg_temp.lid(2);

-- Seed only the synthetic arithmetic boundary, then exercise the real RPC.
set local session_replication_role=replica;
update private.post_approval_room_issue_drafts set draft_revision=9007199254740990 where client_report_id=pg_temp.lid(6001);
set local session_replication_role=origin;
select is((pg_temp.save_late(p_revision=>9007199254740990,p_key=>repeat('7',64))->'draft'->>'draftRevision')::bigint,
  9007199254740991::bigint,'last safe increment has a projectable safe-integer result');
select throws_ok($$select pg_temp.save_late(p_revision=>9007199254740991,p_key=>repeat('8',64))$$,'40001','POST_APPROVAL_ROOM_ISSUE_DRAFT_CONFLICT','exhausted draft revision fails closed without unsafe increment');
select ok(private.post_approval_room_issue_memo_valid(repeat('x',500)),'500 UTF-16 units accepted');
select ok(not private.post_approval_room_issue_memo_valid(repeat(U&'\+01F600',251)),'astral characters count as two UTF-16 units');
select ok(not private.post_approval_room_issue_memo_valid(U&'\00A0\FEFF\3000'),'JS whitespace-only memo rejected');
select is(pg_temp.old_digest(),(select digest from old_checkpoint),'old room/source/photo/seal/inspection/earning/payroll/retention rows are unchanged');
select is(private.submission_projection(pg_temp.lid(4002)),(select old_dto from old_checkpoint),'old submitted DTO receives no supplemental issue fields or memberships');
select is((select expires_at-retention_starts_at from private.photo_retention_records where object_id=pg_temp.lid(5402)),
  interval '168 hours','old approved photo expiry is not extended');
select ok(not exists(select 1 from public.audit_events where event_type='post_approval_room_issue.draft_saved' and after_state::text like '%synthetic memo%'),
  'safe draft audit does not copy memo');
select ok((select bool_and(relrowsecurity and relforcerowsecurity) from pg_class where oid in
  ('private.post_approval_room_issue_drafts'::regclass,'private.post_approval_room_issue_draft_revisions'::regclass,'private.post_approval_room_issue_reports'::regclass)),
  'all new private ledgers force RLS');
select ok(has_function_privilege('service_role','public.save_post_approval_room_issue_draft(uuid,uuid,uuid,uuid,bigint,text,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.save_post_approval_room_issue_draft(uuid,uuid,uuid,uuid,bigint,text,text,text)','EXECUTE')
  and not has_table_privilege('service_role','private.post_approval_room_issue_drafts','INSERT'),
  'service-only command has no direct runtime-role table DML');
select is((select provolatile::text from pg_proc where oid='public.get_post_approval_room_issue_source(uuid,uuid,uuid)'::regprocedure),'s','source discovery remains snapshot STABLE, not mutation authority');
select is((select provolatile::text from pg_proc where oid='private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)'::regprocedure),'v','new mutation guard is VOLATILE fresh');
select ok((select bool_and(proowner='postgres'::regrole and prosecdef and prolang=(select oid from pg_language where lanname='plpgsql')
  and proconfig @> array['search_path=""']::text[]) from pg_proc where oid in
  ('public.get_post_approval_room_issue_source(uuid,uuid,uuid)'::regprocedure,
   'public.save_post_approval_room_issue_draft(uuid,uuid,uuid,uuid,bigint,text,text,text)'::regprocedure,
   'public.finalize_post_approval_room_issue_report(uuid,uuid,uuid,uuid,bigint,bigint,text,jsonb,text,text)'::regprocedure,
   'private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)'::regprocedure)),
  'new command/read guard functions have exact postgres PL/pgSQL SECURITY DEFINER empty search_path contract');
select ok(not has_function_privilege('anon','private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)','EXECUTE')
  and not has_function_privilege('authenticated','private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)','EXECUTE')
  and not has_function_privilege('service_role','private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)','EXECUTE'),
  'private fresh wrapper is not callable by runtime roles');

-- Typed provider metadata below is synthetic server input, NOT actual Drive
-- verification. Exercise real SQL command/fence/acceptance/report/worker authority.
select public.refresh_photo_storage_quota(clock_timestamp(),1000);
create function pg_temp.typed_upload(p_client integer,p_evidence integer,p_collection bigint default 0,p_item bigint default 0,p_accept boolean default true,p_mismatch boolean default false,p_record boolean default true,p_actor integer default 2,p_session integer default 202)
returns jsonb language plpgsql as $$
declare ad jsonb; op jsonb; ctx jsonb; folder jsonb; result jsonb; key text:=md5(p_client::text||':'||p_evidence::text||':'||p_collection::text)||md5('typed'||p_client::text||p_evidence::text||p_collection::text);
begin
  ad:=public.admit_post_approval_room_issue_evidence_upload(pg_temp.lid(p_actor),pg_temp.lid(p_session),pg_temp.lid(4002),pg_temp.lid(p_client),pg_temp.lid(p_evidence),1,p_collection,p_item,key);
  op:=public.begin_post_approval_room_issue_evidence_upload(pg_temp.lid(p_actor),pg_temp.lid(p_session),(ad->>'admissionId')::uuid,repeat('a',64),'image/jpeg',100,key,repeat('b',64));
  op:=public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,repeat('f',64));
  ctx:=public.get_post_approval_room_issue_evidence_provider_context(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,(op->>'leaseVersion')::integer,repeat('f',64));
  folder:=public.reserve_post_approval_room_issue_evidence_folder(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,1,repeat('f',64),'date','synthetic_336_root_folder','synthetic_336_date_'||p_evidence);
  folder:=public.reserve_post_approval_room_issue_evidence_folder(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,1,repeat('f',64),'room','synthetic_336_root_folder','synthetic_336_room_'||p_evidence);
  ctx:=public.reserve_post_approval_room_issue_evidence_identity(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,1,repeat('f',64),'synthetic_336_file_'||p_evidence,folder->>'folderId');
  op:=public.prepare_post_approval_room_issue_evidence_provider_write(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,1,repeat('f',64));
  if not p_record then return op; end if;
  result:=public.record_post_approval_room_issue_evidence_provider_success(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,1,repeat('f',64),case when p_mismatch then clock_timestamp()-interval '1 day' else clock_timestamp() end);
  if p_accept then result:=public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(p_actor),pg_temp.lid(p_session),(op->>'operationId')::uuid,1,repeat('f',64)); end if;
  return result;
end $$;
savepoint admission_retry_cas;
savepoint upload_handover;
select pg_temp.save_late(p_client=>6097,p_key=>md5('handover-draft')||md5('handover-draft-key'));
insert into late_results values('handover-operation',pg_temp.typed_upload(6097,6297,0,0,false));
create function pg_temp.handover(p_actor integer default 1,p_session integer default 201,p_version integer default 1,
  p_key text default '9',p_hash text default '8',p_fence text default '7') returns jsonb language sql as $$
  select public.handover_post_approval_room_issue_evidence_upload(pg_temp.lid(p_actor),pg_temp.lid(p_session),
    (select (value->>'operationId')::uuid from late_results where label='handover-operation'),p_version,
    repeat(p_key,64),repeat(p_hash,64),repeat(p_fence,64)) $$;
select throws_ok($$select pg_temp.handover(2,202)$$,'42501','ADMIN_REQUIRED','maid cannot acquire handover execution');
savepoint handover_rate_limit;
insert into private.photo_upload_admission_limits values(pg_temp.lid(1),date_trunc('minute',clock_timestamp()),30)
  on conflict(actor_profile_id) do update set minute_started_at=excluded.minute_started_at,occurrence_count=30;
select throws_ok($$select pg_temp.handover()$$,'54000','PHOTO_UPLOAD_RATE_LIMITED','handover enforces shared actor rate ceiling');
select is((select count(*) from private.post_approval_issue_upload_handovers),0::bigint,'rate rejection leaves handover ledger empty');
rollback to handover_rate_limit;
savepoint handover_inflight_limit;
select public.admit_post_approval_room_issue_quota_refresh(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),pg_temp.lid(6004),
  pg_temp.lid(6300+n),1,0,0,md5('handover-permit'||n)||md5('handover-permit-key'||n),
  md5('handover-gate'||n)||md5('handover-gate-key'||n)) from generate_series(1,8)n;
select is(private.post_approval_issue_all_inflight(pg_temp.lid(1),clock_timestamp()),8::bigint,'eight actual quota permits fill recipient execution allowance');
select throws_ok($$select pg_temp.handover()$$,'54000','PHOTO_UPLOAD_LIMIT_EXCEEDED','handover cannot become ninth current operation');
select is((select lease_version from private.post_approval_issue_upload_states where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='handover-operation')),1,'inflight rejection preserves original fence version');
rollback to handover_inflight_limit;
insert into late_results values('handover-first',pg_temp.handover());
select is((select value->>'leaseVersion' from late_results where label='handover-first'),'2','handover rotates existing lease even when it is live');
select is((select value->>'status' from late_results where label='handover-first'),'provider_succeeded','handover preserves provider success state');
select is(private.post_approval_issue_executor((select (value->>'operationId')::uuid from late_results where label='handover-operation')),
  pg_temp.lid(1),'new admin becomes current executor');
select is((select ad.actor_profile_id from private.post_approval_issue_upload_operations o
  join private.post_approval_issue_upload_admissions ad on ad.id=o.admission_id
  where o.id=(select (value->>'operationId')::uuid from late_results where label='handover-operation')),pg_temp.lid(2),'original upload actor remains immutable');
create temp table handover_expiry as select lease_expires_at from private.post_approval_issue_upload_states
  where operation_id=(select (value->>'operationId')::uuid from late_results where label='handover-operation');
select is(pg_temp.handover(),(select value from late_results where label='handover-first'),'same handover receipt replays without another transition');
savepoint handover_replay_expiry;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.lid(201);
select throws_ok($$select pg_temp.handover()$$,'42501','SESSION_REVOKED','expired session cannot replay successful handover');
rollback to handover_replay_expiry;
select is((select lease_expires_at from private.post_approval_issue_upload_states where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='handover-operation')),
  (select lease_expires_at from handover_expiry),'handover replay does not extend lease');
select throws_ok($$select pg_temp.handover(p_hash=>'6')$$,'23505','IDEMPOTENCY_KEY_REUSED','handover receipt rejects changed payload');
select throws_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),repeat('f',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','old uploader cannot reclaim execution with its old fence');
select throws_ok($$select public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),1,repeat('f',64))$$,
  '40001','PHOTO_UPLOAD_FENCE_CONFLICT','new executor cannot use old lease/fence');
savepoint handover_accept;
select lives_ok($$select public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),2,repeat('7',64))$$,
  'new executor accepts original immutable provider identity with new fence');
rollback to handover_accept;
savepoint handover_expired_recovery;
update private.post_approval_issue_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',
  revision=revision+1,updated_at=clock_timestamp() where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='handover-operation');
select is(pg_temp.handover()->>'leaseVersion','2','lost handover response replays expired lease without renewing');
select is(public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),repeat('7',64))->>'leaseVersion',
  '3','current executor safely reclaims expired handover with same receipt fence');
select is(pg_temp.handover()->>'leaseVersion','3','lost reclaim response replays current bounded lease');
select is(public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),repeat('7',64))->>'leaseVersion',
  '3','reclaim retry does not consume another live lease');
select is((select lease_version from private.post_approval_issue_upload_handovers),2,'reclaim preserves immutable original handover receipt');
select lives_ok($$select public.get_post_approval_room_issue_evidence_provider_context(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),3,repeat('7',64))$$,
  'reclaimed executor can inspect existing provider identity');
select lives_ok($$select public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),3,repeat('7',64))$$,
  'reclaimed executor accepts original uploaded evidence');
select is(pg_temp.handover()->>'status','accepted','completed receipt remains replayable after reclaim');
rollback to handover_expired_recovery;
insert into auth.users(id) values(pg_temp.lid(104));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values(pg_temp.lid(4),pg_temp.lid(104),'late-issue-four','late-issue-four','late-issue-four','late-issue-four',0,'admin','active',false);
insert into auth.sessions(id,user_id,not_after) values(pg_temp.lid(206),pg_temp.lid(104),clock_timestamp()+interval '1 day');
create temp table handover_read_state as select to_jsonb(s) value from private.post_approval_issue_upload_states s
  where operation_id=(select (value->>'operationId')::uuid from late_results where label='handover-operation');
select is(public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(4),pg_temp.lid(206),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'))->>'leaseVersion',
  '2','another active admin can read latest operation CAS before taking over');
select is((select to_jsonb(s) from private.post_approval_issue_upload_states s where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='handover-operation')),
  (select value from handover_read_state),'shared status read does not mutate lease/fence/executor state');
select throws_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(4),pg_temp.lid(206),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),repeat('4',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','shared status access cannot claim another admin execution');
select throws_ok($$select public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(3),pg_temp.lid(203),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','foreign maid cannot read shared admin operation status');
savepoint shared_status_session_expiry;
update auth.sessions set not_after=clock_timestamp()-interval '1 second' where id=pg_temp.lid(206);
select throws_ok($$select public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(4),pg_temp.lid(206),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'))$$,
  '42501','SESSION_REVOKED','shared admin status still requires its own live session');
rollback to shared_status_session_expiry;
savepoint shared_status_role_change;
set local session_replication_role=replica;
update public.profiles set role='maid' where id=pg_temp.lid(4);
set local session_replication_role=origin;
select throws_ok($$select public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(4),pg_temp.lid(206),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded admin loses shared status access immediately');
rollback to shared_status_role_change;
select throws_ok($$select pg_temp.handover(4,206,1,'6','5','4')$$,'40001','PHOTO_UPLOAD_FENCE_CONFLICT','stale handover CAS cannot displace executor');
select is(pg_temp.handover(4,206,2,'6','5','4')->>'leaseVersion','3','third admin can take over using latest lease CAS');
select is(public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'))->>'leaseVersion',
  '3','displaced admin retains shared read access without regaining execution');
select throws_ok($$select pg_temp.handover()$$,'40001','PHOTO_UPLOAD_FENCE_CONFLICT','old successful handover receipt cannot restore displaced admin');
select throws_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='handover-operation'),repeat('7',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','displaced handover executor cannot reclaim old receipt fence');
select is((select count(*) from private.post_approval_issue_upload_handovers),2::bigint,'two handovers preserve two immutable actor transitions');
select is(private.post_approval_issue_extra_inflight(pg_temp.lid(1),clock_timestamp()),0::bigint,'displaced executor no longer consumes extra execution slot');
select is(private.post_approval_issue_extra_inflight(pg_temp.lid(4),clock_timestamp()),1::bigint,'new executor consumes one execution slot');
select is(private.post_approval_issue_extra_inflight(pg_temp.lid(2),clock_timestamp()),1::bigint,'original admission continues to account for one upload');
select throws_ok($$delete from private.post_approval_issue_upload_handovers$$,'55000','POST_APPROVAL_ROOM_ISSUE_IMMUTABLE','handover actor history cannot be deleted');
select ok(not has_table_privilege('service_role','private.post_approval_issue_upload_handovers','INSERT'),
  'runtime service cannot inject arbitrary handover history');
select is(pg_temp.old_digest(),(select digest from old_checkpoint),'handover preserves old business source digest');
rollback to upload_handover;
-- An admin starts an independently owned upload on another creator's draft.
-- This does not transfer an already-running provider operation to that admin.
savepoint shared_admin_upload;
select pg_temp.save_late(p_client=>6088,p_key=>md5('shared-upload')||md5('shared-upload-draft'));
insert into late_results values('shared-quota',public.admit_post_approval_room_issue_quota_refresh(
  pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),pg_temp.lid(6088),pg_temp.lid(6288),1,0,0,repeat('8',64),repeat('7',64)));
select is(public.refresh_post_approval_room_issue_quota(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'permitId')::uuid from late_results where label='shared-quota'),clock_timestamp(),1000)->>'refreshed','true',
  'admin refreshes quota for another creator draft using its own permit');
insert into late_results values('shared-admission',public.admit_post_approval_room_issue_evidence_upload(
  pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),pg_temp.lid(6088),pg_temp.lid(6288),1,0,0,repeat('8',64)));
select is((select actor_profile_id from private.post_approval_issue_upload_admissions where id=
  (select (value->>'admissionId')::uuid from late_results where label='shared-admission')),pg_temp.lid(1),
  'shared upload admission records actual admin, not draft creator');
select is((select reported_by_profile_id from private.post_approval_room_issue_drafts where client_report_id=pg_temp.lid(6088)),pg_temp.lid(2),
  'shared upload preserves original draft creator');
select throws_ok($$select public.begin_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'admissionId')::uuid from late_results where label='shared-admission'),repeat('a',64),'image/jpeg',100,repeat('8',64),repeat('b',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','draft creator cannot execute another actor admission');
insert into late_results values('shared-operation',public.begin_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'admissionId')::uuid from late_results where label='shared-admission'),repeat('a',64),'image/jpeg',100,repeat('8',64),repeat('b',64)));
select lives_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='shared-operation'),repeat('f',64))$$,
  'actual admin can claim its shared-draft operation');
select throws_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='shared-operation'),repeat('e',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','creator cannot replace another uploader fence');
select throws_ok($$select public.prepare_post_approval_room_issue_evidence_delete(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='shared-operation'),1,repeat('f',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','creator with exact fence cannot compensate another uploader operation');
select lives_ok($$do $flow$ declare op uuid; folder jsonb; begin
  select (value->>'operationId')::uuid into op from late_results where label='shared-operation';
  perform public.get_post_approval_room_issue_evidence_provider_context(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64));
  perform public.reserve_post_approval_room_issue_evidence_folder(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64),'date','synthetic_336_root_folder','synthetic_336_shared_date');
  folder:=public.reserve_post_approval_room_issue_evidence_folder(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64),'room','synthetic_336_root_folder','synthetic_336_shared_room');
  perform public.reserve_post_approval_room_issue_evidence_identity(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64),'synthetic_336_shared_file',folder->>'folderId');
  perform public.prepare_post_approval_room_issue_evidence_provider_write(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64));
  perform public.record_post_approval_room_issue_evidence_provider_success(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64),clock_timestamp());
  perform public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),op,1,repeat('f',64));
end $flow$ $$,'admin completes synthetic provider flow on another creator draft');
select is((select count(*) from private.post_approval_issue_evidence_acceptances where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='shared-operation')),1::bigint,
  'shared draft gains exactly one acceptance from actual uploader operation');
select throws_ok($$select public.prepare_post_approval_room_issue_evidence_delete(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='shared-operation'),1,repeat('f',64))$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED','shared uploader cannot compensate accepted business evidence');
-- Keep original performer authority valid after downgrade: these denials must
-- come from draft ownership, not from a missing source entitlement.
set local session_replication_role=replica;
update public.profiles set role='admin' where id=pg_temp.lid(2);
set local session_replication_role=origin;
insert into late_results values('downgrade-permit',public.admit_post_approval_room_issue_quota_refresh(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6004),pg_temp.lid(6289),1,0,0,repeat('6',64),repeat('5',64)));
insert into late_results values('downgrade-admission',public.admit_post_approval_room_issue_evidence_upload(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6004),pg_temp.lid(6289),1,0,0,repeat('6',64)));
insert into late_results values('downgrade-operation',pg_temp.typed_upload(6004,6299,0,0,false,true));
insert into late_results values('downgrade-accept-ready',pg_temp.typed_upload(6004,6298,0,0,false,false));
select is((select status from private.post_approval_issue_upload_states where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='downgrade-accept-ready')),'provider_succeeded',
  'separate valid provider success is acceptance-ready before actor downgrade');
insert into late_results values('downgrade-delete',public.prepare_post_approval_room_issue_evidence_delete(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-operation'),1,repeat('f',64)));
select ok((select value->>'deleteToken' is not null from late_results where label='downgrade-delete'),
  'shared uploader can prepare compensation for its own never-accepted date mismatch');
select throws_ok($$select public.settle_post_approval_room_issue_evidence_delete(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-operation'),1,repeat('f',64),
  (select (value->>'deleteToken')::uuid from late_results where label='downgrade-delete'),'not_found')$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','draft creator cannot settle another uploader even with exact token and fence');
set local session_replication_role=replica;
update public.profiles set role='maid' where id=pg_temp.lid(2);
set local session_replication_role=origin;
select throws_ok($$select public.refresh_post_approval_room_issue_quota(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'permitId')::uuid from late_results where label='downgrade-permit'),clock_timestamp(),1000)$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded original performer cannot reuse another creator quota permit');
select throws_ok($$select public.admit_post_approval_room_issue_quota_refresh(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6004),pg_temp.lid(6289),1,0,0,repeat('6',64),repeat('5',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','existing admission cannot bypass latest draft authority during quota replay');
select throws_ok($$select public.begin_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'admissionId')::uuid from late_results where label='downgrade-admission'),repeat('a',64),'image/jpeg',100,repeat('6',64),repeat('b',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','own admission does not retain admin draft access after downgrade');
select throws_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-operation'),repeat('f',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded uploader cannot replay a claim with its existing fence');
select throws_ok($$select public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-operation'),1,repeat('f',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded uploader is denied before acceptance state validation');
select throws_ok($$select public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-accept-ready'),1,repeat('f',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded uploader cannot accept otherwise valid provider success');
select ok(not exists(select 1 from private.post_approval_issue_evidence_acceptances where operation_id=
  (select (value->>'operationId')::uuid from late_results where label='downgrade-accept-ready'))
  and exists(select 1 from private.post_approval_issue_upload_states where operation_id=
    (select (value->>'operationId')::uuid from late_results where label='downgrade-accept-ready') and status='provider_succeeded'),
  'denied valid acceptance leaves provider success and business evidence unchanged');
select throws_ok($$select public.prepare_post_approval_room_issue_evidence_delete(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-operation'),1,repeat('f',64))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded uploader cannot replay an existing delete barrier');
select throws_ok($$select public.settle_post_approval_room_issue_evidence_delete(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='downgrade-operation'),1,repeat('f',64),
  (select (value->>'deleteToken')::uuid from late_results where label='downgrade-delete'),'not_found')$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','downgraded uploader cannot settle after synthetic provider round trip');
select ok(exists(select 1 from private.post_approval_issue_delete_barriers b join private.post_approval_issue_provider_objects o on o.id=b.object_id
  where b.delete_token=(select (value->>'deleteToken')::uuid from late_results where label='downgrade-delete')
    and b.settled_at is null and o.purged_at is null and o.provider_file_id is not null),
  'denied creator and downgraded actor settlements preserve pending barrier and locator');
rollback to shared_admin_upload;
select pg_temp.save_late(p_client=>6091,p_key=>md5('admit-cas-draft')||md5('admit-cas-draft-key'));
insert into late_results values('admit-cas',public.admit_post_approval_room_issue_evidence_upload(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6091),pg_temp.lid(6291),1,0,0,repeat('d',64)));
savepoint admission_before_change;
select pg_temp.save_late(p_client=>6091,p_revision=>1,p_key=>md5('admit-cas-change')||md5('admit-cas-change-key'));
select throws_ok($$select public.admit_post_approval_room_issue_evidence_upload(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6091),pg_temp.lid(6291),1,0,0,repeat('d',64))$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID','unstarted admission retry rejects stale CAS before body decoding');
rollback to savepoint admission_before_change;
select public.begin_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'admissionId')::uuid from late_results where label='admit-cas'),repeat('a',64),'image/jpeg',100,repeat('d',64),repeat('b',64));
select pg_temp.save_late(p_client=>6091,p_revision=>1,p_key=>md5('admit-cas-change')||md5('admit-cas-change-key'));
select throws_ok($$select public.admit_post_approval_room_issue_evidence_upload(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6091),pg_temp.lid(6291),1,0,0,repeat('d',64))$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID','reserved admission retry rejects stale CAS before body decoding');
rollback to savepoint admission_retry_cas;
savepoint provider_wait_cas;
select pg_temp.save_late(p_client=>6090,p_key=>md5('provider-cas-draft')||md5('provider-cas-draft-key'));
insert into late_results values('provider-cas',pg_temp.typed_upload(6090,6290,0,0,false,false,false));
select is((select value->>'status' from late_results where label='provider-cas'),'reconciliation_pending','uncertain intent committed before synthetic external provider wait');
select pg_temp.save_late(p_client=>6090,p_revision=>1,p_key=>md5('provider-cas-change')||md5('provider-cas-change-key'));
select lives_ok($$select public.admit_post_approval_room_issue_evidence_upload(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6090),pg_temp.lid(6290),1,0,0,
  md5('6090:6290:0')||md5('typed609062900'))$$,'bound uncertain admission remains available for exact-identity reconciliation after CAS change');
select lives_ok($$select public.admit_post_approval_room_issue_quota_refresh(
  pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6090),pg_temp.lid(6290),1,0,0,
  md5('6090:6290:0')||md5('typed609062900'),repeat('6',64))$$,
  'stale bound uncertain retry can obtain a read-only quota refresh permit');
select lives_ok($$select public.get_post_approval_room_issue_evidence_provider_context(pg_temp.lid(2),pg_temp.lid(202),(select (value->>'operationId')::uuid from late_results where label='provider-cas'),1,repeat('f',64))$$,'stale draft can only inspect its exact bound uncertain identity');
select lives_ok($$select public.record_post_approval_room_issue_evidence_provider_success(pg_temp.lid(2),pg_temp.lid(202),(select (value->>'operationId')::uuid from late_results where label='provider-cas'),1,repeat('f',64),clock_timestamp())$$,'physical first-createdTime persists even when draft CAS changed during provider wait');
select throws_ok($$select public.finalize_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),(select (value->>'operationId')::uuid from late_results where label='provider-cas'),1,repeat('f',64))$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID','post-provider stale CAS returns409 with no acceptance/seal/delete');
select ok((select provider_created_at is not null from private.post_approval_issue_provider_objects where operation_id=(select (value->>'operationId')::uuid from late_results where label='provider-cas')),'stale response does not strand a real object without its immutable first clock');
rollback to savepoint provider_wait_cas;
-- Cold quota is read outside the DB in production. Here server metadata is
-- synthetic: assert the real DB permit couples ONE shared CPU charge to admission.
select pg_temp.save_late(p_client=>6030,p_key=>md5('quota-draft6030')||md5('quota-draft-key6030'),p_hash=>repeat('8',64));
create temp table quota_cpu_before as select occurrence_count from private.photo_upload_admission_limits where actor_profile_id=pg_temp.lid(2);
insert into late_results values('quota-permit',public.admit_post_approval_room_issue_quota_refresh(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6030),pg_temp.lid(6230),1,0,0,repeat('9',64),repeat('0',64)));
select is((select occurrence_count from private.photo_upload_admission_limits where actor_profile_id=pg_temp.lid(2)),
  coalesce((select occurrence_count from quota_cpu_before),0)+1,'quota read permit charges shared CPU exactly once');
select is(public.admit_post_approval_room_issue_quota_refresh(pg_temp.lid(2),pg_temp.lid(204),pg_temp.lid(4002),pg_temp.lid(6030),pg_temp.lid(6230),1,0,0,repeat('9',64),repeat('0',64)),
  (select value from late_results where label='quota-permit'),'same internal gate nonce response loss replays same permit with fresh session');
select is((select occurrence_count from private.photo_upload_admission_limits where actor_profile_id=pg_temp.lid(2)),
  coalesce((select occurrence_count from quota_cpu_before),0)+1,'permit replay does not charge CPU twice');
select is(private.post_approval_issue_extra_inflight(pg_temp.lid(2),clock_timestamp()),1::bigint,'one cold quota logical key reserves one inflight slot');
select lives_ok($$select public.refresh_post_approval_room_issue_quota(pg_temp.lid(2),pg_temp.lid(202),(select (value->>'permitId')::uuid from late_results where label='quota-permit'),clock_timestamp(),1000)$$,'owned quota permit refreshes shared latest snapshot after fresh CAS/barrier boundary');
insert into late_results values('quota-admission',public.admit_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6030),pg_temp.lid(6230),1,0,0,repeat('9',64),(select (value->>'permitId')::uuid from late_results where label='quota-permit')));
select is((select occurrence_count from private.photo_upload_admission_limits where actor_profile_id=pg_temp.lid(2)),
  coalesce((select occurrence_count from quota_cpu_before),0)+1,'permit-consuming admission does not double-charge normal31st limit');
select is(private.post_approval_issue_extra_inflight(pg_temp.lid(2),clock_timestamp()),1::bigint,'actual admission replaces quota permit capacity instead of doubling it');
select throws_ok($$select public.admit_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4001),pg_temp.lid(9999),pg_temp.lid(6230),1,0,0,repeat('9',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','same actor/upload key cannot move admission to another source/report');
select pg_temp.save_late(p_client=>6010,p_key=>repeat('1',64));
insert into late_results values('accepted',pg_temp.typed_upload(6010,6210));
select is((select value->>'status' from late_results where label='accepted'),'accepted','new typed evidence is actually accepted by DB provenance/CAS');
select is((select count(*) from private.post_approval_issue_evidence_acceptances),1::bigint,'one immutable typed acceptance');
select is((select value->>'itemRevision' from late_results where label='accepted'),'1','item CAS0 increments safely');
select is((select value->>'evidenceRevision' from late_results where label='accepted'),'1','collection CAS0 increments safely');
select is(public.get_post_approval_room_issue_draft(pg_temp.lid(2),pg_temp.lid(204),pg_temp.lid(4002),pg_temp.lid(6010))#>>'{evidence,0,evidenceId}',
  pg_temp.lid(6210)::text,'fresh creator-only recovery reads current typed evidence after response loss');
select throws_ok($$select public.get_post_approval_room_issue_draft(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002),pg_temp.lid(6010))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','foreign maid cannot use draft recovery for identity discovery');
select throws_ok($$select public.prepare_post_approval_room_issue_evidence_delete(pg_temp.lid(2),pg_temp.lid(202),(select (value->>'operationId')::uuid from late_results where label='accepted'),1,repeat('f',64))$$,
  '40001','POST_APPROVAL_ROOM_ISSUE_DELETE_NOT_ALLOWED','live accepted business evidence is never orphan');
select throws_ok($$select public.get_post_approval_room_issue_evidence_content(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(6210),1)$$,'42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','other maid cannot read typed evidence');
select lives_ok($$select public.get_post_approval_room_issue_evidence_content(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(6210),1)$$,'active admin can read exact typed evidence');
savepoint shared_admin_finalization;
insert into late_results values('admin-report',public.finalize_post_approval_room_issue_report(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),pg_temp.lid(6010),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(6210),'revision',1,'displayOrder',0)),repeat('2',64),repeat('3',64)));
set constraints all immediate;
set constraints all deferred;
select is((select value#>>'{report,reportedByProfileId}' from late_results where label='admin-report'),pg_temp.lid(1)::text,
  'shared finalization reports actual admin rather than draft creator');
select ok(exists(select 1 from private.post_approval_room_issue_reports where draft_created_by_profile_id=pg_temp.lid(2)
  and reported_by_profile_id=pg_temp.lid(1) and original_performer_profile_id=pg_temp.lid(2)),'creator performer and finalizer provenance remain separate');
select is(public.finalize_post_approval_room_issue_report(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),pg_temp.lid(6010),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(6210),'revision',1,'displayOrder',0)),repeat('2',64),repeat('3',64)),
  (select value from late_results where label='admin-report'),'admin report receipt replays exact sealed result');
select is((select actor_profile_id from public.audit_events where event_type='post_approval_room_issue.reported'),pg_temp.lid(1),
  'shared report audit records actual finalizer');
select is((select count(*) from private.notification_delivery_outbox where event_family='post_approval_room_issue.reported_admin'),0::bigint,
  'admin finalizer does not push to itself');
rollback to shared_admin_finalization;
insert into late_results values('report',public.finalize_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6010),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(6210),'revision',1,'displayOrder',0)),repeat('2',64),repeat('3',64)));
set constraints all immediate;
set constraints all deferred;
select is((select count(*) from private.post_approval_issue_report_seals),1::bigint,'actual typed report seal preserves immutable acceptance');
select is(jsonb_array_length(public.list_post_approval_room_issue_reports(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002))->'reports'),1,'source notice lets admin discover final report without old DTO or maid draft access');
select is(public.finalize_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(204),pg_temp.lid(4002),pg_temp.lid(6010),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(6210),'revision',1,'displayOrder',0)),repeat('2',64),repeat('3',64)),
  (select value from late_results where label='report'),'response loss replays report with renewed live session and no extra report/outbox');
select is((select count(*) from private.notification_delivery_outbox where event_family='post_approval_room_issue.reported_admin'),1::bigint,'one active non-self admin push outbox shares committed typed source');
select ok(not exists(select 1 from public.audit_events where event_type='post_approval_room_issue.reported' and (after_state::text like '%synthetic memo%' or after_state::text like '%6210%')),'report audit has no memo/photo identity');
select throws_ok($$select pg_temp.typed_upload(6010,6211,1)$$,'40001','POST_APPROVAL_ROOM_ISSUE_EVIDENCE_INVALID','seal blocks new upload or replacement');
-- Isolate historical-read behavior under later source states, not a claim that an
-- approved submission can be changed this way by production commands. Synthetic
-- source changes and temporary closure are rolled back before digest checks.
savepoint historical_source_rejection;
set local session_replication_role=replica;
update public.cleaning_submissions set status='rejected' where id=pg_temp.lid(4002);
set local session_replication_role=origin;
select is(public.get_post_approval_room_issue_source(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002))#>>'{source,sourceStatus}',
  'rejected','existing source remains readable after rejection');
select is(jsonb_array_length(public.list_post_approval_room_issue_reports(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002))->'reports'),1,
  'existing report remains discoverable after rejection');
select lives_ok($$select public.get_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),(select (value#>>'{report,reportId}')::uuid from late_results where label='report'))$$,
  'performer can still read the immutable report after rejection');
select lives_ok($$select public.get_post_approval_room_issue_evidence_content(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(6210),1)$$,
  'rejection does not revoke unexpired incident evidence');
select is(public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='accepted'))->>'status',
  'accepted','admin reads historical upload status after source rejection');
select is(public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='accepted'))->>'status',
  'accepted','own maid upload status survives source rejection');
select throws_ok($$select public.claim_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='accepted'),repeat('f',64))$$,
  '55000','POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE','historical status read does not permit a new execution claim');
select throws_ok($$select pg_temp.save_late(p_client=>6091)$$,'55000','POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE',
  'historical read permission does not bypass new-report source eligibility');
select lives_ok($$select public.close_post_approval_room_issue_report(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),(select (value#>>'{report,reportId}')::uuid from late_results where label='report'),0,repeat('4',64),repeat('5',64))$$,
  'admin can close an existing incident after source rejection');
rollback to savepoint historical_source_rejection;
savepoint historical_source_replacement;
set local session_replication_role=replica;
update public.cleaning_submissions set status='superseded' where id=pg_temp.lid(4002);
set local session_replication_role=origin;
select is(public.get_post_approval_room_issue_source(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002))#>>'{source,sourceStatus}',
  'superseded','replacement does not remove historical source projection');
select lives_ok($$select public.get_post_approval_room_issue_draft(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6010))$$,
  'creator can recover sealed draft metadata after source replacement');
select lives_ok($$select public.get_post_approval_room_issue_evidence_content(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(6210),1)$$,
  'performer can read unexpired incident evidence after replacement');
select is(public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(1),pg_temp.lid(201),
  (select (value->>'operationId')::uuid from late_results where label='accepted'))->>'status',
  'accepted','admin reads historical upload status after source replacement');
select is(public.get_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='accepted'))->>'status',
  'accepted','own maid upload status survives source replacement');
select throws_ok($$select public.renew_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),
  (select (value->>'operationId')::uuid from late_results where label='accepted'),1,repeat('f',64))$$,
  '55000','POST_APPROVAL_ROOM_ISSUE_SOURCE_UNAVAILABLE','historical status read cannot renew execution after replacement');
select throws_ok($$select public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','replacement never grants another maid source access');
select lives_ok($$select public.close_post_approval_room_issue_report(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),(select (value#>>'{report,reportId}')::uuid from late_results where label='report'),0,repeat('4',64),repeat('5',64))$$,
  'admin can close an existing incident after source replacement');
rollback to savepoint historical_source_replacement;
select is(public.get_post_approval_room_issue_report(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),
  (select (value#>>'{report,reportId}')::uuid from late_results where label='report'))#>'{report,closureRevision}',
  '0'::jsonb,'unclosed report reads closure revision zero');
select ok((public.list_post_approval_room_issue_reports(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002))#>'{reports,0}')
  @> '{"closureRevision":0,"closedAt":null,"closedByProfileId":null}'::jsonb,'unclosed list returns explicit null closure metadata');
select throws_ok($$select public.close_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),(select (value#>>'{report,reportId}')::uuid from late_results where label='report'),0,repeat('4',64),repeat('5',64))$$,
  '42501','ADMIN_REQUIRED','original performer cannot grant a close/retention anchor');
select lives_ok($$select public.close_post_approval_room_issue_report(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002),(select (value#>>'{report,reportId}')::uuid from late_results where label='report'),0,repeat('4',64),repeat('5',64))$$,'admin closes with separate immutable receipt');
savepoint closure_shared_read;
insert into auth.users(id) values(pg_temp.lid(1990));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.lid(990),pg_temp.lid(1990),'closure-reader','closure-reader','closure-reader','closure-reader',0,'admin','active',false);
insert into auth.sessions(id,user_id,not_after) values(pg_temp.lid(2990),pg_temp.lid(1990),clock_timestamp()+interval '1 day');
select ok((public.get_post_approval_room_issue_report(pg_temp.lid(990),pg_temp.lid(2990),pg_temp.lid(4002),
  (select (value#>>'{report,reportId}')::uuid from late_results where label='report'))->'report')
  @> (select jsonb_build_object('closureRevision',1,'closedAt',closed_at,'closedByProfileId',closed_by_profile_id)
    from private.post_approval_issue_report_closures),'another admin sees exact current closure time and original closing actor');
select ok((public.list_post_approval_room_issue_reports(pg_temp.lid(990),pg_temp.lid(2990),pg_temp.lid(4002))#>'{reports,0}')
  @> (select jsonb_build_object('closureRevision',1,'closedAt',closed_at,'closedByProfileId',closed_by_profile_id)
    from private.post_approval_issue_report_closures),'another admin list sees same current closure metadata');
select is(public.get_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),
  (select (value#>>'{report,reportId}')::uuid from late_results where label='report'))#>>'{report,closureRevision}',
  '1','entitled maid reads closure without obtaining close authority');
select throws_ok($$select public.get_post_approval_room_issue_report(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002),
  (select (value#>>'{report,reportId}')::uuid from late_results where label='report'))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','closure read does not open another maid source');
select is(public.finalize_post_approval_room_issue_report(pg_temp.lid(2),pg_temp.lid(204),pg_temp.lid(4002),pg_temp.lid(6010),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(6210),'revision',1,'displayOrder',0)),repeat('2',64),repeat('3',64)),
  (select value from late_results where label='report'),'closure does not rewrite immutable finalize receipt');
select is((select count(*) from private.post_approval_issue_report_closures),1::bigint,'reads and finalize replay never duplicate closure');
rollback to savepoint closure_shared_read;
select ok(private.post_approval_issue_delete_authority((select object_id from private.post_approval_issue_evidence_acceptances where evidence_id=pg_temp.lid(6210))) is null,'closed evidence is still retained before180d');
-- Synthetic anchor shift ONLY for the temporal boundary; original ledgers remain
-- unchanged. This is not a claim that production accepts caller clocks.
set local session_replication_role=replica;
update private.post_approval_issue_report_closures set closed_at=clock_timestamp()-interval '180 days 1 second';
set local session_replication_role=origin;
select is(private.post_approval_issue_delete_authority((select object_id from private.post_approval_issue_evidence_acceptances where evidence_id=pg_temp.lid(6210)))->>'reason','closed_report_180d','immutable typed closure is180d retention anchor');
insert into late_results values('purge',public.claim_post_approval_room_issue_purges(repeat('6',64),1));
select is(jsonb_array_length((select value->'items' from late_results where label='purge')),1,
  'first claim returns newly discovered due work in the same captured time window');
select is(public.claim_post_approval_room_issue_purges(repeat('6',64),1),
  (select value from late_results where label='purge'),'same claim replay preserves the active lease version');
insert into late_results values('delete',public.get_post_approval_room_issue_purge_context((select (value#>>'{items,0,objectId}')::uuid from late_results where label='purge'),1,repeat('6',64)));
select throws_ok($$select public.get_post_approval_room_issue_evidence_content(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(6210),1)$$,
  '55000','POST_APPROVAL_ROOM_ISSUE_MEDIA_PURGED','prepared delete prevents content/rebinding even before external confirmation');
select is(public.settle_post_approval_room_issue_purge((select (value#>>'{items,0,objectId}')::uuid from late_results where label='purge'),1,repeat('6',64),'not_found')->>'status','purged','synthetic404 settles only matching durable barrier/fence');
select is(public.settle_post_approval_room_issue_purge((select (value#>>'{items,0,objectId}')::uuid from late_results where label='purge'),1,repeat('6',64),'not_found')->>'status','purged','lost settle response replays safely');
select is((select count(*) from private.post_approval_issue_evidence_acceptances),1::bigint,'purge retains immutable acceptance metadata');
select is((select count(*) from private.post_approval_issue_identity_tombstones),1::bigint,'purged provider identity tombstone remains forever');
select ok(not has_function_privilege('authenticated','public.claim_post_approval_room_issue_purges(text,integer)','EXECUTE') and
  has_function_privilege('service_role','public.claim_post_approval_room_issue_purges(text,integer)','EXECUTE'),'worker RPCservice-only without requiring a new admin login');
savepoint single_transition_boundary;
-- BEGIN POST APPROVAL ROOM ISSUE SINGLE FIXTURE
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
select pg_temp.lid(7500),id,'additional',7,'retired',1,
  (select jsonb_agg(jsonb_build_object('slotKey','single-'||n,'required',n<10,'displayOrder',n-1,'label','synthetic single')) from generate_series(1,10)n),pg_temp.lid(1)
from public.room_types where code='standard';
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.lid(7510),r.id,'additional','manual_room_request','late-single-1',current_date,current_date,'notified',2,'{"code":"standard"}',10000,
  jsonb_build_object('id',t.id,'version',7,'photoSlots',t.photo_slots,'durationMinutes',1),pg_temp.lid(1)
from (select * from public.rooms where room_type_id=(select id from public.room_types where code='standard') order by room_number offset 20 limit 1) r
cross join public.cleaning_template_versions t where t.id=pg_temp.lid(7500);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by,service_date)
values(pg_temp.lid(7520),pg_temp.lid(7510),pg_temp.lid(2),100,2,clock_timestamp()-interval '2 hours',pg_temp.lid(1),current_date);
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
select pg_temp.lid(7530),id,pg_temp.lid(7520),pg_temp.lid(2),1,'field_completed',2,template_snapshot,jsonb_build_object('roomId',room_id),
  clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour' from public.cleaning_targets where id=pg_temp.lid(7510);
create function pg_temp.single_admission(p_slot text default 'single-1',p_key text default repeat('d',64)) returns jsonb language sql as $$
  select public.admit_photo_upload(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(7530),pg_temp.lid(7520),2,
    (select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.lid(7510) and slot_key=p_slot),0,p_key) $$;
create function pg_temp.single_begin(p_admission uuid,p_key text default repeat('d',64)) returns jsonb language sql as $$
  select public.begin_admitted_photo_upload(pg_temp.lid(2),pg_temp.lid(202),p_admission,repeat('a',64),'image/jpeg',100,p_key,repeat('b',64)) $$;
-- END POST APPROVAL ROOM ISSUE SINGLE FIXTURE
select pg_temp.save_late(p_client=>6060+n,p_key=>md5('single-mixed-draft'||n)||md5('single-mixed-key'||n)) from generate_series(1,7)n;
select public.admit_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6060+n),pg_temp.lid(6260+n),1,0,0,md5('single-mixed-upload'||n)||md5('single-mixed-upload-key'||n)) from generate_series(1,6)n;
select is(private.post_approval_issue_all_inflight(pg_temp.lid(2),clock_timestamp()),7::bigint,'six typed reservations plus prior cold admission make exactly seven');
insert into late_results values('single-admission',pg_temp.single_admission());
insert into late_results values('single-begin',pg_temp.single_begin((select (value->>'admissionId')::uuid from late_results where label='single-admission')));
select is(private.post_approval_issue_all_inflight(pg_temp.lid(2),clock_timestamp()),8::bigint,'matching legacy eighth admission transitions without counting itself twice');
select is(pg_temp.single_begin((select (value->>'admissionId')::uuid from late_results where label='single-admission')),
  (select value from late_results where label='single-begin'),'duplicate legacy core receipt returns exact operation without another slot');
select throws_ok($$select pg_temp.single_admission('single-2',repeat('e',64))$$,'54000','PHOTO_UPLOAD_LIMIT_EXCEEDED','unrelated ninth legacy admission remains denied');
select throws_ok($$select public.begin_photo_upload(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(7530),pg_temp.lid(7520),2,
  (select id from private.target_photo_slot_snapshots where cleaning_target_id=pg_temp.lid(7510) and slot_key='single-2'),0,repeat('a',64),'image/jpeg',100,repeat('e',64),repeat('b',64))$$,
  '54000','PHOTO_UPLOAD_LIMIT_EXCEEDED','direct core without exact admitted tuple receives no eighth-admission exemption');
select throws_ok($$select public.admit_post_approval_room_issue_evidence_upload(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002),pg_temp.lid(6067),pg_temp.lid(6267),1,0,0,repeat('c',64))$$,
  '54000','PHOTO_UPLOAD_LIMIT_EXCEEDED','ninth typed admission remains denied after single transition');
rollback to savepoint single_transition_boundary;
select is(pg_temp.old_digest(),(select digest from old_checkpoint),'whole old-state digest remains unchanged after upload/seal/close/purge/outbox');
select is(private.submission_projection(pg_temp.lid(4002)),(select old_dto from old_checkpoint),'old submission DTO unchanged after actual separate report');
select is((select expires_at-retention_starts_at from private.photo_retention_records where object_id=pg_temp.lid(5402)),interval '168 hours','old approval expiry not extended by new domain');
-- Synthetic historical assignment construction only; restore all guards before exercising access.
set local session_replication_role=replica;
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,
  notified_at,ended_at,changed_by,service_date)
values(pg_temp.lid(8800),pg_temp.lid(1002),pg_temp.lid(3),9,2,false,null,
  clock_timestamp()-interval '9 days',pg_temp.lid(1),(clock_timestamp() at time zone 'Asia/Seoul')::date-10);
set local session_replication_role=origin;
select throws_ok($$select public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','unnotified assignment does not authorize historical access');
set local session_replication_role=replica;
update public.cleaning_assignments set notified_at=clock_timestamp()-interval '10 days' where id=pg_temp.lid(8800);
set local session_replication_role=origin;
select lives_ok($$select public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002))$$,
  'ended notified nonperformer assignment authorizes its historical target');
select throws_ok($$select public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4001))$$,
  '42501','POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED','notification on another target grants no access');
select is((select original_performer_profile_id from private.post_approval_room_issue_source_authority(pg_temp.lid(4002))),
  pg_temp.lid(2),'historical access does not rewrite original performer');
select is((select id from private.post_approval_issue_notified_assignment(pg_temp.lid(3),pg_temp.lid(1002))),
  pg_temp.lid(8800),'grant lookup returns the exact notified historical assignment');
select ok(not has_function_privilege('service_role','private.post_approval_issue_notified_assignment(uuid,uuid)','EXECUTE'),
  'private history helper is not callable by service role');
insert into auth.sessions(id,user_id,not_after) values
  (pg_temp.lid(206),pg_temp.lid(103),clock_timestamp()+interval '1 day');
insert into late_results values('notified-source',public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002)));
select is((select value#>'{source,notifiedAssignmentAccess}' from late_results where label='notified-source'),
  jsonb_build_object('actorProfileId',pg_temp.lid(3),'sessionId',pg_temp.lid(203),'sourceSubmissionId',pg_temp.lid(4002),
    'assignmentId',pg_temp.lid(8800),'assignmentRevision',2,'notifiedAt',(select notified_at from public.cleaning_assignments where id=pg_temp.lid(8800))),
  'source response carries exact DB-owned historical assignment and current session');
insert into late_results values('notified-draft',pg_temp.save_late(p_actor=>3,p_client=>8801,p_key=>repeat('9',64),p_session=>203));
insert into late_results values('notified-replay',pg_temp.save_late(p_actor=>3,p_client=>8801,p_key=>repeat('9',64),p_session=>206));
select is((select value#>>'{source,notifiedAssignmentAccess,sessionId}' from late_results where label='notified-replay'),
  pg_temp.lid(206)::text,'receipt replay rebuilds authority for the new live session');
select is((select value#-'{source,notifiedAssignmentAccess}' from late_results where label='notified-replay'),
  (select value#-'{source,notifiedAssignmentAccess}' from late_results where label='notified-draft'),
  'logical command result remains identical across sessions');
select ok(not (private.replay_command(pg_temp.lid(3),'post_approval_room_issue.draft',repeat('9',64),repeat('b',64))->'source' ? 'notifiedAssignmentAccess'),
  'persisted receipt contains no session-bound authority');
select is((select count(*) from private.post_approval_room_issue_draft_revisions r join private.post_approval_room_issue_drafts d on d.id=r.draft_id
  where d.client_report_id=pg_temp.lid(8801)),1::bigint,'cross-session retry creates no second revision');
select is(public.get_post_approval_room_issue_draft(pg_temp.lid(3),pg_temp.lid(206),pg_temp.lid(4002),pg_temp.lid(8801))#>>'{source,notifiedAssignmentAccess,sessionId}',
  pg_temp.lid(206)::text,'own draft recovery emits fresh authority');
select is(public.list_post_approval_room_issue_reports(pg_temp.lid(3),pg_temp.lid(206),pg_temp.lid(4002))#>>'{source,notifiedAssignmentAccess,assignmentId}',
  pg_temp.lid(8800)::text,'report list emits the same target-specific authority');
select ok(not (public.get_post_approval_room_issue_source(pg_temp.lid(1),pg_temp.lid(201),pg_temp.lid(4002))->'source' ? 'notifiedAssignmentAccess'),
  'admin response needs no maid proof');
select ok(not (public.get_post_approval_room_issue_source(pg_temp.lid(2),pg_temp.lid(202),pg_temp.lid(4002))->'source' ? 'notifiedAssignmentAccess'),
  'original performer response remains compatible');
select ok(not has_function_privilege('service_role','private.post_approval_issue_authorized_response(jsonb,public.profiles,uuid,uuid)','EXECUTE'),
  'response authority helper cannot be directly invoked by service role');
select is(public.get_post_approval_room_issue_report(pg_temp.lid(3),pg_temp.lid(206),pg_temp.lid(4002),
  (select (value#>>'{report,reportId}')::uuid from late_results where label='report'))#>>'{source,notifiedAssignmentAccess,assignmentId}',
  pg_temp.lid(8800)::text,'single historical report emits exact notified assignment authority');
select lives_ok($$select pg_temp.typed_upload(8801,8802,p_actor=>3,p_session=>206)$$,
  'notified nonperformer completes own new evidence workflow with guards enabled');
insert into late_results values('notified-report',public.finalize_post_approval_room_issue_report(pg_temp.lid(3),pg_temp.lid(203),pg_temp.lid(4002),pg_temp.lid(8801),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(8802),'revision',1,'displayOrder',0)),repeat('7',64),repeat('8',64)));
insert into late_results values('notified-report-replay',public.finalize_post_approval_room_issue_report(pg_temp.lid(3),pg_temp.lid(206),pg_temp.lid(4002),pg_temp.lid(8801),1,1,'synthetic memo',
  jsonb_build_array(jsonb_build_object('evidenceId',pg_temp.lid(8802),'revision',1,'displayOrder',0)),repeat('7',64),repeat('8',64)));
select is((select value#>>'{source,notifiedAssignmentAccess,sessionId}' from late_results where label='notified-report-replay'),
  pg_temp.lid(206)::text,'finalize replay rebuilds authority for renewed session');
select is((select value#-'{source,notifiedAssignmentAccess}' from late_results where label='notified-report-replay'),
  (select value#-'{source,notifiedAssignmentAccess}' from late_results where label='notified-report'),'finalize logical result is unchanged on retry');
select ok(not (private.replay_command(pg_temp.lid(3),'post_approval_room_issue.finalize',repeat('7',64),repeat('8',64))->'source' ? 'notifiedAssignmentAccess'),
  'finalize receipt contains no session-bound proof');
select is((select count(*) from private.post_approval_room_issue_reports where client_report_id=pg_temp.lid(8801)),1::bigint,
  'notified finalization retry creates exactly one report');
select is((select count(*) from private.notification_delivery_outbox where event_family='post_approval_room_issue.reported_admin'),2::bigint,
  'notified reporter adds one admin notification without replay duplication');
set constraints all immediate;
set constraints all deferred;
update auth.sessions set not_after=clock_timestamp()-interval '1 day' where id=pg_temp.lid(206);
select throws_ok($$select pg_temp.save_late(p_actor=>3,p_client=>8801,p_key=>repeat('9',64),p_session=>206)$$,
  '42501','SESSION_REVOKED','expired notified-assignee session cannot replay success');
select throws_ok($$select public.get_post_approval_room_issue_source(pg_temp.lid(3),pg_temp.lid(206),pg_temp.lid(4002))$$,
  '42501','SESSION_REVOKED','historical assignment does not override source session expiry');
select * from finish();
rollback;
