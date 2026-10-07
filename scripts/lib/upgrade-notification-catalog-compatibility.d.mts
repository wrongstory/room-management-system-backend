export interface UpgradeHistoryShape {
  table: string;
  columns: string[];
}
export interface UpgradeHistorySnapshot {
  digest: string;
  catalog: Record<string, unknown>[] | null;
}
export const APPROVED_UPGRADE_NOTIFICATION_CATALOG_ROW: Readonly<Record<string, string | number | boolean>>;
export function assertUpgradeNotificationCatalog(
  before: unknown, after: unknown, expectedCount: number
): void;
export function upgradeHistorySnapshotSql(
  shape: UpgradeHistoryShape[], expectedCount: number, excludeApprovedAddition?: boolean
): string;
