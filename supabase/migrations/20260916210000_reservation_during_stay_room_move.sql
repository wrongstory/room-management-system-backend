-- Issue #187 Phase C: append-only stay/room-segment history and DURING_STAY
-- room moves. Reservation.room_id remains the check-in contract room; actual
-- occupancy after check-in is derived from bounded stay segments.

create table private.reservation_stays (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null unique references public.reservations(id) on delete restrict,
  status text not null check (status in ('scheduled','active','completed','cancelled')),
  scheduled_check_in_at timestamptz not null,
  scheduled_check_out_at timestamptz not null,
  actual_check_in_at timestamptz,
  actual_checkout_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, reservation_id),
  check (isfinite(scheduled_check_in_at) and isfinite(scheduled_check_out_at)),
  check (scheduled_check_out_at > scheduled_check_in_at),
  check (actual_check_in_at is null or isfinite(actual_check_in_at)),
  check (actual_checkout_at is null or actual_check_in_at is null or actual_checkout_at >= actual_check_in_at)
);

create table private.reservation_room_move_events (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  stay_id uuid references private.reservation_stays(id) on delete restrict,
  from_room_id uuid not null references public.rooms(id) on delete restrict,
  to_room_id uuid not null references public.rooms(id) on delete restrict,
  effective_at timestamptz not null,
  mode text not null check (mode in ('BEFORE_CHECKIN','DURING_STAY')),
  reason_code text not null check (reason_code in ('GUEST_REQUEST','ROOM_UNAVAILABLE','OPERATIONAL_ADJUSTMENT')),
  actor_profile_id uuid not null references public.profiles(id) on delete restrict,
  reservation_version bigint not null check (reservation_version > 0),
  source_room_version bigint not null check (source_room_version > 0),
  target_room_version bigint not null check (target_room_version > 0),
  command_key text not null unique,
  created_at timestamptz not null default clock_timestamp(),
  check (from_room_id <> to_room_id),
  check (isfinite(effective_at))
);

alter table private.reservation_room_move_events
  add constraint reservation_room_move_events_stay_reservation_fk
  foreign key (stay_id,reservation_id)
  references private.reservation_stays(id,reservation_id) on delete restrict;

