begin;
select no_plan();

create function pg_temp.pid(n integer) returns uuid language sql immutable as $$
  select ('14600000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid
$$;

insert into auth.users(id) values
  (pg_temp.pid(101)), (pg_temp.pid(102)), (pg_temp.pid(103)), (pg_temp.pid(104));
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
select ok(has_function_privilege('service_role','public.complete_password_change(uuid,uuid,uuid,text,text,text)','EXECUTE'),'service role may complete password change receipt');
select ok(not has_function_privilege('authenticated','public.inspect_password_change(uuid,uuid,uuid,text)','EXECUTE'),'authenticated cannot inspect privileged receipt');
select ok(not has_function_privilege('anon','public.prepare_password_change(uuid,uuid,uuid,text,text,text,text)','EXECUTE'),'anon cannot prepare privileged receipt');
select ok(not has_function_privilege('public','public.complete_password_change(uuid,uuid,uuid,text,text,text)','EXECUTE'),'PUBLIC cannot complete privileged receipt');
select ok(not has_table_privilege('service_role','private.password_change_commands','SELECT'),'service role cannot read raw receipt table');
select ok(not has_table_privilege('authenticated','private.password_change_commands','SELECT'),'authenticated cannot read raw receipt table');
select ok(not has_table_privilege('anon','private.password_change_commands','SELECT'),'anon cannot read raw receipt table');
select ok(not has_table_privilege('service_role','private.password_verification_rate_limits','SELECT'),'service role cannot read raw verification limiter');
select ok(not has_table_privilege('service_role','private.password_reset_auth_markers','SELECT'),'service role cannot read raw reset marker ledger');
select ok(not has_table_privilege('service_role','private.auth_password_versions','SELECT'),'service role cannot read raw password version ledger');
select ok(not has_table_privilege('authenticated','private.auth_password_versions','SELECT'),'authenticated cannot read raw password version ledger');
select ok(not has_table_privilege('anon','private.auth_password_versions','SELECT'),'anon cannot read raw password version ledger');
select ok(has_function_privilege('service_role','public.get_auth_password_version(uuid)','EXECUTE'),'service role may read the nonsecret current password version');
select ok(not has_function_privilege('authenticated','public.get_auth_password_version(uuid)','EXECUTE'),'authenticated cannot read the private password version');
select ok(not has_function_privilege('anon','public.get_auth_password_version(uuid)','EXECUTE'),'anon cannot read the private password version');
select ok(not has_function_privilege('public','private.rotate_auth_password_version()','EXECUTE'),'PUBLIC cannot invoke the Auth password trigger helper');
select ok(not has_function_privilege('authenticated','public.consume_password_verification_rate_limit(uuid,uuid,uuid,text,integer,integer)','EXECUTE'),'authenticated cannot consume privileged password verification limiter');
select ok(has_function_privilege('service_role','public.prepare_password_change_admin_reset(uuid,uuid,text,text,text)','EXECUTE'),'service role may prepare reset recovery marker');
select ok(not has_function_privilege('authenticated','public.finalize_password_change_admin_reset(uuid,uuid,text,text,text)','EXECUTE'),'authenticated cannot finalize reset recovery');

select is((select count(*) from private.auth_password_versions),4::bigint,'Auth user insert/backfill creates exactly one private password version per user');
select ok(not exists(
  select 1 from private.auth_password_versions
  where password_version !~ '^[0-9a-f]{64}$'
),'password versions are random nonsecret 64-hex identities');
create temporary table password_version_observations(label text primary key, version text not null) on commit drop;
insert into password_version_observations values
  ('login-before',public.get_auth_password_version(pg_temp.pid(104))),
  ('untouched-target',public.get_auth_password_version(pg_temp.pid(103)));
update auth.users set last_sign_in_at=clock_timestamp() where id=pg_temp.pid(104);
insert into password_version_observations values
  ('login-after',public.get_auth_password_version(pg_temp.pid(104)));
select is(
  (select version from password_version_observations where label='login-after'),
  (select version from password_version_observations where label='login-before'),
  'ordinary login metadata update does not rotate password-specific provenance'
);
update auth.users set encrypted_password='direct-password-hash-fixture-1' where id=pg_temp.pid(104);
insert into password_version_observations values
  ('direct-first',public.get_auth_password_version(pg_temp.pid(104)));
select isnt(
  (select version from password_version_observations where label='direct-first'),
  (select version from password_version_observations where label='login-before'),
  'direct Auth password update rotates the private version exactly once'
);
select is(
  (select count(*) from private.auth_password_versions where auth_user_id=pg_temp.pid(104)),
  1::bigint,'password rotation updates one shadow row instead of appending password evidence'
);
update auth.users set last_sign_in_at=clock_timestamp() where id=pg_temp.pid(104);
select is(
  public.get_auth_password_version(pg_temp.pid(104)),
  (select version from password_version_observations where label='direct-first'),
  'non-password Auth update after rotation leaves the version unchanged'
);
create function pg_temp.reject_password_version_write() returns trigger language plpgsql as $$
begin
  raise exception using errcode='P0001', message='TEST_PASSWORD_VERSION_WRITE_BLOCKED';
end;
$$;
create trigger reject_password_version_write
before update on private.auth_password_versions
for each row
when (new.auth_user_id = pg_temp.pid(104))
execute function pg_temp.reject_password_version_write();
select throws_ok(
  $$update auth.users set encrypted_password='password-hash-that-must-rollback' where id=pg_temp.pid(104)$$,
  'P0001','TEST_PASSWORD_VERSION_WRITE_BLOCKED','shadow version write failure aborts the Auth password mutation'
);
select is(
  (select encrypted_password from auth.users where id=pg_temp.pid(104)),
  'direct-password-hash-fixture-1','failed provenance trigger leaves the prior Auth password hash unchanged'
);
drop trigger reject_password_version_write on private.auth_password_versions;

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
  $$select public.complete_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(902),'password-first-0001',repeat('a',64),repeat('b',64))$$,
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

