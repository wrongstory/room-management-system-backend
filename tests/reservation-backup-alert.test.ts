import { describe, expect, it, vi } from 'vitest';
import { ALERT_MARKER, publishBackupAlert } from '../supabase/functions/_shared/reservation-backup-alert.js';

const health = { code: 'BACKUP_MISSING', expectedDay: '2026-10-25', checkedAt: '2026-10-25T00:00:00.000Z' };
const token = 'ghs_' + 'synthetic'.repeat(5);
function scenario(body = ALERT_MARKER) {
  const calls: { url: string; options: RequestInit }[] = [];
  const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(input), options: options ?? {} });
    return Response.json(options?.method === 'GET' ? { number: 123, state: 'open', comments: 0, body } : { id: 456 });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
describe('reservation backup alert boundaries', () => {
  it('publishes only allowlisted status and dates to the configured issue', async () => {
    const test = scenario();
    expect(await publishBackupAlert(health, { token, issue: 123, fetcher: test.fetcher })).toEqual({ published: true });
    expect(test.calls.map(c => c.options.method)).toEqual(['GET', 'POST', 'PATCH']);
    expect(test.calls.every(c => c.url.startsWith('https://api.github.com/repos/wrongstory/room-management-system-backend/issues/123'))).toBe(true);
    expect(test.calls.every(c => c.options.redirect === 'error' && c.options.signal)).toBe(true);
    const sent = test.calls.slice(1).map(c => String(c.options.body)).join('');
    expect(sent).toContain('BACKUP_MISSING'); expect(sent).not.toContain(token);
  });
  it('suppresses the same failure and quiet healthy checks', async () => {
    for (const [code, previous] of [['BACKUP_MISSING', 'BACKUP_MISSING'], ['HEALTHY', 'HEALTHY']]) {
      const test = scenario(`${ALERT_MARKER}\n<!-- rms-backup-state:${previous}:2026-10-25:none:none -->`);
      expect(await publishBackupAlert({ ...health, code: code! }, { token, issue: 123, fetcher: test.fetcher })).toEqual({ published: false });
      expect(test.calls).toHaveLength(1);
    }
  });
  it('records initial healthy state quietly and recovery after a failure once', async () => {
    const first = scenario();
    expect(await publishBackupAlert({ ...health, code: 'HEALTHY' }, { token, issue: 123, fetcher: first.fetcher })).toEqual({ published: false });
    expect(first.calls.map(c => c.options.method)).toEqual(['GET', 'PATCH']);
    const next = scenario(`${ALERT_MARKER}\nUser notes retained.\n<!-- rms-backup-state:BACKUP_MISSING:2026-10-25:none:none -->`);
    await publishBackupAlert({ ...health, code: 'HEALTHY', verifiedDay: '2026-10-25', runId: 789 }, { token, issue: 123, fetcher: next.fetcher });
    expect(String(next.calls[1]?.options.body)).toContain('/actions/runs/789');
    expect(String(next.calls[2]?.options.body)).toContain('User notes retained.');
  });
  it('does not alter unrelated issues or closed issues and hides provider errors', async () => {
    for (const value of [{ number: 123, state: 'open', body: 'ordinary issue' },
      { number: 123, state: 'closed', body: ALERT_MARKER }, { number: 123, state: 'open', body: ALERT_MARKER, pull_request: {} }]) {
      const fetcher = vi.fn(async () => Response.json(value));
      await expect(publishBackupAlert(health, { token, issue: 123, fetcher })).rejects.toThrow(/^BACKUP_ALERT_FAILED$/);
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
    await expect(publishBackupAlert(health, { token, issue: 123,
      fetcher: async () => { throw new Error('provider token ' + token); } })).rejects.toThrow(/^BACKUP_ALERT_FAILED$/);
  });
  it('rejects malformed status, dates and numeric identifiers before any request', async () => {
    const test = scenario();
    for (const change of [{ code: 'RAW_ERROR_SECRET' }, { expectedDay: '2026-02-30' }, { checkedAt: 'injected\ntext' },
      { runId: -1 }, { verifiedDay: '2026-02-31' }]) {
      await expect(publishBackupAlert({ ...health, ...change }, { token, issue: 123, fetcher: test.fetcher })).rejects.toThrow();
    }
    expect(test.calls).toHaveLength(0);
  });
  it('bounds responses and leaves failed comments unacknowledged for a later retry', async () => {
    await expect(publishBackupAlert(health, { token, issue: 123,
      fetcher: async () => new Response('x'.repeat(1024 * 1024 + 1)) })).rejects.toThrow(/^BACKUP_ALERT_FAILED$/);
    const fetcher = vi.fn(async (_: unknown, options?: RequestInit) => options?.method === 'GET'
      ? Response.json({ number: 123, state: 'open', comments: 0, body: ALERT_MARKER }) : new Response('private error', { status: 403 }));
    await expect(publishBackupAlert(health, { token, issue: 123, fetcher })).rejects.toThrow(/^BACKUP_ALERT_FAILED$/);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('deduplicates the same failed attempt across the 04:00 KST date boundary', async () => {
    const test = scenario(`${ALERT_MARKER}\n<!-- rms-backup-state:BACKUP_FAILED:2026-10-24:789:2 -->`);
    expect(await publishBackupAlert({ ...health, code: 'BACKUP_FAILED', runId: 789, runAttempt: 2 },
      { token, issue: 123, fetcher: test.fetcher })).toEqual({ published: false });
    expect(test.calls).toHaveLength(1);
    const newer = scenario(`${ALERT_MARKER}\n<!-- rms-backup-state:BACKUP_FAILED:2026-10-24:789:2 -->`);
    expect(await publishBackupAlert({ ...health, code: 'BACKUP_FAILED', runId: 789, runAttempt: 3 },
      { token, issue: 123, fetcher: newer.fetcher })).toEqual({ published: true });
  });
  it('recovers a successful comment with a lost response without resending it', async () => {
    let body = ALERT_MARKER;
    const comments: { user: { type: string; login: string }; body: string }[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
      if (options?.method === 'POST') {
        comments.push({ user: { type: 'Bot', login: 'github-actions[bot]' }, body: JSON.parse(String(options.body)).body });
        throw new Error('lost response after accepted comment');
      }
      if (options?.method === 'PATCH') { body = JSON.parse(String(options.body)).body; return Response.json({}); }
      return String(input).includes('/comments?') ? Response.json(comments)
        : Response.json({ number: 123, state: 'open', comments: comments.length, body });
    }) as unknown as typeof fetch;
    await expect(publishBackupAlert(health, { token, issue: 123, fetcher })).rejects.toThrow(/^BACKUP_ALERT_FAILED$/);
    expect(await publishBackupAlert(health, { token, issue: 123, fetcher })).toEqual({ published: false });
    expect(comments).toHaveLength(1);
    expect(body).toContain('rms-backup-state:BACKUP_MISSING:2026-10-25:none:none');
  });
  it('bounds a stalled alert request and accepts current stateless installation tokens', async () => {
    const test = scenario();
    await publishBackupAlert(health, { token: 'ghs_12345_header.payload-signature', issue: 123, fetcher: test.fetcher });
    const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => nativeTimeout(10));
    try {
      const pending = publishBackupAlert(health, { token, issue: 123, fetcher: () => new Promise<Response>(() => {}) });
      await expect(pending).rejects.toThrow(/^BACKUP_ALERT_FAILED$/);
      expect(timeout).toHaveBeenCalledWith(7000);
      expect(timeout).toHaveBeenCalledWith(25000);
    } finally { timeout.mockRestore(); }
  });
});
