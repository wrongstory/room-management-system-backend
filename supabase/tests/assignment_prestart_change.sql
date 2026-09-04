begin;
select no_plan();
create function pg_temp.pid(n integer) returns uuid language sql immutable as $$ select ('27000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) select pg_temp.pid(n+100) from generate_series(1,6) n;
select public.bootstrap_first_developer_profile(pg_temp.pid(6),pg_temp.pid(106),'개발자','개발자','0006','prestart-test-phone-hash','prestart-bootstrap-0001');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status)
select pg_temp.pid(n),pg_temp.pid(n+100),'prestart-'||n,'prestart-'||n,'prestart-'||n,'prestart-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,case when n=4 then 'inactive' else 'active' end::public.account_status
from generate_series(1,5) n;
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
select pg_temp.pid(n+200),pg_temp.pid(n),'2027-09-27',1,'2027-09-26 20:00+09' from generate_series(2,5) n;
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.pid(n+200),'2027-09-27'::date+d,n<>5 from generate_series(2,5) n cross join generate_series(0,6) d;
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,available_from,due_at,
  status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.pid(n+300),(select id from public.rooms order by room_number offset n limit 1),'additional','manual_room_request','prestart-target-'||n,
  '2027-10-01','2027-10-01','2027-10-01 09:00+09','2027-10-01 15:00+09',
  case when n<=4 then 'draft_assigned' else 'notified' end::public.cleaning_target_status,2,'{}',10000,'{}',pg_temp.pid(1)
from generate_series(1,12) n;
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
select pg_temp.pid(n+400),pg_temp.pid(n+300),pg_temp.pid(2),n,2,pg_temp.pid(1),case when n>4 then clock_timestamp() end from generate_series(1,12) n;
insert into public.notifications(recipient_profile_id,category,title,body,cleaning_target_id,dedupe_key,requires_action)
select pg_temp.pid(2),'cleaning_assignment_notified','테스트','합성 배정',pg_temp.pid(n+300),'initial-prestart-'||n,true from generate_series(5,12) n;

create function pg_temp.command(n integer,action text,k text,maid integer default 2,seq integer default 30,
  request_id uuid default null,decision text default 'approved',version bigint default null,assignment uuid default null,
  access_at timestamptz default null,deadline timestamptz default null,actor integer default 1,hash text default repeat('a',64))
returns jsonb language plpgsql as $$
declare a uuid; v bigint;
begin
  select id into a from public.cleaning_assignments where cleaning_target_id=pg_temp.pid(n+300) and is_current;
  select assignment_version into v from public.cleaning_targets where id=pg_temp.pid(n+300);
  a:=coalesce(assignment,a);v:=coalesce(version,v);
  case action
    when 'change' then return public.change_cleaning_assignment_prestart(pg_temp.pid(actor),pg_temp.pid(n+300),a,v,pg_temp.pid(maid),seq,'OPERATIONAL_CHANGE',k,hash,access_at,deadline);
    when 'unassign' then return public.unassign_cleaning_assignment_prestart(pg_temp.pid(actor),pg_temp.pid(n+300),a,v,'OPERATIONAL_CHANGE',k,hash);
    when 'request' then return public.request_assignment_cancellation(pg_temp.pid(maid),pg_temp.pid(n+300),a,v,'PERSONAL_REASON',k,hash,'개인 일정 조정');
    when 'decision' then return public.decide_assignment_cancellation_request(pg_temp.pid(actor),request_id,a,v,decision,'OPERATIONAL_CHANGE',k,hash);
  end case;
end;
$$;
create temp table results(name text primary key,value jsonb);
insert into results values('draft',pg_temp.command(1,'change','draft-reassign-0001',3,30));
select is((select value->>'maidProfileId' from results where name='draft'),pg_temp.pid(3)::text,'draft reassignment');
select is((select revision from public.cleaning_assignments where cleaning_target_id=pg_temp.pid(301) and is_current),3::bigint,'revision increments');
select is((select count(*) from public.cleaning_assignments where cleaning_target_id=pg_temp.pid(301) and is_current),1::bigint,'one current');
select ok((select not is_current and maid_profile_id=pg_temp.pid(2) and sequence_number=1 from public.cleaning_assignments where id=pg_temp.pid(401)),'old immutable snapshot retained');
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.pid(301)),0::bigint,'draft no notification');
select is(pg_temp.command(1,'change','draft-reassign-0001',3,30,version=>2,assignment=>pg_temp.pid(401)),(select value from results where name='draft'),'exact replay response');
select throws_ok($$select pg_temp.command(1,'change','draft-reassign-0001',hash=>repeat('b',64))$$,'23505','IDEMPOTENCY_KEY_REUSED','different hash conflicts');
select lives_ok($$select pg_temp.command(2,'change','draft-sequence-0002',2,31)$$,'draft sequence revision');
select lives_ok($$select pg_temp.command(3,'change','draft-schedule-0003',2,32,access_at=>'2027-10-01 10:00+09',deadline=>'2027-10-01 14:00+09')$$,'draft narrow schedule');
select is((select count(*) from public.cleaning_target_schedule_revisions where cleaning_target_id=pg_temp.pid(303)),1::bigint,'schedule revision append');
select lives_ok($$select pg_temp.command(4,'unassign','draft-unassign-0004')$$,'draft unassign');
select is((select status::text from public.cleaning_targets where id=pg_temp.pid(304)),'unassigned','unassign is not target cancel');
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.pid(304)),0::bigint,'draft unassign no notice');

