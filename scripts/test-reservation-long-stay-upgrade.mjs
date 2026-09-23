import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(new URL(
  "fixtures/reservation-long-stay-upgrade-v65.sql",
  import.meta.url,
));
const supabaseCli = fileURLToPath(new URL(
  "../node_modules/supabase/dist/supabase.js",
  import.meta.url,
));
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260918010000";
const migrationVersion = "20260919102042";
const ids = [
  "c2020000-0000-4000-8000-000000000001",
  "c2020000-0000-4000-8000-000000000002",
];
const psqlArgs = [
  "exec", "-i", container, "psql", "-X", "-qAt", "-v", "ON_ERROR_STOP=1",
  "-U", "postgres", "-d", "postgres",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", ...options });
}
function psql(input) {
  return run("docker", psqlArgs, { input, stdio: ["pipe", "pipe", "pipe"] }).trim();
}
function reset(version) {
  const args = [supabaseCli, "db", "reset", "--local", "--no-seed"];
  if (version) args.push("--version", version);
  run(process.execPath, args, { stdio: "inherit" });
}
function ledgerSnapshot() {
  return psql(`select encode(extensions.digest(convert_to(jsonb_build_object(
    'reservations',(select jsonb_agg(jsonb_build_object(
      'id',id,'room_id',room_id,'check_in_at',check_in_at,'check_out_at',check_out_at,
      'guest_count',guest_count,'status',status,'preparation_obligation_id',preparation_obligation_id,
      'checkout_obligation_id',checkout_obligation_id,'version',version,
      'actual_check_in_at',actual_check_in_at,'actual_checkout_at',actual_checkout_at,
      'created_at',created_at,'updated_at',updated_at) order by id)
      from public.reservations where id=any(array['${ids.join("','")}']::uuid[])),
    'preparation',(select jsonb_agg(to_jsonb(row) order by id) from public.preparation_obligations row
      where reservation_id=any(array['${ids.join("','")}']::uuid[])),
    'checkout',(select jsonb_agg(to_jsonb(row) order by id) from public.checkout_cleaning_obligations row
      where reservation_id=any(array['${ids.join("','")}']::uuid[])),
    'targets',(select jsonb_agg(to_jsonb(row) order by id) from public.cleaning_targets row
      where reservation_id=any(array['${ids.join("','")}']::uuid[])),
    'audit',(select jsonb_agg(to_jsonb(row) order by id) from public.audit_events row
      where entity_id=any(array['${ids.join("','")}']::uuid[])),
    'receipts',(select jsonb_agg(to_jsonb(row) order by command_type,idempotency_key)
      from private.command_executions row where entity_id=any(array['${ids.join("','")}']::uuid[]))
  )::text,'UTF8'),'sha256'),'hex')`);
}

let passed = false;
try {
  reset(baselineVersion);
  psql(fixture);
  const before = ledgerSnapshot();
  run(process.execPath, [supabaseCli, "migration", "up", "--local"], { stdio: "inherit" });
  assert(before === ledgerSnapshot(), "65 -> 66 must preserve existing reservation ledgers exactly");
  const upgradedShape = psql(`select concat_ws('|',
    exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
    (select count(*) from public.reservations where id=any(array['${ids.join("','")}']::uuid[]) and reservation_type='standard'),
    (select count(*) from private.reservation_stays where reservation_id=any(array['${ids.join("','")}']::uuid[]) and reservation_type='standard'),
    (select count(*) from private.stay_room_segments segment join private.reservation_stays stay on stay.id=segment.stay_id
      where stay.reservation_id=any(array['${ids.join("','")}']::uuid[]) and segment.ends_at is not null)
  )`);
  assert(
    upgradedShape === "t|2|2|3",
    `upgrade must backfill only explicit standard/fixed-end identities (${upgradedShape})`,
  );
  passed = true;
  process.stdout.write("reservation long-stay 65 -> 66 ledger preservation: PASS\n");
} finally {
  try {
    reset();
  } catch (error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if (passed) process.exitCode = 1;
  }
}
