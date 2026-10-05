begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('a3181000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
create function pg_temp.kst_today() returns date language sql stable as $$
  select (clock_timestamp() at time zone 'Asia/Seoul')::date
$$;
\ir room_pin_fixture.psql

insert into auth.users(id) values(pg_temp.pid(101));
insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,
  login_id,login_id_normalized,login_sequence,role,status,must_change_password)
values(pg_temp.pid(201),pg_temp.pid(101),'LIVE 관리자','LIVE 관리자',
  'board-live-admin','board-live-admin',0,'admin','active',false);
insert into auth.sessions(id,user_id) values(pg_temp.pid(301),pg_temp.pid(101));
insert into public.rooms(id,room_number,room_type_id,elevator_zone)
select pg_temp.pid(400+n),(980+n)::text,type.id,'A'
from public.room_types type cross join generate_series(1,6) n where type.code='premium';

-- INSERT-only, owner-created encrypted fixtures are synthetic test material,
-- not actual room PINs. All production nonce/lease/ledger triggers stay active.
select pg_temp.install_room_pin_fixture(pg_temp.pid(402),pg_temp.pid(201),2);
select pg_temp.install_room_pin_fixture(pg_temp.pid(403),pg_temp.pid(201),1);
select pg_temp.install_room_pin_fixture(pg_temp.pid(404),pg_temp.pid(201),1);
select pg_temp.install_room_pin_fixture(pg_temp.pid(405),pg_temp.pid(201),1);
-- The expired fixture is born with a valid historical <=5-minute lease; no
-- immutable clock is rewritten and no real provider or physical lock is used.
insert into private.room_pin_change_leases(room_id,expected_pin_version,
  proposed_pin_version,actor_profile_id,actor_role_snapshot,reason_code,
  envelope_format,ciphertext,nonce,auth_tag,key_version,aad_environment,
  aad_project_ref,request_hash,idempotency_key,status,prepared_at,expires_at,resolved_at)
select pg_temp.pid(400+n),1,2,pg_temp.pid(201),'admin','ADMIN_PHYSICAL_CHANGE',
  1,digest('board-live-lease-'||n,'sha256'),
  substring(digest('board-live-nonce-'||n,'sha256') for 12),
  substring(digest('board-live-tag-'||n,'sha256') for 16),
  'board-live-fixture','test','local',repeat('a',64),'board-live-lease-'||n,
  case when n=3 then 'prepared' else 'expired' end,
  clock_timestamp()-case when n=3 then interval '0 minutes' else interval '6 minutes' end,
  clock_timestamp()+case when n=3 then interval '4 minutes' else interval '-2 minutes' end,
  case when n=4 then clock_timestamp() else null end
from generate_series(3,4) n;
insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,
  actor_profile_id,effective_at)
select pg_temp.pid(400+n),'verified',1,'LEGACY_VERIFIED_FIXTURE',pg_temp.pid(201),
  clock_timestamp() from generate_series(1,5) n;

-- A valid initial historical occupancy fixture has elapsed scheduled checkout
-- but no actual departure. INSERT establishes original clocks and deferred FK
-- pairs with every stay-ledger/obligation guard enabled. No existing fact is edited.
insert into public.cleaning_template_versions(room_type_id,cleaning_kind,version,
  status,duration_minutes,photo_slots,published_at,created_by)
select id,'checkout',318101,'published',null,
  '[{"slotKey":"cleaning-proof","displayOrder":0,"required":true,"label":"청소 사진","maxPhotos":20},
    {"slotKey":"bomb-proof","displayOrder":1,"required":false,"label":"폭탄방 증빙","maxPhotos":10},
    {"slotKey":"issue-proof","displayOrder":2,"required":false,"label":"특이사항 증빙","maxPhotos":10}]'::jsonb,
  clock_timestamp(),pg_temp.pid(201) from public.room_types where code='premium';
insert into public.reservations(id,room_id,reservation_type,check_in_at,check_out_at,
  actual_check_in_at,guest_count,preparation_obligation_id,checkout_obligation_id,
  created_by,updated_by)
values(pg_temp.pid(606),pg_temp.pid(406),'standard',
  (pg_temp.kst_today()-3+time '16:00') at time zone 'Asia/Seoul',
  (pg_temp.kst_today()-1+time '11:00') at time zone 'Asia/Seoul',
  (pg_temp.kst_today()-3+time '16:00') at time zone 'Asia/Seoul',
  2,pg_temp.pid(706),pg_temp.pid(806),pg_temp.pid(201),pg_temp.pid(201));
