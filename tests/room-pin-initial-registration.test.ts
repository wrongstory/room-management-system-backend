import { describe, expect, it, vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseRoomService } from '../src/modules/rooms/room.service.js';

const roomId = '30000000-0000-4000-8000-000000000001';
const leaseId = '40000000-0000-4000-8000-000000000001';
const sessionId = '50000000-0000-4000-8000-000000000001';
const actor: Actor = {
  authUserId: '10000000-0000-4000-8000-000000000001',
  profileId: '20000000-0000-4000-8000-000000000001',
  displayName: '운영 관리자',
  role: 'admin',
  mustChangePassword: false,
  accessToken: `e30.${Buffer.from(JSON.stringify({ session_id: sessionId })).toString('base64url')}.signature`
};
const cryptoConfig = {
  key: Buffer.alloc(32, 8).toString('base64'),
  keyVersion: 'pin-v1',
  keyring: {},
  environment: 'test',
  projectRef: 'local'
};

function clientsWithRpc(rpc: ReturnType<typeof vi.fn>): SupabaseClients {
  return {
    admin: { rpc },
    publicClient: {},
    forAccessToken: vi.fn()
  } as unknown as SupabaseClients;
}

describe('initial room PIN registration', () => {
  it('canonicalizes version-zero physical changes and preserves idempotent replay safety', async () => {
    const prepareCalls: Array<Record<string, unknown>> = [];
    let saved: Record<string, unknown> | undefined;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_room_pin_change_context') {
        return {
          data: { room_number: '0101', current_pin_version: 0, proposed_pin_version: 1 },
          error: null
        };
      }
      if (name !== 'prepare_room_pin_change') throw new Error(`unexpected RPC ${name}`);
      prepareCalls.push(args);
      if (!saved) {
        saved = {
          lease_id: leaseId,
          room_id: roomId,
          current_pin_version: 0,
          proposed_pin_version: 1,
          status: 'prepared',
          expires_at: '2026-09-21T00:05:00.000Z',
          envelope_format: args.p_envelope_format,
          ciphertext_base64: args.p_ciphertext_base64,
          nonce_base64: args.p_nonce_base64,
          auth_tag_base64: args.p_auth_tag_base64,
          key_version: args.p_key_version,
          aad_environment: args.p_aad_environment,
          aad_project_ref: args.p_aad_project_ref
        };
        return { data: { ...saved, replay: false }, error: null };
      }
      return { data: { ...saved, replay: true }, error: null };
    });
    const service = new SupabaseRoomService(clientsWithRpc(rpc), cryptoConfig);
    const base = {
      roomId,
      pinDigits: '0012',
      expectedPinVersion: 0,
      idempotencyKey: 'pin-initial-hotfix-0001'
    } as const;

    const first = await service.preparePinChange(actor, {
      ...base,
      reasonCode: 'ADMIN_PHYSICAL_CHANGE'
    });
    const replay = await service.preparePinChange(actor, {
      ...base,
      reasonCode: 'ADMIN_INITIAL_PIN'
    });

    expect(first).toMatchObject({ currentPinVersion: 0, proposedPinVersion: 1 });
    expect(replay).toEqual(first);
    expect(prepareCalls).toHaveLength(2);
    expect(prepareCalls.map((call) => call.p_reason_code)).toEqual([
      'ADMIN_INITIAL_PIN',
      'ADMIN_INITIAL_PIN'
    ]);
    expect(prepareCalls[0]?.p_request_hash).toBe(prepareCalls[1]?.p_request_hash);
    expect(JSON.stringify({ first, replay, prepareCalls })).not.toContain('0012');

    await expect(service.preparePinChange(actor, {
      ...base,
      pinDigits: '0013',
      reasonCode: 'ADMIN_PHYSICAL_CHANGE'
    })).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('keeps an existing-current physical change reason unchanged', async () => {
    let prepareArgs: Record<string, unknown> | undefined;
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_room_pin_change_context') {
        return {
          data: { room_number: '0101', current_pin_version: 1, proposed_pin_version: 2 },
          error: null
        };
      }
      prepareArgs = args;
      return {
        data: {
          lease_id: leaseId,
          room_id: roomId,
          current_pin_version: 1,
          proposed_pin_version: 2,
          status: 'prepared',
          expires_at: '2026-09-21T00:05:00.000Z',
          replay: false
        },
        error: null
      };
    });
    const service = new SupabaseRoomService(clientsWithRpc(rpc), cryptoConfig);

    await service.preparePinChange(actor, {
      roomId,
      pinDigits: '0012',
      expectedPinVersion: 1,
      reasonCode: 'ADMIN_PHYSICAL_CHANGE',
      idempotencyKey: 'pin-physical-hotfix-0001'
    });

    expect(prepareArgs?.p_reason_code).toBe('ADMIN_PHYSICAL_CHANGE');
  });

  it('maps an invalid reason combination to a redacted stable conflict', async () => {
    const rpc = vi.fn(async (name: string) => name === 'get_room_pin_change_context'
      ? {
          data: { room_number: '0101', current_pin_version: 1, proposed_pin_version: 2 },
          error: null
        }
      : { data: null, error: { message: 'INVALID_PIN_CHANGE_REASON: private detail' } });
    const service = new SupabaseRoomService(clientsWithRpc(rpc), cryptoConfig);

    await expect(service.preparePinChange(actor, {
      roomId,
      pinDigits: '0012',
      expectedPinVersion: 1,
      reasonCode: 'ADMIN_INITIAL_PIN',
      idempotencyKey: 'pin-invalid-reason-0001'
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'INVALID_PIN_CHANGE_REASON',
      message: '현재 PIN 상태와 변경 사유가 일치하지 않습니다.'
    });
  });
});
