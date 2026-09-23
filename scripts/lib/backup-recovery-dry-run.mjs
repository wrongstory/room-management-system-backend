import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

export const BACKUP_RETENTION_DAYS = 15;
export const APP_OWNED_SCHEMAS = Object.freeze(["private", "public"]);
export const PROTECTED_SCHEMAS = Object.freeze([
  "auth",
  "storage",
  "realtime",
  "vault",
  "cron",
  "net",
  "supabase_migrations",
]);

const credentialPatterns = [
  /postgres(?:ql)?:\/\//iu,
  /\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+/u,
  /-----BEGIN (?:RSA |EC |)PRIVATE KEY-----/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertSafeOutputRoot(projectRoot, outputRoot) {
  const allowedRoot = resolve(projectRoot, ".tmp", "backup-recovery");
  const resolvedOutput = resolve(outputRoot);
  const pathFromAllowedRoot = relative(allowedRoot, resolvedOutput);
  invariant(
    pathFromAllowedRoot === "" ||
      (!pathFromAllowedRoot.startsWith(`..${sep}`) && pathFromAllowedRoot !== ".."),
    "BACKUP_OUTPUT_OUTSIDE_LOCAL_TMP",
  );
  return resolvedOutput;
}

export function assertLocalSyntheticTarget(target) {
  invariant(target === "local-synthetic", "BACKUP_TARGET_NOT_LOCAL_SYNTHETIC");
}

export function assertMigrationMatchesSource(sourceMigration, manifest, headVersion) {
  invariant(sourceMigration.count === manifest.totalCount, "BACKUP_MIGRATION_COUNT_MISMATCH");
  invariant(sourceMigration.name === manifest.head, "BACKUP_MIGRATION_NAME_MISMATCH");
  invariant(sourceMigration.version === headVersion, "BACKUP_MIGRATION_VERSION_MISMATCH");
}

export async function sha256File(filePath) {
  const source = await readFile(filePath);
  return createHash("sha256").update(source).digest("hex");
}

export function stripDollarQuotedBodies(source) {
  let result = "";
  let index = 0;
  let activeTag = null;
  while (index < source.length) {
    if (activeTag !== null) {
      if (source.startsWith(activeTag, index)) {
        result += activeTag;
        index += activeTag.length;
        activeTag = null;
      } else {
        result += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(index));
    if (match) {
      activeTag = match[0];
      result += activeTag;
      index += activeTag.length;
      continue;
    }
    result += source[index];
    index += 1;
  }
  invariant(activeTag === null, "BACKUP_SQL_UNTERMINATED_DOLLAR_QUOTE");
  return result;
}

function stripSingleQuotedStrings(source) {
  let result = "";
  let inside = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inside && character === "'") {
      inside = true;
      result += " ";
      continue;
    }
    if (inside && character === "'" && source[index + 1] === "'") {
      result += "  ";
      index += 1;
      continue;
    }
    if (inside && character === "'") {
      inside = false;
      result += " ";
      continue;
    }
    result += inside && character !== "\n" ? " " : character;
  }
  invariant(!inside, "BACKUP_SQL_UNTERMINATED_STRING");
  return result;
}

function protectedSchemaOccurrences(statement) {
  const occurrences = [];
  for (const schema of PROTECTED_SCHEMAS) {
    const expression = new RegExp(`(?:"${schema}"|\\b${schema})\\s*\\.`, "giu");
    for (const match of statement.matchAll(expression)) {
      occurrences.push({ schema, index: match.index ?? 0 });
    }
  }
  return occurrences;
}

function isAllowedReference(statement, index) {
  const before = statement.slice(Math.max(0, index - 48), index);
  return /REFERENCES\s*$/iu.test(before);
}

