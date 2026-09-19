import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(new URL("fixtures/reservation-during-stay-upgrade-v61.sql", import.meta.url));
const supabaseCli = fileURLToPath(new URL("../node_modules/supabase/dist/supabase.js", import.meta.url));
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260916204500";
const migrationVersion = "20260916210000";
const reservationId = "8c200000-0000-4000-8000-000000000001";
const psqlArgs = ["exec","-i",container,"psql","-X","-qAt","-v","ON_ERROR_STOP=1","-U","postgres","-d","postgres"];

function assert(condition, message) { if (!condition) throw new Error(message); }
function run(command, args, options = {}) {
  return execFileSync(command,args,{cwd:root,encoding:"utf8",...options});
}
function psql(input) {
  return run("docker",psqlArgs,{input,stdio:["pipe","pipe","pipe"]}).trim();
}
function reset(version) {
  const args=[supabaseCli,"db","reset","--local","--no-seed"];
  if(version) args.push("--version",version);
  run(process.execPath,args,{stdio:"inherit"});
}
function snapshot() {
  return psql(`select encode(extensions.digest(convert_to(jsonb_build_object(
    'reservation',(select to_jsonb(row)-'reservation_type' from public.reservations row where id='${reservationId}'),
    'obligation',(select to_jsonb(row) from public.checkout_cleaning_obligations row where reservation_id='${reservationId}'),
    'target',(select jsonb_agg(to_jsonb(row)-'stay_segment_checkout_obligation_id' order by id) from public.cleaning_targets row where reservation_id='${reservationId}'),
    'schedule',(select jsonb_agg(to_jsonb(row)-'reservation_type' order by version) from public.reservation_schedule_revisions row where reservation_id='${reservationId}'),
    'audit',(select jsonb_agg(to_jsonb(row) order by id) from public.audit_events row where entity_id='${reservationId}'),
    'receipt',(select jsonb_agg(to_jsonb(row) order by command_type,idempotency_key) from private.command_executions row where entity_id='${reservationId}')
  )::text,'UTF8'),'sha256'),'hex')`);
}

let passed=false;
try {
  reset(baselineVersion);
  psql(fixture);
  const before=snapshot();
  run(process.execPath,[supabaseCli,"migration","up","--local"],{stdio:"inherit"});
  assert(before===snapshot(),"61 -> 62 upgrade must preserve reservation/obligation/target/audit/receipt ledgers");
  assert(psql(`select concat_ws('|',
    exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
    (select count(*) from private.reservation_stays where reservation_id='${reservationId}'),
    (select count(*) from private.stay_room_segments segment join private.reservation_stays stay on stay.id=segment.stay_id where stay.reservation_id='${reservationId}' and segment.retired_at is null),
    (select segment.starts_at=(select actual_check_in_at from public.reservations where id='${reservationId}') from private.stay_room_segments segment join private.reservation_stays stay on stay.id=segment.stay_id where stay.reservation_id='${reservationId}' and segment.retired_at is null)
  )`) === "t|1|1|t","upgrade must create one stay and one exact active segment");
  assert(psql(`select concat_ws('|',
    (select count(*) from private.reservation_room_move_events where reservation_id='8c200000-0000-4000-8000-000000000002' and mode='BEFORE_CHECKIN'),
    (select count(*) from public.audit_events where entity_id='8c200000-0000-4000-8000-000000000002' and event_type='reservation.room_moved'),
    (select count(*) from private.command_executions where entity_id='8c200000-0000-4000-8000-000000000002' and command_type='reservation.room_move')
  )`) === "1|1|1","upgrade must backfill one typed BEFORE_CHECKIN move event without changing its audit or receipt");
  passed=true;
  process.stdout.write("reservation DURING_STAY 61 -> 62 ledger preservation: PASS\n");
} finally {
  try { reset(); } catch(error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if(passed) process.exitCode=1;
  }
}
