import { execFileSync } from 'node:child_process';
import Fastify from 'fastify';
import { createClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admissionConfig, assertAdmissionTarget, admittedRpc, beginHttpAdmission, httpAdmissionRoute,
  type AdmissionRpc, HttpAdmissionError, withAdmissionRpc, withAtomicAdmissionRpc } from '../src/modules/developer-reset/http-admission.js';
import { installHttpAdmission } from '../src/modules/developer-reset/http-admission-node.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { AppError } from '../src/lib/app-error.js';
import { createPhotoRoutes, type PhotoHttpServices } from '../src/modules/photos/photo.routes.js';
import { PhotoError } from '../src/modules/photos/photo-binary.js';

const actor = { profileId: '00000000-0000-4000-8000-000000000001',
  authUserId: '00000000-0000-4000-8000-000000000002', sessionId: '00000000-0000-4000-8000-000000000003' };
const admissionId = '00000000-0000-4000-8000-000000000004';
const config = { target: 'test-project', budgetMs: 10000 };
const command = 'create_reservation_v2';
const args = { p_actor_profile_id: actor.profileId, p_idempotency_key: 'test-command-key', p_request_hash: 'a'.repeat(64) };
const route = httpAdmissionRoute('POST', '/v1/reservations');
afterEach(() => vi.useRealTimers());
function fixture(mode = 'OPEN', opaque = false) {
  const rpc = vi.fn<AdmissionRpc>(async name => ({ data:
    name === 'get_operation_admission_control'
      ? { mode, controlVersion: mode === 'INACTIVE' ? null : '9007199254740993', targetRef: mode === 'INACTIVE' ? null : config.target }
      : name === 'acquire_operation_http_admission'
      ? { admissionId, controlVersion: '9007199254740993', completionMode: opaque ? 'OPAQUE' : 'COMMAND_RECEIPT' }
      : { completed: true }, error: null }));
  const identity = vi.fn(async () => actor);
  return { rpc, identity, input: { config, route, identity, rpc, nonce: () => 'b'.repeat(64) } };
}

