begin;
\ir room_pin_fixture.psql

select plan(94);

select is((
  with scoped_tables as (
    select relation.oid
    from pg_catalog.pg_class relation
    where relation.relnamespace='private'::regnamespace
      and relation.relname in (
        'reservation_stays','reservation_room_move_events','stay_room_segments',
        'stay_segment_checkout_obligations','room_pin_access_scheduled_revocations'
      )
  )
  select count(*)
  from pg_catalog.pg_constraint constraint_row
  where constraint_row.contype='f'
    and constraint_row.conrelid in (select oid from scoped_tables)
    and not exists (
      select 1
      from pg_catalog.pg_index index_row
      where index_row.indrelid=constraint_row.conrelid
        and index_row.indisvalid and index_row.indisready
        and (
          (index_row.indpred is null and index_row.indnkeyatts>=cardinality(constraint_row.conkey)
            and (select array_agg(key_column.attnum order by key_column.ordinality)
              from unnest(index_row.indkey::smallint[]) with ordinality
                key_column(attnum,ordinality)
              where key_column.ordinality<=cardinality(constraint_row.conkey))=constraint_row.conkey)
          or
          (index_row.indisunique and index_row.indpred is null
            and index_row.indnkeyatts<cardinality(constraint_row.conkey)
            and (select array_agg(key_column.attnum order by key_column.ordinality)
              from unnest(index_row.indkey::smallint[]) with ordinality
                key_column(attnum,ordinality)
              where key_column.ordinality<=index_row.indnkeyatts)
              =constraint_row.conkey[1:index_row.indnkeyatts])
        )
    )
),0::bigint,'every Phase C private FK has a non-partial supporting index or a unique leading identity');

insert into auth.users(id) values
  ('8a000000-0000-4000-8000-000000000001'),
  ('8a000000-0000-4000-8000-000000000002'),
  ('8a000000-0000-4000-8000-000000000003');
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password
) values
  ('8a100000-0000-4000-8000-000000000001','8a000000-0000-4000-8000-000000000001',
    '이동 관리자','이동 관리자','이동 관리자','이동 관리자',0,'admin','active',false),
  ('8a100000-0000-4000-8000-000000000002','8a000000-0000-4000-8000-000000000002',
    '관찰 관리자','관찰 관리자','관찰 관리자','관찰 관리자',0,'admin','active',false),
  ('8a100000-0000-4000-8000-000000000003','8a000000-0000-4000-8000-000000000003',
    '이동 메이드','이동 메이드','이동 메이드','이동 메이드',0,'maid','active',false);

insert into public.cleaning_template_versions(
  room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,published_at,created_by
)
select id,'checkout',1,'published',60,'[]'::jsonb,clock_timestamp(),
  '8a100000-0000-4000-8000-000000000001' from public.room_types;

