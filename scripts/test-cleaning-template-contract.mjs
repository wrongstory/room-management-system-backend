import { spawnSync } from 'node:child_process';
import { flatTemplateRequest, historicalTemplateRequest, invalidFlatTemplateRequests } from '../tests/fixtures/cleaning-template-contract.ts';

// Local synthetic rollback-only test. No remote connection string or service key.
const literal = (value) => `'${JSON.stringify(value).replaceAll("'", "''")}'::jsonb`;
const actor = "'e3230000-0000-4000-8000-000000000001'";
const session = "'e3230000-0000-4000-8000-000000000201'";
const command = (body, key) => `public.publish_checkout_cleaning_template(${actor},${session},'${body.roomTypeCode}',${body.expectedVersion},null,${literal(body.slots)},'${key}',repeat('a',64))`;
const statements = [
  'begin;',
  "insert into auth.users(id) values ('e3230000-0000-4000-8000-000000000101');",
  `insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password)
    values (${actor},'e3230000-0000-4000-8000-000000000101','계약 관리자','계약 관리자','contract-admin','contract-admin',0,'admin','active',false);`,
  `insert into auth.sessions(id,user_id) values (${session},'e3230000-0000-4000-8000-000000000101');`,
  `create function pg_temp.check_rejected(command text, expected text) returns void language plpgsql as $$
    begin
      begin execute 'select ' || command;
      exception when others then
        if sqlerrm = expected then return; end if;
        raise;
      end;
      raise exception 'Expected rejection: %', expected;
    end $$;`
];
for (const roomTypeCode of ['standard', 'premium', 'oceanPremium', 'oceanFamily']) {
  const body = { ...flatTemplateRequest, roomTypeCode };
  const first = command(body, `flat-${roomTypeCode}`);
  const stale = command(body, `stale-${roomTypeCode}`);
  const updated = command({ ...body, expectedVersion: 9 }, `update-${roomTypeCode}`);
  statements.push(`do $$ declare original jsonb; replay jsonb; successor jsonb; begin
    original := ${first};
    if original->>'version' is distinct from '9' or original->'slots' is distinct from ${literal(body.slots)} then raise exception 'Invalid initial v9 projection'; end if;
    replay := ${first};
    if replay is distinct from original then raise exception 'Replay changed original receipt'; end if;
    perform pg_temp.check_rejected($q$${stale}$q$, 'CLEANING_TEMPLATE_VERSION_CONFLICT');
    successor := ${updated};
    if successor->>'version' is distinct from '10' then raise exception 'CAS successor not version 10'; end if;
    if ${first} is distinct from original then raise exception 'Old receipt lost after successor'; end if;
  end $$;`);
}
for (const [index, [name, invalid]] of invalidFlatTemplateRequests().entries()) {
  // Use the latest standard CAS to reach slot validation, except the negative-version case.
  const body = { ...invalid, expectedVersion: name === 'invalid version' ? -1 : 10 };
  const code = name === 'invalid version' ? 'INVALID_CLEANING_TEMPLATE' : 'INVALID_CLEANING_TEMPLATE_SLOTS';
  statements.push(`select pg_temp.check_rejected($q$${command(body, `invalid-${index}`)}$q$, '${code}');`);
}
statements.push(`select pg_temp.check_rejected($q$${command({ ...historicalTemplateRequest('standard', true), expectedVersion: 10 }, 'fresh-pre-a')}$q$, 'INVALID_CLEANING_TEMPLATE_SLOTS');`);
for (const [index, patch] of [{ label: '다른 이름' }, { section: '새 구역' }].entries()) {
  const body = { ...flatTemplateRequest, expectedVersion: 10, slots: flatTemplateRequest.slots.map((slot) => ({ ...slot, ...patch })) };
  statements.push(`select pg_temp.check_rejected($q$${command(body, `canonical-${index}`)}$q$, 'INVALID_CLEANING_TEMPLATE_SLOTS');`);
}
// Record actual existing behavior; this check does not establish a new product policy.
statements.push(`select ${command({ ...historicalTemplateRequest('standard'), expectedVersion: 10 }, 'existing-v8-compatibility')};`);
statements.push('rollback;');
const result = spawnSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend',
  'psql', '-X', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q'],
{ input: statements.join('\n'), encoding: 'utf8' });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error(result.stderr || `Local template contract failed (${result.status})`);
console.log('Local DB template contract passed: four room types, initial/CAS/replay, 15 malformed requests, fresh pre-A rejection and existing v8 compatibility; rolled back.');
