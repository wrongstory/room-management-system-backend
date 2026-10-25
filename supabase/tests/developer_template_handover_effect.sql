-- #396 PREPARED, NOT RUN. Entire fixture is synthetic and rolled back.
begin;
select no_plan();
create function pg_temp.s1_id(n integer) returns uuid language sql immutable as $$
  select ('f3961360-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid
$$;
insert into auth.users(id) values(pg_temp.s1_id(1));
set local role service_role;
select public.bootstrap_first_developer_profile(pg_temp.s1_id(11),pg_temp.s1_id(1),
  's1-developer','s1-developer','0136','s1-test-phone','s1-test-bootstrap');
reset role;
insert into auth.sessions(id,user_id,created_at,not_after) values(pg_temp.s1_id(21),pg_temp.s1_id(1),clock_timestamp(),null);
insert into public.room_types(id,code,name,base_cleaning_fee,default_duration_minutes,default_guest_count,max_guest_count)
  values(pg_temp.s1_id(31),'standard','Synthetic S1',1,30,2,2);
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by,created_at,published_at)
  values(pg_temp.s1_id(41),pg_temp.s1_id(31),'checkout',9,'published',null,private.flat_cleaning_photo_slots(),pg_temp.s1_id(11),
    '2001-01-01 00:00:00.123456+00','2001-01-02 00:00:00+00');
insert into private.developer_operation_control(target_ref,policy_hash,reauth_ttl_seconds,lifecycle,maintenance)
  values(repeat('a',20),repeat('f',64),300,'PROVISIONING','REQUESTED');
insert into private.developer_operation_reauth(id,nonce_hash,actor_profile_id,auth_user_id,session_digest,password_version,
  target_ref,policy_hash,control_version,action,created_at,expires_at,state,probe_session_digest,verified_at)
  values(pg_temp.s1_id(51),private.operation_secret_digest(repeat('9',64)),pg_temp.s1_id(11),pg_temp.s1_id(1),
    private.operation_secret_digest(pg_temp.s1_id(21)::text),public.get_auth_password_version(pg_temp.s1_id(1)),
    repeat('a',20),repeat('f',64),1,'RESET_REVIEW',clock_timestamp()-interval '1 second',clock_timestamp()+interval '2 minutes',
    'READY',repeat('8',64),clock_timestamp());
create temp table s1_input(payload jsonb,binding jsonb,header jsonb,entry jsonb,result jsonb);
insert into s1_input(payload) select jsonb_build_object('format','reset-template-effect-v1',
  'policyFingerprint','7b5392d7d15af95a81ddac3d8a903e496a477e5b37c93ada5664dfabca59f84a',
  'projectRef',repeat('a',20),'sourceCommit',repeat('b',40),'catalogFingerprint',repeat('c',64),
  'reviewedPlanFingerprint',repeat('d',64),'contentFingerprint',repeat('e',64),
  'challengeId',pg_temp.s1_id(51),'controlVersion','1',
  'oldTemplates',private.reset_template_handover_rows()->'templates','oldSlots',private.reset_template_handover_rows()->'slots',
  'templates',jsonb_build_array(jsonb_build_object('sourceId',pg_temp.s1_id(41),'newId',pg_temp.s1_id(42),
    'version',10,'maximumVersion',9,'expectedCurrentVersion',9,'plannedAt','2026-01-01T00:00:00.000Z','createdBy',pg_temp.s1_id(11),
    'reason','OPERATIONAL_HANDOVER_INITIALIZATION',
    'content',jsonb_build_object('roomTypeId',pg_temp.s1_id(31),'cleaningKind','checkout','durationMinutes',null,'slots',private.flat_cleaning_photo_slots()))));
update s1_input set binding=jsonb_build_object('actorProfileId',pg_temp.s1_id(11),'authUserId',pg_temp.s1_id(1),
  'sessionDigest',private.operation_secret_digest(pg_temp.s1_id(21)::text),
  'passwordVersionDigest',private.operation_secret_digest(public.get_auth_password_version(pg_temp.s1_id(1))),
  'projectRef',repeat('a',20),'sourceCommit',repeat('b',40),'catalogFingerprint',repeat('c',64),
  'contentFingerprint',repeat('e',64),'planFingerprint',repeat('d',64),
  'expectedPostconditionFingerprint',private.reset_receipt_hash(jsonb_build_object('domain','reset-template-handover-postcondition-v1',
    'payloadHash',private.reset_receipt_hash(payload),'count',1,'registrationTime','DATABASE_CLOCK_AFTER_STARTED_BEFORE_OBSERVED')),
  'policyHash',repeat('f',64),'approvalScopeHash',repeat('1',64),'backupProofHash',repeat('2',64));
