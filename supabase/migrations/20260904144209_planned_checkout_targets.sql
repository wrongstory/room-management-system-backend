-- Planning identity is independent of operational materialization (#1/#4/#26/#28).
alter table public.checkout_cleaning_obligations
  add column planned_cleaning_target_id uuid unique,
  add constraint checkout_obligations_planned_target_fk
    foreign key (planned_cleaning_target_id, id, reservation_id, room_id)
    references public.cleaning_targets (id, checkout_obligation_id, reservation_id, room_id)
    on delete restrict deferrable initially deferred;
create index checkout_obligations_planned_target_contract_idx
on public.checkout_cleaning_obligations (planned_cleaning_target_id, id, reservation_id, room_id);

create function private.ensure_planned_checkout_target(p_obligation_id uuid)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  o public.checkout_cleaning_obligations%rowtype;
  r public.rooms%rowtype;
  rt public.room_types%rowtype;
  template public.cleaning_template_versions%rowtype;
  target_id uuid;
begin
  select * into strict o from public.checkout_cleaning_obligations
  where id = p_obligation_id for update;
  if o.planned_cleaning_target_id is not null then return o.planned_cleaning_target_id; end if;
  if o.status = 'cancelled' then return null; end if;
  target_id := o.current_cleaning_target_id;
  if target_id is null then
    select id into target_id from public.cleaning_targets
    where checkout_obligation_id = o.id;
  end if;
  if target_id is null then
    select * into strict r from public.rooms where id = o.room_id;
    select * into strict rt from public.room_types where id = r.room_type_id;
    select * into template from public.cleaning_template_versions
    where room_type_id = r.room_type_id and cleaning_kind = 'checkout' and status = 'published';
    if not found then
      raise exception using errcode = '23514', message = 'CLEANING_TEMPLATE_NOT_CONFIGURED';
    end if;
    insert into public.cleaning_targets (
      room_id, reservation_id, checkout_obligation_id, cleaning_kind, source, source_key,
      original_service_date, effective_service_date, available_from, due_at,
      room_type_snapshot, fee_snapshot, template_snapshot, created_by
    ) values (
      o.room_id, o.reservation_id, o.id, 'checkout', 'scheduled_checkout',
      'checkout-obligation:' || o.id::text, o.original_service_date, o.effective_service_date,
      o.available_from, o.due_at,
      jsonb_build_object('id', rt.id, 'code', rt.code, 'name', rt.name,
        'roomNumber', r.room_number, 'elevatorZone', r.elevator_zone,
        'defaultDurationMinutes', rt.default_duration_minutes),
      rt.base_cleaning_fee,
      jsonb_build_object('id', template.id, 'version', template.version,
        'durationMinutes', template.duration_minutes, 'photoSlots', template.photo_slots),
      o.created_by
    ) returning id into target_id;
    insert into public.cleaning_target_schedule_revisions (
      cleaning_target_id, revision, effective_service_date, available_from, due_at,
      reason_code, changed_by
    ) values (target_id, 1, o.effective_service_date, o.available_from, o.due_at,
      'CHECKOUT_PLANNED', o.created_by);
  end if;
  update public.checkout_cleaning_obligations
  set planned_cleaning_target_id = target_id where id = o.id;
  return target_id;
end;
$$;
revoke all on function private.ensure_planned_checkout_target(uuid) from public, anon, authenticated;

-- Existing operational identity/snapshots are reused, never recreated.
do $$
declare item record;
begin
  for item in select id from public.checkout_cleaning_obligations where status <> 'cancelled' order by id
  loop perform private.ensure_planned_checkout_target(item.id); end loop;
end;
$$;

create function private.guard_planned_checkout_identity()
returns trigger language plpgsql set search_path = ''
as $$
begin
  if old.planned_cleaning_target_id is not null
    and new.planned_cleaning_target_id is distinct from old.planned_cleaning_target_id then
    raise exception using errcode = '23514', message = 'CHECKOUT_PLANNED_IDENTITY_IMMUTABLE';
  end if;
  if new.planned_cleaning_target_id is not null and new.status = 'available' then
    -- Both scheduled and manual checkout use this promotion; no target is inserted.
    new.current_cleaning_target_id := new.planned_cleaning_target_id;
    new.status := 'materialized';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_planned_checkout_identity() from public, anon, authenticated;
create trigger aa_checkout_planned_identity
before update on public.checkout_cleaning_obligations
for each row execute function private.guard_planned_checkout_identity();

create function private.sync_planned_checkout_target()
returns trigger language plpgsql security definer set search_path = ''
as $$
declare
  t public.cleaning_targets%rowtype;
  a public.cleaning_assignments%rowtype;
  r public.reservations%rowtype;
  changed boolean;
  promoted boolean;
  notice_id uuid;
  reason text;
begin
  if new.planned_cleaning_target_id is null then return null; end if;
  select * into strict t from public.cleaning_targets
  where id = new.planned_cleaning_target_id for update;
  select * into strict r from public.reservations where id = new.reservation_id;
  select * into a from public.cleaning_assignments
  where cleaning_target_id = t.id and is_current for update;
  changed := t.room_id is distinct from new.room_id
    or t.effective_service_date is distinct from new.effective_service_date
    or t.available_from is distinct from new.available_from
    or t.due_at is distinct from new.due_at;
  promoted := old.current_cleaning_target_id is null and new.status = 'materialized';

  if new.status = 'cancelled' and t.status <> 'cancelled' then
    if exists(select 1 from public.cleaning_attempts where cleaning_target_id=t.id and status <> 'superseded')
      or exists(select 1 from public.room_pin_access_leases where cleaning_target_id=t.id and revoked_at is null) then
      raise exception using errcode='23514', message='CLEANING_WORKFLOW_CANCEL_CONFLICT';
    end if;
    update public.cleaning_assignments set is_current=false, ended_at=now(),
      change_reason_code='RESERVATION_CANCELLED' where id=a.id;
    update public.cleaning_targets set status='cancelled', cancelled_at=new.cancelled_at,
      cancelled_by=r.updated_by, cancellation_reason_code=new.cancellation_reason_code,
      assignment_version=assignment_version+1 where id=t.id;
    reason := 'RESERVATION_CANCELLED';
  elsif changed and old.current_cleaning_target_id is null then
    -- Planned unnotified drafts retain their old snapshot and become stale.
    -- A normal reservation change must not silently rewrite a notified assignment.
    if not promoted and (t.status not in ('unassigned','draft_assigned') or a.notified_at is not null) then
      raise exception using errcode='23514', message='CLEANING_WORKFLOW_REPLAN_REQUIRED';
    end if;
    update public.cleaning_targets set room_id=new.room_id,
      effective_service_date=new.effective_service_date, available_from=new.available_from,
      due_at=new.due_at, assignment_version=assignment_version+1
    where id=t.id returning * into t;
    insert into public.cleaning_target_schedule_revisions (
      cleaning_target_id, revision, effective_service_date, available_from, due_at, reason_code, changed_by
    ) values (t.id,t.assignment_version,t.effective_service_date,t.available_from,t.due_at,
      case when promoted then 'MANUAL_CHECKOUT' else 'RESERVATION_SCHEDULE_CHANGED' end, r.updated_by);
    if promoted and a.id is not null then
      update public.cleaning_assignments set is_current=false, ended_at=r.actual_checkout_at,
        change_reason_code='MANUAL_CHECKOUT_RESCHEDULE' where id=a.id;
      insert into public.cleaning_assignments (
        cleaning_target_id,maid_profile_id,sequence_number,revision,is_current,notified_at,changed_by
      ) values (t.id,a.maid_profile_id,a.sequence_number,t.assignment_version,true,
        case when a.notified_at is not null then r.actual_checkout_at end,r.updated_by);
      reason := 'MANUAL_CHECKOUT_RESCHEDULE';
    end if;
  end if;
  if reason is not null and a.notified_at is not null then
    update public.notifications set resolved_at=coalesce(resolved_at,now())
    where cleaning_target_id=t.id and recipient_profile_id=a.maid_profile_id and requires_action;
    insert into public.notifications (
      recipient_profile_id,category,title,body,room_id,cleaning_target_id,dedupe_key,requires_action
    ) values (
      a.maid_profile_id,
      case when reason='RESERVATION_CANCELLED' then 'cleaning_assignment_revoked' else 'cleaning_schedule_changed' end,
      case when reason='RESERVATION_CANCELLED' then '청소 배정이 회수되었습니다' else '청소 시작 시간이 변경되었습니다' end,
      '예약 변경 내역을 확인해 주세요.',new.room_id,t.id,
      'checkout-plan:' || t.id::text || ':' || new.version::text || ':' || reason,
      reason <> 'RESERVATION_CANCELLED'
    ) returning id into notice_id;
    insert into private.notification_outbox(notification_id,channel,delivery_status)
    values(notice_id,'web_push','pending');
  end if;
  return null;
end;
$$;
revoke all on function private.sync_planned_checkout_target() from public, anon, authenticated;
create trigger checkout_planned_target_sync
after update on public.checkout_cleaning_obligations
for each row execute function private.sync_planned_checkout_target();

create function private.validate_planned_checkout_at_commit()
returns trigger language plpgsql set search_path = ''
as $$
declare obligation_id uuid;
begin
  if tg_table_name='checkout_cleaning_obligations' then obligation_id:=new.id;
  elsif tg_table_name='reservations' then obligation_id:=new.checkout_obligation_id;
  else obligation_id:=new.checkout_obligation_id; end if;
  if exists (
    select 1 from public.checkout_cleaning_obligations o
    join public.reservations r on r.id=o.reservation_id
    left join public.cleaning_targets t on t.id=o.planned_cleaning_target_id
    where o.id=obligation_id and o.planned_cleaning_target_id is not null and (
      t.id is null or t.checkout_obligation_id<>o.id or t.reservation_id<>r.id or t.room_id<>r.room_id
      or (o.status='private' and (r.status<>'active' or r.actual_checkout_at is not null
        or o.available_from<>r.check_out_at or t.available_from<>o.available_from
        or t.effective_service_date<>o.effective_service_date or t.due_at is distinct from o.due_at
        or t.status not in ('unassigned','draft_assigned','notified')
        or exists(select 1 from public.cleaning_attempts a where a.cleaning_target_id=t.id and a.status<>'superseded')
        or exists(select 1 from public.room_pin_access_leases l where l.cleaning_target_id=t.id and l.revoked_at is null)))
      or (o.status in ('materialized','completed') and (
        o.current_cleaning_target_id is distinct from t.id or r.status<>'checked_out'
        or r.actual_checkout_at is null))
      or (o.status='cancelled' and (t.status<>'cancelled'
        or exists(select 1 from public.cleaning_assignments a where a.cleaning_target_id=t.id and a.is_current)))
    )
  ) then raise exception using errcode='23514', message='CHECKOUT_PLANNED_CONTRACT_NOT_ATOMIC'; end if;
  return null;
end;
$$;
revoke all on function private.validate_planned_checkout_at_commit() from public, anon, authenticated;
create constraint trigger checkout_planned_validate
after insert or update on public.checkout_cleaning_obligations deferrable initially deferred
for each row execute function private.validate_planned_checkout_at_commit();
create constraint trigger checkout_planned_target_validate
after insert or update on public.cleaning_targets deferrable initially deferred
for each row execute function private.validate_planned_checkout_at_commit();
create constraint trigger checkout_planned_reservation_validate
after insert or update on public.reservations deferrable initially deferred
for each row execute function private.validate_planned_checkout_at_commit();

-- Execution gates do not grant/create work. #28 remains the only activation owner.
create function private.guard_checkout_execution()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name='cleaning_attempts' then
    if tg_op='UPDATE' and new.status='superseded' then return new; end if;
  end if;
  if tg_table_name='room_pin_access_leases' then
    if tg_op='UPDATE' and new.revoked_at is not null then return new; end if;
  end if;
  -- Serialize permission checks with reservation extension/materialization.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  if exists (
    select 1 from public.cleaning_targets t
    where t.id=new.cleaning_target_id and t.cleaning_kind='checkout'
      and not exists (
        select 1 from public.checkout_cleaning_obligations o
        join public.reservations r on r.id=o.reservation_id
        where o.id=t.checkout_obligation_id and o.current_cleaning_target_id=t.id
          and o.status in ('materialized','completed') and r.status='checked_out'
          and r.actual_checkout_at is not null and r.actual_checkout_at<=clock_timestamp()
          and t.available_from<=clock_timestamp()
      )
  ) then raise exception using errcode='23514', message='CHECKOUT_NOT_MATERIALIZED'; end if;
  return new;
end;
$$;
revoke all on function private.guard_checkout_execution() from public, anon, authenticated;
create trigger aa_checkout_attempt_execution_guard
before insert or update on public.cleaning_attempts
for each row execute function private.guard_checkout_execution();


-- Preserve existing public RPC signatures/grants, replacing only lifecycle internals.
create or replace function public.create_reservation(
  p_actor_profile_id uuid,
  p_reservation_id uuid,
  p_room_id uuid,
  p_check_in_at timestamptz,
  p_check_out_at timestamptz,
  p_guest_count integer,
  p_guest_name_encrypted text,
  p_expected_room_version bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_room public.rooms%rowtype;
  v_reservation public.reservations%rowtype;
  v_preparation_id uuid := gen_random_uuid();
  v_checkout_obligation_id uuid := gen_random_uuid();
  v_assignment_reasons text[];
  v_response jsonb;
begin
  perform private.assert_room_admin(p_actor_profile_id);
  v_response := private.replay_command(
    p_actor_profile_id,
    'reservation.create',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  -- Reservation commands share one short transaction lock. The free-plan workload is
  -- small, and a single ordering point prevents room/reservation/obligation deadlocks.
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

  select * into v_room from public.rooms where id = p_room_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND';
  end if;
  if v_room.state_version <> p_expected_room_version then
    raise exception using errcode = '40001', message = 'STALE_VERSION';
  end if;

  v_assignment_reasons := private.room_block_reason_codes(p_room_id, now(), false, false);
  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = p_room_id
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

  insert into public.reservations (
    id,
    room_id,
    check_in_at,
    check_out_at,
    guest_count,
    guest_name_encrypted,
    preparation_obligation_id,
    checkout_obligation_id,
    created_by,
    updated_by
  ) values (
    p_reservation_id,
    p_room_id,
    p_check_in_at,
    p_check_out_at,
    p_guest_count,
    p_guest_name_encrypted,
    v_preparation_id,
    v_checkout_obligation_id,
    p_actor_profile_id,
    p_actor_profile_id
  )
  returning * into v_reservation;

  insert into public.preparation_obligations (
    id,
    reservation_id,
    room_id
  ) values (
    v_preparation_id,
    v_reservation.id,
    v_reservation.room_id
  );

  insert into public.checkout_cleaning_obligations (
    id,
    reservation_id,
    room_id,
    original_service_date,
    effective_service_date,
    available_from,
    created_by
  ) values (
    v_checkout_obligation_id,
    v_reservation.id,
    v_reservation.room_id,
    (v_reservation.check_out_at at time zone 'Asia/Seoul')::date,
    (v_reservation.check_out_at at time zone 'Asia/Seoul')::date,
    v_reservation.check_out_at,
    p_actor_profile_id
  );

  perform private.ensure_planned_checkout_target(v_checkout_obligation_id);

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
    v_reservation.id,
    v_reservation.version,
    v_reservation.room_id,
    v_reservation.check_in_at,
    v_reservation.check_out_at,
    v_reservation.guest_count,
    'RESERVATION_CREATED',
    p_actor_profile_id,
    now()
  );

  update public.rooms
  set state_version = state_version + 1
  where id = v_reservation.room_id
  returning * into v_room;

  perform private.refresh_checkout_due_at(v_reservation.room_id, p_actor_profile_id);
  perform private.invalidate_stale_preparation_proofs(
    v_reservation.room_id,
    'PREVIOUS_OCCUPANCY_CHANGED'
  );

  v_response := private.reservation_response(v_reservation)
    || jsonb_build_object(
      'room_state_version', v_room.state_version
    );

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    reason_code,
    after_state,
    request_hash,
    idempotency_key
  )
  select
    p.id,
    p.display_name,
    'reservation.created',
    'reservation',
    v_reservation.id,
    now(),
    'RESERVATION_CREATED',
    v_response,
    p_request_hash,
    private.audit_command_key(p_actor_profile_id, 'reservation.create', p_idempotency_key)
  from public.profiles p where p.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'reservation.create',
    p_idempotency_key,
    p_request_hash,
    v_reservation.id,
    v_response
  );
  return v_response;
