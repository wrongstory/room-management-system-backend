import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { admissionRouteRows, generateAdmissionSql } from '../scripts/generate-operation-admission-sql.mjs';
const require = createRequire(import.meta.url);
const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const migration = 'supabase/migrations/20261030174256_operation_offline_resolution_admission.sql';
const routes = JSON.parse(read('src/modules/developer-reset/http-admission-routes.json'));

describe('source141 offline resolution terminal observation', () => {
  it('preserves historical route SQL and keeps the other 25 opaque protocols unresolved', () => {
    const original = read('supabase/migrations/20261025032719_operation_admission_authority.sql');
    expect(createHash('sha256').update(original).digest('hex')).toBe('03d67e06609adad00d72805332c53dc550000145368f428e21f2168bc6ca2b43');
    expect(generateAdmissionSql(routes, read('scripts/operation-admission.sql.in'))).toBe(original);
    expect(routes.filter(r => r.completionAdapter === 'OFFLINE_RESOLUTION_V141')).toHaveLength(1);
    expect(routes.filter(r => r.hashMode === 'NONE' && !r.completionAdapter)).toHaveLength(25);
    expect(routes.filter(r => ['CALLER', 'SQL_AVAILABILITY'].includes(r.hashMode))).toHaveLength(66);
  });
  it.each(['tag', 'route', 'rpc', 'aliases', 'binding', 'hash', 'authority', 'command'])('rejects %s adapter substitution', field => {
    const changed = structuredClone(routes); const r = changed.find(r => r.routeId === 'resolveOfflineQuarantine');
    if (field === 'tag') r.completionAdapter = 'TRUST_HTTP';
    if (field === 'route') r.routeId = 'inventedRoute';
    if (field === 'rpc') r.rpc = 'arbitrary_rpc';
    if (field === 'aliases') r.rpcAliases = ['arbitrary_rpc'];
    if (field === 'binding') r.bindings = { p_resolution: 'record_only' };
    if (field === 'hash') r.hashMode = 'CALLER';
    if (field === 'authority') r.authority = 'LIMITED_SESSION';
    if (field === 'command') r.commandName = 'untrusted.command';
    expect(() => admissionRouteRows(changed)).toThrow('ADMISSION_MANIFEST_INVALID');
  });
  it('only observes the existing terminal and changes the existing admission, not business ledgers', () => {
    const source = read(migration);
    expect(source).not.toMatch(/\b(?:create table|alter table|delete from|truncate|disable trigger|create or replace)\b/i);
    expect(source).not.toMatch(/\b(?:insert into|update)\s+(?:public\.|private\.offline_)/i);
    expect(source).toContain('r.actor_profile_id=p_actor and r.event_record_id=p_quarantine_id');
    expect(source).toContain('r.resolution=p_resolution and r.request_hash=v_admission.http_request_hash');
    expect(source).toContain('private.operation_secret_digest(r.idempotency_key)=v_admission.http_key_digest');
    expect(source).toContain('for share;');
    expect(source.match(/private\.assert_attempt_actor_session_fresh\(/g)).toHaveLength(4);
    expect(source).not.toContain('resolve_offline_quarantine_with_notifications_at(');
  });
  it('canonical service hash binds target, action, version and reason before admission captures the actual RPC', () => {
    const source = read('supabase/functions/_shared/attempt-offline-api.ts');
    expect(source).toContain('JSON.stringify({ actorProfileId: actor.profileId, action, input })');
    expect(source).toContain('quarantineId: uuid(id),\n    resolution,\n    expectedExecutionVersion: expectedVersion,\n    reasonCode: resolutionReasons[resolution]');
    expect(source).toContain('p_request_hash: await hash(actor, "resolve_offline", input)');
  });
  it.each(['v15', 'v17'])('parses append and prepared pgTAP with %s without database execution', async version => {
    const parser = require(`@pgsql/parser/${version}`);
    for (const path of [migration, 'supabase/tests/operation_offline_resolution_admission.sql']) {
      expect((await parser.parse(read(path))).stmts.length).toBeGreaterThanOrEqual(3);
    }
  });
});
