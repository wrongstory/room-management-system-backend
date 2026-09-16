\set ON_ERROR_STOP on

begin;

insert into auth.users(id)
values ('e1650000-0000-4000-8000-000000000101');

insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values (
  'e1650000-0000-4000-8000-000000000001',
  'e1650000-0000-4000-8000-000000000101',
  'duration-upgrade-admin','duration-upgrade-admin',
  'duration-upgrade-admin','duration-upgrade-admin',0,'admin','active',false
);

insert into auth.sessions(id,user_id)
values (
  'e1650000-0000-4000-8000-000000000201',
  'e1650000-0000-4000-8000-000000000101'
);

do $$
declare
  v_admin constant uuid := 'e1650000-0000-4000-8000-000000000001';
  v_session constant uuid := 'e1650000-0000-4000-8000-000000000201';
  v_reservation constant uuid := 'e1650000-0000-4000-8000-000000000301';
  v_room public.rooms%rowtype;
begin
  perform public.publish_checkout_cleaning_template(
    v_admin,v_session,'standard',0,60,
    (select jsonb_agg(jsonb_build_object(
      'slotKey',case when display_order=0 then 'tv-on' else 'slot-'||display_order end,
      'displayOrder',display_order,
      'required',display_order<9,
      'label','사진 '||(display_order+1)
    ) order by display_order) from generate_series(0,9) display_order),
    'duration-upgrade-publish',repeat('a',64)
  );

  perform public.publish_checkout_cleaning_template(
    v_admin,v_session,'standard',7,60,
    (select jsonb_agg(jsonb_build_object(
      'slotKey',case when display_order=0 then 'tv-on' else 'slot-'||display_order end,
      'displayOrder',display_order,
      'required',display_order<9,
      'label','사진 '||(display_order+1)
    ) order by display_order) from generate_series(0,9) display_order),
    'duration-upgrade-publish-v8',repeat('d',64)
  );

  select room.* into v_room
  from public.rooms room
  join public.room_types room_type on room_type.id=room.room_type_id
  where room_type.code='standard'
  order by room.room_number
  limit 1;

  perform public.create_reservation(
    v_admin,v_reservation,v_room.id,
    '2044-02-01 16:00+09','2044-02-02 11:00+09',2,null,
    v_room.state_version,'duration-upgrade-reservation',repeat('b',64)
  );
end $$;

commit;
