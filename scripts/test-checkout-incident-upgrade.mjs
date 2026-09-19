import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(
  new URL("fixtures/checkout-incident-upgrade-v53.sql", import.meta.url),
);
const supabaseCli = fileURLToPath(
  new URL("../node_modules/supabase/dist/supabase.js", import.meta.url),
);
const container = "supabase_db_room-management-system-backend";
const migrationVersion = "20260913141655";
const id = (n) => `f3310000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const psqlArgs = [
  "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
  "-U", "postgres", "-d", "postgres",
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
function snapshot() {
  const reservation = id(300);
  const admin = id(1);
  return psql(`with target as (
      select id from public.cleaning_targets where reservation_id='${reservation}'
    ), assignment as (
      select id from public.cleaning_assignments where cleaning_target_id in (select id from target)
    ), attempt as (
      select id from public.cleaning_attempts where cleaning_target_id in (select id from target)
    ), payload as (
      select jsonb_build_object(
        -- Later additive schema versions must not make this 53 -> 54 ledger
        -- preservation check compare columns that did not exist at v53.
        'reservation',(select to_jsonb(x)-'reservation_type' from public.reservations x where id='${reservation}'),
        'obligation',(select to_jsonb(x) from public.checkout_cleaning_obligations x where reservation_id='${reservation}'),
        'targets',(select jsonb_agg(to_jsonb(x)-'stay_segment_checkout_obligation_id' order by id) from public.cleaning_targets x where id in (select id from target)),
        'assignments',(select jsonb_agg(to_jsonb(x) order by id) from public.cleaning_assignments x where id in (select id from assignment)),
        'attempts',(select jsonb_agg(to_jsonb(x) order by id) from public.cleaning_attempts x where id in (select id from attempt)),
        'pinRevision',(select to_jsonb(x) from private.room_pin_revisions x where id='${id(700)}'),
        'currentPin',(select to_jsonb(x) from private.room_current_pin x where pin_revision_id='${id(700)}'),
        'sync',(select jsonb_agg(to_jsonb(x) order by id) from public.room_pin_sync_events x where actor_profile_id='${admin}'),
        'notifications',(select jsonb_agg(to_jsonb(x) order by id) from public.notifications x where cleaning_target_id in (select id from target)),
        'outbox',(select jsonb_agg(to_jsonb(x) order by id) from private.notification_delivery_outbox x where notification_id in (
          select id from public.notifications where cleaning_target_id in (select id from target))),
        'audit',(select jsonb_agg(to_jsonb(x) order by id) from public.audit_events x where actor_profile_id='${admin}'),
        'receipts',(select jsonb_agg(to_jsonb(x) order by id) from private.command_executions x where actor_profile_id='${admin}')
      ) value
    ) select encode(extensions.digest(convert_to(value::text,'UTF8'),'sha256'),'hex') from payload`);
}

let passed = false;
try {
  reset("20260913075134");
  psql(fixture);
  const before = snapshot();
  run(process.execPath, [supabaseCli, "migration", "up", "--local"], {
    stdio: "inherit",
  });
  const after = snapshot();
  assert(before === after, "53 -> 54 upgrade must preserve the complete fixture ledger");
  assert(
    psql(`select concat_ws('|',
      exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
      to_regclass('public.checkout_presence_incidents') is not null,
      to_regclass('public.checkout_presence_incident_decisions') is not null,
      (select count(*) from public.checkout_presence_incidents),
      (select count(*) from public.checkout_presence_incident_decisions))`) === "t|t|t|0|0",
    "upgrade must install an empty incident ledger and record migration history",
  );
  passed = true;
  process.stdout.write("checkout incident 53 -> 54 ledger preservation: PASS\n");
} finally {
  try {
    reset();
  } catch (error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if (passed) process.exitCode = 1;
  }
}
