-- #396: all-status content inventory. No selection, publication or reset authority.
-- Readable history is deliberately distinct from the current fresh-publication shape.
create function private.inspect_reset_template_shape(p_template jsonb,p_room_code text,p_next_version bigint)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog as $$
declare snapshot jsonb; normalized jsonb; readable boolean; fresh_shape boolean:=false;
begin
  snapshot:=jsonb_build_object('templateVersionId',p_template->'id','version',p_template->'version',
    'roomTypeCode',p_room_code,'cleaningKind',p_template->'cleaning_kind','slots',p_template->'photo_slots');
  readable:=coalesce(private.photo_snapshot_valid(snapshot),false);
  begin
    normalized:=private.normalized_checkout_template_slots(p_template->'photo_slots');
    -- Normalization may sort by displayOrder, but may not discard or rewrite any slot value.
    fresh_shape:=p_next_version between 1 and 2147483647
      and (p_template->>'cleaning_kind'='checkout' or p_template->'duration_minutes'<>'null'::jsonb)
      and (p_template->'duration_minutes'='null'::jsonb or (p_template->>'duration_minutes')::integer between 1 and 10080)
      and not exists(select 1 from jsonb_array_elements(normalized) s where not(s ? 'maxPhotos'))
      and private.photo_snapshot_valid(snapshot||jsonb_build_object('version',greatest(p_next_version,
        case when normalized=private.flat_cleaning_photo_slots() then 9 else 8 end),'slots',normalized));
  exception when invalid_parameter_value or invalid_text_representation or numeric_value_out_of_range then
    fresh_shape:=false;
  end;
  return jsonb_build_object('historicallyReadable',readable,'registrationShapeValid',coalesce(fresh_shape,false));
end
$$;
alter function private.inspect_reset_template_shape(jsonb,text,bigint) owner to postgres;
revoke all on function private.inspect_reset_template_shape(jsonb,text,bigint) from public,anon,authenticated,service_role;

create function private.collect_developer_reset_template_inventory()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog set lock_timeout='2s' as $$
declare
  deadline timestamptz:=statement_timestamp()+interval '5 seconds';
  templates jsonb; slots jsonb; t jsonb; projection jsonb; selected_slots jsonb;
  items jsonb:='[]'; references_found jsonb:='[]'; ref record; ref_result jsonb;
  template_count bigint; slot_count bigint; orphan_slots bigint; next_version bigint;
  room_code text; shape jsonb; projection_matches boolean; content_digest text;
