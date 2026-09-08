import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

function assert(value, message) { if (!value) throw new Error(message); }
function ok(result, label) {
  if (result.error) throw new Error(`${label} failed (${String(result.error.code ?? 'DB_ERROR')})`);
  return result.data;
}

// Real local Auth/session/RPC races. Every credential, UUID and SQL result remains in memory.
export async function testAttemptOfflineExpiryConcurrency(client) {
  assert(['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname), 'offline races require local Supabase');
  function sql(statement) {
    try {
      return execFileSync('docker', ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { input: statement, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch { throw new Error('offline local SQL fixture/check failed (raw details redacted)'); }
  }
  async function holdLock(statement) {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stderr.on('data', () => {});
    await new Promise((resolve, reject) => {
      let ready = false; let output = '';
      const timeout = setTimeout(() => { child.kill(); reject(new Error('offline lock setup timed out')); }, 10000);
      child.once('error', () => { clearTimeout(timeout); reject(new Error('offline lock setup failed')); });
      child.once('close', () => { if (!ready) { clearTimeout(timeout); reject(new Error('offline lock closed prematurely')); } });
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        if (!ready && output.includes('LOCK_READY')) { ready = true; clearTimeout(timeout); output = ''; resolve(); }
      });
      child.stdin.write(`begin;set local statement_timeout='12s';set local idle_in_transaction_session_timeout='15s';${statement};\n\\echo LOCK_READY\n`);
    });
    let promise;
    return (beforeCommit = '') => promise ??= (async () => {
      child.stdin.end(`${beforeCommit};commit;\n\\q\n`);
      assert(await closed === 0, 'offline lock released without deadlock');
    })();
  }
  async function waitForLock(rpcName) {
    assert(/^[a-z_]+$/.test(rpcName), 'fixed RPC filter');
    for (let i = 0; i < 50; i += 1) {
      if (sql(`select exists(select 1 from pg_stat_activity where pid<>pg_backend_pid() and state='active' and wait_event_type='Lock' and query like '%${rpcName}%');`) === 't') return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('offline RPC did not reach expected lock');
  }
  async function account(role) {
    const id = randomUUID(); const authId = randomUUID();
    const email = `offline-expiry-${authId}@test.invalid`; const password = `T:${randomUUID()}`;
    ok(await client.auth.admin.createUser({ id: authId, email, password, email_confirm: true }), 'offline Auth');
    ok(await client.from('profiles').insert({ id, auth_user_id: authId, display_name: `offline-expiry-${id}`, display_name_normalized: `offline-expiry-${id}`, login_id: `offline-expiry-${id}`, login_id_normalized: `offline-expiry-${id}`, login_sequence: 0, role, status: 'active', must_change_password: false }), 'offline profile');
    const loginClient = createClient(client.supabaseUrl, client.supabaseKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const signed = ok(await loginClient.auth.signInWithPassword({ email, password }), 'offline sign-in');
    return { id, sessionId: JSON.parse(Buffer.from(signed.session.access_token.split('.')[1], 'base64url').toString()).session_id };
  }
  const admin = await account('admin');
  const roomType = ok(await client.from('room_types').select('id').limit(1).single(), 'offline room type');
  let sequence = 0;
  async function fixture(startAt = null) {
    const owner = await account('maid');
    const roomId = randomUUID(); const targetId = randomUUID(); const assignmentId = randomUUID(); const attemptId = randomUUID();
    const now = startAt ? new Date(startAt) : new Date(); const day = new Date(now.getTime() + 9 * 3600000).toISOString().slice(0, 10);
    ok(await client.from('rooms').insert({ id: roomId, room_number: `${Date.now()}${++sequence}`, room_type_id: roomType.id, elevator_zone: 'A' }), 'offline room');
    ok(await client.from('cleaning_targets').insert({ id: targetId, room_id: roomId, cleaning_kind: 'additional', source: 'manual_room_request', source_key: `offline-expiry-${targetId}`, original_service_date: day, effective_service_date: day, available_from: `${day}T00:00:00+09:00`, due_at: `${day}T23:59:59+09:00`, status: 'notified', assignment_version: 2, room_type_snapshot: {}, template_snapshot: {}, fee_snapshot: 10000, created_by: admin.id }), 'offline target');
    ok(await client.from('cleaning_assignments').insert({ id: assignmentId, cleaning_target_id: targetId, maid_profile_id: owner.id, sequence_number: 1, revision: 2, notified_at: now.toISOString(), changed_by: admin.id }), 'offline assignment');
    ok(await client.from('cleaning_attempts').insert({ id: attemptId, cleaning_target_id: targetId, assignment_id: assignmentId, maid_profile_id: owner.id, attempt_number: 1, status: 'scheduled', assignment_revision: 2, room_snapshot: { roomId }, template_snapshot: {} }), 'offline attempt');
    const input = { p_actor_profile_id: owner.id, p_session_id: owner.sessionId, p_attempt_id: attemptId, p_expected_execution_version: 1, p_expected_assignment_id: assignmentId, p_expected_assignment_revision: 2, p_idempotency_key: randomUUID(), p_request_hash: 'd'.repeat(64) };
    const starts = startAt
      ? [{ data: JSON.parse(sql(`select private.start_attempt_with_lease_at('${owner.id}','${owner.sessionId}','${attemptId}',1,'${assignmentId}',2,'${input.p_idempotency_key}','${input.p_request_hash}','${now.toISOString()}');`)), error: null }]
      : await Promise.all([client.rpc('start_cleaning_attempt_with_lease', input), client.rpc('start_cleaning_attempt_with_lease', input)]);
    starts.forEach((result) => { ok(result, 'offline concurrent start'); });
    if (!startAt) assert(JSON.stringify(starts[0].data.lease) === JSON.stringify(starts[1].data.lease), 'start race must issue one lease with immutable expiry');
    assert(sql(`select count(*) from private.offline_work_leases where attempt_id='${attemptId}';`) === '1', 'exactly one lease per attempt');
    return { owner, attemptId, assignmentId, targetId, lease: starts[0].data.lease, day, startInput: input };
  }
  function event(item, overrides = {}) {
    return { p_actor_profile_id: item.owner.id, p_session_id: item.owner.sessionId, p_lease_id: item.lease.leaseId, p_event_id: randomUUID(), p_expected_execution_version: 2, p_occurred_at: new Date().toISOString(), p_server_offset_ms: 0, ...overrides };
  }
  function resolve(id, resolution = 'record_only', key = randomUUID()) {
    return client.rpc('resolve_offline_event_quarantine', { p_actor_profile_id: admin.id, p_session_id: admin.sessionId, p_quarantine_id: id, p_resolution: resolution, p_expected_execution_version: resolution === 'correction_link' ? 2 : null, p_reason_code: resolution === 'correction_link' ? 'OFFLINE_CORRECTION_APPROVED' : resolution === 'reject_effect' ? 'OFFLINE_REJECT_EFFECT' : 'OFFLINE_RECORD_ONLY', p_idempotency_key: key, p_request_hash: (resolution === 'correction_link' ? 'f' : 'e').repeat(64) });
  }

  // Backdate only the immutable test fixture's original online start. The calls
  // under test are PUBLIC RPCs with their real post-lock server clock.
  for (const [kind, purgeFirst] of [['ingest', true], ['ingest', false], ['resolve', true], ['resolve', false]]) {
    const item = await fixture(new Date(Date.now() - 90 * 86400000 + 6000).toISOString());
    const deadline = Date.parse(item.lease.metadataExpiresAt);
    const input = event(item, { p_occurred_at: new Date(Date.parse(item.lease.issuedAt) + 1000).toISOString() });
    const q = kind === 'resolve' ? ok(await client.rpc('sync_cleaning_attempt_event', input), 'expiry known-lease quarantine') : null;
    if (q) assert(q.outcome === 'quarantined', 'late-but-within-retention fixture is quarantined');
    assert(deadline > Date.now(), 'metadata lock fixture is live before request');
    const release = await holdLock(`select id from public.cleaning_targets where id='${item.targetId}' for update`);
    const rpcName = kind === 'ingest' ? 'sync_cleaning_attempt_event' : 'resolve_offline_event_quarantine';
    const pending = kind === 'ingest'
      ? Promise.resolve(client.rpc(rpcName, input))
      : Promise.resolve(resolve(q.quarantineId));
    try {
      await waitForLock(rpcName);
      assert(Date.now() < deadline, 'public request reaches real lock before retention expires');
      await new Promise((done) => setTimeout(done, Math.max(0, deadline - Date.now() + 150)));
      await release();
      const result = await pending;
      assert(result.error?.message === 'OFFLINE_EVENT_EXPIRED', 'post-lock clock blocks metadata ingest/resolution across 90-day boundary');
      assert(sql(`select status from public.cleaning_attempts where id='${item.attemptId}';`) === 'in_progress', 'retention expiry never completes or revives attempt');
      assert(sql(`select count(*) from private.offline_event_resolutions r join private.offline_completion_events e on e.id=r.event_record_id where e.lease_id='${item.lease.leaseId}';`) === '0', 'expired request leaves no resolution receipt');
    } finally { await release(); await pending; }

    // Both launch orders exercise the same real domain lock serialization.
    // No raw SQL clock seam is used for either competing public operation.
    {
      const contender = () => kind === 'ingest' ? client.rpc('sync_cleaning_attempt_event', input) : resolve(q.quarantineId);
      const purge = () => client.rpc('purge_expired_offline_metadata', { p_limit: 100 });
      const results = purgeFirst ? await Promise.all([purge(), contender()]) : (await Promise.all([contender(), purge()])).reverse();
      ok(results[0], 'metadata bounded purge race');
      const expected = kind === 'ingest' ? ['OFFLINE_EVENT_EXPIRED', 'OFFLINE_LEASE_UNKNOWN'] : ['OFFLINE_EVENT_EXPIRED', 'OFFLINE_QUARANTINE_NOT_FOUND'];
      assert(expected.includes(results[1].error?.message), 'purge versus expired ingest/resolution is stable fail-closed without FK/deadlock');
      assert(sql(`select count(*) from private.offline_work_leases where id='${item.lease.leaseId}';`) === '0', 'purge removes expired lease rather than leaving a permanent tombstone');
      assert(sql(`select count(*) from private.offline_completion_events where lease_id='${item.lease.leaseId}';`) === '0', 'purge race cannot reinsert old event UUID/clock/hash');
    }
    const restarted = await client.rpc('start_cleaning_attempt_with_lease', item.startInput);
    assert(restarted.error?.message === 'OFFLINE_LEASE_ISSUANCE_CLOSED', 'old successful start key cannot renew lease after purge');
    assert(sql(`select count(*) from public.audit_events where entity_id='${item.attemptId}' and event_type in ('cleaning.field_completed','cleaning.offline_event_resolved');`) === '0', 'expiry/purge races produce no fake physical completion or decision');
  }
  console.log('Offline expiry concurrency passed: public ingest/resolve cross 90-day lock wait, purge versus ingest/resolution both launch orders, no metadata resurrection or lease renewal.');
}