insert into results values('notified',pg_temp.command(5,'change','notify-reassign-0005',3,33));
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.pid(305)),3::bigint,'notified old plus revoke and new notice');
select ok((select resolved_at is not null from public.notifications where dedupe_key='initial-prestart-5'),'old notice preserved/resolved');
select is((select count(*) from private.notification_outbox o join public.notifications n on n.id=o.notification_id where n.cleaning_target_id=pg_temp.pid(305)),2::bigint,'two delivery rows');
select lives_ok($$select pg_temp.command(5,'change','notify-reassign-0005',3,33,version=>2,assignment=>pg_temp.pid(405))$$,'notified replay');
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.pid(305)),3::bigint,'replay no new notices');
select lives_ok($$select pg_temp.command(6,'change','notify-sequence-0006',2,34)$$,'notified same maid sequence');
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.pid(306)),2::bigint,'same maid one change notice');
select lives_ok($$select pg_temp.command(7,'unassign','notify-unassign-0007')$$,'notified unassign');
select is((select count(*) from public.notifications where cleaning_target_id=pg_temp.pid(307)),2::bigint,'unassign one revoke');

select throws_ok($$select pg_temp.command(1,'change','bad-version-0001',version=>2)$$,'40001','ASSIGNMENT_VERSION_CONFLICT','stale version');
select throws_ok($$select pg_temp.command(1,'change','bad-identity-0001',assignment=>pg_temp.pid(402))$$,'40001','ASSIGNMENT_VERSION_CONFLICT','wrong current identity');
select throws_ok($$select pg_temp.command(1,'change','inactive-maid-0001',4)$$,'23514','ASSIGNMENT_MAID_UNAVAILABLE','inactive maid');
select throws_ok($$select pg_temp.command(1,'change','unavailable-maid-0001',5)$$,'23514','ASSIGNMENT_MAID_UNAVAILABLE','unavailable maid');
select throws_ok($$select pg_temp.command(1,'change','duplicate-sequence-0001',3,33)$$,'23514','ASSIGNMENT_SEQUENCE_CONFLICT','unique sequence');
select throws_ok($$select pg_temp.command(1,'change','extend-window-0001',access_at=>'2027-10-01 08:00+09')$$,'23514','ASSIGNMENT_SCHEDULE_INVALID','cannot widen source access');
select throws_ok($$update public.cleaning_assignments set sequence_number=999 where id=pg_temp.pid(401)$$,'23514','ASSIGNMENT_SNAPSHOT_IMMUTABLE','history immutable');

