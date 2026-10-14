import { roomPinTransferResponse } from "./room-pin-transfer-api.ts";
import { RoomPinTransfer } from "./room-pin-transfer.ts";
import { GoogleRoomPinImportSource } from "./google-sheets-pin-import.ts";
import { roomPinImportCredentials } from "./google-sheets-pin.ts";
import { type EdgeActor, type EdgeClients, EdgeError } from "./runtime.ts";
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
Deno.test("PIN import reuses photo OAuth with GET-only exact tab access", async () => {
  const values: Record<string, string> = {
    GOOGLE_DRIVE_CLIENT_ID: "synthetic-client",
    GOOGLE_DRIVE_CLIENT_SECRET: "synthetic-secret",
    GOOGLE_DRIVE_REFRESH_TOKEN: "synthetic-refresh",
  };
  let calls = 0;
  const source = new GoogleRoomPinImportSource(
    "synthetic-import-spreadsheet",
    0,
    roomPinImportCredentials((name) => values[name]),
    undefined,
    async (url, init) => {
      calls++;
      assert(
        init && "redirect" in init && init.redirect === "error",
        "no credential redirects",
      );
      if (calls === 1) {
        assert(
          String(url) === "https://oauth2.googleapis.com/token",
          "fixed auth origin",
        );
        const body = init?.body as URLSearchParams;
        assert(
          body.get("grant_type") === "refresh_token",
          "photo refresh grant",
        );
        assert(
          !body.has("scope") && !body.has("assertion"),
          "no expanded grant",
        );
        return Response.json({
          access_token: "synthetic-access-token",
          token_type: "Bearer",
        });
      }
      assert(init?.method === "GET", "no sheet writes");
      return Response.json({
        sheets: [{
          properties: {
            sheetId: 0,
            title: "시트 1",
            gridProperties: { rowCount: 1000 },
          },
          data: [{
            startRow: 1,
            startColumn: 1,
            rowData: [{
              values: [
                { userEnteredValue: { stringValue: "객실" } },
                { userEnteredValue: { stringValue: "비번" } },
              ],
            }],
          }],
        }],
      });
    },
  );
  const rows = await source.read();
  assert(rows[0]?.[1] === "비번" && calls === 2, "exact sheet read");
});
Deno.test("PIN transfer rejects maid/developer before reading provider or DB", async () => {
  for (const role of ["maid", "developer"] as const) {
    const actor = { role, mustChangePassword: false } as EdgeActor;
    try {
      await roomPinTransferResponse(
        new Request("https://test/v1/rooms/pins/export"),
        {} as EdgeClients,
        actor,
        {},
      );
      throw new Error("must reject");
    } catch (error) {
      assert(
        error instanceof EdgeError && error.code === "ADMIN_REQUIRED",
        "admin only",
      );
    }
  }
});
Deno.test("Edge shared preview rejects changed source without partial writes", async () => {
  const actor = {
    profileId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
  };
  const room = {
    roomId: "33333333-3333-4333-8333-333333333333",
    roomNumber: "701",
    stateVersion: 1,
    pinVersion: 0,
    envelope: null,
  };
  let value = "701-001234", writes = 0;
  const service = new RoomPinTransfer(
    async (name, args) => {
      if (name === "get_room_pin_transfer_snapshot") {
        return args.p_expected ? { checked: true } : [room];
      }
      if (args.p_candidates === null) return null;
      writes++;
      return { updated: 1, unchanged: 0 };
    },
    {
      key: btoa(String.fromCharCode(...new Uint8Array(32).fill(3))),
      keyVersion: "v1",
      keyring: {},
      environment: "test",
      projectRef: "local",
    },
    {
      identity: "synthetic",
      read: async () => [["", "비번"], ["701(1.5)", value]],
    },
    "synthetic-secret-for-import-tests-0000",
    () => 1791800000000,
  );
  const preview = await service.preview(actor);
  assert(preview.valid && preview.previewToken, "valid preview");
  assert(!JSON.stringify(preview).includes("001234"), "no plaintext preview");
  value = "701-changed";
  try {
    await service.apply(actor, preview.previewToken, "synthetic-request-001");
    throw new Error("must reject");
  } catch (error) {
    assert(
      error instanceof Error && error.message === "ROOM_PIN_TRANSFER_STALE",
      "source CAS",
    );
  }
  assert(writes === 0, "no partial mutation");
});