insert into public.preparation_obligations(id,reservation_id,room_id)
values(pg_temp.pid(706),pg_temp.pid(606),pg_temp.pid(406));
insert into public.checkout_cleaning_obligations(id,reservation_id,room_id,
  original_service_date,effective_service_date,available_from,created_by)
values(pg_temp.pid(806),pg_temp.pid(606),pg_temp.pid(406),
  pg_temp.kst_today()-1,pg_temp.kst_today()-1,
  (pg_temp.kst_today()-1+time '11:00') at time zone 'Asia/Seoul',pg_temp.pid(201));
select private.ensure_planned_checkout_target(pg_temp.pid(806));

create temporary table fixture_history_before as
select (select count(*) from public.room_pin_sync_events
  where room_id in(select pg_temp.pid(400+n) from generate_series(1,6) n)) pin_events,
  (select count(*) from private.room_pin_revisions
    where room_id in(select pg_temp.pid(400+n) from generate_series(1,6) n)) pin_revisions;

set local role service_role;
create temporary table omitted_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),null,null)
where id in(select pg_temp.pid(400+n) from generate_series(1,6) n);
create temporary table today_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),pg_temp.kst_today(),null)
where id in(select pg_temp.pid(400+n) from generate_series(1,6) n);
select is((select count(*)::int from today_board),6,'all isolated LIVE fixture rooms are projected');
select ok((select bool_and(projection_mode='LIVE') from today_board),'explicit today is always LIVE');
with delayed_live_clock as materialized (
  select pg_temp.pid(401) room_id,pg_sleep(0.02)
)
select ok((select bool_and(board.server_time=statement_timestamp()
    and board.evaluated_at=statement_timestamp())
  from delayed_live_clock delay
  cross join lateral public.get_room_board_projection(
    pg_temp.pid(201),pg_temp.pid(301),null,delay.room_id) board),
  'STABLE LIVE board uses this statement start even when invocation is delayed');
select ok(not exists(
  (select to_jsonb(board)-'server_time'-'evaluated_at' from omitted_board board
   except select to_jsonb(board)-'server_time'-'evaluated_at' from today_board board)
  union all
  (select to_jsonb(board)-'server_time'-'evaluated_at' from today_board board
   except select to_jsonb(board)-'server_time'-'evaluated_at' from omitted_board board)
),'omitted and explicit today have identical business fields, excluding per-call clocks');
select is((select pin_sync_status from today_board where id=pg_temp.pid(401)),
  'unconfigured','legacy verified event without a current encrypted PIN stays unconfigured');
select is((select pin_sync_status from today_board where id=pg_temp.pid(402)),
  'mismatch','verified event for a stale PIN version stays mismatched');
select is((select pin_sync_status from today_board where id=pg_temp.pid(403)),
  'mismatch','prepared physical change wins over a later legacy verified event');
select is((select pin_sync_status from today_board where id=pg_temp.pid(404)),
  'mismatch','expired unresolved physical change wins over a later legacy verified event');
select is((select pin_sync_status from today_board where id=pg_temp.pid(405)),
  'verified','matching encrypted current version and public verification remain verified');
select ok((select bool_and('PIN_SYNC_WARNING'=any(detail_condition_codes))
  from today_board where id in(select pg_temp.pid(400+n) from generate_series(1,4) n)),
  'all four unsafe LIVE PIN states retain the warning condition');
select ok(not(select cleaning_required from today_board where id=pg_temp.pid(406)),
  'elapsed planned checkout alone is not a LIVE cleaning obligation');
select ok((select 'CHECKOUT_INSPECTION_REQUIRED'=any(detail_condition_codes)
  from today_board where id=pg_temp.pid(406)),
  'elapsed planned checkout independently requires inspection before field completion');
select ok((select occupied from today_board where id=pg_temp.pid(406)),
  'actual active occupancy remains occupied after the scheduled checkout');
select is((select occupancy_status from today_board where id=pg_temp.pid(406)),
  'OCCUPIED','LIVE occupancy status preserves actual active occupancy');
select is((select reservation_lifecycle from today_board where id=pg_temp.pid(406)),
  'OCCUPIED','LIVE reservation lifecycle preserves actual active occupancy');
select is((select primary_display_status from today_board where id=pg_temp.pid(406)),
  'OCCUPIED','LIVE primary display does not falsely lower an active stay to vacant');
select ok((select reason_codes @> array['OCCUPIED','RESERVATION_CURRENT']
  from today_board where id=pg_temp.pid(406)),
  'LIVE occupancy and current reservation reasons remain present');
select ok(not(select 'VACANT'=any(detail_condition_codes)
  from today_board where id=pg_temp.pid(406)),
  'LIVE actual active occupancy never receives the VACANT detail condition');