create temporary table move_context as
select
  '8a200000-0000-4000-8000-000000000001'::uuid reservation_id,
  source.id source_room_id,target.id target_room_id,
  (date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')+interval '1 day 16 hours')
    at time zone 'Asia/Seoul' check_in_at,
  (date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')+interval '3 days 11 hours')
    at time zone 'Asia/Seoul' check_out_at
from public.rooms source join public.rooms target on target.room_number='135'
where source.room_number='117';
alter table move_context add column effective_at timestamptz;
update move_context set effective_at=check_in_at+interval '2 hours';

select public.create_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation_id,source_room_id,
  check_in_at,check_out_at,2,null,
  (select state_version from public.rooms where id=source_room_id),
  'during-stay-create',repeat('1',64)
) from move_context;
update public.reservations reservation set actual_check_in_at=context.check_in_at-interval '2 hours'
from move_context context where reservation.id=context.reservation_id;

select ok((select segment.starts_at=context.check_in_at-interval '2 hours'
  from private.reservation_stays stay join private.stay_room_segments segment on segment.stay_id=stay.id
  cross join move_context context where stay.reservation_id=context.reservation_id
    and segment.retired_at is null),'early check-in is preserved as the active segment boundary');

create temporary table preview as
select public.preview_reservation_room_move(
  '8a100000-0000-4000-8000-000000000001',context.reservation_id,context.target_room_id,
  reservation.version,source.state_version,target.state_version,context.effective_at,'ROOM_UNAVAILABLE'
) value
from move_context context join public.reservations reservation on reservation.id=context.reservation_id
join public.rooms source on source.id=context.source_room_id
join public.rooms target on target.id=context.target_room_id;

select is((select value->>'mode' from preview),'DURING_STAY','preview selects DURING_STAY');
select ok((select (value->>'eligible')::boolean from preview),'bounded ready target is eligible');
select is(
  (select value->>'preparationObligationId' from preview),
  (select reservation.preparation_obligation_id::text
    from public.reservations reservation cross join move_context context
    where reservation.id=context.reservation_id),
  'preview returns the required preparation obligation identity consumed by both HTTP runtimes'
);
select throws_ok(format(
  'select public.preview_reservation_room_move(%L,%L,%L,%s,%s,%s,%L,%L)',
  '8a100000-0000-4000-8000-000000000001',context.reservation_id,context.target_room_id,
  reservation.version,source.state_version,target.state_version,context.check_out_at,'ROOM_UNAVAILABLE'),
  '22023','INVALID_MOVE_EFFECTIVE_AT','exact checkout boundary is rejected')
from move_context context join public.reservations reservation on reservation.id=context.reservation_id
join public.rooms source on source.id=context.source_room_id join public.rooms target on target.id=context.target_room_id;

create temporary table result as
select public.commit_reservation_room_move(
  '8a100000-0000-4000-8000-000000000001',context.reservation_id,context.target_room_id,
  (preview.value->>'reservationVersion')::bigint,(preview.value->>'sourceRoomVersion')::bigint,
  (preview.value->>'targetRoomVersion')::bigint,(preview.value->>'evaluatedAt')::timestamptz,
  (preview.value->>'expiresAt')::timestamptz,(preview.value->>'effectiveAt')::timestamptz,
  preview.value->>'impactFingerprint','ROOM_UNAVAILABLE','during-stay-move',repeat('2',64)
) value from move_context context cross join preview;

select is((select value->>'mode' from result),'DURING_STAY','commit returns DURING_STAY');
select is((select value#>>'{stay,currentRoomId}' from result),
  (select source_room_id::text from move_context),
  'future move response keeps the source room as the command-time current room');
select is((select value#>>'{sourceOutcome,occupancyStatus}' from result),'VACANT',
  'future move response evaluates source outcome at effectiveAt');
select is((select value#>>'{targetOutcome,occupancyStatus}' from result),'OCCUPIED',
  'future move response evaluates target outcome at effectiveAt');
select is((select private.reservation_current_room_at(context.reservation_id,context.effective_at)
  from move_context context),(select target_room_id from move_context),
  'the current-room projection changes to the target at the effective boundary');
select ok((select reservation.room_id=context.source_room_id from public.reservations reservation
  cross join move_context context where reservation.id=context.reservation_id),
  'reservation room_id remains the original check-in contract room');
select is((select count(*) from private.stay_room_segments segment join private.reservation_stays stay
  on stay.id=segment.stay_id cross join move_context context where stay.reservation_id=context.reservation_id
    and segment.retired_at is null),2::bigint,'move leaves exactly two active history segments');
select is((select count(*) from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id=segment.stay_id cross join move_context context
  where stay.reservation_id=context.reservation_id and segment.retired_at is null
    and segment.ends_at=context.effective_at),1::bigint,
  'source segment ends at the exact effectiveAt');
select is((select count(*) from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id=segment.stay_id cross join move_context context
  where stay.reservation_id=context.reservation_id and segment.retired_at is null
    and segment.starts_at=context.effective_at),1::bigint,
  'target segment starts at the exact effectiveAt');
select is((select count(*) from private.stay_segment_checkout_obligations obligation
  join private.reservation_stays stay on stay.id=obligation.stay_id cross join move_context context
  where stay.reservation_id=context.reservation_id),1::bigint,'source checkout obligation is exactly once');
select is((select count(*) from public.cleaning_targets target cross join move_context context
  where target.reservation_id=context.reservation_id and target.source='stay_room_move_checkout'
    and target.room_id=context.source_room_id and target.available_from=context.effective_at),1::bigint,
  'source checkout cleaning target is bounded at effectiveAt');
select is((select count(*) from public.cleaning_attempts attempt join public.cleaning_targets target
  on target.id=attempt.cleaning_target_id cross join move_context context
  where target.reservation_id=context.reservation_id and target.source='stay_room_move_checkout'),0::bigint,
  'future move does not create a cleaning attempt');
select ok((select obligation.room_id=context.target_room_id and target.room_id=context.target_room_id
  from public.checkout_cleaning_obligations obligation join public.cleaning_targets target
    on target.id=obligation.planned_cleaning_target_id cross join move_context context
  where obligation.reservation_id=context.reservation_id),'final checkout identity follows target room');
select is((select count(*) from private.reservation_room_move_events event cross join move_context context
  where event.reservation_id=context.reservation_id and event.mode='DURING_STAY'),1::bigint,'immutable move event is appended');
select is((select count(*) from public.audit_events audit cross join move_context context
  where audit.entity_id=context.reservation_id and audit.event_type='reservation.room_moved'),1::bigint,
  'safe domain audit is appended');
select ok((select not (audit.before_state ? 'sourceSegmentId')
    and not (audit.after_state ? 'sourceSegmentId')
    and not (audit.after_state ? 'targetSegmentId')
  from public.audit_events audit cross join move_context context
  where audit.entity_id=context.reservation_id and audit.event_type='reservation.room_moved'),
  'raw audit state exposes no private stay segment identity');
select is((select count(*) from public.notifications where event_family='reservation.room_moved_during_stay'),
  1::bigint,'other active admin receives one typed notification');
select ok((select notice.source_entity_kind='reservation'
    and notice.source_entity_id=context.reservation_id::text
    and position(event.id::text in coalesce(notice.dedupe_key,''))=0
  from public.notifications notice cross join move_context context
  join private.reservation_room_move_events event on event.reservation_id=context.reservation_id
  where notice.event_family='reservation.room_moved_during_stay'),
  'raw public notification provenance and dedupe expose only the public reservation identity');
select is((select count(*) from private.notification_delivery_outbox outbox join public.notifications notice
  on notice.id=outbox.notification_id where notice.event_family='reservation.room_moved_during_stay'),1::bigint,
  'typed delivery outbox is atomic with notification');
select is((select count(*) from public.notifications notice
  where notice.event_family='reservation.room_moved_during_stay'
    and notice.recipient_profile_id='8a100000-0000-4000-8000-000000000001'),0::bigint,
  'actor self notification is suppressed');

select is((select replay.value->>'sourceCleaningTargetId' from (
  select public.commit_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',context.reservation_id,context.target_room_id,
    (preview.value->>'reservationVersion')::bigint,(preview.value->>'sourceRoomVersion')::bigint,
    (preview.value->>'targetRoomVersion')::bigint,(preview.value->>'evaluatedAt')::timestamptz,
    (preview.value->>'expiresAt')::timestamptz,(preview.value->>'effectiveAt')::timestamptz,
    preview.value->>'impactFingerprint','ROOM_UNAVAILABLE','during-stay-move',repeat('2',64)) value
  from move_context context cross join preview) replay),
  (select value->>'sourceCleaningTargetId' from result),'same-key replay returns the original result');
select is((select count(*) from private.reservation_room_move_events),1::bigint,'replay creates no duplicate event');
select throws_ok(format(
  'insert into private.stay_room_segments(stay_id,room_id,starts_at,ends_at,source_reservation_id) select stay.id,%L,%L,%L,%L from private.reservation_stays stay where stay.reservation_id=%L',
  context.target_room_id,context.effective_at,context.check_out_at,
  context.reservation_id,context.reservation_id),
  '23P01',null,'segment exclusion blocks direct overlap bypass') from move_context context;
select throws_ok(format('delete from private.reservation_room_move_events where reservation_id=%L',context.reservation_id),
  '55000','ROOM_MOVE_EVENT_IMMUTABLE','move event deletion is forbidden') from move_context context;

select public.manual_checkout_reservation(
  '8a100000-0000-4000-8000-000000000001',context.reservation_id,reservation.version,
  'TEST',context.check_out_at-interval '1 hour','during-stay-manual-checkout',repeat('3',64)
) from move_context context join public.reservations reservation on reservation.id=context.reservation_id;
select ok((select reservation.status='checked_out' and reservation.room_id=context.source_room_id
  from public.reservations reservation cross join move_context context
  where reservation.id=context.reservation_id),'manual checkout preserves historical reservation room');
select is((select count(*) from public.room_occupancy_events event cross join move_context context
  where event.reservation_id=context.reservation_id and event.event_type='manual_checkout'
    and event.room_id=context.target_room_id),1::bigint,'manual checkout records the final segment room');
select ok((select segment.ends_at=context.check_out_at-interval '1 hour'
  from private.reservation_stays stay join private.stay_room_segments segment on segment.stay_id=stay.id
  cross join move_context context where stay.reservation_id=context.reservation_id
    and segment.room_id=context.target_room_id and segment.retired_at is null),
  'manual checkout closes the final segment at the actual checkout time');
select ok((select not (move_preview.value->>'eligible')::boolean
    and move_preview.value->'rejectionReasonCodes'?'RESERVATION_NOT_ACTIVE'
  from move_context context
  join public.reservations reservation on reservation.id=context.reservation_id
  join public.rooms source on source.id=context.target_room_id
  join public.rooms target on target.id=context.source_room_id
  cross join lateral public.preview_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',context.reservation_id,context.source_room_id,
    reservation.version,source.state_version,target.state_version,null,'GUEST_REQUEST'
  ) move_preview(value)),
  'checked-out reservation returns a 200 ineligible preview projection');

create function pg_temp.seed_moved_reservation(
  p_reservation_id uuid,p_source_number text,p_target_number text,p_key text,p_hash text,
  p_checkout_soon boolean default false
) returns jsonb language plpgsql as $$
declare source_room public.rooms; target_room public.rooms; reservation public.reservations;
  v_check_in_at timestamptz; v_check_out_at timestamptz; v_effective_at timestamptz;
  preview jsonb; result jsonb;
begin
  select * into strict source_room from public.rooms where room_number=p_source_number;
  select * into strict target_room from public.rooms where room_number=p_target_number;
  v_check_in_at:=((date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')-
    interval '1 day'+interval '16 hours') at time zone 'Asia/Seoul');
  v_check_out_at:=((date_trunc('day',clock_timestamp() at time zone 'Asia/Seoul')+
    interval '1 day 11 hours') at time zone 'Asia/Seoul');
  perform public.create_reservation('8a100000-0000-4000-8000-000000000001',
    p_reservation_id,source_room.id,v_check_in_at,v_check_out_at,2,null,source_room.state_version,
    p_key||'-create',p_hash);
  update public.reservations set actual_check_in_at=v_check_in_at where id=p_reservation_id;
  perform pg_temp.install_room_pin_fixture(
    target_room.id,
    '8a100000-0000-4000-8000-000000000001',
    1
  );
  insert into public.room_pin_sync_events(
    room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
  ) values(
    target_room.id,'verified',1,'TEST',
    '8a100000-0000-4000-8000-000000000001',clock_timestamp()
  );
  -- Anchor both boundaries after all unrelated setup. The 15-second future
  -- window keeps the product's future-effective validation meaningful while
  -- avoiding a scheduler/load race around the former two-second boundary.
  v_effective_at:=clock_timestamp()+interval '15 seconds';
  if p_checkout_soon then
    v_check_out_at:=date_trunc('minute',v_effective_at)+interval '1 minute';
    perform set_config('app.reservation_segment_writer_mode','schedule_change_v1',true);
    update public.reservations
    set check_out_at=v_check_out_at,updated_at=clock_timestamp()
    where id=p_reservation_id;
    perform set_config('app.reservation_segment_writer_mode','',true);
    update public.checkout_cleaning_obligations
    set effective_service_date=(v_check_out_at at time zone 'Asia/Seoul')::date,
      available_from=v_check_out_at
    where reservation_id=p_reservation_id;
    update public.cleaning_targets target
    set original_service_date=(v_check_out_at at time zone 'Asia/Seoul')::date,
      effective_service_date=(v_check_out_at at time zone 'Asia/Seoul')::date,
      available_from=v_check_out_at
    from public.checkout_cleaning_obligations obligation
    where obligation.reservation_id=p_reservation_id
      and target.id=obligation.planned_cleaning_target_id;
  end if;
  select * into strict reservation from public.reservations where id=p_reservation_id;
  select * into strict source_room from public.rooms where id=source_room.id;
  select * into strict target_room from public.rooms where id=target_room.id;
  select public.preview_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    reservation.version,source_room.state_version,target_room.state_version,v_effective_at,
    'OPERATIONAL_ADJUSTMENT') into preview;
  select public.commit_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    (preview->>'reservationVersion')::bigint,(preview->>'sourceRoomVersion')::bigint,
    (preview->>'targetRoomVersion')::bigint,(preview->>'evaluatedAt')::timestamptz,
    (preview->>'expiresAt')::timestamptz,(preview->>'effectiveAt')::timestamptz,
    preview->>'impactFingerprint','OPERATIONAL_ADJUSTMENT',p_key||'-move',p_hash) into result;
  perform pg_sleep(greatest(0,extract(epoch from (v_effective_at-clock_timestamp())))+0.1);
  return result;
end
$$;

