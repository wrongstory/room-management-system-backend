begin;
select no_plan();

-- BEGIN MANUAL CANCEL SHARED FIXTURE
\ir room_pin_fixture.psql
create function pg_temp.cancel_id(n integer) returns uuid language sql immutable as $$
  select ('34800000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) select pg_temp.cancel_id(100+n) from generate_series(1,7) n;
select public.bootstrap_first_developer_profile(pg_temp.cancel_id(7),pg_temp.cancel_id(107),
  '수동 취소 개발자','수동 취소 개발자','0007','cancel-fixture-phone-hash','manual-cancel-bootstrap');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.cancel_id(n),pg_temp.cancel_id(100+n),'manual-cancel-'||n,'manual-cancel-'||n,
  'manual-cancel-'||n,'manual-cancel-'||n,0,
  case when n in(1,4,5,6) then 'admin' else 'maid' end::public.app_role,
  case when n=4 then 'inactive' when n=5 then 'upload_only' else 'active' end::public.account_status,
  n=6 from generate_series(1,6) n;
insert into auth.sessions(id,user_id) select pg_temp.cancel_id(200+n),pg_temp.cancel_id(100+n)
  from generate_series(1,3) n;
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,duration_minutes,
  photo_slots,published_at,created_by)
select rt.id,k,1,'published',case when k='checkout' then null else 30 end,'[]'::jsonb,clock_timestamp(),pg_temp.cancel_id(1)
from public.room_types rt cross join unnest(array['checkout','stayover','additional']::public.cleaning_kind[]) k;

create function pg_temp.manual_cancel_fixture(n integer,p_kind public.cleaning_kind default 'additional',
  p_status public.cleaning_target_status default 'notified',p_attempt boolean default true,
  p_day date default '2041-06-07') returns void language plpgsql as $$
declare v_room_id uuid; request_id uuid:=pg_temp.cancel_id(1000+n);
  assignment_id uuid:=pg_temp.cancel_id(2000+n); v_reservation_id uuid;
begin
  select r.id into v_room_id from public.rooms r order by room_number offset n limit 1;
  perform pg_temp.install_room_pin_fixture(v_room_id,pg_temp.cancel_id(1),1);
  insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
  values(v_room_id,'verified',1,'TEST',pg_temp.cancel_id(1),clock_timestamp());
  if p_kind='stayover' then
    v_reservation_id:=pg_temp.cancel_id(4000+n);
    perform public.create_reservation(pg_temp.cancel_id(1),v_reservation_id,v_room_id,
      (p_day-1)::timestamp at time zone 'Asia/Seoul',
      (p_day+1)::timestamp at time zone 'Asia/Seoul',2,null,
      (select state_version from public.rooms where id=v_room_id),'manual-cancel-reservation-'||n,repeat('1',64));
    -- Only the actual check-in projection is fixture setup; all request provenance
    -- and the private checkout graph come from the production commands.
    update public.reservations set actual_check_in_at=check_in_at where id=v_reservation_id;
  end if;
  perform public.create_manual_cleaning_request(pg_temp.cancel_id(1),request_id,v_room_id,v_reservation_id,p_kind,
    p_day,(p_day::timestamp at time zone 'Asia/Seoul'),
    (p_day::timestamp at time zone 'Asia/Seoul')+interval '23 hours',
    (select state_version from public.rooms where id=v_room_id),'MANUAL_CANCEL_TEST',
    'manual-cancel-create-'||n,repeat('2',64));
  if p_status<>'unassigned' then
    update public.cleaning_targets set assignment_version=2,status=p_status where id=request_id;
    insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
      notified_at,changed_by)
    values(assignment_id,request_id,pg_temp.cancel_id(2),n,2,
      case when p_status='notified' then clock_timestamp() end,pg_temp.cancel_id(1));
    if p_status='notified' then
      perform private.emit_notification_v1('assignment.commit_notified',pg_temp.cancel_id(1),pg_temp.cancel_id(2),
        'cleaning_assignment',assignment_id::text,'합성 청소 배정','합성 청소 배정입니다.',
        v_room_id,request_id,request_id,clock_timestamp());
    end if;
    if p_attempt then
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
        assignment_revision,template_snapshot,room_snapshot)
      select pg_temp.cancel_id(3000+n),request_id,assignment_id,pg_temp.cancel_id(2),1,'scheduled',2,
        template_snapshot,room_type_snapshot||jsonb_build_object('roomId',v_room_id)
      from public.cleaning_targets where id=request_id;
    end if;
  end if;
