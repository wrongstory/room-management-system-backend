// Generated from src/modules/rooms/room-pin-sheet-sync.ts. DO NOT EDIT.
import {
  decryptRoomPin,
  type RoomPinCryptoConfig,
  type RoomPinEnvelope,
} from "./room-pin-crypto.ts";
import {
  assertApprovedRoomPinSheetTarget,
  type GoogleSheetsServiceAccount,
  RoomPinSheetProviderError,
  type RoomPinSheetRow,
  type RoomPinSheetTarget,
} from "./google-sheets-pin.ts";

export const ROOM_PIN_SHEET_SYNC_BATCH_LIMIT = 10;
export const ROOM_PIN_SHEET_SYNC_RUN_MS = 45_000;
export const ROOM_PIN_SHEET_SYNC_PROVIDER_MS = 33_000;
export const ROOM_PIN_SHEET_SYNC_SETTLE_MS = 39_000;
const PROVIDER_START_RESERVE_MS = 750;
interface RpcCall extends PromiseLike<{ data: unknown; error: unknown }> {
  abortSignal?(
    signal: AbortSignal,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface RoomPinSheetRpc {
  rpc(name: string, args: Record<string, unknown>): RpcCall;
}
export interface RoomPinSheetProvider {
  inspect(
    row: RoomPinSheetRow,
    deadlineAt: number,
  ): Promise<{ outcome: "current" | "write"; sheetRow: number }>;
  write(row: RoomPinSheetRow, deadlineAt: number): Promise<void>;
}
export interface RoomPinSheetSyncResult {
  claimed: number;
  projected: number;
  alreadyCurrent: number;
  superseded: number;
  retrying: number;
  blocked: number;
  busy: boolean;
}
export interface RoomPinSheetRuntimeConfig {
  target: RoomPinSheetTarget;
  serviceAccount: GoogleSheetsServiceAccount;
  crypto: RoomPinCryptoConfig;
}
interface Context {
  outboxId: string;
  roomId: string;
  roomNumber: string;
  sheetRow: number;
  pinVersion: number;
  effectiveAt: string;
  syncStatus: string;
  reasonCode: string;
  leaseFence: number;
  envelope: RoomPinEnvelope;
}
class DeadlineError extends Error {
  constructor() {
    super("ROOM_PIN_SHEET_SYNC_DEADLINE");
  }
}
export class RoomPinSheetSyncError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RoomPinSheetSyncError";
  }
}
const failed = (): never => {
  throw new RoomPinSheetSyncError("ROOM_PIN_SHEET_SYNC_FAILED");
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : failed();
const uuid = (value: unknown): string =>
  typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(
        value,
      )
    ? value.toLowerCase()
    : failed();
const integer = (
  value: unknown,
  min = 0,
  max = Number.MAX_SAFE_INTEGER,
): number =>
  typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= min &&
    value <= max
    ? value
    : failed();
const text = (value: unknown, pattern: RegExp): string =>
  typeof value === "string" && pattern.test(value) ? value : failed();
export function loadRoomPinSheetRuntimeConfig(
  read: (name: string) => string | undefined,
): RoomPinSheetRuntimeConfig {
  const required = (name: string): string => {
    const value = read(name)?.trim();
    if (!value) {
      throw new RoomPinSheetSyncError("ROOM_PIN_SHEET_SYNC_NOT_CONFIGURED");
    }
    return value;
  };
  const target = {
    environment: required("RUNTIME_ENVIRONMENT"),
    projectRef: required("SUPABASE_PROJECT_REF"),
    spreadsheetId: required("GOOGLE_SHEETS_SPREADSHEET_ID"),
    tab: required("GOOGLE_SHEETS_ROOM_PIN_TAB"),
  };
  // Hosted mappings are absent in Phase B. This check must precede PIN keys and Google credentials.
  assertApprovedRoomPinSheetTarget(target);
  let keyring: unknown;
  try {
    keyring = JSON.parse(read("ROOM_PIN_KEYRING_JSON")?.trim() || "{}");
  } catch {
    throw new RoomPinSheetSyncError("ROOM_PIN_SHEET_SYNC_NOT_CONFIGURED");
  }
  if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)) {
    throw new RoomPinSheetSyncError("ROOM_PIN_SHEET_SYNC_NOT_CONFIGURED");
  }
  return {
    target,
    serviceAccount: {
      email: required("GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL"),
      privateKeyPem: required("GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY"),
    },
    crypto: {
      key: required("ROOM_PIN_KEY_BASE64"),
      keyVersion: required("ROOM_PIN_KEY_VERSION"),
      keyring: keyring as Record<string, string>,
      environment: target.environment,
      projectRef: target.projectRef,
    },
  };
}
function context(value: unknown): Context {
  const row = object(value);
  return {
    outboxId: uuid(row.outboxId),
    roomId: uuid(row.roomId),
    roomNumber: text(row.roomNumber, /^[A-Za-z0-9]{1,32}$/),
    sheetRow: integer(row.sheetRow, 2, 122),
    pinVersion: integer(row.pinVersion, 1),
    effectiveAt: text(row.effectiveAt, /^\d{4}-\d{2}-\d{2}T/),
    syncStatus: text(row.syncStatus, /^[a-z_]{2,40}$/),
    reasonCode: text(row.reasonCode, /^[A-Z0-9_]{2,80}$/),
    leaseFence: integer(row.leaseFence, 1),
    envelope: {
      envelopeFormat: integer(row.envelopeFormat, 1, 1) as 1,
      keyVersion: text(row.keyVersion, /^[A-Za-z0-9._-]{1,32}$/),
      ciphertextBase64: text(row.ciphertextBase64, /^[A-Za-z0-9+/]+={0,2}$/),
      nonceBase64: text(row.nonceBase64, /^[A-Za-z0-9+/]+={0,2}$/),
      authTagBase64: text(row.authTagBase64, /^[A-Za-z0-9+/]+={0,2}$/),
      aadEnvironment: text(row.aadEnvironment, /^[A-Za-z0-9._:-]{1,80}$/),
      aadProjectRef: text(row.aadProjectRef, /^[A-Za-z0-9._:-]{1,80}$/),
    },
  };
}
export class RoomPinSheetSyncWorker {
  readonly #db: RoomPinSheetRpc;
  readonly #provider: RoomPinSheetProvider;
  readonly #cryptoConfig: RoomPinCryptoConfig;
  readonly #clock: () => number;

