-- #396: read-only inventory preview, never a reset or execution approval.
-- STABLE collector uses one calling SELECT snapshot for all catalog/count reads.
-- No business values, IDs, PINs, Auth credentials or row contents leave this function.
create function private.collect_developer_reset_inventory()
returns jsonb language plpgsql stable security definer set search_path = pg_catalog
set lock_timeout = '2s'
as $$
declare
  r record;
  n bigint;
  items jsonb := '[]'::jsonb;
  deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  if (select count(*) from pg_class c join pg_namespace s on s.oid=c.relnamespace
      where s.nspname in ('public','private') and c.relkind in ('r','p','f')) > 1000 then
    raise exception using errcode='54000',message='RESET_PREVIEW_LIMIT_EXCEEDED';
  end if;
  for r in
    select c.oid,s.nspname,c.relname,c.relkind,c.relispartition
    from pg_class c join pg_namespace s on s.oid=c.relnamespace
    where s.nspname in ('public','private') and c.relkind in ('r','p','f')
    order by s.nspname,c.relname
  loop
    if clock_timestamp() >= deadline then
      raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT';
    end if;
    n := null;
    -- Never query a foreign relation/provider or count inherited rows twice.
    if r.relkind='r' and not r.relispartition then
      execute format('select count(*) from (select 1 from only %I.%I limit 10001) bounded',r.nspname,r.relname) into n;
    end if;
    if clock_timestamp() >= deadline then
      raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT';
    end if;
    items := items || jsonb_build_array(jsonb_build_object(
      'relation',r.nspname||'.'||r.relname,'kind',r.relkind::text,
      'partition',r.relispartition,'observedRows',n,'exact',n is not null and n<=10000));
  end loop;
  return jsonb_build_object('format','reset-preview-inventory-v1','readOnly',true,
    'capturedAt',statement_timestamp(),'snapshotId',
    encode(extensions.digest(pg_current_snapshot()::text||statement_timestamp()::text,'sha256'),'hex'),
    'relations',items);
end
$$;
alter function private.collect_developer_reset_inventory() owner to postgres;
revoke all on function private.collect_developer_reset_inventory() from public,anon,authenticated,service_role;

-- VOLATILE is used only for fresh authorization before and after the STABLE read.
-- Reuse the existing sequential profile/session check; no actor parameter from a client body.
create function public.get_developer_reset_preview(p_auth_user_id uuid,p_actor_profile_id uuid,p_session_id text)
returns jsonb language plpgsql volatile security definer set search_path = pg_catalog
-- PostgREST applies this RPC-level timeout before running its calling statement.
set statement_timeout = '7s'
as $$
declare context jsonb; result jsonb; pass integer;
begin
  for pass in 1..2 loop
    context := public.get_active_auth_context(p_auth_user_id,p_session_id);
    if context->>'code' is distinct from 'OK' then
      raise exception using errcode='42501',message='RESET_PREVIEW_AUTHORIZATION_FAILED';
    end if;
    if context#>>'{profile,id}' is distinct from p_actor_profile_id::text
      or context#>>'{profile,role}' is distinct from 'developer'
      or context#>>'{profile,must_change_password}' is distinct from 'false' then
      raise exception using errcode='42501',message='DEVELOPER_REQUIRED';
    end if;
    if pass=1 then select private.collect_developer_reset_inventory() into result; end if;
  end loop;
  return result;
end
$$;
alter function public.get_developer_reset_preview(uuid,uuid,text) owner to postgres;
revoke all on function public.get_developer_reset_preview(uuid,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.get_developer_reset_preview(uuid,uuid,text) to service_role;
comment on function public.get_developer_reset_preview(uuid,uuid,text) is
  '#396 service-only bounded read-only inventory; latest developer/session checked before and after; no reset capability.';
