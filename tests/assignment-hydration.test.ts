import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { loadAssignmentHydration, parseAssignmentHydration } from '../src/modules/assignments/assignment-hydration.js';

const binding = { id: 'assignment-1', cleaning_target_id: 'target-1', maid_profile_id: 'maid-1' };
const pack = (rows: Record<string, unknown>[]) => ({ rows, count: rows.length });
function first<T>(rows: T[]): T {
  const row = rows[0]; if (row === undefined) throw new Error('Fixture row missing'); return row;
}
function fixture(bindings = [binding]) {
  return {
    assignments: structuredClone(bindings),
    targets: pack([...new Set(bindings.map(row => row.cleaning_target_id))].map(id => ({ id }))),
    profiles: pack([...new Set(bindings.map(row => row.maid_profile_id))].map(id => ({ id }))),
    attempts: pack(bindings.map(row => ({ id: `attempt-${row.id}`, assignment_id: row.id, attempt_number: 1, status: 'scheduled', started_at: null }))),
    submissions: pack([]), schedules: pack([]),
  };
}

describe('bounded assignment hydration', () => {
  it.each([1, 100, 1000])('loads %i bindings with bounded RPCs and deduplicates shared relations', async size => {
    const bindings = Array.from({ length: size }, (_, i) => ({ ...binding, id: `assignment-${i}` }));
    const read = vi.fn(async ids => fixture(bindings.filter(row => ids.includes(row.id))));
    const result = await loadAssignmentHydration(bindings, read);
    expect(read).toHaveBeenCalledTimes(Math.ceil(size / 100));
    expect(read.mock.calls.every(([ids]) => ids.length <= 100)).toBe(true);
    expect(result.targets).toHaveLength(1);
    expect(result.profiles).toHaveLength(1);
    expect(result.attempts).toHaveLength(size);
  });
  it('retains every attempt, orders latest display evidence, and never mutates the payload', () => {
    const payload = fixture();
    payload.attempts = pack([
      { id: 'old', assignment_id: binding.id, attempt_number: 1, status: 'superseded', started_at: '2026-10-01T00:00:00Z' },
      { id: 'new', assignment_id: binding.id, attempt_number: 2, status: 'scheduled', started_at: null },
    ]);
    payload.submissions = pack([
      { cleaning_attempt_id: 'new', version: 1, status: 'superseded' },
      { cleaning_attempt_id: 'new', version: 2, status: 'submitted' },
    ]);
    const before = structuredClone(payload);
    const result = parseAssignmentHydration(payload, [binding]);
    expect(result.attempts.map(row => row.id)).toEqual(['new', 'old']);
    expect(result.submissions.map(row => row.version)).toEqual([2, 1]);
    expect(payload).toEqual(before);
  });
  it.each(['targets', 'profiles', 'attempts', 'submissions', 'schedules'] as const)('rejects unknown, truncated, and excessive %s counts', relation => {
    for (const count of [null, -1, 1001, 0.5]) {
      const data = fixture();
      Object.assign(data[relation], { count });
      expect(() => parseAssignmentHydration(data, [binding])).toThrow();
    }
    const data = fixture();
    data[relation].count++;
    expect(() => parseAssignmentHydration(data, [binding])).toThrow();
  });
  it('accepts exactly 1000 related rows and rejects duplicates and cross-scope evidence', () => {
    const data = fixture();
    data.schedules = pack(Array.from({ length: 1000 }, (_, i) => ({ cleaning_target_id: binding.cleaning_target_id, revision: i + 1 })));
    expect(parseAssignmentHydration(data, [binding]).schedules).toHaveLength(1000);
    for (const mutate of [
      (value: ReturnType<typeof fixture>) => { value.assignments = []; },
      (value: ReturnType<typeof fixture>) => { first(value.assignments).maid_profile_id = 'other'; },
      (value: ReturnType<typeof fixture>) => { first(value.targets.rows).id = 'other'; },
      (value: ReturnType<typeof fixture>) => { first(value.attempts.rows).assignment_id = 'other'; },
      (value: ReturnType<typeof fixture>) => { value.submissions = pack([{ cleaning_attempt_id: 'old', version: 1 }]); },
      (value: ReturnType<typeof fixture>) => { value.schedules = pack([{ cleaning_target_id: 'other', revision: 1 }]); },
      (value: ReturnType<typeof fixture>) => { value.attempts.rows.push(first(value.attempts.rows)); value.attempts.count++; },
      (value: ReturnType<typeof fixture>) => { Object.assign(value, { currentDeparture: {} }); },
    ]) {
      const changed = fixture(); mutate(changed);
      expect(() => parseAssignmentHydration(changed, [binding])).toThrow();
    }
  });
  it('rejects shared display drift, duplicate requests, oversized lists, and a later batch failure', async () => {
    const bindings = Array.from({ length: 101 }, (_, i) => ({ ...binding, id: `assignment-${i}` }));
    let call = 0;
    await expect(loadAssignmentHydration(bindings, async ids => {
      const data = fixture(bindings.filter(row => ids.includes(row.id)));
      Object.assign(first(data.targets.rows), { status: ++call === 1 ? 'notified' : 'cancelled' });
      return data;
    })).rejects.toThrow();
    const read = vi.fn();
    await expect(loadAssignmentHydration([binding, binding], read)).rejects.toThrow();
    await expect(loadAssignmentHydration(Array.from({ length: 1001 }, (_, i) => ({ ...binding, id: `${i}` })), read)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled();
    await expect(loadAssignmentHydration(bindings, async ids => {
      if (ids.length === 1) throw new Error('late failure');
      return fixture(bindings.filter(row => ids.includes(row.id)));
    })).rejects.toThrow('late failure');
  });
  it('keeps the 100-distinct-target history cap when assignment batches split shared targets', async () => {
    const bindings = Array.from({ length: 101 }, (_, i) => ({ ...binding, id: `assignment-${i}`, cleaning_target_id: `target-${i === 100 ? 10 : i % 10}` }));
    const run = (lastCount: number) => loadAssignmentHydration(bindings, async ids => {
      const batch = bindings.filter(row => ids.includes(row.id));
      const data = fixture(batch);
      data.schedules = pack([...new Set(batch.map(row => row.cleaning_target_id))].flatMap(target =>
        Array.from({ length: target === 'target-10' ? lastCount : 90 }, (_, i) => ({ cleaning_target_id: target, revision: i + 1 }))));
      return data;
    });
    expect((await run(100)).schedules).toHaveLength(1000);
    await expect(run(101)).rejects.toThrow();
  });
  it('keeps Node/Edge protocol identical and SQL source narrow without claiming SQL execution', () => {
    const normalize = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
    expect(normalize('src/modules/assignments/assignment-hydration.ts')).toBe(normalize('supabase/functions/_shared/assignment-hydration.ts'));
    const sql = normalize('supabase/migrations/20261025020616_assignment_card_hydration.sql');
    expect(sql).toContain("stable security definer set search_path=''");
    expect(sql).toContain('p_actor_profile_id,p_session_id,p_assignment_ids,false,p_expected_actor_role');
    expect(sql).toContain('a.attempt_number,a.status,a.started_at');
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain('to service_role;');
    expect(sql).toContain('>1000 then');
    expect(sql.match(/limit 1001/g)).toHaveLength(5);
    expect(sql).not.toMatch(/\b(insert into|update public|delete from|create policy|reservation_schedule_snapshot)\b/i);
  });
});
