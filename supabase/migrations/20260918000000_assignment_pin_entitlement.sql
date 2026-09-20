-- Issue #194: durable assignment-bound PIN entitlement.
-- The entitlement is created only from an authoritative typed delivery outbox.
-- A reveal lease remains a short-lived (<=30s), single-use decryption window.

create table private.room_pin_assignment_entitlements (
  id uuid primary key default gen_random_uuid(),
  assignment_id uuid not null references public.cleaning_assignments(id) on delete restrict,
  cleaning_target_id uuid not null references public.cleaning_targets(id) on delete restrict,
  room_id uuid not null references public.rooms(id) on delete restrict,
  maid_profile_id uuid not null references public.profiles(id) on delete restrict,
  assignment_revision bigint not null check (assignment_revision > 0),
  pin_revision_id uuid not null references private.room_pin_revisions(id) on delete restrict,
  pin_version bigint not null check (pin_version > 0),
  source_notification_id uuid not null references public.notifications(id) on delete restrict,
  source_outbox_id uuid not null references private.notification_delivery_outbox(id) on delete restrict,
  predecessor_entitlement_id uuid references private.room_pin_assignment_entitlements(id) on delete restrict,
  granted_at timestamptz not null,
  ended_at timestamptz,
  end_reason_code text check (end_reason_code is null or end_reason_code in (
    'ASSIGNMENT_ENDED','TARGET_FINALIZED','ACCOUNT_DEACTIVATED','PIN_VERSION_SUPERSEDED'
  )),
  created_at timestamptz not null default clock_timestamp(),
  unique (assignment_id, assignment_revision, pin_revision_id),
  unique (source_outbox_id, pin_revision_id),
  foreign key (room_id, pin_version)
    references private.room_pin_revisions(room_id, pin_version) on delete restrict,
  check ((ended_at is null) = (end_reason_code is null)),
  check (ended_at is null or ended_at >= granted_at),
  check (predecessor_entitlement_id is null or predecessor_entitlement_id <> id)
);

create unique index room_pin_assignment_entitlement_active_assignment_uq
  on private.room_pin_assignment_entitlements(assignment_id) where ended_at is null;
create index room_pin_assignment_entitlement_actor_idx
  on private.room_pin_assignment_entitlements(maid_profile_id, ended_at, room_id);
create index room_pin_assignment_entitlement_room_idx
  on private.room_pin_assignment_entitlements(room_id, ended_at, assignment_id);
create index room_pin_assignment_entitlement_target_idx
  on private.room_pin_assignment_entitlements(cleaning_target_id, ended_at);

alter table private.room_pin_assignment_entitlements enable row level security;
alter table private.room_pin_assignment_entitlements force row level security;
revoke all on table private.room_pin_assignment_entitlements
  from public, anon, authenticated, service_role;

-- Every unfinalized legacy reveal was authorized by the superseded long
-- access lease contract. Revoke it before installing the new constraints,
-- even when its 30-second window has already expired: expiry alone did not
-- finalize the durable v63 row and must not leave an ambiguous legacy grant.
alter table private.room_pin_reveal_leases
  add column entitlement_id uuid references private.room_pin_assignment_entitlements(id) on delete restrict,
  add column assignment_revision bigint,
  add column revoked_at timestamptz,
  add column revoke_reason_code text check (revoke_reason_code is null or revoke_reason_code in (
    'ENTITLEMENT_ENDED','PIN_VERSION_SUPERSEDED','MIGRATION_CONTRACT_REPLACED'
  ));

update private.room_pin_reveal_leases
set revoked_at = clock_timestamp(), revoke_reason_code = 'MIGRATION_CONTRACT_REPLACED'
where finalized_at is null and revoked_at is null;

do $$
declare item record;
begin
  for item in
    select conname from pg_constraint
    where conrelid='private.room_pin_reveal_leases'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%actor_role_snapshot%'
  loop
    execute format('alter table private.room_pin_reveal_leases drop constraint %I', item.conname);
  end loop;
end $$;

alter table private.room_pin_reveal_leases
  add constraint room_pin_reveal_actor_binding_check check (
    (actor_role_snapshot='admin' and entitlement_id is null and assignment_id is null
      and attempt_id is null and authoritative_access_lease_id is null and assignment_revision is null)
    or
    (actor_role_snapshot='maid' and assignment_id is not null and (
      (entitlement_id is not null and assignment_revision is not null)
      or (entitlement_id is null and attempt_id is not null and authoritative_access_lease_id is not null
          and (finalized_at is not null or revoked_at is not null))
    ))
  ),
  add constraint room_pin_reveal_revocation_pair_check check (
    (revoked_at is null) = (revoke_reason_code is null)
  );

