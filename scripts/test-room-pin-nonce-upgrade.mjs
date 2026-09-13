import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(
  new URL("fixtures/room-pin-nonce-upgrade-v52.sql", import.meta.url),
);
const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260913075134_room_pin_nonce_reservation_hardening.sql",
    import.meta.url,
  ),
  "utf8",
);
const supabaseCli = fileURLToPath(
  new URL("../node_modules/supabase/dist/supabase.js", import.meta.url),
);
const container = "supabase_db_room-management-system-backend";
const actorId = "f1531000-0000-4000-8000-000000000001";
const migrationVersion = "20260913075134";
const psqlBase = [
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

function resetToV52() {
  run(
    process.execPath,
    [
      supabaseCli,
      "db",
      "reset",
      "--local",
      "--no-seed",
      "--version",
      "20260913041707",
    ],
    { stdio: "inherit" },
  );
}

function psql(input, variables = {}) {
  const args = [...psqlBase];
  for (const [name, value] of Object.entries(variables))
    args.push("-v", `${name}=${value}`);
  return run("docker", args, { input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function seedV52() {
  psql(fixture, { inject_conflict: 0 });
}

// Hash every column of every in-scope v52 ledger row. This checks exact PK/FK,
// status/version/timestamps and receipt JSON without printing envelope bytes.
function ledgerSnapshot() {
  return psql(`with fixture_rooms as (
      select room_id from private.room_pin_change_leases where actor_profile_id='${actorId}'
      union select room_id from private.room_pin_revisions where recorded_by='${actorId}'
    ), exact_ledger as (
      select jsonb_build_object(
        'rooms', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from public.rooms where id in (select room_id from fixture_rooms)) x), '[]'),
        'leases', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from private.room_pin_change_leases where actor_profile_id='${actorId}') x), '[]'),
        'revisions', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from private.room_pin_revisions where recorded_by='${actorId}') x), '[]'),
        'currentPointers', coalesce((select jsonb_agg(to_jsonb(x) order by room_id) from (select * from private.room_current_pin where room_id in (select room_id from fixture_rooms)) x), '[]'),
        'syncEvents', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from public.room_pin_sync_events where actor_profile_id='${actorId}') x), '[]'),
        'sheetOutbox', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from private.room_pin_sheet_sync_outbox where room_id in (select room_id from fixture_rooms)) x), '[]'),
        'audit', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from public.audit_events where actor_profile_id='${actorId}') x), '[]'),
        'receipts', coalesce((select jsonb_agg(to_jsonb(x) order by id) from (select * from private.command_executions where actor_profile_id='${actorId}') x), '[]')
      ) payload
    )
    select encode(extensions.digest(convert_to(payload::text,'UTF8'),'sha256'),'hex') from exact_ledger`);
}

function ledgerShape() {
  return psql(`with fixture_rooms as (
      select room_id from private.room_pin_change_leases where actor_profile_id='${actorId}'
      union select room_id from private.room_pin_revisions where recorded_by='${actorId}'
    ) select concat_ws('|',
      (select count(*) from private.room_pin_change_leases where actor_profile_id='${actorId}'),
      (select count(*) from private.room_pin_revisions where recorded_by='${actorId}'),
      (select count(*) from private.room_current_pin where room_id in (select room_id from fixture_rooms)),
      (select count(*) from public.room_pin_sync_events where actor_profile_id='${actorId}'),
      (select count(*) from private.room_pin_sheet_sync_outbox where room_id in (select room_id from fixture_rooms)),
      (select count(*) from public.audit_events where actor_profile_id='${actorId}'),
      (select count(*) from private.command_executions where actor_profile_id='${actorId}'),
      (select string_agg(status || ':' || count, ',' order by status) from (
        select status, count(*)::text count from private.room_pin_change_leases where actor_profile_id='${actorId}' group by status
      ) statuses))`);
}

function migrationRecorded() {
  return psql(
    `select exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}')`,
  );
}

function newArtifactShape() {
  return psql(`select concat_ws('|',
    to_regclass('private.room_pin_nonce_reservations') is not null,
    (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in (
      'room_pin_envelope_fingerprint','reserve_room_pin_nonce_from_envelope','guard_room_pin_change_lease_encryption_identity')),
    (select count(*) from pg_trigger where not tgisinternal and tgname in (
      'room_pin_change_lease_nonce_reserved','room_pin_change_lease_encryption_identity_immutable','room_pin_nonce_reservations_append_only')))`);
}

function assertNoNewArtifacts(message) {
  assert(newArtifactShape() === "f|0|0", message);
  assert(
    migrationRecorded() === "f",
    `${message}: migration history must remain unrecorded`,
  );
}

function startMigration(extraEnv = {}) {
  const child = spawn(
    process.execPath,
    [supabaseCli, "migration", "up", "--local"],
    {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, output }));
  });
  return { child, done };
}

class PsqlSession {
  constructor() {
    this.child = spawn("docker", psqlBase, {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stderr = "";
    this.buffer = "";
    this.current = null;
    this.sequence = 0;
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      const lines = this.buffer.split(/\r?\n/u);
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (this.current && line === this.current.token) {
          const current = this.current;
          this.current = null;
          current.resolve(current.output.join("\n").trim());
        } else if (this.current) this.current.output.push(line);
      }
    });
    this.closed = new Promise((resolve) =>
      this.child.once("close", (code) => resolve(code)),
    );
  }

  query(sql) {
    assert(
      this.current === null,
      "only one synchronized command may run per DB session",
    );
    const token = `__ROOM_PIN_SYNC_${++this.sequence}__`;
    const completion = new Promise((resolve, reject) => {
      this.current = { token, output: [], resolve, reject };
    });
    this.child.stdin.write(`${sql}\n\\echo ${token}\n`);
    void this.closed.then((code) => {
      if (this.current?.token === token) {
        const current = this.current;
        this.current = null;
        current.reject(
          new Error(`psql session exited ${code}: ${this.stderr}`),
        );
      }
    });
    return completion;
  }

  async close() {
    if (!this.child.killed && this.child.exitCode === null)
      this.child.stdin.end("\\q\n");
    await this.closed;
  }
}

