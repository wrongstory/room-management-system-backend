-- #558: rollback-only source replacement regression. Actual PostgreSQL execution requires approval.
begin;
select no_plan();

-- The source test binds this literal to the reviewed six identities and nine edits.
create temp table lint_sources as
select c.value as contract,p.oid,p.prosrc as corrected_body,pg_get_functiondef(p.oid) as corrected_definition,
  to_jsonb(p)-'prosrc' as metadata
from jsonb_array_elements($contracts$[{"identity":"public.get_developer_reset_preview(uuid,uuid,text)","originPath":"supabase/migrations/20261025024327_developer_reset_row_impact.sql","beforeSha256":"9eaf597ac996a24b565116853dbc5d84e497d357c80260144ba7bd66f97a9110","afterSha256":"642a8dffcebba66adf8191e3f53051245506ceb104ef911890c34ced3673d6d7","volatility":"v","securityDefiner":true,"strict":false,"returnType":"jsonb","argumentNames":["p_auth_user_id","p_actor_profile_id","p_session_id"],"settings":["search_path=pg_catalog","statement_timeout=7s"],"acl":["postgres=X/postgres","service_role=X/postgres"],"edits":[{"id":"remove_shadowed_pass","before":"declare context jsonb; result jsonb; pass integer;","after":"declare context jsonb; result jsonb;","occurrences":1,"observedWarningsTargeted":2}]},{"identity":"public.admit_photo_collection_upload_batch(uuid,uuid,uuid,uuid,bigint,uuid,bigint,jsonb,text,text)","originPath":"supabase/migrations/20261025022445_photo_collection_upload_batch.sql","beforeSha256":"d0b73946bff39427704de5ffd681c8a3005d78ce7bfe103c6c7c6c454ab7fffe","afterSha256":"bf965406076dd80eab77d516831f70bc372aa94674e8045eb2ea5c10d7549aed","volatility":"v","securityDefiner":true,"strict":false,"returnType":"jsonb","argumentNames":["p_actor_profile_id","p_session_id","p_attempt_id","p_assignment_id","p_assignment_revision","p_target_slot_id","p_expected_collection_revision","p_items","p_idempotency_key_digest","p_request_hash"],"settings":["search_path=\"\""],"acl":["postgres=X/postgres","service_role=X/postgres"],"edits":[{"id":"explicit_empty_result_jsonb","before":"result jsonb:='[]';","after":"result jsonb:='[]'::jsonb;","occurrences":1,"observedWarningsTargeted":1}]},{"identity":"private.collect_developer_reset_template_inventory()","originPath":"supabase/migrations/20261025031218_developer_reset_template_inventory.sql","beforeSha256":"d58488be97b49c437ad1f279f800b273368dacd764a36ba862d7e8535c4ea936","afterSha256":"6370c825c1c6eb8b528fba5f4e6801c1c2f8c4768e78dd5b7de566c36cb0699d","volatility":"s","securityDefiner":true,"strict":false,"returnType":"jsonb","argumentNames":null,"settings":["search_path=pg_catalog","lock_timeout=2s"],"acl":["postgres=X/postgres"],"edits":[{"id":"explicit_empty_items_jsonb","before":"items jsonb:='[]';","after":"items jsonb:='[]'::jsonb;","occurrences":1,"observedWarningsTargeted":1},{"id":"explicit_empty_references_jsonb","before":"references_found jsonb:='[]';","after":"references_found jsonb:='[]'::jsonb;","occurrences":1,"observedWarningsTargeted":1}]},{"identity":"private.reset_receipt_canonical(jsonb)","originPath":"supabase/migrations/20261025051231_developer_reset_receipt_store.sql","beforeSha256":"23b0ebda264442c103d6ae83d9aca9bed6fa702dcf1376dc2213e2b0547a890c","afterSha256":"d5d0fa59f7d26fa82430f16c4d50068fa82ae646ccbb48a36185c9a08e694ea7","volatility":"i","securityDefiner":false,"strict":true,"returnType":"text","argumentNames":["p_value"],"settings":["search_path=pg_catalog"],"acl":["postgres=X/postgres"],"edits":[{"id":"immutable_text_json_string","before":"to_jsonb(key)::text","after":"(jsonb_object(array['k']::text[],array[key]::text[])->'k')::text","occurrences":1,"observedWarningsTargeted":1}]},{"identity":"private.validate_reset_receipt(jsonb,jsonb,jsonb,bigint)","originPath":"supabase/migrations/20261025051231_developer_reset_receipt_store.sql","beforeSha256":"8f0411d7f6a978f9a5a82d9d984730826d63f4084baa47af5387f838991bc545","afterSha256":"9844d306b50d756b19b4fbf80e26763667017d656454069cdf99fa4ac0386af6","volatility":"i","securityDefiner":false,"strict":false,"returnType":"void","argumentNames":["p_binding","p_header","p_entries","p_now"],"settings":["search_path=pg_catalog"],"acl":["postgres=X/postgres"],"edits":[{"id":"immutable_pending_text_state","before":"jsonb_build_object(s->>'id','PENDING')","after":"jsonb_object(array[s->>'id']::text[],array['PENDING']::text[])","occurrences":1,"observedWarningsTargeted":1},{"id":"immutable_started_text_state","before":"jsonb_build_object(e->>'stepId','STARTED')","after":"jsonb_object(array[e->>'stepId']::text[],array['STARTED']::text[])","occurrences":1,"observedWarningsTargeted":1},{"id":"immutable_observed_text_state","before":"jsonb_build_object(e->>'stepId',e->>'outcome')","after":"jsonb_object(array[e->>'stepId']::text[],array[e->>'outcome']::text[])","occurrences":1,"observedWarningsTargeted":1}]},{"identity":"private.normalize_assignment_instruction(text)","originPath":"supabase/migrations/20261030143048_assignment_instruction_memo.sql","beforeSha256":"c9f44590d035d83c5c87562ab09725ffab3f4aa970d1f23adcc487ea6389c1e1","afterSha256":"3510754a80d970c8a329ebfcb2745699231eae5b08b11e4c60759d16612b0fd8","volatility":"i","securityDefiner":false,"strict":false,"returnType":"text","argumentNames":["p_value"],"settings":["search_path=\"\""],"acl":["postgres=X/postgres"],"edits":[{"id":"remove_shadowed_i","before":"declare normalized text; units integer; i integer;","after":"declare normalized text; units integer;","occurrences":1,"observedWarningsTargeted":2}]}]$contracts$::jsonb) c
join pg_proc p on p.oid=to_regprocedure(c.value->>'identity');
select is((select count(*) from lint_sources),6::bigint,'all six correction identities exist');
select is(encode(extensions.digest(replace(corrected_body,E'\r\n',E'\n'),'sha256'),'hex'),
  contract->>'afterSha256','installed corrected source is exact: '||(contract->>'identity')) from lint_sources;