update auth.users set encrypted_password='self-password-hash-fixture-1' where id=pg_temp.pid(101);
select is(
  public.get_auth_password_version(pg_temp.pid(101)),
  repeat('e',64),'self-service Auth password change binds the prepared receipt version'
);

select is(
  public.complete_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001',repeat('a',64),repeat('b',64))->>'completed',
  'true','claimed command completes the DB state'
);
select is((select must_change_password from public.profiles where id=pg_temp.pid(1)),false,'completion clears must_change_password');
select is((select failed_login_count from public.profiles where id=pg_temp.pid(1)),0,'completion clears failed login count');
select is((select locked_until from public.profiles where id=pg_temp.pid(1)),null::timestamptz,'completion clears lock');
select is((select count(*) from auth.sessions where user_id=pg_temp.pid(101)),1::bigint,'completion revokes every other session');
select ok(exists(select 1 from auth.sessions where id=pg_temp.pid(901)),'completion preserves caller session');
select is((select count(*) from public.audit_events where actor_profile_id=pg_temp.pid(1) and event_type='account.password_changed'),1::bigint,'completion appends one audit event');
select is(
  public.complete_password_change(pg_temp.pid(1),pg_temp.pid(101),pg_temp.pid(901),'password-first-0001',repeat('a',64),repeat('f',64))->>'completed',
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
  repeat('e',64),'completed receipt retains its nonsecret password effect version'
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
  repeat('a',64),'reset recovery binds one nonsecret password effect version to the command receipt'
);
select is((select state from private.password_change_commands where actor_profile_id=pg_temp.pid(2)),'reset_pending','Auth failure before finalize leaves the self-change receipt unresolved');
select is(
  public.prepare_password_change_admin_reset(
    pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('b',64)
  )->>'effectMarker',
  repeat('a',64),'same administrator reset retry reuses its original effect version'
);
select throws_ok(
  $$select public.finalize_password_change_admin_reset(pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('b',64))$$,
  '23505','PASSWORD_RESET_EFFECT_MARKER_MISMATCH','reset finalization rejects a different password effect version'
);
update auth.users set encrypted_password='admin-reset-password-hash-fixture-1' where id=pg_temp.pid(102);
select is(
  public.get_auth_password_version(pg_temp.pid(102)),
  repeat('a',64),'administrator Auth reset binds the prepared reset version'
);
select is(
  public.finalize_password_change_admin_reset(
    pg_temp.pid(1),pg_temp.pid(2),'password-admin-reset-01',repeat('9',64),repeat('a',64)
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
  'first administrator reset owns the external Auth effect-version claim'
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

-- #300: inspect exact synthetic provenance, not short digit substrings in
-- random UUIDs/digests/versions or timestamp fractions. Unknown/missing fields
-- fail closed. Only generated row IDs and typed timestamps vary freely.
create function pg_temp.password_ledger_matches(
  candidate jsonb, expected jsonb, uuid_fields text[], time_fields text[], nullable_times text[]
) returns boolean language plpgsql immutable as $$
declare
  field text;
begin
  if candidate is null or jsonb_typeof(candidate) <> 'object'
    or candidate - (uuid_fields || time_fields || nullable_times) is distinct from expected then
    return false;
  end if;
  foreach field in array uuid_fields loop
    if jsonb_typeof(candidate->field) is distinct from 'string'
      or candidate->>field !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      return false;
    end if;
  end loop;
  foreach field in array time_fields || nullable_times loop
    if field = any(nullable_times) and candidate->field = 'null'::jsonb then
      continue;
    end if;
    if jsonb_typeof(candidate->field) is distinct from 'string'
      or candidate->>field !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}:\d{2}|Z)$' then
      return false;
    end if;
    perform (candidate->>field)::timestamptz;
  end loop;
  return true;
