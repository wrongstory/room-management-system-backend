export type RoomReasonCode =
  | "OCCUPIED"
  | "CLEANING_REQUIRED"
  | "CANDLE_PRESENT"
  | "OPERATION_BLOCKED"
  | "ROOM_ISSUE_BLOCKED"
  | "PIN_MISMATCH"
  | "DATA_UNCONFIRMED";

interface RoomProjectionRow {
  id: string;
  room_number: string;
  room_type_code: string;
  room_type_name: string;
  elevator_zone: "A" | "B" | "C" | null;
  data_status: "verified" | "verification_required";
  state_version: number;
  occupied: boolean;
  cleaning_required: boolean;
  candle_count: number;
  pin_sync_status: "verified" | "mismatch" | "unconfigured";
  allocation_blocked: boolean;
  allocation_ready: boolean;
  reason_codes: RoomReasonCode[];
}

export interface RoomProjection {
  id: string;
  roomNumber: string;
  roomTypeCode: string;
  roomTypeName: string;
  elevatorZone: "A" | "B" | "C" | null;
  dataStatus: "verified" | "verification_required";
  stateVersion: number;
  occupied: boolean;
  cleaningRequired: boolean;
  candleCount: number;
  pinSyncStatus: "verified" | "mismatch" | "unconfigured";
  allocationBlocked: boolean;
  allocationReady: boolean;
  reasonCodes: RoomReasonCode[];
}

/** DB RPC의 snake_case row를 Fastify와 동일한 프론트 공개 계약으로 변환한다. */
export function toRoomProjection(row: RoomProjectionRow): RoomProjection {
  return {
    id: row.id,
    roomNumber: row.room_number,
    roomTypeCode: row.room_type_code,
    roomTypeName: row.room_type_name,
    elevatorZone: row.elevator_zone,
    dataStatus: row.data_status,
    stateVersion: row.state_version,
    occupied: row.occupied,
    cleaningRequired: row.cleaning_required,
    candleCount: row.candle_count,
    pinSyncStatus: row.pin_sync_status,
    allocationBlocked: row.allocation_blocked,
    allocationReady: row.allocation_ready,
    reasonCodes: row.reason_codes,
  };
}

export function toRoomProjections(value: unknown): RoomProjection[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return (value as RoomProjectionRow[]).map(toRoomProjection);
}
