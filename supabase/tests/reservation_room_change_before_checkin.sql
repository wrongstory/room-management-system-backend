begin;

select plan(36);

create function pg_temp.capture_room_move_error_detail(p_statement text)
returns jsonb
language plpgsql
as $$
declare
  v_detail text;
begin
  execute p_statement;
  return null;
exception
  when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    return v_detail::jsonb;
end
$$;

insert into auth.users (id) values
  ('87000000-0000-4000-8000-000000000001'),
  ('87000000-0000-4000-8000-000000000002');

insert into public.profiles (
  id, auth_user_id, display_name, display_name_normalized,
  login_id, login_id_normalized, login_sequence, role, status,
  must_change_password
) values
  (
    '87100000-0000-4000-8000-000000000001',
    '87000000-0000-4000-8000-000000000001',
    '객실 이동 관리자', '객실 이동 관리자', '객실 이동 관리자',
    '객실 이동 관리자', 0, 'admin', 'active', false
  ),
  (
    '87100000-0000-4000-8000-000000000002',
    '87000000-0000-4000-8000-000000000002',
    '객실 이동 메이드', '객실 이동 메이드', '객실 이동 메이드',
    '객실 이동 메이드', 0, 'maid', 'active', false
  );

insert into public.cleaning_template_versions (
  room_type_id, cleaning_kind, version, status, duration_minutes,
  photo_slots, published_at, created_by
)
select id, 'checkout', 1, 'published', 60, '[]'::jsonb,
  clock_timestamp(), '87100000-0000-4000-8000-000000000001'
from public.room_types;

create temporary table room_move_fixtures (
  label text primary key,
  reservation_id uuid not null,
  source_room_id uuid not null,
  target_room_id uuid not null,
  guest_count integer not null,
  check_in_at timestamptz not null,
  check_out_at timestamptz not null
);

insert into room_move_fixtures
select fixture.label, fixture.reservation_id, source.id, target.id,
  fixture.guest_count, fixture.check_in_at, fixture.check_out_at
from (values
  ('success', '87200000-0000-4000-8000-000000000001'::uuid, '117', '135', 2,
    '2035-02-01 16:00+09'::timestamptz, '2035-02-03 11:00+09'::timestamptz),
  ('overlap', '87200000-0000-4000-8000-000000000002'::uuid, '136', '240', 3,
    '2035-03-01 16:00+09'::timestamptz, '2035-03-03 11:00+09'::timestamptz),
  ('blocked', '87200000-0000-4000-8000-000000000003'::uuid, '332', '454', 4,
    '2035-04-01 16:00+09'::timestamptz, '2035-04-03 11:00+09'::timestamptz),
  ('workflow', '87200000-0000-4000-8000-000000000004'::uuid, '455', '459', 2,
    '2035-05-01 16:00+09'::timestamptz, '2035-05-03 11:00+09'::timestamptz),
  ('pin', '87200000-0000-4000-8000-000000000005'::uuid, '527', '528', 2,
    '2035-06-01 16:00+09'::timestamptz, '2035-06-03 11:00+09'::timestamptz),
  ('during', '87200000-0000-4000-8000-000000000006'::uuid, '531', '534', 2,
    '2035-07-01 16:00+09'::timestamptz, '2035-07-03 11:00+09'::timestamptz)
) fixture(label, reservation_id, source_number, target_number, guest_count, check_in_at, check_out_at)
join public.rooms source on source.room_number = fixture.source_number
join public.rooms target on target.room_number = fixture.target_number;

do $$
declare fixture room_move_fixtures%rowtype;
begin
  for fixture in select * from room_move_fixtures order by label loop
    perform public.create_reservation(
      '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
      fixture.source_room_id, fixture.check_in_at, fixture.check_out_at,
      fixture.guest_count, 'encrypted-test-value',
      (select state_version from public.rooms where id = fixture.source_room_id),
      'room-move-create-' || fixture.label, repeat('a', 64)
    );
  end loop;
