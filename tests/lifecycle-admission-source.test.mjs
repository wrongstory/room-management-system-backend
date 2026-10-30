import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { admissionRouteRows, generateAdmissionSql } from '../scripts/generate-operation-admission-sql.mjs';
const require = createRequire(import.meta.url);
const read = file => readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
const sourceFile = 'supabase/migrations/20261025081701_operation_lifecycle_admission.sql';
const source = read(sourceFile);
const routes = JSON.parse(read('src/modules/developer-reset/http-admission-routes.json'));

describe('source137 finite lifecycle admission', () => {
  it('preserves source130 exact bytes and all other route policies', () => {
    const original = read('supabase/migrations/20261025032719_operation_admission_authority.sql');
    expect(createHash('sha256').update(original).digest('hex')).toBe('03d67e06609adad00d72805332c53dc550000145368f428e21f2168bc6ca2b43');
    expect(generateAdmissionSql(routes, read('scripts/operation-admission.sql.in'))).toBe(original);
    expect(routes.filter(r => r.completionAdapter === 'LIFECYCLE_V137')).toHaveLength(1);
    expect(routes.filter(r => r.hashMode === 'NONE' && !r.completionAdapter)).toHaveLength(25);
    expect(routes.filter(r => ['CALLER', 'SQL_AVAILABILITY'].includes(r.hashMode))).toHaveLength(66);
  });
  it.each(['value', 'route', 'kind', 'authority', 'hashMode', 'rpc', 'key'])('rejects %s tag substitution without changing historical generation', field => {
    const changed = structuredClone(routes); const r = changed.find(r => r.completionAdapter);
    if (field === 'value') r.completionAdapter = 'TRUST_RESPONSE';
    if (field === 'route') { delete r.completionAdapter; changed[0].completionAdapter = 'LIFECYCLE_V137'; }
    if (field === 'kind') r.kind = 'AUTH_WRITE';
    if (field === 'authority') r.authority = 'LIMITED_SESSION';
    if (field === 'hashMode') r.hashMode = 'CALLER';
    if (field === 'rpc') r.rpc = 'arbitrary_rpc';
    if (field === 'key') r.keyArgument = 'p_idempotency_key_digest';
    expect(() => admissionRouteRows(changed)).toThrow('ADMISSION_MANIFEST_INVALID');
  });
  it('has only the three reviewed public actions and reuses atomic source130 acquire and completion', () => {
    const actions = [...source.matchAll(/when '([^']+)' then 'cleaning\.lifecycle\.([^']+)'/g)].map(m => [m[1], m[2]]);
    expect(actions).toEqual(['allow_finish', 'allow_upload', 'interrupt_handover'].map(a => [a, a]));
    expect(source).not.toContain('expire_scheduled');
    expect(source).toContain("p_actor,p_auth,p_session,p_nonce,p_deadline,null,null,null,null");
    expect(source).toContain('http_key_digest=private.operation_secret_digest(p_idempotency_key)');
    expect(source).toContain('http_request_hash=p_request_hash');
    expect(source.match(/private\.assert_attempt_actor_session_fresh\(/g)).toHaveLength(2);
    expect(source).not.toMatch(/\b(?:create table|delete from|truncate|disable trigger|execute format)\b/i);
    expect(source).not.toContain('create or replace');
  });
  it.each(['v15', 'v17'])('parses migration and prepared rollback-only fixture using %s (no execution)', async version => {
    const parser = require(`@pgsql/parser/${version}`);
    for (const path of [sourceFile, 'supabase/tests/operation_lifecycle_admission.sql']) {
      const parsed = await parser.parse(read(path)); expect(parsed.stmts.length).toBeGreaterThanOrEqual(3);
    }
  });
});
