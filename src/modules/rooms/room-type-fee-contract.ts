/** Admin catalog price changes apply only to newly created cleaning targets. */
export const MAX_ROOM_TYPE_CLEANING_FEE = 1073741823;
export interface RoomTypeFeeInput {
  baseCleaningFee: number;
  expectedVersion: number;
  confirmFutureTargetsOnly: true;
}
export interface RoomTypeFeeResult {
  roomTypeId: string;
  baseCleaningFee: number;
  version: number;
  effectiveFor: "NEW_TARGETS_ONLY";
}
export class RoomTypeFeeError extends Error {
  constructor(readonly output = false) {
    super("ROOM_TYPE_CLEANING_FEE_INVALID");
  }
}
export function feeRoomTypeId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(value)
  ) throw new RoomTypeFeeError();
  return value.toLowerCase();
}
export function parseRoomTypeFeeInput(value: unknown): RoomTypeFeeInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomTypeFeeError();
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 3 ||
    !["baseCleaningFee", "expectedVersion", "confirmFutureTargetsOnly"].every(
      (key) => Object.hasOwn(row, key),
    ) ||
    !Number.isSafeInteger(row.baseCleaningFee) ||
    (row.baseCleaningFee as number) < 0 ||
    (row.baseCleaningFee as number) > MAX_ROOM_TYPE_CLEANING_FEE ||
    !Number.isSafeInteger(row.expectedVersion) ||
    (row.expectedVersion as number) < 1 ||
    (row.expectedVersion as number) >= Number.MAX_SAFE_INTEGER ||
    row.confirmFutureTargetsOnly !== true
  ) throw new RoomTypeFeeError();
  return {
    baseCleaningFee: row.baseCleaningFee as number,
    expectedVersion: row.expectedVersion as number,
    confirmFutureTargetsOnly: true,
  };
}
export function parseRoomTypeFeeResult(
  value: unknown,
  roomTypeId: string,
  input: RoomTypeFeeInput,
): RoomTypeFeeResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomTypeFeeError(true);
  }
  const row = value as Record<string, unknown>;
  if (
    row.roomTypeId !== roomTypeId ||
    row.baseCleaningFee !== input.baseCleaningFee ||
    !Number.isSafeInteger(row.version) ||
    ![input.expectedVersion, input.expectedVersion + 1].includes(
      row.version as number,
    ) ||
    row.effectiveFor !== "NEW_TARGETS_ONLY"
  ) throw new RoomTypeFeeError(true);
  return {
    roomTypeId,
    baseCleaningFee: input.baseCleaningFee,
    version: row.version as number,
    effectiveFor: "NEW_TARGETS_ONLY",
  };
}