end $$;
create function pg_temp.manual_cancel(n integer,p_actor integer default 1,p_version bigint default null,
  p_key text default null,p_hash text default repeat('3',64),p_session uuid default null) returns jsonb language plpgsql as $$
begin
  return public.cancel_manual_cleaning_request_with_session(pg_temp.cancel_id(p_actor),
    coalesce(p_session,pg_temp.cancel_id(200+p_actor)),pg_temp.cancel_id(1000+n),
    coalesce(p_version,(select assignment_version from public.cleaning_targets where id=pg_temp.cancel_id(1000+n))),
    'CUSTOM_CANCEL_REASON',coalesce(p_key,'manual-cancel-command-'||n),p_hash);
end
$$;
create function pg_temp.manual_cancel_snapshot() returns text language sql stable as $$
  select md5(string_agg(tag||':'||data,'|' order by tag,data)) from (
    select 'target' tag,row_to_json(t)::text data from public.cleaning_targets t union all
    select 'assignment',row_to_json(t)::text from public.cleaning_assignments t union all
    select 'attempt',row_to_json(t)::text from public.cleaning_attempts t union all
    select 'schedule',row_to_json(t)::text from public.cleaning_target_schedule_revisions t union all
    select 'room',row_to_json(t)::text from public.rooms t union all
    select 'entitlement',row_to_json(t)::text from private.room_pin_assignment_entitlements t union all
    select 'reveal',row_to_json(t)::text from private.room_pin_reveal_leases t union all
    select 'legacy-lease',row_to_json(t)::text from public.room_pin_access_leases t union all
    select 'audit',row_to_json(t)::text from public.audit_events t union all
    select 'receipt',row_to_json(t)::text from private.command_executions t union all
    select 'notice',row_to_json(t)::text from public.notifications t union all
    select 'group',row_to_json(t)::text from private.notification_groups t union all
    select 'delivery',row_to_json(t)::text from private.notification_delivery_outbox t union all
    select 'sensitive-access',row_to_json(t)::text from private.actor_activity_events t
  ) protected
$$;
create function pg_temp.cancel_target_snapshot(n integer) returns jsonb language sql stable as $$
  select jsonb_build_object('target',to_jsonb(t)-array['status','assignment_version','cancelled_by',
    'cancelled_at','cancellation_reason_code','updated_at'],
    'schedule',(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]')
      from public.cleaning_target_schedule_revisions s where s.cleaning_target_id=t.id),
    'assignments',(select coalesce(jsonb_agg(to_jsonb(a)-array['is_current','ended_at','change_reason_code'] order by id),'[]')
      from public.cleaning_assignments a where a.cleaning_target_id=t.id),
    'attempts',(select coalesce(jsonb_agg(to_jsonb(a)-array['status','ended_at','end_reason','updated_at','execution_version'] order by id),'[]')
      from public.cleaning_attempts a where a.cleaning_target_id=t.id))
  from public.cleaning_targets t where t.id=pg_temp.cancel_id(1000+n)
$$;
-- END MANUAL CANCEL SHARED FIXTURE

select pg_temp.manual_cancel_fixture(1,'additional','unassigned',false);
select pg_temp.manual_cancel_fixture(2,'stayover','unassigned',false);
select pg_temp.manual_cancel_fixture(3,'additional','draft_assigned',false);
select pg_temp.manual_cancel_fixture(4,'stayover','draft_assigned',false);
select pg_temp.manual_cancel_fixture(5,'additional','notified',false);
select pg_temp.manual_cancel_fixture(6,'stayover','notified',false);
select pg_temp.manual_cancel_fixture(7,'additional','notified',true);
select pg_temp.manual_cancel_fixture(8,'stayover','notified',true);
create temp table preserved(n integer primary key,value jsonb);
insert into preserved select n,pg_temp.cancel_target_snapshot(n) from generate_series(1,8) n;
create temp table result(n integer primary key,value jsonb);
insert into result select n,pg_temp.manual_cancel(n) from generate_series(1,8) n;
select is((select status::text from public.cleaning_targets where id=pg_temp.cancel_id(1000+n)),'cancelled',
  'manual source-kind/state matrix '||n||' cancels') from generate_series(1,8) n;
