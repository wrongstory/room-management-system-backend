import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const memory = vi.hoisted(() => ({ bytes: Buffer.alloc(0), markers: new Map<string, string>(), paths: [] as string[],
  unsafe: false, symlink: false, replaced: false, replaceOnRead: false, wrongRealPath: false,
  writeFailure: false, syncFailure: false, closeFailure: false, syncCount: 0, delayMarker: false,
  finishMarker: undefined as (() => void) | undefined, invalidStat: false }));
vi.mock('node:os', () => ({ homedir: () => process.platform === 'win32' ? 'C:\\synthetic-reset-owner' : '/synthetic-reset-owner' }));
vi.mock('node:child_process', () => ({ execFile: (_program: string, _args: string[], _options: unknown, callback: (error: Error | null, value: unknown) => void) => {
  Promise.resolve().then(() => callback(memory.unsafe ? new Error('native sensitive ACL path') : null, { stdout: 'OWNER_ONLY' }));
} }));
vi.mock('node:fs/promises', () => {
  const metadata = (path: string, opened = false) => ({ isDirectory: () => !path.endsWith('.json'), isFile: () => path.endsWith('.json') && !memory.invalidStat,
    isSymbolicLink: () => memory.symlink, size: memory.bytes.length, dev: 1, ino: !opened && memory.replaced ? 3 : 2,
    mtimeMs: 1, ctimeMs: 1, uid: process.getuid?.() ?? 0, mode: memory.unsafe ? 0o666 : 0o600 });
  return { realpath: async (path: string) => memory.wrongRealPath ? `${path}-elsewhere` : path,
    lstat: async (path: string) => metadata(path),
    open: async (path: string, mode: string | number) => {
      memory.paths.push(path);
      if (mode === 'wx') {
        if (memory.delayMarker) await new Promise<void>(resolve => { memory.finishMarker = resolve; });
        if (memory.markers.has(path)) throw new Error('already consumed native path');
        memory.markers.set(path, '');
        return { writeFile: async (text: string) => { if (memory.writeFailure) throw new Error('sensitive native write'); memory.markers.set(path, text); },
          sync: async () => { if (memory.syncFailure) throw new Error('sensitive native sync'); memory.syncCount++; },
          close: async () => { if (memory.closeFailure) throw new Error('sensitive native close'); } };
      }
      if (!path.endsWith('.json')) return { sync: async () => { memory.syncCount++; }, close: async () => {} };
      return { stat: async () => metadata(path, true),
        read: async (buffer: Buffer, offset: number, count: number, position: number) => {
          memory.bytes.copy(buffer, offset, position, position + count); if (memory.replaceOnRead) memory.replaced = true;
          return { bytesRead: count };
        }, close: async () => {} };
    } };
});
const { prepareResetApprovalRequest, consumeResetApproval } = await import('../src/modules/developer-reset/reset-approval.js');
const h = (n: string) => n.repeat(64);
const approvalId = '10000000-0000-4000-8000-000000000001';
const runId = '20000000-0000-4000-8000-000000000002';
const command = () => ({ binding: {
  actorProfileId: '11111111-1111-4111-8111-111111111111', authUserId: '22222222-2222-4222-8222-222222222222',
  sessionDigest: h('a'), passwordVersionDigest: h('b'), projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40),
  catalogFingerprint: h('c'), contentFingerprint: h('d'), planFingerprint: h('e'), expectedPostconditionFingerprint: h('f'),
  policyHash: h('1'), approvalScopeHash: h('2'), backupProofHash: h('3'),
}, idempotencyKeyDigest: h('4'), createdAt: 1000, expiresAt: 5000, steps: [{ id: h('5'), kind: 'DATABASE' }] });
const request = () => prepareResetApprovalRequest(command(), 1500);
const document = () => ({ format: 'reset-owner-approval-v1', approvalId, action: 'EXECUTE_EXACT_RESET_ONCE',
  requestSha256: request().requestSha256, commandHash: request().commandHash, projectRef: 'a'.repeat(20), sourceCommit: 'b'.repeat(40),
  issuedAtMs: 1200, expiresAtMs: 4000,
  humanDecision: { threadId: '01a17067-c214-7de1-a382-6d5fe7e9f853', turnId: '01a17067-c214-7de1-a382-6d5fe7e9f854' } });
