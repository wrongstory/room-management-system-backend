import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const migrationDirectory = resolve(projectRoot, "supabase", "migrations");
const manifestPath = resolve(projectRoot, "supabase", "migration-manifest.v0.5.0.json");
const migrationFilePattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const baselineCount = 74;

function invariant(condition, message) {
  if (!condition) throw new Error(`Migration manifest generation failed: ${message}`);
}

function canonicalContent(source, fileName) {
  const normalized = source.replaceAll("\r\n", "\n");
  invariant(!normalized.includes("\r"), `${fileName} contains a standalone CR byte`);
  return normalized;
}

const files = (await readdir(migrationDirectory))
  .filter((fileName) => fileName.endsWith(".sql"))
  .sort();

const migrations = [];
let previousVersion = "";
for (const [index, fileName] of files.entries()) {
  const match = migrationFilePattern.exec(fileName);
  invariant(match, `unexpected migration filename ${fileName}`);
  invariant(match[1] > previousVersion, `${fileName} is not in strict version order`);
  const source = await readFile(resolve(migrationDirectory, fileName), "utf8");
  migrations.push({
    order: index + 1,
    name: match[2],
    sha256: createHash("sha256").update(canonicalContent(source, fileName), "utf8").digest("hex"),
  });
  previousVersion = match[1];
}

invariant(migrations.length === 75, `expected 75 migrations, found ${migrations.length}`);
invariant(baselineCount < migrations.length, "baseline must precede the release head");

const manifest = {
  schemaVersion: 1,
  release: "v0.5.0",
  hashAlgorithm: "sha256-lf-utf8",
  totalCount: migrations.length,
  baseline: {
    count: baselineCount,
    head: migrations[baselineCount - 1].name,
  },
  pending: {
    count: migrations.length - baselineCount,
    first: migrations[baselineCount].name,
    head: migrations.at(-1).name,
  },
  head: migrations.at(-1).name,
  migrations,
};

await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(
  `Migration manifest generated: release=${manifest.release} total=${manifest.totalCount} baseline=${manifest.baseline.count} pending=${manifest.pending.count} head=${manifest.head}\n`,
);
