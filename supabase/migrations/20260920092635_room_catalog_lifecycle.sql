-- Issue #230: developer-owned room catalog lifecycle.
-- Existing room identities and all operational history remain immutable. A
-- retired room is hidden from current operations but remains FK-addressable.

begin;

alter table public.rooms
  add column catalog_status text not null default 'active'
    check (catalog_status in ('active','retired')),
  add column retired_at timestamptz,
  add column retired_by uuid references public.profiles(id) on delete restrict,
  add column retirement_reason_code text,
  add constraint rooms_retirement_metadata_check check (
    (catalog_status='active' and retired_at is null and retired_by is null and retirement_reason_code is null)
    or
    (catalog_status='retired' and retired_at is not null and retired_by is not null
      and retirement_reason_code ~ '^[A-Z0-9_]{2,80}$')
  );

create index rooms_active_catalog_order_idx
  on public.rooms(room_number,id) where catalog_status='active';
create index rooms_retired_catalog_order_idx
  on public.rooms(room_number,id) where catalog_status='retired';

create or replace view public.room_catalog
with (security_invoker=true) as
select r.id,r.room_number,rt.code as room_type_code,rt.name as room_type_name,
  r.elevator_zone,r.data_status
from public.rooms r
join public.room_types rt on rt.id=r.room_type_id
where r.catalog_status='active';

create function private.assert_room_catalog_developer(p_actor uuid,p_session uuid)
returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles%rowtype;
begin
  select * into actor from public.profiles where id=p_actor for share;
  if actor.id is null or actor.status<>'active' or actor.role<>'developer' then
    raise exception using errcode='42501',message='DEVELOPER_REQUIRED';
  end if;
  if actor.must_change_password then
    raise exception using errcode='42501',message='PASSWORD_CHANGE_REQUIRED';
  end if;
  if p_session is null or not public.is_active_auth_session(actor.auth_user_id,p_session) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  perform 1 from auth.sessions where id=p_session and user_id=actor.auth_user_id for share;
  if not found then raise exception using errcode='42501',message='SESSION_REVOKED'; end if;
  return actor;
end $$;
revoke all on function private.assert_room_catalog_developer(uuid,uuid)
  from public,anon,authenticated,service_role;

create function private.guard_room_catalog_lifecycle() returns trigger
language plpgsql set search_path='' as $$
begin
  if tg_op='DELETE' then
    raise exception using errcode='55000',message='ROOM_PHYSICAL_DELETE_FORBIDDEN';
  end if;
  if tg_op='INSERT' then
    if coalesce(current_setting('app.room_catalog_command',true),'')<>'v1' then
      raise exception using errcode='42501',message='ROOM_CATALOG_COMMAND_REQUIRED';
    end if;
    return new;
  end if;
  if row(new.catalog_status,new.retired_at,new.retired_by,new.retirement_reason_code)
      is distinct from
     row(old.catalog_status,old.retired_at,old.retired_by,old.retirement_reason_code) then
    if coalesce(current_setting('app.room_catalog_command',true),'')<>'v1'
      or old.catalog_status<>'active' or new.catalog_status<>'retired' then
      raise exception using errcode='55000',message='ROOM_CATALOG_LIFECYCLE_IMMUTABLE';
    end if;
  end if;
  return new;
end $$;
revoke all on function private.guard_room_catalog_lifecycle()
  from public,anon,authenticated,service_role;
create trigger rooms_catalog_lifecycle_guard
before insert or update or delete on public.rooms for each row
execute function private.guard_room_catalog_lifecycle();

create function private.require_active_room_reference() returns trigger
language plpgsql set search_path='' as $$
declare v_room_id uuid; v_catalog_status text;
begin
  if tg_table_name in ('cleaning_assignments','cleaning_attempts') then
    select target.room_id into v_room_id from public.cleaning_targets target
    where target.id=new.cleaning_target_id;
  else
    v_room_id:=new.room_id;
  end if;
  if v_room_id is null then return new; end if;
  -- Serialize retirement against every operation that can create a new
  -- current/future reference. The row lock closes the check-then-write race.
  select room.catalog_status into v_catalog_status from public.rooms room
  where room.id=v_room_id for share;
  if v_catalog_status is distinct from 'active' then
    raise exception using errcode='55000',message='ROOM_RETIRED';
  end if;
  return new;
