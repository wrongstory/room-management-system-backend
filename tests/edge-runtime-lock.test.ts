import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { generateEdgeRuntimeLock, validateEdgeRuntimeLock } from '../scripts/generate-edge-runtime-lock.mjs';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const runtime = JSON.parse(await readFile(new URL('../supabase/functions/deno.lock', import.meta.url), 'utf8'));
const validation = JSON.parse(await readFile(new URL('../supabase/functions/post-approval-report.deno.lock', import.meta.url), 'utf8'));
describe('#400 execution and validation dependency boundaries', () => {
  it('seeds reviewed lock bytes before a frozen verification and cleans only its temporary lock', () => {
    const original = readFileSync(new URL('../supabase/functions/deno.lock', import.meta.url));
    let temporaryLock = '';
    vi.mocked(spawnSync).mockImplementationOnce((_command, args, options) => {
      const argv = args as string[];
      expect(argv).toContain('--frozen');
      expect(argv).not.toContain('--frozen=false');
      temporaryLock = resolve(String(options?.cwd), argv[argv.indexOf('--lock') + 1] ?? '');
      expect(readFileSync(temporaryLock)).toEqual(original);
      return { status: 0, signal: null, output: [], pid: 1, stdout: '', stderr: '' };
    });
    generateEdgeRuntimeLock(true);
    expect(temporaryLock).not.toBe('');
    expect(existsSync(temporaryLock)).toBe(false);
    expect(readFileSync(new URL('../supabase/functions/deno.lock', import.meta.url))).toEqual(original);
  });
  it('keeps all runtime dependencies identical to the frozen validation graph', () => {
    expect(() => validateEdgeRuntimeLock(runtime, validation)).not.toThrow();
    expect(Object.keys(runtime.npm)).toHaveLength(9);
    expect(validation.npm).toHaveProperty('zod@4.4.3');
    expect(validation.npm).toHaveProperty('@types/node@22.5.4');
    expect(validation.npm).toHaveProperty('undici-types@6.19.8');
  });
  it.each(['zod@4.4.3', '@types/node@22.5.4', 'undici-types@6.19.8', 'unknown@1.0.0'])('rejects non-runtime VFS package %s', name => {
    const candidate = structuredClone(runtime);
    candidate.npm[name] = validation.npm[name] ?? { integrity: 'sha512-synthetic' };
    expect(() => validateEdgeRuntimeLock(candidate, validation)).toThrow();
  });
  it('rejects omitted packages, changed integrity, extra specifiers and workspace dependencies', () => {
    for (const mutate of [
      (value: typeof runtime) => { delete value.npm['tslib@2.8.1']; },
      (value: typeof runtime) => { value.npm['tslib@2.8.1'].integrity = 'sha512-changed'; },
      (value: typeof runtime) => { value.specifiers['npm:zod@4.4.3'] = '4.4.3'; },
      (value: typeof runtime) => { value.workspace.dependencies.push('npm:zod@4.4.3'); }
    ]) {
      const candidate = structuredClone(runtime); mutate(candidate);
      expect(() => validateEdgeRuntimeLock(candidate, validation)).toThrow();
    }
  });
  it('retains frozen source/type/tests and verifies actual runtime lock before bundling', async () => {
    const source = (await readFile(new URL('../scripts/check-edge-functions.mjs', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
    expect(source).toContain("['scripts/generate-edge-runtime-lock.mjs', '--check']");
    const check = source.slice(source.indexOf("runDeno([\n  'check'"));
    expect(check).toMatch(/'check',[\s\S]*?'--frozen',[\s\S]*?'--lock',[\s\S]*?'supabase\/functions\/post-approval-report.deno.lock'/);
    expect(check).toMatch(/'test',[\s\S]*?'--frozen',[\s\S]*?'--lock',[\s\S]*?'supabase\/functions\/post-approval-report.deno.lock'/);
    expect(check).toContain('verifyEdgeBundle();');
    expect(check).toContain('verifyPostApprovalReportEdgeBundle();');
  });
});
