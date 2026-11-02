-- #558 approved source corrections; database application requires separate exact-input approval.
-- No business policy, collector clock/snapshot/deadline, owner/ACL or history changes.

-- #558: preserve the reviewed function contracts and reject missing/drifted origins before any replacement.
do $lint_source_guard$
declare expected jsonb; actual record; actual_acl text[];
begin
  for expected in select value from jsonb_array_elements($origins$[{"identity":"public.get_developer_reset_preview(uuid,uuid,text)","beforeSha256":"9eaf597ac996a24b565116853dbc5d84e497d357c80260144ba7bd66f97a9110","volatility":"v","securityDefiner":true,"strict":false,"returnType":"jsonb","argumentNames":["p_auth_user_id","p_actor_profile_id","p_session_id"],"settings":["search_path=pg_catalog","statement_timeout=7s"],"acl":["postgres=X/postgres","service_role=X/postgres"]},{"identity":"public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)","beforeSha256":"d0b73946bff39427704de5ffd681c8a3005d78ce7bfe103c6c7c6c454ab7fffe","volatility":"v","securityDefiner":true,"strict":false,"returnType":"jsonb","argumentNames":["p_actor_profile_id","p_session_id","p_attempt_id","p_assignment_id","p_assignment_revision","p_target_slot_id","p_expected_collection_revision","p_items","p_idempotency_key_digest","p_request_hash"],"settings":["search_path=\"\""],"acl":["postgres=X/postgres","service_role=X/postgres"]},{"identity":"private.collect_developer_reset_template_inventory()","beforeSha256":"d58488be97b49c437ad1f279f800b273368dacd764a36ba862d7e8535c4ea936","volatility":"s","securityDefiner":true,"strict":false,"returnType":"jsonb","argumentNames":null,"settings":["search_path=pg_catalog","lock_timeout=2s"],"acl":["postgres=X/postgres"]},{"identity":"private.reset_receipt_canonical(jsonb)","beforeSha256":"23b0ebda264442c103d6ae83d9aca9bed6fa702dcf1376dc2213e2b0547a890c","volatility":"i","securityDefiner":false,"strict":true,"returnType":"text","argumentNames":["p_value"],"settings":["search_path=pg_catalog"],"acl":["postgres=X/postgres"]},{"identity":"private.validate_reset_receipt(jsonb,jsonb,jsonb,bigint)","beforeSha256":"8f0411d7f6a978f9a5a82d9d984730826d63f4084baa47af5387f838991bc545","volatility":"i","securityDefiner":false,"strict":false,"returnType":"void","argumentNames":["p_binding","p_header","p_entries","p_now"],"settings":["search_path=pg_catalog"],"acl":["postgres=X/postgres"]},{"identity":"private.normalize_assignment_instruction(text)","beforeSha256":"c9f44590d035d83c5c87562ab09725ffab3f4aa970d1f23adcc487ea6389c1e1","volatility":"i","securityDefiner":false,"strict":false,"returnType":"text","argumentNames":["p_value"],"settings":["search_path=\"\""],"acl":["postgres=X/postgres"]}]$origins$::jsonb) loop
    select p.*,r.rolname as owner_name,l.lanname as language_name into actual
      from pg_proc p join pg_roles r on r.oid=p.proowner join pg_language l on l.oid=p.prolang
      where p.oid=to_regprocedure(expected->>'identity');
    if not found then
      raise exception using errcode='55000',message='DB_LINT_CORRECTION_SOURCE_DRIFT';
    end if;
    select array_agg(a::text order by a::text) into actual_acl
      from unnest(coalesce(actual.proacl,acldefault('f',actual.proowner))) a;
    if encode(extensions.digest(replace(actual.prosrc,E'\r\n',E'\n'),'sha256'),'hex')<>expected->>'beforeSha256'
      or actual.prokind<>'f' or actual.language_name<>'plpgsql' or actual.owner_name<>'postgres'
      or actual.provolatile::text<>expected->>'volatility'
      or actual.prosecdef is distinct from (expected->>'securityDefiner')::boolean
      or actual.proisstrict is distinct from (expected->>'strict')::boolean
      or actual.prorettype<>to_regtype(expected->>'returnType')
      or to_jsonb(actual.proargnames) is distinct from nullif(expected->'argumentNames','null'::jsonb)
      or to_jsonb(actual.proconfig) is distinct from expected->'settings'
      or to_jsonb(actual_acl) is distinct from expected->'acl'
      or actual.proretset or actual.proleakproof or actual.proparallel<>'u'
      or actual.pronargdefaults<>0 or actual.proargdefaults is not null
      or actual.provariadic<>0 or actual.prosupport<>0 or actual.procost<>100 or actual.prorows<>0 then
      raise exception using errcode='55000',message='DB_LINT_CORRECTION_SOURCE_DRIFT';
    end if;
  end loop;
