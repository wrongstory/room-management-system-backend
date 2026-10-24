import { win32 } from 'node:path';
import { types } from 'node:util';

export const ONE_TIME_BACKUP_SOURCE_PROJECT_REF = 'aodikrxcczbogjpsjwjt';
export const ONE_TIME_BACKUP_RETENTION_DAYS = 15;
export const ONE_TIME_BACKUP_SCHEMAS = Object.freeze([
  'auth',
  'public',
  'private',
  'supabase_migrations',
]);

const ERROR_CODES = Object.freeze([
  'BACKUP_PLAN_INVALID_CONFIG',
  'BACKUP_PLAN_UNKNOWN_FIELDS',
  'BACKUP_PLAN_INVALID_POLICY',
  'BACKUP_PLAN_INVALID_PATH',
  'BACKUP_PLAN_UNSAFE_PATH',
  'BACKUP_PLAN_INVALID_SECRET_REFERENCE',
  'BACKUP_PLAN_INVALID_RESTORE_TARGET',
  'BACKUP_PLAN_UNSEPARATED_STORAGE',
]);
const PLAN_ERRORS = new WeakSet();

export class OneTimeBackupPlanError extends Error {
  constructor(code = 'BACKUP_PLAN_INVALID_CONFIG') {
    const safeCode = ERROR_CODES.includes(code) ? code : 'BACKUP_PLAN_INVALID_CONFIG';
    super(safeCode);
    this.name = 'OneTimeBackupPlanError';
    Object.defineProperty(this, 'code', { value: safeCode, enumerable: true });
    PLAN_ERRORS.add(this);
  }
}

function fail(code) {
  throw new OneTimeBackupPlanError(code);
}

// Accept data-only JSON shapes, not getters or inherited configuration. Never echo rejected input.
function exactObject(value, keys, code = 'BACKUP_PLAN_INVALID_CONFIG') {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key))) {
    fail('BACKUP_PLAN_UNKNOWN_FIELDS');
  }
  if (ownKeys.length !== keys.length) fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) fail(code);
  }
  return value;
}

const RESERVED_COMPONENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

function hasUnsafeCharacters(value) {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff;
  });
}

function windowsPath(value, allowOneDrive = false) {
  if (
    typeof value !== 'string' ||
    value.length > 240 ||
    !/^[a-z]:\\/iu.test(value) ||
    hasUnsafeCharacters(value) ||
    /[<>"|?*%~]/u.test(value.slice(2)) || value.includes('/') ||
    value.slice(2).includes(':')
  ) fail('BACKUP_PLAN_INVALID_PATH');
  const components = value.slice(3).split('\\');
  if (
    components.length < 2 ||
    components.some((component) =>
      component.length === 0 || component === '.' || component === '..' ||
      component !== component.trim() || /[. ]$/u.test(component) ||
      RESERVED_COMPONENT.test(component)) ||
    win32.normalize(value).toLowerCase() !== value.toLowerCase()
  ) fail('BACKUP_PLAN_INVALID_PATH');
  if (!allowOneDrive && components.some((component) => /^onedrive(?:$|[ -])/iu.test(component))) {
    fail('BACKUP_PLAN_UNSAFE_PATH');
  }
  return value.toLowerCase();
}

function isWithin(path, directory) {
  return path === directory || path.startsWith(`${directory}\\`);
}

function repositoryPaths(value) {
  if (types.isProxy(value) || !Array.isArray(value) || value.length < 1 || value.length > 32) {
    fail('BACKUP_PLAN_INVALID_CONFIG');
  }
  // A JSON array may not carry extra keys, sparse elements, symbols, or accessor elements.
  if (Reflect.ownKeys(value).length !== value.length + 1) fail('BACKUP_PLAN_INVALID_CONFIG');
  const paths = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !('value' in descriptor)) fail('BACKUP_PLAN_INVALID_CONFIG');
    paths.push(windowsPath(descriptor.value, true));
  }
  if (new Set(paths).size !== paths.length) fail('BACKUP_PLAN_INVALID_CONFIG');
  return paths;
}

function secretReference(value) {
  const reference = exactObject(value, ['kind', 'path'], 'BACKUP_PLAN_INVALID_SECRET_REFERENCE');
  if (reference.kind !== 'windows-dpapi-current-user') {
    fail('BACKUP_PLAN_INVALID_SECRET_REFERENCE');
  }
  const path = windowsPath(reference.path);
  if (!path.endsWith('.dpapi')) fail('BACKUP_PLAN_INVALID_SECRET_REFERENCE');
  return path;
}

const EXECUTION_GATES = Object.freeze([
  'source-project-identity-and-read-only-tls-verify-full',
  'trusted-windows-known-folder-and-all-repository-roots',
  'all-path-ancestors-and-handles-no-reparse-before-and-during-use',
  'private-current-user-acl-and-non-cloud-volume',
  'dpapi-current-user-credential-and-separate-key-access',
  'secrets-only-in-process-memory-no-argv-logs-or-plaintext-files',
  'exclusive-run-lock-and-new-staging-no-overwrite',
  'postgres-client-server-extension-and-auth-schema-compatibility',
  'single-consistent-source-snapshot-across-all-artifacts',
  'complete-auth-app-schema-data-roles-and-hosted-history-inventory',
  'original-auth-uuids-and-business-foreign-key-closure',
  'pin-pii-ciphertext-nonce-tag-key-version-and-aad-preservation',
  'authenticated-encryption-artifact-size-and-sha256-verification',
  'isolated-local-target-identity-empty-database-no-service-network',
  'local-workers-cron-webhooks-and-provider-calls-disabled',
  'restore-side-effect-control-and-post-restore-constraint-validation',
  'full-auth-app-and-hosted-history-restore-no-substitution',
  'restore-row-hashes-schema-acl-rls-fk-sequences-and-full-history-equality',
  'failure-evidence-preserved-last-success-unchanged',
  'immutable-success-and-atomic-pointer-only-after-full-validation',
  'fifteen-day-encrypted-retention-no-failed-evidence-auto-deletion',
]);

