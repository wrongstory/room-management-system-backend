// Generated from src/modules/rooms/google-sheets-pin.ts. DO NOT EDIT.
/** Google Sheets is a one-way projection. Database PIN revisions remain authoritative. */
export const ROOM_PIN_SHEET_TAB = "객실_PIN_현황";
export const ROOM_PIN_SHEET_HEADERS = [
  "room_number",
  "current_pin",
  "pin_version",
  "sync_status",
  "effective_at",
  "last_synced_at",
  "reason_code",
  "environment",
] as const;
export const LOCAL_ROOM_PIN_SHEET_TARGET = Object.freeze({
  environment: "local",
  projectRef: "local",
  spreadsheetId: "test-room-pin-sheet-projection-00001",
  tab: ROOM_PIN_SHEET_TAB,
});

export interface RoomPinSheetTarget {
  environment: string;
  projectRef: string;
  spreadsheetId: string;
  tab: string;
}
export interface GoogleSheetsServiceAccount {
  email: string;
  privateKeyPem: string;
}
export interface RoomPinSheetRow {
  sheetRow: number;
  roomNumber: string;
  canonicalPin: string;
  pinVersion: number;
  effectiveAt: string;
  syncStatus: string;
  reasonCode: string;
  environment: string;
}
export interface SheetInspection {
  outcome: "current" | "write";
  sheetRow: number;
}
export class RoomPinSheetProviderError extends Error {
  constructor(
    readonly reason:
      | "AUTHENTICATION_FAILED"
      | "AUTHORIZATION_FAILED"
      | "PROVIDER_CONFIGURATION_ERROR"
      | "PROVIDER_RESPONSE_INVALID"
      | "WRITE_OUTCOME_UNCERTAIN"
      | "RATE_LIMITED"
      | "PROVIDER_UNAVAILABLE",
  ) {
    super("ROOM_PIN_SHEET_PROVIDER_FAILED");
    this.name = "RoomPinSheetProviderError";
  }
}
const fail = (reason: RoomPinSheetProviderError["reason"]): never => {
  throw new RoomPinSheetProviderError(reason);
};
class FetchTransportError extends Error {}
const bytes = (value: Uint8Array): ArrayBuffer => Uint8Array.from(value).buffer;
const b64url = (value: Uint8Array): string => {
  let raw = "";
  for (const part of value) raw += String.fromCharCode(part);
  return btoa(raw).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};
const utf8 = (value: string) => new TextEncoder().encode(value);
const safeTimestamp = (value: string): string => {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) return fail("PROVIDER_RESPONSE_INVALID");
  return value;
};

/** Hosted targets are intentionally absent until #137/release approval adds an exact mapping. */
export function assertApprovedRoomPinSheetTarget(
  target: RoomPinSheetTarget,
): void {
  const approved =
    target.environment === LOCAL_ROOM_PIN_SHEET_TARGET.environment &&
    target.projectRef === LOCAL_ROOM_PIN_SHEET_TARGET.projectRef &&
    target.spreadsheetId === LOCAL_ROOM_PIN_SHEET_TARGET.spreadsheetId &&
    target.tab === LOCAL_ROOM_PIN_SHEET_TARGET.tab;
  if (!approved) fail("PROVIDER_CONFIGURATION_ERROR");
}

