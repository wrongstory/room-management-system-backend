import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = resolve(projectRoot, "supabase", "migrations");
const manifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.5.0.json");
const migrationFilePattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(`Migration manifest invalid: ${message}`);
}

function canonicalContent(source, fileName) {
  const normalized = source.replaceAll("\r\n", "\n");
  invariant(!normalized.includes("\r"), `${fileName} contains a standalone CR byte`);
  return normalized;
}

function stableMigration(fileName) {
  const match = migrationFilePattern.exec(fileName);
  invariant(match, `unexpected migration filename ${fileName}`);
  return { version: match[1], name: match[2] };
}

export async function verifyMigrationManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const files = (await readdir(migrationDirectory))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();

  invariant(manifest.schemaVersion === 1, "schemaVersion must be 1");
  invariant(manifest.release === "v0.5.0", "release must be v0.5.0");
  invariant(manifest.hashAlgorithm === "sha256-lf-utf8", "unexpected hash algorithm");
  invariant(Array.isArray(manifest.migrations), "migrations must be an array");
  invariant(manifest.totalCount === 76, "totalCount must be 76");
  invariant(files.length === manifest.totalCount, `expected 76 SQL files, found ${files.length}`);
  invariant(manifest.migrations.length === manifest.totalCount, "manifest entry count mismatch");
  invariant(manifest.baseline?.count === 74, "baseline count must be 74");
  invariant(manifest.pending?.count === 2, "pending count must be 2");
  invariant(
    manifest.baseline.count + manifest.pending.count === manifest.totalCount,
    "baseline and pending counts must total 76",
  );

  const names = new Set();
  let previousVersion = "";
  for (const [index, fileName] of files.entries()) {
    const migration = stableMigration(fileName);
    const expected = manifest.migrations[index];
    invariant(migration.version > previousVersion, `${fileName} is not in strict version order`);
    invariant(!names.has(migration.name), `duplicate stable name ${migration.name}`);
    invariant(expected?.order === index + 1, `entry ${index + 1} has the wrong order`);
    invariant(expected.name === migration.name, `entry ${index + 1} expected ${migration.name}`);
    invariant(sha256Pattern.test(expected.sha256), `${migration.name} has an invalid SHA-256`);

    const source = await readFile(resolve(migrationDirectory, fileName), "utf8");
    const actualSha256 = createHash("sha256")
      .update(canonicalContent(source, fileName), "utf8")
      .digest("hex");
    invariant(
      actualSha256 === expected.sha256,
      `${migration.name} content SHA mismatch: expected=${expected.sha256} actual=${actualSha256}`,
    );
    names.add(migration.name);
    previousVersion = migration.version;
  }

  const baselineHead = manifest.migrations[manifest.baseline.count - 1]?.name;
  const pendingFirst = manifest.migrations[manifest.baseline.count]?.name;
  const migrationHead = manifest.migrations.at(-1)?.name;
  invariant(baselineHead === manifest.baseline.head, "baseline head mismatch");
  invariant(pendingFirst === manifest.pending.first, "pending first migration mismatch");
  invariant(migrationHead === manifest.pending.head, "pending head mismatch");
  invariant(migrationHead === manifest.head, "release migration head mismatch");

  return {
    release: manifest.release,
    totalCount: manifest.totalCount,
    baselineCount: manifest.baseline.count,
    pendingCount: manifest.pending.count,
    head: manifest.head,
  };
}

verifyMigrationManifest()
  .then((result) => {
    process.stdout.write(
      `Migration manifest PASS: release=${result.release} total=${result.totalCount} baseline=${result.baselineCount} pending=${result.pendingCount} head=${result.head}\n`,
    );
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
