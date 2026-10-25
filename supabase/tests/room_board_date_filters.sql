begin;

select plan(22);

create function pg_temp.kst_today() returns date
language sql stable as $$
  select (clock_timestamp() at time zone 'Asia/Seoul')::date
$$;

create function pg_temp.checkout_slots() returns jsonb
language sql immutable as $$
  select '[{"slotKey":"cleaning-proof","displayOrder":0,"required":true,"label":"청소 사진","maxPhotos":20},
    {"slotKey":"bomb-proof","displayOrder":1,"required":false,"label":"폭탄방 증빙","maxPhotos":10},
    {"slotKey":"issue-proof","displayOrder":2,"required":false,"label":"특이사항 증빙","maxPhotos":10}]'::jsonb
$$;

insert into auth.users(id) values
  ('a1000000-0000-4000-8000-000000000001'),
  ('a1000000-0000-4000-8000-000000000002');

insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  ('a2000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001',
   '객실 현황 관리자', '객실 현황 관리자', '객실 현황 관리자', '객실 현황 관리자',
   0, 'admin', 'active', false),
  ('a2000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000002',
   '객실 현황 메이드', '객실 현황 메이드', '객실 현황 메이드', '객실 현황 메이드',
   0, 'maid', 'active', false);

insert into auth.sessions(id, user_id) values
  ('a3000000-0000-4000-8000-000000000001',
   'a1000000-0000-4000-8000-000000000001'),
  ('a3000000-0000-4000-8000-000000000002',
   'a1000000-0000-4000-8000-000000000002');

insert into public.rooms(id, room_number, room_type_id, elevator_zone)
select 'a4000000-0000-4000-8000-000000000001', '991', id, 'A'
from public.room_types where code = 'premium';

insert into public.cleaning_template_versions(
  room_type_id, cleaning_kind, version, status, duration_minutes, photo_slots,
  published_at, created_by
)
select id, 'checkout', 318, 'published', null, pg_temp.checkout_slots(),
  clock_timestamp(), 'a2000000-0000-4000-8000-000000000001'
from public.room_types where code = 'premium';

select public.create_reservation_v2(
  'a2000000-0000-4000-8000-000000000001',
  'a5000000-0000-4000-8000-000000000001',
  'a4000000-0000-4000-8000-000000000001',
  'standard',
  (pg_temp.kst_today() + 1 + time '15:00') at time zone 'Asia/Seoul',
  (pg_temp.kst_today() + 2 + time '12:00') at time zone 'Asia/Seoul',
  3,
  null,
  (select state_version from public.rooms
   where id = 'a4000000-0000-4000-8000-000000000001'),
  'room-board-reservation',
  repeat('a', 64)
);

insert into public.room_candle_events(
  room_id, count_before, count_after, physically_verified, reason_code,
  actor_profile_id, effective_at
) values (
  'a4000000-0000-4000-8000-000000000001', 0, 2, false,
  'FRONT_DESK_VERIFIED', 'a2000000-0000-4000-8000-000000000001',
  clock_timestamp()
);

insert into public.room_issues(
  room_id, category, severity, blocks_guest_assignment, description,
  reported_by, reported_at
) values (
  'a4000000-0000-4000-8000-000000000001', 'FACILITY', 'warning', false,
  '창문 확인', 'a2000000-0000-4000-8000-000000000001', clock_timestamp()
);

insert into public.room_pin_sync_events(
  room_id, sync_status, pin_version, reason_code, actor_profile_id, effective_at
) values (
  'a4000000-0000-4000-8000-000000000001', 'mismatch', null,
  'FRONT_DESK_VERIFIED', 'a2000000-0000-4000-8000-000000000001',
  clock_timestamp()
);

set local role service_role;

create temporary table future_room_board as
select * from public.get_room_board_projection(
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  pg_temp.kst_today() + 1,
  'a4000000-0000-4000-8000-000000000001'
);

