import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { requestHash } from '../src/lib/command.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  decryptGuestName,
  encryptGuestName,
  normalizeGuestName
} from '../src/modules/reservations/guest-name-crypto.js';
import {
  ReservationCursorCodec,
  reservationCursorScope
} from '../src/modules/reservations/reservation-cursor.js';
import { SupabaseReservationService } from '../src/modules/reservations/reservation.service.js';
import { assertNoContactInformation } from '../src/modules/rooms/room.service.js';

const actor: Actor = {
  authUserId: 'auth-admin-1',
  profileId: 'admin-1',
  displayName: '관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: 'access-token'
};

const piiKey = Buffer.alloc(32, 7).toString('base64');
const guestNamePepper = 'reservation-guest-name-pepper-test-value';

const commandResult = {
  id: '41000000-0000-4000-8000-000000000001',
  room_id: '51000000-0000-4000-8000-000000000001',
  reservation_type: 'standard' as const,
  check_in_at: '2026-09-01T07:00:00+00:00',
  check_out_at: '2026-09-02T02:00:00+00:00',
  guest_count: 2,
  status: 'active' as const,
  preparation_obligation_id: '42000000-0000-4000-8000-000000000001',
  checkout_obligation_id: '43000000-0000-4000-8000-000000000001',
  version: 1,
  room_state_version: 2,
  actual_check_in_at: null,
  actual_checkout_at: null,
  cancelled_at: null,
  created_at: '2026-08-28T00:00:00+00:00',
  updated_at: '2026-08-28T00:00:00+00:00'
};

