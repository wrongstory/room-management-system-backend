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
  date '2042-01-02' as service_date,
  '2042-01-01 16:00+09'::timestamptz as check_in_at,
  '2042-01-02 11:00+09'::timestamptz as check_out_at,
  null::uuid as target_id,null::uuid as assignment_id;
create function pg_temp.preview_relocation_room_move()
returns jsonb language sql volatile as $$
  select public.preview_reservation_room_move(
    pg_temp.vid(1),reservation.id,x.new_room_id,reservation.version,
    source_room.state_version,target_room.state_version,null,
    'OPERATIONAL_ADJUSTMENT'
  )
  from relocation x
  join public.reservations reservation on reservation.id=x.reservation_id
  join public.rooms source_room on source_room.id=reservation.room_id
  join public.rooms target_room on target_room.id=x.new_room_id
$$;
create function pg_temp.commit_relocation_room_move(p_preview jsonb)
returns jsonb language sql volatile as $$
  select public.commit_reservation_room_move(
    pg_temp.vid(1),(p_preview->>'reservationId')::uuid,
    (p_preview->>'targetRoomId')::uuid,
    (p_preview->>'reservationVersion')::bigint,
    (p_preview->>'sourceRoomVersion')::bigint,
    (p_preview->>'targetRoomVersion')::bigint,
    (p_preview->>'evaluatedAt')::timestamptz,
    (p_preview->>'expiresAt')::timestamptz,
    (p_preview->>'effectiveAt')::timestamptz,
    p_preview->>'impactFingerprint','OPERATIONAL_ADJUSTMENT',
    'visibility-relocation-move',repeat('5',64)
  )
$$;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at)
select old_room_id,'verified',1,'TEST',pg_temp.vid(1),now() from relocation
union all select new_room_id,'verified',1,'TEST',pg_temp.vid(1),now() from relocation;
select pg_temp.install_room_pin_fixture(room_id,pg_temp.vid(1),1)
from (select old_room_id room_id from relocation union select new_room_id from relocation) rooms;

-- Build a real reservation plus a deterministic ended notification-history row.
-- This visibility fixture does not depend on today's assignment commit horizon.
select public.create_reservation(pg_temp.vid(1),x.reservation_id,x.old_room_id,
  x.check_in_at,x.check_out_at,2,null,r.state_version,'visibility-relocation-create',repeat('1',64))
from relocation x join public.rooms r on r.id=x.old_room_id;
update relocation x set target_id=o.planned_cleaning_target_id
from public.checkout_cleaning_obligations o where o.reservation_id=x.reservation_id;
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,
  service_date,available_from_snapshot,due_at_snapshot,notified_at,ended_at,
  change_reason_code,changed_by
)
select pg_temp.vid(201),x.target_id,pg_temp.vid(2),1,1,false,x.service_date,
  target.available_from,target.due_at,
  now()-interval '2 hours',now()-interval '1 hour','VISIBILITY_HISTORY_FIXTURE',
  pg_temp.vid(1)
from relocation x join public.cleaning_targets target on target.id=x.target_id;
update relocation set assignment_id=pg_temp.vid(201);
select ok((select a.notified_at is not null and a.notified_room_id_snapshot=x.old_room_id
  and a.notified_room_number_snapshot=x.old_room_number
  from relocation x join public.cleaning_assignments a on a.id=x.assignment_id),
  'historical notification captures the original room identity and number');
select is((select count(*)::integer from public.cleaning_attempts),0,'planned notification creates no execution attempt');
select ok((select condeferrable and condeferred from pg_constraint
  where conname='cleaning_targets_reservation_room_fk' and conrelid='public.cleaning_targets'::regclass),
  'reservation room FK remains enforced and is deferred by the production migration');
create temporary table relocation_preview as
select pg_temp.preview_relocation_room_move() as value;
select ok((select not (value->>'eligible')::boolean
  and (value->'blockingReasonCodes') ? 'CLEANING_ASSIGNMENT_LOCKED'
  from relocation_preview),
  'ended notified history remains an ineligible cleaning-locked preview');
select throws_ok($test$
  select pg_temp.commit_relocation_room_move(value) from relocation_preview
$test$,'23514','CLEANING_ASSIGNMENT_LOCKED',
  'ended notified history cannot move through the dedicated command');
select ok((select r.room_id=x.old_room_id and t.room_id=x.old_room_id and o.room_id=x.old_room_id
  and o.planned_cleaning_target_id=x.target_id and o.current_cleaning_target_id is null
  and o.status='private' and t.status='unassigned'
  from relocation x join public.cleaning_targets t on t.id=x.target_id
  join public.reservations r on r.id=x.reservation_id
  join public.checkout_cleaning_obligations o on o.reservation_id=x.reservation_id),
  'rejected move preserves reservation, private obligation and planned target graph');
select is((select count(*)::integer from public.cleaning_targets t join relocation x on t.reservation_id=x.reservation_id),1,
  'room replan does not duplicate the planned target');
select ok((select not a.is_current and a.notified_at is not null
  and a.notified_room_id_snapshot=x.old_room_id and a.notified_room_number_snapshot=x.old_room_number
  from relocation x join public.cleaning_assignments a on a.id=x.assignment_id),
  'unassign plus rejected room move preserves the actual old notification snapshot');
grant select on relocation to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub',pg_temp.vid(102)::text,true);
select is((select count(*)::integer from public.cleaning_assignments),1,
  'old maid keeps the exact notified historical revision after unassign and replan');
select ok((select a.notified_room_id_snapshot=x.old_room_id and a.notified_room_number_snapshot=x.old_room_number
  and a.notified_room_id_snapshot<>x.new_room_id
  from public.cleaning_assignments a join relocation x on x.assignment_id=a.id),
  'maid history shows only the old notified room and no alternate room');
select is((select count(*)::integer from public.cleaning_targets),0,
  'unassigned target is not exposed through past notified ownership');
select is((select count(*)::integer from public.cleaning_target_schedule_revisions),1,
  'historical maid sees exactly the notified schedule snapshot and no alternate schedule');
reset role;
select is((select count(*)::integer from public.cleaning_attempts),0,'read and replan create no fake attempt');
set constraints all immediate;
select * from finish();
rollback;
