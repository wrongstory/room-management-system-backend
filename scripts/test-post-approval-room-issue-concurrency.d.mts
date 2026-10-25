export const postApprovalRoomIssueFreshRelations: readonly string[];
export function assertPostApprovalRoomIssueFresh(value: unknown): void;
export function assertPostApprovalRoomIssueHistory(value: unknown, expected: readonly { version: string; name: string }[]): void;
export function runPostApprovalRoomIssueConcurrency(): Promise<void>;
