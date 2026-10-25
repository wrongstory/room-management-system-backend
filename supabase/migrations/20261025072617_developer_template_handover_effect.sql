-- #396 S1. Prepared effect source only: NO EXECUTE grant, route, activation or seed.
-- Existing history/content/author/foreign references stay unchanged. The only old
-- template transition is the normal published -> retired transition.
create function private.reset_template_handover_rows()
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set timezone='UTC' set datestyle='ISO, MDY' as $$
declare templates jsonb; slots jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('id',t.id::text,'room_type_id',t.room_type_id::text,
    'cleaning_kind',t.cleaning_kind::text,'version',t.version::text,'status',t.status,
    'duration_minutes',t.duration_minutes::text,'photo_slots',t.photo_slots::text,
    'published_at',t.published_at::text,'created_by',t.created_by::text,'created_at',t.created_at::text)
    order by t.id),'[]'::jsonb) into templates
    from (select * from only public.cleaning_template_versions order by id limit 10001) t;
  select coalesce(jsonb_agg(jsonb_build_object('id',s.id::text,'template_version_id',s.template_version_id::text,
    'slot_key',s.slot_key,'display_order',s.display_order::text,'required',s.required::text,'slot_snapshot',s.slot_snapshot::text)
    order by s.id),'[]'::jsonb) into slots
    from (select * from only private.photo_template_slots order by id limit 10001) s;
  if jsonb_array_length(templates)>10000 or jsonb_array_length(slots)>10000 then
    raise exception using errcode='54000',message='RESET_TEMPLATE_HANDOVER_LIMIT';
  end if;
  return jsonb_build_object('templates',templates,'slots',slots);
end $$;

create function private.assert_reset_template_handover_rows(p_payload jsonb,p_after boolean,p_registered_at timestamptz default null)
returns void language plpgsql volatile security definer set search_path=pg_catalog
set timezone='UTC' set datestyle='ISO, MDY' as $$
declare actual jsonb; old_rows jsonb; expected_old jsonb; item jsonb; t public.cleaning_template_versions;
  previous public.cleaning_template_versions; rt public.room_types; n bigint; max_version bigint; normalized jsonb;