exception when invalid_datetime_format or datetime_field_overflow then
  return false;
end;
$$;
create temporary table expected_password_ledgers (
  kind text not null, value jsonb not null,
  uuid_fields text[] not null, time_fields text[] not null, nullable_times text[] not null
) on commit drop;
insert into expected_password_ledgers
select 'receipt', jsonb_build_object(
  'actor_profile_id',pg_temp.pid(actor),'auth_user_id',pg_temp.pid(auth_user),
  'command_type','account.password.change','idempotency_key',key,
  'request_hash',repeat(hash_char,64),'effect_marker',repeat(effect_char,64),
  'session_digest',encode(extensions.digest(convert_to(
    jsonb_build_array('password-change-session:v1',pg_temp.pid(session_number)::text)::text,'UTF8'
  ),'sha256'),'hex'),
  'state',state,'claim_digest',repeat(claim_char,64),'attempt_count',attempts,
  'failure_code',failure,'reset_command_execution_id',(
    select id from private.command_executions
    where actor_profile_id=pg_temp.pid(1) and command_type='account.password.reset'
      and idempotency_key=reset_key and request_hash=repeat('9',64) and entity_id=pg_temp.pid(2)
  )
), array['id'], array['created_at','updated_at'], array['lease_expires_at','completed_at']
from (values
  (1,101,901,'password-first-0001','a','e','completed',null::text,1,null::text,null::text),
  (2,102,903,'password-recover-01','1','4','superseded',null,2,'PASSWORD_STATE_INCONSISTENT','password-admin-reset-01'),
  (2,102,904,'password-after-reset-01','c','f','auth_pending','d',1,null,null)
) as fixtures(actor,auth_user,session_number,key,hash_char,effect_char,state,claim_char,attempts,failure,reset_key);
insert into expected_password_ledgers
select 'version',jsonb_build_object('auth_user_id',pg_temp.pid(auth_user),'password_version',version),
  array[]::text[],array['rotated_at'],array[]::text[]
from (values
  (101,repeat('e',64)),(102,repeat('a',64)),
  (103,(select version from password_version_observations where label='untouched-target')),
  (104,(select version from password_version_observations where label='direct-first'))
) as fixtures(auth_user,version);
insert into expected_password_ledgers
select 'reset',jsonb_build_object(
  'command_execution_id',(
    select id from private.command_executions
    where actor_profile_id=pg_temp.pid(1) and command_type='account.password.reset'
      and idempotency_key=key and request_hash=repeat(hash_char,64) and entity_id=pg_temp.pid(target)
  ),'actor_profile_id',pg_temp.pid(1),'target_profile_id',pg_temp.pid(target),
  'effect_marker',repeat(effect_char,64),'state',state
),array[]::text[],array['created_at','updated_at'],array['completed_at']
from (values
  (2,'password-admin-reset-01','9','a','completed'),
  (3,'password-reset-plain-01','1','1','prepared')
) as fixtures(target,key,hash_char,effect_char,state);
create temporary view actual_password_ledgers as
  select 'receipt'::text kind,to_jsonb(c) value from private.password_change_commands c
  union all select 'version',to_jsonb(v) from private.auth_password_versions v
  union all select 'reset',to_jsonb(m) from private.password_reset_auth_markers m;
