import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { assertPostApprovalRoomIssueFresh, assertPostApprovalRoomIssueHistory, postApprovalRoomIssueFreshRelations }
  from '../scripts/test-post-approval-room-issue-concurrency.mjs';

const script = await readFile(new URL('../scripts/test-post-approval-room-issue-concurrency.mjs', import.meta.url), 'utf8');
const clean = () => ({ rooms: 121, roomTypes: 4, publicWithoutRls: 0, rows: Object.fromEntries(postApprovalRoomIssueFreshRelations.map(relation => [relation, 0])) });
const history = [{ version: '20261005023103', name: 'post_approval_room_issue_ledger' }];
describe('#336 race runner pure preflight/source checks, NOT actual DB/race execution', () => {
  it('runs the actual runner after existing races in the required migration CI command', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const commands = pkg.scripts['db:test:concurrency'].split(' && ');
    expect(commands.at(-1)).toBe('node scripts/test-post-approval-room-issue-concurrency.mjs');
    expect(commands.filter((command: string) => command.includes('test-post-approval-room-issue-concurrency.mjs'))).toHaveLength(1);
    for (const name of ['reservation', 'limited-existing-session', 'room-candle', 'photo-storage-names']) {
      expect(commands).toContain(`node scripts/test-${name}-concurrency.mjs`);
    }
    const workflow = await readFile(new URL('../.github/workflows/quality.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('- run: npm run db:test:concurrency');
  });
  it('imports without running Docker/CLI/DB and accepts the exact synthetic fresh baseline', () => {
    expect(() => assertPostApprovalRoomIssueFresh(clean())).not.toThrow();
    expect(script).toContain('pathToFileURL(process.argv[1]).href === import.meta.url');
  });
  it.each(['rooms', 'roomTypes', 'publicWithoutRls'])('rejects drift in %s', key => {
    expect(() => assertPostApprovalRoomIssueFresh({ ...clean(), [key]: 1 })).toThrow();
  });
  it.each(['private.photo_upload_operations', 'private.post_approval_room_issue_reports', 'private.notification_delivery_outbox'])
    ('nonempty %s cannot authorize cleanup despite empty users/targets', relation => {
      const value = clean(); value.rows[relation] = 1;
      expect(() => assertPostApprovalRoomIssueFresh(value)).toThrow();
    });
  it('checks the entire exact name/version sequence, not just count/head', () => {
    expect(() => assertPostApprovalRoomIssueHistory(history, history)).not.toThrow();
    expect(() => assertPostApprovalRoomIssueHistory([{ ...history[0], version: '20261005023102' }], history)).toThrow();
    expect(() => assertPostApprovalRoomIssueHistory([{ ...history[0], name: 'same_count_wrong_source' }], history)).toThrow();
    expect(() => assertPostApprovalRoomIssueHistory(history, [])).toThrow();
  });
  it('requires actual lock overlap and preserves mixed core transitions and durable provider races', () => {
    for (const needle of ["wait_event_type='Lock'", 'eighth_single_core_transition', 'EXPECTED_TYPED_NINTH_DENIAL',
      'EXPECTED_COLLECTION_NINTH_DENIAL', 'COLLECTION_RECEIPT_DRIFT', 'provider_wait_cas', 'provider_wait_expiry',
      'shared_admin_create', 'shared_admin_edit', 'shared_admin_finalize',
      'rollbackFirst: true, rollbackSecond: true', 'Original approval/photos/seals/earnings/payroll/room rows unchanged',
      'Unrelated local data blocks cleanup', 'installedHistory(manifest); fresh();']) expect(script).toContain(needle);
    expect(script).not.toMatch(/--skip|--force|SKIP_[A-Z_]+|process\.env\.[A-Z_]+\s*=/);
  });
});