create index room_pin_reveal_entitlement_idx
  on private.room_pin_reveal_leases(entitlement_id) where entitlement_id is not null;
create index room_pin_reveal_open_entitlement_idx
  on private.room_pin_reveal_leases(entitlement_id, expires_at)
  where entitlement_id is not null and finalized_at is null and revoked_at is null;

create function private.pin_assignment_outbox_evidence(p_assignment_id uuid)
returns table(outbox_id uuid, notification_id uuid, enqueued_at timestamptz)
language sql stable security definer set search_path='' as $$
    select o.id outbox_id,n.id notification_id,o.enqueued_at
    from private.notification_delivery_outbox o
    join public.notifications n on n.id=o.notification_id
    join public.cleaning_assignments a on a.id=p_assignment_id
    where o.event_family=n.event_family
      and o.event_family in ('assignment.commit_notified','assignment.prestart_new_notified',
        'attempt.handover_next_notified','reservation.manual_checkout_rescheduled',
        'assignment.prestart_same_maid_changed','reservation.notified_schedule_changed',
        'complaint.rework_assigned')
      and n.recipient_profile_id=a.maid_profile_id
      and (
        (n.source_entity_kind='cleaning_assignment' and n.source_entity_id=a.id::text
          and n.event_family in ('assignment.commit_notified','assignment.prestart_new_notified',
            'attempt.handover_next_notified','reservation.manual_checkout_rescheduled',
            'assignment.prestart_same_maid_changed','reservation.notified_schedule_changed'))
        or
        (n.event_family='complaint.rework_assigned'
          and exists (
            select 1 from public.complaint_compensation_decisions c
            join public.cleaning_targets t on t.complaint_compensation_decision_id=c.id
            where c.id::text=n.source_entity_id and t.id=a.cleaning_target_id
          ))
      )
$$;
revoke all on function private.pin_assignment_outbox_evidence(uuid)
  from public,anon,authenticated,service_role;

create function private.pin_assignment_binding_is_current(p_assignment_id uuid,p_room_id uuid,p_maid_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1
    from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where a.id=p_assignment_id and a.maid_profile_id=p_maid_id
      and a.is_current and a.ended_at is null and a.notified_at is not null
      and a.revision=t.assignment_version
      and a.notified_room_id_snapshot=t.room_id and t.room_id=p_room_id
      and t.status in ('notified','in_progress','upload_pending','inspection_pending')
      and exists(select 1 from private.pin_assignment_outbox_evidence(a.id))
  )