begin
  -- Every supported relation is sampled in the outer statement snapshot, never through an FDW.
  if exists(select 1 from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname||'.'||c.relname in ('public.cleaning_template_versions','private.photo_template_slots',
      'public.cleaning_targets','public.cleaning_attempts','private.target_photo_snapshot_contracts',
      'private.target_photo_slot_snapshots','private.flat_evidence_migration_receipts','public.room_types','public.profiles')
      and (c.relkind<>'r' or c.relispartition)) then
    raise exception using errcode='22023',message='RESET_TEMPLATE_RELATION_UNSUPPORTED';
  end if;
  select count(*) into template_count from (select 1 from only public.cleaning_template_versions limit 10001) q;
  select count(*) into slot_count from (select 1 from only private.photo_template_slots limit 10001) q;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.id),'[]') into templates
    from (select * from only public.cleaning_template_versions order by id limit 10001) q;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.id),'[]') into slots
    from (select * from only private.photo_template_slots order by id limit 10001) q;
  -- Limits are a failure, never a partial collection or a successful empty inventory.
  if template_count>10000 or slot_count>10000 then
    raise exception using errcode='54000',message='RESET_TEMPLATE_INVENTORY_LIMIT';
  end if;
  select count(*) into orphan_slots from jsonb_array_elements(slots) s
    where not exists(select 1 from jsonb_array_elements(templates) v where v->'id'=s->'template_version_id');
  for t in select value from jsonb_array_elements(templates) loop
    if clock_timestamp()>=deadline then raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT'; end if;
    select code into room_code from only public.room_types where id=(t->>'room_type_id')::uuid;
    select max((v->>'version')::bigint)+1
      into next_version from jsonb_array_elements(templates) v
      where v->'room_type_id'=t->'room_type_id' and v->'cleaning_kind'=t->'cleaning_kind';
    select coalesce(jsonb_agg(s order by (s->>'display_order')::integer,s->>'id'),'[]') into selected_slots
      from jsonb_array_elements(slots) s where s->'template_version_id'=t->'id';
    select coalesce(jsonb_agg(s->'slot_snapshot' order by (s->>'display_order')::integer,s->>'id'),'[]') into projection
      from jsonb_array_elements(selected_slots) s;
    projection_matches:=case when t->>'status'='draft' and selected_slots='[]'::jsonb then true
      when jsonb_typeof(t->'photo_slots')<>'array' then false
      else jsonb_array_length(projection)=jsonb_array_length(t->'photo_slots')
        and not exists((select value from jsonb_array_elements(projection)) except all
          (select value from jsonb_array_elements(t->'photo_slots')))
        and not exists(select 1 from jsonb_array_elements(selected_slots) s
          where s->'slot_key' is distinct from s#>'{slot_snapshot,slotKey}'
            or s->'display_order' is distinct from s#>'{slot_snapshot,displayOrder}'
            or s->'required' is distinct from s#>'{slot_snapshot,required}') end;
    shape:=private.inspect_reset_template_shape(t,room_code,next_version);
    content_digest:=encode(extensions.digest(jsonb_build_object('template',t,'slots',selected_slots)::text,'sha256'),'hex');
    items:=items||jsonb_build_array(shape||jsonb_build_object(
      'sourceId',t->'id','status',t->'status','cleaningKind',t->'cleaning_kind',
      'contentDigest',content_digest,'slotRows',jsonb_array_length(selected_slots),
      'slotProjectionMatches',projection_matches,'versionAvailable',next_version<=2147483647,
      'currentPublicationPathSupported',t->>'cleaning_kind'='checkout',
      'creatorExists',exists(select 1 from only public.profiles where id=(t->>'created_by')::uuid)));
  end loop;
  -- Explicit logical references; historical identities are counted, never rewritten.
  -- A missing current catalog target may be legitimate history and is reported as detached.
  for ref in select * from (values
    ('public','cleaning_targets','template_snapshot.id','jsonb_build_array(to_jsonb(s.template_snapshot -> ''id''))'),
    ('public','cleaning_attempts','template_snapshot.id','jsonb_build_array(to_jsonb(s.template_snapshot -> ''id''))'),
    ('private','target_photo_snapshot_contracts','frozen_snapshot.templateVersionId','jsonb_build_array(to_jsonb(s.frozen_snapshot -> ''templateVersionId''))'),
    ('private','target_photo_slot_snapshots','template_version_id','jsonb_build_array(to_jsonb(s.template_version_id))'),
    ('private','flat_evidence_migration_receipts','previous_template_snapshot.id','jsonb_build_array(to_jsonb(s.previous_template_snapshot -> ''id''))'),
    ('private','flat_evidence_migration_receipts','previous_photo_contract.templateVersionId','jsonb_build_array(to_jsonb(s.previous_photo_contract -> ''templateVersionId''))'),
    ('private','flat_evidence_migration_receipts','previous_slots.template_version_id',
      'case when jsonb_typeof(s.previous_slots)=''array'' then coalesce((select jsonb_agg(v->''template_version_id'') from jsonb_array_elements(s.previous_slots) v),''[]''::jsonb) else ''[false]''::jsonb end')
  ) refs(schema_name,table_name,reference_path,expression) loop
    if clock_timestamp()>=deadline then raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT'; end if;
    execute format($query$
      with bounded as materialized(select * from only %I.%I limit 10001),
      extracted as materialized(select x.value from bounded s cross join lateral jsonb_array_elements(%s) x limit 10001),
      edges as (select value,case when jsonb_typeof(value)='string' and value#>>'{}' ~* '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$'
        then (value#>>'{}')::uuid else null end target_id from extracted)
      select jsonb_build_object('relation',%L,'path',%L,'sourceRows',(select count(*) from bounded),
        'edgeRows',count(*),'absent',count(*) filter(where value='null'::jsonb),
        'malformed',count(*) filter(where value<>'null'::jsonb and target_id is null),
        'detached',count(*) filter(where target_id is not null and not exists(select 1 from only public.cleaning_template_versions t where t.id=target_id)),
        'matched',count(*) filter(where target_id is not null and exists(select 1 from only public.cleaning_template_versions t where t.id=target_id)))
        from edges
    $query$,ref.schema_name,ref.table_name,ref.expression,ref.schema_name||'.'||ref.table_name,ref.reference_path) into ref_result;
    if (ref_result->>'sourceRows')::integer>10000 or (ref_result->>'edgeRows')::integer>10000 then
      raise exception using errcode='54000',message='RESET_TEMPLATE_INVENTORY_LIMIT';
    end if;
    references_found:=references_found||jsonb_build_array(ref_result);
  end loop;
  if clock_timestamp()>=deadline then raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT'; end if;
  return jsonb_build_object('format','reset-template-inventory-v1',
    'snapshotId',encode(extensions.digest(pg_current_snapshot()::text||statement_timestamp()::text,'sha256'),'hex'),
    'templateCount',template_count,'slotCount',slot_count,'orphanSlots',orphan_slots,
    'templates',items,'references',references_found);
end
$$;
alter function private.collect_developer_reset_template_inventory() owner to postgres;
revoke all on function private.collect_developer_reset_template_inventory() from public,anon,authenticated,service_role;

-- Gate128 is integrated before this candidate is finalized. The public RPC retains
-- its live pre/post actor and session checks and the shared STABLE read statement.
create or replace function private.collect_developer_reset_impact_preview()
returns jsonb language sql stable security definer set search_path=pg_catalog as $$
  select private.collect_developer_reset_inventory()||jsonb_build_object(
    'rowImpact',private.collect_developer_reset_row_impact(),
    'gateEvidence',private.collect_developer_operation_gates(),
    'templateEvidence',private.collect_developer_reset_template_inventory())
$$;
alter function private.collect_developer_reset_impact_preview() owner to postgres;
revoke all on function private.collect_developer_reset_impact_preview() from public,anon,authenticated,service_role;