const pause = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForLock({ mode, granted, minimum = 1 }, message) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const count = Number(
      psql(`select count(*) from pg_locks where relation in (
      'private.room_pin_change_leases'::regclass,'private.room_pin_revisions'::regclass)
      and mode='${mode}' and granted=${granted ? "true" : "false"}`),
    );
    if (count >= minimum) return;
    await pause(40);
  }
  throw new Error(message);
}

const validWriterSql = `begin;
insert into private.room_pin_revisions(id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,key_version,aad_environment,aad_project_ref,recorded_by,recorded_by_role,source)
select 'f1531000-0000-4000-8000-000000000307',id,1,1,digest('upgrade-writer-cipher','sha256'),
  substring(digest('upgrade-writer-nonce','sha256') for 12),substring(digest('upgrade-writer-tag','sha256') for 16),
  'upgrade-v1','test','local','${actorId}','admin','admin_initial_entry'
from public.rooms order by room_number offset 6 limit 1;`;

const conflictingWriterSql = `begin;
insert into private.room_pin_revisions(id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,key_version,aad_environment,aad_project_ref,recorded_by,recorded_by_role,source)
select 'f1531000-0000-4000-8000-000000000308',id,1,1,digest('upgrade-writer-conflict-cipher','sha256'),
  substring(digest('upgrade-lease-nonce-1','sha256') for 12),substring(digest('upgrade-writer-conflict-tag','sha256') for 16),
  'upgrade-v1','test','local','${actorId}','admin','admin_initial_entry'
from public.rooms order by room_number offset 7 limit 1;`;

