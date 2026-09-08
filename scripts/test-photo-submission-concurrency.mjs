import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

function assert(value, message) { if (!value) throw new Error(message); }
function ok(result, label) {
  if (result.error) throw new Error(`${label} failed (${String(result.error.code ?? 'DB_ERROR')})`);
  return result.data;
}
const container = 'supabase_db_room-management-system-backend';
const args = ['exec', '-i', container, 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'];

/** Owner-only model helpers, exercised through real local PostgreSQL transactions.
 * This does NOT expose upload/submit APIs or claim that synthetic metadata proves image bytes.
 * All identifiers/SQL remain in memory; only fixed PASS labels reach the runner.
 */
export async function testPhotoSubmissionConcurrency(client) {
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
    assert(/^photo30-[0-9a-f-]+$/.test(name), 'fixed local connection identifier');
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '';
    const timer = setTimeout(() => { child.kill(); }, 15000);
    child.stdout.on('data', (value) => { output += value.toString(); });
    child.stderr.on('data', (value) => { errors += value.toString(); });
    const result = new Promise((resolve, reject) => {
      child.once('error', () => { clearTimeout(timer); reject(new Error('photo race process failed')); });
      child.once('close', (code) => {
        clearTimeout(timer);
        const reason = ['PHOTO_VERSION_CONFLICT', 'SUBMISSION_VERSION_CONFLICT'].find((known) => errors.includes(known)) ?? null;
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
  async function race(first, second) {
    const release = await holdMutation(first), name = `photo30-${randomUUID()}`;
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
  const roomType = ok(await client.from('room_types').select('id').eq('code', 'standard').single(), 'photo standard type');
  const templateId = randomUUID();
  const version = Number(sql(`select greatest(coalesce(max(version),0),6)+1 from public.cleaning_template_versions where room_type_id='${roomType.id}' and cleaning_kind='additional';`));
  assert(Number.isSafeInteger(version) && version >= 7 && version <= 2147483647, 'photo synthetic template version is bounded');
  // A retired synthetic template avoids changing an existing published operational choice.
  sql(`insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
    values('${templateId}','${roomType.id}','additional',${version},'retired',1,
      '[{"slotKey":"fixture-required","required":true,"displayOrder":0,"label":"synthetic"},{"slotKey":"fixture-optional","required":false,"displayOrder":1,"label":"synthetic"}]','${admin}');`);
  let sequence = 0;
  async function fixture() {
    const room = randomUUID(), target = randomUUID(), assignment = randomUUID(), attempt = randomUUID();
    ok(await client.from('rooms').insert({ id: room, room_number: `${Date.now()}${++sequence}`, room_type_id: roomType.id, elevator_zone: 'A' }), 'photo room');
    sql(`insert into public.cleaning_targets(id,room_id,cleaning_kind,source,source_key,original_service_date,effective_service_date,status,assignment_version,room_type_snapshot,fee_snapshot,template_snapshot,created_by)
      select '${target}','${room}','additional','manual_room_request','photo-${target}',current_date,current_date,'notified',2,
      '{"code":"standard"}',10000,jsonb_build_object('id',id,'version',version,'photoSlots',photo_slots,'durationMinutes',1),'${admin}'
      from public.cleaning_template_versions where id='${templateId}';
      insert into public.cleaning_assignments(id,cleaning_target_id,maid_profile_id,sequence_number,revision,notified_at,changed_by)
      values('${assignment}','${target}','${maid}',${sequence},2,clock_timestamp()-interval '2 hours','${admin}');
      insert into public.cleaning_attempts(id,cleaning_target_id,assignment_id,maid_profile_id,attempt_number,status,assignment_revision,template_snapshot,room_snapshot,started_at,field_completed_at,ended_at)
      select '${attempt}',id,'${assignment}','${maid}',1,'field_completed',2,template_snapshot,jsonb_build_object('roomId',room_id),clock_timestamp()-interval '2 hours',clock_timestamp()-interval '1 hour',clock_timestamp()-interval '1 hour'
      from public.cleaning_targets where id='${target}';`);
    const slot = sql(`select id from private.target_photo_slot_snapshots where cleaning_target_id='${target}' and slot_key='fixture-required';`);
    assert(/^[0-9a-f-]{36}$/.test(slot), 'photo fixture materialized an exact target slot');
    return { target, assignment, attempt, slot };
  }
  function photo(item, revision, hash = 'a') {
    assert(['a', 'b', 'c'].includes(hash), 'fixed synthetic photo hash');
    return `select private.record_validated_attempt_photo('${maid}','${item.attempt}','${item.slot}',${revision},repeat('${hash}',64),'image/jpeg',100,clock_timestamp()-interval '1 minute')`;
  }
  function submission(item, versionNumber) {
    const id = randomUUID();
    sql(`insert into public.cleaning_submissions(id,cleaning_attempt_id,client_submission_id,version,photo_manifest,submitted_by)
      values('${id}','${item.attempt}','${randomUUID()}',${versionNumber},'[]','${maid}');`);
    return id;
  }
  const bind = (id, revision) => `select private.bind_submission_photo_model('${maid}','${id}',${revision})`;
  function photoCounts(item, count) {
    assert(sql(`select (select count(*) from private.attempt_photo_versions where cleaning_attempt_id='${item.attempt}')=${count}
      and (select count(*) from private.attempt_photo_changes where cleaning_attempt_id='${item.attempt}')=${count}
      and (select revision from private.attempt_photo_current where cleaning_attempt_id='${item.attempt}' and target_photo_slot_id='${item.slot}')=${count};`) === 't', 'photo CAS preserves exactly one version/history per winning revision');
  }

  const same = await fixture();
  const firstRace = await race(photo(same, 0, 'a'), photo(same, 0, 'b'));
  assert(!firstRace.success && firstRace.reason === 'PHOTO_VERSION_CONFLICT', 'same slot initial CAS admits one writer only');
  photoCounts(same, 1);
  const replaceRace = await race(photo(same, 1, 'b'), photo(same, 1, 'c'));
  assert(!replaceRace.success && replaceRace.reason === 'PHOTO_VERSION_CONFLICT', 'same slot replacement CAS admits one writer only');
  photoCounts(same, 2);

  for (const bindFirst of [true, false]) {
    const item = await fixture(); sql(photo(item, 0));
    const submitted = submission(item, 1);
    const result = await race(bindFirst ? bind(submitted, 0) : photo(item, 1, 'b'), bindFirst ? photo(item, 1, 'b') : bind(submitted, 0));
    assert(result.success, 'replacement and binding serialize successfully in both lock orders');
    const expected = bindFirst ? 1 : 2;
    assert(sql(`select (select count(*) from private.submission_photo_bindings where submission_id='${submitted}')=1
      and (select photo_version from private.submission_photo_bindings where submission_id='${submitted}')=${expected}
      and (select photo_count from private.submission_photo_binding_sets where submission_id='${submitted}')=1
      and (select submission_id from private.submission_current_pointers where cleaning_attempt_id='${item.attempt}')='${submitted}';`) === 't', 'seal binds exactly the serialized current photo without mixed membership');
    sql(photo(item, 2, 'c'));
    assert(sql(`select photo_version from private.submission_photo_bindings where submission_id='${submitted}';`) === String(expected), 'later retake cannot rewrite sealed submission membership');
    photoCounts(item, 3);
  }

  const pointer = await fixture(); sql(photo(pointer, 0));
  const oldSubmission = submission(pointer, 1);
  const initialPointer = await race(bind(oldSubmission, 0), bind(oldSubmission, 0));
  assert(!initialPointer.success && initialPointer.reason === 'SUBMISSION_VERSION_CONFLICT', 'submission initial pointer CAS has one winner');
  sql(`update public.cleaning_submissions set status='superseded',superseded_at=clock_timestamp() where id='${oldSubmission}';`);
  const nextSubmission = submission(pointer, 2);
  const nextPointer = await race(bind(nextSubmission, 1), bind(nextSubmission, 1));
  assert(!nextPointer.success && nextPointer.reason === 'SUBMISSION_VERSION_CONFLICT', 'submission replacement pointer CAS has one winner');
  assert(sql(`select (select revision from private.submission_current_pointers where cleaning_attempt_id='${pointer.attempt}')=2
    and (select submission_id from private.submission_current_pointers where cleaning_attempt_id='${pointer.attempt}')='${nextSubmission}'
    and (select count(*) from private.submission_photo_binding_sets where cleaning_attempt_id='${pointer.attempt}')=2
    and (select count(*) from private.submission_photo_bindings where cleaning_attempt_id='${pointer.attempt}')=2
    and (select count(*) from public.cleaning_submissions where cleaning_attempt_id='${pointer.attempt}')=2;`) === 't', 'CAS loser leaves no partial binding/seal and prior canonical submission survives');
  console.log('Photo model concurrency passed: slot CAS, replace/bind seal, submission pointer CAS.');
}