create function pg_temp.assign_and_notify_moved_checkout(
  p_reservation_id uuid,
  p_key text
) returns uuid language plpgsql as $$
declare
  target public.cleaning_targets;
  availability public.availability_versions;
  draft jsonb;
  command_at timestamptz:=clock_timestamp();
  v_week_start date;
begin
  select cleaning.* into strict target
  from public.checkout_cleaning_obligations obligation
  join public.cleaning_targets cleaning on cleaning.id=obligation.planned_cleaning_target_id
  where obligation.reservation_id=p_reservation_id;
  v_week_start:=target.effective_service_date-
    (extract(isodow from target.effective_service_date)::integer-1);
  select * into availability from public.availability_versions version
  where version.maid_profile_id='8a100000-0000-4000-8000-000000000003'
    and version.week_start=v_week_start and version.is_current;
  if availability.id is null then
    insert into public.availability_versions(
      maid_profile_id,week_start,version,submitted_at
    ) values(
      '8a100000-0000-4000-8000-000000000003',v_week_start,1,command_at
    ) returning * into availability;
    insert into public.availability_days(availability_version_id,work_date,available)
    select availability.id,v_week_start+offset_day,true from generate_series(0,6) offset_day;
  end if;
  draft:=public.save_cleaning_assignment_draft(
    '8a100000-0000-4000-8000-000000000001',target.id,
    '8a100000-0000-4000-8000-000000000003',
    coalesce((select max(assignment.sequence_number)+1 from public.cleaning_assignments assignment
      where assignment.maid_profile_id='8a100000-0000-4000-8000-000000000003'
        and assignment.service_date=target.effective_service_date),1),
    target.assignment_version,p_key||'-draft',encode(digest(p_key||'-draft','sha256'),'hex')
  );
  select cleaning.* into strict target
  from public.cleaning_targets cleaning
  where cleaning.id=target.id;
  perform private.commit_and_notify_assignments_at(
    '8a100000-0000-4000-8000-000000000001',target.effective_service_date,
    private.assignment_commit_impact_at(target.effective_service_date,command_at)->>'impactFingerprint',
    jsonb_build_array(jsonb_build_object(
      'cleaningTargetId',target.id,
      'expectedAssignmentVersion',target.assignment_version,
      'expectedAvailabilityVersion',availability.version
    )),p_key||'-notify',encode(digest(p_key||'-notify','sha256'),'hex'),command_at
  );
  return (select assignment.id from public.cleaning_assignments assignment
    where assignment.cleaning_target_id=target.id and assignment.is_current);
end
$$;

create function pg_temp.seed_future_moved_reservation(
  p_reservation_id uuid,p_source_number text,p_target_number text,p_key text,p_hash text
) returns jsonb language plpgsql as $$
declare source_room public.rooms; target_room public.rooms; reservation public.reservations;
  v_check_in_at timestamptz; v_check_out_at timestamptz; v_effective_at timestamptz;
  preview jsonb; result jsonb;
begin
  select * into strict source_room from public.rooms where room_number=p_source_number;
  select * into strict target_room from public.rooms where room_number=p_target_number;
  v_check_in_at:=clock_timestamp()-interval '1 day';
  v_check_out_at:=clock_timestamp()+interval '2 days';
  v_effective_at:=clock_timestamp()+interval '1 hour';
  perform public.create_reservation(
    '8a100000-0000-4000-8000-000000000001',p_reservation_id,source_room.id,
    date_trunc('minute',v_check_in_at),date_trunc('minute',v_check_out_at),2,null,
    source_room.state_version,p_key||'-create',p_hash
  );
  update public.reservations set actual_check_in_at=date_trunc('minute',v_check_in_at)
  where id=p_reservation_id;
  perform pg_temp.install_room_pin_fixture(
    target_room.id,'8a100000-0000-4000-8000-000000000001',1
  );
  insert into public.room_pin_sync_events(
    room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
  ) values(
    target_room.id,'verified',1,'TEST',
    '8a100000-0000-4000-8000-000000000001',clock_timestamp()
  );
  select * into strict reservation from public.reservations where id=p_reservation_id;
  select * into strict source_room from public.rooms where id=source_room.id;
  select * into strict target_room from public.rooms where id=target_room.id;
  select public.preview_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    reservation.version,source_room.state_version,target_room.state_version,v_effective_at,
    'OPERATIONAL_ADJUSTMENT') into preview;
  select public.commit_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    (preview->>'reservationVersion')::bigint,(preview->>'sourceRoomVersion')::bigint,
    (preview->>'targetRoomVersion')::bigint,(preview->>'evaluatedAt')::timestamptz,
    (preview->>'expiresAt')::timestamptz,(preview->>'effectiveAt')::timestamptz,
    preview->>'impactFingerprint','OPERATIONAL_ADJUSTMENT',p_key||'-move',p_hash
  ) into result;
  return result;
end
$$;

-- An early checkout invalidates a future move without mutating the historical
-- reservation room or leaving ghost occupancy/cleanup work.
select pg_temp.seed_future_moved_reservation(
  '8a200000-0000-4000-8000-000000000004','240','314','future-manual',repeat('9',64));
create temporary table future_manual_before as
select reservation.version reservation_version,reservation.room_id historical_room_id,
  clock_timestamp()+interval '30 minutes' checkout_at,stay.id stay_id,
  event.id move_event_id,segment_obligation.cleaning_target_id source_target_id,
  obligation.planned_cleaning_target_id final_target_id
from public.reservations reservation
join private.reservation_stays stay on stay.reservation_id=reservation.id
join private.reservation_room_move_events event on event.reservation_id=reservation.id
join private.stay_segment_checkout_obligations segment_obligation on segment_obligation.stay_id=stay.id
join public.checkout_cleaning_obligations obligation on obligation.reservation_id=reservation.id
where reservation.id='8a200000-0000-4000-8000-000000000004';
create temporary table future_manual_result as
select public.manual_checkout_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,reservation.version,
  'TEST',(select checkout_at from future_manual_before),'future-manual-checkout',repeat('a',64)
) value from public.reservations reservation
where reservation.id='8a200000-0000-4000-8000-000000000004';
select ok((select reservation.status='checked_out'
    and reservation.room_id=before.historical_room_id
  from public.reservations reservation cross join future_manual_before before
  where reservation.id='8a200000-0000-4000-8000-000000000004'),
  'early checkout preserves the historical reservation room');
select ok((select count(*)=1 and bool_and(segment.ends_at=before.checkout_at)
  from private.stay_room_segments segment cross join future_manual_before before
  where segment.stay_id=before.stay_id and segment.retired_at is null
  group by before.checkout_at),
  'early checkout closes the actually occupied source segment at checkout');
select ok((select count(*)=1 and bool_and(segment.retired_at is not null
      and segment.terminal_reason_code='FUTURE_MOVE_INVALIDATED')
  from private.stay_room_segments segment cross join future_manual_before before
  where segment.stay_id=before.stay_id and segment.move_event_id=before.move_event_id
  group by before.move_event_id),
  'early checkout retires the not-yet-effective target segment');
select ok((select obligation.status='cancelled' and target.status='cancelled'
  from private.stay_segment_checkout_obligations obligation
  join public.cleaning_targets target on target.id=obligation.cleaning_target_id
  cross join future_manual_before before where target.id=before.source_target_id),
  'early checkout soft-cancels the future source-room cleanup contract');
select ok((select obligation.room_id=before.historical_room_id
      and target.room_id=before.historical_room_id
      and obligation.available_from=before.checkout_at
      and target.available_from=before.checkout_at
  from public.checkout_cleaning_obligations obligation
  join public.cleaning_targets target on target.id=obligation.current_cleaning_target_id
  cross join future_manual_before before
  where obligation.reservation_id='8a200000-0000-4000-8000-000000000004'),
  'early checkout atomically realigns the final checkout contract to the occupied room');
select ok((select count(*)=1 from private.reservation_room_move_events
    where id=(select move_event_id from future_manual_before))
  and (select public.manual_checkout_reservation(
      '8a100000-0000-4000-8000-000000000001',reservation.id,
      (select reservation_version from future_manual_before),'TEST',
      (select checkout_at from future_manual_before),'future-manual-checkout',repeat('a',64)
    )=(select value from future_manual_result)
    from public.reservations reservation
    where reservation.id='8a200000-0000-4000-8000-000000000004'),
  'early checkout preserves the immutable move event and replays exactly once');

-- At the exact future-move boundary the checkout room is the room occupied
-- immediately before the half-open boundary, never the unrealized target.
select pg_temp.seed_future_moved_reservation(
  '8a200000-0000-4000-8000-000000000010','444','449','future-boundary',repeat('0',64));
create temporary table future_boundary_before as
select reservation.version reservation_version,reservation.room_id historical_room_id,
  event.effective_at checkout_at,event.to_room_id future_room_id,
  stay.id stay_id,obligation.planned_cleaning_target_id final_target_id