select is((select assignment_version from public.cleaning_targets where id=pg_temp.cancel_id(1000+n)),
  case when n<=2 then 2 else 3 end::bigint,'matrix '||n||' advances target CAS once') from generate_series(1,8) n;
select ok((select cancelled_by=pg_temp.cancel_id(1) and cancelled_at is not null
  and cancellation_reason_code='CUSTOM_CANCEL_REASON' from public.cleaning_targets where id=pg_temp.cancel_id(1000+n)),
  'matrix '||n||' preserves cancellation actor/time/reason') from generate_series(1,8) n;
select is(pg_temp.cancel_target_snapshot(cases.n),(select value from preserved where preserved.n=cases.n),
  'matrix '||cases.n||' preserves source/room/fee/template/dates/schedule and assignment/attempt identity') from generate_series(1,8) cases(n);
select ok(not exists(select 1 from public.cleaning_assignments where cleaning_target_id=pg_temp.cancel_id(1000+n) and is_current),
  'matrix '||n||' ends only the current assignment') from generate_series(1,8) n;
select is((select count(*)::int from public.cleaning_attempts where cleaning_target_id=pg_temp.cancel_id(1000+n) and status='superseded'),
  case when n>=7 then 1 else 0 end,'matrix '||n||' retires scheduled work without manufacturing a start') from generate_series(1,8) n;
select is((select execution_version from public.cleaning_attempts where id=pg_temp.cancel_id(3000+n)),2::bigint,
  'scheduled matrix '||n||' advances execution CAS exactly once while preserving timestamps') from generate_series(7,8) n;
select is((select after_state->>'cancelledAssignmentId' from public.audit_events
  where event_type='cleaning.manual_request.cancelled' and entity_id=pg_temp.cancel_id(1000+n)),
  case when n>2 then pg_temp.cancel_id(2000+n)::text end,'matrix '||n||' audit binds exact cancelled assignment or null') from generate_series(1,8) n;
select ok(not ((select value from result where result.n=cases.n) ? 'cancelledAssignmentId'),
  'matrix '||cases.n||' keeps the public cancellation response unchanged') from generate_series(1,8) cases(n);
select is((select count(*)::int from public.notifications where cleaning_target_id=pg_temp.cancel_id(1000+n)
  and event_family='cleaning_request.cancelled_revoked'),case when n>=5 then 1 else 0 end,
  'matrix '||n||' notifies only a current notified owner') from generate_series(1,8) n;
select is((select count(*)::int from private.notification_delivery_outbox o join public.notifications notice on notice.id=o.notification_id
  where notice.cleaning_target_id=pg_temp.cancel_id(1000+n) and notice.event_family='cleaning_request.cancelled_revoked'),
  case when n>=5 then 1 else 0 end,'matrix '||n||' commits one typed informational push outbox only when notified') from generate_series(1,8) n;
select ok((select bool_and(resolved_at is not null) from public.notifications
  where cleaning_target_id=pg_temp.cancel_id(1000+n) and event_family='assignment.commit_notified'),
  'notified matrix '||n||' preserves and resolves the original assignment notice') from generate_series(5,8) n;

-- Legacy disclosure evidence, including an expired but unrevoked lease, does
-- not become a cancellation condition. Original reveal timestamps are retained.
select pg_temp.manual_cancel_fixture(n) from generate_series(10,12) n;
insert into public.room_pin_access_leases(id,room_id,reservation_id,cleaning_target_id,assignment_id,attempt_id,
  pin_version,issued_to,issued_at,expires_at,revealed_at,revoked_at,revoke_reason_code)
select pg_temp.cancel_id(5000+n),t.room_id,null,t.id,pg_temp.cancel_id(2000+n),pg_temp.cancel_id(3000+n),1,
  pg_temp.cancel_id(2),clock_timestamp()-interval '2 minutes',
  case when n=10 then clock_timestamp()+interval '1 minute' else clock_timestamp()-interval '1 minute' end,
  clock_timestamp()-interval '90 seconds',case when n=12 then clock_timestamp()-interval '30 seconds' end,
  case when n=12 then 'TEST_ALREADY_REVOKED' end