create table private.stay_room_segments (
  id uuid primary key default gen_random_uuid(),
  stay_id uuid not null references private.reservation_stays(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source_reservation_id uuid not null references public.reservations(id) on delete restrict,
  move_event_id uuid references private.reservation_room_move_events(id) on delete restrict,
  retired_at timestamptz,
  terminal_reason_code text,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  unique (id, stay_id, room_id),
  foreign key (stay_id,source_reservation_id)
    references private.reservation_stays(id,reservation_id) on delete restrict,
  check (isfinite(starts_at) and isfinite(ends_at)),
  -- A same-instant manual checkout is an existing supported contract. Keep
  -- its historical occupancy segment as an empty [at,at) interval rather
  -- than silently making checkout stricter than reservations.
  check (ends_at >= starts_at)
);

alter table private.stay_room_segments
  add constraint stay_room_segments_no_room_overlap
  exclude using gist (
    room_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (retired_at is null);

alter table private.stay_room_segments
  add constraint stay_room_segments_no_stay_overlap
  exclude using gist (
    stay_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (retired_at is null);

create index stay_room_segments_stay_time_idx
  on private.stay_room_segments(stay_id, starts_at, ends_at);
create unique index stay_room_segments_one_active_boundary
  on private.stay_room_segments(stay_id,starts_at) where retired_at is null;
create index stay_room_segments_room_time_idx
  on private.stay_room_segments(room_id, starts_at, ends_at);
create index reservation_room_move_events_reservation_idx
  on private.reservation_room_move_events(reservation_id, created_at desc, id desc);
create index reservation_room_move_events_stay_reservation_idx
  on private.reservation_room_move_events(stay_id, reservation_id);
create index reservation_room_move_events_from_room_idx
  on private.reservation_room_move_events(from_room_id);
create index reservation_room_move_events_to_room_idx
  on private.reservation_room_move_events(to_room_id);
create index reservation_room_move_events_actor_idx
  on private.reservation_room_move_events(actor_profile_id);
create index stay_room_segments_source_reservation_idx
  on private.stay_room_segments(source_reservation_id);
create index stay_room_segments_stay_reservation_idx
  on private.stay_room_segments(stay_id, source_reservation_id);
create index stay_room_segments_move_event_idx
  on private.stay_room_segments(move_event_id);

create table private.stay_segment_checkout_obligations (
  id uuid primary key default gen_random_uuid(),
  stay_id uuid not null references private.reservation_stays(id) on delete restrict,
  source_segment_id uuid not null unique references private.stay_room_segments(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  cleaning_target_id uuid unique,
  effective_service_date date not null,
  available_from timestamptz not null,
  due_at timestamptz,
  status text not null default 'materialized'
    check (status in ('materialized','completed','cancelled')),
  completion_submission_id uuid references public.cleaning_submissions(id) on delete restrict,
  completed_at timestamptz,
  version bigint not null default 1 check (version > 0),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  unique (id, room_id),
  foreign key (source_segment_id,stay_id,room_id)
    references private.stay_room_segments(id,stay_id,room_id) on delete restrict,
  check (due_at is null or due_at > available_from),
  check ((status='completed') = (completion_submission_id is not null and completed_at is not null))
);

create table private.room_pin_access_scheduled_revocations (
  lease_id uuid primary key references public.room_pin_access_leases(id) on delete restrict,
  reservation_id uuid not null references public.reservations(id) on delete restrict,
  stay_id uuid not null references private.reservation_stays(id) on delete restrict,
  move_event_id uuid not null references private.reservation_room_move_events(id) on delete restrict,
  effective_at timestamptz not null,
  reason_code text not null check (reason_code = 'RESERVATION_ROOM_MOVED'),
  created_at timestamptz not null default clock_timestamp()
);

alter table private.room_pin_access_scheduled_revocations
  add constraint room_pin_scheduled_revocations_stay_reservation_fk
  foreign key (stay_id,reservation_id)
  references private.reservation_stays(id,reservation_id) on delete restrict;

create index stay_segment_checkout_obligations_stay_idx
  on private.stay_segment_checkout_obligations(stay_id);
create index stay_segment_checkout_obligations_room_idx
  on private.stay_segment_checkout_obligations(room_id);
create index stay_segment_checkout_obligations_submission_idx
  on private.stay_segment_checkout_obligations(completion_submission_id);
create index stay_segment_checkout_obligations_creator_idx
  on private.stay_segment_checkout_obligations(created_by);
create index room_pin_scheduled_revocations_stay_reservation_idx
  on private.room_pin_access_scheduled_revocations(stay_id, reservation_id);
create index room_pin_scheduled_revocations_reservation_idx
  on private.room_pin_access_scheduled_revocations(reservation_id);
create index room_pin_scheduled_revocations_move_event_idx
  on private.room_pin_access_scheduled_revocations(move_event_id);

alter table private.reservation_stays enable row level security;
alter table private.reservation_stays force row level security;
alter table private.stay_room_segments enable row level security;
alter table private.stay_room_segments force row level security;
alter table private.reservation_room_move_events enable row level security;
alter table private.reservation_room_move_events force row level security;
alter table private.stay_segment_checkout_obligations enable row level security;
alter table private.stay_segment_checkout_obligations force row level security;
alter table private.room_pin_access_scheduled_revocations enable row level security;
alter table private.room_pin_access_scheduled_revocations force row level security;
revoke all on private.reservation_stays, private.stay_room_segments,
  private.reservation_room_move_events, private.stay_segment_checkout_obligations,
  private.room_pin_access_scheduled_revocations
from public, anon, authenticated, service_role;

-- Early check-in is a supported operational fact. It may precede the planned
-- check-in, but it must remain finite and precede any actual checkout.
alter table public.reservations
  drop constraint reservations_status_timestamps_check,
  add constraint reservations_status_timestamps_check check (
    (
      status='active' and cancelled_at is null and actual_checkout_at is null
      and (actual_check_in_at is null or isfinite(actual_check_in_at))
    ) or (
      status='cancelled' and cancelled_at is not null
      and actual_check_in_at is null and actual_checkout_at is null
    ) or (
      status='checked_out' and cancelled_at is null
      and actual_checkout_at is not null and isfinite(actual_checkout_at)
      and (actual_check_in_at is null or
        (isfinite(actual_check_in_at) and actual_checkout_at>=actual_check_in_at))
    )
  );

-- Backfill is deliberately fail-closed. No existing reservation is rewritten.
do $$
begin
  if exists (
    select 1
    from public.reservations left_reservation
    join public.reservations right_reservation
      on left_reservation.id < right_reservation.id
     and left_reservation.room_id = right_reservation.room_id
     and left_reservation.status = 'active'
     and right_reservation.status = 'active'
     and tstzrange(
       coalesce(left_reservation.actual_check_in_at, left_reservation.check_in_at),
       left_reservation.check_out_at,
       '[)'
     ) && tstzrange(
       coalesce(right_reservation.actual_check_in_at, right_reservation.check_in_at),
       right_reservation.check_out_at,
       '[)'
     )
  ) then
    raise exception using errcode = '23P01', message = 'STAY_SEGMENT_BACKFILL_OVERLAP';
  end if;
end
$$;

insert into private.reservation_stays (
  reservation_id, status, scheduled_check_in_at, scheduled_check_out_at,
  actual_check_in_at, actual_checkout_at, version, created_at, updated_at
)
select
  reservation.id,
  case when reservation.actual_check_in_at is null then 'scheduled' else 'active' end,
  reservation.check_in_at,
  reservation.check_out_at,
  reservation.actual_check_in_at,
  null,
  reservation.version,
  reservation.created_at,
  reservation.updated_at
from public.reservations reservation
where reservation.status = 'active';

insert into private.stay_room_segments (
  stay_id, room_id, starts_at, ends_at, source_reservation_id, version,
  created_at, updated_at
)
select stay.id, reservation.room_id,
  coalesce(reservation.actual_check_in_at, reservation.check_in_at),
  reservation.check_out_at, reservation.id, 1,
  reservation.created_at, reservation.updated_at
from private.reservation_stays stay
join public.reservations reservation on reservation.id = stay.reservation_id;

-- Phase B move audits are already immutable and contain safe typed IDs and
-- versions. Reconstruct the exact check-in boundary from the matching
-- schedule revision; never guess a missing/malformed historical value.
do $$
begin
  if exists(
    select 1
    from public.audit_events audit
    left join public.reservation_schedule_revisions revision
      on revision.reservation_id=audit.entity_id
     and revision.version=case when coalesce(audit.after_state->>'reservationVersion','')~'^[1-9][0-9]*$'
       then (audit.after_state->>'reservationVersion')::bigint end
     and revision.room_id=case when coalesce(audit.after_state->>'targetRoomId','')
       ~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
       then (audit.after_state->>'targetRoomId')::uuid end
    where audit.event_type='reservation.room_moved'
      and audit.after_state->>'mode'='BEFORE_CHECKIN'
      and (
        audit.actor_profile_id is null or audit.entity_id is null
        or audit.idempotency_key is null
        or audit.reason_code not in('GUEST_REQUEST','ROOM_UNAVAILABLE','OPERATIONAL_ADJUSTMENT')
        or coalesce(audit.after_state->>'sourceRoomId','')
          !~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(audit.after_state->>'targetRoomId','')
          !~*'^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or coalesce(audit.after_state->>'reservationVersion','')!~'^[1-9][0-9]*$'
        or coalesce(audit.after_state->>'sourceRoomVersion','')!~'^[1-9][0-9]*$'
        or coalesce(audit.after_state->>'targetRoomVersion','')!~'^[1-9][0-9]*$'
        or revision.id is null
      )
  ) then
    raise exception using errcode='23514',message='ROOM_MOVE_AUDIT_BACKFILL_INVALID';
  end if;

  insert into private.reservation_room_move_events(
    reservation_id,stay_id,from_room_id,to_room_id,effective_at,mode,reason_code,
    actor_profile_id,reservation_version,source_room_version,target_room_version,
    command_key,created_at
  )
  select audit.entity_id,stay.id,(audit.after_state->>'sourceRoomId')::uuid,
    (audit.after_state->>'targetRoomId')::uuid,revision.check_in_at,'BEFORE_CHECKIN',
    audit.reason_code,audit.actor_profile_id,
    (audit.after_state->>'reservationVersion')::bigint,
    (audit.after_state->>'sourceRoomVersion')::bigint,
    (audit.after_state->>'targetRoomVersion')::bigint,
    audit.idempotency_key,audit.recorded_at
  from public.audit_events audit
  join public.reservation_schedule_revisions revision
    on revision.reservation_id=audit.entity_id
   and revision.version=(audit.after_state->>'reservationVersion')::bigint
   and revision.room_id=(audit.after_state->>'targetRoomId')::uuid
  left join private.reservation_stays stay on stay.reservation_id=audit.entity_id
  where audit.event_type='reservation.room_moved'
    and audit.after_state->>'mode'='BEFORE_CHECKIN'
  on conflict(command_key) do nothing;
end
$$;

-- From this point onward stay segments are the canonical occupancy exclusion.
-- The insert/update trigger below makes direct SQL reservation writes create or
-- update a segment in the same transaction, so an exclusion failure rolls the
-- entire reservation/obligation command back.
alter table public.reservations drop constraint reservations_no_overlap;

-- Stay segments are immutable in identity and may only shorten their end at a
-- room-move/checkout boundary. Deletes are never allowed.
create function private.guard_stay_segment_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception using errcode = '55000', message = 'STAY_SEGMENT_HISTORY_IMMUTABLE';
  end if;
  if new.id <> old.id or new.stay_id <> old.stay_id or new.room_id <> old.room_id
    or new.starts_at <> old.starts_at or new.source_reservation_id <> old.source_reservation_id
    or new.move_event_id is distinct from old.move_event_id
    or new.created_at <> old.created_at
    or (new.ends_at > old.ends_at and
      coalesce(current_setting('app.reservation_segment_writer_mode',true),'')
        not in ('schedule_change_v1','stay_ledger_sync_v1'))
    or old.retired_at is not null and new.retired_at is distinct from old.retired_at
    or new.version <> old.version + 1 then
    raise exception using errcode = '55000', message = 'STAY_SEGMENT_HISTORY_IMMUTABLE';
  end if;
  return new;
end
$$;
revoke all on function private.guard_stay_segment_history() from public, anon, authenticated, service_role;
create trigger stay_room_segments_history_guard
before update or delete on private.stay_room_segments
for each row execute function private.guard_stay_segment_history();

create function private.guard_room_move_event_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = '55000', message = 'ROOM_MOVE_EVENT_IMMUTABLE';
end
$$;
revoke all on function private.guard_room_move_event_history() from public, anon, authenticated, service_role;
create trigger reservation_room_move_events_immutable
before update or delete on private.reservation_room_move_events
for each row execute function private.guard_room_move_event_history();

create function private.stay_for_reservation(p_reservation_id uuid)
returns private.reservation_stays
language sql stable security definer set search_path = '' as $$
  select stay.* from private.reservation_stays stay
  where stay.reservation_id = p_reservation_id
$$;
revoke all on function private.stay_for_reservation(uuid) from public, anon, authenticated, service_role;

create function private.stay_segment_at(p_reservation_id uuid, p_at timestamptz)
returns private.stay_room_segments
language sql stable security definer set search_path = '' as $$
  select segment.*
  from private.reservation_stays stay
  join private.stay_room_segments segment on segment.stay_id = stay.id
  where stay.reservation_id = p_reservation_id
    and segment.retired_at is null
    and segment.starts_at <= p_at and segment.ends_at > p_at
  order by segment.starts_at desc, segment.id desc
  limit 1
$$;
revoke all on function private.stay_segment_at(uuid, timestamptz) from public, anon, authenticated, service_role;

create function private.reservation_current_room_at(p_reservation_id uuid, p_at timestamptz)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select segment.room_id from private.stay_segment_at(p_reservation_id, p_at) segment),
    (select segment.room_id
     from private.reservation_stays stay
     join private.stay_room_segments segment on segment.stay_id=stay.id
     where stay.reservation_id=p_reservation_id and segment.retired_at is null
       and segment.starts_at>p_at
     order by segment.starts_at asc,segment.id asc limit 1),
    (select segment.room_id
     from private.reservation_stays stay
     join private.stay_room_segments segment on segment.stay_id=stay.id
     where stay.reservation_id=p_reservation_id and segment.retired_at is null
     order by segment.ends_at desc,segment.starts_at desc,segment.id desc limit 1),
    (select reservation.room_id from public.reservations reservation where reservation.id = p_reservation_id)
  )
$$;
revoke all on function private.reservation_current_room_at(uuid, timestamptz)
from public, anon, authenticated, service_role;

-- Existing and future reservation writes keep the private stay ledger aligned.
create function private.sync_reservation_stay_ledger()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  stay private.reservation_stays;
  segment private.stay_room_segments;
  previous_segment_writer_mode text;
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      insert into private.reservation_stays (
        reservation_id,status,scheduled_check_in_at,scheduled_check_out_at,
        actual_check_in_at,version,created_at,updated_at
      ) values (
        new.id,case when new.actual_check_in_at is null then 'scheduled' else 'active' end,
        new.check_in_at,new.check_out_at,new.actual_check_in_at,new.version,new.created_at,new.updated_at
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
    else
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
    end if;
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
    -- A cancellation closes the existing occupancy below; only an active
    -- administrative reversal needs a replacement scheduled segment.
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
      and (new.actual_check_in_at is null or (
        ends_at = old.check_out_at))
    order by ends_at desc,starts_at desc,id desc limit 1 for update;
    if segment.id is not null and new.actual_check_in_at is null
      and new.check_in_at is distinct from old.check_in_at then
      update private.stay_room_segments set retired_at=clock_timestamp(),
        terminal_reason_code='RESERVATION_SCHEDULE_CHANGED',version=version+1,
        updated_at=clock_timestamp() where id=segment.id;
      insert into private.stay_room_segments(
        stay_id,room_id,starts_at,ends_at,source_reservation_id,created_at,updated_at
      ) values(stay.id,new.room_id,new.check_in_at,new.check_out_at,new.id,
        clock_timestamp(),clock_timestamp());
    elsif segment.id is not null and new.actual_check_in_at is null then
      update private.stay_room_segments set ends_at=new.check_out_at,
        version=version+1,updated_at=clock_timestamp() where id=segment.id;
    elsif segment.id is not null and new.actual_check_in_at is not null then
      update private.stay_room_segments set ends_at=new.check_out_at,
        version=version+1,updated_at=clock_timestamp() where id=segment.id;
    end if;
  end if;

  update private.reservation_stays set
    status=case
      when new.status='cancelled' then 'cancelled'
      when new.status='checked_out' then 'completed'
      when new.actual_check_in_at is not null then 'active'
      else 'scheduled' end,
    scheduled_check_in_at=new.check_in_at,scheduled_check_out_at=new.check_out_at,
    actual_check_in_at=new.actual_check_in_at,actual_checkout_at=new.actual_checkout_at,
    version=greatest(version+1,new.version),updated_at=clock_timestamp()
  where id=stay.id;

  if new.status in ('cancelled','checked_out') then
    select * into segment from private.stay_room_segments
    where stay_id=stay.id and retired_at is null
      and (new.status='cancelled' or (
        starts_at <= new.actual_checkout_at and ends_at >= new.actual_checkout_at))
    order by starts_at desc,id desc limit 1 for update;
    if segment.id is not null then
      update private.stay_room_segments set
        ends_at=case when new.status='checked_out' then new.actual_checkout_at else ends_at end,
        retired_at=case when new.status='cancelled' then clock_timestamp() else retired_at end,
        terminal_reason_code=case when new.status='cancelled' then 'RESERVATION_CANCELLED' else 'RESERVATION_CHECKED_OUT' end,
        version=version+1,updated_at=clock_timestamp() where id=segment.id;
    end if;
  end if;
  perform set_config('app.reservation_segment_writer_mode',previous_segment_writer_mode,true);
  return new;
end
$$;
revoke all on function private.sync_reservation_stay_ledger() from public, anon, authenticated, service_role;
create trigger zz_reservation_stay_ledger_insert
after insert on public.reservations for each row execute function private.sync_reservation_stay_ledger();
create trigger zz_reservation_stay_ledger_update
after update of room_id,check_in_at,check_out_at,status,actual_check_in_at,actual_checkout_at
on public.reservations for each row execute function private.sync_reservation_stay_ledger();

create or replace function private.guard_reservation_room_move_authority()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  if new.room_id is distinct from old.room_id
    and coalesce(current_setting('app.reservation_room_move_writer_mode',true),'')
      <> 'before_checkin_v1' then
    raise exception using errcode='23514',
      message='RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED',
      detail=private.reservation_room_move_conflict_detail(old.id,old.room_id,new.room_id);
  end if;
  return new;
end
$$;
revoke all on function private.guard_reservation_room_move_authority()
from public,anon,authenticated,service_role;

-- A reservation keeps one final checkout obligation, but its room follows the
-- final active segment rather than reservations.room_id once a stay has moved.
alter table public.checkout_cleaning_obligations
  add constraint checkout_obligations_id_reservation_unique unique (id, reservation_id);
alter table public.cleaning_targets
  drop constraint cleaning_targets_checkout_obligation_contract_fk,
  add constraint cleaning_targets_checkout_obligation_contract_fk
    foreign key (checkout_obligation_id, reservation_id)
    references public.checkout_cleaning_obligations(id, reservation_id)
    on delete restrict deferrable initially deferred;
alter table public.reservations
  drop constraint reservations_checkout_obligation_contract_fk,
  add constraint reservations_checkout_obligation_contract_fk
    foreign key (checkout_obligation_id, id)
    references public.checkout_cleaning_obligations(id, reservation_id)
    on delete restrict deferrable initially deferred;

alter table public.cleaning_targets
  add column stay_segment_checkout_obligation_id uuid unique
    references private.stay_segment_checkout_obligations(id) on delete restrict,
  add constraint cleaning_targets_segment_checkout_contract_unique
    unique(id,stay_segment_checkout_obligation_id,room_id);
alter table private.stay_segment_checkout_obligations
  add constraint stay_segment_checkout_target_fk
    foreign key (cleaning_target_id, id, room_id)
    references public.cleaning_targets(id, stay_segment_checkout_obligation_id, room_id)
    on delete restrict deferrable initially deferred;

-- A room move retires the previous planned checkout target and appends a new
-- immutable room/template snapshot. Historical cancelled targets retain their
-- obligation provenance; only the non-cancelled pointer must be unique.
alter table public.cleaning_targets
  drop constraint cleaning_targets_checkout_obligation_id_key;
create unique index cleaning_targets_one_live_checkout_obligation
  on public.cleaning_targets(checkout_obligation_id)
  where checkout_obligation_id is not null and status<>'cancelled';

create or replace function private.guard_planned_checkout_identity()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.planned_cleaning_target_id is not null
    and new.planned_cleaning_target_id is distinct from old.planned_cleaning_target_id then
    if coalesce(current_setting('app.checkout_plan_rebind_mode',true),'')<>'stay_room_move_v1'
      or old.current_cleaning_target_id is not null
      or new.current_cleaning_target_id is not null
      or not exists(select 1 from public.cleaning_targets target
        where target.id=old.planned_cleaning_target_id and target.status='cancelled')
      or not exists(select 1 from public.cleaning_targets target
        where target.id=new.planned_cleaning_target_id
          and target.checkout_obligation_id=new.id
          and target.reservation_id=new.reservation_id
          and target.room_id=new.room_id
          and target.status='unassigned') then
      raise exception using errcode='23514',message='CHECKOUT_PLANNED_IDENTITY_IMMUTABLE';
    end if;
  end if;
  if new.planned_cleaning_target_id is not null and new.status='available' then
    new.current_cleaning_target_id:=new.planned_cleaning_target_id;
    new.status:='materialized';
  end if;
  return new;
end
$$;
revoke all on function private.guard_planned_checkout_identity()
from public,anon,authenticated,service_role;

alter table public.cleaning_targets
  drop constraint cleaning_targets_reservation_room_fk,
  drop constraint cleaning_targets_source_check,
  drop constraint cleaning_targets_source_kind_check,
  drop constraint cleaning_targets_checkout_obligation_shape_check,
  add constraint cleaning_targets_source_check check (source in (
    'scheduled_checkout','manual_checkout','stayover_request','manual_room_request',
    'inspection_reclean','post_approval_complaint_reclean','stay_room_move_checkout'
  )),
  add constraint cleaning_targets_source_kind_check check (
    (
      source in ('scheduled_checkout','manual_checkout')
      and cleaning_kind='checkout' and reservation_id is not null
      and checkout_obligation_id is not null
      and stay_segment_checkout_obligation_id is null
    ) or (
      source='stay_room_move_checkout' and cleaning_kind='checkout'
      and reservation_id is not null and checkout_obligation_id is null
      and stay_segment_checkout_obligation_id is not null
    ) or (
      source='stayover_request' and cleaning_kind='stayover'
      and reservation_id is not null and checkout_obligation_id is null
      and stay_segment_checkout_obligation_id is null
    ) or (
      source='manual_room_request' and cleaning_kind='additional'
      and checkout_obligation_id is null and stay_segment_checkout_obligation_id is null
    ) or (
      source in ('inspection_reclean','post_approval_complaint_reclean')
      and cleaning_kind='reclean' and checkout_obligation_id is null
      and stay_segment_checkout_obligation_id is null
    )
  ),
  add constraint cleaning_targets_checkout_obligation_shape_check check (
    (
      cleaning_kind='checkout'
      and ((checkout_obligation_id is not null)::integer
        + (stay_segment_checkout_obligation_id is not null)::integer) = 1
    ) or (
      cleaning_kind<>'checkout' and checkout_obligation_id is null
      and stay_segment_checkout_obligation_id is null
    )
  );

drop index public.cleaning_targets_one_checkout_per_reservation;
create unique index cleaning_targets_one_final_checkout_per_reservation
  on public.cleaning_targets(reservation_id)
  where reservation_id is not null and cleaning_kind='checkout'
    and checkout_obligation_id is not null and status<>'cancelled';
create unique index cleaning_targets_one_segment_checkout
  on public.cleaning_targets(stay_segment_checkout_obligation_id)
  where stay_segment_checkout_obligation_id is not null;

create function private.reservation_final_room_id(p_reservation_id uuid)
returns uuid language sql stable security definer set search_path='' as $$
  select coalesce(
    (select segment.room_id
     from private.reservation_stays stay
     join private.stay_room_segments segment on segment.stay_id=stay.id
     where stay.reservation_id=p_reservation_id and segment.retired_at is null
     order by segment.ends_at desc,segment.starts_at desc,segment.id desc limit 1),
    (select reservation.room_id from public.reservations reservation where reservation.id=p_reservation_id)
  )
$$;
revoke all on function private.reservation_final_room_id(uuid)
from public,anon,authenticated,service_role;

create or replace function private.validate_planned_checkout_at_commit()
returns trigger language plpgsql security definer set search_path=''
as $$
declare obligation_id uuid;
begin
  if tg_table_name='checkout_cleaning_obligations' then obligation_id:=new.id;
  elsif tg_table_name='reservations' then obligation_id:=new.checkout_obligation_id;
  else obligation_id:=new.checkout_obligation_id; end if;
  if obligation_id is null then return null; end if;
  if exists (
    select 1 from public.checkout_cleaning_obligations o
    join public.reservations r on r.id=o.reservation_id
    left join public.cleaning_targets t on t.id=o.planned_cleaning_target_id
    where o.id=obligation_id and o.planned_cleaning_target_id is not null and (
      t.id is null or t.checkout_obligation_id<>o.id or t.reservation_id<>r.id
      or t.room_id<>o.room_id or o.room_id<>private.reservation_final_room_id(r.id)
      or (o.status='private' and (r.status<>'active' or r.actual_checkout_at is not null
        or o.available_from<>r.check_out_at or t.available_from<>o.available_from
        or t.effective_service_date<>o.effective_service_date or t.due_at is distinct from o.due_at
        or t.status not in ('unassigned','draft_assigned','notified')
        or exists(select 1 from public.cleaning_attempts a where a.cleaning_target_id=t.id and a.status<>'superseded')
        or exists(select 1 from public.room_pin_access_leases l where l.cleaning_target_id=t.id
          and l.revoked_at is null and l.expires_at>clock_timestamp())))
      or (o.status in ('materialized','completed') and (
        o.current_cleaning_target_id is distinct from t.id or r.status<>'checked_out'
        or r.actual_checkout_at is null))
      or (o.status='cancelled' and (t.status<>'cancelled'
        or exists(select 1 from public.cleaning_assignments a where a.cleaning_target_id=t.id and a.is_current)))
    )
  ) then raise exception using errcode='23514',message='CHECKOUT_PLANNED_CONTRACT_NOT_ATOMIC'; end if;
  return null;
end
$$;
revoke all on function private.validate_planned_checkout_at_commit()
from public,anon,authenticated,service_role;

create function private.validate_stay_segment_checkout_at_commit()
returns trigger language plpgsql security definer set search_path='' as $$
declare obligation_id uuid;
begin
  if tg_relid='private.stay_segment_checkout_obligations'::regclass then
    obligation_id:=new.id;
  else
    obligation_id:=new.stay_segment_checkout_obligation_id;
  end if;
  if obligation_id is null then return null; end if;
  if exists (
    select 1 from private.stay_segment_checkout_obligations obligation
    join private.stay_room_segments segment on segment.id=obligation.source_segment_id
    join private.reservation_stays stay on stay.id=obligation.stay_id
    left join public.cleaning_targets target on target.id=obligation.cleaning_target_id
    where obligation.id=obligation_id and (
      segment.stay_id<>obligation.stay_id or segment.room_id<>obligation.room_id
      or target.id is null or target.stay_segment_checkout_obligation_id<>obligation.id
      or target.room_id<>obligation.room_id or target.cleaning_kind<>'checkout'
      or target.source<>'stay_room_move_checkout' or target.reservation_id<>stay.reservation_id
      or target.effective_service_date<>obligation.effective_service_date
      or target.available_from<>obligation.available_from
      or target.due_at is distinct from obligation.due_at
    )
  ) then
    raise exception using errcode='23514',message='STAY_SEGMENT_CHECKOUT_CONTRACT_NOT_ATOMIC';
  end if;
  return null;
end
$$;
revoke all on function private.validate_stay_segment_checkout_at_commit()
from public,anon,authenticated,service_role;
create constraint trigger stay_segment_checkout_obligation_validate
after insert or update on private.stay_segment_checkout_obligations
deferrable initially deferred for each row execute function private.validate_stay_segment_checkout_at_commit();
create constraint trigger stay_segment_checkout_target_validate
after insert or update on public.cleaning_targets
deferrable initially deferred for each row execute function private.validate_stay_segment_checkout_at_commit();

create function private.validate_cleaning_target_room_provenance_at_commit()
returns trigger language plpgsql security definer set search_path='' as $$
declare target public.cleaning_targets;
begin
  select current_target.* into target from public.cleaning_targets current_target
  where current_target.id=new.id;
  if target.id is null or target.reservation_id is null then return null; end if;
  if target.checkout_obligation_id is not null and not exists(
    select 1 from public.checkout_cleaning_obligations obligation
    where obligation.id=target.checkout_obligation_id
      and obligation.reservation_id=target.reservation_id
      and (target.status='cancelled' or obligation.room_id=target.room_id)
  ) then raise exception using errcode='23514',message='CLEANING_TARGET_ROOM_PROVENANCE_INVALID';
  elsif target.stay_segment_checkout_obligation_id is not null and not exists(
    select 1 from private.stay_segment_checkout_obligations obligation
    join private.reservation_stays stay on stay.id=obligation.stay_id
    where obligation.id=target.stay_segment_checkout_obligation_id
      and stay.reservation_id=target.reservation_id and obligation.room_id=target.room_id
  ) then raise exception using errcode='23514',message='CLEANING_TARGET_ROOM_PROVENANCE_INVALID';
  elsif target.source='stayover_request' and not exists(
    select 1 from private.stay_segment_at(target.reservation_id,target.available_from) segment
    where segment.room_id=target.room_id
  ) then raise exception using errcode='23514',message='CLEANING_TARGET_ROOM_PROVENANCE_INVALID';
  end if;
  return null;
end
$$;
revoke all on function private.validate_cleaning_target_room_provenance_at_commit()
from public,anon,authenticated,service_role;
create constraint trigger cleaning_target_room_provenance_validate
after insert or update on public.cleaning_targets deferrable initially deferred
for each row execute function private.validate_cleaning_target_room_provenance_at_commit();

-- Segment-aware occupancy/readiness keeps reservations.room_id as history.
create or replace function private.room_reservation_phase_at(p_room_id uuid,p_at timestamptz)
returns text language sql stable security definer set search_path='' as $$
  select case
    when exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=p_room_id and segment.retired_at is null
        and stay.status in('scheduled','active') and segment.starts_at<=p_at and segment.ends_at>p_at
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
      (stay.status in('scheduled','active') and segment.starts_at<=p_at and segment.ends_at>p_at)
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
  next_reservation_id:=v_next.id; next_check_in_at:=v_next.segment_start; next_check_out_at:=v_next.segment_end;
  current_checkin_pending:=exists(select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    join public.reservations reservation on reservation.id=stay.reservation_id
    where segment.room_id=p_room_id and segment.retired_at is null and reservation.status='active'
      and reservation.actual_check_in_at is null and segment.starts_at<=p_at and segment.ends_at>p_at);
  return next;
end
$$;
revoke all on function private.room_reservation_lifecycle_at(uuid,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.room_current_cleaning_required_at(p_room_id uuid,p_at timestamptz)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.cleaning_targets target where target.room_id=p_room_id and (
    (target.cleaning_kind='checkout' and target.status not in ('approved','cancelled') and (
      exists(select 1 from public.checkout_cleaning_obligations obligation
        join public.reservations reservation on reservation.id=obligation.reservation_id
        where obligation.id=target.checkout_obligation_id
          and obligation.current_cleaning_target_id=target.id and obligation.status='materialized'
          and reservation.actual_checkout_at is not null and reservation.actual_checkout_at<=p_at)
      or exists(select 1 from private.stay_segment_checkout_obligations obligation
        where obligation.id=target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=target.id and obligation.available_from<=p_at)
    )) or (target.cleaning_kind<>'checkout' and target.status in
      ('unassigned','draft_assigned','notified','in_progress','upload_pending','inspection_pending')
      and target.effective_service_date<=(p_at at time zone 'Asia/Seoul')::date
      and (target.available_from is null or target.available_from<=p_at))
  ))
$$;
revoke all on function private.room_current_cleaning_required_at(uuid,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.room_block_reason_codes(
  p_room_id uuid,p_at timestamptz,p_include_occupancy boolean default true,
  p_include_cleaning boolean default true,p_preparation_reservation_id uuid default null
)
returns text[] language plpgsql stable security definer set search_path='' as $$
declare v_reasons text[]:=array[]::text[]; v_room public.rooms; v_pin_status text;
begin
  select * into v_room from public.rooms where id=p_room_id;
  if not found then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if p_include_occupancy and exists(
    select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    join public.reservations reservation on reservation.id=stay.reservation_id
    where segment.room_id=p_room_id and segment.retired_at is null and stay.status='active'
      and segment.starts_at<=p_at and (segment.ends_at>p_at or (
        reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
        and segment.room_id=private.reservation_final_room_id(reservation.id)))
  ) then v_reasons:=array_append(v_reasons,'OCCUPIED'); end if;
  if p_include_occupancy and p_preparation_reservation_id is null
    and private.room_reservation_phase_at(p_room_id,p_at)='current'
    then v_reasons:=array_append(v_reasons,'RESERVATION_CURRENT'); end if;
  if p_include_cleaning and ((p_preparation_reservation_id is not null and exists(
      select 1 from public.preparation_obligations obligation
      join public.reservations reservation on reservation.id=obligation.reservation_id
      where obligation.room_id=p_room_id and obligation.reservation_id=p_preparation_reservation_id
        and reservation.status='active' and obligation.status<>'approved'
    )) or (p_preparation_reservation_id is null and private.room_current_cleaning_required_at(p_room_id,p_at)))
    then v_reasons:=array_append(v_reasons,'CLEANING_REQUIRED'); end if;
  if private.current_candle_count(p_room_id)>0 then v_reasons:=array_append(v_reasons,'CANDLE_PRESENT'); end if;
  if exists(select 1 from public.room_operation_blocks block where block.room_id=p_room_id
    and block.released_at is null and block.starts_at<=p_at and (block.ends_at is null or block.ends_at>p_at))
    then v_reasons:=array_append(v_reasons,'OPERATION_BLOCKED'); end if;
  if exists(select 1 from public.room_issues issue where issue.room_id=p_room_id
    and issue.status='open' and issue.blocks_guest_assignment)
    then v_reasons:=array_append(v_reasons,'ROOM_ISSUE_BLOCKED'); end if;
  if p_preparation_reservation_id is not null then
    v_pin_status:=private.current_pin_sync_status(p_room_id);
    if v_pin_status='mismatch' then v_reasons:=array_append(v_reasons,'PIN_MISMATCH');
    elsif v_pin_status='unconfigured' then v_reasons:=array_append(v_reasons,'DATA_UNCONFIRMED'); end if;
    if exists(select 1 from public.checkout_presence_incidents incident
      where incident.room_id=p_room_id and incident.status='open')
      then v_reasons:=array_append(v_reasons,'CHECKOUT_NOT_COMPLETED'); end if;
  end if;
  if v_room.data_status<>'verified' and not ('DATA_UNCONFIRMED'=any(v_reasons))
    then v_reasons:=array_append(v_reasons,'DATA_UNCONFIRMED'); end if;
  return v_reasons;
end
$$;
revoke all on function private.room_block_reason_codes(uuid,timestamptz,boolean,boolean,uuid)
from public,anon,authenticated,service_role;

-- Future moves shorten access at effectiveAt without making the lease look
-- revoked beforehand. Every PIN authorization path consults this schedule.
create or replace function private.assert_room_pin_actor_work(
  p_actor uuid,p_session uuid,p_room uuid,p_assignment uuid,p_attempt uuid,p_access_lease uuid,
  p_pin_version bigint,p_mode text,p_at timestamptz
) returns public.profiles
language plpgsql security definer set search_path='' as $$
declare actor public.profiles; target public.cleaning_targets; assignment public.cleaning_assignments;
  attempt public.cleaning_attempts; access_lease public.room_pin_access_leases; target_id uuid;
begin
  if p_mode not in ('change','reveal') then raise exception using errcode='22023',message='INVALID_PIN_OPERATION_MODE'; end if;
  actor:=private.assert_room_pin_actor_session(p_actor,p_session);
  if actor.role='admin' then
    if p_assignment is not null or p_attempt is not null or p_access_lease is not null then
      raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED'; end if;
    return actor;
  end if;
  if actor.role<>'maid' or p_assignment is null or p_attempt is null or p_access_lease is null or p_pin_version is null then
    raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED'; end if;
  select cleaning_target_id into target_id from public.cleaning_assignments where id=p_assignment;
  select * into target from public.cleaning_targets where id=target_id for update;
  select * into assignment from public.cleaning_assignments where id=p_assignment for update;
  select * into attempt from public.cleaning_attempts where id=p_attempt for update;
  if assignment.id is null or target.id is null or attempt.id is null
    or assignment.maid_profile_id<>actor.id or not assignment.is_current or assignment.notified_at is null
    or assignment.revision<>target.assignment_version or assignment.notified_room_id_snapshot is distinct from p_room
    or target.room_id<>p_room or target.status in ('cancelled','approved')
    or attempt.assignment_id<>assignment.id or attempt.cleaning_target_id<>target.id or attempt.maid_profile_id<>actor.id
    or attempt.status not in ('scheduled','in_progress') or target.available_from is null or target.available_from>p_at
    then raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED'; end if;
  if p_mode='change' and attempt.status<>'in_progress' then
    raise exception using errcode='42501',message='PIN_CHANGE_IN_PROGRESS_REQUIRED'; end if;
  select * into access_lease from public.room_pin_access_leases where id=p_access_lease for update;
  if access_lease.id is null or access_lease.room_id<>p_room or access_lease.cleaning_target_id<>target.id
    or access_lease.assignment_id<>assignment.id or access_lease.attempt_id<>attempt.id
    or access_lease.issued_to<>actor.id or access_lease.pin_version<>p_pin_version
    or access_lease.revoked_at is not null or access_lease.issued_at>p_at or access_lease.expires_at<=p_at
    or exists(select 1 from private.room_pin_access_scheduled_revocations revocation
      where revocation.lease_id=access_lease.id and revocation.effective_at<=p_at)
    then raise exception using errcode='42501',message='PIN_ACCESS_LEASE_REQUIRED'; end if;
  return actor;
end
$$;
revoke all on function private.assert_room_pin_actor_work(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,timestamptz)
from public,anon,authenticated,service_role;

-- The public ledger may be read through PostgREST, so a scheduled revocation
-- also participates in row visibility. Past reveal evidence remains immutable,
-- but the lease cannot be reused at or after its effective cutoff.
create function private.room_pin_access_lease_cutoff_reached(
  p_lease_id uuid,p_at timestamptz
) returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from private.room_pin_access_scheduled_revocations scheduled
    where scheduled.lease_id=p_lease_id and scheduled.effective_at<=p_at
  )
$$;
revoke all on function private.room_pin_access_lease_cutoff_reached(uuid,timestamptz)
from public,anon,service_role;
grant execute on function private.room_pin_access_lease_cutoff_reached(uuid,timestamptz)
to authenticated;

drop policy room_pin_access_leases_scoped_read on public.room_pin_access_leases;
create policy room_pin_access_leases_scoped_read on public.room_pin_access_leases
for select to authenticated using (
  not private.room_pin_access_lease_cutoff_reached(
    room_pin_access_leases.id,clock_timestamp()) and (
    (select private.current_role())='admin'
    or ((select private.current_role())='maid'
      and issued_to=(select private.current_profile_id())
      and exists(select 1 from public.cleaning_assignments assignment
        where assignment.id=room_pin_access_leases.assignment_id
          and assignment.maid_profile_id=(select private.current_profile_id())
          and assignment.notified_at is not null))
  )
);

create function private.guard_pin_scheduled_revocation_history()
returns trigger language plpgsql set search_path='' as $$
begin
  raise exception using errcode='55000',message='PIN_SCHEDULED_REVOCATION_IMMUTABLE';
end
$$;
revoke all on function private.guard_pin_scheduled_revocation_history()
from public,anon,authenticated,service_role;
create trigger room_pin_access_scheduled_revocations_immutable
before update or delete on private.room_pin_access_scheduled_revocations
for each row execute function private.guard_pin_scheduled_revocation_history();

create function private.propagate_pin_scheduled_revocation_on_rotation()
returns trigger language plpgsql security definer set search_path='' as $$
declare prior private.room_pin_access_scheduled_revocations;
begin
  select scheduled.* into prior
  from private.room_pin_access_scheduled_revocations scheduled
  join public.room_pin_access_leases old_lease on old_lease.id=scheduled.lease_id
  where old_lease.id<>new.id and old_lease.room_id=new.room_id
    and old_lease.reservation_id is not distinct from new.reservation_id
    and old_lease.cleaning_target_id is not distinct from new.cleaning_target_id
    and old_lease.assignment_id is not distinct from new.assignment_id
    and old_lease.attempt_id is not distinct from new.attempt_id
    and old_lease.issued_to=new.issued_to
    and scheduled.effective_at>new.issued_at
  order by scheduled.effective_at asc,scheduled.lease_id limit 1;
  if prior.lease_id is not null then
    insert into private.room_pin_access_scheduled_revocations(
      lease_id,reservation_id,stay_id,move_event_id,effective_at,reason_code
    ) values(new.id,prior.reservation_id,prior.stay_id,prior.move_event_id,
      prior.effective_at,prior.reason_code);
  end if;
  return null;
end
$$;
revoke all on function private.propagate_pin_scheduled_revocation_on_rotation()
from public,anon,authenticated,service_role;
create trigger zz_room_pin_access_propagate_move_cutoff
after insert on public.room_pin_access_leases for each row
execute function private.propagate_pin_scheduled_revocation_on_rotation();

-- Replace Phase B's reservation-row based snapshot with the canonical segment
-- snapshot. The same helper is used by preview and commit so that a five-minute
-- preview cannot authorize a different occupancy graph.
create function private.reservation_room_move_source_segment(
  p_reservation_id uuid,p_effective_at timestamptz
) returns private.stay_room_segments language plpgsql stable security definer
set search_path=pg_catalog,public,private as $$
declare
  reservation public.reservations;
  stay private.reservation_stays;
  segment private.stay_room_segments;
begin
  select * into reservation from public.reservations where id=p_reservation_id;
  if reservation.id is null then return null; end if;
  select * into stay from private.reservation_stays where reservation_id=reservation.id;
  if stay.id is null then return null; end if;

  -- Active reservations retain the normal half-open, non-retired occupancy
  -- lookup. Historical fallback is only for an inactive preview projection:
  -- a same-instant checkout has an empty [at,at) segment, while cancellation
  -- retires the segment that still owns the public room provenance.
  if reservation.status='active' and reservation.actual_checkout_at is null then
    select * into segment from private.stay_segment_at(reservation.id,p_effective_at);
  elsif reservation.actual_checkout_at is not null then
    select item.* into segment
    from private.stay_room_segments item
    where item.stay_id=stay.id and item.retired_at is null
    order by case when tstzrange(item.starts_at,item.ends_at,'[)') @> p_effective_at
        then 0 else 1 end,
      item.starts_at desc,item.created_at desc,item.id desc
    limit 1;
  else
    select item.* into segment
    from private.stay_room_segments item
    where item.stay_id=stay.id
    order by item.starts_at desc,item.created_at desc,item.id desc
    limit 1;
  end if;
  return segment;
end
$$;
revoke all on function private.reservation_room_move_source_segment(uuid,timestamptz)
from public,anon,authenticated,service_role;

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
  select * into source_segment
  from private.reservation_room_move_source_segment(reservation.id,p_effective_at);
  select * into target_room from public.rooms where id=p_target_room_id;
  if target_room.id is null then return null; end if;
  if source_segment.id is not null then
    select * into source_room from public.rooms where id=source_segment.room_id;
  else
    select * into source_room from public.rooms where id=reservation.room_id;
  end if;
  select * into obligation from public.checkout_cleaning_obligations where id=reservation.checkout_obligation_id;
  select * into target from public.cleaning_targets where id=obligation.planned_cleaning_target_id;

  mode:=case when reservation.status='active' and reservation.actual_check_in_at is null
    and reservation.actual_checkout_at is null and p_evaluated_at<reservation.check_in_at
    then 'BEFORE_CHECKIN' else 'DURING_STAY' end;
  if reservation.status<>'active' or reservation.actual_checkout_at is not null then
    rejections:=array_append(rejections,'RESERVATION_NOT_ACTIVE');
  end if;
  if source_segment.id is null then rejections:=array_append(rejections,'ROOM_CHANGE_PREVIEW_STALE'); end if;
  if source_room.id=p_target_room_id then rejections:=array_append(rejections,'SAME_ROOM'); end if;
  if mode='BEFORE_CHECKIN' and p_effective_at<>reservation.check_in_at then
    rejections:=array_append(rejections,'INVALID_MOVE_EFFECTIVE_AT');
  elsif mode='DURING_STAY' and (p_effective_at<p_evaluated_at or p_effective_at>=reservation.check_out_at) then
    rejections:=array_append(rejections,'INVALID_MOVE_EFFECTIVE_AT');
  end if;
  if reservation.check_out_at is null or not isfinite(reservation.check_out_at) then
    rejections:=array_append(rejections,'OPEN_ENDED_STAY_REQUIRES_END');
  end if;
  if obligation.status<>'private' or obligation.current_cleaning_target_id is not null
    or target.id is null or target.status<>'unassigned' then
    rejections:=array_append(rejections,'CLEANING_WORKFLOW_PUBLIC');
  end if;
  if target.id is not null then
    select count(*)::integer into assignment_count from public.cleaning_assignments
      where cleaning_target_id=target.id;
    select count(*)::integer into attempt_count from public.cleaning_attempts
      where cleaning_target_id=target.id;
    select count(*)::integer into pin_count from public.room_pin_access_leases lease
      where (lease.reservation_id=reservation.id or lease.cleaning_target_id=target.id)
        and lease.revoked_at is null
        and not exists(select 1 from private.room_pin_access_scheduled_revocations scheduled
          where scheduled.lease_id=lease.id and scheduled.effective_at<=p_effective_at);
  end if;
  if assignment_count>0 then rejections:=array_append(rejections,'CLEANING_WORKFLOW_ASSIGNED'); end if;
  if attempt_count>0 then rejections:=array_append(rejections,'CLEANING_WORKFLOW_STARTED'); end if;
  if mode='BEFORE_CHECKIN' and pin_count>0 then rejections:=array_append(rejections,'ACTIVE_PIN_ACCESS_EXISTS'); end if;

  block_reasons:=private.room_block_reason_codes(p_target_room_id,p_effective_at,true,true);
  select exists(select 1 from private.stay_room_segments segment
    where segment.room_id=p_target_room_id and segment.retired_at is null
      and tstzrange(segment.starts_at,segment.ends_at,'[)') &&
        tstzrange(p_effective_at,reservation.check_out_at,'[)')) into overlap_found;
  if overlap_found then rejections:=array_append(rejections,'RESERVATION_OVERLAP'); end if;
  if cardinality(block_reasons)>0 then rejections:=array_append(rejections,'TARGET_ROOM_BLOCKED'); end if;
  target_outcome:=private.reservation_room_move_outcome_at(p_target_room_id,p_effective_at);
  source_outcome:=private.reservation_room_move_outcome_at(source_room.id,p_effective_at);
  if coalesce(target_outcome->>'occupancyStatus','OCCUPIED')<>'VACANT'
    or coalesce(target_outcome->>'readinessStatus','BLOCKED')<>'READY' then
    rejections:=array_append(rejections,'TARGET_ROOM_NOT_READY');
  end if;
  if rejections && array['RESERVATION_NOT_ACTIVE','SAME_ROOM','ROOM_CHANGE_PREVIEW_STALE',
      'INVALID_MOVE_EFFECTIVE_AT','OPEN_ENDED_STAY_REQUIRES_END']::text[] then
    blocking:=array_append(blocking,'ROOM_CHANGE_PREVIEW_STALE'); end if;
  if rejections && array['CLEANING_WORKFLOW_PUBLIC','CLEANING_WORKFLOW_ASSIGNED','CLEANING_WORKFLOW_STARTED']::text[] then
    blocking:=array_append(blocking,'CLEANING_ASSIGNMENT_LOCKED'); end if;
  if 'ACTIVE_PIN_ACCESS_EXISTS'=any(rejections) then blocking:=array_append(blocking,'PIN_LEASE_ACTIVE'); end if;
  if 'RESERVATION_OVERLAP'=any(rejections) then blocking:=array_append(blocking,'TARGET_ROOM_OVERLAP'); end if;
  if 'TARGET_ROOM_BLOCKED'=any(rejections) then blocking:=array_append(blocking,'TARGET_ROOM_BLOCKED'); end if;
  if 'TARGET_ROOM_NOT_READY'=any(rejections) then blocking:=array_append(blocking,'TARGET_ROOM_NOT_READY'); end if;

  impact:=jsonb_build_object('contractVersion',2,'reservation',jsonb_build_array(
      reservation.id,reservation.version,reservation.check_in_at,reservation.check_out_at,
      reservation.actual_check_in_at,reservation.actual_checkout_at),
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
    'targetRoomVersion',target_room.state_version,'checkInAt',reservation.check_in_at,
    'checkOutAt',reservation.check_out_at,'guestCount',reservation.guest_count,
    'preparationObligationId',reservation.preparation_obligation_id,
    'checkoutObligationId',obligation.id,'checkoutObligationVersion',obligation.version,
    'plannedCheckoutTargetId',target.id,'plannedCheckoutTargetVersion',target.assignment_version);
end
$$;

create or replace function public.preview_reservation_room_move(
  p_actor_profile_id uuid,p_reservation_id uuid,p_target_room_id uuid,
  p_expected_reservation_version bigint,p_expected_source_room_version bigint,
  p_expected_target_room_version bigint,p_effective_at timestamptz,p_reason_code text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare now_at timestamptz:=clock_timestamp(); expires_at timestamptz:=now_at+interval '5 minutes';
  reservation public.reservations; source_segment private.stay_room_segments;
  source_room_id uuid; source_version bigint; target_version bigint;
  effective_at timestamptz; result jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  select * into reservation from public.reservations where id=p_reservation_id;
  if reservation.id is null then raise exception using errcode='P0002',message='RESERVATION_NOT_FOUND'; end if;
  if p_reason_code not in ('GUEST_REQUEST','ROOM_UNAVAILABLE','OPERATIONAL_ADJUSTMENT') then
    raise exception using errcode='22023',message='INVALID_ROOM_MOVE_REASON'; end if;
  if reservation.status<>'active' or reservation.actual_checkout_at is not null then
    -- Inactive reservations keep Phase B's 200 ineligible projection. For a
    -- checked-out stay, inspect the last occupied half-open instant instead
    -- of rejecting its past checkout timestamp before state evaluation.
    effective_at:=case when reservation.actual_checkout_at is not null
      then reservation.actual_checkout_at-interval '1 microsecond'
      else reservation.check_in_at end;
  else
    effective_at:=case when reservation.actual_check_in_at is null
      then coalesce(p_effective_at,reservation.check_in_at) else p_effective_at end;
    if effective_at is null then raise exception using errcode='22023',message='INVALID_MOVE_EFFECTIVE_AT'; end if;
    if reservation.actual_check_in_at is null and effective_at<>reservation.check_in_at then
      raise exception using errcode='22023',message='INVALID_MOVE_EFFECTIVE_AT';
    elsif reservation.actual_check_in_at is not null
      and (effective_at<now_at or effective_at>=reservation.check_out_at) then
      raise exception using errcode='22023',message='INVALID_MOVE_EFFECTIVE_AT';
    end if;
  end if;
  select * into source_segment
  from private.reservation_room_move_source_segment(reservation.id,effective_at);
  source_room_id:=source_segment.room_id;
  select state_version into source_version from public.rooms where id=source_room_id;
  select state_version into target_version from public.rooms where id=p_target_room_id;
  if target_version is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if reservation.version<>p_expected_reservation_version then raise exception using errcode='40001',message='RESERVATION_VERSION_CONFLICT',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room_id,p_target_room_id); end if;
  if source_version<>p_expected_source_room_version then raise exception using errcode='40001',message='SOURCE_ROOM_VERSION_CONFLICT',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room_id,p_target_room_id); end if;
  if target_version<>p_expected_target_room_version then raise exception using errcode='40001',message='TARGET_ROOM_VERSION_CONFLICT',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room_id,p_target_room_id); end if;
  result:=private.reservation_room_move_state(reservation.id,p_target_room_id,now_at,expires_at,effective_at,p_reason_code);
  if result is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  return result;
end
$$;

insert into private.notification_event_catalog(
  event_family,category,source_entity_kind,recipient_capability,requires_action,
  push_eligible,resolver_kind,deep_link_kind,group_family,group_scope_kind
) values (
  'reservation.room_moved_during_stay','reservation_room_moved','reservation',
  'admin.assignment_decider',true,true,'none','cleaningTarget',
  'reservation_room_moved','room'
);

create function private.emit_during_stay_room_move_notifications(
  p_move_event_id uuid,p_actor uuid,p_room uuid,p_cleaning_target uuid,p_at timestamptz
) returns integer language plpgsql security definer set search_path='' as $$
declare recipient record; group_row private.notification_groups; notice_id uuid; emitted integer:=0;
  move_event private.reservation_room_move_events; notification_key text;
begin
  select * into move_event from private.reservation_room_move_events event
    where event.id=p_move_event_id and event.actor_profile_id=p_actor
      and event.from_room_id=p_room and event.mode='DURING_STAY';
  if move_event.id is null then
    raise exception using errcode='23514',message='NOTIFICATION_PROVENANCE_INVALID';
  end if;
  notification_key:='notification:v2:reservation.room_moved_during_stay:reservation:'
    ||move_event.reservation_id::text||':version:'||move_event.reservation_version::text;
  for recipient in select profile.id from public.profiles profile
    where profile.role='admin' and profile.status='active' and not profile.must_change_password
      and profile.id<>p_actor order by profile.id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'notification-group:v1:'||recipient.id::text||':reservation_room_moved:room:'||p_room::text,0));
    select * into group_row from private.notification_groups existing
      where existing.recipient_profile_id=recipient.id
        and existing.group_family='reservation_room_moved'
        and existing.scope_kind='room' and existing.scope_id=p_room
        and p_at>=existing.started_at and p_at<existing.ends_at
      order by existing.started_at desc,existing.id desc limit 1;
    if group_row.id is null then
      insert into private.notification_groups(
        recipient_profile_id,group_family,scope_kind,scope_id,started_at,ends_at
      ) values (recipient.id,'reservation_room_moved','room',p_room,p_at,p_at+interval '10 minutes')
      returning * into group_row;
    end if;
    insert into public.notifications(
      recipient_profile_id,category,title,body,room_id,cleaning_target_id,dedupe_key,
      requires_action,occurred_at,contract_version,actor_profile_id,event_family,
      source_entity_kind,source_entity_id,deep_link_kind,deep_link_entity_id,notification_group_id
    ) values (
      recipient.id,'reservation_room_moved','투숙 중 객실 이동','이동 후 원 객실 청소 계획을 확인해 주세요.',
      p_room,p_cleaning_target,notification_key,
      true,p_at,1,p_actor,'reservation.room_moved_during_stay','reservation',move_event.reservation_id::text,
      'cleaningTarget',p_cleaning_target,group_row.id
    ) on conflict(recipient_profile_id,dedupe_key) where dedupe_key is not null
      do nothing returning id into notice_id;
    if notice_id is null then
      select id into notice_id from public.notifications where recipient_profile_id=recipient.id
        and dedupe_key=notification_key;
    end if;
    insert into private.notification_delivery_outbox(notification_id,event_family,enqueued_at)
      values(notice_id,'reservation.room_moved_during_stay',p_at)
      on conflict(notification_id) do nothing;
    emitted:=emitted+1;
  end loop;
  return emitted;
