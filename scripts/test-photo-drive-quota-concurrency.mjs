import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';

function assert(value, message) { if (!value) throw new Error(message); }
const args = ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];
const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Local owner fixtures; commands race as real PostgreSQL transactions, never Google HTTP. */
export async function testPhotoDriveQuotaConcurrency(client) {
  const url = new URL(client.supabaseUrl);
  assert(['localhost', '127.0.0.1'].includes(url.hostname), 'photo quota concurrency is local-only');
  function sql(statement) {
    try { return execFileSync('docker', args, { input: `set statement_timeout='10s';${statement}`, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
    catch { throw new Error('photo quota local fixture failed (raw SQL redacted)'); }
  }
  async function race(first, second, waitMs = 0, beforeWait = null) {
    const holder = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const holderClosed = new Promise((resolve) => holder.once('close', resolve));
    holder.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      let output = '', ready = false;
      const timer = setTimeout(() => { holder.kill(); reject(new Error('photo quota lock setup timeout')); }, 10000);
      holder.once('error', () => { clearTimeout(timer); reject(new Error('photo quota holder failed')); });
      holder.once('close', () => { if (!ready) { clearTimeout(timer); reject(new Error('photo quota setup rejected')); } });
      holder.stdout.on('data', (value) => {
        output += value.toString();
        if (!ready && output.includes('PHOTO_QUOTA_READY')) { ready = true; clearTimeout(timer); resolve(); }
      });
      holder.stdin.write(`begin;set local statement_timeout='10s';set local idle_in_transaction_session_timeout='15s';${first};\n\\echo PHOTO_QUOTA_READY\n`);
    });
    const name = `photo84-${randomUUID()}`;
    const worker = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    worker.stdout.on('data', (value) => { output += value.toString(); });
    worker.stderr.on('data', (value) => { errors += value.toString(); });
    const result = new Promise((resolve, reject) => {
      worker.once('error', () => reject(new Error('photo quota worker failed')));
      worker.once('close', (code) => resolve({ success: code === 0, output: output.trim(), reason: ['PHOTO_UPLOAD_IN_FLIGHT', 'PHOTO_STORAGE_QUOTA_EXCEEDED', 'PHOTO_QUOTA_SNAPSHOT_STALE', 'PHOTO_STORAGE_QUOTA_UNAVAILABLE', 'PHOTO_ADMISSION_EXPIRED'].find((reason) => errors.includes(reason)) ?? null }));
    });
    worker.stdin.end(`begin;set local application_name='${name}';set local statement_timeout='10s';${second};commit;\n`);
    let released = false;
    try {
      let blocked = false;
      for (let i = 0; i < 40; i += 1) {
        if (sql(`select exists(select 1 from pg_stat_activity where application_name='${name}' and state='active' and wait_event_type='Lock');`) === 't') { blocked = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert(blocked, 'photo quota RPC must actually wait on another transaction');
      if (beforeWait) beforeWait();
      if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
      holder.stdin.end('commit;\n\\q\n'); released = true;
      assert(await holderClosed === 0, 'photo quota holder commits');
      return await result;
    } finally {
      if (!released) holder.stdin.end('rollback;\n\\q\n');
      await holderClosed; await result;
    }
  }
  const admin = randomUUID(), maid = randomUUID(), adminUser = randomUUID(), maidUser = randomUUID(), session = randomUUID(), template = randomUUID();
  sql(`insert into auth.users(id) values('${adminUser}'),('${maidUser}');
    insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,login_sequence,role,status,must_change_password) values
    ('${admin}','${adminUser}','quota-${admin}','quota-${admin}','quota-${admin}','quota-${admin}',0,'admin','active',false),
    ('${maid}','${maidUser}','quota-${maid}','quota-${maid}','quota-${maid}','quota-${maid}',0,'maid','active',false);
    insert into auth.sessions(id,user_id) values('${session}','${maidUser}');
    insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
    select '${template}',id,'additional',(select coalesce(max(version),6)+1 from public.cleaning_template_versions where room_type_id=rt.id and cleaning_kind='additional'),
    'retired',1,'[{"slotKey":"required","required":true,"displayOrder":0},{"slotKey":"optional","required":false,"displayOrder":1}]','${admin}'
    from public.room_types rt where code='standard';`);
  let sequence = 0;
  function fixture() {
    const target = randomUUID(), assignment = randomUUID(), attempt = randomUUID(); sequence += 1;
    sql(`insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
      select '${target}',r.id,'additional','manual_room_request','quota-${target}',current_date,current_date,'notified',2,'{"code":"standard"}',10000,
      jsonb_build_object('id',t.id,'version',t.version,'photoSlots',t.photo_slots,'durationMinutes',1),'${admin}'
      from public.rooms r cross join public.cleaning_template_versions t where r.room_number='701' and t.id='${template}';
      insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
      values('${assignment}','${target}','${maid}',${sequence},2,clock_timestamp()-interval '2 hours','${admin}');
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
      select '${attempt}',id,'${assignment}','${maid}',1,'field_completed',2,template_snapshot,jsonb_build_object('roomId',room_id),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'
      from public.cleaning_targets where id='${target}';`);
    return { target, assignment, attempt, slot: sql(`select id from private.target_photo_slot_snapshots where cleaning_target_id='${target}' and slot_key='required';`) };
  }
  const admit = (item, key) => `select public.admit_photo_upload('${maid}','${session}','${item.attempt}','${item.assignment}',2,'${item.slot}',0,'${digest(key)}')`;
  sql('select public.refresh_photo_storage_quota(clock_timestamp(),0);');
  const same = fixture(), key = randomUUID();
  const replay = await race(admit(same,key),admit(same,key));
  assert(replay.success, 'same-key concurrent admission replays');
  assert(sql(`select count(*) from private.photo_upload_admissions where actor_profile_id='${maid}' and idempotency_key_digest='${digest(key)}';`) === '1', 'same request reserves bytes exactly once');
  const rotated = await race(admit(same,key),admit(same,randomUUID()));
  assert(!rotated.success && rotated.reason === 'PHOTO_UPLOAD_IN_FLIGHT', 'rotating key cannot bypass slot reservation');

  const first = fixture(), second = fixture();
  const pending = Number(sql("select private.photo_quota_context(clock_timestamp())->>'pendingBytes';"));
  assert(Number.isSafeInteger(pending) && pending < 11999692800, 'local quota fixture is bounded');
  sql(`select public.refresh_photo_storage_quota(clock_timestamp(),${12000000000-pending-307201});`);
  const over = await race(admit(first,randomUUID()),admit(second,randomUUID()));
  assert(!over.success && over.reason === 'PHOTO_STORAGE_QUOTA_EXCEEDED', 'competing different slots cannot oversubscribe final300KiB budget');
  const old = sql("select clock_timestamp()::text;");
  const stale = await race('select public.refresh_photo_storage_quota(clock_timestamp(),100);',`select public.refresh_photo_storage_quota('${old}'::timestamptz,0);`);
  assert(!stale.success && stale.reason === 'PHOTO_QUOTA_SNAPSHOT_STALE', 'late older provider response cannot replace newer snapshot');

  const expiry = fixture(), expiryKey = randomUUID();
  const admissionId = randomUUID();
  sql(`insert into private.photo_upload_admissions(id,actor_profile_id,cleaning_attempt_id,cleaning_target_id,assignment_id,assignment_revision,target_photo_slot_id,expected_photo_revision,idempotency_key_digest,created_at,expires_at,quota_revision)
    select '${admissionId}','${maid}','${expiry.attempt}','${expiry.target}','${expiry.assignment}',2,'${expiry.slot}',0,'${digest(expiryKey)}',at_time-interval '296 seconds',at_time+interval '4 seconds',1 from(select clock_timestamp() at_time) anchor;`);
  const expired = await race("select pg_advisory_xact_lock(hashtextextended('room-management:reservation-command',0));",
    `select public.begin_admitted_photo_upload('${maid}','${session}','${admissionId}',repeat('a',64),'image/jpeg',100,'${digest(expiryKey)}',repeat('b',64));`,4500,
    () => { assert(sql(`select expires_at>clock_timestamp() from private.photo_upload_admissions where id='${admissionId}';`) === 't', 'lease is still valid when blocked public RPC is observed'); });
  assert(!expired.success && expired.reason === 'PHOTO_ADMISSION_EXPIRED', 'public begin recomputes clock after actual lock wait across5minute lease');
  assert(sql(`select count(*) from private.photo_upload_admission_bindings where admission_id='${admissionId}';`) === '0', 'expiry race creates no operation binding');
  sql('select public.refresh_photo_storage_quota(clock_timestamp(),0);');
  function folderOperation() {
    const item = fixture(), key = randomUUID(), claim = digest(randomUUID());
    const admission = JSON.parse(sql(admit(item,key))).admissionId;
    const operation = JSON.parse(sql(`select public.begin_admitted_photo_upload('${maid}','${session}','${admission}',repeat('a',64),'image/jpeg',100,'${digest(key)}',repeat('b',64));`)).operationId;
    sql(`select public.claim_admitted_photo_upload('${maid}','${session}','${operation}','${claim}');`);
    return { operation, claim };
  }
  const folderA = folderOperation(), folderB = folderOperation();
  const reserveFolder = (item,scope,candidate) => `select public.reserve_photo_drive_folder('${maid}','${session}','${item.operation}',1,'${item.claim}','${scope}','synthetic_quota_root_84','${candidate}');`;
  for (const scope of ['date','room']) {
    const candidateA = `folder_${randomUUID()}`, candidateB = `folder_${randomUUID()}`;
    const winnerRace = await race(reserveFolder(folderA,scope,candidateA),reserveFolder(folderB,scope,candidateB));
    assert(winnerRace.success, 'different workers replay the same folder-scope winner');
    const projected = JSON.parse(winnerRace.output);
    const replayed = JSON.parse(sql(reserveFolder(folderA,scope,`folder_${randomUUID()}`)));
    assert(projected.folderId === replayed.folderId && projected.parentFolderId === replayed.parentFolderId, 'folder ID and parent are deterministic across different candidates');
    assert(sql(`select count(*) from private.photo_drive_folder_identities where upload_date='${projected.uploadDate}' and scope_room_number='${scope === 'date' ? '' : '701'}';`) === '1', 'one immutable registry row per date/room scope');
    assert(sql(`select count(*) from private.photo_drive_folder_identities where provider_folder_id='${candidateB}';`) === '0', 'losing candidate ID is unused and never registered');
  }
  console.log('Photo Drive quota/folder races passed: one admission replay, slot exclusion, pending-byte serialization, stale refresh, post-lock expiry, two-worker date/room folder winner and unused loser ID.');
}
