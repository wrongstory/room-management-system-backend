import { toRoomProjections } from "./room-api.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

Deno.test("Edge room projection matches the frontend camelCase contract", () => {
  const rooms = toRoomProjections([
    {
      id: "00000000-0000-4000-8000-000000000001",
      room_number: "101",
      room_type_code: "standard",
      room_type_name: "스탠다드 더블 로프트",
      elevator_zone: "A",
      data_status: "verified",
      state_version: 3,
      occupied: true,
      cleaning_required: false,
      candle_count: 0,
      pin_sync_status: "verified",
      allocation_blocked: true,
      allocation_ready: false,
      reason_codes: ["OCCUPIED"],
    },
  ]);

  assert(rooms.length === 1, "one room is required");
  assert(rooms[0].roomNumber === "101", "roomNumber must be camelCase");
  assert(rooms[0].stateVersion === 3, "stateVersion must be mapped");
  assert(rooms[0].reasonCodes[0] === "OCCUPIED", "reasonCodes must be mapped");
  assert(
    !("room_number" in rooms[0]),
    "database column names must not leak to the frontend contract",
  );
});
