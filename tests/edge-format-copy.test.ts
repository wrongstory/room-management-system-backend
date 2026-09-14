import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const scriptPath = '../scripts/check-edge-functions.mjs';
const { withLfFormatCopy } = await import(scriptPath);

describe('Edge format gate uses disposable LF copies without changing source bytes', () => {
  it('retains relative paths and non-newline formatting, with cleanup on success and failure', () => {
    const base = resolve(realpathSync(process.cwd()), '.tmp');
    mkdirSync(base, { recursive: true });
    const fixture = mkdtempSync(resolve(base, 'edge-format-test-'));
    const cleanup = () => {
      if (dirname(fixture) !== base || !basename(fixture).startsWith('edge-format-test-') || realpathSync(fixture) !== fixture) throw new Error('Unsafe test cleanup target');
      rmSync(fixture, { recursive: true, force: false });
    };
    const source = resolve(fixture, 'nested/source.ts');
    mkdirSync(dirname(source), { recursive: true });
    const raw = 'const  deliberatelyBadSpacing=1;\r\n';
    writeFileSync(source, raw);
    let temporary = '';
    try {
      for (const failure of [false, true]) {
        const run = () => withLfFormatCopy(['nested/source.ts'], (copy: string) => {
          temporary = copy;
          expect(readFileSync(resolve(copy, 'nested/source.ts'), 'utf8')).toBe('const  deliberatelyBadSpacing=1;\n');
          if (failure) throw new Error('synthetic Deno fmt rejection');
          return 'checked';
        }, fixture);
        if (failure) expect(run).toThrow('synthetic Deno fmt rejection');
        else expect(run()).toBe('checked');
        expect(existsSync(temporary)).toBe(false);
        expect(readFileSync(source, 'utf8')).toBe(raw);
      }
      expect(() => withLfFormatCopy(['../outside.ts'], () => {}, fixture)).toThrow('Unsafe format source path');
      expect(() => withLfFormatCopy([source], () => {}, fixture)).toThrow('Unsafe format source path');
    } finally {
      cleanup();
    }
  });
});
