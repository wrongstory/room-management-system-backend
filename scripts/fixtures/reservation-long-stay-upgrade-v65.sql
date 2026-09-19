create function pg_temp.long_stay_slots() returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'slotKey', case when display_order=0 then 'tv-on'
      when display_order=1 then 'entry-storage'
      when display_order=8 then 'extra-proof'
      else 'slot-'||display_order end,
    'displayOrder',display_order,'required',display_order<8,
    'label','사진 '||(display_order+1),
    'maxPhotos',case when display_order=8 then 10 else 1 end
  ) order by display_order)
  from generate_series(0,8) display_order
$$;

insert into auth.users(id) values('c2000000-0000-4000-8000-000000000001');
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,
  login_id_normalized,login_sequence,role,status,must_change_password
) values(
  'c2010000-0000-4000-8000-000000000001',
  'c2000000-0000-4000-8000-000000000001',
  '장기체류 업그레이드 관리자','장기체류 업그레이드 관리자',
  'long-stay-upgrade-admin','long-stay-upgrade-admin',0,'admin','active',false
);

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,
  published_at,created_by
)
select id,'checkout',200,'published',null,pg_temp.long_stay_slots(),
  clock_timestamp(),'c2010000-0000-4000-8000-000000000001'
from public.room_types where code='standard';

select public.create_reservation(
  'c2010000-0000-4000-8000-000000000001',
  'c2020000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number='350'),
  '2036-01-01 15:00:00+09','2036-01-02 11:00:00+09',2,null,
  (select state_version from public.rooms where room_number='350'),
  'long-stay-upgrade-standard',repeat('a',64)
);

select public.create_reservation(
  'c2010000-0000-4000-8000-000000000001',
  'c2020000-0000-4000-8000-000000000002',
  (select id from public.rooms where room_number='352'),
  '2036-02-01 15:00:00+09','2036-02-05 11:00:00+09',1,null,
  (select state_version from public.rooms where room_number='352'),
  'long-stay-upgrade-checked-in',repeat('b',64)
);
update public.reservations set actual_check_in_at=check_in_at
where id='c2020000-0000-4000-8000-000000000002';