describe('reservation privacy and idempotency', () => {
  it('validates guest-name raw and normalized lengths before encryption', () => {
    expect(normalizeGuestName('가'.repeat(80))).toBe('가'.repeat(80));
    expect(() => normalizeGuestName('가'.repeat(81))).toThrowError(
      expect.objectContaining({ code: 'INVALID_GUEST_NAME' })
    );
    expect(() => normalizeGuestName(`${' '.repeat(80)}홍`)).toThrowError(
      expect.objectContaining({ code: 'INVALID_GUEST_NAME' })
    );
    expect(() => normalizeGuestName(' '.repeat(80))).toThrowError(
      expect.objectContaining({ code: 'INVALID_GUEST_NAME' })
    );
    expect(() => normalizeGuestName('\uFB03'.repeat(27))).toThrowError(
      expect.objectContaining({ code: 'INVALID_GUEST_NAME' })
    );
    expect(normalizeGuestName('  홍   길동  ')).toBe('홍 길동');
  });

  it('encrypts guest names with randomized AES-GCM envelopes', () => {
    const first = encryptGuestName(' 홍길동 ', piiKey, 'test-v1');
    const second = encryptGuestName('홍길동', piiKey, 'test-v1');

    expect(first).not.toBe(second);
    expect(first).not.toContain('홍길동');
    expect(decryptGuestName(first, piiKey, 'test-v1')).toBe('홍길동');
  });

  it('creates the same request hash even though encrypted payloads are randomized', async () => {
    const rpc = vi.fn(async (_name: string, _parameters: Record<string, unknown>) => ({
      data: commandResult,
      error: null
    }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(
      clients,
      piiKey,
      'test-v1',
      guestNamePepper
    );
    const input = {
      roomId: commandResult.room_id,
      reservationType: 'standard' as const,
      checkInAt: '2026-09-01T16:00:00+09:00',
      checkOutAt: '2026-09-02T11:00:00+09:00',
      guestCount: 2,
      guestName: '홍길동',
      expectedRoomVersion: 1,
      idempotencyKey: 'reservation-create-0001'
    };

    await service.create(actor, input);
    await service.create(actor, input);

    const first = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = rpc.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(first.p_request_hash).toBe(second.p_request_hash);
    expect(first.p_guest_name_encrypted).not.toBe(second.p_guest_name_encrypted);
    expect(String(first.p_guest_name_encrypted)).not.toContain('홍길동');
    expect(String(first.p_request_hash)).not.toBe(requestHash({
      roomId: input.roomId,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      guestCount: input.guestCount,
      guestName: '홍길동',
      expectedRoomVersion: input.expectedRoomVersion
    }));
  });

  it('passes long-stay identity and null checkout to the v2 command without inventing a checkout graph', async () => {
    const openEnded = {
      ...commandResult,
      reservation_type: 'long_stay' as const,
      check_out_at: null,
      checkout_obligation_id: null
    };
    const rpc = vi.fn(async () => ({ data: openEnded, error: null }));
    const clients = {
      admin: { rpc }, publicClient: {}, forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);

    const result = await service.create(actor, {
      roomId: openEnded.room_id,
      reservationType: 'long_stay',
      checkInAt: openEnded.check_in_at,
      checkOutAt: null,
      guestCount: 1,
      expectedRoomVersion: 1,
      idempotencyKey: 'reservation-open-ended-service-0001'
    });

    expect(result).toMatchObject({
      reservationType: 'long_stay',
      checkOutAt: null,
      checkoutObligationId: null
    });
    expect(rpc).toHaveBeenCalledWith('create_reservation_v2', expect.objectContaining({
      p_reservation_type: 'long_stay',
      p_check_out_at: null
    }));
  });

  it('keeps older encrypted names readable during key rotation', () => {
    const oldKey = Buffer.alloc(32, 3).toString('base64');
    const encrypted = encryptGuestName('홍길동', oldKey, 'old-v1');

    expect(decryptGuestName(encrypted, piiKey, 'test-v2', { 'old-v1': oldKey })).toBe('홍길동');
  });

  it('keeps the guest-name request fingerprint stable across encryption key rotation', async () => {
    const rpc = vi.fn(async (_name: string, _parameters: Record<string, unknown>) => ({
      data: commandResult,
      error: null
    }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const nextKey = Buffer.alloc(32, 9).toString('base64');
    const beforeRotation = new SupabaseReservationService(
      clients,
      piiKey,
      'test-v1',
      guestNamePepper
    );
    const afterRotation = new SupabaseReservationService(
      clients,
      nextKey,
      'test-v2',
      guestNamePepper,
      { 'test-v1': piiKey }
    );
    const input = {
      roomId: commandResult.room_id,
      reservationType: 'standard' as const,
      checkInAt: '2026-09-01T16:00:00+09:00',
      checkOutAt: '2026-09-02T11:00:00+09:00',
      guestCount: 2,
      guestName: '홍길동',
      expectedRoomVersion: 1,
      idempotencyKey: 'reservation-key-rotation-0001'
    };

    await beforeRotation.create(actor, input);
    await afterRotation.create(actor, input);

    const first = rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    const second = rpc.mock.calls[1]?.[1] as Record<string, unknown>;
    expect(first.p_request_hash).toBe(second.p_request_hash);
    expect(first.p_guest_name_encrypted).not.toBe(second.p_guest_name_encrypted);
  });

  it('omits guest names from lists and decrypts them only for a detail request', async () => {
    const encrypted = encryptGuestName('홍길동', piiKey, 'test-v1');
    const row = { ...commandResult, guest_name_encrypted: encrypted };
    const rpc = vi.fn(async (name: string) => ({
      data: name === 'list_reservations' ? [row] : [row],
      error: null
    }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(
      clients,
      piiKey,
      'test-v1',
      guestNamePepper
    );

    const list = await service.list(actor);
    const detail = await service.get(actor, commandResult.id);

    expect(list[0]).not.toHaveProperty('guestName');
    expect(detail.guestName).toBe('홍길동');
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      'list_reservations',
      'get_reservation_detail'
    ]);
  });

  it('pages bounded reservation ranges with an actor/filter scoped cursor and no PII', async () => {
    const rpc = vi.fn(async (_name: string, parameters: Record<string, unknown>) => ({
      data: {
        server_time: '2026-09-01T00:00:00Z',
        reservations: [{ ...commandResult, guest_name_encrypted: 'must-not-leak' }],
        has_more: parameters.p_after_id === null
      },
      error: null
    }));
    const clients = {
      admin: { rpc }, publicClient: {}, forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    const input = {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z',
      roomId: commandResult.room_id
    };

    const first = await service.listPage(actor, input);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(first)).not.toContain('must-not-leak');
    if (!first.nextCursor) throw new Error('expected cursor');
    const second = await service.listPage(actor, { ...input, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({
      p_after_check_in_at: commandResult.check_in_at,
      p_after_id: commandResult.id,
      p_limit: 50
    });
    await expect(service.listPage(actor, {
      ...input,
      roomId: '51000000-0000-4000-8000-000000000002',
      cursor: first.nextCursor
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_RESERVATION_CURSOR' });
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('rejects signed cursors whose keyset timestamp or UUID is malformed', () => {
    const codec = new ReservationCursorCodec(guestNamePepper);
    const scope = reservationCursorScope(actor, {
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z'
    });
    const malformed = codec.encode(scope, { checkInAt: 'not-a-timestamp', id: 'not-a-uuid' });
    expect(() => codec.decode(malformed, scope)).toThrowError(
      expect.objectContaining({ statusCode: 400, code: 'INVALID_RESERVATION_CURSOR' })
    );
  });

  it('keeps PIN readiness separate from interval bookability and permits no matches', async () => {
    let empty = false;
    const rpc = vi.fn(async () => ({
      data: {
        evaluated_at: '2026-09-01T00:00:00Z',
        candidates: empty ? [] : [{
          room_id: commandResult.room_id,
          room_number: '117',
          room_type_id: '52000000-0000-4000-8000-000000000001',
          room_state_version: 2,
          interval_bookable: true,
          check_in_ready: false,
          reason_codes: ['PIN_MISMATCH'],
          evaluated_at: '2026-09-01T00:00:00Z'
        }]
      },
      error: null
    }));
    const clients = {
      admin: { rpc }, publicClient: {}, forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    const input = {
      reservationType: 'standard' as const,
      checkInAt: '2026-10-01T16:00:00+09:00',
      checkOutAt: '2026-10-02T11:00:00+09:00',
      guestCount: 2,
      roomTypeIds: [],
      excludeReservationId: null
    };
    const preview = await service.previewBookability(actor, input);
    expect(preview.reservationType).toBe('standard');
    expect(preview.candidates[0]).toMatchObject({
      intervalBookable: true,
      checkInReady: false,
      reasonCodes: ['PIN_MISMATCH']
    });
    expect(preview.commitAuthority).toBe('CREATE_OR_CHANGE_REVALIDATES');
    expect(rpc).toHaveBeenLastCalledWith('preview_reservation_bookability', expect.objectContaining({
      p_reservation_type: 'standard',
      p_room_type_ids: null,
      p_exclude_reservation_id: null
    }));

    empty = true;
    await expect(service.previewBookability(actor, input)).resolves.toMatchObject({
      evaluatedAt: '2026-09-01T00:00:00Z',
      candidates: []
    });
  });

  it('allowlists room-move projections and fails closed on malformed DB values', async () => {
    const preview = {
      mode: 'BEFORE_CHECKIN', eligible: true, rejectionReasonCodes: [],
      blockingReasonCodes: [], warnings: [], targetBlockReasonCodes: [],
      sourceOutcome: { occupancyStatus: 'VACANT', readinessStatus: 'READY', stateVersion: 2 },
      targetOutcome: { occupancyStatus: 'VACANT', readinessStatus: 'READY', stateVersion: 3 },
      impactFingerprint: 'a'.repeat(64),
      evaluatedAt: '2026-09-01T00:00:00Z', expiresAt: '2026-09-01T00:05:00Z',
      effectiveAt: commandResult.check_in_at,
      reservationId: commandResult.id, reservationVersion: 1,
      stayId: '45000000-0000-4000-8000-000000000001', stayVersion: 1,
      sourceSegmentId: '46000000-0000-4000-8000-000000000001', sourceSegmentVersion: 1,
      sourceRoomId: commandResult.room_id, sourceRoomVersion: 2,
      targetRoomId: '51000000-0000-4000-8000-000000000002', targetRoomVersion: 3,
      reservationType: 'standard',
      checkInAt: commandResult.check_in_at, checkOutAt: commandResult.check_out_at,
      guestCount: 2, preparationObligationId: commandResult.preparation_obligation_id,
      checkoutObligationId: commandResult.checkout_obligation_id,
      checkoutObligationVersion: 1,
      plannedCheckoutTargetId: '44000000-0000-4000-8000-000000000001',
      plannedCheckoutTargetVersion: 1,
      guestName: 'must-not-leak'
    };
    const rpc = vi.fn(async () => ({ data: preview, error: null }));
    const clients = { admin: { rpc }, publicClient: {}, forAccessToken: vi.fn() } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    const input = {
      reservationId: commandResult.id,
      targetRoomId: preview.targetRoomId,
      reasonCode: 'GUEST_REQUEST' as const,
      expectedReservationVersion: 1,
      expectedSourceRoomVersion: 2,
      expectedTargetRoomVersion: 3
    };

    await expect(service.previewRoomMove(actor, input)).resolves.toMatchObject({
      preparationObligationId: commandResult.preparation_obligation_id
    });
    await expect(service.previewRoomMove(actor, input)).resolves.not.toHaveProperty('guestName');
    preview.evaluatedAt = '2026-02-29T00:00:00Z';
    await expect(service.previewRoomMove(actor, input)).rejects.toMatchObject({
      statusCode: 500,
      code: 'RESERVATION_PROJECTION_INVALID'
    });
    preview.evaluatedAt = '2026-09-01T00:00:00Z';
    preview.reservationId = 'not-a-uuid';
    await expect(service.previewRoomMove(actor, input)).rejects.toMatchObject({
      statusCode: 500,
      code: 'RESERVATION_PROJECTION_INVALID'
    });
  });

  it('maps an already-applied room move to the stable 409 contract', async () => {
    const conflict = {
      reloadResources: ['reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'],
      latestVersions: {
        reservationVersion: 2,
        sourceRoomVersion: 7,
        targetRoomVersion: 7
      }
    };
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: '23514', message: 'MOVE_ALREADY_APPLIED', details: JSON.stringify(conflict) }
    }));
    const clients = { admin: { rpc }, publicClient: {}, forAccessToken: vi.fn() } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    await expect(service.commitRoomMove(actor, {
      reservationId: commandResult.id,
      targetRoomId: commandResult.room_id,
      expectedReservationVersion: 2,
      expectedSourceRoomVersion: 2,
      expectedTargetRoomVersion: 2,
      evaluatedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-01T00:05:00Z',
      effectiveAt: commandResult.check_in_at,
      impactFingerprint: 'a'.repeat(64),
      reasonCode: 'GUEST_REQUEST',
      idempotencyKey: 'room-move-already-applied'
    })).rejects.toMatchObject({ statusCode: 409, code: 'MOVE_ALREADY_APPLIED', conflict });
  });

  it('adds safe conflict metadata only to room-move idempotency reuse errors', async () => {
    const conflict = {
      reloadResources: ['reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'],
      latestVersions: {
        reservationVersion: 2,
        sourceRoomVersion: 7,
        targetRoomVersion: 9
      }
    };
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: '23505',
        message: 'IDEMPOTENCY_KEY_REUSED',
        details: JSON.stringify(conflict)
      }
    }));
    const clients = { admin: { rpc }, publicClient: {}, forAccessToken: vi.fn() } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    const roomMoveError = await service.commitRoomMove(actor, {
      reservationId: commandResult.id,
      targetRoomId: '51000000-0000-4000-8000-000000000002',
      expectedReservationVersion: 1,
      expectedSourceRoomVersion: 2,
      expectedTargetRoomVersion: 3,
      evaluatedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-01T00:05:00Z',
      effectiveAt: commandResult.check_in_at,
      impactFingerprint: 'a'.repeat(64),
      reasonCode: 'GUEST_REQUEST',
      idempotencyKey: 'room-move-reused'
    }).catch((error: unknown) => error);
    expect(roomMoveError).toMatchObject({
      statusCode: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      conflict
    });

    const genericError = await service.cancel(actor, {
      reservationId: commandResult.id,
      expectedVersion: 1,
      reasonCode: 'GUEST_REQUEST',
      idempotencyKey: 'reservation-cancel-reused'
    }).catch((error: unknown) => error);
    expect(genericError).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect((genericError as { conflict?: unknown }).conflict).toBeUndefined();
  });

  it('redacts malformed room-move conflict detail behind null latest versions', async () => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: {
        code: '40001',
        message: 'ROOM_CHANGE_PREVIEW_STALE',
        details: JSON.stringify({
          reloadResources: ['reservation'],
          latestVersions: {
            reservationVersion: 2,
            sourceRoomVersion: 3,
            targetRoomVersion: 4
          },
          reservationId: commandResult.id,
          guestName: 'must-not-leak'
        })
      }
    }));
    const clients = { admin: { rpc }, publicClient: {}, forAccessToken: vi.fn() } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    await expect(service.commitRoomMove(actor, {
      reservationId: commandResult.id,
      targetRoomId: commandResult.room_id,
      expectedReservationVersion: 1,
      expectedSourceRoomVersion: 2,
      expectedTargetRoomVersion: 3,
      evaluatedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-01T00:05:00Z',
      effectiveAt: commandResult.check_in_at,
      impactFingerprint: 'a'.repeat(64),
      reasonCode: 'GUEST_REQUEST',
      idempotencyKey: 'room-move-malformed-detail'
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'ROOM_CHANGE_PREVIEW_STALE',
      conflict: {
        reloadResources: ['reservation', 'sourceRoom', 'targetRoom', 'roomMovePreview'],
        latestVersions: {
          reservationVersion: null,
          sourceRoomVersion: null,
          targetRoomVersion: null
        }
      }
    });
  });

  it('projects the bounded during-stay segment, cleaning, and PIN impact contract', async () => {
    const targetRoomId = '51000000-0000-4000-8000-000000000002';
    const effectiveAt = '2026-09-01T01:00:00Z';
    const duringStay = {
      reservation: { ...commandResult, version: 2 },
      mode: 'DURING_STAY',
      evaluatedAt: '2026-09-01T00:59:00Z',
      expiresAt: '2026-09-01T01:04:00Z',
      effectiveAt,
      movedAt: effectiveAt,
      sourceRoomId: commandResult.room_id,
      targetRoomId,
      sourceRoomVersion: 2,
      targetRoomVersion: 3,
      plannedCheckoutTargetId: '44000000-0000-4000-8000-000000000001',
      plannedCheckoutTargetVersion: 2,
      sourceOutcome: { occupancyStatus: 'VACANT', readinessStatus: 'CLEANING_REQUIRED', stateVersion: 2 },
      targetOutcome: { occupancyStatus: 'OCCUPIED', readinessStatus: 'READY', stateVersion: 3 },
      stay: {
        id: '45000000-0000-4000-8000-000000000001',
        version: 2,
        currentRoomId: commandResult.room_id
      },
      segments: [
        {
          id: '46000000-0000-4000-8000-000000000001',
          roomId: commandResult.room_id,
          startsAt: commandResult.check_in_at,
          endsAt: effectiveAt
        },
        {
          id: '46000000-0000-4000-8000-000000000002',
          roomId: targetRoomId,
          startsAt: effectiveAt,
          endsAt: commandResult.check_out_at
        }
      ],
      sourceCleaningTargetId: '44000000-0000-4000-8000-000000000002',
      pinAccessEndsAt: effectiveAt,
      pin: 'must-not-leak'
    };
    const rpc = vi.fn(async () => ({ data: duringStay, error: null }));
    const clients = {
      admin: { rpc }, publicClient: {}, forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    const input = {
      reservationId: commandResult.id,
      targetRoomId,
      expectedReservationVersion: 1,
      expectedSourceRoomVersion: 1,
      expectedTargetRoomVersion: 2,
      evaluatedAt: duringStay.evaluatedAt,
      expiresAt: duringStay.expiresAt,
      effectiveAt,
      impactFingerprint: 'a'.repeat(64),
      reasonCode: 'GUEST_REQUEST' as const,
      idempotencyKey: 'room-move-during-stay'
    };

    const result = await service.commitRoomMove(actor, input);
    expect(result).toMatchObject({
      mode: 'DURING_STAY',
      stay: duringStay.stay,
      segments: duringStay.segments,
      sourceCleaningTargetId: duringStay.sourceCleaningTargetId,
      pinAccessEndsAt: effectiveAt
    });
    expect(result).not.toHaveProperty('pin');

    const targetSegment = duringStay.segments[1];
    if (!targetSegment) throw new Error('target segment fixture missing');
    targetSegment.endsAt = '2026-02-29T00:00:00Z';
    await expect(service.commitRoomMove(actor, input)).rejects.toMatchObject({
      statusCode: 500,
      code: 'RESERVATION_PROJECTION_INVALID'
    });
  });

  it.each([
    ['TARGET_ROOM_OVERLAP', 409],
    ['TARGET_ROOM_BLOCKED', 409],
    ['TARGET_ROOM_NOT_READY', 409],
    ['PIN_LEASE_ACTIVE', 409],
    ['OPEN_ENDED_STAY_REQUIRES_END', 409],
    ['INVALID_MOVE_EFFECTIVE_AT', 400]
  ])('maps room-move domain error %s to its stable status', async (message, statusCode) => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '23514', message } }));
    const clients = {
      admin: { rpc }, publicClient: {}, forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    await expect(service.commitRoomMove(actor, {
      reservationId: commandResult.id,
      targetRoomId: commandResult.room_id,
      expectedReservationVersion: 1,
      expectedSourceRoomVersion: 1,
      expectedTargetRoomVersion: 1,
      evaluatedAt: '2026-09-01T00:00:00Z',
      expiresAt: '2026-09-01T00:05:00Z',
      effectiveAt: '2026-09-01T01:00:00Z',
      impactFingerprint: 'a'.repeat(64),
      reasonCode: 'GUEST_REQUEST',
      idempotencyKey: `room-move-${message.toLowerCase()}`
    })).rejects.toMatchObject({ statusCode, code: message });
  });

  it.each([
    ['STANDARD_RESERVATION_REQUIRES_END', 400],
    ['RESERVATION_TYPE_IMMUTABLE', 409],
    ['RESERVATION_END_IMMUTABLE', 409]
  ])('maps long-stay contract error %s to its stable status', async (message, statusCode) => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: '23514', message } }));
    const clients = {
      admin: { rpc }, publicClient: {}, forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(clients, piiKey, 'test-v1', guestNamePepper);
    await expect(service.change(actor, {
      reservationId: commandResult.id,
      roomId: commandResult.room_id,
      reservationType: 'standard',
      checkInAt: commandResult.check_in_at,
      checkOutAt: commandResult.check_out_at,
      guestCount: 2,
      expectedVersion: 1,
      reasonCode: 'SCHEDULE_CHANGED',
      idempotencyKey: `reservation-contract-${message.toLowerCase()}`
    })).rejects.toMatchObject({ statusCode, code: message });
  });

  it('canonicalizes object key order before hashing commands', () => {
    expect(requestHash({ roomId: 'room-1', nested: { b: 2, a: 1 } })).toBe(
      requestHash({ nested: { a: 1, b: 2 }, roomId: 'room-1' })
    );
  });

  it('rejects phone numbers and email addresses in room issue free text', () => {
    expect(() => assertNoContactInformation('연락처 010-1234-5678')).toThrowError(
      expect.objectContaining({ code: 'SENSITIVE_TEXT_NOT_ALLOWED' })
    );
    expect(() => assertNoContactInformation('guest@example.com으로 연락')).toThrowError(
      expect.objectContaining({ code: 'SENSITIVE_TEXT_NOT_ALLOWED' })
    );
    expect(() => assertNoContactInformation('침대 옆 조명 파손')).not.toThrow();
  });

  it.each([
    ['INVALID_MANUAL_CLEANING_REQUEST', 400],
    ['STAYOVER_ACCESS_WINDOW_INVALID', 409],
    ['VACANT_ROOM_REQUIRED', 409],
    ['RESERVATION_ROOM_MISMATCH', 409]
  ])('maps manual cleaning domain error %s without leaking a 500', async (message, statusCode) => {
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: '23514', message }
    }));
    const clients = {
      admin: { rpc },
      publicClient: {},
      forAccessToken: vi.fn()
    } as unknown as SupabaseClients;
    const service = new SupabaseReservationService(
      clients,
      piiKey,
      'test-v1',
      guestNamePepper
    );

    await expect(service.createManualCleaningRequest(actor, {
      roomId: commandResult.room_id,
      reservationId: commandResult.id,
      cleaningKind: 'stayover',
      serviceDate: '2026-09-01',
      availableFrom: '2026-09-01T08:00:00+00:00',
      dueAt: '2026-09-01T09:00:00+00:00',
      expectedRoomVersion: 1,
      reasonCode: 'ADMIN_REQUEST',
      idempotencyKey: `manual-cleaning-${message.toLowerCase()}`
    })).rejects.toMatchObject({ statusCode, code: message });
  });
});
