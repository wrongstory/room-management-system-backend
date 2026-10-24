export const ONE_TIME_BACKUP_SOURCE_PROJECT_REF: 'aodikrxcczbogjpsjwjt';
export const ONE_TIME_BACKUP_RETENTION_DAYS: 15;
export const ONE_TIME_BACKUP_SCHEMAS: readonly ['auth', 'public', 'private', 'supabase_migrations'];

export type OneTimeBackupPlanErrorCode =
  | 'BACKUP_PLAN_INVALID_CONFIG'
  | 'BACKUP_PLAN_UNKNOWN_FIELDS'
  | 'BACKUP_PLAN_INVALID_POLICY'
  | 'BACKUP_PLAN_INVALID_PATH'
  | 'BACKUP_PLAN_UNSAFE_PATH'
  | 'BACKUP_PLAN_INVALID_SECRET_REFERENCE'
  | 'BACKUP_PLAN_INVALID_RESTORE_TARGET'
  | 'BACKUP_PLAN_UNSEPARATED_STORAGE';

export class OneTimeBackupPlanError extends Error {
  readonly code: OneTimeBackupPlanErrorCode;
  constructor(code?: OneTimeBackupPlanErrorCode);
}

export interface OneTimeBackupPlanConfig {
  version: 1;
  mode: 'plan';
  sourceProjectRef: typeof ONE_TIME_BACKUP_SOURCE_PROJECT_REF;
  retentionDays: 15;
  localAppDataDirectory: string;
  repositoryDirectories: string[];
  backupDirectory: string;
  credentialReference: { kind: 'windows-dpapi-current-user'; path: string };
  backupKeyReference: { kind: 'windows-dpapi-current-user'; path: string };
  restoreTarget: { kind: 'local-isolated-database'; isolationId: string };
}

export interface OneTimeBackupPlan {
  readonly version: 1;
  readonly status: 'PLANNED_NOT_EXECUTABLE';
  readonly validationLevel: 'LEXICAL_ONLY';
  readonly executionAllowed: false;
  readonly backupPerformed: false;
  readonly restoreVerified: false;
  readonly sourceProjectRef: typeof ONE_TIME_BACKUP_SOURCE_PROJECT_REF;
  readonly retentionDays: 15;
  readonly storageClassification: 'LOCAL_WINDOWS_ACCOUNT_STORAGE';
  readonly restoreTarget: 'LOCAL_ISOLATED_DATABASE';
  readonly scope: {
    readonly schemas: typeof ONE_TIME_BACKUP_SCHEMAS;
    readonly authData: 'COMPLETE_ORIGINAL_UUIDS_NO_SUBSTITUTION';
    readonly hostedMigrationHistory: 'COMPLETE_ORIGINAL_ROWS_NO_REPAIR';
    readonly pinAndPiiEnvelopes: 'UNCHANGED_CIPHERTEXT_AND_CONTEXT';
    readonly roles: 'SCHEMA_OWNERSHIP_AND_ACL_NO_PRODUCTION_ROLE_PASSWORDS';
    readonly googleDrivePhotoObjects: 'EXCLUDED_METADATA_PRESERVED';
    readonly platformConfigurationAndExternalSecrets: 'EXCLUDED_NOT_A_FULL_PLATFORM_RESTORE';
  };
  readonly prohibitions: Readonly<Record<
    'productionWrites' | 'remoteRestore' | 'existingRecoveryAuthMutation' |
    'managedRemoteSchemaDeletion' | 'recurringScheduleInstallation' | 'productionKeyInjection' |
    'authUuidRemapping' | 'externalPhotoObjectCopy', true
  >>;
  readonly requiredExecutionGates: ReadonlyArray<{
    readonly id: string;
    readonly status: 'NOT_VERIFIED';
  }>;
}

export function createOneTimeBackupPlan(config: unknown): OneTimeBackupPlan;
