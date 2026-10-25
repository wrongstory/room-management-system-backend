import { beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ bytes: null, marker: null, unsafe: false, symlink: false, changed: false, syncCount: 0 }));
vi.mock('node:os', () => ({ homedir: () => process.platform === 'win32' ? 'C:\\synthetic-owner' : '/synthetic-owner' }));
vi.mock('node:child_process', () => ({ execFile: (_program, _args, _options, callback) => { queueMicrotask(() => callback(memory.unsafe ? new Error('unsafe owner') : null, { stdout: 'OWNER_ONLY' })); } }));
vi.mock('node:fs/promises', () => {
  const metadata = path => ({ isDirectory: () => !path.endsWith('.json'), isFile: () => path.endsWith('.json'), isSymbolicLink: () => memory.symlink,
    size: memory.bytes?.length ?? 0, dev: 1, ino: 2, mtimeMs: memory.changed ? 2 : 1, ctimeMs: 1, uid: process.getuid?.() ?? 0, mode: memory.unsafe ? 0o666 : 0o600 });
  return { realpath: async path => path, lstat: async path => metadata(path), open: async (path, mode) => {
    if (mode === 'wx') { if (memory.marker !== null) throw new Error('already consumed'); memory.marker = ''; return { writeFile: async text => { memory.marker = text; }, sync: async () => { memory.syncCount += 1; }, close: async () => {} }; }
    return { stat: async () => metadata(path), read: async (buffer, offset, count, position) => { memory.bytes.copy(buffer, offset, position, position + count); return { bytesRead: count }; }, close: async () => {} };
  } };
});
vi.mock('../scripts/lib/migration-release-preflight.mjs', () => ({
  migrationReleaseConfiguration: request => ({ policy: { expectedSource: request.source } }),
  validateMigrationApprovalReceipt: ({ request, receipt, runId, nowMs }) => { if (receipt.requestSha256 !== request.requestSha256 || receipt.runId !== runId || receipt.issuedAtMs > nowMs || receipt.expiresAtMs <= nowMs || receipt.action !== 'APPLY_EXACT_MIGRATIONS_ONCE') throw new Error(); return receipt; },
}));
const { consumeMigrationApproval } = await import('../scripts/lib/migration-execution-approval.mjs');
const approvalId = '10000000-0000-4000-8000-000000000001'; const runId = '20000000-0000-4000-8000-000000000002';
const request = { requestSha256: 'a'.repeat(64), source: { projectRef: 'aodikrxcczbogjpsjwjt', headSha1: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) } };
const document = () => ({ approvalId, requestSha256: request.requestSha256, ...request.source, issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 60000,
  action: 'APPLY_EXACT_MIGRATIONS_ONCE', humanDecision: { threadId: '01a17067-c214-7de1-a382-6d5fe7e9f853', turnId: '01a17067-c214-7de1-a382-6d5fe7e9f854' } });
const write = value => { memory.bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); };
beforeEach(() => { Object.assign(memory, { marker: null, unsafe: false, symlink: false, changed: false, syncCount: 0 }); write(document()); });
describe('#378 durable single-use approval using synthetic filesystem/ACL responses', () => {
  it('fsyncs an exclusive consumed marker before returning the bound receipt', async () => {
    const receipt = await consumeMigrationApproval({ approvalId, request, runId });
    expect(receipt).toMatchObject({ requestSha256: request.requestSha256, runId }); expect(memory.syncCount).toBe(1);
    expect(JSON.parse(memory.marker)).toMatchObject({ approvalId, runId, requestSha256: request.requestSha256 });
    await expect(consumeMigrationApproval({ approvalId, request, runId })).rejects.toThrow('MIGRATION_APPROVAL_UNAVAILABLE');
  });
  it.each(['headSha1', 'manifestSha256', 'projectRef', 'requestSha256', 'approvalId', 'action', 'expiresAtMs', 'humanDecision'])('rejects wrong approval field %s without consuming', async key => {
    const value = document(); value[key] = key === 'expiresAtMs' ? Date.now() - 1 : key === 'humanDecision' ? { threadId: 'bad', turnId: 'bad' } : 'wrong'; write(value);
    await expect(consumeMigrationApproval({ approvalId, request, runId })).rejects.toThrow('MIGRATION_APPROVAL_UNAVAILABLE'); expect(memory.marker).toBe(null);
  });
  it.each(['unsafe', 'symlink'])('rejects unsafe filesystem evidence: %s', async key => {
    memory[key] = true; await expect(consumeMigrationApproval({ approvalId, request, runId })).rejects.toThrow(); expect(memory.marker).toBe(null);
  });
  it('rejects duplicate JSON keys and noncanonical approval documents', async () => {
    memory.bytes = Buffer.from(JSON.stringify(document()));
    await expect(consumeMigrationApproval({ approvalId, request, runId })).rejects.toThrow(); expect(memory.marker).toBe(null);
  });
  it('cannot turn approvalId into an arbitrary filesystem path', async () => {
    await expect(consumeMigrationApproval({ approvalId: '../unsafe', request, runId })).rejects.toThrow(); expect(memory.marker).toBe(null);
  });
});
