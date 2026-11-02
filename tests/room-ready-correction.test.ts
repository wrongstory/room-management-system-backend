import Fastify from 'fastify';
import { ZodError } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { AppError } from '../src/lib/app-error.js';
import { requestHash } from '../src/lib/command.js';
import { SupabaseRoomService } from '../src/modules/rooms/room.service.js';
import { createRoomRoutes } from '../src/modules/rooms/room.routes.js';
import { parseRoomReadyCorrectionRequest, parseRoomReadyPreviewRequest, parseRoomReadyPreview, parseRoomReadyCorrectionResult,
  roomReadyErrors, type RoomReadyPreview, type RoomReadyCorrectionResult } from '../src/modules/rooms/room-ready-correction-contract.js';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const roomId = '10000000-0000-4000-8000-000000000142';
const sessionId = '20000000-0000-4000-8000-000000000001';
const targetId = '30000000-0000-4000-8000-000000000001';
const assignmentId = '40000000-0000-4000-8000-000000000001';
const attemptId = '50000000-0000-4000-8000-000000000001';
const actor: Actor = { profileId: sessionId, authUserId: sessionId, role: 'admin', displayName: '합성 관리자', mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature` };
const previewBody = { targetStatus: 'READY', reasonCode: 'ADMIN_ROOM_READY_CORRECTION' } as const;
const proof = { impactFingerprint: 'a'.repeat(64), evaluatedAt: '2026-10-30T03:00:00.123456Z', expiresAt: '2026-10-30T03:05:00.123456Z' };
const commitBody = { ...previewBody, expectedRoomVersion: 9, ...proof, confirmed: true,
  acknowledgeNoNewEarnings: true, confirmPhysicalCandleRemoval: true } as const;
const preview: RoomReadyPreview = { roomId, targetStatus: 'READY', roomStateVersion: 9, canApply: true, blockingReasons: [],
  requiresConfirmation: true, requiresEarningAcknowledgement: true, effects: {
    cleaningTargets: [{ cleaningTargetId: targetId, assignmentId, attemptId, attemptStatus: 'submitted', hasSubmission: true, fieldCompleted: true }],
    operationBlockIds: [assignmentId], roomIssueIds: [attemptId], candleCount: 2, displayStatusOverride: 'READY',
  }, warnings: ['CANCEL_WITHOUT_NEW_EARNINGS', 'APPROVE_BEFORE_CANCEL_TO_PRESERVE_EARNINGS', 'PHYSICAL_CANDLE_REMOVAL_REQUIRED'], ...proof };
const result: RoomReadyCorrectionResult = { roomId, targetStatus: 'READY', roomStateVersion: 10, recordedAt: '2026-10-30T03:01:00Z',
  cancelledCleaningTargetIds: [targetId], releasedOperationBlockIds: [assignmentId], resolvedRoomIssueIds: [attemptId], candlesCleared: true };
const edge = await import(new URL('../supabase/functions/_shared/room-api.ts', import.meta.url).href) as {
  previewRoomReadyCorrection(request: Request, clients: SupabaseClients, actor: Actor, roomId: string): Promise<RoomReadyPreview>;
  applyRoomReadyCorrection(request: Request, clients: SupabaseClients, actor: Actor, roomId: string): Promise<RoomReadyCorrectionResult>;
  roomReadyCorrectionPath(path: string): { roomId: string; preview: boolean } | null;
  roomDatabaseError(error: { message: string }): { status: number; code: string; message: string };
  listRoomEvents(request: Request, clients: SupabaseClients, actor: Actor, roomId: string, limit: number): Promise<unknown>;
};
function fixture(data: unknown, message?: string) {
  const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data, error: message ? { message } : null }));
  const clients = { admin: { rpc } } as unknown as SupabaseClients;
  return { rpc, clients, service: new SupabaseRoomService(clients) };
}
function request(body: unknown, token = actor.accessToken, key: string | null = 'ready-correction-test-1', suffix = '') {
  return new Request(`https://example.invalid/v1/rooms/${roomId}/ready-correction${suffix}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(body) });
}

