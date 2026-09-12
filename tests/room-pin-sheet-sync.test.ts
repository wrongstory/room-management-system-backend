import { describe, expect, it } from "vitest";
import {
  encryptRoomPin,
  type RoomPinCryptoConfig,
} from "../src/modules/rooms/room-pin-crypto.js";
import {
  handleRoomPinSheetSync,
  loadRoomPinSheetRuntimeConfig,
  RoomPinSheetSyncWorker,
  type RoomPinSheetProvider,
  type RoomPinSheetRpc,
} from "../src/modules/rooms/room-pin-sheet-sync.js";
import {
  GoogleSheetsPinProvider,
  LOCAL_ROOM_PIN_SHEET_TARGET,
  RoomPinSheetProviderError,
} from "../src/modules/rooms/google-sheets-pin.js";

const ids = {
  room: "00000000-0000-4000-8000-000000000001",
  outbox: "00000000-0000-4000-8000-000000000002",
};
const config: RoomPinCryptoConfig = {
  key: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))),
  keyVersion: "v1",
  keyring: {},
  environment: "local",
  projectRef: "local",
  nonce: new Uint8Array(12).fill(1),
};
async function fixture() {
  const envelope = await encryptRoomPin("101-1234", ids.room, 1, config);
  return {
    outboxId: ids.outbox,
    roomId: ids.room,
    roomNumber: "101",
    sheetRow: 2,
    pinVersion: 1,
    effectiveAt: "2026-09-13T00:00:00.000Z",
    syncStatus: "verified",
    reasonCode: "PIN_CHANGE_CONFIRMED",
    leaseFence: 4,
    ...envelope,
  };
}
async function setup(
  mode: "write" | "current" | "retry" | "blocked" = "write",
) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [],
    row = await fixture();
  const db: RoomPinSheetRpc = {
    rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_room_pin_sheet_sync")
        return {
          data: { status: "claimed", items: [row], blocked: 0, leaseFence: 4 },
          error: null,
        };
      if (name === "renew_room_pin_sheet_sync_run")
        return { data: { status: "leased", leaseFence: 4 }, error: null };
      if (name === "authorize_room_pin_sheet_write")
        return { data: { status: "authorized", leaseFence: 4 }, error: null };
      if (name === "settle_room_pin_sheet_sync")
        return {
          data: {
            status:
              args.p_outcome === "retryable"
                ? "failed"
                : args.p_outcome === "operator_blocked"
                  ? "operator_blocked"
                  : "succeeded",
          },
          error: null,
        };
      return { data: { status: args.p_status }, error: null };
    },
  };
  const provider: RoomPinSheetProvider = {
    inspect: async (value) => {
      expect(value.canonicalPin).toBe("101-1234");
      if (mode === "retry") throw new RoomPinSheetProviderError("RATE_LIMITED");
      if (mode === "blocked")
        throw new RoomPinSheetProviderError("AUTHORIZATION_FAILED");
      return { outcome: mode, sheetRow: 2 };
    },
    write: async (value) => {
      expect(value.roomNumber).toBe("101");
      expect(value.syncStatus).toBe("verified");
    },
  };
  return {
    worker: new RoomPinSheetSyncWorker(db, provider, config),
    calls,
    provider,
  };
}

