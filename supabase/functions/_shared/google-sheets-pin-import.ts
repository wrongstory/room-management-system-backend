// Generated from src/modules/rooms/google-sheets-pin-import.ts. DO NOT EDIT.
import {
  type GoogleSheetsServiceAccount,
  readRoomPinImportSheet,
  RoomPinSheetProviderError,
} from "./google-sheets-pin.ts";
import type { TransferSource } from "./room-pin-transfer.ts";

export class GoogleRoomPinImportSource implements TransferSource {
  readonly identity: string;
  constructor(
    private readonly spreadsheetId: string,
    private readonly sheetId: number,
    private readonly serviceAccount: GoogleSheetsServiceAccount,
    private readonly projectionSpreadsheetId?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.identity = JSON.stringify([spreadsheetId, sheetId, "시트 1"]);
  }
  async read(): Promise<unknown[][]> {
    if (
      !/^[A-Za-z0-9_-]{20,200}$/.test(this.spreadsheetId) ||
      !Number.isSafeInteger(this.sheetId) ||
      this.sheetId < 0 || this.spreadsheetId === this.projectionSpreadsheetId
    ) {
      throw new RoomPinSheetProviderError("PROVIDER_CONFIGURATION_ERROR");
    }
    return readRoomPinImportSheet(
      this.spreadsheetId,
      this.sheetId,
      this.serviceAccount,
      this.fetcher,
    );
  }
}
