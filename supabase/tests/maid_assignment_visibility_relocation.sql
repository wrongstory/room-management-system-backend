begin;
\ir room_pin_fixture.psql
select no_plan();
create function pg_temp.vid(n integer) returns uuid language sql immutable
as $$ select ('45000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;
insert into auth.users(id) values(pg_temp.vid(101)),(pg_temp.vid(102));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
select pg_temp.vid(n),pg_temp.vid(n+100),'relocation-'||n,'relocation-'||n,
  'relocation-'||n,'relocation-'||n,0,
  case when n=1 then 'admin' else 'maid' end::public.app_role,'active',false
from generate_series(1,2) n;
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,status,
  duration_minutes,photo_slots,published_at,created_by)
select id,'checkout',1,'published',60,'[]',now(),pg_temp.vid(1) from public.room_types;

create temporary table relocation as
select pg_temp.vid(200) as reservation_id,
  (select id from public.rooms order by room_number offset 30 limit 1) as old_room_id,
  (select room_number from public.rooms order by room_number offset 30 limit 1) as old_room_number,
  (select id from public.rooms order by room_number offset 31 limit 1) as new_room_id,
  (select room_number from public.rooms order by room_number offset 31 limit 1) as new_room_number,
  (now() at time zone 'Asia/Seoul')::date+1 as service_date,
  (((now() at time zone 'Asia/Seoul')::date+time '16:00') at time zone 'Asia/Seoul') as check_in_at,
  (((now() at time zone 'Asia/Seoul')::date+1+time '11:00') at time zone 'Asia/Seoul') as check_out_at,
  null::uuid as target_id,null::uuid as assignment_id;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select old_room_id,'verified',1,'TEST',pg_temp.vid(1),now() from relocation
union all select new_room_id,'verified',1,'TEST',pg_temp.vid(1),now() from relocation;
select pg_temp.install_room_pin_fixture(room_id,pg_temp.vid(1),1)
from (select old_room_id room_id from relocation union select new_room_id from relocation) rooms;

-- Execute actual reservation -> draft -> commit/notify -> unassign -> move request.
-- #73 permits the move only after the notified assignment has been explicitly ended.
select public.create_reservation(pg_temp.vid(1),x.reservation_id,x.old_room_id,
  x.check_in_at,x.check_out_at,2,null,r.state_version,'visibility-relocation-create',repeat('1',64))
from relocation x join public.rooms r on r.id=x.old_room_id;
update relocation x set target_id=o.planned_cleaning_target_id
from public.checkout_cleaning_obligations o where o.reservation_id=x.reservation_id;
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
select pg_temp.vid(201),pg_temp.vid(2),service_date-(extract(isodow from service_date)::integer-1),1,now()
from relocation;
insert into public.availability_days(availability_version_id,work_date,available)
select v.id,v.week_start+d,true from public.availability_versions v cross join generate_series(0,6) d
where v.id=pg_temp.vid(201);
select public.save_cleaning_assignment_draft(pg_temp.vid(1),t.id,pg_temp.vid(2),1,t.assignment_version,
  'visibility-relocation-draft',repeat('2',64))
from public.cleaning_targets t join relocation x on x.target_id=t.id;
update relocation x set assignment_id=a.id from public.cleaning_assignments a
where a.cleaning_target_id=x.target_id and a.is_current;
select public.commit_and_notify_assignments(pg_temp.vid(1),x.service_date,
  public.get_assignment_commit_impact(pg_temp.vid(1),x.service_date)->>'impactFingerprint',
  jsonb_build_array(jsonb_build_object('cleaningTargetId',t.id,
    'expectedAssignmentVersion',t.assignment_version,'expectedAvailabilityVersion',1)),
  'visibility-relocation-notify',repeat('3',64))
from relocation x join public.cleaning_targets t on t.id=x.target_id;
select ok((select a.notified_at is not null and a.notified_room_id_snapshot=x.old_room_id
  and a.notified_room_number_snapshot=x.old_room_number
  from relocation x join public.cleaning_assignments a on a.id=x.assignment_id),
  'real commit captures the original notified room identity and number');
select is((select count(*)::integer from public.cleaning_attempts),0,'planned notification creates no execution attempt');
select public.unassign_cleaning_assignment_prestart(pg_temp.vid(1),x.target_id,x.assignment_id,
  t.assignment_version,'OPERATIONAL_CHANGE','visibility-relocation-unassign',repeat('4',64))
from relocation x join public.cleaning_targets t on t.id=x.target_id;
select ok((select condeferrable and condeferred from pg_constraint
  where conname='cleaning_targets_reservation_room_fk' and conrelid='public.cleaning_targets'::regclass),
  'reservation room FK remains enforced and is deferred by the production migration');
select lives_ok($test$ select public.change_reservation(pg_temp.vid(1),x.reservation_id,x.new_room_id,x.check_in_at,x.check_out_at,
  2,'keep',null,r.version,'OPERATIONAL_CHANGE','visibility-relocation-move',repeat('5',64))
from relocation x join public.reservations r on r.id=x.reservation_id $test$,
  'ended notified plan can move atomically to another room');
select ok((select r.room_id=x.new_room_id and t.room_id=x.new_room_id and o.room_id=x.new_room_id
  and o.planned_cleaning_target_id=x.target_id and o.current_cleaning_target_id is null
  and o.status='private' and t.status='unassigned'
  from relocation x join public.cleaning_targets t on t.id=x.target_id
  join public.reservations r on r.id=x.reservation_id
  join public.checkout_cleaning_obligations o on o.reservation_id=x.reservation_id),
  'reservation, private obligation and same planned target move atomically');
select is((select count(*)::integer from public.cleaning_targets t join relocation x on t.reservation_id=x.reservation_id),1,
  'room replan does not duplicate the planned target');
select ok((select not a.is_current and a.notified_at is not null
  and a.notified_room_id_snapshot=x.old_room_id and a.notified_room_number_snapshot=x.old_room_number
  from relocation x join public.cleaning_assignments a on a.id=x.assignment_id),
  'unassign plus room move preserves the actual old notification snapshot');
grant select on relocation to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.vid(102)::text,true);
select is((select count(*)::integer from public.cleaning_assignments),1,
  'old maid keeps the exact notified historical revision after unassign and replan');
select ok((select a.notified_room_id_snapshot=x.old_room_id and a.notified_room_number_snapshot=x.old_room_number
  and a.notified_room_id_snapshot<>x.new_room_id
  from public.cleaning_assignments a join relocation x on x.assignment_id=a.id),
  'maid history shows only old notified room, never the new undisclosed room');
select is((select count(*)::integer from public.cleaning_targets),0,
  'unassigned target is not exposed through past notified ownership');
select is((select count(*)::integer from public.cleaning_target_schedule_revisions),0,
  'no undisclosed reservation schedule is exposed to the historical maid');
reset role;
select is((select count(*)::integer from public.cleaning_attempts),0,'read and replan create no fake attempt');
set constraints all immediate;
select * from finish();
rollback;
