import { describe, expect, it } from "vitest";
import type { Actor } from "../src/domain/actor.js";
import type { SupabaseClients } from "../src/lib/supabase.js";
import { SupabaseDeveloperRoomCatalogService } from "../src/modules/developer-room-catalog/developer-room-catalog.service.js";

const sessionId = "51000000-0000-4000-8000-000000000230";
const actor: Actor = {
  authUserId: "10000000-0000-4000-8000-000000000230",
  profileId: "20000000-0000-4000-8000-000000000230",
  displayName: "개발자",
  role: "developer",
  mustChangePassword: false,
  accessToken: `e30.${
    Buffer.from(JSON.stringify({ session_id: sessionId })).toString("base64url")
  }.signature`,
};
function setup(data: unknown, message?: string) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const clients = {
    admin: {
      rpc: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { data, error: message ? { message } : null };
      },
    },
  } as unknown as SupabaseClients;
  return { calls, service: new SupabaseDeveloperRoomCatalogService(clients) };
}

describe("SupabaseDeveloperRoomCatalogService", () => {
  it("binds bounded listing to the live developer session and produces a cursor", async () => {
    const data = {
      counts: { active: 121, retired: 1, total: 122 },
      items: [],
      hasMore: true,
      nextRoomNumber: "608",
      nextId: "30000000-0000-4000-8000-000000000230",
    };
    const { calls, service } = setup(data);
    const result = await service.list(actor, "all", null, 50);
    expect(result.counts).toEqual(data.counts);
    expect(result.nextCursor).toEqual(expect.any(String));
    expect(calls[0]).toMatchObject({
      name: "list_developer_room_catalog",
      args: {
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId,
        p_status: "all",
        p_limit: 50,
      },
    });
  });

  it("sends create CAS, idempotency key, and a stable request hash", async () => {
    const room = {
      id: "30000000-0000-4000-8000-000000000230",
      roomNumber: "999",
      status: "active",
    };
    const first = setup(room);
    const second = setup(room);
    const input = {
      roomNumber: "999",
      roomTypeId: "40000000-0000-4000-8000-000000000230",
      expectedRoomTypeVersion: 3,
      elevatorZone: "A" as const,
      idempotencyKey: "room-create-0230",
    };
    await first.service.create(actor, input);
    await second.service.create(actor, input);
    expect(first.calls[0]?.args.p_request_hash).toBe(
      second.calls[0]?.args.p_request_hash,
    );
    expect(first.calls[0]).toMatchObject({
      name: "create_room_catalog_entry",
      args: {
        p_expected_room_type_version: 3,
        p_idempotency_key: input.idempotencyKey,
      },
    });
  });

  it("maps retirement conflicts and denies a non-developer before RPC", async () => {
    const conflict = setup(null, "ROOM_RETIRE_RESERVATION_CONFLICT");
    await expect(
      conflict.service.retire(actor, {
        roomId: "30000000-0000-4000-8000-000000000230",
        expectedVersion: 1,
        reasonCode: "ROOM_REMOVED",
        idempotencyKey: "room-retire-0230",
      }),
    )
      .rejects.toMatchObject({
        statusCode: 409,
        code: "ROOM_RETIRE_RESERVATION_CONFLICT",
      });
    const denied = setup(null);
    await expect(
      denied.service.list({ ...actor, role: "admin" }, "all", null, 50),
    )
      .rejects.toMatchObject({ statusCode: 403, code: "DEVELOPER_REQUIRED" });
    expect(denied.calls).toHaveLength(0);
  });
});
