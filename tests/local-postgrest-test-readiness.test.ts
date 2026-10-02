import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type LocalPostgrestReadinessError,
  safeRpcResultSummary,
  waitForLocalPostgrestReady,
} from '../scripts/lib/local-postgrest-test-readiness.mjs';

const apiUrl = 'http://127.0.0.1:54321';
const apiKey = 'local-only-sensitive-key-marker';
const signature = () => ({
  swagger: '2.0',
  paths: {
    '/rpc/process_due_assignment_lifecycle': {
      post: { parameters: [{
        in: 'body', required: true,
        schema: {
          required: ['p_actor_profile_id', 'p_as_of', 'p_idempotency_key', 'p_request_hash'],
          properties: {
            p_actor_profile_id: { type: 'string', format: 'uuid' },
            p_as_of: { type: 'string', format: 'timestamp with time zone' },
            p_idempotency_key: { type: 'string', format: 'text' },
            p_request_hash: { type: 'string', format: 'text' },
          },
        },
      }] },
    },
  },
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const fakeTime = () => {
  let now = 0;
  return { nowImpl: () => now, sleepImpl: async (ms: number) => { now += ms; } };
};

afterEach(() => vi.useRealTimers());

describe('safe local RPC diagnostics', () => {
  it('projects only integer status and recognized database or PostgREST code', () => {
    for (const code of ['40P01', '23514', 'P0001', 'PGRST002', 'PGRST202', 'PGRSTX00']) {
      expect(safeRpcResultSummary({ status: 503, error: { code, message: apiKey, details: apiKey, hint: apiKey }, data: apiKey }))
        .toEqual({ status: 503, code });
    }
    expect(safeRpcResultSummary({ status: 0, error: { message: apiKey } })).toEqual({ status: 0, code: null });
    expect(safeRpcResultSummary({ status: 200, error: null })).toEqual({ status: 200, code: null });
  });

  it.each([apiKey, 'TOKEN', 'PGRST002\nsecret', 'PGRST999', '40p01', {}, 23514, 'X'.repeat(100_000)])(
    'redacts unrecognized or adversarial codes', (code) => {
      expect(safeRpcResultSummary({ status: 400, error: { code } })).toEqual({ status: 400, code: 'UNRECOGNIZED' });
    },
  );

  it.each(['503', -1, 1, 99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, {}, apiKey])(
    'rejects malformed status values', (status) => {
      expect(safeRpcResultSummary({ status })).toEqual({ status: null, code: null });
    },
  );

  it('does not invoke getters or coercion and survives hostile proxy traps', () => {
    const trap = vi.fn(() => { throw new Error(apiKey); });
    const error = { get code() { return trap(); }, message: apiKey, toJSON: trap, toString: trap };
    expect(safeRpcResultSummary({ status: 500, error })).toEqual({ status: 500, code: null });
    expect(safeRpcResultSummary(Object.create({ status: 500, error: { code: '40P01' } })))
      .toEqual({ status: null, code: null });
    expect(safeRpcResultSummary(new Proxy({}, { getOwnPropertyDescriptor: trap })))
      .toEqual({ status: null, code: null });
    expect(trap).toHaveBeenCalledTimes(2);
  });
});

describe('bounded read-only local PostgREST readiness', () => {
  it('requires the current service-role RPC signature and sends only a read-only root GET', async () => {
    const spec = { ...signature(), description: apiKey };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(spec));
    await expect(waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() }))
      .resolves.toEqual({ attempts: 1, elapsedMs: 0 });
    const call = fetchImpl.mock.calls[0];
    if (!call) throw new Error('Expected one readiness probe');
    const [url, options] = call;
    expect(String(url)).toBe(`${apiUrl}/rest/v1/`);
    expect(options?.method).toBe('GET');
    expect(options?.redirect).toBe('error');
    expect(options?.body).toBeUndefined();
    expect(options?.headers).toEqual({ apikey: apiKey, Accept: 'application/openapi+json' });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(['PGRST000', 'PGRST001', 'PGRST002'])('retries only recognized 503 connection errors: %s', async (code) => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ code, message: apiKey }, 503))
      .mockResolvedValueOnce(response(signature()));
    await expect(waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() }))
      .resolves.toEqual({ attempts: 2, elapsedMs: 250 });
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'])(
    'retries recognized connection transport failures: %s', async (code) => {
      const fetchImpl = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError(apiKey, { cause: { code, message: apiKey } }))
        .mockResolvedValueOnce(response(signature()));
      await expect(waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() }))
        .resolves.toEqual({ attempts: 2, elapsedMs: 250 });
    },
  );

  it.each([
    [401, 'PGRST301'], [403, '42501'], [404, 'PGRST202'], [400, 'P0001'],
    [500, '40P01'], [500, 'PGRST300'], [503, '23514'], [504, 'PGRST003'], [503, apiKey],
  ])('fails immediately for HTTP %i code %s', async (status, code) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ code, message: apiKey, hint: apiKey }, status as number));
    const failure = await waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() }).catch((error: LocalPostgrestReadinessError) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as LocalPostgrestReadinessError).message).toBe('LOCAL_POSTGREST_READINESS_FATAL');
    expect(JSON.stringify(failure)).not.toContain(apiKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('fails immediately when the RPC or exact argument signature is missing', async () => {
    const missingArgument = signature();
    missingArgument.paths['/rpc/process_due_assignment_lifecycle'].post.parameters[0]?.schema.required.pop();
    const wrongFormat = signature();
    const wrongParameter = wrongFormat.paths['/rpc/process_due_assignment_lifecycle'].post.parameters[0];
    if (!wrongParameter) throw new Error('Expected source-controlled signature fixture');
    wrongParameter.schema.properties.p_actor_profile_id.format = 'text';
    const invalidSpecs = [
      {}, { swagger: '2.0', paths: {} },
      { ...signature(), swagger: '3.0' },
      missingArgument, wrongFormat,
    ];
    for (const spec of invalidSpecs) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(spec));
      await expect(waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() }))
        .rejects.toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_FATAL', summary: { reason: 'rpc_signature_unavailable' } });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('fails immediately for malformed JSON and unknown thrown errors without revealing them', async () => {
    for (const fetchImpl of [
      vi.fn<typeof fetch>().mockResolvedValue(new Response(apiKey, { status: 200 })),
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError(`redirect ${apiKey}`)),
      vi.fn<typeof fetch>().mockRejectedValue({ code: apiKey, message: apiKey, cause: { code: 'ENOTFOUND', message: apiKey } }),
    ]) {
      const failure = await waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() }).catch((error: LocalPostgrestReadinessError) => error);
      expect((failure as LocalPostgrestReadinessError).message).toBe('LOCAL_POSTGREST_READINESS_FATAL');
      expect(JSON.stringify(failure)).not.toContain(apiKey);
      expect((failure as Error).cause).toBeUndefined();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it('enforces both a finite probe count and the total retry deadline', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response({ code: 'PGRST002' }, 503));
    await expect(waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, maxAttempts: 2, ...fakeTime() }))
      .rejects.toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_TIMEOUT', summary: { attempts: 2, elapsedMs: 250, status: 503, code: 'PGRST002' } });
    fetchImpl.mockClear();
    await expect(waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, maxTotalMs: 1000, requestTimeoutMs: 500, intervalMs: 600, ...fakeTime() }))
      .rejects.toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_TIMEOUT', summary: { attempts: 2, elapsedMs: 1000 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('aborts and bounds a hung fetch even if it ignores AbortSignal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>(() => {}));
    const result = waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, nowImpl: () => Date.now(), maxTotalMs: 30, requestTimeoutMs: 10, intervalMs: 5 })
      .catch((error: LocalPostgrestReadinessError) => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_TIMEOUT', summary: { attempts: 2, elapsedMs: 30 } });
    expect(fetchImpl.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('applies the same deadline to a stalled response body', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream(), { status: 200 }));
    const result = waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, nowImpl: () => Date.now(), maxTotalMs: 10, requestTimeoutMs: 10, intervalMs: 1 })
      .catch((error: LocalPostgrestReadinessError) => error);
    await vi.advanceTimersByTimeAsync(10);
    expect(await result).toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_TIMEOUT', summary: { attempts: 1, elapsedMs: 10, status: null, code: null } });
    expect(fetchImpl.mock.calls.every(([, options]) => options?.signal?.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects an oversized index before decoding or logging sensitive response data', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(apiKey.repeat(150_000)));
    const failure = await waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...fakeTime() })
      .catch((error: LocalPostgrestReadinessError) => error);
    expect(failure).toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_FATAL', summary: { reason: 'invalid_response', attempts: 1, status: 200 } });
    expect(JSON.stringify(failure)).not.toContain(apiKey);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    'https://127.0.0.1:54321', 'http://example.com', 'http://127.0.0.1.example.com',
    'http://127.0.0.1@example.com', 'http://user:password@localhost:54321',
    'http://localhost:54321/other', 'http://localhost:54321?secret=value', 'http://localhost:54321#secret',
  ])('rejects remote or ambiguous API URLs without network calls: %s', async (url) => {
    const fetchImpl = vi.fn<typeof fetch>();
    await expect(waitForLocalPostgrestReady({ apiUrl: url, apiKey, fetchImpl }))
      .rejects.toMatchObject({ message: 'LOCAL_POSTGREST_READINESS_INVALID_CONFIG', summary: { attempts: 0, elapsedMs: 0 } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects excessive budgets and unsafe header keys with a redacted configuration error', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    for (const options of [{ maxTotalMs: 30_001 }, { maxAttempts: 31 }, { requestTimeoutMs: 0 }, { intervalMs: 0 }, { apiKey: `${apiKey}\nsecret` }]) {
      const failure = await waitForLocalPostgrestReady({ apiUrl, apiKey, fetchImpl, ...options })
        .catch((error: LocalPostgrestReadinessError) => error);
      expect((failure as LocalPostgrestReadinessError).message).toBe('LOCAL_POSTGREST_READINESS_INVALID_CONFIG');
      expect(JSON.stringify(failure)).not.toContain(apiKey);
      expect(fetchImpl).not.toHaveBeenCalled();
    }
  });
});