from generate_series(10,12) n join public.cleaning_targets t on t.id=pg_temp.cancel_id(1000+n);
create temp table legacy_before as select id,revealed_at,issued_at,expires_at,revoked_at,revoke_reason_code
  from public.room_pin_access_leases;
select lives_ok(format('select pg_temp.manual_cancel(%s)',n),'legacy revealed lease case '||n||' does not prevent cancellation')
  from generate_series(10,12) n;
select ok(not exists(select 1 from public.room_pin_access_leases l join legacy_before b using(id)
  where l.revealed_at is distinct from b.revealed_at or l.issued_at<>b.issued_at or l.expires_at<>b.expires_at),
  'cancellation preserves every legacy disclosure timestamp');
select ok((select revoked_at is not null and revoke_reason_code='MANUAL_REQUEST_CANCELLED'
  from public.room_pin_access_leases where id=pg_temp.cancel_id(5000+n)),
  'legacy case '||n||' closes subsequent lease access') from generate_series(10,11) n;
select ok((select l.revoked_at=b.revoked_at and l.revoke_reason_code=b.revoke_reason_code
  from public.room_pin_access_leases l join legacy_before b using(id) where l.id=pg_temp.cancel_id(5012)),
  'already revoked legacy history is not rewritten');

-- Current private reveal path: open, successfully finalized and expired
-- finalized history all permit cancellation before start.
select pg_temp.manual_cancel_fixture(n) from generate_series(13,15) n;
insert into result select n,public.begin_room_pin_reveal(pg_temp.cancel_id(2),pg_temp.cancel_id(202),t.room_id,
  pg_temp.cancel_id(2000+n),null,null,pg_temp.cancel_id(6000+n))
from generate_series(13,14) n join public.cleaning_targets t on t.id=pg_temp.cancel_id(1000+n);
select public.finalize_room_pin_reveal(pg_temp.cancel_id(2),pg_temp.cancel_id(202),t.room_id,
  (r.value->>'lease_id')::uuid,pg_temp.cancel_id(6014))
from result r join public.cleaning_targets t on t.id=pg_temp.cancel_id(1014) where r.n=14;
insert into private.room_pin_reveal_leases(id,room_id,pin_revision_id,pin_version,actor_profile_id,actor_role_snapshot,
  assignment_id,entitlement_id,assignment_revision,issued_at,expires_at,finalized_at,request_id)
select pg_temp.cancel_id(7015),room_id,pin_revision_id,pin_version,maid_profile_id,'maid',assignment_id,id,assignment_revision,
  statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '91 seconds',statement_timestamp()-interval '110 seconds',pg_temp.cancel_id(6015)
from private.room_pin_assignment_entitlements where assignment_id=pg_temp.cancel_id(2015) and ended_at is null;
create temp table finalized_before as select id,to_jsonb(r) value from private.room_pin_reveal_leases r where finalized_at is not null;
create temp table sensitive_before as select id,to_jsonb(a) value from private.actor_activity_events a where event_type='sensitive.read';
select lives_ok(format('select pg_temp.manual_cancel(%s)',n),'private reveal case '||n||' does not prevent cancellation')
  from generate_series(13,15) n;
select ok(not exists(select 1 from private.room_pin_reveal_leases r join finalized_before b using(id) where to_jsonb(r)<>b.value),
  'finalized reveal history is preserved byte-equivalent, not retroactively recalled');
select ok(not exists(select 1 from private.actor_activity_events a join sensitive_before b using(id) where to_jsonb(a)<>b.value)
  and (select count(*) from sensitive_before)=(select count(*) from private.actor_activity_events where event_type='sensitive.read'),
  'sensitive.read history is preserved without new disclosure audits');
select ok((select revoked_at is not null and finalized_at is null from private.room_pin_reveal_leases
  where id=(select (value->>'lease_id')::uuid from result where n=13)),
  'open private reveal is atomically revoked by cancellation');
select ok(not exists(select 1 from private.room_pin_assignment_entitlements
  where assignment_id in(pg_temp.cancel_id(2013),pg_temp.cancel_id(2014),pg_temp.cancel_id(2015)) and ended_at is null),
  'all three cancellations end durable PIN entitlement');