select throws_ok($$select pg_temp.command(8,'request','wrong-owner-0008',3)$$,'42501','ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED','other maid request forbidden');
select throws_ok($$select pg_temp.command(2,'request','draft-request-0002')$$,'23514','ASSIGNMENT_PRESTART_REQUIRED','draft cannot request');
insert into results values('approve',pg_temp.command(8,'request','maid-request-0008'));
select is((select status from public.assignment_change_requests where assignment_id=pg_temp.pid(408)),'pending','own request pending');
select ok((select is_current from public.cleaning_assignments where id=pg_temp.pid(408)),'request preserves assignment');
select is((select count(*) from public.notifications where category='assignment_cancellation_requested'),1::bigint,'active admin request notice only');
select throws_ok($$select pg_temp.command(8,'request','second-request-0008')$$,'23514','ASSIGNMENT_CHANGE_REQUEST_EXISTS','pending exactly one');
select lives_ok($$select pg_temp.command(8,'decision','approve-request-0008',request_id=>(select (value->>'requestId')::uuid from results where name='approve'))$$,'approve request');
select is((select status::text from public.cleaning_targets where id=pg_temp.pid(308)),'unassigned','approval releases assignment');
select is((select status from public.assignment_change_requests where assignment_id=pg_temp.pid(408)),'approved','approved not superseded');
select throws_ok($$update public.assignment_change_requests set status='rejected' where assignment_id=pg_temp.pid(408)$$,'23514','ASSIGNMENT_CHANGE_REQUEST_IMMUTABLE','decision immutable');
select throws_ok($$delete from public.assignment_change_requests where assignment_id=pg_temp.pid(408)$$,'23514','ASSIGNMENT_CHANGE_REQUEST_IMMUTABLE','request delete forbidden');
insert into results values('reject',pg_temp.command(9,'request','maid-request-0009'));
select lives_ok($$select pg_temp.command(9,'decision','reject-request-0009',request_id=>(select (value->>'requestId')::uuid from results where name='reject'),decision=>'rejected')$$,'reject request');
select ok((select is_current from public.cleaning_assignments where id=pg_temp.pid(409)),'reject retains assignment');
select throws_ok($$select pg_temp.command(9,'decision','second-decision-0009',request_id=>(select (value->>'requestId')::uuid from results where name='reject'))$$,'23514','ASSIGNMENT_CHANGE_REQUEST_ALREADY_DECIDED','no second decision');
insert into results values('stale',pg_temp.command(10,'request','maid-request-0010'));
select lives_ok($$select pg_temp.command(10,'change','supersede-request-0010',3,35)$$,'reassignment supersedes request');
select is((select status from public.assignment_change_requests where assignment_id=pg_temp.pid(410)),'superseded','no ghost pending');
select throws_ok($$select pg_temp.command(10,'decision','stale-request-0010',request_id=>(select (value->>'requestId')::uuid from results where name='stale'))$$,'40001','ASSIGNMENT_CHANGE_REQUEST_STALE','stale cannot cancel new assignment');

insert into results values('started',pg_temp.command(11,'request','maid-request-0011'));
insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot)
values(pg_temp.pid(311),pg_temp.pid(411),pg_temp.pid(2),1,'scheduled',2,'{}','{}');
select throws_ok($$select pg_temp.command(11,'change','started-change-0011')$$,'23514','ASSIGNMENT_ALREADY_STARTED','attempt without started_at blocks change');
select throws_ok($$select pg_temp.command(11,'unassign','started-unassign-0011')$$,'23514','ASSIGNMENT_ALREADY_STARTED','attempt blocks unassign');
select throws_ok($$select pg_temp.command(11,'request','started-request-0011')$$,'23514','ASSIGNMENT_ALREADY_STARTED','attempt blocks request');
select throws_ok($$select pg_temp.command(11,'decision','started-decision-0011',request_id=>(select (value->>'requestId')::uuid from results where name='started'),decision=>'rejected')$$,'23514','ASSIGNMENT_ALREADY_STARTED','attempt blocks even rejection');
select throws_ok($$insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,assignment_revision,template_snapshot,room_snapshot)
values(pg_temp.pid(301),pg_temp.pid(401),pg_temp.pid(2),1,2,'{}','{}')$$,'40001','ASSIGNMENT_VERSION_CONFLICT','stale activation blocked');

select ok(jsonb_array_length(public.list_assignment_change_requests(pg_temp.pid(1)))>=4,'admin request list');
select ok(jsonb_array_length(public.list_assignment_change_requests(pg_temp.pid(2)))>=4,'maid self request list');
select is(jsonb_array_length(public.list_assignment_change_requests(pg_temp.pid(3))),0,'other maid list empty');
select throws_ok($$select public.list_assignment_change_requests(pg_temp.pid(6))$$,'42501','ASSIGNMENT_ACCESS_REQUIRED','developer no business list');
select throws_ok($$select public.list_assignment_change_requests(pg_temp.pid(4))$$,'42501','ASSIGNMENT_ACCESS_REQUIRED','inactive no list');
select throws_ok($$select public.list_assignment_change_requests(pg_temp.pid(1),p_limit=>101)$$,'22023','ASSIGNMENT_QUERY_INVALID','limit 100');
select throws_ok($$select public.list_assignment_change_requests(pg_temp.pid(1),p_from=>now()-interval '32 days')$$,'22023','ASSIGNMENT_QUERY_INVALID','31 day bound');
select throws_ok($$select public.list_assignment_change_requests(pg_temp.pid(1),p_before_at=>now())$$,'22023','ASSIGNMENT_QUERY_INVALID','paired cursor');
select is(jsonb_array_length(public.list_assignment_change_requests(pg_temp.pid(1),p_limit=>1)),1,'bounded first page');
insert into results values('page-one',public.list_assignment_change_requests(pg_temp.pid(1),p_limit=>1)->0);
select ok(not exists(select 1 from jsonb_array_elements(public.list_assignment_change_requests(pg_temp.pid(1),
  p_before_at=>(select (value->>'requestedAt')::timestamptz from results where name='page-one'),
  p_before_id=>(select (value->>'requestId')::uuid from results where name='page-one'))) item
  where item->>'requestId'=(select value->>'requestId' from results where name='page-one')),'cursor next page excludes prior row');
