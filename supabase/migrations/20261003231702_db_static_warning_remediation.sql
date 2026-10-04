-- #363 / Decision #373 A: fix eight diagnostics without changing legacy RPC parameters.
-- Applied migrations are immutable. Preserve existing OIDs, ACLs, attributes and ledgers.
-- Read-only developer checks use the calling statement snapshot; command guards stay VOLATILE.
create function private.assert_active_developer_snapshot(p_actor_profile_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.profiles profile
    where profile.id = p_actor_profile_id
      and profile.role = 'developer'
      and profile.status = 'active'
      and not profile.must_change_password
  ) then
    raise exception using errcode = '42501', message = 'DEVELOPER_REQUIRED';
  end if;
end;
$$;
alter function private.assert_active_developer_snapshot(uuid) owner to postgres;
revoke all on function private.assert_active_developer_snapshot(uuid)
from public, anon, authenticated, service_role;

do $remediation$
declare
  patch record;
  replacement jsonb;
  function_oid oid;
  old_source text;
  new_source text;
  definition text;
  old_fragment text;
  expected_count integer;
begin
  for patch in
    select * from (values
      ('private.detect_cleaning_overdue_at(uuid,timestamptz)',
       '1445aebe16112a4d5177db4122c4f0d8',
       jsonb_build_array(
         jsonb_build_array('; notice_id uuid', '', 1),
         jsonb_build_array('notice_id:=private.emit_notification_v1(', 'perform private.emit_notification_v1(', 1))),
      ('public.finalize_generated_room_pin_reveal(uuid,uuid,uuid,uuid,uuid)',
       'c604f449eb96b37df18edb4a857913d1',
       jsonb_build_array(
         jsonb_build_array(E'  v_room public.rooms;\n', '', 1),
         jsonb_build_array('select * into v_room from public.rooms where id = p_room_id for update;',
           'perform 1 from public.rooms where id = p_room_id for update;', 1))),
      ('public.confirm_generated_room_pin(uuid,uuid,uuid,bigint,text,text)',
       '87896a623266244dc60922f13220ce51',
       jsonb_build_array(
         jsonb_build_array(E'  v_room public.rooms;\n', '', 1),
         jsonb_build_array('select * into v_room from public.rooms where id = p_room_id for update;',
           'perform 1 from public.rooms where id = p_room_id for update;', 1))),
      ('public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)',
       'af65520fb460db7dc858645f13246450',
       jsonb_build_array(
         jsonb_build_array(E'  v_actor public.profiles;\n', '', 1),
         jsonb_build_array('v_actor := private.assert_inspection_queue_actor(',
           'perform private.assert_inspection_queue_actor(', 1))),
      ('public.list_cleaning_history(uuid,uuid,date,uuid,text,integer,timestamptz,uuid)',
       '043d760417ffc95308bfd9346a0b831a',
       jsonb_build_array(
         jsonb_build_array(E'declare\n', E'declare\n  v_as_of timestamptz := statement_timestamp();\n', 1),
         jsonb_build_array('clock_timestamp()', 'v_as_of', 2))),
      ('public.get_cleaning_history_submission(uuid,uuid,uuid)',
       '31b8a5b65cc4829f8c69ec951c6b9672',
       jsonb_build_array(
         jsonb_build_array('declare actor', 'declare v_as_of timestamptz := statement_timestamp(); actor', 1),
         jsonb_build_array('clock_timestamp()', 'v_as_of', 1))),
      ('public.get_developer_room_catalog(uuid)',
       'd75eefbe637fb17d942f0f89a626b5f7',
       jsonb_build_array(
         jsonb_build_array('clock_timestamp()', 'statement_timestamp()', 1),
         jsonb_build_array('perform private.assert_active_developer(p_actor_profile_id);',
           'perform private.assert_active_developer_snapshot(p_actor_profile_id);', 1)))
    ) as patches(signature, source_md5, replacements)
  loop
    function_oid := to_regprocedure(patch.signature);
    if function_oid is null then
      raise exception 'DB_STATIC_REMEDIATION_FUNCTION_MISSING: %', patch.signature;
    end if;
    select prosrc, pg_get_functiondef(oid) into strict old_source, definition
    from pg_proc where oid = function_oid;
    if md5(old_source) <> patch.source_md5 then
      raise exception 'DB_STATIC_REMEDIATION_SOURCE_DRIFT: %', patch.signature;
    end if;
    new_source := old_source;
    for replacement in select value from jsonb_array_elements(patch.replacements)
    loop
      old_fragment := replacement ->> 0;
      expected_count := (replacement ->> 2)::integer;
      if old_fragment = '' or
        (length(new_source) - length(replace(new_source, old_fragment, ''))) / length(old_fragment) <> expected_count then
        raise exception 'DB_STATIC_REMEDIATION_FRAGMENT_DRIFT: %', patch.signature;
      end if;
      new_source := replace(new_source, old_fragment, replacement ->> 1);
    end loop;
    if new_source = old_source or
      (length(definition) - length(replace(definition, old_source, ''))) / length(old_source) <> 1 then
      raise exception 'DB_STATIC_REMEDIATION_DEFINITION_DRIFT: %', patch.signature;
    end if;
    execute replace(definition, old_source, new_source);
  end loop;
end;
$remediation$;
