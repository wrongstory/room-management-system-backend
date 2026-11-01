-- #551 synthetic regression, prepared for the separately approved full DB run.
-- NOT RUN during feature development. Every row is rolled back.
begin;
select no_plan();
create function pg_temp.memo_id(n integer) returns uuid language sql immutable as $$
  select ('55100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.memo_day() returns date language sql stable as $$
  select (transaction_timestamp() at time zone 'Asia/Seoul')::date
$$;
insert into auth.users(id) select pg_temp.memo_id(100+n) from generate_series(1,4) n;
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
select pg_temp.memo_id(n),pg_temp.memo_id(100+n),'메모 합성 '||n,'메모 합성 '||n,
  'fixed-memo-fixture-'||n,'fixed-memo-fixture-'||n,0,case when n<3 then 'admin' else 'maid' end::public.app_role,'active',false
from generate_series(1,4) n;
insert into auth.sessions(id,user_id,created_at,updated_at,not_after)
select pg_temp.memo_id(200+n),pg_temp.memo_id(100+n),now(),now(),now()+interval '1 hour' from generate_series(1,4) n;
insert into public.availability_versions(maid_profile_id,week_start,version,submitted_at)
select pg_temp.memo_id(n),pg_temp.memo_day()-(extract(isodow from pg_temp.memo_day())::integer-1)+w*7,1,now()
from generate_series(3,4) n cross join generate_series(0,1) w;
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+d,true from public.availability_versions v cross join generate_series(0,6) d
where v.maid_profile_id in(pg_temp.memo_id(3),pg_temp.memo_id(4));
insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,
  effective_service_date,available_from,due_at,status,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
select pg_temp.memo_id(300+n),(select id from public.rooms order by room_number offset n limit 1),
  'additional','manual_room_request','fixed-memo-target-'||n,pg_temp.memo_day(),pg_temp.memo_day(),
  pg_temp.memo_day()::timestamp at time zone 'Asia/Seoul',
  (pg_temp.memo_day()::timestamp at time zone 'Asia/Seoul')+interval '23 hours',
  'unassigned','{}',10000,'{"durationMinutes":60}',pg_temp.memo_id(1)
from generate_series(1,5) n;

create function pg_temp.memo_room() returns uuid language sql stable as $$
 select room_id from public.cleaning_targets where id=pg_temp.memo_id(301)
$$;
create function pg_temp.memo_write(a integer,v bigint,m text,k text) returns jsonb language sql as $$
 select public.set_room_fixed_memo(pg_temp.memo_id(a),pg_temp.memo_id(200+a),pg_temp.memo_room(),v,m,k,
   encode(extensions.digest(k||coalesce(m,'<null>'),'sha256'),'hex'))
$$;
select is(public.get_room_fixed_memo(pg_temp.memo_id(1),pg_temp.memo_id(201),pg_temp.memo_room())->>'version','0','no memo has version zero');
select is(pg_temp.memo_write(1,0,' 화요일마다 청소 ','fixed-memo-001')->>'memo','화요일마다 청소','admin saves normalized persistent memo');
select is(pg_temp.memo_write(2,1,'매주 화요일 청소','fixed-memo-002')->>'version','2','other admin shares editing');
select is(pg_temp.memo_write(1,0,' 화요일마다 청소 ','fixed-memo-001')->>'version','1','replay returns original receipt');
select throws_ok($$select pg_temp.memo_write(1,0,'수정','fixed-memo-stale')$$,'40001','STALE_VERSION','stale CAS rejected');
select throws_ok($$select pg_temp.memo_write(1,2,'다른내용','fixed-memo-001')$$,'23505','IDEMPOTENCY_KEY_REUSED','same key different content rejected');
select throws_ok($$select pg_temp.memo_write(3,2,'메이드수정','fixed-memo-maid')$$,'42501','ADMIN_REQUIRED','maid cannot edit');
select throws_ok($$select public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())$$,'42501','ROOM_FIXED_MEMO_FORBIDDEN','unassigned maid cannot read');
select public.save_cleaning_assignment_draft(pg_temp.memo_id(1),pg_temp.memo_id(301),pg_temp.memo_id(3),1,1,'fixed-memo-draft',repeat('a',64));
select throws_ok($$select public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())$$,'42501','ROOM_FIXED_MEMO_FORBIDDEN','draft without notification cannot read');
create temp table memo_impact as select public.get_assignment_commit_impact(pg_temp.memo_id(1),pg_temp.memo_day()) value;
select public.commit_and_notify_assignments(pg_temp.memo_id(1),pg_temp.memo_day(),value->>'impactFingerprint',
  (select jsonb_agg(jsonb_build_object('cleaningTargetId',item->>'cleaningTargetId',
    'expectedAssignmentVersion',(item->>'targetAssignmentVersion')::bigint,
    'expectedAvailabilityVersion',(item->>'expectedAvailabilityVersion')::bigint))
    from jsonb_array_elements(value->'committableDrafts') item where item->>'cleaningTargetId'=pg_temp.memo_id(301)::text),
  'fixed-memo-notify',repeat('b',64)) from memo_impact;
