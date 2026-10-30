export function roomReadyId(n: number): string;
export function roomReadyCorrectionFixture(source?: string): string;
export function roomReadyApplySql(n: number, preview: unknown, key: string, hash?: string): string;
export const roomReadyProtectedRelations: readonly string[];
export function assertRoomReadyProtectedRows(before: unknown, after: unknown): void;
export function testRoomReadyCorrectionConcurrency(context: {
  sql(input: string): string;
  race(first: string, second: string, suffix: string): Promise<Array<{ exitCode: number | null; code?: string | null; output: string }>>;
}): Promise<void>;
