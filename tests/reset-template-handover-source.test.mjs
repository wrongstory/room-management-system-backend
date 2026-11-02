import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { RESET_HANDOVER_POLICY_FINGERPRINT } from '../src/modules/developer-reset/approved-handover-policy.js';
import { RESET_TEMPLATE_HANDOVER_STEP } from '../src/modules/developer-reset/template-handover-protocol.js';
import { inspectMigrationSqlAst } from '../scripts/lib/migration-sql-plan.mjs';
const require = createRequire(import.meta.url);
const read = p => readFileSync(p, 'utf8').replaceAll('\r\n', '\n');
const migration = 'supabase/migrations/20261025072617_developer_template_handover_effect.sql';
const whole = read(migration), source = whole.split('-- Preserve only exact handover audit rows;')[0], regression = 'supabase/tests/developer_template_handover_effect.sql';
// Narrow IF-expression boundary regression, not a PL/pgSQL compiler. Like PG17
// read_sql_construct, THEN terminates this expression only at bracket depth zero.
function conditionThroughThen(text) {
  let depth = 0;
  const tokens = /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|[a-z_][a-z_0-9]*|[^\s]/gi;
  for (const token of text.matchAll(tokens)) {
    const value = token[0].toLowerCase();
    if (value === '(' || value === '[') depth++;
    else if (value === ')' || value === ']') depth--;
    else if (value === 'then' && depth === 0) return text.slice(0, token.index);
  }
  throw new Error('Missing outer THEN');
}

describe('prepared S1 source contract (SQL not executed)', () => {
  it.each(['v15', 'v17'])('reads the complete preservation IF across its CASE expression with %s', async version => {
    const parser = require(`@pgsql/parser/${version}`);
    const functions = (await parser.parse(whole)).stmts.map(({ stmt }) => stmt.CreateFunctionStmt);
    const fn = functions.find(fn => fn?.funcname?.at(-1)?.String.sval === 'assert_reset_template_handover_rows');
    const body = fn.options.find(({ DefElem }) => DefElem.defname === 'as').DefElem.arg.List.items[0].String.sval;
    const start = body.indexOf('if previous.id is null');
    expect(start).toBeGreaterThan(0);
    const condition = conditionThroughThen(body.slice(start + 3));
    // A bare CASE would stop at its own THEN, exactly where R2 installation failed.
    const parsed = await parser.parse(`select ${condition}`);
    expect(parsed.stmts).toHaveLength(1);
    expect(condition).toContain("'retired' else 'published' end");
    expect(condition).toContain("or (item->>'newId')::uuid in (select (value->>'id')::uuid from jsonb_array_elements(p_payload->'oldTemplates'))");
  });
  it('regenerates136 and current preview while keeping historical135 byte-identical', () => {
    for (const script of ['generate-template-handover-effect', 'generate-reset-receipt-store', 'generate-reset-preview-edge'])
      execFileSync(process.execPath, [`scripts/${script}.mjs`, '--check']);
  });
  it.each(['v15', 'v17'])('parses new migration and rollback-only fixture with %s', async version => {
    const parser = require(`@pgsql/parser/${version}`);
    const parsed = await parser.parse(whole);
    expect(parsed.stmts).toHaveLength(16);
    const inspected = inspectMigrationSqlAst(Buffer.from(whole), parsed, Number(version.slice(1)));
    expect(inspected.statements).toHaveLength(16);
    expect(inspected).toMatchObject({ executionAllowed: false, parserEvidenceVerified: false });
    expect((await parser.parse(read(regression))).stmts.length).toBeGreaterThan(50);
  });
  it('pins the selected policy/step with explicit grants closed and no default role escape', () => {
    for (const text of [source, read(regression)]) {
      expect(text).toContain(RESET_HANDOVER_POLICY_FINGERPRINT); expect(text).toContain(RESET_TEMPLATE_HANDOVER_STEP);
    }
    expect(source.match(/owner to postgres/g)).toHaveLength(4);
    expect(source.match(/from public,anon,authenticated,service_role;/g)).toHaveLength(2);
    expect(source).not.toMatch(/^grant /im);
    expect(source).not.toMatch(/\b(delete from|truncate|auth\.users|auth\.identities|encrypted_password|http_post|dblink)\b/i);
    expect(source).not.toContain('FINAL_VERIFIED');
  });
  it('checks identity twice, live R1/control/drain and exact payload-to-receipt CAS before insert', () => {
    expect(source.match(/perform private.assert_reset_receipt_identity\(p_actor,p_auth,p_session,p_binding\)/g)).toHaveLength(2);
    for (const required of ["control.reauth_ttl_seconds<>300", "challenge.state<>'READY'", "challenge.action<>'RESET_REVIEW'",
      'private.operation_secret_digest(p_nonce)', 'challenge.password_version is distinct from public.get_auth_password_version(p_auth)',
      'completed_at is null', "state in ('auth_pending','inconsistent','reset_pending')", "state='prepared'",
      'p_binding->>\'expectedPostconditionFingerprint\' is distinct from postcondition_hash',
      'head.binding is distinct from p_binding', 'head.header is distinct from p_header',
      'head.head_hash is distinct from p_expected_head']) expect(source).toContain(required);
    expect(source.indexOf('RESET_TEMPLATE_HANDOVER_RECEIPT_CHANGED')).toBeLessThan(source.indexOf('insert into public.cleaning_template_versions'));
    expect(source).toContain("set lock_timeout='2s' set statement_timeout='7s'");
    expect(source).toContain("deadline timestamptz:=clock_timestamp()+interval '5 seconds'");
    expect(source.match(/clock_timestamp\(\)>=deadline/g)).toHaveLength(2);
  });
  it('uses DB clock provenance between STARTED and OBSERVED, preserving old data and atomic readback', () => {
    expect(source).toContain("registration_at:=date_trunc('milliseconds',clock_timestamp())");
    expect(source).toContain("'DATABASE_CLOCK_AFTER_STARTED_BEFORE_OBSERVED'");
    expect(source).toContain("'postconditionHash',postcondition_hash,'registrationTime',registration_time");
    expect(source).not.toContain("p_actor,(item->>'plannedAt')");
    expect(source).toContain("or t.created_at is distinct from p_registered_at");
    expect(source).toContain("value||'{\"status\":\"retired\"}'::jsonb");
    expect(source).toContain('actual->\'slots\'');
    expect(source).toContain("previous.photo_slots::text is distinct from (item#>'{content,slots}')::text");
    expect(source).toContain('t.photo_slots::text is distinct from previous.photo_slots::text');
    expect(source.indexOf("'draft',")).toBeLessThan(source.indexOf("set status='retired'"));
    expect(source.indexOf("set status='retired'")).toBeLessThan(source.indexOf("set status='published'"));
    expect(source.indexOf("'outcome','APPLIED'")).toBeGreaterThan(source.indexOf('perform private.assert_reset_template_handover_rows(p_payload,true,registration_at)'));
  });
  it('keeps activation independent from grants, environment or caller claimed proof', () => {
    const adapter = read('src/modules/developer-reset/template-handover-effect.ts');
    expect(adapter).toContain("status: 'ACTIVATION_REQUIRED'");
    expect(adapter).not.toMatch(/process\.env|prepared\.execute|consumeResetApproval|\.rpc\(/);
    expect(read(regression)).toContain('post-publication identity failure rolls back entire S1 transaction');
    expect(read(regression).trim()).toMatch(/rollback;$/);
  });
});