end
$$;

update public.reservations reservation
set actual_check_in_at = fixture.check_in_at
from room_move_fixtures fixture
where fixture.label = 'during'
  and reservation.id = fixture.reservation_id;

-- A separate active reservation makes the overlap target unavailable.
select public.create_reservation(
  '87100000-0000-4000-8000-000000000001',
  '87200000-0000-4000-8000-000000000099',
  (select id from public.rooms where room_number = '240'),
  '2035-03-02 10:00+09', '2035-03-04 11:00+09', 1, null,
  (select state_version from public.rooms where room_number = '240'),
  'room-move-create-overlap-target', repeat('9', 64)
);

insert into public.room_operation_blocks (
  id, room_id, reason_code, starts_at, ends_at, created_by
) values (
  '87300000-0000-4000-8000-000000000001',
  (select id from public.rooms where room_number = '454'),
  'MAINTENANCE', clock_timestamp() - interval '1 hour',
  '2035-04-04 11:00+09', '87100000-0000-4000-8000-000000000001'
);

create temporary table room_move_previews (label text primary key, value jsonb not null);

insert into room_move_previews
select fixture.label, public.preview_reservation_room_move(
  '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
  fixture.target_room_id, reservation.version, source.state_version,
  target.state_version, null, 'GUEST_REQUEST'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label in ('success', 'overlap', 'blocked');

select ok(
  (select (value ->> 'eligible')::boolean from room_move_previews where label = 'success'),
  'private, unpublished BEFORE_CHECKIN move is eligible'
);
select is(
  (select value ->> 'mode' from room_move_previews where label = 'success'),
  'BEFORE_CHECKIN', 'preview returns the supported mode'
);
select is(
  (select (value ->> 'expiresAt')::timestamptz - (value ->> 'evaluatedAt')::timestamptz
   from room_move_previews where label = 'success'),
  interval '5 minutes', 'preview TTL is exactly five minutes'
);
select is(
  (select (preview.value ->> 'effectiveAt')::timestamptz
   from room_move_previews preview where preview.label = 'success'),
  (select fixture.check_in_at from room_move_fixtures fixture where fixture.label = 'success'),
  'omitted preview effectiveAt authoritatively defaults to checkInAt'
);
select isnt(
  (select preview.value ->> 'impactFingerprint'
   from room_move_previews preview where preview.label = 'success'),
  (select alternative.value ->> 'impactFingerprint'
   from room_move_fixtures fixture
   join public.reservations reservation on reservation.id = fixture.reservation_id
   join public.rooms source on source.id = fixture.source_room_id
   join public.rooms target on target.id = fixture.target_room_id
   cross join lateral public.preview_reservation_room_move(
     '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
     fixture.target_room_id, reservation.version, source.state_version,
     target.state_version, fixture.check_in_at, 'ROOM_UNAVAILABLE'
   ) alternative(value)
   where fixture.label = 'success'),
  'reasonCode and authoritative effectiveAt are bound into the impact fingerprint'
);
select is(
  (select count(*) from public.audit_events where event_type = 'reservation.room_moved'),
  0::bigint, 'preview is read-only and appends no move audit event'
);
select ok(
  (select reservation.room_id = fixture.source_room_id
   from public.reservations reservation
   join room_move_fixtures fixture on fixture.reservation_id = reservation.id
   where fixture.label = 'success'),
  'preview does not move the reservation'
);

select throws_ok(
  format(
    'update public.reservations set room_id = %L where id = %L',
    (select target_room_id from room_move_fixtures where label = 'success'),
    (select reservation_id from room_move_fixtures where label = 'success')
  ), '23514', 'RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED',
  'direct and generic room_id updates fail closed'
);

select ok(
  not (select (value ->> 'eligible')::boolean from room_move_previews where label = 'overlap')
  and (select value -> 'rejectionReasonCodes' ? 'RESERVATION_OVERLAP'
       from room_move_previews where label = 'overlap'),
  'overlap preview returns a stable safe rejection'
);
select ok(
  not (select (value ->> 'eligible')::boolean from room_move_previews where label = 'blocked')
  and (select value -> 'rejectionReasonCodes' ? 'TARGET_ROOM_BLOCKED'
       from room_move_previews where label = 'blocked'),
  'target operation block rejects the preview'
);

select public.cancel_reservation(
  '87100000-0000-4000-8000-000000000001', fixture.reservation_id, 1,
  'TEST_INACTIVE_PREVIEW', 'room-move-inactive-cancel', repeat('2', 64)
)
from room_move_fixtures fixture where fixture.label = 'blocked';
select ok(
  (select not (move_preview.value ->> 'eligible')::boolean
     and move_preview.value -> 'rejectionReasonCodes' ? 'RESERVATION_NOT_ACTIVE'
   from room_move_fixtures fixture
   join public.reservations reservation on reservation.id = fixture.reservation_id
   join public.rooms source on source.id = fixture.source_room_id
   join public.rooms target on target.id = fixture.target_room_id
    cross join lateral public.preview_reservation_room_move(
      '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
      fixture.target_room_id, reservation.version, source.state_version,
      target.state_version, null, 'GUEST_REQUEST'
   ) move_preview(value)
   where fixture.label = 'blocked'),
  'inactive reservation returns a 200 ineligible preview projection'
);

select throws_ok(
  format(
    $sql$select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,null,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, reservation.version + 1, source.state_version,
    target.state_version, 'GUEST_REQUEST'
  ), '40001', 'RESERVATION_VERSION_CONFLICT',
  'reservation CAS conflict has its dedicated stable code'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'success';

select is(
  pg_temp.capture_room_move_error_detail(format(
    $sql$select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,null,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, reservation.version + 1, source.state_version,
    target.state_version, 'GUEST_REQUEST'
  )),
  jsonb_build_object(
    'reloadResources', jsonb_build_array(
      'reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'
    ),
    'latestVersions', jsonb_build_object(
      'reservationVersion', reservation.version,
      'sourceRoomVersion', source.state_version,
      'targetRoomVersion', target.state_version
    )
  ),
  'preview conflict DETAIL exposes only reload resources and current versions'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'success';

select throws_ok(
  format(
    $sql$select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,null,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, reservation.version, source.state_version + 1,
    target.state_version, 'GUEST_REQUEST'
  ), '40001', 'SOURCE_ROOM_VERSION_CONFLICT',
  'source room CAS conflict has its dedicated stable code'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'success';

select throws_ok(
  format(
    $sql$select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,null,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, reservation.version, source.state_version,
    target.state_version + 1, 'GUEST_REQUEST'
  ), '40001', 'TARGET_ROOM_VERSION_CONFLICT',
  'target room CAS conflict has its dedicated stable code'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'success';

select throws_ok(
  format(
    $sql$select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,null,%L)$sql$,
    '87100000-0000-4000-8000-000000000002', fixture.reservation_id,
    fixture.target_room_id, reservation.version, source.state_version,
    target.state_version, 'GUEST_REQUEST'
  ), '42501', 'ADMIN_REQUIRED', 'maid cannot preview a room move'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'success';

select throws_ok(
  format(
    $sql$select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, reservation.version, source.state_version,
    target.state_version, fixture.check_in_at + interval '1 second',
    'GUEST_REQUEST'
  ), '22023', 'INVALID_MOVE_EFFECTIVE_AT',
  'BEFORE_CHECKIN preview accepts only omitted or exact checkInAt effectiveAt'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'success';

insert into room_move_previews
select fixture.label, public.preview_reservation_room_move(
  '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
  fixture.target_room_id, reservation.version, source.state_version,
  target.state_version, fixture.check_in_at, 'GUEST_REQUEST'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'during';

select ok(
  (select not (preview.value ->> 'eligible')::boolean
     and preview.value ->> 'mode' = 'DURING_STAY'
     and preview.value -> 'rejectionReasonCodes' ? 'DURING_STAY_NOT_SUPPORTED'
   from room_move_previews preview where preview.label = 'during'),
  'actual check-in returns a 200 DURING_STAY ineligible preview'
);

select throws_ok(
  format(
    $sql$select public.commit_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L,%L,%L,%L,%L,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, preview.value ->> 'reservationVersion',
    preview.value ->> 'sourceRoomVersion', preview.value ->> 'targetRoomVersion',
    preview.value ->> 'evaluatedAt', preview.value ->> 'expiresAt',
    preview.value ->> 'effectiveAt', preview.value ->> 'impactFingerprint',
    'GUEST_REQUEST', 'room-move-during-stay-rejected', repeat('7', 64)
  ), '23514', 'DURING_STAY_NOT_SUPPORTED',
  'DURING_STAY commit returns the dedicated stable 409 domain code'
)
from room_move_fixtures fixture join room_move_previews preview using (label)
where fixture.label = 'during';

create temporary table room_move_results (value jsonb not null);
insert into room_move_results
select public.commit_reservation_room_move(
  '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
  fixture.target_room_id, (preview.value ->> 'reservationVersion')::bigint,
  (preview.value ->> 'sourceRoomVersion')::bigint,
  (preview.value ->> 'targetRoomVersion')::bigint,
  (preview.value ->> 'evaluatedAt')::timestamptz,
  (preview.value ->> 'expiresAt')::timestamptz,
  (preview.value ->> 'effectiveAt')::timestamptz,
  preview.value ->> 'impactFingerprint', 'GUEST_REQUEST',
  'room-move-commit-success', repeat('a', 64)
)
from room_move_fixtures fixture
join room_move_previews preview using (label)
where fixture.label = 'success';

select ok(
  (select reservation.room_id = fixture.target_room_id
     and reservation.check_in_at = fixture.check_in_at
     and reservation.check_out_at = fixture.check_out_at
     and reservation.guest_count = fixture.guest_count
     and reservation.guest_name_encrypted = 'encrypted-test-value'
   from public.reservations reservation
   join room_move_fixtures fixture on fixture.reservation_id = reservation.id
   where fixture.label = 'success'),
  'commit preserves reservation identity, guest, schedule, and count'
);
select ok(
  (select preparation.room_id = fixture.target_room_id
     and obligation.room_id = fixture.target_room_id
   from room_move_fixtures fixture
   join public.reservations reservation on reservation.id = fixture.reservation_id
   join public.preparation_obligations preparation on preparation.id = reservation.preparation_obligation_id
   join public.checkout_cleaning_obligations obligation on obligation.id = reservation.checkout_obligation_id
   where fixture.label = 'success'),
  'commit moves both existing obligations atomically'
);
select ok(
  (select target.id = (preview.value ->> 'plannedCheckoutTargetId')::uuid
     and target.room_id = fixture.target_room_id
   from room_move_fixtures fixture
   join room_move_previews preview using (label)
   join public.reservations reservation on reservation.id = fixture.reservation_id
   join public.checkout_cleaning_obligations obligation on obligation.id = reservation.checkout_obligation_id
   join public.cleaning_targets target on target.id = obligation.planned_cleaning_target_id
   where fixture.label = 'success'),
  'commit preserves and moves the exact planned target identity'
);
select is(
  (select count(*) from public.reservation_schedule_revisions revision
   join room_move_fixtures fixture on fixture.reservation_id = revision.reservation_id
   where fixture.label = 'success'),
  2::bigint, 'commit appends one reservation schedule revision'
);
select ok(
  (select result.value ->> 'evaluatedAt' = preview.value ->> 'evaluatedAt'
     and result.value ->> 'expiresAt' = preview.value ->> 'expiresAt'
     and result.value ->> 'effectiveAt' = preview.value ->> 'effectiveAt'
   from room_move_results result cross join room_move_previews preview
   where preview.label = 'success'),
  'commit echoes the authoritative preview timestamps exactly'
);
select ok(
  (select count(*) = 1
     and bool_and(not (after_state ?| array['guestName', 'pin', 'impactFingerprint']))
   from public.audit_events where event_type = 'reservation.room_moved'),
  'move audit is exactly once and excludes guest, PIN, and raw fingerprint'
);

select throws_ok(
  format(
    $sql$select public.commit_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L,%L,%L,%L,%L,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, preview.value ->> 'reservationVersion',
    preview.value ->> 'sourceRoomVersion', preview.value ->> 'targetRoomVersion',
    preview.value ->> 'evaluatedAt', preview.value ->> 'expiresAt',
    preview.value ->> 'effectiveAt', preview.value ->> 'impactFingerprint',
    'GUEST_REQUEST', 'room-move-already-applied', repeat('3', 64)
  ), '23514', 'MOVE_ALREADY_APPLIED',
  'a different key with the original stale preview returns MOVE_ALREADY_APPLIED before CAS'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join room_move_previews preview using (label)
where fixture.label = 'success';

-- A completed receipt replays before first-attempt TTL validation.
insert into private.command_executions (
  actor_profile_id, command_type, idempotency_key, request_hash,
  entity_id, response_payload
) values (
  '87100000-0000-4000-8000-000000000001', 'reservation.room_move',
  'room-move-expired-replay', repeat('b', 64),
  '87200000-0000-4000-8000-000000000001', '{"replayed":true}'::jsonb
);
select is(
  public.commit_reservation_room_move(
    '87100000-0000-4000-8000-000000000001',
    '87200000-0000-4000-8000-000000000001',
    '87300000-0000-4000-8000-000000000099', 1, 1, 1,
    '2026-01-01T00:00:00Z'::timestamptz,
    '2026-01-01T00:05:00Z'::timestamptz,
    '2035-02-01T07:00:00Z'::timestamptz, repeat('c', 64),
    'GUEST_REQUEST', 'room-move-expired-replay', repeat('b', 64)
  ), '{"replayed":true}'::jsonb,
  'same-key same-payload success replays after expiry before validation'
);
select throws_ok(
  $$select public.commit_reservation_room_move(
    '87100000-0000-4000-8000-000000000001',
    '87200000-0000-4000-8000-000000000001',
    '87300000-0000-4000-8000-000000000099',1,1,1,
    '2026-01-01T00:00:00Z','2026-01-01T00:05:00Z',
    '2035-02-01T07:00:00Z',repeat('c',64),'GUEST_REQUEST',
    'room-move-expired-replay',repeat('d',64))$$,
  '23505', 'IDEMPOTENCY_KEY_REUSED',
  'same key with a different request hash conflicts even after expiry'
);
select is(
  pg_temp.capture_room_move_error_detail($$select public.commit_reservation_room_move(
    '87100000-0000-4000-8000-000000000001',
    '87200000-0000-4000-8000-000000000001',
    '87300000-0000-4000-8000-000000000099',1,1,1,
    '2026-01-01T00:00:00Z','2026-01-01T00:05:00Z',
    '2035-02-01T07:00:00Z',repeat('c',64),'GUEST_REQUEST',
    'room-move-expired-replay',repeat('d',64))$$),
  jsonb_build_object(
    'reloadResources', jsonb_build_array(
      'reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'
    ),
    'latestVersions', jsonb_build_object(
      'reservationVersion', (
        select reservation.version
        from public.reservations reservation
        where reservation.id = '87200000-0000-4000-8000-000000000001'
      ),
      'sourceRoomVersion', (
        select room.state_version
        from public.reservations reservation
        join public.rooms room on room.id = reservation.room_id
        where reservation.id = '87200000-0000-4000-8000-000000000001'
      ),
      'targetRoomVersion', null
    )
  ),
  'different-payload idempotency reuse exposes only safe current conflict metadata'
);
select throws_ok(
  $$select public.commit_reservation_room_move(
    '87100000-0000-4000-8000-000000000001',
    '87200000-0000-4000-8000-000000000002',
    '87300000-0000-4000-8000-000000000099',1,1,1,
    '2026-01-01T00:00:00Z','2026-01-01T00:05:00Z',
    '2035-03-01T07:00:00Z',repeat('c',64),'GUEST_REQUEST',
    'room-move-expired-first',repeat('e',64))$$,
  '40001', 'ROOM_CHANGE_PREVIEW_STALE',
  'a new first attempt after expiry fails closed'
);

-- Synthetic workflow fixtures intentionally bypass writer triggers only while
-- inserting mutually consistent historical rows. The command itself runs with
-- all triggers enabled and must roll back without moving either reservation.
set local session_replication_role = replica;
insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision,
  is_current, service_date, notified_at, changed_by
)
select '87400000-0000-4000-8000-000000000001', target.id,
  '87100000-0000-4000-8000-000000000002', 1, 1, true,
  target.effective_service_date, null,
  '87100000-0000-4000-8000-000000000001'
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.checkout_cleaning_obligations obligation on obligation.id = reservation.checkout_obligation_id
join public.cleaning_targets target on target.id = obligation.planned_cleaning_target_id
where fixture.label = 'workflow';
insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, template_snapshot, room_snapshot
)
select '87500000-0000-4000-8000-000000000001', assignment.cleaning_target_id,
  assignment.id, assignment.maid_profile_id, 1, 'scheduled', assignment.revision,
  '{}'::jsonb, '{}'::jsonb
from public.cleaning_assignments assignment
where assignment.id = '87400000-0000-4000-8000-000000000001';

insert into public.cleaning_assignments (
  id, cleaning_target_id, maid_profile_id, sequence_number, revision,
  is_current, service_date, notified_at, changed_by
)
select '87400000-0000-4000-8000-000000000002', target.id,
  '87100000-0000-4000-8000-000000000002', 1, 1, true,
  target.effective_service_date, null,
  '87100000-0000-4000-8000-000000000001'
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.checkout_cleaning_obligations obligation on obligation.id = reservation.checkout_obligation_id
join public.cleaning_targets target on target.id = obligation.planned_cleaning_target_id
where fixture.label = 'pin';
insert into public.cleaning_attempts (
  id, cleaning_target_id, assignment_id, maid_profile_id, attempt_number,
  status, assignment_revision, template_snapshot, room_snapshot
)
select '87500000-0000-4000-8000-000000000002', assignment.cleaning_target_id,
  assignment.id, assignment.maid_profile_id, 1, 'scheduled', assignment.revision,
  '{}'::jsonb, '{}'::jsonb
from public.cleaning_assignments assignment
where assignment.id = '87400000-0000-4000-8000-000000000002';
insert into public.room_pin_access_leases (
  id, room_id, reservation_id, cleaning_target_id, assignment_id, attempt_id,
  pin_version, issued_to, issued_at, expires_at
)
select '87600000-0000-4000-8000-000000000001', fixture.source_room_id,
  fixture.reservation_id, assignment.cleaning_target_id, assignment.id,
  '87500000-0000-4000-8000-000000000002', 1, assignment.maid_profile_id,
  clock_timestamp() - interval '1 minute', clock_timestamp() + interval '1 hour'
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.checkout_cleaning_obligations obligation on obligation.id = reservation.checkout_obligation_id
join public.cleaning_assignments assignment on assignment.cleaning_target_id = obligation.planned_cleaning_target_id
where fixture.label = 'pin';
set local session_replication_role = origin;

insert into room_move_previews
select fixture.label, public.preview_reservation_room_move(
  '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
  fixture.target_room_id, reservation.version, source.state_version,
  target.state_version, null, 'GUEST_REQUEST'
)
from room_move_fixtures fixture
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label in ('workflow', 'pin');

select throws_ok(
  format(
    $sql$select public.commit_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L,%L,%L,%L,%L,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, preview.value ->> 'reservationVersion',
    preview.value ->> 'sourceRoomVersion', preview.value ->> 'targetRoomVersion',
    preview.value ->> 'evaluatedAt', preview.value ->> 'expiresAt',
    preview.value ->> 'effectiveAt', preview.value ->> 'impactFingerprint', 'GUEST_REQUEST',
    'room-move-workflow-locked', repeat('f', 64)
  ), '23514', 'CLEANING_ASSIGNMENT_LOCKED',
  'assignment or attempt locks the cleaning workflow'
)
from room_move_fixtures fixture join room_move_previews preview using (label)
where fixture.label = 'workflow';

select throws_ok(
  format(
    $sql$select public.commit_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L,%L,%L,%L,%L,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, preview.value ->> 'reservationVersion',
    preview.value ->> 'sourceRoomVersion', preview.value ->> 'targetRoomVersion',
    preview.value ->> 'evaluatedAt', preview.value ->> 'expiresAt',
    preview.value ->> 'effectiveAt', preview.value ->> 'impactFingerprint', 'GUEST_REQUEST',
    'room-move-pin-locked', repeat('1', 64)
  ), '23514', 'PIN_LEASE_ACTIVE', 'an active PIN lease has its dedicated conflict'
)
from room_move_fixtures fixture join room_move_previews preview using (label)
where fixture.label = 'pin';

select is(
  pg_temp.capture_room_move_error_detail(format(
    $sql$select public.commit_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L,%L,%L,%L,%L,%L)$sql$,
    '87100000-0000-4000-8000-000000000001', fixture.reservation_id,
    fixture.target_room_id, preview.value ->> 'reservationVersion',
    preview.value ->> 'sourceRoomVersion', preview.value ->> 'targetRoomVersion',
    preview.value ->> 'evaluatedAt', preview.value ->> 'expiresAt',
    preview.value ->> 'effectiveAt', preview.value ->> 'impactFingerprint', 'GUEST_REQUEST',
    'room-move-pin-detail', repeat('2', 64)
  )),
  jsonb_build_object(
    'reloadResources', jsonb_build_array(
      'reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'
    ),
    'latestVersions', jsonb_build_object(
      'reservationVersion', reservation.version,
      'sourceRoomVersion', source.state_version,
      'targetRoomVersion', target.state_version
    )
  ),
  'commit conflict DETAIL stays allowlisted after locking current versions'
)
from room_move_fixtures fixture
join room_move_previews preview using (label)
join public.reservations reservation on reservation.id = fixture.reservation_id
join public.rooms source on source.id = fixture.source_room_id
join public.rooms target on target.id = fixture.target_room_id
where fixture.label = 'pin';

select ok(
  (select bool_and(reservation.room_id = fixture.source_room_id)
   from room_move_fixtures fixture
   join public.reservations reservation on reservation.id = fixture.reservation_id
   where fixture.label in ('overlap', 'blocked', 'workflow', 'pin')),
  'all rejected overlap, block, workflow, and PIN moves roll back'
);

select ok(
  not has_function_privilege('anon',
    'public.preview_reservation_room_move(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.preview_reservation_room_move(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,text)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.preview_reservation_room_move(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,text)', 'EXECUTE'),
  'preview RPC is service-role only'
);
select ok(
  not has_function_privilege('anon',
    'public.commit_reservation_room_move(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,text,text,text,text)', 'EXECUTE')
  and not has_function_privilege('authenticated',
    'public.commit_reservation_room_move(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,text,text,text,text)', 'EXECUTE')
  and has_function_privilege('service_role',
    'public.commit_reservation_room_move(uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,text,text,text,text)', 'EXECUTE'),
  'commit RPC is service-role only'
);

select * from finish();
rollback;