end
$$;
revoke all on function private.emit_during_stay_room_move_notifications(uuid,uuid,uuid,uuid,timestamptz)
from public,anon,authenticated,service_role;

-- Preserve the fully reviewed Phase B implementation and dispatch only the
-- post-check-in mode to the segment command below.
alter function public.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,
  timestamptz,text,text,text,text
) set schema private;
alter function private.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,
  timestamptz,text,text,text,text
) rename to commit_reservation_room_move_before_stay_segments;

create function public.commit_reservation_room_move(
  p_actor_profile_id uuid,p_reservation_id uuid,p_target_room_id uuid,
  p_expected_reservation_version bigint,p_expected_source_room_version bigint,
  p_expected_target_room_version bigint,p_preview_evaluated_at timestamptz,
  p_preview_expires_at timestamptz,p_effective_at timestamptz,p_impact_fingerprint text,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare
  command_at timestamptz; reservation public.reservations; stay private.reservation_stays;
  source_segment private.stay_room_segments; new_segment private.stay_room_segments;
  source_room public.rooms; target_room public.rooms; obligation public.checkout_cleaning_obligations;
  final_target public.cleaning_targets; source_target public.cleaning_targets;
  room_type public.room_types;
  target_room_type public.room_types; template public.cleaning_template_versions;
  target_template public.cleaning_template_versions; state jsonb; current_state jsonb; response jsonb;
  move_event_id uuid:=gen_random_uuid(); source_target_id uuid:=gen_random_uuid();
  final_target_id uuid:=gen_random_uuid();
  source_obligation_id uuid:=gen_random_uuid(); due_at timestamptz; final_due_at timestamptz; source_version bigint;
  target_version bigint; current_room_id uuid; before_state jsonb; after_state jsonb; immediate boolean;
  previous_rebind_mode text;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  begin
    response:=private.replay_command(p_actor_profile_id,'reservation.room_move',p_idempotency_key,p_request_hash);
  exception when unique_violation then
    if sqlerrm='IDEMPOTENCY_KEY_REUSED' then raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED',
      detail=private.reservation_room_move_conflict_detail(p_reservation_id,null,p_target_room_id); end if;
    raise;
  end;
  if response is not null then return response; end if;
  select * into reservation from public.reservations where id=p_reservation_id;
  if reservation.id is null then raise exception using errcode='P0002',message='RESERVATION_NOT_FOUND'; end if;
  if reservation.actual_check_in_at is null then
    response:=private.commit_reservation_room_move_before_stay_segments(
      p_actor_profile_id,p_reservation_id,p_target_room_id,p_expected_reservation_version,
      p_expected_source_room_version,p_expected_target_room_version,p_preview_evaluated_at,
      p_preview_expires_at,p_effective_at,p_impact_fingerprint,p_reason_code,
      p_idempotency_key,p_request_hash);
    insert into private.reservation_room_move_events(
      reservation_id,stay_id,from_room_id,to_room_id,effective_at,mode,reason_code,
      actor_profile_id,reservation_version,source_room_version,target_room_version,command_key,created_at
    )
    select audit.entity_id,stay_row.id,
      (audit.after_state->>'sourceRoomId')::uuid,(audit.after_state->>'targetRoomId')::uuid,
      revision.check_in_at,'BEFORE_CHECKIN',audit.reason_code,audit.actor_profile_id,
      (audit.after_state->>'reservationVersion')::bigint,
      (audit.after_state->>'sourceRoomVersion')::bigint,
      (audit.after_state->>'targetRoomVersion')::bigint,
      audit.idempotency_key,audit.recorded_at
    from public.audit_events audit
    join private.reservation_stays stay_row on stay_row.reservation_id=audit.entity_id
    join public.reservation_schedule_revisions revision
      on revision.reservation_id=audit.entity_id
      and revision.version=(audit.after_state->>'reservationVersion')::bigint
      and revision.room_id=(audit.after_state->>'targetRoomId')::uuid
    where audit.event_type='reservation.room_moved'
      and audit.entity_type='reservation' and audit.entity_id=p_reservation_id
      and audit.idempotency_key=private.audit_command_key(
        p_actor_profile_id,'reservation.room_move',p_idempotency_key)
    on conflict(command_key) do nothing;
    if not exists(select 1 from private.reservation_room_move_events event
      where event.command_key=private.audit_command_key(
        p_actor_profile_id,'reservation.room_move',p_idempotency_key)
        and event.mode='BEFORE_CHECKIN') then
      raise exception using errcode='23514',message='ROOM_MOVE_EVENT_PROVENANCE_INVALID';
    end if;
    return response;
  end if;

  command_at:=clock_timestamp(); immediate:=p_effective_at<=command_at;
  if p_reason_code not in ('GUEST_REQUEST','ROOM_UNAVAILABLE','OPERATIONAL_ADJUSTMENT') then
    raise exception using errcode='22023',message='INVALID_ROOM_MOVE_REASON'; end if;
  if p_effective_at is null or p_effective_at<command_at or p_effective_at>=reservation.check_out_at then
    raise exception using errcode='22023',message='INVALID_MOVE_EFFECTIVE_AT'; end if;
  if p_impact_fingerprint is null or p_impact_fingerprint!~'^[0-9a-f]{64}$'
    or p_preview_evaluated_at>command_at
    or p_preview_expires_at<>p_preview_evaluated_at+interval '5 minutes' then
    raise exception using errcode='22023',message='ROOM_MOVE_PREVIEW_INVALID'; end if;
  if p_preview_expires_at<=command_at then raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE',
    detail=private.reservation_room_move_conflict_detail(p_reservation_id,null,p_target_room_id); end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into strict reservation from public.reservations where id=p_reservation_id for update;
  select * into strict stay from private.reservation_stays where reservation_id=reservation.id for update;
  select * into strict source_segment from private.stay_segment_at(reservation.id,p_effective_at);
  perform 1 from private.stay_room_segments where id=source_segment.id for update;
  perform 1 from public.rooms room where room.id in(source_segment.room_id,p_target_room_id)
    order by room.id for update;
  select * into strict source_room from public.rooms where id=source_segment.room_id;
  select * into strict target_room from public.rooms where id=p_target_room_id;
  select * into strict obligation from public.checkout_cleaning_obligations
    where id=reservation.checkout_obligation_id for update;
  select * into strict final_target from public.cleaning_targets
    where id=obligation.planned_cleaning_target_id for update;
  perform 1 from public.cleaning_assignments where cleaning_target_id=final_target.id order by id for update;
  perform 1 from public.cleaning_attempts where cleaning_target_id=final_target.id order by id for update;
  perform 1 from public.room_pin_access_leases lease where lease.reservation_id=reservation.id
    order by lease.id for update;

  if source_room.id=p_target_room_id then raise exception using errcode='23514',message='MOVE_ALREADY_APPLIED',
    detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id); end if;
  if reservation.version<>p_expected_reservation_version then raise exception using errcode='40001',message='RESERVATION_VERSION_CONFLICT',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id); end if;
  if source_room.state_version<>p_expected_source_room_version then raise exception using errcode='40001',message='SOURCE_ROOM_VERSION_CONFLICT',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id); end if;
  if target_room.state_version<>p_expected_target_room_version then raise exception using errcode='40001',message='TARGET_ROOM_VERSION_CONFLICT',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id); end if;
  if final_target.status<>'unassigned'
    or exists(select 1 from public.cleaning_assignments assignment
      where assignment.cleaning_target_id=final_target.id and assignment.is_current)
    or exists(select 1 from public.cleaning_attempts attempt
      where attempt.cleaning_target_id=final_target.id and attempt.status<>'superseded')
    or exists(select 1 from public.room_pin_access_leases lease
      where lease.cleaning_target_id=final_target.id) then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;
  state:=private.reservation_room_move_state(reservation.id,p_target_room_id,p_preview_evaluated_at,
    p_preview_expires_at,p_effective_at,p_reason_code);
  if state->>'impactFingerprint'<>p_impact_fingerprint then raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id); end if;
  current_state:=private.reservation_room_move_state(reservation.id,p_target_room_id,command_at,
    command_at+interval '5 minutes',p_effective_at,p_reason_code);
  if not coalesce((current_state->>'eligible')::boolean,false) then
    if (current_state->'rejectionReasonCodes')?'RESERVATION_OVERLAP' then raise exception using errcode='23P01',message='TARGET_ROOM_OVERLAP',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id);
    elsif (current_state->'rejectionReasonCodes')?'TARGET_ROOM_NOT_READY' then raise exception using errcode='23514',message='TARGET_ROOM_NOT_READY',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id);
    elsif (current_state->'rejectionReasonCodes')?'TARGET_ROOM_BLOCKED' then raise exception using errcode='23514',message='TARGET_ROOM_BLOCKED',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id);
    elsif (current_state->'rejectionReasonCodes')?'OPEN_ENDED_STAY_REQUIRES_END' then raise exception using errcode='23514',message='OPEN_ENDED_STAY_REQUIRES_END',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id);
    elsif (current_state->'rejectionReasonCodes')?'INVALID_MOVE_EFFECTIVE_AT' then raise exception using errcode='22023',message='INVALID_MOVE_EFFECTIVE_AT';
    else raise exception using errcode='40001',message='ROOM_CHANGE_PREVIEW_STALE',detail=private.reservation_room_move_conflict_detail(reservation.id,source_room.id,p_target_room_id); end if;
  end if;

  before_state:=jsonb_build_object('mode','DURING_STAY','reservationId',reservation.id,
    'reservationVersion',reservation.version,'sourceRoomId',source_room.id,'targetRoomId',target_room.id,
    'effectiveAt',p_effective_at);
  insert into private.reservation_room_move_events(
    id,reservation_id,stay_id,from_room_id,to_room_id,effective_at,mode,reason_code,
    actor_profile_id,reservation_version,source_room_version,target_room_version,command_key
  ) values(move_event_id,reservation.id,stay.id,source_room.id,target_room.id,p_effective_at,
    'DURING_STAY',p_reason_code,p_actor_profile_id,reservation.version,source_room.state_version,
    target_room.state_version,private.audit_command_key(p_actor_profile_id,'reservation.room_move',p_idempotency_key));
  update private.stay_room_segments set ends_at=p_effective_at,terminal_reason_code='DURING_STAY_ROOM_MOVED',
    version=version+1,updated_at=command_at where id=source_segment.id;
  insert into private.stay_room_segments(
    stay_id,room_id,starts_at,ends_at,source_reservation_id,move_event_id,created_at,updated_at
  ) values(stay.id,target_room.id,p_effective_at,reservation.check_out_at,reservation.id,move_event_id,command_at,command_at)
  returning * into new_segment;

  -- Move the still-private final checkout target first, freeing the source
  -- room's one-active-target slot for the segment checkout work.
  update public.reservations set version=version+1,updated_by=p_actor_profile_id where id=reservation.id
    returning * into reservation;
  update private.reservation_stays set version=version+1,updated_at=command_at where id=stay.id;
  select min(segment.starts_at)-interval '30 minutes' into final_due_at
  from private.stay_room_segments segment where segment.room_id=target_room.id
    and segment.retired_at is null
    and segment.starts_at>=reservation.check_out_at;
  if final_due_at is not null and final_due_at<=reservation.check_out_at then
    raise exception using errcode='23P01',message='TARGET_ROOM_OVERLAP';
  end if;
  select type.* into strict target_room_type
  from public.room_types type where type.id=target_room.room_type_id;
  select version.* into target_template
  from public.cleaning_template_versions version
  where version.room_type_id=target_room.room_type_id
    and version.cleaning_kind='checkout' and version.status='published';
  if target_template.id is null then
    raise exception using errcode='23514',message='CLEANING_TEMPLATE_NOT_CONFIGURED';
  end if;
  -- Photo/template snapshots are immutable once a target exists. Retire the
  -- unused source-room plan and append a target-room plan instead of mutating
  -- encrypted/photo contract history across room types.
  update public.cleaning_targets
  set status='cancelled',cancelled_at=command_at,cancelled_by=p_actor_profile_id,
    cancellation_reason_code='RESERVATION_ROOM_MOVED',
    assignment_version=assignment_version+1,updated_at=command_at
  where id=final_target.id;
  insert into public.cleaning_targets(
    id,room_id,reservation_id,checkout_obligation_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,carryover_count,available_from,due_at,
    status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,
    created_by,created_at,updated_at
  ) values(
    final_target_id,target_room.id,reservation.id,obligation.id,'checkout',final_target.source,
    'reservation-checkout:'||reservation.id::text||':room-move:'||move_event_id::text,
    final_target.original_service_date,final_target.effective_service_date,
    final_target.carryover_count,final_target.available_from,final_due_at,
    'unassigned',1,jsonb_build_object(
      'id',target_room_type.id,'code',target_room_type.code,'name',target_room_type.name,
      'roomNumber',target_room.room_number,'elevatorZone',target_room.elevator_zone,
      'defaultDurationMinutes',target_room_type.default_duration_minutes
    ),target_room_type.base_cleaning_fee,jsonb_build_object(
      'id',target_template.id,'version',target_template.version,
      'durationMinutes',target_template.duration_minutes,
      'photoSlots',target_template.photo_slots
    ),p_actor_profile_id,command_at,command_at
  ) returning * into final_target;
  insert into public.cleaning_target_schedule_revisions(
    cleaning_target_id,revision,effective_service_date,available_from,due_at,
    reason_code,changed_by
  ) values(
    final_target.id,final_target.assignment_version,final_target.effective_service_date,
    final_target.available_from,final_target.due_at,'DURING_STAY_ROOM_MOVE',p_actor_profile_id
  );
  previous_rebind_mode:=coalesce(current_setting('app.checkout_plan_rebind_mode',true),'');
  perform set_config('app.checkout_plan_rebind_mode','stay_room_move_v1',true);
  update public.checkout_cleaning_obligations
    set room_id=target_room.id,planned_cleaning_target_id=final_target.id,
      due_at=final_due_at,version=version+1
    where id=obligation.id returning * into obligation;
  perform set_config('app.checkout_plan_rebind_mode',previous_rebind_mode,true);

  select min(segment.starts_at)-interval '30 minutes' into due_at
  from private.stay_room_segments segment where segment.room_id=source_room.id
    and segment.retired_at is null and segment.starts_at>=p_effective_at;
  if due_at is not null and due_at<=p_effective_at then
    raise exception using errcode='23P01',message='TARGET_ROOM_OVERLAP';
  end if;
  select type.* into strict room_type from public.room_types type where type.id=source_room.room_type_id;
  select version.* into template from public.cleaning_template_versions version
    where version.room_type_id=source_room.room_type_id and version.cleaning_kind='checkout'
      and version.status='published';
  if template.id is null then raise exception using errcode='23514',message='CLEANING_TEMPLATE_NOT_CONFIGURED'; end if;
  insert into private.stay_segment_checkout_obligations(
    id,stay_id,source_segment_id,room_id,cleaning_target_id,effective_service_date,
    available_from,due_at,created_by
  ) values(source_obligation_id,stay.id,source_segment.id,source_room.id,source_target_id,
    (p_effective_at at time zone 'Asia/Seoul')::date,p_effective_at,due_at,p_actor_profile_id);
  insert into public.cleaning_targets(
    id,room_id,reservation_id,stay_segment_checkout_obligation_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,available_from,due_at,room_type_snapshot,
    fee_snapshot,template_snapshot,created_by,created_at,updated_at
  ) values(source_target_id,source_room.id,reservation.id,source_obligation_id,'checkout',
    'stay_room_move_checkout','stay-segment-checkout:'||source_segment.id::text,
    (p_effective_at at time zone 'Asia/Seoul')::date,(p_effective_at at time zone 'Asia/Seoul')::date,
    p_effective_at,due_at,jsonb_build_object('id',room_type.id,'code',room_type.code,'name',room_type.name,
      'roomNumber',source_room.room_number,'elevatorZone',source_room.elevator_zone,
      'defaultDurationMinutes',room_type.default_duration_minutes),room_type.base_cleaning_fee,
    jsonb_build_object('id',template.id,'version',template.version,'durationMinutes',template.duration_minutes,
      'photoSlots',template.photo_slots),p_actor_profile_id,command_at,command_at)
  returning * into source_target;
  insert into public.cleaning_target_schedule_revisions(
    cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by
  ) values(source_target.id,1,source_target.effective_service_date,p_effective_at,due_at,
    'DURING_STAY_ROOM_MOVE',p_actor_profile_id);

  insert into public.reservation_schedule_revisions(
    reservation_id,version,room_id,check_in_at,check_out_at,guest_count,reason_code,actor_profile_id,effective_at
  ) values(reservation.id,reservation.version,target_room.id,reservation.check_in_at,reservation.check_out_at,
    reservation.guest_count,p_reason_code,p_actor_profile_id,p_effective_at);

  if immediate then
    update public.room_pin_access_leases set revoked_at=command_at,revoke_reason_code='RESERVATION_ROOM_MOVED'
    where reservation_id=reservation.id and room_id=source_room.id and revoked_at is null;
  else
    insert into private.room_pin_access_scheduled_revocations(
      lease_id,reservation_id,stay_id,move_event_id,effective_at,reason_code
    ) select lease.id,reservation.id,stay.id,move_event_id,p_effective_at,'RESERVATION_ROOM_MOVED'
      from public.room_pin_access_leases lease
      where lease.reservation_id=reservation.id and lease.room_id=source_room.id
        and lease.revoked_at is null on conflict(lease_id) do nothing;
  end if;
  update public.rooms set state_version=state_version+1 where id in(source_room.id,target_room.id);
  perform private.refresh_checkout_due_at(source_room.id,p_actor_profile_id);
  perform private.refresh_checkout_due_at(target_room.id,p_actor_profile_id);
  select state_version into source_version from public.rooms where id=source_room.id;
  select state_version into target_version from public.rooms where id=target_room.id;
  -- A scheduled move changes the final-room plan immediately, but it does not
  -- change the guest's current room before effectiveAt. Keep the command
  -- response aligned with the same command-time projection used by reads.
  current_room_id:=private.reservation_current_room_at(reservation.id,command_at);
  after_state:=jsonb_build_object('mode','DURING_STAY','reservationId',reservation.id,
    'reservationVersion',reservation.version,'sourceRoomId',source_room.id,'targetRoomId',target_room.id,
    'sourceCleaningTargetId',source_target.id,'effectiveAt',p_effective_at);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,reason_code,before_state,after_state,request_hash,idempotency_key)
  select profile.id,profile.display_name,'reservation.room_moved','reservation',reservation.id,
    p_effective_at,p_reason_code,before_state,after_state,p_request_hash,
    private.audit_command_key(p_actor_profile_id,'reservation.room_move',p_idempotency_key)
  from public.profiles profile where profile.id=p_actor_profile_id;
  perform private.emit_during_stay_room_move_notifications(
    move_event_id,p_actor_profile_id,source_room.id,source_target.id,command_at);
  response:=jsonb_build_object('reservation',private.reservation_response(reservation),'mode','DURING_STAY',
    'evaluatedAt',p_preview_evaluated_at,'expiresAt',p_preview_expires_at,'effectiveAt',p_effective_at,
    'movedAt',command_at,'sourceRoomId',source_room.id,'targetRoomId',target_room.id,
    'sourceRoomVersion',source_version,'targetRoomVersion',target_version,
    'stay',jsonb_build_object('id',stay.id,'version',stay.version+1,'currentRoomId',current_room_id),
    'segments',jsonb_build_array(jsonb_build_object('id',source_segment.id,'roomId',source_room.id,
      'startsAt',source_segment.starts_at,'endsAt',p_effective_at),jsonb_build_object('id',new_segment.id,
      'roomId',target_room.id,'startsAt',p_effective_at,'endsAt',reservation.check_out_at)),
    'sourceCleaningTargetId',source_target.id,'plannedCheckoutTargetId',final_target.id,
    'plannedCheckoutTargetVersion',final_target.assignment_version,
    'pinAccessEndsAt',p_effective_at,'sourceOutcome',private.reservation_room_move_outcome_at(source_room.id,p_effective_at),
    'targetOutcome',private.reservation_room_move_outcome_at(target_room.id,p_effective_at));
  perform private.complete_command(p_actor_profile_id,'reservation.room_move',p_idempotency_key,
    p_request_hash,reservation.id,response);
  return response;
exception when exclusion_violation then
  raise exception using errcode='23P01',message='TARGET_ROOM_OVERLAP',
    detail=private.reservation_room_move_conflict_detail(p_reservation_id,source_segment.room_id,p_target_room_id);
end
$$;
revoke all on function public.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,
  timestamptz,text,text,text,text) from public,anon,authenticated;
grant execute on function public.commit_reservation_room_move(
  uuid,uuid,uuid,bigint,bigint,bigint,timestamptz,timestamptz,
  timestamptz,text,text,text,text) to service_role;

