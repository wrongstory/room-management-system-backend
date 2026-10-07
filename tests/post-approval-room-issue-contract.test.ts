import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/app-error.js';
import { requestHash } from '../src/lib/command.js';
import {
  POST_APPROVAL_ROOM_ISSUE_DRAFT_COMMAND,
  POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND,
  preparePostApprovalRoomIssueDraft,
  preparePostApprovalRoomIssueFinalization,
  projectPostApprovalRoomIssueDraft,
  projectPostApprovalRoomIssueReport,
  projectPostApprovalRoomIssueReportRead,
  projectPostApprovalRoomIssueReportList,
  projectPostApprovalRoomIssueSource,
  validatePostApprovalRoomIssueDraft,
  validatePostApprovalRoomIssueFinalization
} from '../src/modules/post-approval-room-issues/post-approval-room-issue-contract.js';

const id = (n: number) => `ABCDEF00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = () => ({ actorProfileId: id(1), sessionId: id(2) });
const draft = () => ({ clientReportId: id(3), sourceSubmissionId: id(4), expectedDraftRevision: 0, memo: '  새로 발견한 특이사항  ' });
const evidence = (count = 1) => Array.from({ length: count }, (_, displayOrder) => ({ evidenceId: id(displayOrder + 10), revision: 1, displayOrder }));
const complete = () => ({ ...draft(), expectedDraftRevision: 1, expectedEvidenceRevision: 1, evidence: evidence() });
const source = () => ({ sourceSubmissionId: id(4), originalPerformerProfileId: id(1), sourceStatus: 'submitted' });
const report = () => ({ reportId: id(5), clientReportId: id(3), sourceSubmissionId: id(4),
  originalPerformerProfileId: id(1), reportedByProfileId: id(1), reportedAt: '2000-01-01T00:00:00Z',
  memo: '특이사항', evidence: evidence() });
const key = 'synthetic-report-key';

describe('post-approval room issue pure contract foundation (no endpoint or DB authorization)', () => {
  it('reads current closure without changing immutable finalize projections', () => {
    const open = { ...report(), closureRevision: 0, closedAt: null, closedByProfileId: null };
    const closed = { ...report(), closureRevision: 1, closedAt: '2000-01-02T00:00:00Z', closedByProfileId: id(9) };
    expect(projectPostApprovalRoomIssueReportRead(open).closureRevision).toBe(0);
    expect(projectPostApprovalRoomIssueReportRead(closed)).toMatchObject({ closureRevision: 1, closedAt: closed.closedAt, closedByProfileId: id(9).toLowerCase() });
    expect(projectPostApprovalRoomIssueReportList([closed])[0]).toEqual(projectPostApprovalRoomIssueReportRead(closed));
    expect(projectPostApprovalRoomIssueReport(open)).toEqual(projectPostApprovalRoomIssueReport(closed));
    expect(projectPostApprovalRoomIssueReport(closed)).not.toHaveProperty('closureRevision');
  });
  it.each([
    {}, { closureRevision: 0, closedAt: '2000-01-02T00:00:00Z', closedByProfileId: id(9) },
    { closureRevision: 1, closedAt: null, closedByProfileId: id(9) },
    { closureRevision: 1, closedAt: '2000-01-02T00:00:00Z', closedByProfileId: null },
    { closureRevision: 2, closedAt: '2000-01-02T00:00:00Z', closedByProfileId: id(9) }
  ])('rejects incomplete or inconsistent current closure metadata %j', fields => {
    expect(() => projectPostApprovalRoomIssueReportRead({ ...report(), ...fields })).toThrow(AppError);
    expect(() => projectPostApprovalRoomIssueReportList([{ ...report(), ...fields }])).toThrow(AppError);
  });
  const access = () => ({ actorProfileId: id(40), sessionId: id(2), sourceSubmissionId: id(4),
    assignmentId: id(50), assignmentRevision: 1, notifiedAt: '2000-01-01T00:00:00Z' });
  it.each(['submitted', 'approved', 'rejected', 'superseded'])('projects a server-bound notified assignee for historical %s', sourceStatus => {
    const result = projectPostApprovalRoomIssueSource({ ...actor(), actorProfileId: id(40) }, 'maid',
      { ...source(), sourceStatus, notifiedAssignmentAccess: access() });
    expect(result.ownership).toBe('notified_assignee');
    expect(result.originalPerformerProfileId).toBe(id(1).toLowerCase());
    expect(Object.keys(result).sort()).toEqual(['sourceSubmissionId', 'originalPerformerProfileId', 'sourceStatus', 'ownership'].sort());
    expect(JSON.stringify(result)).not.toContain('assignmentId');
  });
  it.each([{ actorProfileId: id(41) }, { sessionId: id(42) }, { sourceSubmissionId: id(43) },
    { assignmentId: 'invalid' }, { assignmentRevision: 0 }, { notifiedAt: null }])('rejects unbound or invalid server grant %j', change => {
    expect(() => projectPostApprovalRoomIssueSource({ ...actor(), actorProfileId: id(40) }, 'maid',
      { ...source(), notifiedAssignmentAccess: { ...access(), ...change } })).toThrow(AppError);
  });
  it('never accepts assignment authority from client draft or finalization payload', () => {
    expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), notifiedAssignmentAccess: access() })).toThrow(AppError);
    expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), notifiedAssignmentAccess: access() })).toThrow(AppError);
    expect(() => projectPostApprovalRoomIssueSource({ ...actor(), actorProfileId: id(40) }, 'maid', source())).toThrow(AppError);
  });
  it('accepts a first draft at CAS0 and preserves nonblank memo text without trimming', () => {
    const result = validatePostApprovalRoomIssueDraft(draft());
    expect(result.expectedDraftRevision).toBe(0);
    expect(result.memo).toBe(draft().memo);
    expect(result.sourceSubmissionId).toBe(id(4).toLowerCase());
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each(['', ' ', '\t\r\n', '\u00a0', 'x'.repeat(501)])('rejects invalid memo %j', (memo) => {
    expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), memo })).toThrow(AppError);
    expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), memo })).toThrow(AppError);
  });

  it('accepts memo endpoints and rejects absent, non-string or silently coerced values', () => {
    for (const memo of ['가', '가'.repeat(500)]) {
      expect(validatePostApprovalRoomIssueDraft({ ...draft(), memo }).memo).toBe(memo);
      expect(validatePostApprovalRoomIssueFinalization({ ...complete(), memo }).memo).toBe(memo);
    }
    for (const memo of [null, undefined, 1, ['memo'], {}]) {
      expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), memo })).toThrow(AppError);
    }
  });

  it.each([-1, 0.5, '0', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid draft CAS %j', (expectedDraftRevision) => {
    expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), expectedDraftRevision })).toThrow(AppError);
    expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), expectedDraftRevision })).toThrow(AppError);
  });

  it('requires positive completion CAS and exact positive evidence revisions', () => {
    expect(validatePostApprovalRoomIssueDraft({ ...draft(), expectedDraftRevision: Number.MAX_SAFE_INTEGER - 1 }).expectedDraftRevision)
      .toBe(Number.MAX_SAFE_INTEGER - 1);
    expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), expectedDraftRevision: 0 })).toThrow(AppError);
    for (const expectedEvidenceRevision of [0, -1, 1.5, '1', undefined, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), expectedEvidenceRevision })).toThrow(AppError);
    }
    for (const revision of [0, -1, 0.5, '1', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), evidence: [{ ...evidence()[0], revision }] })).toThrow(AppError);
    }
  });

  it('separates incrementable draft CAS from maximum safe stored/sealed revisions', () => {
    expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), expectedDraftRevision: Number.MAX_SAFE_INTEGER })).toThrow(AppError);
    const sealed = validatePostApprovalRoomIssueFinalization({ ...complete(), expectedDraftRevision: Number.MAX_SAFE_INTEGER,
      expectedEvidenceRevision: Number.MAX_SAFE_INTEGER, evidence: [{ ...evidence()[0], revision: Number.MAX_SAFE_INTEGER }] });
    expect(sealed.expectedDraftRevision).toBe(Number.MAX_SAFE_INTEGER);
    expect(sealed.evidence[0]?.revision).toBe(Number.MAX_SAFE_INTEGER);
    expect(projectPostApprovalRoomIssueDraft({ ...draft(), draftRevision: Number.MAX_SAFE_INTEGER,
      evidenceRevision: 0, evidenceCount: 0 }).draftRevision).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('bounds completion evidence to 1..10, copies and freezes exact order and revision bindings', () => {
    for (const count of [1, 10]) {
      const input = { ...complete(), evidence: evidence(count) };
      const parsed = validatePostApprovalRoomIssueFinalization(input);
      expect(parsed.evidence).toHaveLength(count);
      expect(parsed.evidence.map((item) => item.displayOrder)).toEqual(Array.from({ length: count }, (_, i) => i));
      expect(Object.isFrozen(parsed.evidence)).toBe(true);
      expect(parsed.evidence.every(Object.isFrozen)).toBe(true);
      const firstInput = input.evidence[0];
      if (!firstInput) throw new Error('synthetic evidence fixture required');
      firstInput.revision = 2;
      expect(parsed.evidence[0]?.revision).toBe(1);
    }
    for (const items of [[], evidence(11), null, {}, 'photo']) {
      expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), evidence: items })).toThrow(AppError);
    }
  });

  it('rejects duplicate UUIDs including case variants, gaps, reversed order and forged evidence fields', () => {
    for (const items of [
      [evidence()[0], { ...evidence()[0], evidenceId: id(10).toLowerCase(), displayOrder: 1 }],
      [{ ...evidence()[0], displayOrder: 1 }],
      [evidence(2)[1], evidence(2)[0]],
      [{ ...evidence()[0], displayOrder: '0' }],
      [{ ...evidence()[0], providerLocator: 'synthetic_private' }],
      [{ ...evidence()[0], verified: true }]
    ]) expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), evidence: items })).toThrow(AppError);
  });

  it.each(['actor', 'actorProfileId', 'roomId', 'maidProfileId', 'role', 'sessionId', 'reportedAt', 'status',
    'provider', 'providerLocator', 'pin', 'inspectionDecision', 'payment', 'earningId', 'sourceStatus', 'idempotencyKey',
    'expectedRoomVersion', 'currentAssignmentId', 'submission', 'photos'])('rejects client authority or unrelated field %s', (field) => {
    expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), [field]: 'synthetic_forbidden' })).toThrow(AppError);
    expect(() => validatePostApprovalRoomIssueFinalization({ ...complete(), [field]: 'synthetic_forbidden' })).toThrow(AppError);
  });

  it('rejects invalid source/report identity and a nonexact server actor context', () => {
    for (const field of ['clientReportId', 'sourceSubmissionId']) {
      for (const value of ['not-a-uuid', null, undefined, 1]) {
        expect(() => validatePostApprovalRoomIssueDraft({ ...draft(), [field]: value })).toThrow(AppError);
      }
    }
    for (const invalidActor of [{ ...actor(), role: 'admin' }, { ...actor(), sessionId: undefined },
      { ...actor(), actorProfileId: 'unsafe' }, { ...actor(), sessionId: 'unsafe' }, null]) {
      expect(() => preparePostApprovalRoomIssueDraft(invalidActor, draft(), key)).toThrow(AppError);
    }
    expect(() => validatePostApprovalRoomIssueDraft([])).toThrow(AppError);
    expect(() => validatePostApprovalRoomIssueFinalization(null)).toThrow(AppError);
  });

  it('scopes keys by actor/command/raw key only and excludes refreshed session from retry identity', () => {
    const prepared = preparePostApprovalRoomIssueFinalization(actor(), complete(), key);
    expect(prepared).toEqual(preparePostApprovalRoomIssueFinalization(actor(), complete(), key));
    expect(prepared.command).toBe(POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND);
    expect(prepared.requestHash).toBe(requestHash({ actorProfileId: id(1).toLowerCase(),
      command: POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND, ...validatePostApprovalRoomIssueFinalization(complete()) }));
    expect(prepared.idempotencyKeyDigest).toBe(requestHash({ actorProfileId: id(1).toLowerCase(),
      command: POST_APPROVAL_ROOM_ISSUE_FINALIZE_COMMAND, idempotencyKey: key }));
    const renewed = preparePostApprovalRoomIssueFinalization({ ...actor(), sessionId: id(22) }, complete(), key);
    expect(renewed.requestHash).toBe(prepared.requestHash);
    expect(renewed.idempotencyKeyDigest).toBe(prepared.idempotencyKeyDigest);
    expect(renewed.actor.sessionId).not.toBe(prepared.actor.sessionId);
    const otherKey = preparePostApprovalRoomIssueFinalization(actor(), complete(), 'synthetic-other-key');
    expect(otherKey.requestHash).toBe(prepared.requestHash);
    expect(otherKey.idempotencyKeyDigest).not.toBe(prepared.idempotencyKeyDigest);
    for (const other of [
      preparePostApprovalRoomIssueFinalization({ ...actor(), actorProfileId: id(21) }, complete(), key),
      preparePostApprovalRoomIssueDraft(actor(), draft(), key)
    ]) {
      expect(other.requestHash).not.toBe(prepared.requestHash);
      expect(other.idempotencyKeyDigest).not.toBe(prepared.idempotencyKeyDigest);
    }
    expect(preparePostApprovalRoomIssueDraft(actor(), draft(), key).command).toBe(POST_APPROVAL_ROOM_ISSUE_DRAFT_COMMAND);
    expect(JSON.stringify(prepared)).not.toContain(key);
    expect(Object.isFrozen(prepared.actor)).toBe(true);
  });

  it.each(['sourceSubmissionId', 'clientReportId'])('keeps the receipt scope but changes payload hash when same raw key changes %s', (field) => {
    const originalDraft = preparePostApprovalRoomIssueDraft(actor(), draft(), key);
    const changedDraft = preparePostApprovalRoomIssueDraft(actor(), { ...draft(), [field]: id(23) }, key);
    expect(changedDraft.idempotencyKeyDigest).toBe(originalDraft.idempotencyKeyDigest);
    expect(changedDraft.requestHash).not.toBe(originalDraft.requestHash);
    const originalFinalization = preparePostApprovalRoomIssueFinalization(actor(), complete(), key);
    const changedFinalization = preparePostApprovalRoomIssueFinalization(actor(), { ...complete(), [field]: id(23) }, key);
    expect(changedFinalization.idempotencyKeyDigest).toBe(originalFinalization.idempotencyKeyDigest);
    expect(changedFinalization.requestHash).not.toBe(originalFinalization.requestHash);
    // These hash mismatches must become IDEMPOTENCY_KEY_REUSED/409 in the future receipt RPC, not a second command.
  });

  it('makes payload field/revision/order changes observable but preserves canonical property and UUID case identity', () => {
    const baselineInput = { ...complete(), evidence: evidence(2) };
    const baseline = preparePostApprovalRoomIssueFinalization(actor(), baselineInput, key);
    for (const patch of [{ memo: '변경된 내용' }, { expectedDraftRevision: 2 }, { expectedEvidenceRevision: 2 },
      { evidence: [{ ...evidence(2)[0], revision: 2 }, evidence(2)[1]] },
      { evidence: evidence(2).reverse().map((item, displayOrder) => ({ ...item, displayOrder })) }]) {
      const changed = preparePostApprovalRoomIssueFinalization(actor(), { ...baselineInput, ...patch }, key);
      expect(changed.idempotencyKeyDigest).toBe(baseline.idempotencyKeyDigest);
      expect(changed.requestHash).not.toBe(baseline.requestHash);
    }
    const reordered = Object.fromEntries(Object.entries(baselineInput).reverse());
    expect(preparePostApprovalRoomIssueFinalization(actor(), reordered, key).requestHash).toBe(baseline.requestHash);
    expect(preparePostApprovalRoomIssueFinalization(
      { actorProfileId: id(1).toLowerCase(), sessionId: id(2).toLowerCase() },
      { ...baselineInput, clientReportId: id(3).toLowerCase(), sourceSubmissionId: id(4).toLowerCase() }, key
    ).requestHash).toBe(baseline.requestHash);
  });

  it.each(['', 'short', 'x'.repeat(129), 'Bearer synthetic', null, 1])('rejects invalid raw key %j with safe errors', (invalidKey) => {
    expect(() => preparePostApprovalRoomIssueDraft(actor(), draft(), invalidKey)).toThrow(AppError);
  });

  it('projects historical source after rejection/replacement without authorizing new commands or another maid', () => {
    for (const sourceStatus of ['submitted', 'approved', 'rejected', 'superseded']) {
      expect(projectPostApprovalRoomIssueSource(actor(), 'maid', { ...source(), sourceStatus }).ownership).toBe('original_performer');
      expect(projectPostApprovalRoomIssueSource({ ...actor(), actorProfileId: id(40) }, 'admin', { ...source(), sourceStatus }).ownership).toBe('admin');
      expect(() => projectPostApprovalRoomIssueSource({ ...actor(), actorProfileId: id(40) }, 'maid',
        { ...source(), sourceStatus, currentAssigneeProfileId: id(40), current: true })).toThrow(AppError);
    }
    expect(() => projectPostApprovalRoomIssueSource(actor(), 'developer', source())).toThrow(AppError);
    for (const sourceStatus of ['draft', 'in_progress', 'approved_by_client']) {
      expect(() => projectPostApprovalRoomIssueSource(actor(), 'maid', { ...source(), sourceStatus })).toThrow(AppError);
    }
  });

  it('allowlists source/draft/report DTOs recursively without changing the original source DTO', () => {
    const forbidden = { providerLocator: 'synthetic_private', pin: 'synthetic_pin', sessionId: id(2),
      accessToken: 'synthetic_token', requestHash: 'a'.repeat(64), payment: {}, inspectionDecision: {},
      sourceSubmission: { photos: ['synthetic_original_photo'], earningId: id(99) }, roomIssues: [] };
    const rawSource = { ...source(), ...forbidden };
    const before = JSON.stringify(rawSource);
    expect(Object.keys(projectPostApprovalRoomIssueSource(actor(), 'maid', rawSource)).sort())
      .toEqual(['sourceSubmissionId', 'originalPerformerProfileId', 'sourceStatus', 'ownership'].sort());
    expect(JSON.stringify(rawSource)).toBe(before);
    const projectedDraft = projectPostApprovalRoomIssueDraft({ ...draft(), draftRevision: 1, evidenceRevision: 0, evidenceCount: 0, ...forbidden });
    expect(Object.keys(projectedDraft).sort()).toEqual(['clientReportId', 'sourceSubmissionId', 'draftRevision', 'evidenceRevision', 'evidenceCount', 'memo'].sort());
    const projectedReport = projectPostApprovalRoomIssueReport({ ...report(), ...forbidden,
      evidence: evidence().map((item) => ({ ...item, ...forbidden })) });
    expect(Object.keys(projectedReport).sort()).toEqual(Object.keys(report()).sort());
    expect(Object.keys(projectedReport.evidence[0] ?? {}).sort()).toEqual(['evidenceId', 'revision', 'displayOrder'].sort());
    expect(Object.isFrozen(projectedReport)).toBe(true);
    expect(Object.isFrozen(projectedReport.evidence)).toBe(true);
    expect(projectedReport.reportedAt).toBe('2000-01-01T00:00:00Z');
    for (const name of Object.keys(forbidden)) expect(projectedReport).not.toHaveProperty(name);
  });

  it('rejects malformed backend DTOs with safe fixed projection errors rather than false success or raw values', () => {
    for (const value of [null, [], { ...report(), memo: ' ' }, { ...report(), reportedAt: '2000-02-30T00:00:00Z' },
      { ...report(), evidence: [] }, { ...report(), reportedByProfileId: 'synthetic_secret' }]) {
      expect(() => projectPostApprovalRoomIssueReport(value)).toThrow(expect.objectContaining({
        statusCode: 500, code: 'POST_APPROVAL_ROOM_ISSUE_PROJECTION_INVALID'
      }));
    }
    expect(() => projectPostApprovalRoomIssueDraft({ ...draft(), draftRevision: 0, evidenceRevision: 0, evidenceCount: 0 })).toThrow(AppError);
    expect(() => projectPostApprovalRoomIssueDraft({ ...draft(), draftRevision: 1, evidenceRevision: 0, evidenceCount: 1 })).toThrow(AppError);
    const unsafe = { get reportId() { throw new Error('synthetic_private_locator'); } };
    expect(() => projectPostApprovalRoomIssueReport(unsafe)).toThrow('사후 특이사항 보고 계약을 확인해 주세요.');
  });
});
