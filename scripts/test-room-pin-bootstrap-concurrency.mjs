import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createClient } from '@supabase/supabase-js';

const execFileAsync = promisify(execFile);
const container = 'supabase_db_room-management-system-backend';
const psqlArgs = [
  'exec', '-i', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  '-U', 'postgres', '-d', 'postgres', '-c',
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function ok(result, message) {
  if (result.error) throw new Error(`${message}: ${result.error.message}`);
  return result.data;
}

function literal(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function sqlSession(command) {
  try {
    const { stdout } = await execFileAsync('docker', [...psqlArgs, command], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { value: stdout.trim(), code: null };
  } catch (error) {
    const stderr = `${error.stderr ?? ''}`;
    const code = /ERROR:\s+([A-Z][A-Z0-9_]+)/.exec(stderr)?.[1] ??
      (stderr.includes('deadlock detected') ? 'DEADLOCK_DETECTED' : null) ??
      (stderr.includes('duplicate key value') ? 'UNIQUE_VIOLATION' : null) ??
      (error.killed || error.signal ? 'SESSION_TIMEOUT' : null) ??
      'REDACTED_DB_ERROR';
    return { value: '', code };
  }
}

function envelope(overrides = {}) {
  return {
    ciphertext: randomBytes(32).toString('base64'),
    nonce: randomBytes(12).toString('base64'),
    tag: randomBytes(16).toString('base64'),
    keyVersion: 'bootstrap-concurrency-v1',
    ...overrides,
  };
}

function candidate(item, material) {
  return {
    roomId: item.id,
    roomNumber: item.roomNumber,
    envelopeFormat: 1,
    ciphertextBase64: material.ciphertext,
    nonceBase64: material.nonce,
    authTagBase64: material.tag,
    keyVersion: material.keyVersion,
    aadEnvironment: 'test',
    aadProjectRef: 'local',
  };
}

function bootstrapSql(actor, candidates, key, hash) {
  return `select public.bootstrap_room_pins(
    ${literal(actor.profileId)}::uuid,
    ${literal(actor.sessionId)}::uuid,
    ${literal(JSON.stringify(candidates))}::jsonb,
    ${literal(key)},
    ${literal(hash)}
  )::text`;
}

function prepareSql(actor, item, material, key, hash) {
  return `select public.prepare_room_pin_change(
    ${literal(actor.profileId)}::uuid,
    ${literal(actor.sessionId)}::uuid,
    ${literal(item.id)}::uuid,
    0::bigint,
    ${literal(item.roomNumber)},
    null,null,null,
    'ADMIN_INITIAL_PIN',1::smallint,
    ${literal(material.ciphertext)},
    ${literal(material.nonce)},
    ${literal(material.tag)},
    ${literal(material.keyVersion)},
    'test','local',
    ${literal(key)},
    ${literal(hash)}
  )::text`;
}

function confirmSql(actor, item, leaseId, key, hash) {
  return `select public.confirm_room_pin_change(
    ${literal(actor.profileId)}::uuid,
    ${literal(actor.sessionId)}::uuid,
    ${literal(item.id)}::uuid,
    ${literal(leaseId)}::uuid,
    0::bigint,
    ${literal(key)},
    ${literal(hash)}
  )::text`;
}

async function roomLedger(item) {
  const result = await sqlSession(`select jsonb_build_object(
    'revisions',(select count(*) from private.room_pin_revisions where room_id=${literal(item.id)}::uuid),
    'current',(select count(*) from private.room_current_pin where room_id=${literal(item.id)}::uuid),
    'verified',(select count(*) from public.room_pin_sync_events where room_id=${literal(item.id)}::uuid and sync_status='verified'),
    'mismatch',(select count(*) from public.room_pin_sync_events where room_id=${literal(item.id)}::uuid and sync_status='mismatch'),
    'outbox',(select count(*) from private.room_pin_sheet_sync_outbox where room_id=${literal(item.id)}::uuid),
    'audit',(select count(*) from public.audit_events where entity_id=${literal(item.id)}::uuid and event_type='room.pin_change_confirmed'),
    'generatedAudit',(select count(*) from public.audit_events where entity_id=${literal(item.id)}::uuid and event_type='room.pin_generated'),
    'unresolved',(select count(*) from private.room_pin_change_leases where room_id=${literal(item.id)}::uuid and status in ('prepared','expired'))
  )::text`);
  assert(!result.code, 'room PIN ledger query succeeds');
  return JSON.parse(result.value);
}

async function receiptCount(profileId, commandType, keys) {
  const keyList = keys.map(literal).join(',');
  const result = await sqlSession(`select count(*) from private.command_executions
    where actor_profile_id=${literal(profileId)}::uuid
      and command_type=${literal(commandType)}
      and idempotency_key in (${keyList})`);
  assert(!result.code, 'room PIN receipt query succeeds');
  return Number(result.value);
}

// Every sqlSession invocation starts a separate psql process/connection. These
// races therefore exercise actual independent PostgreSQL sessions rather than
// sequential calls in one transaction or one client-side mock.
export async function testRoomPinBootstrapConcurrency(client) {
  assert(
    ['localhost', '127.0.0.1'].includes(new URL(client.supabaseUrl).hostname),
    'room PIN bootstrap concurrency is local only',
  );

  const authUserId = randomUUID();
  const profileId = randomUUID();
  const email = `pin-bootstrap-race-${authUserId}@test.invalid`;
  const password = `T:${randomUUID()}`;
  ok(await client.auth.admin.createUser({ id: authUserId, email, password, email_confirm: true }), 'bootstrap race Auth fixture');
  ok(await client.from('profiles').insert({
    id: profileId,
    auth_user_id: authUserId,
    display_name: `bootstrap-race-${profileId.slice(0, 8)}`,
    display_name_normalized: `bootstrap-race-${profileId.slice(0, 8)}`,
    login_id: `bootstrap-race-${authUserId}`,
    login_id_normalized: `bootstrap-race-${authUserId}`,
    login_sequence: 0,
    role: 'admin',
    status: 'active',
    must_change_password: false,
  }), 'bootstrap race profile fixture');
  const loginClient = createClient(client.supabaseUrl, client.supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const signedIn = ok(await loginClient.auth.signInWithPassword({ email, password }), 'bootstrap race sign-in');
  const sessionId = JSON.parse(Buffer.from(signedIn.session.access_token.split('.')[1], 'base64url').toString()).session_id;
  const actor = { profileId, sessionId };

  const roomType = ok(await client.from('room_types').select('id').limit(1).single(), 'bootstrap race room type');
  let roomSequence = 0;
  async function createRoom() {
    roomSequence += 1;
    const item = { id: randomUUID(), roomNumber: `${Date.now()}${roomSequence}` };
    const inserted = await sqlSession(`begin; set local app.room_catalog_command='v1';
      insert into public.rooms(id,room_number,room_type_id,elevator_zone)
      values(${literal(item.id)},${literal(item.roomNumber)},${literal(roomType.id)},'A');
      commit;`);
    assert(inserted.code === null, 'bootstrap race room fixture');
    return item;
  }

  // Same-key concurrent retry: both sessions return the first committed safe
  // response, and a later response-loss replay ignores a changed candidate set.
  const sameKeyRoom = await createRoom();
  const replayCandidateRoom = await createRoom();
  const sameMaterial = envelope();
  const sameKey = `bootstrap-same-${randomUUID()}`;
  const sameHash = randomBytes(32).toString('hex');
  const sameSql = bootstrapSql(actor, [candidate(sameKeyRoom, sameMaterial)], sameKey, sameHash);
  const sameRace = await Promise.all([sqlSession(sameSql), sqlSession(sameSql)]);
  assert(sameRace.every((result) => !result.code), 'same-key bootstrap sessions both succeed');
  assert(new Set(sameRace.map((result) => result.value)).size === 1, 'same-key sessions replay one response');
  const changedReplay = await sqlSession(bootstrapSql(
    actor,
    [candidate(replayCandidateRoom, envelope())],
    sameKey,
    sameHash,
  ));
  assert(!changedReplay.code && changedReplay.value === sameRace[0].value, 'response-loss replay returns the first receipt after candidates change');
  const sameLedger = await roomLedger(sameKeyRoom);
  assert(
    sameLedger.revisions === 1 && sameLedger.current === 1 && sameLedger.mismatch === 1 &&
      sameLedger.verified === 0 && sameLedger.outbox === 0 && sameLedger.generatedAudit === 1,
    'same-key bootstrap creates each room ledger exactly once',
  );
  assert((await roomLedger(replayCandidateRoom)).revisions === 0, 'receipt replay does not initialize a newly supplied candidate');
  assert(
    await receiptCount(profileId, 'room.pin.bootstrap', [sameKey]) === 1,
    'same-key bootstrap stores one completed receipt',
  );

  // Different keys racing for the same room both finish, but only one creates
  // the immutable room ledger; the loser reports that current PIN was skipped.
  const differentKeyRoom = await createRoom();
  const differentCandidate = candidate(differentKeyRoom, envelope());
  const differentHash = randomBytes(32).toString('hex');
  const differentKeys = [`bootstrap-a-${randomUUID()}`, `bootstrap-b-${randomUUID()}`];
  const differentRace = await Promise.all(differentKeys.map((key) => sqlSession(
    bootstrapSql(actor, [differentCandidate], key, differentHash),
  )));
  assert(differentRace.every((result) => !result.code), 'different-key same-room bootstrap sessions finish without deadlock');
  const differentResults = differentRace.map((result) => JSON.parse(result.value));
  assert(
    differentResults.filter((result) => result.initialized_count === 1).length === 1 &&
      differentResults.filter((result) => result.skipped_count === 1).length === 1,
    'different-key same-room bootstrap has one initializer and one explicit skip',
  );
  const differentLedger = await roomLedger(differentKeyRoom);
  assert(
    differentLedger.revisions === 1 && differentLedger.current === 1 && differentLedger.mismatch === 1 &&
      differentLedger.verified === 0 && differentLedger.outbox === 0 && differentLedger.generatedAudit === 1,
    'different-key bootstrap still creates one room ledger',
  );
  assert(
    await receiptCount(profileId, 'room.pin.bootstrap', differentKeys) === 2,
    'different-key winner and explicit skip each store exactly one completed receipt',
  );

  // bootstrap versus prepare on one room preserves whichever valid state wins:
  // either an unverified generated current PIN or one unresolved physical-change lease.
  const prepareRaceRoom = await createRoom();
  const bootstrapMaterial = envelope();
  const prepareMaterial = envelope();
  const bootstrapPrepareKey = `bootstrap-prepare-${randomUUID()}`;
  const prepareBootstrapKey = `prepare-bootstrap-${randomUUID()}`;
  const bootstrapPrepareRace = await Promise.all([
    sqlSession(bootstrapSql(actor, [candidate(prepareRaceRoom, bootstrapMaterial)], bootstrapPrepareKey, randomBytes(32).toString('hex'))),
    sqlSession(prepareSql(actor, prepareRaceRoom, prepareMaterial, prepareBootstrapKey, randomBytes(32).toString('hex'))),
  ]);
  assert(
    bootstrapPrepareRace.filter((result) => !result.code).length >= 1 &&
      bootstrapPrepareRace.every((result) => !result.code || result.code === 'STALE_PIN_VERSION'),
    `bootstrap versus prepare has only a committed result or stable stale loser: ${bootstrapPrepareRace.map((result) => result.code ?? 'OK').join(',')}`,
  );
  const prepareRaceLedger = await roomLedger(prepareRaceRoom);
  assert(
    (prepareRaceLedger.revisions === 1 && prepareRaceLedger.current === 1 &&
      prepareRaceLedger.mismatch === 1 && prepareRaceLedger.verified === 0 &&
      prepareRaceLedger.outbox === 0 && prepareRaceLedger.generatedAudit === 1 &&
      prepareRaceLedger.unresolved === 0) ||
      (prepareRaceLedger.revisions === 0 && prepareRaceLedger.current === 0 &&
        prepareRaceLedger.mismatch === 1 && prepareRaceLedger.verified === 0 &&
        prepareRaceLedger.outbox === 0 && prepareRaceLedger.generatedAudit === 0 &&
        prepareRaceLedger.unresolved === 1),
    `bootstrap versus prepare preserves one generated ledger or one unresolved physical change: ${JSON.stringify(prepareRaceLedger)}`,
  );
  assert(
    await receiptCount(profileId, 'room.pin.bootstrap', [bootstrapPrepareKey]) === 1,
    'bootstrap versus prepare stores exactly one completed bootstrap receipt',
  );

  // A prepared envelope owns its nonce before confirm. Concurrent confirm may
  // link that same logical encryption, while bootstrap of another room with a
  // different encryption under the nonce must fail closed.
  const confirmRoom = await createRoom();
  const collidingBootstrapRoom = await createRoom();
  const confirmedMaterial = envelope();
  const prepared = await sqlSession(prepareSql(
    actor,
    confirmRoom,
    confirmedMaterial,
    `confirm-race-prepare-${randomUUID()}`,
    randomBytes(32).toString('hex'),
  ));
  assert(!prepared.code, 'bootstrap-confirm race prepare succeeds');
  const leaseId = JSON.parse(prepared.value).lease_id;
  const conflictingMaterial = envelope({ nonce: confirmedMaterial.nonce, keyVersion: confirmedMaterial.keyVersion });
  const confirmKey = `confirm-race-${randomUUID()}`;
  const bootstrapConfirmKey = `bootstrap-confirm-${randomUUID()}`;
  const bootstrapConfirmRace = await Promise.all([
    sqlSession(confirmSql(actor, confirmRoom, leaseId, confirmKey, randomBytes(32).toString('hex'))),
    sqlSession(bootstrapSql(actor, [candidate(collidingBootstrapRoom, conflictingMaterial)], bootstrapConfirmKey, randomBytes(32).toString('hex'))),
  ]);
  assert(!bootstrapConfirmRace[0].code, 'confirm reuses its existing nonce reservation');
  assert(bootstrapConfirmRace[1].code === 'ROOM_PIN_NONCE_REUSE', 'cross-room bootstrap collision fails closed during concurrent confirm');
  const confirmLedger = await roomLedger(confirmRoom);
  assert(
    confirmLedger.revisions === 1 && confirmLedger.current === 1 && confirmLedger.verified === 1 &&
      confirmLedger.outbox === 1 && confirmLedger.audit === 1,
    'confirm commits one complete room ledger',
  );
  assert((await roomLedger(collidingBootstrapRoom)).revisions === 0, 'failed colliding bootstrap leaves no room ledger');
  assert(
    await receiptCount(profileId, 'room.pin_change.confirm', [confirmKey]) === 1 &&
      await receiptCount(profileId, 'room.pin.bootstrap', [bootstrapConfirmKey]) === 0,
    'confirm stores one receipt while colliding bootstrap stores none',
  );

  // Two bootstrap commands for distinct rooms force the same nonce with
  // different encryption identities. The registry admits exactly one.
  const collisionRoomA = await createRoom();
  const collisionRoomB = await createRoom();
  const sharedNonce = randomBytes(12).toString('base64');
  const collisionKeys = [
    `bootstrap-collision-a-${randomUUID()}`,
    `bootstrap-collision-b-${randomUUID()}`,
  ];
  const collisionRace = await Promise.all([
    sqlSession(bootstrapSql(actor, [candidate(collisionRoomA, envelope({ nonce: sharedNonce }))], collisionKeys[0], randomBytes(32).toString('hex'))),
    sqlSession(bootstrapSql(actor, [candidate(collisionRoomB, envelope({ nonce: sharedNonce }))], collisionKeys[1], randomBytes(32).toString('hex'))),
  ]);
  assert(
    collisionRace.filter((result) => !result.code).length === 1 &&
      collisionRace.filter((result) => result.code === 'ROOM_PIN_NONCE_REUSE').length === 1,
    'parallel bootstrap nonce collision has one winner and one stable loser',
  );
  const collisionLedgers = await Promise.all([roomLedger(collisionRoomA), roomLedger(collisionRoomB)]);
  assert(
    collisionLedgers.reduce((sum, ledger) => sum + ledger.revisions, 0) === 1 &&
      collisionLedgers.reduce((sum, ledger) => sum + ledger.current, 0) === 1 &&
      collisionLedgers.reduce((sum, ledger) => sum + ledger.mismatch, 0) === 1 &&
      collisionLedgers.reduce((sum, ledger) => sum + ledger.verified, 0) === 0 &&
      collisionLedgers.reduce((sum, ledger) => sum + ledger.outbox, 0) === 0 &&
      collisionLedgers.reduce((sum, ledger) => sum + ledger.generatedAudit, 0) === 1,
    'parallel bootstrap collision creates one complete room ledger and no partial loser state',
  );
  assert(
    await receiptCount(profileId, 'room.pin.bootstrap', collisionKeys) === 1,
    'parallel bootstrap collision stores only the winner receipt',
  );

  console.log('Room PIN bootstrap concurrency passed: independent DB sessions covered same/different keys, prepare/confirm races, response-loss replay, and forced nonce collisions.');
}