from public.reservations reservation
join private.reservation_stays stay on stay.reservation_id=reservation.id
join private.reservation_room_move_events event on event.reservation_id=reservation.id
join public.checkout_cleaning_obligations obligation on obligation.reservation_id=reservation.id
where reservation.id='8a200000-0000-4000-8000-000000000010';
select public.manual_checkout_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,reservation.version,
  'TEST',(select checkout_at from future_boundary_before),
  'future-boundary-checkout',repeat('1',64)
) from public.reservations reservation
where reservation.id='8a200000-0000-4000-8000-000000000010';
select ok((select obligation.room_id=before.historical_room_id
      and target.room_id=before.historical_room_id
      and target.available_from=before.checkout_at
  from public.checkout_cleaning_obligations obligation
  join public.cleaning_targets target on target.id=obligation.current_cleaning_target_id
  cross join future_boundary_before before
  where obligation.reservation_id='8a200000-0000-4000-8000-000000000010'),
  'exact move-boundary checkout rebinds final cleaning to the pre-boundary source room');
select ok((select count(*)=1 and bool_and(segment.retired_at is not null
      and segment.terminal_reason_code='FUTURE_MOVE_INVALIDATED')
  from private.stay_room_segments segment cross join future_boundary_before before
  where segment.stay_id=before.stay_id and segment.room_id=before.future_room_id
  group by before.stay_id),
  'exact move-boundary checkout retires the zero-length unrealized target segment');
select is((select count(*) from public.room_occupancy_events event
  cross join future_boundary_before before
  where event.reservation_id='8a200000-0000-4000-8000-000000000010'
    and event.event_type='manual_checkout' and event.room_id=before.historical_room_id),
  1::bigint,'exact move-boundary checkout records occupancy on the source room');

-- Segment checkout rollover keeps the private obligation and target schedule
-- in one deferred-contract revision.
select pg_temp.seed_future_moved_reservation(
  '8a200000-0000-4000-8000-000000000011','454','455','segment-rollover',repeat('2',64));
update private.stay_segment_checkout_obligations obligation
set effective_service_date=((clock_timestamp() at time zone 'Asia/Seoul')::date-1),
    available_from=clock_timestamp()-interval '2 days',
    due_at=clock_timestamp()-interval '1 day',version=version+1
from public.cleaning_targets target
where target.id=obligation.cleaning_target_id
  and target.reservation_id='8a200000-0000-4000-8000-000000000011';
update public.cleaning_targets target
set effective_service_date=((clock_timestamp() at time zone 'Asia/Seoul')::date-1),
    available_from=clock_timestamp()-interval '2 days',
    due_at=clock_timestamp()-interval '1 day',updated_at=clock_timestamp()
where target.reservation_id='8a200000-0000-4000-8000-000000000011'
  and target.source='stay_room_move_checkout';
select private.rollover_cleaning_target_at(
  '8a100000-0000-4000-8000-000000000001',target.id,clock_timestamp(),
  null,target.assignment_version,target.effective_service_date
) from public.cleaning_targets target
where target.reservation_id='8a200000-0000-4000-8000-000000000011'
  and target.source='stay_room_move_checkout';
select ok((select obligation.effective_service_date=target.effective_service_date
      and obligation.available_from=target.available_from
      and obligation.due_at is not distinct from target.due_at
      and obligation.version>1 and target.assignment_version>1
  from private.stay_segment_checkout_obligations obligation
  join public.cleaning_targets target on target.id=obligation.cleaning_target_id
  where target.reservation_id='8a200000-0000-4000-8000-000000000011'),
  'segment checkout rollover advances target and obligation in the same revision');
select ok((select count(*)=2
  from public.cleaning_target_schedule_revisions revision
  join public.cleaning_targets target on target.id=revision.cleaning_target_id
  where target.reservation_id='8a200000-0000-4000-8000-000000000011'
    and target.source='stay_room_move_checkout'),
  'segment checkout rollover appends exactly one schedule revision');

-- Once the segment checkout follows the normal submission/approval/earning
-- lifecycle it is original-cleaning complaint provenance, not compensation.
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,service_date,sequence_number,revision,
  is_current,notified_at,changed_by
)
select '8af00000-0000-4000-8000-000000000001',target.id,
  '8a100000-0000-4000-8000-000000000003',target.effective_service_date,101,
  target.assignment_version,true,clock_timestamp()-interval '2 hours',
  '8a100000-0000-4000-8000-000000000001'
from public.cleaning_targets target
where target.reservation_id='8a200000-0000-4000-8000-000000000011'
  and target.source='stay_room_move_checkout';
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,started_at,field_completed_at,ended_at,template_snapshot,room_snapshot
)
select '8af00000-0000-4000-8000-000000000002',target.id,assignment.id,
  assignment.maid_profile_id,1,'approved',assignment.revision,
  clock_timestamp()-interval '90 minutes',clock_timestamp()-interval '30 minutes',
  clock_timestamp()-interval '20 minutes',target.template_snapshot,
  target.room_type_snapshot||jsonb_build_object('roomId',target.room_id)
from public.cleaning_targets target
join public.cleaning_assignments assignment on assignment.cleaning_target_id=target.id and assignment.is_current
where target.reservation_id='8a200000-0000-4000-8000-000000000011'
  and target.source='stay_room_move_checkout';
insert into public.cleaning_submissions(
  id,cleaning_attempt_id,client_submission_id,version,status,photo_manifest,submitted_by,submitted_at
) values(
  '8af00000-0000-4000-8000-000000000003','8af00000-0000-4000-8000-000000000002',
  '8af00000-0000-4000-8000-000000000004',1,'approved','{}',
  '8a100000-0000-4000-8000-000000000003',clock_timestamp()-interval '10 minutes'
);
insert into public.inspection_decisions(
  id,submission_id,decision,reason_code,decided_by,decided_at
) values(
  '8af00000-0000-4000-8000-000000000005','8af00000-0000-4000-8000-000000000003',
  'approved','QUALITY_OK','8a100000-0000-4000-8000-000000000001',clock_timestamp()-interval '5 minutes'
);
insert into public.earnings(
  id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus
) values(
  '8af00000-0000-4000-8000-000000000006','8af00000-0000-4000-8000-000000000003',
  '8af00000-0000-4000-8000-000000000003','8a100000-0000-4000-8000-000000000003',
  (clock_timestamp() at time zone 'Asia/Seoul')::date,15000,0
);
update public.cleaning_targets
set status='approved',updated_at=clock_timestamp()
where reservation_id='8a200000-0000-4000-8000-000000000011'
  and source='stay_room_move_checkout';
update private.stay_segment_checkout_obligations
set status='completed',completion_submission_id='8af00000-0000-4000-8000-000000000003',
  completed_at=clock_timestamp(),version=version+1
where cleaning_target_id=(select id from public.cleaning_targets
  where reservation_id='8a200000-0000-4000-8000-000000000011'
    and source='stay_room_move_checkout');
select is((public.create_complaint_case(
  '8a100000-0000-4000-8000-000000000001','8af00000-0000-4000-8000-000000000006',
  'cleanliness_general',0,'segment-checkout-complaint',repeat('3',64)
)->>'status'),'received',
  'approved segment checkout earning is accepted as exact original-cleaning complaint provenance');

-- A final target that has entered assignment workflow is not silently rebound.
select pg_temp.seed_future_moved_reservation(
  '8a200000-0000-4000-8000-000000000005','332','350','future-final-assigned',repeat('b',64));
update public.cleaning_targets target set status='draft_assigned'
from public.checkout_cleaning_obligations obligation
where obligation.reservation_id='8a200000-0000-4000-8000-000000000005'
  and target.id=obligation.planned_cleaning_target_id;
insert into public.cleaning_assignments(
  cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,
  changed_by,service_date,available_from_snapshot,due_at_snapshot
)
select target.id,'8a100000-0000-4000-8000-000000000003',91,
  target.assignment_version,true,clock_timestamp(),
  '8a100000-0000-4000-8000-000000000001',target.effective_service_date,
  target.available_from,target.due_at
from public.checkout_cleaning_obligations obligation
join public.cleaning_targets target on target.id=obligation.planned_cleaning_target_id
where obligation.reservation_id='8a200000-0000-4000-8000-000000000005';
create temporary table future_final_before as
select reservation.version reservation_version,reservation.room_id,stay.id stay_id,
  clock_timestamp()+interval '30 minutes' checkout_at,
  obligation.room_id obligation_room_id,obligation.version obligation_version,
  target.id target_id,target.assignment_version,
  (select count(*) from private.stay_room_segments segment where segment.stay_id=stay.id) segment_count
from public.reservations reservation join private.reservation_stays stay
  on stay.reservation_id=reservation.id