-- Segment checkout work is assignable immediately but executable only once
-- the move boundary has passed. This is the DB backstop for attempt and PIN
-- lease creation, including direct service-role writes.
create or replace function private.guard_checkout_execution()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_table_name='cleaning_attempts' then
    if tg_op='UPDATE' and new.status='superseded' then return new; end if;
    if tg_op='INSERT' and new.status='scheduled' and exists(
      select 1 from public.cleaning_targets target
      where target.id=new.cleaning_target_id
        and target.source='stay_room_move_checkout'
        and target.stay_segment_checkout_obligation_id is not null
    ) then return new; end if;
  elsif tg_table_name='room_pin_access_leases' then
    if tg_op='UPDATE' and new.revoked_at is not null then return new; end if;
    if tg_op='INSERT' and new.revealed_at is null and exists(
      select 1 from public.cleaning_targets target
      where target.id=new.cleaning_target_id
        and target.source='stay_room_move_checkout'
        and target.stay_segment_checkout_obligation_id is not null
    ) then return new; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if exists(select 1 from public.cleaning_targets target
    where target.id=new.cleaning_target_id and target.cleaning_kind='checkout'
      and not (
        (target.stay_segment_checkout_obligation_id is null and exists(
          select 1 from public.checkout_cleaning_obligations obligation
          join public.reservations reservation on reservation.id=obligation.reservation_id
          where obligation.id=target.checkout_obligation_id
            and obligation.current_cleaning_target_id=target.id
            and obligation.status in('materialized','completed')
            and reservation.status='checked_out' and reservation.actual_checkout_at<=clock_timestamp()
            and target.available_from<=clock_timestamp()))
        or (target.stay_segment_checkout_obligation_id is not null and exists(
          select 1 from private.stay_segment_checkout_obligations obligation
          where obligation.id=target.stay_segment_checkout_obligation_id
            and obligation.cleaning_target_id=target.id
            and obligation.status in('materialized','completed')
            and obligation.available_from<=clock_timestamp()
            and target.available_from<=clock_timestamp()))
      )) then raise exception using errcode='23514',message='CHECKOUT_NOT_MATERIALIZED'; end if;
  return new;
end
$$;

alter function private.activation_reason_at(
  public.cleaning_targets,public.cleaning_assignments,timestamptz
) rename to activation_reason_at_before_stay_segments;
create function private.activation_reason_at(
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
        and p_target.due_at is not null and segment.ends_at>=p_target.due_at
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

alter function private.finalize_submission_inspection(uuid,uuid,text,text,text,text)
rename to finalize_submission_inspection_before_stay_segments;
create function private.finalize_submission_inspection(
  p_actor_profile_id uuid,p_submission_id uuid,p_decision text,p_reason_code text,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; target public.cleaning_targets; submission public.cleaning_submissions;
begin
  select s.* into submission from public.cleaning_submissions s where s.id=p_submission_id;
  select t.* into target from public.cleaning_targets t
    join public.cleaning_attempts attempt on attempt.cleaning_target_id=t.id
    where attempt.id=submission.cleaning_attempt_id;
  result:=private.finalize_submission_inspection_before_stay_segments(
    p_actor_profile_id,p_submission_id,p_decision,p_reason_code,p_idempotency_key,p_request_hash);
  if p_decision='approved' and target.stay_segment_checkout_obligation_id is not null then
    update private.stay_segment_checkout_obligations set status='completed',
      completion_submission_id=p_submission_id,completed_at=clock_timestamp(),version=version+1
    where id=target.stay_segment_checkout_obligation_id and status='materialized';
    if not found and not exists(select 1 from private.stay_segment_checkout_obligations
      where id=target.stay_segment_checkout_obligation_id and status='completed'
        and completion_submission_id=p_submission_id) then
      raise exception using errcode='55000',message='INSPECTION_INVALID_TRANSITION';
    end if;
  end if;
  return result;
end
$$;
revoke all on function private.finalize_submission_inspection(uuid,uuid,text,text,text,text)
from public,anon,authenticated,service_role;

create or replace function private.refresh_checkout_due_at(
  p_room_id uuid,p_actor_profile_id uuid
) returns void language plpgsql security definer set search_path=pg_catalog,public,private as $$
declare item record; target public.cleaning_targets; desired timestamptz;
begin
  for item in select obligation.*,stay.id as stay_id
    from public.checkout_cleaning_obligations obligation
    join private.reservation_stays stay on stay.reservation_id=obligation.reservation_id
    where obligation.room_id=p_room_id and obligation.status in('private','available','materialized')
    order by obligation.available_from,obligation.id
  loop
    select min(segment.starts_at)-interval '30 minutes' into desired
    from private.stay_room_segments segment
    where segment.room_id=p_room_id and segment.retired_at is null
      and segment.starts_at>=item.available_from;
    if item.due_at is not distinct from desired then continue; end if;
    select * into target from public.cleaning_targets
      where id=coalesce(item.current_cleaning_target_id,item.planned_cleaning_target_id) for update;
    if target.id is not null then
      if target.status in('approved','cancelled') then continue; end if;
      if target.status not in('unassigned','draft_assigned')
        or exists(select 1 from public.cleaning_assignments assignment
          where assignment.cleaning_target_id=target.id and assignment.is_current
            and assignment.notified_at is not null) then
        raise exception using errcode='23514',message='CLEANING_DUE_REPLAN_REQUIRED';
      end if;
      update public.cleaning_targets set due_at=desired,assignment_version=assignment_version+1
        where id=target.id returning * into target;
      insert into public.cleaning_target_schedule_revisions(
        cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by
      ) values(target.id,target.assignment_version,target.effective_service_date,target.available_from,
        target.due_at,'NEXT_RESERVATION_CHANGED',p_actor_profile_id);
    end if;
    update public.checkout_cleaning_obligations set due_at=desired,version=version+1
      where id=item.id;
  end loop;
  for item in
    select obligation.*,stay.id as stay_id
    from private.stay_segment_checkout_obligations obligation
    join private.reservation_stays stay on stay.id=obligation.stay_id
    where obligation.room_id=p_room_id
      and obligation.status='materialized'
    order by obligation.available_from,obligation.id
  loop
    select min(segment.starts_at)-interval '30 minutes' into desired
    from private.stay_room_segments segment
    where segment.room_id=p_room_id and segment.retired_at is null
      and segment.starts_at>=item.available_from;
    if item.due_at is not distinct from desired then continue; end if;
    select * into target from public.cleaning_targets
    where id=item.cleaning_target_id for update;
    if target.id is null or target.status in('approved','cancelled') then continue; end if;
    if target.status not in('unassigned','draft_assigned')
      or exists(select 1 from public.cleaning_assignments assignment
        where assignment.cleaning_target_id=target.id and assignment.is_current
          and assignment.notified_at is not null) then
      raise exception using errcode='23514',message='CLEANING_DUE_REPLAN_REQUIRED';
    end if;
    update public.cleaning_targets
    set due_at=desired,assignment_version=assignment_version+1
    where id=target.id returning * into target;
    insert into public.cleaning_target_schedule_revisions(
      cleaning_target_id,revision,effective_service_date,available_from,due_at,
      reason_code,changed_by
    ) values(
      target.id,target.assignment_version,target.effective_service_date,
      target.available_from,target.due_at,'NEXT_RESERVATION_CHANGED',p_actor_profile_id
    );
    update private.stay_segment_checkout_obligations
    set due_at=desired,version=version+1 where id=item.id;
  end loop;
end
$$;
revoke all on function private.refresh_checkout_due_at(uuid,uuid)
from public,anon,authenticated,service_role;

-- Assignment preview/commit use the same segment provenance as execution.
-- Preserve the reviewed pre-segment rules for every other target shape.
alter function private.assignment_preview_source_reason(
  public.cleaning_targets,integer,timestamptz
) rename to assignment_preview_source_reason_before_stay_segments;
create function private.assignment_preview_source_reason(
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
          and segment.starts_at<=p_target.available_from and segment.ends_at>=p_target.due_at
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

alter function private.assignment_commit_candidates_at(date,timestamptz)
rename to assignment_commit_candidates_at_before_stay_segments;
create function private.assignment_commit_candidates_at(
  p_service_date date,p_command_at timestamptz
) returns table(
  target_id uuid,room_id uuid,room_number text,target_assignment_version bigint,
  target_status public.cleaning_target_status,target_available_from timestamptz,
  target_due_at timestamptz,assignment_id uuid,maid_profile_id uuid,
  maid_display_name text,assignment_service_date date,sequence_number integer,
  assignment_revision bigint,assignment_available_from timestamptz,
  assignment_due_at timestamptz,assignment_notified_at timestamptz,
  availability_version integer,availability_day_available boolean,reason_code text
) language sql stable security definer set search_path='' as $$
  select candidate.target_id,candidate.room_id,candidate.room_number,
    candidate.target_assignment_version,candidate.target_status,
    candidate.target_available_from,candidate.target_due_at,candidate.assignment_id,
    candidate.maid_profile_id,candidate.maid_display_name,candidate.assignment_service_date,
    candidate.sequence_number,candidate.assignment_revision,
    candidate.assignment_available_from,candidate.assignment_due_at,
    candidate.assignment_notified_at,candidate.availability_version,
    candidate.availability_day_available,
    case
      when candidate.reason_code='ASSIGNMENT_WINDOW_EXPIRED'
        then candidate.reason_code
      when target.source in(
        'stay_room_move_checkout','scheduled_checkout','manual_checkout',
        'stayover_request','manual_room_request'
      ) and private.assignment_preview_source_reason(
        target,case when target.due_at is null
          then nullif(target.template_snapshot->>'durationMinutes','')::integer else null end,
        p_command_at
      ) is not null then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source in(
        'stay_room_move_checkout','scheduled_checkout','manual_checkout',
        'stayover_request','manual_room_request'
      ) and candidate.reason_code='ASSIGNMENT_COMMIT_NOT_ALLOWED'
      and candidate.target_status='draft_assigned'
      and candidate.assignment_id is not null and candidate.assignment_notified_at is null
      and candidate.assignment_revision=candidate.target_assignment_version
      and candidate.assignment_service_date=p_service_date
      and candidate.assignment_service_date=target.effective_service_date
      and candidate.assignment_available_from is not distinct from target.available_from
      and candidate.assignment_due_at is not distinct from target.due_at
      and candidate.maid_profile_id is not null
      and candidate.availability_version is not null
      and candidate.availability_day_available is true
      and (target.due_at is null or target.due_at>p_command_at)
      and not exists(select 1 from public.cleaning_attempts attempt
        where attempt.cleaning_target_id=target.id and private.attempt_blocks_assignment(attempt))
      and exists(select 1 from public.profiles maid where maid.id=candidate.maid_profile_id
        and maid.role='maid' and maid.status='active')
      and private.assignment_preview_source_reason(
        target,case when target.due_at is null
          then nullif(target.template_snapshot->>'durationMinutes','')::integer else null end,
        p_command_at
      ) is null
      then null else candidate.reason_code end
  from private.assignment_commit_candidates_at_before_stay_segments(
    p_service_date,p_command_at) candidate
  join public.cleaning_targets target on target.id=candidate.target_id
$$;
revoke all on function private.assignment_commit_candidates_at(date,timestamptz)
from public,anon,authenticated,service_role;

create or replace function private.assert_handover_schedule(
  p_target public.cleaning_targets,p_date date,p_from timestamptz,p_due timestamptz
) returns void language plpgsql stable security definer set search_path='' as $$
declare v_reservation public.reservations; v_next_in timestamptz;
begin
  if p_date is null or p_from is null or p_due is null or p_from>=p_due
    or (p_from at time zone 'Asia/Seoul')::date<>p_date
    or p_due>(p_date+1)::timestamp at time zone 'Asia/Seoul' then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
  end if;
  if p_target.cleaning_kind='checkout'
    and p_target.source in('scheduled_checkout','manual_checkout','stay_room_move_checkout') then
    select * into v_reservation from public.reservations reservation
    where reservation.id=p_target.reservation_id;
    if v_reservation.id is null then
      raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED';
    end if;
    if p_target.source='stay_room_move_checkout' then
      if not exists(select 1 from private.stay_segment_checkout_obligations obligation
        where obligation.id=p_target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=p_target.id
          and obligation.room_id=p_target.room_id
          and obligation.status in('materialized','completed')
          and obligation.available_from<=p_from) then
        raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED';
      end if;
    elsif v_reservation.status<>'checked_out' or v_reservation.actual_checkout_at is null
      or p_from<v_reservation.actual_checkout_at
      or p_target.room_id<>private.reservation_final_room_id(v_reservation.id)
      or not exists(select 1 from public.checkout_cleaning_obligations obligation
        where obligation.id=p_target.checkout_obligation_id
          and obligation.reservation_id=v_reservation.id
          and obligation.room_id=p_target.room_id
          and obligation.planned_cleaning_target_id=p_target.id
          and obligation.current_cleaning_target_id=p_target.id
          and obligation.status in('materialized','completed')) then
      raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED';
    end if;
    select min(segment.starts_at) into v_next_in
    from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    where segment.room_id=p_target.room_id and segment.retired_at is null
      and stay.status in('scheduled','active') and segment.starts_at>=p_from;
    if v_next_in is not null and p_due>v_next_in-interval '30 minutes' then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
    end if;
  elsif p_target.cleaning_kind='stayover' and p_target.source='stayover_request' then
    if not exists(select 1 from private.reservation_stays stay
      join private.stay_room_segments segment on segment.stay_id=stay.id
      join public.reservations reservation on reservation.id=stay.reservation_id
      where reservation.id=p_target.reservation_id and reservation.status='active'
        and reservation.actual_check_in_at is not null and reservation.actual_checkout_at is null
        and segment.room_id=p_target.room_id and segment.retired_at is null
        and segment.starts_at<=p_from and segment.ends_at>=p_due) then
      raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
    end if;
  elsif not (p_target.cleaning_kind='additional' and p_target.source='manual_room_request') then
    raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE';
  end if;
  if p_target.cleaning_kind in('checkout','additional') and exists(
    select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    where segment.room_id=p_target.room_id and segment.retired_at is null
      and stay.status in('scheduled','active')
      and tstzrange(segment.starts_at,segment.ends_at,'[)')
        &&tstzrange(p_from,p_due,'[)')
  ) then raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
end
$$;
revoke all on function private.assert_handover_schedule(
  public.cleaning_targets,date,timestamptz,timestamptz
) from public,anon,authenticated,service_role;

create or replace function private.assert_expired_attempt_replan(
  p_target public.cleaning_targets,p_maid uuid
) returns void language plpgsql stable security definer set search_path='' as $$
declare v_next_date date:=p_target.effective_service_date+1;
  v_next_from timestamptz:=p_target.available_from+interval '1 day';
  v_next_due timestamptz:=p_target.due_at+interval '1 day';
  v_reservation public.reservations;
begin
  if v_next_from is null or (v_next_from at time zone 'Asia/Seoul')::date<>v_next_date
    or (v_next_due is not null and (v_next_due<=v_next_from
      or v_next_due>(v_next_date+1)::timestamp at time zone 'Asia/Seoul')) then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
  end if;
  if p_target.cleaning_kind='reclean' and p_target.source in(
    'inspection_reclean','post_approval_complaint_reclean'
  ) then
    if p_target.reclean_maid_profile_id is distinct from p_maid
      or (p_target.source='inspection_reclean' and p_target.fee_snapshot<>0)
      or not exists(select 1 from public.cleaning_attempts attempt
        where attempt.id=p_target.reclean_of_attempt_id
          and attempt.status='rejected') then
      raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE';
    end if;
  elsif v_next_due is not null then
    perform private.assert_handover_schedule(p_target,v_next_date,v_next_from,v_next_due);
    return;
  elsif p_target.cleaning_kind='checkout'
    and p_target.source in('scheduled_checkout','manual_checkout','stay_room_move_checkout') then
    select * into v_reservation from public.reservations reservation
    where reservation.id=p_target.reservation_id;
    if p_target.source='stay_room_move_checkout' then
      if not exists(select 1 from private.stay_segment_checkout_obligations obligation
        where obligation.id=p_target.stay_segment_checkout_obligation_id
          and obligation.cleaning_target_id=p_target.id
          and obligation.status in('materialized','completed')
          and obligation.available_from<=v_next_from) then
        raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED';
      end if;
    elsif v_reservation.id is null or v_reservation.status<>'checked_out'
      or v_reservation.actual_checkout_at is null or v_next_from<v_reservation.actual_checkout_at
      or p_target.room_id<>private.reservation_final_room_id(v_reservation.id)
      or not exists(select 1 from public.checkout_cleaning_obligations obligation
        where obligation.id=p_target.checkout_obligation_id
          and obligation.planned_cleaning_target_id=p_target.id
          and obligation.current_cleaning_target_id=p_target.id
          and obligation.reservation_id=v_reservation.id
          and obligation.status in('materialized','completed')) then
      raise exception using errcode='55000',message='CHECKOUT_NOT_MATERIALIZED';
    end if;
  elsif not (p_target.cleaning_kind='additional' and p_target.source='manual_room_request') then
    raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID';
  end if;
  if exists(select 1 from private.stay_room_segments segment
    join private.reservation_stays stay on stay.id=segment.stay_id
    where segment.room_id=p_target.room_id and segment.retired_at is null
      and stay.status in('scheduled','active')
      and tstzrange(segment.starts_at,segment.ends_at,'[)')
        &&tstzrange(v_next_from,coalesce(v_next_due,'infinity'::timestamptz),'[)'))
    or (p_target.cleaning_kind in('checkout','reclean') and exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=p_target.room_id and segment.retired_at is null
        and stay.status in('scheduled','active')
        and segment.starts_at>=v_next_from
        and (v_next_due is null or v_next_due>segment.starts_at-interval '30 minutes')
    )) then raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
end
$$;
revoke all on function private.assert_expired_attempt_replan(
  public.cleaning_targets,uuid
) from public,anon,authenticated,service_role;

-- Manual cleaning requests must validate the room occupied by the bounded
-- segment, not the reservation's historical check-in room.
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
          and segment.ends_at>=p_due_at
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
      and stay.actual_checkout_at is null and stay.scheduled_check_out_at<=p_available_from
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

-- Checkout and post-check-in schedule commands are redefined below against
-- derived stay-segment rooms; reservations.room_id is never projected or mutated.
-- All read projections derive the operational room from the stay ledger while
-- reservations.room_id remains the immutable check-in contract room.
create function private.reservation_projected_room_id(
  p_reservation public.reservations,p_at timestamptz
) returns uuid language sql stable security definer set search_path='' as $$
  select coalesce(
    (select segment.room_id from private.reservation_stays stay
      join private.stay_room_segments segment on segment.stay_id=stay.id
      where stay.reservation_id=p_reservation.id and segment.retired_at is null
        and segment.starts_at<=p_at and segment.ends_at>p_at
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

create or replace function public.list_reservations(
  p_actor_profile_id uuid,p_room_id uuid default null
) returns setof public.reservations language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare source public.reservations; projected public.reservations; projected_room uuid;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  for source in select reservation.* from public.reservations reservation
    order by reservation.check_in_at,reservation.id
  loop
    projected_room:=private.reservation_projected_room_id(source,clock_timestamp());
    if p_room_id is null or projected_room=p_room_id then
      projected:=source; projected.room_id:=projected_room; return next projected;
    end if;
  end loop;
end
$$;
revoke all on function public.list_reservations(uuid,uuid) from public,anon,authenticated;
grant execute on function public.list_reservations(uuid,uuid) to service_role;

create or replace function public.get_reservation_detail(
  p_actor_profile_id uuid,p_reservation_id uuid
) returns setof public.reservations language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare source public.reservations; projected public.reservations;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  select * into source from public.reservations where id=p_reservation_id;
  if source.id is not null then
    projected:=source;
    projected.room_id:=private.reservation_projected_room_id(source,clock_timestamp());
    return next projected;
  end if;
end
$$;
revoke all on function public.get_reservation_detail(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_reservation_detail(uuid,uuid) to service_role;

-- When a checkout is moved to or before a not-yet-effective room move, keep
-- the immutable move event but retire its unrealized segment/work. The final
-- checkout contract is atomically rebound to the room actually occupied just
-- before the new checkout boundary.
create function private.invalidate_future_stay_moves_at(
  p_reservation_id uuid,
  p_checkout_at timestamptz,
  p_actor_profile_id uuid,
  p_reason_code text
) returns uuid language plpgsql security definer
set search_path=pg_catalog,public,private as $$
declare
  v_stay private.reservation_stays;
  v_current private.stay_room_segments;
  v_obligation public.checkout_cleaning_obligations;
  v_target public.cleaning_targets;
  v_room public.rooms;
  v_type public.room_types;
  v_template public.cleaning_template_versions;
  v_final_assignment public.cleaning_assignments;
  v_source_assignment record;
  v_due_at timestamptz;
  v_new_target_id uuid:=gen_random_uuid();
  v_now timestamptz:=clock_timestamp();
  v_previous_rebind_mode text;
begin
  select * into strict v_stay
  from private.reservation_stays stay
  where stay.reservation_id=p_reservation_id
  for update;
  if not exists(
    select 1 from private.stay_room_segments segment
    where segment.stay_id=v_stay.id and segment.retired_at is null
      and segment.move_event_id is not null and segment.starts_at>=p_checkout_at
  ) then
    return private.reservation_final_room_id(p_reservation_id);
  end if;

  select * into strict v_current
  from private.stay_room_segments segment
  where segment.stay_id=v_stay.id and segment.retired_at is null
    and segment.starts_at<=p_checkout_at-interval '1 microsecond'
    and segment.ends_at>p_checkout_at-interval '1 microsecond'
  order by segment.starts_at desc,segment.id desc
  limit 1 for update;

  perform 1 from private.stay_room_segments segment
  where segment.stay_id=v_stay.id and segment.retired_at is null
  order by segment.starts_at,segment.id for update;

  -- A future segment cleanup may already be notified, but it cannot have
  -- started. Scheduled attempts and unrevealed access are reversible and are
  -- closed below; any irreversible execution/exposure is fail-closed.
  perform 1
  from private.stay_segment_checkout_obligations segment_obligation
  join public.cleaning_attempts attempt
    on attempt.cleaning_target_id=segment_obligation.cleaning_target_id
  where segment_obligation.stay_id=v_stay.id
    and segment_obligation.status='materialized'
    and segment_obligation.available_from>=p_checkout_at
    and attempt.status not in('scheduled','superseded')
  for update of attempt;
  if found then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;
  perform 1
  from private.stay_segment_checkout_obligations segment_obligation
  join public.room_pin_access_leases lease
    on lease.cleaning_target_id=segment_obligation.cleaning_target_id
  where segment_obligation.stay_id=v_stay.id
    and segment_obligation.status='materialized'
    and segment_obligation.available_from>=p_checkout_at
    and lease.revoked_at is null and lease.revealed_at is not null
  for update of lease;
  if found then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;

  -- Cancel move-boundary cleanup that has not become effective. The work
  -- history remains append-only; only current pointers/statuses are closed.
  for v_source_assignment in
    select assignment.*,target.room_id,target.id as target_id
    from private.stay_segment_checkout_obligations segment_obligation
    join public.cleaning_targets target
      on target.id=segment_obligation.cleaning_target_id
    join public.cleaning_assignments assignment
      on assignment.cleaning_target_id=target.id and assignment.is_current
    where segment_obligation.stay_id=v_stay.id
      and segment_obligation.status='materialized'
      and segment_obligation.available_from>=p_checkout_at
      and assignment.notified_at is not null
  loop
    if exists(select 1 from public.notifications notice
      where notice.event_family='assignment.commit_notified'
        and notice.source_entity_kind='cleaning_assignment'
        and notice.source_entity_id=v_source_assignment.id::text
        and notice.resolved_at is null) then
      perform private.resolve_notifications_v1(
        'assignment.commit_notified','cleaning_assignment',
        v_source_assignment.id::text,v_now
      );
    end if;
    perform private.emit_notification_v1(
      'reservation.extension_revoked',p_actor_profile_id,
      v_source_assignment.maid_profile_id,'cleaning_assignment',
      v_source_assignment.id::text,'청소 배정이 회수되었습니다',
      '객실 이동 계획이 퇴실 일정 변경으로 취소되어 배정이 회수되었습니다.',
      v_source_assignment.room_id,v_source_assignment.target_id,
      v_source_assignment.target_id,v_now
    );
  end loop;

  update public.cleaning_assignments assignment
  set is_current=false,ended_at=v_now,
    change_reason_code='RESERVATION_SCHEDULE_CHANGED'
  from private.stay_segment_checkout_obligations segment_obligation
  where segment_obligation.stay_id=v_stay.id
    and segment_obligation.status='materialized'
    and segment_obligation.available_from>=p_checkout_at
    and assignment.cleaning_target_id=segment_obligation.cleaning_target_id
    and assignment.is_current;

  update public.cleaning_attempts attempt
  set status='superseded',ended_at=v_now,
    end_reason='RESERVATION_SCHEDULE_CHANGED',updated_at=v_now
  from private.stay_segment_checkout_obligations segment_obligation
  where segment_obligation.stay_id=v_stay.id
    and segment_obligation.status='materialized'
    and segment_obligation.available_from>=p_checkout_at
    and attempt.cleaning_target_id=segment_obligation.cleaning_target_id
    and attempt.status='scheduled';

  update public.room_pin_access_leases lease
  set revoked_at=v_now,revoke_reason_code='RESERVATION_SCHEDULE_CHANGED'
  from private.stay_segment_checkout_obligations segment_obligation
  where segment_obligation.stay_id=v_stay.id
    and segment_obligation.status='materialized'
    and segment_obligation.available_from>=p_checkout_at
    and lease.cleaning_target_id=segment_obligation.cleaning_target_id
    and lease.revoked_at is null and lease.revealed_at is null;

  update public.cleaning_targets target
  set status='cancelled',assignment_version=assignment_version+1,updated_at=v_now
  from private.stay_segment_checkout_obligations segment_obligation
  where segment_obligation.stay_id=v_stay.id
    and segment_obligation.status='materialized'
    and segment_obligation.available_from>=p_checkout_at
    and target.id=segment_obligation.cleaning_target_id
    and target.status not in('approved','cancelled');

  update private.stay_segment_checkout_obligations
  set status='cancelled',version=version+1
  where stay_id=v_stay.id and status='materialized'
    and available_from>=p_checkout_at;

  update private.stay_room_segments
  set retired_at=v_now,terminal_reason_code='FUTURE_MOVE_INVALIDATED',
    version=version+1,updated_at=v_now
  where stay_id=v_stay.id and retired_at is null
    and move_event_id is not null and starts_at>=p_checkout_at;

  if v_current.ends_at is distinct from p_checkout_at
    or v_current.terminal_reason_code is distinct from p_reason_code then
    update private.stay_room_segments
    set ends_at=p_checkout_at,terminal_reason_code=p_reason_code,
      version=version+1,updated_at=v_now
    where id=v_current.id
    returning * into v_current;
  end if;

  select * into strict v_obligation
  from public.checkout_cleaning_obligations obligation
  where obligation.reservation_id=p_reservation_id
  for update;
  select * into strict v_target
  from public.cleaning_targets target
  where target.id=v_obligation.planned_cleaning_target_id
  for update;
  select * into v_final_assignment
  from public.cleaning_assignments assignment
  where assignment.cleaning_target_id=v_target.id and assignment.is_current
  for update;
  if v_final_assignment.id is not null
    or exists(select 1 from public.cleaning_attempts attempt
      where attempt.cleaning_target_id=v_target.id
        and attempt.status<>'superseded')
    or exists(select 1 from public.room_pin_access_leases lease
      where lease.cleaning_target_id=v_target.id)
    or exists(select 1 from private.offline_work_leases offline
      join public.cleaning_attempts attempt on attempt.id=offline.attempt_id
      where attempt.cleaning_target_id=v_target.id) then
    raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
  end if;
  select * into strict v_room from public.rooms room
  where room.id=v_current.room_id for update;
  select * into strict v_type from public.room_types type
  where type.id=v_room.room_type_id;
  select version.* into v_template
  from public.cleaning_template_versions version
  where version.room_type_id=v_room.room_type_id
    and version.cleaning_kind='checkout' and version.status='published';
  if v_template.id is null then
    raise exception using errcode='23514',message='CLEANING_TEMPLATE_NOT_CONFIGURED';
  end if;
  select min(segment.starts_at)-interval '30 minutes' into v_due_at
  from private.stay_room_segments segment
  where segment.room_id=v_room.id and segment.retired_at is null
    and segment.stay_id<>v_stay.id and segment.starts_at>=p_checkout_at;
  if v_due_at is not null and v_due_at<=p_checkout_at then
    raise exception using errcode='23P01',message='RESERVATION_OVERLAP';
  end if;

  update public.cleaning_targets
  set status='cancelled',cancelled_at=v_now,cancelled_by=p_actor_profile_id,
    cancellation_reason_code=p_reason_code,
    assignment_version=assignment_version+1,updated_at=v_now
  where id=v_target.id;
  insert into public.cleaning_targets(
    id,room_id,reservation_id,checkout_obligation_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,carryover_count,available_from,due_at,
    status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,
    created_by,created_at,updated_at
  ) values(
    v_new_target_id,v_room.id,p_reservation_id,v_obligation.id,'checkout',v_target.source,
    'reservation-checkout:'||p_reservation_id::text||':future-invalidation:'||v_target.id::text,
    v_target.original_service_date,(p_checkout_at at time zone 'Asia/Seoul')::date,
    v_target.carryover_count,p_checkout_at,v_due_at,'unassigned',1,
    jsonb_build_object(
      'id',v_type.id,'code',v_type.code,'name',v_type.name,
      'roomNumber',v_room.room_number,'elevatorZone',v_room.elevator_zone,
      'defaultDurationMinutes',v_type.default_duration_minutes
    ),v_type.base_cleaning_fee,jsonb_build_object(
      'id',v_template.id,'version',v_template.version,
      'durationMinutes',v_template.duration_minutes,'photoSlots',v_template.photo_slots
    ),p_actor_profile_id,v_now,v_now
  ) returning * into v_target;

  insert into public.cleaning_target_schedule_revisions(
    cleaning_target_id,revision,effective_service_date,available_from,due_at,
    reason_code,changed_by
  ) values(
    v_target.id,v_target.assignment_version,v_target.effective_service_date,
    v_target.available_from,v_target.due_at,p_reason_code,p_actor_profile_id
  );

  v_previous_rebind_mode:=coalesce(current_setting('app.checkout_plan_rebind_mode',true),'');
  perform set_config('app.checkout_plan_rebind_mode','stay_room_move_v1',true);
  update public.checkout_cleaning_obligations
  set room_id=v_room.id,planned_cleaning_target_id=v_target.id,
    effective_service_date=(p_checkout_at at time zone 'Asia/Seoul')::date,
    available_from=p_checkout_at,due_at=v_due_at,version=version+1
  where id=v_obligation.id;
  perform set_config('app.checkout_plan_rebind_mode',v_previous_rebind_mode,true);

  update public.rooms set state_version=state_version+1
  where id=v_room.id or id in(
    select segment.room_id from private.stay_room_segments segment
    where segment.stay_id=v_stay.id and segment.retired_at=v_now
  );
  return v_room.id;
end
$$;
revoke all on function private.invalidate_future_stay_moves_at(uuid,timestamptz,uuid,text)
from public,anon,authenticated,service_role;

-- Manual and scheduled checkout bodies below preserve the complete reviewed
-- v61 side-effect contract and substitute only the derived operational room.
create or replace function public.manual_checkout_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_expected_version bigint,
  p_reason_code text,
  p_effective_at timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_obligation public.checkout_cleaning_obligations%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_attempt public.cleaning_attempts%rowtype;
  v_new_assignment_id uuid;
  v_new_attempt_id uuid;
  v_current_pin_version bigint;
  v_current_pin_status text;
  v_operational_room_id uuid;
  v_before jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.manual_checkout',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;
  if v_reservation.status <> 'active'
    or v_reservation.actual_check_in_at is null
    or v_reservation.actual_checkout_at is not null
    or p_effective_at >= v_reservation.check_out_at
    or p_effective_at < v_reservation.actual_check_in_at then
    raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_NOT_ALLOWED';
  end if;

  if exists(
    select 1 from private.reservation_stays stay
    join private.stay_room_segments segment on segment.stay_id=stay.id
    where stay.reservation_id=v_reservation.id and segment.retired_at is null
      and segment.move_event_id is not null and segment.starts_at>=p_effective_at
  ) then
    v_operational_room_id:=private.invalidate_future_stay_moves_at(
      v_reservation.id,p_effective_at,p_actor_profile_id,'MANUAL_CHECKOUT'
    );
  else
    v_operational_room_id := private.reservation_current_room_at(
      v_reservation.id, p_effective_at - interval '1 microsecond'
    );
  end if;
  if v_operational_room_id is null then
    raise exception using errcode = '23514', message = 'STAY_SEGMENT_CONTRACT_MISMATCH';
  end if;
  perform 1 from public.rooms where id = v_operational_room_id for update;
  select * into v_obligation
  from public.checkout_cleaning_obligations
  where reservation_id = v_reservation.id
  for update;
  if v_obligation.id is null or v_obligation.room_id is distinct from v_operational_room_id then
    raise exception using errcode = '23514', message = 'STAY_SEGMENT_CONTRACT_MISMATCH';
  end if;

  if exists (
    select 1
    from public.cleaning_targets t
    join public.cleaning_assignments ca
      on ca.cleaning_target_id = t.id
      and ca.is_current
    join public.cleaning_attempts a
      on a.cleaning_target_id = t.id
      and a.assignment_id = ca.id
    where t.id in(
        v_obligation.planned_cleaning_target_id,
        v_obligation.current_cleaning_target_id
      )
      and a.status <> 'superseded'
      and (a.started_at is not null or a.status <> 'scheduled')
  ) or exists (
    select 1
    from public.room_pin_access_leases l
    where l.reservation_id = v_reservation.id
      and l.room_id=v_operational_room_id
      and l.cleaning_target_id in(
        v_obligation.planned_cleaning_target_id,
        v_obligation.current_cleaning_target_id
      )
      and l.revealed_at is not null
      and l.revoked_at is null
      and not exists(
        select 1 from private.room_pin_access_scheduled_revocations scheduled
        where scheduled.lease_id=l.id and scheduled.effective_at<=p_effective_at
      )
  ) then
    raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_ACCESS_CONFLICT';
  end if;

  if v_obligation.current_cleaning_target_id is not null then
    select * into v_assignment
    from public.cleaning_assignments a
    where a.cleaning_target_id = v_obligation.current_cleaning_target_id
      and a.is_current
    for update;

    select * into v_attempt
    from public.cleaning_attempts a
    where a.cleaning_target_id = v_obligation.current_cleaning_target_id
      and a.status = 'scheduled'
    order by a.attempt_number desc
    limit 1
    for update;
  end if;

  v_before := private.reservation_response(v_reservation);

  update public.reservations
  set status = 'checked_out',
      actual_checkout_at = p_effective_at,
      version = version + 1,
      updated_by = p_actor_profile_id
  where id = v_reservation.id
  returning * into v_updated;

  update public.checkout_cleaning_obligations
  set status = case
        when current_cleaning_target_id is null then 'available'::public.checkout_obligation_status
        else 'materialized'::public.checkout_obligation_status
      end,
      available_from = p_effective_at,
      effective_service_date = (p_effective_at at time zone 'Asia/Seoul')::date,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.cleaning_targets
  set available_from = p_effective_at,
      effective_service_date = (p_effective_at at time zone 'Asia/Seoul')::date,
      assignment_version = assignment_version + 1
  where id = v_obligation.current_cleaning_target_id
    and status in ('unassigned', 'draft_assigned', 'notified');

  insert into public.cleaning_target_schedule_revisions (
    cleaning_target_id,
    revision,
    effective_service_date,
    available_from,
    due_at,
    reason_code,
    changed_by
  )
  select
    t.id,
    t.assignment_version,
    t.effective_service_date,
    t.available_from,
    t.due_at,
    'MANUAL_CHECKOUT',
    p_actor_profile_id
  from public.cleaning_targets t
  where t.id = v_obligation.current_cleaning_target_id
    and t.status in ('unassigned', 'draft_assigned', 'notified');

  if v_assignment.id is not null then
    update public.cleaning_assignments
    set is_current = false,
        ended_at = p_effective_at,
        change_reason_code = 'MANUAL_CHECKOUT_RESCHEDULE'
    where id = v_assignment.id;

    v_new_assignment_id := gen_random_uuid();
    insert into public.cleaning_assignments (
      id,
      cleaning_target_id,
      maid_profile_id,
      sequence_number,
      revision,
      is_current,
      notified_at,
      changed_by
    ) values (
      v_new_assignment_id,
      v_assignment.cleaning_target_id,
      v_assignment.maid_profile_id,
      v_assignment.sequence_number,
      v_assignment.revision + 1,
      true,
      case when v_assignment.notified_at is null then null else p_effective_at end,
      p_actor_profile_id
    );

    if v_attempt.id is not null then
      update public.cleaning_attempts
      set status = 'superseded',
          ended_at = p_effective_at,
          end_reason = 'MANUAL_CHECKOUT_RESCHEDULE'
      where id = v_attempt.id;

      v_new_attempt_id := gen_random_uuid();
      insert into public.cleaning_attempts (
        id,
        cleaning_target_id,
        assignment_id,
        maid_profile_id,
        attempt_number,
        status,
        assignment_revision,
        template_snapshot,
        room_snapshot
      ) values (
        v_new_attempt_id,
        v_attempt.cleaning_target_id,
        v_new_assignment_id,
        v_assignment.maid_profile_id,
        v_attempt.attempt_number + 1,
        'scheduled',
        v_assignment.revision + 1,
        v_attempt.template_snapshot,
        v_attempt.room_snapshot
      );
    end if;

    if v_assignment.notified_at is not null then
      insert into public.notifications (
        recipient_profile_id,
        category,
        title,
        body,
        room_id,
        cleaning_target_id,
        dedupe_key,
        requires_action,
        occurred_at
      ) values (
        v_assignment.maid_profile_id,
        'cleaning_schedule_changed',
        '청소 시작 시간이 변경되었습니다',
        '수동 체크아웃 처리로 청소 가능 시간이 변경되었습니다.',
        v_operational_room_id,
        v_assignment.cleaning_target_id,
        private.audit_command_key(
          p_actor_profile_id,
          'reservation.manual_checkout.assignment_notice',
          p_idempotency_key
        ),
        true,
        p_effective_at
      );
    end if;
  end if;

  select e.sync_status, e.pin_version
  into v_current_pin_status, v_current_pin_version
  from public.room_pin_sync_events e
  where e.room_id = v_operational_room_id
  order by e.recorded_at desc, e.id desc
  limit 1;

  with revoked as (
    update public.room_pin_access_leases
    set revoked_at = p_effective_at,
        revoke_reason_code = 'MANUAL_CHECKOUT_RESCHEDULE'
    where reservation_id = v_reservation.id
      and room_id=v_operational_room_id
      and cleaning_target_id in(
        v_obligation.planned_cleaning_target_id,
        v_obligation.current_cleaning_target_id
      )
      and revoked_at is null
    returning *
  )
  insert into public.room_pin_access_leases (
    room_id,
    reservation_id,
    cleaning_target_id,
    assignment_id,
    attempt_id,
    pin_version,
    issued_to,
    issued_at,
    expires_at
  )
  select
    l.room_id,
    l.reservation_id,
    l.cleaning_target_id,
    v_new_assignment_id,
    v_new_attempt_id,
    v_current_pin_version,
    l.issued_to,
    p_effective_at,
    l.expires_at
  from revoked l
  where v_new_assignment_id is not null
    and v_new_attempt_id is not null
    and l.room_id = v_operational_room_id
    and l.cleaning_target_id = v_obligation.current_cleaning_target_id
    and l.assignment_id = v_assignment.id
    and l.attempt_id = v_attempt.id
    and l.issued_to = v_assignment.maid_profile_id
    and l.revealed_at is null
    and l.expires_at > p_effective_at
    and v_current_pin_status = 'verified'
    and v_current_pin_version is not null;

  insert into public.room_occupancy_events (
    event_key,
    room_id,
    reservation_id,
    event_type,
    effective_at,
    actor_profile_id,
    reason_code,
    before_state,
    after_state
  ) values (
    private.audit_command_key(
      p_actor_profile_id,
      'reservation.manual_checkout.event',
      p_idempotency_key
    ),
    v_operational_room_id,
    v_updated.id,
    'manual_checkout',
    p_effective_at,
    p_actor_profile_id,
    p_reason_code,
    jsonb_build_object('occupied', true),
    jsonb_build_object('occupied', false)
  );

  update public.rooms
  set state_version = state_version + 1
  where id = v_operational_room_id;

  v_response := jsonb_set(private.reservation_response(v_updated), '{room_id}',
    to_jsonb(v_operational_room_id), true);

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.manual_checkout',
    'reservation',
    v_updated.id,
    p_effective_at,
    p_reason_code,
    v_before,
    v_response,
    p_request_hash,
    private.audit_command_key(
      p_actor_profile_id,
      'reservation.manual_checkout',
      p_idempotency_key
    )
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.manual_checkout',
    p_idempotency_key,
    p_request_hash,
    v_updated.id,
    v_response
  );
  return v_response;
end;
$$;


revoke all on function public.manual_checkout_reservation(uuid,uuid,bigint,text,timestamptz,text,text)
from public,anon,authenticated;
grant execute on function public.manual_checkout_reservation(uuid,uuid,bigint,text,timestamptz,text,text)
to service_role;

create or replace function public.process_due_reservation_transitions(
  p_actor_profile_id uuid,
  p_as_of timestamptz,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_reason_codes text[];
  v_checked_in integer := 0;
  v_checked_out integer := 0;
  v_blocked integer := 0;
  v_purged_guest_names integer := 0;
  v_operational_room_id uuid;
  v_before_projection jsonb;
  v_after_projection jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.process_due_transitions',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  -- Close due stays first so a legal [checkout, next check-in) boundary does not
  -- leave the next reservation blocked until the following scheduler tick.
  for v_reservation in
    select r.*
    from public.reservations r
    where r.status = 'active'
      and r.actual_checkout_at is null
      and r.check_out_at <= p_as_of
    order by r.room_id, r.check_out_at, r.id
    for update skip locked
  loop
    v_operational_room_id := private.reservation_current_room_at(
      v_reservation.id, v_reservation.check_out_at - interval '1 microsecond'
    );
    if v_operational_room_id is null then
      raise exception using errcode = '23514', message = 'STAY_SEGMENT_CONTRACT_MISMATCH';
    end if;
    perform 1 from public.rooms where id = v_operational_room_id for update;
    if not exists (select 1 from public.checkout_cleaning_obligations obligation
      where obligation.reservation_id=v_reservation.id
        and obligation.room_id=v_operational_room_id) then
      raise exception using errcode = '23514', message = 'STAY_SEGMENT_CONTRACT_MISMATCH';
    end if;
    v_before_projection := jsonb_set(private.reservation_response(v_reservation),
      '{room_id}',to_jsonb(v_operational_room_id),true);

    update public.reservations
    set status = 'checked_out',
        actual_checkout_at = v_reservation.check_out_at,
        version = version + 1,
        updated_by = p_actor_profile_id
    where id = v_reservation.id
      and status = 'active'
      and actual_checkout_at is null
    returning * into v_updated;

    if not found then
      continue;
    end if;

    update public.checkout_cleaning_obligations
    set status = case
          when current_cleaning_target_id is null then 'available'::public.checkout_obligation_status
          else 'materialized'::public.checkout_obligation_status
        end,
        available_from = v_updated.check_out_at,
        effective_service_date = (v_updated.check_out_at at time zone 'Asia/Seoul')::date,
        version = version + 1
    where reservation_id = v_updated.id;

    insert into public.room_occupancy_events (
      event_key,
      room_id,
      reservation_id,
      event_type,
      effective_at,
      actor_profile_id,
      reason_code,
      before_state,
      after_state
    ) values (
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_checkout.' || v_updated.id::text,
        p_idempotency_key
      ),
      v_operational_room_id,
      v_updated.id,
      'scheduled_checkout',
      v_updated.check_out_at,
      p_actor_profile_id,
      'SCHEDULED_CHECKOUT_REACHED',
      jsonb_build_object('occupied', v_reservation.actual_check_in_at is not null),
      jsonb_build_object('occupied', false)
    );

    update public.rooms set state_version = state_version + 1 where id = v_operational_room_id;
    v_after_projection := jsonb_set(private.reservation_response(v_updated),
      '{room_id}',to_jsonb(v_operational_room_id),true);

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      reason_code,
      before_state,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      p.id,
      p.display_name,
      'reservation.scheduled_checkout',
      'reservation',
      v_updated.id,
      v_updated.check_out_at,
      'SCHEDULED_CHECKOUT_REACHED',
      v_before_projection,
      v_after_projection,
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_checkout.' || v_updated.id::text,
        p_idempotency_key
      )
    from public.profiles p where p.id = p_actor_profile_id;

    v_checked_out := v_checked_out + 1;
  end loop;

  for v_reservation in
    select r.*
    from public.reservations r
    where r.status = 'active'
      and r.actual_check_in_at is null
      and r.check_in_at <= p_as_of
      and r.check_out_at > p_as_of
    order by r.room_id, r.check_in_at, r.id
    for update skip locked
  loop
    perform 1 from public.rooms where id = v_reservation.room_id for update;
    v_reason_codes := private.room_block_reason_codes(
      v_reservation.room_id,
      p_as_of,
      true,
      true,
      v_reservation.id
    );

    if cardinality(v_reason_codes) > 0 then
      v_blocked := v_blocked + 1;
      continue;
    end if;

    update public.reservations
    set actual_check_in_at = p_as_of,
        version = version + 1,
        updated_by = p_actor_profile_id
    where id = v_reservation.id
      and status = 'active'
      and actual_check_in_at is null
    returning * into v_updated;

    if not found then
      continue;
    end if;

    insert into public.room_occupancy_events (
      event_key,
      room_id,
      reservation_id,
      event_type,
      effective_at,
      actor_profile_id,
      reason_code,
      before_state,
      after_state
    ) values (
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_check_in.' || v_updated.id::text,
        p_idempotency_key
      ),
      v_updated.room_id,
      v_updated.id,
      'scheduled_check_in',
      p_as_of,
      p_actor_profile_id,
      'SCHEDULED_CHECK_IN_READY',
      jsonb_build_object('occupied', false),
      jsonb_build_object('occupied', true)
    );

    update public.rooms set state_version = state_version + 1 where id = v_updated.room_id;

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      reason_code,
      before_state,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      p.id,
      p.display_name,
      'reservation.scheduled_check_in',
      'reservation',
      v_updated.id,
      p_as_of,
      'SCHEDULED_CHECK_IN_READY',
      private.reservation_response(v_reservation),
      private.reservation_response(v_updated),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.scheduled_check_in.' || v_updated.id::text,
        p_idempotency_key
      )
    from public.profiles p where p.id = p_actor_profile_id;

    v_checked_in := v_checked_in + 1;
  end loop;

  update public.reservations r
  set guest_name_encrypted = null,
      version = version + 1,
      updated_by = p_actor_profile_id
  where r.guest_name_encrypted is not null
    and (
      (r.status = 'checked_out' and r.actual_checkout_at <= p_as_of - interval '180 days')
      or (r.status = 'cancelled' and r.cancelled_at <= p_as_of - interval '180 days')
    );
  get diagnostics v_purged_guest_names = row_count;

  if v_purged_guest_names > 0 then
    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      effective_at,
      reason_code,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      p.id,
      p.display_name,
      'reservation.guest_name_retention_purged',
      'reservation_retention_batch',
      p_as_of,
      'RETENTION_180_DAYS_EXPIRED',
      jsonb_build_object('purged_count', v_purged_guest_names),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.guest_name_retention_purged',
        p_idempotency_key
      )
    from public.profiles p where p.id = p_actor_profile_id;
  end if;

  v_response := jsonb_build_object(
    'as_of', p_as_of,
    'checked_in_count', v_checked_in,
    'checked_out_count', v_checked_out,
    'blocked_check_in_count', v_blocked,
    'purged_guest_name_count', v_purged_guest_names
  );

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.process_due_transitions',
    p_idempotency_key,
    p_request_hash,
    null,
    v_response
  );
  return v_response;