exception
  when exclusion_violation then
    raise exception using errcode = '23P01', message = 'RESERVATION_OVERLAP';
end;
$$;

create or replace function private.refresh_checkout_due_at(
  p_room_id uuid,
  p_actor_profile_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_item record;
  v_target public.cleaning_targets%rowtype;
begin
  for v_item in
    select
      o.id as obligation_id,
      coalesce(o.current_cleaning_target_id, o.planned_cleaning_target_id) as current_cleaning_target_id,
      o.status as obligation_status,
      case
        when next_stay.next_check_in_at is null then null
        else next_stay.next_check_in_at - interval '30 minutes'
      end as desired_due_at
    from public.checkout_cleaning_obligations o
    join public.reservations r on r.id = o.reservation_id
    cross join lateral (
      select (
        select min(next_r.check_in_at)
        from public.reservations next_r
        where next_r.room_id = r.room_id
          and next_r.status = 'active'
          and next_r.check_in_at >= r.check_out_at
          and next_r.id <> r.id
      ) as next_check_in_at
    ) next_stay
    where r.room_id = p_room_id
      and r.status <> 'cancelled'
      and o.status in ('private', 'available', 'materialized')
      and o.due_at is distinct from case
        when next_stay.next_check_in_at is null then null
        else next_stay.next_check_in_at - interval '30 minutes'
      end
    order by r.check_out_at, r.id
  loop
    if v_item.current_cleaning_target_id is not null then
      select * into v_target
      from public.cleaning_targets t
      where t.id = v_item.current_cleaning_target_id
      for update;

      if v_target.status in ('approved', 'cancelled') then
        continue;
      end if;
      if v_target.status <> 'unassigned' and not (
        v_target.status = 'draft_assigned' and v_item.obligation_status = 'private'
        and not exists (select 1 from public.cleaning_assignments a
          where a.cleaning_target_id=v_target.id and a.is_current and a.notified_at is not null)
      ) then
        raise exception using
          errcode = '23514',
          message = 'CLEANING_DUE_REPLAN_REQUIRED';
      end if;

      update public.cleaning_targets
      set due_at = v_item.desired_due_at,
          assignment_version = assignment_version + 1
      where id = v_target.id
      returning * into v_target;

      insert into public.cleaning_target_schedule_revisions (
        cleaning_target_id,
        revision,
        effective_service_date,
        available_from,
        due_at,
        reason_code,
        changed_by
      ) values (
        v_target.id,
        v_target.assignment_version,
        v_target.effective_service_date,
        v_target.available_from,
        v_target.due_at,
        'NEXT_RESERVATION_CHANGED',
        p_actor_profile_id
      );
    end if;

    update public.checkout_cleaning_obligations
    set due_at = v_item.desired_due_at,
        version = version + 1
    where id = v_item.obligation_id;
  end loop;
end;
$$;

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
  perform 1
  from public.rooms r
  where r.id in (v_old_room_id, p_room_id)
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
      or p_room_id <> v_reservation.room_id
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
      where t.reservation_id = v_reservation.id
        and a.status <> 'superseded'
        and (a.started_at is not null or a.status <> 'scheduled')
    ) or exists (
      select 1
      from public.room_pin_access_leases l
      where l.reservation_id = v_reservation.id
        and l.revealed_at is not null
        and l.revoked_at is null
    ) then
      raise exception using errcode = '23514', message = 'RESERVATION_EXTENSION_ACCESS_CONFLICT';
    end if;
    v_reopen_occupancy := true;
  end if;

  if v_reservation.actual_check_in_at is not null and not v_reopen_occupancy then
    if p_room_id <> v_reservation.room_id or p_check_in_at <> v_reservation.check_in_at then
      raise exception using errcode = '23514', message = 'OCCUPIED_RESERVATION_SCHEDULE_LOCKED';
    end if;
    if p_check_out_at <= now() then
      raise exception using errcode = '23514', message = 'MANUAL_CHECKOUT_REQUIRED';
    end if;
  end if;

  if v_checkout_obligation.current_cleaning_target_id is not null
    and (
      p_room_id <> v_reservation.room_id
      or p_check_out_at <> v_reservation.check_out_at
    ) then
    if not v_reopen_occupancy then
      raise exception using errcode = '23514', message = 'CLEANING_WORKFLOW_REPLAN_REQUIRED';
    end if;
  end if;

  if p_room_id <> v_reservation.room_id then
    v_assignment_reasons := private.room_block_reason_codes(p_room_id, now(), false, false);
  else
    v_assignment_reasons := array[]::text[];
  end if;
  if exists (
    select 1
    from public.room_operation_blocks b
    where b.room_id = p_room_id
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

  update public.reservations
  set room_id = p_room_id,
      check_in_at = p_check_in_at,
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

  update public.preparation_obligations
  set room_id = p_room_id,
      status = case
        when p_room_id <> v_reservation.room_id
          or p_check_in_at <> v_reservation.check_in_at then 'invalidated'
        else status
      end,
      approved_submission_id = case
        when p_room_id <> v_reservation.room_id
          or p_check_in_at <> v_reservation.check_in_at then null
        else approved_submission_id
      end,
      invalidated_reason_code = case
        when p_room_id <> v_reservation.room_id then 'RESERVATION_ROOM_CHANGED'
        when p_check_in_at <> v_reservation.check_in_at then 'RESERVATION_CHECK_IN_CHANGED'
        else invalidated_reason_code
      end,
      version = version + 1
  where reservation_id = v_reservation.id;

  update public.checkout_cleaning_obligations
  set room_id = p_room_id,
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
    v_updated.room_id,
    v_updated.check_in_at,
    v_updated.check_out_at,
    v_updated.guest_count,
    p_reason_code,
    p_actor_profile_id,
    now()
  );

  update public.rooms
  set state_version = state_version + 1
  where id in (v_old_room_id, p_room_id);

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
      v_updated.room_id,
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
      v_updated.room_id,
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

  perform private.refresh_checkout_due_at(v_old_room_id, p_actor_profile_id);
  perform private.invalidate_stale_preparation_proofs(
    v_old_room_id,
    'RESERVATION_SCHEDULE_CHANGED'
  );
  if p_room_id <> v_old_room_id then
    perform private.refresh_checkout_due_at(p_room_id, p_actor_profile_id);
    perform private.invalidate_stale_preparation_proofs(
      p_room_id,
      'RESERVATION_SCHEDULE_CHANGED'
    );
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
    raise exception using errcode = '23P01', message = 'RESERVATION_OVERLAP';
