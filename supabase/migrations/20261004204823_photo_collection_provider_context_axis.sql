-- #384: provider access must compare the same photo CAS axis as admission/finalize.
-- Patch only this guard in the latest definition; preserve later return-field
-- extensions (#383), function identity, security attributes and existing ACLs.
do $migration$
declare
  function_id oid := 'public.get_photo_provider_context(uuid,uuid,uuid,integer,text)'::regprocedure;
  old_source text;
  old_definition text;
  new_source text;
  old_guard constant text := $old$  if a.assignment_id<>o.assignment_id or a.assignment_revision<>o.assignment_revision
    or coalesce((select revision from private.attempt_photo_current where cleaning_attempt_id=a.id and target_photo_slot_id=o.target_photo_slot_id),0)<>o.expected_photo_revision then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;$old$;
  new_guard constant text := $new$  -- PHOTO_COLLECTION_PROVIDER_CONTEXT_AXIS: ordinary and collection CAS stay separate.
  if a.assignment_id<>o.assignment_id or a.assignment_revision<>o.assignment_revision
    or (case when o.collection_item_id is null then
      coalesce((select revision from private.attempt_photo_current
        where cleaning_attempt_id=a.id and target_photo_slot_id=o.target_photo_slot_id),0)<>o.expected_photo_revision
    else
      coalesce((select revision from private.attempt_photo_collection_states
        where cleaning_attempt_id=a.id and target_photo_slot_id=o.target_photo_slot_id),0)<>o.expected_photo_revision
      or o.expected_item_revision is null
      or o.expected_item_revision not between 0 and 9007199254740990
      or (o.expected_item_revision=0 and exists(
        select 1 from private.attempt_photo_collection_items where id=o.collection_item_id))
      or (o.expected_item_revision>0 and not exists(
        select 1 from private.attempt_photo_collection_items item_row
        where item_row.id=o.collection_item_id
          and item_row.cleaning_attempt_id=a.id
          and item_row.cleaning_target_id=o.cleaning_target_id
          and item_row.target_photo_slot_id=o.target_photo_slot_id
          and item_row.active
          and item_row.revision=o.expected_item_revision))
    end) then
    raise exception using errcode='40001',message='PHOTO_VERSION_CONFLICT'; end if;$new$;
begin
  select replace(prosrc, E'\r\n', E'\n'),
    replace(pg_get_functiondef(oid), E'\r\n', E'\n')
    into old_source, old_definition
  from pg_proc where oid=function_id;
  if old_source is null or old_source='' or old_definition is null
    or position('PHOTO_COLLECTION_PROVIDER_CONTEXT_AXIS' in old_source)>0
    or (length(old_source)-length(replace(old_source,old_guard,'')))<>length(old_guard)
    or (length(old_definition)-length(replace(old_definition,old_source,'')))<>length(old_source) then
    raise exception 'PHOTO_COLLECTION_PROVIDER_CONTEXT_SOURCE_DRIFT';
  end if;
  new_source := replace(old_source,old_guard,new_guard);
  execute replace(old_definition,old_source,new_source);
end
$migration$;