select is(public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())->>'memo','매주 화요일 청소','actual notified maid reads current room memo');
select throws_ok($$select public.get_room_fixed_memo(pg_temp.memo_id(4),pg_temp.memo_id(204),pg_temp.memo_room())$$,'42501','ROOM_FIXED_MEMO_FORBIDDEN','other maid cannot read');
select is(pg_temp.memo_write(2,2,null,'fixed-memo-clear')->'memo','null'::jsonb,'clear adds a revision');
select is((select count(*) from private.room_fixed_memo_revisions),3::bigint,'clearing preserves history');
select throws_ok($$update private.room_fixed_memo_revisions set memo='replace'$$,'23514','ROOM_FIXED_MEMO_IMMUTABLE','history update rejected');
select throws_ok($$delete from private.room_fixed_memo_revisions$$,'23514','ROOM_FIXED_MEMO_IMMUTABLE','history delete rejected');
select ok(not has_table_privilege('service_role','private.room_fixed_memo_revisions','SELECT'),'service role cannot bypass scoped RPC');
select ok(not has_function_privilege('authenticated','public.get_room_fixed_memo(uuid,uuid,uuid)','EXECUTE'),'authenticated direct RPC rejected');
select ok(not exists(select 1 from public.audit_events where after_state::text like '%화요일%' or before_state::text like '%화요일%'),'audit excludes raw memo');
select is((select count(*) from public.cleaning_targets where source_key like 'fixed-memo-target-%'),5::bigint,'memo never creates cleaning targets');
-- Synthetic authorization boundary states; not a claim of real workflow transition coverage.
update public.cleaning_targets set status='approved' where id=pg_temp.memo_id(301);
select is(public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())->>'version','3','approved current assignee still reads memo');
update public.cleaning_targets set status='rejected' where id=pg_temp.memo_id(301);
select is(public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())->>'version','3','rejected current assignee still reads memo');
update public.cleaning_targets set status='cancelled' where id=pg_temp.memo_id(301);
select throws_ok($$select public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())$$,'42501','ROOM_FIXED_MEMO_FORBIDDEN','cancelled target denied even with stale current assignment');
update public.cleaning_targets set status='notified' where id=pg_temp.memo_id(301);
update public.cleaning_assignments set is_current=false,ended_at=now() where cleaning_target_id=pg_temp.memo_id(301) and is_current;
select throws_ok($$select public.get_room_fixed_memo(pg_temp.memo_id(3),pg_temp.memo_id(203),pg_temp.memo_room())$$,'42501','ROOM_FIXED_MEMO_FORBIDDEN','ended assignment loses access');
update auth.sessions set not_after=now()-interval '1 second' where id=pg_temp.memo_id(201);
select throws_ok($$select pg_temp.memo_write(1,0,' 화요일마다 청소 ','fixed-memo-001')$$,'42501',null,'revoked session cannot replay receipt');
select * from finish();
rollback;
