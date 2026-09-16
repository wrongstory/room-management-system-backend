insert into auth.users(id) values ('8c000000-0000-4000-8000-000000000001');
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values (
  '8c100000-0000-4000-8000-000000000001','8c000000-0000-4000-8000-000000000001',
  '업그레이드 관리자','업그레이드 관리자','업그레이드 관리자','업그레이드 관리자',
  0,'admin','active',false
);

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select id,'checkout',1,'published',60,'[]'::jsonb,clock_timestamp(),
  '8c100000-0000-4000-8000-000000000001' from public.room_types;

select public.create_reservation(
  '8c100000-0000-4000-8000-000000000001',
  '8c200000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number='117'),
  '2026-09-18T16:00:00+09:00','2026-09-20T11:00:00+09:00',2,null,
  (select state_version from public.rooms where room_number='117'),
  'phasec-upgrade-create',repeat('a',64)
);
update public.reservations set actual_check_in_at=check_in_at
where id='8c200000-0000-4000-8000-000000000001';

select public.create_reservation(
  '8c100000-0000-4000-8000-000000000001',
  '8c200000-0000-4000-8000-000000000002',
  (select id from public.rooms where room_number='135'),
  date_trunc('minute',clock_timestamp())+interval '2 days',
  date_trunc('minute',clock_timestamp())+interval '4 days',2,null,
  (select state_version from public.rooms where room_number='135'),
  'phaseb-upgrade-create',repeat('b',64)
);
create temporary table phaseb_move_preview as
select public.preview_reservation_room_move(
  '8c100000-0000-4000-8000-000000000001',reservation.id,target.id,
  reservation.version,source.state_version,target.state_version,
  reservation.check_in_at,'GUEST_REQUEST'
) value
from public.reservations reservation
join public.rooms source on source.id=reservation.room_id
cross join public.rooms target
where reservation.id='8c200000-0000-4000-8000-000000000002'
  and target.room_number='136';
select public.commit_reservation_room_move(
  '8c100000-0000-4000-8000-000000000001',
  '8c200000-0000-4000-8000-000000000002',
  (select id from public.rooms where room_number='136'),
  (value->>'reservationVersion')::bigint,
  (value->>'sourceRoomVersion')::bigint,
  (value->>'targetRoomVersion')::bigint,
  (value->>'evaluatedAt')::timestamptz,
  (value->>'expiresAt')::timestamptz,
  (value->>'effectiveAt')::timestamptz,
  value->>'impactFingerprint','GUEST_REQUEST','phaseb-upgrade-move',repeat('c',64)
) from phaseb_move_preview;
