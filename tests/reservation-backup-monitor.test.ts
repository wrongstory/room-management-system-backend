import { describe, expect, it, vi } from 'vitest';
import { BACKUP_REPOSITORY, BACKUP_VERIFICATION_STEP, BACKUP_WORKFLOW_PATH,
  collectBackupHealth, evaluateBackupEvidence, expectedBackupDay,
  type BackupEvidence } from '../supabase/functions/_shared/reservation-backup-monitor.js';

const now = new Date('2026-10-24T19:01:00Z'); // 04:01 KST on 25 October
const sha = 'a'.repeat(40);
const token = 'synthetic-storage-token-no-secret';
function present<T>(value: T | undefined): T { if (value === undefined) throw new Error('Fixture is incomplete'); return value; }
function job(data: BackupEvidence) { return present(present(data.verifiedRun).jobs[0]); }
function step(data: BackupEvidence) { return present(job(data).steps[0]); }
function evidence(): BackupEvidence {
  return { workflowState: 'active', bucketPrivate: true,
    runs: [{ id: 10, attempt: 2, status: 'completed', conclusion: 'success', startedAt: '2026-10-24T18:00:00Z', headSha: sha }],
    objects: [{ name: '2026-10-25.rms', size: 100, createdAt: '2026-10-24T18:01:00Z', updatedAt: '2026-10-24T18:01:00Z' }],
    verifiedRun: { runId: 10, attempt: 2, jobs: [{ name: 'backup', status: 'completed', conclusion: 'success',
      steps: [{ name: BACKUP_VERIFICATION_STEP, status: 'completed', conclusion: 'success',
        startedAt: '2026-10-24T18:00:30Z', completedAt: '2026-10-24T18:02:00Z' }] }] } };
}
function rawRun(overrides: Record<string, unknown> = {}) {
  return { id: 10, workflow_id: 50, head_branch: 'main', event: 'schedule',
    repository: { full_name: BACKUP_REPOSITORY }, head_repository: { full_name: BACKUP_REPOSITORY },
    run_started_at: '2026-10-24T18:00:00Z', status: 'completed', conclusion: 'success', head_sha: sha, run_attempt: 2, ...overrides };
}
function rawJobs() {
  return { total_count: 1, jobs: [{ run_id: 10, run_attempt: 2, head_sha: sha,
    name: 'backup', status: 'completed', conclusion: 'success',
    steps: [{ name: BACKUP_VERIFICATION_STEP, status: 'completed', conclusion: 'success',
      started_at: '2026-10-24T18:00:30Z', completed_at: '2026-10-24T18:02:00Z' }] }] };
}
type Override = (url: string, calls: number) => Response | undefined;
function mockFetch(override?: Override) {
  const reads = new Map<string, number>();
  return vi.fn<typeof fetch>(async (input) => {
    const url = String(input); const calls = (reads.get(url) ?? 0) + 1; reads.set(url, calls);
    const custom = override?.(url, calls); if (custom) return custom;
    if (url.endsWith('/actions/workflows/reservation-backup.yml')) return Response.json({ id: 50, path: BACKUP_WORKFLOW_PATH, state: 'active' });
    if (url.endsWith('/bucket/reservation-backups')) return Response.json({ id: 'reservation-backups', public: false });
    if (url.endsWith('/runs?branch=main&per_page=100')) return Response.json({ workflow_runs: [rawRun()] });
    if (url.endsWith('/object/list/reservation-backups')) return Response.json([{ name: '2026-10-25.rms', metadata: { size: 100 }, created_at: '2026-10-24T18:01:00Z', updated_at: '2026-10-24T18:01:00Z' }]);
    if (url.endsWith('/actions/runs/10')) return Response.json(rawRun());
    if (url.endsWith('/actions/runs/10/attempts/2/jobs?per_page=100')) return Response.json(rawJobs());
    throw new Error(`Unexpected synthetic request: ${url}`);
  });
}