end
$lint_source_guard$;

-- Origin: supabase/migrations/20261025024327_developer_reset_row_impact.sql
-- Identity: public.get_developer_reset_preview(uuid,uuid,text)
create or replace function public.get_developer_reset_preview(p_auth_user_id uuid,p_actor_profile_id uuid,p_session_id text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog set statement_timeout='7s' as $$
declare context jsonb; result jsonb;
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
    if pass=1 then select private.collect_developer_reset_impact_preview() into result; end if;
  end loop;
  return result;
end
$$;

-- Origin: supabase/migrations/20261025022445_photo_collection_upload_batch.sql
-- Identity: public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)
create or replace function public.admit_photo_collection_upload_batch(
  p_actor_profile_id uuid,p_session_id uuid,p_attempt_id uuid,p_assignment_id uuid,
  p_assignment_revision bigint,p_target_slot_id uuid,p_expected_collection_revision bigint,
  p_items jsonb,p_idempotency_key_digest text,p_request_hash text
) returns jsonb language plpgsql security definer set search_path='' as $$
declare a public.cleaning_attempts; b private.photo_upload_batches; item jsonb; result jsonb:='[]'::jsonb; ad jsonb;
  idx integer:=0; capacity integer; append_count integer;
begin
  a:=private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  perform 1 from public.cleaning_attempts where id=a.id for update;
  if p_idempotency_key_digest is null or p_idempotency_key_digest !~ '^[0-9a-f]{64}$'
    or p_request_hash is null or p_request_hash !~ '^[0-9a-f]{64}$'
    or p_expected_collection_revision is null or p_expected_collection_revision not between 0 and 9007199254740988
    or jsonb_typeof(p_items) is distinct from 'array' then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  if jsonb_array_length(p_items)<>2 then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object'
      or (select count(*) from jsonb_object_keys(item))<>3
      or not (item ?& array['photoItemId','expectedItemRevision','keyDigest'])
      or jsonb_typeof(item->'photoItemId') is distinct from 'string'
      or item->>'photoItemId' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      or jsonb_typeof(item->'expectedItemRevision') is distinct from 'number'
      or item->>'expectedItemRevision' !~ '^(0|[1-9][0-9]{0,15})$'
      or (item->>'expectedItemRevision')::bigint>9007199254740990
      or jsonb_typeof(item->'keyDigest') is distinct from 'string'
      or item->>'keyDigest' !~ '^[0-9a-f]{64}$' then
      raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  end loop;
  if p_items->0->>'photoItemId'=p_items->1->>'photoItemId'
    or p_items->0->>'keyDigest'=p_items->1->>'keyDigest' then
    raise exception using errcode='23514',message='PHOTO_UPLOAD_INVALID'; end if;
  select * into b from private.photo_upload_batches
    where actor_profile_id=p_actor_profile_id and idempotency_key_digest=p_idempotency_key_digest;
  if b.id is not null and b.request_hash<>p_request_hash then
    raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
  if b.id is null then
    if exists(select 1 from private.photo_upload_admissions old
      where old.actor_profile_id=p_actor_profile_id and old.idempotency_key_digest in
        (p_items->0->>'keyDigest',p_items->1->>'keyDigest')) then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    capacity:=private.photo_slot_max_photos(p_target_slot_id,a.cleaning_target_id);
    if capacity is null or capacity<=1 then
      raise exception using errcode='23514',message='PHOTO_COLLECTION_NOT_ALLOWED'; end if;
    select count(*) into append_count from jsonb_array_elements(p_items) x
      where (x->>'expectedItemRevision')::bigint=0;
    if append_count+(select count(*) from private.attempt_photo_collection_items
      where cleaning_attempt_id=a.id and target_photo_slot_id=p_target_slot_id and active)>capacity then
      raise exception using errcode='54000',message='PHOTO_COLLECTION_LIMIT_EXCEEDED'; end if;
    insert into private.photo_upload_batches(actor_profile_id,idempotency_key_digest,request_hash)
      values(p_actor_profile_id,p_idempotency_key_digest,p_request_hash) returning * into b;
    for item in select value from jsonb_array_elements(p_items) loop
      insert into private.photo_upload_batch_members values(b.id,p_actor_profile_id,idx,item->>'keyDigest');
      idx:=idx+1;
    end loop;
  end if;
  idx:=0;
  for item in select value from jsonb_array_elements(p_items) loop
    if not exists(select 1 from private.photo_upload_batch_members where batch_id=b.id
      and item_index=idx and idempotency_key_digest=item->>'keyDigest') then
      raise exception using errcode='23505',message='IDEMPOTENCY_KEY_REUSED'; end if;
    ad:=public.admit_photo_collection_upload(p_actor_profile_id,p_session_id,p_attempt_id,p_assignment_id,
      p_assignment_revision,p_target_slot_id,(item->>'photoItemId')::uuid,p_expected_collection_revision,
      (item->>'expectedItemRevision')::bigint,item->>'keyDigest');
    result:=result||jsonb_build_array(jsonb_build_object('photoItemId',item->>'photoItemId',
      'expiresAt',ad->'expiresAt','quotaWarning',ad->'quotaWarning'));
    idx:=idx+1;
  end loop;
  perform private.assert_photo_upload_actor(p_actor_profile_id,p_session_id,p_attempt_id);
  return jsonb_build_object('batchId',b.id,'maximumConcurrentTransfers',2,'items',result);