end;
$$;


revoke all on function public.process_due_reservation_transitions(uuid,timestamptz,text,text)
from public,anon,authenticated;
grant execute on function public.process_due_reservation_transitions(uuid,timestamptz,text,text)
to service_role;

-- Reservation changes preserve the complete v61 workflow. Only the operational
-- room is derived from the final stay segment, and reservations.room_id is never assigned.
create or replace function public.change_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_guest_name_mode text,
  p_guest_name_encrypted text,
  p_expected_version bigint,
  p_reason_code text,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_reservation public.reservations%rowtype;
  v_updated public.reservations%rowtype;
  v_old_room_id uuid;
  v_projected_room_id uuid;
  v_operational_room_id uuid;
  v_previous_segment_mode text;
  v_checkout_obligation public.checkout_cleaning_obligations%rowtype;
  v_checkout_event_type text;
  v_reopen_occupancy boolean := false;
  v_assignment_reasons text[];
  v_before jsonb;
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.change',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  if (p_check_out_at at time zone 'Asia/Seoul')::date
      <= (p_check_in_at at time zone 'Asia/Seoul')::date
    or p_check_in_at <> date_trunc('minute', p_check_in_at)
    or p_check_out_at <> date_trunc('minute', p_check_out_at) then
    raise exception using errcode = '22023', message = 'INVALID_RESERVATION_SCHEDULE';
  end if;
  if p_guest_count <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_GUEST_COUNT';
  end if;
  if p_guest_name_mode not in ('keep', 'set', 'clear')
    or (p_guest_name_mode = 'set' and p_guest_name_encrypted is null) then
    raise exception using errcode = '22023', message = 'INVALID_GUEST_NAME_MODE';
  end if;

  select * into v_reservation
  from public.reservations
  where id = p_reservation_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'RESERVATION_NOT_FOUND';
  end if;
  if v_reservation.version <> p_expected_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  v_old_room_id := v_reservation.room_id;
  v_projected_room_id := private.reservation_projected_room_id(
    v_reservation,
    clock_timestamp()
  );
  if v_reservation.actual_check_in_at is not null and exists(
    select 1 from private.reservation_stays stay
    join private.stay_room_segments segment on segment.stay_id=stay.id
    where stay.reservation_id=v_reservation.id and segment.retired_at is null
      and segment.move_event_id is not null and segment.starts_at>=p_check_out_at
  ) then
    v_operational_room_id:=private.invalidate_future_stay_moves_at(
      v_reservation.id,p_check_out_at,p_actor_profile_id,'RESERVATION_SCHEDULE_CHANGED'
    );
  else
    v_operational_room_id := case when v_reservation.actual_check_in_at is not null
      then private.reservation_final_room_id(v_reservation.id) else v_reservation.room_id end;
  end if;
  if v_projected_room_id is null then
    raise exception using errcode='23514',message='STAY_SEGMENT_CONTRACT_MISMATCH';
  end if;
  if v_operational_room_id is null then
    raise exception using errcode='23514',message='STAY_SEGMENT_CONTRACT_MISMATCH';
  end if;
  if p_room_id <> v_projected_room_id then
    raise exception using errcode='23514',message='RESERVATION_ROOM_CHANGE_DEDICATED_COMMAND_REQUIRED';
  end if;
  perform 1
  from public.rooms r
  where r.id in (v_old_room_id, v_projected_room_id, v_operational_room_id)
  order by r.id
  for update;
  if not exists (select 1 from public.rooms where id = p_room_id) then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;

  select * into v_checkout_obligation
  from public.checkout_cleaning_obligations o
  where o.reservation_id = v_reservation.id
  for update;

  if v_reservation.status = 'cancelled' then
    raise exception using errcode = '23514', message = 'INVALID_TRANSITION';
  elsif v_reservation.status = 'checked_out' then
    select e.event_type into v_checkout_event_type
    from public.room_occupancy_events e
    where e.reservation_id = v_reservation.id
      and e.event_type in ('manual_checkout', 'scheduled_checkout')
    order by e.recorded_at desc, e.id desc
    limit 1;

    if v_checkout_event_type <> 'scheduled_checkout'
      or p_check_out_at <= now()
      or p_check_in_at <> v_reservation.check_in_at then
      raise exception using errcode = '23514', message = 'CHECKED_OUT_RESERVATION_IMMUTABLE';
    end if;

    if exists (
      select 1
      from public.cleaning_targets t
      join public.cleaning_assignments ca
        on ca.cleaning_target_id = t.id
        and ca.is_current
      join public.cleaning_attempts a
        on a.cleaning_target_id = t.id
        and a.assignment_id = ca.id
      where t.id in(
          v_checkout_obligation.planned_cleaning_target_id,
          v_checkout_obligation.current_cleaning_target_id
        )
        and a.status <> 'superseded'
        and (a.started_at is not null or a.status <> 'scheduled')
    ) or exists (
      select 1
      from public.room_pin_access_leases l
      where l.reservation_id = v_reservation.id
        and l.room_id=v_operational_room_id
        and l.cleaning_target_id in(
          v_checkout_obligation.planned_cleaning_target_id,
          v_checkout_obligation.current_cleaning_target_id
        )
        and l.revealed_at is not null
        and l.revoked_at is null
        and not exists(
          select 1 from private.room_pin_access_scheduled_revocations scheduled
          where scheduled.lease_id=l.id and scheduled.effective_at<=clock_timestamp()
        )
    ) then
      raise exception using errcode = '23514', message = 'RESERVATION_EXTENSION_ACCESS_CONFLICT';
    end if;
    v_reopen_occupancy := true;
  end if;

  if v_reservation.actual_check_in_at is not null and not v_reopen_occupancy then
    if p_check_in_at <> v_reservation.check_in_at then
      raise exception using errcode = '23514', message = 'OCCUPIED_RESERVATION_SCHEDULE_LOCKED';
    end if;
    if p_check_out_at <= now() then
      raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_REQUIRED';
    end if;
  end if;

  if v_checkout_obligation.current_cleaning_target_id is not null
    and (
      p_check_out_at <> v_reservation.check_out_at
    ) then
    if not v_reopen_occupancy then
      raise exception using errcode = '23514', message = 'CLEANING_WORKFLOW_REPLAN_REQUIRED';
    end if;
  end if;

  v_assignment_reasons := array[]::text[];
  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = v_operational_room_id
      and b.released_at is null
      and b.starts_at < p_check_out_at
      and (b.ends_at is null or b.ends_at > p_check_in_at)
  ) and not ('OPERATION_BLOCKED' = any(v_assignment_reasons)) then
    v_assignment_reasons := array_append(v_assignment_reasons, 'OPERATION_BLOCKED');
  end if;
  if cardinality(v_assignment_reasons) > 0 then
    raise exception using
      errcode = '23514',
      message = 'ROOM_ALLOCATION_BLOCKED',
      detail = array_to_string(v_assignment_reasons, ',');
  end if;

  v_before := private.reservation_response(v_reservation);

  v_previous_segment_mode := current_setting('app.reservation_segment_writer_mode',true);
  perform set_config('app.reservation_segment_writer_mode','schedule_change_v1',true);
  update public.reservations
  set check_in_at = p_check_in_at,
      check_out_at = p_check_out_at,
      guest_count = p_guest_count,
      guest_name_encrypted = case p_guest_name_mode
        when 'keep' then guest_name_encrypted
        when 'clear' then null
        else p_guest_name_encrypted
      end,
      status = case when v_reopen_occupancy then 'active' else status end,
      actual_checkout_at = case when v_reopen_occupancy then null else actual_checkout_at end,
      version = version + 1,
      updated_by = p_actor_profile_id
  where id = v_reservation.id
  returning * into v_updated;
  perform set_config('app.reservation_segment_writer_mode',coalesce(v_previous_segment_mode,''),true);

  update public.preparation_obligations
  set room_id = v_reservation.room_id,
      status = case
        when p_check_in_at <> v_reservation.check_in_at then 'invalidated'
        else status
      end,
      approved_submission_id = case
        when p_check_in_at <> v_reservation.check_in_at then null
        else approved_submission_id
      end,
      invalidated_reason_code = case
        when p_check_in_at <> v_reservation.check_in_at then 'RESERVATION_CHECK_IN_CHANGED'
        else invalidated_reason_code
      end,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.checkout_cleaning_obligations
  set room_id = v_operational_room_id,
      status = case
        when v_reopen_occupancy then 'private'
        else status
      end,
      current_cleaning_target_id = case when v_reopen_occupancy then null else current_cleaning_target_id end,
      effective_service_date = (p_check_out_at at time zone 'Asia/Seoul')::date,
      available_from = p_check_out_at,
      version = version + 1
  where reservation_id = v_reservation.id;

  insert into public.reservation_schedule_revisions (
    reservation_id,
    version,
    room_id,
    check_in_at,
    check_out_at,
    guest_count,
    reason_code,
    actor_profile_id,
    effective_at
  ) values (
    v_updated.id,
    v_updated.version,
    v_operational_room_id,
    v_updated.check_in_at,
    v_updated.check_out_at,
    v_updated.guest_count,
    p_reason_code,
    p_actor_profile_id,
    now()
  );

  update public.rooms
  set state_version = state_version + 1
  where id in (v_old_room_id, v_projected_room_id, v_operational_room_id);

  if v_reopen_occupancy then
    update public.cleaning_attempts a
    set status = 'superseded',
        ended_at = now(),
        end_reason = 'RESERVATION_EXTENDED'
    from public.cleaning_targets t
    where t.id = v_checkout_obligation.current_cleaning_target_id
      and a.cleaning_target_id = t.id
      and a.status = 'scheduled';

    update public.cleaning_assignments a
    set is_current = false,
        ended_at = now(),
        change_reason_code = 'RESERVATION_EXTENDED'
    where a.cleaning_target_id = v_checkout_obligation.current_cleaning_target_id
      and a.is_current;

    insert into public.notifications (
      recipient_profile_id,
      category,
      title,
      body,
      room_id,
      cleaning_target_id,
      dedupe_key,
      requires_action
    )
    select
      a.maid_profile_id,
      'cleaning_assignment_revoked',
      '청소 배정이 회수되었습니다',
      '예약 퇴실 시간이 연장되어 기존 청소 배정이 회수되었습니다.',
      v_operational_room_id,
      a.cleaning_target_id,
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.change.assignment_revoked.' || a.id::text,
        p_idempotency_key
      ),
      false
    from public.cleaning_assignments a
    where a.cleaning_target_id = v_checkout_obligation.current_cleaning_target_id
      and a.change_reason_code = 'RESERVATION_EXTENDED'
      and a.ended_at is not null
      and a.notified_at is not null;

    update public.cleaning_targets
    set status = 'unassigned',
        available_from = p_check_out_at,
        effective_service_date = (p_check_out_at at time zone 'Asia/Seoul')::date,
        assignment_version = assignment_version + 1
    where id = v_checkout_obligation.current_cleaning_target_id;

    insert into public.cleaning_target_schedule_revisions (
      cleaning_target_id,
      revision,
      effective_service_date,
      available_from,
      due_at,
      reason_code,
      changed_by
    )
    select
      t.id,
      t.assignment_version,
      t.effective_service_date,
      t.available_from,
      t.due_at,
      'RESERVATION_EXTENDED',
      p_actor_profile_id
    from public.cleaning_targets t
    where t.id = v_checkout_obligation.current_cleaning_target_id;

    update public.room_pin_access_leases
    set revoked_at = now(), revoke_reason_code = 'RESERVATION_EXTENDED'
    where reservation_id = v_reservation.id
      and room_id=v_operational_room_id
      and cleaning_target_id in(
        v_checkout_obligation.planned_cleaning_target_id,
        v_checkout_obligation.current_cleaning_target_id
      )
      and revoked_at is null;

    if v_reservation.actual_check_in_at is not null then
      insert into public.room_occupancy_events (
      event_key,
      room_id,
      reservation_id,
      event_type,
      effective_at,
      actor_profile_id,
      reason_code,
      before_state,
      after_state
    ) values (
      private.audit_command_key(
        p_actor_profile_id,
        'reservation.change.occupancy_resumed',
        p_idempotency_key
      ),
      v_operational_room_id,
      v_updated.id,
      'occupancy_resumed',
      now(),
      p_actor_profile_id,
      p_reason_code,
      jsonb_build_object('occupied', false),
      jsonb_build_object('occupied', true)
      );
    end if;
  end if;

  perform private.refresh_checkout_due_at(v_old_room_id,p_actor_profile_id);
  perform private.invalidate_stale_preparation_proofs(v_old_room_id,'RESERVATION_SCHEDULE_CHANGED');
  if v_operational_room_id<>v_old_room_id then
    perform private.refresh_checkout_due_at(v_operational_room_id,p_actor_profile_id);
    perform private.invalidate_stale_preparation_proofs(
      v_operational_room_id,'RESERVATION_SCHEDULE_CHANGED');
  end if;

  v_response := private.reservation_response(v_updated);

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    before_state,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.changed',
    'reservation',
    v_updated.id,
    now(),
    p_reason_code,
    v_before,
    v_response,
    p_request_hash,
    private.audit_command_key(p_actor_profile_id, 'reservation.change', p_idempotency_key)
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.change',
    p_idempotency_key,
    p_request_hash,
    v_updated.id,
    v_response
  );
  return v_response;
