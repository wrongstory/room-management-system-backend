import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { manualCancelId, runManualCleaningCancelConcurrency } from './test-manual-cleaning-cancel-concurrency.mjs';

// SOURCE CANDIDATE / actual SQL and races NOT RUN until the final DB run is approved.
// Reuses the manual-cancel fixture, process/lock barrier, and its existing cleanup
// reset. There is no additional reset, Docker entry point, provider call, or media.
export const roomReadyId = n => {
  assert(Number.isSafeInteger(n) && n >= 0 && n < 100000, 'Synthetic identity only');
  return `53210000-0000-4000-8000-${String(n).padStart(12, '0')}`;
};
const fixtureSource = () => readFileSync(new URL('../supabase/tests/photo_collection_upload_batch.sql', import.meta.url), 'utf8');
const caseNumber = n => assert(Number.isInteger(n) && n >= 1 && n <= 7, 'Unknown READY fixture');
const uuid = value => `'${value}'::uuid`;
const room = n => roomReadyId(1000 + n), target = n => roomReadyId(300 + n);
const assignment = n => roomReadyId(400 + n), attempt = n => roomReadyId(500 + n);
const slot = n => `(select id from private.target_photo_slot_snapshots where cleaning_target_id=${uuid(target(n))} and slot_key='cleaning-proof')`;

function between(source, begin, end) {
  assert.equal(source.split(begin).length, 2, 'Shared fixture start must be unique');
  const tail = source.split(begin)[1];
  assert.equal(tail.split(end).length, 2, 'Shared fixture end must be unique');
  return tail.split(end)[0];
}
export function roomReadyCorrectionFixture(input = fixtureSource()) {
  const source = input.replaceAll('\r\n', '\n');
  const ordinaryStart = 'create function pg_temp.ordinary_slots() returns jsonb language sql immutable as $$';
  assert.equal(source.split(ordinaryStart).length, 2, 'Shared legacy slot helper must be unique');
  const ordinary = ordinaryStart + source.split(ordinaryStart)[1].split('\n$$;')[0] + '\n$$;';
  const start = 'create function pg_temp.additional_fixture(n integer,legacy boolean) returns void';
  assert.equal(source.split(start).length, 2, 'Shared target fixture must be unique');
  let definition = start + source.split(start)[1].split('\n$$;')[0] + '\n$$;';
  const selection = "where room_type_id=(select id from public.room_types where code='standard')\n    order by room_number offset n limit 1;";
  assert.equal(definition.split(selection).length, 2, 'Shared target room selection drift');
  definition = definition.replace(selection, 'where id=pg_temp.cid(1000+n);');
  assert(definition.includes("'context-target-'||n"));
  definition = definition.replace("'context-target-'||n", "'ready-race-target-'||n");
  const helpers = between(source, '-- BEGIN PHOTO CONTEXT RPC HELPERS', '-- END PHOTO CONTEXT RPC HELPERS');
  assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(|session_replication_role|disable\s+trigger/i.test(ordinary + definition + helpers));
  assert(helpers.includes('public.finalize_admitted_photo_upload') && helpers.includes('CONTEXT_CHAIN_NOT_ACCEPTED'));
  // Historical flat snapshot fixture from the photo suite. Retired metadata
  // avoids changing the already published templates owned by the manual suite.
  return `begin;
create function pg_temp.cid(n integer) returns uuid language sql immutable as $$
 select case n when 1 then '${manualCancelId(1)}'::uuid when 2 then '${manualCancelId(2)}'::uuid
 when 902 then '${manualCancelId(202)}'::uuid
 else ('53210000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid end $$;
insert into public.rooms(id,room_number,room_type_id,elevator_zone,data_status)
 select pg_temp.cid(1000+n),(9550+n)::text,rt.id,'A','verified'
 from public.room_types rt cross join generate_series(1,7) n where rt.code='standard' and rt.active;
insert into public.cleaning_template_versions(id,room_type_id,cleaning_kind,version,status,duration_minutes,photo_slots,created_by)
 select pg_temp.cid(200),id,'additional',9,'retired',1,private.flat_cleaning_photo_slots(),pg_temp.cid(1)
 from public.room_types where code='standard';
create temp table context_fixture(n integer primary key,target_id uuid,assignment_id uuid,attempt_id uuid);
-- Both CASE branches must resolve during planning, even though legacy is false.
${ordinary}
${definition}
select pg_temp.additional_fixture(n,false) from generate_series(1,7) n;
${helpers}
-- Existing metadata-only photo fixture models provider acknowledgement. No Drive request occurs.
select pg_temp.finish_upload(n,20+n,pg_temp.open_upload(n,20+n,'cleaning-proof',n,0)) from generate_series(1,7) n;
commit;`;
}