async function verifyCleanUpgradePreservesCompleteLedger() {
  resetToV52();
  seedV52();
  assert(
    ledgerShape() ===
      "4|2|1|1|1|1|1|confirmed:1,expired:1,prepared:1,rolled_back:1",
    "v52 fixture must include every required ledger class and lease state",
  );
  const before = ledgerSnapshot();
  const result = await startMigration().done;
  assert(result.code === 0, "clean v52 history must upgrade successfully");
  assert(
    ledgerSnapshot() === before,
    "successful upgrade must preserve the exact complete v52 ledger",
  );
  assert(
    migrationRecorded() === "t",
    "successful upgrade must atomically record migration history",
  );
  assert(
    psql("select count(*) from private.room_pin_nonce_reservations") === "5",
    "clean fixture must backfill five logical encryptions",
  );
}

async function verifyCommittedWriterIsVisibleAfterLockWait() {
  resetToV52();
  seedV52();
  const writer = new PsqlSession();
  await writer.query(validWriterSql);
  const applying = startMigration();
  await waitForLock(
    { mode: "ShareRowExclusiveLock", granted: false },
    "migration did not wait behind the uncommitted v52 writer",
  );
  await writer.query("commit;");
  await writer.close();
  const committedLedger = ledgerSnapshot();
  const result = await applying.done;
  assert(
    result.code === 0,
    "migration must succeed after a valid v52 writer commits",
  );
  assert(
    ledgerSnapshot() === committedLedger,
    "migration must preserve the writer commit exactly",
  );
  assert(
    psql(`select count(*) from private.room_pin_nonce_reservations where key_version='upgrade-v1'
    and nonce=substring(digest('upgrade-writer-nonce','sha256') for 12)`) ===
      "1",
    "READ COMMITTED scan after lock wait must include the writer reservation",
  );
}

async function verifyConflictingCommittedWriterRollsMigrationBack() {
  resetToV52();
  seedV52();
  const writer = new PsqlSession();
  await writer.query(conflictingWriterSql);
  const applying = startMigration();
  await waitForLock(
    { mode: "ShareRowExclusiveLock", granted: false },
    "migration did not wait behind the conflicting v52 writer",
  );
  await writer.query("commit;");
  await writer.close();
  const committedEvidence = ledgerSnapshot();
  const result = await applying.done;
  assert(
    result.code !== 0 &&
      result.output.includes("ROOM_PIN_HISTORICAL_NONCE_REUSE"),
    "committed conflicting evidence must fail with the stable code",
  );
  assertNoNewArtifacts(
    "historical conflict must roll every migration artifact back",
  );
  assert(
    ledgerSnapshot() === committedEvidence,
    "historical conflict must preserve the writer and complete ledger exactly",
  );
}

async function verifyMigrationFirstForcesWriterThroughNewTrigger() {
  resetToV52();
  seedV52();
  const before = ledgerSnapshot();
  psql(`create function private.upgrade_test_pause_after_table_locks() returns event_trigger
    language plpgsql set search_path='' as $$
    begin perform pg_catalog.pg_advisory_xact_lock(140, 53); end $$;
    create event trigger upgrade_test_pause_after_table_locks on ddl_command_start
    when tag in ('CREATE FUNCTION') execute function private.upgrade_test_pause_after_table_locks();`);
  const gate = new PsqlSession();
  await gate.query(`begin; select pg_advisory_xact_lock(140, 53);`);
  const applying = startMigration();
  await waitForLock(
    { mode: "ShareRowExclusiveLock", granted: true, minimum: 2 },
    "migration did not acquire both table locks before the DDL barrier",
  );
  const writer = new PsqlSession();
  const writerResult = writer.query(conflictingWriterSql).then(
    () => ({ succeeded: true, output: "" }),
    (error) => ({ succeeded: false, output: String(error) }),
  );
  await waitForLock(
    { mode: "RowExclusiveLock", granted: false },
    "v52 writer was not queued behind the migration lock",
  );
  await gate.query("commit;");
  await gate.close();
  const migrationResult = await applying.done;
  assert(
    migrationResult.code === 0,
    "migration must acquire the queued lock before the later writer",
  );
  const blockedWriter = await writerResult;
  await writer.close();
  assert(
    !blockedWriter.succeeded &&
      blockedWriter.output.includes("ROOM_PIN_NONCE_REUSE"),
    "released writer must pass through the new reservation trigger",
  );
  assert(
    ledgerSnapshot() === before,
    "rejected post-migration writer must leave the complete ledger unchanged",
  );
}

