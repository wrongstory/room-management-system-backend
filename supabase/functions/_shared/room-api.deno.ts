import {
  changeRoomMasterData,
  createRoomOperationBlock,
  getRoom,
  listRooms,
  recordRoomPinSync,
  releaseRoomOperationBlock,
  reportRoomIssue,
  resolveRoomIssue,
  roomDatabaseError,
  roomDetailIdFromPath,
  roomPathIds,
  setRoomCandleCount,
  toRoomProjections,
} from "./room-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function captureEdgeError(
  run: () => Promise<unknown>,
): Promise<EdgeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected EdgeError");
}

const admin: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "운영 관리자",
  role: "admin",
  mustChangePassword: false,
};
const roomId = "30000000-0000-4000-8000-000000000001";
const roomTypeId = "40000000-0000-4000-8000-000000000001";
const blockId = "50000000-0000-4000-8000-000000000001";
const issueId = "60000000-0000-4000-8000-000000000001";
const roomRow = {
  id: roomId,
  room_number: "101",
  room_type_code: "standard",
  room_type_name: "스탠다드 더블 로프트",
  elevator_zone: "A" as const,
  data_status: "verified" as const,
  state_version: 3,
  occupied: true,
  cleaning_required: false,
  candle_count: 0,
  pin_sync_status: "verified" as const,
  allocation_blocked: true,
  allocation_ready: false,
  reason_codes: ["OCCUPIED" as const],
};

