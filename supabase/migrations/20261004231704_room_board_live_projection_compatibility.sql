-- #318: retain existing LIVE PIN, materialized-cleaning and active occupancy.
-- LIVE selection and the STABLE request clock are patched. Historical/future
-- date boundaries, detail conditions, actor/session checks, OID/ACL and ledgers
-- are unchanged. This owned append is still unapplied on both hosted projects.
do $live_compatibility$
declare
  function_oid oid := to_regprocedure('public.get_room_board_projection(uuid,uuid,date,uuid)');
  old_source text;
  new_source text;
  definition text;
  replacement jsonb;
  old_fragment text;
  old_acl aclitem[];
  old_owner oid;
  old_attributes jsonb;
begin
  if function_oid is null then
    raise exception 'ROOM_BOARD_LIVE_FUNCTION_MISSING';
  end if;
  select prosrc, pg_get_functiondef(oid), proacl, proowner,
    jsonb_build_array(provolatile, prosecdef, proconfig, prorettype, proargtypes::text)
  into strict old_source, definition, old_acl, old_owner, old_attributes
  from pg_proc where oid = function_oid;
  if md5(old_source) <> '7a4ca74a6410734ac72b251a2cf6c418' then
    raise exception 'ROOM_BOARD_LIVE_SOURCE_DRIFT';
  end if;
  new_source := old_source;
  for replacement in
    select value from jsonb_array_elements(jsonb_build_array(
      jsonb_build_array(
        'v_server_time timestamptz := clock_timestamp();',
        'v_server_time timestamptz := statement_timestamp();'),
      jsonb_build_array(
        'private.room_board_cleaning_required_at(room.id, v_evaluated_at) as cleaning_required',
        E'case when v_projection_mode = ''LIVE''\n        then private.room_current_cleaning_required_at(room.id, v_evaluated_at)\n        else private.room_board_cleaning_required_at(room.id, v_evaluated_at)\n      end as cleaning_required'),
      jsonb_build_array(
        'private.room_board_pin_sync_status_at(room.id, v_evaluated_at) as pin_status',
        E'case when v_projection_mode = ''LIVE''\n        then private.current_pin_sync_status(room.id)\n        else private.room_board_pin_sync_status_at(room.id, v_evaluated_at)\n      end as pin_status'),
      jsonb_build_array(
        E'and (segment.ends_at is null or segment.ends_at > v_evaluated_at)\n    order by segment.starts_at desc, segment.id desc',
        E'and (\n        (segment.ends_at is null or segment.ends_at > v_evaluated_at)\n        or (v_projection_mode = ''LIVE'' and stay.status = ''active''\n          and reservation.actual_check_in_at is not null\n          and reservation.actual_check_in_at <= v_evaluated_at\n          and reservation.actual_checkout_at is null\n          and segment.room_id = private.reservation_final_room_id(reservation.id)\n          and not exists (\n            select 1 from private.room_occupancy_corrections correction\n            where correction.successor_segment_id = segment.id\n              and not correction.occupied\n              and correction.effective_at <= v_evaluated_at\n          ))\n      )\n    order by segment.starts_at desc, segment.id desc')
    ))
  loop
    old_fragment := replacement ->> 0;
    if (length(new_source) - length(replace(new_source, old_fragment, ''))) / length(old_fragment) <> 1 then
      raise exception 'ROOM_BOARD_LIVE_FRAGMENT_DRIFT';
    end if;
    new_source := replace(new_source, old_fragment, replacement ->> 1);
  end loop;
  if new_source = old_source or
    (length(definition) - length(replace(definition, old_source, ''))) / length(old_source) <> 1 then
    raise exception 'ROOM_BOARD_LIVE_DEFINITION_DRIFT';
  end if;
  execute replace(definition, old_source, new_source);
  if to_regprocedure('public.get_room_board_projection(uuid,uuid,date,uuid)') <> function_oid or
    exists (
      select 1 from pg_proc
      where oid = function_oid and (
        proacl is distinct from old_acl or proowner <> old_owner or
        jsonb_build_array(provolatile, prosecdef, proconfig, prorettype, proargtypes::text)
          is distinct from old_attributes
      )
    ) then
    raise exception 'ROOM_BOARD_LIVE_ATTRIBUTES_DRIFT';
  end if;
end;
$live_compatibility$;