describe('reservation backup independent health evidence', () => {
  it('uses the KST 04:00 deadline, including month/year rollover', () => {
    expect(expectedBackupDay(new Date('2026-10-24T18:59:59.999Z'))).toBe('2026-10-24');
    expect(expectedBackupDay(new Date('2026-10-24T19:00:00Z'))).toBe('2026-10-25');
    expect(expectedBackupDay(new Date('2026-12-31T18:59:00Z'))).toBe('2026-12-31');
    expect(expectedBackupDay(new Date('2026-12-31T19:00:00Z'))).toBe('2027-01-01');
  });
  it('requires a matching object and actual current-attempt successful verification step', () => {
    expect(evaluateBackupEvidence(evidence(), now)).toEqual({ code: 'HEALTHY', expectedDay: '2026-10-25',
      verifiedDay: '2026-10-25', runId: 10, runAttempt: 2, checkedAt: now.toISOString() });
  });
  it('accepts a same-day immutable object verified again later that day', () => {
    const data = evidence();
    present(data.objects[0]).createdAt = '2026-10-24T15:01:00Z';
    expect(evaluateBackupEvidence(data, now).code).toBe('HEALTHY');
  });
  it('allows Storage microseconds within GitHub completion second but rejects the next second', () => {
    const data = evidence();
    step(data).completedAt = '2026-10-24T18:00:59Z';
    present(data.objects[0]).createdAt = '2026-10-24T18:00:59.123456+00:00';
    present(data.objects[0]).updatedAt = '2026-10-24T18:00:59.999999+00:00';
    expect(evaluateBackupEvidence(data, now).code).toBe('HEALTHY');
    present(data.objects[0]).updatedAt = '2026-10-24T18:01:00+00:00';
    expect(evaluateBackupEvidence(data, now).code).toBe('MONITOR_CHECK_FAILED');
  });
  it('does not treat workflow success with skipped/missing/failed verification as a backup', () => {
    for (const mutate of [
      (data: BackupEvidence) => { job(data).conclusion = 'skipped'; },
      (data: BackupEvidence) => { job(data).steps = []; },
      (data: BackupEvidence) => { step(data).conclusion = 'failure'; },
    ]) { const data = evidence(); mutate(data); expect(evaluateBackupEvidence(data, now).code).toBe('BACKUP_FAILED'); }
  });
  it('does not reuse a previous attempt or another run as success', () => {
    for (const field of ['attempt', 'runId'] as const) {
      const data = evidence(); present(data.verifiedRun)[field] += 1;
      expect(evaluateBackupEvidence(data, now).code).toBe('MONITOR_CHECK_FAILED');
    }
  });
  it('reports missing/stale backups after deadline and permits yesterday before deadline', () => {
    const data = evidence(); data.objects = [];
    expect(evaluateBackupEvidence(data, now).code).toBe('BACKUP_MISSING');
    const old = JSON.parse(JSON.stringify(evidence()).replaceAll('2026-10-25.rms', '2026-10-24.rms').replaceAll('2026-10-24T', '2026-10-23T')) as BackupEvidence;
    expect(evaluateBackupEvidence(old, now).code).toBe('BACKUP_MISSING');
    expect(evaluateBackupEvidence(old, new Date('2026-10-24T18:59:59Z')).code).toBe('HEALTHY');
  });
  it('reports a newer failed/cancelled/skipped attempt even while an earlier valid copy remains', () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped']) {
      const data = evidence(); data.runs.push({ ...present(data.runs[0]), id: 11, startedAt: '2026-10-24T18:30:00Z', conclusion });
      expect(evaluateBackupEvidence(data, now)).toMatchObject({ code: 'BACKUP_FAILED', runId: 11 });
    }
  });
  it('does not let an in-progress run hide missing backups or stall indefinitely', () => {
    const data = evidence();
    data.runs.push({ ...present(data.runs[0]), id: 11, startedAt: '2026-10-24T18:45:00Z', status: 'in_progress', conclusion: null });
    expect(evaluateBackupEvidence(data, now).code).toBe('HEALTHY');
    data.objects = [];
    expect(evaluateBackupEvidence(data, now).code).toBe('BACKUP_MISSING');
    present(data.runs[1]).startedAt = '2026-10-24T18:30:00Z';
    expect(evaluateBackupEvidence(data, now).code).toBe('BACKUP_FAILED');
  });
  it.each(['disabled_inactivity', 'disabled_manually', 'deleted'])('reports workflow state %s', (workflowState) => {
    expect(evaluateBackupEvidence({ ...evidence(), workflowState }, now).code).toBe('WORKFLOW_DISABLED');
  });
  it('rejects malformed, duplicate, future, oversized or mismatched storage objects', () => {
    for (const mutate of [
      (data: BackupEvidence) => { data.bucketPrivate = false; },
      (data: BackupEvidence) => { present(data.objects[0]).name = '2026-02-30.rms'; },
      (data: BackupEvidence) => { present(data.objects[0]).name = '../2026-10-25.rms'; },
      (data: BackupEvidence) => { present(data.objects[0]).size = 33554469; },
      (data: BackupEvidence) => { present(data.objects[0]).size = 36; },
      (data: BackupEvidence) => { data.objects.push(present(data.objects[0])); },
      (data: BackupEvidence) => { present(data.objects[0]).createdAt = '2026-10-25T19:01:01Z'; },
      (data: BackupEvidence) => { present(data.objects[0]).createdAt = '2026-10-24T18:02:01Z'; },
      (data: BackupEvidence) => { present(data.objects[0]).updatedAt = '2026-10-24T18:02:01Z'; },
      (data: BackupEvidence) => { present(data.objects[0]).updatedAt = '2026-10-24T18:00:00Z'; },
    ]) { const data = evidence(); mutate(data); expect(evaluateBackupEvidence(data, now).code).toBe('MONITOR_CHECK_FAILED'); }
  });
  it('rejects ambiguous midnight verification and unsafe run identity/time', () => {
    for (const mutate of [
      (data: BackupEvidence) => { present(data.runs[0]).id = Number.MAX_SAFE_INTEGER + 1; },
      (data: BackupEvidence) => { present(data.runs[0]).startedAt = '2026-10-25T19:00:00Z'; },
      (data: BackupEvidence) => { present(data.runs[0]).headSha = 'untrusted'; },
      (data: BackupEvidence) => { present(data.runs[0]).startedAt = '2026-10-24T14:00:00Z'; step(data).startedAt = '2026-10-24T14:59:00Z'; },
    ]) { const data = evidence(); mutate(data); expect(evaluateBackupEvidence(data, now).code).toBe('MONITOR_CHECK_FAILED'); }
  });
});

