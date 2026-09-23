import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APP_OWNED_SCHEMAS,
  BACKUP_RETENTION_DAYS,
  assertLocalSyntheticTarget,
  assertManifestSafe,
  assertMigrationMatchesSource,
  assertSafeOutputRoot,
  pruneExpiredSuccessfulRuns,
  publishSuccessfulRun,
  sha256File,
  validateDataDump,
  validateRolesDump,
  validateSchemaDump,
  verifyArtifactHashes,
} from "./lib/backup-recovery-dry-run.mjs";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const containerName = "supabase_db_room-management-system-backend";
const sourceDatabase = "postgres";
const migrationManifestPath = resolve(projectRoot, "supabase", "migration-manifest.dev.json");

function parseArguments(argv) {
  const values = { target: "local-synthetic", outputRoot: resolve(projectRoot, ".tmp", "backup-recovery") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--target") values.target = argv[++index];
    else if (argument === "--output-root") values.outputRoot = resolve(argv[++index]);
    else throw new Error(`BACKUP_ARGUMENT_NOT_ALLOWED:${argument}`);
  }
  return values;
}

function run(command, arguments_, options = {}) {
  try {
    const output = execFileSync(command, arguments_, {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: options.capture === false ? "ignore" : ["ignore", "pipe", "pipe"],
    });
    return typeof output === "string" ? output.trim() : "";
  } catch (error) {
    const code = typeof error.status === "number" ? error.status : "unknown";
    throw new Error(`${options.errorCode ?? "BACKUP_COMMAND_FAILED"}:${command}:${code}`);
  }
}

function docker(arguments_, options = {}) {
  return run("docker", arguments_, options);
}

function psql(database, sql) {
  return docker([
    "exec",
    containerName,
    "psql",
    "-X",
    "-U",
    "postgres",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
    "-c",
    sql,
  ]);
}

function parseJsonOutput(output, errorCode) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(errorCode);
  }
}

function assertLocalContainer() {
  const labels = parseJsonOutput(
    docker(["inspect", containerName, "--format", "{{json .Config.Labels}}"]),
    "BACKUP_LOCAL_CONTAINER_LABELS_INVALID",
  );
  if (labels["com.supabase.cli.project"] !== "room-management-system-backend") {
    throw new Error("BACKUP_CONTAINER_NOT_LOCAL_PROJECT");
  }
  const running = docker(["inspect", containerName, "--format", "{{.State.Running}}"]);
  if (running !== "true") throw new Error("BACKUP_LOCAL_CONTAINER_NOT_RUNNING");
}

function sourceSafetySnapshot() {
  return parseJsonOutput(
    psql(
      sourceDatabase,
      `select json_build_object(
        'rooms', (select count(*) from public.rooms),
        'profiles', (select count(*) from public.profiles),
        'reservations', (select count(*) from public.reservations),
        'authUsers', (select count(*) from auth.users),
        'pinRevisions', (select count(*) from private.room_pin_revisions),
        'pushRevisions', (select count(*) from private.web_push_subscription_revisions)
      )::text`,
    ),
    "BACKUP_SOURCE_SAFETY_SNAPSHOT_INVALID",
  );
}

function assertSyntheticSource(snapshot) {
  if (snapshot.rooms !== 121) throw new Error("BACKUP_SYNTHETIC_ROOM_COUNT_INVALID");
  for (const key of ["profiles", "reservations", "authUsers", "pinRevisions", "pushRevisions"]) {
    if (snapshot[key] !== 0) throw new Error(`BACKUP_SOURCE_NOT_SYNTHETIC:${key}`);
  }
}

function migrationSnapshot() {
  return parseJsonOutput(
    psql(
      sourceDatabase,
      `select json_build_object(
        'count', count(*),
        'version', max(version),
        'name', (array_agg(name order by version desc))[1]
      )::text from supabase_migrations.schema_migrations`,
    ),
    "BACKUP_MIGRATION_SNAPSHOT_INVALID",
  );
}

function tableNames(database) {
  const output = psql(
    database,
    `select n.nspname || '.' || c.relname
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     where n.nspname in ('public','private') and c.relkind in ('r','p')
     order by 1`,
  );
  return output ? output.split(/\r?\n/u) : [];
}

function tableCounts(database, expectedTables = null) {
  const tables = tableNames(database);
  if (expectedTables && JSON.stringify(tables) !== JSON.stringify(expectedTables)) {
    throw new Error("BACKUP_RESTORE_TABLE_SET_MISMATCH");
  }
  const query = tables
    .map((name) => {
      const [schema, table] = name.split(".");
      return `select '${schema}.${table}' as relation, count(*)::bigint as row_count from "${schema}"."${table}"`;
    })
    .join(" union all ");
  const output = psql(database, `${query} order by relation`);
  return Object.fromEntries(
    output.split(/\r?\n/u).filter(Boolean).map((line) => {
      const [name, count] = line.split("|");
      return [name, Number(count)];
    }),
  );
}