create function pg_temp.check_lint_origins() returns void language plpgsql as $lint_source_guard$
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

create function pg_temp.restore_lint_definitions(original boolean) returns void language plpgsql as $$
declare entry record; patch jsonb; body text; expected_hash text;
begin
  for entry in select * from lint_sources order by oid loop
    body:=replace(entry.corrected_body,E'\r\n',E'\n');
    if original then
      for patch in select value from jsonb_array_elements(entry.contract->'edits') with ordinality p(value,ord) order by ord desc loop
        if (length(body)-length(replace(body,patch->>'after','')))/length(patch->>'after')<>1 then
          raise exception 'LINT_FIXTURE_SOURCE_DRIFT';
        end if;
        body:=replace(body,patch->>'after',patch->>'before');
      end loop;
    end if;
    expected_hash:=entry.contract->>(case when original then 'beforeSha256' else 'afterSha256' end);
    if encode(extensions.digest(body,'sha256'),'hex')<>expected_hash
      or (length(entry.corrected_definition)-length(replace(entry.corrected_definition,entry.corrected_body,'')))/length(entry.corrected_body)<>1 then
      raise exception 'LINT_FIXTURE_SOURCE_DRIFT';
    end if;
    execute replace(entry.corrected_definition,entry.corrected_body,body);
  end loop;
