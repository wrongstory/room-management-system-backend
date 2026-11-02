import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { indexAssignmentSchedules, summarizeAssignmentRollover } from '../src/modules/assignments/assignment-schedule-core.js';

interface Evidence { cleaning_target_id: string; revision: number; reason_code: string }
interface Card { targetId: string; revision: number; cap: number }
const rolloverReasonCodes = new Set(['ROLLED_OVER_UNASSIGNED', 'ROLLED_OVER_NOT_STARTED']);
export function fixture(cards: number, revisions: number, shared = false) {
  const targets = shared ? 1 : cards;
  const rows: Evidence[] = Array.from({ length: targets * revisions }, (_, i) => ({
    cleaning_target_id: String(Math.floor(i / revisions)),
    revision: revisions - i % revisions,
    reason_code: i % 3 === 0 ? 'RESERVATION_CHANGED' : 'ROLLED_OVER_NOT_STARTED'
  }));
  const requests: Card[] = Array.from({ length: cards }, (_, i) => ({
    targetId: String(shared ? 0 : i), revision: shared ? i % revisions + 1 : revisions, cap: revisions
  }));
  return { rows, requests };
}
export function legacy(input: ReturnType<typeof fixture>) {
  return input.requests.map(card => {
    const evidence = input.rows.filter(row => row.cleaning_target_id === card.targetId &&
      row.revision <= card.revision &&
      rolloverReasonCodes.has(row.reason_code))
      .sort((a, b) => b.revision - a.revision);
    const rolloverCount = Math.min(card.cap, evidence.length);
    return { rolloverCount, rolloverReason: rolloverCount === 0 ? null : evidence[0]?.reason_code ?? null };
  });
}
export function optimized(input: ReturnType<typeof fixture>) {
  // Include per-request index construction in the measured cost.
  const index = indexAssignmentSchedules(input.rows);
  return input.requests.map(card =>
    summarizeAssignmentRollover(index.get(card.targetId) ?? [], card.targetId, card.revision, card.cap));
}
function measure(run: () => unknown) {
  for (let i = 0; i < 5; i++) run();
  const samples = Array.from({ length: 21 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  }).sort((a, b) => a - b);
  return { p50Ms: Number(samples[10]?.toFixed(3)), p95Ms: Number(samples[19]?.toFixed(3)) };
}
export function benchmark() {
  return [[1, 1, false], [100, 10, false], [1000, 10, false], [1000, 1000, true]].map(values => {
    const [cards, revisions, shared] = values as [number, number, boolean];
    const input = fixture(cards, revisions, shared);
    assert.deepEqual(optimized(input), legacy(input));
    return { cards, revisions, shared, evidenceRows: input.rows.length,
      legacy: measure(() => legacy(input)), optimized: measure(() => optimized(input)) };
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify({ scope: 'synthetic CPU only; no DB/network; not production latency',
    node: process.version, warmup: 5, samples: 21, results: benchmark() }, null, 2));
}
