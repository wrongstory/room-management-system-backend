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
async function fullResyncFixture() {
  const first = await fixture();
  return {
    runId: "00000000-0000-4000-8000-000000000099",
    leaseFence: 8,
    items: Array.from({ length: 121 }, (_, index) => ({
      roomId: index === 0 ? first.roomId : `00000000-0000-4000-8${String(index).padStart(3, "0")}-${String(index + 100).padStart(12, "0")}`,
      roomNumber: index === 0 ? "101" : String(1001 + index),
      sheetRow: index + 2,
      pinVersion: index === 0 ? 1 : 0,
      effectiveAt: "2026-09-13T00:00:00.000Z",
      syncStatus: index === 0 ? "verified" : "unconfigured",
      reasonCode: "FULL_RESYNC_REPAIR",
      ...(index === 0
        ? { envelope: {
          envelopeFormat: first.envelopeFormat,
          keyVersion: first.keyVersion,
          ciphertextBase64: first.ciphertextBase64,
          nonceBase64: first.nonceBase64,
          authTagBase64: first.authTagBase64,
          aadEnvironment: first.aadEnvironment,
          aadProjectRef: first.aadProjectRef,
        } }
        : {}),
    })),
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
      if (name === "claim_room_pin_sheet_full_resync")
        return { data: { status: "empty", leaseFence: 0 }, error: null };
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
      "claim_room_pin_sheet_full_resync",
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
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
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
  it("validates malformed service-account configuration on an empty claim without network access", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let fetches = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
        if (name === "claim_room_pin_sheet_sync") {
          return {
            data: { status: "claimed", items: [], blocked: 0, leaseFence: 4 },
            error: null,
          };
        }
        if (name === "renew_room_pin_sheet_sync_run") {
          return { data: { status: "leased", leaseFence: 4 }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      },
    };
    const provider = new GoogleSheetsPinProvider(
      LOCAL_ROOM_PIN_SHEET_TARGET,
      { email: "malformed", privateKeyPem: "malformed" },
      async () => {
        fetches++;
        return Response.json({});
      },
    );
    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).resolves.toMatchObject({ claimed: 0, blocked: 0, projected: 0 });
    expect(fetches).toBe(0);
    expect(calls.map((call) => call.name)).toEqual([
      "claim_room_pin_sheet_full_resync",
      "claim_room_pin_sheet_sync",
      "renew_room_pin_sheet_sync_run",
      "record_room_pin_sheet_sync_heartbeat",
    ]);
    expect(calls.at(-1)?.args).toMatchObject({
      p_status: "degraded",
      p_claimed: 0,
      p_error_code: "PROVIDER_CONFIGURATION_ERROR",
    });
  });
  it("validates malformed PKCS8 on an empty claim without a Google token request", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let fetches = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
        if (name === "claim_room_pin_sheet_sync") {
          return {
            data: { status: "claimed", items: [], blocked: 0, leaseFence: 4 },
            error: null,
          };
        }
        if (name === "renew_room_pin_sheet_sync_run") {
          return { data: { status: "leased", leaseFence: 4 }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      },
    };
    const provider = new GoogleSheetsPinProvider(
      LOCAL_ROOM_PIN_SHEET_TARGET,
      {
        email: "sheet-worker@example.iam.gserviceaccount.com",
        privateKeyPem: "not-a-pkcs8-private-key",
      },
      async () => {
        fetches++;
        return Response.json({});
      },
    );
    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).resolves.toMatchObject({ claimed: 0, blocked: 0, projected: 0 });
    expect(fetches).toBe(0);
    expect(calls.at(-1)?.args).toMatchObject({
      p_status: "degraded",
      p_error_code: "PROVIDER_CONFIGURATION_ERROR",
    });
  });
  it("classifies a failed DB settle after provider success without repeating the Sheet write", async () => {
    const source = await fixture(),
      calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let writes = 0,
      settleAttempts = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
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
        if (name === "authorize_room_pin_sheet_write") {
          return { data: { status: "authorized", leaseFence: 4 }, error: null };
        }
        if (name === "settle_room_pin_sheet_sync") {
          settleAttempts++;
          return settleAttempts === 1
            ? { data: null, error: { code: "DB_UNAVAILABLE" } }
            : { data: { status: "operator_blocked" }, error: null };
        }
        return { data: { status: args.p_status }, error: null };
      },
    };
    const provider: RoomPinSheetProvider = {
      inspect: async () => ({ outcome: "write", sheetRow: 2 }),
      write: async () => {
        writes++;
      },
    };
    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).resolves.toMatchObject({ projected: 0, blocked: 1 });
    expect(writes).toBe(1);
    expect(settleAttempts).toBe(2);
    expect(
      calls.filter((call) => call.name === "settle_room_pin_sheet_sync").at(-1)
        ?.args,
    ).toMatchObject({
      p_outcome: "operator_blocked",
      p_reason_code: "DB_SETTLE_UNCERTAIN",
    });
  });
  it("leaves fenced write evidence when both post-write settle attempts fail", async () => {
    const source = await fixture();
    let writes = 0;
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        calls.push({ name, args });
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
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
        if (name === "authorize_room_pin_sheet_write") {
          return { data: { status: "authorized", leaseFence: 4 }, error: null };
        }
        return { data: null, error: { code: "DB_UNAVAILABLE" } };
      },
    };
    const provider: RoomPinSheetProvider = {
      inspect: async () => ({ outcome: "write", sheetRow: 2 }),
      write: async () => {
        writes++;
      },
    };
    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).rejects.toMatchObject({ code: "ROOM_PIN_SHEET_SYNC_FAILED" });
    expect(writes).toBe(1);
    expect(
      calls.filter((call) => call.name === "settle_room_pin_sheet_sync"),
    ).toHaveLength(2);
    expect(
      calls.filter((call) => call.name === "authorize_room_pin_sheet_write"),
    ).toHaveLength(1);
  });
  it("blocks lease-expiry reconciliation after both settles fail without a duplicate Sheet write", async () => {
    const source = await fixture();
    let leaseExpired = false,
      providerWriteStarted = false,
      writes = 0,
      inspections = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name) => {
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
        if (name === "claim_room_pin_sheet_sync") {
          if (providerWriteStarted && leaseExpired) {
            return {
              data: {
                status: "operator_blocked",
                items: [],
                blocked: 1,
                leaseFence: 0,
              },
              error: null,
            };
          }
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
        if (name === "authorize_room_pin_sheet_write") {
          providerWriteStarted = true;
          return { data: { status: "authorized", leaseFence: 4 }, error: null };
        }
        return { data: null, error: { code: "DB_UNAVAILABLE" } };
      },
    };
    const provider: RoomPinSheetProvider = {
      inspect: async () => {
        inspections++;
        return { outcome: "write", sheetRow: 2 };
      },
      write: async () => {
        writes++;
      },
    };

    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).rejects.toMatchObject({ code: "ROOM_PIN_SHEET_SYNC_FAILED" });
    expect(providerWriteStarted).toBe(true);
    expect(writes).toBe(1);
    leaseExpired = true;

    await expect(
      new RoomPinSheetSyncWorker(db, provider, config).run(),
    ).resolves.toMatchObject({ claimed: 0, blocked: 1, projected: 0 });
    expect(inspections).toBe(1);
    expect(writes).toBe(1);
  });
  it("does not begin a write without the provider reserve and finishes settle/heartbeat before 45 seconds", async () => {
    const source = await fixture(),
      times: Array<{ name: string; now: number }> = [];
    let now = 0,
      writes = 0;
    const db: RoomPinSheetRpc = {
      rpc: async (name, args) => {
        times.push({ name, now });
        if (name === "claim_room_pin_sheet_full_resync")
          return { data: { status: "empty", leaseFence: 0 }, error: null };
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
  it("writes one deterministic full-board snapshot and settles it under the singleton fence", async () => {
    const operation = await fullResyncFixture();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let writes = 0;
    const db: RoomPinSheetRpc = { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_room_pin_sheet_full_resync") {
        return { data: { status: "claimed", leaseFence: 8, operation }, error: null };
      }
      if (name === "renew_room_pin_sheet_full_resync") return { data: { status: "leased", leaseFence: 8 }, error: null };
      if (name === "authorize_room_pin_sheet_full_resync_write") return { data: { status: "authorized", leaseFence: 8 }, error: null };
      if (name === "settle_room_pin_sheet_full_resync") return { data: { status: "succeeded", roomCount: 121 }, error: null };
      return { data: { status: args.p_status }, error: null };
    } };
    const provider: RoomPinSheetProvider = {
      inspect: async () => { throw new Error("full resync must not read Sheet values"); },
      write: async () => { throw new Error("full resync must not use incremental writes"); },
      validateConfiguration: async () => undefined,
      writeFullBoard: async (rows) => {
        writes++;
        expect(rows).toHaveLength(121);
        expect(rows[0]).toMatchObject({ roomNumber: "101", sheetRow: 2, canonicalPin: "101-1234" });
        expect(rows[120]).toMatchObject({ roomNumber: "1121", sheetRow: 122, canonicalPin: "", pinVersion: 0 });
      },
    };
    await expect(new RoomPinSheetSyncWorker(db, provider, config).run()).resolves.toMatchObject({ claimed: 1, projected: 1 });
    expect(writes).toBe(1);
    expect(calls.map(call => call.name)).toEqual([
      "claim_room_pin_sheet_full_resync",
      "renew_room_pin_sheet_full_resync",
      "authorize_room_pin_sheet_full_resync_write",
      "settle_room_pin_sheet_full_resync",
      "record_room_pin_sheet_sync_heartbeat",
    ]);
  });
  it("keeps a recovery lineage operator-blocked when authorization finds a stale snapshot", async () => {
    const operation = await fullResyncFixture();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let writes = 0;
    const db: RoomPinSheetRpc = { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_room_pin_sheet_full_resync") {
        return { data: { status: "claimed", leaseFence: 8, operation }, error: null };
      }
      if (name === "renew_room_pin_sheet_full_resync") {
        return { data: { status: "leased", leaseFence: 8 }, error: null };
      }
      if (name === "authorize_room_pin_sheet_full_resync_write") {
        return { data: { status: "operator_blocked", leaseFence: 8 }, error: null };
      }
      return { data: { status: args.p_status }, error: null };
    } };
    const provider: RoomPinSheetProvider = {
      inspect: async () => { throw new Error("no Sheet read"); },
      write: async () => { throw new Error("no incremental write"); },
      validateConfiguration: async () => undefined,
      writeFullBoard: async () => { writes++; },
    };
    await expect(new RoomPinSheetSyncWorker(db, provider, config).run()).resolves.toMatchObject({
      claimed: 1,
      blocked: 1,
      projected: 0,
    });
    expect(writes).toBe(0);
    expect(calls.map(call => call.name)).not.toContain("settle_room_pin_sheet_full_resync");
    expect(calls.find(call => call.name === "record_room_pin_sheet_sync_heartbeat")?.args).toMatchObject({
      p_status: "operator_blocked",
      p_blocked: 1,
      p_error_code: "SNAPSHOT_STALE",
    });
  });
  it("does not report success when bounded lineage cleanup requires another recovery", async () => {
    const operation = await fullResyncFixture();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let writes = 0;
    const db: RoomPinSheetRpc = { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_room_pin_sheet_full_resync") {
        return { data: { status: "claimed", leaseFence: 8, operation }, error: null };
      }
      if (name === "renew_room_pin_sheet_full_resync") {
        return { data: { status: "leased", leaseFence: 8 }, error: null };
      }
      if (name === "authorize_room_pin_sheet_full_resync_write") {
        return { data: { status: "authorized", leaseFence: 8 }, error: null };
      }
      if (name === "settle_room_pin_sheet_full_resync") {
        return { data: { status: "operator_blocked", roomCount: 121 }, error: null };
      }
      return { data: { status: args.p_status }, error: null };
    } };
    const provider: RoomPinSheetProvider = {
      inspect: async () => { throw new Error("no Sheet read"); },
      write: async () => { throw new Error("no incremental write"); },
      validateConfiguration: async () => undefined,
      writeFullBoard: async () => { writes++; },
    };
    await expect(new RoomPinSheetSyncWorker(db, provider, config).run()).resolves.toMatchObject({
      claimed: 1,
      blocked: 1,
      projected: 0,
    });
    expect(writes).toBe(1);
    expect(calls.map(call => call.name)).not.toContain("block_room_pin_sheet_full_resync_after_settle_failure");
    expect(calls.find(call => call.name === "record_room_pin_sheet_sync_heartbeat")?.args).toMatchObject({
      p_status: "operator_blocked",
      p_blocked: 1,
      p_error_code: "DB_SETTLE_UNCERTAIN",
    });
  });
  it("does not authorize a full-board write when snapshot preparation exhausts the provider reserve", async () => {
    const operation = await fullResyncFixture();
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    let now = 0;
    let writes = 0;
    const db: RoomPinSheetRpc = { rpc: async (name, args) => {
      calls.push({ name, args });
      if (name === "claim_room_pin_sheet_full_resync") {
        return { data: { status: "claimed", leaseFence: 8, operation }, error: null };
      }
      if (name === "renew_room_pin_sheet_full_resync") {
        now = 32500;
        return { data: { status: "leased", leaseFence: 8 }, error: null };
      }
      if (name === "authorize_room_pin_sheet_full_resync_write") {
        throw new Error("provider permit must not be created without reserve");
      }
      if (name === "settle_room_pin_sheet_full_resync") {
        return { data: { status: "failed", roomCount: 121 }, error: null };
      }
      return { data: { status: args.p_status }, error: null };
    } };
    const provider: RoomPinSheetProvider = {
      inspect: async () => { throw new Error("no Sheet read"); },
      write: async () => { throw new Error("no incremental write"); },
      validateConfiguration: async () => undefined,
      writeFullBoard: async () => { writes++; },
    };
    const result = await new RoomPinSheetSyncWorker(db, provider, config, () => now).run();
    expect(result).toMatchObject({ claimed: 1, projected: 0, retrying: 1, blocked: 0 });
    expect(writes).toBe(0);
    expect(calls.map(call => call.name)).not.toContain("authorize_room_pin_sheet_full_resync_write");
    expect(calls.find(call => call.name === "settle_room_pin_sheet_full_resync")?.args).toMatchObject({
      p_outcome: "retryable",
      p_reason_code: "PROVIDER_UNAVAILABLE",
    });
    expect(calls.find(call => call.name === "record_room_pin_sheet_sync_heartbeat")?.args).toMatchObject({
      p_status: "degraded",
      p_retrying: 1,
      p_error_code: "PROVIDER_UNAVAILABLE",
    });
  });
  it("never repeats a full-board write after provider success and both settle paths fail", async () => {
    const operation = await fullResyncFixture();
    let leaseExpired = false, writes = 0, marker = false;
    const db: RoomPinSheetRpc = { rpc: async (name) => {
      if (name === "claim_room_pin_sheet_full_resync") {
        if (leaseExpired && marker) return { data: { status: "operator_blocked", leaseFence: 8 }, error: null };
        return { data: { status: "claimed", leaseFence: 8, operation }, error: null };
      }
      if (name === "renew_room_pin_sheet_full_resync") return { data: { status: "leased", leaseFence: 8 }, error: null };
      if (name === "authorize_room_pin_sheet_full_resync_write") {
        marker = true;
        return { data: { status: "authorized", leaseFence: 8 }, error: null };
      }
      return { data: null, error: { code: "DB_UNAVAILABLE" } };
    } };
    const provider: RoomPinSheetProvider = {
      inspect: async () => { throw new Error("no Sheet read"); },
      write: async () => { throw new Error("no incremental write"); },
      validateConfiguration: async () => undefined,
      writeFullBoard: async () => { writes++; },
    };
    await expect(new RoomPinSheetSyncWorker(db, provider, config).run()).rejects.toMatchObject({ code: "ROOM_PIN_SHEET_SYNC_FAILED" });
    expect(marker).toBe(true);
    expect(writes).toBe(1);
    leaseExpired = true;
    await expect(new RoomPinSheetSyncWorker(db, provider, config).run()).resolves.toMatchObject({ blocked: 1, projected: 0 });
    expect(writes).toBe(1);
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