update s1_input set header=jsonb_build_object('bindingHash',private.reset_receipt_hash(binding),
  'idempotencyKeyDigest',repeat('3',64),'expectedPostconditionFingerprint',binding->>'expectedPostconditionFingerprint',
  'createdAt',floor(extract(epoch from clock_timestamp())*1000)::bigint,
  'expiresAt',floor(extract(epoch from clock_timestamp())*1000)::bigint+60000,
  'steps',jsonb_build_array(jsonb_build_object('id','fa08fa290aa9dd42dde4539d4c0da985b1c29a5dcbb49d7e4a570f9abea3ae16','kind','DATABASE')));
update s1_input set header=header||jsonb_build_object('format','reset-receipt-v1','commandHash',private.reset_receipt_hash(header));
create function pg_temp.s1_call(mode text,version integer default 0,head text default null,nonce text default repeat('9',64))
returns jsonb language sql volatile as $$
  select public.apply_developer_template_handover(mode,pg_temp.s1_id(11),pg_temp.s1_id(1),pg_temp.s1_id(21)::text,nonce,
    binding,header,payload,version,coalesce(head,private.reset_receipt_hash(header))) from pg_temp.s1_input
$$;
select ok(not has_function_privilege(r,'public.apply_developer_template_handover(text,uuid,uuid,text,text,jsonb,jsonb,jsonb,integer,text)','EXECUTE'),r||' effect denied')
  from unnest(array['anon','authenticated','service_role']) r;
select ok(not has_function_privilege(r,'private.reset_template_handover_rows()','EXECUTE'),r||' raw row helper denied')
  from unnest(array['anon','authenticated','service_role']) r;
select ok(not exists(select 1 from pg_proc p,aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  where p.oid='public.apply_developer_template_handover(text,uuid,uuid,text,text,jsonb,jsonb,jsonb,integer,text)'::regprocedure and a.grantee=0),'PUBLIC default execute revoked');
select throws_ok($q$select public.apply_developer_template_handover('PRECHECK',null,null,null,null,null,null,null,null,null)$q$,
  '42501','RESET_RECEIPT_IDENTITY_REJECTED','NULL identity rejected');
select throws_ok($q$select pg_temp.s1_call('PRECHECK',0,null,'malformed')$q$,
  '42501','RESET_TEMPLATE_HANDOVER_REAUTH_REJECTED','nonce malformed rejected');
select is(pg_temp.s1_call('PRECHECK')->>'status','PRECHECKED','owner synthetic precheck succeeds without granting runtime access');
select is((select count(*) from private.developer_reset_receipt_heads),0::bigint,'precheck writes no receipt');
select is((select count(*) from public.cleaning_template_versions),1::bigint,'precheck writes no draft');
select throws_ok($q$select private.assert_reset_template_handover_rows(jsonb_set(payload,'{templates,0,version}','11'),false) from s1_input$q$,
  '40001','RESET_TEMPLATE_HANDOVER_VERSION_CHANGED','planned next version must follow complete group maximum');
select throws_ok($q$select private.assert_reset_template_handover_rows(jsonb_set(payload,'{templates,0,content,slots,0,label}','"changed"'),false) from s1_input$q$,
  '40001','RESET_TEMPLATE_HANDOVER_SOURCE_CHANGED','same count different content rejected');
select throws_ok($q$select private.assert_reset_template_handover_rows(jsonb_set(payload,'{templates,0,content,slots,0,displayOrder}','0.0'::jsonb),false) from s1_input$q$,
  '40001','RESET_TEMPLATE_HANDOVER_SOURCE_CHANGED','numeric jsonb equality must not change exact historical PG text');
select throws_ok($q$select public.apply_developer_template_handover('PRECHECK',pg_temp.s1_id(11),pg_temp.s1_id(1),pg_temp.s1_id(21)::text,repeat('9',64),
  binding,header,jsonb_set(payload,'{templates,0,newId}',to_jsonb(pg_temp.s1_id(99))),0,private.reset_receipt_hash(header)) from s1_input$q$,
  '22023','RESET_TEMPLATE_HANDOVER_COMMAND_CHANGED','payload transport mutation cannot replace approved postcondition');