describe("room PIN Sheet sync worker", () => {
  it("rejects an unapproved hosted target before reading PIN or Google credentials", () => {
    const reads: string[] = [],
      environment: Record<string, string> = {
        RUNTIME_ENVIRONMENT: "production",
        SUPABASE_PROJECT_REF: "prod",
        GOOGLE_SHEETS_SPREADSHEET_ID: "test-room-pin-sheet-projection-00001",
        GOOGLE_SHEETS_ROOM_PIN_TAB: "객실_PIN_현황",
      };
    expect(() =>
      loadRoomPinSheetRuntimeConfig((name) => {
        reads.push(name);
        return environment[name];
      }),
    ).toThrowError("ROOM_PIN_SHEET_PROVIDER_FAILED");
    expect(reads).toEqual([
      "RUNTIME_ENVIRONMENT",
      "SUPABASE_PROJECT_REF",
      "GOOGLE_SHEETS_SPREADSHEET_ID",
      "GOOGLE_SHEETS_ROOM_PIN_TAB",
    ]);
    expect(reads).not.toContain("ROOM_PIN_KEY_BASE64");
    expect(reads).not.toContain("GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY");
  });
  it("fences the provider write and settles exactly one current projection", async () => {
    const value = await setup();
    expect(JSON.stringify(value.worker)).toBe("{}");
    expect(await value.worker.run()).toMatchObject({
      claimed: 1,
      projected: 1,
      blocked: 0,
    });
    expect(value.calls.map((call) => call.name)).toEqual([
      "claim_room_pin_sheet_sync",
      "renew_room_pin_sheet_sync_run",
      "authorize_room_pin_sheet_write",
      "settle_room_pin_sheet_sync",
      "record_room_pin_sheet_sync_heartbeat",
    ]);
    expect(
      value.calls.find(
        (call) => call.name === "record_room_pin_sheet_sync_heartbeat",
      )?.args,
    ).toMatchObject({ p_status: "succeeded", p_projected: 1 });
    expect(JSON.stringify(value.calls)).not.toContain("101-1234");
    expect(JSON.stringify(value.worker)).toBe("{}");
    expect(JSON.stringify(value.worker)).not.toContain(config.key);
  });
  it("settles exact current without authorizing a provider write", async () => {
    const value = await setup("current");
    expect(await value.worker.run()).toMatchObject({
      alreadyCurrent: 1,
      projected: 0,
    });
    expect(value.calls.map((call) => call.name)).not.toContain(
      "authorize_room_pin_sheet_write",
    );
  });
  it("classifies bounded retry and global operator block without leaking provider details", async () => {
    const retry = await setup("retry");
    expect(await retry.worker.run()).toMatchObject({ retrying: 1, blocked: 0 });
    expect(
      retry.calls.find((call) => call.name === "settle_room_pin_sheet_sync")
        ?.args,
    ).toMatchObject({ p_outcome: "retryable", p_reason_code: "RATE_LIMITED" });
    const blocked = await setup("blocked");
    expect(await blocked.worker.run()).toMatchObject({ blocked: 1 });
    expect(
      blocked.calls.find(
        (call) => call.name === "record_room_pin_sheet_sync_heartbeat",
      )?.args,
    ).toMatchObject({ p_status: "operator_blocked", p_blocked: 1 });
  });
  it("settles malformed service-account configuration after claim without contacting Google", async () => {
    const source = await fixture(),
      calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let fetches = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "claim_room_pin_sheet_sync") {
          return {
            data: {
              status: "claimed",
              items: [source],
              blocked: 0,
              leaseFence: 4,
            },
            error: null,
          };
        }
        if (name === "renew_room_pin_sheet_sync_run") {
          return { data: { status: "leased", leaseFence: 4 }, error: null };
        }
        if (name === "settle_room_pin_sheet_sync") {
          return { data: { status: "operator_blocked" }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      },
    };
    const provider = new GoogleSheetsPinProvider(
      LOCAL_ROOM_PIN_SHEET_TARGET,
      {
        email: "synthetic@project.iam.gserviceaccount.com",
        privateKeyPem: "malformed",
      },
      async () => {
        fetches++;
        return Response.json({});
      },
    );
    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).resolves.toMatchObject({ blocked: 1, projected: 0 });
    expect(fetches).toBe(0);
    expect(
      calls.find((call) => call.name === "settle_room_pin_sheet_sync")?.args,
    ).toMatchObject({
      p_outcome: "operator_blocked",
      p_reason_code: "PROVIDER_CONFIGURATION_ERROR",
    });
    expect(
      calls.find(
        (call) => call.name === "record_room_pin_sheet_sync_heartbeat",
      )?.args,
    ).toMatchObject({ p_status: "operator_blocked", p_blocked: 1 });
  });
  it("does not begin a write without the provider reserve and finishes settle/heartbeat before 45 seconds", async () => {
    const source = await fixture(),
      times: Array<{ name: string; now: number }> = [];
    let now = 0,
      writes = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        times.push({ name, now });
        if (name === "claim_room_pin_sheet_sync") {
          now = 1000;
          return {
            data: {
              status: "claimed",
              items: [source],
              blocked: 0,
              leaseFence: 4,
            },
            error: null,
          };
        }
        if (name === "renew_room_pin_sheet_sync_run") {
          now = 2000;
          return { data: { status: "leased", leaseFence: 4 }, error: null };
        }
        if (name === "authorize_room_pin_sheet_write") {
          now = 32800;
          return { data: { status: "authorized", leaseFence: 4 }, error: null };
        }
        if (name === "settle_room_pin_sheet_sync") {
          now = 35000;
          return { data: { status: "failed" }, error: null };
        }
        now = 39000;
        return { data: { status: args.p_status }, error: null };
      },
    };
    const provider: RoomPinSheetProvider = {
      inspect: async (_row, deadline) => {
        expect(deadline).toBe(33000);
        now = 32000;
        return { outcome: "write", sheetRow: 2 };
      },
      write: async () => {
        writes++;
      },
    };
    const result = await new RoomPinSheetSyncWorker(
      db,
      provider,
      config,
      () => now,
    ).run();
    expect(result).toMatchObject({ blocked: 0, retrying: 1, projected: 0 });
    expect(writes).toBe(0);
    expect(
      times.find((value) => value.name === "settle_room_pin_sheet_sync"),
    ).toBeDefined();
    expect(
      times.find((value) => value.name === "settle_room_pin_sheet_sync")?.now,
    ).toBeLessThanOrEqual(39000);
    expect(
      times.find(
        (value) => value.name === "record_room_pin_sheet_sync_heartbeat",
      )?.now,
    ).toBeLessThan(45000);
  });
  it("fails closed on an invalid provider inspection outcome before authorization", async () => {
    const value = await setup();
    value.provider.inspect = async () => ({
      outcome: "unexpected" as "write",
      sheetRow: 2,
    });
    await expect(value.worker.run()).resolves.toMatchObject({
      blocked: 1,
      projected: 0,
    });
    expect(value.calls.map((call) => call.name)).not.toContain(
      "authorize_room_pin_sheet_write",
    );
    expect(
      value.calls.find((call) => call.name === "settle_room_pin_sheet_sync")
        ?.args,
    ).toMatchObject({
      p_outcome: "operator_blocked",
      p_reason_code: "PROVIDER_RESPONSE_INVALID",
    });
  });
  it("rejects wrong route, method, secret and body before running", async () => {
    const secret = "s".repeat(32);
    let runs = 0;
    const run = async () => {
      runs++;
      return {
        claimed: 0,
        projected: 0,
        alreadyCurrent: 0,
        superseded: 0,
        retrying: 0,
        blocked: 0,
        busy: false,
      };
    };
    expect(
      (
        await handleRoomPinSheetSync(
          new Request("http://local/wrong", { method: "POST" }),
          secret,
          run,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handleRoomPinSheetSync(
          new Request("http://local/room-pin-sheet-sync"),
          secret,
          run,
        )
      ).status,
    ).toBe(405);
    expect(
      (
        await handleRoomPinSheetSync(
          new Request("http://local/room-pin-sheet-sync", {
            method: "POST",
            headers: { "x-room-pin-sheet-sync-secret": "x".repeat(32) },
          }),
          secret,
          run,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleRoomPinSheetSync(
          new Request("http://local/room-pin-sheet-sync", {
            method: "POST",
            headers: { "x-room-pin-sheet-sync-secret": secret },
            body: "secret body",
          }),
          secret,
          run,
        )
      ).status,
    ).toBe(400);
    expect(runs).toBe(0);
  });
  it("accepts one authenticated empty POST and returns only safe counters", async () => {
    const secret = "s".repeat(32);
    const response = await handleRoomPinSheetSync(
      new Request("http://local/room-pin-sheet-sync", {
        method: "POST",
        headers: { "x-room-pin-sheet-sync-secret": secret },
      }),
      secret,
      async () => ({
        claimed: 1,
        projected: 1,
        alreadyCurrent: 0,
        superseded: 0,
        retrying: 0,
        blocked: 0,
        busy: false,
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: {
        claimed: 1,
        projected: 1,
        alreadyCurrent: 0,
        superseded: 0,
        retrying: 0,
        blocked: 0,
        busy: false,
      },
    });
  });
});
