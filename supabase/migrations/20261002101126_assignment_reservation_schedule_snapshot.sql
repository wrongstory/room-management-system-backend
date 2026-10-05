-- #328: future captures only. No historical plan, notice or receipt is hydrated.
alter table public.cleaning_target_schedule_revisions
  add column reservation_schedule_snapshot jsonb;
alter table public.cleaning_assignments
  add column notified_reservation_schedule_snapshot jsonb;

-- Existing browser table-level SELECT would expose the new internal lineage
-- JSON despite DTO stripping. Preserve all pre95 explicit-column reads and
-- existing RLS, but make these two packs app-owned RPC-only for browsers.
revoke select on public.cleaning_assignments,public.cleaning_target_schedule_revisions
  from public,anon,authenticated;
do $browser_columns$
declare relation regclass; column_list text;
begin
  foreach relation in array array['public.cleaning_assignments'::regclass,
    'public.cleaning_target_schedule_revisions'::regclass] loop
    select string_agg(format('%I',attname),',' order by attnum) into column_list
    from pg_attribute where attrelid=relation and attnum>0 and not attisdropped
      and attname not in('reservation_schedule_snapshot','notified_reservation_schedule_snapshot');
    if column_list is null then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_COLUMN_GRANT_INVALID';
    end if;
    execute format('grant select(%s) on %s to authenticated',column_list,relation);
  end loop;
end $browser_columns$;
revoke select(notified_reservation_schedule_snapshot) on public.cleaning_assignments
  from public,anon,authenticated;
revoke select(reservation_schedule_snapshot) on public.cleaning_target_schedule_revisions
  from public,anon,authenticated;

create function private.assignment_schedule_reason(p_reason text)
returns text language sql immutable set search_path='' as $$
  select case when p_reason=any(array[
    'INITIAL','MIGRATION_BASELINE','RESERVATION_CREATED','CHECKOUT_PLANNED',
    'MANUAL_REQUEST','MANUAL_CHECKOUT','RESERVATION_SCHEDULE_CHANGED',
    'RESERVATION_EXTENDED','NEXT_RESERVATION_CHANGED','SCHEDULE_CHANGED',
    'OPERATIONAL_CHANGE','MAID_UNAVAILABLE','SEQUENCE_CHANGED',
    'DURING_STAY_ROOM_MOVE','INSPECTION_REJECTED','COMPLAINT_REWORK_CONFIRMED',
    'ROLLED_OVER_UNASSIGNED','ROLLED_OVER_NOT_STARTED','EXTEND_CHECKOUT',
    'CONFIRM_DEPARTED','FALSE_REPORT','CHECKOUT_NOT_COMPLETED',
    'GUEST_STILL_PRESENT_EXTENDED','GUEST_DEPARTURE_CONFIRMED','REPORT_FALSE_CONFIRMED',
    'MAID_DEPARTED','MAID_INJURED','HANDOVER','MANUAL_REQUEST_CREATED'
  ]) then p_reason else 'UNKNOWN' end
$$;

