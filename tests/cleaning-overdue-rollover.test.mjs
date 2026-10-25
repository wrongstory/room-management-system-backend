import { describe, expect, it } from 'vitest';
import { assertOverdueRollover } from '../scripts/test-cleaning-overdue-concurrency.mjs';

function fixture() {
  const before = { id: 'target', status: 'unassigned', assignment_version: 1, carryover_count: 0,
    updated_at: '2026-10-13T14:00:00Z', original_service_date: '2026-10-13',
    effective_service_date: '2026-10-13', available_from: '2026-10-12T15:00:00Z',
    due_at: '2026-10-13T15:00:00Z', room_id: 'room', fee_snapshot: 16000,
    template_snapshot: { version: 9 }, created_by: 'admin' };
  const after = { ...structuredClone(before), assignment_version: 2, carryover_count: 1,
    updated_at: '2026-10-13T15:01:00Z' };
  const evidence = { audits: 1, matchingAudits: 1, revisions: 1, matchingRevisions: 1,
    assignments: 0, attempts: 0, rolloverNotices: 0 };
  const results = Array.from({ length: 8 }, (_, index) => ({ error: null, data: {
    overdueCount: index === 0 ? 1 : 0, rolledOverCount: index === 0 ? 1 : 0,
    rolloverResults: index === 0 ? [{ cleaningTargetId: 'target', status: 'rolledOver',
      targetAssignmentVersion: 2, carryoverCount: 1 }] : []
  } }));
  return { before, after, evidence, results };
}
const verify = f => assertOverdueRollover(f.before, f.after, f.evidence, f.results);

describe('overdue scheduler midnight contract (pure, no DB)', () => {
  it('permits only the one approved rollover across eight responses', () => {
    const f = fixture();
    expect(() => verify(f)).not.toThrow();
    f.results.reverse();
    expect(() => verify(f)).not.toThrow();
  });
  it.each(['id', 'status', 'original_service_date', 'effective_service_date', 'available_from',
    'due_at', 'room_id', 'fee_snapshot', 'template_snapshot', 'created_by'])('rejects mutation of %s', field => {
    const f = fixture();
    f.after[field] = 'changed';
    expect(() => verify(f)).toThrow();
  });
  it.each(['assignment_version', 'carryover_count'])('rejects missing or duplicate %s increment', field => {
    for (const delta of [0, 2]) {
      const f = fixture();
      f.after[field] = f.before[field] + delta;
      expect(() => verify(f)).toThrow();
    }
  });
  it.each(Object.keys(fixture().evidence))('rejects missing, duplicate or mismatched evidence: %s', field => {
    const f = fixture();
    f.evidence[field] += 1;
    expect(() => verify(f)).toThrow();
    f.evidence[field] -= 2;
    expect(() => verify(f)).toThrow();
  });
  it('rejects invalid timestamp, missing columns and newly introduced mutations', () => {
    for (const change of [f => { f.after.updated_at = 'invalid'; },
      f => { f.after.updated_at = '2025-01-01'; }, f => { delete f.after.room_id; },
      f => { f.after.unexpected = true; }]) {
      const f = fixture(); change(f);
      expect(() => verify(f)).toThrow();
    }
  });
  it('rejects RPC errors, malformed bounds, duplicate or absent transition results', () => {
    for (const change of [f => { f.results[1].error = {}; },
      f => { f.results[1].data.overdueCount = 101; },
      f => { f.results[1].data.overdueCount = -1; },
      f => { f.results[1].data.rolloverResults = null; },
      f => { f.results[1].data.rolledOverCount = 1; },
      f => { f.results[1] = structuredClone(f.results[0]); },
      f => { f.results[0] = structuredClone(f.results[1]); },
      f => { f.results[0].data.rolloverResults[0].targetAssignmentVersion = 3; },
      f => { f.results.pop(); }]) {
      const f = fixture(); change(f);
      expect(() => verify(f)).toThrow();
    }
  });
});
