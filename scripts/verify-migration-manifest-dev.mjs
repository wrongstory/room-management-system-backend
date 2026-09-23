import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = resolve(projectRoot, "supabase", "migrations");
const manifestPath = resolve(projectRoot, "supabase", "migration-manifest.dev.json");
const releaseManifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.5.1.json");
const migrationFilePattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const sha256Pattern = /^[a-f0-9]{64}$/;

function invariant(condition, message) {
  if (!condition) throw new Error(`Development migration manifest invalid: ${message}`);
}

function canonicalContent(source, fileName) {
  const normalized = source.replaceAll("\r\n", "\n");
  invariant(!normalized.includes("\r"), `${fileName} contains a standalone CR byte`);
  return normalized;
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const releaseManifest = JSON.parse(await readFile(releaseManifestPath, "utf8"));
const files = (await readdir(migrationDirectory))
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort();

invariant(manifest.schemaVersion === 1, "schemaVersion must be 1");
invariant(manifest.release === "dev", "release must be dev");
invariant(manifest.hashAlgorithm === "sha256-lf-utf8", "unexpected hash algorithm");
invariant(manifest.totalCount === files.length, "totalCount must match every SQL migration");
invariant(manifest.baseline?.count === 78, "baseline count must be 78");
invariant(
  manifest.baseline?.head === "reservation_bookability_optional_guest_count",
  "baseline head mismatch",
);
invariant(
  JSON.stringify(manifest.migrations.slice(0, 78)) === JSON.stringify(releaseManifest.migrations),
  "published v0.5.1 migration entries must remain identical",
);
invariant(manifest.pending?.count === files.length - 78, "pending count mismatch");
invariant(manifest.head === manifest.migrations.at(-1)?.name, "head mismatch");

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
  `Development migration manifest PASS: total=${manifest.totalCount} baseline=${manifest.baseline.count} pending=${manifest.pending.count} head=${manifest.head}\n`,
);