exception
  when exclusion_violation then
    perform set_config('app.reservation_segment_writer_mode',coalesce(v_previous_segment_mode,''),true);
    raise exception using errcode = '23P01', message = 'RESERVATION_OVERLAP';
  when others then
    perform set_config('app.reservation_segment_writer_mode',coalesce(v_previous_segment_mode,''),true);
    raise;
end;
$$;


revoke all on function public.change_reservation(
  uuid,uuid,uuid,timestamptz,timestamptz,integer,text,text,bigint,text,text,text
) from public,anon,authenticated;
grant execute on function public.change_reservation(
  uuid,uuid,uuid,timestamptz,timestamptz,integer,text,text,bigint,text,text,text
) to service_role;

-- Checkout-presence evidence follows the final stay segment, while the
-- reservation row keeps the immutable original check-in room.
create or replace function private.sync_planned_checkout_target()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  t public.cleaning_targets%rowtype; a public.cleaning_assignments%rowtype;
  r public.reservations%rowtype; changed boolean; promoted boolean;
  changed_at timestamptz:=clock_timestamp();
  v_final_room_id uuid;
begin
  if new.planned_cleaning_target_id is null then return null; end if;
  select * into strict t from public.cleaning_targets
  where id=new.planned_cleaning_target_id for update;
  select * into strict r from public.reservations where id=new.reservation_id;
  v_final_room_id:=private.reservation_final_room_id(r.id);
  if v_final_room_id is null or new.room_id is distinct from v_final_room_id then
    raise exception using errcode='23514',message='STAY_SEGMENT_CONTRACT_MISMATCH';
  end if;
  select * into a from public.cleaning_assignments
  where cleaning_target_id=t.id and is_current for update;
  changed:=t.room_id is distinct from v_final_room_id
    or t.effective_service_date is distinct from new.effective_service_date
    or t.available_from is distinct from new.available_from
    or t.due_at is distinct from new.due_at;
  promoted:=old.current_cleaning_target_id is null and new.status='materialized';

  if old.current_cleaning_target_id is not null and new.current_cleaning_target_id is null
    and new.status='private' and a.id is not null and a.notified_at is not null then
    perform set_config('app.notification_extended_assignment_id',a.id::text,true);
  end if;

  if new.status='cancelled' and t.status<>'cancelled' then
    if exists(select 1 from public.cleaning_attempts where cleaning_target_id=t.id and status<>'superseded')
      or exists(select 1 from public.room_pin_access_leases where cleaning_target_id=t.id and revoked_at is null) then
      raise exception using errcode='23514',message='CLEANING_WORKFLOW_CANCEL_CONFLICT';
    end if;
    if a.id is not null and a.notified_at is not null then
      perform set_config('app.notification_cancelled_assignment_id',a.id::text,true);
    end if;
    update public.cleaning_assignments set is_current=false,ended_at=now(),
      change_reason_code='RESERVATION_CANCELLED' where id=a.id;
    update public.cleaning_targets set status='cancelled',cancelled_at=new.cancelled_at,
      cancelled_by=r.updated_by,cancellation_reason_code=new.cancellation_reason_code,
      assignment_version=assignment_version+1 where id=t.id;
  elsif changed and old.current_cleaning_target_id is null then
    if not promoted and a.notified_at is not null then
      if t.room_id is distinct from v_final_room_id then
        raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
      end if;
      perform private.replan_notified_checkout_assignment_v1(
        t.id,new.effective_service_date,new.available_from,new.due_at,
        'RESERVATION_SCHEDULE_CHANGED',r.updated_by,changed_at);
    else
      if not promoted and t.status not in ('unassigned','draft_assigned') then
        raise exception using errcode='23514',message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
      end if;
      update public.cleaning_targets set room_id=v_final_room_id,
        effective_service_date=new.effective_service_date,available_from=new.available_from,
        due_at=new.due_at,assignment_version=assignment_version+1
      where id=t.id returning * into t;
      insert into public.cleaning_target_schedule_revisions(
        cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by
      ) values(t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,
        case when promoted then 'MANUAL_CHECKOUT' else 'RESERVATION_SCHEDULE_CHANGED' end,r.updated_by);
      if promoted and a.id is not null then
        update public.cleaning_assignments set is_current=false,ended_at=r.actual_checkout_at,
          change_reason_code='MANUAL_CHECKOUT_RESCHEDULE' where id=a.id;
        insert into public.cleaning_assignments(
          cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,changed_by
        ) values(t.id,a.maid_profile_id,a.sequence_number,t.assignment_version,true,
          case when a.notified_at is not null then r.actual_checkout_at end,r.updated_by);
      end if;
    end if;
  end if;
  return null;
end $$;




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
  -- Shared domain lock first; the account guard only owns its profile row.
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
    -- Recheck actual start instant, including delayed starts with an open-ended
    -- additional window. No invented duration/default is used for this check.
    if v_target.cleaning_kind='additional' and exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=v_target.room_id and segment.retired_at is null
        and stay.status in('scheduled','active')
        and segment.starts_at<=v_command_at and segment.ends_at>v_command_at
    ) then raise exception using errcode='55000',message='ATTEMPT_ACTIVATION_NOT_ALLOWED'; end if;
    if exists(select 1 from public.cleaning_attempts a where a.maid_profile_id=p_actor_profile_id and a.status='in_progress') then
      raise exception using errcode='55000',message='MAID_ALREADY_IN_PROGRESS';
    end if;
    update public.cleaning_attempts set status='in_progress',started_at=v_command_at,
      execution_version=execution_version+1 where id=p_attempt_id returning * into v_attempt;
    update public.cleaning_targets set status='in_progress' where id=v_target.id;
  else
    -- Completion acknowledges actual field work. It must not reapply today's
    -- activation window or reject an ordinary checkout after a stayover start.
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




create or replace function private.assignment_prestart_command(
  p_actor uuid,p_action text,p_target uuid,p_assignment uuid,p_version bigint,
  p_maid uuid,p_sequence integer,p_available timestamptz,p_due timestamptz,
  p_request uuid,p_decision text,p_reason text,p_detail text,p_key text,p_hash text
) returns jsonb language plpgsql security definer set search_path=''
as $$
declare
  t public.cleaning_targets%rowtype; a public.cleaning_assignments%rowtype; next_a public.cleaning_assignments%rowtype;
  q public.assignment_change_requests%rowtype; r public.reservations%rowtype;
  cmd text; event_name text; response jsonb; summary jsonb; entity uuid;
  wk date; admin_row record; was_notified boolean; changed_schedule boolean;
  access_at timestamptz; deadline timestamptz; v_now timestamptz:=clock_timestamp();
begin
  if p_action='request' then
    if private.assert_active_actor(p_actor)<>'maid' then
      raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  else perform private.assert_room_admin(p_actor); end if;
  cmd:=case p_action when 'change' then 'assignment.prestart_change' when 'unassign' then 'assignment.prestart_unassign'
    when 'request' then 'assignment.cancellation_request' when 'decision' then 'assignment.cancellation_decision' end;
  if cmd is null or p_version is null or p_version<1 or p_assignment is null then
    raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
  if p_reason is null or not (p_reason=any(case p_action when 'request' then
    array['PERSONAL_REASON','HEALTH_REASON','MAID_UNAVAILABLE','OPERATIONAL_CHANGE']
    when 'decision' then array['APPROVED','REJECTED','OPERATIONAL_CHANGE','MAID_UNAVAILABLE']
    else array['MAID_UNAVAILABLE','SCHEDULE_CHANGED','SEQUENCE_CHANGED','OPERATIONAL_CHANGE'] end)) then
    raise exception using errcode='22023',message='ASSIGNMENT_REASON_INVALID'; end if;
  if p_detail is not null and (char_length(p_detail) not between 1 and 200 or p_detail ~ '[0-9@:/]') then
    raise exception using errcode='22023',message='ASSIGNMENT_REASON_INVALID'; end if;
  response:=private.replay_command(p_actor,cmd,p_key,p_hash);
  if response is not null then return response; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if p_action='decision' then
    if p_decision is null or p_decision not in ('approved','rejected') then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
    select * into q from public.assignment_change_requests where id=p_request;
    if not found then raise exception using errcode='P0002',message='ASSIGNMENT_CHANGE_REQUEST_NOT_FOUND'; end if;
    p_target:=q.cleaning_target_id;
  end if;
  select * into t from public.cleaning_targets where id=p_target for update;
  select * into a from public.cleaning_assignments where cleaning_target_id=t.id and is_current for update;
  if p_action='decision' then
    select * into q from public.assignment_change_requests where id=p_request for update;
    if q.status='superseded' then raise exception using errcode='40001',message='ASSIGNMENT_CHANGE_REQUEST_STALE'; end if;
    if q.status<>'pending' then raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_ALREADY_DECIDED'; end if;
    if q.assignment_id is distinct from a.id or q.source_target_assignment_version is distinct from t.assignment_version
      or q.assignment_id is distinct from p_assignment or q.source_target_assignment_version is distinct from p_version then
      raise exception using errcode='40001',message='ASSIGNMENT_CHANGE_REQUEST_STALE'; end if;
  end if;
  if t.id is null or a.id is null then raise exception using errcode='P0002',message='ASSIGNMENT_NOT_FOUND'; end if;
  if p_action='request' and a.maid_profile_id<>p_actor then
    raise exception using errcode='42501',message='ASSIGNMENT_CHANGE_REQUEST_ACCESS_REQUIRED'; end if;
  if exists(select 1 from public.cleaning_attempts attempt where cleaning_target_id=t.id and private.attempt_blocks_assignment(attempt)) then
    raise exception using errcode='23514',message='ASSIGNMENT_ALREADY_STARTED'; end if;
  if t.status not in ('draft_assigned','notified') or (p_action in ('request','decision') and t.status<>'notified') then
    raise exception using errcode='23514',message='ASSIGNMENT_PRESTART_REQUIRED'; end if;
  if t.assignment_version<>p_version or a.id<>p_assignment then
    raise exception using errcode='40001',message='ASSIGNMENT_VERSION_CONFLICT'; end if;
  was_notified:=t.status='notified';
  if p_action='change' then
    if p_sequence is null or p_sequence<1 or p_maid is null then
      raise exception using errcode='22023',message='ASSIGNMENT_INPUT_INVALID'; end if;
    perform 1 from public.profiles where id=p_maid and role='maid' and status='active' for share;
    if not found then raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if t.source='inspection_reclean' and p_maid is distinct from t.reclean_maid_profile_id then
      raise exception using errcode='23514',message='RECLEAN_MAID_IMMUTABLE'; end if;
    wk:=t.effective_service_date-(extract(isodow from t.effective_service_date)::integer-1);
    perform pg_advisory_xact_lock(hashtextextended('availability:'||p_maid::text||':'||wk::text,0));
    if not exists(select 1 from public.availability_versions v join public.availability_days d on d.availability_version_id=v.id
      where v.maid_profile_id=p_maid and v.week_start=wk and v.is_current and d.work_date=t.effective_service_date and d.available) then
      raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE'; end if;
    if exists(select 1 from public.cleaning_assignments where is_current and id<>a.id and maid_profile_id=p_maid
      and service_date=t.effective_service_date and sequence_number=p_sequence) then
      raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT'; end if;
    access_at:=coalesce(p_available,t.available_from); deadline:=coalesce(p_due,t.due_at);
    changed_schedule:=access_at is distinct from t.available_from or deadline is distinct from t.due_at;
    if changed_schedule then
      -- 생성 command의 source-kind 조합만 허용한다. 예약/checkout 원장의 시간은 #27로 우회하지 않는다.
      if not ((t.source='manual_room_request' and t.cleaning_kind='additional')
          or (t.source='stayover_request' and t.cleaning_kind='stayover'))
        or access_at is null or deadline is null or access_at>=deadline
        or t.available_from is null or t.due_at is null
        or access_at<t.available_from or deadline>t.due_at
        or (access_at at time zone 'Asia/Seoul')::date<>t.effective_service_date
        or (deadline at time zone 'Asia/Seoul')::date<>t.effective_service_date then
        raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
    end if;
    if t.cleaning_kind='stayover' then
      select * into r from public.reservations where id=t.reservation_id;
      if r.id is null or r.status<>'active' or r.actual_check_in_at is null
        or r.actual_checkout_at is not null
        or not exists(
          select 1 from private.reservation_stays stay
          join private.stay_room_segments segment on segment.stay_id=stay.id
          where stay.reservation_id=r.id and segment.room_id=t.room_id
            and segment.retired_at is null
            and segment.starts_at<=access_at and segment.ends_at>=deadline
        ) then
        raise exception using errcode='23514',message='ASSIGNMENT_SCHEDULE_INVALID'; end if;
    end if;
    update public.cleaning_assignments set is_current=false,ended_at=v_now,change_reason_code=p_reason where id=a.id;
    update public.cleaning_targets set assignment_version=assignment_version+1,available_from=access_at,due_at=deadline
      where id=t.id returning * into t;
    if changed_schedule then
      insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,available_from,due_at,reason_code,changed_by)
      values(t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,p_reason,p_actor);
    end if;
    insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
    values(t.id,p_maid,p_sequence,t.assignment_version,p_actor,case when was_notified then v_now end) returning * into next_a;
    if was_notified then
      update public.notifications set resolved_at=coalesce(resolved_at,v_now) where cleaning_target_id=t.id
        and recipient_profile_id=a.maid_profile_id and requires_action
        and category in ('cleaning_assignment_notified','cleaning_assignment_changed','cleaning_schedule_changed');
      if a.maid_profile_id<>p_maid then
        perform private.prestart_notice(a.maid_profile_id,t,'cleaning_assignment_revoked','prestart-revoke:'||a.id::text,false);
      end if;
      perform private.prestart_notice(p_maid,t,case when a.maid_profile_id=p_maid then 'cleaning_assignment_changed' else 'cleaning_assignment_notified' end,
        'prestart-notify:'||next_a.id::text,true);
    end if;
    event_name:='assignment.prestart_changed'; entity:=next_a.id;
    response:=private.prestart_assignment_projection(next_a.id);
  elsif p_action='request' then
    if exists(select 1 from public.assignment_change_requests where assignment_id=a.id and status='pending') then
      raise exception using errcode='23514',message='ASSIGNMENT_CHANGE_REQUEST_EXISTS'; end if;
    insert into public.assignment_change_requests(cleaning_target_id,assignment_id,maid_profile_id,reason_code,reason_detail,
      source_assignment_revision,source_target_assignment_version)
    values(t.id,a.id,p_actor,p_reason,p_detail,a.revision,t.assignment_version) returning * into q;
    for admin_row in select id from public.profiles where role='admin' and status='active' order by id loop
      perform private.prestart_notice(admin_row.id,t,'assignment_cancellation_requested','assignment-request:'||q.id::text,true);
    end loop;
    event_name:='assignment.cancellation_requested'; entity:=q.id;
    response:=private.assignment_request_projection(q);
  else
    if p_action='decision' then
      -- 요청을 먼저 terminal로 만들어 source 종료 trigger가 승인 이력을 superseded로 덮지 않게 한다.
      update public.assignment_change_requests set status=p_decision,decided_by=p_actor,decided_at=v_now,decision_reason_code=p_reason
      where id=q.id returning * into q;
      update public.notifications set resolved_at=coalesce(resolved_at,v_now) where dedupe_key='assignment-request:'||q.id::text and requires_action;
    end if;
    if p_action='unassign' or p_decision='approved' then
      update public.cleaning_assignments set is_current=false,ended_at=v_now,change_reason_code=p_reason where id=a.id;
      update public.cleaning_targets set status='unassigned',assignment_version=assignment_version+1 where id=t.id returning * into t;
      if was_notified then
        update public.notifications set resolved_at=coalesce(resolved_at,v_now) where cleaning_target_id=t.id
          and recipient_profile_id=a.maid_profile_id and requires_action
          and category in ('cleaning_assignment_notified','cleaning_assignment_changed','cleaning_schedule_changed');
      end if;
    end if;
    if was_notified then
      perform private.prestart_notice(a.maid_profile_id,t,
        case when p_action='unassign' then 'cleaning_assignment_revoked'
          when p_decision='approved' then 'assignment_cancellation_approved' else 'assignment_cancellation_rejected' end,
        case when p_action='unassign' then 'prestart-revoke:'||a.id::text else 'assignment-decision:'||q.id::text end,false);
    end if;
    if p_action='unassign' then event_name:='assignment.prestart_unassigned';entity:=a.id;
      response:=private.prestart_assignment_projection(a.id);
    else event_name:='assignment.cancellation_decided';entity:=q.id;response:=private.assignment_request_projection(q);end if;
  end if;
  summary:=jsonb_strip_nulls(jsonb_build_object('cleaningTargetId',t.id,'assignmentId',coalesce(next_a.id,a.id),
    'previousAssignmentId',case when next_a.id is not null then a.id end,'maidProfileId',coalesce(next_a.maid_profile_id,a.maid_profile_id),
    'previousMaidProfileId',case when next_a.id is not null then a.maid_profile_id end,'serviceDate',t.effective_service_date,
    'sequenceNumber',coalesce(next_a.sequence_number,a.sequence_number),'revision',coalesce(next_a.revision,a.revision),
    'targetAssignmentVersion',t.assignment_version,'requestId',q.id,'decision',p_decision,'reasonCode',p_reason));
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  select p_actor,display_name,event_name,case when q.id is null then 'cleaning_assignment' else 'assignment_change_request' end,
    entity,v_now,p_reason,summary,p_hash,private.audit_command_key(p_actor,cmd,p_key) from public.profiles where id=p_actor;
  perform private.complete_command(p_actor,cmd,p_key,p_hash,entity,response);
  return response;
end;
$$;