select is((select count(*) from private.password_change_commands),3::bigint,'exactly three self-change receipts');
select is((select count(*) from private.auth_password_versions),4::bigint,'exactly four password versions');
select is((select count(*) from private.password_reset_auth_markers),2::bigint,'exactly two reset markers');
select ok(not exists (
  select 1 from actual_password_ledgers actual where not exists (
    select 1 from expected_password_ledgers expected where actual.kind=expected.kind
      and pg_temp.password_ledger_matches(actual.value,expected.value,
        expected.uuid_fields,expected.time_fields,expected.nullable_times)
  )
),'private password ledgers contain only exact safe fixture provenance');
select ok(not exists (
  select 1 from expected_password_ledgers expected where not exists (
    select 1 from actual_password_ledgers actual where actual.kind=expected.kind
      and pg_temp.password_ledger_matches(actual.value,expected.value,
        expected.uuid_fields,expected.time_fields,expected.nullable_times)
  )
),'every expected password ledger row is present');
select ok(not exists (
  select 1 from private.auth_password_versions versions
  join auth.users users on users.id=versions.auth_user_id
  where users.encrypted_password is not null and (
    versions.password_version=users.encrypted_password
    or versions.password_version=encode(extensions.digest(users.encrypted_password,'sha256'),'hex')
  )
),'password versions are neither Auth hash fixtures nor their SHA-256 verifiers');
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
-- Exercise the matcher against full synthetic rows, without mutating ledgers.
-- The matcher checks metadata types; existing table CHECK constraints enforce
-- completed_at/lease nullability for each state on the actual rows above.
create temporary view password_ledger_samples as
select expected.*, value || coalesce((
  select jsonb_object_agg(field,'12340000-0000-4000-8000-000000654321'::text)
  from unnest(uuid_fields) as fields(field)
),'{}'::jsonb) || (
  select jsonb_object_agg(field,'2026-10-07T12:00:00.654321Z'::text)
  from unnest(time_fields || nullable_times) as fields(field)
) as sample from expected_password_ledgers expected;
select ok(bool_and(pg_temp.password_ledger_matches(sample,value,uuid_fields,time_fields,nullable_times)),
  'generated UUID and timestamp digit collisions are accepted') from password_ledger_samples;
select ok(bool_and(not pg_temp.password_ledger_matches(
  sample || jsonb_build_object(field,sentinel),value,uuid_fields,time_fields,nullable_times
)), 'every ledger field rejects secret sentinel mutation')
from password_ledger_samples
cross join lateral jsonb_object_keys(sample) as fields(field)
cross join (values ('1234'),('654321'),('tmp:secret'),('eyJtoken'),('Bearer token'),('refresh'),
  ('direct-password-hash-fixture-1'),('self-password-hash-fixture-1'),('admin-reset-password-hash-fixture-1'),
  (repeat('0',64))) as secrets(sentinel);
