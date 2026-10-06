-- #332 after #329: retain the registered-report VOLATILE read contract and
-- replace its single snapshot identity check with the existing fresh guard.
-- Original #332/#329 SQL and their strict migration-time inventories stay exact.
do $patch$
declare
  target_oid oid := to_regprocedure('public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)');
  helper_oid oid := to_regprocedure('private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)');
  original_body text;
  definition text;
  original_contract jsonb;
  old_call constant text := 'private.assert_attempt_actor_session(';
  new_call constant text := 'private.assert_attempt_actor_session_fresh(';
begin
  if target_oid is null or helper_oid is null then
    raise exception 'ADMIN_REPORT_FRESH_GUARD_DEPENDENCY_MISSING';
  end if;
  if not exists(select 1 from pg_proc p join pg_language l on l.oid=p.prolang
    where p.oid=helper_oid and l.lanname='plpgsql' and p.prokind='f'
      and p.provolatile='v' and p.prosecdef and p.prorettype='public.profiles'::regtype
      and p.proconfig=array['search_path=""']::text[])
    or exists(select 1 from (values('anon'),('authenticated'),('service_role')) roles(name)
      where has_function_privilege(roles.name,helper_oid,'EXECUTE')) then
    raise exception 'ADMIN_REPORT_FRESH_GUARD_DEPENDENCY_DRIFT';
  end if;
  select p.prosrc,to_jsonb(p)-'prosrc' into original_body,original_contract
    from pg_proc p join pg_language l on l.oid=p.prolang
    where p.oid=target_oid and l.lanname='plpgsql' and p.prokind='f'
      and p.provolatile='v' and p.prosecdef and p.prorettype='jsonb'::regtype
      and p.proconfig=array['search_path=""']::text[];
  if original_body is null
    or md5(replace(original_body,E'\r\n',E'\n'))<>'5244a78ce24b971106cae3d7bd49d46b'
    or (length(original_body)-length(replace(original_body,old_call,'')))/length(old_call)<>1
    or strpos(original_body,new_call)>0
    or not has_function_privilege('service_role',target_oid,'EXECUTE')
    or exists(select 1 from (values('anon'),('authenticated')) roles(name)
      where has_function_privilege(roles.name,target_oid,'EXECUTE')) then
    raise exception 'ADMIN_REPORT_FRESH_GUARD_SOURCE_DRIFT';
  end if;
  definition:=pg_get_functiondef(target_oid);
  if (length(definition)-length(replace(definition,old_call,'')))/length(old_call)<>1 then
    raise exception 'ADMIN_REPORT_FRESH_GUARD_DEFINITION_DRIFT';
  end if;
  execute replace(definition,old_call,new_call);
  if not exists(select 1 from pg_proc p
    where p.oid=target_oid and to_jsonb(p)-'prosrc'=original_contract
      and p.prosrc=replace(original_body,old_call,new_call)
      and md5(replace(p.prosrc,E'\r\n',E'\n'))='5981a7d9c2d1a4ecba51c45bb4f04ffb') then
    raise exception 'ADMIN_REPORT_FRESH_GUARD_CONTRACT_DRIFT';
  end if;
end $patch$;