join public.checkout_cleaning_obligations obligation on obligation.reservation_id=reservation.id
join public.cleaning_targets target on target.id=obligation.planned_cleaning_target_id
where reservation.id='8a200000-0000-4000-8000-000000000005';
select throws_ok(format(
  'select public.manual_checkout_reservation(%L,%L,%s,%L,%L,%L,%L)',
  '8a100000-0000-4000-8000-000000000001','8a200000-0000-4000-8000-000000000005',
  (select reservation_version from future_final_before),'TEST',
  (select checkout_at from future_final_before),'future-final-assigned-checkout',repeat('c',64)),
  '23514','CLEANING_WORKFLOW_REPLAN_REQUIRED',
  'assigned final checkout target blocks implicit early-checkout rebinding');
select ok((select reservation.status='active' and reservation.room_id=before.room_id
  from public.reservations reservation cross join future_final_before before
  where reservation.id='8a200000-0000-4000-8000-000000000005')
  and (select count(*) from private.stay_room_segments segment
    where segment.stay_id=(select stay_id from future_final_before))
      =(select segment_count from future_final_before),
  'failed final-target rebind rolls back reservation and segment changes');
select ok((select obligation.room_id=before.obligation_room_id
      and obligation.version=before.obligation_version
      and target.assignment_version=before.assignment_version
  from public.checkout_cleaning_obligations obligation
  join public.cleaning_targets target on target.id=obligation.planned_cleaning_target_id
  cross join future_final_before before
  where obligation.reservation_id='8a200000-0000-4000-8000-000000000005')
  and not exists(select 1 from private.command_executions
    where idempotency_key='future-final-assigned-checkout'),
  'failed final-target rebind leaves workflow state and receipt absent');

-- Notified source cleanup is reversible before the move: scheduled work and
-- unrevealed access are closed exactly once with the cancellation.
select pg_temp.seed_future_moved_reservation(
  '8a200000-0000-4000-8000-000000000006','352','358','future-source-assigned',repeat('d',64));
select pg_temp.install_room_pin_fixture(
  (select id from public.rooms where room_number='352'),
  '8a100000-0000-4000-8000-000000000001',1
);
insert into public.room_pin_sync_events(
  room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
) values(
  (select id from public.rooms where room_number='352'),'verified',1,'TEST',
  '8a100000-0000-4000-8000-000000000001',clock_timestamp()
);
update public.cleaning_targets target set status='notified'
from private.stay_segment_checkout_obligations obligation
join private.reservation_stays stay on stay.id=obligation.stay_id
where stay.reservation_id='8a200000-0000-4000-8000-000000000006'
  and target.id=obligation.cleaning_target_id;
insert into public.cleaning_assignments(
  id,cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,
  changed_by,service_date,available_from_snapshot,due_at_snapshot
)
select '8a500000-0000-4000-8000-000000000001',target.id,
  '8a100000-0000-4000-8000-000000000003',90,target.assignment_version,true,
  clock_timestamp(),'8a100000-0000-4000-8000-000000000001',
  target.effective_service_date,target.available_from,target.due_at
from private.stay_segment_checkout_obligations obligation
join private.reservation_stays stay on stay.id=obligation.stay_id
join public.cleaning_targets target on target.id=obligation.cleaning_target_id
where stay.reservation_id='8a200000-0000-4000-8000-000000000006';
insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
  assignment_revision,template_snapshot,room_snapshot
)
select '8a600000-0000-4000-8000-000000000001',assignment.cleaning_target_id,
  assignment.id,assignment.maid_profile_id,1,'scheduled',assignment.revision,
  target.template_snapshot,target.room_type_snapshot
from public.cleaning_assignments assignment join public.cleaning_targets target
  on target.id=assignment.cleaning_target_id
where assignment.id='8a500000-0000-4000-8000-000000000001';
insert into public.room_pin_access_leases(
  id,room_id,reservation_id,cleaning_target_id,assignment_id,attempt_id,
  pin_version,issued_to,issued_at,expires_at
)
select '8a700000-0000-4000-8000-000000000001',target.room_id,target.reservation_id,
  target.id,assignment.id,attempt.id,1,assignment.maid_profile_id,
  clock_timestamp(),clock_timestamp()+interval '2 hours'
from public.cleaning_assignments assignment
join public.cleaning_targets target on target.id=assignment.cleaning_target_id
join public.cleaning_attempts attempt on attempt.assignment_id=assignment.id
where assignment.id='8a500000-0000-4000-8000-000000000001';
select public.manual_checkout_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,reservation.version,
  'TEST',clock_timestamp()+interval '30 minutes','future-source-assigned-checkout',repeat('e',64)
) from public.reservations reservation
where reservation.id='8a200000-0000-4000-8000-000000000006';
select ok((select not is_current and change_reason_code='RESERVATION_SCHEDULE_CHANGED'
    from public.cleaning_assignments where id='8a500000-0000-4000-8000-000000000001')
  and (select status='superseded' and end_reason='RESERVATION_SCHEDULE_CHANGED'
    from public.cleaning_attempts where id='8a600000-0000-4000-8000-000000000001'),
  'future source cleanup closes assignment and supersedes scheduled attempt');
select ok((select revoked_at is not null and revoke_reason_code='RESERVATION_SCHEDULE_CHANGED'
    from public.room_pin_access_leases where id='8a700000-0000-4000-8000-000000000001')
  and (select status='cancelled' from public.cleaning_targets
    where id=(select cleaning_target_id from public.cleaning_attempts
      where id='8a600000-0000-4000-8000-000000000001')),
  'future source cleanup revokes unrevealed access and cancels the target');
select is((select count(*) from public.notifications notice
  where notice.cleaning_target_id=(select cleaning_target_id from public.cleaning_attempts
    where id='8a600000-0000-4000-8000-000000000001')
    and notice.category='cleaning_assignment_revoked'),1::bigint,
  'future source cleanup emits one revocation notification');

-- Preserve the pre-existing same-instant manual checkout contract as an
-- empty historical segment rather than silently rejecting it.
select public.create_reservation(
  '8a100000-0000-4000-8000-000000000001','8a200000-0000-4000-8000-000000000007',
  room.id,date_trunc('minute',clock_timestamp()-interval '1 day'),
  date_trunc('minute',clock_timestamp()+interval '1 day'),2,null,room.state_version,
  'zero-length-create',repeat('f',64)
) from public.rooms room where room.room_number='359';
update public.reservations
set actual_check_in_at=check_in_at
where id='8a200000-0000-4000-8000-000000000007';
select public.manual_checkout_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,reservation.version,
  'TEST',reservation.actual_check_in_at,'zero-length-checkout',repeat('0',64)
) from public.reservations reservation
where reservation.id='8a200000-0000-4000-8000-000000000007';
select ok((select status='checked_out' and actual_checkout_at=actual_check_in_at
    from public.reservations where id='8a200000-0000-4000-8000-000000000007'),
  'same-instant manual checkout remains allowed');
select ok((select segment.starts_at=segment.ends_at
  from private.reservation_stays stay join private.stay_room_segments segment
    on segment.stay_id=stay.id
  where stay.reservation_id='8a200000-0000-4000-8000-000000000007'
    and segment.retired_at is null),
  'same-instant checkout preserves an empty historical segment');
select ok((select not (preview->>'eligible')::boolean
    and preview->'rejectionReasonCodes'?'RESERVATION_NOT_ACTIVE'
    and (preview->>'sourceSegmentId')::uuid=segment.id
    and (preview->>'sourceRoomId')::uuid=segment.room_id
  from public.reservations reservation
  join private.reservation_stays stay on stay.reservation_id=reservation.id
  join private.stay_room_segments segment on segment.stay_id=stay.id
    and segment.retired_at is null
  join public.rooms source_room on source_room.id=segment.room_id
  join public.rooms target_room on target_room.room_number='410'
  cross join lateral public.preview_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    reservation.version,source_room.state_version,target_room.state_version,
    null,'GUEST_REQUEST') preview
  where reservation.id='8a200000-0000-4000-8000-000000000007'),
  'same-instant checked-out preview uses the empty historical segment and returns 200 ineligible');

select public.create_reservation(
  '8a100000-0000-4000-8000-000000000001','8a200000-0000-4000-8000-000000000008',
  source_room.id,date_trunc('minute',clock_timestamp()+interval '4 days'),
  date_trunc('minute',clock_timestamp()+interval '5 days'),2,null,source_room.state_version,
  'cancelled-history-create',repeat('1',64)
) from public.rooms source_room where source_room.room_number='415';
select public.cancel_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,reservation.version,
  'TEST','cancelled-history-cancel',repeat('2',64)
) from public.reservations reservation
where reservation.id='8a200000-0000-4000-8000-000000000008';
select ok((select not (preview->>'eligible')::boolean
    and preview->'rejectionReasonCodes'?'RESERVATION_NOT_ACTIVE'
    and (preview->>'sourceSegmentId')::uuid=segment.id
    and (preview->>'sourceRoomId')::uuid=segment.room_id
  from public.reservations reservation
  join private.reservation_stays stay on stay.reservation_id=reservation.id
  join private.stay_room_segments segment on segment.stay_id=stay.id
    and segment.retired_at is not null
  join public.rooms source_room on source_room.id=segment.room_id
  join public.rooms target_room on target_room.room_number='444'
  cross join lateral public.preview_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    reservation.version,source_room.state_version,target_room.state_version,
    null,'GUEST_REQUEST') preview
  where reservation.id='8a200000-0000-4000-8000-000000000008'),
  'cancelled preview uses the last retired historical segment and returns 200 ineligible');

