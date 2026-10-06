import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
const modulePath = '../scripts/read-reset-catalog.mjs';
const { summarizeResetCatalog, readLocalResetCatalog, readLocalResetAccounts, readLocalResetReferenceFixture } = await import(modulePath);

function catalog() {
  return {
    format: 'reset-catalog-v1', readOnly: true,
    relations: [
      { name: 'public.profiles', kind: 'r', rls: true, forceRls: false },
      { name: 'public.rooms', kind: 'r', rls: true, forceRls: false },
    ],
    foreignKeys: [{ source: 'public.profiles', target: 'auth.users', name: 'profiles_auth_fkey',
      definition: 'FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT' }],
    triggers: [{ relation: 'public.profiles', name: 'guard', enabled: 'O',
      definitionHash: 'a'.repeat(32), functionHash: 'b'.repeat(32) }],
  };
}
function runner() {
  const spawn = vi.fn()
    .mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify('npipe:////./pipe/docker_engine') })
    .mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify({
      name: '/supabase_db_room-management-system-backend', running: true,
      project: 'room-management-system-backend',
      ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] },
    }) })
    .mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify(catalog()) });
  const read = vi.fn((path: string | URL) => String(path).endsWith('config.toml')
    ? 'project_id = "room-management-system-backend"\n[db]\nport = 54322'
    : readFileSync(new URL('../scripts/reset-catalog.sql',import.meta.url),'utf8'));
  return { spawn, read, env: {}, args: [] };
}
describe('local-only reset catalog diagnostic', () => {
  it('rejects synthetic fixture target overrides before any writes', () => {
    const deps = runner();
    expect(() => readLocalResetReferenceFixture({ ...deps, args: ['--remote'] })).toThrow('RESET_CATALOG_REJECTED');
    expect(() => readLocalResetReferenceFixture({ ...deps, env: { DOCKER_HOST: 'remote' } })).toThrow('RESET_CATALOG_REJECTED');
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it('limits fixture DDL and data to session-local temporary relations', () => {
    const sql = readFileSync(new URL('../scripts/reset-reference-fixture.sql', import.meta.url), 'utf8');
    expect(sql.match(/CREATE TEMP TABLE/g)).toHaveLength(2);
    expect(sql.match(/ON COMMIT DROP/g)).toHaveLength(2);
    expect(sql.match(/INSERT INTO pg_temp\./g)).toHaveLength(2);
    expect(sql).toContain('ROLLBACK;');
    expect(sql).toContain('pg_get_constraintdef');
    expect(sql).not.toMatch(/\b(?:FROM|JOIN|INTO|REFERENCES)\s+(?:public|private|auth)\./i);
    expect(sql).not.toMatch(/\b(?:DELETE|UPDATE|TRUNCATE|ALTER|CREATE TABLE)\b/i);
  });
  it('keeps the account reader on the same fixed local target and fixed SQL', () => {
    const deps = runner();
    deps.read.mockImplementation((path: string | URL) => String(path).endsWith('config.toml')
      ? 'project_id = "room-management-system-backend"\n[db]\nport = 54322'
      : readFileSync(path, 'utf8'));
    // Reuse the validated context/container responses, replacing only the SQL result.
    const original = deps.spawn;
    let call = 0;
    const spawn = vi.fn((...args: unknown[]) => {
      if (++call < 3) return original(...args);
      return { status: 0, stderr: '', stdout: JSON.stringify({
        format: 'reset-accounts-v2', readOnly: true, profiles: 0, developers: 0,
        eligibleDevelopers: 0, resetCandidates: 0, otherProfiles: 0,
        developerAuthLinks: 0, developerLoginAliases: 0, developerPasswordVersions: 0,
        developerAliasRows: 0, missingAuthLinks: 0, unlinkedAuthUsers: 0,
        unresolvedPasswordChanges: 0, preparedPasswordResets: 0,
        developerCrossAccountMarkers: 0, developerCommandLinks: 0,
      }) };
    });
    expect(readLocalResetAccounts({ ...deps, spawn })).toMatchObject({
      necessaryConditionsMet: false, executionEnabled: false,
    });
    expect(spawn.mock.calls[2]?.[1]).toEqual(expect.arrayContaining([
      readFileSync(new URL('../scripts/reset-accounts.sql', import.meta.url), 'utf8'),
      '/var/run/postgresql', 'supabase_db_room-management-system-backend',
    ]));
  });
  it('rejects account-reader target overrides before connecting', () => {
    const deps = runner();
    expect(() => readLocalResetAccounts({ ...deps, args: ['--remote'] })).toThrow('RESET_CATALOG_REJECTED');
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it('reads the fixed local socket and never returns names or permission to reset', () => {
    const deps = runner();
    const result = readLocalResetCatalog(deps);
    expect(result).toMatchObject({
      executionEnabled: false, classificationComplete: false, relationCount: 2,
      unclassifiedRelationCount: 0, missingRelationCount: 181, crossSchemaForeignKeyCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('profiles');
    const call = deps.spawn.mock.calls[2];
    expect(call?.[1]).toEqual(expect.arrayContaining([
      '--context','default','exec','supabase_db_room-management-system-backend',
      '-h','/var/run/postgresql','-XqAt','ON_ERROR_STOP=1',
    ]));
    expect(call?.[2]).toMatchObject({ shell: false, windowsHide: true, timeout: 15000 });
  });
  it.each(['DOCKER_HOST','DOCKER_CONTEXT','DOCKER_TLS_VERIFY','DOCKER_CERT_PATH'])('rejects %s overrides before connecting', (key) => {
    const deps = runner();
    expect(() => readLocalResetCatalog({ ...deps, env: { [key]: 'remote' } })).toThrow('RESET_CATALOG_REJECTED');
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it('rejects CLI target overrides', () => {
    const deps = runner();
    expect(() => readLocalResetCatalog({ ...deps, args: ['--remote'] })).toThrow('RESET_CATALOG_REJECTED');
    expect(deps.spawn).not.toHaveBeenCalled();
  });
  it('rejects a remote persisted Docker context before container access', () => {
    const deps = runner();
    deps.spawn.mockReset().mockReturnValue({ status: 0, stderr: '', stdout: '"tcp://remote:2376"' });
    expect(() => readLocalResetCatalog(deps)).toThrow('RESET_CATALOG_REJECTED');
    expect(deps.spawn).toHaveBeenCalledTimes(1);
  });
  it('rejects the wrong container before SQL', () => {
    const deps = runner();
    deps.spawn.mockReset()
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: '"npipe:////./pipe/docker_engine"' })
      .mockReturnValueOnce({ status: 0, stderr: '', stdout: JSON.stringify({
        name: '/wrong_project', running: true, project: 'wrong_project', ports: {},
      }) });
    expect(() => readLocalResetCatalog(deps)).toThrow('RESET_CATALOG_REJECTED');
    expect(deps.spawn).toHaveBeenCalledTimes(2);
  });
  it('rejects missing mandatory application relations', () => {
    const c = catalog(); c.relations = c.relations.filter((r) => r.name !== 'public.rooms');
    expect(() => summarizeResetCatalog(c)).toThrow('RESET_CATALOG_REJECTED');
  });
  it('rejects unrelated foreign keys outside the inventory', () => {
    const c = catalog();
    c.foreignKeys = c.foreignKeys.map((f) => ({ ...f, source: 'auth.identities', target: 'auth.users' }));
    expect(() => summarizeResetCatalog(c)).toThrow('RESET_CATALOG_REJECTED');
  });
  it.each([
    { status: 1, stderr: 'sensitive details', stdout: '' },
    { status: 0, stderr: 'sensitive warning', stdout: '' },
    { status: null, signal: 'SIGTERM', stderr: '', stdout: '' },
    { status: 0, error: new Error('sensitive error'), stderr: '', stdout: '' },
  ])('sanitizes process failures', (failure) => {
    const deps = runner();
    deps.spawn.mockReset().mockReturnValue(failure);
    expect(() => readLocalResetCatalog(deps)).toThrow(/^RESET_CATALOG_REJECTED$/);
  });
  it('uses a read-only bounded transaction and catalog-only SQL', () => {
    const sql = readFileSync(new URL('../scripts/reset-catalog.sql',import.meta.url),'utf8');
    expect(sql).toContain('REPEATABLE READ READ ONLY');
    expect(sql).toContain("statement_timeout = '10s'");
    expect(sql).toContain('ROLLBACK;');
    expect(sql).not.toMatch(/\b(?:DELETE FROM|INSERT INTO|UPDATE public|TRUNCATE|DROP TABLE|CREATE TABLE)\b/i);
    expect(sql).not.toMatch(/\bFROM\s+(?:public|private|auth)\./i);
  });
  it('produces a stable fingerprint for reordered catalog rows', () => {
    const c = catalog(); const before = summarizeResetCatalog(c);
    c.relations.reverse();
    expect(summarizeResetCatalog(c)).toEqual(before);
  });
  it('fingerprints changed trigger code without exposing it', () => {
    const c = catalog(); const before = summarizeResetCatalog(c);
    c.triggers = c.triggers.map((t) => ({ ...t, functionHash: 'c'.repeat(32) }));
    expect(summarizeResetCatalog(c).catalogFingerprint).not.toBe(before.catalogFingerprint);
  });
  it.each(['readOnly','format','relations','foreignKeys','triggers'])('rejects missing %s', (key) => {
    const c: Record<string, unknown> = catalog(); delete c[key];
    expect(() => summarizeResetCatalog(c)).toThrow('RESET_CATALOG_REJECTED');
  });
  it('rejects duplicate relations and foreign-key identities', () => {
    const c = catalog();
    c.relations = [...c.relations,...c.relations];
    expect(() => summarizeResetCatalog(c)).toThrow('RESET_CATALOG_REJECTED');
    const d = catalog(); d.foreignKeys = [...d.foreignKeys,...d.foreignKeys];
    expect(() => summarizeResetCatalog(d)).toThrow('RESET_CATALOG_REJECTED');
  });
  it('rejects orphan trigger metadata', () => {
    const c = catalog(); c.triggers = c.triggers.map((t) => ({ ...t, relation: 'private.unknown' }));
    expect(() => summarizeResetCatalog(c)).toThrow('RESET_CATALOG_REJECTED');
  });
  it('marks foreign tables unsupported rather than querying their data', () => {
    const c = catalog(); c.relations.push({ name: 'private.remote', kind: 'f', rls: false, forceRls: false });
    expect(summarizeResetCatalog(c)).toMatchObject({ unsupportedRelationCount: 1, executionEnabled: false });
  });
});
