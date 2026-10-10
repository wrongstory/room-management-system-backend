import type { spawnSync } from 'node:child_process';
import type { readFileSync } from 'node:fs';
export interface RoomBoardSample {
  kind: string; mode: string; sample: number; dayOffset?: number; table?: string;
  resultEquivalent?: boolean; denials?: number; executionMs: number; planningMs: number;
  sharedHitBlocks: number; sharedReadBlocks: number; walBytes: number; walRecords: number;
  triggerMs: number; extraIndexBytes: number;
}
export interface RoomBoardEvidence {
  scope: string; serverVersion: string; rooms: number; eventsPerRoom: number; results: RoomBoardSample[];
}
export function summarizeRoomBoard(raw: string): RoomBoardEvidence;
export function runRoomBoardBenchmark(options?: {
  env?: NodeJS.ProcessEnv; run?: typeof spawnSync; read?: typeof readFileSync;
}): RoomBoardEvidence;
