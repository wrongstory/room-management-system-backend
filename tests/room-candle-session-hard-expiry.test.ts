import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const original = readFileSync(new URL('../supabase/migrations/20261005011849_shared_room_candle_adjustment.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const migration = readFileSync(new URL('../supabase/migrations/20261005011912_room_candle_session_hard_expiry.sql', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const runner = readFileSync(new URL('../scripts/test-room-candle-concurrency.mjs', import.meta.url), 'utf8');
const fixture = readFileSync(new URL('../supabase/tests/room_candle_session_hard_expiry.sql', import.meta.url), 'utf8');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const occurrences = (value: string, part: string) => value.split(part).length - 1;
const call = 'private.assert_room_candle_actor(p_actor_profile_id,p_session_id)';
function body(name: string): string {
  const after = original.split(`create function ${name}(`);
  expect(after).toHaveLength(2);
  return after[1]?.split('as $$')[1]?.split('$$;')[0] ?? '';
}
function fragment(tag: string): string {
  const parts = migration.split(`$${tag}$`);
  expect(parts).toHaveLength(3);
  return parts[1] ?? '';
}
const specs = [
  { name: 'private.assert_room_candle_actor', hash: '676fc8704e1eaa8f23c1ed8533fb847e', oldCalls: 0, newCalls: 0,
    replacements: [['declare actor public.profiles%rowtype;', 'declare actor public.profiles%rowtype; session_not_after timestamptz;'],
      [fragment('guard_before'), fragment('guard_after')]] },
  { name: 'public.set_room_candle_count', hash: '87e1a66ca14e3209747c189cb1b6de6d', oldCalls: 1, newCalls: 3,
    replacements: [[fragment('room_before'), fragment('room_after')], [fragment('receipt_before'), fragment('receipt_after')]] }
];
function patchSource(source: string, spec: typeof specs[number]): string {
  if (md5(source) !== spec.hash) throw new Error('SOURCE_DRIFT');
  if (occurrences(source, call) !== spec.oldCalls) throw new Error('CALL_DRIFT');
  let result = source;
  for (const [before, after] of spec.replacements) {
    if (!before || occurrences(result, before) !== 1) throw new Error('FRAGMENT_DRIFT');
    result = result.replace(before, after ?? '');
  }
  if (result === source || occurrences(result, call) !== spec.newCalls) throw new Error('DEFINITION_DRIFT');
  return result;
}
// Model only: demonstrates fail-closed source/attribute branches and atomic
// publication without executing PostgreSQL or claiming installed catalog proof.
function catalogModel(sources = specs.map((spec) => body(spec.name)), driftAt = -1, changedOid = false): string[] {
  const staged: string[] = [];
  for (const [index, spec] of specs.entries()) {
    if (index === driftAt) throw new Error('ATTRIBUTE_DRIFT');
    staged.push(patchSource(sources[index] ?? '', spec));
  }
  if (changedOid) throw new Error('CATALOG_CHANGED');
  return staged;
}

describe('#330 post-lock session hard-expiry append source contract', () => {
  it('preserves the exact original LF source and original function bodies', () => {
    expect(createHash('sha256').update(original).digest('hex')).toBe('0f2d86b199831e446a5a3d06a78caeca7ccad21b62223395224de94087734579');
    for (const spec of specs) {
      expect(md5(body(spec.name))).toBe(spec.hash);
      expect(migration).toContain(spec.hash);
      expect(occurrences(body(spec.name), call)).toBe(spec.oldCalls);
    }
  });
  it('patches only exact approved fragments while preserving unchanged command text', () => {
    const patched = catalogModel();
    for (const [index, spec] of specs.entries()) {
      let recovered = patched[index] ?? '';
      for (const [before, after] of [...spec.replacements].reverse()) recovered = recovered.replace(after ?? '', before ?? '');
      expect(recovered).toBe(body(spec.name));
    }
    const guard = patched[0] ?? '', command = patched[1] ?? '';
    expect(guard.indexOf('for share;\n  -- Evaluate')).toBeLessThan(guard.indexOf('session_not_after <= clock_timestamp()'));
    expect(guard).not.toContain('not_after > clock_timestamp()) for share');
    expect(command.indexOf('private.replay_command')).toBeLessThan(command.indexOf(call));
    expect(command.indexOf(call)).toBeLessThan(command.indexOf('if response is not null then return response;'));
    expect(command).toContain(fragment('room_after'));
    expect(command).toContain(fragment('receipt_after'));
    expect(occurrences(command, call)).toBe(3);
  });
  it.each([0, 1])('fails closed when function %i source drifts, without publishing a partial model', (index) => {
    const sources = specs.map((spec) => body(spec.name));
    const before = [...sources];
    sources[index] += '\n-- drift';
    expect(() => catalogModel(sources)).toThrow('SOURCE_DRIFT');
    expect(specs.map((spec) => body(spec.name))).toEqual(before);
  });
  it.each([0, 1])('rejects attribute drift for function %i before model publication', (index) => {
    expect(() => catalogModel(undefined, index)).toThrow('ATTRIBUTE_DRIFT');
  });
  it('rejects changed OID/catalog and missing or duplicated patch fragments', () => {
    expect(() => catalogModel(undefined, -1, true)).toThrow('CATALOG_CHANGED');
    const spec = specs[1];
    if (!spec) throw new Error('missing spec');
    expect(() => patchSource(body(spec.name), { ...spec, replacements: [['not an approved fragment', 'replacement']] })).toThrow('FRAGMENT_DRIFT');
    const duplicated = body(spec.name) + fragment('room_before');
    expect(() => patchSource(duplicated, { ...spec, hash: md5(duplicated) })).toThrow('FRAGMENT_DRIFT');
    expect(() => patchSource(body(spec.name), { ...spec, oldCalls: 2 })).toThrow('CALL_DRIFT');
  });
  it('makes PostgreSQL metadata/source checks atomic with no ACL or ledger rewrite', () => {
    expect(occurrences(migration, 'do $candle_session_patch$')).toBe(1);
    expect(migration).toContain("to_jsonb(p) - 'prosrc'");
    expect(migration).toContain('after_catalog is distinct from before_catalog');
    expect(migration).toContain("p.proowner <> 'postgres'::regrole");
    expect(migration).toContain("p.provolatile <> 'v'");
    expect(migration).toContain('p.proconfig is distinct from');
    expect(migration).toContain('patch.expected_acl');
    expect(migration).toContain('execute replace(definition, old_source, new_source)');
    expect(migration).not.toMatch(/\b(?:grant|revoke|drop|insert|update|delete|alter)\s+(?:all|table|function|into|public\.|private\.|auth\.)/i);
    expect(migration).not.toContain('exception when');
  });
  it('requires exact holder/contender PID edges live and expired before release, with no retry or skip', () => {
    expect(runner).toContain("hardExpiryRace('room'");
    expect(runner).toContain("hardExpiryRace('session'");
    expect(runner).toContain(`h.pid=\${holderPid} and c.pid=\${contenderPid}`);
    expect(runner).toContain('h.pid=any(pg_blocking_pids(c.pid))');
    expect(runner.indexOf('await observe(false);')).toBeLessThan(runner.indexOf('await observe(true);'));
    expect(runner.indexOf('await observe(true);')).toBeLessThan(runner.indexOf('const holderResult = await held.release();'));
    expect(runner).toContain("denied.error === 'SESSION_REVOKED'");
    expect(runner).toContain('await effects(room, actors) === before');
    expect(runner).toContain('setTimeout(() => { timedOut = true; child.kill(); }, 45000)');
    expect(runner).not.toMatch(/\.skip|continue;|not_after=clock_timestamp\(\)\+interval.*(?:retry|extend)/);
    expect(fixture).toContain('select * from finish();\nrollback;');
    expect(fixture).toContain('pg_temp.cestate()=before_state');
    expect(fixture).toContain('perform pg_sleep(3)');
    expect(fixture).not.toMatch(/update auth.sessions[^;]+new\./);
  });
  it('sanitizes known and unknown native errors without printing stderr or private detail', () => {
    const constants = runner.slice(runner.indexOf('const safeCodes ='), runner.indexOf('function assert('));
    expect(runInNewContext(`${constants}\nsafeError(input)`, { input: 'ERROR: SESSION_REVOKED\nDETAIL: synthetic-sensitive-value' })).toBe('SESSION_REVOKED');
    expect(runInNewContext(`${constants}\nsafeError(input)`, { input: 'ERROR: unknown synthetic-sensitive-value' })).toBe('DATABASE_TEST_FAILED');
    expect(runner).not.toMatch(/console\.(?:log|error).*stderr|throw error\b|stdio:\s*['"]inherit/);
  });
});