end;
$$;

create or replace function private.assignment_commit_candidates_at(
  p_service_date date,
  p_command_at timestamptz
)
returns table (
  target_id uuid,
  room_id uuid,
  room_number text,
  target_assignment_version bigint,
  target_status public.cleaning_target_status,
  target_available_from timestamptz,
  target_due_at timestamptz,
  assignment_id uuid,
  maid_profile_id uuid,
  maid_display_name text,
  assignment_service_date date,
  sequence_number integer,
  assignment_revision bigint,
  assignment_available_from timestamptz,
  assignment_due_at timestamptz,
  assignment_notified_at timestamptz,
  availability_version integer,
  availability_day_available boolean,
  reason_code text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    target.id,
    target.room_id,
    room.room_number,
    target.assignment_version,
    target.status,
    target.available_from,
    target.due_at,
    assignment.id,
    assignment.maid_profile_id,
    maid.display_name,
    assignment.service_date,
    assignment.sequence_number,
    assignment.revision,
    assignment.available_from_snapshot,
    assignment.due_at_snapshot,
    assignment.notified_at,
    availability.version,
    day.available,
    case
      when target.status = 'unassigned' then null
      when p_service_date not in (
        (p_command_at at time zone 'Asia/Seoul')::date,
        (p_command_at at time zone 'Asia/Seoul')::date + 1
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when assignment.id is null or assignment.notified_at is not null
        then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when assignment.revision <> target.assignment_version
        or assignment.service_date <> target.effective_service_date
        or assignment.service_date <> p_service_date
        or assignment.available_from_snapshot is distinct from target.available_from
        or assignment.due_at_snapshot is distinct from target.due_at
        then 'ASSIGNMENT_DRAFT_STALE_SCHEDULE'
      when exists (
        select 1
        from public.cleaning_attempts attempt
        where attempt.cleaning_target_id = target.id
          and attempt.status <> 'superseded'
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when maid.id is null or maid.role <> 'maid' or maid.status <> 'active'
        then 'ASSIGNMENT_MAID_UNAVAILABLE'
      when availability.id is null then 'ASSIGNMENT_AVAILABILITY_REQUIRED'
      when day.available is distinct from true then 'ASSIGNMENT_MAID_UNAVAILABLE'
      when target.due_at is not null and target.due_at <= p_command_at
        then 'ASSIGNMENT_WINDOW_EXPIRED'
      when target.source in ('scheduled_checkout', 'manual_checkout') and not exists (
        select 1
        from public.reservations reservation
        join public.checkout_cleaning_obligations obligation
          on obligation.id = target.checkout_obligation_id
          and obligation.reservation_id = reservation.id
          and obligation.room_id = reservation.room_id
        where reservation.id = target.reservation_id
          and reservation.room_id = target.room_id
          and (
            (reservation.status = 'checked_out'
              and reservation.actual_checkout_at is not null
              and obligation.status = 'materialized'
              and obligation.current_cleaning_target_id = target.id)
            or (target.source = 'scheduled_checkout'
              and reservation.status = 'active'
              and reservation.actual_checkout_at is null
              and reservation.check_out_at = target.available_from
              and obligation.status = 'private'
              and obligation.current_cleaning_target_id is null
              and obligation.planned_cleaning_target_id = target.id)
          )
          and obligation.effective_service_date = target.effective_service_date
          and obligation.available_from is not distinct from target.available_from
          and obligation.due_at is not distinct from target.due_at
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source = 'stayover_request' and not exists (
        select 1
        from public.reservations reservation
        where reservation.id = target.reservation_id
          and reservation.room_id = target.room_id
          and reservation.status = 'active'
          and reservation.actual_check_in_at is not null
          and reservation.actual_checkout_at is null
          and target.cleaning_kind = 'stayover'
          and target.available_from is not null
          and target.due_at is not null
          and target.available_from >= reservation.actual_check_in_at
          and target.due_at <= reservation.check_out_at
          and target.available_from < target.due_at
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source = 'manual_room_request' and (
        target.cleaning_kind <> 'additional'
        or target.available_from is null
        or exists (
          select 1
          from public.reservations reservation
          where reservation.room_id = target.room_id
            and reservation.status = 'active'
            and tstzrange(
              coalesce(reservation.actual_check_in_at, reservation.check_in_at),
              case
                when reservation.actual_check_in_at is not null
                  and reservation.actual_checkout_at is null
                  then 'infinity'::timestamptz
                else coalesce(reservation.actual_checkout_at, reservation.check_out_at)
              end,
              '[)'
            ) && tstzrange(
              target.available_from,
              coalesce(
                target.due_at,
                target.available_from + make_interval(
                  mins => coalesce(
                    nullif(target.template_snapshot ->> 'durationMinutes', '')::integer,
                    1
                  )
                )
              ),
              '[)'
            )
        )
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source = 'inspection_reclean' and (
        target.cleaning_kind <> 'reclean'
        or target.reclean_of_attempt_id is null
        or target.reclean_maid_profile_id is distinct from assignment.maid_profile_id
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      when target.source not in (
        'scheduled_checkout',
        'manual_checkout',
        'stayover_request',
        'manual_room_request',
        'inspection_reclean'
      ) then 'ASSIGNMENT_COMMIT_NOT_ALLOWED'
      else null
    end
  from public.cleaning_targets target
  join public.rooms room on room.id = target.room_id
  left join public.cleaning_assignments assignment
    on assignment.cleaning_target_id = target.id
    and assignment.is_current
  left join public.profiles maid on maid.id = assignment.maid_profile_id
  left join lateral (
    select version_row.*
    from public.availability_versions version_row
    where version_row.maid_profile_id = assignment.maid_profile_id
      and version_row.week_start = p_service_date
        - (extract(isodow from p_service_date)::integer - 1)
      and version_row.is_current
      and version_row.status = 'submitted'
    limit 1
  ) availability on true
  left join public.availability_days day
    on day.availability_version_id = availability.id
    and day.work_date = p_service_date
  where target.effective_service_date = p_service_date
    and target.status in ('unassigned', 'draft_assigned')
$$;

create or replace function private.commit_and_notify_assignments_at(
  p_actor_profile_id uuid,
  p_service_date date,
  p_expected_impact_fingerprint text,
  p_items jsonb,
  p_idempotency_key text,
  p_request_hash text,
  p_command_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_response jsonb;
  v_impact jsonb;
  v_after_impact jsonb;
  v_item jsonb;
  v_candidate record;
  v_lock record;
  v_notification_id uuid;
  v_notified jsonb := '[]'::jsonb;
  v_week_start date;
begin
  perform private.assert_room_admin(p_actor_profile_id);

  if p_command_at is null
    or p_service_date not in (
      (p_command_at at time zone 'Asia/Seoul')::date,
      (p_command_at at time zone 'Asia/Seoul')::date + 1
    ) then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
  end if;
  if p_expected_impact_fingerprint is null
    or p_expected_impact_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_IMPACT_INVALID';
  end if;
  if jsonb_typeof(p_items) <> 'array'
    or jsonb_array_length(p_items) not between 1 and 121 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_ITEMS_INVALID';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_items) item
    where jsonb_typeof(item) <> 'object'
      or (select array_agg(key order by key) from jsonb_object_keys(item) key)
        <> array[
          'cleaningTargetId',
          'expectedAssignmentVersion',
          'expectedAvailabilityVersion'
        ]::text[]
      or jsonb_typeof(item -> 'cleaningTargetId') <> 'string'
      or (item ->> 'cleaningTargetId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(item -> 'expectedAssignmentVersion') <> 'number'
      or (item ->> 'expectedAssignmentVersion') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(item -> 'expectedAvailabilityVersion') <> 'number'
      or (item ->> 'expectedAvailabilityVersion') !~ '^[1-9][0-9]*$'
  ) then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_ITEMS_INVALID';
  end if;
  if (
    select count(*) <> count(distinct item ->> 'cleaningTargetId')
    from jsonb_array_elements(p_items) item
  ) then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_COMMIT_ITEMS_DUPLICATED';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id,
    'assignment.commit_notify',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  -- Match reservation create/change/cancel/checkout ordering before any target lock.
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  perform pg_advisory_xact_lock(hashtextextended(
    'assignment-commit:' || p_service_date::text,
    0
  ));

  for v_lock in
    select target.id
    from public.cleaning_targets target
    where target.effective_service_date = p_service_date
      and target.status in ('unassigned', 'draft_assigned')
    order by target.id
    for update
  loop
    null;
  end loop;

  for v_lock in
    select assignment.id
    from public.cleaning_assignments assignment
    join public.cleaning_targets target
      on target.id = assignment.cleaning_target_id
    where target.effective_service_date = p_service_date
      and target.status = 'draft_assigned'
      and assignment.is_current
    order by assignment.cleaning_target_id
    for update of assignment
  loop
    null;
  end loop;

  v_week_start := p_service_date
    - (extract(isodow from p_service_date)::integer - 1);
  for v_lock in
    select distinct assignment.maid_profile_id
    from public.cleaning_assignments assignment
    join public.cleaning_targets target
      on target.id = assignment.cleaning_target_id
    where target.effective_service_date = p_service_date
      and target.status = 'draft_assigned'
      and assignment.is_current
    order by assignment.maid_profile_id
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'availability:' || v_lock.maid_profile_id::text || ':' || v_week_start::text,
      0
    ));
    perform 1
    from public.availability_versions availability
    where availability.maid_profile_id = v_lock.maid_profile_id
      and availability.week_start = v_week_start
      and availability.is_current
    for update;
  end loop;

  v_impact := private.assignment_commit_impact_at(p_service_date, p_command_at);
  if v_impact ->> 'impactFingerprint' <> p_expected_impact_fingerprint then
    raise exception using errcode = '40001', message = 'ASSIGNMENT_IMPACT_CHANGED';
  end if;

  for v_item in
    select item
    from jsonb_array_elements(p_items) item
    order by item ->> 'cleaningTargetId'
  loop
    select * into v_candidate
    from private.assignment_commit_candidates_at(p_service_date, p_command_at) candidate
    where candidate.target_id = (v_item ->> 'cleaningTargetId')::uuid;

    if not found or v_candidate.target_status <> 'draft_assigned' then
      raise exception using errcode = '23514', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
    end if;
    if v_candidate.reason_code is not null then
      raise exception using errcode = '23514', message = v_candidate.reason_code;
    end if;
    if v_candidate.target_assignment_version
      <> (v_item ->> 'expectedAssignmentVersion')::bigint then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
    end if;
    if v_candidate.availability_version
      <> (v_item ->> 'expectedAvailabilityVersion')::integer then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_AVAILABILITY_STALE';
    end if;

    update public.cleaning_assignments assignment
    set notified_at = p_command_at
    where assignment.id = v_candidate.assignment_id
      and assignment.is_current
      and assignment.notified_at is null;
    if not found then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_COMMIT_NOT_ALLOWED';
    end if;

    update public.cleaning_targets target
    set status = 'notified'
    where target.id = v_candidate.target_id
      and target.status = 'draft_assigned'
      and target.assignment_version = v_candidate.target_assignment_version;
    if not found then
      raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
    end if;

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
      v_candidate.maid_profile_id,
      'cleaning_assignment_notified',
      format('%s호 청소 배정', v_candidate.room_number),
      format(
        '%s · %s번째 청소가 배정되었습니다.',
        p_service_date,
        v_candidate.sequence_number
      ),
      v_candidate.room_id,
      v_candidate.target_id,
      'assignment-notified:' || v_candidate.assignment_id::text
        || ':' || v_candidate.assignment_revision::text,
      true,
      p_command_at
    ) returning id into v_notification_id;

    insert into private.notification_outbox (
      notification_id,
      channel,
      delivery_status,
      next_attempt_at,
      created_at
    ) values (
      v_notification_id,
      'web_push',
      'pending',
      p_command_at,
      p_command_at
    );

    insert into public.audit_events (
      actor_profile_id,
      actor_display_name_snapshot,
      event_type,
      entity_type,
      entity_id,
      effective_at,
      after_state,
      request_hash,
      idempotency_key
    )
    select
      actor.id,
      actor.display_name,
      'assignment.notified',
      'cleaning_assignment',
      v_candidate.assignment_id,
      p_command_at,
      jsonb_build_object(
        'cleaningTargetId', v_candidate.target_id,
        'assignmentId', v_candidate.assignment_id,
        'maidProfileId', v_candidate.maid_profile_id,
        'serviceDate', p_service_date,
        'sequenceNumber', v_candidate.sequence_number,
        'revision', v_candidate.assignment_revision
      ),
      p_request_hash,
      private.audit_command_key(
        p_actor_profile_id,
        'assignment.commit_notify.' || v_candidate.assignment_id::text,
        p_idempotency_key
      )
    from public.profiles actor
    where actor.id = p_actor_profile_id;

    v_notified := v_notified || jsonb_build_array(jsonb_build_object(
      'assignmentId', v_candidate.assignment_id,
      'cleaningTargetId', v_candidate.target_id,
      'roomId', v_candidate.room_id,
      'roomNumber', v_candidate.room_number,
      'maidProfileId', v_candidate.maid_profile_id,
      'maidDisplayName', v_candidate.maid_display_name,
      'serviceDate', p_service_date,
      'sequenceNumber', v_candidate.sequence_number,
      'revision', v_candidate.assignment_revision,
      'targetAssignmentVersion', v_candidate.target_assignment_version,
      'expectedAvailabilityVersion', v_candidate.availability_version,
      'availableFrom', v_candidate.assignment_available_from,
      'dueAt', v_candidate.assignment_due_at,
      'notifiedAt', p_command_at
    ));
  end loop;

  v_after_impact := private.assignment_commit_impact_at(p_service_date, p_command_at);
  v_response := jsonb_build_object(
    'serviceDate', p_service_date,
    'notifiedAssignments', v_notified,
    'remainingDrafts', v_after_impact -> 'committableDrafts',
    'blockedDrafts', v_after_impact -> 'blockedDrafts',
    'unassignedTargets', v_after_impact -> 'remainingUnassignedTargets',
    'impactFingerprint', v_after_impact ->> 'impactFingerprint'
  );

  perform private.complete_command(
    p_actor_profile_id,
    'assignment.commit_notify',
    p_idempotency_key,
    p_request_hash,
    null,
    v_response
  );
  return v_response;
end;
$$;

create or replace function public.save_cleaning_assignment_draft(
  p_actor_profile_id uuid,
  p_cleaning_target_id uuid,
  p_maid_profile_id uuid,
  p_sequence_number integer,
  p_expected_assignment_version bigint,
  p_idempotency_key text,
  p_request_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_target public.cleaning_targets%rowtype;
  v_assignment public.cleaning_assignments%rowtype;
  v_response jsonb;
  v_now timestamptz := clock_timestamp();
  v_revision bigint;
begin
  perform private.assert_room_admin(p_actor_profile_id);

  if p_sequence_number is null or p_sequence_number <= 0 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_SEQUENCE_INVALID';
  end if;
  if p_expected_assignment_version is null or p_expected_assignment_version <= 0 then
    raise exception using errcode = '22023', message = 'ASSIGNMENT_VERSION_INVALID';
  end if;

  v_response := private.replay_command(
    p_actor_profile_id,
    'assignment.save_draft',
    p_idempotency_key,
    p_request_hash
  );
  if v_response is not null then
    return v_response;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command', 0));

  select * into v_target
  from public.cleaning_targets t
  where t.id = p_cleaning_target_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'CLEANING_TARGET_NOT_FOUND';
  end if;
  if v_target.status not in ('unassigned', 'draft_assigned') then
    raise exception using errcode = '23514', message = 'ASSIGNMENT_TARGET_STATE_INVALID';
  end if;
  if v_target.assignment_version <> p_expected_assignment_version then
    raise exception using errcode = '40001', message = 'ASSIGNMENT_VERSION_CONFLICT';
  end if;
  if not exists (
    select 1
    from public.profiles p
    where p.id = p_maid_profile_id
      and p.role = 'maid'
      and p.status = 'active'
  ) then
    raise exception using errcode = '23514', message = 'ACTIVE_MAID_REQUIRED';
  end if;

  v_revision := v_target.assignment_version + 1;

  update public.cleaning_assignments a
  set is_current = false,
      ended_at = v_now,
      change_reason_code = 'DRAFT_REVISED'
  where a.cleaning_target_id = p_cleaning_target_id
    and a.is_current;

  insert into public.cleaning_assignments (
    cleaning_target_id,
    maid_profile_id,
    service_date,
    sequence_number,
    revision,
    is_current,
    available_from_snapshot,
    due_at_snapshot,
    changed_by,
    created_at
  ) values (
    p_cleaning_target_id,
    p_maid_profile_id,
    v_target.effective_service_date,
    p_sequence_number,
    v_revision,
    true,
    v_target.available_from,
    v_target.due_at,
    p_actor_profile_id,
    v_now
  )
  returning * into v_assignment;

  update public.cleaning_targets
  set status = 'draft_assigned',
      assignment_version = v_revision
  where id = p_cleaning_target_id;

  select jsonb_build_object(
    'assignmentId', v_assignment.id,
    'cleaningTargetId', v_assignment.cleaning_target_id,
    'roomId', t.room_id,
    'roomNumber', r.room_number,
    'maidProfileId', v_assignment.maid_profile_id,
    'maidDisplayName', maid.display_name,
    'serviceDate', v_assignment.service_date,
    'sequenceNumber', v_assignment.sequence_number,
    'revision', v_assignment.revision,
    'isCurrent', v_assignment.is_current,
    'targetAssignmentVersion', v_revision,
    'availableFrom', v_assignment.available_from_snapshot,
    'dueAt', v_assignment.due_at_snapshot,
    'notifiedAt', v_assignment.notified_at,
    'endedAt', v_assignment.ended_at,
    'createdAt', v_assignment.created_at
  ) into v_response
  from public.cleaning_targets t
  join public.rooms r on r.id = t.room_id
  join public.profiles maid on maid.id = v_assignment.maid_profile_id
  where t.id = v_assignment.cleaning_target_id;

  insert into public.audit_events (
    actor_profile_id,
    actor_display_name_snapshot,
    event_type,
    entity_type,
    entity_id,
    effective_at,
    after_state,
    idempotency_key
  )
  select
    actor.id,
    actor.display_name,
    'assignment.draft_saved',
    'cleaning_assignment',
    v_assignment.id,
    v_now,
    jsonb_build_object(
      'cleaningTargetId', v_assignment.cleaning_target_id,
      'maidProfileId', v_assignment.maid_profile_id,
      'serviceDate', v_assignment.service_date,
      'sequenceNumber', v_assignment.sequence_number,
      'revision', v_assignment.revision,
      'targetAssignmentVersion', v_revision,
      'requestHash', p_request_hash
    ),
    private.audit_command_key(
      p_actor_profile_id,
      'assignment.save_draft',
      p_idempotency_key
    )
  from public.profiles actor
  where actor.id = p_actor_profile_id;

  perform private.complete_command(
    p_actor_profile_id,
    'assignment.save_draft',
    p_idempotency_key,
    p_request_hash,
    v_assignment.id,
    v_response
  );

  return v_response;
end;
$$;

create trigger aa_checkout_pin_execution_guard
before insert or update on public.room_pin_access_leases
for each row execute function private.guard_checkout_execution();

-- Validate backfilled rows too. Never silently retain pre-checkout execution.
update public.checkout_cleaning_obligations
set planned_cleaning_target_id=planned_cleaning_target_id
where planned_cleaning_target_id is not null;
