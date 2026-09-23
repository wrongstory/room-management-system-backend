export interface OperatorCredentialTargets {
  productionDatabaseUrl: "RMS.Backup.ProductionDbUrl";
  recoveryDatabaseUrl: "RMS.Backup.RecoveryDbUrl";
  artifactEncryptionKey: "RMS.Backup.ArtifactEncryptionKey";
}

export interface OperatorConfig {
  schemaVersion: 1;
  productionProjectRef: "aodikrxcczbogjpsjwjt";
  recoveryProjectRef: "matalcofimnhuzslfhdd";
  backupRoot: string;
  scheduleTimeKst: string;
  retentionDays: 15;
  credentialTargets: OperatorCredentialTargets;
}

export interface OperatorPlan extends OperatorConfig {
  taskName: "RMS-Production-Backup-Recovery";
  timezone: "Asia/Seoul";
  action: {
    executable: "powershell.exe";
    arguments: readonly string[];
  };
}

export const PRODUCTION_PROJECT_REF: "aodikrxcczbogjpsjwjt";
export const RECOVERY_PROJECT_REF: "matalcofimnhuzslfhdd";
export const OPERATOR_RETENTION_DAYS: 15;
export const SCHEDULE_WINDOW: Readonly<{ start: "01:00"; end: "06:00" }>;

export function assertScheduleTimeKst(value: string): string;
export function assertWindowsLocalBackupRoot(value: string): string;
export function validateOperatorConfig(input: unknown): Readonly<OperatorConfig>;
export function buildSafeOperatorPlan(
  config: unknown,
  paths: { repositoryRoot: string; configPath: string },
): Readonly<OperatorPlan>;
export function assertPlanContainsNoSecretMaterial<T>(plan: T): T;
