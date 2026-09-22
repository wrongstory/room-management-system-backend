alter table public.room_types
  add column version bigint not null default 1 check (version > 0);

create or replace function private.advance_room_type_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.version is distinct from old.version then
    raise exception 'ROOM_TYPE_VERSION_MANAGED';
  end if;

  if row(
    new.code,
    new.name,
    new.base_cleaning_fee,
    new.default_duration_minutes,
    new.default_guest_count,
    new.max_guest_count,
    new.active
  ) is distinct from row(
    old.code,
    old.name,
    old.base_cleaning_fee,
    old.default_duration_minutes,
    old.default_guest_count,
    old.max_guest_count,
    old.active
  ) then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;

  return new;
end;
$$;

revoke all on function private.advance_room_type_version() from public, anon, authenticated, service_role;

create trigger room_types_advance_version
before update on public.room_types
for each row execute function private.advance_room_type_version();

create or replace function public.list_room_type_catalog(
  p_actor_profile_id uuid,
  p_session_id uuid
)
returns table (
  id uuid,
  code text,
  display_name text,
  base_cleaning_fee integer,
  active boolean,
  version bigint,
  room_count integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform private.assert_attempt_actor_session(
    p_actor_profile_id,
    p_session_id,
    true
  );

  return query
  select
    rt.id,
    rt.code,
    rt.name as display_name,
    rt.base_cleaning_fee,
    rt.active,
    rt.version,
    count(r.id)::integer as room_count
  from public.room_types rt
  left join public.rooms r on r.room_type_id = rt.id
  group by rt.id
  order by rt.code;
end;
$$;

revoke all on function public.list_room_type_catalog(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_room_type_catalog(uuid, uuid) to service_role;

comment on function public.list_room_type_catalog(uuid, uuid) is
  'Returns the app-owned business-admin room type catalog, including inactive referenced types and current room counts.';
