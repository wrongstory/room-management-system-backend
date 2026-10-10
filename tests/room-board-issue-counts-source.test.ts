import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const read = async (name: string) => (await readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const initial = await read('20261004231650_room_board_date_filters.sql');
const compatibility = await read('20261004231704_room_board_live_projection_compatibility.sql');
const patch = await read('20261010153508_room_board_issue_counts_single_scan.sql');
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
// Reconstruct only the reviewed four literal patches. No subprocess, SQL or DB execution.
const initialSource = initial.split('create function public.get_room_board_projection(')[1]?.split('as $$')[1]?.split('$$;')[0];
if (!initialSource) throw new Error('ROOM_BOARD_SOURCE_MISSING');
const replacements = [...compatibility.matchAll(/jsonb_build_array\(\s*'([^']*)',\s*(E)?'((?:[^']|'')*)'\)/g)];
const decode = (value: string, escaped?: string) => {
  const quotes = value.replace(/''/g, "'");
  return escaped ? quotes.replace(/\\n/g, '\n') : quotes;
};
// The fourth replacement also has an E-prefixed first argument.
const fourth = compatibility.match(/jsonb_build_array\(\s*E'((?:[^']|'')*)',\s*E'((?:[^']|'')*)'\)/);
if (!fourth) throw new Error('ROOM_BOARD_COMPATIBILITY_PATCH_MISSING');
let currentSource = initialSource;
for (const match of replacements) currentSource = currentSource.replace(String(match[1]), decode(String(match[3]), match[2]));
currentSource = currentSource.replace(decode(String(fourth[1]), 'E'), decode(String(fourth[2]), 'E'));
const literal = (name: string, tag: string) => {
  const value = patch.split(`${name} constant text := $${tag}$`)[1]?.split(`$${tag}$;`)[0];
  if (!value) throw new Error(`MISSING_PATCH_${name}`);
  return value;
};
const beforeCounts = literal('old_counts', 'before'), afterCounts = literal('new_counts', 'after');
const beforeJoin = literal('old_join', 'before'), afterJoin = literal('new_join', 'after');

describe('#416 issue aggregate source only; real SQL/plan/ACL NOT RUN', () => {
  it('pins the exact baseline and applies only two unique replacements', () => {
    expect(md5(initialSource)).toBe('7a4ca74a6410734ac72b251a2cf6c418');
    expect(replacements).toHaveLength(3);
    expect(md5(currentSource)).toBe('dbcb3d36a8ee29447ca04854b6ad8909');
    expect(patch).toContain(md5(currentSource));
    for (const fragment of [beforeCounts, beforeJoin]) expect(currentSource.split(fragment)).toHaveLength(2);
    const next = currentSource.replace(beforeCounts, afterCounts).replace(beforeJoin, afterJoin);
    expect(next.replace(afterCounts, beforeCounts).replace(afterJoin, beforeJoin)).toBe(currentSource);
    expect(next).not.toContain('private.room_board_issue_count_at(');
    expect(next.match(/from public.room_issues issue/g)).toHaveLength(1);
    expect(next).toContain('perform private.assert_attempt_actor_session(');
    expect(next).toContain('v_server_time timestamptz := statement_timestamp();');
  });
  it('keeps the time boundary, aggregate row for empty rooms and no writes/grants', () => {
    expect(afterJoin).toContain('count(*)::integer as issue_count');
    expect(afterJoin).toContain('count(*) filter (where issue.blocks_guest_assignment)::integer');
    expect(afterJoin).toContain('issue.reported_at <= v_evaluated_at');
    expect(afterJoin).toContain('issue.resolved_at is null or issue.resolved_at > v_evaluated_at');
    expect(afterJoin).not.toMatch(/group by|issue\.status|limit /i);
    expect(patch).toContain('after_catalog is distinct from before_catalog');
    expect(patch).not.toMatch(/^\s*(grant|revoke|insert|update|delete|create index|alter table)\b/im);
  });
});
