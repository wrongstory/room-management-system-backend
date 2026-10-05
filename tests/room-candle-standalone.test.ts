import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../scripts/test-room-candle-concurrency.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const cli = source.slice(source.indexOf('// Import callers own their fixture.'));

describe('#330 standalone disposable fixture', () => {
  it('imports without creating fixtures or resetting the aggregate DB', async () => {
    const module = await import(new URL('../scripts/test-room-candle-concurrency.mjs', import.meta.url).href);
    expect(typeof module.testRoomCandleConcurrency).toBe('function');
    expect(cli).toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
  });
  it('checks local identity before creating the developer and maid fixtures', () => {
    for (const key of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'SUPABASE_WORKDIR', 'SUPABASE_CLI_BINARY_OVERRIDE']) expect(cli).toContain(key);
    expect(cli).toContain('validateLocalDockerEndpoint(');
    expect(cli.indexOf('assertLimitedConcurrencyFreshIdentity(await freshIdentity(), manifest);')).toBeLessThan(cli.indexOf('cleanupRequired = true;'));
    expect(cli.indexOf('cleanupRequired = true;')).toBeLessThan(cli.indexOf('insert into auth.users'));
    expect(cli.indexOf("'developer','active',false")).toBeLessThan(cli.indexOf('await testRoomCandleConcurrency();'));
  });
  it('always cleans only a verified disposable DB, and verifies it after reset', () => {
    expect(cli).toContain('finally {\n    if (cleanupRequired)');
    expect(cli).toContain("[cli, 'db', 'reset', '--local', '--no-seed']");
    expect(cli.match(/assertLimitedConcurrencyFreshIdentity\(await freshIdentity\(\), manifest\);/g)).toHaveLength(2);
    expect(cli).toContain('timeout: 120000');
    expect(cli).not.toMatch(/console\.(?:log|error)\((?:error|manifest|config)/);
  });
});
