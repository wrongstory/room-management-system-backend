import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const fixture = readFileSync(new URL("fixtures/photo-retention-upgrade-v62.sql", import.meta.url));
const supabaseCli = fileURLToPath(new URL("../node_modules/supabase/dist/supabase.js", import.meta.url));
const container = "supabase_db_room-management-system-backend";
const baselineVersion = "20260916210000";
const migrationVersion = "20260917090000";
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
    'operations',(select jsonb_agg(to_jsonb(row) order by id) from private.photo_upload_operations row where id::text like 'f009%'),
    'objects',(select jsonb_agg(to_jsonb(row) order by id) from private.photo_provider_objects row where id::text like 'f009%'),
    'photos',(select jsonb_agg(to_jsonb(row) order by id) from private.attempt_photo_versions row where id::text like 'f009%'),
    'acceptances',(select jsonb_agg(to_jsonb(row) order by operation_id) from private.photo_upload_acceptances row where operation_id::text like 'f009%'),
    'pointers',(select jsonb_agg(to_jsonb(row) order by target_photo_slot_id) from private.attempt_photo_current row where cleaning_attempt_id='f0090000-0000-4000-8000-000000000500'),
    'submissions',(select jsonb_agg(to_jsonb(row) order by id) from public.cleaning_submissions row where id::text like 'f009%'),
    'bindings',(select jsonb_agg(to_jsonb(row) order by submission_id,target_photo_slot_id) from private.submission_photo_bindings row where submission_id::text like 'f009%'),
    'bindingSets',(select jsonb_agg(to_jsonb(row) order by submission_id) from private.submission_photo_binding_sets row where submission_id::text like 'f009%'),
    'decision',(select to_jsonb(row) from public.inspection_decisions row where id='f0090000-0000-4000-8000-000000000902'),
    'purged',(select jsonb_agg(to_jsonb(row) order by photo_version_id) from private.attempt_photo_purge_states row where photo_version_id::text like 'f009%'),
    'audit',(select jsonb_agg(to_jsonb(row) order by id) from public.audit_events row where entity_id::text like 'f009%'),
    'receipt',(select jsonb_agg(to_jsonb(row) order by id) from private.command_executions row where entity_id::text like 'f009%')
  )::text,'UTF8'),'sha256'),'hex')`);
}

let passed=false;
try {
  reset(baselineVersion);
  psql(fixture);
  const before=snapshot();
  run(process.execPath,[supabaseCli,"migration","up","--local"],{stdio:"inherit"});
  assert(before===snapshot(),"62 -> 63 upgrade must preserve photo/submission/audit/receipt history");
  assert(psql(`select concat_ws('|',
    exists(select 1 from supabase_migrations.schema_migrations where version='${migrationVersion}'),
    (select effective_policy_kind||':'||(expires_at is null)::text from private.photo_retention_records where photo_version_id='f0090000-0000-4000-8000-000000000801'),
    (select effective_policy_kind||':'||(expires_at-retention_starts_at)::text from private.photo_retention_records where photo_version_id='f0090000-0000-4000-8000-000000000802'),
    (select effective_policy_kind||':'||(expires_at-retention_starts_at)::text from private.photo_retention_records where photo_version_id='f0090000-0000-4000-8000-000000000803'),
    (select media_availability||':'||(purged_at is not null)::text from private.photo_retention_records where photo_version_id='f0090000-0000-4000-8000-000000000804')
  )`) === "t|cleaning_submission:true|cleaning_submission:7 days|orphan:30 days|purged:true",
  "upgrade must derive pending/final/orphan/purged retention without resurrecting media");
  assert(psql(`select concat_ws('|',
    (select link.active::text from private.photo_retention_links link
      where link.object_id='f0090000-0000-4000-8000-000000000702'
        and link.domain_kind='cleaning_submission'
        and link.domain_id='f0090000-0000-4000-8000-000000000900'),
    (select (link.retention_starts_at=decision.decided_at)::text
      from private.photo_retention_links link
      join public.inspection_decisions decision on decision.submission_id=link.domain_id
      where link.object_id='f0090000-0000-4000-8000-000000000702'
        and link.domain_kind='cleaning_submission'),
    (select (link.expires_at=decision.decided_at+interval '168 hours')::text
      from private.photo_retention_links link
      join public.inspection_decisions decision on decision.submission_id=link.domain_id
      where link.object_id='f0090000-0000-4000-8000-000000000702'
        and link.domain_kind='cleaning_submission'),
    (select (pointer.submission_id='f0090000-0000-4000-8000-000000000910')::text
      from private.submission_current_pointers pointer
      where pointer.cleaning_attempt_id='f0090000-0000-4000-8000-000000000500')
  )`) === "true|true|true|true",
  "historical decided submission remains active through its exact decidedAt + 168h boundary after reclean supersedes current pointer");
  assert(psql(`select concat_ws('|',
    (select status||':'||lease_version from private.photo_purge_jobs where photo_version_id='f0090000-0000-4000-8000-000000000801'),
    (select status||':'||lease_version||':'||(claim_digest=repeat('3',64))::text from private.photo_purge_jobs where photo_version_id='f0090000-0000-4000-8000-000000000803')
  )`) === "pending:3|blocked:8:true",
  "upgrade must fence a changed in-flight clock and preserve operator-blocked state");
  passed=true;
  process.stdout.write("photo retention 62 -> 63 ledger preservation: PASS\n");
} finally {
  try { reset(); } catch(error) {
    process.stderr.write(`failed to restore full local migration state: ${error}\n`);
    if(passed) process.exitCode=1;
  }
}