select ok(not exists(select 1 from public.list_developer_audit_events(pg_temp.pid(6)) where event_type like 'assignment.%'
  and (summary ?| array['requestHash','reasonDetail','before_state','after_state','notificationBody'])),'safe developer audit only');
select is((select count(distinct event_type) from public.list_developer_audit_events(pg_temp.pid(6)) where event_type in
  ('assignment.prestart_changed','assignment.prestart_unassigned','assignment.cancellation_requested','assignment.cancellation_decided')),4::bigint,'all four audit event types visible');
select ok(not has_function_privilege('anon','public.change_cleaning_assignment_prestart(uuid,uuid,uuid,bigint,uuid,integer,text,text,text,timestamptz,timestamptz)','execute')
  and not has_function_privilege('authenticated','public.request_assignment_cancellation(uuid,uuid,uuid,bigint,text,text,text,text)','execute'),'privileged RPCs private');
select ok(not has_table_privilege('authenticated','public.assignment_change_requests','INSERT')
  and not has_table_privilege('authenticated','public.assignment_change_requests','UPDATE')
  and not has_table_privilege('authenticated','public.assignment_change_requests','DELETE'),'direct writes revoked');
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.pid(102)::text,true);
select is((select count(*) from public.assignment_change_requests),4::bigint,'maid self RLS');
select set_config('request.jwt.claim.sub',pg_temp.pid(103)::text,true);
select is((select count(*) from public.assignment_change_requests),0::bigint,'other maid RLS');
select set_config('request.jwt.claim.sub',pg_temp.pid(106)::text,true);
select is((select count(*) from public.assignment_change_requests),0::bigint,'developer RLS zero');
select set_config('request.jwt.claim.sub',pg_temp.pid(101)::text,true);
select is((select count(*) from public.assignment_change_requests),4::bigint,'admin RLS all');
reset role;
select ok(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace,
  unnest(array['anon','authenticated']) client_role where n.nspname='public'
  and p.proname in ('change_cleaning_assignment_prestart','unassign_cleaning_assignment_prestart',
    'request_assignment_cancellation','decide_assignment_cancellation_request','list_assignment_change_requests')
  and has_function_privilege(client_role,p.oid,'execute')),'all five public RPCs deny client roles/PUBLIC defaults');
update public.profiles set status='upload_only' where id=pg_temp.pid(2);
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.pid(102)::text,true);
select is((select count(*) from public.assignment_change_requests),0::bigint,'upload-only cannot read general requests');
reset role;
update public.profiles set status='active' where id=pg_temp.pid(2);
-- 재청소는 원 maid에게만 귀속한다. #27 재배정도 같은 불변식을 재검증한다.
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,ended_at,end_reason,template_snapshot,room_snapshot)
values(pg_temp.pid(512),pg_temp.pid(312),pg_temp.pid(412),pg_temp.pid(2),1,'rejected',2,now(),'INSPECTION_REJECTED','{}','{}');
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,
  available_from,due_at,room_type_snapshot,fee_snapshot,template_snapshot,created_by,reclean_of_attempt_id,reclean_maid_profile_id)
select pg_temp.pid(313),room_id,'reclean','inspection_reclean','prestart-reclean','2027-10-01','2027-10-01',available_from,due_at,'{}',0,'{}',pg_temp.pid(1),pg_temp.pid(512),pg_temp.pid(2)
from public.cleaning_targets where id=pg_temp.pid(312);
select public.save_cleaning_assignment_draft(pg_temp.pid(1),pg_temp.pid(313),pg_temp.pid(2),40,1,'prestart-reclean-draft',repeat('d',64));
select throws_ok($$select pg_temp.command(13,'change','reclean-wrong-maid-0013',3,40)$$,'23514','RECLEAN_MAID_IMMUTABLE','prestart cannot reassign reclean to other maid');
select lives_ok($$select pg_temp.command(13,'change','reclean-sequence-0013',2,41)$$,'reclean sequence change retains original maid');
select * from finish();
rollback;