select throws_ok(format('select public.finalize_room_pin_reveal(%L,%L,%L,%L,%L)',pg_temp.cancel_id(2),pg_temp.cancel_id(202),
  (select room_id from public.cleaning_targets where id=pg_temp.cancel_id(1013)),
  (select (value->>'lease_id')::uuid from result where n=13),pg_temp.cancel_id(6013)),
  '42501','PIN_REVEAL_AUTHORIZATION_CHANGED','begin then cancel then finalize fails without a disclosure');
select throws_ok(format('select public.begin_room_pin_reveal(%L,%L,%L,%L,null,null,%L)',pg_temp.cancel_id(2),pg_temp.cancel_id(202),
  (select room_id from public.cleaning_targets where id=pg_temp.cancel_id(1014)),pg_temp.cancel_id(2014),pg_temp.cancel_id(6114)),
  '42501','PIN_ENTITLEMENT_REQUIRED','cancelled assignment cannot obtain a new reveal');

-- Historical notified owners must never substitute for a cancelled current
-- draft, an unassigned target, or the actual latest notified owner.
select pg_temp.manual_cancel_fixture(21,'additional','unassigned',false);
select pg_temp.manual_cancel_fixture(22,'additional','draft_assigned',false);
select pg_temp.manual_cancel_fixture(23,'additional','notified',false);
insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,
  notified_at,ended_at,change_reason_code,changed_by)
select pg_temp.cancel_id(8000+n),pg_temp.cancel_id(1000+n),pg_temp.cancel_id(3),100+n,
  case when n=21 then 0+1 else 1 end,false,clock_timestamp()-interval '1 hour',
  clock_timestamp()-interval '30 minutes','OLD_NOTIFIED_HISTORY',pg_temp.cancel_id(1)
from generate_series(21,23) n;
select private.emit_notification_v1('assignment.commit_notified',pg_temp.cancel_id(1),pg_temp.cancel_id(3),
  'cleaning_assignment',pg_temp.cancel_id(8000+n)::text,'과거 청소 배정','보존할 과거 배정입니다.',
  t.room_id,t.id,t.id,clock_timestamp()-interval '1 hour')
from generate_series(21,23) n join public.cleaning_targets t on t.id=pg_temp.cancel_id(1000+n);
create temp table historical_notices as select id,to_jsonb(notice) value from public.notifications notice
  where source_entity_id in(pg_temp.cancel_id(8021)::text,pg_temp.cancel_id(8022)::text,pg_temp.cancel_id(8023)::text);
create temp table historical_assignments as select id,to_jsonb(a) value from public.cleaning_assignments a
  where id in(pg_temp.cancel_id(8021),pg_temp.cancel_id(8022),pg_temp.cancel_id(8023));
select lives_ok(format('select pg_temp.manual_cancel(%s)',n),'history provenance case '||n||' cancels') from generate_series(21,23) n;
select is((select count(*)::int from public.notifications where recipient_profile_id=pg_temp.cancel_id(3)
  and event_family='cleaning_request.cancelled_revoked'),0,'historical owners receive no cancellation notice');
select ok(not exists(select 1 from public.notifications notice join historical_notices b using(id) where to_jsonb(notice)<>b.value),
  'historical notices are neither rewritten nor incorrectly resolved');
select ok(not exists(select 1 from public.cleaning_assignments a join historical_assignments b using(id) where to_jsonb(a)<>b.value),
  'historical assignment snapshots and end records remain unchanged');
select is((select source_entity_id from public.notifications where cleaning_target_id=pg_temp.cancel_id(1023)
  and event_family='cleaning_request.cancelled_revoked'),pg_temp.cancel_id(2023)::text,
  'new notified owner revocation uses exact cancelled current assignment evidence');
select is((select count(*)::int from public.notifications where cleaning_target_id in(pg_temp.cancel_id(1021),pg_temp.cancel_id(1022))
  and event_family='cleaning_request.cancelled_revoked'),0,'draft and unassigned cancellation never borrow a historical owner');

-- Failure matrix, exact receipt replay and no side effects.
select pg_temp.manual_cancel_fixture(30,'additional','notified',true);
select private.execute_cleaning_attempt_at(pg_temp.cancel_id(2),pg_temp.cancel_id(3030),1,pg_temp.cancel_id(2030),2,
  'manual-cancel-started-fixture',repeat('4',64),'start','2041-06-07 10:00+09');
