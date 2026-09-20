import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const args = ["exec","-i","supabase_db_room-management-system-backend","psql","-X","-qAt","-U","postgres","-d","postgres","-v","ON_ERROR_STOP=1"];
function assert(value, message) { if (!value) throw new Error(message); }
function closeWithin(child, label, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    const timer = setTimeout(() => {
      child.kill();
      setTimeout(() => {
        try { if (child.exitCode === null) child.kill("SIGKILL"); } catch { /* bounded cleanup only */ }
      }, 500).unref();
      reject(new Error(`${label} hard timeout`));
    }, timeoutMs);
    child.once("close", code => { clearTimeout(timer); resolve(code); });
    child.once("error", () => { clearTimeout(timer); reject(new Error(`${label} failed`)); });
  });
}

/** Local-only DB race. It never calls a provider and never logs media locators. */
export async function testPhotoRetentionConcurrency(client) {
  const url = new URL(client.supabaseUrl);
  assert(["localhost","127.0.0.1"].includes(url.hostname), "photo retention concurrency is local-only");
  function sql(statement) {
    return execFileSync("docker",args,{input:`set statement_timeout='10s';${statement}`,encoding:"utf8",timeout:15000,stdio:["pipe","pipe","pipe"]}).trim();
  }
  const fixture = readFileSync(new URL("fixtures/photo-retention-upgrade-v62.sql", import.meta.url));
  sql(fixture);
  sql(`set session_replication_role=replica;
    update private.photo_provider_objects
    set uploaded_at=stamp.value,
        purge_after=stamp.value+interval '168 hours'
    from (select clock_timestamp()-interval '31 days' as value) stamp
    where id in (
      'f0090000-0000-4000-8000-000000000702',
      'f0090000-0000-4000-8000-000000000703'
    );
    insert into private.photo_retention_records(
      object_id,operation_id,photo_version_id,performer_maid_profile_id,effective_policy_kind,
      retention_starts_at,expires_at,purged_at,media_availability
    ) select job.object_id,job.operation_id,job.photo_version_id,'f0090000-0000-4000-8000-000000000002',
      'orphan',object.uploaded_at,object.uploaded_at+interval '30 days',
      state.purged_at,
      case when state.purged_at is not null then 'purged' else 'available' end
    from private.photo_purge_jobs job join private.photo_provider_objects object on object.id=job.object_id
    left join private.attempt_photo_purge_states state on state.photo_version_id=job.photo_version_id
    where job.object_id::text like 'f009%';
    update private.photo_purge_jobs set next_attempt_at=clock_timestamp()+interval '1 day',revision=revision+1
      where status <> 'purged';
    update private.photo_purge_jobs set status='blocked',lease_version=8,claim_digest=repeat('3',64),
      lease_expires_at=clock_timestamp()+interval '10 minutes',last_reason_code='RETRY_EXHAUSTED',revision=revision+1
      where object_id='f0090000-0000-4000-8000-000000000701';
    update private.photo_purge_jobs set status='pending',lease_version=0,claim_digest=null,lease_expires_at=null,
      delete_prepared_version=null,delete_prepared_claim_digest=null,delete_prepared_expires_at=null,delete_prepared_at=null,
      purge_after=(select expires_at from private.photo_retention_records where object_id='f0090000-0000-4000-8000-000000000702'),
      next_attempt_at=clock_timestamp()-interval '1 second',revision=revision+1
      where object_id='f0090000-0000-4000-8000-000000000702';
    update private.photo_purge_jobs set status='pending',lease_version=0,claim_digest=null,lease_expires_at=null,
      delete_prepared_version=null,delete_prepared_claim_digest=null,delete_prepared_expires_at=null,delete_prepared_at=null,
      purge_after=(select expires_at from private.photo_retention_records where object_id='f0090000-0000-4000-8000-000000000703'),
      next_attempt_at=clock_timestamp()-interval '1 second',last_reason_code=null,revision=revision+1
      where object_id='f0090000-0000-4000-8000-000000000703';
    set session_replication_role=origin;`);

  assert(sql(`select jsonb_array_length(public.claim_due_photo_purges(repeat('d',64),1)->'items')`) === "1",
    "first object must be claimed before the binding-first race");
  const holder = spawn("docker",args,{stdio:["pipe","pipe","pipe"]});
  const holderClosed = closeWithin(holder,"photo retention binding holder");
  holder.stderr.on("data",()=>{});
  await new Promise((resolve,reject)=>{
    let ready=false;
    const timer=setTimeout(()=>{holder.kill();reject(new Error("photo retention claim setup timeout"));},10000);
    holder.once("error",()=>{clearTimeout(timer);reject(new Error("photo retention binding holder failed"));});
    holder.once("close",()=>{if(!ready){clearTimeout(timer);reject(new Error("photo retention binding rejected"));}});
    holder.stdout.on("data",value=>{
      if(!ready&&value.toString().includes("PHOTO_RETENTION_READY")){ready=true;clearTimeout(timer);resolve();}
    });
    holder.stdin.write(`begin;set local statement_timeout='10s';set local application_name='photo-retention-binding-holder';
      select private.attach_photo_retention_link(
        'f0090000-0000-4000-8000-000000000702','cleaning_submission','cleaning_attempt',
        'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000002'
      );\n\\echo PHOTO_RETENTION_READY\n`);
  });
  assert(sql("select exists(select 1 from pg_stat_activity where application_name='photo-retention-binding-holder' and state='idle in transaction');") === "t",
    "binding READY must correspond to a live transaction retaining the global barrier");
  const worker = spawn("docker",args,{stdio:["pipe","pipe","pipe"]});
  let workerError="";
  worker.stderr.on("data",value=>{workerError+=value.toString();});
  let workerOutput="";
  worker.stdout.on("data",value=>{workerOutput+=value.toString();});
  const workerClosed = closeWithin(worker,"photo retention permit waiter");
  worker.stdin.end(`begin;set local application_name='photo-retention-permit-waiter';
    select public.get_photo_purge_context(
      'f0090000-0000-4000-8000-000000000702',1,repeat('d',64)
    );commit;\n`);
  try {
    let blocked=false;
    for(let n=0;n<40;n+=1){
      if(sql("select exists(select 1 from pg_stat_activity where application_name='photo-retention-permit-waiter' and wait_event_type='Lock');")==="t"){
        blocked=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert(blocked,"delete permit must wait while a domain link wins the shared barrier");
    holder.stdin.end("commit;\n\\q\n");
    assert(await holderClosed===0,"domain link commits first");
    assert(await workerClosed!==0,"stale provider delete permit is rejected after binding wins");
  } finally {
    try {
      sql("select pg_terminate_backend(pid) from pg_stat_activity where application_name in ('photo-retention-binding-holder','photo-retention-permit-waiter') and pid<>pg_backend_pid();");
    } catch { /* child hard timeout remains authoritative */ }
    if(holder.exitCode===null) holder.stdin.end("rollback;\n\\q\n");
    if(worker.exitCode===null) worker.kill();
    await Promise.allSettled([holderClosed,workerClosed]);
  }
  assert(!workerOutput.includes('providerFileId') && workerError.includes('PHOTO_PURGE_FENCE_CONFLICT'),
    "binding-first race must never return provider delete authority");
  assert(sql(`select concat_ws('|',status,lease_version,(purge_after='9999-12-31 23:59:59+00'::timestamptz)::text,
      (claim_digest is null)::text,(delete_prepared_at is null)::text)
    from private.photo_purge_jobs where object_id='f0090000-0000-4000-8000-000000000702';`) === "pending|2|true|true|true",
  "binding-first race must revoke the stale claim without recording a delete permit");
  let staleRejected=false;
  try {
    sql(`select public.settle_photo_purge('f0090000-0000-4000-8000-000000000702',1,repeat('d',64),'deleted',null);`);
  } catch { staleRejected=true; }
  assert(staleRejected,"stale purge worker must not settle after a late domain binding");

  assert(sql(`select jsonb_array_length(public.claim_due_photo_purges(repeat('e',64),1)->'items')`) === "1",
    "second object must be claimed before the permit-first race");
  const permitHolder = spawn("docker",args,{stdio:["pipe","pipe","pipe"]});
  const permitClosed = closeWithin(permitHolder,"photo retention permit holder");
  let permitOutput="";
  permitHolder.stdout.on("data",value=>{permitOutput+=value.toString();});
  permitHolder.stderr.on("data",()=>{});
  await new Promise((resolve,reject)=>{
    let ready=false;
    const timer=setTimeout(()=>{permitHolder.kill();reject(new Error("photo retention permit setup timeout"));},10000);
    permitHolder.once("error",()=>{clearTimeout(timer);reject(new Error("photo retention permit holder failed"));});
    permitHolder.once("close",()=>{if(!ready){clearTimeout(timer);reject(new Error("photo retention permit rejected"));}});
    permitHolder.stdout.on("data",value=>{
      if(!ready&&value.toString().includes("PHOTO_RETENTION_PERMIT_READY")){ready=true;clearTimeout(timer);resolve();}
    });
    permitHolder.stdin.write(`begin;set local statement_timeout='10s';set local application_name='photo-retention-permit-holder';
      select public.get_photo_purge_context(
        'f0090000-0000-4000-8000-000000000703',1,repeat('e',64)
      );\n\\echo PHOTO_RETENTION_PERMIT_READY\n`);
  });
  assert(permitOutput.includes('providerFileId'),"permit-first race records exact provider delete authority");
  const lateBinder = spawn("docker",args,{stdio:["pipe","pipe","pipe"]});
  let lateError="";
  lateBinder.stderr.on("data",value=>{lateError+=value.toString();});
  const lateClosed = closeWithin(lateBinder,"photo retention post-permit binder");
  lateBinder.stdin.end(`begin;set local application_name='photo-retention-post-permit-binder';
    select private.attach_photo_retention_link(
      'f0090000-0000-4000-8000-000000000703','cleaning_submission','cleaning_attempt',
      'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000002'
    );commit;\n`);
  try {
    let blocked=false;
    for(let n=0;n<40;n+=1){
      if(sql("select exists(select 1 from pg_stat_activity where application_name='photo-retention-post-permit-binder' and wait_event_type='Lock');")==="t"){
        blocked=true;break;
      }
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert(blocked,"late domain binding must wait while the exact delete permit commits");
    permitHolder.stdin.end("commit;\n\\q\n");
    assert(await permitClosed===0,"delete permit commits first");
    assert(await lateClosed!==0,"post-permit domain binding fails closed");
  } finally {
    try {
      sql("select pg_terminate_backend(pid) from pg_stat_activity where application_name in ('photo-retention-permit-holder','photo-retention-post-permit-binder') and pid<>pg_backend_pid();");
    } catch { /* child hard timeout remains authoritative */ }
    if(permitHolder.exitCode===null) permitHolder.stdin.end("rollback;\n\\q\n");
    if(lateBinder.exitCode===null) lateBinder.kill();
    await Promise.allSettled([permitClosed,lateClosed]);
  }
  assert(lateError.includes('PHOTO_RETENTION_DELETE_PREPARED'),
    "post-permit binding returns the stable delete-prepared domain error");
  assert(sql(`select concat_ws('|',status,delete_prepared_version,
      (delete_prepared_claim_digest=repeat('e',64))::text,
      (delete_prepared_expires_at=purge_after)::text,
      (not exists(select 1 from private.photo_retention_links where object_id=job.object_id and domain_id='f0090000-0000-4000-8000-000000000500'))::text)
    from private.photo_purge_jobs job where object_id='f0090000-0000-4000-8000-000000000703';`) === "claimed|1|true|true|true",
    "persisted permit keeps the object unbound and exact to object/fence/claim/expiry");
  assert(sql(`select public.settle_photo_purge(
    'f0090000-0000-4000-8000-000000000703',1,repeat('e',64),'retryable','NETWORK_ERROR')->>'status'`) === "retry",
    "uncertain provider delete retains the persistent barrier for safe retry");
  let postUncertainRejected=false;
  try {
    sql(`select private.attach_photo_retention_link(
      'f0090000-0000-4000-8000-000000000703','cleaning_submission','cleaning_attempt',
      'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000002')`);
  } catch { postUncertainRejected=true; }
  assert(postUncertainRejected,"uncertain external delete must never reopen late binding");

  let purgedResurrectionRejected=false;
  try {
    sql(`select private.attach_photo_retention_link(
      'f0090000-0000-4000-8000-000000000704','cleaning_submission','cleaning_attempt',
      'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000002')`);
  } catch { purgedResurrectionRejected=true; }
  assert(purgedResurrectionRejected,"purged evidence cannot be resurrected by a new domain link");

  sql(`select private.attach_photo_retention_link(
    'f0090000-0000-4000-8000-000000000701','cleaning_submission','cleaning_attempt',
    'f0090000-0000-4000-8000-000000000500','f0090000-0000-4000-8000-000000000002'
  );`);
  assert(sql(`select concat_ws('|',status,lease_version,(claim_digest=repeat('3',64))::text)
    from private.photo_purge_jobs where object_id='f0090000-0000-4000-8000-000000000701';`) === "blocked|8|true",
  "domain anchor refresh must not auto-resume operator-blocked media");
  console.log("Photo retention race passed: both permit/binding lock orders, persistent uncertain barrier, stale settle rejection, no resurrection, and blocked-state preservation.");
}
