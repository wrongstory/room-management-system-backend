import { describe, expect, it } from 'vitest';
import {
  createOneTimeBackupPlan,
  OneTimeBackupPlanError,
  type OneTimeBackupPlanConfig,
} from '../scripts/lib/one-time-backup-plan.mjs';

function config(): OneTimeBackupPlanConfig {
  return {
    version: 1,
    mode: 'plan',
    sourceProjectRef: 'aodikrxcczbogjpsjwjt',
    retentionDays: 15,
    localAppDataDirectory: 'C:\\Users\\synthetic-operator\\AppData\\Local',
    repositoryDirectories: ['C:\\workspaces\\synthetic-backend'],
    backupDirectory: 'C:\\Users\\synthetic-operator\\AppData\\Local\\RoomManagementSystem\\ReleaseBackups',
    credentialReference: {
      kind: 'windows-dpapi-current-user',
      path: 'C:\\Users\\synthetic-operator\\AppData\\Local\\RoomManagementSystem\\Secrets\\credential.dpapi',
    },
    backupKeyReference: {
      kind: 'windows-dpapi-current-user',
      path: 'C:\\Users\\synthetic-operator\\AppData\\Local\\RoomManagementSystem\\BackupKeys\\backup-key.dpapi',
    },
    restoreTarget: {
      kind: 'local-isolated-database',
      isolationId: '2127b3cf-a7cc-4bb1-8048-234fa2ccf71b',
    },
  };
}