create temporary table future_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),pg_temp.kst_today()+1,null)
where id in(select pg_temp.pid(400+n) from generate_series(1,6) n);
select is((select pin_sync_status from future_board where id=pg_temp.pid(401)),
  'verified','future event-clock PIN projection is not replaced by the LIVE helper');
select ok((select cleaning_required from future_board where id=pg_temp.pid(406)),
  'future projection still includes planned checkout obligations');
select ok(not(select occupied from future_board where id=pg_temp.pid(406)),
  'future projection still uses its scheduled segment end rather than LIVE actual occupancy');
select ok((select 'VACANT'=any(detail_condition_codes)
  from future_board where id=pg_temp.pid(406)),
  'future scheduled vacancy detail is unchanged by LIVE actual occupancy');
create temporary table elapsed_past_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),
  pg_temp.kst_today()-1,pg_temp.pid(406));
select ok(not(select occupied from elapsed_past_board),
  'past projection still uses the historical scheduled segment end');
create temporary table past_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),pg_temp.kst_today()-1,pg_temp.pid(401));
select is((select pin_sync_status from past_board),'unconfigured',
  'today-recorded verification does not leak into yesterday');
select ok(not has_function_privilege('authenticated',
  'public.get_room_board_projection(uuid,uuid,date,uuid)','EXECUTE'),
  'append patch retains the authenticated RPC denial');
select throws_ok($$select * from public.get_room_board_projection(
  pg_temp.pid(201),pg_temp.pid(399),null,pg_temp.pid(401))$$,
  '42501','SESSION_REVOKED','LIVE still requires the latest valid actor session');

-- Exercise the real correction command inside a nested rollback-only branch.
-- The actual-active fallback must not resurrect a false-correction successor,
-- and a legitimate occupied restoration must not be blanket-denied by its
-- terminal reason. SAVEPOINT rollback restores the original fixture for checkout.
savepoint before_occupancy_corrections;
create temporary table vacant_correction_result as
select public.correct_room_occupancy(pg_temp.pid(201),pg_temp.pid(301),
  pg_temp.pid(406),pg_temp.pid(606),false,
  (select actual_check_in_at+interval '1 hour' from public.reservations where id=pg_temp.pid(606)),
  (select state_version from public.rooms where id=pg_temp.pid(406)),
  'FRONT_DESK_VERIFIED','board-live-vacant-correction',repeat('c',64)) value;
create temporary table corrected_vacant_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),null,pg_temp.pid(406));
select ok(not(select occupied from corrected_vacant_board),
  'actual-active fallback never resurrects the administrator vacant correction');
select is((select occupancy_status from corrected_vacant_board),'VACANT',
  'administrator correction remains VACANT after the scheduled checkout');
select ok((select 'VACANT'=any(detail_condition_codes) from corrected_vacant_board),
  'administrator correction retains the LIVE vacant detail');
select ok(not(select reason_codes && array['OCCUPIED','RESERVATION_CURRENT'] from corrected_vacant_board),
  'vacant correction removes actual occupancy/current reasons');
select is(public.correct_room_occupancy(pg_temp.pid(201),pg_temp.pid(301),
  pg_temp.pid(406),pg_temp.pid(606),false,
  (select (value->>'effective_at')::timestamptz from vacant_correction_result),
  (select (value->>'room_state_version')::bigint-1 from vacant_correction_result),
  'FRONT_DESK_VERIFIED','board-live-vacant-correction',repeat('c',64)),
  (select value from vacant_correction_result),'vacant correction response-loss retry replays the identical receipt');
-- Private ledger readback is fixture-owner inspection, not a service-role grant.
reset role;
select is((select count(*)::int from private.room_occupancy_corrections where room_id=pg_temp.pid(406)),
  1,'vacant correction replay appends no duplicate immutable ledger');
select ok((select replaced.retired_at is not null and successor.retired_at is null
  and successor.ends_at=correction.effective_at and not correction.occupied
  from private.room_occupancy_corrections correction
  join private.stay_room_segments replaced on replaced.id=correction.replaced_segment_id
  join private.stay_room_segments successor on successor.id=correction.successor_segment_id
  where correction.room_id=pg_temp.pid(406)),
  'vacant correction retains retired source and exact truncated successor history');
select ok((select stay.status='active' and reservation.actual_check_in_at is not null
  and reservation.actual_checkout_at is null
  from private.reservation_stays stay join public.reservations reservation on reservation.id=stay.reservation_id
  where reservation.id=pg_temp.pid(606)),
  'vacant correction does not fabricate a departure or rewrite the active stay');

