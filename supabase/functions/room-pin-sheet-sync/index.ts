import { createEdgeClients } from "../_shared/runtime.ts";
import { GoogleSheetsPinProvider } from "../_shared/google-sheets-pin.ts";
import {
  handleRoomPinSheetSync,
  loadRoomPinSheetRuntimeConfig,
  RoomPinSheetSyncWorker,
} from "../_shared/room-pin-sheet-sync.ts";

Deno.serve((request) => {
  let invokeSecret: string | undefined;
  try {
    invokeSecret = Deno.env.get("ROOM_PIN_SHEET_SYNC_INVOKE_SECRET");
  } catch { /* handler returns a stable configuration error */ }
  return handleRoomPinSheetSync(request, invokeSecret, async () => {
    const settings = loadRoomPinSheetRuntimeConfig((name) =>
      Deno.env.get(name)
    );
    const provider = new GoogleSheetsPinProvider(
      settings.target,
      settings.serviceAccount,
    );
    return await new RoomPinSheetSyncWorker(
      createEdgeClients().admin,
      provider,
      settings.crypto,
    ).run();
  });
});