select pg_temp.manual_cancel_fixture(31,'stayover','unassigned',false);
select pg_temp.manual_cancel_fixture(n,'additional',
  case when n in(32,34) then 'notified' else 'unassigned' end::public.cleaning_target_status,false)
from generate_series(32,39) n;
-- field_completed/submitted are attempt states, not target states. Preserve a
-- notified target projection in these two synthetic histories to independently
-- exercise the current-assignment execution guard, even if that projection lags.
insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,execution_version,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot)
select pg_temp.cancel_id(3000+n),t.id,pg_temp.cancel_id(2000+n),pg_temp.cancel_id(2),1,
  case when n=32 then 'field_completed' else 'submitted' end::public.attempt_status,2,3,
  '2041-06-07 10:00+09'::timestamptz,'2041-06-07 11:00+09'::timestamptz,'2041-06-07 11:00+09'::timestamptz,
  t.template_snapshot,t.room_type_snapshot||jsonb_build_object('roomId',t.room_id)
from unnest(array[32,34]) n join public.cleaning_targets t on t.id=pg_temp.cancel_id(1000+n);
update public.cleaning_targets set status=case id
  when pg_temp.cancel_id(1033) then 'upload_pending' when pg_temp.cancel_id(1035) then 'inspection_pending'
  when pg_temp.cancel_id(1036) then 'approved' when pg_temp.cancel_id(1037) then 'rejected'
  when pg_temp.cancel_id(1038) then 'cancelled' else status end::public.cleaning_target_status
where id in(select pg_temp.cancel_id(1000+n) from generate_series(32,38) n);
create temp table failure_before as select pg_temp.manual_cancel_snapshot() value;
select throws_ok('select pg_temp.manual_cancel(30)','23514','CLEANING_REQUEST_CANCEL_CONFLICT','started work is still non-cancellable');
select throws_ok(format('select pg_temp.manual_cancel(%s)',n),'23514','CLEANING_REQUEST_CANCEL_CONFLICT',
  'execution/terminal/review state '||n||' remains protected') from generate_series(32,38) n;
select throws_ok(format('select public.cancel_manual_cleaning_request_with_session(%L,%L,%L,1,%L,%L,%L)',pg_temp.cancel_id(1),pg_temp.cancel_id(201),
  (select planned_cleaning_target_id from public.checkout_cleaning_obligations where reservation_id=pg_temp.cancel_id(4031)),
  'CUSTOM_CANCEL_REASON','manual-cancel-auto-denied',repeat('5',64)),
  '23514','NOT_MANUAL_CLEANING_REQUEST','automatic checkout cleaning cannot be cancelled by this command');
select throws_ok('select pg_temp.manual_cancel(39,1,2)','40001','STALE_VERSION','stale target assignmentVersion is denied');
select throws_ok(format('select public.cancel_manual_cleaning_request_with_session(%L,%L,%L,null,%L,%L,%L)',
  pg_temp.cancel_id(1),pg_temp.cancel_id(201),pg_temp.cancel_id(1039),'CUSTOM_CANCEL_REASON','manual-cancel-null-cas',repeat('7',64)),
  '22023','VALIDATION_ERROR','null target CAS is denied before any domain effects');
select throws_ok('select pg_temp.manual_cancel(39,1,0)','22023','VALIDATION_ERROR','nonpositive target CAS is denied');
select throws_ok(format('select public.cancel_manual_cleaning_request_with_session(%L,%L,%L,1,null,%L,%L)',
  pg_temp.cancel_id(1),pg_temp.cancel_id(201),pg_temp.cancel_id(1039),'manual-cancel-null-reason',repeat('7',64)),
  '22023','VALIDATION_ERROR','null cancellation reason cannot write a receipt');
select throws_ok(format('select public.cancel_manual_cleaning_request_with_session(%L,%L,%L,1,%L,%L,%L)',
  pg_temp.cancel_id(1),pg_temp.cancel_id(201),pg_temp.cancel_id(1039),'unsafe reason','manual-cancel-invalid-reason',repeat('7',64)),
  '22023','VALIDATION_ERROR','invalid cancellation reason format is denied');
