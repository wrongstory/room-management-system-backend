import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = resolve(projectRoot, "supabase", "migrations");
const manifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.6.0.json");
const previousManifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.5.1.json");
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
  createHash("sha256")
    .update(canonicalContent(previousManifestSource, "migration-manifest.v0.5.1.json"), "utf8")
    .digest("hex") === "0ff723a625105a1d178b654123f99ab0b75c8e40d9c324c895395919dabd045e",
  "published v0.5.1 manifest canonical bytes changed",
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const previousManifest = JSON.parse(previousManifestSource);
const files = (await readdir(migrationDirectory))
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort();
const releaseFiles = files.slice(0, 83);

invariant(manifest.schemaVersion === 1, "schemaVersion must be 1");
invariant(manifest.release === "v0.6.0", "release must be v0.6.0");
invariant(manifest.hashAlgorithm === "sha256-lf-utf8", "unexpected hash algorithm");
invariant(manifest.totalCount === 83, "totalCount must be 83");
invariant(files.length >= 83, `expected at least 83 SQL files, found ${files.length}`);
invariant(
  releaseFiles.at(-1) === "20260923160000_maid_pin_immediate_reveal.sql",
  "published v0.6.0 migration boundary changed",
);
invariant(manifest.baseline?.count === 78, "baseline count must be 78");
invariant(
  manifest.baseline?.head === "reservation_bookability_optional_guest_count",
  "baseline head mismatch",
);
invariant(manifest.pending?.count === 5, "pending count must be 5");
invariant(
  manifest.pending?.first === "assignment_unavailability_reassignment" &&
    manifest.pending?.head === "maid_pin_immediate_reveal" &&
    manifest.head === "maid_pin_immediate_reveal",
  "release range mismatch",
);
invariant(
  JSON.stringify(manifest.migrations.slice(0, 78)) ===
    JSON.stringify(previousManifest.migrations),
  "v0.5.1 migration entries must remain identical in v0.6.0",
);

let previousVersion = "";
for (const [index, fileName] of releaseFiles.entries()) {
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
