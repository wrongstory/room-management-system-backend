begin;
select no_plan();

create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
  select ('e2020000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) select pg_temp.cid(n) from generate_series(101, 105) n;
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  (pg_temp.cid(3),pg_temp.cid(103),'카탈로그 개발자','카탈로그 개발자','admin','admin',0,'developer','active',false);
insert into public.profiles(
  id, auth_user_id, display_name, display_name_normalized, login_id,
  login_id_normalized, login_sequence, role, status, must_change_password
) values
  (pg_temp.cid(1),pg_temp.cid(101),'카탈로그 관리자','카탈로그 관리자','catalog-admin','catalog-admin',0,'admin','active',false),
  (pg_temp.cid(2),pg_temp.cid(102),'카탈로그 메이드','카탈로그 메이드','catalog-maid','catalog-maid',0,'maid','active',false),
  (pg_temp.cid(4),pg_temp.cid(104),'비활성 관리자','비활성 관리자','catalog-inactive','catalog-inactive',0,'admin','inactive',false),
  (pg_temp.cid(5),pg_temp.cid(105),'임시 관리자','임시 관리자','catalog-temporary','catalog-temporary',0,'admin','active',true);
insert into auth.sessions(id,user_id) values
  (pg_temp.cid(201),pg_temp.cid(101)),(pg_temp.cid(202),pg_temp.cid(102)),
  (pg_temp.cid(204),pg_temp.cid(104)),(pg_temp.cid(205),pg_temp.cid(105)),
  (pg_temp.cid(203),pg_temp.cid(103));

select is(
  (select count(*)::integer from public.list_room_type_catalog(pg_temp.cid(1),pg_temp.cid(201))),
  4,
  'active password-complete admin sees all four room types'
);
select ok(
  not exists (
    select 1
    from public.list_room_type_catalog(pg_temp.cid(1),pg_temp.cid(201)) catalog
    join public.room_types room_type on room_type.id = catalog.id
    where catalog.base_occupancy <> room_type.default_guest_count
       or catalog.max_occupancy <> room_type.max_guest_count
       or catalog.base_occupancy < 1
       or catalog.max_occupancy < catalog.base_occupancy
  ),
  'catalog exposes the stored valid occupancy values without inventing replacements'
);
select is(
  (
    select jsonb_object_agg(code, jsonb_build_object(
      'displayName', display_name,
      'baseCleaningFee', base_cleaning_fee,
      'active', active,
      'version', version,
      'roomCount', room_count
    ))
    from public.list_room_type_catalog(pg_temp.cid(1),pg_temp.cid(201))
  ),
  jsonb_build_object(
    'standard', jsonb_build_object('displayName','스탠다드 더블 로프트','baseCleaningFee',16000,'active',true,'version',1,'roomCount',22),
    'premium', jsonb_build_object('displayName','프리미어 더블 로프트','baseCleaningFee',20000,'active',true,'version',1,'roomCount',51),
    'oceanPremium', jsonb_build_object('displayName','파셜 오션뷰 프리미어 더블 로프트','baseCleaningFee',20000,'active',true,'version',1,'roomCount',13),
    'oceanFamily', jsonb_build_object('displayName','파셜 오션뷰 패밀리 투룸 로프트','baseCleaningFee',30000,'active',true,'version',1,'roomCount',35)
  ),
  'catalog maps stable codes, display names, KRW fees, versions, and room counts'
);

select throws_ok(
  $$select * from public.list_room_type_catalog(pg_temp.cid(2),pg_temp.cid(202))$$,
  '42501','ADMIN_REQUIRED','maid cannot list the catalog'
);
select throws_ok(
  format(
    'select * from public.list_room_type_catalog(%L,%L)',
    pg_temp.cid(3), pg_temp.cid(203)
  ),
  '42501','ADMIN_REQUIRED','developer cannot list the catalog'
);
select throws_ok(
  $$select * from public.list_room_type_catalog(pg_temp.cid(4),pg_temp.cid(204))$$,
  '42501','ADMIN_REQUIRED','inactive admin cannot list the catalog'
);
select throws_ok(
  $$select * from public.list_room_type_catalog(pg_temp.cid(5),pg_temp.cid(205))$$,
  '42501','PASSWORD_CHANGE_REQUIRED','temporary-password admin cannot list the catalog'
);
select throws_ok(
  $$select * from public.list_room_type_catalog(pg_temp.cid(1),pg_temp.cid(299))$$,
  '42501','SESSION_REVOKED','revoked session cannot list the catalog'
);

update public.room_types set active=false where code='standard';
select is(
  (select active from public.list_room_type_catalog(pg_temp.cid(1),pg_temp.cid(201)) where code='standard'),
  false,
  'inactive referenced type remains visible in the catalog'
);
select is(
  (select version::integer from public.room_types where code='standard'),
  2,
  'real room type changes advance the managed version'
);
update public.room_types set active=active where code='standard';
select is(
  (select version::integer from public.room_types where code='standard'),
  2,
  'no-op writes do not create a fake version'
);
select throws_ok(
  $$update public.room_types set version=99 where code='standard'$$,
  'P0001','ROOM_TYPE_VERSION_MANAGED','callers cannot forge catalog versions'
);

select ok(
  has_function_privilege('service_role','public.list_room_type_catalog(uuid,uuid)','EXECUTE') and
  not has_function_privilege('authenticated','public.list_room_type_catalog(uuid,uuid)','EXECUTE'),
  'only the service role can execute the app-owned catalog projection'
);

select * from finish();
rollback;