describe('operation admission control and terminal evidence', () => {
  it('keeps the default disabled and requires an explicit observational budget', () => {
    expect(admissionConfig(undefined, undefined, undefined)).toBeUndefined();
    expect(admissionConfig('disabled', undefined, undefined)).toBeUndefined();
    for (const budget of [undefined, '', '0', '-1', 'NaN', '1.5', String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(() => admissionConfig('required', config.target, budget)).toThrow(HttpAdmissionError);
    }
    expect(admissionConfig('required', config.target, '10000')).toEqual(config);
  });
  it('disabled performs no observation or identity calls', async () => {
    const f = fixture();
    expect(await beginHttpAdmission({ ...f.input, config: undefined })).toBeUndefined();
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled();
  });
  it('binds an activated runtime to the trusted Supabase URL instead of a request target', () => {
    const production = { ...config, target: 'a'.repeat(20) };
    expect(() => assertAdmissionTarget(production, `https://${production.target}.supabase.co`)).not.toThrow();
    expect(() => assertAdmissionTarget(undefined, undefined)).not.toThrow();
    for (const url of [undefined, 'http://localhost:54321', `https://${'b'.repeat(20)}.supabase.co`,
      `http://${production.target}.supabase.co`, `https://${production.target}.supabase.co.evil.invalid`,
      `https://${production.target}.supabase.co/path`, `https://${production.target}.supabase.co?target=x`,
      `https://user@${production.target}.supabase.co`, `https://${production.target}.supabase.co:444`]) {
      expect(() => assertAdmissionTarget(production, url)).toThrow(HttpAdmissionError);
    }
  });
  it('bounds an unresponsive transport without claiming it stopped remotely', async () => {
    vi.useFakeTimers();
    const f = fixture(); let signal: AbortSignal | undefined;
    f.rpc.mockImplementation(async (_name, _args, current) => { signal = current; return new Promise(() => {}); });
    const observed = beginHttpAdmission({ ...f.input, config: { ...config, budgetMs: 5 } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(6); expect(await observed).toBeInstanceOf(HttpAdmissionError);
    expect(signal?.aborted).toBe(true); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('bounds identity observation before creating any admission when Auth never responds', async () => {
    vi.useFakeTimers();
    const f = fixture(); let signal: AbortSignal | undefined;
    const observed = beginHttpAdmission({ ...f.input, config: { ...config, budgetMs: 5 }, identity: current => {
      signal = current; return new Promise(() => {});
    } }).catch(error => error);
    await vi.advanceTimersByTimeAsync(6); expect(await observed).toBeInstanceOf(HttpAdmissionError);
    expect(signal?.aborted).toBe(true);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['get_operation_admission_control']);
  });
  it('bounds effect response loss without a retry or a fictional terminal receipt', async () => {
    vi.useFakeTimers();
    const f = fixture(); const scope = await beginHttpAdmission({ ...f.input, config: { ...config, budgetMs: 20 } });
    let signal: AbortSignal | undefined; const invoke = vi.fn((current: AbortSignal): Promise<unknown> => {
      signal = current; return new Promise(() => {});
    });
    const observed = scope?.execute(command, args, invoke).catch(error => error);
    await vi.advanceTimersByTimeAsync(21); expect(await observed).toBeInstanceOf(HttpAdmissionError);
    expect(invoke).toHaveBeenCalledTimes(1); expect(signal?.aborted).toBe(true);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['get_operation_admission_control', 'acquire_operation_http_admission']);
  });
  it('a genuinely absent control preserves existing work without authenticating twice', async () => {
    const f = fixture('INACTIVE');
    expect(await beginHttpAdmission(f.input)).toBeUndefined();
    expect(f.rpc).toHaveBeenCalledTimes(1); expect(f.identity).not.toHaveBeenCalled();
  });
  it.each(['UNKNOWN', 'REQUESTED', 'invalid'])('blocks %s before business or Auth effects', async mode => {
    const f = fixture(mode);
    await expect(beginHttpAdmission(f.input)).rejects.toThrow(HttpAdmissionError);
    expect(f.identity).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed and mismatched target/control observations', async () => {
    for (const data of [null, [], {}, { mode: 'INACTIVE', controlVersion: '1', targetRef: null },
      { mode: 'OPEN', controlVersion: '1', targetRef: 'another-project' },
      { mode: 'OPEN', controlVersion: 1, targetRef: config.target },
      { mode: 'OPEN', controlVersion: '9223372036854775808', targetRef: config.target },
      { mode: 'OPEN', controlVersion: '1', targetRef: config.target, ready: true }]) {
      const f = fixture(); f.rpc.mockResolvedValueOnce({ data, error: null });
      await expect(beginHttpAdmission(f.input)).rejects.toThrow(HttpAdmissionError);
    }
  });
  it('waits until exact service arguments exist; takes no lease for body validation failures', async () => {
    const f = fixture(); await beginHttpAdmission(f.input);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['get_operation_admission_control']);
  });
  it('passes the actual fingerprint and bigint version; probes the DB after success', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    const invoke = vi.fn(async () => ({ data: { result: 1 }, error: null }));
    expect(await scope?.execute(command, args, invoke)).toEqual({ data: { result: 1 }, error: null });
    expect(f.rpc.mock.calls[1]?.[1]).toMatchObject({ p_version: '9007199254740993',
      p_route_id: 'createReservation', p_command_name: 'reservation.create', p_request_hash: args.p_request_hash,
      p_actor: actor.profileId, p_auth: actor.authUserId, p_session: actor.sessionId, p_idempotency_key: args.p_idempotency_key });
    expect(f.rpc.mock.calls[2]?.[0]).toBe('complete_operation_http_admission');
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('the acquire-side maintenance race denies execution despite an earlier OPEN observation', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    f.rpc.mockResolvedValueOnce({ data: null, error: { message: 'REQUESTED' } });
    const invoke = vi.fn(async () => 'not reached');
    await expect(scope?.execute(command, args, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(invoke).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it.each(['actor', 'key', 'hash', 'rpc'])('rejects changed %s binding before acquisition', async field => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    const changed = { ...args };
    if (field === 'actor') changed.p_actor_profile_id = admissionId;
    if (field === 'key') changed.p_idempotency_key = 'short';
    if (field === 'hash') changed.p_request_hash = 'not-a-hash';
    const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(field === 'rpc' ? 'change_reservation_v2' : command, changed, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(invoke).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('never reuses one admission for a second command', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    await scope?.execute(command, args, async () => 1);
    await expect(scope?.execute(command, args, async () => 2)).rejects.toThrow(HttpAdmissionError);
  });
  it('does readback on transport response loss but never substitutes it for the original error', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input); const lost = new Error('synthetic lost response');
    await expect(scope?.execute(command, args, async () => { throw lost; })).rejects.toBe(lost);
    expect(f.rpc.mock.calls[2]?.[0]).toBe('complete_operation_http_admission');
  });
  it('receipt absent, role/session revocation, malformed proof, or probe error retains the result and unresolved lease', async () => {
    for (const result of [{ data: null, error: { code: 'RECEIPT_ABSENT' } },
      { data: null, error: { code: 'SESSION_REVOKED' } }, { data: { completed: false }, error: null }]) {
      const f = fixture(); const scope = await beginHttpAdmission(f.input);
      f.rpc.mockImplementationOnce(async () => ({ data: { admissionId, controlVersion: '9007199254740993', completionMode: 'COMMAND_RECEIPT' }, error: null }))
        .mockResolvedValueOnce(result);
      expect(await scope?.execute(command, args, async () => 'business result')).toBe('business result');
      expect(f.rpc).toHaveBeenCalledTimes(3);
    }
  });
  it('expiry never completes an admission or starts a delayed command', async () => {
    let time = 1000; const f = fixture(); const scope = await beginHttpAdmission({ ...f.input, now: () => time });
    time += config.budgetMs;
    const invoke = vi.fn(async () => 1);
    await expect(scope?.execute(command, args, invoke)).rejects.toThrow(HttpAdmissionError);
    expect(invoke).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('completion after the budget expires remains UNKNOWN even when the response was successful', async () => {
    let time = 1000; const f = fixture(); const scope = await beginHttpAdmission({ ...f.input, now: () => time });
    expect(await scope?.execute(command, args, async () => { time += config.budgetMs; return 200; })).toBe(200);
    expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['get_operation_admission_control', 'acquire_operation_http_admission']);
  });
  it.each([['POST', '/v1/auth/login'], ['POST', '/v1/auth/password'], ['POST', '/v1/accounts'],
    ['POST', '/v1/attempts/a/photo-slots/s/upload'], ['POST', '/v1/rooms/a/pin/reveal']])(
    '%s %s is opaque and never receives generic completion', async (method, path) => {
      const f = fixture('OPEN', true);
      expect(await beginHttpAdmission({ ...f.input, route: httpAdmissionRoute(method, path) })).toBeUndefined();
      expect(f.rpc.mock.calls.map(([name]) => name)).toEqual(['get_operation_admission_control', 'acquire_operation_http_admission']);
      expect(f.rpc.mock.calls[1]?.[1]).toMatchObject({ p_request_hash: null, p_idempotency_key: null, p_command_name: null });
    });
  it('keeps current non-admitted calls and reads unchanged', async () => {
    const rpc = vi.fn(async () => ({ data: 1, error: null }));
    expect(await admittedRpc({ admin: { rpc } }, command, args)).toEqual({ data: 1, error: null });
    expect(httpAdmissionRoute('GET', '/v1/reservations')).toBeUndefined();
    expect(httpAdmissionRoute('POST', '/v1/%72eservations')).toBeUndefined();
    expect(httpAdmissionRoute('POST', '/v1/reservations?secret=x')).toBeUndefined();
    expect(httpAdmissionRoute('POST', '/v1/reservations/')).toEqual(route);
    expect(httpAdmissionRoute('POST', '/v1/reservations/transitions/process')?.commandName).toBe('reservation.process_due_transitions.v66');
  });
  it('has reproducible shared source and manifest', () => {
    execFileSync(process.execPath, ['scripts/generate-http-admission-edge.mjs', '--check']);
  });
  it('preserves real Supabase lazy/fluent builders and executes one admitted fetch across repeated await', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    const fetch = vi.fn(async () => new Response(JSON.stringify({ id: 1 }), { headers: { 'content-type': 'application/json' } }));
    const client = withAdmissionRpc(createClient('https://synthetic.invalid', 'synthetic-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
    }), () => scope);
    const query = client.rpc(command, args).abortSignal(new AbortController().signal).single();
    expect(fetch).not.toHaveBeenCalled(); expect(f.rpc).toHaveBeenCalledTimes(1);
    const [first, second] = await Promise.all([query, query]);
    expect(first.data).toEqual({ id: 1 }); expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1); expect(f.rpc).toHaveBeenCalledTimes(3);
  });
  it('passes the shared budget signal to a stuck SDK effect without discarding caller cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture(); const scope = await beginHttpAdmission({ ...f.input, config: { ...config, budgetMs: 20 } });
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_input: unknown, init?: RequestInit): Promise<Response> => { signal = init?.signal ?? undefined; return new Promise(() => {}); });
    const client = withAdmissionRpc(createClient('https://synthetic.invalid', 'synthetic-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
    }), () => scope);
    const caller = new AbortController();
    const observed = Promise.resolve(client.rpc(command, args).abortSignal(caller.signal)).catch(error => error);
    await vi.advanceTimersByTimeAsync(21); expect(await observed).toBeInstanceOf(HttpAdmissionError);
    expect(signal?.aborted).toBe(true); expect(caller.signal.aborted).toBe(false); expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.rpc).toHaveBeenCalledTimes(2);
  });
  it('does not turn a different RPC into an admitted terminal command', async () => {
    const f = fixture(); const scope = await beginHttpAdmission(f.input);
    const client = withAdmissionRpc(createClient('https://synthetic.invalid', 'synthetic-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: {
        fetch: async () => new Response(JSON.stringify({ data: 1 })),
      },
    }), () => scope);
    await client.rpc('get_reservation_detail', {}).maybeSingle();
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('passes only the finite availability hash fields to the DB canonicalizer', async () => {
    const f = fixture(); const scope = await beginHttpAdmission({ ...f.input,
      route: httpAdmissionRoute('POST', '/v1/availability/submissions') });
    const input = { p_actor_profile_id: actor.profileId, p_week_start: '2026-10-26',
      p_available_dates: ['2026-10-28', '2026-10-26'], p_expected_version: 0, p_idempotency_key: args.p_idempotency_key };
    await scope?.execute('submit_weekly_availability', input, async () => 1);
    expect(f.rpc.mock.calls[1]?.[1]).toMatchObject({ p_request_hash: null, p_command_name: 'availability.submit',
      p_command_args: { p_actor_profile_id: actor.profileId, p_week_start: input.p_week_start,
        p_available_dates: input.p_available_dates, p_expected_version: 0 } });
    expect((f.rpc.mock.calls[1]?.[1].p_command_args as object)).not.toHaveProperty('p_idempotency_key');
  });
  it('requires the fixed action for multiplexed room mutations', async () => {
    const f = fixture(); const scope = await beginHttpAdmission({ ...f.input,
      route: httpAdmissionRoute('POST', '/v1/rooms/room/operation-blocks') });
    await expect(scope?.execute('mutate_room_operation', { ...args, p_action: 'release_block' }, async () => 1)).rejects.toThrow(HttpAdmissionError);
    expect(f.rpc).toHaveBeenCalledTimes(1);
  });
  it('does not accumulate leases for read-only previews or the retired 410 policy', async () => {
    const f = fixture();
    for (const path of ['/v1/reservations/bookability/preview', '/v1/reservations/id/room-change/preview',
      '/v1/assignments/preview', '/v1/assignment-preview/duration-policy', '/v1/notifications/id/read']) {
      expect(await beginHttpAdmission({ ...f.input, route: httpAdmissionRoute('POST', path) })).toBeUndefined();
    }
    expect(f.rpc).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled();
  });
  it('keeps an already digested postapproval key exact rather than hashing or logging it again', async () => {
    const f = fixture(); const scope = await beginHttpAdmission({ ...f.input,
      route: httpAdmissionRoute('POST', '/v1/cleaning-history/submissions/id/supplemental-room-issues/drafts') });
    const digest = 'c'.repeat(64);
    await scope?.execute('save_post_approval_room_issue_draft', { p_actor_profile_id: actor.profileId,
      p_idempotency_key_digest: digest, p_request_hash: args.p_request_hash }, async () => 1);
    expect(f.rpc.mock.calls[1]?.[1].p_idempotency_key).toBe(digest);
    expect(f.rpc.mock.calls[1]?.[1].p_command_args).toBeNull();
  });
  it('accepts the finite tomorrow assignment alias with the same terminal command', async () => {
    const f = fixture(); const scope = await beginHttpAdmission({ ...f.input,
      route: httpAdmissionRoute('POST', '/v1/assignments/target/change') });
    expect(scope?.matches('change_cleaning_assignment_for_plan')).toBe(true);
    expect(scope?.matches('arbitrary_command')).toBe(false);
    await scope?.execute('change_cleaning_assignment_for_plan', args, async () => 1);
    expect(f.rpc.mock.calls[1]?.[1].p_command_name).toBe('assignment.prestart_change');
  });
  it('observes account unlock as a DB command while retaining Auth admission kind', async () => {
    const f = fixture(); const unlock = httpAdmissionRoute('POST', '/v1/accounts/id/unlock');
    expect(unlock?.kind).toBe('AUTH_WRITE');
    const scope = await beginHttpAdmission({ ...f.input, route: unlock });
    await scope?.execute('unlock_account', args, async () => ({ data: {}, error: null }));
    expect(f.rpc.mock.calls[1]?.[1]).toMatchObject({ p_route_id: 'unlockAccount', p_command_name: 'account.unlock', p_request_hash: args.p_request_hash });
    expect(f.rpc.mock.calls[2]?.[0]).toBe('complete_operation_http_admission');
  });
});