update public.profiles set must_change_password=true where id=pg_temp.s1_id(11);
select throws_ok($q$select pg_temp.s1_call('PRECHECK')$q$,'42501','OPERATION_ACTOR_REJECTED','latest actor status checked');
update public.profiles set must_change_password=false where id=pg_temp.s1_id(11);
select public.store_developer_reset_receipt('CREATE',pg_temp.s1_id(11),pg_temp.s1_id(1),pg_temp.s1_id(21)::text,
  binding,header,0,private.reset_receipt_hash(header),null) from s1_input;
update s1_input set entry=jsonb_build_object('sequence',1,'at',floor(extract(epoch from clock_timestamp())*1000)::bigint,
  'previousHash',private.reset_receipt_hash(header),'event',jsonb_build_object('type','STARTED',
  'stepId','fa08fa290aa9dd42dde4539d4c0da985b1c29a5dcbb49d7e4a570f9abea3ae16','bindingHash',header->>'bindingHash'));
update s1_input set entry=entry||jsonb_build_object('hash',private.reset_receipt_hash(entry));
select public.store_developer_reset_receipt('APPEND',pg_temp.s1_id(11),pg_temp.s1_id(1),pg_temp.s1_id(21)::text,
  binding,header,0,private.reset_receipt_hash(header),entry) from s1_input;
select throws_ok($q$select pg_temp.s1_call('APPLY',1,repeat('0',64))$q$,
  '40001','RESET_TEMPLATE_HANDOVER_RECEIPT_CHANGED','CAS prefix must match durable STARTED');
create function pg_temp.s1_corrupt_slot() returns trigger language plpgsql as $$
begin if new.template_version_id=pg_temp.s1_id(42) then new.required:=not new.required; end if; return new; end $$;
create trigger s1_test_slot_failure before insert on private.photo_template_slots for each row execute function pg_temp.s1_corrupt_slot();
select throws_ok($q$select pg_temp.s1_call('APPLY',1,(select entry->>'hash' from s1_input))$q$,
  '23514','RESET_TEMPLATE_HANDOVER_SLOT_READBACK_CHANGED','same snapshot/count with corrupt materialized metadata rolls back');
select is((select count(*) from public.cleaning_template_versions),1::bigint,'slot mismatch rolls back newly published row');
select is((select count(*) from private.photo_template_slots),3::bigint,'slot mismatch leaves every old slot intact');
drop trigger s1_test_slot_failure on private.photo_template_slots;
create function pg_temp.s1_corrupt_audit() returns trigger language plpgsql as $$
begin if new.event_type='cleaning_template.operational_handover' then new.reason_code:='WRONG_REASON'; end if; return new; end $$;
create trigger s1_test_audit_failure before insert on public.audit_events for each row execute function pg_temp.s1_corrupt_audit();
select throws_ok($q$select pg_temp.s1_call('APPLY',1,(select entry->>'hash' from s1_input))$q$,
  '40001','RESET_TEMPLATE_HANDOVER_AUDIT_CHANGED','wrong persisted registration reason rolls back entire effect');
select is((select count(*) from public.cleaning_template_versions),1::bigint,'audit mismatch rolls back new publication');
select is((select count(*) from public.audit_events where event_type='cleaning_template.operational_handover'),0::bigint,'audit mismatch leaves no false provenance');
drop trigger s1_test_audit_failure on public.audit_events;
-- Inject a failure after publication. The effect, retired status, slots, consumed
-- challenge and OBSERVED all roll back; the separately recorded STARTED remains.
create function pg_temp.s1_fail_after_publication() returns trigger language plpgsql as $$
begin
  if new.id=pg_temp.s1_id(42) and new.status='published' then
    update public.profiles set must_change_password=true where id=pg_temp.s1_id(11);
  end if; return new;
end $$;
create trigger s1_test_failure after update on public.cleaning_template_versions for each row execute function pg_temp.s1_fail_after_publication();
select throws_ok($q$select pg_temp.s1_call('APPLY',1,(select entry->>'hash' from s1_input))$q$,
  '42501','OPERATION_ACTOR_REJECTED','post-publication identity failure rolls back entire S1 transaction');
