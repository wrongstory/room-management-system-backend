import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { requestHash } from '../src/lib/command.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import {
  decryptGuestName,
  encryptGuestName,
  normalizeGuestName
} from '../src/modules/reservations/guest-name-crypto.js';
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
