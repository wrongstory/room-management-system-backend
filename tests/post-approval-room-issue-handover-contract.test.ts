import { describe, expect, it } from 'vitest';
import { requestHash } from '../src/lib/command.js';
import {
  POST_APPROVAL_ROOM_ISSUE_HANDOVER_COMMAND,
  preparePostApprovalRoomIssueHandover,
  validatePostApprovalRoomIssueHandover
} from '../src/modules/post-approval-room-issues/post-approval-room-issue-handover-contract.js';
import { POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND } from '../src/modules/post-approval-room-issues/post-approval-room-issue-upload-contract.js';

const id = (n: number) => `abcdef00-0000-4000-8000-${String(n).padStart(12, '0')}`;
const actor = { actorProfileId: id(1), sessionId: id(2) };
const input = { operationId: id(3), expectedLeaseVersion: 1 };
const key = 'handover-key-0001';

describe('post-approval evidence handover request foundation', () => {
  it.each([0, 1, 7])('accepts expected fence version %s without resetting it', version => {
    expect(validatePostApprovalRoomIssueHandover({ ...input, expectedLeaseVersion: version }).expectedLeaseVersion).toBe(version);
  });
  it.each([-1, 8, 9, 1.5, Number.MAX_SAFE_INTEGER, NaN, Infinity, '1', null, undefined])(
    'rejects invalid or exhausted expected version %s', version => {
      expect(() => validatePostApprovalRoomIssueHandover({ ...input, expectedLeaseVersion: version })).toThrow();
    }
  );
  it.each(['targetActorId', 'actorProfileId', 'originalUploaderId', 'sessionId', 'fenceTokenDigest',
    'providerFileId', 'fileName', 'quotaPermitId', 'status', 'force'])('rejects injected %s', field => {
    expect(() => validatePostApprovalRoomIssueHandover({ ...input, [field]: 'injected' })).toThrow();
  });
  it.each([null, {}, [], { ...input, operationId: 'invalid' }])('rejects malformed request %#', value => {
    expect(() => validatePostApprovalRoomIssueHandover(value)).toThrow();
  });
  it('normalizes UUIDs and freezes nested request/actor values', () => {
    const result = preparePostApprovalRoomIssueHandover({ actorProfileId: id(1).toUpperCase(), sessionId: id(2).toUpperCase() },
      { ...input, operationId: id(3).toUpperCase() }, key);
    expect(result.actor).toEqual(actor);
    expect(result.input).toEqual(input);
    expect([result, result.actor, result.input].every(Object.isFrozen)).toBe(true);
  });
  it('preserves identity across session refresh, never across actors', () => {
    const first = preparePostApprovalRoomIssueHandover(actor, input, key);
    const refresh = preparePostApprovalRoomIssueHandover({ ...actor, sessionId: id(9) }, input, key);
    expect(refresh.idempotencyKeyDigest).toBe(first.idempotencyKeyDigest);
    expect(refresh.requestHash).toBe(first.requestHash);
    const other = preparePostApprovalRoomIssueHandover({ ...actor, actorProfileId: id(9) }, input, key);
    expect(other.idempotencyKeyDigest).not.toBe(first.idempotencyKeyDigest);
    expect(other.requestHash).not.toBe(first.requestHash);
  });
  it.each([{ ...input, operationId: id(9) }, { ...input, expectedLeaseVersion: 2 }])(
    'binds payload changes without creating a fresh receipt scope %#', changed => {
      const first = preparePostApprovalRoomIssueHandover(actor, input, key);
      const next = preparePostApprovalRoomIssueHandover(actor, changed, key);
      expect(next.idempotencyKeyDigest).toBe(first.idempotencyKeyDigest);
      expect(next.requestHash).not.toBe(first.requestHash);
    }
  );
  it('uses an independent command scope from uploading bytes', () => {
    const result = preparePostApprovalRoomIssueHandover(actor, input, key);
    expect(POST_APPROVAL_ROOM_ISSUE_HANDOVER_COMMAND).not.toBe(POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND);
    expect(result.idempotencyKeyDigest).not.toBe(requestHash({ actorProfileId: actor.actorProfileId,
      command: POST_APPROVAL_ROOM_ISSUE_UPLOAD_COMMAND, idempotencyKey: key }));
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each(['short', 'x'.repeat(129), 'spaces invalid', 'slash/key', null, 123])('rejects invalid key %#', value => {
    expect(() => preparePostApprovalRoomIssueHandover(actor, input, value)).toThrow();
  });
  it.each([null, { ...actor, role: 'admin' }, { ...actor, sessionId: 'invalid' }])('rejects untrusted actor shape %#', value => {
    expect(() => preparePostApprovalRoomIssueHandover(value, input, key)).toThrow();
  });
  it('does not leak injected content in validation errors', () => {
    try {
      preparePostApprovalRoomIssueHandover(actor, { ...input, providerFileId: 'sensitive-marker' }, key);
      throw new Error('Expected validation failure');
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 400, code: 'VALIDATION_ERROR' });
      expect(String(error)).not.toContain('sensitive-marker');
    }
  });
});