function pemBytes(value: string): Uint8Array {
  const normalized = value.includes("\\n") && !value.includes("\n")
    ? value.replaceAll("\\n", "\n")
    : value;
  const header = ["-----BEGIN", "PRIVATE KEY-----"].join(" ");
  const footer = ["-----END", "PRIVATE KEY-----"].join(" ");
  const footerOffset = normalized.indexOf(`\n${footer}`);
  const trailing = footerOffset < 0
    ? ""
    : normalized.slice(footerOffset + footer.length + 1);
  if (
    !normalized.startsWith(`${header}\n`) || footerOffset < 0 ||
    (trailing !== "" && trailing !== "\n") ||
    utf8(normalized).length > 8192
  ) {
    return fail("PROVIDER_CONFIGURATION_ERROR");
  }
  try {
    const encodedBlock = normalized.slice(header.length + 1, footerOffset);
    if (!encodedBlock) return fail("PROVIDER_CONFIGURATION_ERROR");
    const encoded = encodedBlock.replace(/[\r\n]/g, "");
    const raw = atob(encoded);
    const decoded = Uint8Array.from(
      raw,
      (character) => character.charCodeAt(0),
    );
    if (
      decoded.length < 256 || btoa(String.fromCharCode(...decoded)) !== encoded
    ) return fail("PROVIDER_CONFIGURATION_ERROR");
    return decoded;
  } catch {
    return fail("PROVIDER_CONFIGURATION_ERROR");
  }
}

async function boundedFetch(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  deadlineAt: number,
  clock: () => number,
): Promise<Response> {
  const remaining = Math.floor(deadlineAt - clock());
  if (remaining <= 0) throw new FetchTransportError();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), remaining);
  try {
    return await fetcher(url, {
      ...init,
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    throw new FetchTransportError();
  } finally {
    clearTimeout(timer);
  }
}
async function boundedJson(
  response: Response,
  deadlineAt: number,
  clock: () => number,
  limit = 65536,
): Promise<Record<string, unknown>> {
  if (!response.body) return fail("PROVIDER_RESPONSE_INVALID");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const remaining = Math.floor(deadlineAt - clock());
      if (remaining <= 0) throw new FetchTransportError();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const part = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new FetchTransportError()),
            remaining,
          );
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) {
        void reader.cancel();
        return fail("PROVIDER_RESPONSE_INVALID");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch { /* preserve the stable classified error */ }
    throw error;
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(joined);
  } catch {
    return fail("PROVIDER_RESPONSE_INVALID");
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return fail("PROVIDER_RESPONSE_INVALID");
    }
    return value as Record<string, unknown>;
  } catch {
    return fail("PROVIDER_RESPONSE_INVALID");
  }
}

