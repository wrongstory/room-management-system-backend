import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(
  new URL("fixtures/cleaning-template-duration-upgrade-v55.sql", import.meta.url),
);
const supabaseCli = fileURLToPath(
  new URL("../node_modules/supabase/dist/supabase.js", import.meta.url),
);
const container = "supabase_db_room-management-system-backend";
const migrationVersion = "20260915000628";
const currentMigrationVersion = "20260916030930";
const baselineVersion = "20260914094126";
const adminId = "e1650000-0000-4000-8000-000000000001";
const sessionId = "e1650000-0000-4000-8000-000000000201";
const reservationId = "e1650000-0000-4000-8000-000000000301";
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
function snapshot() {
  return psql(`with template as (
      select id from public.cleaning_template_versions
      where room_type_id=(select id from public.room_types where code='standard')
        and cleaning_kind='checkout'
    ), target as (
      select id from public.cleaning_targets where reservation_id='${reservationId}'
    ), payload as (
      select jsonb_build_object(
        'template',(select jsonb_agg(to_jsonb(x) order by id) from public.cleaning_template_versions x where id in (select id from template)),
        'slots',(select jsonb_agg(to_jsonb(x) order by template_version_id,display_order) from private.photo_template_slots x where template_version_id in (select id from template)),
        'reservation',(select to_jsonb(x)-'reservation_type' from public.reservations x where id='${reservationId}'),
        'obligation',(select to_jsonb(x) from public.checkout_cleaning_obligations x where reservation_id='${reservationId}'),
        'target',(select jsonb_agg(to_jsonb(x)-'stay_segment_checkout_obligation_id' order by id) from public.cleaning_targets x where id in (select id from target)),
        'audit',(select jsonb_agg(to_jsonb(x) order by id) from public.audit_events x where actor_profile_id='${adminId}'),
        'receipts',(select jsonb_agg(to_jsonb(x) order by command_type,idempotency_key) from private.command_executions x where actor_profile_id='${adminId}')
      ) value
    ) select encode(extensions.digest(convert_to(value::text,'UTF8'),'sha256'),'hex') from payload`);
}

let passed = false;
try {
  reset(baselineVersion);
  psql(fixture);
  const before = snapshot();

  run(process.execPath, [supabaseCli, "migration", "up", "--local"], { stdio: "inherit" });
  assert(before === snapshot(), "55 -> current upgrade must preserve existing template/reservation ledgers");
  assert(
    psql(`select concat_ws('|',
      exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
      exists(select 1 from supabase_migrations.schema_migrations where version='${currentMigrationVersion}'),
      (select concat_ws(':',version,duration_minutes) from public.cleaning_template_versions
       where room_type_id=(select id from public.room_types where code='standard')
         and cleaning_kind='checkout' and status='published'),
      (select count(*) from public.cleaning_targets where reservation_id='${reservationId}'),
      (select is_nullable from information_schema.columns
       where table_schema='public' and table_name='cleaning_template_versions'
         and column_name='duration_minutes'))`) === "t|t|8:60|1|YES",
    "upgrade must retain configured duration and enable the checkout nullable plus v8 slot contracts",
  );

  const historicalReplay = JSON.parse(psql(`select public.publish_checkout_cleaning_template(
    '${adminId}','${sessionId}','standard',7,60,
    (select jsonb_agg(jsonb_build_object(
      'slotKey',case when display_order=0 then 'tv-on' else 'slot-'||display_order end,
      'displayOrder',display_order,
      'required',display_order<9,
      'label','사진 '||(display_order+1)
    ) order by display_order) from generate_series(0,9) display_order),
    'duration-upgrade-publish-v8',repeat('d',64))`));
  assert(historicalReplay.version === 8 && historicalReplay.durationMinutes === 60,
    "upgrade must replay the exact completed pre-A v8 publication without A-contract revalidation");

  const publication = JSON.parse(psql(`select public.publish_checkout_cleaning_template(
    '${adminId}','${sessionId}','standard',8,null,
    (select jsonb_agg(jsonb_build_object(
      'slotKey',case when display_order=0 then 'tv-on' when display_order=1 then 'entry-storage'
        when display_order=8 then 'extra-proof' else 'slot-'||display_order end,
      'displayOrder',display_order,
      'required',display_order<8,
      'label','사진 '||(display_order+1),
      'maxPhotos',case when display_order=8 then 10 else 1 end
    ) order by display_order) from generate_series(0,8) display_order),
    'duration-upgrade-null',repeat('c',64))`));
  assert(publication.durationMinutes === null && publication.version === 9,
    "upgraded RPC must transition historical pre-A v8 to an explicit null-duration A-contract v9");

  passed = true;
  process.stdout.write("cleaning-template duration 55 -> current ledger preservation: PASS\n");
} finally {
  try {
    reset();
  } catch (error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if (passed) process.exitCode = 1;
  }
}