$$;
revoke all on function private.pin_assignment_binding_is_current(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

create function private.pin_assignment_in_rotation_scope(p_assignment_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where a.id=p_assignment_id and (
      t.status in ('in_progress','upload_pending','inspection_pending')
      or t.effective_service_date <= (clock_timestamp() at time zone 'Asia/Seoul')::date
      or (t.status='notified' and t.effective_service_date=(
        select min(next_target.effective_service_date)
        from public.cleaning_targets next_target
        join public.cleaning_assignments next_assignment
          on next_assignment.cleaning_target_id=next_target.id
          and next_assignment.is_current and next_assignment.notified_at is not null
        where next_target.room_id=t.room_id and next_target.status='notified'
          and next_target.effective_service_date>
            (clock_timestamp() at time zone 'Asia/Seoul')::date
      ))
    )
  )
$$;
revoke all on function private.pin_assignment_in_rotation_scope(uuid)
  from public,anon,authenticated,service_role;

create function private.end_pin_assignment_entitlement(
  p_assignment_id uuid,p_reason text,p_at timestamptz
) returns void language plpgsql security definer set search_path='' as $$
begin
  if p_reason not in ('ASSIGNMENT_ENDED','TARGET_FINALIZED','ACCOUNT_DEACTIVATED','PIN_VERSION_SUPERSEDED')
    or p_at is null or not isfinite(p_at) then
    raise exception using errcode='22023',message='PIN_ENTITLEMENT_END_INVALID';
  end if;
  update private.room_pin_assignment_entitlements
  set ended_at=p_at,end_reason_code=p_reason
  where assignment_id=p_assignment_id and ended_at is null;
  update private.room_pin_reveal_leases r
  set revoked_at=p_at,revoke_reason_code=case when p_reason='PIN_VERSION_SUPERSEDED'
    then 'PIN_VERSION_SUPERSEDED' else 'ENTITLEMENT_ENDED' end
  where r.entitlement_id in (
      select e.id from private.room_pin_assignment_entitlements e
      where e.assignment_id=p_assignment_id and e.ended_at=p_at and e.end_reason_code=p_reason
    ) and r.finalized_at is null and r.revoked_at is null;
end $$;
revoke all on function private.end_pin_assignment_entitlement(uuid,text,timestamptz)
  from public,anon,authenticated,service_role;

create function private.grant_pin_assignment_entitlement(
  p_assignment_id uuid,p_pin_revision_id uuid,p_pin_version bigint,p_at timestamptz,
  p_source_outbox_id uuid,p_source_notification_id uuid,p_predecessor uuid default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare a public.cleaning_assignments; t public.cleaning_targets; maid public.profiles; result_id uuid;
begin
  select * into a from public.cleaning_assignments where id=p_assignment_id for update;
  if a.id is null then return null; end if;
  select * into t from public.cleaning_targets where id=a.cleaning_target_id for share;
  select * into maid from public.profiles where id=a.maid_profile_id for share;
  if not private.pin_assignment_binding_is_current(a.id,t.room_id,a.maid_profile_id)
    or maid.role<>'maid' or maid.must_change_password
    or maid.status<>'active'
    or (p_predecessor is not null and not private.pin_assignment_in_rotation_scope(a.id))
  then return null; end if;
  if not exists(
    select 1 from private.pin_assignment_outbox_evidence(a.id) evidence
    where evidence.outbox_id=p_source_outbox_id
      and evidence.notification_id=p_source_notification_id
  ) then return null; end if;
  if not exists(select 1 from private.room_pin_revisions r
      where r.id=p_pin_revision_id and r.room_id=t.room_id and r.pin_version=p_pin_version) then
    raise exception using errcode='23514',message='PIN_ENTITLEMENT_REVISION_INVALID';
  end if;
  insert into private.room_pin_assignment_entitlements(
    assignment_id,cleaning_target_id,room_id,maid_profile_id,assignment_revision,
    pin_revision_id,pin_version,source_notification_id,source_outbox_id,
    predecessor_entitlement_id,granted_at)
  values(a.id,t.id,t.room_id,a.maid_profile_id,a.revision,p_pin_revision_id,p_pin_version,
    p_source_notification_id,p_source_outbox_id,p_predecessor,p_at)
  on conflict(assignment_id,assignment_revision,pin_revision_id) do nothing
  returning id into result_id;
  if result_id is null then
    select id into result_id from private.room_pin_assignment_entitlements
    where assignment_id=a.id and assignment_revision=a.revision
      and pin_revision_id=p_pin_revision_id;
  end if;
  return result_id;
end $$;
revoke all on function private.grant_pin_assignment_entitlement(uuid,uuid,bigint,timestamptz,uuid,uuid,uuid)
  from public,anon,authenticated,service_role;

create function private.guard_room_pin_assignment_entitlement()
returns trigger language plpgsql security definer set search_path='' as $$
declare predecessor private.room_pin_assignment_entitlements;
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='PIN_ENTITLEMENT_IMMUTABLE';
  end if;
  if tg_op='UPDATE' then
    if new.id<>old.id or new.assignment_id<>old.assignment_id
      or new.cleaning_target_id<>old.cleaning_target_id or new.room_id<>old.room_id
      or new.maid_profile_id<>old.maid_profile_id
      or new.assignment_revision<>old.assignment_revision
      or new.pin_revision_id<>old.pin_revision_id or new.pin_version<>old.pin_version
      or new.source_notification_id<>old.source_notification_id
      or new.source_outbox_id<>old.source_outbox_id
      or new.predecessor_entitlement_id is distinct from old.predecessor_entitlement_id
      or new.granted_at<>old.granted_at or new.created_at<>old.created_at
      or old.ended_at is not null or new.ended_at is null or new.end_reason_code is null then
      raise exception using errcode='55000',message='PIN_ENTITLEMENT_IMMUTABLE';
    end if;
    return new;
  end if;
  if new.predecessor_entitlement_id is not null then
    select * into predecessor from private.room_pin_assignment_entitlements
      where id=new.predecessor_entitlement_id for share;
    if predecessor.id is null or predecessor.ended_at is null
      or predecessor.assignment_id<>new.assignment_id
      or predecessor.cleaning_target_id<>new.cleaning_target_id
      or predecessor.room_id<>new.room_id or predecessor.maid_profile_id<>new.maid_profile_id
      or predecessor.assignment_revision<>new.assignment_revision
      or predecessor.pin_version>=new.pin_version
      or predecessor.pin_revision_id=new.pin_revision_id then
      raise exception using errcode='23514',message='PIN_ENTITLEMENT_PREDECESSOR_INVALID';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_room_pin_assignment_entitlement()
  from public,anon,authenticated,service_role;
create trigger room_pin_assignment_entitlement_guard
before insert or update or delete on private.room_pin_assignment_entitlements
for each row execute function private.guard_room_pin_assignment_entitlement();

create function private.grant_pin_entitlement_from_outbox()
returns trigger language plpgsql security definer set search_path='' as $$
declare n public.notifications; a public.cleaning_assignments; current_pin private.room_current_pin;
begin
  select * into n from public.notifications where id=new.notification_id;
  if new.event_family is distinct from n.event_family then return new; end if;
  if new.event_family in ('assignment.commit_notified','assignment.prestart_new_notified',
      'attempt.handover_next_notified','reservation.manual_checkout_rescheduled',
      'assignment.prestart_same_maid_changed','reservation.notified_schedule_changed')
      and n.source_entity_kind='cleaning_assignment' then
    begin a.id:=n.source_entity_id::uuid; exception when invalid_text_representation then return new; end;
    select * into a from public.cleaning_assignments where id=a.id;
  elsif new.event_family='complaint.rework_assigned' then
    select assignment.* into a
    from public.complaint_compensation_decisions c
    join public.cleaning_targets t on t.complaint_compensation_decision_id=c.id
    join public.cleaning_assignments assignment on assignment.cleaning_target_id=t.id and assignment.is_current
    where c.id::text=n.source_entity_id;
  else
    return new;
  end if;
  if a.id is null or a.maid_profile_id<>n.recipient_profile_id then return new; end if;
  select * into current_pin from private.room_current_pin where room_id=n.room_id;
  -- Notification commits the durable assignment authority. A transient
  -- physical mismatch blocks reveal in begin_room_pin_reveal, but must not
  -- make the outbox-triggered entitlement disappear permanently when the
  -- same current revision is later verified by rollback.
  if current_pin.pin_revision_id is not null then
    perform private.grant_pin_assignment_entitlement(a.id,current_pin.pin_revision_id,
      current_pin.pin_version,new.enqueued_at,new.id,new.notification_id,null);
  end if;
  return new;
end $$;
revoke all on function private.grant_pin_entitlement_from_outbox()
  from public,anon,authenticated,service_role;
create trigger notification_outbox_grant_pin_entitlement
after insert on private.notification_delivery_outbox
for each row execute function private.grant_pin_entitlement_from_outbox();

create function private.end_pin_entitlement_on_assignment_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if old.is_current and (not new.is_current or new.ended_at is not null
      or new.maid_profile_id is distinct from old.maid_profile_id
      or new.revision is distinct from old.revision) then
    perform private.end_pin_assignment_entitlement(old.id,'ASSIGNMENT_ENDED',clock_timestamp());
  end if;
  return new;
end $$;
revoke all on function private.end_pin_entitlement_on_assignment_change()
  from public,anon,authenticated,service_role;
create trigger cleaning_assignment_end_pin_entitlement
after update on public.cleaning_assignments
for each row execute function private.end_pin_entitlement_on_assignment_change();

create function private.end_pin_entitlement_on_target_final()
returns trigger language plpgsql security definer set search_path='' as $$
declare item record;
begin
  if new.status in ('approved','rejected','cancelled')
    and new.status is distinct from old.status then
    for item in select id from public.cleaning_assignments where cleaning_target_id=new.id loop
      perform private.end_pin_assignment_entitlement(item.id,'TARGET_FINALIZED',clock_timestamp());
    end loop;
  end if;
  return new;
end $$;
revoke all on function private.end_pin_entitlement_on_target_final()
  from public,anon,authenticated,service_role;
create trigger cleaning_target_final_end_pin_entitlement
after update of status on public.cleaning_targets
for each row execute function private.end_pin_entitlement_on_target_final();

create function private.end_pin_entitlement_on_profile_final()
returns trigger language plpgsql security definer set search_path='' as $$
declare item record;
begin
  if new.status in ('inactive','departed') and new.status is distinct from old.status then
    for item in select assignment_id from private.room_pin_assignment_entitlements
      where maid_profile_id=new.id and ended_at is null
    loop
      perform private.end_pin_assignment_entitlement(item.assignment_id,'ACCOUNT_DEACTIVATED',clock_timestamp());
    end loop;
  end if;
  return new;
end $$;
revoke all on function private.end_pin_entitlement_on_profile_final()
  from public,anon,authenticated,service_role;
create trigger profile_final_end_pin_entitlement
after update of status on public.profiles
for each row execute function private.end_pin_entitlement_on_profile_final();

create function private.rotate_room_pin_assignment_entitlements()
returns trigger language plpgsql security definer set search_path='' as $$
declare item record; evidence record; previous_id uuid; at_time timestamptz:=clock_timestamp();
begin
  if tg_op='UPDATE' and new.pin_revision_id=old.pin_revision_id
    and new.pin_version=old.pin_version then return new; end if;
  -- Every lifecycle endpoint finishes with entitlement/reveal rows. Acquire
  -- each authoritative domain row before that shared ledger in the same
  -- deterministic order so assignment/profile finalization cannot invert the
  -- rotation lock graph.
  perform 1 from public.cleaning_assignments a
  join public.cleaning_targets t on t.id=a.cleaning_target_id
  where t.room_id=new.room_id and a.is_current
  order by a.id for update of a;
  perform 1 from public.cleaning_targets t
  where t.room_id=new.room_id
    and exists(select 1 from public.cleaning_assignments a
      where a.cleaning_target_id=t.id and a.is_current)
  order by t.id for share;
  perform 1 from public.profiles p
  where p.id in (
    select a.maid_profile_id from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where t.room_id=new.room_id and a.is_current
  )
  order by p.id for share;
  -- End every authority bound to the old cryptographic revision first. The
  -- exact same transaction then grants the new revision only to assignments
  -- which still have authoritative typed delivery-outbox evidence.
  for item in
    select id,assignment_id from private.room_pin_assignment_entitlements
    where room_id=new.room_id and ended_at is null
    order by assignment_id,id for update
  loop
    previous_id:=item.id;
    perform private.end_pin_assignment_entitlement(
      item.assignment_id,'PIN_VERSION_SUPERSEDED',at_time);
    select * into evidence from private.pin_assignment_outbox_evidence(item.assignment_id)
      order by enqueued_at desc,outbox_id desc limit 1;
    if private.pin_assignment_in_rotation_scope(item.assignment_id) then
      perform private.grant_pin_assignment_entitlement(
        item.assignment_id,new.pin_revision_id,new.pin_version,at_time,
        evidence.outbox_id,evidence.notification_id,previous_id);
    end if;
  end loop;
  -- Admin reveals have no assignment entitlement, but rotation must revoke
  -- every still-open lease bound to the superseded cryptographic revision.
  -- Entitlement-linked rows were already locked/revoked above, so this keeps
  -- the common entitlement -> reveal lock order while closing the remainder.
  if tg_op='UPDATE' and old.pin_revision_id is not null then
    update private.room_pin_reveal_leases
    set revoked_at=at_time,revoke_reason_code='PIN_VERSION_SUPERSEDED'
    where room_id=new.room_id and pin_revision_id=old.pin_revision_id
      and finalized_at is null and revoked_at is null;
  end if;
  -- Initial PIN configuration can happen after assignment notification. In
  -- that case no predecessor exists, but the original typed outbox is still
  -- mandatory evidence and remains linked by the grant helper.
  for item in
    select a.id
    from public.cleaning_assignments a
    join public.cleaning_targets t on t.id=a.cleaning_target_id
    where t.room_id=new.room_id and a.is_current and a.notified_at is not null
      and (tg_op='INSERT' or private.pin_assignment_in_rotation_scope(a.id))
      and not exists(select 1 from private.room_pin_assignment_entitlements e
        where e.assignment_id=a.id and e.ended_at is null)
    order by a.id
  loop
    select * into evidence from private.pin_assignment_outbox_evidence(item.id)
      order by enqueued_at desc,outbox_id desc limit 1;
    perform private.grant_pin_assignment_entitlement(
      item.id,new.pin_revision_id,new.pin_version,at_time,
      evidence.outbox_id,evidence.notification_id,null);
  end loop;
  return new;
end $$;
revoke all on function private.rotate_room_pin_assignment_entitlements()
  from public,anon,authenticated,service_role;
create trigger room_current_pin_rotate_assignment_entitlements
after insert or update of pin_revision_id,pin_version on private.room_current_pin
for each row execute function private.rotate_room_pin_assignment_entitlements();

-- Backfill only authoritative current/notified work whose typed push outbox,
-- current PIN revision, active maid and nonterminal workflow all agree. A
-- transient physical mismatch is a reveal-time gate, not a reason to lose the
-- durable entitlement before the same revision is verified again.
insert into private.room_pin_assignment_entitlements(
  assignment_id,cleaning_target_id,room_id,maid_profile_id,assignment_revision,
  pin_revision_id,pin_version,source_notification_id,source_outbox_id,granted_at)
select a.id,t.id,t.room_id,a.maid_profile_id,a.revision,pin.pin_revision_id,pin.pin_version,
  evidence.notification_id,evidence.outbox_id,greatest(a.notified_at,evidence.enqueued_at)
from public.cleaning_assignments a
join public.cleaning_targets t on t.id=a.cleaning_target_id
join private.room_current_pin pin on pin.room_id=t.room_id
cross join lateral (
  select * from private.pin_assignment_outbox_evidence(a.id)
  order by enqueued_at desc,outbox_id desc limit 1
) evidence
where private.pin_assignment_binding_is_current(a.id,t.room_id,a.maid_profile_id)
  and pin.pin_revision_id is not null
  and exists(select 1 from public.profiles p where p.id=a.maid_profile_id
    and p.role='maid' and p.status='active' and not p.must_change_password)
on conflict(assignment_id,assignment_revision,pin_revision_id) do nothing;

-- Reveal authority is now the durable entitlement, not availableFrom, attempt
-- state, or the historical long room_pin_access_lease.
create or replace function public.begin_room_pin_reveal(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_assignment_id uuid,
  p_attempt_id uuid,p_access_lease_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room public.rooms; current_pin private.room_current_pin;
  revision private.room_pin_revisions; reveal private.room_pin_reveal_leases;
  entitlement private.room_pin_assignment_entitlements; at_time timestamptz:=clock_timestamp();
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  if private.current_pin_sync_status(p_room_id)<>'verified'
    or exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared') then
    raise exception using errcode='55000',message='ROOM_PIN_MISMATCH_UNRESOLVED';
  end if;
  if current_pin.pin_revision_id is null then raise exception using errcode='P0002',message='ROOM_PIN_UNCONFIGURED'; end if;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role='admin' then
    if p_assignment_id is not null or p_attempt_id is not null or p_access_lease_id is not null then
      raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
    end if;
  elsif actor.role='maid' then
    if p_assignment_id is null then
      raise exception using errcode='42501',message='PIN_ENTITLEMENT_REQUIRED';
    end if;
    select * into entitlement from private.room_pin_assignment_entitlements e
    where e.assignment_id=p_assignment_id and e.maid_profile_id=actor.id
      and e.room_id=p_room_id and e.ended_at is null
    for update;
    if entitlement.id is null
      or entitlement.pin_revision_id<>current_pin.pin_revision_id
      or entitlement.pin_version<>current_pin.pin_version
      or not private.pin_assignment_binding_is_current(entitlement.assignment_id,p_room_id,actor.id) then
      raise exception using errcode='42501',message='PIN_ENTITLEMENT_REQUIRED';
    end if;
  else
    raise exception using errcode='42501',message='PIN_ACCESS_REQUIRED';
  end if;
  select * into revision from private.room_pin_revisions where id=current_pin.pin_revision_id;
  insert into private.room_pin_reveal_leases(room_id,pin_revision_id,pin_version,actor_profile_id,
    actor_role_snapshot,assignment_id,entitlement_id,assignment_revision,issued_at,expires_at,request_id)
  values(p_room_id,revision.id,revision.pin_version,actor.id,actor.role,p_assignment_id,
    entitlement.id,entitlement.assignment_revision,at_time,at_time+interval '30 seconds',p_request_id)
  returning * into reveal;
  return jsonb_build_object('lease_id',reveal.id,'room_id',p_room_id,'room_number',room.room_number,
    'pin_version',revision.pin_version,'expires_at',reveal.expires_at,'envelope_format',revision.envelope_format,
    'ciphertext_base64',encode(revision.ciphertext,'base64'),'nonce_base64',encode(revision.nonce,'base64'),
    'auth_tag_base64',encode(revision.auth_tag,'base64'),'key_version',revision.key_version,
    'aad_environment',revision.aad_environment,'aad_project_ref',revision.aad_project_ref);
end $$;

create or replace function public.finalize_room_pin_reveal(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_reveal_lease_id uuid,p_request_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room public.rooms; current_pin private.room_current_pin;
  reveal private.room_pin_reveal_leases; entitlement private.room_pin_assignment_entitlements;
  at_time timestamptz:=clock_timestamp(); activity_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  perform pg_advisory_xact_lock(hashtextextended('room-pin:'||p_room_id::text,0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  select * into current_pin from private.room_current_pin where room_id=p_room_id for update;
  select * into reveal from private.room_pin_reveal_leases
    where id=p_reveal_lease_id and room_id=p_room_id;
  if reveal.id is null then raise exception using errcode='P0002',message='PIN_REVEAL_LEASE_NOT_FOUND'; end if;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role='maid' then
    select * into entitlement from private.room_pin_assignment_entitlements
      where id=reveal.entitlement_id for update;
    if entitlement.id is null or entitlement.ended_at is not null
      or entitlement.assignment_id<>reveal.assignment_id
      or entitlement.assignment_revision<>reveal.assignment_revision
      or entitlement.maid_profile_id<>actor.id or entitlement.room_id<>p_room_id
      or not private.pin_assignment_binding_is_current(entitlement.assignment_id,p_room_id,actor.id) then
      raise exception using errcode='42501',message='PIN_REVEAL_AUTHORIZATION_CHANGED';
    end if;
  elsif actor.role<>'admin' or reveal.entitlement_id is not null then
    raise exception using errcode='42501',message='PIN_REVEAL_AUTHORIZATION_CHANGED';
  end if;
  -- Entitlement ending always locks entitlement before its open reveal rows.
  -- Re-lock the exact lease only after the entitlement to preserve that order.
  select * into reveal from private.room_pin_reveal_leases
    where id=p_reveal_lease_id and room_id=p_room_id for update;
  if reveal.actor_profile_id<>actor.id or reveal.request_id<>p_request_id
    or reveal.finalized_at is not null or reveal.revoked_at is not null or reveal.expires_at<=at_time
    or current_pin.pin_revision_id<>reveal.pin_revision_id or current_pin.pin_version<>reveal.pin_version
    or private.current_pin_sync_status(p_room_id)<>'verified'
    or exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared') then
    raise exception using errcode='42501',message='PIN_REVEAL_AUTHORIZATION_CHANGED';
  end if;
  update private.room_pin_reveal_leases set finalized_at=at_time where id=reveal.id;
  insert into private.actor_activity_events(actor_profile_id,actor_role_snapshot,category,event_type,outcome,
    source,resource_type,resource_id,reason_code,request_id,occurred_at)
  values(actor.id,actor.role,'sensitive_access','sensitive.read','succeeded','edge.sensitive.room_pin',
    'room',p_room_id,null,p_request_id::text,at_time) returning id into activity_id;
  return jsonb_build_object('room_id',p_room_id,'pin_version',reveal.pin_version,
    'reveal_lease_id',reveal.id,'activity_id',activity_id,'finalized_at',at_time);
end $$;

revoke all on function public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
revoke all on function public.finalize_room_pin_reveal(uuid,uuid,uuid,uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid) to service_role;
grant execute on function public.finalize_room_pin_reveal(uuid,uuid,uuid,uuid,uuid) to service_role;

comment on table private.room_pin_assignment_entitlements is
  '#194 durable, assignment-bound PIN authority. Private and never a credential payload.';
comment on column private.room_pin_assignment_entitlements.source_outbox_id is
  'The exact typed delivery outbox whose atomic creation made this notified assignment eligible.';
comment on function public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid) is
  'Creates a <=30 second reveal window. Maid authority is the current durable assignment entitlement; attempt/access lease inputs are legacy compatibility fields and are not authority.';
