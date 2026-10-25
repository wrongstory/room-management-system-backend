begin;

alter table private.room_pin_revisions drop constraint room_pin_revisions_source_check;
alter table private.room_pin_revisions add constraint room_pin_revisions_source_check
  check (source in ('admin_initial_entry','admin_physical_change','maid_cleaning_change','actual_pin_reentry','sheet_import'));

-- Acquire the same global/room locks as physical PIN commands. No network work in this transaction.
create function private.lock_room_pin_transfer(p_actor uuid, p_session uuid)
returns public.profiles language plpgsql security definer set search_path='' as $$
declare actor public.profiles; v_room_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));
  for v_room_id in select id from public.rooms where active order by id loop
    perform pg_advisory_xact_lock(hashtextextended('room-pin:' || v_room_id::text,0));
    perform 1 from public.rooms where id=v_room_id for update;
  end loop;
  actor := private.assert_room_pin_actor_session(p_actor,p_session);
  if actor.role <> 'admin' then
    raise exception using errcode='42501',message='ADMIN_REQUIRED';
  end if;
  if not exists (select 1 from auth.sessions where id=p_session and user_id=actor.auth_user_id
    and (not_after is null or not_after>clock_timestamp())) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  if (select count(*) from public.rooms where active) not between 1 and 300 then
    raise exception using errcode='22023',message='ROOM_PIN_TRANSFER_CATALOG_INVALID';
  end if;
  return actor;
end $$;

create function private.room_pin_transfer_versions()
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'roomId',r.id,'roomNumber',r.room_number,'stateVersion',r.state_version,
    'pinVersion',coalesce(c.pin_version,0)) order by r.id),'[]'::jsonb)
  from public.rooms r left join private.room_current_pin c on c.room_id=r.id where r.active;
$$;