select is((select service_date from future_room_board), pg_temp.kst_today() + 1,
  'future projection echoes the selected service date');
select is((select projection_mode from future_room_board), 'FUTURE_START_OF_DAY',
  'future projection uses the Asia/Seoul start of day');
select is(
  (select evaluated_at at time zone 'Asia/Seoul' from future_room_board),
  (pg_temp.kst_today() + 1)::timestamp,
  'future evaluatedAt is midnight in Asia/Seoul');
select is((select display_reservation_id from future_room_board),
  'a5000000-0000-4000-8000-000000000001'::uuid,
  'future room card exposes the next reservation identity');
select is((select display_guest_count from future_room_board), 3,
  'future room card exposes the safe guest count');
select is((select display_base_occupancy from future_room_board), 2,
  'future room card exposes the room type base occupancy');
select ok((select detail_condition_codes @> array['EXTRA_GUESTS'] from future_room_board),
  'extra guests follows the wireframe rule');
select ok((select detail_condition_codes @> array['VACANT'] from future_room_board),
  'future room remains vacant before check-in');
select ok((select detail_condition_codes @> array['CANDLE_PRESENT'] from future_room_board),
  'candle condition appears only on the vacant room card');
select ok((select detail_condition_codes @> array['ROOM_ISSUE_PRESENT'] from future_room_board),
  'open room issue appears as a detail condition');
select ok((select detail_condition_codes @> array['EARLY_CHECK_IN'] from future_room_board),
  '15:00 is classified as early check-in');
select ok((select detail_condition_codes @> array['LATE_CHECK_OUT'] from future_room_board),
  '12:00 is classified as late checkout');
select ok((select detail_condition_codes @> array['PIN_SYNC_WARNING'] from future_room_board),
  'PIN mismatch remains a warning detail condition');

create temporary table past_room_board as
select * from public.get_room_board_projection(
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  pg_temp.kst_today() - 1,
  'a4000000-0000-4000-8000-000000000001'
);

select is((select projection_mode from past_room_board), 'PAST_END_OF_DAY',
  'past projection uses the Asia/Seoul end of day');
select is((select candle_count from past_room_board), 0,
  'future-recorded candle state does not leak into a past projection');
select ok(not (select detail_condition_codes @> array['ROOM_ISSUE_PRESENT'] from past_room_board),
  'future-recorded room issues do not leak into a past projection');

select is((select projection_mode from public.get_room_board_projection(
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  pg_temp.kst_today(),
  'a4000000-0000-4000-8000-000000000001'
)), 'LIVE', 'today always uses the live server snapshot');

create temporary table post_checkout_room_board as
select * from public.get_room_board_projection(
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000001',
  pg_temp.kst_today() + 3,
  'a4000000-0000-4000-8000-000000000001'
);

select ok((select detail_condition_codes @> array['CHECKOUT_INSPECTION_REQUIRED']
  from post_checkout_room_board),
  'checkout target requires inspection after checkout until field completion');

select throws_ok($$select * from public.get_room_board_projection(
  'a2000000-0000-4000-8000-000000000002',
  'a3000000-0000-4000-8000-000000000002',
  null, null)$$,
  '42501', 'ADMIN_REQUIRED', 'maid cannot read the global admin room board');

select throws_ok($$select * from public.get_room_board_projection(
  'a2000000-0000-4000-8000-000000000001',
  'a3000000-0000-4000-8000-000000000099',
  null, null)$$,
  '42501', 'SESSION_REVOKED', 'an active admin still needs a live session');

select ok(has_function_privilege(
  'service_role', 'public.get_room_board_projection(uuid,uuid,date,uuid)', 'EXECUTE'),
  'service role can execute the actor-bound room board projection');
select ok(not has_function_privilege(
  'authenticated', 'public.get_room_board_projection(uuid,uuid,date,uuid)', 'EXECUTE'),
  'authenticated clients cannot bypass the Edge actor/session boundary');

select * from finish();
rollback;
