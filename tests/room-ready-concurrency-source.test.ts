import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { assertRoomReadyProtectedRows, roomReadyApplySql, roomReadyCorrectionFixture, roomReadyId,
  roomReadyProtectedRelations } from '../scripts/test-room-ready-correction-concurrency.mjs';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => { throw new Error('DB execution is forbidden in this source test'); }),
  spawn: vi.fn(() => { throw new Error('Child execution is forbidden in this source test'); })
}));
const read = (path: string) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const script = read('scripts/test-room-ready-correction-concurrency.mjs');
const manual = read('scripts/test-manual-cleaning-cancel-concurrency.mjs');
const photoFixture = read('supabase/tests/photo_collection_upload_batch.sql');
const require = createRequire(import.meta.url);
const preview = () => ({ roomId: roomReadyId(1001), canApply: true, roomStateVersion: 3,
  impactFingerprint: 'a'.repeat(64), evaluatedAt: '2026-10-30T12:00:00.123456+00:00',
  expiresAt: '2026-10-30T12:05:00.123456+00:00' });
const ledger = (hashes: string[] = ['a'.repeat(64)]) => Object.fromEntries(
  roomReadyProtectedRelations.map(relation => [relation, [...hashes]]));

describe('#532 READY race preparation (actual SQL/concurrency NOT RUN)', () => {
  it('imports and constructs the shared fixture without CLI/Docker/process calls', () => {
    expect(roomReadyCorrectionFixture()).toContain('public.finalize_admitted_photo_upload');
    expect(execFileSync).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });
  it.each([15,17])('parses the complete prepared fixture with PostgreSQL %i grammar only', async version => {
    const parser = require(`@pgsql/parser/v${version}`) as { parse(sql: string): Promise<{ stmts: unknown[] }> };
    const fixture = roomReadyCorrectionFixture(photoFixture);
    expect((await parser.parse(fixture)).stmts.length).toBeGreaterThan(8);
    expect(fixture).toContain('where id=pg_temp.cid(1000+n)');
    expect(fixture).toContain("9,'retired'");
    expect(fixture).not.toMatch(/session_replication_role|disable\s+trigger|truncate|\bdelete\s+from|\\ir/i);
    const defined = new Set([...fixture.matchAll(/create function pg_temp\.([a-z_]+)\(/g)].map(match => match[1]));
    const referenced = new Set([...fixture.matchAll(/pg_temp\.([a-z_]+)\(/g)].map(match => match[1]));
    expect([...referenced].filter(name => !defined.has(name))).toEqual([]);
    expect(fixture.indexOf('create function pg_temp.ordinary_slots')).toBeLessThan(fixture.indexOf('create function pg_temp.additional_fixture'));
    // Parser treats PL/pgSQL bodies as strings; this is not installation/runtime proof.
  });
  it.each([
    (source: string) => source.replace('create function pg_temp.ordinary_slots() returns jsonb language sql immutable as $$',''),
    (source: string) => source.replace('-- BEGIN PHOTO CONTEXT RPC HELPERS','-- drift'),
    (source: string) => source.replace('order by room_number offset n limit 1;','order by room_number limit 1;'),
    (source: string) => source.replace('CONTEXT_CHAIN_NOT_ACCEPTED','IGNORED_RESULT'),
    (source: string) => source.replace('create function pg_temp.additional_fixture(n integer,legacy boolean) returns void','')
  ])('fails closed when the reused fixture contract changes', change => {
    expect(() => roomReadyCorrectionFixture(change(photoFixture))).toThrow();
  });
  it('binds actor, room, CAS, receipt, and exact microsecond preview timestamps in the real RPC', () => {
    const sql = roomReadyApplySql(1,preview(),'ready-race-same-key');
    expect(sql).toContain('public.apply_room_ready_correction(');
    expect(sql).toContain(`'${roomReadyId(1001)}'::uuid`);
    expect(sql).toContain("'2026-10-30T12:00:00.123456+00:00'::timestamptz");
    expect(sql).toContain("true,true,false,'ADMIN_ROOM_READY_CORRECTION'");
  });
  it.each([
    { roomId: roomReadyId(1002) }, { canApply: false }, { roomStateVersion: 0 },
    { roomStateVersion: Number.MAX_SAFE_INTEGER+1 }, { impactFingerprint: "';select 1;--" },
    { evaluatedAt: "2026-10-30T12:00:00Z';select 1;--" }, { expiresAt: null }
  ])('rejects a mismatched or unsafe preview before making SQL', patch => {
    expect(() => roomReadyApplySql(1,{...preview(),...patch},'ready-race-test')).toThrow();
  });
  it('rejects arbitrary fixture targets, keys, and hashes', () => {
    expect(() => roomReadyApplySql(8,preview(),'ready-race-test')).toThrow();
    expect(() => roomReadyApplySql(1,preview(),"ready-race-x';select 1")).toThrow();
    expect(() => roomReadyApplySql(1,preview(),'ready-race-test','x'.repeat(64))).toThrow();
    expect(() => roomReadyId(-1)).toThrow();
  });
  it('permits legitimate appended audit/inspection rows while preserving every prior exact row', () => {
    expect(() => assertRoomReadyProtectedRows(ledger(),ledger(['a'.repeat(64),'b'.repeat(64)]))).not.toThrow();
    expect(() => assertRoomReadyProtectedRows(ledger(['a'.repeat(64),'a'.repeat(64)]),ledger())).toThrow();
    expect(() => assertRoomReadyProtectedRows(ledger(),ledger(['b'.repeat(64)]))).toThrow();
    expect(() => assertRoomReadyProtectedRows(ledger(),ledger([]))).toThrow();
  });
  it.each([null, [], {}, { ...ledger(), 'public.earnings': 'not-an-array' },
    { ...ledger(), 'public.earnings': ['unsafe'] }, { ...ledger(), unexpected: [] }])
  ('rejects incomplete/malformed ledger snapshots', value => {
    expect(() => assertRoomReadyProtectedRows(ledger(),value)).toThrow();
    expect(() => assertRoomReadyProtectedRows(value,ledger())).toThrow();
  });
  it('wires six planned lock races and preserves approval/photo assertions', () => {
    expect(script.match(/await race\(/g)).toHaveLength(6);
    for (const marker of ['ready_same_key','ready_room_cas','ready_approval_first','ready_correction_first','ready_upload_first','ready_upload_after',
      'public.approve_cleaning_submission','public.admit_photo_collection_upload', 'INSPECTION_INVALID_TRANSITION',
      'PHOTO_UPLOAD_IN_PROGRESS','PHOTO_ACCESS_REQUIRED','assertRoomReadyProtectedRows', 'Confirmed earning baseline must be nonempty']) {
      expect(script).toContain(marker);
    }
    expect(manual).toContain('await waitBlocked(`manual_cancel_contender_${suffix}`)');
    expect(manual).toContain("wait_event_type='Lock'");
    expect(manual).toContain('if (afterManual) await afterManual({ sql: localSql, race });');
    expect(manual.indexOf('if (afterManual)')).toBeLessThan(manual.indexOf('for (const item of pending)'));
  });
  it('replaces one entry with the combined suite without adding a reset or weakening final gates', () => {
    const pkg = JSON.parse(read('package.json'));
    const commands: string[] = pkg.scripts['db:test:concurrency'].split(' && ');
    expect(commands.filter(command => command.includes('test-room-ready-correction-concurrency'))).toHaveLength(1);
    expect(commands).not.toContain('node scripts/test-manual-cleaning-cancel-concurrency.mjs');
    expect(script).toContain('await runManualCleaningCancelConcurrency(testRoomReadyCorrectionConcurrency)');
    expect(script).not.toMatch(/execFileSync|\bspawn\(|db.*reset|--skip|--force/);
    expect(manual.match(/\['db'|\[cli, 'db', 'reset'/g)).toHaveLength(1);
    expect(read('.github/workflows/quality.yml')).toContain('timeout-minutes: 40');
  });
});
