-- Issue #200: long-stay and open-ended reservation contracts.
-- Existing reservations remain standard. A NULL checkout is an unbounded
-- scheduled stay, not an inferred duration and not a checkout obligation.

create type public.reservation_type as enum ('standard', 'long_stay');

alter table public.reservations
  add column reservation_type public.reservation_type not null default 'standard',
  alter column check_out_at drop not null,
  alter column checkout_obligation_id drop not null;

alter table public.reservation_schedule_revisions
  add column reservation_type public.reservation_type not null default 'standard',
  alter column check_out_at drop not null;

alter table private.reservation_stays
  add column reservation_type public.reservation_type not null default 'standard',
  alter column scheduled_check_out_at drop not null;

alter table private.stay_room_segments alter column ends_at drop not null;

alter table public.reservations
  add constraint reservations_type_schedule_shape_check check (
    (reservation_type = 'standard' and check_out_at is not null)
    or reservation_type = 'long_stay'
  );

alter table public.reservation_schedule_revisions
  add constraint reservation_schedule_revisions_type_shape_check check (
    (reservation_type = 'standard' and check_out_at is not null)
    or reservation_type = 'long_stay'
  );

alter table private.reservation_stays
  add constraint reservation_stays_type_shape_check check (
    (reservation_type = 'standard' and scheduled_check_out_at is not null)
    or reservation_type = 'long_stay'
  );

create function private.guard_reservation_type_and_end()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    if new.reservation_type is distinct from old.reservation_type then
      raise exception using errcode = '23514', message = 'RESERVATION_TYPE_IMMUTABLE';
    end if;
    if old.check_out_at is not null and new.check_out_at is null then
      raise exception using errcode = '23514', message = 'RESERVATION_END_IMMUTABLE';
    end if;
  end if;
  if new.reservation_type = 'standard' and new.check_out_at is null then
    raise exception using errcode = '23514', message = 'STANDARD_RESERVATION_REQUIRES_END';
  end if;
  return new;
end
$$;
revoke all on function private.guard_reservation_type_and_end()
from public, anon, authenticated, service_role;
create trigger reservations_type_and_end_guard
before insert or update of reservation_type, check_out_at on public.reservations
for each row execute function private.guard_reservation_type_and_end();

create function private.validate_reservation_checkout_graph(p_reservation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  reservation public.reservations;
  obligation_count integer;
  target_count integer;
begin
  select * into reservation from public.reservations where id = p_reservation_id;
  if reservation.id is null then return; end if;
  select count(*)::integer into obligation_count
  from public.checkout_cleaning_obligations obligation
  where obligation.reservation_id = reservation.id;
  select count(*)::integer into target_count
  from public.cleaning_targets target
  where target.reservation_id = reservation.id
    and target.cleaning_kind = 'checkout';

  if reservation.check_out_at is null and reservation.actual_checkout_at is null then
    if reservation.reservation_type <> 'long_stay'
      or reservation.checkout_obligation_id is not null
      or obligation_count <> 0 or target_count <> 0 then
      raise exception using errcode = '23514', message = 'OPEN_ENDED_CHECKOUT_GRAPH_INVALID';
    end if;
  elsif reservation.status <> 'cancelled' or reservation.check_out_at is not null then
    if reservation.checkout_obligation_id is null or obligation_count <> 1
      or not exists (
        select 1 from public.checkout_cleaning_obligations obligation
        where obligation.id = reservation.checkout_obligation_id
          and obligation.reservation_id = reservation.id
          and obligation.planned_cleaning_target_id is not null
      ) or target_count <> 1 then
      raise exception using errcode = '23514', message = 'CHECKOUT_GRAPH_REQUIRED';
    end if;
  end if;
end
$$;
revoke all on function private.validate_reservation_checkout_graph(uuid)
from public, anon, authenticated, service_role;

create function private.validate_reservation_checkout_graph_trigger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  reservation_id uuid;
  reservation_end timestamptz;
  actual_checkout timestamptz;
begin
  if tg_table_schema = 'public' and tg_table_name = 'reservations' then
    reservation_id := new.id;
    -- The pre-existing standard reservation graph remains governed by its
    -- original constraints. This additive validator owns the long-stay shape.
    if new.reservation_type = 'standard' then
      return null;
    end if;
  elsif tg_table_schema = 'public' and tg_table_name in (
    'checkout_cleaning_obligations', 'cleaning_targets'
  ) then
    reservation_id := new.reservation_id;
  else
    raise exception using errcode = '23514', message = 'CHECKOUT_GRAPH_TRIGGER_SCOPE_INVALID';
  end if;
  if tg_table_name <> 'reservations' then
    select check_out_at, actual_checkout_at
      into reservation_end, actual_checkout
    from public.reservations where id = reservation_id;
    -- Existing bounded reservations already have their graph protected by the
    -- older provenance/immutability constraints. Child triggers here exist to
    -- stop a graph from being attached to an open-ended stay; the reservation
    -- trigger remains the authoritative null -> fixed commit validator.
    if reservation_end is not null or actual_checkout is not null then
      return null;
    end if;
  end if;
  perform private.validate_reservation_checkout_graph(reservation_id);
  return null;
end
$$;
revoke all on function private.validate_reservation_checkout_graph_trigger()
from public, anon, authenticated, service_role;
create constraint trigger reservations_checkout_graph_validate
after insert or update on public.reservations deferrable initially deferred
for each row execute function private.validate_reservation_checkout_graph_trigger();
create constraint trigger checkout_obligations_reservation_graph_validate
after insert or update on public.checkout_cleaning_obligations deferrable initially deferred
for each row execute function private.validate_reservation_checkout_graph_trigger();
create constraint trigger cleaning_targets_reservation_graph_validate
after insert or update on public.cleaning_targets deferrable initially deferred
for each row when (new.reservation_id is not null and new.cleaning_kind = 'checkout')
execute function private.validate_reservation_checkout_graph_trigger();

create or replace function private.guard_stay_segment_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'STAY_SEGMENT_HISTORY_IMMUTABLE';
  end if;
  if new.id <> old.id or new.stay_id <> old.stay_id or new.room_id <> old.room_id
    or new.starts_at <> old.starts_at or new.source_reservation_id <> old.source_reservation_id
    or new.move_event_id is distinct from old.move_event_id
    or new.created_at <> old.created_at
    or (((old.ends_at is not null and new.ends_at is null)
          or (old.ends_at is not null and new.ends_at is not null and new.ends_at > old.ends_at))
      and coalesce(current_setting('app.reservation_segment_writer_mode',true),'')
        not in ('schedule_change_v1','stay_ledger_sync_v1'))
    or old.retired_at is not null and new.retired_at is distinct from old.retired_at
    or new.version <> old.version + 1 then
    raise exception using errcode = '55000', message = 'STAY_SEGMENT_HISTORY_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function private.guard_stay_segment_history()
from public, anon, authenticated, service_role;

create or replace function private.stay_segment_at(p_reservation_id uuid, p_at timestamptz)
returns private.stay_room_segments
language sql stable security definer set search_path = '' as $$
  select segment.*
  from private.reservation_stays stay
  join private.stay_room_segments segment on segment.stay_id = stay.id
  where stay.reservation_id = p_reservation_id
    and segment.retired_at is null
    and segment.starts_at <= p_at
    and (segment.ends_at is null or segment.ends_at > p_at)
  order by segment.starts_at desc, segment.id desc
  limit 1
$$;
revoke all on function private.stay_segment_at(uuid, timestamptz)
from public, anon, authenticated, service_role;

create or replace function private.room_reservation_phase_at(p_room_id uuid,p_at timestamptz)
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=p_room_id and segment.retired_at is null
        and stay.status in('scheduled','active') and segment.starts_at<=p_at
        and (segment.ends_at is null or segment.ends_at>p_at)
    ) then 'current'
    when exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=p_room_id and segment.retired_at is null
        and stay.status in('scheduled','active') and segment.starts_at>p_at
    ) then 'upcoming' else 'none' end
