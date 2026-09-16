import { describe, expect, it } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  assertInspectionResponseSize,
  InspectionCursorCodec,
  inspectionCursorScope
} from '../src/modules/submissions/inspection-cursor.js';
import { SupabaseSubmissionService } from '../src/modules/submissions/submission.service.js';

const secret = 'inspection-cursor-secret-tests-1234567';
const id = (n: number) => `94000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sessionId = id(90);
const token = () => `header.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`;
const actor = (profile = id(1)): Actor => ({
  authUserId: id(91),
  profileId: profile,
  displayName: 'admin',
  role: 'admin',
  mustChangePassword: false,
  accessToken: token()
});
const submission = (n: number, submittedAt = '2026-09-16T00:00:00Z') => ({
  id: id(n),
  attemptId: id(100 + n),
  version: 1,
  status: 'submitted',
  submittedBy: id(30),
  submittedAt,
  currentRevision: 1,
  current: true,
  photoCount: 1,
  candleCount: 0,
  reviewContext: {
    cleaningTargetId: id(200 + n),
    cleaningKind: 'additional',
    roomNumber: String(100 + n),
    serviceDate: '2026-09-16',
    maidProfileId: id(30),
    providerLocator: 'must-not-leak'
  },
  requestHash: 'must-not-leak'
});

describe('inspection queue cursor and page contract', () => {
  it('binds a signed cursor to the exact admin and queue scope', () => {
    const codec = new InspectionCursorCodec(secret);
    const scope = inspectionCursorScope(actor());
    const cursor = codec.encode(scope, { submittedAt: '2026-09-16T00:00:00Z', id: id(2) });
    expect(codec.decode(cursor, scope)).toEqual({
      submittedAt: '2026-09-16T00:00:00Z',
      id: id(2)
    });
    expect(() => codec.decode(`${cursor.slice(0, -1)}A`, scope)).toThrowError(
      expect.objectContaining({ code: 'INVALID_INSPECTION_CURSOR' })
    );
    expect(() => codec.decode(cursor, inspectionCursorScope(actor(id(2))))).toThrowError(
      expect.objectContaining({ code: 'INVALID_INSPECTION_CURSOR' })
    );
    expect(() => new InspectionCursorCodec('short')).toThrowError(
      expect.objectContaining({ code: 'INSPECTION_CURSOR_NOT_CONFIGURED' })
    );
  });

  it('continues equal timestamps with the id tie-breaker and strips private fields', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const pages = [
      {
        submissions: [submission(1), submission(2)],
        hasMore: true,
        lastSubmittedAt: '2026-09-16T00:00:00Z',
        lastId: id(2)
      },
      {
        submissions: [submission(3, '2026-09-16T00:00:01Z')],
        hasMore: false,
        lastSubmittedAt: null,
        lastId: null
      }
    ];
    const clients = {
      admin: {
        rpc: async (name: string, args: Record<string, unknown>) => {
          expect(name).toBe('list_cleaning_inspections_page');
          calls.push(args);
          return { data: pages.shift(), error: null };
        }
      }
    } as unknown as SupabaseClients;
    const service = new SupabaseSubmissionService(clients, secret);
    const first = await service.listPending(actor(), { limit: 2 });
    expect(first.submissions).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(JSON.stringify(first)).not.toMatch(/must-not-leak|providerLocator|requestHash/);
    const second = await service.listPending(actor(), { limit: 2, cursor: first.nextCursor as string });
    expect(second).toEqual({
      submissions: [expect.objectContaining({ id: id(3) })],
      hasMore: false,
      nextCursor: null
    });
    expect(calls[0]).toEqual(expect.objectContaining({
      p_session_id: sessionId,
      p_after_submitted_at: null,
      p_after_id: null,
      p_limit: 2
    }));
    expect(calls[1]).toEqual(expect.objectContaining({
      p_after_submitted_at: '2026-09-16T00:00:00Z',
      p_after_id: id(2)
    }));
  });

  it('rejects malformed cursors before the RPC and fails closed on oversized responses', async () => {
    let calls = 0;
    const clients = {
      admin: { rpc: async () => { calls += 1; return { data: null, error: null }; } }
    } as unknown as SupabaseClients;
    const service = new SupabaseSubmissionService(clients, secret);
    await expect(service.listPending(actor(), { cursor: 'not-a-signed-cursor' })).rejects.toMatchObject({
      code: 'INVALID_INSPECTION_CURSOR'
    });
    expect(calls).toBe(0);
    expect(() => assertInspectionResponseSize({ submissions: [{ value: '가'.repeat(50_000) }] }))
      .toThrowError(expect.objectContaining({ code: 'INSPECTION_RESPONSE_TOO_LARGE' }));
  });
});
