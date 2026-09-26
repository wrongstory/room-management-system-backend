import { win32 } from "node:path";

export const PRODUCTION_PROJECT_REF = "aodikrxcczbogjpsjwjt";
export const RECOVERY_PROJECT_REF = "matalcofimnhuzslfhdd";
export const OPERATOR_RETENTION_DAYS = 15;
export const SCHEDULE_WINDOW = Object.freeze({ start: "01:00", end: "06:00" });
export const OPERATOR_SCHEDULE_TIME_KST = "03:00";

const expectedCredentialTargets = Object.freeze({
  productionDatabaseUrl: "RMS.Backup.ProductionDbUrl",
  recoveryDatabaseUrl: "RMS.Backup.RecoveryDbUrl",
  artifactEncryptionKey: "RMS.Backup.ArtifactEncryptionKey",
});

const allowedKeys = new Set([
  "schemaVersion",
  "productionProjectRef",
  "recoveryProjectRef",
  "backupRoot",
  "scheduleTimeKst",
  "retentionDays",
  "credentialTargets",
]);

function invariant(condition, code) {
  if (!condition) throw new Error(code);
}

function clockMinutes(value) {
  invariant(/^\d{2}:\d{2}$/u.test(value), "BACKUP_SCHEDULE_TIME_INVALID");
  const [hour, minute] = value.split(":").map(Number);
  invariant(hour <= 23 && minute <= 59, "BACKUP_SCHEDULE_TIME_INVALID");
  return hour * 60 + minute;
}

export function assertScheduleTimeKst(value) {
  const minutes = clockMinutes(value);
  invariant(
    minutes >= clockMinutes(SCHEDULE_WINDOW.start) && minutes <= clockMinutes(SCHEDULE_WINDOW.end),
    "BACKUP_SCHEDULE_OUTSIDE_APPROVED_WINDOW",
  );
  invariant(value === OPERATOR_SCHEDULE_TIME_KST, "BACKUP_SCHEDULE_TIME_POLICY_MISMATCH");
  return OPERATOR_SCHEDULE_TIME_KST;
}

export function assertWindowsLocalBackupRoot(value) {
  invariant(typeof value === "string" && value.length > 0, "BACKUP_ROOT_REQUIRED");
  invariant(!value.includes("%") && !value.includes("$"), "BACKUP_ROOT_ENV_EXPANSION_FORBIDDEN");
  invariant(!value.startsWith("\\\\"), "BACKUP_ROOT_NETWORK_PATH_FORBIDDEN");
  invariant(/^[A-Za-z]:[\\/]/u.test(value) && win32.isAbsolute(value), "BACKUP_ROOT_NOT_ABSOLUTE_WINDOWS_PATH");

  const normalized = win32.normalize(value);
  const root = win32.parse(normalized).root;
  invariant(normalized !== root, "BACKUP_ROOT_DRIVE_ROOT_FORBIDDEN");
  invariant(!normalized.split(/[\\/]/u).includes(".."), "BACKUP_ROOT_TRAVERSAL_FORBIDDEN");
  invariant(!/[/\\](?:Windows|Program Files(?: \(x86\))?|ProgramData)$/iu.test(normalized), "BACKUP_ROOT_SYSTEM_PATH_FORBIDDEN");
  return normalized;
}

export function validateOperatorConfig(input) {
  invariant(input && typeof input === "object" && !Array.isArray(input), "BACKUP_CONFIG_INVALID");
  for (const key of Object.keys(input)) {
    invariant(allowedKeys.has(key), `BACKUP_CONFIG_KEY_NOT_ALLOWED:${key}`);
  }

  invariant(input.schemaVersion === 1, "BACKUP_CONFIG_SCHEMA_VERSION_INVALID");
  invariant(input.productionProjectRef === PRODUCTION_PROJECT_REF, "BACKUP_PRODUCTION_PROJECT_REF_MISMATCH");
  invariant(input.recoveryProjectRef === RECOVERY_PROJECT_REF, "BACKUP_RECOVERY_PROJECT_REF_MISMATCH");
  invariant(input.productionProjectRef !== input.recoveryProjectRef, "BACKUP_PROJECT_REFS_MUST_DIFFER");
  invariant(input.retentionDays === OPERATOR_RETENTION_DAYS, "BACKUP_RETENTION_POLICY_MISMATCH");

  const credentialTargets = input.credentialTargets;
  invariant(
    credentialTargets && typeof credentialTargets === "object" && !Array.isArray(credentialTargets),
    "BACKUP_CREDENTIAL_TARGETS_INVALID",
  );
  invariant(
    JSON.stringify(Object.keys(credentialTargets).sort()) ===
      JSON.stringify(Object.keys(expectedCredentialTargets).sort()),
    "BACKUP_CREDENTIAL_TARGETS_INVALID",
  );
  for (const [key, target] of Object.entries(expectedCredentialTargets)) {
    invariant(credentialTargets[key] === target, `BACKUP_CREDENTIAL_TARGET_MISMATCH:${key}`);
  }

  return Object.freeze({
    schemaVersion: 1,
    productionProjectRef: PRODUCTION_PROJECT_REF,
    recoveryProjectRef: RECOVERY_PROJECT_REF,
    backupRoot: assertWindowsLocalBackupRoot(input.backupRoot),
    scheduleTimeKst: assertScheduleTimeKst(input.scheduleTimeKst),
    retentionDays: OPERATOR_RETENTION_DAYS,
    credentialTargets: Object.freeze({ ...expectedCredentialTargets }),
  });
}

export function buildSafeOperatorPlan(config, { repositoryRoot, configPath }) {
  const validated = validateOperatorConfig(config);
  invariant(
    typeof repositoryRoot === "string" && win32.isAbsolute(repositoryRoot),
    "BACKUP_REPOSITORY_ROOT_INVALID",
  );
  invariant(typeof configPath === "string" && win32.isAbsolute(configPath), "BACKUP_CONFIG_PATH_INVALID");

  const scriptPath = win32.join(repositoryRoot, "scripts", "windows", "Invoke-RmsBackupRecovery.ps1");
  return Object.freeze({
    schemaVersion: 1,
    taskName: "RMS-Production-Backup-Recovery",
    timezone: "Asia/Seoul",
    scheduleTimeKst: validated.scheduleTimeKst,
    retentionDays: validated.retentionDays,
    backupRoot: validated.backupRoot,
    productionProjectRef: validated.productionProjectRef,
    recoveryProjectRef: validated.recoveryProjectRef,
    credentialTargets: validated.credentialTargets,
    action: Object.freeze({
      executable: "powershell.exe",
      arguments: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-RepositoryRoot",
        win32.normalize(repositoryRoot),
        "-ConfigPath",
        win32.normalize(configPath),
      ],
    }),
  });
}

export function assertPlanContainsNoSecretMaterial(plan) {
  const serialized = JSON.stringify(plan);
  invariant(!/postgres(?:ql)?:\/\//iu.test(serialized), "BACKUP_PLAN_CONTAINS_DATABASE_URL");
  invariant(!/password|private[_-]?key|refresh[_-]?token/iu.test(serialized), "BACKUP_PLAN_CONTAINS_SECRET_FIELD");
  invariant(!/\beyJ[A-Za-z0-9_-]{10,}\./u.test(serialized), "BACKUP_PLAN_CONTAINS_TOKEN");
  return plan;
}
