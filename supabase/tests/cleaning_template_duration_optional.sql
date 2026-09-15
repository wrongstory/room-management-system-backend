begin;
select no_plan();

create function pg_temp.tid(n integer) returns uuid language sql immutable as $$
  select ('e1650000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;
create function pg_temp.checkout_slots(p_count integer) returns jsonb
language sql immutable as $$
  select jsonb_agg(jsonb_build_object(
    'slotKey', case when display_order = 0 then 'tv-on' else 'slot-' || display_order end,
    'displayOrder', display_order,
    'required', display_order < p_count - 1,
    'label', '사진 ' || (display_order + 1)
  ) order by display_order)
  from generate_series(0, p_count - 1) display_order
$$;

insert into auth.users(id) values (pg_temp.tid(101));
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values (
  pg_temp.tid(1), pg_temp.tid(101), '시간 미설정 관리자', '시간 미설정 관리자',
  'duration-optional-admin', 'duration-optional-admin', 0, 'admin', 'active', false
);
insert into auth.sessions(id,user_id) values (pg_temp.tid(201),pg_temp.tid(101));

create temp table publication(response jsonb);
insert into publication
select public.publish_checkout_cleaning_template(
  pg_temp.tid(1), pg_temp.tid(201), 'standard', 0, null,
  pg_temp.checkout_slots(10), 'duration-optional-publish', repeat('a',64)
);

select is((select response->'durationMinutes' from publication),'null'::jsonb,
  'checkout photo template publishes with an explicit unconfigured duration');
select is((select duration_minutes from public.cleaning_template_versions
  where room_type_id=(select id from public.room_types where code='standard')
    and cleaning_kind='checkout' and status='published'),null::integer,
  'database never invents a checkout template duration');
select ok(not (select after_state ? 'durationMinutes' from public.audit_events
  where event_type='cleaning_template.published' order by recorded_at desc limit 1),
  'audit omits unconfigured duration instead of recording a fallback');

select lives_ok(
  format(
    $sql$select public.create_reservation(%L,%L,%L,'2044-01-01 16:00+09','2044-01-02 11:00+09',2,null,%s,%L,%L)$sql$,
    pg_temp.tid(1), pg_temp.tid(301),
    (select room.id from public.rooms room join public.room_types room_type
      on room_type.id=room.room_type_id where room_type.code='standard'
      order by room.room_number limit 1),
    (select room.state_version from public.rooms room join public.room_types room_type
      on room_type.id=room.room_type_id where room_type.code='standard'
      order by room.room_number limit 1),
    'duration-optional-reservation', repeat('b',64)
  ),
  'reservation succeeds when the published checkout photo template has no duration'
);
select is((select count(*) from public.cleaning_targets where reservation_id=pg_temp.tid(301)),1::bigint,
  'duration-less template still creates exactly one planned checkout target');
select is((select template_snapshot->>'durationMinutes' from public.cleaning_targets
  where reservation_id=pg_temp.tid(301)),null::text,
  'planned target snapshot contains no invented duration value');
select is((select count(*) from public.assignment_duration_policy_versions
  where status='confirmed'),0::bigint,
  'template publication does not implicitly confirm assignment duration policy');

select throws_ok(
  $$insert into public.cleaning_template_versions(
      room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by
    ) values(
      (select id from public.room_types where code='premium'),'stayover',999,'draft',null,'[]',
      pg_temp.tid(1)
    )$$,
  '23514',null,
  'non-checkout template kinds retain the positive duration requirement'
);

select * from finish();
rollback;
