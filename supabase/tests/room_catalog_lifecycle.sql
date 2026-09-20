begin;
select no_plan();

create function pg_temp.rid(n integer) returns uuid language sql immutable as $$
  select ('f2300000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.rid(101));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values(pg_temp.rid(1),pg_temp.rid(101),'객실 개발자','객실 개발자','admin','admin',0,'developer','active',false);
create temp table room_catalog_test_actor(profile_id uuid not null, auth_user_id uuid not null);
insert into room_catalog_test_actor
select id,auth_user_id from public.profiles
where role='developer' and status='active' and must_change_password=false
order by created_at,id limit 1;
do $$ begin
  if not exists(select 1 from pg_temp.room_catalog_test_actor) then
    raise exception using errcode='55000',message='ROOM_CATALOG_DEVELOPER_FIXTURE_UNAVAILABLE';
  end if;
end $$;
create function pg_temp.developer_id() returns uuid language sql stable as $$
  select profile_id from pg_temp.room_catalog_test_actor
$$;
insert into auth.users(id) values(pg_temp.rid(102)),(pg_temp.rid(103)),(pg_temp.rid(104));
insert into auth.sessions(id,user_id) values
  (pg_temp.rid(201),(select auth_user_id from pg_temp.room_catalog_test_actor)),(pg_temp.rid(202),pg_temp.rid(102)),
  (pg_temp.rid(203),pg_temp.rid(103));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password) values
  (pg_temp.rid(2),pg_temp.rid(102),'객실 관리자','객실 관리자','room-admin','room-admin',0,'admin','active',false),
  (pg_temp.rid(3),pg_temp.rid(103),'객실 메이드','객실 메이드','room-maid','room-maid',0,'maid','active',false),
  (pg_temp.rid(4),pg_temp.rid(104),'비활성 관리자','비활성 관리자','room-inactive','room-inactive',0,'admin','inactive',false);

select throws_ok(format($q$insert into public.rooms(room_number,room_type_id,elevator_zone)
  values('998',%L,'A')$q$,(select id from public.room_types where code='standard')),
  '42501','ROOM_CATALOG_COMMAND_REQUIRED','raw room insert fails closed when command GUC is unset');
select throws_ok(format($q$update public.rooms set catalog_status='retired',retired_at=clock_timestamp(),
  retired_by=%L,retirement_reason_code='RAW_RETIRE' where id=%L$q$,
  pg_temp.developer_id(),(select id from public.rooms order by room_number,id limit 1)),
  '55000','ROOM_CATALOG_LIFECYCLE_IMMUTABLE','raw active-to-retired update fails closed when command GUC is unset');

select is((public.list_developer_room_catalog(pg_temp.developer_id(),pg_temp.rid(201),'all',null,null,2)#>>'{counts,active}')::integer,
  121,'initial seed is a current count, not a hard-coded projection');
select is(jsonb_array_length(public.list_developer_room_catalog(pg_temp.developer_id(),pg_temp.rid(201),'all',null,null,2)->'items'),
  2,'developer list is bounded');
select throws_ok(format('select public.list_developer_room_catalog(%L,%L,''all'',null,null,50)',pg_temp.rid(2),pg_temp.rid(202)),
  '42501','DEVELOPER_REQUIRED','admin cannot read developer room catalog');
select throws_ok(format('select public.list_developer_room_catalog(%L,%L,''all'',null,null,50)',pg_temp.rid(3),pg_temp.rid(203)),
  '42501','DEVELOPER_REQUIRED','maid cannot read developer room catalog');
select throws_ok(format('select public.list_developer_room_catalog(%L,%L,''all'',null,null,50)',pg_temp.rid(4),pg_temp.rid(204)),
  '42501','DEVELOPER_REQUIRED','inactive developer cannot read developer room catalog');
select throws_ok(format('select public.list_developer_room_catalog(%L,%L,''all'',null,null,50)',pg_temp.developer_id(),pg_temp.rid(299)),
  '42501','SESSION_REVOKED','revoked session cannot read developer room catalog');

create temp table created_room as
select public.create_room_catalog_entry(pg_temp.developer_id(),pg_temp.rid(201),'999',
  (select id from public.room_types where code='standard'),1,'A','room-create-0230',repeat('a',64)) response;
select is((select response->>'roomNumber' from created_room),'999','developer creates a room from published catalog');
select is((public.list_developer_room_catalog(pg_temp.developer_id(),pg_temp.rid(201),'active',null,null,100)#>>'{counts,active}')::integer,
  122,'active count follows catalog creation');
select is(public.create_room_catalog_entry(pg_temp.developer_id(),pg_temp.rid(201),'999',
  (select id from public.room_types where code='standard'),1,'A','room-create-0230',repeat('a',64)),
  (select response from created_room),'same create request replays the receipt');
select throws_ok(format($q$select public.create_room_catalog_entry(%L,%L,'998',%L,1,'A','room-create-0230',repeat('b',64))$q$,
  pg_temp.developer_id(),pg_temp.rid(201),(select id from public.room_types where code='standard')),
  '23505','IDEMPOTENCY_KEY_REUSED','same create key with different payload is rejected');

select throws_ok(format($q$select public.retire_room_catalog_entry(%L,%L,%L,2,'ROOM_REMOVED','room-retire-0230',repeat('c',64))$q$,
  pg_temp.developer_id(),pg_temp.rid(201),(select (response->>'id')::uuid from created_room)),
  '40001','STALE_VERSION','retire uses room version CAS');
create temp table retired_room as
select public.retire_room_catalog_entry(pg_temp.developer_id(),pg_temp.rid(201),
  (select (response->>'id')::uuid from created_room),1,'ROOM_REMOVED','room-retire-0230',repeat('c',64)) response;
select is((select response->>'status' from retired_room),'retired','delete UX is logical retirement');
select is((public.list_developer_room_catalog(pg_temp.developer_id(),pg_temp.rid(201),'all',null,null,100)#>>'{counts,retired}')::integer,
  1,'retired count is projected');
select is((select count(*)::integer from public.get_room_operational_projection(pg_temp.rid(2),
  (select (response->>'id')::uuid from created_room))),0,'ordinary admin room projection excludes retired room');
select throws_ok(format($q$insert into private.stay_room_segments(id,stay_id,source_reservation_id,room_id,starts_at,ends_at,created_at)
  values(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),%L,clock_timestamp(),clock_timestamp()+interval '1 day',clock_timestamp())$q$,
  (select (response->>'id')::uuid from created_room)),
  '55000','ROOM_RETIRED','stay segment cannot target a retired room');
select throws_ok(format($q$select public.retire_room_catalog_entry(%L,%L,%L,2,'ROOM_REMOVED','room-retire-0231',repeat('d',64))$q$,
  pg_temp.developer_id(),pg_temp.rid(201),(select (response->>'id')::uuid from created_room)),
  '23514','ROOM_ALREADY_RETIRED','retired rooms cannot resurrect or retire twice');
select ok(exists(select 1 from public.audit_events where event_type='room.catalog_created'),'create audit is immutable evidence');
select ok(exists(select 1 from public.audit_events where event_type='room.catalog_retired'),'retire audit is immutable evidence');

select * from finish();
rollback;