end $$;
revoke all on function private.require_active_room_reference()
  from public,anon,authenticated,service_role;
create trigger reservations_require_active_room
before insert or update of room_id,status on public.reservations for each row
execute function private.require_active_room_reference();
create trigger cleaning_targets_require_active_room
before insert or update of room_id,status on public.cleaning_targets for each row
execute function private.require_active_room_reference();
create trigger stay_room_segments_require_active_room
before insert or update of room_id on private.stay_room_segments for each row
execute function private.require_active_room_reference();
create trigger cleaning_assignments_require_active_room
before insert or update of cleaning_target_id,is_current on public.cleaning_assignments for each row
when (new.is_current) execute function private.require_active_room_reference();
create trigger cleaning_attempts_require_active_room
before insert or update of cleaning_target_id,status on public.cleaning_attempts for each row
when (new.status in ('scheduled','in_progress','field_completed','upload_pending','submitted'))
execute function private.require_active_room_reference();
create trigger room_operation_blocks_require_active_room
before insert or update of room_id,released_at on public.room_operation_blocks for each row
when (new.released_at is null)
execute function private.require_active_room_reference();
create trigger room_issues_require_active_room
before insert or update of room_id,status on public.room_issues for each row
when (new.status='open')
execute function private.require_active_room_reference();
create trigger room_pin_change_leases_require_active_room
before insert or update of room_id,status on private.room_pin_change_leases for each row
when (new.status='prepared')
execute function private.require_active_room_reference();
create trigger room_pin_assignment_entitlements_require_active_room
before insert or update of room_id,ended_at on private.room_pin_assignment_entitlements for each row
when (new.ended_at is null)
execute function private.require_active_room_reference();
create trigger room_pin_reveal_leases_require_active_room
before insert or update of room_id,finalized_at,revoked_at,expires_at on private.room_pin_reveal_leases for each row
when (new.finalized_at is null and new.revoked_at is null)
execute function private.require_active_room_reference();
create trigger room_pin_sheet_sync_outbox_require_active_room
before insert or update of room_id,status on private.room_pin_sheet_sync_outbox for each row
when (new.status in ('pending','processing','failed'))
execute function private.require_active_room_reference();

create function public.list_developer_room_catalog(
  p_actor_profile_id uuid,p_session_id uuid,p_status text default 'all',
  p_after_room_number text default null,p_after_id uuid default null,p_limit integer default 50
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actor public.profiles; v_items jsonb; v_active integer; v_retired integer;
  v_has_more boolean; v_next_room_number text; v_next_id uuid;
begin
  actor:=private.assert_room_catalog_developer(p_actor_profile_id,p_session_id);
  if p_status not in ('all','active','retired') then
    raise exception using errcode='22023',message='INVALID_ROOM_CATALOG_STATUS';
  end if;
  if p_limit is null or p_limit<1 or p_limit>100 then
    raise exception using errcode='22023',message='INVALID_ROOM_CATALOG_PAGE_SIZE';
  end if;
  if (p_after_room_number is null)<>(p_after_id is null)
    or (p_after_room_number is not null and p_after_room_number !~ '^[0-9]{1,8}$') then
    raise exception using errcode='22023',message='INVALID_ROOM_CATALOG_CURSOR';
  end if;
  select count(*) filter(where catalog_status='active')::integer,
    count(*) filter(where catalog_status='retired')::integer
  into v_active,v_retired from public.rooms;
  with candidates as (
    select room.id,room.room_number,room.catalog_status,room.state_version,
      room.room_type_id,room_type.code room_type_code,room_type.name room_type_name,
      room_type.version room_type_version,room.elevator_zone,room.created_at,
      room.retired_at,room.retirement_reason_code
    from public.rooms room join public.room_types room_type on room_type.id=room.room_type_id
    where (p_status='all' or room.catalog_status=p_status)
      and (p_after_room_number is null or (room.room_number,room.id)>(p_after_room_number,p_after_id))
    order by room.room_number,room.id limit p_limit+1
  ), numbered as (
    select candidates.*,row_number() over(order by room_number,id) ordinal from candidates
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id',id,'roomNumber',room_number,'status',catalog_status,'version',state_version,
      'roomTypeId',room_type_id,'roomTypeCode',room_type_code,'roomTypeName',room_type_name,
      'roomTypeVersion',room_type_version,'elevatorZone',elevator_zone,'createdAt',created_at,
      'retiredAt',retired_at,'retirementReasonCode',retirement_reason_code
    ) order by room_number,id) filter(where ordinal<=p_limit),'[]'::jsonb),
    coalesce(bool_or(ordinal>p_limit),false),
    max(room_number) filter(where ordinal<=p_limit),
    (max(id::text) filter(where ordinal<=p_limit and room_number=(
      select max(room_number) from numbered where ordinal<=p_limit)))::uuid
  into v_items,v_has_more,v_next_room_number,v_next_id from numbered;
  return jsonb_build_object('counts',jsonb_build_object(
    'active',v_active,'retired',v_retired,'total',v_active+v_retired),
    'items',v_items,'hasMore',v_has_more,
    'nextRoomNumber',case when v_has_more then v_next_room_number else null end,
    'nextId',case when v_has_more then v_next_id else null end);