select is((select count(*) from public.cleaning_template_versions),1::bigint,'failed effect leaves no draft or publication');
select is((select status from public.cleaning_template_versions where id=pg_temp.s1_id(41)),'published','old published status rolls back');
select is((select count(*) from private.photo_template_slots),3::bigint,'failed materialized slots roll back');
select is((select count(*) from public.audit_events where event_type='cleaning_template.operational_handover'),0::bigint,'failed effect provenance audit also rolls back');
select is((select state from private.developer_operation_reauth where id=pg_temp.s1_id(51)),'READY','failed challenge consumption rolls back');
select is((select version from private.developer_reset_receipt_heads),1,'failed OBSERVED append rolls back to existing STARTED');
drop trigger s1_test_failure on public.cleaning_template_versions;
-- Explicit synthetic second invocation only. Operational adapter never retries.
update s1_input set result=pg_temp.s1_call('APPLY',1,entry->>'hash');
select is(result->>'status','APPLIED','atomic draft/validate/publication observed') from s1_input;
select is(result->>'executionEnabled','false','effect evidence is not reset authority') from s1_input;
select is((select status from public.cleaning_template_versions where id=pg_temp.s1_id(41)),'retired','normal prior publication retired');
select is((select status from public.cleaning_template_versions where id=pg_temp.s1_id(42)),'published','new validated draft published');
select is((select created_at from public.cleaning_template_versions where id=pg_temp.s1_id(41)),'2001-01-01 00:00:00.123456+00'::timestamptz,'historical actual creation unchanged');
select isnt((select created_at from public.cleaning_template_versions where id=pg_temp.s1_id(42)),
  (select (payload#>>'{templates,0,plannedAt}')::timestamptz from s1_input),'actual registration never copies planning time');
select is((select created_at from public.cleaning_template_versions where id=pg_temp.s1_id(42)),
  (select (result->>'registrationTime')::timestamptz from s1_input),'returned actual registration time matches database');
select lives_ok($q$select private.assert_reset_template_handover_rows(payload,true,(result->>'registrationTime')::timestamptz) from s1_input$q$,
  'full old provenance/content and every old slot preserved; exact new content and slots read back');
select lives_ok($q$select private.assert_reset_template_handover_audit(payload,header,pg_temp.s1_id(11),(result->>'registrationTime')::timestamptz) from s1_input$q$,
  'exact append-only old-to-new mapping and handover reason persist after raw plan disposal');
select is((select reason_code from public.audit_events where event_type='cleaning_template.operational_handover'),
  'OPERATIONAL_HANDOVER_INITIALIZATION','registration reason is durable');
select is((select (case when event_type='cleaning_template.operational_handover' then 'preserve' else 'resetCandidate' end)
  from public.audit_events where event_type='cleaning_template.operational_handover'),'preserve','handover audit is excluded from reset candidates');
select is(private.developer_reset_disposition_expression('public.audit_events','r'),
  'case when r.event_type=''cleaning_template.operational_handover'' then ''preserve'' else ''resetCandidate'' end','collector keeps only exact event family even when its payload is malformed');
select is((select after_state->>'sourceTemplateVersionId' from public.audit_events where event_type='cleaning_template.operational_handover'),
  pg_temp.s1_id(41)::text,'original template is mapped without rewriting its references');
select is((select state from private.developer_operation_reauth where id=pg_temp.s1_id(51)),'CONSUMED','R1 receipt consumed once');
select is((select version from private.developer_reset_receipt_heads),2,'one OBSERVED appended atomically');
select ok(not exists(select 1 from private.developer_reset_receipt_events where entry#>>'{event,type}'='FINAL_VERIFIED'),'whole reset not marked complete');
select is(pg_temp.s1_call('READ',1,(select entry->>'hash' from s1_input),null)->>'status','APPLIED','explicit readback anchored at STARTED resolves lost reply');
select is((select version from private.developer_reset_receipt_heads),2,'readback does not append or replay');
select throws_ok($q$select pg_temp.s1_call('APPLY',1,(select entry->>'hash' from s1_input))$q$,
  '42501','RESET_TEMPLATE_HANDOVER_REAUTH_REJECTED','second application rejected');
delete from auth.sessions where id=pg_temp.s1_id(21);
select throws_ok($q$select pg_temp.s1_call('READ',1,(select entry->>'hash' from s1_input))$q$,
  '42501','OPERATION_ACTOR_REJECTED','revoked session also blocks readback');
select * from finish();
rollback;
