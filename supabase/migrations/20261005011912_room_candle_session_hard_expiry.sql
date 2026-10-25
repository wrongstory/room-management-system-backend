-- #330: SHARE locks prevent Auth row mutation, not passage of its hard deadline.
-- Preserve the original migration, function identities/ACLs and every ledger.
-- One DO statement is atomic: any source/catalog drift rolls back both patches.
do $candle_session_patch$
declare
  patch record;
  function_oid oid;
  before_catalog jsonb;
  after_catalog jsonb;
  old_source text;
  new_source text;
  definition text;
  replacement jsonb;
  old_fragment text;
  call_fragment constant text := 'private.assert_room_candle_actor(p_actor_profile_id,p_session_id)';
begin
  for patch in
    select * from (values
      ('private.assert_room_candle_actor(uuid,uuid)',
       '676fc8704e1eaa8f23c1ed8533fb847e', 'public.profiles',
       array['postgres=X/postgres']::text[], 0, 0,
       jsonb_build_array(
         jsonb_build_array('declare actor public.profiles%rowtype;',
           'declare actor public.profiles%rowtype; session_not_after timestamptz;'),
         jsonb_build_array($guard_before$  perform 1 from auth.sessions where id = p_session and user_id = actor.auth_user_id
    and (not_after is null or not_after > clock_timestamp()) for share;
  if not found then raise exception using errcode = '42501', message = 'SESSION_REVOKED'; end if;$guard_before$,
           $guard_after$  select not_after into session_not_after from auth.sessions
    where id = p_session and user_id = actor.auth_user_id for share;
  -- Evaluate time only after the actual SHARE lock has been acquired.
  if not found or (session_not_after is not null and session_not_after <= clock_timestamp()) then
    raise exception using errcode = '42501', message = 'SESSION_REVOKED';
  end if;$guard_after$))),
      ('public.set_room_candle_count(uuid,uuid,uuid,bigint,text,jsonb,text,text)',
       '87e1a66ca14e3209747c189cb1b6de6d', 'jsonb',
       array['postgres=X/postgres','service_role=X/postgres']::text[], 1, 3,
       jsonb_build_array(
         jsonb_build_array($room_before$  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  if room.state_version <> p_expected_room_version then$room_before$,
           $room_after$  if not found then raise exception using errcode = 'P0002', message = 'ROOM_NOT_FOUND'; end if;
  -- A valid entry session may have expired while waiting for the room lock.
  actor := private.assert_room_candle_actor(p_actor_profile_id,p_session_id);
  if room.state_version <> p_expected_room_version then$room_after$),
         jsonb_build_array($receipt_before$  perform private.complete_command(actor.id,'room.operation.set_candle_count',p_idempotency_key,p_request_hash,room.id,response);$receipt_before$,
           $receipt_after$  -- Any late hard-expiry denial rolls back event, audit, CAS and pending receipt.
  actor := private.assert_room_candle_actor(p_actor_profile_id,p_session_id);
  perform private.complete_command(actor.id,'room.operation.set_candle_count',p_idempotency_key,p_request_hash,room.id,response);$receipt_after$)))
    ) as patches(signature, source_md5, return_type, expected_acl, old_calls, new_calls, replacements)
  loop
    function_oid := to_regprocedure(patch.signature);
    if function_oid is null then
      raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_FUNCTION_MISSING';
    end if;
    select to_jsonb(p) - 'prosrc', p.prosrc, pg_get_functiondef(p.oid)
      into strict before_catalog, old_source, definition from pg_proc p where p.oid = function_oid;
    if exists (select 1 from pg_proc p where p.oid = function_oid and (
      p.proowner <> 'postgres'::regrole or p.prolang <> (select oid from pg_language where lanname = 'plpgsql')
      or p.prokind <> 'f' or p.provolatile <> 'v' or p.proparallel <> 'u'
      or not p.prosecdef or p.proisstrict or p.proleakproof or p.proretset
      or p.pronargdefaults <> 0 or p.provariadic <> 0
      or p.prorettype <> to_regtype(patch.return_type)
      or p.proconfig is distinct from array['search_path=""']::text[]
      or array(select acl::text from unnest(p.proacl) acl order by acl::text) is distinct from patch.expected_acl
    )) then
      raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_ATTRIBUTE_DRIFT';
    end if;
    if md5(old_source) <> patch.source_md5 then
      raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_SOURCE_DRIFT';
    end if;
    if (length(old_source) - length(replace(old_source, call_fragment, ''))) / length(call_fragment) <> patch.old_calls then
      raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_CALL_DRIFT';
    end if;
    new_source := old_source;
    for replacement in select value from jsonb_array_elements(patch.replacements)
    loop
      old_fragment := replacement ->> 0;
      if old_fragment = '' or
        (length(new_source) - length(replace(new_source, old_fragment, ''))) / length(old_fragment) <> 1 then
        raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_FRAGMENT_DRIFT';
      end if;
      new_source := replace(new_source, old_fragment, replacement ->> 1);
    end loop;
    if new_source = old_source or
      (length(definition) - length(replace(definition, old_source, ''))) / length(old_source) <> 1 or
      (length(new_source) - length(replace(new_source, call_fragment, ''))) / length(call_fragment) <> patch.new_calls then
      raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_DEFINITION_DRIFT';
    end if;
    -- pg_get_functiondef supplies CREATE OR REPLACE with the original attributes.
    execute replace(definition, old_source, new_source);
    select to_jsonb(p) - 'prosrc' into strict after_catalog from pg_proc p where p.oid = function_oid;
    if after_catalog is distinct from before_catalog or
      (select prosrc from pg_proc where oid = function_oid) is distinct from new_source then
      raise exception using errcode = '55000', message = 'CANDLE_SESSION_PATCH_CATALOG_CHANGED';
    end if;
  end loop;
end;
$candle_session_patch$;