end $$;

select throws_ok('select pg_temp.check_lint_origins()','55000','DB_LINT_CORRECTION_SOURCE_DRIFT',
  'already corrected bodies are not silently accepted as original migration inputs');
select lives_ok('select pg_temp.restore_lint_definitions(true)','restore exact old source in this transaction');
select lives_ok('select pg_temp.check_lint_origins()','all six exact original source and metadata contracts pass');
select is(to_jsonb(p)-'prosrc',s.metadata,'old source restoration preserves every pg_proc attribute and OID: '||(s.contract->>'identity'))
  from lint_sources s join pg_proc p on p.oid=s.oid;

create temp table lint_golden(value jsonb);
insert into lint_golden values($golden${"binding":{"actorProfileId":"11111111-1111-4111-8111-111111111111","authUserId":"22222222-2222-4222-8222-222222222222","sessionDigest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","passwordVersionDigest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","projectRef":"aaaaaaaaaaaaaaaaaaaa","sourceCommit":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","catalogFingerprint":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","contentFingerprint":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","planFingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","expectedPostconditionFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","policyHash":"1111111111111111111111111111111111111111111111111111111111111111","approvalScopeHash":"2222222222222222222222222222222222222222222222222222222222222222","backupProofHash":"3333333333333333333333333333333333333333333333333333333333333333"},"header":{"format":"reset-receipt-v1","commandHash":"8e922c58ff1a78b68d407e2a9d6ca5e4278828f26e283b57a923eafe20d27bb1","bindingHash":"4d574c965997cf895bd2a490c68b62e740491683ebfbad8bc7beb38781ad300d","idempotencyKeyDigest":"4444444444444444444444444444444444444444444444444444444444444444","expectedPostconditionFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","createdAt":1000,"expiresAt":2000,"steps":[{"id":"5555555555555555555555555555555555555555555555555555555555555555","kind":"DATABASE"}]},"events":[{"sequence":1,"at":1100,"previousHash":"5e13e280f43c42e2304801850f13a5fe3c7d13c106bbe3b1c4a1ec5a597886d1","event":{"type":"STARTED","stepId":"5555555555555555555555555555555555555555555555555555555555555555","bindingHash":"4d574c965997cf895bd2a490c68b62e740491683ebfbad8bc7beb38781ad300d"},"hash":"0dcb7f99a38f77b1537782a6821c4d81770bcce43c451b277b38a56844489f90"},{"sequence":2,"at":1200,"previousHash":"0dcb7f99a38f77b1537782a6821c4d81770bcce43c451b277b38a56844489f90","event":{"type":"OBSERVED","stepId":"5555555555555555555555555555555555555555555555555555555555555555","outcome":"APPLIED","evidenceHash":"6666666666666666666666666666666666666666666666666666666666666666"},"hash":"9d76983a8f1df8544bc09d8ae0a228f6e851eee4878ded2f40066a0c3de51cd0"},{"sequence":3,"at":1300,"previousHash":"9d76983a8f1df8544bc09d8ae0a228f6e851eee4878ded2f40066a0c3de51cd0","event":{"type":"FINAL_VERIFIED","postconditionFingerprint":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","evidenceHash":"7777777777777777777777777777777777777777777777777777777777777777","remoteQuiescent":true},"hash":"356efb80f352d1ed739e1475388ee8dd728bc7ce38c55444211be1c0c22cd7b8"}],"headerHash":"5e13e280f43c42e2304801850f13a5fe3c7d13c106bbe3b1c4a1ec5a597886d1"}$golden$::jsonb);
select is(private.reset_receipt_hash(value->'binding'),value#>>'{header,bindingHash}','old binding matches fixed Node hash') from lint_golden;
select is(private.reset_receipt_hash(value->'header'),value->>'headerHash','old header matches fixed Node hash') from lint_golden;
select lives_ok(format('select private.validate_reset_receipt(%L::jsonb,%L::jsonb,%L::jsonb,1500)',
  value->'binding',value->'header',value->'events'),'old validator accepts the fixed STARTED/OBSERVED/FINAL_VERIFIED chain') from lint_golden;

create temp table lint_json_values(id integer primary key,value jsonb);
insert into lint_json_values values
  (1,'{}'),(2,'[]'),(3,'null'),(4,'"null"'),(5,'123'),(6,'"123"'),
  (7,$json${"quote\"":"slash\\","line\n":"tab\t","한글":"😀","é":"e","Z":"upper","a":"lower"}$json$),
  (8,$json${"0":"zero","01":"leading","a":[true,false,null,1,1.0,-0.0,"01",{},[]]}$json$),
  (9,$json${"nested":{"🧹":{"\b\f\r":"escaped"}},"empty":""}$json$);
create temp table lint_original_json as
  select id,private.reset_receipt_canonical(value) as canonical,private.reset_receipt_hash(value) as hash from lint_json_values;
select ok(private.reset_receipt_canonical(null::jsonb) is null,'old STRICT canonical preserves SQL NULL');

-- Deliberately drift a body only inside this rollback transaction, then require the exact guard to reject it.
do $drift$
declare entry record;
begin
  select * into strict entry from lint_sources where contract->>'identity'='public.get_developer_reset_preview(uuid,uuid,text)';
  execute replace(pg_get_functiondef(entry.oid),(select prosrc from pg_proc where oid=entry.oid),
    (select prosrc from pg_proc where oid=entry.oid)||E'\n-- injected source drift');
end $drift$;
select throws_ok('select pg_temp.check_lint_origins()','55000','DB_LINT_CORRECTION_SOURCE_DRIFT','unexpected original body is rejected');
select lives_ok('select pg_temp.restore_lint_definitions(true)','restore original bodies after rejection');
select lives_ok('select pg_temp.restore_lint_definitions(false)','apply exact reviewed replacement bodies without dropping identities');
select is(to_jsonb(p)-'prosrc',s.metadata,'replacement preserves every pg_proc attribute and OID: '||(s.contract->>'identity'))
  from lint_sources s join pg_proc p on p.oid=s.oid;
select is(encode(extensions.digest(replace(p.prosrc,E'\r\n',E'\n'),'sha256'),'hex'),
  s.contract->>'afterSha256','replacement body matches reviewed hash: '||(s.contract->>'identity'))
  from lint_sources s join pg_proc p on p.oid=s.oid;

select is(private.reset_receipt_canonical(v.value),o.canonical,'old/new canonical bytes agree for vector '||v.id)
  from lint_json_values v join lint_original_json o using(id);
select is(private.reset_receipt_hash(v.value),o.hash,'old/new canonical hash agrees for vector '||v.id)
  from lint_json_values v join lint_original_json o using(id);
select ok(private.reset_receipt_canonical(null::jsonb) is null,'new STRICT canonical preserves SQL NULL');
select isnt(private.reset_receipt_canonical('"123"'::jsonb),private.reset_receipt_canonical('123'::jsonb),'text and number remain distinct');
select is(private.reset_receipt_hash(value->'binding'),value#>>'{header,bindingHash}','new binding matches fixed Node hash') from lint_golden;
select is(private.reset_receipt_hash(value->'header'),value->>'headerHash','new header matches fixed Node hash') from lint_golden;
select is(private.reset_receipt_hash(e.value-'hash'),e.value->>'hash','new event matches fixed Node hash '||(e.value->>'sequence'))
  from lint_golden g cross join lateral jsonb_array_elements(g.value->'events') e;
select lives_ok(format('select private.validate_reset_receipt(%L::jsonb,%L::jsonb,%L::jsonb,1500)',
  value->'binding',value->'header',value->'events'),'new validator accepts the same fixed state chain') from lint_golden;
select throws_ok(format('select private.validate_reset_receipt(%L::jsonb,%L::jsonb,%L::jsonb,1500)',
  value->'binding',value->'header',jsonb_set(value->'events','{1,event,outcome}','null')),
  '22023','RESET_RECEIPT_CHAIN_INVALID','JSON null outcome cannot pass the immutable chain') from lint_golden;

select is(private.normalize_assignment_instruction('  note  '),'note','memo trim behavior remains');
select ok(private.normalize_assignment_instruction(null) is null,'NULL memo remains a clear');
select is(private.normalize_assignment_instruction(repeat('😀',250)),repeat('😀',250),'500 UTF-16 units remain accepted');
select throws_ok($q$select private.normalize_assignment_instruction(repeat('😀',251))$q$,'22023','ASSIGNMENT_INSTRUCTION_INVALID','UTF-16 overrun remains rejected');

-- Check actual snapshot identity coherence in one SELECT; this is not a concurrent-row race proof.
with collected as materialized(select private.collect_developer_reset_inventory() as inventory,
  private.collect_developer_reset_row_impact() as impact,private.collect_developer_reset_template_inventory() as templates,
  encode(extensions.digest(pg_current_snapshot()::text||statement_timestamp()::text,'sha256'),'hex') as expected_snapshot)
select unnest(array[
  is(inventory->>'snapshotId',expected_snapshot,'inventory binds the non-null outer statement snapshot digest'),
  is(impact->>'snapshotId',expected_snapshot,'impact binds the non-null outer statement snapshot digest'),
  is(templates->>'snapshotId',expected_snapshot,'templates bind the non-null outer statement snapshot digest'),
  is(inventory->>'snapshotId',impact->>'snapshotId','inventory and impact share the calling statement snapshot'),
  is(inventory->>'snapshotId',templates->>'snapshotId','template inventory shares the calling statement snapshot')]) from collected;

-- Inject an already expired deadline to exercise the existing fail-closed branch without a five-second sleep.
-- This proves branch behavior, not hard cancellation of a running SQL query or measured wall-clock latency.
create function pg_temp.expired_lint_collector(identity text) returns boolean language plpgsql as $$
declare original text; body text; expired text; rejected boolean:=false;
begin
  if identity not in ('private.collect_developer_reset_inventory()',
    'private.collect_developer_reset_row_impact()','private.collect_developer_reset_template_inventory()') then
    raise exception 'LINT_FIXTURE_IDENTITY_REJECTED';
  end if;
  select pg_get_functiondef(oid),prosrc into strict original,body from pg_proc where oid=to_regprocedure(identity);
  if (length(body)-length(replace(body,'interval ''5 seconds''','')))/length('interval ''5 seconds''')<>1 then
    raise exception 'LINT_FIXTURE_SOURCE_DRIFT';
  end if;
  expired:=replace(body,'interval ''5 seconds''','interval ''-1 seconds''');
  execute replace(original,body,expired);
  begin
    execute 'select '||identity;
  exception when query_canceled then
    rejected:=sqlerrm='RESET_PREVIEW_TIMEOUT';
  end;
  execute original;
  return rejected;
end $$;
select ok(pg_temp.expired_lint_collector('private.collect_developer_reset_inventory()'),'inventory rejects an expired wall-clock deadline');
select ok(pg_temp.expired_lint_collector('private.collect_developer_reset_row_impact()'),'impact rejects an expired wall-clock deadline');
select ok(pg_temp.expired_lint_collector('private.collect_developer_reset_template_inventory()'),'templates reject an expired wall-clock deadline');
select is(to_jsonb(p)-'prosrc',s.metadata,'deadline probes preserve metadata: '||(s.contract->>'identity'))
  from lint_sources s join pg_proc p on p.oid=s.oid;
select is(p.prosrc,s.corrected_body,'all six corrected bodies restored exactly: '||(s.contract->>'identity'))
  from lint_sources s join pg_proc p on p.oid=s.oid;
select * from finish();
rollback;
