import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('fresh Edge candidate build preparation', () => {
  it('prepares and verifies ignored photo assets before checking the full candidate module', async () => {
    const script = await readFile(new URL('../scripts/check-edge-functions.mjs', import.meta.url), 'utf8');
    const main = script.slice(script.indexOf('function main() {'));
    const assets = main.indexOf("['scripts/generate-photo-edge.mjs', ...args]");
    const tests = main.indexOf("runDeno(['test'");
    const module = main.indexOf("'supabase/functions/_shared/post-approval-module-runtime.deno.ts'");
    expect(main).toContain("for (const args of [['--assets-only'], ['--check']])");
    expect(assets).toBeGreaterThan(0);
    expect(tests).toBeGreaterThan(assets);
    expect(module).toBeGreaterThan(tests);
  });
  it('verifies the data-only Swagger candidate before runtime tests and Deno typechecking', async () => {
    const script = await readFile(new URL('../scripts/check-edge-functions.mjs', import.meta.url), 'utf8');
    const main = script.slice(script.indexOf('function main() {'));
    expect(script).toContain("'supabase/functions/_shared/post-approval-openapi.ts'");
    const spec = main.indexOf("['--import', 'tsx', 'scripts/generate-post-approval-openapi.ts', '--check']");
    expect(spec).toBeGreaterThan(0);
    expect(main.indexOf("runDeno(['test'")).toBeGreaterThan(spec);
    expect(main).toContain("if (reportSpec.status !== 0) throw new Error('Report generated data-only OpenAPI verification failed')");
  });
});