set local role service_role;
create temporary table occupied_correction_result as
select public.correct_room_occupancy(pg_temp.pid(201),pg_temp.pid(301),
  pg_temp.pid(406),pg_temp.pid(606),true,
  (select actual_check_in_at+interval '2 hours' from public.reservations where id=pg_temp.pid(606)),
  (select state_version from public.rooms where id=pg_temp.pid(406)),
  'FRONT_DESK_VERIFIED','board-live-occupied-restore',repeat('d',64)) value;
create temporary table restored_occupied_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),null,pg_temp.pid(406));
select ok((select occupied from restored_occupied_board),
  'legitimate same-room occupied restoration remains LIVE occupied after schedule end');
select is((select primary_display_status from restored_occupied_board),'OCCUPIED',
  'a positive correction is not blanket-denied by its terminal reason');
select ok(not(select 'VACANT'=any(detail_condition_codes) from restored_occupied_board),
  'legitimate restoration removes the LIVE vacant detail');
select is(public.correct_room_occupancy(pg_temp.pid(201),pg_temp.pid(301),
  pg_temp.pid(406),pg_temp.pid(606),true,
  (select (value->>'effective_at')::timestamptz from occupied_correction_result),
  (select (value->>'room_state_version')::bigint-1 from occupied_correction_result),
  'FRONT_DESK_VERIFIED','board-live-occupied-restore',repeat('d',64)),
  (select value from occupied_correction_result),'occupied restoration response-loss retry replays the identical receipt');
reset role;
select is((select count(*)::int from private.room_occupancy_corrections where room_id=pg_temp.pid(406)),
  2,'positive correction replay preserves exactly two immutable correction records');
select ok((select successor.ends_at=reservation.check_out_at
  and successor.terminal_reason_code='ADMIN_OCCUPANCY_CORRECTION'
  from private.room_occupancy_corrections correction
  join private.stay_room_segments successor on successor.id=correction.successor_segment_id
  join public.reservations reservation on reservation.id=correction.reservation_id
  where correction.room_id=pg_temp.pid(406) and correction.occupied),
  'restoration preserves the original lineage end rather than overwriting its clock');
rollback to savepoint before_occupancy_corrections;
release savepoint before_occupancy_corrections;
set local role service_role;

-- The actual command now materializes the initial historical checkout. The
-- scheduled time is preserved; this does not simulate departure by projection.
select public.manual_checkout_reservation(pg_temp.pid(201),pg_temp.pid(606),1,
  'GUEST_LEFT_EARLY',
  (pg_temp.kst_today()-1+time '10:00') at time zone 'Asia/Seoul',
  'board-live-manual-checkout',repeat('b',64));
create temporary table materialized_board as
select * from public.get_room_board_projection(pg_temp.pid(201),pg_temp.pid(301),null,pg_temp.pid(406));
select ok((select cleaning_required from materialized_board),
  'actual materialized checkout is required by the LIVE projection');
select ok(not(select occupied from materialized_board),
  'actual checkout closes LIVE occupancy instead of extending a completed stay');
select is((select occupancy_status from materialized_board),'VACANT',
  'actual checkout restores the LIVE vacant occupancy status');
select is((select reservation_lifecycle from materialized_board),'NONE',
  'actual checkout leaves no current or next LIVE reservation');
select is((select primary_display_status from materialized_board),'CLEANING_REQUIRED',
  'actual checkout displays the materialized cleaning obligation');
select ok((select 'VACANT'=any(detail_condition_codes) from materialized_board),
  'actual checkout restores the LIVE VACANT detail condition');
select ok(not(select reason_codes && array['OCCUPIED','RESERVATION_CURRENT'] from materialized_board),
  'actual checkout removes LIVE occupancy/current reasons');
reset role;
select is((select status::text from public.checkout_cleaning_obligations where id=pg_temp.pid(806)),
  'materialized','the actual checkout command materialized the guarded obligation');
select is((select check_out_at from public.reservations where id=pg_temp.pid(606)),
  (pg_temp.kst_today()-1+time '11:00') at time zone 'Asia/Seoul',
  'actual checkout does not overwrite the original scheduled clock');
select is((select count(*) from public.room_pin_sync_events
  where room_id in(select pg_temp.pid(400+n) from generate_series(1,6) n)),
  (select pin_events from fixture_history_before),'room board reads preserve every PIN verification event');
select is((select count(*) from private.room_pin_revisions
  where room_id in(select pg_temp.pid(400+n) from generate_series(1,6) n)),
  (select pin_revisions from fixture_history_before),'room board reads preserve encrypted PIN revision history');
set constraints all immediate;
select * from finish();
rollback;
