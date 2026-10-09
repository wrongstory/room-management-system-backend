begin;
select plan(14);
select is(pg_get_indexdef('public.room_candle_events_effective_lookup_idx'::regclass),
  'CREATE INDEX room_candle_events_effective_lookup_idx ON public.room_candle_events USING btree (room_id, effective_at DESC, recorded_at DESC, id DESC)',
  'candle effective lookup exactly matches the existing predicate/order');
select is(pg_get_indexdef('public.room_pin_sync_events_effective_lookup_idx'::regclass),
  'CREATE INDEX room_pin_sync_events_effective_lookup_idx ON public.room_pin_sync_events USING btree (room_id, effective_at DESC, recorded_at DESC, id DESC)',
  'PIN state effective lookup exactly matches the existing predicate/order');
select ok((select indisvalid and indisready and not indisunique from pg_index
  where indexrelid='public.room_candle_events_effective_lookup_idx'::regclass),'candle index ready, valid, nonunique');
select ok((select indisvalid and indisready and not indisunique from pg_index
  where indexrelid='public.room_pin_sync_events_effective_lookup_idx'::regclass),'PIN state index ready, valid, nonunique');
select ok(to_regclass('public.room_candle_events_room_idx') is not null,'existing candle recorded-order index retained');
select ok(to_regclass('public.room_pin_sync_events_room_idx') is not null,'existing PIN recorded-order index retained');
select ok((select relrowsecurity from pg_class where oid='public.room_candle_events'::regclass),'candle RLS remains enabled');
select ok((select relrowsecurity from pg_class where oid='public.room_pin_sync_events'::regclass),'PIN state RLS remains enabled');
select is((select md5(prosrc) from pg_proc where oid='private.room_board_candle_count_at(uuid,timestamptz)'::regprocedure),
  '4c58cb1564512e28dcb4327994acd376','historical candle helper unchanged');
select is((select md5(prosrc) from pg_proc where oid='private.room_board_pin_sync_status_at(uuid,timestamptz)'::regprocedure),
  'ffae0161f594f1d11f048db47752c9c4','historical PIN state helper unchanged');

insert into auth.users(id) values('41600000-0000-4000-8000-000000000001');
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password)
values('41600000-0000-4000-8000-000000000002','41600000-0000-4000-8000-000000000001',
  'index fixture','index fixture','index fixture','index fixture',0,'admin','active',false);
create temporary table index_fixture_room as select id from public.rooms order by id limit 1;
insert into public.room_candle_events(room_id,count_before,count_after,physically_verified,reason_code,actor_profile_id,effective_at)
select id,0,3,false,'INDEX_FIXTURE','41600000-0000-4000-8000-000000000002','2020-01-02T00:00:00Z' from index_fixture_room;
select is(private.room_board_candle_count_at((select id from index_fixture_room),'2020-01-01T00:00:00Z'),0,'before candle event remains zero');
select is(private.room_board_candle_count_at((select id from index_fixture_room),'2020-01-02T00:00:00Z'),3,'inclusive effective boundary retained');
-- Deliberately reverse insert order and tie both timestamps: UUID is decisive.
insert into public.room_pin_sync_events(id,room_id,sync_status,reason_code,actor_profile_id,effective_at,recorded_at)
select x.id,r.id,x.status,'INDEX_FIXTURE','41600000-0000-4000-8000-000000000002',
  '2020-01-02T00:00:00Z','2020-01-03T00:00:00Z'
from index_fixture_room r cross join (values
  ('41600000-0000-4000-8000-000000000005'::uuid,'mismatch'),
  ('41600000-0000-4000-8000-000000000004'::uuid,'unconfigured')) x(id,status);
select is(private.room_board_pin_sync_status_at((select id from index_fixture_room),'2020-01-01T00:00:00Z'),
  'unconfigured','before PIN state event remains unconfigured');
select is(private.room_board_pin_sync_status_at((select id from index_fixture_room),'2020-01-02T00:00:00Z'),
  'mismatch','full timestamp tie still picks descending UUID');
select * from finish();
rollback;
