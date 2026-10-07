import { describe, expect, it } from 'vitest';
import {
  AssignmentReadMetadataError, assignmentCancellationCapability,
  parseAssignmentReadMetadata, parseRoomTypeSnapshot
} from '../src/modules/assignments/assignment-preview-core.js';

const metadata = {
  cleaningKind: 'additional', sourceKind: 'manual_room_request',
  roomTypeCode: null, roomTypeName: null, elevatorZone: null,
  roomTypeSnapshot: { code: null, name: null, elevatorZone: null },
  feeSnapshot: 0, originalServiceDate: '2026-09-29', effectiveServiceDate: '2026-10-02',
  rolloverCount: 0, rolloverReason: null, canCancel: true, cancelReasonCode: null
};

describe('assignment read metadata safe contract', () => {
  it('whitelists known zero snapshot values and never copies raw nested metadata', () => {
    const projected = parseAssignmentReadMetadata({ ...metadata, sourceKey: 'private', domainIdentity: { private: true },
      roomTypeSnapshot: { ...metadata.roomTypeSnapshot, pin: 'private' } });
    expect(projected).toEqual(metadata);
    expect(JSON.stringify(projected)).not.toContain('private');
    expect(parseRoomTypeSnapshot({})).toEqual({ code: null, name: null, elevatorZone: null });
  });

  it('does not enrich an old receipt with fabricated room, fee, dates or rollover', () => {
    expect(parseAssignmentReadMetadata({ cleaningTargetId: 'old', serviceDate: '2026-10-02' })).toEqual({
      cleaningKind: null, sourceKind: null, roomTypeCode: null, roomTypeName: null, elevatorZone: null,
      roomTypeSnapshot: null, feeSnapshot: null, originalServiceDate: null, effectiveServiceDate: null,
      rolloverCount: null, rolloverReason: null, canCancel: false, cancelReasonCode: 'CAPABILITY_UNAVAILABLE'
    });
  });

  it.each(Object.keys(metadata))('rejects a partial new receipt missing %s', (key) => {
    const partial: Record<string, unknown> = { ...metadata };
    delete partial[key];
    expect(() => parseAssignmentReadMetadata(partial)).toThrow(AssignmentReadMetadataError);
  });

  it.each([
    { feeSnapshot: -1 }, { feeSnapshot: 0.5 }, { rolloverCount: -1 },
    { rolloverCount: 1, rolloverReason: null }, { rolloverCount: 0, rolloverReason: 'ROLLED_OVER_UNASSIGNED' },
    { rolloverCount: null, rolloverReason: 'ROLLED_OVER_NOT_STARTED' }, { rolloverReason: 'DATE_GAP' },
    { canCancel: 'true' }, { canCancel: true, cancelReasonCode: 'ADMIN_REQUIRED' },
    { canCancel: false, cancelReasonCode: null }, { canCancel: false, cancelReasonCode: 'PIN_DISCLOSED' },
    { originalServiceDate: '2026-02-30' }, { effectiveServiceDate: '2026-10-2' },
    { roomTypeSnapshot: [] }, { roomTypeSnapshot: {} },
    { roomTypeCode: 'standard' }, { roomTypeSnapshot: { code: 1234, name: null, elevatorZone: null } },
    { roomTypeSnapshot: { code: '', name: null, elevatorZone: null } },
    { roomTypeSnapshot: { code: null, name: false, elevatorZone: null } },
    { roomTypeSnapshot: { code: null, name: null, elevatorZone: ['A'] } },
    { roomTypeSnapshot: { code: undefined, name: null, elevatorZone: null } }
  ])('fails safe on malformed supplied metadata %j', (overrides) => {
    expect(() => parseAssignmentReadMetadata({ ...metadata, ...overrides })).toThrow(AssignmentReadMetadataError);
  });

  it.each([101, 1001])('preserves a valid canonical receipt snapshot name of %i characters', (length) => {
    const name = 'n'.repeat(length);
    const projected = parseAssignmentReadMetadata({ ...metadata, roomTypeName: name,
      roomTypeSnapshot: { code: null, name, elevatorZone: null } });
    expect(projected.roomTypeName).toBe(name);
    expect(projected.roomTypeSnapshot?.name).toBe(name);
    expect(parseRoomTypeSnapshot({ name })?.name).toBe(name);
  });

  it.each([{}, { code: '', name: '', elevatorZone: '' }, { code: 1234, name: false, elevatorZone: ['A'] }])(
    'normalizes only raw stored snapshot optional values: %j', (raw) => {
      expect(parseRoomTypeSnapshot(raw)).toEqual({ code: null, name: null, elevatorZone: null });
    });

  it('preserves actual source separately from kind and permits evidence-only rollover', () => {
    expect(parseAssignmentReadMetadata({ ...metadata, cleaningKind: 'checkout', sourceKind: 'manual_checkout',
      rolloverCount: 2, rolloverReason: 'ROLLED_OVER_NOT_STARTED' })).toMatchObject({
      cleaningKind: 'checkout', sourceKind: 'manual_checkout', rolloverCount: 2, rolloverReason: 'ROLLED_OVER_NOT_STARTED'
    });
  });

  it.each(['inspection_reclean', 'post_approval_complaint_reclean'])(
    'preserves actual reclean source %s, zero fee and nullable snapshots', (sourceKind) => {
      const reclean = { ...metadata, cleaningKind: 'reclean', sourceKind, feeSnapshot: 0,
        canCancel: false, cancelReasonCode: 'NOT_MANUAL_CLEANING_REQUEST' };
      expect(parseAssignmentReadMetadata(reclean)).toEqual(reclean);
      expect(parseAssignmentReadMetadata(reclean).roomTypeSnapshot).toEqual({ code: null, name: null, elevatorZone: null });
    });

  it('capability only considers exact-current supplied attempts, never PIN disclosure', () => {
    expect(assignmentCancellationCapability('admin', true, 'manual_room_request', 'notified', [
      { status: 'scheduled', started_at: null }, { status: 'superseded', started_at: '2026-10-02T01:00:00Z' }
    ])).toEqual({ canCancel: true, cancelReasonCode: null });
    expect(assignmentCancellationCapability('admin', true, 'scheduled_checkout', 'notified', []))
      .toEqual({ canCancel: false, cancelReasonCode: 'NOT_MANUAL_CLEANING_REQUEST' });
    expect(assignmentCancellationCapability('admin', true, null, 'notified', []))
      .toEqual({ canCancel: false, cancelReasonCode: 'CAPABILITY_UNAVAILABLE' });
  });
});