  constructor(
    db: RoomPinSheetRpc,
    provider: RoomPinSheetProvider,
    cryptoConfig: RoomPinCryptoConfig,
    clock: () => number = Date.now,
  ) {
    this.#db = db;
    this.#provider = provider;
    this.#cryptoConfig = cryptoConfig;
    this.#clock = clock;
  }
  #remaining(deadline: number): number {
    return Math.floor(deadline - this.#clock());
  }
  async #rpc(
    name: string,
    args: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown> {
    const remaining = this.#remaining(deadline);
    if (remaining <= 0) throw new DeadlineError();
    const controller = new AbortController(),
      timeout = Math.min(5000, remaining);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = this.#db.rpc(name, args),
        call = raw.abortSignal ? raw.abortSignal(controller.signal) : raw;
      const response = await Promise.race([
        Promise.resolve(call),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new DeadlineError());
          }, timeout);
        }),
      ]);
      if (response.error) return failed();
      return response.data;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async #settle(
    item: Context,
    claimId: string,
    fence: number,
    outcome: string,
    reason: string | null,
    deadline: number,
  ): Promise<string> {
    const value = object(
      await this.#rpc(
        "settle_room_pin_sheet_sync",
        {
          p_outbox_id: item.outboxId,
          p_claim_id: claimId,
          p_lease_fence: fence,
          p_expected_pin_version: item.pinVersion,
          p_outcome: outcome,
          p_reason_code: reason,
        },
        deadline,
      ),
    );
    return text(value.status, /^[a-z_]{2,40}$/);
  }
  async run(): Promise<RoomPinSheetSyncResult> {
    const started = this.#clock(),
      providerDeadline = started + ROOM_PIN_SHEET_SYNC_PROVIDER_MS;
    const settleDeadline = started + ROOM_PIN_SHEET_SYNC_SETTLE_MS,
      runDeadline = started + ROOM_PIN_SHEET_SYNC_RUN_MS;
    const claimId = crypto.randomUUID(),
      result: RoomPinSheetSyncResult = {
        claimed: 0,
        projected: 0,
        alreadyCurrent: 0,
        superseded: 0,
        retrying: 0,
        blocked: 0,
        busy: false,
      };
    let fence = 0;
    try {
      const claimed = object(
        await this.#rpc(
          "claim_room_pin_sheet_sync",
          {
            p_claim_id: claimId,
            p_limit: ROOM_PIN_SHEET_SYNC_BATCH_LIMIT,
            p_expected_environment: this.#cryptoConfig.environment,
            p_expected_project_ref: this.#cryptoConfig.projectRef,
          },
          providerDeadline,
        ),
      );
      const status = text(claimed.status, /^[a-z_]{2,40}$/);
      fence = integer(claimed.leaseFence, 0);
      if (status === "busy") {
        result.busy = true;
        return result;
      }
      if (
        !Array.isArray(claimed.items) ||
        claimed.items.length > ROOM_PIN_SHEET_SYNC_BATCH_LIMIT
      ) {
        return failed();
      }
      result.blocked = integer(claimed.blocked, 0, 10);
      if (status === "operator_blocked") return result;
      if (status !== "claimed" || fence < 1) return failed();
      const items = claimed.items.map(context);
      result.claimed = items.length;
      if (items.some((item) => item.leaseFence !== fence)) return failed();
      object(
        await this.#rpc(
          "renew_room_pin_sheet_sync_run",
          {
            p_claim_id: claimId,
            p_lease_fence: fence,
          },
          providerDeadline,
        ),
      );
      for (const item of items) {
        if (this.#remaining(providerDeadline) < PROVIDER_START_RESERVE_MS) {
          break;
        }
        let row: RoomPinSheetRow | undefined;
        try {
          const canonicalPin = await decryptRoomPin(
            item.envelope,
            item.roomId,
            item.roomNumber,
            item.pinVersion,
            this.#cryptoConfig,
          );
          row = {
            sheetRow: item.sheetRow,
            roomNumber: item.roomNumber,
            canonicalPin,
            pinVersion: item.pinVersion,
            effectiveAt: new Date(item.effectiveAt).toISOString(),
            syncStatus: item.syncStatus,
            reasonCode: item.reasonCode,
            environment: this.#cryptoConfig.environment,
          };
          const inspection = await this.#provider.inspect(
            row,
            providerDeadline,
          );
          if (
            !Number.isSafeInteger(inspection.sheetRow) ||
            inspection.sheetRow < 2 ||
            inspection.sheetRow > 122
          ) {
            return failed();
          }
          if (
            inspection.outcome !== "current" &&
            inspection.outcome !== "write"
          ) {
            return failed();
          }
          if (inspection.outcome === "current") {
            const settled = await this.#settle(
              item,
              claimId,
              fence,
              "already_current",
              null,
              settleDeadline,
            );
            if (settled === "succeeded") result.alreadyCurrent++;
            else if (settled === "superseded") result.superseded++;
            else return failed();
            continue;
          }
          row = { ...row, sheetRow: inspection.sheetRow };
          const authorization = object(
            await this.#rpc(
              "authorize_room_pin_sheet_write",
              {
                p_outbox_id: item.outboxId,
                p_claim_id: claimId,
                p_lease_fence: fence,
                p_expected_pin_version: item.pinVersion,
              },
              providerDeadline,
            ),
          );
          const authorized = text(authorization.status, /^[a-z_]{2,40}$/);
          if (authorized === "superseded") {
            result.superseded++;
            continue;
          }
          if (authorized !== "authorized") return failed();
          if (this.#remaining(providerDeadline) < PROVIDER_START_RESERVE_MS) {
            const settled = await this.#settle(
              item,
              claimId,
              fence,
              "retryable",
              "PROVIDER_UNAVAILABLE",
              settleDeadline,
            );
            if (settled === "failed") {
              result.retrying++;
              continue;
            }
            if (settled === "operator_blocked") {
              result.blocked++;
              break;
            }
            if (settled === "superseded") {
              result.superseded++;
              continue;
            }
            return failed();
          }
          await this.#provider.write(row, providerDeadline);
          const settled = await this.#settle(
            item,
            claimId,
            fence,
            "succeeded",
            null,
            settleDeadline,
          );
          if (settled === "succeeded") result.projected++;
          else if (settled === "superseded") result.superseded++;
          else return failed();
        } catch (error) {
          const reason = error instanceof RoomPinSheetProviderError
            ? error.reason
            : error instanceof DeadlineError
            ? "WRITE_OUTCOME_UNCERTAIN"
            : "PROVIDER_RESPONSE_INVALID";
          const retryable = reason === "RATE_LIMITED" ||
            reason === "PROVIDER_UNAVAILABLE";
          const settled = await this.#settle(
            item,
            claimId,
            fence,
            retryable ? "retryable" : "operator_blocked",
            reason,
            settleDeadline,
          );
          if (settled === "operator_blocked") {
            result.blocked++;
            break;
          }
          if (settled === "failed" && retryable) {
            result.retrying++;
            continue;
          }
          if (settled === "superseded") {
            result.superseded++;
            continue;
          }
          return failed();
        } finally {
          row = undefined;
        }
      }
      const heartbeatStatus = result.blocked > 0
        ? "operator_blocked"
        : result.retrying > 0 ||
            result.claimed >
              result.projected + result.alreadyCurrent + result.superseded
        ? "degraded"
        : "succeeded";
      await this.#rpc(
        "record_room_pin_sheet_sync_heartbeat",
        {
          p_claim_id: claimId,
          p_lease_fence: fence,
          p_status: heartbeatStatus,
          p_claimed: result.claimed,
          p_projected: result.projected,
          p_already_current: result.alreadyCurrent,
          p_superseded: result.superseded,
          p_retrying: result.retrying,
          p_blocked: result.blocked,
          p_error_code: null,
        },
        runDeadline,
      );
      return result;
    } catch (error) {
      if (fence > 0) {
        try {
          await this.#rpc(
            "record_room_pin_sheet_sync_heartbeat",
            {
              p_claim_id: claimId,
              p_lease_fence: fence,
              p_status: result.blocked > 0 ? "operator_blocked" : "failed",
              p_claimed: result.claimed,
              p_projected: result.projected,
              p_already_current: result.alreadyCurrent,
              p_superseded: result.superseded,
              p_retrying: result.retrying,
              p_blocked: result.blocked,
              p_error_code: "ROOM_PIN_SHEET_SYNC_FAILED",
            },
            runDeadline,
          );
        } catch {
          /* preserve original */
        }
      }
      throw error;
    }
  }
}

