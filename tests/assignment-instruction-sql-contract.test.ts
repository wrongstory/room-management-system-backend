import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(name, 'utf8').replaceAll('\r\n', '\n');
const file = '20261030143048_assignment_instruction_memo.sql';
const sql = read(`supabase/migrations/${file}`);
const fixture = read('supabase/tests/assignment_instruction_memo.sql');
const require = createRequire(import.meta.url);
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('Expected exact SQL source component is missing');
  return value;
};
const between = (start: string, end: string) => sql.split(start)[1]?.split(end)[0] ?? '';
const original = (name: string, functionName: string) => {
  const source = read(`supabase/migrations/${name}`);
  const body = source.split(`function ${functionName}(`)[1];
  if (!body) throw new Error(`Missing source function ${functionName}`);
  return body.match(/\bas\s+(\$\w*\$)([\s\S]*?)\1/i)?.[2] ?? '';
};
const exactReplace = (source: string, old: string, replacement: string, name: string) => {
  expect(source.split(old).length - 1, name).toBe(1);
  return source.replace(old, replacement);
};
const dollarPatches = (source: string) => [...source.matchAll(/\$old\$([\s\S]*?)\$old\$\s*,\s*\$new\$([\s\S]*?)\$new\$/g)];

describe('#534 assignment instruction SQL source contracts (Full DB NOT RUN)', () => {
  it.each([15, 17])('parses SQL statements with PostgreSQL %i grammar without a database', async (version) => {
    const parser = require(`@pgsql/parser/v${version}`) as { parse(value: string): Promise<{ stmts: unknown[] }> };
    expect((await parser.parse(sql)).stmts.length).toBeGreaterThan(20);
    expect((await parser.parse(fixture)).stmts.length).toBeGreaterThan(45);
    // PL/pgSQL strings are not executed or fully validated by this parser.
  });

  it('preserves pre-migration nulls and consumes the inheritance marker before storage', () => {
    expect(sql).toContain('add column instruction_memo text;');
    expect(sql.indexOf('add column instruction_memo text;')).toBeLessThan(sql.indexOf("set default '';"));
    expect(sql).not.toMatch(/add column instruction_memo[^;]*default/i);
    const guard = between('create function private.guard_assignment_instruction()', 'end $$;');
    expect(guard).toContain("if tg_op='UPDATE' then");
    expect(guard).toContain('new.instruction_memo is distinct from old.instruction_memo');
    expect(guard).toContain('ASSIGNMENT_SNAPSHOT_IMMUTABLE');
    expect(guard.indexOf('for update')).toBeLessThan(guard.indexOf("if new.instruction_memo=''"));
    expect(guard).toContain('a.cleaning_target_id=new.cleaning_target_id and a.revision<new.revision');
    expect(guard).toContain('order by a.revision desc limit 1');
    expect(guard).not.toMatch(/instruction_memo\s+is\s+not\s+null/i);
    expect(sql).toContain('char_length(instruction_memo) between 1 and 500');
    expect(sql).not.toMatch(/update public\.cleaning_assignments set instruction_memo|disable trigger|truncate|delete from/i);
  });

  it('counts raw UTF16 before exact JavaScript trimming and keeps quantity instructions valid', () => {
    const normalize = between('create function private.normalize_assignment_instruction', 'end $$;');
    expect(normalize.indexOf('units>500')).toBeLessThan(normalize.indexOf('normalized:=nullif(btrim'));
    expect(normalize).toContain('ascii(substr(p_value,i,1))>65535');
    const whitespace = normalize.match(/U&'([^']+)'/)?.[1] ?? '';
    const decoded = whitespace.replaceAll(/\\([0-9A-F]{4})/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
    expect(decoded.length).toBe(25);
    for (const char of decoded) expect(char.trim()).toBe('');
    for (const char of ['\u0085', '\u180e', '\u200b']) expect(decoded).not.toContain(char);
    expect(normalize).toContain('$email$');
    expect(normalize).toContain('$phone$');
    expect(normalize).toContain('$pin$');
    expect(normalize).not.toContain("~ '[0-9@:/]'");
  });

  it('matches every read projection patch exactly once against its current baseline source', () => {
    const origins: Record<string, string> = {
      'public.save_cleaning_assignment_draft': '20260904144209_planned_checkout_targets.sql',
      'private.prestart_assignment_projection': '20260904154536_assignment_prestart_change.sql',
      'private.assignment_target_read_rows': '20261002074234_assignment_target_read_metadata.sql',
      'private.commit_and_notify_assignments_at': '20260904144209_planned_checkout_targets.sql',
      'public.get_current_cleaning_attempt': '20260908110343_attempt_execution_core.sql',
      'public.get_limited_cleaning_attempt': '20260908123214_attempt_handover_limited_capability.sql',
      'public.get_cleaning_attempt_lifecycle_impact': '20260908123214_attempt_handover_limited_capability.sql',
    };
    const patch = between('do $projection$', 'end $projection$;');
    const rows = [...patch.matchAll(/\('([^']+)'\s*,\s*\$old\$([\s\S]*?)\$old\$\s*,\s*\$new\$([\s\S]*?)\$new\$/g)];
    expect(rows).toHaveLength(7);
    for (const [, signature, old, replacement] of rows) {
      const name = required(required(signature).split('(')[0]);
      let source = original(required(origins[name]), name);
      if (name === 'private.commit_and_notify_assignments_at') {
        const metadata = read('supabase/migrations/20261002074234_assignment_target_read_metadata.sql');
        const patchSource = required(required(metadata.split("('private.commit_and_notify_assignments_at(")[1]).split("('private.assignment_preview_snapshot_at(")[0]);
        const [, before, after] = required(dollarPatches(patchSource)[0]);
        source = exactReplace(source, required(before), required(after), 'existing metadata patch');
      }
      exactReplace(source, required(old), required(replacement), required(signature));
    }
    expect(patch).toContain("to_jsonb(p)-'prosrc'");
    expect(patch).toContain('ASSIGNMENT_INSTRUCTION_CATALOG_DRIFT');
  });

  it('clones only known insert points while keeping actor replay CAS and receipt hashes', () => {
    let draft = original('20260904144209_planned_checkout_targets.sql', 'public.save_cleaning_assignment_draft');
    for (const [, old, replacement] of dollarPatches(between('do $draft$', 'end $draft$;'))) {
      draft = exactReplace(draft, required(old), required(replacement), 'draft explicit memo insert');
    }
    expect(draft).toContain('private.normalize_assignment_instruction(p_instruction_memo)');
    expect(draft.indexOf('private.assert_room_admin')).toBeLessThan(draft.indexOf('private.replay_command'));
    expect(draft.indexOf('return v_response;')).toBeLessThan(draft.indexOf('insert into public.cleaning_assignments'));
    expect(draft).toContain('v_target.assignment_version <> p_expected_assignment_version');
    expect(draft).toContain('where id in (p_actor_profile_id,p_maid_profile_id) order by id for share');
    expect(draft.split('private.assert_room_admin(p_actor_profile_id)').length - 1).toBe(2);
    expect(draft).toContain("'assignment.save_draft',\n    p_idempotency_key,\n    p_request_hash");
    const start = original('20260916210000_reservation_during_stay_room_move.sql', 'private.assignment_prestart_command');
    const block = between('do $prestart$', 'end $prestart$;');
    const old = block.match(/old_text:=\$old\$([\s\S]*?)\$old\$/)?.[1] ?? '';
    const replacement = block.match(/new_text:=\$new\$([\s\S]*?)\$new\$/)?.[1] ?? '';
    const changed = exactReplace(start, old, replacement, 'latest prestart insert');
    expect(changed).toContain('private.normalize_assignment_instruction(p_instruction_memo)');
    expect(block).toContain("oid='private.assignment_prestart_command_for_plan(");
    const lock = block.match(/lock_text:=\$lock\$([\s\S]*?)\$lock\$/)?.[1] ?? '';
    expect(start.split(lock).length - 1).toBe(1);
    expect(block).toContain('where id=p_actor for share;');
    expect(changed).toContain('ASSIGNMENT_ALREADY_STARTED');
    expect(changed).toContain('t.assignment_version<>p_version or a.id<>p_assignment');
    expect(changed).toContain('private.complete_command(p_actor,cmd,p_key,p_hash,entity,response)');
    expect(sql).not.toMatch(/set_config\(|app\.instruction|create function public\.[^(]+\([^;]*p_instruction_memo text default/i);
  });

  it('keeps memo out of base execution audit, notifications, and historical receipt hydration', () => {
    const patch = between('do $projection$', 'end $projection$;');
    expect(patch).not.toContain("('private.attempt_execution_projection(");
    expect(patch).toContain("case when nullif(row->>'assignmentId','') is null then '{}'::jsonb else");
    expect(sql).toContain('a.cleaning_target_id=p_target_id and a.id=p_assignment_id');
    expect(sql).toContain('a.id=p_attempt.assignment_id and a.revision=p_attempt.assignment_revision');
    expect(sql).toContain('a.cleaning_target_id=p_attempt.cleaning_target_id and a.maid_profile_id=p_attempt.maid_profile_id');
    expect(sql).not.toMatch(/insert into public\.(audit_events|notifications)|update private\.command_executions/i);
    const prestart = original('20260916210000_reservation_during_stay_room_move.sql', 'private.assignment_prestart_command');
    expect(required(prestart.split('summary:=')[1]).split('perform private.complete_command')[0]).not.toContain('instruction');
    const commit = original('20260904144209_planned_checkout_targets.sql', 'private.commit_and_notify_assignments_at');
    expect(required(commit.split('insert into public.audit_events')[1]).split('v_notified :=')[0]).not.toContain('v_notified');
    expect(sql).toContain('grant select(instruction_memo) on public.cleaning_assignments to authenticated;');
    expect(sql).not.toMatch(/create policy|alter policy|grant (?:all|update|insert|delete)\b/i);
  });

  it('covers old writer inserts using the default rather than an unsafe whole-row clone', () => {
    const files = readdirSync('supabase/migrations').filter((name) => name.endsWith('.sql') && name < file);
    let inserts = 0;
    for (const name of files) {
      const source = read(`supabase/migrations/${name}`);
      for (const match of source.matchAll(/insert\s+into\s+public\.cleaning_assignments\b([^;]*);/gi)) {
        inserts++;
        const insert = required(match[1]);
        expect(insert.trimStart().startsWith('('), name).toBe(true);
        const columns = insert.slice(0, insert.indexOf(')'));
        expect(columns, name).not.toContain('instruction_memo');
        expect(match[1], name).not.toMatch(/select\s+(?:\w+\.)?\*/i);
      }
    }
    expect(inserts).toBeGreaterThan(15);
    expect(sql).not.toContain('create table');
    expect(fixture).toContain('midnight reassignment preserves instruction');
    expect(fixture).toContain('old receipt replays original text after later edits');
    expect(fixture).toContain('notified memo-only change appends revision');
    expect(fixture).toContain('other maid cannot read instruction');
    expect(fixture.trimEnd()).toMatch(/rollback;$/);
  });
});
