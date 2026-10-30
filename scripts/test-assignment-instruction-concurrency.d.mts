export const assignmentMemoLimits: Readonly<{ workMs: number; cleanupMs: number; connectMs: number;
  queryMs: number; statementMs: number; lockMs: number; idleMs: number; barrierMs: number }>;
export function assignmentMemoLocalConnection(value: unknown): {
  host: string; port: number; database: string; user: string; password: string; ssl: false;
  connectionTimeoutMillis: number; query_timeout: number; statement_timeout: number;
  lock_timeout: number; idle_in_transaction_session_timeout: number; application_name: string;
};
export function assignmentMemoCommand(input: Record<string, unknown>): {
  text: string; values: unknown[]; key: string; hash: string; target: string; commandName: string;
};
export function assertAssignmentMemoRace(result: unknown, expected: string): void;
export function assertAssignmentMemoHistory(rows: unknown, expectedMemos: Array<string | null>): void;
export function assertAssignmentMemoResponse(response: unknown, expected: unknown): void;
export function closeAssignmentMemoConnections(connections: Array<{
  connected: boolean; busy: boolean; failed: boolean;
  client: { query(sql: string): Promise<unknown>; end(): Promise<void> };
}>): Promise<void>;
export function testAssignmentInstructionConcurrency(connectionString: string, actor: string): Promise<void>;