export async function handleRoomPinSheetSync(
  request: Request,
  secret: string | undefined,
  run: () => Promise<RoomPinSheetSyncResult>,
): Promise<Response> {
  const response = (status: number, value: unknown) =>
    Response.json(value, {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  try {
    const url = new URL(request.url);
    if (
      !["/room-pin-sheet-sync", "/functions/v1/room-pin-sheet-sync"].includes(
        url.pathname,
      ) ||
      url.search
    ) {
      return response(404, { error: { code: "ROUTE_NOT_FOUND" } });
    }
    if (request.method !== "POST") {
      return response(405, { error: { code: "METHOD_NOT_ALLOWED" } });
    }
    if (
      !secret ||
      new TextEncoder().encode(secret).length < 32 ||
      secret.length > 4096
    ) {
      return response(503, {
        error: { code: "ROOM_PIN_SHEET_SYNC_NOT_CONFIGURED" },
      });
    }
    const provided = request.headers.get("x-room-pin-sheet-sync-secret") ?? "";
    if (
      new TextEncoder().encode(provided).length < 32 ||
      provided.length > 4096
    ) {
      return response(401, {
        error: { code: "INVALID_ROOM_PIN_SHEET_SYNC_SECRET" },
      });
    }
    const algorithm = { name: "HMAC", hash: "SHA-256" },
      encoder = new TextEncoder(),
      message = encoder.encode("room-pin-sheet-sync:invoke:v1");
    const expected = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      algorithm,
      false,
      ["sign"],
    );
    const candidate = await crypto.subtle.importKey(
      "raw",
      encoder.encode(provided),
      algorithm,
      false,
      ["sign"],
    );
    const [left, right] = await Promise.all([
      crypto.subtle.sign("HMAC", expected, message),
      crypto.subtle.sign("HMAC", candidate, message),
    ]);
    const a = new Uint8Array(left),
      b = new Uint8Array(right);
    let mismatch = a.length ^ b.length;
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
      mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
    }
    if (mismatch !== 0) {
      return response(401, {
        error: { code: "INVALID_ROOM_PIN_SHEET_SYNC_SECRET" },
      });
    }
    if ((request.headers.get("content-length") ?? "0") !== "0") {
      return response(400, {
        error: { code: "INVALID_ROOM_PIN_SHEET_SYNC_REQUEST" },
      });
    }
    if (request.body) {
      const reader = request.body.getReader();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (let zeroChunks = 0; zeroChunks < 8; zeroChunks++) {
          const part = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("body timeout")), 1000);
            }),
          ]);
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          if (part.done) break;
          if ((part.value?.byteLength ?? 0) > 0) {
            void reader.cancel().catch(() => {});
            return response(400, {
              error: { code: "INVALID_ROOM_PIN_SHEET_SYNC_REQUEST" },
            });
          }
          if (zeroChunks === 7) throw new Error("body did not terminate");
        }
      } finally {
        if (timer) clearTimeout(timer);
        reader.releaseLock();
      }
    }
    const result = await run();
    return response(200, { result });
  } catch {
    return response(503, { error: { code: "ROOM_PIN_SHEET_SYNC_FAILED" } });
  }
}