export function roomReadyApplySql(n, preview, key, hash = 'a'.repeat(64)) {
  caseNumber(n);
  assert(preview && preview.roomId === room(n) && preview.canApply === true, 'Applicable exact synthetic room preview required');
  assert(Number.isSafeInteger(preview.roomStateVersion) && preview.roomStateVersion > 0, 'Exact room CAS required');
  assert(typeof preview.impactFingerprint === 'string' && /^[a-f0-9]{64}$/.test(preview.impactFingerprint), 'Exact impact fingerprint required');
  for (const field of ['evaluatedAt', 'expiresAt']) {
    assert(typeof preview[field] === 'string'
      && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:\d\d)$/.test(preview[field])
      && Number.isFinite(Date.parse(preview[field])), 'Exact preview clock required');
  }
  assert(typeof key === 'string' && /^ready-race-[a-z0-9-]{1,48}$/.test(key), 'Synthetic receipt key required');
  assert(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'Exact request hash required');
  return `select public.apply_room_ready_correction('${manualCancelId(1)}','${manualCancelId(201)}',${uuid(room(n))},
 ${preview.roomStateVersion},'${preview.impactFingerprint}','${preview.evaluatedAt}'::timestamptz,'${preview.expiresAt}'::timestamptz,
 true,true,false,'ADMIN_ROOM_READY_CORRECTION','${key}','${hash}');`;
}

export const roomReadyProtectedRelations = Object.freeze([
  'public.earnings', 'public.inspection_decisions', 'public.audit_events', 'private.command_executions'
]);
export function assertRoomReadyProtectedRows(before, after) {
  for (const value of [before, after]) {
    assert(value && typeof value === 'object' && !Array.isArray(value), 'Protected ledger map required');
    assert.deepEqual(Object.keys(value).sort(), [...roomReadyProtectedRelations].sort(), 'Exact protected ledger set required');
    for (const relation of roomReadyProtectedRelations) {
      assert(Array.isArray(value[relation]) && value[relation].every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)), 'Ledger row hashes required');
    }
  }
  for (const relation of roomReadyProtectedRelations) {
    const remaining = new Map();
    for (const hash of after[relation]) remaining.set(hash, (remaining.get(hash) ?? 0) + 1);
    for (const hash of before[relation]) {
      assert((remaining.get(hash) ?? 0) > 0, 'Existing immutable ledger row changed or disappeared');
      remaining.set(hash, remaining.get(hash) - 1);
    }
  }
}
const rowsDigest = (relation, where = 'true') => `(select coalesce(jsonb_agg(encode(extensions.digest(convert_to(to_jsonb(r)::text,'UTF8'),'sha256'),'hex')
 order by to_jsonb(r)::text),'[]'::jsonb) from ${relation} r where ${where})`;
const snapshotSql = relations => `select jsonb_build_object(${relations.map(relation => `'${relation}',${rowsDigest(relation)}`).join(',')});`;
const photoRelations = ['private.attempt_photo_versions', 'private.attempt_photo_collection_items',
  'private.attempt_photo_collection_states', 'private.attempt_photo_collection_changes', 'private.photo_provider_objects',
  'private.photo_upload_acceptances', 'private.submission_photo_bindings', 'private.submission_photo_binding_sets'];
const submissionSql = n => `select public.create_cleaning_submission('${manualCancelId(2)}',${uuid(attempt(n))},${uuid(roomReadyId(600+n))},
 0,0,'ready-race-submit-${n}',repeat('b',64));`;
const approveSql = n => `select public.approve_cleaning_submission('${manualCancelId(1)}',
 (select id from public.cleaning_submissions where cleaning_attempt_id=${uuid(attempt(n))}),
 'QUALITY_OK','ready-race-approve-${n}',repeat('c',64));`;
const admitSql = n => `select public.admit_photo_collection_upload('${manualCancelId(2)}','${manualCancelId(202)}',
 ${uuid(attempt(n))},${uuid(assignment(n))},2,${slot(n)},${uuid(roomReadyId(11000+n))},1,0,lpad('${n}',64,'0'));`;