end $$;
revoke all on function public.list_developer_room_catalog(uuid,uuid,text,text,uuid,integer)
  from public,anon,authenticated;
grant execute on function public.list_developer_room_catalog(uuid,uuid,text,text,uuid,integer)
  to service_role;

create function public.create_room_catalog_entry(
  p_actor_profile_id uuid,p_session_id uuid,p_room_number text,p_room_type_id uuid,
  p_expected_room_type_version bigint,p_elevator_zone text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room_type public.room_types%rowtype; room public.rooms%rowtype;
  response jsonb; at_time timestamptz:=clock_timestamp(); active_count integer;
begin
  actor:=private.assert_room_catalog_developer(p_actor_profile_id,p_session_id);
  response:=private.replay_command(actor.id,'room_catalog.create',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  if p_room_number is null or p_room_number !~ '^[0-9]{1,8}$'
    or p_elevator_zone is not null and p_elevator_zone not in ('A','B','C') then
    raise exception using errcode='22023',message='INVALID_ROOM_CATALOG_ENTRY';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:room-catalog',0));
  select * into room_type from public.room_types where id=p_room_type_id for share;
  if room_type.id is null or not room_type.active then
    raise exception using errcode='23514',message='ROOM_TYPE_NOT_PUBLISHED';
  end if;
  if room_type.version<>p_expected_room_type_version then
    raise exception using errcode='40001',message='STALE_ROOM_TYPE_VERSION';
  end if;
  select count(*)::integer into active_count from public.rooms where catalog_status='active';
  if active_count>=500 then
    raise exception using errcode='54000',message='ROOM_CATALOG_ACTIVE_LIMIT_EXCEEDED';
  end if;
  if exists(select 1 from public.rooms where room_number=p_room_number) then
    raise exception using errcode='23505',message='ROOM_NUMBER_ALREADY_USED';
  end if;
  perform set_config('app.room_catalog_command','v1',true);
  insert into public.rooms(room_number,room_type_id,elevator_zone,created_at,updated_at)
  values(p_room_number,room_type.id,p_elevator_zone,at_time,at_time) returning * into room;
  response:=jsonb_build_object('id',room.id,'roomNumber',room.room_number,'status','active',
    'version',room.state_version,'roomTypeId',room.room_type_id,'roomTypeCode',room_type.code,
    'roomTypeName',room_type.name,'roomTypeVersion',room_type.version,
    'elevatorZone',room.elevator_zone,'createdAt',room.created_at,'retiredAt',null);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,reason_code,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.catalog_created','room',room.id,at_time,'ROOM_CATALOG_CREATED',
    jsonb_build_object('roomNumber',room.room_number,'status','active','version',room.state_version,
      'roomTypeId',room.room_type_id,'roomTypeCode',room_type.code,'elevatorZone',room.elevator_zone),
    p_request_hash,private.audit_command_key(actor.id,'room_catalog.create',p_idempotency_key));
  perform private.complete_command(actor.id,'room_catalog.create',p_idempotency_key,p_request_hash,room.id,response);
  return response;
end $$;
revoke all on function public.create_room_catalog_entry(uuid,uuid,text,uuid,bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.create_room_catalog_entry(uuid,uuid,text,uuid,bigint,text,text,text)
  to service_role;

create function public.retire_room_catalog_entry(
  p_actor_profile_id uuid,p_session_id uuid,p_room_id uuid,p_expected_version bigint,
  p_reason_code text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; room public.rooms%rowtype; response jsonb;
  at_time timestamptz:=clock_timestamp(); conflict_code text;
begin
  actor:=private.assert_room_catalog_developer(p_actor_profile_id,p_session_id);
  response:=private.replay_command(actor.id,'room_catalog.retire',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  if p_reason_code is null or p_reason_code !~ '^[A-Z0-9_]{2,80}$' then
    raise exception using errcode='22023',message='INVALID_ROOM_RETIREMENT_REASON';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:room-catalog',0));
  select * into room from public.rooms where id=p_room_id for update;
  if room.id is null then raise exception using errcode='P0002',message='ROOM_NOT_FOUND'; end if;
  if room.catalog_status='retired' then raise exception using errcode='23514',message='ROOM_ALREADY_RETIRED'; end if;
  if room.state_version<>p_expected_version then raise exception using errcode='40001',message='STALE_VERSION'; end if;
  if exists(select 1 from public.reservations r where r.room_id=room.id and r.status='active')
    or exists(select 1 from private.stay_room_segments s join private.reservation_stays st on st.id=s.stay_id
      where s.room_id=room.id and s.retired_at is null and st.status in ('scheduled','active')) then
    conflict_code:='ROOM_RETIRE_RESERVATION_CONFLICT';
  elsif exists(select 1 from public.cleaning_targets t where t.room_id=room.id and t.status not in ('approved','cancelled'))
    or exists(select 1 from public.cleaning_attempts a join public.cleaning_targets t on t.id=a.cleaning_target_id
      where t.room_id=room.id and a.status in ('scheduled','in_progress','field_completed','upload_pending','submitted'))
    or exists(select 1 from public.cleaning_assignments a join public.cleaning_targets t on t.id=a.cleaning_target_id
      where t.room_id=room.id and a.is_current and a.ended_at is null) then
    conflict_code:='ROOM_RETIRE_CLEANING_CONFLICT';
  elsif exists(select 1 from public.room_issues i where i.room_id=room.id and i.status='open') then
    conflict_code:='ROOM_RETIRE_ISSUE_CONFLICT';
  elsif exists(select 1 from public.room_operation_blocks b where b.room_id=room.id and b.released_at is null) then
    conflict_code:='ROOM_RETIRE_OPERATION_BLOCK_CONFLICT';
  elsif private.current_pin_sync_status(room.id)='mismatch'
    or exists(select 1 from private.room_pin_change_leases l where l.room_id=room.id and l.status='prepared')
    or exists(select 1 from private.room_pin_assignment_entitlements e where e.room_id=room.id and e.ended_at is null)
    or exists(select 1 from private.room_pin_reveal_leases l where l.room_id=room.id and l.finalized_at is null
      and l.revoked_at is null and l.expires_at>at_time)
    or exists(select 1 from private.room_pin_sheet_sync_outbox o where o.room_id=room.id
      and o.status in ('pending','processing','failed')) then
    conflict_code:='ROOM_RETIRE_PIN_WORKFLOW_CONFLICT';
  end if;
  if conflict_code is not null then raise exception using errcode='23514',message=conflict_code; end if;
  perform set_config('app.room_catalog_command','v1',true);
  update public.rooms set catalog_status='retired',retired_at=at_time,retired_by=actor.id,
    retirement_reason_code=p_reason_code,state_version=state_version+1,updated_at=at_time
  where id=room.id returning * into room;
  response:=jsonb_build_object('id',room.id,'roomNumber',room.room_number,'status','retired',
    'version',room.state_version,'retiredAt',room.retired_at,'retirementReasonCode',room.retirement_reason_code);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,
    entity_id,effective_at,reason_code,before_state,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room.catalog_retired','room',room.id,at_time,p_reason_code,
    jsonb_build_object('status','active','version',p_expected_version),
    jsonb_build_object('roomNumber',room.room_number,'status','retired','version',room.state_version),
    p_request_hash,private.audit_command_key(actor.id,'room_catalog.retire',p_idempotency_key));
  perform private.complete_command(actor.id,'room_catalog.retire',p_idempotency_key,p_request_hash,room.id,response);
  return response;
end $$;
revoke all on function public.retire_room_catalog_entry(uuid,uuid,uuid,bigint,text,text,text)
  from public,anon,authenticated;
grant execute on function public.retire_room_catalog_entry(uuid,uuid,uuid,bigint,text,text,text)
  to service_role;

-- Keep historical implementations private and expose active-only wrappers.
alter function public.get_room_operational_projection(uuid,uuid)
  rename to get_room_operational_projection_v73;
revoke all on function public.get_room_operational_projection_v73(uuid,uuid)
  from public,anon,authenticated,service_role;
create function public.get_room_operational_projection(p_actor_profile_id uuid,p_room_id uuid default null)
returns table(id uuid,room_number text,room_type_code text,room_type_name text,elevator_zone text,
  data_status public.data_status,state_version bigint,evaluated_at timestamptz,reservation_phase text,
  occupied boolean,cleaning_required boolean,candle_count integer,pin_sync_status text,
  allocation_blocked boolean,allocation_ready boolean,reason_codes text[],server_time timestamptz,
  occupancy_status text,reservation_lifecycle text,readiness_status text,primary_display_status text,
  next_reservation_id uuid,next_check_in_at timestamptz,next_check_out_at timestamptz,
  blocking_reason_codes text[],readiness_reason_codes text[])
language sql security definer set search_path='' as $$
  select projection.* from public.get_room_operational_projection_v73(p_actor_profile_id,p_room_id) projection
  join public.rooms room on room.id=projection.id where room.catalog_status='active'
  order by projection.room_number
$$;
revoke all on function public.get_room_operational_projection(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_room_operational_projection(uuid,uuid) to service_role;

alter function public.preview_reservation_bookability(uuid,timestamptz,timestamptz,uuid,uuid[],text)
  rename to preview_reservation_bookability_v73;
revoke all on function public.preview_reservation_bookability_v73(uuid,timestamptz,timestamptz,uuid,uuid[],text)
  from public,anon,authenticated,service_role;
create function public.preview_reservation_bookability(
  p_actor_profile_id uuid,p_check_in_at timestamptz,p_check_out_at timestamptz,
  p_exclude_reservation_id uuid default null,p_room_type_ids uuid[] default null,
  p_reservation_type text default 'standard'
) returns jsonb language sql security definer set search_path='' as $$
  select jsonb_set(source.result,'{candidates}',coalesce((
    select jsonb_agg(candidate.value order by candidate.ordinality)
    from jsonb_array_elements(source.result->'candidates') with ordinality candidate(value,ordinality)
    join public.rooms room on room.id=(candidate.value->>'room_id')::uuid
    where room.catalog_status='active'
  ),'[]'::jsonb))
  from (select public.preview_reservation_bookability_v73(
    p_actor_profile_id,p_check_in_at,p_check_out_at,p_exclude_reservation_id,p_room_type_ids,p_reservation_type
  ) result) source
$$;
revoke all on function public.preview_reservation_bookability(uuid,timestamptz,timestamptz,uuid,uuid[],text)
  from public,anon,authenticated;
grant execute on function public.preview_reservation_bookability(uuid,timestamptz,timestamptz,uuid,uuid[],text)
  to service_role;

create or replace function public.list_room_type_catalog(p_actor_profile_id uuid,p_session_id uuid)
returns table(id uuid,code text,display_name text,base_cleaning_fee integer,active boolean,
  version bigint,room_count integer)
language plpgsql stable security definer set search_path='' as $$
begin
  perform private.assert_attempt_actor_session(p_actor_profile_id,p_session_id,true);
  return query select rt.id,rt.code,rt.name,rt.base_cleaning_fee,rt.active,rt.version,
    count(r.id) filter(where r.catalog_status='active')::integer
  from public.room_types rt left join public.rooms r on r.room_type_id=rt.id
  group by rt.id order by rt.code;
end $$;

-- The initial 121 rows are seed data, not a permanent catalog invariant.
alter table private.room_pin_sheet_full_resync_runs
  drop constraint room_pin_sheet_full_resync_runs_snapshot_room_count_check,
  add constraint room_pin_sheet_full_resync_runs_snapshot_room_count_check
    check(snapshot_room_count between 1 and 500);
alter table private.room_pin_sheet_full_resync_items
  drop constraint room_pin_sheet_full_resync_items_sheet_row_check,
  add constraint room_pin_sheet_full_resync_items_sheet_row_check
    check(sheet_row between 2 and 501);

create or replace function public.request_room_pin_sheet_full_resync(
  p_actor_profile_id uuid,p_session_id uuid,p_expected_fence bigint,
  p_expected_environment text,p_expected_project_ref text,
  p_expected_target_identity_digest text,p_idempotency_key text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; state private.room_pin_sheet_sync_worker_state;
  blocked_run private.room_pin_sheet_full_resync_runs;
  root_run private.room_pin_sheet_full_resync_runs;
  v_run_id uuid:=gen_random_uuid(); v_root_id uuid; at_time timestamptz:=clock_timestamp();
  response jsonb; room_count integer; pending_count integer;
begin
  if p_expected_fence is null or p_expected_fence<0
    or p_expected_environment is null or p_expected_environment !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_project_ref is null or p_expected_project_ref !~ '^[A-Za-z0-9._:-]{1,80}$'
    or p_expected_target_identity_digest is null
    or p_expected_target_identity_digest !~ '^[0-9a-f]{64}$' then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  actor:=private.assert_room_pin_sheet_operator(p_actor_profile_id,p_session_id);
  response:=private.replay_command(actor.id,'room_pin_sheet.full_resync',p_idempotency_key,p_request_hash);
  if response is not null then return response; end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  if state.lease_fence<>p_expected_fence then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_FULL_RESYNC_STALE';
  end if;
  if state.status='leased' and state.lease_expires_at>at_time then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_WORKER_BUSY';
  end if;
  if state.status='leased' and state.lease_expires_at<=at_time and (
    exists(select 1 from private.room_pin_sheet_sync_outbox o where o.status='processing'
      and o.claim_id=state.claim_id and o.lease_fence=state.lease_fence and o.provider_write_started_at is not null)
    or exists(select 1 from private.room_pin_sheet_full_resync_runs f where f.status='processing'
      and f.claim_id=state.claim_id and f.lease_fence=state.lease_fence and f.provider_write_started_at is not null)
  ) then
    update private.room_pin_sheet_full_resync_runs set status='operator_blocked',
      last_error_code='WRITE_OUTCOME_UNCERTAIN',completed_at=coalesce(completed_at,at_time)
    where status='processing' and claim_id=state.claim_id and lease_fence=state.lease_fence
      and provider_write_started_at is not null;
    update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
      lease_expires_at=null,blocked_reason_code='WRITE_OUTCOME_UNCERTAIN',updated_at=at_time
    where singleton=true returning * into state;
  elsif state.status='leased' and state.lease_expires_at<=at_time then
    update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,
      lease_expires_at=null,blocked_reason_code=null,updated_at=at_time
    where singleton=true returning * into state;
  end if;
  select count(*)::integer into pending_count from private.room_pin_sheet_full_resync_runs
  where status in ('pending','processing','failed') and coalesce(last_error_code,'')<>'RETRY_EXHAUSTED';
  if pending_count>0 then raise exception using errcode='55000',message='ROOM_PIN_SHEET_FULL_RESYNC_PENDING'; end if;
  if state.status='operator_blocked' then
    select * into blocked_run from private.room_pin_sheet_full_resync_runs
    where status='operator_blocked' and lease_fence=state.lease_fence
    order by completed_at desc,requested_at desc,id desc limit 1 for update;
    if blocked_run.id is null then
      v_root_id:=v_run_id;
    else
      select * into root_run from private.room_pin_sheet_full_resync_runs
      where id=blocked_run.recovery_root_run_id for key share;
      if root_run.id is null or root_run.recovery_root_run_id<>root_run.id then
        raise exception using errcode='55000',message='ROOM_PIN_SHEET_FULL_RESYNC_LINEAGE_INVALID';
      end if;
      v_root_id:=root_run.id;
    end if;
  else
    v_root_id:=v_run_id;
  end if;
  select count(*)::integer into room_count from public.rooms where catalog_status='active';
  if room_count not between 1 and 500 then
    raise exception using errcode='54000',message='ROOM_PIN_SHEET_ROOM_MASTER_INVALID';
  end if;
  insert into private.room_pin_sheet_full_resync_runs(
    id,actor_profile_id,actor_role_snapshot,expected_fence,reconciles_blocked_fence,recovery_root_run_id,
    aad_environment,aad_project_ref,target_identity_digest,snapshot_room_count,idempotency_key,request_hash,requested_at
  ) values(v_run_id,actor.id,actor.role,p_expected_fence,
    case when state.status='operator_blocked' then state.lease_fence else null end,v_root_id,
    p_expected_environment,p_expected_project_ref,p_expected_target_identity_digest,room_count,
    p_idempotency_key,p_request_hash,at_time);
  insert into private.room_pin_sheet_full_resync_items(
    run_id,room_id,room_number_snapshot,sheet_row,pin_revision_id,pin_version,sync_status,effective_at,reason_code
  ) select v_run_id,ranked.id,ranked.room_number,ranked.sheet_row,current_pin.pin_revision_id,
      coalesce(current_pin.pin_version,0),private.current_pin_sync_status(ranked.id),at_time,'FULL_RESYNC_REPAIR'
    from (select r.id,r.room_number,(row_number() over(order by r.room_number,r.id)+1)::integer sheet_row
      from public.rooms r where r.catalog_status='active') ranked
    left join private.room_current_pin current_pin on current_pin.room_id=ranked.id;
  if (select count(*) from private.room_pin_sheet_full_resync_items where run_id=v_run_id)<>room_count then
    raise exception using errcode='55000',message='ROOM_PIN_SHEET_ROOM_MASTER_INVALID';
  end if;
  response:=jsonb_build_object('status','pending','roomCount',room_count,'version',state.lease_fence);
  insert into public.audit_events(actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,
    effective_at,reason_code,after_state,request_hash,idempotency_key)
  values(actor.id,actor.display_name,'room_pin_sheet.full_resync_requested','room_pin_sheet_full_resync',v_run_id,
    at_time,'FULL_RESYNC_REQUESTED',jsonb_build_object('status','pending','roomCount',room_count,
      'expectedFence',state.lease_fence,'reconciliation',state.status='operator_blocked'),
    p_request_hash,private.audit_command_key(actor.id,'room_pin_sheet.full_resync',p_idempotency_key));
  perform private.complete_command(actor.id,'room_pin_sheet.full_resync',p_idempotency_key,p_request_hash,v_run_id,response);
  return response;
end $$;

create or replace function public.authorize_room_pin_sheet_full_resync_write(
  p_run_id uuid,p_claim_id uuid,p_lease_fence bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare at_time timestamptz:=clock_timestamp(); state private.room_pin_sheet_sync_worker_state;
  run private.room_pin_sheet_full_resync_runs; changed boolean;
begin
  if p_run_id is null or p_claim_id is null or p_lease_fence is null or p_lease_fence<1 then
    raise exception using errcode='22023',message='ROOM_PIN_SHEET_FULL_RESYNC_AUTHORIZE_INVALID';
  end if;
  select * into state from private.room_pin_sheet_sync_worker_state where singleton=true for update;
  select * into run from private.room_pin_sheet_full_resync_runs where id=p_run_id for update;
  if run.id is null then raise exception using errcode='P0002',message='ROOM_PIN_SHEET_FULL_RESYNC_NOT_FOUND'; end if;
  if state.status<>'leased' or state.claim_id<>p_claim_id or state.lease_fence<>p_lease_fence
    or state.lease_expires_at<=at_time or run.status<>'processing' or run.claim_id<>p_claim_id
    or run.lease_fence<>p_lease_fence or run.claim_expires_at<=at_time then
    raise exception using errcode='40001',message='ROOM_PIN_SHEET_LEASE_LOST';
  end if;
  select exists(
    select 1 from private.room_pin_sheet_full_resync_items item
    left join public.rooms room on room.id=item.room_id and room.catalog_status='active'
    left join private.room_current_pin current_pin on current_pin.room_id=item.room_id
    where item.run_id=p_run_id and (room.id is null or room.room_number<>item.room_number_snapshot
      or private.current_pin_sync_status(item.room_id)<>item.sync_status
      or coalesce(current_pin.pin_version,0)<>item.pin_version
      or current_pin.pin_revision_id is distinct from item.pin_revision_id)
  ) or (select count(*) from public.rooms where catalog_status='active')<>run.snapshot_room_count
    or (select count(*) from private.room_pin_sheet_full_resync_items where run_id=p_run_id)<>run.snapshot_room_count
  into changed;
  if changed then
    if run.reconciles_blocked_fence is not null then
      update private.room_pin_sheet_full_resync_runs set status='operator_blocked',
        last_error_code='SNAPSHOT_STALE',completed_at=at_time where id=p_run_id;
      update private.room_pin_sheet_sync_worker_state set status='operator_blocked',claim_id=null,
        lease_expires_at=null,blocked_reason_code='SNAPSHOT_STALE',updated_at=at_time where singleton=true;
      return jsonb_build_object('status','operator_blocked','leaseFence',p_lease_fence);
    end if;
    update private.room_pin_sheet_full_resync_runs set status='superseded',claim_id=null,
      claimed_at=null,claim_expires_at=null,lease_fence=null,last_error_code='SNAPSHOT_STALE',completed_at=at_time
    where id=p_run_id;
    update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,lease_expires_at=null,
      blocked_reason_code=null,updated_at=at_time where singleton=true;
    return jsonb_build_object('status','superseded');
  end if;
  update private.room_pin_sheet_full_resync_runs set provider_write_started_at=at_time where id=p_run_id;
  return jsonb_build_object('status','authorized','leaseFence',p_lease_fence);
end $$;

-- Surface only non-sensitive room catalog lifecycle metadata in the existing
-- bounded developer audit feed.
alter function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) set schema private;
alter function private.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) rename to list_developer_audit_events_before_room_catalog;
revoke all on function private.list_developer_audit_events_before_room_catalog(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated,service_role;

create function public.list_developer_audit_events(
  p_actor_profile_id uuid,
  p_event_types text[] default null,
  p_filter_actor_profile_id uuid default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_before_recorded_at timestamptz default null,
  p_before_id uuid default null,
  p_limit integer default 50
) returns table(
  id uuid,event_type text,entity_type text,entity_id uuid,
  actor_profile_id uuid,actor_display_name text,effective_at timestamptz,
  recorded_at timestamptz,reason_code text,summary jsonb
) language plpgsql security definer set search_path='' as $$
declare
  new_types constant text[]:=array['room.catalog_created','room.catalog_retired'];
  previous_types text[];
  from_at timestamptz:=coalesce(p_from,clock_timestamp()-interval '7 days');
  to_at timestamptz:=coalesce(p_to,clock_timestamp());
begin
  if p_event_types is not null and coalesce(cardinality(p_event_types),0)=0 then
    raise exception using errcode='22023',message='INVALID_AUDIT_QUERY';
  end if;
  if p_event_types is null then
    previous_types:=null;
  else
    select coalesce(array_agg(requested),array[]::text[]) into previous_types
    from unnest(p_event_types) requested where requested<>all(new_types);
    if cardinality(previous_types)=0 then previous_types:=array['account.created']; end if;
  end if;
  return query
  select merged.* from (
    select previous.*
    from private.list_developer_audit_events_before_room_catalog(
      p_actor_profile_id,previous_types,p_filter_actor_profile_id,p_from,p_to,
      p_before_recorded_at,p_before_id,p_limit
    ) previous
    where p_event_types is null or previous.event_type=any(p_event_types)
    union all
    select audit.id,audit.event_type,audit.entity_type,audit.entity_id,
      audit.actor_profile_id,audit.actor_display_name_snapshot,audit.effective_at,
      audit.recorded_at,audit.reason_code,
      jsonb_strip_nulls(jsonb_build_object(
        'roomNumber',audit.after_state->>'roomNumber',
        'status',audit.after_state->>'status',
        'version',audit.after_state->'version',
        'roomTypeCode',audit.after_state->>'roomTypeCode',
        'elevatorZone',audit.after_state->>'elevatorZone'
      ))
    from public.audit_events audit
    where audit.event_type=any(new_types)
      and (p_event_types is null or audit.event_type=any(p_event_types))
      and audit.recorded_at>=from_at and audit.recorded_at<=to_at
      and (p_filter_actor_profile_id is null or audit.actor_profile_id=p_filter_actor_profile_id)
      and (p_before_recorded_at is null
        or (audit.recorded_at,audit.id)<(p_before_recorded_at,p_before_id))
    order by recorded_at desc,id desc
    limit p_limit
  ) merged
  order by merged.recorded_at desc,merged.id desc
  limit p_limit;
end $$;
revoke all on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) from public,anon,authenticated;
grant execute on function public.list_developer_audit_events(
  uuid,text[],uuid,timestamptz,timestamptz,timestamptz,uuid,integer
) to service_role;

commit;
