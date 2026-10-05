export interface SafeRpcResultSummary {
  status: number | null;
  code: string | null;
}
export interface LocalPostgrestReadinessSummary extends SafeRpcResultSummary {
  reason: string;
  attempts: number;
  elapsedMs: number;
}
export interface LocalPostgrestReadinessError extends Error {
  summary: LocalPostgrestReadinessSummary;
}
export function safeRpcResultSummary(result: unknown): SafeRpcResultSummary;
export function waitForLocalPostgrestReady(options: {
  apiUrl: string;
  apiKey: string;
  requiredRpc?: 'process_due_assignment_lifecycle';
  fetchImpl?: typeof fetch;
  nowImpl?: () => number;
  sleepImpl?: (ms: number) => Promise<void>;
  maxTotalMs?: number;
  maxAttempts?: number;
  requestTimeoutMs?: number;
  intervalMs?: number;
}): Promise<{ attempts: number; elapsedMs: number }>;
