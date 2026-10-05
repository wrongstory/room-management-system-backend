import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const original = new URL('../supabase/migrations/20261004232901_admin_registered_report_read.sql', import.meta.url);
const append = new URL('../supabase/migrations/20261005003351_admin_registered_report_fresh_session_guard.sql', import.meta.url);
const sqlTests = new URL('../supabase/tests/admin_registered_report_fresh_session_guard.sql', import.meta.url);
const oldCall = 'private.assert_attempt_actor_session(';
const newCall = 'private.assert_attempt_actor_session_fresh(';
const lf = (value: string) => value.replaceAll('\r\n', '\n');
const hash = (algorithm: string, value: string) => createHash(algorithm).update(value).digest('hex');

describe('#332 narrow fresh-session integration append', () => {
  it('keeps original SQL exact and changes only one call in the installed body', async () => {
    const source = lf(await readFile(original, 'utf8'));
    expect(hash('sha256', source)).toBe('83541ca1f351b8e6d830cb8e4c2b13e9a58e338c58284854fe4105fa37f938e3');
    const body = /as \$\$([\s\S]*?)\$\$;/.exec(source)?.[1];
    expect(body).toBeDefined();
    expect(body?.split(oldCall)).toHaveLength(2);
    expect(hash('md5', body ?? '')).toBe('5244a78ce24b971106cae3d7bd49d46b');
    const expected = (body ?? '').replace(oldCall, newCall);
    expect(hash('md5', expected)).toBe('5981a7d9c2d1a4ecba51c45bb4f04ffb');
    expect(expected.replace(newCall, oldCall)).toBe(body);
    expect(source).not.toMatch(/language plpgsql stable/i);
  });

  it('fails closed on dependency/source/attribute drift and preserves every non-body catalog field', async () => {
    const source = lf(await readFile(append, 'utf8'));
    for (const code of ['DEPENDENCY_MISSING', 'DEPENDENCY_DRIFT', 'SOURCE_DRIFT', 'DEFINITION_DRIFT', 'CONTRACT_DRIFT']) {
      expect(source).toContain(`ADMIN_REPORT_FRESH_GUARD_${code}`);
    }
    expect(source).toContain("p.provolatile='v' and p.prosecdef");
    expect(source).toContain("p.proconfig=array['search_path=\"\"']::text[]");
    expect(source).toContain("to_jsonb(p)-'prosrc'");
    expect(source).toContain("to_jsonb(p)-'prosrc'=original_contract");
    expect(source).toContain('p.prosrc=replace(original_body,old_call,new_call)');
    expect(source).toContain('execute replace(definition,old_call,new_call);');
    expect(source).toContain('5244a78ce24b971106cae3d7bd49d46b');
    expect(source).toContain('5981a7d9c2d1a4ecba51c45bb4f04ffb');
    expect(source.match(/\bexecute\s+/gi)).toHaveLength(1);
    expect(source).not.toMatch(/\b(?:create\s+(?:or\s+replace\s+)?function|alter|drop|grant|revoke|insert|update|delete|truncate)\b/i);
  });

  it('includes rollback-only real fresh/snapshot boundary and unchanged original submatrix tests', async () => {
    const source = lf(await readFile(sqlTests, 'utf8'));
    expect(source.trimStart()).toMatch(/^begin;/);
    expect(source.trimEnd()).toMatch(/select \* from finish\(\);\s*rollback;$/);
    expect(source).toContain('with expired as materialized(select pg_temp.rfexpire() changed)');
    expect(source).toContain('private.assert_attempt_actor_session(pg_temp.rfid(1),pg_temp.rfid(201),true)');
    expect(source).toContain('public.list_room_reports_page(pg_temp.rfid(1),pg_temp.rfid(201),pg_temp.rfroom())');
    expect(source).toContain("not_after=clock_timestamp()-interval '1 microsecond'");
    expect(source).toContain('count(*)=6');
    expect(source).toContain('count(*)=18');
    expect(source).toContain('set local role service_role;');
    expect(source).toContain('set local role anon;');
    expect(source).toContain('set local role authenticated;');
    expect(source).not.toContain('pg_sleep');
    expect(source).not.toContain('session_replication_role');
  });
});