async function verifyLockTimeoutHasNoPartialApply() {
  resetToV52();
  seedV52();
  const before = ledgerSnapshot();
  const gate = new PsqlSession();
  await gate.query(
    `begin; lock table private.room_pin_change_leases, private.room_pin_revisions in share row exclusive mode;`,
  );
  const result = await startMigration({ PGOPTIONS: "-c lock_timeout=250ms" })
    .done;
  assert(
    result.code !== 0 && /lock timeout/iu.test(result.output),
    "migration lock timeout must fail instead of being ignored",
  );
  assertNoNewArtifacts("lock timeout must leave no partial artifacts");
  assert(
    ledgerSnapshot() === before,
    "lock timeout must leave the complete v52 ledger unchanged",
  );
  await gate.query("commit;");
  await gate.close();
}

async function verifyMidMigrationFailureIsAtomic() {
  resetToV52();
  seedV52();
  psql(`create function private.upgrade_test_passthrough() returns trigger language plpgsql set search_path='' as $$ begin return new; end $$;
    create trigger room_pin_revision_nonce_reserved before insert on private.room_pin_revisions for each row execute function private.upgrade_test_passthrough();`);
  const before = ledgerSnapshot();
  const result = await startMigration().done;
  assert(
    result.code !== 0 &&
      /room_pin_revision_nonce_reserved/iu.test(result.output),
    "late trigger collision must force a mid-migration failure",
  );
  assertNoNewArtifacts(
    "mid-migration failure must roll registry, helpers and earlier triggers back",
  );
  assert(
    psql(
      `select count(*) from pg_trigger where not tgisinternal and tgname='room_pin_revision_nonce_reserved'`,
    ) === "1",
    "pre-existing failure evidence must remain unchanged",
  );
  assert(
    ledgerSnapshot() === before,
    "mid-migration failure must preserve the complete v52 ledger exactly",
  );
}

let passed = false;
try {
  assert(
    /^begin;/mu.test(migration) && /commit;\s*$/mu.test(migration),
    "migration must author the transaction required by LOCK TABLE",
  );
  assert(
    !/create\s+(?:unique\s+)?index\s+concurrently|reindex[\s\S]*concurrently|\bvacuum\b|alter\s+system|\bcluster\b/iu.test(
      migration,
    ),
    "migration must not contain a pipeline-incompatible statement",
  );
  await verifyCleanUpgradePreservesCompleteLedger();
  await verifyCommittedWriterIsVisibleAfterLockWait();
  await verifyConflictingCommittedWriterRollsMigrationBack();
  await verifyMigrationFirstForcesWriterThroughNewTrigger();
  await verifyLockTimeoutHasNoPartialApply();
  await verifyMidMigrationFailureIsAtomic();
  passed = true;
  process.stdout.write("room PIN nonce 52 -> 53 atomic online upgrade: PASS\n");
} finally {
  try {
    run(
      process.execPath,
      [supabaseCli, "db", "reset", "--local", "--no-seed"],
      { stdio: "inherit" },
    );
  } catch (restoreError) {
    process.stderr.write(
      `failed to restore full local migration state: ${restoreError}\n`,
    );
    if (passed) process.exitCode = 1;
  }
}
