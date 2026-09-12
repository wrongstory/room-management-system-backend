begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('14600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) values (pg_temp.pid(101)), (pg_temp.pid(102)), (pg_temp.pid(103));
insert into auth.sessions(id,user_id) values
  (pg_temp.pid(901),pg_temp.pid(101)),
  (pg_temp.pid(902),pg_temp.pid(101)),
  (pg_temp.pid(903),pg_temp.pid(102));
insert into public.profiles(
  id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
  login_sequence,role,status,must_change_password,failed_login_count,locked_until
) values
  (pg_temp.pid(1),pg_temp.pid(101),'password admin','password admin','password-admin','password-admin',0,'admin','active',true,2,clock_timestamp()+interval '5 minutes'),
  (pg_temp.pid(2),pg_temp.pid(102),'password maid','password maid','password-maid','password-maid',0,'maid','active',false,0,null),
  (pg_temp.pid(3),pg_temp.pid(103),'reset target','reset target','reset-target','reset-target',0,'maid','active',false,0,null);

select ok(has_function_privilege('service_role','public.inspect_password_change(uuid,uuid,uuid,text)','EXECUTE'),'service role may inspect password change receipt');
select ok(has_function_privilege('service_role','public.prepare_password_change(uuid,uuid,uuid,text,text,text,text)','EXECUTE'),'service role may prepare password change receipt');
select ok(has_function_privilege('service_role','public.finish_password_change_failure(uuid,uuid,uuid,text,text,text)','EXECUTE'),'service role may finish password change failure');
select ok(has_function_privilege('service_role','public.complete_password_change(uuid,uuid,uuid,text,text,text,text)','EXECUTE'),'service role may complete password change receipt');
select ok(not has_function_privilege('authenticated','public.inspect_password_change(uuid,uuid,uuid,text)','EXECUTE'),'authenticated cannot inspect privileged receipt');
select ok(not has_function_privilege('anon','public.prepare_password_change(uuid,uuid,uuid,text,text,text,text)','EXECUTE'),'anon cannot prepare privileged receipt');
select ok(not has_function_privilege('public','public.complete_password_change(uuid,uuid,uuid,text,text,text,text)','EXECUTE'),'PUBLIC cannot complete privileged receipt');
select ok(not has_table_privilege('service_role','private.password_change_commands','SELECT'),'service role cannot read raw receipt table');
select ok(not has_table_privilege('authenticated','private.password_change_commands','SELECT'),'authenticated cannot read raw receipt table');
select ok(not has_table_privilege('anon','private.password_change_commands','SELECT'),'anon cannot read raw receipt table');
select ok(not has_table_privilege('service_role','private.password_verification_rate_limits','SELECT'),'service role cannot read raw verification limiter');
select ok(not has_table_privilege('service_role','private.password_reset_auth_markers','SELECT'),'service role cannot read raw reset marker ledger');
select ok(not has_function_privilege('authenticated','public.consume_password_verification_rate_limit(uuid,uuid,uuid,text,integer,integer)','EXECUTE'),'authenticated cannot consume privileged password verification limiter');
select ok(has_function_privilege('service_role','public.prepare_password_change_admin_reset(uuid,uuid,text,text,text)','EXECUTE'),'service role may prepare reset recovery marker');
select ok(not has_function_privilege('authenticated','public.finalize_password_change_admin_reset(uuid,uuid,text,text,text,text)','EXECUTE'),'authenticated cannot finalize reset recovery');

select is(
  public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001')->>'state',
  'absent','new key is absent before preparation'
);
select is(
  public.prepare_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001',repeat('a',64),repeat('b',64),repeat('e',64))->>'state',
  'execute','first preparation owns the Auth mutation claim'
);
select is(
  public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001')->>'state',
  'busy','active lease blocks a second mutation'
);
select throws_ok(
  $$select public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(902),'password-first-0001')$$,
  '42501','PASSWORD_CHANGE_SESSION_MISMATCH','another live session cannot inspect a known receipt'
);
select throws_ok(
  $$select public.prepare_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(902),'password-first-0001',repeat('a',64),repeat('b',64),repeat('e',64))$$,
  '42501','PASSWORD_CHANGE_SESSION_MISMATCH','another live session cannot reclaim a known receipt'
);
select throws_ok(
  $$select public.complete_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(902),'password-first-0001',repeat('a',64),repeat('b',64),'2026-09-12T12:00:00.987000Z')$$,
  '42501','PASSWORD_CHANGE_SESSION_MISMATCH','another live session cannot complete a known receipt'
);
select throws_ok(
  $$select public.finish_password_change_failure(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(902),'password-first-0001',repeat('b',64),'AUTH_PASSWORD_CHANGE_FAILED')$$,
  '42501','PASSWORD_CHANGE_SESSION_MISMATCH','another live session cannot terminate a known receipt'
);
select is(
  public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-other-0002')->>'state',
  'other_in_progress','different actor key cannot overlap an unresolved password change'
);
select throws_ok(
  $$select public.prepare_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001',repeat('c',64),repeat('d',64),repeat('f',64))$$,
  '23505','IDEMPOTENCY_KEY_REUSED','same scoped key with a different safe fingerprint is rejected'
);