$$;
revoke all on function private.room_reservation_phase_at(uuid,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.room_reservation_lifecycle_at(p_room_id uuid,p_at timestamptz)
returns table(reservation_lifecycle text,next_reservation_id uuid,next_check_in_at timestamptz,
  next_check_out_at timestamptz,current_checkin_pending boolean)
language plpgsql stable security definer set search_path='' as $$
declare v_current boolean; v_next record;
  v_today date:=(p_at at time zone 'Asia/Seoul')::date;
begin
  select exists(select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    join public.reservations reservation on reservation.id=stay.reservation_id
    where segment.room_id=p_room_id and segment.retired_at is null and (
      (stay.status in('scheduled','active') and segment.starts_at<=p_at
        and (segment.ends_at is null or segment.ends_at>p_at))
      or (stay.status='active' and reservation.actual_check_in_at is not null
        and reservation.actual_checkout_at is null
        and segment.room_id=private.reservation_final_room_id(reservation.id)
        and segment.starts_at<=p_at))) into v_current;
  select reservation.id,segment.starts_at as segment_start,segment.ends_at as segment_end into v_next
  from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id=segment.stay_id
  join public.reservations reservation on reservation.id=stay.reservation_id
  where segment.room_id=p_room_id and segment.retired_at is null
    and stay.status in('scheduled','active') and reservation.status='active'
    and reservation.actual_checkout_at is null and segment.starts_at>p_at
  order by segment.starts_at,reservation.id limit 1;
  reservation_lifecycle:=case when v_current then 'OCCUPIED' when v_next.id is null then 'NONE'
    when (v_next.segment_start at time zone 'Asia/Seoul')::date=v_today then 'ARRIVAL_PENDING'
    when (v_next.segment_start at time zone 'Asia/Seoul')::date=v_today+1 then 'RESERVATION_PRESENT'
    else 'FUTURE' end;
  next_reservation_id:=v_next.id; next_check_in_at:=v_next.segment_start;
  next_check_out_at:=v_next.segment_end;
  current_checkin_pending:=exists(select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    join public.reservations reservation on reservation.id=stay.reservation_id
    where segment.room_id=p_room_id and segment.retired_at is null and reservation.status='active'
      and reservation.actual_check_in_at is null and segment.starts_at<=p_at
      and (segment.ends_at is null or segment.ends_at>p_at));
  return next;
end
$$;
revoke all on function private.room_reservation_lifecycle_at(uuid,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.reservation_projected_room_id(
  p_reservation public.reservations,p_at timestamptz
) returns uuid language sql stable security definer set search_path='' as $$
  select coalesce(
    (select segment.room_id from private.reservation_stays stay
      join private.stay_room_segments segment on segment.stay_id=stay.id
      where stay.reservation_id=p_reservation.id and segment.retired_at is null
        and segment.starts_at<=p_at and (segment.ends_at is null or segment.ends_at>p_at)
      order by segment.starts_at desc,segment.id desc limit 1),
    case when p_reservation.status='checked_out' or p_reservation.actual_checkout_at is not null
        or (p_reservation.actual_check_in_at is not null and p_reservation.actual_checkout_at is null)
      then private.reservation_final_room_id(p_reservation.id) end,
    p_reservation.room_id)
$$;
revoke all on function private.reservation_projected_room_id(public.reservations,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.reservation_response(p_reservation public.reservations)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object(
    'id',p_reservation.id,
    'room_id',private.reservation_projected_room_id(p_reservation,clock_timestamp()),
    'reservation_type',p_reservation.reservation_type,
    'check_in_at',p_reservation.check_in_at,'check_out_at',p_reservation.check_out_at,
    'guest_count',p_reservation.guest_count,'status',p_reservation.status,
    'preparation_obligation_id',p_reservation.preparation_obligation_id,
    'checkout_obligation_id',p_reservation.checkout_obligation_id,
    'version',p_reservation.version,'actual_check_in_at',p_reservation.actual_check_in_at,
    'actual_checkout_at',p_reservation.actual_checkout_at,'cancelled_at',p_reservation.cancelled_at,
    'created_at',p_reservation.created_at,'updated_at',p_reservation.updated_at)
$$;
revoke all on function private.reservation_response(public.reservations)
from public,anon,authenticated,service_role;

create or replace function private.sync_reservation_stay_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  stay private.reservation_stays;
  segment private.stay_room_segments;
  previous_segment_writer_mode text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      insert into private.reservation_stays (
        reservation_id,status,reservation_type,scheduled_check_in_at,scheduled_check_out_at,
        actual_check_in_at,version,created_at,updated_at
      ) values (
        new.id,case when new.actual_check_in_at is null then 'scheduled' else 'active' end,
        new.reservation_type,new.check_in_at,new.check_out_at,new.actual_check_in_at,
        new.version,new.created_at,new.updated_at
      ) returning * into stay;
      insert into private.stay_room_segments (
        stay_id,room_id,starts_at,ends_at,source_reservation_id,created_at,updated_at
      ) values (
        stay.id,new.room_id,coalesce(new.actual_check_in_at,new.check_in_at),new.check_out_at,
        new.id,new.created_at,new.updated_at
      );
    end if;
    return new;
  end if;

  select * into stay from private.reservation_stays where reservation_id = new.id for update;
  if stay.id is null then return new; end if;
  previous_segment_writer_mode:=coalesce(
    current_setting('app.reservation_segment_writer_mode',true),'');
  perform set_config('app.reservation_segment_writer_mode','stay_ledger_sync_v1',true);

  if new.room_id is distinct from old.room_id then
    if coalesce(current_setting('app.reservation_room_move_writer_mode', true), '') <> 'before_checkin_v1'
      or old.actual_check_in_at is not null then
      raise exception using errcode='23514',message='RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED';
    end if;
    select * into segment from private.stay_room_segments
    where stay_id=stay.id and starts_at=old.check_in_at and room_id=old.room_id
    order by id desc limit 1 for update;
    if segment.id is null then
      raise exception using errcode='23514',message='STAY_SEGMENT_CONTRACT_MISMATCH';
    end if;
    update private.stay_room_segments set retired_at = clock_timestamp(),
      terminal_reason_code='BEFORE_CHECKIN_ROOM_CHANGED',version=version+1,updated_at=clock_timestamp()
    where id=segment.id;
    insert into private.stay_room_segments (
      stay_id,room_id,starts_at,ends_at,source_reservation_id,terminal_reason_code
    ) values (stay.id,new.room_id,new.check_in_at,new.check_out_at,new.id,null);
  elsif old.actual_check_in_at is not null and new.actual_check_in_at is not null
    and new.actual_check_in_at is distinct from old.actual_check_in_at then
    select * into segment from private.stay_room_segments
    where stay_id=stay.id and retired_at is null and room_id=old.room_id
      and starts_at=old.actual_check_in_at
    order by id desc limit 1 for update;
    if segment.id is null then
      raise exception using errcode='23514',message='STAY_SEGMENT_CONTRACT_MISMATCH';
    end if;
    update private.stay_room_segments set retired_at=clock_timestamp(),
      terminal_reason_code='ACTUAL_CHECK_IN_CORRECTED',version=version+1,
      updated_at=clock_timestamp() where id=segment.id;
    insert into private.stay_room_segments(
      stay_id,room_id,starts_at,ends_at,source_reservation_id,created_at,updated_at
    ) values(stay.id,new.room_id,new.actual_check_in_at,new.check_out_at,new.id,
      clock_timestamp(),clock_timestamp());
  elsif old.actual_check_in_at is not null and new.actual_check_in_at is null then
    if new.status='active' then
      select * into segment from private.stay_room_segments
      where stay_id=stay.id and retired_at is null and room_id=old.room_id
      order by (starts_at=old.actual_check_in_at) desc,starts_at desc,id desc
      limit 1 for update;
      if segment.id is null then
        raise exception using errcode='23514',message='STAY_SEGMENT_CONTRACT_MISMATCH';
      end if;
      update private.stay_room_segments set retired_at=clock_timestamp(),
        terminal_reason_code='ACTUAL_CHECK_IN_REVERTED',version=version+1,
        updated_at=clock_timestamp() where id=segment.id;
      insert into private.stay_room_segments(
        stay_id,room_id,starts_at,ends_at,source_reservation_id,created_at,updated_at
      ) values(stay.id,new.room_id,new.check_in_at,new.check_out_at,new.id,
        clock_timestamp(),clock_timestamp());
    end if;
  elsif old.actual_check_in_at is null and new.actual_check_in_at is not null then
    select * into segment from private.stay_room_segments
    where stay_id=stay.id and retired_at is null
      and starts_at=old.check_in_at and room_id=old.room_id
    order by id desc limit 1 for update;
    if segment.id is not null then
      update private.stay_room_segments set retired_at=clock_timestamp(),
        terminal_reason_code='RESERVATION_CHECKED_IN',version=version+1,
        updated_at=clock_timestamp() where id=segment.id;
    end if;
    insert into private.stay_room_segments(
      stay_id,room_id,starts_at,ends_at,source_reservation_id,created_at,updated_at
    ) values(stay.id,new.room_id,new.actual_check_in_at,new.check_out_at,new.id,
      clock_timestamp(),clock_timestamp());
  elsif new.check_in_at is distinct from old.check_in_at
     or new.check_out_at is distinct from old.check_out_at then
    select * into segment from private.stay_room_segments
    where stay_id=stay.id and retired_at is null
      and (new.actual_check_in_at is null or ends_at is not distinct from old.check_out_at)
    order by ends_at desc nulls first,starts_at desc,id desc limit 1 for update;
    if segment.id is not null and new.actual_check_in_at is null
      and new.check_in_at is distinct from old.check_in_at then
      update private.stay_room_segments set retired_at=clock_timestamp(),
        terminal_reason_code='RESERVATION_SCHEDULE_CHANGED',version=version+1,
        updated_at=clock_timestamp() where id=segment.id;
      insert into private.stay_room_segments(
        stay_id,room_id,starts_at,ends_at,source_reservation_id,created_at,updated_at
      ) values(stay.id,new.room_id,new.check_in_at,new.check_out_at,new.id,
        clock_timestamp(),clock_timestamp());
    elsif segment.id is not null then
      update private.stay_room_segments set ends_at=new.check_out_at,
        version=version+1,updated_at=clock_timestamp() where id=segment.id;
    end if;
  end if;

  update private.reservation_stays set
    status=case when new.status='cancelled' then 'cancelled'
      when new.status='checked_out' then 'completed'
      when new.actual_check_in_at is not null then 'active' else 'scheduled' end,
    reservation_type=new.reservation_type,
    scheduled_check_in_at=new.check_in_at,scheduled_check_out_at=new.check_out_at,
    actual_check_in_at=new.actual_check_in_at,actual_checkout_at=new.actual_checkout_at,
    version=greatest(version+1,new.version),updated_at=clock_timestamp()
  where id=stay.id;

  if new.status in ('cancelled','checked_out') then
    select * into segment from private.stay_room_segments
    where stay_id=stay.id and retired_at is null
      and (new.status='cancelled' or (starts_at <= new.actual_checkout_at
        and (ends_at is null or ends_at >= new.actual_checkout_at)))
    order by starts_at desc,id desc limit 1 for update;
    if segment.id is not null then
      update private.stay_room_segments set
        ends_at=case when new.status='checked_out' then new.actual_checkout_at else ends_at end,
        retired_at=case when new.status='cancelled' then clock_timestamp() else retired_at end,
        terminal_reason_code=case when new.status='cancelled' then 'RESERVATION_CANCELLED'
          else 'RESERVATION_CHECKED_OUT' end,
        version=version+1,updated_at=clock_timestamp() where id=segment.id;
    end if;
  end if;
  perform set_config('app.reservation_segment_writer_mode',previous_segment_writer_mode,true);
  return new;
exception when others then
  perform set_config('app.reservation_segment_writer_mode',coalesce(previous_segment_writer_mode,''),true);
  raise;
end
$$;
revoke all on function private.sync_reservation_stay_ledger()
from public, anon, authenticated, service_role;

create function private.ensure_reservation_checkout_graph(
  p_reservation_id uuid,
  p_available_from timestamptz,
  p_actor_profile_id uuid
) returns public.checkout_cleaning_obligations
language plpgsql security definer set search_path = pg_catalog, public, private as $$
declare
  reservation public.reservations;
  obligation public.checkout_cleaning_obligations;
  obligation_id uuid := gen_random_uuid();
  operational_room_id uuid;
begin
  select * into strict reservation from public.reservations
  where id = p_reservation_id for update;
  select * into obligation from public.checkout_cleaning_obligations
  where reservation_id = reservation.id for update;
  if obligation.id is not null then
    if reservation.checkout_obligation_id is distinct from obligation.id then
      update public.reservations set checkout_obligation_id = obligation.id
      where id = reservation.id;
    end if;
    perform private.ensure_planned_checkout_target(obligation.id);
    select * into obligation from public.checkout_cleaning_obligations where id=obligation.id;
    return obligation;
  end if;
  if p_available_from is null or not isfinite(p_available_from) then
    raise exception using errcode='22023',message='INVALID_RESERVATION_SCHEDULE';
  end if;
  operational_room_id := private.reservation_current_room_at(
    reservation.id, p_available_from - interval '1 microsecond');
  if operational_room_id is null then
    operational_room_id := reservation.room_id;
  end if;
  insert into public.checkout_cleaning_obligations(
    id,reservation_id,room_id,original_service_date,effective_service_date,
    available_from,created_by
  ) values(
    obligation_id,reservation.id,operational_room_id,
    (p_available_from at time zone 'Asia/Seoul')::date,
    (p_available_from at time zone 'Asia/Seoul')::date,p_available_from,p_actor_profile_id
  ) returning * into obligation;
  update public.reservations set checkout_obligation_id=obligation.id
  where id=reservation.id;
  perform private.ensure_planned_checkout_target(obligation.id);
  select * into obligation from public.checkout_cleaning_obligations where id=obligation.id;
  return obligation;
end
$$;
revoke all on function private.ensure_reservation_checkout_graph(uuid,timestamptz,uuid)
from public,anon,authenticated,service_role;

create function public.create_reservation_v2(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_reservation_type text,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_guest_name_encrypted text,
  p_expected_room_version bigint,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb language plpgsql security definer
set search_path = pg_catalog, public, private as $$
declare
  room public.rooms;
  reservation public.reservations;
  preparation_id uuid:=gen_random_uuid();
  checkout_obligation_id uuid:=case when p_check_out_at is null then null else gen_random_uuid() end;
  assignment_reasons text[];
  response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  response:=private.replay_command(p_actor_profile_id,'reservation.create',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if p_reservation_type not in ('standard','long_stay') then
    raise exception using errcode='22023',message='UNSUPPORTED_RESERVATION_TYPE';
  end if;
  if p_reservation_type='standard' and p_check_out_at is null then
    raise exception using errcode='22023',message='STANDARD_RESERVATION_REQUIRES_END';
  end if;
  if p_check_in_at is null or not isfinite(p_check_in_at)
    or p_check_in_at<>date_trunc('minute',p_check_in_at)
    or (p_check_out_at is not null and (
      not isfinite(p_check_out_at) or p_check_out_at<>date_trunc('minute',p_check_out_at)
      or (p_check_out_at at time zone 'Asia/Seoul')::date
        <=(p_check_in_at at time zone 'Asia/Seoul')::date)) then
    raise exception using errcode='22023',message='INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_guest_count is null or p_guest_count<=0 then
    raise exception using errcode='22023',message='INVALID_GUEST_COUNT';
  end if;
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if room.state_version<>p_expected_room_version then
    raise exception using errcode='40001',message='STALE_VERSION';
  end if;
  assignment_reasons:=private.room_block_reason_codes(p_room_id,clock_timestamp(),false,false);
  if exists(select 1 from public.room_operation_blocks block
    where block.room_id=p_room_id and block.released_at is null
      and (p_check_out_at is null or block.starts_at<p_check_out_at)
      and (block.ends_at is null or block.ends_at>p_check_in_at))
    and not ('OPERATION_BLOCKED'=any(assignment_reasons)) then
    assignment_reasons:=array_append(assignment_reasons,'OPERATION_BLOCKED');
  end if;
  if cardinality(assignment_reasons)>0 then
    raise exception using errcode='23514',message='ROOM_ALLOCATION_BLOCKED',
      detail=array_to_string(assignment_reasons,',');
  end if;
  insert into public.reservations(
    id,room_id,reservation_type,check_in_at,check_out_at,guest_count,guest_name_encrypted,
    preparation_obligation_id,checkout_obligation_id,created_by,updated_by
  ) values(
    p_reservation_id,p_room_id,p_reservation_type::public.reservation_type,
    p_check_in_at,p_check_out_at,p_guest_count,p_guest_name_encrypted,
    preparation_id,checkout_obligation_id,p_actor_profile_id,p_actor_profile_id
  ) returning * into reservation;
  insert into public.preparation_obligations(id,reservation_id,room_id)
  values(preparation_id,reservation.id,reservation.room_id);
  if checkout_obligation_id is not null then
    insert into public.checkout_cleaning_obligations(
      id,reservation_id,room_id,original_service_date,effective_service_date,
      available_from,created_by
    ) values(
      checkout_obligation_id,reservation.id,reservation.room_id,
      (reservation.check_out_at at time zone 'Asia/Seoul')::date,
      (reservation.check_out_at at time zone 'Asia/Seoul')::date,
      reservation.check_out_at,p_actor_profile_id
    );
    perform private.ensure_planned_checkout_target(checkout_obligation_id);
  end if;
  insert into public.reservation_schedule_revisions(
    reservation_id,version,room_id,reservation_type,check_in_at,check_out_at,
    guest_count,reason_code,actor_profile_id,effective_at
  ) values(
    reservation.id,reservation.version,reservation.room_id,reservation.reservation_type,
    reservation.check_in_at,reservation.check_out_at,reservation.guest_count,
    'RESERVATION_CREATED',p_actor_profile_id,clock_timestamp()
  );
  update public.rooms set state_version=state_version+1 where id=reservation.room_id returning * into room;
  if reservation.check_out_at is not null then
    perform private.refresh_checkout_due_at(reservation.room_id,p_actor_profile_id);
  end if;
  perform private.invalidate_stale_preparation_proofs(reservation.room_id,'PREVIOUS_OCCUPANCY_CHANGED');
  response:=private.reservation_response(reservation)||jsonb_build_object('room_state_version',room.state_version);
  insert into public.audit_events(
    actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,after_state,request_hash,idempotency_key
  ) select profile.id,profile.display_name,'reservation.created','reservation',reservation.id,
    clock_timestamp(),'RESERVATION_CREATED',response,p_request_hash,
    private.audit_command_key(p_actor_profile_id,'reservation.create',p_idempotency_key)
  from public.profiles profile where profile.id=p_actor_profile_id;
  perform private.complete_command(p_actor_profile_id,'reservation.create',p_idempotency_key,
    p_request_hash,reservation.id,response);
  return response;
exception when exclusion_violation then
  raise exception using errcode='23P01',message='RESERVATION_OVERLAP';
end
$$;
revoke all on function public.create_reservation_v2(
  uuid,uuid,uuid,text,timestamptz,timestamptz,integer,text,bigint,text,text
) from public,anon,authenticated;
grant execute on function public.create_reservation_v2(
  uuid,uuid,uuid,text,timestamptz,timestamptz,integer,text,bigint,text,text
) to service_role;

create function private.set_reservation_schedule_revision_type()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  select reservation.reservation_type into new.reservation_type
  from public.reservations reservation where reservation.id=new.reservation_id;
  if new.reservation_type is null then
    raise exception using errcode='23503',message='RESERVATION_NOT_FOUND';
  end if;
  return new;
end
$$;
revoke all on function private.set_reservation_schedule_revision_type()
from public,anon,authenticated,service_role;
create trigger reservation_schedule_revision_type_snapshot
before insert on public.reservation_schedule_revisions
for each row execute function private.set_reservation_schedule_revision_type();

create function public.change_reservation_v2(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_reservation_type text,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_guest_name_mode text,
  p_guest_name_encrypted text,
  p_expected_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare
  reservation public.reservations;
  updated public.reservations;
  projected_room_id uuid;
  before_state jsonb;
  response jsonb;
  previous_segment_mode text;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  response:=private.replay_command(p_actor_profile_id,'reservation.change',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into reservation from public.reservations where id=p_reservation_id for update;
  if reservation.id is null then raise exception using errcode='P0002',message='RESERVATION_NOT_FOUND'; end if;
  if reservation.version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if p_reservation_type not in ('standard','long_stay')
    or reservation.reservation_type::text<>p_reservation_type then
    raise exception using errcode='23514',message='RESERVATION_TYPE_IMMUTABLE';
  end if;
  if reservation.check_out_at is not null and p_check_out_at is null then
    raise exception using errcode='23514',message='RESERVATION_END_IMMUTABLE';
  end if;
  if p_reservation_type='standard' and p_check_out_at is null then
    raise exception using errcode='22023',message='STANDARD_RESERVATION_REQUIRES_END';
  end if;

  if p_check_out_at is not null then
    if reservation.check_out_at is null then
      perform private.ensure_reservation_checkout_graph(
        reservation.id,p_check_out_at,p_actor_profile_id);
    end if;
    return public.change_reservation(
      p_actor_profile_id,p_reservation_id,p_room_id,p_check_in_at,p_check_out_at,
      p_guest_count,p_guest_name_mode,p_guest_name_encrypted,p_expected_version,
      p_reason_code,p_idempotency_key,p_request_hash);
  end if;

  if p_check_in_at is null or not isfinite(p_check_in_at)
    or p_check_in_at<>date_trunc('minute',p_check_in_at) then
    raise exception using errcode='22023',message='INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_guest_count is null or p_guest_count<=0 then
    raise exception using errcode='22023',message='INVALID_GUEST_COUNT';
  end if;
  if p_guest_name_mode not in ('keep','set','clear')
    or (p_guest_name_mode='set' and p_guest_name_encrypted is null) then
    raise exception using errcode='22023',message='INVALID_GUEST_NAME_MODE';
  end if;
  if reservation.status<>'active' then
    raise exception using errcode='23514',message='INVALID_TRANSITION';
  end if;
  if reservation.actual_check_in_at is not null and p_check_in_at<>reservation.check_in_at then
    raise exception using errcode='23514',message='OCCUPIED_RESERVATION_SCHEDULE_LOCKED';
  end if;
  projected_room_id:=private.reservation_projected_room_id(reservation,clock_timestamp());
  if projected_room_id is null or p_room_id<>projected_room_id then
    raise exception using errcode='23514',message='RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED';
  end if;
  perform 1 from public.rooms room where room.id=p_room_id for update;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if exists(select 1 from public.room_operation_blocks block
    where block.room_id=p_room_id and block.released_at is null
      and (block.ends_at is null or block.ends_at>p_check_in_at)) then
    raise exception using errcode='23514',message='ROOM_ALLOCATION_BLOCKED',detail='OPERATION_BLOCKED';
  end if;
  before_state:=private.reservation_response(reservation);
  previous_segment_mode:=coalesce(current_setting('app.reservation_segment_writer_mode',true),'');
  perform set_config('app.reservation_segment_writer_mode','schedule_change_v1',true);
  update public.reservations set
    check_in_at=p_check_in_at,guest_count=p_guest_count,
    guest_name_encrypted=case p_guest_name_mode when 'keep' then guest_name_encrypted
      when 'clear' then null else p_guest_name_encrypted end,
    version=version+1,updated_by=p_actor_profile_id
  where id=reservation.id returning * into updated;
  perform set_config('app.reservation_segment_writer_mode',previous_segment_mode,true);
  update public.preparation_obligations set
    status=case when p_check_in_at<>reservation.check_in_at then 'invalidated' else status end,
    approved_submission_id=case when p_check_in_at<>reservation.check_in_at then null else approved_submission_id end,
    invalidated_reason_code=case when p_check_in_at<>reservation.check_in_at
      then 'RESERVATION_CHECK_IN_CHANGED' else invalidated_reason_code end,
    version=version+1
  where reservation_id=reservation.id;
  insert into public.reservation_schedule_revisions(
    reservation_id,version,room_id,reservation_type,check_in_at,check_out_at,
    guest_count,reason_code,actor_profile_id,effective_at
  ) values(updated.id,updated.version,projected_room_id,updated.reservation_type,
    updated.check_in_at,null,updated.guest_count,p_reason_code,p_actor_profile_id,clock_timestamp());
  update public.rooms set state_version=state_version+1 where id=p_room_id;
  perform private.invalidate_stale_preparation_proofs(p_room_id,'RESERVATION_SCHEDULE_CHANGED');
  response:=private.reservation_response(updated);
  insert into public.audit_events(
    actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,before_state,after_state,request_hash,idempotency_key
  ) select profile.id,profile.display_name,'reservation.changed','reservation',updated.id,
    clock_timestamp(),p_reason_code,before_state,response,p_request_hash,
    private.audit_command_key(p_actor_profile_id,'reservation.change',p_idempotency_key)
  from public.profiles profile where profile.id=p_actor_profile_id;
  perform private.complete_command(p_actor_profile_id,'reservation.change',p_idempotency_key,
    p_request_hash,updated.id,response);
  return response;
exception when exclusion_violation then
  perform set_config('app.reservation_segment_writer_mode',coalesce(previous_segment_mode,''),true);
  raise exception using errcode='23P01',message='RESERVATION_OVERLAP';
when others then
  perform set_config('app.reservation_segment_writer_mode',coalesce(previous_segment_mode,''),true);
  raise;
end
$$;
revoke all on function public.change_reservation_v2(
  uuid,uuid,uuid,text,timestamptz,timestamptz,integer,text,text,bigint,text,text,text
) from public,anon,authenticated;
grant execute on function public.change_reservation_v2(
  uuid,uuid,uuid,text,timestamptz,timestamptz,integer,text,text,bigint,text,text,text
) to service_role;

create or replace function public.preview_reservation_bookability(
  p_actor_profile_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_exclude_reservation_id uuid default null,
  p_room_type_ids uuid[] default null,
  p_reservation_type text default 'standard'
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare
  evaluated_at timestamptz:=clock_timestamp();
  excluded public.reservations;
  candidates jsonb;
  room_type_ids uuid[]:=nullif(p_room_type_ids,array[]::uuid[]);
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_reservation_type not in ('standard','long_stay') then
    raise exception using errcode='22023',message='UNSUPPORTED_RESERVATION_TYPE';
  end if;
  if p_check_in_at is null or not isfinite(p_check_in_at)
    or p_check_in_at<>date_trunc('minute',p_check_in_at)
    or (p_reservation_type='standard' and p_check_out_at is null)
    or (p_check_out_at is not null and (
      not isfinite(p_check_out_at) or p_check_out_at<=p_check_in_at
      or (p_check_out_at at time zone 'Asia/Seoul')::date
        <=(p_check_in_at at time zone 'Asia/Seoul')::date
      or p_check_out_at<>date_trunc('minute',p_check_out_at))) then
    raise exception using errcode='22023',message='INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_check_out_at is not null and p_check_out_at-p_check_in_at>interval '366 days' then
    raise exception using errcode='22023',message='BOOKABILITY_RANGE_TOO_LARGE';
  end if;
  if room_type_ids is not null and cardinality(room_type_ids)>20 then
    raise exception using errcode='22023',message='INVALID_ROOM_TYPE_FILTER';
  end if;
  if room_type_ids is not null and ((select count(distinct value) from unnest(room_type_ids) value)
      <>cardinality(room_type_ids) or exists(select 1 from unnest(room_type_ids) value
        where not exists(select 1 from public.room_types room_type where room_type.id=value))) then
    raise exception using errcode='22023',message='INVALID_ROOM_TYPE_FILTER';
  end if;
  if p_exclude_reservation_id is not null then
    select * into excluded from public.reservations where id=p_exclude_reservation_id;
    if excluded.id is null then raise exception using errcode='P0002',message='EXCLUDE_RESERVATION_NOT_FOUND'; end if;
    if excluded.status<>'active' or excluded.actual_check_in_at is not null
      or excluded.actual_checkout_at is not null or excluded.cancelled_at is not null then
      raise exception using errcode='23514',message='EXCLUDE_RESERVATION_NOT_ELIGIBLE';
    end if;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'room_id',candidate.room_id,'room_number',candidate.room_number,
    'room_type_id',candidate.room_type_id,'room_state_version',candidate.room_state_version,
    'interval_bookable',candidate.interval_bookable,'check_in_ready',candidate.check_in_ready,
    'reason_codes',candidate.reason_codes,'evaluated_at',evaluated_at
  ) order by candidate.room_number,candidate.room_id),'[]'::jsonb) into candidates
  from (
    select room.id room_id,room.room_number,room.room_type_id,room.state_version room_state_version,
      not state.overlap_found and cardinality(state.interval_reasons)=0 interval_bookable,
      readiness.readiness_status='READY' check_in_ready,combined.reason_codes
    from public.rooms room
    cross join lateral (
      select exists(select 1 from private.stay_room_segments segment
        join private.reservation_stays stay on stay.id=segment.stay_id
        where segment.room_id=room.id and segment.retired_at is null
          and stay.status in ('scheduled','active')
          and segment.source_reservation_id is distinct from p_exclude_reservation_id
          and tstzrange(segment.starts_at,segment.ends_at,'[)')
            &&tstzrange(p_check_in_at,p_check_out_at,'[)')) overlap_found,
        private.room_block_reason_codes(room.id,evaluated_at,false,false)
          ||case when exists(select 1 from public.room_operation_blocks block
            where block.room_id=room.id and block.released_at is null
              and (p_check_out_at is null or block.starts_at<p_check_out_at)
              and (block.ends_at is null or block.ends_at>p_check_in_at))
            and not ('OPERATION_BLOCKED'=any(private.room_block_reason_codes(
              room.id,evaluated_at,false,false)))
          then array['OPERATION_BLOCKED']::text[] else array[]::text[] end interval_reasons,
        private.room_block_reason_codes(room.id,evaluated_at,true,true) readiness_base_reasons,
        private.current_pin_sync_status(room.id) pin_status
    ) state
    cross join lateral private.room_reservation_lifecycle_at(room.id,evaluated_at) lifecycle
    cross join lateral private.room_readiness_axes_at(
      state.readiness_base_reasons,state.pin_status,lifecycle.current_checkin_pending) readiness
    cross join lateral (
      select coalesce(array_agg(item.reason order by item.first_ordinal),array[]::text[]) reason_codes
      from (select reason,min(ordinal) first_ordinal from unnest(
        case when state.overlap_found then array['RESERVATION_OVERLAP']::text[] else array[]::text[] end
        ||state.interval_reasons||readiness.readiness_reason_codes
      ) with ordinality reasons(reason,ordinal) group by reason) item
    ) combined
    where room_type_ids is null or room.room_type_id=any(room_type_ids)
  ) candidate;
  return jsonb_build_object('evaluated_at',evaluated_at,'candidates',candidates);
end
$$;

comment on function public.preview_reservation_bookability(
  uuid,timestamptz,timestamptz,uuid,uuid[],text
) is 'Admin-only standard or long-stay interval preview. A NULL long-stay checkout is an unbounded [checkIn,infinity) request. Current readiness remains separate from interval bookability.';

create or replace function public.list_reservations_page(
  p_actor_profile_id uuid,p_from timestamptz,p_to timestamptz,p_room_id uuid default null,
  p_after_check_in_at timestamptz default null,p_after_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare server_time timestamptz:=clock_timestamp(); rows_payload jsonb; has_more boolean;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to) or p_to<=p_from then
    raise exception using errcode='22023',message='INVALID_RESERVATION_RANGE';
  end if;
  if p_to-p_from>interval '31 days' then raise exception using errcode='22023',message='RESERVATION_RANGE_TOO_LARGE'; end if;
  if p_limit is null or p_limit<1 or p_limit>50 then raise exception using errcode='22023',message='INVALID_RESERVATION_PAGE_SIZE'; end if;
  if (p_after_check_in_at is null)<>(p_after_id is null) then
    raise exception using errcode='22023',message='INVALID_RESERVATION_CURSOR';
  end if;
  with candidates as (
    select reservation reservation_row,reservation.check_in_at sort_check_in_at,reservation.id sort_id
    from public.reservations reservation
    where reservation.check_in_at<p_to
      and (reservation.check_out_at is null or reservation.check_out_at>p_from)
      and (p_room_id is null or exists(select 1 from private.stay_room_segments segment
        where segment.source_reservation_id=reservation.id and segment.room_id=p_room_id
          and tstzrange(segment.starts_at,segment.ends_at,'[)')&&tstzrange(p_from,p_to,'[)')))
      and (p_after_check_in_at is null or (reservation.check_in_at,reservation.id)>(p_after_check_in_at,p_after_id))
    order by reservation.check_in_at,reservation.id limit p_limit+1
  ), numbered as (
    select candidates.*,row_number() over(order by sort_check_in_at,sort_id) row_number from candidates
  ) select coalesce(jsonb_agg(private.reservation_response(numbered.reservation_row)
      order by numbered.sort_check_in_at,numbered.sort_id)
      filter(where numbered.row_number<=p_limit),'[]'::jsonb),
    coalesce(bool_or(numbered.row_number>p_limit),false)
  into rows_payload,has_more from numbered;
  return jsonb_build_object('server_time',server_time,'reservations',rows_payload,'has_more',has_more);
end
$$;

create or replace function private.reservation_room_move_state(
  p_reservation_id uuid,p_target_room_id uuid,p_evaluated_at timestamptz,
  p_expires_at timestamptz,p_effective_at timestamptz,p_reason_code text
) returns jsonb language plpgsql stable security definer
set search_path=pg_catalog,public,private as $$
declare
  reservation public.reservations; stay private.reservation_stays;
  source_segment private.stay_room_segments; source_room public.rooms; target_room public.rooms;
  obligation public.checkout_cleaning_obligations; target public.cleaning_targets;
  mode text; rejections text[]:=array[]::text[]; blocking text[]:=array[]::text[];
  block_reasons text[]:=array[]::text[]; overlap_found boolean:=false;
  source_outcome jsonb; target_outcome jsonb; impact jsonb; fingerprint text;
  assignment_count integer:=0; attempt_count integer:=0; pin_count integer:=0;
begin
  select * into reservation from public.reservations where id=p_reservation_id;
  if reservation.id is null then return null; end if;
  select * into stay from private.reservation_stays where reservation_id=reservation.id;
  if stay.id is null then return null; end if;
  select * into source_segment from private.reservation_room_move_source_segment(
    reservation.id,p_effective_at);
  select * into target_room from public.rooms where id=p_target_room_id;
  if target_room.id is null then return null; end if;
  if source_segment.id is not null then
    select * into source_room from public.rooms where id=source_segment.room_id;
  else select * into source_room from public.rooms where id=reservation.room_id; end if;
  if reservation.checkout_obligation_id is not null then
    select * into obligation from public.checkout_cleaning_obligations
    where id=reservation.checkout_obligation_id;
    select * into target from public.cleaning_targets where id=obligation.planned_cleaning_target_id;
  end if;
  mode:=case when reservation.status='active' and reservation.actual_check_in_at is null
    and reservation.actual_checkout_at is null and p_evaluated_at<reservation.check_in_at
    then 'BEFORE_CHECKIN' else 'DURING_STAY' end;
  if reservation.status<>'active' or reservation.actual_checkout_at is not null then
    rejections:=array_append(rejections,'RESERVATION_NOT_ACTIVE'); end if;
  if source_segment.id is null then rejections:=array_append(rejections,'ROOM_CHANGE_PREVIEW_STALE'); end if;
  if source_room.id=p_target_room_id then rejections:=array_append(rejections,'SAME_ROOM'); end if;
  if mode='BEFORE_CHECKIN' and p_effective_at<>reservation.check_in_at then
    rejections:=array_append(rejections,'INVALID_MOVE_EFFECTIVE_AT');
  elsif mode='DURING_STAY' and (reservation.check_out_at is null
    or p_effective_at<p_evaluated_at or p_effective_at>=reservation.check_out_at) then
    rejections:=array_append(rejections,case when reservation.check_out_at is null
      then 'OPEN_ENDED_STAY_REQUIRES_END' else 'INVALID_MOVE_EFFECTIVE_AT' end);
  end if;
  if reservation.check_out_at is not null then
    if obligation.status<>'private' or obligation.current_cleaning_target_id is not null
      or target.id is null or target.status<>'unassigned' then
      rejections:=array_append(rejections,'CLEANING_WORKFLOW_PUBLIC');
    end if;
  elsif mode='BEFORE_CHECKIN' and (obligation.id is not null or target.id is not null) then
    rejections:=array_append(rejections,'CLEANING_WORKFLOW_PUBLIC');
  end if;
  if target.id is not null then
    select count(*)::integer into assignment_count from public.cleaning_assignments
      where cleaning_target_id=target.id;
    select count(*)::integer into attempt_count from public.cleaning_attempts
      where cleaning_target_id=target.id;
    select count(*)::integer into pin_count from public.room_pin_access_leases lease
      where (lease.reservation_id=reservation.id or lease.cleaning_target_id=target.id)
        and lease.revoked_at is null and not exists(
          select 1 from private.room_pin_access_scheduled_revocations scheduled
          where scheduled.lease_id=lease.id and scheduled.effective_at<=p_effective_at);
  end if;
  if assignment_count>0 then rejections:=array_append(rejections,'CLEANING_WORKFLOW_ASSIGNED'); end if;
  if attempt_count>0 then rejections:=array_append(rejections,'CLEANING_WORKFLOW_STARTED'); end if;
  if mode='BEFORE_CHECKIN' and pin_count>0 then rejections:=array_append(rejections,'ACTIVE_PIN_ACCESS_EXISTS'); end if;
  block_reasons:=private.room_block_reason_codes(p_target_room_id,p_effective_at,true,true);
  select exists(select 1 from private.stay_room_segments segment
    where segment.room_id=p_target_room_id and segment.retired_at is null
      and segment.source_reservation_id<>reservation.id
      and tstzrange(segment.starts_at,segment.ends_at,'[)')&&
        tstzrange(p_effective_at,reservation.check_out_at,'[)')) into overlap_found;
  if overlap_found then rejections:=array_append(rejections,'RESERVATION_OVERLAP'); end if;
  if cardinality(block_reasons)>0 then rejections:=array_append(rejections,'TARGET_ROOM_BLOCKED'); end if;
  target_outcome:=private.reservation_room_move_outcome_at(p_target_room_id,p_effective_at);
  source_outcome:=private.reservation_room_move_outcome_at(source_room.id,p_effective_at);
  if coalesce(target_outcome->>'occupancyStatus','OCCUPIED')<>'VACANT'
    or coalesce(target_outcome->>'readinessStatus','BLOCKED')<>'READY' then
    rejections:=array_append(rejections,'TARGET_ROOM_NOT_READY'); end if;
  if rejections&&array['RESERVATION_NOT_ACTIVE','SAME_ROOM','ROOM_CHANGE_PREVIEW_STALE',
      'INVALID_MOVE_EFFECTIVE_AT','OPEN_ENDED_STAY_REQUIRES_END']::text[] then
    blocking:=array_append(blocking,'ROOM_CHANGE_PREVIEW_STALE'); end if;
  if rejections&&array['CLEANING_WORKFLOW_PUBLIC','CLEANING_WORKFLOW_ASSIGNED',
      'CLEANING_WORKFLOW_STARTED']::text[] then
    blocking:=array_append(blocking,'CLEANING_ASSIGNMENT_LOCKED'); end if;
  if 'ACTIVE_PIN_ACCESS_EXISTS'=any(rejections) then blocking:=array_append(blocking,'PIN_LEASE_ACTIVE'); end if;
  if 'RESERVATION_OVERLAP'=any(rejections) then blocking:=array_append(blocking,'TARGET_ROOM_OVERLAP'); end if;
  if 'TARGET_ROOM_BLOCKED'=any(rejections) then blocking:=array_append(blocking,'TARGET_ROOM_BLOCKED'); end if;
  if 'TARGET_ROOM_NOT_READY'=any(rejections) then blocking:=array_append(blocking,'TARGET_ROOM_NOT_READY'); end if;
  impact:=jsonb_build_object('contractVersion',3,'reservation',jsonb_build_array(
      reservation.id,reservation.version,reservation.reservation_type,reservation.check_in_at,
      reservation.check_out_at,reservation.actual_check_in_at,reservation.actual_checkout_at),
    'stay',jsonb_build_array(stay.id,stay.version,stay.status),
    'sourceSegment',jsonb_build_array(source_segment.id,source_segment.room_id,
      source_segment.starts_at,source_segment.ends_at,source_segment.version),
    'sourceRoom',jsonb_build_array(source_room.id,source_room.state_version),
    'targetRoom',jsonb_build_array(target_room.id,target_room.state_version),
    'checkout',jsonb_build_array(obligation.id,obligation.room_id,obligation.status,
      obligation.version,target.id,target.status,target.assignment_version),
    'workflowCounts',jsonb_build_array(assignment_count,attempt_count,pin_count),
    'targetBlockReasons',to_jsonb(block_reasons),'overlap',overlap_found,
    'mode',mode,'evaluatedAt',p_evaluated_at,'expiresAt',p_expires_at,
    'effectiveAt',p_effective_at,'reasonCode',p_reason_code);
  fingerprint:=encode(extensions.digest(convert_to(impact::text,'UTF8'),'sha256'),'hex');
  return jsonb_build_object('mode',mode,'eligible',cardinality(rejections)=0,
    'rejectionReasonCodes',to_jsonb(rejections),'blockingReasonCodes',to_jsonb(blocking),
    'warnings','[]'::jsonb,'targetBlockReasonCodes',to_jsonb(block_reasons),
    'sourceOutcome',source_outcome,'targetOutcome',target_outcome,'impactFingerprint',fingerprint,
    'evaluatedAt',p_evaluated_at,'expiresAt',p_expires_at,'effectiveAt',p_effective_at,
    'reservationId',reservation.id,'reservationVersion',reservation.version,
    'stayId',stay.id,'stayVersion',stay.version,'sourceSegmentId',source_segment.id,
    'sourceSegmentVersion',source_segment.version,'sourceRoomId',source_room.id,
    'sourceRoomVersion',source_room.state_version,'targetRoomId',target_room.id,
    'targetRoomVersion',target_room.state_version,'reservationType',reservation.reservation_type,
    'checkInAt',reservation.check_in_at,'checkOutAt',reservation.check_out_at,
    'guestCount',reservation.guest_count,'preparationObligationId',reservation.preparation_obligation_id,
    'checkoutObligationId',obligation.id,'checkoutObligationVersion',obligation.version,
    'plannedCheckoutTargetId',target.id,'plannedCheckoutTargetVersion',target.assignment_version);
end
$$;

alter function public.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,
  timestamptz,text,text,text,text
) rename to commit_reservation_room_move_v65;
revoke all on function public.commit_reservation_room_move_v65(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,
  timestamptz,text,text,text,text
) from public,anon,authenticated;

create function private.commit_open_ended_room_move_before_checkin(
  p_actor_profile_id uuid,p_reservation_id uuid,p_target_room_id uuid,
  p_expected_reservation_version bigint,p_expected_source_room_version bigint,
  p_expected_target_room_version bigint,p_preview_evaluated_at timestamptz,
  p_preview_expires_at timestamptz,p_effective_at timestamptz,p_impact_fingerprint text,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare
  command_at timestamptz:=clock_timestamp();
  reservation public.reservations; updated public.reservations;
  preparation public.preparation_obligations; stay private.reservation_stays;
  source_room_id uuid; source_version bigint; target_version bigint;
  state jsonb; current_state jsonb; before_state jsonb; after_state jsonb; response jsonb;
  move_event_id uuid:=gen_random_uuid(); previous_move_mode text;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  response:=private.replay_command(p_actor_profile_id,'reservation.room_move',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  if p_reason_code not in ('GUEST_REQUEST','ROOM_UNAVAILABLE','OPERATIONAL_ADJUSTMENT') then
    raise exception using errcode='22023',message='INVALID_ROOM_MOVE_REASON';
  end if;
  if p_impact_fingerprint is null or p_impact_fingerprint!~'^[0-9a-f]{64}$'
    or p_preview_evaluated_at>command_at
    or p_preview_expires_at<>p_preview_evaluated_at+interval '5 minutes' then
    raise exception using errcode='22023',message='ROOM_MOVE_PREVIEW_INVALID';
  end if;
  if p_preview_expires_at<=command_at then
    raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into reservation from public.reservations where id=p_reservation_id for update;
  if reservation.id is null then raise exception using errcode='P0002',message='RESERVATION_NOT_FOUND'; end if;
  if reservation.reservation_type<>'long_stay' or reservation.check_out_at is not null
    or reservation.actual_check_in_at is not null then
    raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE';
  end if;
  source_room_id:=reservation.room_id;
  perform 1 from public.rooms room where room.id in(source_room_id,p_target_room_id)
    order by room.id for update;
  select state_version into source_version from public.rooms where id=source_room_id;
  select state_version into target_version from public.rooms where id=p_target_room_id;
  if source_version is null or target_version is null then
    raise exception using errcode='P0002',message='ROOM_NOT_FOUND';
  end if;
  if reservation.version<>p_expected_reservation_version then
    raise exception using errcode='40001',message='RESERVATION_VERSION_CONFLICT';
  end if;
  if source_version<>p_expected_source_room_version then
    raise exception using errcode='40001',message='SOURCE_ROOM_VERSION_CONFLICT';
  end if;
  if target_version<>p_expected_target_room_version then
    raise exception using errcode='40001',message='TARGET_ROOM_VERSION_CONFLICT';
  end if;
  if p_effective_at is distinct from reservation.check_in_at then
    raise exception using errcode='22023',message='INVALID_MOVE_EFFECTIVE_AT';
  end if;
  select * into strict preparation from public.preparation_obligations
  where id=reservation.preparation_obligation_id for update;
  select * into strict stay from private.reservation_stays
  where reservation_id=reservation.id for update;
  state:=private.reservation_room_move_state(reservation.id,p_target_room_id,
    p_preview_evaluated_at,p_preview_expires_at,p_effective_at,p_reason_code);
  if state->>'impactFingerprint'<>p_impact_fingerprint then
    raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE';
  end if;
  current_state:=private.reservation_room_move_state(reservation.id,p_target_room_id,
    command_at,command_at+interval '5 minutes',p_effective_at,p_reason_code);
  if not coalesce((current_state->>'eligible')::boolean,false) then
    if (current_state->'rejectionReasonCodes')?'RESERVATION_OVERLAP' then
      raise exception using errcode='23P01',message='TARGET_ROOM_OVERLAP';
    end if;
    raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE';
  end if;
  before_state:=jsonb_build_object('mode','BEFORE_CHECKIN','reservationId',reservation.id,
    'reservationVersion',reservation.version,'sourceRoomId',source_room_id,
    'targetRoomId',p_target_room_id,'checkoutObligationId',null,
    'plannedCheckoutTargetId',null);
  previous_move_mode:=coalesce(current_setting('app.reservation_room_move_writer_mode',true),'');
  perform set_config('app.reservation_room_move_writer_mode','before_checkin_v1',true);
  update public.reservations set room_id=p_target_room_id,version=version+1,
    updated_by=p_actor_profile_id where id=reservation.id returning * into updated;
  perform set_config('app.reservation_room_move_writer_mode',previous_move_mode,true);
  update public.preparation_obligations set room_id=p_target_room_id,status='invalidated',
    approved_submission_id=null,invalidated_reason_code='RESERVATION_ROOM_CHANGED',version=version+1
  where id=preparation.id;
  insert into public.reservation_schedule_revisions(
    reservation_id,version,room_id,reservation_type,check_in_at,check_out_at,guest_count,
    reason_code,actor_profile_id,effective_at
  ) values(updated.id,updated.version,updated.room_id,updated.reservation_type,
    updated.check_in_at,null,updated.guest_count,p_reason_code,p_actor_profile_id,command_at);
  update public.rooms set state_version=state_version+1 where id in(source_room_id,p_target_room_id);
  select state_version into source_version from public.rooms where id=source_room_id;
  select state_version into target_version from public.rooms where id=p_target_room_id;
  insert into private.reservation_room_move_events(
    id,reservation_id,stay_id,from_room_id,to_room_id,effective_at,mode,reason_code,
    actor_profile_id,reservation_version,source_room_version,target_room_version,command_key
  ) values(move_event_id,updated.id,stay.id,source_room_id,p_target_room_id,p_effective_at,
    'BEFORE_CHECKIN',p_reason_code,p_actor_profile_id,updated.version,source_version,target_version,
    private.audit_command_key(p_actor_profile_id,'reservation.room_move',p_idempotency_key));
  after_state:=jsonb_build_object('mode','BEFORE_CHECKIN','reservationId',updated.id,
    'reservationVersion',updated.version,'sourceRoomId',source_room_id,'targetRoomId',p_target_room_id,
    'sourceRoomVersion',source_version,'targetRoomVersion',target_version,
    'checkoutObligationId',null,'plannedCheckoutTargetId',null,'plannedCheckoutTargetVersion',null);
  response:=jsonb_build_object('reservation',private.reservation_response(updated),
    'mode','BEFORE_CHECKIN','evaluatedAt',p_preview_evaluated_at,'expiresAt',p_preview_expires_at,
    'effectiveAt',p_effective_at,'movedAt',command_at,'sourceRoomId',source_room_id,
    'targetRoomId',p_target_room_id,'sourceRoomVersion',source_version,
    'targetRoomVersion',target_version,'plannedCheckoutTargetId',null,
    'plannedCheckoutTargetVersion',null,
    'sourceOutcome',private.reservation_room_move_outcome_at(source_room_id,command_at),
    'targetOutcome',private.reservation_room_move_outcome_at(p_target_room_id,command_at));
  insert into public.audit_events(
    actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,before_state,after_state,request_hash,idempotency_key
  ) select profile.id,profile.display_name,'reservation.room_moved','reservation',updated.id,
    command_at,p_reason_code,before_state,after_state,p_request_hash,
    private.audit_command_key(p_actor_profile_id,'reservation.room_move',p_idempotency_key)
  from public.profiles profile where profile.id=p_actor_profile_id;
  perform private.complete_command(p_actor_profile_id,'reservation.room_move',p_idempotency_key,
    p_request_hash,updated.id,response);
  return response;
exception when exclusion_violation then
  perform set_config('app.reservation_room_move_writer_mode',coalesce(previous_move_mode,''),true);
  raise exception using errcode='23P01',message='TARGET_ROOM_OVERLAP';
when others then
  perform set_config('app.reservation_room_move_writer_mode',coalesce(previous_move_mode,''),true);
  raise;
end
$$;
revoke all on function private.commit_open_ended_room_move_before_checkin(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,text,text,text,text
) from public,anon,authenticated,service_role;

create function public.commit_reservation_room_move(
  p_actor_profile_id uuid,p_reservation_id uuid,p_target_room_id uuid,
  p_expected_reservation_version bigint,p_expected_source_room_version bigint,
  p_expected_target_room_version bigint,p_preview_evaluated_at timestamptz,
  p_preview_expires_at timestamptz,p_effective_at timestamptz,p_impact_fingerprint text,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare reservation public.reservations;
begin
  select * into reservation from public.reservations where id=p_reservation_id;
  if reservation.id is null then raise exception using errcode='P0002',message='RESERVATION_NOT_FOUND'; end if;
  if reservation.reservation_type='long_stay' and reservation.check_out_at is null
    and reservation.actual_check_in_at is null then
    return private.commit_open_ended_room_move_before_checkin(
      p_actor_profile_id,p_reservation_id,p_target_room_id,p_expected_reservation_version,
      p_expected_source_room_version,p_expected_target_room_version,p_preview_evaluated_at,
      p_preview_expires_at,p_effective_at,p_impact_fingerprint,p_reason_code,
      p_idempotency_key,p_request_hash);
  end if;
  return public.commit_reservation_room_move_v65(
    p_actor_profile_id,p_reservation_id,p_target_room_id,p_expected_reservation_version,
    p_expected_source_room_version,p_expected_target_room_version,p_preview_evaluated_at,
    p_preview_expires_at,p_effective_at,p_impact_fingerprint,p_reason_code,
    p_idempotency_key,p_request_hash);
end
$$;
revoke all on function public.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,text,text,text,text
) from public,anon,authenticated;
grant execute on function public.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,timestamptz,text,text,text,text
) to service_role;

alter function public.manual_checkout_reservation(uuid,uuid,bigint,text,timestamptz,text,text)
rename to manual_checkout_reservation_v65;
revoke all on function public.manual_checkout_reservation_v65(
  uuid,uuid,bigint,text,timestamptz,text,text
) from public,anon,authenticated;

create function public.manual_checkout_reservation(
  p_actor_profile_id uuid,p_reservation_id uuid,p_expected_version bigint,
  p_reason_code text,p_effective_at timestamptz,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare reservation public.reservations; response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  response:=private.replay_command(p_actor_profile_id,'reservation.manual_checkout',
    p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into reservation from public.reservations where id=p_reservation_id for update;
  if reservation.id is null then raise exception using errcode='P0002',message='RESERVATION_NOT_FOUND'; end if;
  if reservation.version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if reservation.status<>'active' or reservation.actual_check_in_at is null
    or reservation.actual_checkout_at is not null
    or p_effective_at<reservation.actual_check_in_at
    or (reservation.check_out_at is not null and p_effective_at>=reservation.check_out_at) then
    raise exception using errcode='23514',message='MANUAL_CHECKOUT_NOT_ALLOWED';
  end if;
  if reservation.check_out_at is null then
    perform private.ensure_reservation_checkout_graph(
      reservation.id,p_effective_at,p_actor_profile_id);
  end if;
  return public.manual_checkout_reservation_v65(
    p_actor_profile_id,p_reservation_id,p_expected_version,p_reason_code,
    p_effective_at,p_idempotency_key,p_request_hash);
end
$$;
revoke all on function public.manual_checkout_reservation(uuid,uuid,bigint,text,timestamptz,text,text)
from public,anon,authenticated;
grant execute on function public.manual_checkout_reservation(uuid,uuid,bigint,text,timestamptz,text,text)
to service_role;

alter function public.process_due_reservation_transitions(uuid,timestamptz,text,text)
rename to process_due_reservation_transitions_v65;
revoke all on function public.process_due_reservation_transitions_v65(uuid,timestamptz,text,text)
from public,anon,authenticated;

create function public.process_due_reservation_transitions(
  p_actor_profile_id uuid,p_as_of timestamptz,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare
  reservation public.reservations; updated public.reservations;
  reason_codes text[]; open_checked_in integer:=0; open_blocked integer:=0;
  bounded jsonb; response jsonb;
  bounded_key text:=p_idempotency_key||':bounded-v66';
begin
  perform private.assert_room_admin(p_actor_profile_id);
  response:=private.replay_command(p_actor_profile_id,'reservation.process_due_transitions.v66',
    p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  for reservation in select item.* from public.reservations item
    where item.status='active' and item.reservation_type='long_stay'
      and item.check_out_at is null and item.actual_check_in_at is null
      and item.check_in_at<=p_as_of
    order by item.room_id,item.check_in_at,item.id for update skip locked
  loop
    perform 1 from public.rooms room where room.id=reservation.room_id for update;
    reason_codes:=private.room_block_reason_codes(
      reservation.room_id,p_as_of,true,true,reservation.id);
    if cardinality(reason_codes)>0 then open_blocked:=open_blocked+1; continue; end if;
    update public.reservations set actual_check_in_at=p_as_of,version=version+1,
      updated_by=p_actor_profile_id where id=reservation.id and status='active'
      and actual_check_in_at is null returning * into updated;
    if updated.id is null then continue; end if;
    insert into public.room_occupancy_events(
      event_key,room_id,reservation_id,event_type,effective_at,actor_profile_id,
      reason_code,before_state,after_state
    ) values(private.audit_command_key(p_actor_profile_id,
        'reservation.scheduled_check_in.'||updated.id::text,p_idempotency_key),
      updated.room_id,updated.id,'scheduled_check_in',p_as_of,p_actor_profile_id,
      'SCHEDULED_CHECK_IN_READY',jsonb_build_object('occupied',false),
      jsonb_build_object('occupied',true));
    update public.rooms set state_version=state_version+1 where id=updated.room_id;
    insert into public.audit_events(
      actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
      effective_at,reason_code,before_state,after_state,request_hash,idempotency_key
    ) select profile.id,profile.display_name,'reservation.scheduled_check_in','reservation',
      updated.id,p_as_of,'SCHEDULED_CHECK_IN_READY',private.reservation_response(reservation),
      private.reservation_response(updated),p_request_hash,
      private.audit_command_key(p_actor_profile_id,
        'reservation.scheduled_check_in.'||updated.id::text,p_idempotency_key)
    from public.profiles profile where profile.id=p_actor_profile_id;
    open_checked_in:=open_checked_in+1;
  end loop;
  bounded:=public.process_due_reservation_transitions_v65(
    p_actor_profile_id,p_as_of,bounded_key,p_request_hash);
  response:=jsonb_build_object('as_of',p_as_of,
    'checked_in_count',coalesce((bounded->>'checked_in_count')::integer,0)+open_checked_in,
    'checked_out_count',coalesce((bounded->>'checked_out_count')::integer,0),
    'blocked_check_in_count',coalesce((bounded->>'blocked_check_in_count')::integer,0)+open_blocked,
    'purged_guest_name_count',coalesce((bounded->>'purged_guest_name_count')::integer,0));
  perform private.complete_command(p_actor_profile_id,'reservation.process_due_transitions.v66',
    p_idempotency_key,p_request_hash,null,response);
  return response;
end
$$;
revoke all on function public.process_due_reservation_transitions(uuid,timestamptz,text,text)
from public,anon,authenticated;
grant execute on function public.process_due_reservation_transitions(uuid,timestamptz,text,text)
to service_role;

-- Open-ended stay segments use NULL as their authoritative infinite upper bound.
-- Preserve every existing cleaning policy while making the stayover containment
-- checks use that same meaning from request creation through physical start.
create or replace function private.activation_reason_at(
  p_target public.cleaning_targets,p_assignment public.cleaning_assignments,p_command_at timestamptz
) returns text language plpgsql stable security definer set search_path='' as $$
declare reason text;
begin
  reason:=private.activation_reason_at_before_stay_segments(p_target,p_assignment,p_command_at);
  if p_target.cleaning_kind='checkout' then
    if not (
      (p_target.source='stay_room_move_checkout' and exists(
        select 1 from private.stay_segment_checkout_obligations obligation
        where obligation.id=p_target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=p_target.id
          and obligation.room_id=p_target.room_id
          and obligation.status in('materialized','completed')
          and obligation.available_from<=p_command_at
          and p_target.available_from<=p_command_at
      )) or
      (p_target.source in('scheduled_checkout','manual_checkout') and exists(
        select 1 from public.checkout_cleaning_obligations obligation
        join public.reservations reservation on reservation.id=obligation.reservation_id
        where obligation.id=p_target.checkout_obligation_id
          and obligation.reservation_id=p_target.reservation_id
          and obligation.room_id=p_target.room_id
          and obligation.room_id=private.reservation_final_room_id(reservation.id)
          and obligation.planned_cleaning_target_id=p_target.id
          and obligation.current_cleaning_target_id=p_target.id
          and obligation.status in('materialized','completed')
          and reservation.status='checked_out'
          and reservation.actual_checkout_at<=p_command_at
          and p_target.available_from<=p_command_at
      ))
    ) then return 'CHECKOUT_NOT_MATERIALIZED'; end if;
    if reason='CHECKOUT_NOT_MATERIALIZED' then return null; end if;
    return reason;
  elsif p_target.source='stayover_request' and p_target.cleaning_kind='stayover' then
    if not exists(
      select 1 from private.reservation_stays stay
      join private.stay_room_segments segment on segment.stay_id=stay.id
      join public.reservations reservation on reservation.id=stay.reservation_id
      where reservation.id=p_target.reservation_id
        and reservation.status='active' and reservation.actual_check_in_at is not null
        and reservation.actual_checkout_at is null
        and segment.room_id=p_target.room_id and segment.retired_at is null
        and segment.starts_at<=p_target.available_from
        and p_target.due_at is not null
        and (segment.ends_at is null or segment.ends_at>=p_target.due_at)
        and p_target.available_from<p_target.due_at
    ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if reason='ATTEMPT_ACTIVATION_NOT_ALLOWED' then return null; end if;
    return reason;
  elsif p_target.source='manual_room_request' and p_target.cleaning_kind='additional' then
    if exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=p_target.room_id and segment.retired_at is null
        and stay.status in('scheduled','active')
        and tstzrange(segment.starts_at,segment.ends_at,'[)') && tstzrange(
          p_target.available_from,coalesce(p_target.due_at,
            p_target.available_from+make_interval(
              mins=>coalesce(nullif(p_target.template_snapshot->>'durationMinutes','')::integer,1)
            )), '[)')
    ) then return 'ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if reason='ATTEMPT_ACTIVATION_NOT_ALLOWED' then return null; end if;
    return reason;
  end if;
  return reason;
end
$$;
revoke all on function private.activation_reason_at(
  public.cleaning_targets,public.cleaning_assignments,timestamptz
) from public,anon,authenticated,service_role;

create or replace function private.assignment_preview_source_reason(
  p_target public.cleaning_targets,p_duration_minutes integer,p_command_at timestamptz
) returns text language plpgsql stable security definer set search_path='' as $$
begin
  if p_target.available_from is null or not isfinite(p_target.available_from)
    or (p_target.due_at is not null and
      (not isfinite(p_target.due_at) or p_target.due_at<=p_target.available_from))
    or (p_target.available_from at time zone 'Asia/Seoul')::date<>p_target.effective_service_date then
    return 'ASSIGNMENT_PREVIEW_INVALID_SCHEDULE';
  end if;
  if p_target.due_at is not null and p_target.due_at<=p_command_at then
    return 'ASSIGNMENT_WINDOW_EXPIRED';
  end if;
  if p_target.source='stay_room_move_checkout' then
    if p_target.cleaning_kind<>'checkout'
      or not exists(
        select 1 from private.stay_segment_checkout_obligations obligation
        join private.reservation_stays stay on stay.id=obligation.stay_id
        join private.stay_room_segments segment on segment.id=obligation.source_segment_id
        where obligation.id=p_target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=p_target.id
          and obligation.room_id=p_target.room_id
          and obligation.available_from=p_target.available_from
          and obligation.due_at is not distinct from p_target.due_at
          and obligation.status='materialized'
          and stay.reservation_id=p_target.reservation_id
          and segment.room_id=p_target.room_id
          and segment.ends_at=p_target.available_from
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  elsif p_target.cleaning_kind='checkout'
    and p_target.source in ('scheduled_checkout','manual_checkout') then
    if not exists(
        select 1
        from public.reservations reservation
        join public.checkout_cleaning_obligations obligation
          on obligation.reservation_id=reservation.id
        where obligation.id=p_target.checkout_obligation_id
          and reservation.id=p_target.reservation_id
          and obligation.room_id=p_target.room_id
          and p_target.room_id=private.reservation_final_room_id(reservation.id)
          and obligation.planned_cleaning_target_id=p_target.id
          and obligation.effective_service_date=p_target.effective_service_date
          and obligation.available_from is not distinct from p_target.available_from
          and obligation.due_at is not distinct from p_target.due_at
          and (
            (reservation.status='checked_out'
              and reservation.actual_checkout_at is not null
              and obligation.status='materialized'
              and obligation.current_cleaning_target_id=p_target.id)
            or (p_target.source='scheduled_checkout'
              and reservation.status='active'
              and reservation.actual_checkout_at is null
              and reservation.check_out_at=p_target.available_from
              and obligation.status='private'
              and obligation.current_cleaning_target_id is null)
          )
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  end if;
  if p_target.source='stayover_request' then
    if p_target.cleaning_kind<>'stayover' or p_target.due_at is null
      or not exists(
        select 1 from private.reservation_stays stay
        join private.stay_room_segments segment on segment.stay_id=stay.id
        join public.reservations reservation on reservation.id=stay.reservation_id
        where reservation.id=p_target.reservation_id and reservation.status='active'
          and reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
          and segment.room_id=p_target.room_id and segment.retired_at is null
          and segment.starts_at<=p_target.available_from
          and (segment.ends_at is null or segment.ends_at>=p_target.due_at)
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  end if;
  if p_target.source='manual_room_request' then
    if p_target.cleaning_kind<>'additional' then
      return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID';
    end if;
    if p_target.due_at is null and p_duration_minutes is null then
      return 'ASSIGNMENT_PREVIEW_DURATION_POLICY_UNCONFIRMED';
    end if;
    if exists(
        select 1 from private.stay_room_segments segment
        join private.reservation_stays stay on stay.id=segment.stay_id
        where segment.room_id=p_target.room_id and segment.retired_at is null
          and stay.status in('scheduled','active')
          and tstzrange(segment.starts_at,segment.ends_at,'[)') && tstzrange(
            p_target.available_from,
            coalesce(p_target.due_at,
              p_target.available_from+make_interval(mins=>p_duration_minutes)),'[)')
      ) then return 'ASSIGNMENT_PREVIEW_SOURCE_INVALID'; end if;
    return null;
  end if;
  return private.assignment_preview_source_reason_before_stay_segments(
    p_target,p_duration_minutes,p_command_at);
end
$$;
revoke all on function private.assignment_preview_source_reason(
  public.cleaning_targets,integer,timestamptz
) from public,anon,authenticated,service_role;

create or replace function public.create_manual_cleaning_request(
  p_actor_profile_id uuid,p_target_id uuid,p_room_id uuid,p_reservation_id uuid,
  p_cleaning_kind public.cleaning_kind,p_service_date date,
  p_available_from timestamptz,p_due_at timestamptz,p_expected_room_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare v_room public.rooms; v_type public.room_types; v_template public.cleaning_template_versions;
  v_reservation public.reservations; v_target public.cleaning_targets; v_response jsonb;
  v_window_end timestamptz;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response:=private.replay_command(p_actor_profile_id,'cleaning.manual_request.create',
    p_idempotency_key,p_request_hash);
  if v_response is not null then return v_response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if p_cleaning_kind not in('stayover','additional')
    or not isfinite(p_available_from)
    or (p_available_from at time zone 'Asia/Seoul')::date<>p_service_date
    or (p_due_at is not null and (not isfinite(p_due_at) or p_due_at<=p_available_from)) then
    raise exception using errcode='22023',message='INVALID_MANUAL_CLEANING_REQUEST';
  end if;
  select * into v_room from public.rooms where id=p_room_id for update;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if v_room.state_version<>p_expected_room_version then
    raise exception using errcode='40001',message='STALE_VERSION'; end if;
  select * into strict v_type from public.room_types where id=v_room.room_type_id;
  select * into v_template from public.cleaning_template_versions template
    where template.room_type_id=v_room.room_type_id
      and template.cleaning_kind=p_cleaning_kind and template.status='published';
  if not found then raise exception using errcode='23514',message='CLEANING_TEMPLATE_NOT_CONFIGURED'; end if;
  v_window_end:=coalesce(p_due_at,case when v_template.duration_minutes is not null
    then p_available_from+make_interval(mins=>v_template.duration_minutes) end);

  if p_cleaning_kind='stayover' then
    select * into v_reservation from public.reservations reservation
      where reservation.id=p_reservation_id for update;
    if v_reservation.id is null or v_reservation.status<>'active'
      or v_reservation.actual_check_in_at is null or v_reservation.actual_checkout_at is not null then
      raise exception using errcode='23514',message='ACTIVE_STAY_RESERVATION_REQUIRED';
    end if;
    if p_due_at is null or not exists(
        select 1 from private.reservation_stays stay
        join private.stay_room_segments segment on segment.stay_id=stay.id
        where stay.reservation_id=v_reservation.id and segment.room_id=p_room_id
          and segment.retired_at is null and segment.starts_at<=p_available_from
          and (segment.ends_at is null or segment.ends_at>=p_due_at)
      ) then raise exception using errcode='23514',message='STAYOVER_ACCESS_WINDOW_INVALID'; end if;
  elsif p_reservation_id is not null and not exists(
    select 1 from private.reservation_stays stay
    join private.stay_room_segments segment on segment.stay_id=stay.id
    where stay.reservation_id=p_reservation_id and segment.room_id=p_room_id
      and segment.retired_at is null
  ) then raise exception using errcode='23514',message='RESERVATION_ROOM_MISMATCH';
  elsif v_window_end is null then
    raise exception using errcode='23514',message='CLEANING_DURATION_REQUIRED';
  elsif exists(
    select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    where segment.room_id=p_room_id and segment.retired_at is null
      and stay.status in('scheduled','active')
      and tstzrange(segment.starts_at,segment.ends_at,'[)')
        && tstzrange(p_available_from,v_window_end,'[)')
  ) then raise exception using errcode='23514',message='VACANT_ROOM_REQUIRED'; end if;

  if p_cleaning_kind='additional' and exists(
    select 1 from private.reservation_stays stay
    where stay.status='active' and stay.actual_check_in_at is not null
      and stay.actual_checkout_at is null
      and (stay.scheduled_check_out_at is null or stay.scheduled_check_out_at<=p_available_from)
      and private.reservation_current_room_at(stay.reservation_id,p_available_from)=p_room_id
  ) then raise exception using errcode='23514',message='VACANT_ROOM_REQUIRED'; end if;

  if v_window_end is not null and exists(
    select 1 from public.cleaning_targets target where target.room_id=p_room_id
      and target.status not in('approved','cancelled') and target.available_from is not null
      and target.due_at is not null
      and tstzrange(target.available_from,target.due_at,'[)')
        && tstzrange(p_available_from,v_window_end,'[)')
  ) then raise exception using errcode='23P01',message='CLEANING_REQUEST_TIME_CONFLICT'; end if;

  insert into public.cleaning_targets(
    id,room_id,reservation_id,cleaning_kind,source,source_key,original_service_date,
    effective_service_date,available_from,due_at,room_type_snapshot,fee_snapshot,
    template_snapshot,created_by
  ) values(
    p_target_id,p_room_id,p_reservation_id,p_cleaning_kind,
    case when p_cleaning_kind='stayover' then 'stayover_request' else 'manual_room_request' end,
    'manual-cleaning-request:'||p_target_id,p_service_date,p_service_date,p_available_from,p_due_at,
    jsonb_build_object('id',v_type.id,'code',v_type.code,'name',v_type.name,
      'defaultDurationMinutes',v_type.default_duration_minutes),v_type.base_cleaning_fee,
    jsonb_build_object('id',v_template.id,'version',v_template.version,
      'durationMinutes',v_template.duration_minutes,'photoSlots',v_template.photo_slots),
    p_actor_profile_id
  ) returning * into v_target;
  insert into public.cleaning_target_schedule_revisions(
    cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by
  ) values(v_target.id,v_target.assignment_version,v_target.effective_service_date,
    v_target.available_from,v_target.due_at,p_reason_code,p_actor_profile_id);
  update public.rooms set state_version=state_version+1 where id=p_room_id;
  v_response:=jsonb_build_object('id',v_target.id,'room_id',v_target.room_id,
    'reservation_id',v_target.reservation_id,'cleaning_kind',v_target.cleaning_kind,
    'status',v_target.status,'service_date',v_target.effective_service_date,
    'available_from',v_target.available_from,'due_at',v_target.due_at,
    'version',v_target.assignment_version);
  insert into public.audit_events(
    actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,after_state,request_hash,idempotency_key
  ) select profile.id,profile.display_name,'cleaning.manual_request.created','cleaning_target',
    v_target.id,clock_timestamp(),p_reason_code,v_response,p_request_hash,
    private.audit_command_key(p_actor_profile_id,'cleaning.manual_request.create',p_idempotency_key)
    from public.profiles profile where profile.id=p_actor_profile_id;
  perform private.complete_command(p_actor_profile_id,'cleaning.manual_request.create',
    p_idempotency_key,p_request_hash,v_target.id,v_response);
  return v_response;
end
$$;
revoke all on function public.create_manual_cleaning_request(
  uuid,uuid,uuid,uuid,public.cleaning_kind,date,timestamptz,timestamptz,bigint,text,text,text
) from public,anon,authenticated;
grant execute on function public.create_manual_cleaning_request(
  uuid,uuid,uuid,uuid,public.cleaning_kind,date,timestamptz,timestamptz,bigint,text,text,text
) to service_role;

create or replace function private.execute_cleaning_attempt_at(
  p_actor_profile_id uuid,p_attempt_id uuid,p_expected_execution_version bigint,
  p_expected_assignment_id uuid,p_expected_assignment_revision bigint,
  p_idempotency_key text,p_request_hash text,p_action text,p_command_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_profile public.profiles%rowtype; v_attempt public.cleaning_attempts%rowtype;
  v_target public.cleaning_targets%rowtype; v_assignment public.cleaning_assignments%rowtype;
  v_command text; v_event text; v_replay jsonb; v_result jsonb; v_reason text;
  v_command_at timestamptz;
begin
  if p_action not in ('start','complete_field_work') or p_action is null
    or p_expected_execution_version is null or p_expected_execution_version<1
    or p_expected_assignment_revision is null or p_expected_assignment_revision<1
    or p_expected_assignment_id is null or p_attempt_id is null then
    raise exception using errcode='22023',message='INVALID_ATTEMPT_COMMAND';
  end if;
  select * into v_profile from public.profiles where id=p_actor_profile_id and status='active';
  if not found or v_profile.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  v_command:='cleaning.attempt.'||p_action;
  v_event:=case when p_action='start' then 'cleaning.attempt_started' else 'cleaning.field_completed' end;
  v_replay:=private.replay_command(p_actor_profile_id,v_command,p_idempotency_key,p_request_hash);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_profile from public.profiles where id=p_actor_profile_id and status='active' for share;
  if not found or v_profile.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  if v_profile.must_change_password then raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED'; end if;
  select * into v_attempt from public.cleaning_attempts where id=p_attempt_id and maid_profile_id=p_actor_profile_id;
  if not found then raise exception using errcode='42501',message='ATTEMPT_ACCESS_REQUIRED'; end if;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id for update;
  select * into v_assignment from public.cleaning_assignments where id=v_attempt.assignment_id for update;
  select * into v_attempt from public.cleaning_attempts where id=p_attempt_id for update;
  v_command_at:=coalesce(p_command_at,clock_timestamp());
  if not v_assignment.is_current or v_assignment.notified_at is null
    or v_assignment.maid_profile_id<>p_actor_profile_id
    or v_assignment.id<>p_expected_assignment_id
    or v_assignment.revision<>p_expected_assignment_revision
    or v_attempt.assignment_revision<>v_assignment.revision
    or v_target.assignment_version<>v_assignment.revision
    or v_target.status='cancelled' then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if v_replay is not null then return v_replay; end if;
  if v_attempt.execution_version<>p_expected_execution_version then
    raise exception using errcode='40001',message='ATTEMPT_VERSION_CONFLICT';
  end if;
  if p_action='start' then
    if v_attempt.status<>'scheduled' then raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION'; end if;
    v_reason:=private.activation_reason_at(v_target,v_assignment,v_command_at);
    if v_reason is not null then raise exception using errcode='55000',message=v_reason; end if;
    if v_assignment.notified_room_id_snapshot is distinct from v_target.room_id
      or (v_attempt.room_snapshot->>'roomId') is distinct from v_target.room_id::text then
      raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT';
    end if;
    if v_target.cleaning_kind='additional' and exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=v_target.room_id and segment.retired_at is null
        and stay.status in('scheduled','active')
        and segment.starts_at<=v_command_at
        and (segment.ends_at is null or segment.ends_at>v_command_at)
    ) then raise exception using errcode='55000',message='ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if exists(select 1 from public.cleaning_attempts a where a.maid_profile_id=p_actor_profile_id and a.status='in_progress') then
      raise exception using errcode='55000',message='MAID_ALREADY_IN_PROGRESS';
    end if;
    update public.cleaning_attempts set status='in_progress',started_at=v_command_at,
      execution_version=execution_version+1 where id=p_attempt_id returning * into v_attempt;
    update public.cleaning_targets set status='in_progress' where id=v_target.id;
  else
    if v_attempt.status<>'in_progress' or v_attempt.started_at is null or v_attempt.started_at>v_command_at then
      raise exception using errcode='55000',message='ATTEMPT_INVALID_TRANSITION';
    end if;
    update public.cleaning_attempts set status='field_completed',field_completed_at=v_command_at,ended_at=v_command_at,
      execution_version=execution_version+1 where id=p_attempt_id returning * into v_attempt;
  end if;
  v_result:=private.attempt_execution_projection(v_attempt);
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,actor_display_name_snapshot,
    effective_at,recorded_at,after_state,idempotency_key)
  values(v_event,'cleaning_attempt',v_attempt.id,p_actor_profile_id,v_profile.display_name,
    v_command_at,clock_timestamp(),v_result,private.audit_command_key(p_actor_profile_id,v_command,p_idempotency_key));
  perform private.complete_command(p_actor_profile_id,v_command,p_idempotency_key,p_request_hash,p_attempt_id,v_result);
  return v_result;
end;
$$;
revoke all on function private.execute_cleaning_attempt_at(uuid,uuid,bigint,uuid,bigint,text,text,text,timestamptz)
  from public,anon,authenticated,service_role;