end $$;

-- Origin: supabase/migrations/20261025031218_developer_reset_template_inventory.sql
-- Identity: private.collect_developer_reset_template_inventory()
create or replace function private.collect_developer_reset_template_inventory()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog set lock_timeout='2s' as $$
declare
  deadline timestamptz:=statement_timestamp()+interval '5 seconds';
  templates jsonb; slots jsonb; t jsonb; projection jsonb; selected_slots jsonb;
  items jsonb:='[]'::jsonb; references_found jsonb:='[]'::jsonb; ref record; ref_result jsonb;
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

-- Origin: supabase/migrations/20261025051231_developer_reset_receipt_store.sql
-- Identity: private.reset_receipt_canonical(jsonb)
create or replace function private.reset_receipt_canonical(p_value jsonb)
returns text language plpgsql immutable strict set search_path=pg_catalog as $$
declare result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{'||coalesce(string_agg((jsonb_object(array['k']::text[],array[key]::text[])->'k')::text||':'||private.reset_receipt_canonical(value),',' order by key collate "C"),'')||'}'
      into result from jsonb_each(p_value);
    when 'array' then
      select '['||coalesce(string_agg(private.reset_receipt_canonical(value),',' order by ord),'')||']'
      into result from jsonb_array_elements(p_value) with ordinality a(value,ord);
    else result := p_value::text;
  end case;
  return result;
end $$;

-- Origin: supabase/migrations/20261025051231_developer_reset_receipt_store.sql
-- Identity: private.validate_reset_receipt(jsonb,jsonb,jsonb,bigint)
create or replace function private.validate_reset_receipt(p_binding jsonb,p_header jsonb,p_entries jsonb,p_now bigint)
returns void language plpgsql immutable set search_path=pg_catalog as $$
declare k text; s jsonb; e jsonb; row_value jsonb; state jsonb := '{}'::jsonb;
  previous_hash text; last_at bigint; expires bigint; seq integer := 0; next_step text; final boolean := false;