begin
  actual:=private.reset_template_handover_rows();
  if not p_after then
    if actual->'templates' is distinct from p_payload->'oldTemplates' or actual->'slots' is distinct from p_payload->'oldSlots' then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_SOURCE_CHANGED';
    end if;
    if (select count(*) from public.cleaning_template_versions where status='published')<>jsonb_array_length(p_payload->'templates') then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_SELECTION_CHANGED';
    end if;
  else
    select coalesce(jsonb_agg(value order by value->>'id'),'[]') into old_rows from jsonb_array_elements(actual->'templates')
      where value->>'id' in (select value->>'id' from jsonb_array_elements(p_payload->'oldTemplates'));
    select coalesce(jsonb_agg(case when value->>'id' in
      (select value->>'sourceId' from jsonb_array_elements(p_payload->'templates')) then value||'{"status":"retired"}'::jsonb else value end
      order by value->>'id'),'[]') into expected_old from jsonb_array_elements(p_payload->'oldTemplates');
    if old_rows is distinct from expected_old or jsonb_array_length(actual->'templates')<>
      jsonb_array_length(p_payload->'oldTemplates')+jsonb_array_length(p_payload->'templates') then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_PRESERVATION_CHANGED';
    end if;
    select coalesce(jsonb_agg(value order by value->>'id'),'[]') into old_rows from jsonb_array_elements(actual->'slots')
      where value->>'id' in (select value->>'id' from jsonb_array_elements(p_payload->'oldSlots'));
    if old_rows is distinct from p_payload->'oldSlots' or exists(select 1 from jsonb_array_elements(actual->'slots') s
      where s->>'id' not in (select value->>'id' from jsonb_array_elements(p_payload->'oldSlots'))
      and s->>'template_version_id' not in (select value->>'newId' from jsonb_array_elements(p_payload->'templates'))) then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_PRESERVATION_CHANGED';
    end if;
  end if;
  for item in select value from jsonb_array_elements(p_payload->'templates') loop
    if not private.reset_receipt_fields(item,array['sourceId','newId','version','maximumVersion','expectedCurrentVersion','plannedAt','createdBy','reason','content'])
      or not private.reset_receipt_fields(item->'content',array['roomTypeId','cleaningKind','durationMinutes','slots'])
      or jsonb_typeof(item->'sourceId') is distinct from 'string' or jsonb_typeof(item->'newId') is distinct from 'string'
      or jsonb_typeof(item->'createdBy') is distinct from 'string' or jsonb_typeof(item->'plannedAt') is distinct from 'string'
      or item#>>'{content,cleaningKind}' is distinct from 'checkout'
      or item->>'reason' is distinct from 'OPERATIONAL_HANDOVER_INITIALIZATION'
      or jsonb_typeof(item->'version') is distinct from 'number' or (item->>'version' ~ '^[1-9][0-9]{0,9}$') is not true
      or jsonb_typeof(item->'maximumVersion') is distinct from 'number' or (item->>'maximumVersion' ~ '^[1-9][0-9]{0,9}$') is not true
      or jsonb_typeof(item->'expectedCurrentVersion') is distinct from 'number' or (item->>'expectedCurrentVersion' ~ '^[1-9][0-9]{0,9}$') is not true then
      raise exception using errcode='22023',message='RESET_TEMPLATE_HANDOVER_INPUT_INVALID';
    end if;
    select * into previous from public.cleaning_template_versions where id=(item->>'sourceId')::uuid;
    select * into rt from public.room_types where id=previous.room_type_id for share;
    if previous.id is null or rt.id is null or previous.status<>(case when p_after then 'retired' else 'published' end)
      or previous.version is distinct from (item->>'expectedCurrentVersion')::integer
      or previous.room_type_id::text is distinct from item#>>'{content,roomTypeId}'
      or previous.cleaning_kind::text<>'checkout'
      or to_jsonb(previous.duration_minutes) is distinct from nullif(item#>'{content,durationMinutes}','null'::jsonb)
      -- Preserve PostgreSQL jsonb text too: numeric 1.0/1 equality must not
      -- create a new row that fails the retained audit's exact content check.
      or previous.photo_slots::text is distinct from (item#>'{content,slots}')::text
      or (item->>'plannedAt')::timestamptz<=previous.created_at or (item->>'plannedAt')::timestamptz>clock_timestamp()
      or (item->>'newId')::uuid in (select (value->>'id')::uuid from jsonb_array_elements(p_payload->'oldTemplates')) then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_SOURCE_CHANGED';
    end if;
    normalized:=private.normalized_checkout_template_slots(item#>'{content,slots}');
    if normalized is distinct from previous.photo_slots or exists(select 1 from jsonb_array_elements(normalized) s where not (s ? 'maxPhotos'))
      or not private.photo_snapshot_valid(jsonb_build_object('templateVersionId',item->>'newId','version',(item->>'version')::integer,
        'roomTypeCode',rt.code,'cleaningKind','checkout','slots',normalized)) then
      raise exception using errcode='23514',message='RESET_TEMPLATE_HANDOVER_SHAPE_INVALID';
    end if;
    if not p_after then
      select max(version)::bigint into max_version from public.cleaning_template_versions where room_type_id=previous.room_type_id and cleaning_kind='checkout';
      if max_version>=2147483647 or max_version is distinct from (item->>'maximumVersion')::bigint
        or (item->>'version')::integer<>greatest(max_version+1,case when normalized=private.flat_cleaning_photo_slots() then 9 else 8 end) then
        raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_VERSION_CHANGED';
      end if;
    else
      select * into t from public.cleaning_template_versions where id=(item->>'newId')::uuid;
      if t.id is null or t.room_type_id<>previous.room_type_id or t.cleaning_kind<>'checkout' or t.status<>'published'
        or t.version<>(item->>'version')::integer or t.created_by<>(item->>'createdBy')::uuid
        or p_registered_at is null or t.created_at is distinct from p_registered_at
        or t.created_at<(item->>'plannedAt')::timestamptz or t.published_at is null or t.published_at<t.created_at
        or t.duration_minutes is distinct from previous.duration_minutes or t.photo_slots::text is distinct from previous.photo_slots::text then
        raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_READBACK_CHANGED';
      end if;
      select count(*) into n from private.photo_template_slots where template_version_id=t.id;
      if n<>jsonb_array_length(t.photo_slots) or exists(
        (select jsonb_build_object('slot_key',value->>'slotKey','display_order',(value->>'displayOrder')::integer,
          'required',(value->>'required')::boolean,'slot_snapshot',value) from jsonb_array_elements(t.photo_slots)) except
        (select jsonb_build_object('slot_key',slot_key,'display_order',display_order,'required',required,'slot_snapshot',slot_snapshot)
          from private.photo_template_slots where template_version_id=t.id)) then
        raise exception using errcode='23514',message='RESET_TEMPLATE_HANDOVER_SLOT_READBACK_CHANGED';
      end if;
    end if;
  end loop;
end $$;

create function private.assert_reset_template_handover_audit(p_payload jsonb,p_header jsonb,p_actor uuid,p_registration_at timestamptz)
returns void language plpgsql volatile security definer set search_path=pg_catalog
set timezone='UTC' set datestyle='ISO, MDY' as $$
declare item jsonb; a public.audit_events; expected jsonb; payload_hash text:=private.reset_receipt_hash(p_payload);
begin
  for item in select value from jsonb_array_elements(p_payload->'templates') loop
    select * into a from public.audit_events where idempotency_key='reset-template-handover:'||(p_header->>'commandHash')||':'||(item->>'newId');
    expected:=jsonb_build_object('sourceTemplateVersionId',item->>'sourceId','newTemplateVersionId',item->>'newId',
      'plannedAt',item->>'plannedAt','registrationTime',to_char(p_registration_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'version',item->'version','policyFingerprint',p_payload->>'policyFingerprint',
      'commandHash',p_header->>'commandHash','payloadHash',payload_hash);
    if a.id is null or a.actor_profile_id is distinct from p_actor or a.actor_display_name_snapshot is not null
      or a.event_type<>'cleaning_template.operational_handover' or a.entity_type<>'cleaning_template_version'
      or a.entity_id is distinct from (item->>'newId')::uuid or a.effective_at is distinct from p_registration_at
      or a.reason_code is distinct from 'OPERATIONAL_HANDOVER_INITIALIZATION' or a.before_state is not null
      or a.after_state is distinct from expected or a.request_id is not null
      or a.request_hash is distinct from payload_hash
      or a.recorded_at<p_registration_at or a.created_at<p_registration_at then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_AUDIT_CHANGED';
    end if;
  end loop;
end $$;

create function public.apply_developer_template_handover(p_mode text,p_actor uuid,p_auth uuid,p_session text,p_nonce text,
  p_binding jsonb,p_header jsonb,p_payload jsonb,p_expected_version integer,p_expected_head text)
returns jsonb language plpgsql volatile security definer set search_path=pg_catalog
set timezone='UTC' set datestyle='ISO, MDY' set lock_timeout='2s' set statement_timeout='7s' as $$
declare control private.developer_operation_control; challenge private.developer_operation_reauth;
  head private.developer_reset_receipt_heads; events jsonb; journal jsonb; item jsonb; entry jsonb;
  payload_hash text; postcondition_hash text; evidence_hash text; step_id text; now_ms bigint; count_templates integer;
  registration_at timestamptz; registration_time text; audit_at timestamptz;
  deadline timestamptz:=clock_timestamp()+interval '5 seconds';
begin
  perform private.assert_reset_receipt_identity(p_actor,p_auth,p_session,p_binding);
  now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  perform private.validate_reset_receipt(p_binding,p_header,'[]',now_ms);
  if (p_mode in ('PRECHECK','APPLY','READ')) is not true or p_expected_version is null or p_expected_version not between 0 and 2
    or p_expected_head is null or p_expected_head !~ '^[a-f0-9]{64}$'
    or octet_length(coalesce(p_payload::text,''))>4194304
    or not private.reset_receipt_fields(p_payload,array['format','policyFingerprint','projectRef','sourceCommit','catalogFingerprint',
      'reviewedPlanFingerprint','contentFingerprint','challengeId','controlVersion','oldTemplates','oldSlots','templates'])
    or p_payload->>'format' is distinct from 'reset-template-effect-v1'
    or p_payload->>'policyFingerprint' is distinct from '7b5392d7d15af95a81ddac3d8a903e496a477e5b37c93ada5664dfabca59f84a'
    or p_payload->>'projectRef' is distinct from p_binding->>'projectRef'
    or p_payload->>'sourceCommit' is distinct from p_binding->>'sourceCommit'
    or p_payload->>'catalogFingerprint' is distinct from p_binding->>'catalogFingerprint'
    or p_payload->>'contentFingerprint' is distinct from p_binding->>'contentFingerprint'
    or p_payload->>'reviewedPlanFingerprint' is distinct from p_binding->>'planFingerprint'
    or jsonb_typeof(p_payload->'controlVersion') is distinct from 'string' or (p_payload->>'controlVersion' ~ '^[1-9][0-9]{0,18}$') is not true
    or jsonb_typeof(p_payload->'challengeId') is distinct from 'string'
    or jsonb_typeof(p_payload->'oldTemplates') is distinct from 'array' or jsonb_typeof(p_payload->'oldSlots') is distinct from 'array'
    or jsonb_typeof(p_payload->'templates') is distinct from 'array' then
    raise exception using errcode='22023',message='RESET_TEMPLATE_HANDOVER_INPUT_INVALID';
  end if;
  count_templates:=jsonb_array_length(p_payload->'templates');
  if count_templates not between 1 and 1000 or jsonb_array_length(p_payload->'oldTemplates')>10000 or jsonb_array_length(p_payload->'oldSlots')>10000
    or (select count(distinct value->>'sourceId') from jsonb_array_elements(p_payload->'templates'))<>count_templates
    or (select count(distinct value->>'newId') from jsonb_array_elements(p_payload->'templates'))<>count_templates
    or exists(select 1 from jsonb_array_elements(p_payload->'templates') where value->>'createdBy' is distinct from p_actor::text) then
    raise exception using errcode='22023',message='RESET_TEMPLATE_HANDOVER_INPUT_INVALID';
  end if;
  payload_hash:=private.reset_receipt_hash(p_payload);
  postcondition_hash:=private.reset_receipt_hash(jsonb_build_object('domain','reset-template-handover-postcondition-v1','payloadHash',payload_hash,
    'count',count_templates,'registrationTime','DATABASE_CLOCK_AFTER_STARTED_BEFORE_OBSERVED'));
  step_id:='fa08fa290aa9dd42dde4539d4c0da985b1c29a5dcbb49d7e4a570f9abea3ae16';
  if p_header->'steps' is distinct from jsonb_build_array(jsonb_build_object('id',step_id,'kind','DATABASE'))
    or p_binding->>'expectedPostconditionFingerprint' is distinct from postcondition_hash then
    raise exception using errcode='22023',message='RESET_TEMPLATE_HANDOVER_COMMAND_CHANGED';
  end if;
  -- Lock the existing control before any target or journal lock, like admission.
  select * into control from private.developer_operation_control where singleton for update;
  if control.singleton is null or control.target_ref is distinct from p_binding->>'projectRef'
    or control.policy_hash is distinct from p_binding->>'policyHash' or control.lifecycle<>'PROVISIONING'
    or control.maintenance<>'REQUESTED' or control.version is distinct from (p_payload->>'controlVersion')::bigint
    or control.reauth_ttl_seconds<>300 then
    raise exception using errcode='42501',message='RESET_TEMPLATE_HANDOVER_CONTROL_REJECTED';
  end if;
  lock table public.cleaning_template_versions,private.photo_template_slots in share row exclusive mode;
  if p_mode='READ' then
    journal:=public.store_developer_reset_receipt('READ',p_actor,p_auth,p_session,p_binding,p_header,p_expected_version,p_expected_head,null);
    events:=journal#>'{receipt,events}';
    select created_at into registration_at from public.cleaning_template_versions where id=(p_payload#>>'{templates,0,newId}')::uuid;
    registration_time:=to_char(registration_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
    evidence_hash:=private.reset_receipt_hash(jsonb_build_object('domain','reset-template-handover-applied-v1',
      'postconditionHash',postcondition_hash,'registrationTime',registration_time));
    if jsonb_array_length(events)<>2 or events#>>'{1,event,type}' is distinct from 'OBSERVED'
      or events#>>'{1,event,outcome}' is distinct from 'APPLIED' or events#>>'{1,event,stepId}' is distinct from step_id
      or events#>>'{1,event,evidenceHash}' is distinct from evidence_hash or registration_at is null
      or registration_at<>date_trunc('milliseconds',registration_at)
      or extract(epoch from registration_at)*1000<(events#>>'{0,at}')::bigint
      or extract(epoch from registration_at)*1000>(events#>>'{1,at}')::bigint then
      raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_NOT_OBSERVED';
    end if;
    perform private.assert_reset_template_handover_rows(p_payload,true,registration_at);
    perform private.assert_reset_template_handover_audit(p_payload,p_header,p_actor,registration_at);
  else
    if now_ms>=(p_header->>'expiresAt')::bigint or exists(select 1 from private.developer_operation_admissions where completed_at is null)
      or exists(select 1 from private.password_change_commands where state in ('auth_pending','inconsistent','reset_pending'))
      or exists(select 1 from private.password_reset_auth_markers where state='prepared') then
      raise exception using errcode='42501',message='RESET_TEMPLATE_HANDOVER_NOT_DRAINED';
    end if;
    select * into challenge from private.developer_operation_reauth where id=(p_payload->>'challengeId')::uuid for update;
    if challenge.id is null or challenge.state<>'READY' or challenge.action<>'RESET_REVIEW'
      or challenge.actor_profile_id is distinct from p_actor or challenge.auth_user_id is distinct from p_auth
      or challenge.session_digest is distinct from private.operation_secret_digest(p_session)
      or p_nonce is null or p_nonce !~ '^[a-f0-9]{64}$' or challenge.nonce_hash is distinct from private.operation_secret_digest(p_nonce)
      or challenge.password_version is distinct from public.get_auth_password_version(p_auth)
      or challenge.target_ref is distinct from control.target_ref or challenge.policy_hash is distinct from control.policy_hash
      or challenge.control_version<>control.version or challenge.expires_at<=clock_timestamp()
      or challenge.expires_at>challenge.created_at+interval '300 seconds'
      or challenge.verified_at is null or challenge.verified_at<challenge.created_at or challenge.verified_at>clock_timestamp()
      or exists(select 1 from auth.sessions where user_id=p_auth and private.operation_secret_digest(id::text)=challenge.probe_session_digest) then
      raise exception using errcode='42501',message='RESET_TEMPLATE_HANDOVER_REAUTH_REJECTED';
    end if;
    perform private.assert_reset_template_handover_rows(p_payload,false);
    if p_mode='PRECHECK' then
      if p_expected_version<>0 or p_expected_head<>private.reset_receipt_hash(p_header)
        or exists(select 1 from private.developer_reset_receipt_heads where actor_profile_id=p_actor
          and project_ref=p_binding->>'projectRef' and key_digest=p_header->>'idempotencyKeyDigest') then
        raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_ALREADY_STARTED';
      end if;
    else
      -- The only allowed post-review writes are this exact genesis/STARTED
      -- receipt. Do not ignore whole control, receipt or security relations.
      select * into head from private.developer_reset_receipt_heads where actor_profile_id=p_actor
        and project_ref=p_binding->>'projectRef' and key_digest=p_header->>'idempotencyKeyDigest' for update;
      if head.id is null or head.binding is distinct from p_binding or head.header is distinct from p_header
        or head.version<>1 or p_expected_version<>1 or head.head_hash is distinct from p_expected_head then
        raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_RECEIPT_CHANGED';
      end if;
      journal:=public.store_developer_reset_receipt('READ',p_actor,p_auth,p_session,p_binding,p_header,1,p_expected_head,null);
      events:=journal#>'{receipt,events}';
      if jsonb_array_length(events)<>1 or events#>>'{0,event,type}' is distinct from 'STARTED'
        or events#>>'{0,event,stepId}' is distinct from step_id then
        raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_RECEIPT_CHANGED';
      end if;
      -- One actual database registration time for this atomic S1 effect. The
      -- review's plannedAt is intent only and is never written as created_at.
      registration_at:=date_trunc('milliseconds',clock_timestamp());
      if extract(epoch from registration_at)*1000<(events#>>'{0,at}')::bigint then
        raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_CLOCK_REJECTED'; end if;
      registration_time:=to_char(registration_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
      evidence_hash:=private.reset_receipt_hash(jsonb_build_object('domain','reset-template-handover-applied-v1',
        'postconditionHash',postcondition_hash,'registrationTime',registration_time));
      for item in select value from jsonb_array_elements(p_payload->'templates') order by value->>'sourceId' loop
        if clock_timestamp()>=deadline then raise exception using errcode='57014',message='RESET_TEMPLATE_HANDOVER_TIMEOUT'; end if;
        insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by,created_at)
          values((item->>'newId')::uuid,(item#>>'{content,roomTypeId}')::uuid,'checkout',(item->>'version')::integer,'draft',
            (item#>>'{content,durationMinutes}')::integer,item#>'{content,slots}',p_actor,registration_at);
        -- Draft content and present contract are checked before publishing. All
        -- changes are one transaction; no partially registered draft survives.
        if not exists(select 1 from public.cleaning_template_versions t where t.id=(item->>'newId')::uuid and t.status='draft'
          and t.photo_slots=item#>'{content,slots}' and t.created_by=p_actor and t.created_at=registration_at) then
          raise exception using errcode='23514',message='RESET_TEMPLATE_HANDOVER_DRAFT_CHANGED';
        end if;
        update public.cleaning_template_versions set status='retired'
          where id=(item->>'sourceId')::uuid and status='published' and version=(item->>'expectedCurrentVersion')::integer;
        if not found then raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_VERSION_CHANGED'; end if;
        update public.cleaning_template_versions set status='published',published_at=clock_timestamp() where id=(item->>'newId')::uuid and status='draft';
        if not found then raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_DRAFT_CHANGED'; end if;
        -- Fixed, append-only provenance. No template/photo payload, name or PIN.
        -- A pre-existing matching idempotency row is not a new registration audit.
        if exists(select 1 from public.audit_events where idempotency_key='reset-template-handover:'||(p_header->>'commandHash')||':'||(item->>'newId')) then
          raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_AUDIT_CHANGED'; end if;
        audit_at:=clock_timestamp();
        insert into public.audit_events(actor_profile_id,event_type,entity_type,entity_id,effective_at,recorded_at,created_at,
          reason_code,after_state,idempotency_key,request_hash)
        values(p_actor,'cleaning_template.operational_handover','cleaning_template_version',(item->>'newId')::uuid,
          registration_at,audit_at,audit_at,'OPERATIONAL_HANDOVER_INITIALIZATION',
          jsonb_build_object('sourceTemplateVersionId',item->>'sourceId','newTemplateVersionId',item->>'newId',
            'plannedAt',item->>'plannedAt','registrationTime',registration_time,'version',item->'version',
            'policyFingerprint',p_payload->>'policyFingerprint','commandHash',p_header->>'commandHash','payloadHash',payload_hash),
          'reset-template-handover:'||(p_header->>'commandHash')||':'||(item->>'newId'),payload_hash);
      end loop;
      perform private.assert_reset_template_handover_rows(p_payload,true,registration_at);
      perform private.assert_reset_template_handover_audit(p_payload,p_header,p_actor,registration_at);
      update private.developer_operation_reauth set state='CONSUMED',consumed_at=clock_timestamp() where id=challenge.id and state='READY';
      if not found then raise exception using errcode='40001',message='RESET_TEMPLATE_HANDOVER_REAUTH_REJECTED'; end if;
      now_ms:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
      entry:=jsonb_build_object('sequence',2,'at',now_ms,'previousHash',head.head_hash,
        'event',jsonb_build_object('type','OBSERVED','stepId',step_id,'outcome','APPLIED','evidenceHash',evidence_hash));
      entry:=entry||jsonb_build_object('hash',private.reset_receipt_hash(entry));
      journal:=public.store_developer_reset_receipt('APPEND',p_actor,p_auth,p_session,p_binding,p_header,1,head.head_hash,entry);
    end if;
  end if;
  perform private.assert_reset_receipt_identity(p_actor,p_auth,p_session,p_binding);
  if p_mode<>'READ' and (clock_timestamp()>=challenge.expires_at
    or floor(extract(epoch from clock_timestamp())*1000)::bigint>=(p_header->>'expiresAt')::bigint) then
    raise exception using errcode='42501',message='RESET_TEMPLATE_HANDOVER_REAUTH_REJECTED';
  end if;
  if clock_timestamp()>=deadline then raise exception using errcode='57014',message='RESET_TEMPLATE_HANDOVER_TIMEOUT'; end if;
  return jsonb_build_object('format','reset-template-effect-result-v1','status',case when p_mode='PRECHECK' then 'PRECHECKED' else 'APPLIED' end,
    'payloadHash',payload_hash,'evidenceHash',case when p_mode='PRECHECK' then null else evidence_hash end,
    'registrationTime',registration_time,'count',count_templates,
    'receipt',case when p_mode='PRECHECK' then null else journal->'receipt' end,'executionEnabled',false);
end $$;

alter function private.reset_template_handover_rows() owner to postgres;
alter function private.assert_reset_template_handover_rows(jsonb,boolean,timestamptz) owner to postgres;
alter function private.assert_reset_template_handover_audit(jsonb,jsonb,uuid,timestamptz) owner to postgres;
alter function public.apply_developer_template_handover(text,uuid,uuid,text,text,jsonb,jsonb,jsonb,integer,text) owner to postgres;
revoke all on function private.reset_template_handover_rows(),private.assert_reset_template_handover_rows(jsonb,boolean,timestamptz),
  private.assert_reset_template_handover_audit(jsonb,jsonb,uuid,timestamptz)
  from public,anon,authenticated,service_role;
revoke all on function public.apply_developer_template_handover(text,uuid,uuid,text,text,jsonb,jsonb,jsonb,integer,text)
  from public,anon,authenticated,service_role;
-- Intentionally no GRANT. D01 recovery/coverage/owner approval/target activation
-- are NOT proven by a service key, a supplied hash, or this prepared migration.

-- Preserve only exact handover audit rows; prior migration135 remains frozen.
create or replace function private.developer_reset_disposition_expression(p_relation text,p_alias text)
returns text language sql immutable security definer set search_path=pg_catalog as $$
  select case when p_alias in ('r','s','t') then replace(expression,'{alias}',p_alias) end
  from (values
    ('auth.users','case (select p.role::text from public.profiles p where p.auth_user_id={alias}.id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.actor_activity_aggregates','''preserve''::text'),
    ('private.actor_activity_events','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.actor_authorization_denial_aggregates','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.assignment_activation_scan_cursor','''resetCandidate''::text'),
    ('private.assignment_unavailability_cancellations','''resetCandidate''::text'),
    ('private.attempt_capability_grants','''resetCandidate''::text'),
    ('private.attempt_capability_revocations','''resetCandidate''::text'),
    ('private.attempt_capability_session_roots','''resetCandidate''::text'),
    ('private.attempt_handover_events','''resetCandidate''::text'),
    ('private.attempt_photo_changes','''photoHold''::text'),
    ('private.attempt_photo_collection_changes','''photoHold''::text'),
    ('private.attempt_photo_collection_items','''photoHold''::text'),
    ('private.attempt_photo_collection_states','''photoHold''::text'),
    ('private.attempt_photo_current','''photoHold''::text'),
    ('private.attempt_photo_purge_states','''photoHold''::text'),
    ('private.attempt_photo_versions','''photoHold''::text'),
    ('private.attempt_room_issue_reports','''photoHold''::text'),
    ('private.auth_password_versions','case (select p.role::text from public.profiles p where p.auth_user_id={alias}.auth_user_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.bomb_room_decisions','''photoHold''::text'),
    ('private.bomb_room_report_evidence','''photoHold''::text'),
    ('private.bomb_room_report_seals','''photoHold''::text'),
    ('private.bomb_room_reports','''photoHold''::text'),
    ('private.cleaning_overdue_events','''resetCandidate''::text'),
    ('private.cleaning_overdue_recipients','''resetCandidate''::text'),
    ('private.cleaning_overdue_scan_cursor','''resetCandidate''::text'),
    ('private.command_executions','''resetCandidate''::text'),
    ('private.complaint_response_attention_events','''resetCandidate''::text'),
    ('private.complaint_response_attention_recipients','''resetCandidate''::text'),
    ('private.complaint_response_attention_scan_cursor','''resetCandidate''::text'),
    ('private.developer_catalog_previews','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.developer_diagnostic_rate_limits','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.developer_operation_admissions','''preserve''::text'),
    ('private.developer_operation_control','''preserve''::text'),
    ('private.developer_operation_events','''preserve''::text'),
    ('private.developer_operation_reauth','''preserve''::text'),
    ('private.developer_reset_receipt_events','''preserve''::text'),
    ('private.developer_reset_receipt_heads','''preserve''::text'),
    ('private.flat_evidence_migration_receipts','''photoHold''::text'),
    ('private.limited_session_eligibility','''resetCandidate''::text'),
    ('private.limited_session_roots','''resetCandidate''::text'),
    ('private.login_rate_limit_windows','''preserve''::text'),
    ('private.notification_delivery_attempt_results','''resetCandidate''::text'),
    ('private.notification_delivery_attempts','''resetCandidate''::text'),
    ('private.notification_delivery_events','''resetCandidate''::text'),
    ('private.notification_delivery_heartbeat','''resetCandidate''::text'),
    ('private.notification_delivery_jobs','''resetCandidate''::text'),
    ('private.notification_delivery_outbox','''resetCandidate''::text'),
    ('private.notification_delivery_permits','''resetCandidate''::text'),
    ('private.notification_delivery_targets','''resetCandidate''::text'),
    ('private.notification_event_catalog','''preserve''::text'),
    ('private.notification_groups','''resetCandidate''::text'),
    ('private.notification_outbox','''resetCandidate''::text'),
    ('private.offline_completion_events','''resetCandidate''::text'),
    ('private.offline_event_resolutions','''resetCandidate''::text'),
    ('private.offline_work_lease_revocations','''resetCandidate''::text'),
    ('private.offline_work_leases','''resetCandidate''::text'),
    ('private.password_change_commands','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.password_reset_auth_markers','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.password_verification_rate_limits','case (select p.role::text from public.profiles p where p.id={alias}.actor_profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('private.payroll_payment_projection_transitions','''resetCandidate''::text'),
    ('private.payroll_remittance_marker_revisions','''resetCandidate''::text'),
    ('private.payroll_remittance_markers','''resetCandidate''::text'),
    ('private.photo_cleanup_events','''photoHold''::text'),
    ('private.photo_collection_commands','''photoHold''::text'),
    ('private.photo_drive_folder_bindings','''photoHold''::text'),
    ('private.photo_drive_folder_identities','''photoHold''::text'),
    ('private.photo_drive_identities','''photoHold''::text'),
    ('private.photo_folder_purge_jobs','''photoHold''::text'),
    ('private.photo_orphan_purge_jobs','''photoHold''::text'),
    ('private.photo_provider_identity_tombstones','''photoHold''::text'),
    ('private.photo_provider_objects','''photoHold''::text'),
    ('private.photo_purge_heartbeat','''photoHold''::text'),
    ('private.photo_purge_jobs','''photoHold''::text'),
    ('private.photo_quota_pending','''photoHold''::text'),
    ('private.photo_retention_links','''photoHold''::text'),
    ('private.photo_retention_records','''photoHold''::text'),
    ('private.photo_storage_names','''photoHold''::text'),
    ('private.photo_storage_quota_snapshot','''photoHold''::text'),
    ('private.photo_template_slots','''templateSource''::text'),
    ('private.photo_upload_acceptances','''photoHold''::text'),
    ('private.photo_upload_admission_bindings','''photoHold''::text'),
    ('private.photo_upload_admission_limits','''photoHold''::text'),
    ('private.photo_upload_admissions','''photoHold''::text'),
    ('private.photo_upload_batch_members','''photoHold''::text'),
    ('private.photo_upload_batches','''photoHold''::text'),
    ('private.photo_upload_events','''photoHold''::text'),
    ('private.photo_upload_operations','''photoHold''::text'),
    ('private.photo_upload_rate_limits','''photoHold''::text'),
    ('private.photo_upload_states','''photoHold''::text'),
    ('private.post_approval_issue_collections','''photoHold''::text'),
    ('private.post_approval_issue_delete_barriers','''photoHold''::text'),
    ('private.post_approval_issue_evidence_acceptances','''photoHold''::text'),
    ('private.post_approval_issue_evidence_items','''photoHold''::text'),
    ('private.post_approval_issue_folder_bindings','''photoHold''::text'),
    ('private.post_approval_issue_identity_tombstones','''photoHold''::text'),
    ('private.post_approval_issue_provider_objects','''photoHold''::text'),
    ('private.post_approval_issue_purge_jobs','''photoHold''::text'),
    ('private.post_approval_issue_purge_scan','''photoHold''::text'),
    ('private.post_approval_issue_quota_pending','''photoHold''::text'),
    ('private.post_approval_issue_quota_permit_uses','''photoHold''::text'),
    ('private.post_approval_issue_quota_permits','''photoHold''::text'),
    ('private.post_approval_issue_quota_refreshes','''photoHold''::text'),
    ('private.post_approval_issue_report_closures','''photoHold''::text'),
    ('private.post_approval_issue_report_seals','''photoHold''::text'),
    ('private.post_approval_issue_upload_admissions','''photoHold''::text'),
    ('private.post_approval_issue_upload_events','''photoHold''::text'),
    ('private.post_approval_issue_upload_handovers','''photoHold''::text'),
    ('private.post_approval_issue_upload_operations','''photoHold''::text'),
    ('private.post_approval_issue_upload_states','''photoHold''::text'),
    ('private.post_approval_room_issue_draft_revisions','''photoHold''::text'),
    ('private.post_approval_room_issue_drafts','''photoHold''::text'),
    ('private.post_approval_room_issue_reports','''photoHold''::text'),
    ('private.preparation_proof_usages','''resetCandidate''::text'),
    ('private.reservation_room_move_events','''resetCandidate''::text'),
    ('private.reservation_stays','''resetCandidate''::text'),
    ('private.room_current_pin','''resetCandidate''::text'),
    ('private.room_display_status_overrides','''resetCandidate''::text'),
    ('private.room_occupancy_corrections','''resetCandidate''::text'),
    ('private.room_pin_access_scheduled_revocations','''resetCandidate''::text'),
    ('private.room_pin_assignment_entitlements','''resetCandidate''::text'),
    ('private.room_pin_change_leases','''resetCandidate''::text'),
    ('private.room_pin_nonce_reservations','''preserve''::text'),
    ('private.room_pin_reveal_leases','''resetCandidate''::text'),
    ('private.room_pin_revisions','''resetCandidate''::text'),
    ('private.room_pin_sheet_full_resync_items','''resetCandidate''::text'),
    ('private.room_pin_sheet_full_resync_runs','''resetCandidate''::text'),
    ('private.room_pin_sheet_sync_heartbeat','''resetCandidate''::text'),
    ('private.room_pin_sheet_sync_outbox','''resetCandidate''::text'),
    ('private.room_pin_sheet_sync_worker_state','''resetCandidate''::text'),
    ('private.scheduler_invocation_heartbeats','''resetCandidate''::text'),
    ('private.stay_room_segments','''resetCandidate''::text'),
    ('private.stay_segment_checkout_obligations','''resetCandidate''::text'),
    ('private.submission_current_pointers','''photoHold''::text'),
    ('private.submission_photo_binding_sets','''photoHold''::text'),
    ('private.submission_photo_bindings','''photoHold''::text'),
    ('private.target_photo_slot_snapshots','''photoHold''::text'),
    ('private.target_photo_snapshot_contracts','''photoHold''::text'),
    ('private.web_push_registration_limits','''resetCandidate''::text'),
    ('private.web_push_subscription_events','''resetCandidate''::text'),
    ('private.web_push_subscription_revisions','''resetCandidate''::text'),
    ('private.web_push_subscription_secrets','''resetCandidate''::text'),
    ('private.web_push_subscriptions','''resetCandidate''::text'),
    ('public.assignment_change_requests','''resetCandidate''::text'),
    ('public.assignment_duration_policy_versions','''resetCandidate''::text'),
    ('public.audit_events','case when {alias}.event_type=''cleaning_template.operational_handover'' then ''preserve'' else ''resetCandidate'' end'),
    ('public.availability_change_requests','''resetCandidate''::text'),
    ('public.availability_days','''resetCandidate''::text'),
    ('public.availability_versions','''resetCandidate''::text'),
    ('public.checkout_cleaning_obligations','''resetCandidate''::text'),
    ('public.checkout_presence_incident_decisions','''resetCandidate''::text'),
    ('public.checkout_presence_incidents','''resetCandidate''::text'),
    ('public.cleaning_assignments','''resetCandidate''::text'),
    ('public.cleaning_attempts','''resetCandidate''::text'),
    ('public.cleaning_submissions','''resetCandidate''::text'),
    ('public.cleaning_target_schedule_revisions','''resetCandidate''::text'),
    ('public.cleaning_targets','''resetCandidate''::text'),
    ('public.cleaning_template_versions','''templateSource''::text'),
    ('public.compensation_entitlements','''resetCandidate''::text'),
    ('public.complaint_case_events','''resetCandidate''::text'),
    ('public.complaint_cases','''resetCandidate''::text'),
    ('public.complaint_compensation_decisions','''resetCandidate''::text'),
    ('public.complaint_decisions','''resetCandidate''::text'),
    ('public.complaint_maid_responses','''resetCandidate''::text'),
    ('public.earnings','''resetCandidate''::text'),
    ('public.inspection_decisions','''resetCandidate''::text'),
    ('public.login_aliases','case (select p.role::text from public.profiles p where p.id={alias}.profile_id) when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('public.notifications','''resetCandidate''::text'),
    ('public.payroll_adjustment_books','''resetCandidate''::text'),
    ('public.payroll_adjustment_items','''resetCandidate''::text'),
    ('public.payroll_adjustments','''resetCandidate''::text'),
    ('public.payroll_carry_items','''resetCandidate''::text'),
    ('public.payroll_cycles','''resetCandidate''::text'),
    ('public.payroll_events','''resetCandidate''::text'),
    ('public.payroll_items','''resetCandidate''::text'),
    ('public.payroll_offset_settlements','''resetCandidate''::text'),
    ('public.payroll_payment_attempts','''resetCandidate''::text'),
    ('public.payroll_payment_results','''resetCandidate''::text'),
    ('public.payroll_residual_carries','''resetCandidate''::text'),
    ('public.preparation_obligations','''resetCandidate''::text'),
    ('public.profiles','case {alias}.role::text when ''developer'' then ''preserve'' when ''admin'' then ''resetCandidate'' when ''maid'' then ''resetCandidate'' else ''unresolved'' end'),
    ('public.reservation_schedule_revisions','''resetCandidate''::text'),
    ('public.reservations','''resetCandidate''::text'),
    ('public.room_candle_events','''resetCandidate''::text'),
    ('public.room_issues','''resetCandidate''::text'),
    ('public.room_occupancy_events','''resetCandidate''::text'),
    ('public.room_operation_blocks','''resetCandidate''::text'),
    ('public.room_pin_access_leases','''resetCandidate''::text'),
    ('public.room_pin_sync_events','''resetCandidate''::text'),
    ('public.room_types','''preserve''::text'),
    ('public.rooms','''roomBaseline''::text'),
    ('public.submission_photos','''photoHold''::text')
  ) rules(relation,expression) where relation=p_relation
$$;
alter function private.developer_reset_disposition_expression(text,text) owner to postgres;
revoke all on function private.developer_reset_disposition_expression(text,text) from public,anon,authenticated,service_role;

create or replace function private.collect_developer_reset_row_impact()
returns jsonb language plpgsql stable security definer set search_path=pg_catalog
set lock_timeout='2s' as $$
declare
  r record; k record; shape record; result jsonb; auth_boundary jsonb;
  items jsonb := '[]'::jsonb; references_found jsonb := '[]'::jsonb;
  policy text; source_policy text; target_policy text;
  unsupported_references integer := 0; expected_references integer;
  deadline timestamptz := clock_timestamp()+interval '5 seconds';
begin
  if (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private') and c.relkind in ('r','p','f')) > 1000 then
    raise exception using errcode='54000',message='RESET_PREVIEW_LIMIT_EXCEEDED';
  end if;
  for r in select c.oid,n.nspname,c.relname,c.relkind,c.relispartition
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','private') and c.relkind in ('r','p','f')
    order by n.nspname,c.relname
  loop
    if clock_timestamp()>=deadline then
      raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT';
    end if;
    policy := private.developer_reset_disposition_expression(r.nspname||'.'||r.relname,'r');
    result := null;
    if policy is not null and r.relkind='r' and not r.relispartition then
      execute format($query$
        with bounded as materialized(select * from only %I.%I limit 10001),
          classified as materialized(select %s as disposition from bounded r)
        select jsonb_build_object('rowCount',count(*),'counts',jsonb_build_object(
          'preserve',count(*) filter(where disposition='preserve'),
          'roomBaseline',count(*) filter(where disposition='roomBaseline'),
          'resetCandidate',count(*) filter(where disposition='resetCandidate'),
          'templateSource',count(*) filter(where disposition='templateSource'),
          'photoHold',count(*) filter(where disposition='photoHold'),
          'unresolved',count(*) filter(where disposition='unresolved')))
        from classified
      $query$,r.nspname,r.relname,policy) into result;
    end if;
    items := items||jsonb_build_array(jsonb_build_object('relation',r.nspname||'.'||r.relname,
      'rowCount',result->'rowCount','counts',result->'counts'));
  end loop;
  select count(*) into expected_references from pg_constraint c
    join pg_class s on s.oid=c.conrelid join pg_namespace sn on sn.oid=s.relnamespace
    join pg_class t on t.oid=c.confrelid join pg_namespace tn on tn.oid=t.relnamespace
    where c.contype='f' and (sn.nspname in ('public','private') or tn.nspname in ('public','private'));
  if expected_references>10000 then
    raise exception using errcode='54000',message='RESET_PREVIEW_LIMIT_EXCEEDED';
  end if;
  -- Account inventory selects IDs only, including unlinked Auth accounts that
  -- cannot inherit an admin/maid deletion candidate from a missing profile.
  with bounded as materialized(select id from only auth.users limit 10001)
  select jsonb_build_object('rowCount',count(*),
    'independentCount',(select count(*) from (select id from only auth.users limit 10001) census),
    'preserve',count(*) filter(where p.role::text='developer'),
    'resetCandidate',count(*) filter(where p.role::text in ('admin','maid')),
    'unresolved',count(*) filter(where p.role is null or p.role::text not in ('developer','admin','maid')))
  into auth_boundary from bounded u left join public.profiles p on p.auth_user_id=u.id;
  for k in select c.*,s.relkind source_kind,s.relispartition source_partition,
    t.relkind target_kind,t.relispartition target_partition,
    sn.nspname source_schema,s.relname source_name,tn.nspname target_schema,t.relname target_name,
    i.indisvalid,i.indisunique,i.indimmediate,i.indpred,i.indexprs
    from pg_constraint c
    join pg_class s on s.oid=c.conrelid join pg_namespace sn on sn.oid=s.relnamespace
    join pg_class t on t.oid=c.confrelid join pg_namespace tn on tn.oid=t.relnamespace
    join pg_index i on i.indexrelid=c.conindid
    where c.contype='f' and (sn.nspname in ('public','private') or tn.nspname in ('public','private'))
    order by sn.nspname,s.relname,c.conname
  loop
    if clock_timestamp()>=deadline then
      raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT';
    end if;
    source_policy := private.developer_reset_disposition_expression(k.source_schema||'.'||k.source_name,'s');
    target_policy := private.developer_reset_disposition_expression(k.target_schema||'.'||k.target_name,'t');
    -- auth.users is the only readable FK boundary and only as an ID lookup target.
    -- No Auth password, row serialization, hash or credential-derived proof exists.
    if source_policy is null or target_policy is null or k.source_schema not in ('public','private')
      or (k.target_schema not in ('public','private') and not (k.target_schema='auth' and k.target_name='users'))
      or k.source_kind<>'r' or k.target_kind<>'r' or k.source_partition or k.target_partition
      or not k.convalidated or k.confmatchtype not in ('s','f')
      or not k.indisvalid or not k.indisunique or not k.indimmediate
      or k.indpred is not null or k.indexprs is not null then
      unsupported_references := unsupported_references+1; continue;
    end if;
    select count(*) arity,
      bool_and(opn.nspname='pg_catalog' and op.oprname='='
        and a.atttypid=op.oprright and b.atttypid=op.oprleft
        and a.attcollation=b.attcollation) supported,
      string_agg(format('t.%I OPERATOR(pg_catalog.=) s.%I',b.attname,a.attname),' and ' order by x.ord) equality,
      string_agg(format('s.%I is null',a.attname),' or ' order by x.ord) any_null,
      string_agg(format('s.%I is null',a.attname),' and ' order by x.ord) all_null,
      (array_agg(b.attname order by x.ord))[1] target_column
    into shape
    from unnest(k.conkey,k.confkey,k.conpfeqop) with ordinality x(source_column,target_column,operator_id,ord)
    join pg_attribute a on a.attrelid=k.conrelid and a.attnum=x.source_column and not a.attisdropped
    join pg_attribute b on b.attrelid=k.confrelid and b.attnum=x.target_column and not b.attisdropped
    join pg_operator op on op.oid=x.operator_id join pg_namespace opn on opn.oid=op.oprnamespace;
    if shape.arity<>cardinality(k.conkey) or shape.supported is distinct from true then
      unsupported_references := unsupported_references+1; continue;
    end if;
    execute format($query$
      with bounded as materialized(select * from only %I.%I limit 10001),
      joined as materialized(select (%s) source_disposition,(%s) target_disposition,
        (%s) any_null,(%s) all_null,t.%I is not null matched
        from bounded s left join only %I.%I t on %s)
      select jsonb_build_object('sourceRows',count(*),
        'nullEdges',count(*) filter(where any_null),
        'partialNulls',count(*) filter(where %L='f' and any_null and not all_null),
        'missingTargets',count(*) filter(where not any_null and not matched),
        'preservedToRemoved',count(*) filter(where not any_null and matched
          and source_disposition in ('preserve','roomBaseline','photoHold')
          and target_disposition in ('resetCandidate','templateSource')),
        'unresolvedTargets',count(*) filter(where not any_null and matched and target_disposition='unresolved'))
      from joined
    $query$,k.source_schema,k.source_name,source_policy,target_policy,shape.any_null,shape.all_null,
      shape.target_column,k.target_schema,k.target_name,shape.equality,k.confmatchtype::text) into result;
    references_found := references_found||jsonb_build_array(jsonb_build_object(
      'source',k.source_schema||'.'||k.source_name,'constraint',k.conname,'impact',result));
  end loop;
  if clock_timestamp()>=deadline then
    raise exception using errcode='57014',message='RESET_PREVIEW_TIMEOUT';
  end if;
  return jsonb_build_object('format','reset-row-impact-v1','ruleFingerprint','a8ecfda5bff059aac9d10736ea0ce3560f53e02258c2a2f89238680f9c7a7cb8',
    'snapshotId',encode(extensions.digest(pg_current_snapshot()::text||statement_timestamp()::text,'sha256'),'hex'),
    'relations',items,'authBoundary',auth_boundary,'expectedForeignKeys',expected_references,
    'unsupportedForeignKeys',unsupported_references,'foreignKeys',references_found);
end
$$;
alter function private.collect_developer_reset_row_impact() owner to postgres;
revoke all on function private.collect_developer_reset_row_impact() from public,anon,authenticated,service_role;