select is(
  public.complete_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001',repeat('a',64),repeat('b',64),'2026-09-12T12:00:00.987000Z')->>'completed',
  'true','claimed command completes the DB state'
);
select is((select must_change_password from public.profiles where id=pg_temp.pid(1)),false,'completion clears must_change_password');
select is((select failed_login_count from public.profiles where id=pg_temp.pid(1)),0,'completion clears failed login count');
select is((select locked_until from public.profiles where id=pg_temp.pid(1)),null::timestamptz,'completion clears lock');
select is((select count(*) from auth.sessions where user_id=pg_temp.pid(101)),1::bigint,'completion revokes every other session');
select ok(exists(select 1 from auth.sessions where id=pg_temp.pid(901)),'completion preserves caller session');
select is((select count(*) from public.audit_events where actor_profile_id=pg_temp.pid(1) and event_type='account.password_changed'),1::bigint,'completion appends one audit event');
select is(
  public.complete_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001',repeat('a',64),repeat('f',64),'2026-09-12T12:00:00.987000Z')->>'completed',
  'true','completed receipt replay is idempotent without reclaiming Auth'
);
select is((select count(*) from public.audit_events where actor_profile_id=pg_temp.pid(1) and event_type='account.password_changed'),1::bigint,'completed replay does not duplicate audit');
select isnt(
  (select idempotency_key from public.audit_events where actor_profile_id=pg_temp.pid(1) and event_type='account.password_changed'),
  'password-first-0001','audit global identity never stores the raw scoped key'
);

select is(
  public.prepare_password_change(pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(903),'password-recover-01',repeat('1',64),repeat('2',64),repeat('4',64))->>'state',
  'execute','another actor has an isolated command namespace'
);
update private.password_change_commands set lease_expires_at=clock_timestamp()-interval '1 second'
where actor_profile_id=pg_temp.pid(2);
select is(
  public.prepare_password_change(pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(903),'password-recover-01',repeat('1',64),repeat('3',64),repeat('5',64))->>'state',
  'recover','expired claim is recoverable with a new nonsecret claim digest'
);
select is((select attempt_count from private.password_change_commands where actor_profile_id=pg_temp.pid(2)),2,'recovery increments bounded attempt count');
select lives_ok(
  $$select public.finish_password_change_failure(pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(903),'password-recover-01',repeat('3',64),'PASSWORD_STATE_INCONSISTENT')$$,
  'ambiguous Auth evidence is recorded as inconsistent'
);
select is((select state from private.password_change_commands where actor_profile_id=pg_temp.pid(2)),'inconsistent','ambiguous state stays fail-closed and recoverable');

select is(
  public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001')->>'effectMarker',
  repeat('e',64),'completed receipt retains a nonsecret Auth operation marker'
);
select is(
  public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001')->>'authUpdatedAt',
  '2026-09-12T12:00:00.987000Z','completed receipt retains exact nonsecret Auth version evidence'
);