describe('one-time production backup plan (no execution)', () => {
  it('returns only immutable safe diagnostics, never runtime safety or completed backup claims', () => {
    const input = config();
    const plan = createOneTimeBackupPlan(input);
    expect(plan.status).toBe('PLANNED_NOT_EXECUTABLE');
    expect(plan.validationLevel).toBe('LEXICAL_ONLY');
    expect([plan.executionAllowed, plan.backupPerformed, plan.restoreVerified]).toEqual([false, false, false]);
    expect(plan.scope.schemas).toEqual(['auth', 'public', 'private', 'supabase_migrations']);
    expect(plan.scope.authData).toBe('COMPLETE_ORIGINAL_UUIDS_NO_SUBSTITUTION');
    expect(plan.scope.hostedMigrationHistory).toBe('COMPLETE_ORIGINAL_ROWS_NO_REPAIR');
    expect(Object.values(plan.prohibitions).every((value) => value === true)).toBe(true);
    expect(plan.requiredExecutionGates).toHaveLength(21);
    expect(plan.requiredExecutionGates.every((gate) => gate.status === 'NOT_VERIFIED')).toBe(true);
    for (const value of [plan, plan.scope, plan.scope.schemas, plan.prohibitions, plan.requiredExecutionGates, ...plan.requiredExecutionGates]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    const diagnostic = JSON.stringify(plan);
    expect(diagnostic).not.toContain('synthetic-operator');
    expect(diagnostic).not.toContain('.dpapi');
    expect(diagnostic).not.toContain(input.restoreTarget.isolationId);
    input.backupDirectory = 'changed';
    expect(createOneTimeBackupPlan(config())).toEqual(plan);
  });

  it('requires snapshot, encryption, Auth linkage, complete history, ACL/reparse and atomic publication gates', () => {
    const ids = createOneTimeBackupPlan(config()).requiredExecutionGates.map((gate) => gate.id).join('\n');
    for (const required of ['read-only-tls-verify-full', 'no-reparse', 'current-user-acl', 'exclusive-run-lock', 'single-consistent-source-snapshot', 'complete-auth', 'original-auth-uuids', 'ciphertext', 'sha256', 'no-service-network', 'provider-calls-disabled', 'post-restore-constraint', 'full-history-equality', 'last-success-unchanged', 'atomic-pointer', 'fifteen-day']) {
      expect(ids).toContain(required);
    }
  });

  it.each([
    ['version', 2], ['mode', 'execute'], ['sourceProjectRef', 'matalcofimnhuzslfhdd'],
    ['sourceProjectRef', 'https://aodikrxcczbogjpsjwjt.supabase.co'], ['retentionDays', 14],
    ['retentionDays', '15'], ['retentionDays', Number.NaN],
  ])('rejects policy drift in %s', (field, value) => {
    expect(() => createOneTimeBackupPlan({ ...config(), [field]: value })).toThrow('BACKUP_PLAN_INVALID_POLICY');
  });

  it.each(['PROD_DB_URL', 'password', 'token', 'schedule', 'execute', 'authUuidMapping', 'snapshotVerified', 'fullRestoreSucceeded', 'includeSchemas'])('rejects extra %s and never echoes its value', (field) => {
    expect(() => createOneTimeBackupPlan({ ...config(), [field]: 'synthetic-sensitive-value' })).toThrow('BACKUP_PLAN_UNKNOWN_FIELDS');
    try {
      createOneTimeBackupPlan({ ...config(), [field]: 'synthetic-sensitive-value' });
    } catch (error) {
      expect(error).toBeInstanceOf(OneTimeBackupPlanError);
      expect(String(error)).not.toContain('synthetic-sensitive-value');
      expect(String(error)).not.toContain(field);
    }
  });

  it.each([
    '', 'relative\\backup', 'C:backup', 'C:\\', '\\\\server\\share\\backup',
    '\\\\?\\C:\\backup', '\\\\.\\GLOBALROOT\\backup', '/tmp/backup',
    'C:\\Users\\operator\\AppData\\Local\\..\\backup',
    'C:\\Users\\operator\\AppData\\Local\\.\\backup',
    'C:\\Users\\operator\\AppData\\Local\\folder.\\backup',
    'C:\\Users\\operator\\AppData\\Local\\folder \\backup',
    'C:\\Users\\operator\\AppData\\Local\\NUL.txt\\backup',
    'C:\\Users\\operator\\AppData\\Local\\COM¹\\backup',
    'C:\\Users\\operator\\AppData\\Local\\CONOUT$\\backup',
    'C:\\Users\\operator\\AppData\\Local\\ONE DRI~1\\backup',
    'C:\\Users\\operator\\AppData\\Local\\%PRIVATE%\\backup',
    'C:\\Users\\operator\\AppData\\Local\\folder:stream\\backup',
    'C:\\Users\\operator\\AppData\\Local\\folder\\\\backup',
    'C:\\Users\\operator\\AppData\\Local\\folder\\backup\\',
    'C:\\Users\\operator\\AppData\\Local\\folder\r\\backup',
    'C:\\Users\\operator\\AppData\\Local\\folder\u202e\\backup',
  ])('rejects noncanonical Windows backup path %j', (path) => {
    expect(() => createOneTimeBackupPlan({ ...config(), backupDirectory: path })).toThrow('BACKUP_PLAN_INVALID_PATH');
  });

  it.each([
    'C:\\Users\\synthetic-operator\\OneDrive\\backup',
    'C:\\Users\\synthetic-operator\\AppData\\Local\\OneDrive - Tenant\\backup',
    'D:\\outside\\backup', 'C:\\Users\\synthetic-operator\\AppData\\Local',
    'C:\\Users\\synthetic-operator\\AppData\\Local\\backup',
  ])('rejects cloud, root, shallow or unapproved storage %j', (path) => {
    expect(() => createOneTimeBackupPlan({ ...config(), backupDirectory: path })).toThrow('BACKUP_PLAN_UNSAFE_PATH');
  });

  it('rejects repository overlap case-insensitively with segment boundaries', () => {
    const input = config();
    input.repositoryDirectories = [input.backupDirectory.toUpperCase()];
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSAFE_PATH');
    input.repositoryDirectories = [`${input.backupDirectory}\\child-repository`];
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSAFE_PATH');
    input.repositoryDirectories = [`${input.backupDirectory}-different`];
    expect(() => createOneTimeBackupPlan(input)).not.toThrow();
    input.repositoryDirectories = ['C:\\Users\\synthetic-operator\\OneDrive\\backend'];
    expect(() => createOneTimeBackupPlan(input)).not.toThrow();
  });

  it.each(['credentialReference', 'backupKeyReference'] as const)('requires %s to be an opaque DPAPI reference, not a secret or URL', (field) => {
    // Deliberately synthetic URI: no actual connection, secret lookup, or scanner exemption.
    const syntheticUrl = new URL('postgresql://localhost');
    syntheticUrl.username = 'fixture-user';
    syntheticUrl.password = 'synthetic-only';
    for (const reference of ['synthetic-secret', { kind: 'environment', path: 'PROD_DB_URL' }, { kind: 'windows-dpapi-current-user', path: config()[field].path, password: 'synthetic-secret' }, { kind: 'windows-dpapi-current-user', path: syntheticUrl.href }, { kind: 'windows-dpapi-current-user', path: config()[field].path.replace('.dpapi', '.txt') }]) {
      expect(() => createOneTimeBackupPlan({ ...config(), [field]: reference })).toThrow(OneTimeBackupPlanError);
    }
  });

  it('requires a distinct encryption key outside the backup and credential paths', () => {
    const input = config();
    input.backupKeyReference.path = input.credentialReference.path.toUpperCase();
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSEPARATED_STORAGE');
    input.backupKeyReference.path = `${input.backupDirectory}\\key.dpapi`;
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSEPARATED_STORAGE');
    input.backupKeyReference = config().backupKeyReference;
    input.credentialReference.path = `${input.backupDirectory}\\credential.dpapi`;
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSEPARATED_STORAGE');
  });

  it('rejects backup/secret-reference overlap in both directions and nested secret files', () => {
    for (const field of ['credentialReference', 'backupKeyReference'] as const) {
      const input = config();
      input.backupDirectory = `${input[field].path}\\backups`;
      expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSEPARATED_STORAGE');
    }
    const input = config();
    input.backupKeyReference.path = `${input.credentialReference.path}\\key.dpapi`;
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSEPARATED_STORAGE');
    input.credentialReference.path = `${config().backupKeyReference.path}\\credential.dpapi`;
    input.backupKeyReference = config().backupKeyReference;
    expect(() => createOneTimeBackupPlan(input)).toThrow('BACKUP_PLAN_UNSEPARATED_STORAGE');
  });

  it.each([
    { kind: 'remote-recovery', isolationId: config().restoreTarget.isolationId },
    { kind: 'local-isolated-database', isolationId: 'production' },
    { kind: 'local-isolated-database', isolationId: config().restoreTarget.isolationId, url: 'http://127.0.0.1' },
    { kind: 'local-isolated-database', isolationId: config().restoreTarget.isolationId, auth: 'app-only' },
  ])('rejects a restore target override or claimed subset', (restoreTarget) => {
    expect(() => createOneTimeBackupPlan({ ...config(), restoreTarget })).toThrow(OneTimeBackupPlanError);
  });

  it('rejects missing fields, inherited values, symbols, getters and sparse or augmented arrays without invoking getters', () => {
    const missing = { ...config() } as Partial<OneTimeBackupPlanConfig>;
    delete missing.retentionDays;
    expect(() => createOneTimeBackupPlan(missing)).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    expect(() => createOneTimeBackupPlan(Object.create(config()))).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    expect(() => createOneTimeBackupPlan({ ...config(), [Symbol('secret')]: 'synthetic-secret' })).toThrow('BACKUP_PLAN_UNKNOWN_FIELDS');
    const getter = { ...config() };
    Object.defineProperty(getter, 'sourceProjectRef', { enumerable: true, get() { throw new Error('must not be invoked'); } });
    expect(() => createOneTimeBackupPlan(getter)).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    const sparse = new Array(1);
    expect(() => createOneTimeBackupPlan({ ...config(), repositoryDirectories: sparse })).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    const accessor = [config().repositoryDirectories[0]];
    Object.defineProperty(accessor, '0', { get() { throw new Error('must not be invoked'); } });
    expect(() => createOneTimeBackupPlan({ ...config(), repositoryDirectories: accessor })).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    const augmented = Object.assign([...config().repositoryDirectories], { extra: 'synthetic-secret' });
    expect(() => createOneTimeBackupPlan({ ...config(), repositoryDirectories: augmented })).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    expect(() => createOneTimeBackupPlan({ ...config(), repositoryDirectories: [] })).toThrow('BACKUP_PLAN_INVALID_CONFIG');
  });

  it('rejects proxies before invoking any reflection/get traps, including nested objects and arrays', () => {
    let calls = 0;
    const trap = () => { calls += 1; throw new Error('synthetic-sensitive-value'); };
    const handler = { getPrototypeOf: trap, ownKeys: trap, get: trap, getOwnPropertyDescriptor: trap };
    const base = config();
    for (const input of [
      new Proxy(base, handler),
      { ...base, credentialReference: new Proxy(base.credentialReference, handler) },
      { ...base, backupKeyReference: new Proxy(base.backupKeyReference, handler) },
      { ...base, restoreTarget: new Proxy(base.restoreTarget, handler) },
      { ...base, repositoryDirectories: new Proxy(base.repositoryDirectories, handler) },
      { ...base, repositoryDirectories: [new Proxy({}, handler)] },
    ]) {
      expect(() => createOneTimeBackupPlan(input)).toThrow(OneTimeBackupPlanError);
    }
    expect(calls).toBe(0);
    const revoked = Proxy.revocable(base, handler);
    revoked.revoke();
    expect(() => createOneTimeBackupPlan(revoked.proxy)).toThrow('BACKUP_PLAN_INVALID_CONFIG');
    expect(calls).toBe(0);
  });

  it('returns a safe fixed error without copying a rejected proxy exception or cause', () => {
    const input = new Proxy(config(), { getPrototypeOf() { throw new Error('synthetic-sensitive-value'); } });
    try {
      createOneTimeBackupPlan(input);
      expect.fail('reflection must be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(OneTimeBackupPlanError);
      expect(String(error)).toBe('OneTimeBackupPlanError: BACKUP_PLAN_INVALID_CONFIG');
      expect(JSON.stringify(error)).not.toContain('synthetic-sensitive-value');
      expect(error).not.toHaveProperty('cause');
    }
    const arbitrary = new OneTimeBackupPlanError();
    arbitrary.message = 'synthetic-sensitive-value';
    const branded = new Proxy(config(), { getPrototypeOf() { throw arbitrary; } });
    expect(() => createOneTimeBackupPlan(branded)).toThrow('BACKUP_PLAN_INVALID_CONFIG');
  });
});