select pg_temp.seed_moved_reservation(
  '8a200000-0000-4000-8000-000000000002','136','139','schedule-fixture',repeat('4',64));
select pg_temp.assign_and_notify_moved_checkout(
  '8a200000-0000-4000-8000-000000000002','schedule-fixture');
create temporary table schedule_before as
select reservation.room_id historical_room_id,reservation.version reservation_version,
  reservation.check_out_at old_check_out_at,stay.id stay_id,
  source_segment.id source_segment_id,source_segment.version source_segment_version,
  final_segment.id final_segment_id,final_segment.version final_segment_version,
  assignment.id assignment_id,
  (select count(*) from private.stay_room_segments all_segment where all_segment.stay_id=stay.id) segment_count
from public.reservations reservation
join private.reservation_stays stay on stay.reservation_id=reservation.id
join private.stay_room_segments source_segment on source_segment.stay_id=stay.id
  and source_segment.room_id=reservation.room_id and source_segment.retired_at is null
join private.stay_room_segments final_segment on final_segment.stay_id=stay.id
  and final_segment.room_id<>(reservation.room_id) and final_segment.retired_at is null
join public.checkout_cleaning_obligations obligation on obligation.reservation_id=reservation.id
join public.cleaning_assignments assignment
  on assignment.cleaning_target_id=obligation.planned_cleaning_target_id and assignment.is_current
where reservation.id='8a200000-0000-4000-8000-000000000002';
create temporary table schedule_result as
select public.change_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,
  (private.reservation_response(reservation)->>'room_id')::uuid,
  reservation.check_in_at,reservation.check_out_at+interval '1 hour',reservation.guest_count,
  'keep',null,reservation.version,'TEST','schedule-change-after-move',repeat('5',64)) value
from public.reservations reservation where reservation.id='8a200000-0000-4000-8000-000000000002';
select ok((select reservation.room_id=before.historical_room_id from public.reservations reservation
  cross join schedule_before before where reservation.id='8a200000-0000-4000-8000-000000000002'),
  'schedule change never mutates the historical reservation room');
select is((select count(*) from private.stay_room_segments where stay_id=(select stay_id from schedule_before)),
  (select segment_count from schedule_before),'schedule change creates no segment churn');
select is((select version from private.stay_room_segments where id=(select source_segment_id from schedule_before)),
  (select source_segment_version from schedule_before),'schedule change does not touch the closed source segment');
select ok((select segment.ends_at=before.old_check_out_at+interval '1 hour'
    and segment.version=before.final_segment_version+1
  from private.stay_room_segments segment cross join schedule_before before
  where segment.id=before.final_segment_id),'schedule change extends only the final segment once');
select ok((select obligation.room_id=room.id and obligation.available_from=reservation.check_out_at
    and target.room_id=obligation.room_id and target.available_from=reservation.check_out_at
  from public.reservations reservation join public.checkout_cleaning_obligations obligation
    on obligation.reservation_id=reservation.id join public.cleaning_targets target
    on target.id=obligation.planned_cleaning_target_id
  join public.rooms room on room.room_number='139'
  where reservation.id='8a200000-0000-4000-8000-000000000002'),
  'schedule change keeps final-room checkout obligation and target aligned');
select ok((select revision.room_id=target.id from public.reservation_schedule_revisions revision
  join public.rooms target on target.room_number='139'
  where revision.reservation_id='8a200000-0000-4000-8000-000000000002'
  order by revision.version desc limit 1),'schedule revision records the final segment room');
select ok((select audit.after_state->>'room_id'=target.id::text and receipt.response_payload->>'room_id'=target.id::text
  from public.audit_events audit cross join private.command_executions receipt
  join public.rooms target on target.room_number='139'
  where audit.entity_id='8a200000-0000-4000-8000-000000000002'
    and audit.event_type='reservation.changed'
    and receipt.command_type='reservation.change'
    and receipt.idempotency_key='schedule-change-after-move' limit 1),
  'schedule change audit and receipt expose the current moved room after effectiveAt');
select ok((select not assignment.is_current
    and assignment.change_reason_code='RESERVATION_SCHEDULE_CHANGED'
  from public.cleaning_assignments assignment
  where assignment.id=(select assignment_id from schedule_before)),
  'post-move schedule change closes the prior notified assignment revision');
select is((select count(*) from public.cleaning_assignments assignment
  join public.checkout_cleaning_obligations obligation
    on obligation.planned_cleaning_target_id=assignment.cleaning_target_id
  where obligation.reservation_id='8a200000-0000-4000-8000-000000000002'
    and assignment.is_current and assignment.notified_at is not null),1::bigint,
  'post-move schedule change creates exactly one current notified revision');
select is((select count(*) from public.notifications notice
  join public.checkout_cleaning_obligations obligation
    on obligation.planned_cleaning_target_id=notice.cleaning_target_id
  where obligation.reservation_id='8a200000-0000-4000-8000-000000000002'
    and notice.event_family='reservation.notified_schedule_changed'),1::bigint,
  'post-move schedule change emits one final-room schedule-change notification');
select is((select count(*) from public.cleaning_attempts attempt
  join public.cleaning_targets target on target.id=attempt.cleaning_target_id
  where target.reservation_id='8a200000-0000-4000-8000-000000000002'),0::bigint,
  'post-move schedule change does not activate an attempt before checkout');
select is((select replay->>'room_id' from (
  select public.change_reservation(
    '8a100000-0000-4000-8000-000000000001',reservation.id,
    (private.reservation_response(reservation)->>'room_id')::uuid,
    reservation.check_in_at,reservation.check_out_at,reservation.guest_count,'keep',null,
    (select reservation_version from schedule_before),'TEST','schedule-change-after-move',repeat('5',64)) replay
  from public.reservations reservation where reservation.id='8a200000-0000-4000-8000-000000000002') item),
  (select value->>'room_id' from schedule_result),
  'schedule change replay returns the original final-room result');

select pg_temp.seed_moved_reservation(
  '8a200000-0000-4000-8000-000000000003','142','211','scheduled-fixture',repeat('6',64),true);
select pg_temp.assign_and_notify_moved_checkout(
  '8a200000-0000-4000-8000-000000000003','scheduled-fixture');
create temporary table scheduled_before as
select reservation.room_id historical_room_id,reservation.check_out_at,stay.id stay_id,
  (select count(*) from private.stay_room_segments all_segment where all_segment.stay_id=stay.id) segment_count,
  final_segment.id final_segment_id,
  final_segment.version final_segment_version
from public.reservations reservation join private.reservation_stays stay
  on stay.reservation_id=reservation.id join private.stay_room_segments final_segment
  on final_segment.stay_id=stay.id and final_segment.room_id<>reservation.room_id
  and final_segment.retired_at is null
where reservation.id='8a200000-0000-4000-8000-000000000003';
select public.process_due_reservation_transitions(
  '8a100000-0000-4000-8000-000000000001',(select check_out_at+interval '1 minute' from scheduled_before),
  'scheduled-after-move',repeat('7',64));
select ok((select reservation.status='checked_out' and reservation.room_id=before.historical_room_id
  from public.reservations reservation cross join scheduled_before before
  where reservation.id='8a200000-0000-4000-8000-000000000003'),
  'scheduled checkout preserves the historical reservation room');
select is((select count(*) from private.stay_room_segments where stay_id=(select stay_id from scheduled_before)),
  (select segment_count from scheduled_before),'scheduled checkout creates no segment churn');
select ok((select segment.ends_at=before.check_out_at
    and segment.version=before.final_segment_version+1
    and segment.terminal_reason_code='RESERVATION_CHECKED_OUT'
  from private.stay_room_segments segment cross join scheduled_before before
  where segment.id=before.final_segment_id),
  'scheduled checkout preserves the exact boundary and records terminal history');
select ok((select event.room_id=target.id and audit.after_state->>'room_id'=target.id::text
  from public.room_occupancy_events event join public.audit_events audit
    on audit.entity_id=event.reservation_id and audit.event_type='reservation.scheduled_checkout'
  join public.rooms target on target.room_number='211'
  where event.reservation_id='8a200000-0000-4000-8000-000000000003'
    and event.event_type='scheduled_checkout'),'scheduled checkout event and audit use final room');
