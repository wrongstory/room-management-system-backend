import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(new URL("fixtures/room-pin-entitlement-upgrade-v63.sql", import.meta.url));
const supabaseCli = fileURLToPath(new URL("../node_modules/supabase/dist/supabase.js", import.meta.url));
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260917090000";
const migrationVersion = "20260918000000";
const psqlArgs = ["exec","-i",container,"psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","postgres"];

function assert(condition, message) { if (!condition) throw new Error(message); }
function run(command, args, options = {}) { return execFileSync(command,args,{cwd:root,encoding:"utf8",...options}); }
function psql(input) { return run("docker",psqlArgs,{input,stdio:["pipe","pipe","pipe"]}).trim(); }
function reset(version) {
  const args=[supabaseCli,"db","reset","--local","--no-seed"];
  if(version) args.push("--version",version);
  run(process.execPath,args,{stdio:"inherit"});
}
function snapshot() {
  return psql(`select encode(extensions.digest(convert_to(jsonb_build_object(
    'profiles',(select jsonb_agg(to_jsonb(row) order by id) from public.profiles row where id::text like 'f1940063%'),
    'targets',(select jsonb_agg(to_jsonb(row) order by id) from public.cleaning_targets row where id::text like 'f1940063%'),
    'assignments',(select jsonb_agg(to_jsonb(row) order by id) from public.cleaning_assignments row where id::text like 'f1940063%'),
    'notifications',(select jsonb_agg(to_jsonb(row) order by id) from public.notifications row where id::text like 'f1940063%'),
    'outbox',(select jsonb_agg(to_jsonb(row) order by id) from private.notification_delivery_outbox row where id::text like 'f1940063%'),
    'revisions',(select jsonb_agg(to_jsonb(row) order by id) from private.room_pin_revisions row where recorded_by='f1940063-0000-4000-8000-000000000001'),
    'currentPin',(select jsonb_agg(to_jsonb(row) order by room_id) from private.room_current_pin row where pin_revision_id in
      (select id from private.room_pin_revisions where recorded_by='f1940063-0000-4000-8000-000000000001')),
    'changeLeases',(select jsonb_agg(to_jsonb(row) order by id) from private.room_pin_change_leases row
      where actor_profile_id='f1940063-0000-4000-8000-000000000001'),
    'reveal',(select jsonb_agg(jsonb_build_object('id',id,'room_id',room_id,'pin_revision_id',pin_revision_id,
      'pin_version',pin_version,'actor_profile_id',actor_profile_id,'actor_role_snapshot',actor_role_snapshot,
      'assignment_id',assignment_id,'attempt_id',attempt_id,'authoritative_access_lease_id',authoritative_access_lease_id,
      'issued_at',issued_at,'expires_at',expires_at,'finalized_at',finalized_at,'request_id',request_id) order by id)
      from private.room_pin_reveal_leases where id::text like 'f1940063%'),
    'audit',(select jsonb_agg(to_jsonb(row) order by id) from public.audit_events row where actor_profile_id='f1940063-0000-4000-8000-000000000001'),
    'receipts',(select jsonb_agg(to_jsonb(row) order by id) from private.command_executions row where actor_profile_id='f1940063-0000-4000-8000-000000000001')
  )::text,'UTF8'),'sha256'),'hex')`);
}

let passed=false;
try {
  reset(baselineVersion);
  psql(fixture);
  const before=snapshot();
  run(process.execPath,[supabaseCli,"migration","up","--local"],{stdio:"inherit"});
  assert(before===snapshot(),"63 -> 64 upgrade must preserve PIN, assignment, notification, audit, receipt, and reveal history");
  assert(psql(`select concat_ws('|',
    exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
    (select count(*) from private.room_pin_assignment_entitlements),
    exists(select 1 from private.room_pin_assignment_entitlements where assignment_id='f1940063-0000-4000-8000-000000000401' and ended_at is null),
    not exists(select 1 from private.room_pin_assignment_entitlements where assignment_id in
      ('f1940063-0000-4000-8000-000000000402','f1940063-0000-4000-8000-000000000403','f1940063-0000-4000-8000-000000000404')),
    private.current_pin_sync_status((select room_id from private.room_current_pin where pin_revision_id in
      (select id from private.room_pin_revisions where recorded_by='f1940063-0000-4000-8000-000000000001'))),
    (select revoke_reason_code from private.room_pin_reveal_leases where id='f1940063-0000-4000-8000-000000000801'),
    (select (finalized_at is not null and revoked_at is null)::text from private.room_pin_reveal_leases where id='f1940063-0000-4000-8000-000000000802'),
    (select concat_ws(':',revoke_reason_code,(finalized_at is null)::text,(revoked_at is not null)::text)
      from private.room_pin_reveal_leases where id='f1940063-0000-4000-8000-000000000803')
  )`) === "t|1|t|t|mismatch|MIGRATION_CONTRACT_REPLACED|true|MIGRATION_CONTRACT_REPLACED:true:true",
  "upgrade backfills mismatch-time active current notified authority, excludes unsafe rows, and safely revokes every unfinalized legacy reveal including expired maid rows");
  passed=true;
  process.stdout.write("room PIN entitlement 63 -> 64 preservation/backfill: PASS\n");
} finally {
  try { reset(); } catch(error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if(passed) process.exitCode=1;
  }
}