describe('fixed atomic RPC protection before HTTP scope creation', () => {
  const denial = { p_actor_profile_id: actor.profileId, p_source: 'edge.authorization.photos', p_reason_code: 'FORBIDDEN' };
  function atomicFixture(mode = 'OPEN') {
    const names: string[] = [];
    const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
      const name = String(_input).split('/').at(-1) ?? ''; names.push(name);
      const body = JSON.parse(String(init?.body));
      const data = name === 'get_operation_admission_control'
        ? { mode, controlVersion: mode === 'INACTIVE' ? null : '1', targetRef: mode === 'INACTIVE' ? null : config.target }
        : { result: body.p_rpc_name === 'mark_notification_read' ? { id: actor.profileId, read_at: '2026-10-25T00:00:00Z' } : null };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    });
    const raw = createClient('https://synthetic.invalid', 'synthetic-anon-key', {
      auth: { persistSession: false, autoRefreshToken: false }, global: { fetch },
    });
    const client = withAtomicAdmissionRpc(raw, { config, error: () => new HttpAdmissionError('OPERATION_ATOMIC_RPC_UNAVAILABLE') });
    return { names, fetch, raw, client };
  }
  it.each(['OPEN', 'INACTIVE'])('rechecks %s in the atomic transaction without ever calling the original effect', async mode => {
    const f = atomicFixture(mode); const query = f.client.rpc('record_authorization_denial', denial);
    expect(f.fetch).not.toHaveBeenCalled();
    const [first, repeated] = await Promise.all([query, query]);
    expect(first).toEqual({ data: null, error: null }); expect(repeated).toEqual(first);
    expect(f.names).toEqual(['get_operation_admission_control', 'execute_operation_atomic_rpc']);
    const input = JSON.parse(String(f.fetch.mock.calls[1]?.[1]?.body));
    expect(input).toMatchObject({ p_version: mode === 'INACTIVE' ? null : '1', p_rpc_name: 'record_authorization_denial', p_args: denial });
    expect(input.p_args).not.toHaveProperty('p_occurred_at'); // Keep the existing DB clock default.
  });
  it('retains mark-read JSON while avoiding an outer opaque admission', async () => {
    const f = atomicFixture();
    const result = await f.client.rpc('mark_notification_read', { p_actor_profile_id: actor.profileId,
      p_session_id: actor.sessionId, p_notification_id: admissionId });
    expect(result.data).toEqual({ id: actor.profileId, read_at: '2026-10-25T00:00:00Z' });
    expect(f.names).not.toContain('acquire_operation_http_admission');
  });
  it('does not convert a failure of the atomic operation into a successful audit', async () => {
    const f = atomicFixture(); const error = { code: 'P0001', message: 'synthetic domain rejection' };
    f.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ mode: 'OPEN', controlVersion: '1', targetRef: config.target })))
      .mockResolvedValueOnce(new Response(JSON.stringify(error), { status: 400 }));
    const result = await f.client.rpc('record_authorization_denial', denial);
    expect(result.error).toMatchObject(error); expect(result.data).toBeNull();
    expect(f.names).not.toContain('record_authorization_denial');
  });
  it('maintenance denies a pre-handler audit without any write or fictional completion', async () => {
    const app = Fastify(); const f = atomicFixture('REQUESTED');
    app.get('/synthetic-read', { preHandler: async () => {
      await f.client.rpc('record_authorization_denial', denial);
    } }, async () => ({ shouldNotRun: true }));
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof HttpAdmissionError ? 503 : 500).send({ error: 'blocked' }));
    try {
      expect((await app.inject('/synthetic-read')).statusCode).toBe(503);
      expect(f.names).toEqual(['get_operation_admission_control']);
    } finally { await app.close(); }
  });
  it('aborting a lazy fixed call before execution starts sends no RPC', async () => {
    const f = atomicFixture(); const controller = new AbortController();
    const query = f.client.rpc('record_unknown_login_failure', {}).abortSignal(controller.signal);
    controller.abort(); await expect(Promise.resolve(query)).rejects.toThrow(HttpAdmissionError);
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it('does not redirect unrelated RPCs through an atomic mutation dispatcher', async () => {
    const f = atomicFixture(); await f.client.rpc('get_reservation_detail', {});
    expect(f.names).toEqual(['get_reservation_detail']);
  });
});

