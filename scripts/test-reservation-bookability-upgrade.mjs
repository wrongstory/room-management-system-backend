import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const supabaseCli = fileURLToPath(new URL(
  "../node_modules/supabase/dist/supabase.js",
  import.meta.url,
));
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260920150000";
const migrationVersion = "20260921144731";
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
  return psql(`
    select encode(extensions.digest(string_agg(snapshot, E'\\n' order by snapshot), 'sha256'),'hex')
    from (
      select format('%I.%I|%s', schemaname, tablename,
        coalesce((xpath('/row/hash/text()', query_to_xml(
          format('select md5(coalesce(string_agg(row_to_json(t)::text, '''' order by row_to_json(t)::text), '''')) hash from %I.%I t', schemaname, tablename),
          false, true, '')))[1]::text, '')) snapshot
      from pg_tables
      where schemaname in ('public','private')
        and not (schemaname='private' and tablename in (
          'assignment_unavailability_cancellations',
          'notification_event_catalog'
        ))
    ) preserved`);
}

let passed = false;
try {
  reset(baselineVersion);
  const before = ledgerSnapshot();
  run(process.execPath, [supabaseCli, "migration", "up", "--local"], { stdio: "inherit" });
  assert(
    before === ledgerSnapshot(),
    "77 -> 78 and later append-only migrations must preserve all pre-existing ledger rows exactly",
  );

  const result = psql(`select concat_ws('|',
    exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
    pg_get_function_arguments('public.preview_reservation_bookability(uuid,timestamptz,timestamptz,integer,uuid,uuid[],text)'::regprocedure) ilike '%p_guest_count integer default null%',
    has_function_privilege('service_role', 'public.preview_reservation_bookability(uuid,timestamptz,timestamptz,integer,uuid,uuid[],text)', 'EXECUTE'),
    not has_function_privilege('authenticated', 'public.preview_reservation_bookability(uuid,timestamptz,timestamptz,integer,uuid,uuid[],text)', 'EXECUTE'),
    not has_function_privilege('anon', 'public.preview_reservation_bookability(uuid,timestamptz,timestamptz,integer,uuid,uuid[],text)', 'EXECUTE')
  )`);
  assert(result === "t|t|t|t|t", `unexpected upgraded function contract (${result})`);
  passed = true;
  process.stdout.write("reservation bookability 77 -> 78 ledger preservation: PASS\n");
} finally {
  try {
    reset();
  } catch (error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if (passed) process.exitCode = 1;
  }
}
