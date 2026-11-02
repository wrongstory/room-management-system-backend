-- #548 candidate regression. Execute only in the explicitly approved final isolated DB gate.
begin;

select plan(11);

create function pg_temp.kst_today() returns date
language sql stable as $$
  select (transaction_timestamp() at time zone 'Asia/Seoul')::date
$$;

create function pg_temp.checkout_slots() returns jsonb
language sql immutable as $$
  select '[{"slotKey":"cleaning-proof","displayOrder":0,"required":true,"label":"청소 사진","maxPhotos":20},
    {"slotKey":"bomb-proof","displayOrder":1,"required":false,"label":"폭탄방 증빙","maxPhotos":10},
    {"slotKey":"issue-proof","displayOrder":2,"required":false,"label":"특이사항 증빙","maxPhotos":10}]'::jsonb
$$;

insert into auth.users(id) values
  ('b5481000-0000-4000-8000-000000000001'),
  ('b5481000-0000-4000-8000-000000000002');

insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  ('b5482000-0000-4000-8000-000000000001',
   'b5481000-0000-4000-8000-000000000001',
   '객실 현황 관리자', '객실 현황 관리자', '객실 현황 관리자', '객실 현황 관리자',
   0, 'admin', 'active', false),
  ('b5482000-0000-4000-8000-000000000002',
   'b5481000-0000-4000-8000-000000000002',
   '객실 현황 메이드', '객실 현황 메이드', '객실 현황 메이드', '객실 현황 메이드',
   0, 'maid', 'active', false);

insert into auth.sessions(id, user_id) values
  ('b5483000-0000-4000-8000-000000000001',
   'b5481000-0000-4000-8000-000000000001'),
  ('b5483000-0000-4000-8000-000000000002',
   'b5481000-0000-4000-8000-000000000002');

insert into public.rooms(id, room_number, room_type_id, elevator_zone)
select 'b5484000-0000-4000-8000-000000000001', '985', id, 'A'
from public.room_types where code = 'premium';

insert into public.cleaning_template_versions(
  room_type_id, cleaning_kind, version, status, duration_minutes, photo_slots,
  published_at, created_by
)
select id, 'checkout', 548, 'published', null, pg_temp.checkout_slots(),
  clock_timestamp(), 'b5482000-0000-4000-8000-000000000001'
from public.room_types where code = 'premium';

select public.create_reservation_v2(
  'b5482000-0000-4000-8000-000000000001',
  'b5485000-0000-4000-8000-000000000001',
  'b5484000-0000-4000-8000-000000000001',
  'standard',
  (pg_temp.kst_today() - 1 + time '16:00') at time zone 'Asia/Seoul',
  (pg_temp.kst_today() + 1 + time '11:00') at time zone 'Asia/Seoul',
  3,
  null,
  (select state_version from public.rooms
   where id = 'b5484000-0000-4000-8000-000000000001'),
  'room-board-reservation',
  repeat('a', 64)
);


create temporary table before_arrival_read as select
  (select count(*) from public.audit_events) audits,
  (select count(*) from public.room_occupancy_events) occupancy_events;
set local role service_role;
create temporary table arrival_read as select value from public.get_room_board_arrival_projection(
  'b5482000-0000-4000-8000-000000000001','b5483000-0000-4000-8000-000000000001',
  pg_temp.kst_today(),'b5484000-0000-4000-8000-000000000001') value;
select is((select value #>> '{arrival,status}' from arrival_read),'CHECKIN_PENDING','yesterday arrival remains visible as pending');
select is((select value #>> '{arrival,checkInReady}' from arrival_read),'false','unapproved preparation cannot advertise ready');
select ok((select value #> '{arrival,reasonCodes}' from arrival_read) @> '["CLEANING_REQUIRED"]'::jsonb,'specific preparation reason is exposed');
select is((select value ->> 'allocation_ready' from arrival_read),'false','legacy ready flag is conservative');
select is((select value #> '{arrival,actualCheckInAt}' from arrival_read),'null'::jsonb,'read does not fabricate actual check-in');
select is((select value -> 'arrival' from public.get_room_board_arrival_projection(
  'b5482000-0000-4000-8000-000000000001','b5483000-0000-4000-8000-000000000001',
  pg_temp.kst_today()-1,'b5484000-0000-4000-8000-000000000001') value),'null'::jsonb,'past readiness is not inferred from current rows');
select throws_ok($$select * from public.get_room_board_arrival_projection(
  'b5482000-0000-4000-8000-000000000002',
  'b5483000-0000-4000-8000-000000000002', null, null)$$,
  '42501', 'ADMIN_REQUIRED', 'maid cannot read global room arrival facts');
select throws_ok($$select * from public.get_room_board_arrival_projection(
  'b5482000-0000-4000-8000-000000000001',
  'b5483000-0000-4000-8000-000000000099', null, null)$$,
  '42501', 'SESSION_REVOKED', 'arrival facts require a live actor session');
reset role;
select is((select count(*) from public.audit_events),(select audits from before_arrival_read),'read adds no audit events');
select is((select count(*) from public.room_occupancy_events),(select occupancy_events from before_arrival_read),'read adds no occupancy events');
select ok(not has_function_privilege('authenticated','public.get_room_board_arrival_projection(uuid,uuid,date,uuid)','EXECUTE'),'direct authenticated RPC is forbidden');
select * from finish();
rollback;