export class GoogleSheetsPinProvider {
  #token: { value: string; expiresAt: number } | undefined;
  readonly #target: RoomPinSheetTarget;
  readonly #serviceAccount: GoogleSheetsServiceAccount;
  readonly #fetcher: typeof fetch;
  readonly #clock: () => number;
  constructor(
    target: RoomPinSheetTarget,
    serviceAccount: GoogleSheetsServiceAccount,
    fetcher: typeof fetch = fetch,
    clock: () => number = Date.now,
  ) {
    assertApprovedRoomPinSheetTarget(target);
    this.#target = { ...target };
    this.#serviceAccount = { ...serviceAccount };
    this.#fetcher = fetcher;
    this.#clock = clock;
  }
  async #accessToken(deadlineAt: number): Promise<string> {
    // Target approval remains constructor-time, but credential validation must
    // happen after the worker owns a claim so invalid hosted configuration is
    // durably settled as operator-blocked instead of returning false-green.
    if (
      !/^[A-Za-z0-9._%+-]{1,128}@[A-Za-z0-9.-]+\.iam\.gserviceaccount\.com$/
        .test(this.#serviceAccount.email)
    ) fail("PROVIDER_CONFIGURATION_ERROR");
    if (this.#token && this.#token.expiresAt - this.#clock() > 60000) {
      return this.#token.value;
    }
    const issued = Math.floor(this.#clock() / 1000),
      header = b64url(utf8(JSON.stringify({ alg: "RS256", typ: "JWT" })));
    const claim = b64url(
      utf8(
        JSON.stringify({
          iss: this.#serviceAccount.email,
          scope: "https://www.googleapis.com/auth/spreadsheets",
          aud: "https://oauth2.googleapis.com/token",
          iat: issued,
          exp: issued + 3600,
        }),
      ),
    );
    const input = `${header}.${claim}`;
    let key: CryptoKey;
    try {
      key = await crypto.subtle.importKey(
        "pkcs8",
        bytes(pemBytes(this.#serviceAccount.privateKeyPem)),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
      );
    } catch {
      return fail("PROVIDER_CONFIGURATION_ERROR");
    }
    const signature = new Uint8Array(
      await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes(utf8(input))),
    );
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${input}.${b64url(signature)}`,
    });
    let response: Response;
    try {
      response = await boundedFetch(
        this.#fetcher,
        "https://oauth2.googleapis.com/token",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        },
        deadlineAt,
        this.#clock,
      );
    } catch {
      return fail("PROVIDER_UNAVAILABLE");
    }
    if (response.status === 401) return fail("AUTHENTICATION_FAILED");
    if (response.status === 403) return fail("AUTHORIZATION_FAILED");
    if (response.status === 429 || response.status >= 500) {
      return fail(
        response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
      );
    }
    if (!response.ok) return fail("PROVIDER_CONFIGURATION_ERROR");
    let value: Record<string, unknown>;
    try {
      value = await boundedJson(response, deadlineAt, this.#clock);
    } catch (error) {
      if (error instanceof RoomPinSheetProviderError) throw error;
      return fail("PROVIDER_UNAVAILABLE");
    }
    if (
      typeof value.access_token !== "string" ||
      value.access_token.length < 20 || value.access_token.length > 4096 ||
      value.token_type !== "Bearer" || typeof value.expires_in !== "number" ||
      value.expires_in < 60 || value.expires_in > 3600
    ) return fail("PROVIDER_RESPONSE_INVALID");
    this.#token = {
      value: value.access_token,
      expiresAt: this.#clock() + value.expires_in * 1000,
    };
    return value.access_token;
  }
  #range(row: number): string {
    return `'${this.#target.tab.replaceAll("'", "''")}'!A${row}:H${row}`;
  }
  async #sheets(
    path: string,
    init: RequestInit,
    deadlineAt: number,
    writeStarted = false,
  ): Promise<Response> {
    const token = await this.#accessToken(deadlineAt);
    try {
      const response = await boundedFetch(
        this.#fetcher,
        `https://sheets.googleapis.com/v4/spreadsheets/${
          encodeURIComponent(this.#target.spreadsheetId)
        }/${path}`,
        {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${token}` },
        },
        deadlineAt,
        this.#clock,
      );
      if (response.status === 401) return fail("AUTHENTICATION_FAILED");
      if (response.status === 403) return fail("AUTHORIZATION_FAILED");
      if (response.status === 429 || response.status >= 500) {
        return fail(
          response.status === 429 ? "RATE_LIMITED" : "PROVIDER_UNAVAILABLE",
        );
      }
      if (!response.ok) return fail("PROVIDER_CONFIGURATION_ERROR");
      return response;
    } catch (error) {
      if (error instanceof RoomPinSheetProviderError) throw error;
      return fail(
        writeStarted ? "WRITE_OUTCOME_UNCERTAIN" : "PROVIDER_UNAVAILABLE",
      );
    }
  }
  async inspect(
    row: RoomPinSheetRow,
    deadlineAt: number,
  ): Promise<SheetInspection> {
    const ranges = [
      `'${this.#target.tab}'!A1:H1`,
      `'${this.#target.tab}'!A2:H122`,
    ];
    const query = new URLSearchParams();
    for (const range of ranges) query.append("ranges", range);
    query.set("majorDimension", "ROWS");
    const response = await this.#sheets(`values:batchGet?${query}`, {
      method: "GET",
    }, deadlineAt);
    let body: Record<string, unknown>;
    try {
      body = await boundedJson(response, deadlineAt, this.#clock);
    } catch (error) {
      if (error instanceof RoomPinSheetProviderError) throw error;
      return fail("PROVIDER_UNAVAILABLE");
    }
    const groups = body.valueRanges;
    if (!Array.isArray(groups) || groups.length !== 2) {
      return fail("PROVIDER_RESPONSE_INVALID");
    }
    const rows = groups.map((value) =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>).values
        : null
    );
    const header = Array.isArray(rows[0]) && Array.isArray(rows[0][0])
      ? rows[0][0] as unknown[]
      : [];
    if (
      header.length > 0 &&
      (header.length !== ROOM_PIN_SHEET_HEADERS.length ||
        header.some((v, i) => v !== ROOM_PIN_SHEET_HEADERS[i]))
    ) return fail("PROVIDER_CONFIGURATION_ERROR");
    const board = Array.isArray(rows[1]) ? rows[1] as unknown[] : [];
    if (board.length > 121 || board.some((value) => !Array.isArray(value))) {
      return fail("PROVIDER_RESPONSE_INVALID");
    }
    const matches = board.map((value, index) => ({
      cells: value as unknown[],
      sheetRow: index + 2,
    })).filter((value) => value.cells[0] === row.roomNumber);
    if (matches.length > 1) return fail("PROVIDER_CONFIGURATION_ERROR");
    if (matches.length === 0) {
      const deterministic = board[row.sheetRow - 2];
      if (
        Array.isArray(deterministic) &&
        deterministic.some((value) => value !== "")
      ) return fail("PROVIDER_CONFIGURATION_ERROR");
      return { outcome: "write", sheetRow: row.sheetRow };
    }
    const match = matches[0];
    if (!match) return fail("PROVIDER_RESPONSE_INVALID");
    const { cells, sheetRow } = match;
    if (cells.length > 8 || cells.some((value) => typeof value !== "string")) {
      return fail("PROVIDER_RESPONSE_INVALID");
    }
    if (cells[0] !== row.roomNumber || cells[7] !== row.environment) {
      return fail("PROVIDER_CONFIGURATION_ERROR");
    }
    if (!/^\d+$/.test(String(cells[2] ?? ""))) {
      return fail("PROVIDER_RESPONSE_INVALID");
    }
    const sheetVersion = Number(cells[2]);
    if (!Number.isSafeInteger(sheetVersion) || sheetVersion > row.pinVersion) {
      return fail(
        sheetVersion > row.pinVersion
          ? "PROVIDER_CONFIGURATION_ERROR"
          : "PROVIDER_RESPONSE_INVALID",
      );
    }
    if (sheetVersion < row.pinVersion) return { outcome: "write", sheetRow };
    const outcome =
      cells[1] === row.canonicalPin && cells[3] === row.syncStatus &&
        cells[4] === row.effectiveAt && (cells[6] ?? "") === row.reasonCode
        ? "current"
        : "write";
    return { outcome, sheetRow };
  }
  async write(row: RoomPinSheetRow, deadlineAt: number): Promise<void> {
    const values = [
      {
        range: `'${this.#target.tab}'!A1:H1`,
        majorDimension: "ROWS",
        values: [ROOM_PIN_SHEET_HEADERS],
      },
      {
        range: this.#range(row.sheetRow),
        majorDimension: "ROWS",
        values: [[
          row.roomNumber,
          row.canonicalPin,
          String(row.pinVersion),
          row.syncStatus,
          safeTimestamp(row.effectiveAt),
          new Date(this.#clock()).toISOString(),
          row.reasonCode,
          row.environment,
        ]],
      },
    ];
    const response = await this.#sheets(
      "values:batchUpdate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          valueInputOption: "RAW",
          includeValuesInResponse: false,
          data: values,
        }),
      },
      deadlineAt,
      true,
    );
    let body: Record<string, unknown>;
    try {
      body = await boundedJson(response, deadlineAt, this.#clock);
    } catch (error) {
      if (error instanceof RoomPinSheetProviderError) throw error;
      return fail("WRITE_OUTCOME_UNCERTAIN");
    }
    if (
      typeof body.totalUpdatedRows !== "number" || body.totalUpdatedRows < 1 ||
      body.totalUpdatedRows > 2
    ) return fail("WRITE_OUTCOME_UNCERTAIN");
  }
}
