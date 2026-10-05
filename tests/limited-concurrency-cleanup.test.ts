import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const { assertLimitedConcurrencyFreshIdentity, limitedConcurrencyFreshIdentitySQL } =
  await import(new URL('../scripts/test-limited-existing-session-concurrency.mjs', import.meta.url).href) as {
    assertLimitedConcurrencyFreshIdentity(value: unknown, manifest: unknown): void;
    limitedConcurrencyFreshIdentitySQL: string;
  };
const manifest = { totalCount: 104, head: 'photo_collection_provider_context_axis' };
const fresh = () => ({ authUsers: 0, profiles: 0, targets: 0, operations: 0,
  historyCount: manifest.totalCount, head: manifest.head });
const source = readFileSync(new URL('../scripts/test-limited-existing-session-concurrency.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

describe('#329 standalone local concurrency fixture cleanup', () => {
  it('accepts the exact fresh manifest identity without running a DB/reset on import', () => {
    expect(() => assertLimitedConcurrencyFreshIdentity(fresh(), manifest)).not.toThrow();
    expect(limitedConcurrencyFreshIdentitySQL).toContain('supabase_migrations.schema_migrations');
  });
  it.each(['authUsers', 'profiles', 'targets', 'operations'])('rejects leftover %s fixture rows', (field) => {
    expect(() => assertLimitedConcurrencyFreshIdentity({ ...fresh(), [field]: 1 }, manifest)).toThrow();
  });
  it.each([
    { ...fresh(), historyCount: 103 }, { ...fresh(), head: 'unexpected_head' },
    { ...fresh(), authUsers: '0' }, { ...fresh(), head: null },
    { ...fresh(), unexpected: 0 }, null,
  ])('rejects manifest/type/shape drift %#', (value) => {
    expect(() => assertLimitedConcurrencyFreshIdentity(value, manifest)).toThrow();
  });
  it.each([{ totalCount: 0, head: manifest.head }, { totalCount: 104.5, head: manifest.head },
    { totalCount: 104, head: 'unsafe;head' }])('rejects malformed expected identity %#', (value) => {
    expect(() => assertLimitedConcurrencyFreshIdentity(fresh(), value)).toThrow();
  });
  it('keeps reset inside explicit CLI-only finally and only after fresh target verification', () => {
    const cliOnly = source.slice(source.indexOf('// Safe import for the aggregate runner;'));
    expect(cliOnly).toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
    expect(cliOnly.indexOf('assertLimitedConcurrencyFreshIdentity(freshIdentity(), manifest);')).toBeLessThan(cliOnly.indexOf('cleanupRequired = true;'));
    expect(cliOnly).toContain("finally {\n    if (cleanupRequired)");
    expect(cliOnly).toContain("[cli, 'db', 'reset', '--local', '--no-seed']");
    expect(cliOnly.match(/assertLimitedConcurrencyFreshIdentity\(freshIdentity\(\), manifest\);/gu)).toHaveLength(2);
    for (const variable of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'SUPABASE_WORKDIR', 'SUPABASE_CLI_BINARY_OVERRIDE']) expect(cliOnly).toContain(variable);
    expect(cliOnly).toContain('validateLocalDockerEndpoint(');
    expect(cliOnly).not.toMatch(/console\.(?:log|error)\((?:status|error|manifest)/u);
  });
});