export async function testRoomReadyCorrectionConcurrency({ sql, race }) {
  assert.equal(sql(`select count(*) from public.profiles where id in ('${manualCancelId(1)}','${manualCancelId(2)}') and status='active';`), '2', 'Shared synthetic actors required');
  sql(roomReadyCorrectionFixture());
  for (const n of [3,4,7]) sql(submissionSql(n));
  sql(approveSql(7)); // A real synthetic approval creates protected, already confirmed earnings.
  const state = n => JSON.parse(sql(`select jsonb_build_object('target',t.status,'current',a.is_current,'version',r.state_version,
 'audits',(select count(*) from public.audit_events where event_type='room.ready_corrected' and entity_id=r.id),
 'receipts',(select count(*) from private.command_executions where command_type='room.ready_correction' and entity_id=r.id),
 'earnings',(select count(*) from public.earnings e join public.cleaning_submissions s on s.id=e.submission_id where s.cleaning_attempt_id=${uuid(attempt(n))}))
 from public.rooms r join public.cleaning_targets t on t.room_id=r.id join public.cleaning_assignments a on a.id=${uuid(assignment(n))}
 where r.id=${uuid(room(n))} and t.id=${uuid(target(n))};`));
  assert.equal(state(7).earnings, 1, 'Confirmed earning baseline must be nonempty');
  const preview = n => JSON.parse(sql(`select public.preview_room_ready_correction('${manualCancelId(1)}','${manualCancelId(201)}',${uuid(room(n))});`));
  const photosBefore = sql(snapshotSql(photoRelations));
  let ledgersBefore = JSON.parse(sql(snapshotSql(roomReadyProtectedRelations)));
  const physicalBefore = sql(`select ${rowsDigest('public.cleaning_attempts', `r.id in (${[1,2,4,5,6].map(n => uuid(attempt(n))).join(',')})`)};`);
  const submissionBefore = sql(`select ${rowsDigest('public.cleaning_submissions', `r.cleaning_attempt_id=${uuid(attempt(4))}`)};`);
  const preserved = () => {
    assert.equal(sql(snapshotSql(photoRelations)), photosBefore, 'Existing photos/provider metadata/sealed bindings must remain exact');
    const next = JSON.parse(sql(snapshotSql(roomReadyProtectedRelations)));
    assertRoomReadyProtectedRows(ledgersBefore, next); ledgersBefore = next;
  };
  const corrected = (n, original) => {
    const value = state(n);
    assert.deepEqual(value, { target: 'cancelled', current: false, version: original.roomStateVersion+1, audits: 1, receipts: 1, earnings: 0 });
    preserved();
  };
  const denied = (value, code) => { assert.notEqual(value.exitCode, 0, 'The losing command must fail'); assert.equal(value.code, code); };

  const samePreview = preview(1), same = roomReadyApplySql(1,samePreview,'ready-race-same-key');
  const sameResult = await race(same,same,'ready_same_key');
  assert(sameResult.every(result => result.exitCode === 0), 'Concurrent same-key requests must both succeed');
  assert.deepEqual(JSON.parse(sameResult[0].output), JSON.parse(sameResult[1].output), 'Concurrent replay returns the same durable receipt');
  corrected(1,samePreview);

  const casPreview = preview(2);
  const cas = await race(roomReadyApplySql(2,casPreview,'ready-race-cas-first'),roomReadyApplySql(2,casPreview,'ready-race-cas-second'),'ready_room_cas');
  assert.equal(cas[0].exitCode,0); denied(cas[1],'ROOM_READY_PREVIEW_STALE'); corrected(2,casPreview);

  const approvalPreview = preview(3);
  const approved = await race(approveSql(3),roomReadyApplySql(3,approvalPreview,'ready-race-after-approval'),'ready_approval_first');
  assert.equal(approved[0].exitCode,0); denied(approved[1],'ROOM_READY_PREVIEW_STALE');
  assert.equal(state(3).target,'approved'); assert.equal(state(3).earnings,1);
  assert.equal(state(3).audits,0); assert.equal(state(3).receipts,0); preserved();

  const cancellationPreview = preview(4);
  const approvalLost = await race(roomReadyApplySql(4,cancellationPreview,'ready-race-before-approval'),approveSql(4),'ready_correction_first');
  assert.equal(approvalLost[0].exitCode,0); denied(approvalLost[1],'INSPECTION_INVALID_TRANSITION'); corrected(4,cancellationPreview);
  assert.equal(sql(`select ${rowsDigest('public.cleaning_submissions', `r.cleaning_attempt_id=${uuid(attempt(4))}`)};`),submissionBefore,
    'Cancellation ends authority without changing the existing submission or manufacturing an inspection');

  const uploadPreview = preview(5);
  const uploading = await race(admitSql(5),roomReadyApplySql(5,uploadPreview,'ready-race-after-upload'),'ready_upload_first');
  assert.equal(uploading[0].exitCode,0); denied(uploading[1],'ROOM_READY_PREVIEW_STALE');
  const blocked = preview(5);
  assert.equal(blocked.canApply,false); assert(blocked.blockingReasons.includes('PHOTO_UPLOAD_IN_PROGRESS'));
  assert.equal(state(5).target,'notified'); assert.equal(state(5).current,true);
  assert.equal(state(5).audits,0); assert.equal(state(5).receipts,0); preserved();

  const beforeUpload = preview(6);
  const uploadLost = await race(roomReadyApplySql(6,beforeUpload,'ready-race-before-upload'),admitSql(6),'ready_upload_after');
  assert.equal(uploadLost[0].exitCode,0); denied(uploadLost[1],'PHOTO_ACCESS_REQUIRED'); corrected(6,beforeUpload);
  assert.equal(sql(`select count(*) from private.photo_upload_admissions where collection_item_id=${uuid(roomReadyId(11006))};`),'0', 'Losing photo request leaves no new upload authority');
  assert.equal(sql(`select ${rowsDigest('public.cleaning_attempts', `r.id in (${[1,2,4,5,6].map(n => uuid(attempt(n))).join(',')})`)};`),physicalBefore,
    'Finished/submitted physical work records remain exact');
  assert.equal(state(7).earnings,1); preserved();
  console.log('Room READY correction concurrency: PASS; six observed lock orderings, receipts, photos and prior earnings preserved.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runManualCleaningCancelConcurrency(testRoomReadyCorrectionConcurrency);
}