create or replace function private.rollover_cleaning_target_at(
  p_actor_profile_id uuid,
  p_cleaning_target_id uuid,
  p_command_at timestamptz,
  p_expected_assignment_id uuid default null,
  p_expected_assignment_version bigint default null,
  p_expected_service_date date default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target public.cleaning_targets%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_old_date date;
  v_new_date date;
  v_day_delta integer;
  v_next_available_from timestamptz;
  v_next_due_at timestamptz;
  v_window_end timestamptz;
  v_notification_id uuid;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_target
  from public.cleaning_targets target
  where target.id = p_cleaning_target_id
  for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_TARGET_NOT_FOUND';
  end if;

  select * into v_assignment
  from public.cleaning_assignments assignment
  where assignment.cleaning_target_id = v_target.id
    and assignment.is_current
  for update;

  if (p_expected_assignment_id is not null
      and v_assignment.id is distinct from p_expected_assignment_id)
    or (p_expected_assignment_id is null and v_assignment.id is not null)
    or (p_expected_assignment_version is not null
      and v_target.assignment_version is distinct from p_expected_assignment_version)
    or (p_expected_service_date is not null
      and v_target.effective_service_date is distinct from p_expected_service_date) then
    return private.assignment_activation_result(
      'notReady', 'ASSIGNMENT_VERSION_CONFLICT', v_target, v_assignment, null
    );
  end if;

  if exists (
    select 1 from public.cleaning_attempts attempt
    where attempt.cleaning_target_id = v_target.id
      and private.attempt_blocks_assignment(attempt)
  ) then
    return private.assignment_activation_result(
      'blocked', 'ROLLOVER_NOT_ALLOWED', v_target, v_assignment, null
    );
  end if;

  if v_target.status not in ('unassigned', 'notified')
    or (v_target.status = 'unassigned' and v_assignment.id is not null)
    or (v_target.status = 'notified' and (
      v_assignment.id is null
      or v_assignment.notified_at is null
      or v_assignment.revision <> v_target.assignment_version
    )) then
    return private.assignment_activation_result(
      'notReady', 'ROLLOVER_NOT_ALLOWED', v_target, v_assignment, null
    );
  end if;

  if v_target.cleaning_kind='checkout' and not (
    exists(
      select 1 from public.checkout_cleaning_obligations obligation
      join public.reservations reservation on reservation.id=obligation.reservation_id
      where obligation.id=v_target.checkout_obligation_id
        and obligation.current_cleaning_target_id=v_target.id
        and obligation.room_id=v_target.room_id
        and obligation.status in('materialized','completed')
        and reservation.status='checked_out'
        and reservation.actual_checkout_at is not null
        and v_target.room_id=private.reservation_final_room_id(reservation.id)
    ) or exists(
      select 1 from private.stay_segment_checkout_obligations obligation
      where obligation.id=v_target.stay_segment_checkout_obligation_id
        and obligation.cleaning_target_id=v_target.id
        and obligation.room_id=v_target.room_id
        and obligation.status in('materialized','completed')
    )
  ) then
    return private.assignment_activation_result(
      'notReady','CHECKOUT_NOT_MATERIALIZED',v_target,v_assignment,null
    );
  end if;

  v_window_end := least(coalesce(v_target.due_at,'infinity'::timestamptz),
    ((v_target.effective_service_date + 1)::timestamp at time zone 'Asia/Seoul'));
  if v_window_end > p_command_at then
    return private.assignment_activation_result(
      'notReady', 'CLEANING_WINDOW_NOT_EXPIRED', v_target, v_assignment, null
    );
  end if;

  v_old_date := v_target.effective_service_date;
  v_new_date := v_old_date + 1;
  v_day_delta := v_new_date - v_old_date;
  v_next_available_from := v_target.available_from + make_interval(days => v_day_delta);
  v_next_due_at := v_target.due_at + make_interval(days => v_day_delta);

  -- Validate the proposed source window before closing assignments or writing any side effect.
  -- Invalid stayovers remain unchanged for explicit domain resolution, never auto-cancelled.
  if v_target.source='stayover_request' and v_target.cleaning_kind='stayover' then
    if not exists(
      select 1 from private.reservation_stays stay
      join private.stay_room_segments segment on segment.stay_id=stay.id
      join public.reservations reservation on reservation.id=stay.reservation_id
      where reservation.id=v_target.reservation_id
        and reservation.status='active'
        and reservation.actual_check_in_at is not null
        and reservation.actual_checkout_at is null
        and segment.room_id=v_target.room_id and segment.retired_at is null
        and v_next_available_from is not null and v_next_due_at is not null
        and v_next_available_from<v_next_due_at
        and segment.starts_at<=v_next_available_from
        and segment.ends_at>=v_next_due_at
        and (v_next_available_from at time zone 'Asia/Seoul')::date=v_new_date
    ) then
      return private.assignment_activation_result(
        'blocked','STAYOVER_ROLLOVER_NOT_ALLOWED',v_target,v_assignment,null
      );
    end if;
  elsif v_target.source='manual_room_request' and v_target.cleaning_kind='additional' then
    if v_next_available_from is null or exists(
      select 1 from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      where segment.room_id=v_target.room_id and segment.retired_at is null
        and stay.status in('scheduled','active')
        and tstzrange(segment.starts_at,segment.ends_at,'[)') && tstzrange(
          v_next_available_from,
          coalesce(v_next_due_at,v_next_available_from+make_interval(
            mins=>coalesce(nullif(v_target.template_snapshot->>'durationMinutes','')::integer,1)
          )),'[)')
    ) then
      return private.assignment_activation_result(
        'blocked','ADDITIONAL_ROLLOVER_NOT_ALLOWED',v_target,v_assignment,null
      );
    end if;
  end if;

  if v_assignment.id is not null then
    update public.cleaning_assignments
    set is_current = false,
        ended_at = p_command_at,
        change_reason_code = 'ROLLED_OVER_NOT_STARTED'
    where id = v_assignment.id
      and is_current;

    update public.notifications
    set resolved_at = coalesce(resolved_at, p_command_at)
    where cleaning_target_id = v_target.id
      and recipient_profile_id = v_assignment.maid_profile_id
      and requires_action
      and resolved_at is null;
  end if;

  update public.cleaning_targets
  set effective_service_date = v_new_date,
      available_from = v_next_available_from,
      due_at = v_next_due_at,
      carryover_count = carryover_count + 1,
      assignment_version = assignment_version + 1,
      status = 'unassigned',
      updated_at = p_command_at
  where id = v_target.id
  returning * into v_target;

  if v_target.cleaning_kind = 'checkout' then
    update public.checkout_cleaning_obligations
    set effective_service_date = v_target.effective_service_date,
        available_from = v_target.available_from,
        due_at = v_target.due_at,
        version = version + 1,
        updated_at = p_command_at
    where id = v_target.checkout_obligation_id
      and current_cleaning_target_id = v_target.id;

    update private.stay_segment_checkout_obligations
    set effective_service_date = v_target.effective_service_date,
        available_from = v_target.available_from,
        due_at = v_target.due_at,
        version = version + 1
    where id = v_target.stay_segment_checkout_obligation_id
      and cleaning_target_id = v_target.id
      and status = 'materialized';
  end if;

  insert into public.cleaning_target_schedule_revisions (
    cleaning_target_id,
    revision,
    effective_service_date,
    available_from,
    due_at,
    reason_code,
    changed_by,
    recorded_at
  ) values (
    v_target.id,
    v_target.assignment_version,
    v_target.effective_service_date,
    v_target.available_from,
    v_target.due_at,
    case when v_assignment.id is null
      then 'ROLLED_OVER_UNASSIGNED'
      else 'ROLLED_OVER_NOT_STARTED'
    end,
    p_actor_profile_id,
    p_command_at
  );

  if v_assignment.id is not null then
    insert into public.notifications (
      recipient_profile_id,
      category,
      title,
      body,
      room_id,
      cleaning_target_id,
      dedupe_key,
      requires_action,
      occurred_at
    ) values (
      v_assignment.maid_profile_id,
      'cleaning_assignment_rolled_over',
      '미착수 청소 배정이 이월되었습니다',
      '미착수 청소 배정이 다음 업무일의 재배정 대상으로 변경되었습니다.',
      v_target.room_id,
      v_target.id,
      'assignment-rollover:' || v_assignment.id::text,
      false,
      p_command_at
    ) returning id into v_notification_id;

    insert into private.notification_outbox (
      notification_id, channel, delivery_status, next_attempt_at, created_at
    ) values (
      v_notification_id, 'web_push', 'pending', p_command_at, p_command_at
    );
  end if;

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    after_state,
    idempotency_key
  )
  select
    actor.id,
    actor.display_name,
    'assignment.rolled_over',
    'cleaning_target',
    v_target.id,
    p_command_at,
    case when v_assignment.id is null
      then 'ROLLED_OVER_UNASSIGNED'
      else 'ROLLED_OVER_NOT_STARTED'
    end,
    jsonb_strip_nulls(jsonb_build_object(
      'cleaningTargetId', v_target.id,
      'assignmentId', v_assignment.id,
      'maidProfileId', v_assignment.maid_profile_id,
      'serviceDate', v_target.effective_service_date,
      'assignmentRevision', v_assignment.revision,
      'targetAssignmentVersion', v_target.assignment_version,
      'rolloverFromDate', v_old_date,
      'rolloverToDate', v_new_date,
      'carryoverCount', v_target.carryover_count,
      'reasonCode', case when v_assignment.id is null
        then 'ROLLED_OVER_UNASSIGNED'
        else 'ROLLED_OVER_NOT_STARTED'
      end
    )),
    private.audit_command_key(
      p_actor_profile_id,
      'assignment.rolled_over.' || v_target.id::text,
      v_old_date::text || ':' || v_target.assignment_version::text
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  return jsonb_strip_nulls(jsonb_build_object(
    'status', 'rolledOver',
    'cleaningTargetId', v_target.id,
    'assignmentId', v_assignment.id,
    'maidProfileId', v_assignment.maid_profile_id,
    'rolloverFromDate', v_old_date,
    'rolloverToDate', v_new_date,
    'carryoverCount', v_target.carryover_count,
    'targetAssignmentVersion', v_target.assignment_version,
    'reasonCode', case when v_assignment.id is null
      then 'ROLLED_OVER_UNASSIGNED'
      else 'ROLLED_OVER_NOT_STARTED'
    end
  ));
end;
$$;




create or replace function private.assignment_preview_snapshot_at(
  p_actor_profile_id uuid,p_service_date date,p_command_at timestamptz
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy public.assignment_duration_policy_versions;
  v_targets jsonb;
  v_maids jsonb;
begin
  perform private.assert_assignment_preview_admin(p_actor_profile_id);
  if p_command_at is null or not isfinite(p_command_at) or p_service_date is null or not isfinite(p_service_date)
    or p_service_date not in ((p_command_at at time zone 'Asia/Seoul')::date,(p_command_at at time zone 'Asia/Seoul')::date+1) then
    raise exception using errcode='22023',message='ASSIGNMENT_PREVIEW_DATE_NOT_ALLOWED';
  end if;
  select * into v_policy from public.assignment_duration_policy_versions where status='confirmed';
  select coalesce(jsonb_agg(jsonb_build_object(
    'maidProfileId',p.id,'maidDisplayName',p.display_name,'role',p.role,'status',p.status,
    'availabilityVersion',v.version,'available',coalesce(d.available,false),
    'availabilityIdentity',jsonb_build_object('versionId',v.id,'weekStart',v.week_start,'workDate',d.work_date)
  ) order by p.id),'[]'::jsonb) into v_maids
  from (select * from public.profiles where role='maid' order by id limit 1001) p
  left join public.availability_versions v on v.maid_profile_id=p.id and v.is_current and v.status='submitted'
    and v.week_start=p_service_date-(extract(isodow from p_service_date)::integer-1)
  left join public.availability_days d on d.availability_version_id=v.id and d.work_date=p_service_date;
  if jsonb_array_length(v_maids)>1000 then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'cleaningTargetId',t.id,'roomId',t.room_id,
    'roomNumber',coalesce(t.room_type_snapshot->>'roomNumber',r.room_number),
    'roomTypeCode',coalesce(t.room_type_snapshot->>'code','unknown'),
    'elevatorZone',coalesce(t.room_type_snapshot->>'elevatorZone',r.elevator_zone,'unknown'),
    'feeSnapshot',t.fee_snapshot,'availableFrom',t.available_from,'dueAt',t.due_at,
    'serviceDate',t.effective_service_date,'status',t.status,'assignmentVersion',t.assignment_version,
    'source',t.source,'cleaningKind',t.cleaning_kind,'recleanMaidProfileId',t.reclean_maid_profile_id,
    'domainIdentity',jsonb_build_object('reservationId',t.reservation_id,'checkoutObligationId',t.checkout_obligation_id,
      'recleanOfAttemptId',t.reclean_of_attempt_id,'reservationVersion',res.version,'reservationStatus',res.status,
      'checkInAt',res.check_in_at,'checkOutAt',res.check_out_at,'actualCheckInAt',res.actual_check_in_at,
      'actualCheckoutAt',res.actual_checkout_at,'obligationStatus',o.status,'obligationVersion',o.version,
      'plannedTargetId',o.planned_cleaning_target_id,'currentTargetId',o.current_cleaning_target_id,
      'roomStateVersion',r.state_version,'originalServiceDate',t.original_service_date,'carryoverCount',t.carryover_count,
      'roomReservations',coalesce((select jsonb_agg(jsonb_build_object('id',schedule.id,'version',schedule.version,
        'status',schedule.status,'checkInAt',schedule.check_in_at,'checkOutAt',schedule.check_out_at,
        'actualCheckInAt',schedule.actual_check_in_at,'actualCheckoutAt',schedule.actual_checkout_at) order by schedule.id)
        from (select distinct on(reservation.id) reservation.*
          from public.reservations reservation
          join private.reservation_stays stay on stay.reservation_id=reservation.id
          join private.stay_room_segments segment on segment.stay_id=stay.id
          where segment.room_id=t.room_id and segment.retired_at is null
            and reservation.status='active'
            and segment.starts_at < coalesce(t.due_at,'infinity'::timestamptz)
            and segment.ends_at > t.available_from
          order by reservation.id,segment.starts_at limit 123) schedule),'[]'::jsonb)),
    'currentAssignment',case when a.id is null then null else jsonb_build_object(
      'assignmentId',a.id,'maidProfileId',a.maid_profile_id,'sequenceNumber',a.sequence_number,'revision',a.revision,
      'serviceDate',a.service_date,'availableFrom',a.available_from_snapshot,'dueAt',a.due_at_snapshot,
      'targetAssignmentVersion',t.assignment_version,'notifiedAt',a.notified_at) end,
    'activeAttempt',case when att.id is null then null else jsonb_build_object(
      'attemptId',att.id,'maidProfileId',att.maid_profile_id,'status',att.status,'startedAt',att.started_at,'endedAt',att.ended_at) end,
    'blockedReason',case
      when att.id is not null and t.effective_service_date<>p_service_date then 'ASSIGNMENT_PREVIEW_ACTIVE_WORKFLOW_UNRESOLVED'
      when t.room_type_snapshot->>'code' is null or t.room_type_snapshot->>'code' not in ('standard','premium','oceanPremium','oceanFamily')
        then 'ASSIGNMENT_PREVIEW_ROOM_TYPE_UNKNOWN'
      when a.id is not null and (a.revision<>t.assignment_version or a.service_date<>t.effective_service_date
        or a.available_from_snapshot is distinct from t.available_from or a.due_at_snapshot is distinct from t.due_at)
        then 'ASSIGNMENT_DRAFT_STALE_SCHEDULE'
      when t.status in ('draft_assigned','notified') and a.id is null then 'ASSIGNMENT_PREVIEW_FIXED_ASSIGNMENT_INVALID'
      when t.status='unassigned' and a.id is not null then 'ASSIGNMENT_PREVIEW_FIXED_ASSIGNMENT_INVALID'
      when exists (
        select 1 from public.cleaning_attempts previous_attempt
        join public.cleaning_targets previous_target on previous_target.id=previous_attempt.cleaning_target_id
        where previous_target.room_id=t.room_id and previous_target.id<>t.id
          and previous_attempt.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')
          and (coalesce(previous_target.available_from,'-infinity'::timestamptz),previous_target.created_at,previous_target.id)
            < (coalesce(t.available_from,'infinity'::timestamptz),t.created_at,t.id)
      ) then 'PREVIOUS_ROOM_WORKFLOW_ACTIVE'
      else private.assignment_preview_source_reason(t,
        case t.room_type_snapshot->>'code' when 'standard' then v_policy.standard_minutes
          when 'premium' then v_policy.premium_minutes when 'oceanPremium' then v_policy.ocean_premium_minutes
          when 'oceanFamily' then v_policy.ocean_family_minutes end,p_command_at) end
  ) order by t.id),'[]'::jsonb) into v_targets
  from (
    select target.* from public.cleaning_targets target
    where (target.effective_service_date=p_service_date and target.status not in ('cancelled','approved'))
      or exists (select 1 from public.cleaning_attempts busy where busy.cleaning_target_id=target.id
        and busy.status in ('scheduled','in_progress','field_completed','upload_pending','submitted')
        and (target.effective_service_date<=p_service_date or busy.status<>'scheduled'))
    order by target.id limit 243
  ) t
  join public.rooms r on r.id=t.room_id
  left join public.reservations res on res.id=t.reservation_id
  left join public.checkout_cleaning_obligations o on o.id=t.checkout_obligation_id
  left join public.cleaning_assignments a on a.cleaning_target_id=t.id and a.is_current
  left join lateral (select attempt.* from public.cleaning_attempts attempt where attempt.cleaning_target_id=t.id
    and private.attempt_blocks_assignment(attempt) order by attempt.attempt_number desc limit 1) att on true;
  if jsonb_array_length(v_targets)>242 then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;
  if exists (select 1 from jsonb_array_elements(v_targets) item
    where jsonb_array_length(item->'domainIdentity'->'roomReservations')>122) then
    raise exception using errcode='54000',message='ASSIGNMENT_PREVIEW_LIMIT_EXCEEDED';
  end if;
  return jsonb_build_object('serviceDate',p_service_date,'planningAt',p_command_at,
    'durationPolicy',private.assignment_duration_policy_projection(v_policy),'maids',v_maids,'targets',v_targets);
end;
$$;






create or replace function public.report_checkout_presence_incident(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,
  p_expected_execution_version bigint,p_expected_assignment_id uuid,
  p_expected_assignment_revision bigint,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; a public.cleaning_attempts; s public.cleaning_assignments;
  t public.cleaning_targets; r public.reservations; o public.checkout_cleaning_obligations;
  i public.checkout_presence_incidents; replay jsonb; result jsonb; at_time timestamptz;
  v_pin_version bigint;
  report_audit_id uuid;
  v_final_room_id uuid;
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_writer_mode text:=current_setting('app.checkout_incident_writer_mode',true);
begin
  if p_attempt_id is null or p_expected_assignment_id is null
    or p_expected_execution_version is null or p_expected_execution_version<1
    or p_expected_assignment_revision is null or p_expected_assignment_revision<1 then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_REPORT';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  at_time:=clock_timestamp();
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role<>'maid' then raise exception using errcode='42501',message='MAID_REQUIRED'; end if;
  replay:=private.replay_command(p_actor_profile_id,'checkout.presence.report',p_idempotency_key,p_request_hash);
  if replay is not null then return replay; end if;
  perform 1 from public.profiles where id=p_actor_profile_id for no key update;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  perform 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;

  select * into a from public.cleaning_attempts where id=p_attempt_id;
  if a.id is null or a.maid_profile_id<>p_actor_profile_id then
    raise exception using errcode='42501',message='CHECKOUT_INCIDENT_REPORT_REQUIRED';
  end if;
  select * into r from public.reservations where id=(select reservation_id from public.cleaning_targets where id=a.cleaning_target_id) for update;
  select * into o from public.checkout_cleaning_obligations where reservation_id=r.id for update;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for update;
  select * into s from public.cleaning_assignments where id=a.assignment_id for update;
  select * into a from public.cleaning_attempts where id=p_attempt_id for update;
  v_final_room_id:=private.reservation_final_room_id(r.id);
  if r.id is null or o.id is null or t.id is null or s.id is null
    or t.cleaning_kind<>'checkout' or t.reservation_id<>r.id or t.checkout_obligation_id<>o.id
    or v_final_room_id is null or t.room_id<>v_final_room_id or o.room_id<>v_final_room_id
    or r.status<>'checked_out' or r.actual_checkout_at is null
    or o.status<>'materialized' or o.current_cleaning_target_id<>t.id
    or not s.is_current or s.notified_at is null or s.id<>p_expected_assignment_id
    or s.maid_profile_id<>p_actor_profile_id or s.revision<>p_expected_assignment_revision
    or t.assignment_version<>s.revision or a.assignment_revision<>s.revision
    or a.execution_version<>p_expected_execution_version
    or a.status not in ('scheduled','in_progress') or a.field_completed_at is not null then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_REPORT_CONFLICT';
  end if;
  if not exists(
    select 1
    from (
      select occupancy.room_id,occupancy.event_type,occupancy.effective_at
      from public.room_occupancy_events occupancy
      where occupancy.reservation_id=r.id
        and occupancy.event_type in ('manual_checkout','scheduled_checkout')
      order by occupancy.recorded_at desc,occupancy.id desc
      limit 1
    ) latest_checkout
    where latest_checkout.room_id=v_final_room_id
      and latest_checkout.event_type='scheduled_checkout'
      and latest_checkout.effective_at=r.actual_checkout_at
  ) then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_REPORT_CONFLICT';
  end if;
  if exists(
    select 1
    from public.checkout_presence_incidents existing_incident
    where existing_incident.status='open'
      and (existing_incident.attempt_id=a.id or existing_incident.cleaning_target_id=t.id)
  ) then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_REPORT_CONFLICT';
  end if;
  select current_pin.pin_version into v_pin_version
  from private.room_current_pin current_pin where current_pin.room_id=t.room_id;
  perform set_config('app.checkout_incident_writer_mode','typed_v1',true);
  insert into public.checkout_presence_incidents(
    reservation_id,room_id,checkout_obligation_id,cleaning_target_id,assignment_id,attempt_id,
    reported_by,reason_code,reservation_version,target_assignment_version,assignment_revision,
    attempt_execution_version,pin_version_snapshot,reported_at
  ) values(r.id,t.room_id,o.id,t.id,s.id,a.id,p_actor_profile_id,'GUEST_STILL_PRESENT',
    r.version,t.assignment_version,s.revision,a.execution_version,v_pin_version,at_time)
  returning * into i;
  update public.room_pin_access_leases set revoked_at=at_time,revoke_reason_code='CHECKOUT_NOT_COMPLETED'
    where attempt_id=a.id and revoked_at is null;
  insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
    select l.id,at_time,'CHECKOUT_NOT_COMPLETED',l.metadata_expires_at
    from private.offline_work_leases l where l.attempt_id=a.id
    on conflict(lease_id) do nothing;
  insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
    select g.id,at_time,'CHECKOUT_NOT_COMPLETED',p_actor_profile_id
    from private.attempt_capability_grants g where g.attempt_id=a.id
    on conflict(capability_id) do nothing;
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
    actor_display_name_snapshot,effective_at,recorded_at,reason_code,after_state,idempotency_key)
  values('checkout.presence_reported','checkout_presence_incident',i.id,p_actor_profile_id,
    actor.display_name,at_time,clock_timestamp(),'GUEST_STILL_PRESENT',
    jsonb_build_object('incidentId',i.id,'reservationId',r.id,'roomId',t.room_id,
      'cleaningTargetId',t.id,'assignmentId',s.id,'attemptId',a.id,'status','open','version',1),
    private.audit_command_key(p_actor_profile_id,'checkout.presence.report',p_idempotency_key))
  returning id into report_audit_id;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',report_audit_id::text,true);
  perform private.resolve_notifications_v1(
    'assignment.commit_notified','cleaning_assignment',s.id::text,at_time
  );
  perform private.resolve_notifications_v1(
    'assignment.prestart_new_notified','cleaning_assignment',s.id::text,at_time
  );
  perform private.resolve_notifications_v1(
    'assignment.prestart_same_maid_changed','cleaning_assignment',s.id::text,at_time
  );
  perform private.resolve_notifications_v1(
    'reservation.manual_checkout_rescheduled','cleaning_assignment',s.id::text,at_time
  );
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform private.emit_checkout_incident_notification('checkout.presence_reported_admin',p_actor_profile_id,
    admin_profile.id,i.id,null,at_time)
  from public.profiles admin_profile where admin_profile.role='admin' and admin_profile.status='active'
    and not admin_profile.must_change_password;
  result:=private.checkout_incident_projection(i)||jsonb_build_object(
    'impactFingerprint',private.checkout_incident_impact_fingerprint(i.id));
  perform set_config('app.checkout_incident_writer_mode',coalesce(previous_writer_mode,''),true);
  perform private.complete_command(p_actor_profile_id,'checkout.presence.report',p_idempotency_key,
    p_request_hash,i.id,result);
  return result;
end $$;

