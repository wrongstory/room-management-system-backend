-- #416: one aggregate per selected room, preserving the historical time predicate.
-- Source candidate only. Execute only after the separately approved final DB gate.
do $issue_counts$
declare
  function_oid oid := to_regprocedure('public.get_room_board_projection(uuid,uuid,date,uuid)');
  old_source text;
  new_source text;
  definition text;
  before_catalog jsonb;
  after_catalog jsonb;
  old_counts constant text := $before$      private.room_board_issue_count_at(room.id, v_evaluated_at, false) as issue_count,
      private.room_board_issue_count_at(room.id, v_evaluated_at, true) as blocking_issue_count,$before$;
  new_counts constant text := $after$      issue_counts.issue_count,
      issue_counts.blocking_issue_count,$after$;
  old_join constant text := $before$  ) display_reservation
  cross join lateral ($before$;
  new_join constant text := $after$  ) display_reservation
  cross join lateral (
    select count(*)::integer as issue_count,
      count(*) filter (where issue.blocks_guest_assignment)::integer as blocking_issue_count
    from public.room_issues issue
    where issue.room_id = room.id
      and issue.reported_at <= v_evaluated_at
      and (issue.resolved_at is null or issue.resolved_at > v_evaluated_at)
  ) issue_counts
  cross join lateral ($after$;
begin
  if function_oid is null then
    raise exception 'ROOM_BOARD_ISSUE_COUNTS_FUNCTION_MISSING';
  end if;
  select replace(p.prosrc, E'\r\n', E'\n'),
    replace(pg_get_functiondef(p.oid), E'\r\n', E'\n'), to_jsonb(p) - 'prosrc'
    into strict old_source, definition, before_catalog from pg_proc p where p.oid = function_oid;
  if md5(old_source) <> 'dbcb3d36a8ee29447ca04854b6ad8909' then
    raise exception 'ROOM_BOARD_ISSUE_COUNTS_SOURCE_DRIFT';
  end if;
  if (length(old_source) - length(replace(old_source, old_counts, ''))) / length(old_counts) <> 1
    or (length(old_source) - length(replace(old_source, old_join, ''))) / length(old_join) <> 1
    or (length(definition) - length(replace(definition, old_source, ''))) / length(old_source) <> 1 then
    raise exception 'ROOM_BOARD_ISSUE_COUNTS_FRAGMENT_DRIFT';
  end if;
  new_source := replace(replace(old_source, old_counts, new_counts), old_join, new_join);
  -- No renamed RPC, helper, signature, owner, grant, clock, actor check or other projection change.
  execute replace(definition, old_source, new_source);
  select to_jsonb(p) - 'prosrc' into strict after_catalog from pg_proc p where p.oid = function_oid;
  if to_regprocedure('public.get_room_board_projection(uuid,uuid,date,uuid)') <> function_oid
    or after_catalog is distinct from before_catalog
    or (select prosrc from pg_proc where oid = function_oid) is distinct from new_source then
    raise exception 'ROOM_BOARD_ISSUE_COUNTS_CATALOG_DRIFT';
  end if;
end;
$issue_counts$;