it('Fastify authenticates before admission and isolates interleaved command contexts', async () => {
  const app = Fastify(); const f = fixture(); const called: string[] = [];
  app.decorateRequest('actor');
  const client = { admin: { rpc: vi.fn(async (_name, input) => {
    called.push(input.p_idempotency_key); await new Promise(resolve => setTimeout(resolve, 2));
    return { data: input.p_idempotency_key, error: null };
  }) } } as unknown as SupabaseClients;
  client.operationAdmission = installHttpAdmission(app, { config, clients: () => client, rpc: f.rpc });
  client.admin = withAdmissionRpc(client.admin, client.operationAdmission);
  app.register(async child => {
    child.post('/', { preHandler: async request => {
      request.actor = { ...actor, displayName: 'synthetic', role: 'admin', mustChangePassword: false, accessToken: '' };
    } }, async request => {
      return await client.admin.rpc(command, { ...args, p_idempotency_key: request.headers['idempotency-key'] });
    });
  }, { prefix: '/v1/reservations' });
  const token = `header.${Buffer.from(JSON.stringify({ session_id: actor.sessionId })).toString('base64url')}.signature`;
  try {
    const responses = await Promise.all(['request-key-a', 'request-key-b'].map(key => app.inject({
      method: 'POST', url: '/v1/reservations', headers: { authorization: `Bearer ${token}`, 'idempotency-key': key }, payload: {},
    })));
    expect(responses.map(response => response.statusCode)).toEqual([200, 200]);
    expect(called.sort()).toEqual(['request-key-a', 'request-key-b']);
    const acquired = f.rpc.mock.calls.filter(([name]) => name === 'acquire_operation_http_admission');
    expect(acquired).toHaveLength(2);
    expect(new Set(acquired.map(([, input]) => input.p_nonce)).size).toBe(2);
    expect(client.operationAdmission?.()).toBeUndefined();
  } finally { await app.close(); }
});