const write = (value: unknown) => { memory.bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`); };
const consume = (prepared = request()) => consumeResetApproval({ request: prepared, approvalId, runId, ioBudgetMs: 25 });
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1500);
  Object.assign(memory, { markers: new Map(), paths: [], unsafe: false, symlink: false, replaced: false, replaceOnRead: false,
    wrongRealPath: false, writeFailure: false, syncFailure: false, closeFailure: false, syncCount: 0,
    delayMarker: false, finishMarker: undefined, invalidStat: false }); write(document());
});
afterEach(() => vi.useRealTimers());

describe('reset owner approval one-use consumption with synthetic filesystem and ACL only', () => {
  it('binds a canonical request and fsyncs an exclusive marker without granting execution', async () => {
    const r = request(); expect(Object.isFrozen(r)).toBe(true);
    const result = await consume(r);
    expect(result).toEqual({ status: 'CONSUMED', approvalId, runId, requestSha256: r.requestSha256,
      commandHash: r.commandHash, consumedAtMs: 1500, executionEnabled: false, retryExecutionAllowed: false });
    expect(memory.markers.size).toBe(1); expect(memory.syncCount).toBeGreaterThanOrEqual(1);
    const marker = JSON.parse([...memory.markers.values()][0] ?? '{}');
    expect(marker).toMatchObject({ approvalId, runId, requestSha256: r.requestSha256 });
    expect(Object.keys(result)).not.toEqual(expect.arrayContaining(['live', 'coverage', 'authorized']));
    expect(JSON.stringify(marker)).not.toContain('sessionDigest');
    await expect(consume(r)).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
  });
  it('two independently prepared requests race for one durable marker and only one succeeds', async () => {
    const outcomes = await Promise.allSettled([consume(), consume()]);
    expect(outcomes.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect(memory.markers.size).toBe(1);
  });
  it('a fresh request after process-style restart cannot reuse a persisted consumed marker', async () => {
    await consume(); await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    expect(memory.markers.size).toBe(1);
  });
  it.each(['writeFailure', 'syncFailure', 'closeFailure'] as const)('failure after marker creation remains consumed: %s', async field => {
    memory[field] = true;
    await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    expect(memory.markers.size).toBe(1); memory[field] = false;
    await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
  });
  it('observation timeout never removes a late exclusive marker or permits retry', async () => {
    memory.delayMarker = true;
    const r = request(); const pending = consume(r); const assertion = expect(pending).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    for (let n = 0; n < 30 && !memory.finishMarker; n++) await Promise.resolve();
    expect(memory.finishMarker).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(26); await assertion;
    memory.finishMarker?.(); await vi.advanceTimersByTimeAsync(0);
    expect(memory.markers.size).toBe(1); expect([...memory.markers.values()]).toEqual(['']);
    memory.delayMarker = false; await expect(consume(r)).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
  });
  it.each(Object.keys(command().binding))('changes to command binding %s invalidate the old approval', async key => {
    const c = command(); const values = c.binding as Record<string, string>;
    values[key] = ['actorProfileId', 'authUserId'].includes(key) ? '99999999-9999-4999-8999-999999999999'
      : key === 'projectRef' ? 'z'.repeat(20) : key === 'sourceCommit' ? '9'.repeat(40) : h('9');
    await expect(consume(prepareResetApprovalRequest(c, 1500))).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    expect(memory.markers.size).toBe(0);
  });
  it.each(['key', 'step', 'order', 'created', 'expires'])('changes to %s cannot reuse approval', async key => {
    const c = command();
    if (key === 'key') c.idempotencyKeyDigest = h('9');
    if (key === 'step') c.steps = [{ id: h('6'), kind: 'AUTH' }];
    if (key === 'order') c.steps = [{ id: h('6'), kind: 'AUTH' }, ...c.steps];
    if (key === 'created') c.createdAt = 1001;
    if (key === 'expires') c.expiresAt = 5001;
    await expect(consume(prepareResetApprovalRequest(c, 1500))).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    expect(memory.markers.size).toBe(0);
  });
  it.each(['approvalId', 'requestSha256', 'commandHash', 'projectRef', 'sourceCommit', 'action', 'format', 'humanDecision'])('rejects approval field %s', async key => {
    const d = document() as Record<string, unknown>; d[key] = key === 'humanDecision' ? { threadId: 'bad', turnId: 'bad' } : 'wrong'; write(d);
    await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE'); expect(memory.markers.size).toBe(0);
  });
  it.each([[1501, 4000], [999, 4000], [1200, 1500], [1200, 5001], [1400, 1300]])('rejects changed/expired approval window %i..%i', async (issuedAtMs, expiresAtMs) => {
    write({ ...document(), issuedAtMs, expiresAtMs });
    await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE'); expect(memory.markers.size).toBe(0);
  });
  it.each(['unsafe', 'symlink', 'wrongRealPath', 'replaceOnRead', 'invalidStat'] as const)('rejects unsafe file evidence %s', async field => {
    memory[field] = true;
    await expect(consume()).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE'); expect(memory.markers.size).toBe(0);
  });
  it.each(['unknown', 'duplicate', 'notCanonical', 'invalidUtf8', 'tooLarge'])('rejects document serialization %s without native error output', async mode => {
    if (mode === 'unknown') write({ ...document(), rawPassword: 'synthetic-never-read' });
    if (mode === 'duplicate') memory.bytes = Buffer.from(`${JSON.stringify(document(), null, 2).replace('{', '{"approvalId":"duplicate",')}\n`);
    if (mode === 'notCanonical') memory.bytes = Buffer.from(JSON.stringify(document()));
    if (mode === 'invalidUtf8') memory.bytes = Buffer.from([0xff]);
    if (mode === 'tooLarge') memory.bytes = Buffer.alloc(8193);
    await expect(consume()).rejects.toThrow(/^RESET_APPROVAL_UNAVAILABLE$/); expect(memory.markers.size).toBe(0);
  });
  it('rejects cloned/hash-only request objects, traversal IDs, and missing budget before filesystem access', async () => {
    await expect(consume({ ...request() })).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    await expect(consumeResetApproval({ request: request(), approvalId: '../outside', runId, ioBudgetMs: 25 })).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    await expect(consumeResetApproval({ request: request(), approvalId, runId, ioBudgetMs: 0 })).rejects.toThrow('RESET_APPROVAL_UNAVAILABLE');
    expect(memory.paths).toHaveLength(0);
  });
  it('does not invoke malicious command getters or accept unknown command keys', () => {
    const getter = vi.fn(() => command().binding);
    const c = { ...command(), get binding() { return getter(); } };
    expect(() => prepareResetApprovalRequest(c, 1500)).toThrow('RESET_APPROVAL_UNAVAILABLE'); expect(getter).not.toHaveBeenCalled();
    expect(() => prepareResetApprovalRequest({ ...command(), approved: true }, 1500)).toThrow('RESET_APPROVAL_UNAVAILABLE');
  });
});
