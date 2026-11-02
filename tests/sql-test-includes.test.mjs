import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = realpathSync(resolve('supabase/tests'));
const sql = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const inside = path => {
  const location = relative(root, path);
  return location !== '..' && !location.startsWith('../') && !location.startsWith('..\\') && !isAbsolute(location);
};

describe('Supabase SQL test include files (no database execution)', () => {
  it('resolves all psql includes within the directory mounted by supabase test db', () => {
    const pending = readdirSync(root).filter(name => name.endsWith('.sql')).map(name => resolve(root, name));
    const visited = new Set();
    while (pending.length) {
      const path = pending.pop();
      if (visited.has(path)) continue;
      visited.add(path);
      for (const match of sql(path).matchAll(/^\s*\\(ir|i|include_relative|include)\s+(.+?)\s*$/gm)) {
        expect(match[1], `${relative(root, path)} must resolve from the containing SQL file`).toMatch(/^(ir|include_relative)$/);
        const argument = match[2].replace(/^(['"])(.*)\1$/, '$2');
        expect(argument, 'include paths must be literal relative paths').not.toMatch(/[`:$]/);
        const target = resolve(dirname(path), argument);
        expect(inside(target), `${relative(root, path)} includes an unmounted path: ${argument}`).toBe(true);
        expect(statSync(target).isFile(), argument).toBe(true);
        expect(inside(realpathSync(target)), 'include symlinks cannot escape the test mount').toBe(true);
        pending.push(target);
      }
    }
    expect(visited.size).toBeGreaterThan(0);
  });

  it('keeps the bundled availability migration identical to the immutable source', () => {
    expect(sql(resolve(root, 'availability_guard_unused_parameter_migration.psql'))).toBe(
      sql(resolve('supabase/migrations/20261101235415_availability_guard_unused_parameter.sql')),
    );
  });
});
