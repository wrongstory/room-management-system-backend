import { idempotencyKey, readJsonBody } from "./account-api.ts";
import { config } from "./room-pin-api.ts";
import { RoomPinTransfer } from "./room-pin-transfer.ts";
import { GoogleRoomPinImportSource } from "./google-sheets-pin-import.ts";
import {
  roomPinTransferDatabaseError,
  roomPinTransferFailure,
} from "./room-pin-transfer-http.ts";
import {
  type EdgeActor,
  type EdgeClients,
  EdgeError,
  requirePasswordChanged,
  verifiedRequestSessionId,
} from "./runtime.ts";

export async function roomPinTransferResponse(
  request: Request,
  clients: EdgeClients,
  actor: EdgeActor,
  cors: Record<string, string>,
): Promise<Response> {
  requirePasswordChanged(actor);
  if (actor.role !== "admin") {
    throw new EdgeError(403, "ADMIN_REQUIRED", "관리자 권한이 필요합니다.");
  }
  if ([...new URL(request.url).searchParams.keys()].length) {
    throw new EdgeError(
      400,
      "VALIDATION_ERROR",
      "query 항목은 허용되지 않습니다.",
    );
  }
  const identity = {
    profileId: actor.profileId,
    sessionId: verifiedRequestSessionId(request),
  };
  const path = new URL(request.url).pathname;
  let token = "", key = "";
  if (request.method === "POST") {
    const body = await readJsonBody(request);
    if (path.endsWith("/preview")) {
      if (Object.keys(body).length) {
        throw new EdgeError(400, "VALIDATION_ERROR", "빈 객체가 필요합니다.");
      }
    } else {
      if (
        Object.keys(body).join(",") !== "previewToken" ||
        typeof body.previewToken !== "string" || body.previewToken.length > 160
      ) {
        throw new EdgeError(
          400,
          "VALIDATION_ERROR",
          "previewToken을 확인해 주세요.",
        );
      }
      token = body.previewToken;
      key = idempotencyKey(request);
    }
  }
  try {
    const service = new RoomPinTransfer(
      async (name, args) => {
        const { data, error } = await clients.admin.rpc(name, args);
        if (error) throw roomPinTransferDatabaseError(error.message);
        return data;
      },
      config(),
      new GoogleRoomPinImportSource(
        Deno.env.get("ROOM_PIN_IMPORT_SPREADSHEET_ID") ?? "",
        Deno.env.get("ROOM_PIN_IMPORT_SHEET_ID")
          ? Number(Deno.env.get("ROOM_PIN_IMPORT_SHEET_ID"))
          : -1,
        {
          email: Deno.env.get("GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL") ?? "",
          privateKeyPem:
            Deno.env.get("GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY") ?? "",
        },
        Deno.env.get("GOOGLE_SHEETS_SPREADSHEET_ID"),
      ),
      Deno.env.get("ROOM_PIN_TRANSFER_HMAC_SECRET"),
    );
    const headers = { ...cors, "Cache-Control": "no-store" };
    if (request.method === "GET") {
      return new Response(await service.export(identity), {
        headers: {
          ...headers,
          "Content-Type":
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          "Content-Disposition": 'attachment; filename="room-pins.xlsx"',
        },
      });
    }
    const body = path.endsWith("/preview")
      ? { preview: await service.preview(identity) }
      : { imported: await service.apply(identity, token, key) };
    return new Response(JSON.stringify(body), {
      headers: { ...headers, "Content-Type": "application/json" },
    });
  } catch (error) {
    const failure = roomPinTransferFailure(error);
    throw new EdgeError(failure.status, failure.code, failure.message);
  }
}
