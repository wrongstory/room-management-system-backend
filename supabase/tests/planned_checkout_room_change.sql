begin;
\ir room_pin_fixture.psql
select no_plan();

create function pg_temp.rid(n integer) returns uuid language sql immutable
as $$ select ('73000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid $$;

insert into auth.users(id) values (pg_temp.rid(101)),(pg_temp.rid(102));
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  (pg_temp.rid(1),pg_temp.rid(101),'room-change-admin','room-change-admin',
   'room-change-admin','room-change-admin',0,'admin','active',false),
  (pg_temp.rid(2),pg_temp.rid(102),'room-change-maid','room-change-maid',
   'room-change-maid','room-change-maid',0,'maid','active',false);

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select id,'checkout',1,'published',60,'[]',now(),pg_temp.rid(1)
from public.room_types;

create temporary table room_change_cases(
  label text primary key,
  reservation_id uuid not null,
  old_room_id uuid not null,
  new_room_id uuid not null,
  check_in_at timestamptz not null,
  check_out_at timestamptz not null,
  target_id uuid,
  assignment_id uuid,
  original_target_snapshot jsonb
);

create function pg_temp.make_room_change_case(
  p_label text,p_reservation_number integer,p_room_offset integer,
  p_check_in_at timestamptz,p_check_out_at timestamptz
) returns void language plpgsql as $$
declare
  old_room public.rooms%rowtype;
  new_room public.rooms%rowtype;
  target_id uuid;
begin
  select * into strict old_room from public.rooms order by room_number offset p_room_offset limit 1;
  select * into strict new_room from public.rooms order by room_number offset p_room_offset+1 limit 1;
  insert into public.room_pin_sync_events(
    room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
  ) values
    (old_room.id,'verified',1,'ROOM_CHANGE_FIXTURE',pg_temp.rid(1),now()),
    (new_room.id,'verified',1,'ROOM_CHANGE_FIXTURE',pg_temp.rid(1),now());
  perform pg_temp.install_room_pin_fixture(old_room.id,pg_temp.rid(1),1);
  perform pg_temp.install_room_pin_fixture(new_room.id,pg_temp.rid(1),1);
  perform public.create_reservation(
    pg_temp.rid(1),pg_temp.rid(p_reservation_number),old_room.id,p_check_in_at,p_check_out_at,
    2,null,(select state_version from public.rooms where id=old_room.id),
    'room-change-create-'||p_label,repeat('1',64)
  );
  select o.planned_cleaning_target_id into strict target_id
  from public.checkout_cleaning_obligations o
  where o.reservation_id=pg_temp.rid(p_reservation_number);
  insert into room_change_cases values(
    p_label,pg_temp.rid(p_reservation_number),old_room.id,new_room.id,
    p_check_in_at,p_check_out_at,target_id,null,
    (select jsonb_build_object(
      'id',t.id,'originalServiceDate',t.original_service_date,
      'roomTypeSnapshot',t.room_type_snapshot,'feeSnapshot',t.fee_snapshot,
      'templateSnapshot',t.template_snapshot,'createdAt',t.created_at
    ) from public.cleaning_targets t where t.id=target_id)
  );
end;
$$;

select pg_temp.make_room_change_case(
  'unassigned',200,70,'2041-01-01 16:00+09','2041-01-02 11:00+09'
);
select pg_temp.make_room_change_case(
  'draft',201,72,'2041-02-01 16:00+09','2041-02-02 11:00+09'
);
select pg_temp.make_room_change_case(
  'notified',202,74,
  (((now() at time zone 'Asia/Seoul')::date+time '16:00') at time zone 'Asia/Seoul'),
  (((now() at time zone 'Asia/Seoul')::date+1+time '11:00') at time zone 'Asia/Seoul')
);
select pg_temp.make_room_change_case(
  'checked-in',203,76,
  date_trunc('minute',now())-interval '1 day',
  date_trunc('minute',now())+interval '1 day'
);

-- Unassigned: the reservation, obligation and same planned target move together.
create temporary table unassigned_result as
select public.change_reservation(
  pg_temp.rid(1),c.reservation_id,c.new_room_id,c.check_in_at,c.check_out_at,2,
  'keep',null,1,'ROOM_CHANGED','room-change-unassigned',repeat('2',64)
) as response
from room_change_cases c where c.label='unassigned';
select is(
  public.change_reservation(
    pg_temp.rid(1),c.reservation_id,c.new_room_id,c.check_in_at,c.check_out_at,2,
    'keep',null,1,'ROOM_CHANGED','room-change-unassigned',repeat('2',64)
  ),
  (select response from unassigned_result),
  'same room-change command replays the same logical response'
)
from room_change_cases c where c.label='unassigned';
select ok((
  select r.room_id=c.new_room_id and o.room_id=c.new_room_id and t.room_id=c.new_room_id
    and o.planned_cleaning_target_id=c.target_id and o.current_cleaning_target_id is null
    and o.status='private' and t.status='unassigned'
  from room_change_cases c
  join public.reservations r on r.id=c.reservation_id
  join public.checkout_cleaning_obligations o on o.reservation_id=c.reservation_id
  join public.cleaning_targets t on t.id=c.target_id
  where c.label='unassigned'
),'unassigned reservation and planned checkout graph move atomically');
select is((select count(*)::integer from public.cleaning_targets t join room_change_cases c
  on c.reservation_id=t.reservation_id where c.label='unassigned'),1,
  'room change reuses exactly one planned target');
select ok((
  select c.original_target_snapshot=jsonb_build_object(
    'id',t.id,'originalServiceDate',t.original_service_date,
    'roomTypeSnapshot',t.room_type_snapshot,'feeSnapshot',t.fee_snapshot,
    'templateSnapshot',t.template_snapshot,'createdAt',t.created_at
  )
  from room_change_cases c join public.cleaning_targets t on t.id=c.target_id
  where c.label='unassigned'
),'room change preserves immutable target creation snapshots');
select is((select count(*)::integer from public.audit_events a join room_change_cases c
  on a.entity_id=c.reservation_id where c.label='unassigned' and a.event_type='reservation.changed'),1,
  'room-change replay appends one audit event');
select is((select count(*)::integer from private.command_executions e
  where e.actor_profile_id=pg_temp.rid(1) and e.command_type='reservation.change'
    and e.idempotency_key='room-change-unassigned'),1,
  'room-change replay retains one scoped receipt');
select throws_ok($test$
  select public.change_reservation(
    pg_temp.rid(1),c.reservation_id,c.new_room_id,c.check_in_at,c.check_out_at,2,
    'keep',null,1,'ROOM_CHANGED','room-change-unassigned',repeat('9',64)
  ) from room_change_cases c where c.label='unassigned'
$test$,'23505','IDEMPOTENCY_KEY_REUSED','same idempotency key with another hash is rejected');

-- Draft: keep the immutable draft revision, but make it explicitly stale.
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
select pg_temp.rid(301),pg_temp.rid(2),date '2041-01-28',1,now();
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.rid(301),date '2041-01-28'+n,true from generate_series(0,6) n;
select public.save_cleaning_assignment_draft(
  pg_temp.rid(1),c.target_id,pg_temp.rid(2),1,t.assignment_version,
  'room-change-draft-save',repeat('3',64)
)
from room_change_cases c join public.cleaning_targets t on t.id=c.target_id
where c.label='draft';
update room_change_cases c set assignment_id=a.id
from public.cleaning_assignments a
where c.label='draft' and a.cleaning_target_id=c.target_id and a.is_current;
select lives_ok($test$
  select public.change_reservation(
    pg_temp.rid(1),c.reservation_id,c.new_room_id,c.check_in_at,c.check_out_at,2,
    'keep',null,1,'ROOM_CHANGED','room-change-draft',repeat('4',64)
  ) from room_change_cases c where c.label='draft'
$test$,'unnotified draft room change succeeds');
select ok((
  select a.is_current and a.notified_at is null and a.notified_room_id_snapshot is null
    and a.revision<t.assignment_version and t.room_id=c.new_room_id
  from room_change_cases c
  join public.cleaning_assignments a on a.id=c.assignment_id
  join public.cleaning_targets t on t.id=c.target_id
  where c.label='draft'
),'unnotified draft remains immutable and stale after room move');
select is((
  select reason_code from private.assignment_commit_candidates_at(
    date '2041-02-02','2041-02-01 09:00+09'
  ) q join room_change_cases c on c.target_id=q.target_id where c.label='draft'
),'ASSIGNMENT_DRAFT_STALE_SCHEDULE','stale draft cannot be notified without a new revision');

-- Notified: implicit relocation is rejected and all graph/side-effect state rolls back.
insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
select pg_temp.rid(302),pg_temp.rid(2),service_date-(extract(isodow from service_date)::integer-1),1,now()
from (
  select (check_out_at at time zone 'Asia/Seoul')::date service_date
  from room_change_cases where label='notified'
) x;
insert into public.availability_days(availability_version_id,work_date,available)
select pg_temp.rid(302),v.week_start+n,true
from public.availability_versions v cross join generate_series(0,6) n
where v.id=pg_temp.rid(302);
select public.save_cleaning_assignment_draft(
  pg_temp.rid(1),c.target_id,pg_temp.rid(2),2,t.assignment_version,
  'room-change-notified-draft',repeat('5',64)
)
from room_change_cases c join public.cleaning_targets t on t.id=c.target_id
where c.label='notified';
update room_change_cases c set assignment_id=a.id
from public.cleaning_assignments a
where c.label='notified' and a.cleaning_target_id=c.target_id and a.is_current;
select public.commit_and_notify_assignments(
  pg_temp.rid(1),(c.check_out_at at time zone 'Asia/Seoul')::date,
  public.get_assignment_commit_impact(
    pg_temp.rid(1),(c.check_out_at at time zone 'Asia/Seoul')::date
  )->>'impactFingerprint',
  jsonb_build_array(jsonb_build_object(
    'cleaningTargetId',c.target_id,'expectedAssignmentVersion',t.assignment_version,
    'expectedAvailabilityVersion',1
  )),'room-change-notified-commit',repeat('6',64)
)
from room_change_cases c join public.cleaning_targets t on t.id=c.target_id
where c.label='notified';
create temporary table notified_before as
select to_jsonb(r) reservation,to_jsonb(o) obligation,to_jsonb(t) target,to_jsonb(a) assignment,
  (select count(*) from public.audit_events) audit_count,
  (select count(*) from public.notifications) notification_count,
  (select count(*) from private.notification_delivery_outbox) outbox_count
from room_change_cases c
join public.reservations r on r.id=c.reservation_id
join public.checkout_cleaning_obligations o on o.reservation_id=c.reservation_id
join public.cleaning_targets t on t.id=c.target_id
join public.cleaning_assignments a on a.id=c.assignment_id
where c.label='notified';
select throws_ok($test$
  select public.change_reservation(
    pg_temp.rid(1),c.reservation_id,c.new_room_id,c.check_in_at,c.check_out_at,2,
    'keep',null,1,'ROOM_CHANGED','room-change-notified',repeat('7',64)
  ) from room_change_cases c where c.label='notified'
$test$,'23514','CLEANING_WORKFLOW_REPLAN_REQUIRED',
  'notified planned checkout requires explicit replan');
select ok((
  select b.reservation=to_jsonb(r) and b.obligation=to_jsonb(o) and b.target=to_jsonb(t)
    and b.assignment=to_jsonb(a)
    and b.audit_count=(select count(*) from public.audit_events)
    and b.notification_count=(select count(*) from public.notifications)
    and b.outbox_count=(select count(*) from private.notification_delivery_outbox)
  from notified_before b cross join room_change_cases c
  join public.reservations r on r.id=c.reservation_id
  join public.checkout_cleaning_obligations o on o.reservation_id=c.reservation_id
  join public.cleaning_targets t on t.id=c.target_id
  join public.cleaning_assignments a on a.id=c.assignment_id
  where c.label='notified'
),'rejected notified move rolls back domain, audit, notification and outbox state');

-- Checked in: room identity is locked before any graph mutation.
update public.reservations r set actual_check_in_at=r.check_in_at
from room_change_cases c where c.label='checked-in' and r.id=c.reservation_id;
select throws_ok($test$
  select public.change_reservation(
    pg_temp.rid(1),c.reservation_id,c.new_room_id,c.check_in_at,c.check_out_at,2,
    'keep',null,1,'ROOM_CHANGED','room-change-checked-in',repeat('8',64)
  ) from room_change_cases c where c.label='checked-in'
$test$,'23514','OCCUPIED_RESERVATION_SCHEDULE_LOCKED',
  'checked-in reservation cannot move rooms');
select ok((
  select r.room_id=c.old_room_id and o.room_id=c.old_room_id and t.room_id=c.old_room_id
  from room_change_cases c
  join public.reservations r on r.id=c.reservation_id
  join public.checkout_cleaning_obligations o on o.reservation_id=c.reservation_id
  join public.cleaning_targets t on t.id=c.target_id
  where c.label='checked-in'
),'checked-in rejection leaves the planned checkout graph unchanged');

-- Deferral is not a bypass: a half-updated graph still fails at the commit boundary.
select throws_ok($test$
  do $body$
  declare c room_change_cases%rowtype;
  begin
    select * into strict c from room_change_cases where label='checked-in';
    update public.reservations set room_id=c.new_room_id where id=c.reservation_id;
    set constraints all immediate;
  end
  $body$
$test$,'23514','CHECKOUT_PLANNED_CONTRACT_NOT_ATOMIC',
  'deferred graph contract still rejects a partial reservation-only room move');

select ok((select condeferrable and condeferred from pg_constraint
  where conname='cleaning_targets_reservation_room_fk'
    and conrelid='public.cleaning_targets'::regclass),
  'production FK is deferred, not disabled or dropped');
select is((select count(*)::integer from public.cleaning_attempts),0,
  'reservation room changes never create execution attempts');

set constraints all immediate;
select * from finish();
rollback;