describe('room-ready correction shared contract', () => {
  it('requires a concrete READY intent and rejects authority or effect injection', () => {
    expect(parseRoomReadyPreviewRequest(previewBody)).toEqual(previewBody);
    for (const body of [null, [], {}, { targetStatus: 'READY' }, { ...previewBody, targetStatus: 'OCCUPIED' },
      { ...previewBody, reasonCode: 'OTHER' }, { ...previewBody, actorProfileId: actor.profileId }, { ...previewBody, effects: {} }]) {
      expect(() => parseRoomReadyPreviewRequest(body)).toThrow();
    }
  });
  it('preserves exact proof timestamps and old proof for idempotent receipt replay', () => {
    expect(parseRoomReadyCorrectionRequest(commitBody)).toEqual(commitBody);
    const old = { ...commitBody, evaluatedAt: '2000-02-29T00:00:00+09:00', expiresAt: '2000-02-29T00:05:00+09:00' };
    expect(parseRoomReadyCorrectionRequest(old)).toEqual(old);
  });
  it.each([
    { confirmed: false }, { confirmed: 'true' }, { expectedRoomVersion: 0 }, { expectedRoomVersion: '9' }, { expectedRoomVersion: Number.MAX_SAFE_INTEGER + 1 },
    { impactFingerprint: 'A'.repeat(64) }, { impactFingerprint: 'a'.repeat(63) }, { acknowledgeNoNewEarnings: undefined }, { confirmPhysicalCandleRemoval: 'true' },
    { evaluatedAt: '2026-02-30T03:00:00Z' }, { evaluatedAt: '2026-10-30T03:00Z' }, { evaluatedAt: '2026-10-30T03:00:00' },
    { evaluatedAt: '2026-10-30T24:00:00Z' }, { evaluatedAt: '0000-10-30T03:00:00Z' }, { expiresAt: '2026-10-30T03:05:01.123456Z' },
    { expiresAt: '2026-10-30T03:05:00.1234567Z' }, { expiresAt: '2026-10-30T03:05:00.123457Z' }, { targetIds: [targetId] },
  ])('rejects malformed or expanded commit input %j', change => {
    expect(() => parseRoomReadyCorrectionRequest({ ...commitBody, ...change })).toThrow();
  });
  it('allowlists response properties at every level instead of returning provider or private state', () => {
    const data = { ...preview, customerName: 'sensitive', effects: { ...preview.effects, secret: 'sensitive',
      cleaningTargets: preview.effects.cleaningTargets.map(item => ({ ...item, pin: 'sensitive' })) } };
    expect(parseRoomReadyPreview(data, roomId)).toEqual(preview);
    expect(parseRoomReadyCorrectionResult({ ...result, privateLedger: 'sensitive' }, roomId)).toEqual(result);
  });
  it.each([
    { roomId: sessionId }, { roomStateVersion: '9' }, { requiresConfirmation: false }, { canApply: true, blockingReasons: ['OCCUPIED'] },
    { canApply: false, blockingReasons: [] }, { warnings: ['UNREVIEWED_DETAIL'] }, { requiresEarningAcknowledgement: false },
    { effects: { ...preview.effects, candleCount: -1 } }, { effects: { ...preview.effects, candleCount: 2147483648 } },
    { effects: { ...preview.effects, operationBlockIds: [assignmentId, assignmentId] } },
    { effects: { ...preview.effects, cleaningTargets: [preview.effects.cleaningTargets[0], preview.effects.cleaningTargets[0]] } },
    { effects: { ...preview.effects, cleaningTargets: [{ ...preview.effects.cleaningTargets[0], attemptStatus: 'private-status' }] } },
    { effects: { ...preview.effects, cleaningTargets: [{ ...preview.effects.cleaningTargets[0], attemptId: null }] } },
    { expiresAt: '2026-10-30T03:04:59Z' },
  ])('fails closed on unsafe or inconsistent preview %j', change => {
    expect(() => parseRoomReadyPreview({ ...preview, ...change }, roomId)).toThrow();
  });
  it('preserves blocked preview without treating it as command success', () => {
    const blocked = { ...preview, canApply: false, blockingReasons: ['OCCUPIED', 'RESERVATION_CURRENT', 'ASSIGNMENT_CHANGE_PENDING'] };
    expect(parseRoomReadyPreview(blocked, roomId)).toEqual(blocked);
  });
  it.each([{ roomId: sessionId }, { roomStateVersion: 0 }, { candlesCleared: 'true' }, { recordedAt: 'bad' },
    { cancelledCleaningTargetIds: [targetId, targetId] }, { resolvedRoomIssueIds: undefined }])('rejects invalid receipt %j', change => {
    expect(() => parseRoomReadyCorrectionResult({ ...result, ...change }, roomId)).toThrow();
  });
});