function supabase(arguments_, options) {
  const entrypoint = resolve(projectRoot, "node_modules", "supabase", "dist", "supabase.js");
  return run(process.execPath, [entrypoint, ...arguments_], options);
}

function dumpArtifacts(stagingDirectory) {
  supabase([
    "db",
    "dump",
    "--local",
    "--schema",
    APP_OWNED_SCHEMAS.join(","),
    "--file",
    resolve(stagingDirectory, "schema.sql"),
  ], { errorCode: "BACKUP_SCHEMA_DUMP_FAILED" });
  supabase([
    "db",
    "dump",
    "--local",
    "--schema",
    APP_OWNED_SCHEMAS.join(","),
    "--data-only",
    "--use-copy",
    "--file",
    resolve(stagingDirectory, "data.sql"),
  ], { errorCode: "BACKUP_DATA_DUMP_FAILED" });
  supabase([
    "db",
    "dump",
    "--local",
    "--role-only",
    "--file",
    resolve(stagingDirectory, "roles.sql"),
  ], { errorCode: "BACKUP_ROLES_DUMP_FAILED" });
}

async function validateArtifacts(stagingDirectory) {
  const roles = await readFile(resolve(stagingDirectory, "roles.sql"), "utf8");
  const schema = await readFile(resolve(stagingDirectory, "schema.sql"), "utf8");
  const data = await readFile(resolve(stagingDirectory, "data.sql"), "utf8");
  validateRolesDump(roles);
  validateSchemaDump(schema);
  validateDataDump(data);
}

function createDisposableDatabase(database) {
  docker(["exec", containerName, "createdb", "-U", "postgres", database], {
    errorCode: "BACKUP_RESTORE_DATABASE_CREATE_FAILED",
  });
  psql(
    database,
    `create schema auth;
     create table auth.users(id uuid primary key);
     create schema extensions;
     create extension pgcrypto with schema extensions;
     create extension btree_gist with schema extensions;`,
  );
}

function dropDisposableDatabase(database) {
  if (!/^rms_backup_restore_[a-f0-9]{20}$/u.test(database)) {
    throw new Error("BACKUP_RESTORE_DATABASE_NAME_INVALID");
  }
  docker(["exec", containerName, "dropdb", "-U", "postgres", "--if-exists", database], {
    errorCode: "BACKUP_RESTORE_DATABASE_DROP_FAILED",
  });
}

function restoreArtifacts(database, stagingDirectory) {
  const containerSchema = `/tmp/${database}-schema.sql`;
  const containerData = `/tmp/${database}-data.sql`;
  docker(["cp", resolve(stagingDirectory, "schema.sql"), `${containerName}:${containerSchema}`], {
    errorCode: "BACKUP_SCHEMA_COPY_FAILED",
  });
  docker(["cp", resolve(stagingDirectory, "data.sql"), `${containerName}:${containerData}`], {
    errorCode: "BACKUP_DATA_COPY_FAILED",
  });
  try {
    docker([
      "exec",
      containerName,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      database,
      "--single-transaction",
      "-v",
      "ON_ERROR_STOP=1",
      "-f",
      containerSchema,
    ], { capture: false, errorCode: "BACKUP_SCHEMA_RESTORE_FAILED" });
    docker([
      "exec",
      containerName,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      database,
      "--single-transaction",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      "set session_replication_role=replica",
      "-f",
      containerData,
    ], { capture: false, errorCode: "BACKUP_DATA_RESTORE_FAILED" });
  } finally {
    docker(["exec", containerName, "rm", "-f", containerSchema, containerData], {
      capture: false,
      errorCode: "BACKUP_RESTORE_TEMPFILE_CLEANUP_FAILED",
    });
  }
}

function assertCriticalRpcGrants(database) {
  const query = `with expected(name, signature) as (values
    ('create_account_profile','public.create_account_profile(uuid,uuid,uuid,text,text,public.app_role,text,text,text,text)'),
    ('get_developer_database_status','public.get_developer_database_status(uuid,text)'),
    ('get_room_operational_projection','public.get_room_operational_projection(uuid,uuid)'),
    ('is_active_auth_session','public.is_active_auth_session(uuid,uuid)'),
    ('process_due_reservation_transitions','public.process_due_reservation_transitions(uuid,timestamp with time zone,text,text)')
  )
  select name || '|' || (
    oid is not null
    and has_function_privilege('service_role', oid, 'EXECUTE')
    and not has_function_privilege('anon', oid, 'EXECUTE')
    and not has_function_privilege('authenticated', oid, 'EXECUTE')
  )::text
  from expected
  cross join lateral (select to_regprocedure(signature) as oid) resolved
  order by name`;
  const results = psql(database, query).split(/\r?\n/u).filter(Boolean);
  if (results.length !== 5 || results.some((result) => !result.endsWith("|true"))) {
    throw new Error("BACKUP_RESTORE_CRITICAL_RPC_INVALID");
  }
}