function touchesProtectedSchemaDefinition(statement, schema) {
  const quotedSchema = `(?:"${schema}"|\\b${schema}\\b)`;
  return [
    new RegExp(`\\b(?:CREATE|ALTER|DROP)\\s+SCHEMA(?:\\s+IF\\s+(?:NOT\\s+)?EXISTS)?\\s+${quotedSchema}`, "iu"),
    new RegExp(`\\b(?:GRANT|REVOKE)\\b[\\s\\S]*\\bON\\s+SCHEMA\\s+${quotedSchema}`, "iu"),
    new RegExp(`\\bALTER\\s+DEFAULT\\s+PRIVILEGES\\b[\\s\\S]*\\bIN\\s+SCHEMA\\s+${quotedSchema}`, "iu"),
  ].some((expression) => expression.test(statement));
}

export function validateSchemaDump(source) {
  for (const pattern of credentialPatterns) {
    invariant(!pattern.test(source), "BACKUP_SCHEMA_CONTAINS_CREDENTIAL_MATERIAL");
  }

  const topLevel = stripSingleQuotedStrings(stripDollarQuotedBodies(source));
  for (const rawStatement of topLevel.split(";")) {
    const statement = rawStatement.replaceAll(/--[^\n]*/gu, " ").trim();
    if (!statement) continue;
    for (const schema of PROTECTED_SCHEMAS) {
      invariant(
        !touchesProtectedSchemaDefinition(statement, schema),
        `BACKUP_SCHEMA_TOUCHES_PROTECTED_SCHEMA:${schema}`,
      );
    }
    for (const occurrence of protectedSchemaOccurrences(statement)) {
      invariant(
        isAllowedReference(statement, occurrence.index),
        `BACKUP_SCHEMA_TOUCHES_PROTECTED_SCHEMA:${occurrence.schema}`,
      );
    }
  }

  invariant(/CREATE SCHEMA IF NOT EXISTS "private"/u.test(source), "BACKUP_PRIVATE_SCHEMA_MISSING");
  invariant(/CREATE SCHEMA IF NOT EXISTS "public"/u.test(source), "BACKUP_PUBLIC_SCHEMA_MISSING");
}

export function validateDataDump(source) {
  for (const pattern of credentialPatterns) {
    invariant(!pattern.test(source), "BACKUP_DATA_CONTAINS_CREDENTIAL_MATERIAL");
  }
  const copyTargets = [...source.matchAll(/^COPY\s+"([^"]+)"\."([^"]+)"/gmu)];
  invariant(copyTargets.length > 0, "BACKUP_DATA_HAS_NO_COPY_TARGETS");
  for (const match of copyTargets) {
    invariant(APP_OWNED_SCHEMAS.includes(match[1]), `BACKUP_DATA_SCHEMA_NOT_ALLOWED:${match[1]}`);
  }
  for (const schema of PROTECTED_SCHEMAS) {
    const expression = new RegExp(`^COPY\\s+(?:"${schema}"|${schema})\\.`, "imu");
    invariant(!expression.test(source), `BACKUP_DATA_TOUCHES_PROTECTED_SCHEMA:${schema}`);
  }
}

export function validateRolesDump(source) {
  for (const pattern of credentialPatterns) {
    invariant(!pattern.test(source), "BACKUP_ROLES_CONTAINS_CREDENTIAL_MATERIAL");
  }
  const allowedStatementTimeouts = new Map([
    ["anon", "3s"],
    ["authenticated", "8s"],
    ["authenticator", "8s"],
  ]);
  const allowedDiagnosticSettings = new Map([
    ["default_transaction_read_only", "on"],
    ["statement_timeout", "3s"],
    ["lock_timeout", "500ms"],
    ["idle_in_transaction_session_timeout", "5s"],
    ["search_path", "pg_catalog, public"],
  ]);
  for (const rawStatement of source.split(";")) {
    const statement = rawStatement.replaceAll(/--[^\n]*/gu, " ").trim();
    if (!statement) continue;
    if (/^(?:SET|RESET)\b/iu.test(statement)) continue;
    if (/^CREATE ROLE\s+"rms_diagnostic"$/iu.test(statement)) continue;
    if (
      /^ALTER ROLE\s+"rms_diagnostic"\s+WITH\s+NOINHERIT\s+NOCREATEROLE\s+NOCREATEDB\s+LOGIN\s+NOBYPASSRLS$/iu.test(
        statement,
      )
    ) continue;
    const match = /^ALTER ROLE\s+"([^"]+)"\s+SET\s+"([^"]+)"\s+TO\s+'([^']+)'$/iu.exec(
      statement,
    );
    const role = match?.[1];
    const setting = match?.[2];
    const value = match?.[3];
    const allowed = role === "rms_diagnostic"
      ? allowedDiagnosticSettings.get(setting)
      : setting === "statement_timeout"
        ? allowedStatementTimeouts.get(role)
        : undefined;
    invariant(Boolean(match) && allowed === value, "BACKUP_ROLES_COMMAND_NOT_ALLOWED");
  }
}

