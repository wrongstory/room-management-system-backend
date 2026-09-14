import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(
  new URL("fixtures/production-baseline-v19.sql", import.meta.url),
);
const supabaseCli = fileURLToPath(
  new URL("../node_modules/supabase/dist/supabase.js", import.meta.url),
);
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260831124140";
const finalVersion = "20260913141655";
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const fixtureUserIds = [
  "f0190000-0000-4000-8000-000000000101",
  "f0190000-0000-4000-8000-000000000102",
  "f0190000-0000-4000-8000-000000000103",
];
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

function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
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

function tableFingerprint({ table_schema: schema, table_name: table, columns }) {
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
  const selected = columns.map(quoteIdentifier).join(",");
  return psql(`with source_rows as (
      select ${selected} from ${qualified}
    ), canonical as (
      select to_jsonb(source_rows) as value from source_rows
    )
    select concat(
      count(*)::text,
      ':',
      encode(extensions.digest(convert_to(
        coalesce(jsonb_agg(value order by value::text),'[]'::jsonb)::text,
        'UTF8'
      ),'sha256'),'hex')
    )
    from canonical`);
}

function authFingerprint() {
  const ids = fixtureUserIds.map(quoteLiteral).join(",");
  return psql(`with auth_rows as (
      select jsonb_build_object('id',u.id) value
      from auth.users u where u.id in (${ids})
      union all
      select jsonb_build_object('id',s.id,'userId',s.user_id) value
      from auth.sessions s where s.user_id in (${ids})
    )
    select concat(
      count(*)::text,
      ':',
      encode(extensions.digest(convert_to(
        coalesce(jsonb_agg(value order by value::text),'[]'::jsonb)::text,
        'UTF8'
      ),'sha256'),'hex')
    ) from auth_rows`);
}

function captureBaseline(shape) {
  // Only count:digest fingerprints leave PostgreSQL. Row values, even though
  // synthetic in this rehearsal, are never written to stdout or result files.
  const entries = shape.map((table) => [
    `${table.table_schema}.${table.table_name}`,
    tableFingerprint(table),
  ]);
  entries.push(["auth.synthetic_users_and_sessions", authFingerprint()]);
  return Object.fromEntries(entries);
}

function compositeFingerprint(snapshot) {
  return createHash("sha256")
    .update(JSON.stringify(Object.entries(snapshot).sort(([a], [b]) => a.localeCompare(b))))
    .digest("hex");
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
  assert(expectedMigrations.length === 54, "release candidate must contain exactly 54 migrations");
  assert(
    expectedMigrations[18]?.version === baselineVersion &&
      expectedMigrations[18]?.name === "actor_activity_audit_contract",
    "migration 19 must be actor_activity_audit_contract",
  );
  assert(
    expectedMigrations.at(-1)?.version === finalVersion &&
      expectedMigrations.at(-1)?.name === "checkout_not_completed_incident_workflow",
    "migration 54 must be checkout_not_completed_incident_workflow",
  );

  reset(baselineVersion);
  assertHistory(migrationHistory(), expectedMigrations.slice(0, 19), "baseline");
  psql(fixture);

  const shape = baselineTableShape();
  assert(shape.length > 0, "baseline table inventory must not be empty");
  const before = captureBaseline(shape);
  const beforeComposite = compositeFingerprint(before);

  run(process.execPath, [supabaseCli, "migration", "up", "--local"], {
    stdio: "inherit",
  });

  assertHistory(migrationHistory(), expectedMigrations, "upgraded");
  const after = captureBaseline(shape);
  const afterComposite = compositeFingerprint(after);
  for (const [table, fingerprint] of Object.entries(before)) {
    assert(after[table] === fingerprint, `migration 20 -> 54 changed ${table}`);
  }
  assert(
    beforeComposite === afterComposite,
    "migration 20 -> 54 changed a pre-existing v19 domain or ledger row",
  );

  const finalState = psql(`select concat_ws('|',
    (select count(*) from public.rooms),
    (select count(*) from public.reservations),
    (select count(*) from public.profiles where status='active' and not must_change_password),
    (select count(*) from auth.sessions where user_id in (
      ${fixtureUserIds.map(quoteLiteral).join(",")}
    )),
    to_regclass('public.checkout_presence_incidents') is not null,
    to_regclass('private.room_pin_nonce_reservations') is not null,
    to_regclass('private.notification_delivery_jobs') is not null,
    (select count(*) from pg_class c
      join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity)
  )`);
  assert(
    finalState === "121|0|3|3|t|t|t|0",
    "upgraded schema/cardinality/RLS acceptance state is not the approved v0.3.0 contract",
  );

  passed = true;
  process.stdout.write(
    `production-baseline 19 -> 54 cumulative upgrade: PASS (${shape.length} baseline tables preserved)\n`,
  );
} finally {
  try {
    reset();
  } catch (error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if (passed) process.exitCode = 1;
  }
}