select throws_ok('select pg_temp.manual_cancel(39,2)','42501','ADMIN_REQUIRED','current maid cannot cancel a request');
select throws_ok('select pg_temp.manual_cancel(39,3)','42501','ADMIN_REQUIRED','another maid cannot cancel a request');
select throws_ok('select pg_temp.manual_cancel(39,7)','42501','ADMIN_REQUIRED','developer cannot cancel operational work');
select throws_ok('select pg_temp.manual_cancel(39,4)','42501','ACTIVE_ACCOUNT_REQUIRED','inactive administrator is denied');
select throws_ok('select pg_temp.manual_cancel(39,5)','42501','ACTIVE_ACCOUNT_REQUIRED','upload-only administrator is denied');
select throws_ok('select pg_temp.manual_cancel(39,6)','42501','PASSWORD_CHANGE_REQUIRED','temporary-password administrator is denied');
select throws_ok($$select pg_temp.manual_cancel(39,p_session=>pg_temp.cancel_id(202))$$,'42501','SESSION_REVOKED','another actor session cannot authorize cancellation');
select throws_ok($$select pg_temp.manual_cancel(39,p_session=>pg_temp.cancel_id(999))$$,'42501','SESSION_REVOKED','missing session is denied');
insert into auth.sessions(id,user_id,not_after) values(pg_temp.cancel_id(211),pg_temp.cancel_id(101),clock_timestamp()-interval '1 second');
select throws_ok($$select pg_temp.manual_cancel(39,p_session=>pg_temp.cancel_id(211))$$,'42501','SESSION_REVOKED','expired exact actor session is denied');
select throws_ok($$select pg_temp.manual_cancel(39,p_hash=>'not-a-hash')$$,'22023','INVALID_REQUEST_HASH','invalid request hash is denied');
select throws_ok($$select pg_temp.manual_cancel(39,p_key=>'short')$$,'22023','INVALID_IDEMPOTENCY_KEY','invalid receipt key is denied');
select is(pg_temp.manual_cancel_snapshot(),(select value from failure_before),'all rejected requests leave every protected ledger unchanged');
select is(pg_temp.manual_cancel(7,p_version=>2),(select value from result where n=7),
  'completed receipt replays unchanged even after cancellation/version advancement');
select is(pg_temp.manual_cancel_snapshot(),(select value from failure_before),'receipt replay cannot re-notify or mutate cancellation history');
select throws_ok($$select pg_temp.manual_cancel(7,p_version=>2,p_hash=>repeat('6',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','same scoped key with changed payload fails closed');
select is(pg_temp.manual_cancel_snapshot(),(select value from failure_before),'receipt hash collision adds no effects');
update public.profiles set must_change_password=true where id=pg_temp.cancel_id(1);
select throws_ok($$select pg_temp.manual_cancel(7,p_version=>2)$$,'42501','PASSWORD_CHANGE_REQUIRED',
  'a completed receipt cannot bypass the current password-change gate');
update public.profiles set must_change_password=false where id=pg_temp.cancel_id(1);
select throws_ok($$select pg_temp.manual_cancel(7,p_version=>2,p_session=>pg_temp.cancel_id(211))$$,'42501','SESSION_REVOKED',
  'a completed receipt cannot bypass a currently expired session');
select is(pg_temp.manual_cancel_snapshot(),(select value from failure_before),'denied replay preserves all protected ledgers');
select ok(not has_function_privilege('service_role','public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)','EXECUTE')
  and not has_function_privilege('anon','public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.cancel_manual_cleaning_request(uuid,uuid,bigint,text,text,text)','EXECUTE'),
  'legacy sessionless cancellation cannot be called by runtime or clients');
select ok(has_function_privilege('service_role','public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text)','EXECUTE')
  and not has_function_privilege('anon','public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text)','EXECUTE')
  and not has_function_privilege('authenticated','public.cancel_manual_cleaning_request_with_session(uuid,uuid,uuid,bigint,text,text,text)','EXECUTE'),
  'session-aware cancellation RPC retains service-only execution');
select ok(not has_function_privilege('service_role','private.dispatch_notification_from_audit()','EXECUTE'),
  'private audit dispatcher cannot be called directly by runtime');
select ok(not exists(select 1 from public.audit_events where event_type='cleaning.manual_request.cancelled'
  and (after_state ? 'ciphertext_base64' or after_state ? 'pinDigits' or after_state ? 'pinCredential')),
  'cancellation audit contains no PIN/envelope response fields');
select * from finish();
rollback;
