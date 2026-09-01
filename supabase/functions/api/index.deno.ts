import { type ApiHandlerDependencies, handleApiRequest } from "./index.ts";
import type { EdgeActor, EdgeClients } from "../_shared/runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const actor: EdgeActor = {
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
  elevator_zone: "A",
  data_status: "verified",
  state_version: 3,
  occupied: false,
  cleaning_required: false,
  candle_count: 0,
  pin_sync_status: "verified",
  allocation_blocked: false,
  allocation_ready: true,
  reason_codes: [],
};

function routeDependencies(calls: string[]): ApiHandlerDependencies {
  const clients = {
    admin: {
      async rpc(name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (name === "get_room_operational_projection") {
          return { data: [roomRow], error: null };
        }
        if (name === "change_room_master_data") {
          return { data: null, error: null };
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
  return {
    createClients: () => clients,
    authenticateRequest: () => Promise.resolve(actor),
  };
}

function request(
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Request {
  return new Request(`http://localhost/functions/v1/api${path}`, {
    method,
    headers: body
      ? {
        "content-type": "application/json",
        "idempotency-key": "room-route-regression-0001",
      }
      : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = await response.json() as { error?: { code?: string } };
  return payload.error?.code;
}

Deno.test("Room GET detail route rejects every mutation-shaped alias", async () => {
  const forbiddenGetPaths = [
    `/v1/rooms/${roomId}/master-data`,
    `/v1/rooms/${roomId}/operation-blocks`,
    `/v1/rooms/${roomId}/candles`,
    `/v1/rooms/${roomId}/issues`,
    `/v1/rooms/${roomId}/pin-sync-events`,
    `/v1/rooms/${roomId}/operation-blocks/${blockId}/release`,
    `/v1/rooms/${roomId}/issues/${issueId}/resolve`,
  ];

  for (const path of forbiddenGetPaths) {
    const calls: string[] = [];
    const response = await handleApiRequest(
      request("GET", path),
      routeDependencies(calls),
    );
    assert(response.status === 404, `${path} must return 404`);
    assert(
      await errorCode(response) === "ROUTE_NOT_FOUND",
      `${path} must use the unknown route contract`,
    );
    assert(calls.length === 0, `${path} must not call a Room RPC`);
  }
});

Deno.test("Room list, exact detail, and mutation routes remain reachable", async () => {
  const routes: Array<{
    method: string;
    path: string;
    status: number;
    body?: Record<string, unknown>;
  }> = [
    { method: "GET", path: "/v1/rooms", status: 200 },
    { method: "GET", path: `/v1/rooms/${roomId}`, status: 200 },
    {
      method: "PATCH",
      path: `/v1/rooms/${roomId}/master-data`,
      status: 200,
      body: {
        roomTypeId,
        elevatorZone: "A",
        dataStatus: "verified",
        dataStatusReason: null,
        expectedVersion: 3,
        reasonCode: "MASTER_DATA_CHANGED",
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/operation-blocks`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "MAINTENANCE",
        startsAt: "2026-09-01T00:00:00Z",
        endsAt: null,
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/operation-blocks/${blockId}/release`,
      status: 200,
      body: { expectedRoomVersion: 3, reasonCode: "MAINTENANCE_DONE" },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/candles`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "PHYSICAL_CHECK",
        count: 0,
        physicallyVerified: true,
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/issues`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "ISSUE_REPORTED",
        category: "FACILITY",
        severity: "warning",
        blocksGuestAssignment: true,
        description: "시설 확인 필요",
      },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/issues/${issueId}/resolve`,
      status: 200,
      body: { expectedRoomVersion: 3, reasonCode: "ISSUE_RESOLVED" },
    },
    {
      method: "POST",
      path: `/v1/rooms/${roomId}/pin-sync-events`,
      status: 201,
      body: {
        expectedRoomVersion: 3,
        reasonCode: "SYNC_VERIFIED",
        syncStatus: "verified",
        pinVersion: 2,
      },
    },
  ];

  for (const route of routes) {
    const calls: string[] = [];
    const response = await handleApiRequest(
      request(route.method, route.path, route.body),
      routeDependencies(calls),
    );
    assert(
      response.status === route.status,
      `${route.method} ${route.path} expected ${route.status}, got ${response.status}`,
    );
    assert(
      calls.length > 0,
      `${route.method} ${route.path} must call a Room RPC`,
    );
  }
});
