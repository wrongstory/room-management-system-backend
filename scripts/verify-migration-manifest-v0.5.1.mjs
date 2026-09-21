import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = resolve(projectRoot, "supabase", "migrations");
const manifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.5.1.json");
const previousManifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.5.0.json");
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

const previousManifestSource = await readFile(previousManifestPath, "utf8");
invariant(
  createHash("sha256").update(previousManifestSource, "utf8").digest("hex") ===
    "6483f279f167791b81741a14c99f6fb01f887ada833cbea5feff0d821f052af5",
  "published v0.5.0 manifest bytes changed",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const previousManifest = JSON.parse(previousManifestSource);
const files = (await readdir(migrationDirectory))
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort();

invariant(manifest.schemaVersion === 1, "schemaVersion must be 1");
invariant(manifest.release === "v0.5.1", "release must be v0.5.1");
invariant(manifest.hashAlgorithm === "sha256-lf-utf8", "unexpected hash algorithm");
invariant(manifest.totalCount === 78, "totalCount must be 78");
invariant(files.length === 78, `expected 78 SQL files, found ${files.length}`);
invariant(manifest.baseline?.count === 77, "baseline count must be 77");
invariant(manifest.baseline?.head === "room_status_admin_correction", "baseline head mismatch");
invariant(manifest.pending?.count === 1, "pending count must be 1");
invariant(
  manifest.pending?.first === "reservation_bookability_optional_guest_count" &&
    manifest.pending?.head === "reservation_bookability_optional_guest_count" &&
    manifest.head === "reservation_bookability_optional_guest_count",
  "hotfix head mismatch",
);
invariant(
  JSON.stringify(manifest.migrations.slice(0, 77)) ===
    JSON.stringify(previousManifest.migrations),
  "v0.5.0 migration entries must remain identical in v0.5.1",
);

let previousVersion = "";
for (const [index, fileName] of files.entries()) {
  const match = migrationFilePattern.exec(fileName);
  invariant(match, `unexpected migration filename ${fileName}`);
  invariant(match[1] > previousVersion, `${fileName} is not in strict version order`);
  const expected = manifest.migrations[index];
  invariant(expected?.order === index + 1, `entry ${index + 1} has the wrong order`);
  invariant(expected.name === match[2], `entry ${index + 1} expected ${match[2]}`);
  invariant(sha256Pattern.test(expected.sha256), `${expected.name} has an invalid SHA-256`);
  const source = await readFile(resolve(migrationDirectory, fileName), "utf8");
  const actualSha256 = createHash("sha256")
    .update(canonicalContent(source, fileName), "utf8")
    .digest("hex");
  invariant(actualSha256 === expected.sha256, `${expected.name} content SHA mismatch`);
  previousVersion = match[1];
}

process.stdout.write(
  `Migration manifest PASS: release=${manifest.release} total=${manifest.totalCount} baseline=${manifest.baseline.count} pending=${manifest.pending.count} head=${manifest.head}\n`,
);