/**
 * Validate an explicit one-time plan lexically. No files, environment variables, secrets,
 * database connections, processes, schedules, dumps, or restores are read or changed here.
 * Caller assertions are never accepted as evidence that any execution gate passed.
 */
function validateOneTimeBackupPlan(input) {
  const config = exactObject(input, [
    'version', 'mode', 'sourceProjectRef', 'retentionDays', 'localAppDataDirectory',
    'repositoryDirectories', 'backupDirectory', 'credentialReference', 'backupKeyReference',
    'restoreTarget',
  ]);
  if (
    config.version !== 1 || config.mode !== 'plan' ||
    config.sourceProjectRef !== ONE_TIME_BACKUP_SOURCE_PROJECT_REF ||
    config.retentionDays !== ONE_TIME_BACKUP_RETENTION_DAYS
  ) fail('BACKUP_PLAN_INVALID_POLICY');

  const localAppData = windowsPath(config.localAppDataDirectory);
  if (!localAppData.endsWith('\\appdata\\local')) fail('BACKUP_PLAN_UNSAFE_PATH');
  const repositories = repositoryPaths(config.repositoryDirectories);
  const backup = windowsPath(config.backupDirectory);
  const credential = secretReference(config.credentialReference);
  const key = secretReference(config.backupKeyReference);
  for (const path of [backup, credential, key]) {
    if (
      path === localAppData || !isWithin(path, localAppData) ||
      win32.relative(localAppData, path).split('\\').length < 2 ||
      repositories.some((repository) => isWithin(path, repository) || isWithin(repository, path))
    ) fail('BACKUP_PLAN_UNSAFE_PATH');
  }
  if (
    isWithin(credential, backup) || isWithin(backup, credential) ||
    isWithin(key, backup) || isWithin(backup, key) ||
    isWithin(credential, key) || isWithin(key, credential)
  ) {
    fail('BACKUP_PLAN_UNSEPARATED_STORAGE');
  }
  const restore = exactObject(config.restoreTarget, ['kind', 'isolationId'], 'BACKUP_PLAN_INVALID_RESTORE_TARGET');
  if (
    restore.kind !== 'local-isolated-database' || typeof restore.isolationId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(restore.isolationId)
  ) fail('BACKUP_PLAN_INVALID_RESTORE_TARGET');

  // This is a diagnostic projection, not executable configuration: no paths or secret references.
  return Object.freeze({
    version: 1,
    status: 'PLANNED_NOT_EXECUTABLE',
    validationLevel: 'LEXICAL_ONLY',
    executionAllowed: false,
    backupPerformed: false,
    restoreVerified: false,
    sourceProjectRef: ONE_TIME_BACKUP_SOURCE_PROJECT_REF,
    retentionDays: ONE_TIME_BACKUP_RETENTION_DAYS,
    storageClassification: 'LOCAL_WINDOWS_ACCOUNT_STORAGE',
    restoreTarget: 'LOCAL_ISOLATED_DATABASE',
    scope: Object.freeze({
      schemas: ONE_TIME_BACKUP_SCHEMAS,
      authData: 'COMPLETE_ORIGINAL_UUIDS_NO_SUBSTITUTION',
      hostedMigrationHistory: 'COMPLETE_ORIGINAL_ROWS_NO_REPAIR',
      pinAndPiiEnvelopes: 'UNCHANGED_CIPHERTEXT_AND_CONTEXT',
      roles: 'SCHEMA_OWNERSHIP_AND_ACL_NO_PRODUCTION_ROLE_PASSWORDS',
      googleDrivePhotoObjects: 'EXCLUDED_METADATA_PRESERVED',
      platformConfigurationAndExternalSecrets: 'EXCLUDED_NOT_A_FULL_PLATFORM_RESTORE',
    }),
    prohibitions: Object.freeze({
      productionWrites: true,
      remoteRestore: true,
      existingRecoveryAuthMutation: true,
      managedRemoteSchemaDeletion: true,
      recurringScheduleInstallation: true,
      productionKeyInjection: true,
      authUuidRemapping: true,
      externalPhotoObjectCopy: true,
    }),
    requiredExecutionGates: Object.freeze(EXECUTION_GATES.map((id) => Object.freeze({
      id,
      status: 'NOT_VERIFIED',
    }))),
  });
}

export function createOneTimeBackupPlan(input) {
  try {
    return validateOneTimeBackupPlan(input);
  } catch (error) {
    // Exotic inputs can throw during reflection. Their exceptions may contain secrets.
    // Only branded, fixed-code validator errors survive; no foreign message/cause is copied.
    const code = typeof error === 'object' && error !== null && PLAN_ERRORS.has(error)
      ? error.code : 'BACKUP_PLAN_INVALID_CONFIG';
    throw new OneTimeBackupPlanError(code);
  }
}
