// Generated from src/modules/rooms/room-pin-transfer.ts. DO NOT EDIT.
import {
  decryptRoomPin,
  encryptRoomPin,
  isValidRoomPin,
  type RoomPinCryptoConfig,
  type RoomPinEnvelope,
} from "./room-pin-crypto.ts";
import { roomPinXlsx } from "./room-pin-xlsx.ts";

export class RoomPinTransferError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export interface TransferActor {
  profileId: string;
  sessionId: string;
}
export interface TransferSource {
  identity: string;
  read(): Promise<unknown[][]>;
}
export type TransferRpc = (
  name: string,
  args: Record<string, unknown>,
) => Promise<unknown>;
interface Room {
  roomId: string;
  roomNumber: string;
  stateVersion: number;
  pinVersion: number;
  envelope: RoomPinEnvelope | null;
}
interface Candidate {
  room: Room;
  credential: string;
}
export interface TransferIssue {
  row: number;
  code: string;
}
const fail = (code: string): never => {
  throw new RoomPinTransferError(code);
};
const utf8 = (s: string) => new TextEncoder().encode(s);
const hex = (v: ArrayBuffer) =>
  [...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, "0")).join("");
const facilities = new Set(["다이닝카페", "피트니스", "짐보관실"]);

/** Input is B2:C1001, including the header. Never return cell contents in errors. */
export function parseRoomPinRows(rows: unknown[][], rooms: Room[]) {
  const issues: TransferIssue[] = [], candidates: Candidate[] = [];
  const catalog = new Map(rooms.map((room) => [room.roomNumber, room]));
  const seen = new Set<string>();
  let ignored = 0;
  if (
    rows.length > 1000 || typeof rows[0]?.[1] !== "string" ||
    rows[0][1].trim() !== "비번"
  ) {
    return {
      issues: [{ row: 2, code: "INVALID_SHEET_HEADER" }],
      candidates,
      ignored,
    };
  }
  for (let i = 1; i < rows.length; i++) {
    const [label, value] = rows[i] ?? [], row = i + 2;
    if (
      (label === undefined || label === "") &&
      (value === undefined || value === "")
    ) continue;
    if (typeof label === "string" && facilities.has(label.replace(/\s/g, ""))) {
      ignored++;
      continue;
    }
    const number = typeof label === "string"
      ? /^([A-Za-z0-9]+)(?=$|[\s(호-])/.exec(label.trim())?.[1]
      : undefined;
    const room = number === undefined ? undefined : catalog.get(number);
    if (!room) {
      issues.push({ row, code: "UNKNOWN_ROOM" });
      continue;
    }
    if (seen.has(room.roomId)) {
      issues.push({ row, code: "DUPLICATE_ROOM" });
      continue;
    }
    seen.add(room.roomId);
    if (
      typeof value !== "string" || !value.startsWith(room.roomNumber + "-") ||
      !isValidRoomPin(value.slice(room.roomNumber.length + 1))
    ) {
      issues.push({ row, code: "INVALID_ROOM_CREDENTIAL" });
      continue;
    }
    candidates.push({ room, credential: value });
  }
  if (!candidates.length && !issues.length) {
    issues.push({ row: 0, code: "NO_ROOM_ROWS" });
  }
  candidates.sort((a, b) => a.room.roomId.localeCompare(b.room.roomId));
  return { issues, candidates, ignored };
}

export class RoomPinTransfer {
  constructor(
    private readonly rpc: TransferRpc,
    private readonly cryptoConfig: RoomPinCryptoConfig,
    private readonly source?: TransferSource,
    private readonly secret?: string,
    private readonly clock: () => number = Date.now,
  ) {}

  private args(actor: TransferActor) {
    return {
      p_actor_profile_id: actor.profileId,
      p_session_id: actor.sessionId,
    };
  }
  private async snapshot(actor: TransferActor): Promise<Room[]> {
    const data = await this.rpc(
      "get_room_pin_transfer_snapshot",
      this.args(actor),
    );
    if (!Array.isArray(data) || data.length < 1 || data.length > 300) {
      return fail("ROOM_PIN_TRANSFER_INVALID_RESPONSE");
    }
    const ids = new Set<string>(), numbers = new Set<string>();
    for (const room of data as Room[]) {
      if (
        !room || typeof room.roomId !== "string" ||
        !/^[a-f0-9-]{36}$/i.test(room.roomId) ||
        typeof room.roomNumber !== "string" ||
        !/^[A-Za-z0-9]{1,32}$/.test(room.roomNumber) ||
        !Number.isSafeInteger(room.stateVersion) || room.stateVersion < 0 ||
        !Number.isSafeInteger(room.pinVersion) || room.pinVersion < 0 ||
        (room.pinVersion === 0 ? room.envelope !== null : !room.envelope) ||
        ids.has(room.roomId) || numbers.has(room.roomNumber)
      ) return fail("ROOM_PIN_TRANSFER_INVALID_RESPONSE");
      ids.add(room.roomId);
      numbers.add(room.roomNumber);
    }
    return (data as Room[]).sort((a, b) => a.roomId.localeCompare(b.roomId));
  }
  private expected(rooms: Room[]) {
    return rooms.map(({ roomId, roomNumber, stateVersion, pinVersion }) => ({
      roomId,
      roomNumber,
      stateVersion,
      pinVersion,
    }));
  }
  private async hmac(value: string): Promise<string> {
    if (
      !this.secret || utf8(this.secret).length < 32 ||
      utf8(this.secret).length > 1024 ||
      [this.cryptoConfig.key, ...Object.values(this.cryptoConfig.keyring)]
        .includes(this.secret)
    ) {
      return fail("ROOM_PIN_TRANSFER_NOT_CONFIGURED");
    }
    const key = await crypto.subtle.importKey(
      "raw",
      utf8(this.secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(await crypto.subtle.sign("HMAC", key, utf8(value)));
  }
  private async analysis(actor: TransferActor) {
    if (!this.source) return fail("ROOM_PIN_TRANSFER_NOT_CONFIGURED");
    const rooms = await this.snapshot(actor);
    const parsed = parseRoomPinRows(await this.source.read(), rooms);
    const changed: Candidate[] = [];
    for (const candidate of parsed.candidates) {
      const { room, credential } = candidate;
      if (
        !room.envelope ||
        credential !==
          await decryptRoomPin(
            room.envelope,
            room.roomId,
            room.roomNumber,
            room.pinVersion,
            this.cryptoConfig,
          )
      ) {
        changed.push(candidate);
      }
    }
    const fingerprint = await this.hmac(JSON.stringify([
      "room-pin-import-v1",
      this.source.identity,
      this.expected(rooms),
      parsed.candidates.map((c) => [c.room.roomId, c.credential]),
    ]));
    return {
      ...parsed,
      rooms,
      changed,
      fingerprint,
      unchanged: parsed.candidates.length - changed.length,
    };
  }
  private proof(actor: TransferActor, expires: string, fingerprint: string) {
    return this.hmac(
      JSON.stringify([
        "room-pin-preview-v1",
        actor.profileId,
        actor.sessionId,
        expires,
        fingerprint,
      ]),
    );
  }
  async preview(actor: TransferActor) {
    const result = await this.analysis(actor);
    await this.rpc("get_room_pin_transfer_snapshot", {
      ...this.args(actor),
      p_expected: this.expected(result.rooms),
    });
    const expires = String(this.clock() + 5 * 60_000);
    const signature = await this.proof(actor, expires, result.fingerprint);
    return {
      valid: result.issues.length === 0,
      total: result.candidates.length,
      changed: result.changed.length,
      unchanged: result.unchanged,
      ignored: result.ignored,
      issues: result.issues,
      expiresAt: new Date(Number(expires)).toISOString(),
      previewToken: result.issues.length
        ? null
        : expires + "." + result.fingerprint + "." + signature,
    };
  }
  async apply(
    actor: TransferActor,
    previewToken: string,
    idempotencyKey: string,
  ) {
    if (
      !/^\d{13}\.[a-f0-9]{64}\.[a-f0-9]{64}$/.test(previewToken) ||
      !/^[A-Za-z0-9._:-]{8,128}$/.test(idempotencyKey)
    ) return fail("INVALID_PIN_TRANSFER_REQUEST");
    const [expires, fingerprint, signature] = previewToken.split(".") as [
      string,
      string,
      string,
    ];
    const expectedSignature = await this.proof(actor, expires, fingerprint);
    // Verify using WebCrypto rather than comparing secret-dependent signatures.
    const key = await crypto.subtle.importKey(
      "raw",
      utf8(this.secret!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const signatureBytes = Uint8Array.from(
      signature.match(/../g)!,
      (byte) => Number.parseInt(byte, 16),
    );
    if (
      !expectedSignature ||
      !await crypto.subtle.verify(
        "HMAC",
        key,
        signatureBytes,
        utf8(
          JSON.stringify([
            "room-pin-preview-v1",
            actor.profileId,
            actor.sessionId,
            expires,
            fingerprint,
          ]),
        ),
      )
    ) {
      return fail("INVALID_PIN_TRANSFER_REQUEST");
    }
    const requestHash = hex(
      await crypto.subtle.digest("SHA-256", utf8(previewToken)),
    );
    const command = {
      ...this.args(actor),
      p_idempotency_key: idempotencyKey,
      p_request_hash: requestHash,
    };
    const replay = await this.rpc("apply_room_pin_transfer", {
      ...command,
      p_candidates: null,
      p_expected: null,
    });
    if (replay !== null) return this.result(replay);
    if (this.clock() >= Number(expires)) return fail("ROOM_PIN_TRANSFER_STALE");
    const result = await this.analysis(actor);
    if (result.issues.length || result.fingerprint !== fingerprint) {
      return fail("ROOM_PIN_TRANSFER_STALE");
    }
    const candidates = [];
    for (const { room, credential } of result.changed) {
      candidates.push({
        roomId: room.roomId,
        ...await encryptRoomPin(
          credential,
          room.roomId,
          room.pinVersion + 1,
          this.cryptoConfig,
        ),
      });
    }
    return this.result(
      await this.rpc("apply_room_pin_transfer", {
        ...command,
        p_candidates: candidates,
        p_expected: this.expected(result.rooms),
        p_unchanged: result.unchanged,
        p_expires_at: new Date(Number(expires)).toISOString(),
      }),
    );
  }
  private result(value: unknown): { updated: number; unchanged: number } {
    const row = value as { updated: number; unchanged: number } | null;
    if (
      !row || Object.keys(row).sort().join(",") !== "unchanged,updated" ||
      !Number.isInteger(row.updated) ||
      !Number.isInteger(row.unchanged) || row.updated < 0 ||
      row.unchanged < 0 ||
      row.updated + row.unchanged > 300
    ) return fail("ROOM_PIN_TRANSFER_INVALID_RESPONSE");
    return row;
  }
  async export(actor: TransferActor): Promise<Uint8Array> {
    const rooms = await this.snapshot(actor), rows = [];
    for (
      const room of [...rooms].sort((a, b) =>
        a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true })
      )
    ) {
      rows.push({
        roomNumber: room.roomNumber,
        credential: room.envelope
          ? await decryptRoomPin(
            room.envelope,
            room.roomId,
            room.roomNumber,
            room.pinVersion,
            this.cryptoConfig,
          )
          : "",
      });
    }
    const file = roomPinXlsx(rows);
    await this.rpc("get_room_pin_transfer_snapshot", {
      ...this.args(actor),
      p_expected: this.expected(rooms),
      p_export: true,
    });
    return file;
  }
}
