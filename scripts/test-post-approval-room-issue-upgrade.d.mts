export interface UpgradeSourceEntry {
  file: string;
  raw: Uint8Array;
  isFile: boolean;
  isSymbolicLink: boolean;
}
export interface UpgradeValidatedEntry {
  file: string;
  version: string;
  name: string;
  sha256: string;
  rawSha256: string;
  canonical: string;
}
export interface UpgradeSource {
  entries: UpgradeValidatedEntry[];
  ledger: string;
}
export interface UpgradeFunctionSpec {
  signature: string;
  name: string;
  source: string;
  language: string;
  returns: string;
  returnsSet: boolean;
  volatility: string;
  securityDefiner: boolean;
  args: string[];
  defaults: string;
  defaultCount: number;
}
export interface UpgradePlan {
  tables: string[];
  functions: UpgradeFunctionSpec[];
}
export const POST_APPROVAL_UPGRADE_PREFIX_SHA256: string;
export const POST_APPROVAL_UPGRADE_FILE_PREFIX_SHA256: string;
export const POST_APPROVAL_UPGRADE_TABLES: readonly string[];
export const POST_APPROVAL_UPGRADE_FRESH_TABLES: readonly string[];
export const POST_APPROVAL_UPGRADE_PATCHES: readonly { signature: string; needle: string; replacement: string }[];
export const POST_APPROVAL_UPGRADE_NOTIFICATION: Readonly<Record<string, string | number | boolean>>;
export function validatePostApprovalUpgradeSource(manifest: unknown, entries: UpgradeSourceEntry[]): UpgradeSource;
export function validatePostApprovalUpgradeLocal(input: {
  args: string[];
  env: Record<string, string | undefined>;
  config: string;
  endpoint: string;
  status: unknown;
  container: string;
  cliVersion: string;
}): { projectId: string; dbPort: number; endpoint: string };
export function assertPostApprovalUpgradeHistory(actual: unknown, source: UpgradeSource, installed?: number): void;
export function assertPostApprovalUpgradeFresh(value: unknown): void;
export function postApprovalUpgradeFreshSql(): string;
export function parsePostApprovalUpgradePlan(source: string): UpgradePlan;
export function assertPostApprovalUpgradeCallers(functions: unknown, installed: number): void;
export function assertPostApprovalUpgradeCatalog(before: unknown, after: unknown, plan: UpgradePlan): void;
export function preparePostApprovalUpgradeWorkspace(source: UpgradeSource): string;
export function runPostApprovalRoomIssueUpgrade(): boolean;
export function postApprovalUpgradeSqlState(error: unknown): string | null;
export function postApprovalUpgradeLegacyFixture(source: string): string;
