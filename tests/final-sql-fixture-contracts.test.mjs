// AST/source checks only. These never connect to PostgreSQL or execute SQL.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.ts';
const { Parser } = createRequire(import.meta.url)('@pgsql/parser');
const parser = new Parser({ version: 17 });
const files = ['db_static_warning_remediation_fixture.psql', 'developer_operation_reauth.sql',
  'developer_reset_preview.sql', 'developer_reset_receipt_store.sql', 'developer_template_handover_effect.sql',
  'limited_existing_session_discovery.sql', 'operation_offline_resolution_admission.sql',
  'photo_collection_upload_batch.sql', 'post_approval_room_issue_ledger.sql',
  'reservation_room_change_before_checkin.sql', 'room_ready_correction.sql',
  'room_status_admin_correction.sql', 'work_history.sql'];
const source = name => readFileSync(`supabase/tests/${name}`, 'utf8').replaceAll('\r\n', '\n');
const parse = text => parser.parse(text.replace(/^\s*\\[^\n]*$/gm, ''));
for (const name of files) it(`Postgres17 AST parses ${name} without database execution`, async () => {
  expect((await parse(source(name))).stmts.length).toBeGreaterThan(0);
});
it('keeps all 43 batch oracles and adds a real final rollback oracle outside savepoints', async () => {
  const sql = source('photo_collection_upload_batch.sql');
  const ast = await parse(sql);
  const names = ast.stmts.map(s => s.stmt?.SelectStmt?.targetList?.[0]?.ResTarget?.val?.FuncCall?.funcname?.at(-1)?.String?.sval);
  expect(names.filter(n => ['ok', 'is', 'isnt', 'lives_ok', 'throws_ok'].includes(n))).toHaveLength(44);
  const tail = sql.slice(sql.lastIndexOf('rollback to session;'));
  expect(tail.indexOf('select is(pg_temp.batch_savepoint_state()')).toBeLessThan(tail.indexOf('select * from finish()'));
  expect(tail).toContain('batch_savepoint_before');
  expect(sql).toContain('select no_plan()');
  expect(sql).not.toMatch(/select plan\(/);
});
it('isolates password provenance mutation with the expected rejection subtransaction', () => {
  const sql = source('operation_offline_resolution_admission.sql');
  expect(sql).toMatch(/throws_ok\(\$q\$do \$password_case\$ begin[\s\S]*update auth.users[\s\S]*perform pg_temp.offline_admission_complete\(6\)[\s\S]*P9999[\s\S]*end \$password_case\$;\$q\$/);
  expect(sql).not.toContain('offline_password_before');
  expect(sql).toContain('exact terminal remains observable after maintenance starts');
});
it('preserves developer protection and rollback checks without disabling their triggers', () => {
  for (const name of ['developer_reset_preview.sql', 'developer_reset_receipt_store.sql', 'developer_template_handover_effect.sql']) {
    const sql = source(name);
    expect(sql).toContain("'23514','DEVELOPER_ACCOUNT_PROTECTED'");
    expect(sql).not.toMatch(/disable trigger|session_replication_role/i);
  }
  expect(source('developer_reset_receipt_store.sql')).toContain('failed transaction also rolls back injected identity change');
  expect(source('developer_template_handover_effect.sql')).toContain('failed publication preserves every template column');
});
it('captures one minute-aligned reservation clock and preserves original ready conflict oracle', () => {
  const sql = source('room_ready_correction.sql');
  expect(sql).toContain("date_trunc('minute',clock_timestamp()) at_time");
  expect(sql).not.toMatch(/clock_timestamp\(\)\s*[+-]interval '(1 day|1 hour|2 days)'/);
  expect(sql).toContain("'CLEANING_DUE_REPLAN_REQUIRED'");
});
it('pins the SQL audit census to the exact public OpenAPI enum size and approved additions', () => {
  const types = openApiDocument.components.schemas.DeveloperAuditEventType.enum;
  expect(new Set(types).size).toBe(types.length);
  const sql = source('room_status_admin_correction.sql');
  const expectedCount = Number(sql.match(/cardinality\(private\.developer_audit_event_types\(\)\)=(\d+)/)[1]);
  expect(expectedCount).toBe(types.length);
  for (const type of ['assignment.unavailability_cancelled', 'room.ready_corrected']) {
    expect(types).toContain(type);
    expect(sql).toContain(`'${type}'`);
  }
});
it('removes status from the extracted JSON row rather than subtracting from the JSON index', async () => {
  const ast = await parse(source('developer_template_handover_effect.sql'));
  const statement = ast.stmts.find(s => JSON.stringify(s).includes('retirement changes no other historical template field'));
  const expression = statement.stmt.SelectStmt.targetList[0].ResTarget.val.FuncCall.args[1]
    .SubLink.subselect.SelectStmt.targetList[0].ResTarget.val.A_Expr;
  expect(expression.name.at(-1).String.sval).toBe('-');
  expect(expression.lexpr.A_Expr.name.at(-1).String.sval).toBe('->');
});
