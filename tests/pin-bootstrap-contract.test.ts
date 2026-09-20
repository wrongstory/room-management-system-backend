import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { generateUniqueFourDigitPins } from '../src/modules/rooms/room.service.js';

function readSqlFixture(path: string): string {
  return readFileSync(join(process.cwd(), path), 'utf8').replace(/\r\n/g, '\n');
}

const migration = readSqlFixture(
  'supabase/migrations/20260913041707_pin_bootstrap_reservation_readiness.sql',
);
const nonceHardeningMigration = readSqlFixture(
  'supabase/migrations/20260913075134_room_pin_nonce_reservation_hardening.sql',
);
const generatedPinMigration = readSqlFixture(
  'supabase/migrations/20260919230733_generated_room_pin_confirmation.sql',
);

describe('PIN bootstrap and reservation readiness contract', () => {
  it('generates unique fixed-width values and retries collisions', () => {
    const draws = [0, 0, 42, 9999];
    expect(generateUniqueFourDigitPins(3, () => draws.shift() ?? 1234)).toEqual([
      '0000',
      '0042',
      '9999',
    ]);
    expect(() => generateUniqueFourDigitPins(26)).toThrow(RangeError);
  });
  it('keeps PIN warnings out of reservation allocation while retaining the check-in gate', () => {
    expect(migration).toContain('p_preparation_reservation_id is not null');
    expect(migration).toContain("array_append(v_reasons, 'PIN_MISMATCH')");
    expect(migration).toContain("array_append(v_reasons, 'DATA_UNCONFIRMED')");

    const roomReasonCodes = openApiDocument.components.schemas.RoomReasonCode.enum;
    expect(roomReasonCodes).not.toContain('PIN_MISMATCH');
    expect(roomReasonCodes).toContain('DATA_UNCONFIRMED');
  });

  it('exposes a bounded admin bootstrap with only short-lived generated credentials', () => {
    const operation = openApiDocument.paths['/v1/rooms/pins/bootstrap'].post;
    expect(operation.operationId).toBe('bootstrapRoomPins');
    expect(operation.security).toEqual([{ bearerAuth: [] }]);

    const request = openApiDocument.components.schemas.RoomPinBootstrapRequest;
    expect(request.additionalProperties).toBe(false);
    expect(Object.keys(request.properties)).toEqual(['limit']);
    expect(request.properties.limit).toMatchObject({ minimum: 1, maximum: 25 });

    const result = openApiDocument.components.schemas.RoomPinBootstrapResult;
    expect(Object.keys(result.properties)).toEqual([
      'initializedRoomIds',
      'skippedRoomIds',
      'initializedCount',
      'skippedCount',
      'remainingCount',
      'completedAt',
      'generatedPins',
    ]);
    expect(result.properties.generatedPins.items.$ref).toBe('#/components/schemas/RoomPinReveal');
    expect(openApiDocument.paths['/v1/rooms/{roomId}/pin/generated/confirm'].post.operationId)
      .toBe('confirmGeneratedRoomPin');
  });

  it('accepts encrypted envelopes only and restricts both RPCs to service role', () => {
    expect(migration).toContain('create function public.get_room_pin_bootstrap_context');
    expect(migration).toContain('create function public.bootstrap_room_pins');
    expect(migration).toContain('jsonb_array_length(p_candidates) > 25');
    expect(migration).toContain('grant execute on function public.get_room_pin_bootstrap_context');
    expect(migration).toContain('grant execute on function public.bootstrap_room_pins');
    expect(migration).toContain('to service_role');
    expect(migration).not.toContain('ROOM_PIN_INITIAL_DIGITS');
    expect(migration).not.toMatch(/p_pin_digits|pin_digits\s+(text|varchar)/i);
  });

  it('does not overwrite existing current PIN or unresolved physical changes', () => {
    expect(migration).toContain(
      'select 1 from private.room_current_pin where room_id = v_room.id',
    );
    expect(migration).toContain("status in ('prepared', 'expired')");
    expect(migration).toContain('v_skipped_ids := array_append(v_skipped_ids, v_room.id)');
    expect(migration).toContain('continue;');
  });

  it('keeps generated revisions mismatched until physical confirmation', () => {
    expect(generatedPinMigration).toContain("'GENERATED_PIN_AWAITING_PHYSICAL_CONFIRMATION'");
    expect(generatedPinMigration).toContain("v_room.id, 'mismatch', 1");
    expect(generatedPinMigration).toContain('create function public.begin_generated_room_pin_reveal');
    expect(generatedPinMigration).toContain('create function public.finalize_generated_room_pin_reveal');
    expect(generatedPinMigration).toContain('create function public.confirm_generated_room_pin');
    expect(generatedPinMigration).toContain("'GENERATED_PIN_PHYSICALLY_CONFIRMED'");
    expect(generatedPinMigration).toMatch(
      /private\.room_pin_sheet_sync_outbox[\s\S]*?'verified',[\s\n]*'GENERATED_PIN_PHYSICALLY_CONFIRMED'/,
    );
    expect(generatedPinMigration).not.toContain('ROOM_PIN_INITIAL_DIGITS');
  });

  it('reserves AES-GCM nonces across prepare and bootstrap without exposing the registry', () => {
    expect(nonceHardeningMigration).toMatch(/^begin;/m);
    expect(nonceHardeningMigration).toContain(
      'private.room_pin_change_leases,\n  private.room_pin_revisions\nin share row exclusive mode;',
    );
    expect(nonceHardeningMigration).not.toMatch(/skip\s+locked/i);
    expect(nonceHardeningMigration).toMatch(/commit;\s*$/);
    expect(nonceHardeningMigration).toContain(
      'unique (key_version, nonce)',
    );
    expect(nonceHardeningMigration).toContain(
      "message = 'ROOM_PIN_HISTORICAL_NONCE_REUSE'",
    );
    expect(nonceHardeningMigration).toContain(
      "message = 'ROOM_PIN_NONCE_REUSE'",
    );
    expect(nonceHardeningMigration).toContain(
      'alter table private.room_pin_nonce_reservations force row level security',
    );
    expect(nonceHardeningMigration).toContain(
      'create trigger room_pin_change_lease_nonce_reserved',
    );
    expect(nonceHardeningMigration).toContain(
      'create trigger room_pin_revision_nonce_reserved',
    );
    expect(nonceHardeningMigration).toContain(
      'ROOM_PIN_CHANGE_ENCRYPTION_IDENTITY_IMMUTABLE',
    );
    expect(nonceHardeningMigration).toContain(
      'from public, anon, authenticated, service_role',
    );
  });

  it('documents the atomic result and response-loss receipt semantics', () => {
    const operation = openApiDocument.paths['/v1/rooms/pins/bootstrap'].post;
    expect(operation.description).toContain('원자적');
    expect(operation.description).toContain('Idempotency-Key');
    expect(operation.description).toContain('receipt');

    const result = openApiDocument.components.schemas.RoomPinBootstrapResult;
    expect(result.properties.initializedRoomIds.description).toContain(
      '신규 PIN 원장 전체가 확정된',
    );
    expect(result.properties.skippedRoomIds.description).toContain(
      '의도적으로 건너뛴',
    );
  });
});
