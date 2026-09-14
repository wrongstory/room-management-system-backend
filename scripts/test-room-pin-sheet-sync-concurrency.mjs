import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const sql = value => execFileSync('docker', [
  'exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-A', '-t', '-q',
  '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', value,
], { encoding: 'utf8', timeout: 15_000 }).trim();
async function sqlAsync(value) {
  try {
    const { stdout } = await execFileAsync('docker', [
      'exec', '-i', 'supabase_db_room-management-system-backend', 'psql', '-X', '-A', '-t', '-q',
      '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', value,
    ], { encoding: 'utf8', timeout: 15_000 });
    return { value: stdout.trim(), error: '' };
  } catch (error) { return { value: '', error: `${error.stderr ?? error.message}` }; }
}

export async function testRoomPinSheetSyncConcurrency() {
  const roomId = sql('select id from public.rooms order by room_number,id limit 1');
  const pinVersion = Number(sql(`select coalesce(max(pin_version),0)+1 from private.room_pin_revisions where room_id='${roomId}'::uuid`));
  assert(Number.isSafeInteger(pinVersion) && pinVersion > 0, 'next local PIN revision is bounded');
  const revisionId = randomUUID(), outboxId = randomUUID(), claimA = randomUUID(), claimB = randomUUID();
  const actorUserId = randomUUID(), actorProfileId = randomUUID();
  sql(`begin;
    insert into auth.users(id) values('${actorUserId}'::uuid);
    insert into public.profiles(id,auth_user_id,display_name,display_name_normalized,login_id,login_id_normalized,
      login_sequence,role,status,must_change_password)
    values('${actorProfileId}'::uuid,'${actorUserId}'::uuid,'sheet-sync-race-${actorProfileId}','sheet-sync-race-${actorProfileId}',
      'sheet-sync-race-${actorProfileId}','sheet-sync-race-${actorProfileId}',0,'admin','active',false);
    update private.room_pin_sheet_sync_outbox set status='superseded',completed_at=clock_timestamp(),claim_id=null,
      claimed_at=null,claim_expires_at=null,lease_fence=null,provider_write_started_at=null where status in ('pending','failed','processing');
    update private.room_pin_sheet_sync_worker_state set status='idle',claim_id=null,lease_expires_at=null,blocked_reason_code=null where singleton=true;
    insert into private.room_pin_revisions(id,room_id,pin_version,envelope_format,ciphertext,nonce,auth_tag,key_version,
      aad_environment,aad_project_ref,recorded_by,recorded_by_role,source)
    values('${revisionId}'::uuid,'${roomId}'::uuid,${pinVersion},1,digest('sheet-race-cipher-${revisionId}','sha256'),substring(digest('sheet-race-nonce-${revisionId}','sha256') for 12),
      substring(digest('sheet-race-tag','sha256') for 16),'test-fixture','test','local','${actorProfileId}'::uuid,'admin','admin_initial_entry');
    insert into private.room_current_pin(room_id,pin_revision_id,pin_version) values('${roomId}'::uuid,'${revisionId}'::uuid,${pinVersion})
      on conflict(room_id) do update set pin_revision_id=excluded.pin_revision_id,pin_version=excluded.pin_version,updated_at=clock_timestamp();
    insert into private.room_pin_sheet_sync_outbox(id,room_id,pin_version,sync_status,reason_code)
      values('${outboxId}'::uuid,'${roomId}'::uuid,${pinVersion},'verified','PIN_CHANGE_CONFIRMED');
    commit;`);
  const race = await Promise.all([
    sqlAsync(`select public.claim_room_pin_sheet_sync('${claimA}'::uuid,10,'test','local')::text`),
    sqlAsync(`select public.claim_room_pin_sheet_sync('${claimB}'::uuid,10,'test','local')::text`),
  ]);
  assert(race.every(result => !/40P01|deadlock detected/i.test(result.error)), 'parallel singleton claim has no deadlock');
  assert(race.every(result => !result.error), `parallel singleton claim has no generic failure: ${JSON.stringify(race)}`);
  const parsed = race.map(result => JSON.parse(result.value));
  const winners = parsed.map((value, index) => ({ value, claim: index === 0 ? claimA : claimB })).filter(result => result.value.items.some(item => item.outboxId === outboxId));
  assert(winners.length === 1, `global singleton has exactly one projection winner: ${JSON.stringify(parsed)}`);
  assert(parsed.filter(value => value.status === 'busy').length === 1, 'the other concurrent claim is bounded busy');
  const winner = winners[0]; assert(winner, 'singleton winner exists'); const fence = winner.value.leaseFence;
  const stale = await sqlAsync(`select public.authorize_room_pin_sheet_write('${outboxId}'::uuid,'${winner.claim === claimA ? claimB : claimA}'::uuid,${fence},${pinVersion})::text`);
  assert(/ROOM_PIN_SHEET_LEASE_LOST/.test(stale.error), 'loser claim cannot authorize provider write');
  const authorized = await sqlAsync(`select public.authorize_room_pin_sheet_write('${outboxId}'::uuid,'${winner.claim}'::uuid,${fence},${pinVersion})::text`);
  assert(!authorized.error && JSON.parse(authorized.value).status === 'authorized', 'winner obtains one fenced provider permit');
  const settled = await sqlAsync(`select public.settle_room_pin_sheet_sync('${outboxId}'::uuid,'${winner.claim}'::uuid,${fence},${pinVersion},'succeeded',null)::text`);
  assert(!settled.error && JSON.parse(settled.value).status === 'succeeded', 'winner settles exact current version');
  assert(sql(`select count(*) from private.room_pin_sheet_sync_outbox where id='${outboxId}'::uuid and status='succeeded'`) === '1', 'concurrent path converges to one terminal outbox');
  console.log('Room PIN Sheet concurrency passed: 1 singleton winner, 1 busy loser, stale fence blocked, 40P01/generic errors=0.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await testRoomPinSheetSyncConcurrency();
