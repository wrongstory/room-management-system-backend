import {
  changeRoomMasterData,
  correctRoomOccupancy,
  createRoomOperationBlock,
  getRoom,
  listRoomCandles,
  listRoomEvents,
  listRoomIssues,
  listRoomOperationBlocks,
  listRoomReports,
  listRooms,
  listRoomTypes,
  overrideRoomDisplayStatus,
  recordRoomPinSync,
  releaseRoomOperationBlock,
  reportRoomIssue,
  resolveRoomIssue,
  roomDatabaseError,
  roomDetailIdFromPath,
  roomListServiceDate,
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
const sessionId = "70000000-0000-4000-8000-000000000001";

function readRequest(path = "/v1/room-types"): Request {
  const encoded = btoa(JSON.stringify({ session_id: sessionId }))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer header.${encoded}.signature` },
  });
}
Deno.test("registered reports bind admin session, validate paging and allowlist evidence", async () => {
  const previous = Deno.env.get("INSPECTION_CURSOR_HMAC_SECRET");
  Deno.env.set(
    "INSPECTION_CURSOR_HMAC_SECRET",
    "room-operation-cursor-test-secret-123456789",
  );
  const calls: Array<Record<string, unknown>> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        assert(name === "list_room_reports_page", "registered report RPC");
        calls.push(args);
        return Promise.resolve({
          error: null,
          data: {
            roomId,
            roomStateVersion: 1,
            evaluatedAt: "2026-09-30T00:00:00Z",
            items: [{
              id: issueId,
              attemptId: blockId,
              kind: "bomb_room",
              memo: "registered",
              reportedAt: "2026-09-30T00:00:00Z",
              status: "reported",
              sealedSubmissionId: null,
              providerLocator: "must-not-leak",
              evidence: [{
                photoId: issueId,
                readState: "purged",
                retentionPolicy: "cleaning_submission",
                retentionStartsAt: null,
                expiresAt: null,
                purgedAt: "2026-09-30T00:00:00Z",
                mediaAvailability: "purged",
                token: "must-not-leak",
              }],
            }],
            hasMore: true,
            nextCursor: { occurredAt: "2026-09-30T00:00:00Z", id: issueId },
          },
        });
      },
    },
  } as unknown as EdgeClients;
  const path = `/v1/rooms/${roomId}/reports`;
  try {
    const page = await listRoomReports(
      readRequest(path),
      clients,
      admin,
      roomId,
    );
    assert(
      !JSON.stringify(page).includes("must-not-leak"),
      "no private fields",
    );
    assert(
      calls[0].p_session_id === sessionId && calls[0].p_limit === 5,
      "session/default limit",
    );
    await listRoomReports(
      readRequest(`${path}?cursor=${page.nextCursor}`),
      clients,
      admin,
      roomId,
    );
    assert(calls[1].p_cursor_id === issueId, "keyset forwarded");
    for (
      const query of [
        "limit=11",
        "limit=0",
        "limit=1&limit=2",
        "status=open",
        "unknown=1",
      ]
    ) {
      const error = await captureEdgeError(() =>
        listRoomReports(readRequest(`${path}?${query}`), clients, admin, roomId)
      );
      assert(error.status === 400, "invalid query rejected");
    }
    const denied = await captureEdgeError(() =>
      listRoomReports(
        readRequest(path),
        clients,
        { ...admin, role: "maid" },
        roomId,
      )
    );
    assert(denied.status === 403, "maid forbidden");
    const cross = await captureEdgeError(() =>
      listRoomIssues(
        readRequest(`/v1/rooms/${roomId}/issues?cursor=${page.nextCursor}`),
        clients,
        admin,
        roomId,
      )
    );
    assert(
      cross.code === "INVALID_ROOM_OPERATION_CURSOR",
      "cross stream cursor rejected",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("INSPECTION_CURSOR_HMAC_SECRET");
    } else Deno.env.set("INSPECTION_CURSOR_HMAC_SECRET", previous);
  }
});

const roomRow = {
  id: roomId,
  room_number: "101",
  room_type_code: "standard",
  room_type_name: "스탠다드 더블 로프트",
  elevator_zone: "A" as const,
  data_status: "verified" as const,
  state_version: 3,
  service_date: "2026-09-16",
  projection_mode: "LIVE" as const,
  detail_condition_codes: ["CHECKOUT_INSPECTION_REQUIRED", "EXTRA_GUESTS"],
  evaluated_at: "2026-09-16T08:00:00.000Z",
  reservation_phase: "current" as const,
  server_time: "2026-09-16T08:00:00.000Z",
  occupancy_status: "OCCUPIED" as const,
  reservation_lifecycle: "OCCUPIED" as const,
  readiness_status: "READY" as const,
  primary_display_status: "OCCUPIED" as const,
  canonical_primary_display_status: "OCCUPIED" as const,
  display_status_override: null,
  next_reservation_id: "30000000-0000-4000-8000-000000000010",
  next_check_in_at: "2026-09-17T07:00:00.000Z",
  next_check_out_at: "2026-09-18T02:00:00.000Z",
  display_reservation_id: "30000000-0000-4000-8000-000000000009",
  display_check_in_at: "2026-09-16T06:00:00.000Z",
  display_check_out_at: "2026-09-16T11:00:00.000Z",
  display_guest_count: 3,
  display_base_occupancy: 2,
  blocking_reason_codes: [],
  readiness_reason_codes: [],
  occupied: true,
  cleaning_required: false,
  candle_count: 0,
  pin_sync_status: "verified" as const,
  allocation_blocked: false,
  allocation_ready: false,
  reason_codes: ["OCCUPIED" as const],
};

function commandRequest(
  path: string,
  body: Record<string, unknown>,
  method = "POST",
  key = "room-command-0001",
): Request {
  const encoded = btoa(JSON.stringify({ session_id: sessionId }))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "idempotency-key": key,
      authorization: `Bearer header.${encoded}.signature`,
    },
    body: JSON.stringify(body),
  });
}

function operationClients(calls: Array<[string, Record<string, unknown>]>) {
  return {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        if (name === "get_room_board_projection") {
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

Deno.test("room type catalog maps the app-owned admin projection", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        return {
          data: [{
            id: roomTypeId,
            code: "standard",
            display_name: "스탠다드 더블 로프트",
            base_cleaning_fee: 16000,
            base_occupancy: 2,
            max_occupancy: 2,
            active: true,
            version: 2,
            room_count: 22,
          }],
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;

  const items = await listRoomTypes(readRequest(), clients, admin);
  assert(items.length === 1, "one catalog item");
  assert(items[0].displayName === "스탠다드 더블 로프트", "display name");
  assert(items[0].baseCleaningFee === 16000, "integer KRW fee");
  assert(
    items[0].roomCount === 22 && items[0].version === 2,
    "count and version",
  );
  assert(calls[0][0] === "list_room_type_catalog", "app-owned RPC");
  assert(calls[0][1].p_actor_profile_id === admin.profileId, "actor bound");
  assert(calls[0][1].p_session_id === sessionId, "session bound");
});

Deno.test("room operation cursor is signed, scoped and forwarded as a keyset", async () => {
  const previous = Deno.env.get("INSPECTION_CURSOR_HMAC_SECRET");
  Deno.env.set(
    "INSPECTION_CURSOR_HMAC_SECRET",
    "room-operation-cursor-test-secret-123456789",
  );
  const calls: Array<Record<string, unknown>> = [];
  const clients = {
    admin: {
      rpc(_name: string, args: Record<string, unknown>) {
        calls.push(args);
        return Promise.resolve({
          error: null,
          data: {
            roomId,
            roomStateVersion: 9,
            evaluatedAt: "2026-09-20T01:00:00.000Z",
            items: [{
              id: blockId,
              reasonCode: "MAINTENANCE",
              startsAt: "2026-09-20T00:00:00.000Z",
              endsAt: null,
              status: "active",
              createdAt: "2026-09-19T00:00:00.000Z",
            }],
            hasMore: true,
            nextCursor: {
              occurredAt: "2026-09-20T00:00:00.000Z",
              id: blockId,
            },
          },
        });
      },
    },
  } as unknown as EdgeClients;
  try {
    const first = await listRoomOperationBlocks(
      readRequest(`/v1/rooms/${roomId}/operation-blocks?limit=1`),
      clients,
      admin,
      roomId,
    );
    assert(
      first.hasMore && typeof first.nextCursor === "string",
      "signed cursor returned",
    );
    const firstCursor = first.nextCursor;
    if (typeof firstCursor !== "string") {
      throw new Error("signed cursor missing");
    }
    await listRoomOperationBlocks(
      readRequest(
        `/v1/rooms/${roomId}/operation-blocks?limit=1&cursor=${
          encodeURIComponent(firstCursor)
        }`,
      ),
      clients,
      admin,
      roomId,
    );
    assert(
      calls[1]?.p_cursor_at === "2026-09-20T00:00:00.000Z",
      "timestamp forwarded",
    );
    assert(calls[1]?.p_cursor_id === blockId, "id forwarded");
    const tampered = `${firstCursor.slice(0, -1)}x`;
    const tamperedError = await captureEdgeError(() =>
      listRoomOperationBlocks(
        readRequest(
          `/v1/rooms/${roomId}/operation-blocks?cursor=${
            encodeURIComponent(tampered)
          }`,
        ),
        clients,
        admin,
        roomId,
      )
    );
    assert(
      tamperedError.code === "INVALID_ROOM_OPERATION_CURSOR",
      "tamper rejected",
    );
    const scopeError = await captureEdgeError(() =>
      listRoomIssues(
        readRequest(
          `/v1/rooms/${roomId}/issues?cursor=${
            encodeURIComponent(firstCursor)
          }`,
        ),
        clients,
        admin,
        roomId,
      )
    );
    assert(
      scopeError.code === "INVALID_ROOM_OPERATION_CURSOR",
      "cross-stream cursor rejected",
    );
  } finally {
    if (previous === undefined) {
      Deno.env.delete("INSPECTION_CURSOR_HMAC_SECRET");
    } else Deno.env.set("INSPECTION_CURSOR_HMAC_SECRET", previous);
  }
});

Deno.test("room type catalog rejects non-admin and temporary-password actors", async () => {
  const maidError = await captureEdgeError(() =>
    listRoomTypes(readRequest(), {} as EdgeClients, { ...admin, role: "maid" })
  );
  assert(maidError.status === 403, "maid denied");
  const passwordError = await captureEdgeError(() =>
    listRoomTypes(readRequest(), {} as EdgeClients, {
      ...admin,
      mustChangePassword: true,
    })
  );
  assert(passwordError.code === "PASSWORD_CHANGE_REQUIRED", "password gate");
});

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

  const rooms = await listRooms(readRequest("/v1/rooms"), clients, admin);
  const detail = await getRoom(
    readRequest(`/v1/rooms/${rows[0].id}`),
    clients,
    admin,
    rows[0].id,
  );
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
    getRoom(
      readRequest("/v1/rooms/30000000-0000-4000-8000-999999999999"),
      clients,
      admin,
      "30000000-0000-4000-8000-999999999999",
    )
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
      listRooms(readRequest("/v1/rooms"), {} as EdgeClients, actor)
    );
    assert(error.code === "ADMIN_REQUIRED", `${actor.role} denied`);
  }
  const temporary = await captureEdgeError(() =>
    listRooms(
      readRequest("/v1/rooms"),
      {} as EdgeClients,
      { ...admin, mustChangePassword: true },
    )
  );
  assert(
    temporary.code === "PASSWORD_CHANGE_REQUIRED",
    "temporary password denied",
  );
});

Deno.test("room list serviceDate accepts one real calendar date only", () => {
  for (
    const value of [
      "0001-01-01",
      "0099-12-31",
      "0096-02-29",
      "0100-01-01",
      "2000-02-29",
      "2026-09-22",
      "9999-12-31",
    ]
  ) {
    assert(
      roomListServiceDate(readRequest(`/v1/rooms?serviceDate=${value}`)) ===
        value,
      `${value} valid date without 1900 year remapping`,
    );
  }
  assert(
    roomListServiceDate(readRequest("/v1/rooms")) === null,
    "omitted date",
  );
  for (
    const path of [
      "/v1/rooms?serviceDate=0000-01-01",
      "/v1/rooms?serviceDate=0099-02-29",
      "/v1/rooms?serviceDate=0100-02-29",
      "/v1/rooms?serviceDate=1900-02-29",
      "/v1/rooms?serviceDate=2026-02-29",
      "/v1/rooms?serviceDate=2026-02-30",
      "/v1/rooms?serviceDate=2026-9-22",
      "/v1/rooms?serviceDate=2026-09-22&serviceDate=2026-09-23",
      "/v1/rooms?unexpected=true",
    ]
  ) {
    let rejected = false;
    try {
      roomListServiceDate(readRequest(path));
    } catch (error) {
      rejected = error instanceof EdgeError && error.status === 400;
    }
    assert(rejected, `${path} rejected`);
  }
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

  const mutations = calls.filter(([name]) =>
    ["mutate_room_operation", "set_room_candle_count"].includes(name)
  );
  assert(mutations.length === 6, "exact six mutation calls");
  assert(
    mutations.map(([name, args]) =>
      name === "set_room_candle_count" ? "set_candle_count" : args.p_action
    ).join(",") ===
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

Deno.test("all maids get only candle fields and use the session-bound candle command", async () => {
  const maid = { ...admin, role: "maid" as const };
  const item = { roomId, roomNumber: "350", count: 2, roomStateVersion: 3 };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        return Promise.resolve({
          data: {
            items: [{
              ...item,
              pin: "not-returned",
              guestName: "not-returned",
            }],
            nextCursor: null,
          },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const page = await listRoomCandles(
    readRequest(`/v1/rooms/candles?roomId=${roomId}`),
    clients,
    maid,
  );
  assert(
    JSON.stringify(page) ===
      JSON.stringify({ items: [item], nextCursor: null }),
    "safe minimal projection",
  );
  assert(
    calls[0][1].p_session_id === sessionId && calls[0][1].p_room_id === roomId,
    "session and filter binding",
  );
  for (
    const query of [
      "limit=51",
      "limit=01",
      "limit=1&limit=2",
      `roomId=${roomId}&cursor=${roomId}`,
      "pin=true",
    ]
  ) {
    const error = await captureEdgeError(() =>
      listRoomCandles(readRequest(`/v1/rooms/candles?${query}`), clients, maid)
    );
    assert(error.status === 400, "strict bounded query");
  }
  for (
    const forbidden of [{ ...maid, role: "developer" as const }, {
      ...maid,
      mustChangePassword: true,
    }]
  ) {
    const error = await captureEdgeError(() =>
      listRoomCandles(readRequest("/v1/rooms/candles"), clients, forbidden)
    );
    assert(error.status === 403, "developer/password gate");
  }
  const mutations: Array<[string, Record<string, unknown>]> = [];
  await setRoomCandleCount(
    commandRequest(`/v1/rooms/${roomId}/candles`, {
      count: 0,
      physicallyVerified: true,
      expectedRoomVersion: 3,
      reasonCode: "CANDLE_COLLECTED",
    }),
    operationClients(mutations),
    maid,
    roomId,
  );
  assert(
    mutations[0][0] === "set_room_candle_count" &&
      mutations[0][1].p_session_id === sessionId &&
      !("p_action" in mutations[0][1]),
    "narrow command, no arbitrary operation",
  );
  const denied = await captureEdgeError(() =>
    createRoomOperationBlock(
      commandRequest(`/v1/rooms/${roomId}/operation-blocks`, {}),
      clients,
      maid,
      roomId,
    )
  );
  assert(denied.status === 403, "other room commands remain admin only");
});

Deno.test("candle commands reject invalid input and redact DB errors", async () => {
  const body = {
    count: 0,
    physicallyVerified: true,
    expectedRoomVersion: 3,
    reasonCode: "CANDLE_COLLECTED",
  };
  for (
    const patch of [{ count: -1 }, { count: 2147483648 }, { count: 1.5 }, {
      expectedRoomVersion: 1e20,
    }, { assignmentId: roomId }]
  ) {
    const error = await captureEdgeError(() =>
      setRoomCandleCount(
        commandRequest(`/v1/rooms/${roomId}/candles`, { ...body, ...patch }),
        operationClients([]),
        admin,
        roomId,
      )
    );
    assert(error.status === 400, "invalid input rejected");
  }
  for (
    const [code, status] of [
      ["CANDLE_ACCESS_REQUIRED", 403],
      ["CANDLE_VERIFICATION_REQUIRED", 400],
      ["SESSION_REVOKED", 401],
      ["STALE_VERSION", 409],
      ["PASSWORD_CHANGE_REQUIRED", 403],
      ["INVALID_CANDLE_REQUEST", 400],
    ] as const
  ) {
    const clients = {
      admin: {
        rpc: () =>
          Promise.resolve({
            data: null,
            error: { message: `${code}: private-detail` },
          }),
      },
    } as unknown as EdgeClients;
    const error = await captureEdgeError(() =>
      setRoomCandleCount(
        commandRequest(`/v1/rooms/${roomId}/candles`, body),
        clients,
        admin,
        roomId,
      )
    );
    assert(
      error.status === status && !error.message.includes("private-detail"),
      "safe error mapping",
    );
  }
});

Deno.test("occupancy correction is a separate admin session-bound command", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const correctionId = "71000000-0000-4000-8000-000000000001";
  const reservationId = "80000000-0000-4000-8000-000000000001";
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        return {
          data: {
            correction_id: correctionId,
            room_id: roomId,
            reservation_id: reservationId,
            occupied: false,
            effective_at: "2026-09-20T00:00:00.000Z",
            room_state_version: 4,
            recorded_at: "2026-09-20T00:00:01.000Z",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  const result = await correctRoomOccupancy(
    commandRequest(`/v1/rooms/${roomId}/occupancy-corrections`, {
      reservationId,
      occupied: false,
      effectiveAt: "2026-09-20T00:00:00.000Z",
      expectedRoomVersion: 3,
      reasonCode: "FRONT_DESK_VERIFIED",
    }),
    clients,
    admin,
    roomId,
  );
  assert(result.correctionId === correctionId, "correction mapped");
  assert(calls[0][0] === "correct_room_occupancy", "dedicated RPC");
  assert(calls[0][1].p_session_id === sessionId, "live session bound");
  assert(calls[0][1].p_expected_room_version === 3, "room CAS");

  for (const role of ["maid", "developer"] as const) {
    const denied = await captureEdgeError(() =>
      correctRoomOccupancy(
        commandRequest(`/v1/rooms/${roomId}/occupancy-corrections`, {
          reservationId,
          occupied: false,
          effectiveAt: "2026-09-20T00:00:00.000Z",
          expectedRoomVersion: 3,
          reasonCode: "FRONT_DESK_VERIFIED",
        }),
        clients,
        { ...admin, role },
        roomId,
      )
    );
    assert(denied.status === 403, `${role} denied`);
  }
});

Deno.test("occupancy correction database failures keep stable Edge codes", () => {
  for (
    const [databaseCode, status] of [
      ["RESERVATION_NOT_FOUND", 404],
      ["STAY_SEGMENT_CONTRACT_MISMATCH", 409],
      ["OCCUPANCY_CORRECTION_ROOM_MISMATCH", 409],
      ["ROOM_OCCUPANCY_CONFLICT", 409],
    ] as const
  ) {
    const mapped = roomDatabaseError({ message: databaseCode });
    assert(mapped.status === status, `${databaseCode} status`);
    assert(mapped.code === databaseCode, `${databaseCode} code`);
  }
});

Deno.test("display status override is display-only, session-bound, and supports clear", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        return {
          data: {
            override_id: "72000000-0000-4000-8000-000000000001",
            room_id: roomId,
            target_status: args.p_target_status,
            room_state_version: 5,
            recorded_at: "2026-09-20T00:00:01.000Z",
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;

  for (
    const targetStatus of [
      "BLOCKED",
      "OCCUPIED",
      "ARRIVAL_PENDING",
      "RESERVATION_PRESENT",
      "CLEANING_REQUIRED",
      "READY",
      null,
    ] as const
  ) {
    const result = await overrideRoomDisplayStatus(
      commandRequest(
        `/v1/rooms/${roomId}/display-status-overrides`,
        {
          targetStatus,
          expectedRoomVersion: 4,
          reasonCode: "FRONT_DESK_VERIFIED",
        },
        "POST",
        `display-${targetStatus ?? "clear"}`,
      ),
      clients,
      admin,
      roomId,
    );
    assert(result.targetStatus === targetStatus, `${targetStatus} mapped`);
  }
  assert(
    calls.every(([name, args]) =>
      name === "override_room_display_status" &&
      args.p_session_id === sessionId
    ),
    "dedicated session-bound RPC",
  );
  for (const role of ["maid", "developer"] as const) {
    const denied = await captureEdgeError(() =>
      overrideRoomDisplayStatus(
        commandRequest(`/v1/rooms/${roomId}/display-status-overrides`, {
          targetStatus: "READY",
          expectedRoomVersion: 5,
          reasonCode: "FRONT_DESK_VERIFIED",
        }),
        clients,
        { ...admin, role },
        roomId,
      )
    );
    assert(denied.status === 403, `${role} display override denied`);
  }
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
  const invalidPinReason = roomDatabaseError({
    message: "INVALID_PIN_CHANGE_REASON: private detail",
  });
  assert(
    invalidPinReason.status === 409 &&
      invalidPinReason.code === "INVALID_PIN_CHANGE_REASON" &&
      !invalidPinReason.message.includes("private detail"),
    "invalid PIN reason is a stable redacted conflict",
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
  assert(
    room.evaluatedAt === "2026-09-16T08:00:00.000Z",
    "evaluatedAt mapped",
  );
  assert(room.reservationPhase === "current", "reservationPhase mapped");
  assert(room.serverTime === room.evaluatedAt, "one server snapshot mapped");
  assert(room.occupancyStatus === "OCCUPIED", "occupancyStatus mapped");
  assert(
    room.reservationLifecycle === "OCCUPIED",
    "reservationLifecycle mapped",
  );
  assert(room.primaryDisplayStatus === "OCCUPIED", "display status mapped");
  assert(
    room.nextReservationId === "30000000-0000-4000-8000-000000000010",
    "next future reservation mapped",
  );
  assert(!("raw_pin" in room), "unknown DB field removed");
  assert(!JSON.stringify(room).includes("must-not-leak"), "raw PIN removed");
});

Deno.test("room operation reads map only safe fields and bind the live session", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        if (name === "list_room_operation_blocks_page") {
          return Promise.resolve({
            error: null,
            data: {
              roomId,
              roomStateVersion: 9,
              evaluatedAt: "2026-09-20T01:00:00.000Z",
              items: [{
                id: blockId,
                reasonCode: "MAINTENANCE",
                startsAt: "2026-09-20T00:00:00.000Z",
                endsAt: null,
                status: "active",
                createdAt: "2026-09-19T00:00:00.000Z",
                raw_pin: "must-not-leak",
              }],
              hasMore: false,
              nextCursor: null,
            },
          });
        }
        return Promise.resolve({
          error: null,
          data: {
            roomId,
            roomStateVersion: 10,
            evaluatedAt: "2026-09-20T01:00:00.000Z",
            items: [{
              id: issueId,
              category: "FACILITY",
              severity: "warning",
              blocksGuestAssignment: true,
              description: "창문 점검",
              status: "open",
              reportedAt: "2026-09-19T00:00:00.000Z",
              guestName: "must-not-leak",
            }],
            hasMore: false,
            nextCursor: null,
          },
        });
      },
    },
  } as unknown as EdgeClients;
  const blocks = await listRoomOperationBlocks(
    readRequest(),
    clients,
    admin,
    roomId,
  );
  const issues = await listRoomIssues(readRequest(), clients, admin, roomId);

  assert(blocks.roomStateVersion === 9, "block CAS version mapped");
  assert(blocks.items[0]?.status === "active", "derived status mapped");
  assert(
    blocks.hasMore === false && blocks.nextCursor === null,
    "block page metadata mapped",
  );
  assert(issues.roomStateVersion === 10, "issue CAS version mapped");
  assert(issues.items[0]?.status === "open", "open issue mapped");
  assert(
    issues.hasMore === false && issues.nextCursor === null,
    "issue page metadata mapped",
  );
  assert(
    !JSON.stringify(blocks).includes("must-not-leak"),
    "PIN field removed",
  );
  assert(
    !JSON.stringify(issues).includes("must-not-leak"),
    "guest field removed",
  );
  assert(
    calls.every(([, args]) => args.p_session_id === sessionId),
    "both reads bind the verified JWT session",
  );
});

Deno.test("room operation reads reject cross-room and over-limit DB pages", async () => {
  const data: Record<string, unknown> = {
    roomId: "30000000-0000-4000-8000-000000000002",
    roomStateVersion: 9,
    evaluatedAt: "2026-09-20T01:00:00.000Z",
    items: [],
    hasMore: false,
    nextCursor: null,
  };
  const clients = {
    admin: {
      rpc() {
        return Promise.resolve({ error: null, data });
      },
    },
  } as unknown as EdgeClients;
  const crossRoom = await captureEdgeError(() =>
    listRoomOperationBlocks(
      readRequest(`/v1/rooms/${roomId}/operation-blocks?limit=1`),
      clients,
      admin,
      roomId,
    )
  );
  assert(crossRoom.code === "ROOM_PROJECTION_INVALID", "cross-room rejected");

  data.roomId = roomId;
  data.items = [{}, {}];
  const overLimit = await captureEdgeError(() =>
    listRoomOperationBlocks(
      readRequest(`/v1/rooms/${roomId}/operation-blocks?limit=1`),
      clients,
      admin,
      roomId,
    )
  );
  assert(overLimit.code === "ROOM_PROJECTION_INVALID", "over-limit rejected");
});

Deno.test("room event timeline maps the bounded safe projection", async () => {
  const reservationId = "80000000-0000-4000-8000-000000000001";
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        assert(name === "list_room_events", "event projection RPC");
        assert(args.p_session_id === sessionId, "live session bound");
        assert(args.p_limit === 30, "bounded limit forwarded");
        return Promise.resolve({
          error: null,
          data: {
            roomId,
            roomStateVersion: 11,
            evaluatedAt: "2026-09-20T01:00:00.000Z",
            items: [{
              id: "90000000-0000-4000-8000-000000000001",
              eventKey: "occupancy:90000000-0000-4000-8000-000000000001",
              source: "occupancy",
              category: "occupancy",
              eventType: "scheduled_check_in",
              actorProfileId: admin.profileId,
              actorDisplayName: null,
              entityId: reservationId,
              reasonCode: "SCHEDULED_TRANSITION",
              effectiveAt: "2026-09-20T00:00:00.000Z",
              recordedAt: "2026-09-20T00:00:01.000Z",
              reservationId,
              summary: {
                occupiedBefore: false,
                occupiedAfter: true,
                guestName: "must-not-leak",
              },
              requestHash: "must-not-leak",
            }],
          },
        });
      },
    },
  } as unknown as EdgeClients;

  const timeline = await listRoomEvents(
    readRequest(),
    clients,
    admin,
    roomId,
    30,
  );
  assert(timeline.roomStateVersion === 11, "room version mapped");
  assert(
    timeline.items[0]?.reservationId === reservationId,
    "reservation mapped",
  );
  assert(
    timeline.items[0]?.eventKey ===
        "occupancy:90000000-0000-4000-8000-000000000001" &&
      timeline.items[0]?.category === "occupancy" &&
      timeline.items[0]?.actorProfileId === admin.profileId &&
      timeline.items[0]?.actorDisplayName === null &&
      timeline.items[0]?.entityId === reservationId,
    "stable identity, catalog category, actor and entity mapped",
  );
  assert(
    !JSON.stringify(timeline).includes("must-not-leak"),
    "raw and unknown summary fields removed",
  );
});