create function public.get_room_pin_transfer_snapshot(
  p_actor_profile_id uuid,p_session_id uuid,p_expected jsonb default null,p_export boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; result jsonb;
begin
  actor := private.lock_room_pin_transfer(p_actor_profile_id,p_session_id);
  if exists(select 1 from private.room_pin_change_leases l join public.rooms r on r.id=l.room_id where r.active and l.status in ('prepared','expired')) then
    raise exception using errcode='40001',message='ROOM_PIN_TRANSFER_BUSY';
  end if;
  if p_expected is not null and p_expected is distinct from private.room_pin_transfer_versions() then
    raise exception using errcode='40001',message='ROOM_PIN_TRANSFER_STALE';
  end if;
  if p_export then
    if p_expected is null then
      raise exception using errcode='22023',message='INVALID_PIN_TRANSFER_REQUEST';
    end if;
    insert into private.actor_activity_events(
      actor_profile_id,actor_role_snapshot,category,event_type,outcome,source,
      resource_type,resource_id,request_id,occurred_at
    ) select actor.id,actor.role,'sensitive_access','sensitive.read','succeeded',
      'edge.sensitive.room_pin','room',r.id,gen_random_uuid()::text,clock_timestamp()
      from public.rooms r join private.room_current_pin c on c.room_id=r.id where r.active;
  end if;
  if not exists(select 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id
    and (not_after is null or not_after>clock_timestamp())) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  if p_expected is not null then return jsonb_build_object('checked',true); end if;
  select jsonb_agg(jsonb_build_object(
    'roomId',r.id,'roomNumber',r.room_number,'stateVersion',r.state_version,
    'pinVersion',coalesce(c.pin_version,0),'envelope',case when v.id is null then null else jsonb_build_object(
      'envelopeFormat',v.envelope_format,'keyVersion',v.key_version,
      'ciphertextBase64',replace(encode(v.ciphertext,'base64'),E'\n',''),
      'nonceBase64',encode(v.nonce,'base64'),'authTagBase64',encode(v.auth_tag,'base64'),
      'aadEnvironment',v.aad_environment,'aadProjectRef',v.aad_project_ref) end) order by r.id)
  into result from public.rooms r left join private.room_current_pin c on c.room_id=r.id
    left join private.room_pin_revisions v on v.id=c.pin_revision_id where r.active;
  return result;
end $$;

create function public.apply_room_pin_transfer(
  p_actor_profile_id uuid,p_session_id uuid,p_candidates jsonb,p_expected jsonb,
  p_idempotency_key text,p_request_hash text,p_unchanged integer default 0,
  p_expires_at timestamptz default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare actor public.profiles; replay jsonb; item jsonb; v_room_id uuid; version bigint;
  revision_id uuid; at_time timestamptz; result jsonb; changed integer:=0;
begin
  actor := private.lock_room_pin_transfer(p_actor_profile_id,p_session_id);
  replay := private.replay_command(actor.id,'room.pin.sheet_import',p_idempotency_key,p_request_hash);
  if replay is not null then return replay; end if;
  -- Receipt lookup supports response-loss recovery without contacting Google again.
  if p_candidates is null and p_expected is null then return null; end if;
  if p_expected is null or p_expected is distinct from private.room_pin_transfer_versions()
    or p_expires_at is null or p_expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='ROOM_PIN_TRANSFER_STALE';
  end if;
  if exists(select 1 from private.room_pin_change_leases l join public.rooms r on r.id=l.room_id where r.active and l.status in ('prepared','expired')) then
    raise exception using errcode='40001',message='ROOM_PIN_TRANSFER_BUSY';
  end if;
  if p_candidates is null or jsonb_typeof(p_candidates)<>'array' or jsonb_array_length(p_candidates)>300
    or p_unchanged is null or p_unchanged<0 or p_unchanged+jsonb_array_length(p_candidates)>300 then
    raise exception using errcode='22023',message='INVALID_PIN_TRANSFER_REQUEST';
  end if;
  if (select count(*)<>count(distinct value->>'roomId') from jsonb_array_elements(p_candidates)) then
    raise exception using errcode='22023',message='INVALID_PIN_TRANSFER_REQUEST';
  end if;
  for item in select value from jsonb_array_elements(p_candidates) order by value->>'roomId' loop
    if jsonb_typeof(item)<>'object' or not item ?& array[
      'roomId','envelopeFormat','keyVersion','ciphertextBase64','nonceBase64','authTagBase64','aadEnvironment','aadProjectRef'
    ] or exists(select 1 from jsonb_object_keys(item) k where k<>all(array[
      'roomId','envelopeFormat','keyVersion','ciphertextBase64','nonceBase64','authTagBase64','aadEnvironment','aadProjectRef'
    ])) or exists(select 1 from jsonb_each(item) e where e.value='null'::jsonb) then
      raise exception using errcode='22023',message='INVALID_PIN_TRANSFER_REQUEST';
    end if;
    v_room_id := (item->>'roomId')::uuid;
    if not exists(select 1 from public.rooms where id=v_room_id and active) then
      raise exception using errcode='40001',message='ROOM_PIN_TRANSFER_STALE';
    end if;
    select coalesce((select pin_version from private.room_current_pin where room_id= (item->>'roomId')::uuid),0)+1 into version;
    revision_id := gen_random_uuid(); at_time := clock_timestamp();
    insert into private.room_pin_revisions(
      id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,key_version,
      aad_environment,aad_project_ref,recorded_by,recorded_by_role,source,created_at
    ) values(
      revision_id,v_room_id,version,(item->>'envelopeFormat')::smallint,decode(item->>'ciphertextBase64','base64'),
      decode(item->>'nonceBase64','base64'),decode(item->>'authTagBase64','base64'),item->>'keyVersion',
      item->>'aadEnvironment',item->>'aadProjectRef',actor.id,'admin','sheet_import',at_time
    );
    insert into private.room_current_pin(room_id,pin_revision_id,pin_version,updated_at)
      values(v_room_id,revision_id,version,at_time)
      on conflict on constraint room_current_pin_pkey do update
      set pin_revision_id=excluded.pin_revision_id,pin_version=excluded.pin_version,updated_at=excluded.updated_at;
    insert into public.room_pin_sync_events(room_id,sync_status,pin_version,reason_code,actor_profile_id,effective_at,recorded_at)
      values(v_room_id,'mismatch',version,'SHEET_PIN_AWAITING_PHYSICAL_CONFIRMATION',actor.id,at_time,at_time);
    update public.rooms set state_version=state_version+1 where id=v_room_id;
    insert into public.audit_events(
      actor_profile_id,actor_display_name_snapshot,event_type,entity_type,entity_id,effective_at,
      reason_code,after_state,request_hash,idempotency_key
    ) values(actor.id,actor.display_name,'room.pin_imported','room',v_room_id,at_time,'SHEET_IMPORT',
      jsonb_build_object('pinVersion',version,'status','mismatch'),p_request_hash,
      private.audit_command_key(actor.id,'room.pin.sheet_import.'||v_room_id::text,p_idempotency_key));
    changed := changed+1;
  end loop;
  if p_expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='ROOM_PIN_TRANSFER_STALE';
  end if;
  if not exists(select 1 from auth.sessions where id=p_session_id and user_id=actor.auth_user_id
    and (not_after is null or not_after>clock_timestamp())) then
    raise exception using errcode='42501',message='SESSION_REVOKED';
  end if;
  result := jsonb_build_object('updated',changed,'unchanged',p_unchanged);
  perform private.complete_command(actor.id,'room.pin.sheet_import',p_idempotency_key,p_request_hash,null,result);
  return result;
end $$;

revoke all on function private.lock_room_pin_transfer(uuid,uuid) from public,anon,authenticated,service_role;
revoke all on function private.room_pin_transfer_versions() from public,anon,authenticated,service_role;
revoke all on function public.get_room_pin_transfer_snapshot(uuid,uuid,jsonb,boolean) from public,anon,authenticated;
revoke all on function public.apply_room_pin_transfer(uuid,uuid,jsonb,jsonb,text,text,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.get_room_pin_transfer_snapshot(uuid,uuid,jsonb,boolean) to service_role;
grant execute on function public.apply_room_pin_transfer(uuid,uuid,jsonb,jsonb,text,text,integer,timestamptz) to service_role;
commit;