select is(
  (select count(*) from public.consume_password_verification_rate_limit(
    pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),repeat('6',64),10,60
  ) where allowed),
  1::bigint,'first password verification is allowed'
);
select is(
  (select count(*) from public.consume_password_verification_rate_limit(
    pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(903),repeat('7',64),10,60
  ) where allowed),
  1::bigint,'another actor and session has an isolated verification budget'
);
insert into auth.sessions(id,user_id)
select pg_temp.pid(909+i),pg_temp.pid(101) from generate_series(1,10) as i;
select lives_ok($$
  do $body$
  begin
    for i in 1..10 loop
      perform * from public.consume_password_verification_rate_limit(
        pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(909+i),
        repeat((case when i % 2 = 0 then '8' else '9' end),64),10,60
      );
    end loop;
  end
  $body$
$$,'rotating sessions and client evidence share one authoritative actor budget');
select is((select count(*) from private.password_verification_rate_limits where actor_profile_id=pg_temp.pid(1)),1::bigint,'verification limiter cardinality is one row per actor');
select is((select attempt_count from private.password_verification_rate_limits where actor_profile_id=pg_temp.pid(1)),11,'verification limiter saturates at limit plus one');
select is(
  (select count(*) from public.consume_password_verification_rate_limit(
    pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),repeat('a',64),10,60
  ) where not allowed),
  1::bigint,'saturated verification budget fails closed'
);
select is((select attempt_count from private.password_verification_rate_limits where actor_profile_id=pg_temp.pid(1)),11,'denied verification does not keep writing after saturation');

select lives_ok(
  $$select public.prepare_account_password_reset(pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64))$$,
  'administrator reset DB preparation accepts an inconsistent self-change after the lease'
);
select is((select state from private.password_change_commands where actor_profile_id=pg_temp.pid(2)),'inconsistent','DB reset preparation alone does not prematurely resolve the receipt');
select is(
  public.prepare_password_change_admin_reset(
    pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('a',64)
  )->>'effectMarker',
  repeat('a',64),'reset recovery binds one nonsecret Auth marker to the command receipt'
);
select is((select state from private.password_change_commands where actor_profile_id=pg_temp.pid(2)),'reset_pending','Auth failure before finalize leaves the self-change receipt unresolved');
select is(
  public.prepare_password_change_admin_reset(
    pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('b',64)
  )->>'effectMarker',
  repeat('a',64),'same administrator reset retry reuses its original Auth marker'
);
select throws_ok(
  $$select public.finalize_password_change_admin_reset(pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('b',64),'2026-09-12T12:01:00.987000Z')$$,
  '23505','PASSWORD_RESET_EFFECT_MARKER_MISMATCH','reset finalization rejects a different Auth operation marker'
);
select is(
  public.finalize_password_change_admin_reset(
    pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('a',64),'2026-09-12T12:01:00.987000Z'
  )->>'completed',
  'true','successful external Auth reset finalization supersedes the inconsistent receipt'
);
select is((select state from private.password_change_commands where actor_profile_id=pg_temp.pid(2)),'superseded','admin reset success closes the unresolved self-change receipt');
insert into auth.sessions(id,user_id) values (pg_temp.pid(904),pg_temp.pid(102));
select is(
  public.inspect_password_change(pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(904),'password-after-reset-01')->>'state',
  'absent','new temporary-password self-change may start after successful admin reset'
);
select is(
  public.prepare_password_change(
    pg_temp.pid(2),pg_temp.pid(102),pg_temp.pid(904),'password-after-reset-01',repeat('c',64),repeat('d',64),repeat('f',64)
  )->>'state',
  'execute','post-reset self-change receives a fresh isolated receipt'
);
select is(
  public.prepare_password_change_admin_reset(
    pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('b',64)
  )->>'state',
  'completed','completed administrator reset key replays before inspecting a newer self-change receipt'
);
select is(
  (select state from private.password_change_commands where actor_profile_id=pg_temp.pid(2) and idempotency_key='password-after-reset-01'),
  'auth_pending','completed reset replay does not move a newer self-change receipt to reset_pending'
);
select is(
  (select reset_command_execution_id from private.password_change_commands where actor_profile_id=pg_temp.pid(2) and idempotency_key='password-after-reset-01'),
  null::uuid,'completed reset replay does not bind its old execution to a newer self-change receipt'
);