function assertPostRestore(database, sourceTables, sourceCounts) {
  const restoredRooms = Number(psql(database, "select count(*) from public.rooms"));
  if (restoredRooms !== 121) throw new Error("BACKUP_RESTORE_ROOM_COUNT_INVALID");
  const rlsMissing = Number(
    psql(
      database,
      `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity`,
    ),
  );
  if (rlsMissing !== 0) throw new Error("BACKUP_RESTORE_RLS_MISSING");
  const restoredCounts = tableCounts(database, sourceTables);
  if (JSON.stringify(restoredCounts) !== JSON.stringify(sourceCounts)) {
    throw new Error("BACKUP_RESTORE_ROW_COUNTS_MISMATCH");
  }
  assertCriticalRpcGrants(database);
}

async function artifactMetadata(stagingDirectory) {
  const files = ["roles.sql", "schema.sql", "data.sql"];
  return Promise.all(
    files.map(async (file) => {
      const filePath = resolve(stagingDirectory, file);
      const source = await readFile(filePath);
      return { file, bytes: source.byteLength, sha256: await sha256File(filePath) };
    }),
  );
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  assertLocalSyntheticTarget(arguments_.target);
  const outputRoot = assertSafeOutputRoot(projectRoot, arguments_.outputRoot);
  await mkdir(outputRoot, { recursive: true });
  assertLocalContainer();

  const migrationManifest = JSON.parse(await readFile(migrationManifestPath, "utf8"));
  const migrationFiles = (await readdir(resolve(projectRoot, "supabase", "migrations")))
    .filter((fileName) => fileName.endsWith(".sql"))
    .sort();
  const headFile = migrationFiles.at(-1);
  const headVersion = /^(\d{14})_/u.exec(headFile)?.[1];
  if (!headVersion) throw new Error("BACKUP_MIGRATION_HEAD_FILE_INVALID");

  const sourceSafety = sourceSafetySnapshot();
  assertSyntheticSource(sourceSafety);
  const sourceMigration = migrationSnapshot();
  assertMigrationMatchesSource(sourceMigration, migrationManifest, headVersion);
  const sourceTables = tableNames(sourceDatabase);
  const sourceCounts = tableCounts(sourceDatabase, sourceTables);

  const runId = randomUUID();
  const stagingDirectory = resolve(outputRoot, `.staging-${runId}`);
  await mkdir(stagingDirectory, { recursive: false });
  let disposableDatabase = null;
  try {
    dumpArtifacts(stagingDirectory);
    await validateArtifacts(stagingDirectory);

    disposableDatabase = `rms_backup_restore_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
    createDisposableDatabase(disposableDatabase);
    restoreArtifacts(disposableDatabase, stagingDirectory);
    assertPostRestore(disposableDatabase, sourceTables, sourceCounts);
    dropDisposableDatabase(disposableDatabase);
    disposableDatabase = null;

    const completedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      runId,
      target: "local-synthetic",
      completedAt,
      source: {
        commit: run("git", ["rev-parse", "HEAD"]),
        tree: run("git", ["rev-parse", "HEAD^{tree}"]),
        migrationCount: migrationManifest.totalCount,
        migrationHead: migrationManifest.head,
        migrationVersion: headVersion,
        migrationManifestSha256: await sha256File(migrationManifestPath),
      },
      policy: {
        timezone: "Asia/Seoul",
        dailyWindow: "01:00-06:00",
        retentionDays: BACKUP_RETENTION_DAYS,
        schemas: APP_OWNED_SCHEMAS,
      },
      checks: {
        rooms: 121,
        publicRlsMissing: 0,
        criticalRpcs: 5,
        tableCount: sourceTables.length,
        rowCountsMatched: true,
      },
      artifacts: await artifactMetadata(stagingDirectory),
    };
    assertManifestSafe(manifest);
    await writeFile(resolve(stagingDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await verifyArtifactHashes(stagingDirectory, manifest);
    const successDirectory = await publishSuccessfulRun({ outputRoot, stagingDirectory, manifest });
    try {
      await pruneExpiredSuccessfulRuns(outputRoot);
    } catch {
      process.stderr.write("BACKUP_RETENTION_PRUNE_DEFERRED\n");
    }
    process.stdout.write(
      `Backup recovery dry-run PASS: target=local-synthetic migrations=${manifest.source.migrationCount} head=${manifest.source.migrationHead} rooms=121 artifact=${successDirectory}\n`,
    );
  } catch (error) {
    const failedDirectory = resolve(outputRoot, `failed-${new Date().toISOString().replaceAll(/[-:.]/gu, "")}-${runId}`);
    try {
      await rename(stagingDirectory, failedDirectory);
    } catch {
      await rm(stagingDirectory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    if (disposableDatabase) dropDisposableDatabase(disposableDatabase);
  }
}

await main();
