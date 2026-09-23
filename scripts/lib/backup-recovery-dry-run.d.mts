export const BACKUP_RETENTION_DAYS: number;
export const APP_OWNED_SCHEMAS: readonly string[];
export const PROTECTED_SCHEMAS: readonly string[];

export function assertSafeOutputRoot(projectRoot: string, outputRoot: string): string;
export function assertLocalSyntheticTarget(target: string): void;
export function assertMigrationMatchesSource(
  sourceMigration: { count: number; name: string; version: string },
  manifest: { totalCount: number; head: string },
  headVersion: string,
): void;
export function sha256File(filePath: string): Promise<string>;
export function stripDollarQuotedBodies(source: string): string;
export function validateSchemaDump(source: string): void;
export function validateDataDump(source: string): void;
export function validateRolesDump(source: string): void;
export function assertManifestSafe(manifest: unknown): void;
export function verifyArtifactHashes(
  runDirectory: string,
  manifest: { artifacts: Array<{ file: string; bytes: number; sha256: string }> },
): Promise<void>;
export function publishSuccessfulRun(options: {
  outputRoot: string;
  stagingDirectory: string;
  manifest: { artifacts: Array<{ file: string; bytes: number; sha256: string }> };
  now?: Date;
}): Promise<string>;
export function pruneExpiredSuccessfulRuns(outputRoot: string, now?: Date): Promise<string[]>;