select lives_ok(
  $$select public.prepare_account_password_reset(pg_temp.pid(1),pg_temp.pid(3),'password-reset-plain-01',repeat('1',64))$$,
  'first administrator reset may prepare a target without a prior self-change receipt'
);
select lives_ok(
  $$select public.prepare_password_change_admin_reset(pg_temp.pid(1),pg_temp.pid(3),'password-reset-plain-01',repeat('1',64),repeat('1',64))$$,
  'first administrator reset owns the external Auth marker claim'
);
select lives_ok(
  $$select public.prepare_account_password_reset(pg_temp.pid(1),pg_temp.pid(3),'password-reset-plain-02',repeat('2',64))$$,
  'a competing reset may complete DB preparation before external Auth serialization'
);
select throws_ok(
  $$select public.prepare_password_change_admin_reset(pg_temp.pid(1),pg_temp.pid(3),'password-reset-plain-02',repeat('2',64),repeat('2',64))$$,
  '40001','PASSWORD_RESET_IN_PROGRESS','only one administrator reset may own the target Auth mutation at a time'
);

select throws_ok(
  $$update private.password_change_commands set idempotency_key='password-tamper-01' where actor_profile_id=pg_temp.pid(1)$$,
  '55000','PASSWORD_CHANGE_RECEIPT_IMMUTABLE','receipt identity cannot be changed'
);
select throws_ok(
  $$delete from private.password_change_commands where actor_profile_id=pg_temp.pid(1)$$,
  '55000','PASSWORD_CHANGE_RECEIPT_DELETE_FORBIDDEN','receipt cannot be deleted'
);
select throws_ok(
  $$select public.inspect_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(902),'password-first-0001')$$,
  '42501','SESSION_REVOKED','revoked session cannot inspect a receipt'
);

select ok(not exists(
  select 1 from private.password_change_commands c
  where to_jsonb(c)::text ~ '(1234|654321|tmp:|eyJ|Bearer|refresh)'
),'receipt contains no password, transformed password, token, or reusable verifier material');
select ok(not exists(
  select 1 from private.password_change_commands c
  where to_jsonb(c)::text like '%' || pg_temp.pid(901)::text || '%'
),'receipt stores only a domain-separated session digest, never the raw session UUID');
select ok(not exists(
  select 1 from private.password_verification_rate_limits limits
  where to_jsonb(limits)::text like '%' || pg_temp.pid(901)::text || '%'
     or exists (
       select 1 from generate_series(910,919) as session_number
       where to_jsonb(limits)::text like '%' || pg_temp.pid(session_number)::text || '%'
     )
),'verification limiter stores no raw session UUID, including rotated sessions');
select ok(not exists(
  select 1 from private.password_reset_auth_markers markers
  where to_jsonb(markers)::text ~ '(1234|654321|tmp:|eyJ|Bearer|refresh)'
),'reset recovery ledger contains only nonsecret command and effect provenance');
select ok(not exists(
  select 1 from public.audit_events a
  where a.actor_profile_id in (pg_temp.pid(1),pg_temp.pid(2))
    and to_jsonb(a)::text ~ '(1234|654321|tmp:|eyJ|Bearer|refresh)'
),'password audit contains no password or token material');
select ok(not exists(
  select 1 from public.audit_events a
  where a.actor_profile_id in (pg_temp.pid(1),pg_temp.pid(2))
    and (
      jsonb_build_object('before',a.before_state,'after',a.after_state)::text like '%' || repeat('e',64) || '%'
      or jsonb_build_object('before',a.before_state,'after',a.after_state)::text like '%' || repeat('a',64) || '%'
    )
),'password/reset effect markers are not projected into the public audit ledger');

select * from finish();
rollback;
