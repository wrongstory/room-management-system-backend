import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const read = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const sha = text => createHash('sha256').update(text).digest('hex');
const migration = read('supabase/migrations/20261104211056_finite_service_role_authority.sql');
const parser = createRequire(import.meta.url)('@pgsql/parser/v17');
const history = ['room_occupancy_events', 'room_pin_sync_events', 'room_candle_events',
  'cleaning_target_schedule_revisions', 'reservation_schedule_revisions'];

describe('#586 finite authority (DB-free; actual SQL behavior NOT RUN)', () => {
  it('preserves the exact 149-entry history and binds append150', () => {
    const manifest = JSON.parse(read('supabase/migration-manifest.dev.json'));
    expect(manifest.totalCount).toBe(150);
    expect(sha(JSON.stringify(manifest.migrations.slice(0, 149))))
      .toBe('1211a6f45eacfa88b1522126a6d6efc986eb368a7541872fc881578695f6e554');
    expect(manifest.migrations[149].sha256).toBe(sha(migration));
    expect(manifest.head).toBe('finite_service_role_authority');
  });

  it('parses exactly four restricted service-only REVOKEs between two guards', async () => {
    const parsed = await parser.parse(migration);
    expect(parsed.stmts.map(s => Object.keys(s.stmt)[0]))
      .toEqual(['DoStmt', 'GrantStmt', 'GrantStmt', 'GrantStmt', 'GrantStmt', 'DoStmt']);
    const contracts = [
      ['OBJECT_TABLE', history, ['update', 'references', 'trigger', 'maintain']],
      ['OBJECT_TABLE', ['assignment_change_requests'], ['references', 'trigger', 'maintain']],
      ['OBJECT_TABLE', ['availability_candidates'], ['insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain']],
      ['OBJECT_SEQUENCE', ['complaint_case_events_id_seq'], ['select', 'usage', 'update']],
    ];
    let count = 0;
    for (const [i, [kind, objects, privileges]] of contracts.entries()) {
      const statement = parsed.stmts[i + 1].stmt.GrantStmt;
      expect(statement.is_grant ?? false).toBe(false);
      expect(statement.grant_option ?? false).toBe(false);
      expect(statement.targtype).toBe('ACL_TARGET_OBJECT');
      expect(statement.objtype).toBe(kind);
      expect(statement.behavior).toBe('DROP_RESTRICT');
      expect(statement.grantees.map(g => [g.RoleSpec.roletype, g.RoleSpec.rolename]))
        .toEqual([['ROLESPEC_CSTRING', 'service_role']]);
      expect(statement.objects.map(o => [o.RangeVar.schemaname, o.RangeVar.relname]))
        .toEqual(objects.map(name => ['public', name]));
      expect(statement.privileges.map(p => p.AccessPriv)).toEqual(privileges.map(priv_name => ({ priv_name })));
      count += objects.length * privileges.length;
    }
    expect(count).toBe(33);
  });

  it('guards concrete identity, inherited and column rights without changing other policy', () => {
    expect(migration).toContain("current_user <> 'postgres'");
    expect(migration).toContain("pg_get_userbyid(c.relowner)='postgres'");
    expect(migration).toContain("a.attidentity='a'");
    expect(migration).toContain("d.objsubid=0 and d.deptype='i'");
    expect(migration).toContain("pg_get_serial_sequence('public.complaint_case_events','id')::regclass=d.objid");
    expect(migration).toContain("has_any_column_privilege('service_role','public.'||v.name,p)");
    expect(migration).toContain("array['REFERENCES','TRIGGER','MAINTAIN','DELETE','TRUNCATE']");
    expect(migration).toContain('FINITE_AUTHORITY_BUSINESS_PRIVILEGE_MISSING');
    const bodies = [...migration.matchAll(/do \$guard\$([\s\S]*?)\$guard\$;/g)].map(m => m[1]);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body).not.toMatch(/\b(?:execute|insert|update|delete|truncate|grant|revoke|alter|create|setval|nextval)\s+(?:into|on|table|schema|role|sequence|function|default|['"])/i);
  });

  it.each(['finite_service_role_authority.sql', 'complaint_lifecycle.sql', 'assignment_prestart_change.sql'])
    ('parses prepared regression %s using PG17 grammar', async file => {
      const sql = read(`supabase/tests/${file}`).replace(/^\\ir .*$/gm, '');
      expect((await parser.parse(sql)).stmts.length).toBeGreaterThan(10);
      // SQL grammar parsing does not execute or fully validate PL/pgSQL bodies.
    });

  it('keeps denial tests nonvacuous and preserves sequence-safe business coverage', () => {
    const assignment = read('supabase/tests/assignment_prestart_change.sql');
    for (const name of history) {
      expect(assignment).toContain(`update public.${name} set id=id$$,'42501'`);
      expect(assignment).toContain(`${name} all rows and fields preserved`);
    }
    expect(assignment).toContain("jsonb_array_length(rows)>0");
    expect(assignment).toContain("decision=>'rejected'");
    const complaint = read('supabase/tests/complaint_lifecycle.sql');
    expect(complaint).toContain("set local role service_role;\ninsert into complaint_results values('authority33',public.create_complaint_case(");
    expect(complaint).toContain('normal complaint append generates one identity');
    expect(complaint).toContain('prior complaint events retain all rows and fields');
    expect(complaint).not.toMatch(/select\s+(?:pg_catalog\.)?(?:setval|nextval)\(/i);
  });
});