select ok((select obligation.room_id=target.id and cleaning.room_id=target.id
  from public.checkout_cleaning_obligations obligation join public.cleaning_targets cleaning
  on cleaning.id=obligation.current_cleaning_target_id join public.rooms target on target.room_number='211'
  where obligation.reservation_id='8a200000-0000-4000-8000-000000000003'),
  'scheduled checkout materializes the final-room checkout target');
select is((select replay->>'checked_out_count' from (
  select public.process_due_reservation_transitions(
    '8a100000-0000-4000-8000-000000000001',(select check_out_at+interval '1 minute' from scheduled_before),
    'scheduled-after-move',repeat('7',64)) replay) item),'1',
  'scheduled checkout replay returns the original exactly-once count');
select ok((select reservation.room_id=target.id from public.list_reservations(
  '8a100000-0000-4000-8000-000000000001',(select id from public.rooms where room_number='211')) reservation
  join public.rooms target on target.room_number='211'
  where reservation.id='8a200000-0000-4000-8000-000000000003'),
  'reservation list filters and projects the final segment room');
select ok((select reservation.room_id=target.id from public.get_reservation_detail(
  '8a100000-0000-4000-8000-000000000001','8a200000-0000-4000-8000-000000000003') reservation
  join public.rooms target on target.room_number='211'),
  'reservation detail projects the final segment room');
select pg_sleep(greatest(0,extract(epoch from (
  (select check_out_at from scheduled_before)-clock_timestamp())))+0.1);

insert into public.cleaning_attempts(
  id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,
  assignment_revision,status,template_snapshot,room_snapshot
)
select '8a300000-0000-4000-8000-000000000001',target.id,assignment.id,
  assignment.maid_profile_id,1,assignment.revision,'scheduled',
  target.template_snapshot,target.room_type_snapshot
from public.checkout_cleaning_obligations obligation
join public.cleaning_targets target on target.id=obligation.current_cleaning_target_id
join public.cleaning_assignments assignment
  on assignment.cleaning_target_id=target.id and assignment.is_current
where obligation.reservation_id='8a200000-0000-4000-8000-000000000003';
insert into public.room_pin_access_leases(
  id,room_id,reservation_id,cleaning_target_id,assignment_id,attempt_id,
  pin_version,issued_to,issued_at,expires_at
)
select '8a400000-0000-4000-8000-000000000001',target.room_id,target.reservation_id,
  target.id,assignment.id,attempt.id,1,assignment.maid_profile_id,
  now(),reservation.check_out_at+interval '2 hours'
from public.checkout_cleaning_obligations obligation
join public.reservations reservation on reservation.id=obligation.reservation_id
join public.cleaning_targets target on target.id=obligation.current_cleaning_target_id
join public.cleaning_assignments assignment
  on assignment.cleaning_target_id=target.id and assignment.is_current
join public.cleaning_attempts attempt
  on attempt.cleaning_target_id=target.id and attempt.assignment_id=assignment.id
where obligation.reservation_id='8a200000-0000-4000-8000-000000000003';
create temporary table extension_before as
select reservation.version reservation_version,reservation.check_out_at old_check_out_at,
  reservation.room_id historical_room_id,stay.id stay_id,
  (select count(*) from private.stay_room_segments segment where segment.stay_id=stay.id) segment_count,
  obligation.current_cleaning_target_id target_id,
  assignment.id assignment_id
from public.reservations reservation
join private.reservation_stays stay on stay.reservation_id=reservation.id
join public.checkout_cleaning_obligations obligation on obligation.reservation_id=reservation.id
join public.cleaning_assignments assignment
  on assignment.cleaning_target_id=obligation.current_cleaning_target_id and assignment.is_current
where reservation.id='8a200000-0000-4000-8000-000000000003';
create temporary table extension_result as
select public.change_reservation(
  '8a100000-0000-4000-8000-000000000001',reservation.id,
  (private.reservation_response(reservation)->>'room_id')::uuid,
  reservation.check_in_at,reservation.check_out_at+interval '1 hour',reservation.guest_count,
  'keep',null,reservation.version,'TEST_EXTENSION','scheduled-extension-after-move',repeat('8',64)
) value from public.reservations reservation
where reservation.id='8a200000-0000-4000-8000-000000000003';
select ok((select reservation.room_id=before.historical_room_id
    and reservation.status='active' and reservation.actual_checkout_at is null
  from public.reservations reservation cross join extension_before before
  where reservation.id='8a200000-0000-4000-8000-000000000003'),
  'post-move scheduled-checkout extension reopens occupancy without changing historical room');
select ok((select count(*)=before.segment_count
    and bool_and(case when segment.room_id=target.id
      then segment.ends_at=before.old_check_out_at+interval '1 hour' else true end)
  from private.stay_room_segments segment cross join extension_before before
  join public.rooms target on target.room_number='211'
  where segment.stay_id=before.stay_id group by before.segment_count,before.old_check_out_at),
  'post-move extension preserves segment identities and extends only the final-room boundary');
select ok((select attempt.status='superseded' and attempt.end_reason='RESERVATION_EXTENDED'
  from public.cleaning_attempts attempt where attempt.id='8a300000-0000-4000-8000-000000000001')
  and (select not assignment.is_current and assignment.change_reason_code='RESERVATION_EXTENDED'
    from public.cleaning_assignments assignment where assignment.id=(select assignment_id from extension_before)),
  'post-move extension supersedes the scheduled attempt and closes its assignment revision');
select ok((select lease.revoked_at is not null and lease.revoke_reason_code='RESERVATION_EXTENDED'
  from public.room_pin_access_leases lease where lease.id='8a400000-0000-4000-8000-000000000001'),
  'post-move extension revokes the unrevealed final-room PIN lease');
select ok((select count(*)=1 from public.notifications notice
    where notice.cleaning_target_id=(select target_id from extension_before)
      and notice.category='cleaning_assignment_revoked')
  and (select count(*)=1 from public.room_occupancy_events event
    join public.rooms room on room.id=event.room_id and room.room_number='211'
    where event.reservation_id='8a200000-0000-4000-8000-000000000003'
      and event.event_type='occupancy_resumed'),
  'post-move extension emits the final-room revocation and occupancy-resumed evidence');
select ok((select obligation.status='private' and obligation.current_cleaning_target_id is null
      and obligation.room_id=target.room_id and target.status='unassigned'
      and target.available_from=before.old_check_out_at+interval '1 hour'
    from public.checkout_cleaning_obligations obligation
    join public.cleaning_targets target on target.id=obligation.planned_cleaning_target_id
    cross join extension_before before
    where obligation.reservation_id='8a200000-0000-4000-8000-000000000003')
  and (select public.change_reservation(
      '8a100000-0000-4000-8000-000000000001',reservation.id,
      (private.reservation_response(reservation)->>'room_id')::uuid,
      reservation.check_in_at,(select old_check_out_at+interval '1 hour' from extension_before),
      reservation.guest_count,'keep',null,(select reservation_version from extension_before),
      'TEST_EXTENSION','scheduled-extension-after-move',repeat('8',64)
    )=(select value from extension_result)
    from public.reservations reservation
    where reservation.id='8a200000-0000-4000-8000-000000000003'),
  'post-move extension realigns the final target and replays all side effects exactly once');

-- A later return to the original room is evaluated per segment, not by
-- excluding the whole stay. The source cleanup must finish before that room
-- becomes READY, and an assigned due-date change fails atomically.
select pg_temp.seed_future_moved_reservation(
  '8a200000-0000-4000-8000-000000000009','410','413','chained-return',repeat('e',64));
create temporary table chained_context as
select reservation.id reservation_id,reservation.room_id original_room_id,
  stay.id stay_id,event.effective_at first_move_at,
  event.effective_at+interval '2 hours' return_at,reservation.check_out_at,
  source_target.id source_target_id,source_target.due_at source_due_at,
  source_target.assignment_version source_assignment_version,
  source_segment.id source_segment_id,target_segment.id target_segment_id,
  (select count(*) from private.stay_room_segments item where item.stay_id=stay.id) segment_count
from public.reservations reservation
join private.reservation_stays stay on stay.reservation_id=reservation.id
join private.reservation_room_move_events event on event.reservation_id=reservation.id
  and event.mode='DURING_STAY'
join private.stay_segment_checkout_obligations source_obligation
  on source_obligation.stay_id=stay.id
join public.cleaning_targets source_target on source_target.id=source_obligation.cleaning_target_id
join private.stay_room_segments source_segment on source_segment.id=source_obligation.source_segment_id
join private.stay_room_segments target_segment on target_segment.stay_id=stay.id
  and target_segment.move_event_id=event.id