-- A segment-checkout submission is an original-cleaning earning source, not
-- a compensation or reclean earning. Preserve the #100 provenance gate while
-- admitting the new exact stay/segment checkout identity.
create or replace function public.create_complaint_case(
  p_actor_profile_id uuid,p_original_earning_id uuid,p_category text,p_expected_version bigint,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_earning public.earnings; v_submission public.cleaning_submissions;
  v_attempt public.cleaning_attempts; v_target public.cleaning_targets; v_inspection public.inspection_decisions;
  v_case public.complaint_cases; v_replay jsonb; v_result jsonb; v_at timestamptz:=transaction_timestamp();
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.create',p_idempotency_key,p_request_hash);
  if p_expected_version is distinct from 0 then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if p_category is null or p_category not in ('cleanliness_general','bathroom_cleanliness','bedding_quality',
    'trash_not_removed','amenity_missing','damage_or_loss','odor_or_smoke','access_or_handover') then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_CATEGORY'; end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  select * into v_earning from public.earnings where id=p_original_earning_id;
  select * into v_submission from public.cleaning_submissions where id=v_earning.submission_id;
  select * into v_attempt from public.cleaning_attempts where id=v_submission.cleaning_attempt_id;
  select * into v_target from public.cleaning_targets where id=v_attempt.cleaning_target_id;
  select * into v_inspection from public.inspection_decisions where submission_id=v_submission.id;
  if v_earning.id is null or v_submission.id is null or v_attempt.id is null or v_target.id is null
    or v_inspection.id is null or v_inspection.decision<>'approved' or v_submission.status<>'approved'
    or v_attempt.status<>'approved' or v_target.status<>'approved'
    or v_target.source not in (
      'scheduled_checkout','manual_checkout','stayover_request','manual_room_request',
      'stay_room_move_checkout')
    or (v_target.source='stay_room_move_checkout' and not exists(
      select 1
      from private.stay_segment_checkout_obligations obligation
      join private.reservation_stays stay on stay.id=obligation.stay_id
      where obligation.id=v_target.stay_segment_checkout_obligation_id
        and obligation.cleaning_target_id=v_target.id
        and obligation.room_id=v_target.room_id
        and obligation.status='completed'
        and stay.reservation_id=v_target.reservation_id
    ))
    or v_earning.earning_entitlement_id is null
    or v_earning.earning_entitlement_id is distinct from v_submission.id
    or v_earning.compensation_entitlement_id is not null
    or v_earning.maid_profile_id<>v_attempt.maid_profile_id
    or v_submission.submitted_by<>v_attempt.maid_profile_id then
    raise exception using errcode='55000',message='COMPLAINT_SOURCE_NOT_APPROVED';
  end if;
  if v_inspection.decided_at>v_at or v_at>v_inspection.decided_at+interval '30 days' then
    raise exception using errcode='22023',message='COMPLAINT_INTAKE_WINDOW_CLOSED';
  end if;
  insert into public.complaint_cases(room_id,cleaning_target_id,cleaning_attempt_id,submission_id,
    inspection_decision_id,original_earning_id,maid_profile_id,category,status,version,received_by,received_at,updated_at)
  values(v_target.room_id,v_target.id,v_attempt.id,v_submission.id,v_inspection.id,v_earning.id,
    v_attempt.maid_profile_id,p_category,'received',1,v_actor.id,v_at,v_at) returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,actor_profile_id,occurred_at)
  values(v_case.id,'received',null,'received',1,v_actor.id,v_at);
  perform private.enqueue_complaint_notice(v_case.maid_profile_id,v_case,'received',1,v_at);
  v_result:=private.get_complaint_projection(v_case.id);
  insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,reason_code,after_state,idempotency_key)
  values(v_actor.id,'complaint.received','complaint_case',v_case.id,v_at,p_category,
    jsonb_build_object('complaintId',v_case.id,'originalEarningId',v_case.original_earning_id,'status','received','version',1),
    private.audit_command_key(v_actor.id,'complaint.create',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.create',p_idempotency_key,p_request_hash,v_case.id,v_result);
  return v_result;
end $$;

-- Incident decisions preserve the existing transactional workflow but use
-- the final segment room for checkout provenance and occupancy evidence.
create or replace function public.materialize_complaint_rework(
  p_actor_profile_id uuid,p_complaint_id uuid,p_expected_version bigint,
  p_complaint_decision_id uuid,p_assignee_maid_profile_id uuid,p_compensation_amount integer,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor public.profiles; v_case public.complaint_cases; v_source public.complaint_decisions;
  v_original_target public.cleaning_targets; v_assignee public.profiles;
  v_template public.cleaning_template_versions; v_template_count integer;
  v_comp public.complaint_compensation_decisions; v_target public.cleaning_targets;
  v_assignment public.cleaning_assignments; v_replay jsonb; v_result jsonb;
  v_notice uuid; v_at timestamptz:=transaction_timestamp(); v_today date;
  v_tomorrow timestamptz; v_due timestamptz; v_duration interval; v_sequence integer;
  v_week date;
begin
  v_actor:=private.assert_complaint_admin(p_actor_profile_id);
  v_replay:=private.replay_command(v_actor.id,'complaint.materialize_rework',p_idempotency_key,p_request_hash);
  if p_expected_version is null or p_expected_version<1 or p_complaint_decision_id is null
    or p_assignee_maid_profile_id is null or p_compensation_amount is null or p_compensation_amount<0 then
    raise exception using errcode='22023',message='INVALID_COMPLAINT_REWORK';
  end if;
  if v_replay is not null then return v_replay; end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  v_replay:=private.replay_command(v_actor.id,'complaint.materialize_rework',p_idempotency_key,p_request_hash);
  if v_replay is not null then return v_replay; end if;
  select * into v_actor from public.profiles where id=p_actor_profile_id and role='admin'
    and status='active' and not must_change_password for no key update;
  if v_actor.id is null then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  select * into v_case from public.complaint_cases where id=p_complaint_id for update;
  if v_case.id is null then raise exception using errcode='P0002',message='COMPLAINT_NOT_FOUND'; end if;
  if v_case.version is distinct from p_expected_version
    or v_case.current_decision_id is distinct from p_complaint_decision_id then
    raise exception using errcode='40001',message='COMPLAINT_REWORK_DECISION_STALE'; end if;
  if v_case.current_compensation_decision_id is not null then
    raise exception using errcode='23505',message='COMPLAINT_REWORK_ALREADY_MATERIALIZED'; end if;
  if v_case.status not in ('decided','acknowledged','appealed','closed') then
    raise exception using errcode='55000',message='COMPLAINT_DECISION_REQUIRED'; end if;
  select * into v_source from public.complaint_decisions
    where id=v_case.current_decision_id and complaint_case_id=v_case.id for share;
  if v_source.id is null or v_source.finding<>'confirmed' or not v_source.rework_required then
    raise exception using errcode='55000',message='COMPLAINT_REWORK_NOT_CONFIRMED'; end if;
  select * into v_original_target from public.cleaning_targets
    where id=v_case.cleaning_target_id for update;
  if v_original_target.id is null or v_original_target.source not in (
      'scheduled_checkout','manual_checkout','stayover_request','manual_room_request',
      'stay_room_move_checkout')
    or (v_original_target.source='stay_room_move_checkout' and not exists(
      select 1
      from private.stay_segment_checkout_obligations obligation
      join private.reservation_stays stay on stay.id=obligation.stay_id
      where obligation.id=v_original_target.stay_segment_checkout_obligation_id
        and obligation.cleaning_target_id=v_original_target.id
        and obligation.room_id=v_original_target.room_id
        and obligation.status='completed'
        and stay.reservation_id=v_original_target.reservation_id
    ))
    or v_original_target.status<>'approved' then
    raise exception using errcode='55000',message='COMPLAINT_SOURCE_NOT_APPROVED'; end if;
  select * into v_assignee from public.profiles where id=p_assignee_maid_profile_id
    and role='maid' and status='active' for share;
  if v_assignee.id is null then
    raise exception using errcode='23514',message='COMPLAINT_REWORK_MAID_UNAVAILABLE'; end if;
  if p_assignee_maid_profile_id=v_case.maid_profile_id and p_compensation_amount<>0
    or p_assignee_maid_profile_id<>v_case.maid_profile_id
      and p_compensation_amount>v_original_target.fee_snapshot then
    raise exception using errcode='22023',message='COMPLAINT_COMPENSATION_AMOUNT_INVALID'; end if;
  v_today:=(v_at at time zone 'Asia/Seoul')::date;
  v_tomorrow:=(v_today+1)::timestamp at time zone 'Asia/Seoul';
  select count(*) into v_template_count
  from public.cleaning_template_versions template
  join public.room_types room_type on room_type.id=template.room_type_id
  where room_type.code=v_original_target.room_type_snapshot->>'code'
    and template.cleaning_kind='reclean' and template.status='published';
  if v_template_count<>1 then
    raise exception using errcode='23514',message='RECLEAN_TEMPLATE_NOT_CONFIGURED'; end if;
  select template.* into v_template from public.cleaning_template_versions template
  join public.room_types room_type on room_type.id=template.room_type_id
  where room_type.code=v_original_target.room_type_snapshot->>'code'
    and template.cleaning_kind='reclean' and template.status='published';
  v_duration:=make_interval(mins=>v_template.duration_minutes);
  select least(v_tomorrow,coalesce(min(segment.starts_at-interval '30 minutes'),v_tomorrow))
  into v_due
  from private.stay_room_segments segment
  join private.reservation_stays stay on stay.id=segment.stay_id
  join public.reservations reservation on reservation.id=stay.reservation_id
  where segment.room_id=v_case.room_id and segment.retired_at is null
    and reservation.status='active' and segment.starts_at>v_at;
  v_due:=coalesce(v_due,v_tomorrow);
  if v_at+v_duration>v_due
    or exists(select 1
      from private.stay_room_segments segment
      join private.reservation_stays stay on stay.id=segment.stay_id
      join public.reservations reservation on reservation.id=stay.reservation_id
      where segment.room_id=v_case.room_id and segment.retired_at is null
        and reservation.status='active'
        and tstzrange(segment.starts_at,segment.ends_at,'[)')
          && tstzrange(v_at,v_at+v_duration,'[)'))
    or exists(select 1 from public.cleaning_targets target where target.room_id=v_case.room_id
      and target.status not in ('approved','cancelled')) then
    raise exception using errcode='55000',message='COMPLAINT_REWORK_WINDOW_UNAVAILABLE'; end if;
  v_week:=v_today-(extract(isodow from v_today)::integer-1);
  if not exists(select 1 from public.availability_versions version
    join public.availability_days day on day.availability_version_id=version.id
    where version.maid_profile_id=v_assignee.id and version.week_start=v_week
      and version.is_current and version.status='submitted' and day.work_date=v_today and day.available) then
    raise exception using errcode='23514',message='COMPLAINT_REWORK_MAID_UNAVAILABLE'; end if;
  select coalesce(max(assignment.sequence_number),0)+1 into v_sequence
  from public.cleaning_assignments assignment
  where assignment.maid_profile_id=v_assignee.id and assignment.service_date=v_today and assignment.is_current;
  v_comp.id:=gen_random_uuid(); v_target.id:=gen_random_uuid(); v_assignment.id:=gen_random_uuid();
  insert into public.complaint_compensation_decisions(id,complaint_case_id,complaint_decision_id,
    original_cleaning_target_id,rework_cleaning_target_id,original_maid_profile_id,assignee_maid_profile_id,
    original_base_fee_snapshot,compensation_amount,source_case_version,decided_by,decided_at)
  values(v_comp.id,v_case.id,v_source.id,v_original_target.id,v_target.id,v_case.maid_profile_id,v_assignee.id,
    v_original_target.fee_snapshot,p_compensation_amount,v_case.version,v_actor.id,v_at)
  returning * into v_comp;
  insert into public.cleaning_targets(id,room_id,reservation_id,cleaning_kind,source,source_key,
    original_service_date,effective_service_date,carryover_count,available_from,due_at,status,
    assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by,
    complaint_compensation_decision_id)
  values(v_target.id,v_case.room_id,null,'reclean','post_approval_complaint_reclean',
    'complaint-rework:'||v_comp.id::text,v_today,v_today,0,v_at,v_due,'notified',1,
    v_original_target.room_type_snapshot,0,jsonb_build_object('id',v_template.id,'version',v_template.version,
      'durationMinutes',v_template.duration_minutes,'photoSlots',v_template.photo_slots),v_actor.id,v_comp.id)
  returning * into v_target;
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
    available_from,due_at,reason_code,changed_by,recorded_at)
  values(v_target.id,1,v_today,v_at,v_due,'COMPLAINT_REWORK_CONFIRMED',v_actor.id,v_at);
  insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,
    is_current,notified_at,changed_by,created_at)
  values(v_assignment.id,v_target.id,v_assignee.id,v_sequence,1,true,v_at,v_actor.id,v_at)
  returning * into v_assignment;
  update public.complaint_cases set current_compensation_decision_id=v_comp.id,
    version=version+1,updated_at=v_at where id=v_case.id returning * into v_case;
  insert into public.complaint_case_events(complaint_case_id,event_type,from_status,to_status,case_version,
    actor_profile_id,decision_id,compensation_decision_id,occurred_at)
  values(v_case.id,'rework_materialized',v_case.status,v_case.status,v_case.version,
    v_actor.id,v_source.id,v_comp.id,v_at);
  insert into public.notifications(recipient_profile_id,category,title,body,room_id,cleaning_target_id,
    dedupe_key,requires_action,occurred_at)
  values(v_assignee.id,'complaint_rework_assigned','컴플레인 재작업 배정',
    '승인 후 컴플레인 재작업이 배정되었습니다.',v_case.room_id,v_target.id,
    'complaint-rework:'||v_comp.id::text,true,v_at) returning id into v_notice;
  insert into private.notification_outbox(notification_id,channel,delivery_status,next_attempt_at,created_at)
  values(v_notice,'web_push','pending',v_at,v_at);
  v_result:=jsonb_build_object('complaint',private.get_complaint_projection(v_case.id,v_actor.id),
    'reworkDecision',private.complaint_compensation_projection(v_comp,v_case.current_decision_id),
    'assignment',jsonb_build_object('id',v_assignment.id,'cleaningTargetId',v_target.id,
      'maidProfileId',v_assignment.maid_profile_id,'sequenceNumber',v_assignment.sequence_number,
      'revision',v_assignment.revision,'serviceDate',v_assignment.service_date,
      'availableFrom',v_assignment.available_from_snapshot,'dueAt',v_assignment.due_at_snapshot));
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,after_state,request_hash,idempotency_key)
  values(v_actor.id,v_actor.display_name,'complaint.rework_materialized','complaint_compensation_decision',v_comp.id,
    v_at,jsonb_build_object('complaintId',v_case.id,'sourceComplaintDecisionId',v_source.id,
      'reworkCleaningTargetId',v_target.id,'assigneeMaidProfileId',v_assignee.id,
      'compensationAmount',v_comp.compensation_amount,'currency','KRW','caseVersion',v_case.version),
    p_request_hash,private.audit_command_key(v_actor.id,'complaint.materialize_rework',p_idempotency_key));
  perform private.complete_command(v_actor.id,'complaint.materialize_rework',p_idempotency_key,p_request_hash,v_comp.id,v_result);
  return v_result;
end $$;
revoke all on function public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text)
from public,anon,authenticated,service_role;
grant execute on function public.materialize_complaint_rework(uuid,uuid,bigint,uuid,uuid,integer,text,text)
to service_role;




create or replace function public.decide_checkout_presence_incident(
  p_actor_profile_id uuid,p_session_id uuid,p_incident_id uuid,p_expected_version bigint,
  p_expected_impact_fingerprint text,p_decision text,p_reason_code text,
  p_new_checkout_at timestamptz,p_reassignment jsonb,
  p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; maid public.profiles; i public.checkout_presence_incidents;
  d public.checkout_presence_incident_decisions; r public.reservations; o public.checkout_cleaning_obligations;
  t public.cleaning_targets; s public.cleaning_assignments; a public.cleaning_attempts;
  ns public.cleaning_assignments; na public.cleaning_attempts; replay jsonb; result jsonb;
  next_maid uuid; next_sequence integer; next_date date; next_from timestamptz; next_due timestamptz;
  at_time timestamptz; wk date; event_key text; v_attempt_number integer;
  decision_audit_id uuid;
  v_final_room_id uuid;
  previous_segment_mode text:=current_setting('app.reservation_segment_writer_mode',true);
  previous_terminal_kind text:=current_setting('app.notification_terminal_kind',true);
  previous_terminal_id text:=current_setting('app.notification_terminal_id',true);
  previous_writer_mode text:=current_setting('app.checkout_incident_writer_mode',true);
begin
  if p_incident_id is null or p_expected_version is null or p_expected_version<1
    or p_expected_impact_fingerprint is null
    or p_expected_impact_fingerprint !~ '^[0-9a-f]{64}$'
    or p_decision is null or p_decision not in ('EXTEND_CHECKOUT','CONFIRM_DEPARTED','FALSE_REPORT')
    or p_reason_code<>(case p_decision when 'EXTEND_CHECKOUT' then 'GUEST_STILL_PRESENT_EXTENDED'
      when 'CONFIRM_DEPARTED' then 'GUEST_DEPARTURE_CONFIRMED' else 'REPORT_FALSE_CONFIRMED' end)
    or jsonb_typeof(p_reassignment) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(p_reassignment) k)
      is distinct from array['availableFrom','dueAt','maidProfileId','sequenceNumber','serviceDate']::text[]
    or jsonb_typeof(p_reassignment->'sequenceNumber')<>'number' then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end if;
  begin
    next_maid:=(p_reassignment->>'maidProfileId')::uuid;
    next_sequence:=(p_reassignment->>'sequenceNumber')::integer;
    next_date:=(p_reassignment->>'serviceDate')::date;
    next_from:=(p_reassignment->>'availableFrom')::timestamptz;
    next_due:=(p_reassignment->>'dueAt')::timestamptz;
  exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role<>'admin' then raise exception using errcode='42501',message='ADMIN_REQUIRED'; end if;
  replay:=private.replay_command(p_actor_profile_id,'checkout.presence.decision',p_idempotency_key,p_request_hash);
  if replay is not null then return replay; end if;
  if next_maid is null or next_sequence is null or next_sequence<1 or next_date is null
    or next_from is null or next_due is null or not isfinite(next_from) or not isfinite(next_due)
    or next_due<=next_from or next_from<>date_trunc('minute',next_from)
    or next_due<>date_trunc('minute',next_due)
    or (p_decision='EXTEND_CHECKOUT' and (p_new_checkout_at is null
      or not isfinite(p_new_checkout_at) or p_new_checkout_at<>date_trunc('minute',p_new_checkout_at)
      or next_from<>p_new_checkout_at
      or next_date<>(p_new_checkout_at at time zone 'Asia/Seoul')::date))
    or (p_decision<>'EXTEND_CHECKOUT' and p_new_checkout_at is not null) then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end if;
  select * into i from public.checkout_presence_incidents where id=p_incident_id for update;
  if i.id is null then raise exception using errcode='P0002',message='CHECKOUT_INCIDENT_NOT_FOUND'; end if;
  select * into r from public.reservations where id=i.reservation_id for update;
  select * into o from public.checkout_cleaning_obligations where id=i.checkout_obligation_id for update;
  select * into t from public.cleaning_targets where id=i.cleaning_target_id for update;
  select * into s from public.cleaning_assignments where id=i.assignment_id for update;
  select * into a from public.cleaning_attempts where id=i.attempt_id for update;
  v_final_room_id:=private.reservation_final_room_id(r.id);
  -- assert_room_pin_actor_session() already holds the actor row FOR SHARE for
  -- the transaction. Re-locking that row FOR NO KEY UPDATE after the global
  -- reservation lock inverts the legacy reservation command order
  -- (actor SHARE -> global lock) and can deadlock. Lock only the assignee here;
  -- the actor's role/status remains protected by the existing SHARE lock.
  perform 1 from public.profiles where id=next_maid for no key update;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  select * into maid from public.profiles where id=next_maid;
  if i.status<>'open' or i.version<>p_expected_version
    or r.id is null or o.id is null or t.id is null or s.id is null or a.id is null
    or r.status<>'checked_out' or r.actual_checkout_at is null
    or v_final_room_id is null or t.room_id<>v_final_room_id or o.room_id<>v_final_room_id
    or o.current_cleaning_target_id<>t.id or t.reservation_id<>r.id
    or t.cleaning_kind<>'checkout' or s.id<>a.assignment_id
    or maid.role<>'maid' or maid.status<>'active' or maid.must_change_password then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_VERSION_CONFLICT';
  end if;
  if private.checkout_incident_impact_fingerprint(i.id)<>p_expected_impact_fingerprint then
    raise exception using errcode='40001',message='CHECKOUT_INCIDENT_IMPACT_CHANGED';
  end if;
  wk:=next_date-(extract(isodow from next_date)::integer-1);
  perform pg_advisory_xact_lock(hashtextextended('availability:'||next_maid::text||':'||wk::text,0));
  if not exists(select 1 from public.availability_versions v join public.availability_days ad
    on ad.availability_version_id=v.id where v.maid_profile_id=next_maid and v.week_start=wk
      and v.is_current and ad.work_date=next_date and ad.available) then
    raise exception using errcode='23514',message='ASSIGNMENT_MAID_UNAVAILABLE';
  end if;
  if exists(select 1 from public.cleaning_assignments x where x.is_current
    and x.maid_profile_id=next_maid and x.service_date=next_date
    and x.sequence_number=next_sequence and x.id<>s.id) then
    raise exception using errcode='23514',message='ASSIGNMENT_SEQUENCE_CONFLICT';
  end if;
  -- Reuse the canonical execution/handover interval contract after every
  -- reservation/target/assignment/availability lock and current-state check.
  -- This preserves the KST service-day boundary and the next check-in buffer
  -- before any incident, assignment, attempt, notification, or receipt write.
  perform private.assert_handover_schedule(t,next_date,next_from,next_due);
  -- This clock sample deliberately occurs after every domain lock and current
  -- state/fingerprint revalidation. A request that waited on a lock cannot
  -- materialize an assignment whose due boundary elapsed while it waited.
  at_time:=clock_timestamp();
  if next_due<=at_time
    or (p_decision='EXTEND_CHECKOUT' and p_new_checkout_at<=at_time)
    or (p_decision<>'EXTEND_CHECKOUT' and (next_from>at_time
      or next_date<>(at_time at time zone 'Asia/Seoul')::date)) then
    raise exception using errcode='22023',message='INVALID_CHECKOUT_INCIDENT_DECISION';
  end if;
  perform set_config('app.checkout_incident_writer_mode','typed_v1',true);
  update public.room_pin_access_leases set revoked_at=coalesce(revoked_at,at_time),
    revoke_reason_code=case when revoked_at is null then 'CHECKOUT_NOT_COMPLETED' else revoke_reason_code end
    where attempt_id=a.id;
  insert into private.offline_work_lease_revocations(lease_id,revoked_at,reason_code,metadata_expires_at)
    select l.id,at_time,'CHECKOUT_NOT_COMPLETED',l.metadata_expires_at from private.offline_work_leases l
    where l.attempt_id=a.id on conflict(lease_id) do nothing;
  insert into private.attempt_capability_revocations(capability_id,revoked_at,reason_code,actor_profile_id)
    select g.id,at_time,'CHECKOUT_NOT_COMPLETED',p_actor_profile_id from private.attempt_capability_grants g
    where g.attempt_id=a.id on conflict(capability_id) do nothing;
  update public.cleaning_attempts set status=case when status='in_progress' then 'interrupted'::public.attempt_status
      else 'superseded'::public.attempt_status end,ended_at=at_time,end_reason='CHECKOUT_NOT_COMPLETED',
      execution_version=execution_version+1 where id=a.id and status in ('scheduled','in_progress');
  update public.cleaning_assignments set is_current=false,ended_at=at_time,
    change_reason_code='CHECKOUT_NOT_COMPLETED' where id=s.id and is_current;
  update public.cleaning_targets set effective_service_date=next_date,available_from=next_from,due_at=next_due,
    assignment_version=assignment_version+1,status='notified' where id=t.id returning * into t;
  insert into public.cleaning_target_schedule_revisions(cleaning_target_id,revision,effective_service_date,
    available_from,due_at,reason_code,changed_by)
  values(t.id,t.assignment_version,next_date,next_from,next_due,p_reason_code,p_actor_profile_id);
  insert into public.cleaning_assignments(cleaning_target_id,maid_profile_id,sequence_number,revision,changed_by,notified_at)
  values(t.id,next_maid,next_sequence,t.assignment_version,p_actor_profile_id,at_time) returning * into ns;

  if p_decision='EXTEND_CHECKOUT' then
    perform set_config('app.reservation_segment_writer_mode','schedule_change_v1',true);
    update public.reservations set check_out_at=p_new_checkout_at,status='active',actual_checkout_at=null,
      version=version+1,updated_by=p_actor_profile_id where id=r.id returning * into r;
    perform set_config('app.reservation_segment_writer_mode',coalesce(previous_segment_mode,''),true);
    update public.checkout_cleaning_obligations set status='private',effective_service_date=next_date,
      available_from=next_from,due_at=next_due,current_cleaning_target_id=null,
      planned_cleaning_target_id=t.id,version=version+1 where id=o.id returning * into o;
    event_key:=private.audit_command_key(p_actor_profile_id,'checkout.presence.occupancy_resumed',p_idempotency_key);
    insert into public.room_occupancy_events(event_key,room_id,reservation_id,event_type,effective_at,
      actor_profile_id,reason_code,before_state,after_state)
    values(event_key,t.room_id,r.id,'occupancy_resumed',at_time,p_actor_profile_id,p_reason_code,
      jsonb_build_object('occupied',false),jsonb_build_object('occupied',true));
  else
    update public.checkout_cleaning_obligations set status='materialized',effective_service_date=next_date,
      available_from=next_from,due_at=next_due,current_cleaning_target_id=t.id,
      planned_cleaning_target_id=t.id,version=version+1 where id=o.id returning * into o;
    select coalesce(max(existing_attempt.attempt_number),0)+1 into v_attempt_number
    from public.cleaning_attempts existing_attempt where existing_attempt.cleaning_target_id=t.id;
    insert into public.cleaning_attempts(cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,
      assignment_revision,template_snapshot,room_snapshot)
    select t.id,ns.id,next_maid,v_attempt_number,'scheduled',ns.revision,
      t.template_snapshot,t.room_type_snapshot||jsonb_build_object('roomId',room.id,
        'roomNumber',room.room_number,'elevatorZone',room.elevator_zone)
    from public.rooms room where room.id=t.room_id returning * into na;
  end if;

  insert into public.checkout_presence_incident_decisions(incident_id,incident_version,decision,reason_code,
    decided_by,decided_at,new_checkout_at,next_assignment_id,next_attempt_id)
  values(i.id,i.version,p_decision,p_reason_code,p_actor_profile_id,at_time,p_new_checkout_at,ns.id,na.id)
  returning * into d;
  update public.checkout_presence_incidents set status='resolved',current_decision_id=d.id,
    resolved_at=at_time,version=version+1 where id=i.id returning * into i;
  insert into public.audit_events(event_type,entity_type,entity_id,actor_profile_id,
    actor_display_name_snapshot,effective_at,recorded_at,reason_code,after_state,idempotency_key)
  values('checkout.presence_decided','checkout_presence_incident',i.id,p_actor_profile_id,
    actor.display_name,at_time,clock_timestamp(),p_reason_code,
    jsonb_build_object('incidentId',i.id,'decisionId',d.id,'decision',p_decision,
      'reservationId',r.id,'roomId',t.room_id,'cleaningTargetId',t.id,
      'nextAssignmentId',ns.id,'nextAttemptId',na.id,'version',i.version),
    private.audit_command_key(p_actor_profile_id,'checkout.presence.decision',p_idempotency_key))
  returning id into decision_audit_id;
  perform set_config('app.notification_terminal_kind','audit_event',true);
  perform set_config('app.notification_terminal_id',decision_audit_id::text,true);
  perform private.resolve_notifications_v1('checkout.presence_reported_admin','checkout_presence_incident',i.id::text,at_time);
  perform set_config('app.notification_terminal_kind',coalesce(previous_terminal_kind,''),true);
  perform set_config('app.notification_terminal_id',coalesce(previous_terminal_id,''),true);
  perform private.emit_checkout_incident_notification('checkout.presence_resolved_maid',p_actor_profile_id,
    ns.maid_profile_id,i.id,d.id,at_time);
  perform private.emit_notification_v1(
    'assignment.commit_notified',p_actor_profile_id,ns.maid_profile_id,
    'cleaning_assignment',ns.id::text,
    coalesce(t.room_type_snapshot->>'roomNumber','객실')||'호 청소 배정',
    t.effective_service_date::text||' · '||ns.sequence_number||'번째 청소가 배정되었습니다.',
    t.room_id,t.id,t.id,at_time
  );
  if s.maid_profile_id<>ns.maid_profile_id then
    perform private.emit_checkout_incident_notification('checkout.presence_previous_maid_resolved',p_actor_profile_id,
      s.maid_profile_id,i.id,d.id,at_time);
  end if;
  result:=private.checkout_incident_projection(i)||jsonb_build_object(
    'impactFingerprint',private.checkout_incident_impact_fingerprint(i.id),
    'decision',private.checkout_incident_decision_projection(d));
  perform set_config('app.checkout_incident_writer_mode',coalesce(previous_writer_mode,''),true);
  perform private.complete_command(p_actor_profile_id,'checkout.presence.decision',p_idempotency_key,
    p_request_hash,i.id,result);
  return result;
end $$;