-- Scheduled segment ends are not actual departure facts. This helper only
-- returns a source-room fact at/before p_at; the guest's final checkout in a
-- different room can never become a room-move cleaning's actual checkout.
create function private.assignment_departure_fact_at(
  p_target public.cleaning_targets,p_at timestamptz,p_require_event boolean default true
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actual_checkout timestamptz; actual_room_departure timestamptz;
begin
  if p_target.reservation_id is not null and p_target.source<>'stay_room_move_checkout' then
    select reservation.actual_checkout_at into actual_checkout
    from public.reservations reservation
    join private.reservation_stays stay on stay.reservation_id=reservation.id
    where reservation.id=p_target.reservation_id and reservation.status='checked_out'
      and reservation.actual_checkout_at is not null and reservation.actual_checkout_at<=p_at
      and stay.status='completed' and stay.actual_checkout_at=reservation.actual_checkout_at
      and exists(select 1 from private.stay_room_segments segment
        where segment.stay_id=stay.id and segment.source_reservation_id=reservation.id
          and segment.room_id=p_target.room_id and segment.retired_at is null
          and segment.ends_at=reservation.actual_checkout_at
          and segment.starts_at<=reservation.actual_checkout_at)
      and (not p_require_event or exists(select 1 from public.room_occupancy_events event
        where event.reservation_id=reservation.id and event.room_id=p_target.room_id
          and event.event_type in('manual_checkout','scheduled_checkout')
          and event.effective_at=reservation.actual_checkout_at));
  elsif p_target.source='stay_room_move_checkout' then
    select segment.ends_at into actual_room_departure
    from private.stay_segment_checkout_obligations obligation
    join private.reservation_stays stay on stay.id=obligation.stay_id
    join private.stay_room_segments segment on segment.id=obligation.source_segment_id
    join private.reservation_room_move_events event
      on event.stay_id=stay.id and event.reservation_id=stay.reservation_id
        and event.from_room_id=segment.room_id and event.effective_at=segment.ends_at
        and event.mode='DURING_STAY'
    where obligation.id=p_target.stay_segment_checkout_obligation_id
      and obligation.cleaning_target_id=p_target.id and obligation.room_id=p_target.room_id
      and obligation.status in('materialized','completed')
      and stay.reservation_id=p_target.reservation_id and segment.retired_at is null
      and segment.room_id=p_target.room_id and segment.ends_at<=p_at
      and segment.terminal_reason_code='DURING_STAY_ROOM_MOVED';
  end if;
  return jsonb_build_object('actualCheckoutAt',actual_checkout,
    'actualRoomDepartureAt',actual_room_departure);
end $$;

create function private.capture_cleaning_reservation_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
declare target public.cleaning_targets; source_reservation public.reservations;
  previous public.cleaning_target_schedule_revisions;
  next_reservation public.reservations; next_segment private.stay_room_segments;
  planned_room_departure timestamptz; anchor_at timestamptz;
  captured_at timestamptz:=clock_timestamp(); arrival_kind text; updated boolean:=false;
begin
  select * into strict target from public.cleaning_targets where id=new.cleaning_target_id;
  -- Reservation commands insert/change the cleaning schedule before inserting
  -- reservation_schedule_revisions. The current row is the transaction's new
  -- planned authority; MAX historical reservation revision would be stale.
  if target.reservation_id is not null then
    select * into strict source_reservation from public.reservations where id=target.reservation_id;
  end if;
  if target.source='stay_room_move_checkout' then
    select segment.ends_at into planned_room_departure
    from private.stay_segment_checkout_obligations obligation
    join private.stay_room_segments segment on segment.id=obligation.source_segment_id
    join private.reservation_stays stay on stay.id=obligation.stay_id
    where obligation.id=target.stay_segment_checkout_obligation_id
      and obligation.cleaning_target_id=target.id and obligation.room_id=target.room_id
      and segment.room_id=target.room_id and segment.source_reservation_id=target.reservation_id
      and stay.reservation_id=target.reservation_id and segment.retired_at is null;
  end if;
  -- The actual cleaning revision's explicit access boundary chooses the next
  -- room arrival. An early manual checkout preserves the original planned
  -- guest checkout but must not hide a newly legal intervening arrival.
  anchor_at:=coalesce(planned_room_departure,new.available_from,source_reservation.check_out_at);
  if anchor_at is not null then
    select segment.* into next_segment from private.stay_room_segments segment
    join public.reservations reservation on reservation.id=segment.source_reservation_id
    where segment.room_id=target.room_id and segment.retired_at is null
      and segment.starts_at>=anchor_at and reservation.status='active'
      and reservation.actual_checkout_at is null
      and (target.reservation_id is null or reservation.id<>target.reservation_id)
    order by segment.starts_at,segment.id limit 1;
    if next_segment.id is not null then
      select * into strict next_reservation from public.reservations where id=next_segment.source_reservation_id;
      arrival_kind:=case when next_segment.move_event_id is not null then 'room_move'
        when next_segment.starts_at=coalesce(next_reservation.actual_check_in_at,next_reservation.check_in_at)
          then 'check_in' else null end;
    end if;
  end if;
  select * into previous from public.cleaning_target_schedule_revisions
    where cleaning_target_id=target.id and revision<new.revision order by revision desc limit 1;
  updated:=previous.id is not null and new.reason_code=any(array[
    'RESERVATION_SCHEDULE_CHANGED','RESERVATION_EXTENDED','NEXT_RESERVATION_CHANGED',
    'MANUAL_CHECKOUT','SCHEDULE_CHANGED','OPERATIONAL_CHANGE',
    'EXTEND_CHECKOUT','CONFIRM_DEPARTED','FALSE_REPORT','CHECKOUT_NOT_COMPLETED',
    'GUEST_STILL_PRESENT_EXTENDED','GUEST_DEPARTURE_CONFIRMED','REPORT_FALSE_CONFIRMED'
  ]) and (new.effective_service_date is distinct from previous.effective_service_date
    or new.available_from is distinct from previous.available_from
    or new.due_at is distinct from previous.due_at);
  -- Caller-provided JSON is never trusted. IDs are internal binding evidence,
  -- not public projection fields; no guest name/count/phone/PIN is copied.
  new.reservation_schedule_snapshot:=jsonb_build_object(
    'capturedAt',captured_at,'scheduleRevision',new.revision,
    'scheduleReasonCode',private.assignment_schedule_reason(new.reason_code),
    'sourceReservationVersion',source_reservation.version,
    'plannedCheckoutAt',source_reservation.check_out_at,
    'actualCheckoutAt',null,'plannedRoomDepartureAt',planned_room_departure,
    'actualRoomDepartureAt',null,'nextCheckInAt',next_reservation.check_in_at,
    'nextRoomArrivalAt',next_segment.starts_at,'nextArrivalKind',arrival_kind,
    'isEarlyCheckIn',case when arrival_kind='check_in'
      then (next_reservation.check_in_at at time zone 'Asia/Seoul')::time<time '16:00' end,
    'isLateCheckout',case when target.source<>'stay_room_move_checkout'
        and source_reservation.check_out_at is not null
      then (source_reservation.check_out_at at time zone 'Asia/Seoul')::time>time '11:00' end,
    'isScheduleUpdated',updated,'sourceReservationId',source_reservation.id,'sourceRoomId',target.room_id);
  return new;
end $$;
create trigger cleaning_schedule_capture_reservation_snapshot
before insert on public.cleaning_target_schedule_revisions
for each row execute function private.capture_cleaning_reservation_schedule();

create function private.capture_assignment_reservation_schedule()
returns trigger language plpgsql security definer set search_path='' as $$
declare target public.cleaning_targets; snapshot jsonb; captured_at timestamptz:=clock_timestamp();
begin
  if tg_op='UPDATE' and old.notified_at is not null then
    if new.notified_reservation_schedule_snapshot is distinct from old.notified_reservation_schedule_snapshot then
      raise exception using errcode='23514',message='ASSIGNMENT_NOTIFICATION_SCHEDULE_IMMUTABLE';
    end if;
    return new;
  end if;
  new.notified_reservation_schedule_snapshot:=null;
  if new.notified_at is null then return new; end if;
  select * into strict target from public.cleaning_targets where id=new.cleaning_target_id;
  select schedule.reservation_schedule_snapshot into snapshot
  from public.cleaning_target_schedule_revisions schedule
  where schedule.cleaning_target_id=target.id and schedule.revision<=new.revision
    and schedule.effective_service_date=target.effective_service_date
    and schedule.available_from is not distinct from target.available_from
    and schedule.due_at is not distinct from target.due_at
    -- UPDATE drafts already own their frozen work window. Do not attach a
    -- target's newer plan to that older card. INSERT still needs the target
    -- fallback because the existing snapshot-fill trigger runs after this one.
    and (tg_op='INSERT' or (schedule.effective_service_date=new.service_date
      and schedule.available_from is not distinct from new.available_from_snapshot
      and schedule.due_at is not distinct from new.due_at_snapshot))
  order by schedule.revision desc limit 1;
  -- A legacy NULL plan remains wholly unknown even when first notified now.
  -- New actual capture may precede occupancy-event insertion in the same manual
  -- checkout transaction; the exact canonical reservation/stay/room proof is
  -- already available. Current reads additionally require committed event proof.
  if snapshot is not null then
    new.notified_reservation_schedule_snapshot:=snapshot ||
      private.assignment_departure_fact_at(target,captured_at,false);
  end if;
  return new;
end $$;
create trigger cleaning_assignments_capture_reservation_schedule
before insert or update on public.cleaning_assignments
for each row execute function private.capture_assignment_reservation_schedule();

create function private.assignment_schedule_public_snapshot(p_snapshot jsonb)
returns jsonb language sql immutable set search_path='' as $$
  select p_snapshot-array['sourceReservationId','sourceRoomId']
$$;

create function public.get_assignment_schedule_read(
  p_actor_profile_id uuid,p_session_id uuid,p_assignment_ids uuid[],p_include_current boolean,
  p_expected_actor_role text
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles; assignment public.cleaning_assignments; target public.cleaning_targets;
  snapshot jsonb; current_departure jsonb; result jsonb:='[]'::jsonb;
  evaluated_at timestamptz:=statement_timestamp(); assignment_id uuid;
begin
  select * into actor from public.profiles where id=p_actor_profile_id;
  if actor.id is null or actor.role not in('admin','maid') or actor.status<>'active' then
    raise exception using errcode='42501',message='ASSIGNMENT_ACCESS_REQUIRED';
  end if;
  -- The adapter's initial role controls which row shape it hydrates. A live
  -- role transition must reject that earlier shape rather than authorize it
  -- under different ownership rules at this final authority boundary.
  if p_expected_actor_role is null or p_expected_actor_role not in('admin','maid')
    or actor.role::text<>p_expected_actor_role then
    raise exception using errcode='42501',message='ASSIGNMENT_ACCESS_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  -- Session rows can outlive their configured timebox until Auth cleanup.
  -- Check the current statement's expiry fence, not only row existence.
  if p_session_id is null or not exists(select 1 from auth.sessions session
    where session.id=p_session_id and session.user_id=actor.auth_user_id
      and (session.not_after is null or session.not_after>evaluated_at)) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  if p_assignment_ids is null or cardinality(p_assignment_ids) not between 1 and 100
    or p_include_current is null or exists(select 1 from unnest(p_assignment_ids) item where item is null)
    or (select count(distinct item) from unnest(p_assignment_ids) item)<>cardinality(p_assignment_ids) then
    raise exception using errcode='22023',message='ASSIGNMENT_SCHEDULE_QUERY_INVALID';
  end if;
  foreach assignment_id in array p_assignment_ids loop
    select * into assignment from public.cleaning_assignments where id=assignment_id;
    if assignment.id is null or (actor.role='maid' and
      (assignment.maid_profile_id<>actor.id or assignment.notified_at is null)) then
      raise exception using errcode='42501',message='ASSIGNMENT_ACCESS_REQUIRED';
    end if;
    select * into strict target from public.cleaning_targets where id=assignment.cleaning_target_id;
    snapshot:=assignment.notified_reservation_schedule_snapshot;
    if actor.role='admin' and assignment.notified_at is null then
      select schedule.reservation_schedule_snapshot into snapshot
      from public.cleaning_target_schedule_revisions schedule
      where schedule.cleaning_target_id=assignment.cleaning_target_id and schedule.revision<=assignment.revision
        and schedule.effective_service_date=assignment.service_date
        and schedule.available_from is not distinct from assignment.available_from_snapshot
        and schedule.due_at is not distinct from assignment.due_at_snapshot
      order by schedule.revision desc limit 1;
    end if;
    current_departure:=null;
    if p_include_current and snapshot is not null and assignment.is_current and assignment.ended_at is null
      and assignment.notified_at is not null and assignment.notified_room_id_snapshot=target.room_id
      and assignment.revision=target.assignment_version
      and assignment.service_date=target.effective_service_date
      and assignment.available_from_snapshot is not distinct from target.available_from
      and assignment.due_at_snapshot is not distinct from target.due_at
      and snapshot->>'sourceRoomId'=target.room_id::text
      and snapshot->>'sourceReservationId' is not distinct from target.reservation_id::text then
      current_departure:=jsonb_build_object('evaluatedAt',evaluated_at)||
        private.assignment_departure_fact_at(target,evaluated_at,true);
    end if;
    result:=result||jsonb_build_array(jsonb_build_object('assignmentId',assignment.id,
      'scheduleSnapshot',private.assignment_schedule_public_snapshot(snapshot),'currentDeparture',current_departure));
  end loop;
  return result;
end $$;

revoke all on function private.assignment_schedule_reason(text),
  private.assignment_departure_fact_at(public.cleaning_targets,timestamptz,boolean),
  private.capture_cleaning_reservation_schedule(),private.capture_assignment_reservation_schedule(),
  private.assignment_schedule_public_snapshot(jsonb)
from public,anon,authenticated,service_role;
revoke all on function public.get_assignment_schedule_read(uuid,uuid,uuid[],boolean,text)
from public,anon,authenticated,service_role;
grant execute on function public.get_assignment_schedule_read(uuid,uuid,uuid[],boolean,text) to service_role;

-- The incident EXTEND command historically inserted its successor schedule
-- before updating the reservation. Move only that same UPDATE block earlier,
-- after old responsibility has ended. Stay synchronization does not create an
-- assignment; obligation synchronization and all event/decision/notice/receipt
-- writes retain their original order. Fail closed if the source definition drifts.
do $migration$
declare definition text; original_update text; insert_boundary text;
begin
  definition:=replace(pg_get_functiondef('public.decide_checkout_presence_incident(uuid,uuid,uuid,bigint,text,text,text,timestamptz,jsonb,text,text)'::regprocedure),E'\r\n',E'\n');
  original_update:=$source$    perform set_config('app.reservation_segment_writer_mode','schedule_change_v1',true);
    update public.reservations set check_out_at=p_new_checkout_at,status='active',actual_checkout_at=null,
      version=version+1,updated_by=p_actor_profile_id where id=r.id returning * into r;
    perform set_config('app.reservation_segment_writer_mode',coalesce(previous_segment_mode,''),true);
$source$;
  insert_boundary:=$source$  update public.cleaning_targets set effective_service_date=next_date,available_from=next_from,due_at=next_due,
$source$;
  original_update:=replace(original_update,E'\r\n',E'\n');
  insert_boundary:=replace(insert_boundary,E'\r\n',E'\n');
  if (length(definition)-length(replace(definition,original_update,'')))/length(original_update)<>1
    or (length(definition)-length(replace(definition,insert_boundary,'')))/length(insert_boundary)<>1 then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INCIDENT_SOURCE_DRIFT';
  end if;
  definition:=replace(definition,original_update,'');
  definition:=replace(definition,insert_boundary,
    E'  if p_decision=''EXTEND_CHECKOUT'' then\n'||original_update||E'  end if;\n'||insert_boundary);
  execute definition;
end $migration$;