export function assertManifestSafe(manifest) {
  const serialized = JSON.stringify(manifest);
  for (const pattern of credentialPatterns) {
    invariant(!pattern.test(serialized), "BACKUP_MANIFEST_CONTAINS_CREDENTIAL_MATERIAL");
  }
  for (const forbiddenKey of [
    "password",
    "secret",
    "token",
    "pin",
    "phone",
    "guestName",
    "connectionString",
    "projectRef",
  ]) {
    invariant(!serialized.includes(`"${forbiddenKey}"`), `BACKUP_MANIFEST_FORBIDDEN_KEY:${forbiddenKey}`);
  }
}

export async function verifyArtifactHashes(runDirectory, manifest) {
  for (const artifact of manifest.artifacts) {
    invariant(/^[a-z0-9][a-z0-9.-]+$/u.test(artifact.file), "BACKUP_ARTIFACT_NAME_INVALID");
    const filePath = resolve(runDirectory, artifact.file);
    invariant(dirname(filePath) === resolve(runDirectory), "BACKUP_ARTIFACT_PATH_ESCAPE");
    const fileStats = await stat(filePath);
    invariant(fileStats.size === artifact.bytes, `BACKUP_ARTIFACT_SIZE_MISMATCH:${artifact.file}`);
    const actualHash = await sha256File(filePath);
    invariant(actualHash === artifact.sha256, `BACKUP_ARTIFACT_HASH_MISMATCH:${artifact.file}`);
  }
}

export async function publishSuccessfulRun({ outputRoot, stagingDirectory, manifest, now = new Date() }) {
  assertManifestSafe(manifest);
  await verifyArtifactHashes(stagingDirectory, manifest);

  const timestamp = now.toISOString().replaceAll(/[-:.]/gu, "");
  const successName = `success-${timestamp}-${randomUUID()}`;
  const successDirectory = resolve(outputRoot, successName);
  await rename(stagingDirectory, successDirectory);

  const pointer = {
    schemaVersion: 1,
    runDirectory: successName,
    manifestSha256: await sha256File(resolve(successDirectory, "manifest.json")),
    completedAt: now.toISOString(),
  };
  const pointerPath = resolve(outputRoot, "latest-success.json");
  const temporaryPointer = resolve(outputRoot, `.latest-success-${randomUUID()}.json`);
  await writeFile(temporaryPointer, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
  await rename(temporaryPointer, pointerPath);
  return successDirectory;
}

export async function pruneExpiredSuccessfulRuns(outputRoot, now = new Date()) {
  const cutoff = now.getTime() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const entries = await readdir(outputRoot, { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("success-")) continue;
    const manifestPath = resolve(outputRoot, entry.name, "manifest.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const completedAt = Date.parse(manifest.completedAt);
    if (!Number.isFinite(completedAt) || completedAt >= cutoff) continue;
    await rm(resolve(outputRoot, entry.name), { recursive: true, force: false });
    removed.push(entry.name);
  }
  return removed;
}