describe('bounded public workflow and private metadata collector', () => {
  it('uses collection completion time for evidence that completed during its requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-24T17:59:59Z'));
      const fetcher = mockFetch((url, reads) => {
        if (url.endsWith('/actions/runs/10') && reads === 2) {
          vi.setSystemTime(new Date('2026-10-24T18:03:00Z'));
        }
        return undefined;
      });
      expect(await collectBackupHealth(token, { fetcher })).toEqual({ code: 'HEALTHY', expectedDay: '2026-10-24',
        verifiedDay: '2026-10-25', runId: 10, runAttempt: 2, checkedAt: '2026-10-24T18:03:00.000Z' });
    } finally { vi.useRealTimers(); }
  });
  it('reads only fixed metadata endpoints with Storage credentials isolated from GitHub', async () => {
    const fetcher = mockFetch();
    expect((await collectBackupHealth(token, { fetcher, now })).code).toBe('HEALTHY');
    expect(fetcher).toHaveBeenCalledTimes(7);
    for (const [url, init] of fetcher.mock.calls) {
      expect(init?.redirect).toBe('error'); expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(String(url)).toMatch(/^https:\/\/(api\.github\.com\/repos\/wrongstory\/room-management-system-backend\/|matalcofimnhuzslfhdd\.supabase\.co\/storage\/v1\/)/);
      expect(String(url)).not.toContain('.rms');
      expect(init?.method).toBe(String(url).includes('/object/list/') ? 'POST' : 'GET');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(String(url).includes('api.github.com') ? null : `Bearer ${token}`);
    }
    expect(fetcher.mock.calls.some(([url]) => String(url).includes('/attempts/2/jobs'))).toBe(true);
  });
  it.each([
    { head_branch: 'other' }, { event: 'pull_request' }, { workflow_id: 51 },
    { repository: { full_name: 'other/repository' } }, { run_attempt: 0 },
  ])('rejects out-of-scope workflow runs %j', async (change) => {
    const fetcher = mockFetch(url => url.includes('/runs?') ? Response.json({ workflow_runs: [rawRun(change)] }) : undefined);
    expect((await collectBackupHealth(token, { fetcher, now })).code).toBe('MONITOR_CHECK_FAILED');
  });
  it('detects a rerun between listing, job reads and final confirmation', async () => {
    for (const targetRead of [1, 2]) {
      const fetcher = mockFetch((url, count) => url.endsWith('/actions/runs/10') && count === targetRead
        ? Response.json(rawRun({ run_attempt: 3 })) : undefined);
      expect((await collectBackupHealth(token, { fetcher, now })).code).toBe('MONITOR_CHECK_FAILED');
    }
  });
  it('rejects stale attempts or truncated job pages', async () => {
    for (const change of ['attempt', 'truncated']) {
      const jobs = rawJobs(); if (change === 'attempt') present(jobs.jobs[0]).run_attempt = 1; else jobs.total_count = 101;
      const fetcher = mockFetch(url => url.includes('/attempts/') ? Response.json(jobs) : undefined);
      expect((await collectBackupHealth(token, { fetcher, now })).code).toBe('MONITOR_CHECK_FAILED');
    }
  });
  it.each([429, 403, 500, 302])('never reports success or provider text on status %s', async (status) => {
    const fetcher = mockFetch(() => new Response('sensitive provider detail', { status }));
    const result = await collectBackupHealth(token, { fetcher, now });
    expect(result.code).toBe('MONITOR_CHECK_FAILED'); expect(JSON.stringify(result)).not.toContain('sensitive');
  });
  it('rejects a public bucket and wrong workflow path', async () => {
    for (const fetcher of [
      mockFetch(url => url.includes('/bucket/') ? Response.json({ id: 'reservation-backups', public: true }) : undefined),
      mockFetch(url => url.endsWith('.yml') ? Response.json({ id: 50, path: '.github/workflows/other.yml', state: 'active' }) : undefined),
    ]) expect((await collectBackupHealth(token, { fetcher, now })).code).toBe('MONITOR_CHECK_FAILED');
  });
  it('rejects malformed/oversized responses with and without content-length', async () => {
    for (const response of [new Response('{bad'), new Response('x'.repeat(65537)),
      new Response('{}', { headers: { 'content-length': '65537' } })]) {
      expect((await collectBackupHealth(token, { fetcher: mockFetch(url => url.endsWith('.yml') ? response : undefined), now })).code).toBe('MONITOR_CHECK_FAILED');
    }
  });
  it('rejects a redirected response even when its status is successful', async () => {
    const response = Response.json({ id: 50, path: BACKUP_WORKFLOW_PATH, state: 'active' });
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'https://other.example/credentials' });
    expect((await collectBackupHealth(token, { fetcher: mockFetch(url => url.endsWith('.yml') ? response : undefined), now })).code).toBe('MONITOR_CHECK_FAILED');
  });
  it('terminates stalled request and body reads when their finite deadline aborts', async () => {
    for (const stalledBody of [false, true]) {
      const controller = new AbortController();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
      const pull = vi.fn();
      const fetcher = vi.fn<typeof fetch>(() => stalledBody
        ? Promise.resolve(new Response(new ReadableStream<Uint8Array>({ pull })))
        : new Promise<Response>(() => undefined));
      try {
        const pending = collectBackupHealth(token, { fetcher, now });
        if (stalledBody) await vi.waitFor(() => expect(pull).toHaveBeenCalled());
        controller.abort();
        expect((await pending).code).toBe('MONITOR_CHECK_FAILED');
        expect(timeout).toHaveBeenCalledWith(45000);
        expect(timeout).toHaveBeenCalledWith(7000);
      } finally { timeout.mockRestore(); }
    }
  });
  it('rejects network errors and invalid credentials without exposing them', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('sensitive token failure'));
    expect(await collectBackupHealth(token, { fetcher, now })).toEqual({ code: 'MONITOR_CHECK_FAILED', expectedDay: '2026-10-25', checkedAt: now.toISOString() });
    fetcher.mockClear();
    expect((await collectBackupHealth('bad\ncredential', { fetcher, now })).code).toBe('MONITOR_CHECK_FAILED');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
