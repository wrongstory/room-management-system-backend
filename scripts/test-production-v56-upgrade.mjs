import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const supabaseCli = fileURLToPath(
  new URL("../node_modules/supabase/dist/supabase.js", import.meta.url),
);
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260915000628";
const finalVersion = "20260920150000";
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const psqlArgs = [
  "exec",
  "-i",
  container,
  "psql",
  "-X",
  "-qAt",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  "postgres",
  "-d",
  "postgres",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
}

function psql(input) {
  return run("docker", psqlArgs, {
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function reset(version) {
  const args = [supabaseCli, "db", "reset", "--local", "--no-seed"];
  if (version) args.push("--version", version);
  run(process.execPath, args, { stdio: "inherit" });
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

function migrationFiles() {
  return readdirSync(new URL("../supabase/migrations", import.meta.url))
    .filter((fileName) => migrationPattern.test(fileName))
    .sort()
    .map((fileName) => {
      const [, version, name] = migrationPattern.exec(fileName);
      return { version, name };
    });
}

function migrationHistory() {
  return JSON.parse(
    psql(`select coalesce(jsonb_agg(jsonb_build_object(
      'version',version,'name',name
    ) order by version),'[]'::jsonb)
    from supabase_migrations.schema_migrations`),
  );
}

function baselineTableShape() {
  return JSON.parse(
    psql(`select coalesce(jsonb_agg(table_shape order by table_schema,table_name),'[]'::jsonb)
    from (
      select
        c.table_schema,
        c.table_name,
        jsonb_agg(c.column_name order by c.ordinal_position) as columns
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema=c.table_schema and t.table_name=c.table_name
      where c.table_schema in ('public','private')
        and t.table_type='BASE TABLE'
      group by c.table_schema,c.table_name
    ) table_shape`),
  );
}

function tableRowHashes({ table_schema: schema, table_name: table, columns }) {
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const selected = columns.map(quoteIdentifier).join(",");
  return JSON.parse(psql(`with source_rows as (
      select ${selected} from ${qualified}
    ), row_hashes as (
      select encode(extensions.digest(
        convert_to(to_jsonb(source_rows)::text,'UTF8'),
        'sha256'
      ),'hex') as value
      from source_rows
    )
    select coalesce(jsonb_agg(value order by value),'[]'::jsonb)
    from row_hashes`));
}

function captureBaseline(shape) {
  return Object.fromEntries(
    shape.map((table) => [
      `${table.table_schema}.${table.table_name}`,
      tableRowHashes(table),
    ]),
  );
}

function assertRowsPreserved(before, after, table) {
  const remaining = new Map();
  for (const hash of after) remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
  for (const hash of before) {
    const count = remaining.get(hash) ?? 0;
    assert(count > 0, `migration 57 -> 77 changed or removed an existing ${table} row`);
    remaining.set(hash, count - 1);
  }
}

function assertHistory(actual, expected, label) {
  assert(actual.length === expected.length, `${label} migration count mismatch`);
  for (const [index, migration] of expected.entries()) {
    assert(
      actual[index]?.version === migration.version && actual[index]?.name === migration.name,
      `${label} migration ${index + 1} does not match the source-controlled release order`,
    );
  }
}

let passed = false;
try {
  const expectedMigrations = migrationFiles();
  assert(expectedMigrations.length === 77, "release candidate must contain exactly 77 migrations");
  assert(
    expectedMigrations[55]?.version === baselineVersion &&
      expectedMigrations[55]?.name === "cleaning_template_duration_optional",
    "migration 56 must be cleaning_template_duration_optional",
  );
  assert(
    expectedMigrations.at(-1)?.version === finalVersion &&
      expectedMigrations.at(-1)?.name === "room_status_admin_correction",
    "migration 77 must be room_status_admin_correction",
  );

  reset(baselineVersion);
  assertHistory(migrationHistory(), expectedMigrations.slice(0, 56), "production baseline");

  const baselineCardinality = psql(`select concat_ws('|',
    (select count(*) from public.rooms),
    (select count(*) from public.reservations)
  )`);
  assert(baselineCardinality === "121|0", "v56 baseline must contain 121 rooms and zero reservations");

  const shape = baselineTableShape();
  assert(shape.length > 0, "baseline table inventory must not be empty");
  const before = captureBaseline(shape);

  run(process.execPath, [supabaseCli, "migration", "up", "--local"], {
    stdio: "inherit",
  });

  assertHistory(migrationHistory(), expectedMigrations, "release candidate");
  const after = captureBaseline(shape);
  for (const [table, hashes] of Object.entries(before)) {
    assertRowsPreserved(hashes, after[table], table);
  }

  const finalState = psql(`select concat_ws('|',
    (select count(*) from public.rooms),
    (select count(*) from public.reservations),
    to_regprocedure('public.list_room_events(uuid,uuid,uuid,integer)') is not null,
    to_regprocedure('public.confirm_generated_room_pin(uuid,uuid,uuid,bigint,text,text)') is not null,
    (select count(*) from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity)
  )`);
  assert(
    finalState === "121|0|t|t|0",
    "upgraded schema/cardinality/RLS state is not the approved v0.5.0 candidate contract",
  );

  passed = true;
  process.stdout.write(
    `production-baseline 56 -> 77 cumulative upgrade: PASS (${shape.length} baseline tables preserved)\n`,
  );
} finally {
  try {
    reset();
  } catch (error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if (passed) process.exitCode = 1;
  }
}
