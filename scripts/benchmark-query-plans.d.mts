import type { spawnSync } from 'node:child_process';
import type { readFileSync } from 'node:fs';

export interface PlanSample {
  eventsPerRoom: number;
  cutoff: string;
  mode: string;
  sample: number;
  executionMs: number;
  planningMs: number;
  localHitBlocks: number;
  localReadBlocks: number;
  sortNodes: number;
  effectiveIndexUsed: boolean;
  extraIndexBytes: number;
  resultEquivalent: boolean;
}
export interface PlanEvidence {
  scope: string;
  serverVersion: string;
  rooms: number;
  results: PlanSample[];
}
export function validateBenchmarkSource(board: string, indexes: string): void;
export function summarizePlans(raw: string): PlanEvidence;
export function runBenchmark(options?: {
  env?: NodeJS.ProcessEnv;
  run?: typeof spawnSync;
  read?: typeof readFileSync;
}): PlanEvidence;