begin
  if p_now is null or p_now<0 or p_now>8640000000000000
    or octet_length(coalesce(p_binding::text,''))>4096 or octet_length(coalesce(p_header::text,''))>32768
    or octet_length(coalesce(p_entries::text,''))>1048576
    or not private.reset_receipt_fields(p_binding,array['actorProfileId','authUserId','sessionDigest','passwordVersionDigest',
      'projectRef','sourceCommit','catalogFingerprint','contentFingerprint','planFingerprint','expectedPostconditionFingerprint',
      'policyHash','approvalScopeHash','backupProofHash'])
    or not private.reset_receipt_fields(p_header,array['format','commandHash','bindingHash','idempotencyKeyDigest',
      'expectedPostconditionFingerprint','createdAt','expiresAt','steps']) then
    raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
  end if;
  for k in select jsonb_object_keys(p_binding) loop
    if jsonb_typeof(p_binding->k) is distinct from 'string' or (case
      when k in ('actorProfileId','authUserId') then p_binding->>k ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      when k='projectRef' then p_binding->>k ~ '^[a-z]{20}$'
      when k='sourceCommit' then p_binding->>k ~ '^[a-f0-9]{40}$'
      else p_binding->>k ~ '^[a-f0-9]{64}$' end) is not true then
      raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
    end if;
  end loop;
  if p_header->>'format' is distinct from 'reset-receipt-v1'
    or jsonb_typeof(p_header->'createdAt') is distinct from 'number' or (p_header->>'createdAt' ~ '^(0|[1-9][0-9]{0,15})$') is not true
    or jsonb_typeof(p_header->'expiresAt') is distinct from 'number' or (p_header->>'expiresAt' ~ '^(0|[1-9][0-9]{0,15})$') is not true
    or jsonb_typeof(p_header->'steps') is distinct from 'array' or jsonb_typeof(p_entries) is distinct from 'array' then
    raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
  end if;
  last_at := (p_header->>'createdAt')::bigint; expires := (p_header->>'expiresAt')::bigint;
  if last_at>p_now or expires<=last_at or expires>8640000000000000
    or jsonb_array_length(p_header->'steps') not between 1 and 100 or jsonb_array_length(p_entries)>1000 then
    raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
  end if;
  foreach k in array array['commandHash','bindingHash','idempotencyKeyDigest','expectedPostconditionFingerprint'] loop
    if jsonb_typeof(p_header->k) is distinct from 'string' or (p_header->>k ~ '^[a-f0-9]{64}$') is not true then
      raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
    end if;
  end loop;
  if p_header->>'bindingHash' is distinct from private.reset_receipt_hash(p_binding)
    or p_header->>'expectedPostconditionFingerprint' is distinct from p_binding->>'expectedPostconditionFingerprint'
    or p_header->>'commandHash' is distinct from private.reset_receipt_hash(p_header-array['format','commandHash']) then
    raise exception using errcode='22023',message='RESET_RECEIPT_BINDING_CHANGED';
  end if;
  for s in select value from jsonb_array_elements(p_header->'steps') loop
    if not private.reset_receipt_fields(s,array['id','kind']) or jsonb_typeof(s->'id') is distinct from 'string'
      or (s->>'id' ~ '^[a-f0-9]{64}$') is not true or (s->>'kind' in ('DATABASE','AUTH','EXTERNAL')) is not true
      or state ? (s->>'id') then
      raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
    end if;
    state := state||jsonb_object(array[s->>'id']::text[],array['PENDING']::text[]);
  end loop;
  previous_hash := private.reset_receipt_hash(p_header);
  for row_value in select value from jsonb_array_elements(p_entries) loop
    seq := seq+1;
    if not private.reset_receipt_fields(row_value,array['sequence','at','previousHash','event','hash'])
      or jsonb_typeof(row_value->'sequence') is distinct from 'number' or row_value->>'sequence' is distinct from seq::text
      or jsonb_typeof(row_value->'at') is distinct from 'number' or (row_value->>'at' ~ '^(0|[1-9][0-9]{0,15})$') is not true
      or jsonb_typeof(row_value->'previousHash') is distinct from 'string' or jsonb_typeof(row_value->'hash') is distinct from 'string'
      or row_value->>'previousHash' is distinct from previous_hash
      or row_value->>'hash' is distinct from private.reset_receipt_hash(row_value-'hash') or final then
      raise exception using errcode='22023',message='RESET_RECEIPT_CHAIN_INVALID';
    end if;
    if (row_value->>'at')::bigint<last_at or (row_value->>'at')::bigint>p_now then
      raise exception using errcode='22023',message='RESET_RECEIPT_TIME_INVALID';
    end if;
    last_at := (row_value->>'at')::bigint; e := row_value->'event';
    if e->>'type'='STARTED' then
      select value->>'id' into next_step from jsonb_array_elements(p_header->'steps') with ordinality a(value,ord)
        where state->>(value->>'id')<>'APPLIED' order by ord limit 1;
      if not private.reset_receipt_fields(e,array['type','stepId','bindingHash']) or e->>'stepId' is distinct from next_step
        or jsonb_typeof(e->'stepId') is distinct from 'string' or jsonb_typeof(e->'bindingHash') is distinct from 'string'
        or state->>(e->>'stepId') is distinct from 'PENDING' or last_at>=expires
        or e->>'bindingHash' is distinct from p_header->>'bindingHash' then
        raise exception using errcode='22023',message='RESET_RECEIPT_STEP_REJECTED';
      end if;
      state := state||jsonb_object(array[e->>'stepId']::text[],array['STARTED']::text[]);
    elsif e->>'type'='OBSERVED' then
      if not private.reset_receipt_fields(e,array['type','stepId','outcome','evidenceHash'])
        or jsonb_typeof(e->'stepId') is distinct from 'string'
        or (state->>(e->>'stepId') in ('STARTED','UNKNOWN')) is not true
        or (e->>'outcome' in ('APPLIED','NOT_APPLIED','UNKNOWN')) is not true
        or (case when e->>'outcome'='UNKNOWN' then e->'evidenceHash'='null'::jsonb
          else jsonb_typeof(e->'evidenceHash')='string' and e->>'evidenceHash' ~ '^[a-f0-9]{64}$' end) is not true then
        raise exception using errcode='22023',message='RESET_RECEIPT_OBSERVATION_REJECTED';
      end if;
      state := state||jsonb_object(array[e->>'stepId']::text[],array[e->>'outcome']::text[]);
    elsif e->>'type'='FINAL_VERIFIED' then
      if not private.reset_receipt_fields(e,array['type','postconditionFingerprint','evidenceHash','remoteQuiescent'])
        or exists(select 1 from jsonb_each_text(state) where value<>'APPLIED')
        or e->>'postconditionFingerprint' is distinct from p_header->>'expectedPostconditionFingerprint'
        or jsonb_typeof(e->'postconditionFingerprint') is distinct from 'string'
        or jsonb_typeof(e->'evidenceHash') is distinct from 'string' or (e->>'evidenceHash' ~ '^[a-f0-9]{64}$') is not true
        or e->'remoteQuiescent' is distinct from 'true'::jsonb then
        raise exception using errcode='22023',message='RESET_RECEIPT_FINAL_REJECTED';
      end if;
      final := true;
    else raise exception using errcode='22023',message='RESET_RECEIPT_INPUT_INVALID';
    end if;
    previous_hash := row_value->>'hash';
  end loop;
