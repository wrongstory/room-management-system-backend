-- Issue #275: a notified maid's current assignment entitlement is sufficient
-- to reveal the authoritative stored PIN. Physical lock sync remains a
-- check-in/readiness signal and is not maid reveal authorization.

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
  if current_pin.pin_revision_id is null then raise exception using errcode='P0002',message='ROOM_PIN_UNCONFIGURED'; end if;
  actor:=private.assert_room_pin_actor_session(p_actor_profile_id,p_session_id);
  if actor.role='admin' then
    if private.current_pin_sync_status(p_room_id)<>'verified'
      or exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared') then
      raise exception using errcode='55000',message='ROOM_PIN_MISMATCH_UNRESOLVED';
    end if;
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
    or (actor.role='admin' and (
      private.current_pin_sync_status(p_room_id)<>'verified'
      or exists(select 1 from private.room_pin_change_leases where room_id=p_room_id and status='prepared')
    )) then
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

comment on function public.begin_room_pin_reveal(uuid,uuid,uuid,uuid,uuid,uuid,uuid) is
  'Creates a <=30 second reveal window for the authoritative current stored PIN. Maid authority is the current durable assignment entitlement and physical lock sync is not maid reveal authorization; admin ordinary reveal keeps the verified sync gate.';
comment on function public.finalize_room_pin_reveal(uuid,uuid,uuid,uuid,uuid) is
  'Rechecks live actor, assignment entitlement, current PIN revision, and lease before recording sensitive access. Physical lock sync is not maid reveal authorization; admin ordinary reveal keeps the verified sync gate.';