function commandRequest(
  path: string,
  body: Record<string, unknown>,
  method = "POST",
  key = "room-command-0001",
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

function operationClients(calls: Array<[string, Record<string, unknown>]>) {
  return {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        if (name === "get_room_operational_projection") {
          return { data: [roomRow], error: null };
        }
        if (name === "change_room_master_data") {
          return {
            data: {
              id: roomId,
              state_version: 4,
              updated_at: "2026-09-01T00:00:00Z",
            },
            error: null,
          };
        }
        const payload = args.p_payload as Record<string, unknown>;
        return {
          data: {
            entity_id: payload.entityId,
            room_id: args.p_room_id,
            room_state_version: Number(args.p_expected_room_version) + 1,
            recorded_at: "2026-09-01T00:00:00Z",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
}

Deno.test("room list and detail use one exact camelCase projection", async () => {
  const rows = Array.from({ length: 121 }, (_, index) => ({
    ...roomRow,
    id: `30000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    room_number: String(index + 101),
  }));
  const clients = {
    admin: {
      rpc: (_name: string, args: Record<string, unknown>) =>
        Promise.resolve({
          data: args.p_room_id === null
            ? rows
            : rows.filter((row) => row.id === args.p_room_id),
          error: null,
        }),
    },
  } as unknown as EdgeClients;

  const rooms = await listRooms(clients, admin);
  const detail = await getRoom(clients, admin, rows[0].id);
  assert(rooms.length === 121, "all 121 rooms must remain visible");
  assert(
    JSON.stringify(rooms[0]) === JSON.stringify(detail),
    "same projection",
  );
  assert(!("room_number" in detail), "database names must not leak");
  assert(
    !JSON.stringify(detail).toLowerCase().includes("rawpin"),
    "no PIN material",
  );

  const missing = await captureEdgeError(() =>
    getRoom(clients, admin, "30000000-0000-4000-8000-999999999999")
  );
  assert(
    missing.code === "ROOM_NOT_FOUND" && missing.status === 404,
    "unknown room",
  );
});

Deno.test("room routes require a changed password and exact business admin", async () => {
  for (
    const actor of [
      { ...admin, role: "developer" as const },
      { ...admin, role: "maid" as const },
    ]
  ) {
    const error = await captureEdgeError(() =>
      listRooms({} as EdgeClients, actor)
    );
    assert(error.code === "ADMIN_REQUIRED", `${actor.role} denied`);
  }
  const temporary = await captureEdgeError(() =>
    listRooms({} as EdgeClients, { ...admin, mustChangePassword: true })
  );
  assert(
    temporary.code === "PASSWORD_CHANGE_REQUIRED",
    "temporary password denied",
  );
});

Deno.test("master-data command preserves actor, CAS, canonical replay hash", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = operationClients(calls);
  const body = {
    roomTypeId,
    elevatorZone: "B",
    dataStatus: "verification_required",
    dataStatusReason: "  현장 재확인 필요  ",
    expectedVersion: 3,
    reasonCode: "MASTER_DATA_CHECK",
  };
  await changeRoomMasterData(
    commandRequest(
      `/v1/rooms/${roomId}/master-data`,
      body,
      "PATCH",
      "master-replay-0001",
    ),
    clients,
    admin,
    roomId,
  );
  await changeRoomMasterData(
    commandRequest(
      `/v1/rooms/${roomId}/master-data`,
      body,
      "PATCH",
      "master-replay-0001",
    ),
    clients,
    admin,
    roomId,
  );
  const commands = calls.filter(([name]) => name === "change_room_master_data");
  assert(commands.length === 2, "two retry calls");
  assert(commands[0][1].p_actor_profile_id === admin.profileId, "actor bound");
  assert(commands[0][1].p_expected_version === 3, "CAS version");
  assert(
    commands[0][1].p_data_status_reason === "현장 재확인 필요",
    "trimmed reason",
  );
  assert(
    commands[0][1].p_request_hash === commands[1][1].p_request_hash,
    "stable replay hash",
  );
});

Deno.test("all six room operations reuse mutate_room_operation", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = operationClients(calls);
  await createRoomOperationBlock(
    commandRequest(`/v1/rooms/${roomId}/operation-blocks`, {
      expectedRoomVersion: 3,
      reasonCode: "MAINTENANCE",
      startsAt: "2026-09-01T10:00:00+09:00",
      endsAt: null,
    }),
    clients,
    admin,
    roomId,
  );
  await releaseRoomOperationBlock(
    commandRequest(`/v1/rooms/${roomId}/operation-blocks/${blockId}/release`, {
      expectedRoomVersion: 3,
      reasonCode: "MAINTENANCE_DONE",
    }),
    clients,
    admin,
    roomId,
    blockId,
  );
  await setRoomCandleCount(
    commandRequest(`/v1/rooms/${roomId}/candles`, {
      expectedRoomVersion: 3,
      reasonCode: "PHYSICAL_CHECK",
      count: 0,
    }),
    clients,
    admin,
    roomId,
  );
  await reportRoomIssue(
    commandRequest(`/v1/rooms/${roomId}/issues`, {
      expectedRoomVersion: 3,
      reasonCode: "ISSUE_REPORTED",
      category: "FACILITY",
      severity: "warning",
      blocksGuestAssignment: true,
      description: "창문 잠금 점검 필요",
    }),
    clients,
    admin,
    roomId,
  );
  await resolveRoomIssue(
    commandRequest(`/v1/rooms/${roomId}/issues/${issueId}/resolve`, {
      expectedRoomVersion: 3,
      reasonCode: "ISSUE_FIXED",
    }),
    clients,
    admin,
    roomId,
    issueId,
  );
  const pinResult = await recordRoomPinSync(
    commandRequest(`/v1/rooms/${roomId}/pin-sync-events`, {
      expectedRoomVersion: 3,
      reasonCode: "SYNC_VERIFIED",
      syncStatus: "verified",
      pinVersion: null,
    }),
    clients,
    admin,
    roomId,
  );

  const mutations = calls.filter(([name]) => name === "mutate_room_operation");
  assert(mutations.length === 6, "exact six mutation calls");
  assert(
    mutations.map(([, args]) => args.p_action).join(",") ===
      "create_block,release_block,set_candle_count,report_issue,resolve_issue,record_pin_sync",
    "existing action contract",
  );
  assert(
    (mutations[1][1].p_payload as Record<string, unknown>).entityId === blockId,
    "release path ID",
  );
  assert(
    (mutations[4][1].p_payload as Record<string, unknown>).entityId === issueId,
    "resolve path ID",
  );
  assert(
    (mutations[2][1].p_payload as Record<string, unknown>)
      .physicallyVerified === false,
    "default false",
  );
  assert(
    !JSON.stringify(pinResult).toLowerCase().includes("pin"),
    "operation response has no PIN data",
  );
});

Deno.test("generated entity IDs stay outside the idempotency fingerprint", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = operationClients(calls);
  const body = { expectedRoomVersion: 3, reasonCode: "MAINTENANCE" };
  await Promise.all([
    createRoomOperationBlock(
      commandRequest(
        `/v1/rooms/${roomId}/operation-blocks`,
        body,
        "POST",
        "same-room-create",
      ),
      clients,
      admin,
      roomId,
    ),
    createRoomOperationBlock(
      commandRequest(
        `/v1/rooms/${roomId}/operation-blocks`,
        body,
        "POST",
        "same-room-create",
      ),
      clients,
      admin,
      roomId,
    ),
  ]);
  assert(
    calls[0][1].p_request_hash === calls[1][1].p_request_hash,
    "stable request hash",
  );
  assert(
    (calls[0][1].p_payload as Record<string, unknown>).entityId !==
      (calls[1][1].p_payload as Record<string, unknown>).entityId,
    "server IDs randomized",
  );
});

Deno.test("issue contact text and every raw PIN field fail before RPC", async () => {
  for (const description of ["010-1234-5678로 연락", "room@example.com 확인"]) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const error = await captureEdgeError(() =>
      reportRoomIssue(
        commandRequest(`/v1/rooms/${roomId}/issues`, {
          expectedRoomVersion: 3,
          reasonCode: "ISSUE_REPORTED",
          category: "FACILITY",
          severity: "warning",
          blocksGuestAssignment: false,
          description,
        }),
        operationClients(calls),
        admin,
        roomId,
      )
    );
    assert(error.code === "SENSITIVE_TEXT_NOT_ALLOWED", "contact rejected");
    assert(calls.length === 0, "sensitive description never reaches RPC");
    assert(
      !error.message.includes(description),
      "description not reflected in error",
    );
  }

  for (
    const field of [
      "pin",
      "rawPin",
      "pinCode",
      "doorCode",
      "credential",
      "providerSecret",
    ]
  ) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const error = await captureEdgeError(() =>
      recordRoomPinSync(
        commandRequest(`/v1/rooms/${roomId}/pin-sync-events`, {
          expectedRoomVersion: 3,
          reasonCode: "SYNC_VERIFIED",
          syncStatus: "verified",
          [field]: "secret-value",
        }),
        operationClients(calls),
        admin,
        roomId,
      )
    );
    assert(error.code === "PIN_MATERIAL_NOT_ALLOWED", `${field} rejected`);
    assert(calls.length === 0, `${field} never reaches RPC`);
    assert(!error.message.includes("secret-value"), "secret not reflected");
  }
});

Deno.test("room validation and database errors use stable redacted codes", async () => {
  const negative = await captureEdgeError(() =>
    setRoomCandleCount(
      commandRequest(`/v1/rooms/${roomId}/candles`, {
        expectedRoomVersion: 3,
        reasonCode: "PHYSICAL_CHECK",
        count: -1,
      }),
      operationClients([]),
      admin,
      roomId,
    )
  );
  assert(negative.code === "VALIDATION_ERROR", "negative candle rejected");
  assert(
    roomDatabaseError({ message: "STALE_VERSION" }).status === 409,
    "stale 409",
  );
  assert(
    roomDatabaseError({ message: "ROOM_BLOCK_NOT_FOUND" }).status === 404,
    "operation 404",
  );
  const unknown = roomDatabaseError({ message: "private database detail" });
  assert(unknown.code === "ROOM_COMMAND_FAILED", "unknown stable code");
  assert(
    !unknown.message.includes("private database detail"),
    "DB detail redacted",
  );
});

Deno.test("room path parser accepts only exact UUID route shapes", () => {
  assert(
    roomDetailIdFromPath(`/v1/rooms/${roomId}`) === roomId,
    "detail path",
  );
  assert(
    roomDetailIdFromPath(`/v1/rooms/${roomId}/issues`) === null,
    "mutation path is not a detail alias",
  );
  assert(
    roomPathIds(`/v1/rooms/${roomId}/operation-blocks/${blockId}/release`)
      .blockId === blockId,
    "block path",
  );
  assert(
    roomPathIds(`/v1/rooms/${roomId}/issues/${issueId}/resolve`).issueId ===
      issueId,
    "issue path",
  );
});

Deno.test("room projection mapper exposes only the allowlisted fields", () => {
  const [room] = toRoomProjections([{ ...roomRow, raw_pin: "must-not-leak" }]);
  assert(room.roomNumber === "101", "roomNumber mapped");
  assert(room.stateVersion === 3, "stateVersion mapped");
  assert(!("raw_pin" in room), "unknown DB field removed");
  assert(!JSON.stringify(room).includes("must-not-leak"), "raw PIN removed");
});
