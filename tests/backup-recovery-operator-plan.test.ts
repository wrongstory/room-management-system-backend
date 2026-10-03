import { describe, expect, it } from 'vitest';
import {
  assertPlanContainsNoSecretMaterial,
  assertScheduleTimeKst,
  assertWindowsLocalBackupRoot,
  buildSafeOperatorPlan,
  validateOperatorConfig,
} from '../scripts/lib/backup-recovery-operator-plan.mjs';

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    productionProjectRef: 'aodikrxcczbogjpsjwjt',
    recoveryProjectRef: 'matalcofimnhuzslfhdd',
    backupRoot: 'D:\\RmsBackups',
    scheduleTimeKst: '03:00',
    retentionDays: 15,
    credentialTargets: {
      productionDatabaseUrl: 'RMS.Backup.ProductionDbUrl',
      recoveryDatabaseUrl: 'RMS.Backup.RecoveryDbUrl',
      artifactEncryptionKey: 'RMS.Backup.ArtifactEncryptionKey',
    },
    ...overrides,
  };
}

describe('backup recovery operator plan', () => {
  it('accepts only the approved KST execution window', () => {
    expect(assertScheduleTimeKst('03:00')).toBe('03:00');
    expect(() => assertScheduleTimeKst('01:00')).toThrow('BACKUP_SCHEDULE_TIME_POLICY_MISMATCH');
    expect(() => assertScheduleTimeKst('03:30')).toThrow('BACKUP_SCHEDULE_TIME_POLICY_MISMATCH');
    expect(() => assertScheduleTimeKst('06:00')).toThrow('BACKUP_SCHEDULE_TIME_POLICY_MISMATCH');
    expect(() => assertScheduleTimeKst('00:59')).toThrow('BACKUP_SCHEDULE_OUTSIDE_APPROVED_WINDOW');
    expect(() => assertScheduleTimeKst('06:01')).toThrow('BACKUP_SCHEDULE_OUTSIDE_APPROVED_WINDOW');
    expect(() => assertScheduleTimeKst('3:00')).toThrow('BACKUP_SCHEDULE_TIME_INVALID');
  });

  it('requires an explicit non-root local Windows path', () => {
    expect(assertWindowsLocalBackupRoot('D:\\RmsBackups')).toBe('D:\\RmsBackups');
    expect(() => assertWindowsLocalBackupRoot('D:\\')).toThrow('BACKUP_ROOT_DRIVE_ROOT_FORBIDDEN');
    expect(() => assertWindowsLocalBackupRoot('\\\\server\\share')).toThrow('BACKUP_ROOT_NETWORK_PATH_FORBIDDEN');
    expect(() => assertWindowsLocalBackupRoot('%USERPROFILE%\\backup')).toThrow(
      'BACKUP_ROOT_ENV_EXPANSION_FORBIDDEN',
    );
  });

  it('pins project refs, 15-day retention, and credential target names', () => {
    expect(validateOperatorConfig(validConfig()).retentionDays).toBe(15);
    expect(() => validateOperatorConfig(validConfig({ retentionDays: 7 }))).toThrow(
      'BACKUP_RETENTION_POLICY_MISMATCH',
    );
    expect(() =>
      validateOperatorConfig(validConfig({ productionProjectRef: 'wrongprojectref00000' })),
    ).toThrow('BACKUP_PRODUCTION_PROJECT_REF_MISMATCH');
    expect(() =>
      validateOperatorConfig(
        validConfig({
          credentialTargets: {
            productionDatabaseUrl: 'postgresql://secret',
            recoveryDatabaseUrl: 'RMS.Backup.RecoveryDbUrl',
            artifactEncryptionKey: 'RMS.Backup.ArtifactEncryptionKey',
          },
        }),
      ),
    ).toThrow('BACKUP_CREDENTIAL_TARGET_MISMATCH:productionDatabaseUrl');
  });

  it('builds a disabled-task-safe plan without secret material', () => {
    const repositoryRoot = 'C:\\workspace\\room-management-system-backend';
    const configPath = 'C:\\RmsConfig\\backup.json';
    const plan = buildSafeOperatorPlan(validConfig(), { repositoryRoot, configPath });
    expect(plan.action.executable).toBe('powershell.exe');
    expect(plan.action.arguments).toContain('-NoProfile');
    expect(plan.credentialTargets.productionDatabaseUrl).toBe('RMS.Backup.ProductionDbUrl');
    expect(() => assertPlanContainsNoSecretMaterial(plan)).not.toThrow();
    const unsafeUrl = ['postgresql://user', 'fixture@example.invalid/db'].join(':');
    expect(() => assertPlanContainsNoSecretMaterial({ databaseUrl: unsafeUrl })).toThrow(
      'BACKUP_PLAN_CONTAINS_DATABASE_URL',
    );
  });

  it('rejects unknown config keys instead of silently accepting policy drift', () => {
    expect(() => validateOperatorConfig(validConfig({ enabled: true }))).toThrow(
      'BACKUP_CONFIG_KEY_NOT_ALLOWED:enabled',
    );
  });
});
