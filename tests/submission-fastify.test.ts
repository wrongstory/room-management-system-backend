import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { createSubmissionRoutes, type AuthenticateLimitedSubmission } from '../src/modules/submissions/submission.routes.js';
import { SupabaseSubmissionService, type SubmissionActor, type SubmissionService } from '../src/modules/submissions/submission.service.js';
import type { SupabaseClients } from '../src/lib/supabase.js';

const id = (n: number) => `92000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = (role: Actor['role']): Actor => ({ authUserId: id(90), profileId: id(91), displayName: role, role, mustChangePassword: false, accessToken: 'transient-test-token' });

function service(calls: string[]): SubmissionService {
  return {
    async reportBomb() { calls.push('report'); return { id: id(1), attemptId: id(2), evidenceCount: 1 }; },
    async create() { calls.push('submit'); return { id: id(3), attemptId: id(2), version: 1 }; },
    async list(_actor, attemptId) { calls.push(attemptId ? 'history' : 'queue'); return []; },
    async detail() { calls.push('detail'); return { id: id(3) }; },
    async decideBomb() { calls.push('bomb-decision'); return { id: id(4) }; },
    async decide(_actor, _submissionId, decision) { calls.push(decision); return { decision }; }
  };
}

async function appFor(
  initial: Actor,
  calls: string[],
  limited?: AuthenticateLimitedSubmission,
  submissionService: SubmissionService = service(calls)
) {
  let current = initial;
  const app = Fastify({ logger: false });
  app.decorateRequest('actor');
  app.decorate('authenticate', async (request) => { request.actor = current; });
  app.decorate('requirePasswordChanged', async (request) => {
    if (request.actor.mustChangePassword) throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '비밀번호 변경 필요');
  });
  app.decorate('requireAdmin', async (request) => {
    if (request.actor.role !== 'admin') throw new AppError(403, 'ADMIN_REQUIRED', '관리자 필요');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof AppError) return reply.code(error.statusCode).send({ error: { code: error.code } });
    if (error && typeof error === 'object' && 'issues' in error) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR' } });
    return reply.code(500).send({ error: { code: 'INTERNAL_SERVER_ERROR' } });
  });
  await app.register(createSubmissionRoutes(submissionService, limited));
  return { app, setActor: (value: Actor) => { current = value; } };
}

describe('Fastify submission/review parity', () => {
  it('allowlists nested bomb detail fields instead of exposing raw RPC state', async () => {
    const clients = {
      admin: {
        rpc: async () => ({
          error: null,
          data: {
            id: id(3),
            attemptId: id(2),
            status: 'submitted',
            requestHash: 'must-not-leak',
            bombReport: {
              id: id(4),
              attemptId: id(2),
              memo: '검수용 메모',
              evidenceCount: 1,
              evidencePhotoIds: [id(8)],
              reportedAt: '2026-09-09T00:00:00Z',
              providerLocator: 'must-not-leak',
              sha256: 'must-not-leak',
              before_state: { secret: true }
            },
            photos: [{
              photoId: id(8),
              targetPhotoSlotId: id(9),
              slotKey: 'proof',
              label: '완료 증빙',
              displayOrder: 0,
              required: true,
              photoVersion: 1,
              providerLocator: 'must-not-leak',
              sha256: 'must-not-leak',
              requestHash: 'must-not-leak'
            }],
            reviewContext: {
              cleaningTargetId: id(5),
              cleaningKind: 'additional',
              roomNumber: '101',
              serviceDate: '2026-09-09',
              maidProfileId: id(6),
              pin: 'must-not-leak',
              guestName: 'must-not-leak'
            }
          }
        })
      }
    } as unknown as SupabaseClients;
    const result = await new SupabaseSubmissionService(clients).detail(actor('admin'), id(3));
    expect(result).toEqual({
      id: id(3),
      attemptId: id(2),
      status: 'submitted',
      bombReport: {
        id: id(4),
        attemptId: id(2),
        memo: '검수용 메모',
        evidenceCount: 1,
        evidencePhotoIds: [id(8)],
        reportedAt: '2026-09-09T00:00:00Z'
      },
      photos: [{
        photoId: id(8),
        targetPhotoSlotId: id(9),
        slotKey: 'proof',
        label: '완료 증빙',
        displayOrder: 0,
        required: true,
        photoVersion: 1
      }],
      reviewContext: {
        cleaningTargetId: id(5),
        cleaningKind: 'additional',
        roomNumber: '101',
        serviceDate: '2026-09-09',
        maidProfileId: id(6)
      }
    });
    expect(JSON.stringify(result)).not.toMatch(/requestHash|providerLocator|sha256|before_state|secret|pin|guestName/);
  });

  it('separates exact maid and business-admin route capabilities', async () => {
    const calls: string[] = [];
    const { app, setActor } = await appFor(actor('maid'), calls);
    try {
      const report = await app.inject({ method: 'POST', url: `/v1/attempts/${id(2)}/bomb-room-reports`, headers: { 'idempotency-key': 'bomb-key-01' }, payload: { evidencePhotoIds: [id(8)], memo: '합성 신고' } });
      expect(report.statusCode).toBe(201);
      const queue = await app.inject({ method: 'GET', url: '/v1/inspections' });
      expect(queue.statusCode).toBe(403);
      setActor(actor('admin'));
      const adminReport = await app.inject({ method: 'POST', url: `/v1/attempts/${id(2)}/bomb-room-reports`, headers: { 'idempotency-key': 'bomb-key-02' }, payload: { evidencePhotoIds: [id(8)], memo: '합성 신고' } });
      expect(adminReport.statusCode).toBe(403);
      const adminQueue = await app.inject({ method: 'GET', url: '/v1/inspections' });
      expect(adminQueue.statusCode).toBe(200);
      setActor(actor('developer'));
      expect((await app.inject({ method: 'GET', url: '/v1/inspections' })).statusCode).toBe(403);
      expect(calls).toEqual(['report', 'queue']);
    } finally { await app.close(); }
  });

  it('enforces source-controlled decision/reason pairs and exact paths', async () => {
    const calls: string[] = [];
    const { app } = await appFor(actor('admin'), calls);
    try {
      const arbitrary = await app.inject({ method: 'POST', url: `/v1/inspections/${id(3)}/approve`, headers: { 'idempotency-key': 'review-key-01' }, payload: { reasonCode: 'ARBITRARY_VALID_CODE' } });
      expect(arbitrary.statusCode).toBe(400);
      const wrongPair = await app.inject({ method: 'POST', url: `/v1/inspections/${id(3)}/bomb-room-decision`, headers: { 'idempotency-key': 'review-key-02' }, payload: { decision: 'approved', reasonCode: 'BOMB_NOT_CONFIRMED' } });
      expect(wrongPair.statusCode).toBe(400);
      const approved = await app.inject({ method: 'POST', url: `/v1/inspections/${id(3)}/approve`, headers: { 'idempotency-key': 'review-key-03' }, payload: { reasonCode: 'QUALITY_OK' } });
      expect(approved.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/v1/inspections/${id(3)}/approve` })).statusCode).toBe(404);
      expect(calls).toEqual(['approve']);
    } finally { await app.close(); }
  });

  it('rejects whitespace-only bomb memos and query aliases before service calls', async () => {
    const calls: string[] = [];
    const { app } = await appFor(actor('maid'), calls);
    try {
      const whitespace = await app.inject({ method: 'POST', url: `/v1/attempts/${id(2)}/bomb-room-reports`, headers: { 'idempotency-key': 'bomb-key-03' }, payload: { evidencePhotoIds: [id(8)], memo: '   ' } });
      expect(whitespace.statusCode).toBe(400);
      const queryAlias = await app.inject({ method: 'POST', url: `/v1/attempts/${id(2)}/submissions?unsafe=1`, headers: { 'idempotency-key': 'submit-key-01' }, payload: { clientSubmissionId: id(10), expectedRevision: 0, candleCount: 0 } });
      expect(queryAlias.statusCode).toBe(400);
      expect(calls).toEqual([]);
    } finally { await app.close(); }
  });

  it('uses the limited upload_submit identity only for submission and keeps capability denial stable', async () => {
    const calls: string[] = [];
    const uploadOnly: SubmissionActor = { profileId: id(92), role: 'maid', mustChangePassword: false };
    const { app } = await appFor(actor('admin'), calls, async () => uploadOnly);
    try {
      const response = await app.inject({ method: 'POST', url: `/v1/attempts/${id(2)}/submissions`, headers: { 'idempotency-key': 'limited-submit-01' }, payload: { clientSubmissionId: id(10), expectedRevision: 0, candleCount: 0 } });
      expect(response.statusCode).toBe(201);
      expect(calls).toEqual(['submit']);
    } finally { await app.close(); }

    for (const fixture of ['missing', 'expired', 'revoked', 'evidence-only', 'deactivation-pending']) {
      const deniedCalls: string[] = [];
      const deniedService = service(deniedCalls);
      const errorCode = fixture === 'deactivation-pending' ? 'SUBMISSION_ACCESS_REQUIRED' : 'CAPABILITY_ACCESS_REQUIRED';
      deniedService.create = async () => { throw new AppError(403, errorCode, fixture); };
      const deniedApp = await appFor(actor('admin'), deniedCalls, async () => uploadOnly, deniedService);
      try {
        const response = await deniedApp.app.inject({ method: 'POST', url: `/v1/attempts/${id(2)}/submissions`, headers: { 'idempotency-key': `limited-${fixture}-01` }, payload: { clientSubmissionId: id(10), expectedRevision: 0, candleCount: 0 } });
        expect(response.statusCode).toBe(403);
        expect(response.json().error.code).toBe(errorCode);
        expect(deniedCalls).toEqual([]);
      } finally { await deniedApp.app.close(); }
    }
  });
});
