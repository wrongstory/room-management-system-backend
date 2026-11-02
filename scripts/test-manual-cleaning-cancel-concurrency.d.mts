import type { SupabaseClient } from '@supabase/supabase-js';
import type { SafeRpcResultSummary } from './lib/local-postgrest-test-readiness.mjs';

export function manualCancelId(n: number): string;
export function manualCancelFixture(): string;
export interface ManualCancelRaceContext {
  sql(input: string): string;
  race(first: string, second: string, suffix: string): Promise<Array<{
    exitCode: number | null; code: string | null; output?: string;
  }>>;
}
export function testManualCleaningCancelConcurrency(client: SupabaseClient,
  afterManual?: ((context: ManualCancelRaceContext) => Promise<void>) | null): Promise<void>;
export function runManualCleaningCancelConcurrency(
  afterManual?: ((context: ManualCancelRaceContext) => Promise<void>) | null): Promise<void>;
export function manualCancelSqlState(stderr: unknown): string | null;
export function manualCancelFailureSummary(error: unknown, phase: unknown): {
  phase: string;
  kind: 'ASSERTION_FAILED' | 'VALIDATION_FAILED';
  sourceLine: number | null;
  readySourceLine: number | null;
  sqlState: string | null;
  rpc?: SafeRpcResultSummary;
};