where reservation.id='8a200000-0000-4000-8000-000000000009';
select ok((select not (preview->>'eligible')::boolean
    and preview->'rejectionReasonCodes'?'TARGET_ROOM_NOT_READY'
  from chained_context context
  join public.reservations reservation on reservation.id=context.reservation_id
  join private.stay_room_segments source_segment on source_segment.id=context.target_segment_id
  join public.rooms source_room on source_room.id=source_segment.room_id
  join public.rooms target_room on target_room.id=context.original_room_id
  cross join lateral public.preview_reservation_room_move(
    '8a100000-0000-4000-8000-000000000001',reservation.id,target_room.id,
    reservation.version,source_room.state_version,target_room.state_version,
    context.return_at,'OPERATIONAL_ADJUSTMENT') preview),
  'A to B to A remains fail-closed while the first A source cleanup is incomplete');
update public.cleaning_targets target set status='notified'
from chained_context context where target.id=context.source_target_id;
insert into public.cleaning_assignments(
  cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,
  changed_by,service_date,available_from_snapshot,due_at_snapshot
)
select context.source_target_id,'8a100000-0000-4000-8000-000000000003',97,
  context.source_assignment_version,true,clock_timestamp(),
  '8a100000-0000-4000-8000-000000000001',target.effective_service_date,
  target.available_from,target.due_at
from chained_context context join public.cleaning_targets target on target.id=context.source_target_id;
select throws_ok(format($sql$
  do $inner$ begin
    update private.stay_room_segments set ends_at=%L,version=version+1,updated_at=clock_timestamp()
      where id=%L;
    insert into private.stay_room_segments(
      stay_id,room_id,starts_at,ends_at,source_reservation_id
    ) values(%L,%L,%L,%L,%L);
    perform private.refresh_checkout_due_at(%L,%L);
  end $inner$
  $sql$,context.return_at,context.target_segment_id,context.stay_id,
  context.original_room_id,context.return_at,context.check_out_at,context.reservation_id,
  context.original_room_id,'8a100000-0000-4000-8000-000000000001'),
  '23514','CLEANING_DUE_REPLAN_REQUIRED',
  'same-stay future return participates in the 30-minute due replan and notified work fails closed')
from chained_context context;
select ok((select count(*)=context.segment_count
    and (select segment.ends_at=context.check_out_at
      from private.stay_room_segments segment where segment.id=context.target_segment_id)
    and (select target.due_at is not distinct from context.source_due_at
      from public.cleaning_targets target where target.id=context.source_target_id)
  from private.stay_room_segments segment cross join chained_context context
  where segment.stay_id=context.stay_id
  group by context.segment_count,context.check_out_at,context.target_segment_id,
    context.source_target_id,context.source_due_at),
  'failed chained replan rolls back the segment boundary and source target schedule');
update public.cleaning_assignments assignment
set is_current=false,ended_at=clock_timestamp(),change_reason_code='TEST_CLEANUP_COMPLETED'
from chained_context context where assignment.cleaning_target_id=context.source_target_id
  and assignment.is_current;
update public.cleaning_targets target set status='approved'
from chained_context context where target.id=context.source_target_id;
select pg_temp.install_room_pin_fixture(
  (select original_room_id from chained_context),
  '8a100000-0000-4000-8000-000000000001',1
);
insert into public.room_pin_sync_events(
  room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at
) select original_room_id,'verified',1,'TEST',
  '8a100000-0000-4000-8000-000000000001',clock_timestamp()
from chained_context;
create temporary table chained_preview as
select public.preview_reservation_room_move(
  '8a100000-0000-4000-8000-000000000001',reservation.id,context.original_room_id,
  reservation.version,source_room.state_version,target_room.state_version,
  context.return_at,'OPERATIONAL_ADJUSTMENT') value
from chained_context context
join public.reservations reservation on reservation.id=context.reservation_id
join private.stay_room_segments source_segment on source_segment.id=context.target_segment_id
join public.rooms source_room on source_room.id=source_segment.room_id
join public.rooms target_room on target_room.id=context.original_room_id;
select ok((select (value->>'eligible')::boolean from chained_preview),
  'A to B to A becomes eligible only after the original room cleanup is terminal and READY');
create temporary table chained_result as
select public.commit_reservation_room_move(
  '8a100000-0000-4000-8000-000000000001',context.reservation_id,context.original_room_id,
  (preview.value->>'reservationVersion')::bigint,
  (preview.value->>'sourceRoomVersion')::bigint,
  (preview.value->>'targetRoomVersion')::bigint,
  (preview.value->>'evaluatedAt')::timestamptz,
  (preview.value->>'expiresAt')::timestamptz,
  (preview.value->>'effectiveAt')::timestamptz,
  preview.value->>'impactFingerprint','OPERATIONAL_ADJUSTMENT',
  'chained-return-second-move',repeat('f',64)) value
from chained_context context cross join chained_preview preview;
select ok((select reservation.room_id=context.original_room_id
    and private.reservation_final_room_id(reservation.id)=context.original_room_id
    and (select count(*) from private.stay_room_segments segment
      where segment.stay_id=context.stay_id and segment.retired_at is null)=3
    and (select count(*) from private.reservation_room_move_events event
      where event.reservation_id=reservation.id and event.mode='DURING_STAY')=2
  from public.reservations reservation cross join chained_context context
  where reservation.id=context.reservation_id),
  'completed A to B to A appends a third adjacent segment and second event without changing reservation.room_id');
select ok((select target.room_id=context.original_room_id
    and obligation.room_id=context.original_room_id
  from public.checkout_cleaning_obligations obligation
  join public.cleaning_targets target on target.id=obligation.planned_cleaning_target_id
  cross join chained_context context where obligation.reservation_id=context.reservation_id),
  'chained move keeps the final checkout obligation and planned target on the last segment room');
select throws_ok(format(
  'insert into private.stay_room_segments(stay_id,room_id,starts_at,ends_at,source_reservation_id) select stay.id,room.id,%L,%L,%L from private.reservation_stays stay cross join lateral (select id from public.rooms where id<>(select room_id from private.stay_room_segments where stay_id=stay.id limit 1) order by id limit 1) room where stay.reservation_id=%L',
  context.effective_at-interval '30 minutes',context.effective_at+interval '30 minutes',
  context.reservation_id,context.reservation_id),
  '23P01',null,'a stay cannot occupy two different rooms over the same half-open interval')
from move_context context;
select lives_ok(format(
  'insert into private.stay_room_segments(stay_id,room_id,starts_at,ends_at,source_reservation_id) select stay.id,%L,%L,%L,%L from private.reservation_stays stay where stay.reservation_id=%L',
  context.target_room_id,context.check_out_at,context.check_out_at+interval '1 minute',context.reservation_id,
  context.reservation_id),
  'adjacent half-open stay segments remain valid') from move_context context;
select throws_ok(format(
  'insert into private.reservation_room_move_events(reservation_id,stay_id,from_room_id,to_room_id,effective_at,mode,reason_code,actor_profile_id,reservation_version,source_room_version,target_room_version,command_key) select %L,stay.id,%L,%L,clock_timestamp(),''DURING_STAY'',''GUEST_REQUEST'',%L,1,1,1,''wrong-pair-event'' from private.reservation_stays stay where stay.reservation_id=%L',
  '8a200000-0000-4000-8000-000000000003',context.source_room_id,context.target_room_id,
  '8a100000-0000-4000-8000-000000000001',context.reservation_id),
  '23503',null,'move event stay and reservation provenance must match') from move_context context;
select throws_ok(format(
  'insert into private.stay_room_segments(stay_id,room_id,starts_at,ends_at,source_reservation_id) select stay.id,%L,%L,%L,%L from private.reservation_stays stay where stay.reservation_id=%L',
  context.target_room_id,context.check_out_at+interval '2 minutes',context.check_out_at+interval '3 minutes',
  '8a200000-0000-4000-8000-000000000003',context.reservation_id),
  '23503',null,'segment stay and source reservation provenance must match') from move_context context;
select throws_ok(format(
  'insert into private.stay_segment_checkout_obligations(stay_id,source_segment_id,room_id,effective_service_date,available_from,created_by) select segment.stay_id,segment.id,%L,(segment.ends_at at time zone ''Asia/Seoul'')::date,segment.ends_at,%L from private.stay_room_segments segment join private.reservation_stays stay on stay.id=segment.stay_id where stay.reservation_id=%L and segment.move_event_id is not null order by segment.starts_at limit 1',
  context.source_room_id,'8a100000-0000-4000-8000-000000000001',context.reservation_id),
  '23503',null,'segment cleanup obligation must match the exact stay, segment, and room') from move_context context;
select ok(
  not has_table_privilege('authenticated','private.reservation_stays','SELECT')
  and not has_table_privilege('authenticated','private.stay_room_segments','SELECT')
  and not has_table_privilege('authenticated','private.reservation_room_move_events','SELECT')
  and not has_table_privilege('authenticated','private.stay_segment_checkout_obligations','SELECT')
  and not has_table_privilege('authenticated','private.room_pin_access_scheduled_revocations','SELECT'),
  'authenticated Data API cannot read raw stay, move, cleanup, or PIN-cutoff ledgers');

select * from finish();
rollback;
