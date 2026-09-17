import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

function assert(value, message) { if (!value) throw new Error(message); }
function ok(result, label) {
  if (result.error) throw new Error(`${label} failed (${String(result.error.code ?? 'DB_ERROR')})`);
  return result.data;
}
const container = process.env.SUPABASE_DB_CONTAINER ?? 'supabase_db_room-management-system-backend';
assert(/^supabase_db_[a-z0-9-]+$/.test(container), 'trusted local Supabase database container name');
const args = ['exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];

/** Photo operation commands, exercised through real local PostgreSQL transactions.
 * This does NOT expose upload/submit APIs or claim that synthetic metadata proves image bytes.
 * All identifiers/SQL remain in memory; only fixed PASS labels reach the runner.
 */
export async function testPhotoStorageOperationsConcurrency(client) {
  const url = new URL(client.supabaseUrl);
  assert(['localhost', '127.0.0.1'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol), 'photo races require local Supabase');
  function sql(statement) {
    try {
      return execFileSync('docker', args, {
        input: `set statement_timeout='10s';${statement}`, encoding: 'utf8', timeout: 15000,
        stdio: ['pipe', 'pipe', 'pipe']
      }).trim();
    } catch { throw new Error('photo local fixture/check failed (raw details redacted)'); }
  }
  function execute(statement, name) {
    assert(/^photo83-[0-9a-f-]+$/.test(name), 'fixed local connection identifier');
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); }, 15000);
    child.stdout.on('data', (value) => { output += value.toString(); });
    child.stderr.on('data', (value) => { errors += value.toString(); });
    const result = new Promise((resolve, reject) => {
      child.once('error', () => { clearTimeout(timer); reject(new Error('photo race process failed')); });
      child.once('close', (code) => {
        clearTimeout(timer);
        const reason = ['PHOTO_UPLOAD_IN_FLIGHT', 'PHOTO_UPLOAD_FENCE_CONFLICT', 'PHOTO_OPERATION_TERMINAL', 'PHOTO_OPERATION_ACCEPTED', 'IDEMPOTENCY_KEY_REUSED', 'PHOTO_VERSION_CONFLICT', 'PHOTO_COLLECTION_VERSION_CONFLICT', 'PHOTO_ITEM_VERSION_CONFLICT', 'PHOTO_COLLECTION_LIMIT_EXCEEDED', 'SESSION_REVOKED', 'CAPABILITY_ACCESS_REQUIRED'].find((known) => errors.includes(known)) ?? null;
        resolve({ success: code === 0, output: output.trim(), reason });
      });
    });
    child.stdin.end(`begin;set local application_name='${name}';set local statement_timeout='10s';${statement};commit;\n`);
    return result;
  }
  async function holdMutation(statement) {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    let output = '';
    child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      let ready = false;
      const timer = setTimeout(() => { child.kill(); reject(new Error('photo mutation lock setup timed out')); }, 10000);
      child.once('error', () => { clearTimeout(timer); reject(new Error('photo mutation lock process failed')); });
      child.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('photo mutation lock setup failed')); } });
      child.stdout.on('data', (value) => {
        output += value.toString();
        if (!ready && output.includes('PHOTO_LOCK_READY')) {
          ready = true; clearTimeout(timer); output = ''; resolve();
        }
      });
      child.stdin.write(`begin;set local statement_timeout='10s';set local idle_in_transaction_session_timeout='15s';${statement};\n\\echo PHOTO_LOCK_READY\n`);
    });
    let result;
    return () => result ??= (async () => {
      child.stdin.end('commit;\n\\q\n');
      assert(await closed === 0, 'photo first transaction commits without deadlock');
    })();
  }
  async function race(first, second, holdMilliseconds = 0) {
    const release = await holdMutation(first), name = `photo83-${randomUUID()}`;
    const pending = execute(second, name);
    try {
      let blocked = false;
      for (let i = 0; i < 40; i += 1) {
        if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}' and state='active' and wait_event_type='Lock');`) === 't') {
          blocked = true; break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert(blocked, 'photo competing transaction must actually wait on a DB lock');
      if (holdMilliseconds > 0) await new Promise((resolve) => setTimeout(resolve, holdMilliseconds));
      await release();
      return await pending;
    } finally { await release(); await pending; }
  }
  async function account(role) {
    const id = randomUUID(), authId = randomUUID();
    ok(await client.auth.admin.createUser({ id: authId, email: `photo-${authId}@test.invalid`, password: `T:${randomUUID()}`, email_confirm: true }), 'photo synthetic Auth');
    ok(await client.from('profiles').insert({ id, auth_user_id: authId, display_name: `photo-${id}`, display_name_normalized: `photo-${id}`, login_id: `photo-${id}`, login_id_normalized: `photo-${id}`, login_sequence: 0, role, status: 'active', must_change_password: false }), 'photo synthetic profile');
    return id;
  }
  const admin = await account('admin'), maid = await account('maid');
  const session = randomUUID();
  sql(`insert into auth.sessions(id,user_id) select '${session}',auth_user_id from public.profiles where id='${maid}';`);
  const roomType = ok(await client.from('room_types').select('id').eq('code', 'standard').single(), 'photo standard type');
  const templateId = randomUUID();
  const version = Number(sql(`select greatest(coalesce(max(version),0),6)+1 from public.cleaning_template_versions where room_type_id='${roomType.id}' and cleaning_kind='additional';`));
  assert(Number.isSafeInteger(version) && version >= 7 && version <= 2147483647, 'photo synthetic template version is bounded');
  // A retired synthetic template avoids changing an existing published operational choice.
  sql(`insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
    values('${templateId}','${roomType.id}','additional',${version},'retired',1,
      '[{"slotKey":"fixture-required","required":true,"displayOrder":0,"label":"synthetic"},{"slotKey":"fixture-optional","required":false,"displayOrder":1,"label":"synthetic"}]','${admin}');`);
  let sequence = 0;
  async function fixture(startOnline = false) {
    const room = randomUUID(), target = randomUUID(), assignment = randomUUID(), attempt = randomUUID();
    ok(await client.from('rooms').insert({ id: room, room_number: `${Date.now()}${++sequence}`, room_type_id: roomType.id, elevator_zone: 'A' }), 'photo room');
    sql(`insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,available_from,due_at,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
      select '${target}','${room}','additional','manual_room_request','photo-${target}',
      (clock_timestamp() at time zone 'Asia/Seoul')::date,(clock_timestamp() at time zone 'Asia/Seoul')::date,
      (clock_timestamp() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul',
      ((clock_timestamp() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul','notified',2,
      '{"code":"standard"}',10000,jsonb_build_object('id',id,'version',version,'photoSlots',photo_slots,'durationMinutes',1),'${admin}'
      from public.cleaning_template_versions where id='${templateId}';
      insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
      values('${assignment}','${target}','${maid}',${sequence},2,clock_timestamp()-interval '2 hours','${admin}');
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
      select '${attempt}',id,'${assignment}','${maid}',1,'${startOnline ? 'scheduled' : 'field_completed'}',2,template_snapshot,jsonb_build_object('roomId',room_id),
      ${startOnline ? 'null,null,null' : "clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'"}
      from public.cleaning_targets where id='${target}';`);
    const slot = sql(`select id from private.target_photo_slot_snapshots where cleaning_target_id='${target}' and slot_key='fixture-required';`);
    assert(/^[0-9a-f-]{36}$/.test(slot), 'photo fixture materialized an exact target slot');
    if(startOnline)sql(`select public.start_cleaning_attempt('${maid}','${attempt}',1,'${assignment}',2,'${randomUUID()}',repeat('a',64));`);
    return { target, assignment, attempt, slot };
  }

  const digest = (value) => createHash('sha256').update(value).digest('hex');
  const claimA = digest(randomUUID()), claimB = digest(randomUUID());
  function begin(item, key = 'first', revision = 0) {
    return `select public.begin_photo_upload('${maid}','${session}','${item.attempt}','${item.assignment}',2,'${item.slot}',${revision},
      repeat('a',64),'image/jpeg',100,'${digest(item.attempt+key)}','${digest(item.attempt+revision)}')`;
  }
  function operation(item) {
    return sql(`select id from private.photo_upload_operations where cleaning_attempt_id='${item.attempt}';`);
  }
  const claim = (op, identity) => `select public.claim_photo_upload('${maid}','${session}','${op}','${identity}')`;
  // Immutable, already-committed server anchor keeps retry metadata exact and within the operation window.
  const provider = (op, identity, fence = 1) => `select public.record_photo_provider_success('${op}',${fence},'${identity}','synthetic_${op.replaceAll('-','')}',(select created_at from private.photo_upload_operations where id='${op}'))`;
  const finalize = (op, identity, fence = 1) => `select public.finalize_photo_upload('${maid}','${session}','${op}',${fence},'${identity}')`;
  const reconcile = (op) => `select public.reconcile_photo_upload('${op}','${claimB}')`;
  const settle = (op, identity, fence = 1) => `select public.settle_photo_compensation('${op}',${fence},'${identity}','not_found')`;
  function unchanged(item, expectedPhotos, status) {
    assert(sql(`select (select count(*) from private.photo_upload_operations where cleaning_attempt_id='${item.attempt}')=1
      and (select count(*) from private.photo_provider_objects o join private.photo_upload_operations u on u.id=o.operation_id where u.cleaning_attempt_id='${item.attempt}')=1
      and (select count(*) from private.attempt_photo_versions where cleaning_attempt_id='${item.attempt}')=${expectedPhotos}
      and (select count(*) from private.photo_upload_acceptances a join private.photo_upload_operations u on u.id=a.operation_id where u.cleaning_attempt_id='${item.attempt}')=${expectedPhotos}
      and (select count(*) from public.audit_events where entity_id='${item.attempt}' and event_type='photo.upload_accepted')=${expectedPhotos}
      and (select s.status from private.photo_upload_states s where cleaning_attempt_id='${item.attempt}')='${status}';`) === 't',
    'photo upload has exactly one operation/object and one or zero atomic photo acceptance/audit');
  }

  const same = await fixture();
  const replay = await race(begin(same),begin(same));
  assert(replay.success, 'concurrent identical begin returns same logical result');
  const op = operation(same);
  assert(JSON.parse(replay.output).operationId === op, 'loser retry returns original operation identity');
  unchanged(same,0,'reserved');

  const actorCardinality = () => sql(`select jsonb_build_object(
    'operations',(select count(*) from private.photo_upload_operations where actor_profile_id='${maid}'),
    'providerObjects',(select count(*) from private.photo_provider_objects p join private.photo_upload_operations o on o.id=p.operation_id where o.actor_profile_id='${maid}'),
    'states',(select count(*) from private.photo_upload_states where actor_profile_id='${maid}'),
    'events',(select count(*) from private.photo_upload_events e join private.photo_upload_operations o on o.id=e.operation_id where o.actor_profile_id='${maid}'),
    'rateRows',(select count(*) from private.photo_upload_rate_limits where actor_profile_id='${maid}'),
    'rateCount',(select occurrence_count from private.photo_upload_rate_limits where actor_profile_id='${maid}'));
  `);
  const beforeRotating=actorCardinality();
  for(let batch=0;batch<20;batch+=1) {
    // #84 revokes direct service EXECUTE. Preserve the #83 internal state-machine
    // regression as owner-only local transactions, not a restored runtime bypass.
    const results=await Promise.all(Array.from({length:25},(_,index)=>execute(
      begin(same,`rotation-${same.attempt}-${batch}-${index}`),`photo83-${randomUUID()}`
    )));
    assert(results.every((result)=>!result.success&&result.reason==='PHOTO_UPLOAD_IN_FLIGHT'), '500 rotating keys fail at the unfinished-slot gate');
  }
  assert(actorCardinality()===beforeRotating, '500 distinct key denials append no operation/provider/state/event/rate row or bucket increment');
  unchanged(same,0,'reserved');
  const rotating = await race(begin(same),begin(same,'different'));
  assert(!rotating.success && rotating.reason === 'PHOTO_UPLOAD_IN_FLIGHT', 'new key cannot append second unfinished same-slot operation');
  unchanged(same,0,'reserved');

  const claimant = await race(claim(op,claimA),claim(op,claimB));
  assert(!claimant.success && claimant.reason === 'PHOTO_UPLOAD_IN_FLIGHT', 'distinct simultaneous claimant cannot share live fence');
  assert(sql(`select lease_version=1 and lease_claim_digest='${claimA}' from private.photo_upload_states where operation_id='${op}';`) === 't', 'one claimant/fence persisted');
  const firstClaim = sql(claim(op,claimA));
  assert(sql(claim(op,claimA)) === firstClaim, 'same claimant retry does not renew lease');
  for(const callback of [provider(op,claimB),finalize(op,claimB)]) {
    const result = await execute(callback,`photo83-${randomUUID()}`);
    assert(!result.success && result.reason === 'PHOTO_UPLOAD_FENCE_CONFLICT', 'other claimant cannot record/finalize winner object');
  }
  const providerRetry = await race(provider(op,claimA),provider(op,claimA));
  assert(providerRetry.success, 'same provider result callback is idempotent after lock');
  unchanged(same,0,'provider_succeeded');
  const accepted = await race(finalize(op,claimA),reconcile(op));
  assert(accepted.success && JSON.parse(accepted.output).status === 'accepted', 'finalize winner makes concurrent reconcile preserve accepted');
  unchanged(same,1,'accepted');
  const lostResponse = sql(finalize(op,claimA));
  assert(JSON.parse(lostResponse).photoId === JSON.parse(accepted.output).photoId, 'finalize lost response returns same photo');
  const deletion = await execute(settle(op,claimB,2),`photo83-${randomUUID()}`);
  assert(!deletion.success && deletion.reason === 'PHOTO_OPERATION_ACCEPTED', 'accepted object can never become cleanup target');
  unchanged(same,1,'accepted');

  const retire = await fixture(); sql(begin(retire));
  const retiredOp = operation(retire); sql(claim(retiredOp,claimA)); sql(provider(retiredOp,claimA));
  // Local owner-only clock fixture; no production/test-clock RPC or external provider action.
  sql(`update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id='${retiredOp}';`);
  const retirement = await race(reconcile(retiredOp),finalize(retiredOp,claimA));
  assert(!retirement.success && retirement.reason === 'PHOTO_OPERATION_TERMINAL', 'retirement winner fences stale business finalize');
  unchanged(retire,0,'compensation_pending');
  const staleProvider = await execute(provider(retiredOp,claimA),`photo83-${randomUUID()}`);
  assert(!staleProvider.success && staleProvider.reason === 'PHOTO_UPLOAD_FENCE_CONFLICT', 'retired fence cannot mutate provider evidence');
  const wrongSettle = await execute(settle(retiredOp,claimA),`photo83-${randomUUID()}`);
  assert(!wrongSettle.success && wrongSettle.reason === 'PHOTO_UPLOAD_FENCE_CONFLICT', 'old claimant cannot settle new cleanup lease');
  const settled = await race(settle(retiredOp,claimB,2),settle(retiredOp,claimB,2));
  assert(settled.success && JSON.parse(settled.output).status === 'compensated', 'same cleanup 404 completion replays once');
  unchanged(retire,0,'compensated');

  function operationByKey(item, key) {
    return sql(`select id from private.photo_upload_operations where cleaning_attempt_id='${item.attempt}' and idempotency_key_digest='${digest(item.attempt+key)}';`);
  }
  function verifyDisposition(item, currentOp, wasAccepted, expectedPhotos) {
    assert(sql(`select (select count(*) from private.attempt_photo_versions where cleaning_attempt_id='${item.attempt}')=${expectedPhotos}
      and (select count(*) from public.audit_events where entity_id='${item.attempt}' and event_type='photo.upload_accepted')=${expectedPhotos}
      and exists(select 1 from private.photo_provider_objects where operation_id='${currentOp}' and provider_locator is not null)
      and exists(select 1 from private.photo_upload_acceptances where operation_id='${currentOp}')=${wasAccepted};`) === 't',
    'authorization/CAS race preserves provider identity and exactly the winning acceptance/audit');
    if (!wasAccepted) {
      sql(`update private.photo_upload_states set lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 where operation_id='${currentOp}';`);
    }
    const result = JSON.parse(sql(reconcile(currentOp)));
    assert(result.status === (wasAccepted ? 'accepted' : 'compensation_pending') && result.compensationAllowed === !wasAccepted,
      'reconciliation preserves accepted history; only a newly fenced never-accepted object is a compensation candidate');
  }

  for (const finalizeFirst of [true,false]) {
    const item=await fixture();sql(begin(item));
    const firstOp=operation(item);sql(claim(firstOp,claimA));sql(provider(firstOp,claimA));sql(finalize(firstOp,claimA));
    sql(begin(item,'replace',1));const replacement=operationByKey(item,'replace');
    sql(claim(replacement,claimA));sql(provider(replacement,claimA));
    const clear=`select private.clear_attempt_photo('${maid}','${item.attempt}','${item.slot}',1)`;
    const result=await race(finalizeFirst ? finalize(replacement,claimA) : clear, finalizeFirst ? clear : finalize(replacement,claimA));
    assert(!result.success && result.reason==='PHOTO_VERSION_CONFLICT', 'clear and finalize at same expected pointer revision admit one effect');
    assert(sql(`select revision=2 and (photo_version_id is not null)=${finalizeFirst} from private.attempt_photo_current where cleaning_attempt_id='${item.attempt}' and target_photo_slot_id='${item.slot}';`)==='t',
      'clear/finalize winner determines pointer while loser cannot overwrite it');
    verifyDisposition(item,replacement,finalizeFirst,finalizeFirst ? 2 : 1);
    assert(JSON.parse(sql(reconcile(firstOp))).compensationAllowed===false, 'clear never makes original accepted photo an orphan');
  }

  for (const change of ['session','account']) {
    for (const finalizeFirst of [true,false]) {
      const item=await fixture();sql(begin(item));const nextOp=operation(item);
      sql(claim(nextOp,claimA));sql(provider(nextOp,claimA));
      const revoke=change==='session' ? `delete from auth.sessions where id='${session}'`
        : `update public.profiles set status='inactive' where id='${maid}'`;
      try {
        const result=await race(finalizeFirst ? finalize(nextOp,claimA) : revoke, finalizeFirst ? revoke : finalize(nextOp,claimA));
        const denied=change==='session' ? 'SESSION_REVOKED' : 'CAPABILITY_ACCESS_REQUIRED';
        assert(finalizeFirst ? result.success : !result.success && result.reason===denied,
          'finalize and session/account invalidation serialize with latest authorization and no post-revocation acceptance');
        verifyDisposition(item,nextOp,finalizeFirst,finalizeFirst ? 1 : 0);
      } finally {
        // Restore only the synthetic fixture principal for the next isolated race.
        if(change==='session')sql(`insert into auth.sessions(id,user_id) select '${session}',auth_user_id from public.profiles where id='${maid}' on conflict(id) do nothing;`);
        else sql(`update public.profiles set status='active' where id='${maid}';`);
      }
    }
  }
  const expiry=await fixture();sql(begin(expiry));const expiringOp=operation(expiry);
  sql(claim(expiringOp,claimA));sql(provider(expiringOp,claimA));
  assert(sql(`select lease_expires_at>clock_timestamp()+interval '4 minutes' and lease_expires_at<=clock_timestamp()+interval '5 minutes' from private.photo_upload_states where operation_id='${expiringOp}';`)==='t',
    'real claim originally issues a five-minute lease');
  // Owner-only local fixture ages the remaining lease to two seconds; actual RPC uses its real post-lock clock.
  const expired=await race(`update private.photo_upload_states set lease_expires_at=clock_timestamp()+interval '2 seconds',revision=revision+1 where operation_id='${expiringOp}'`,finalize(expiringOp,claimA),2500);
  assert(!expired.success&&expired.reason==='PHOTO_UPLOAD_FENCE_CONFLICT', 'finalize waiting across actual lease expiry cannot accept provider result');
  unchanged(expiry,0,'provider_succeeded');
  verifyDisposition(expiry,expiringOp,false,0);

  const nextMaid=await account('maid'),adminSession=randomUUID();
  sql(`insert into auth.sessions(id,user_id) select '${adminSession}',auth_user_id from public.profiles where id='${admin}';`);
  const availability=randomUUID();
  sql(`insert into public.availability_versions(id,maid_profile_id,week_start,version,submitted_at)
    values('${availability}','${nextMaid}',date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date,1,clock_timestamp());
    insert into public.availability_days(availability_version_id,work_date,available)
    select '${availability}',date_trunc('week',clock_timestamp() at time zone 'Asia/Seoul')::date+n,true from generate_series(0,6)n;`);
  let handoverSequence=0;
  for(const finalizeFirst of [true,false]) {
    const item=await fixture(true);sql(begin(item));const currentOp=operation(item);
    sql(claim(currentOp,claimA));sql(provider(currentOp,claimA));
    const profileVersion=Number(sql(`select account_lifecycle_version from public.profiles where id='${maid}';`));
    assert(Number.isSafeInteger(profileVersion)&&profileVersion>0,'synthetic current profile CAS');
    const handover=`select public.manage_cleaning_attempt_lifecycle('${admin}','${adminSession}','${item.attempt}',2,'${item.assignment}',2,${profileVersion},'interrupt_handover',
      jsonb_build_object('maidProfileId','${nextMaid}','sequenceNumber',${++handoverSequence},
        'serviceDate',(clock_timestamp() at time zone 'Asia/Seoul')::date,
        'availableFrom',(clock_timestamp() at time zone 'Asia/Seoul')::date::timestamp at time zone 'Asia/Seoul',
        'dueAt',((clock_timestamp() at time zone 'Asia/Seoul')::date+1)::timestamp at time zone 'Asia/Seoul','deactivateOld',false),
      'ADMIN_HANDOVER','${randomUUID()}',repeat('b',64))`;
    const result=await race(finalizeFirst?finalize(currentOp,claimA):handover,finalizeFirst?handover:finalize(currentOp,claimA));
    assert(result.success,'handover and authorized old-attempt evidence finalization serialize in both launch orders');
    assert(sql(`select (select count(*) from public.cleaning_attempts where cleaning_target_id='${item.target}')=2
      and exists(select 1 from public.cleaning_attempts where id='${item.attempt}' and status='interrupted')
      and exists(select 1 from private.attempt_capability_grants where attempt_id='${item.attempt}' and kind='evidence_upload'
        and allowed_actions=array['upload_evidence','validate_evidence']::text[])
      and exists(select 1 from public.cleaning_attempts where cleaning_target_id='${item.target}' and id<>'${item.attempt}' and status='scheduled' and maid_profile_id='${nextMaid}')
      and not exists(select 1 from private.attempt_photo_current p join public.cleaning_attempts a on a.id=p.cleaning_attempt_id where a.cleaning_target_id='${item.target}' and a.id<>'${item.attempt}')
      and not exists(select 1 from private.attempt_photo_versions p join public.cleaning_attempts a on a.id=p.cleaning_attempt_id where a.cleaning_target_id='${item.target}' and a.id<>'${item.attempt}');`)==='t',
      'real handover preserves old evidence-only scope and leaves new scheduled attempt photo pointer empty');
    verifyDisposition(item,currentOp,true,1);
  }

  // #180 collection races use the real collection helper/delete/bind functions
  // in parallel owner transactions. The synthetic fixture promotes only its
  // frozen optional slot to a collection; it does not create an operational
  // checkout template or weaken runtime grants.
  function acceptedPhoto(item,slot,photoItem,collectionRevision,itemRevision,hex='a') {
    const operationId=randomUUID(),objectId=randomUUID();
    const collectionColumns=photoItem===null?'null,null':`'${photoItem}',${itemRevision}`;
    const record=photoItem===null
      ? `private.record_validated_attempt_photo('${maid}','${item.attempt}','${slot}',${collectionRevision},repeat('${hex}',64),'image/jpeg',100,uploaded_at)`
      : `private.record_validated_collection_photo('${maid}','${item.attempt}','${slot}','${photoItem}',${collectionRevision},${itemRevision},repeat('${hex}',64),'image/jpeg',100,uploaded_at)`;
    return `do $fixture$ declare photo_id uuid; uploaded_at timestamptz:=clock_timestamp(); begin
      insert into private.photo_upload_operations(
        id,actor_profile_id,command_type,idempotency_key_digest,request_hash,
        cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,
        target_photo_slot_id,expected_photo_revision,sha256,mime_type,size_bytes,
        collection_item_id,expected_item_revision)
      values('${operationId}','${maid}',${photoItem===null?"'photo.upload'":"'photo.collection.upload'"},
        encode(extensions.digest('${operationId}:collection-fixture-key','sha256'),'hex'),
        encode(extensions.digest('${operationId}:collection-fixture-request','sha256'),'hex'),
        '${item.attempt}','${item.target}','${item.assignment}',2,'${slot}',${collectionRevision},
        repeat('${hex}',64),'image/jpeg',100,${collectionColumns});
      insert into private.photo_provider_objects(id,operation_id,provider_locator,uploaded_at,purge_after)
      values('${objectId}','${operationId}','fixture_${objectId.replaceAll('-','')}',uploaded_at,uploaded_at+interval '168 hours');
      insert into private.photo_upload_states(
        operation_id,cleaning_attempt_id,target_photo_slot_id,actor_profile_id,status,lease_version,revision)
      values('${operationId}','${item.attempt}','${slot}','${maid}','provider_succeeded',0,1);
      photo_id:=${record};
      insert into private.photo_upload_acceptances(operation_id,object_id,photo_version_id)
      values('${operationId}','${objectId}',photo_id);
      update private.photo_upload_states set status='accepted',revision=revision+1
      where operation_id='${operationId}';
    end $fixture$`;
  }
  async function collectionFixture() {
    const item=await fixture();
    const collectionSlot=sql(`select id from private.target_photo_slot_snapshots where cleaning_target_id='${item.target}' and not required;`);
    assert(/^[0-9a-f-]{36}$/.test(collectionSlot),'collection fixture has one optional slot');
    sql(`begin;
      alter table private.target_photo_snapshot_contracts disable trigger photo_model_append_only;
      alter table private.target_photo_slot_snapshots disable trigger photo_model_append_only;
      update private.target_photo_slot_snapshots
        set slot_key='tv-on',display_order=0,required=true,
          slot_snapshot=jsonb_build_object('slotKey','tv-on','required',true,'displayOrder',0,'maxPhotos',1,'label','synthetic')
        where id='${item.slot}';
      update private.target_photo_slot_snapshots
        set slot_key='extra-proof',display_order=8,required=false,
          slot_snapshot=jsonb_build_object('slotKey','extra-proof','required',false,'displayOrder',8,'maxPhotos',10,'label','synthetic')
        where id='${collectionSlot}';
      update private.target_photo_snapshot_contracts
        set frozen_snapshot=jsonb_set(jsonb_set(jsonb_set(
          frozen_snapshot,'{version}',to_jsonb(8)),'{cleaningKind}',to_jsonb('checkout'::text)),'{slots}',(
            select jsonb_agg(jsonb_build_object(
              'slotKey',case when i=1 then 'tv-on' when i=2 then 'entry-storage' when i=9 then 'extra-proof' else 'slot-'||i end,
              'required',i<9,'displayOrder',i-1,'maxPhotos',case when i=9 then 10 else 1 end,'label','synthetic') order by i)
            from generate_series(1,9)i))
        where cleaning_target_id='${item.target}';
      insert into private.target_photo_slot_snapshots(
        cleaning_target_id,template_version_id,slot_key,display_order,required,slot_snapshot)
      select '${item.target}',template_version_id,
        case when i=2 then 'entry-storage' else 'slot-'||i end,i-1,true,
        jsonb_build_object('slotKey',case when i=2 then 'entry-storage' else 'slot-'||i end,
          'required',true,'displayOrder',i-1,'maxPhotos',1,'label','synthetic')
      from private.target_photo_slot_snapshots cross join generate_series(2,8)i
      where id='${item.slot}';
      alter table private.target_photo_slot_snapshots enable trigger photo_model_append_only;
      alter table private.target_photo_snapshot_contracts enable trigger photo_model_append_only;
      commit;`);
    const requiredSlots=JSON.parse(sql(`select json_agg(id::text order by display_order)::text
      from private.target_photo_slot_snapshots where cleaning_target_id='${item.target}' and required;`));
    for(const requiredSlot of requiredSlots)sql(acceptedPhoto(item,requiredSlot,null,0,null,'a'));
    assert(sql(`select private.photo_slot_max_photos('${collectionSlot}','${item.target}');`)==='10','synthetic optional slot exercises collection path');
    return {...item,collectionSlot};
  }
  const collectionRecord=(item,photoItem,collectionRevision,itemRevision,hex='b')=>
    acceptedPhoto(item,item.collectionSlot,photoItem,collectionRevision,itemRevision,hex);
  const collectionDelete=(item,photoItem,collectionRevision,itemRevision,key,hash='f')=>
    `select public.delete_photo_collection_item('${maid}','${session}','${item.attempt}','${item.assignment}',2,'${item.collectionSlot}','${photoItem}',${collectionRevision},${itemRevision},'${digest(key)}','${digest(hash)}')`;
  function collectionState(item,active,revision,changes) {
    assert(sql(`select
      (select count(*) from private.attempt_photo_collection_items where cleaning_attempt_id='${item.attempt}' and active)=${active}
      and (select revision from private.attempt_photo_collection_states where cleaning_attempt_id='${item.attempt}' and target_photo_slot_id='${item.collectionSlot}')=${revision}
      and (select count(*) from private.attempt_photo_collection_changes where cleaning_attempt_id='${item.attempt}')=${changes};`)==='t',
    'collection race leaves exact active count, revision and append-only history');
  }
  function newSubmission(item) {
    const submission=randomUUID();
    sql(`insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,photo_manifest,submitted_by)
      values('${submission}','${item.attempt}','${randomUUID()}',1,'[]','${maid}');`);
    return {submission,bind:`select private.bind_submission_photo_model('${maid}','${submission}',0)`};
  }

  const initialCollection=await collectionFixture();
  const initialWinner=randomUUID(),initialLoser=randomUUID();
  const initialRace=await race(collectionRecord(initialCollection,initialWinner,0,0),collectionRecord(initialCollection,initialLoser,0,0));
  assert(!initialRace.success&&initialRace.reason==='PHOTO_COLLECTION_VERSION_CONFLICT','two first appends serialize and one stale CAS loses');
  collectionState(initialCollection,1,1,1);

  const cappedCollection=await collectionFixture();
  for(let index=0;index<9;index+=1)sql(collectionRecord(cappedCollection,randomUUID(),index,0,(index+1).toString(16)));
  const capRace=await race(collectionRecord(cappedCollection,randomUUID(),9,0,'a'),collectionRecord(cappedCollection,randomUUID(),9,0,'b'));
  assert(!capRace.success&&capRace.reason==='PHOTO_COLLECTION_VERSION_CONFLICT','concurrent tenth/eleventh append admits one CAS winner');
  const overCap=await execute(collectionRecord(cappedCollection,randomUUID(),10,0,'c'),`photo83-${randomUUID()}`);
  assert(!overCap.success&&overCap.reason==='PHOTO_COLLECTION_LIMIT_EXCEEDED','ten-item collection rejects a fresh eleventh append');
  collectionState(cappedCollection,10,10,10);

  for(const uploadFirst of [true,false]) {
    const item=await collectionFixture(),photoItem=randomUUID();
    sql(collectionRecord(item,photoItem,0,0));
    const upload=collectionRecord(item,photoItem,1,1,'d');
    const remove=collectionDelete(item,photoItem,1,1,`${item.attempt}-delete`);
    const result=await race(uploadFirst?upload:remove,uploadFirst?remove:upload);
    assert(!result.success&&['PHOTO_COLLECTION_VERSION_CONFLICT','PHOTO_ITEM_VERSION_CONFLICT'].includes(result.reason),
      'replace and delete serialize on collection/item CAS');
    collectionState(item,uploadFirst?1:0,2,2);
  }

  for(const uploadFirst of [true,false]) {
    const item=await collectionFixture(),photoItem=randomUUID();
    sql(collectionRecord(item,photoItem,0,0));
    const submission=newSubmission(item);
    const replace=collectionRecord(item,photoItem,1,1,'e');
    const result=await race(uploadFirst?replace:submission.bind,uploadFirst?submission.bind:replace);
    assert(result.success,'collection replace and submission binding both finish after serial lock ordering');
    const boundRevision=Number(sql(`select item_revision from private.submission_photo_bindings where submission_id='${submission.submission}' and collection_item_id='${photoItem}';`));
    assert(boundRevision===(uploadFirst?2:1),'submission seals exactly the collection revision visible at its lock point');
  }

  for(const deleteFirst of [true,false]) {
    const item=await collectionFixture(),photoItem=randomUUID();
    sql(collectionRecord(item,photoItem,0,0));
    const submission=newSubmission(item);
    const remove=collectionDelete(item,photoItem,1,1,`${item.attempt}-submit-delete`);
    const result=await race(deleteFirst?remove:submission.bind,deleteFirst?submission.bind:remove);
    assert(result.success,'collection delete and submission binding both finish after serial lock ordering');
    const bound=sql(`select exists(select 1 from private.submission_photo_bindings where submission_id='${submission.submission}' and collection_item_id='${photoItem}');`)==='t';
    assert(bound===!deleteFirst,'submission binding keeps the exact pre-delete item or excludes the already-deleted item');
  }

  const replayCollection=await collectionFixture(),replayItem=randomUUID();
  sql(collectionRecord(replayCollection,replayItem,0,0));
  const replayDelete=collectionDelete(replayCollection,replayItem,1,1,`${replayCollection.attempt}-replay`);
  const replayRace=await race(replayDelete,replayDelete);
  assert(replayRace.success&&JSON.parse(replayRace.output).collectionRevision===2,'same delete key replays one committed response after waiting');
  const reused=await execute(collectionDelete(replayCollection,replayItem,1,1,`${replayCollection.attempt}-replay`,'different'),`photo83-${randomUUID()}`);
  assert(!reused.success&&reused.reason==='IDEMPOTENCY_KEY_REUSED','same delete key with a different request hash fails closed');
  collectionState(replayCollection,0,2,2);

  console.log('Photo storage concurrency passed: begin/cardinality, claimant/expiry fencing, provider retry, finalize/reconcile/clear/session/account/handover and collection append/limit/replace/delete/submit/idempotency races.');
}