describe('Fastify and Edge room-ready service parity', () => {
  it('exposes only the five bounded audit summary fields in both room timelines', async () => {
    const summary = { roomStateVersion: 10, cancelledCleaningCount: 1, releasedOperationBlockCount: 1, resolvedRoomIssueCount: 1, candlesCleared: true };
    const event = { id: targetId, eventKey: `room_command:${targetId}`, source: 'room_command', category: 'room_configuration', eventType: 'room.ready_corrected',
      actorProfileId: actor.profileId, actorDisplayName: actor.displayName, entityId: roomId, reasonCode: previewBody.reasonCode,
      effectiveAt: result.recordedAt, recordedAt: result.recordedAt, reservationId: null, summary };
    const page = { roomId, roomStateVersion: 10, evaluatedAt: result.recordedAt, items: [event] };
    const test = fixture({ ...page, items: [{ ...event, summary: { ...summary, beforeState: { rawPin: 'private' }, targetIds: [targetId] } }] });
    expect(await test.service.listEvents(actor, roomId, 10)).toEqual(page);
    expect(await edge.listRoomEvents(request({}, actor.accessToken, null), test.clients, actor, roomId, 10)).toEqual(page);
    test.rpc.mockResolvedValue({ data: { ...page, items: [{ ...event, summary: { ...summary, cancelledCleaningCount: { rawPin: 'private' } } }] }, error: null });
    await expect(test.service.listEvents(actor, roomId, 10)).rejects.toMatchObject({ statusCode: 500 });
    await expect(edge.listRoomEvents(request({}, actor.accessToken, null), test.clients, actor, roomId, 10)).rejects.toMatchObject({ status: 500 });
  });
  it('binds actor/session and exact command proof, with identical hashes and stable retry', async () => {
    const node = fixture(result), deno = fixture(result);
    const input = { roomId, ...commitBody, idempotencyKey: 'ready-correction-test-1' };
    expect(await node.service.applyReadyCorrection(actor, input)).toEqual(result);
    expect(await node.service.applyReadyCorrection(actor, input)).toEqual(result);
    expect(await edge.applyRoomReadyCorrection(request(commitBody), deno.clients, actor, roomId)).toEqual(result);
    const expected = { p_actor_profile_id: actor.profileId, p_session_id: sessionId, p_room_id: roomId,
      p_expected_room_version: 9, p_impact_fingerprint: proof.impactFingerprint, p_evaluated_at: proof.evaluatedAt, p_expires_at: proof.expiresAt,
      p_confirmed: true, p_acknowledge_no_new_earnings: true, p_confirm_physical_candle_removal: true,
      p_reason_code: previewBody.reasonCode, p_idempotency_key: input.idempotencyKey, p_request_hash: requestHash({ roomId, ...commitBody }) };
    expect(node.rpc.mock.calls).toEqual([['apply_room_ready_correction', expected], ['apply_room_ready_correction', expected]]);
    expect(deno.rpc.mock.calls).toEqual([['apply_room_ready_correction', expected]]);
    await node.service.applyReadyCorrection(actor, { ...input, acknowledgeNoNewEarnings: false });
    expect(node.rpc.mock.calls[2]?.[1].p_request_hash).not.toBe(expected.p_request_hash);
    await node.service.applyReadyCorrection(actor, { ...input, idempotencyKey: 'ready-correction-test-2' });
    expect(node.rpc.mock.calls[3]?.[1].p_request_hash).toBe(expected.p_request_hash);
    for (const field of Object.keys({ roomId, ...commitBody })) {
      expect(requestHash({ roomId, ...commitBody, [field]: 'changed' })).not.toBe(expected.p_request_hash);
    }
  });
  it('uses a dedicated read-only RPC for the complete confirmation preview', async () => {
    const node = fixture(preview), deno = fixture(preview);
    expect(await node.service.previewReadyCorrection(actor, { roomId, ...previewBody })).toEqual(preview);
    expect(await edge.previewRoomReadyCorrection(request(previewBody, actor.accessToken, null), deno.clients, actor, roomId)).toEqual(preview);
    expect(node.rpc.mock.calls).toEqual([['preview_room_ready_correction', { p_actor_profile_id: actor.profileId,
      p_session_id: sessionId, p_room_id: roomId, p_reason_code: previewBody.reasonCode }]]);
    expect(deno.rpc.mock.calls).toEqual(node.rpc.mock.calls);
  });
  it.each(['developer', 'maid'] as const)('denies %s before issuing any RPC', async role => {
    const test = fixture(preview), denied = { ...actor, role };
    await expect(test.service.previewReadyCorrection(denied, { roomId, ...previewBody })).rejects.toMatchObject({ statusCode: 403 });
    await expect(test.service.applyReadyCorrection(denied, { roomId, ...commitBody, idempotencyKey: 'ready-correction-test-1' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(edge.previewRoomReadyCorrection(request(previewBody), test.clients, denied, roomId)).rejects.toMatchObject({ status: 403 });
    await expect(edge.applyRoomReadyCorrection(request(commitBody), test.clients, denied, roomId)).rejects.toMatchObject({ status: 403 });
    expect(test.rpc).not.toHaveBeenCalled();
  });
  it('rejects incomplete password state and invalid sessions before RPC', async () => {
    const test = fixture(preview);
    await expect(test.service.previewReadyCorrection({ ...actor, mustChangePassword: true }, { roomId, ...previewBody })).rejects.toMatchObject({ statusCode: 403 });
    await expect(edge.previewRoomReadyCorrection(request(previewBody), test.clients, { ...actor, mustChangePassword: true }, roomId)).rejects.toMatchObject({ status: 403 });
    for (const accessToken of ['invalid', `e30.${Buffer.from(JSON.stringify({ session_id: '-'.repeat(36) })).toString('base64url')}.sig`]) {
      await expect(test.service.previewReadyCorrection({ ...actor, accessToken }, { roomId, ...previewBody })).rejects.toMatchObject({ statusCode: 401 });
      await expect(edge.previewRoomReadyCorrection(request(previewBody, accessToken), test.clients, actor, roomId)).rejects.toMatchObject({ status: 401 });
    }
    expect(test.rpc).not.toHaveBeenCalled();
  });
  it.each(roomReadyErrors)('maps %s consistently and never exposes raw DB error detail', async (code, status, message) => {
    const test = fixture(null, `${code}: private provider detail`);
    await expect(test.service.applyReadyCorrection(actor, { roomId, ...commitBody, idempotencyKey: 'ready-correction-test-1' }))
      .rejects.toMatchObject({ statusCode: status, code, message });
    await expect(edge.applyRoomReadyCorrection(request(commitBody), test.clients, actor, roomId)).rejects.toMatchObject({ status, code, message });
  });
  it('maps a DB session revocation after HTTP authentication to an authorization failure', async () => {
    const test = fixture(null, 'SESSION_REVOKED');
    await expect(test.service.previewReadyCorrection(actor, { roomId, ...previewBody })).rejects.toMatchObject({ statusCode: 401 });
    await expect(edge.previewRoomReadyCorrection(request(previewBody), test.clients, actor, roomId)).rejects.toMatchObject({ status: 401 });
  });
  it('rejects missing idempotency and injected query without RPC', async () => {
    const test = fixture(result);
    await expect(edge.applyRoomReadyCorrection(request(commitBody, actor.accessToken, null), test.clients, actor, roomId)).rejects.toMatchObject({ status: 400 });
    await expect(edge.previewRoomReadyCorrection(request(previewBody, actor.accessToken, null, '?actorProfileId=other'), test.clients, actor, roomId)).rejects.toMatchObject({ status: 400 });
    expect(test.rpc).not.toHaveBeenCalled();
  });
  it('has exact path matching and denies malformed room identities', () => {
    expect(edge.roomReadyCorrectionPath(`/v1/rooms/${roomId}/ready-correction/preview`)).toEqual({ roomId, preview: true });
    expect(edge.roomReadyCorrectionPath(`/v1/rooms/${roomId}/ready-correction`)).toEqual({ roomId, preview: false });
    for (const suffix of ['/sibling', '/preview/sibling', '/preview/']) expect(edge.roomReadyCorrectionPath(`/v1/rooms/${roomId}/ready-correction${suffix}`)).toBeNull();
    expect(() => edge.roomReadyCorrectionPath('/v1/rooms/not-id/ready-correction')).toThrow();
  });
});

describe('room-ready Fastify HTTP and Swagger contract', () => {
  it('registers exact preview/commit envelopes, no-store, strict body and idempotency boundary', async () => {
    const test = fixture(preview), app = Fastify();
    const noop = async () => {};
    app.decorate('authenticate', noop); app.decorate('requirePasswordChanged', noop); app.decorate('requireAdmin', noop);
    app.addHook('preHandler', async req => { req.actor = actor; });
    app.setErrorHandler((error, _req, reply) => reply.code(error instanceof ZodError ? 400 : error instanceof AppError ? error.statusCode : 500)
      .send({ error: { code: error instanceof AppError ? error.code : 'VALIDATION_ERROR' } }));
    await app.register(createRoomRoutes(test.service), { prefix: '/v1/rooms' });
    try {
      const url = `/v1/rooms/${roomId}/ready-correction`;
      const read = await app.inject({ method: 'POST', url: `${url}/preview`, payload: previewBody });
      expect(read.statusCode).toBe(200); expect(read.headers['cache-control']).toBe('no-store'); expect(read.json()).toEqual({ preview });
      test.rpc.mockResolvedValue({ data: result, error: null });
      const commit = await app.inject({ method: 'POST', url, payload: commitBody, headers: { 'idempotency-key': 'ready-correction-test-1' } });
      expect(commit.statusCode).toBe(200); expect(commit.headers['cache-control']).toBe('no-store'); expect(commit.json()).toEqual({ correction: result });
      const before = test.rpc.mock.calls.length;
      for (const input of [
        { url, payload: commitBody }, { url, payload: { ...commitBody, confirmed: false } },
        { url: `${url}?target=other`, payload: commitBody }, { url: `${url}/preview`, payload: { ...previewBody, actorProfileId: sessionId } },
      ]) expect((await app.inject({ method: 'POST', ...input })).statusCode).toBe(400);
      for (const method of ['GET', 'DELETE', 'PATCH'] as const) expect((await app.inject({ method, url })).statusCode).toBe(404);
      expect(test.rpc.mock.calls.length).toBe(before);
    } finally { await app.close(); }
  });
  it('documents mandatory confirmation, earning acknowledgement, candidate status and unchanged display-only API', () => {
    const paths = openApiDocument.paths;
    const read = paths['/v1/rooms/{roomId}/ready-correction/preview'].post;
    const write = paths['/v1/rooms/{roomId}/ready-correction'].post;
    expect(read).toMatchObject({ operationId: 'previewRoomReadyCorrection', 'x-required-roles': ['admin'], 'x-release-status': 'candidate' });
    expect(write).toMatchObject({ operationId: 'applyRoomReadyCorrection', 'x-required-roles': ['admin'], 'x-release-status': 'candidate' });
    expect(read.parameters).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key' })]));
    expect(write.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Idempotency-Key', required: true })]));
    expect(openApiDocument.components.schemas.RoomReadyCorrectionRequest.required).toEqual(expect.arrayContaining([
      'confirmed', 'acknowledgeNoNewEarnings', 'confirmPhysicalCandleRemoval', 'impactFingerprint', 'expectedRoomVersion', 'evaluatedAt', 'expiresAt',
    ]));
    expect(write.description).toContain('미승인 제출'); expect(write.description).toContain('기존 확정 수당');
    expect(openApiDocument.components.schemas.ErrorCode.enum).toEqual(expect.arrayContaining(['CLEANING_DUE_REPLAN_REQUIRED', ...roomReadyErrors.map(([code]) => code)]));
    expect(paths['/v1/rooms/{roomId}/display-status-overrides'].post.description).toContain('bookability');
  });
});