it('the existing photo error handler preserves maintenance admission as 503 before upload work', async () => {
  const app = Fastify(); const f = fixture('REQUESTED');
  installHttpAdmission(app, { config, clients: () => ({}) as SupabaseClients, rpc: f.rpc });
  await app.register(createPhotoRoutes({
    authenticate: async () => ({ profileId: actor.profileId, sessionId: actor.sessionId, role: 'maid', profileStatus: 'active' }),
    service: {}, denied: async () => { throw new Error('no authorization denial'); },
  } as unknown as PhotoHttpServices));
  try {
    const response = await app.inject({ method: 'POST', url: `/v1/attempts/${admissionId}/photo-slots/${admissionId}/upload`,
      headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('synthetic') });
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('OPERATION_MAINTENANCE_REQUESTED');
    expect(f.rpc).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});

it('a blocked photo denial audit preserves atomic unavailable instead of inventing an audit success', async () => {
  const app = Fastify(); const denied = vi.fn(async () => { throw new AppError(503, 'OPERATION_ATOMIC_RPC_UNAVAILABLE', 'unavailable'); });
  await app.register(createPhotoRoutes({
    authenticate: async () => ({ profileId: actor.profileId, sessionId: actor.sessionId, role: 'maid', profileStatus: 'active' }),
    service: { withTiming: () => ({ content: async () => { throw new PhotoError(403, 'PHOTO_ACCESS_REQUIRED'); } }) }, denied,
  } as unknown as PhotoHttpServices));
  try {
    const response = await app.inject(`/v1/photos/${admissionId}/content`);
    expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('OPERATION_ATOMIC_RPC_UNAVAILABLE');
    expect(denied).toHaveBeenCalledTimes(1);
  } finally { await app.close(); }
});