select ok(bool_and(not pg_temp.password_ledger_matches(
  sample - field,value,uuid_fields,time_fields,nullable_times
)), 'missing ledger fields fail closed') from password_ledger_samples
cross join lateral jsonb_object_keys(sample) as fields(field);
select ok(bool_and(not pg_temp.password_ledger_matches(
  sample || '{"unexpected":{"password":"1234"}}'::jsonb,value,uuid_fields,time_fields,nullable_times
)), 'new nested ledger fields fail closed') from password_ledger_samples;
select ok(bool_and(pg_temp.password_ledger_matches(
  sample || jsonb_build_object(field,collision),value || jsonb_build_object(field,collision),
  uuid_fields,time_fields,nullable_times
)), 'exact nonsecret digest/version provenance may contain password-like digits')
from password_ledger_samples
cross join lateral jsonb_object_keys(value) as fields(field)
cross join (values ('1234' || repeat('a',60)),('654321' || repeat('b',58))) as collisions(collision)
where field in ('password_version','session_digest','effect_marker');
-- #404: UUIDs and timestamp fractions can legitimately contain "1234".
-- Compare every other field with the exact synthetic command contract instead
-- of searching short digit strings inside generated identity/time metadata.
create temporary table expected_password_audit (value jsonb not null) on commit drop;
insert into expected_password_audit
select jsonb_build_object(
  'actor_profile_id',pg_temp.pid(1),
  'actor_display_name_snapshot','password admin',
  'event_type',event_type,'entity_type','profile','entity_id',pg_temp.pid(target),
  'reason_code',null,'before_state',null,'after_state',state,
  'request_id',null,'request_hash',repeat(hash_char,64),'idempotency_key',audit_key
)
from (values
  ('account.password_changed',1,'{"mustChangePassword":false}'::jsonb,'a',
    private.password_change_audit_key(pg_temp.pid(1),'password-first-0001')),
  ('account.password_reset_requested',2,'{"mustChangePassword":true,"lockCleared":true}'::jsonb,'9',
    private.audit_command_key(pg_temp.pid(1),'account.password.reset','password-admin-reset-01')),
  ('account.password_reset_requested',3,'{"mustChangePassword":true,"lockCleared":true}'::jsonb,'1',
    private.audit_command_key(pg_temp.pid(1),'account.password.reset','password-reset-plain-01')),
  ('account.password_reset_requested',3,'{"mustChangePassword":true,"lockCleared":true}'::jsonb,'2',
    private.audit_command_key(pg_temp.pid(1),'account.password.reset','password-reset-plain-02'))
) as expected(event_type,target,state,hash_char,audit_key);
create function pg_temp.password_audit_is_expected(candidate jsonb)
returns boolean language sql stable as $$
  select exists (
    select 1 from expected_password_audit expected
    where candidate - array['id','effective_at','recorded_at','created_at'] = expected.value
  )
$$;
select is((select count(*) from public.audit_events
  where actor_profile_id in (pg_temp.pid(1),pg_temp.pid(2))),4::bigint,
  'password audit contains exactly the four expected command events');
select ok(not exists(
  select 1 from public.audit_events a
  where a.actor_profile_id in (pg_temp.pid(1),pg_temp.pid(2))
    and not pg_temp.password_audit_is_expected(to_jsonb(a))
),'password audit contains only exact safe command fields, no password or token material');
select ok(bool_and(pg_temp.password_audit_is_expected(value || jsonb_build_object(
  'id','12340000-0000-4000-8000-000000654321'::uuid,
  'effective_at','2026-10-07T12:00:00.123456Z'::timestamptz,
  'recorded_at','2026-10-07T12:00:00.654321Z'::timestamptz,
  'created_at','2026-10-07T12:00:00.123456Z'::timestamptz
))), 'valid generated UUID and timestamp digit collisions are not secret payloads')
from expected_password_audit;
select ok(bool_and(not pg_temp.password_audit_is_expected(
  value || jsonb_build_object(field,sentinel)
)), 'every non-metadata field rejects password and token sentinel mutations')
from expected_password_audit
cross join lateral jsonb_object_keys(value) as fields(field)
cross join (values ('1234'),('654321'),('tmp:secret'),('eyJtoken'),('Bearer token'),('refresh')) as secrets(sentinel);
select ok(bool_and(not pg_temp.password_audit_is_expected(
  value || jsonb_build_object('after_state',(value->'after_state') || jsonb_build_object('password',sentinel))
)), 'nested payload secrets are rejected even alongside valid audit state')
from expected_password_audit
cross join (values ('1234'),('654321'),('tmp:secret'),('eyJtoken'),('Bearer token'),('refresh')) as secrets(sentinel);
select ok(bool_and(not pg_temp.password_audit_is_expected(value || '{"unexpected":"1234"}'::jsonb)),
  'new unapproved audit fields fail closed') from expected_password_audit;
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