end $$;

-- Origin: supabase/migrations/20261030143048_assignment_instruction_memo.sql
-- Identity: private.normalize_assignment_instruction(text)
create or replace function private.normalize_assignment_instruction(p_value text)
returns text language plpgsql immutable set search_path='' as $$
declare normalized text; units integer;
begin
  if p_value is null then return null; end if;
  units:=char_length(p_value);
  if units>500 then
    raise exception using errcode='22023',message='ASSIGNMENT_INSTRUCTION_INVALID';
  end if;
  -- JavaScript/JSON maxLength is explicitly constrained to 500 UTF-16 units.
  for i in 1..char_length(p_value) loop
    if ascii(substr(p_value,i,1))>65535 then units:=units+1; end if;
  end loop;
  if units>500 then
    raise exception using errcode='22023',message='ASSIGNMENT_INSTRUCTION_INVALID';
  end if;
  -- Exactly ECMAScript String.trim's WhiteSpace + LineTerminator set.
  normalized:=nullif(btrim(p_value,
    U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),'');
  if normalized is not null and (
    normalized ~ $email$[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$email$
    or normalized ~* $url$https?://|www\.$url$
    or normalized ~ $phone$(^|[^0-9])(01[016789]|\+82[ -]?1[016789])[ -]?[0-9]{3,4}[ -]?[0-9]{4}([^0-9]|$)$phone$
    or normalized ~* $pin$(PIN|비밀번호|출입코드)([ \t\r\n]*[:=][ \t\r\n]*|[ \t\r\n]+)[0-9]{4,}$pin$
  ) then
    raise exception using errcode='22023',message='ASSIGNMENT_INSTRUCTION_INVALID';
  end if;
  return normalized;
end $$;
