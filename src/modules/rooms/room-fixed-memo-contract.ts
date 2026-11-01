/** #551 room guidance, independent from per-assignment instructions. */
export interface RoomFixedMemo {
  roomId: string;
  memo: string | null;
  version: number;
  updatedAt: string | null;
}
export class RoomFixedMemoError extends Error {
  constructor(readonly output = false) {
    super("ROOM_FIXED_MEMO_INVALID");
  }
}
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function fixedMemoRoomId(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value)) {
    throw new RoomFixedMemoError();
  }
  return value.toLowerCase();
}
export function normalizeRoomFixedMemo(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" || value.length > 500 || value.includes("\u0000")
  ) throw new RoomFixedMemoError();
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new RoomFixedMemoError();
    } else if (c >= 0xdc00 && c <= 0xdfff) throw new RoomFixedMemoError();
  }
  const memo = value.trim();
  if (
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(memo) ||
    /https?:\/\/|www\./i.test(memo) ||
    /(^|[^0-9])(01[016789]|\+82[ -]?1[016789])[ -]?[0-9]{3,4}[ -]?[0-9]{4}([^0-9]|$)/
      .test(memo) ||
    /(?:PIN|비밀번호|출입코드)(?:[ \t\r\n]*[:=][ \t\r\n]*|[ \t\r\n]+)[0-9]{4,}/i
      .test(memo)
  ) throw new RoomFixedMemoError();
  return memo || null;
}
export function parseRoomFixedMemoInput(
  value: unknown,
): { memo: string | null; expectedVersion: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoomFixedMemoError();
  }
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).length !== 2 || !Object.hasOwn(row, "memo") ||
    !Object.hasOwn(row, "expectedVersion") ||
    !Number.isSafeInteger(row.expectedVersion) ||
    (row.expectedVersion as number) < 0 ||
    (row.expectedVersion as number) >= Number.MAX_SAFE_INTEGER
  ) throw new RoomFixedMemoError();
  return {
    memo: normalizeRoomFixedMemo(row.memo),
    expectedVersion: row.expectedVersion as number,
  };
}
export function parseRoomFixedMemo(
  value: unknown,
  roomId: string,
): RoomFixedMemo {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error();
    }
    const r = value as Record<string, unknown>,
      memo = normalizeRoomFixedMemo(r.memo);
    if (
      r.roomId !== roomId || r.memo !== memo ||
      !Number.isSafeInteger(r.version) || (r.version as number) < 0 ||
      (r.version === 0
        ? r.updatedAt !== null || memo !== null
        : typeof r.updatedAt !== "string" ||
          !Number.isFinite(Date.parse(r.updatedAt)))
    ) throw new Error();
    return {
      roomId,
      memo,
      version: r.version as number,
      updatedAt: r.updatedAt as string | null,
    };
  } catch {
    throw new RoomFixedMemoError(true);
  }
}
export const fixedMemoErrors: ReadonlyArray<readonly [string, number, string]> =
  [
    ["PASSWORD_CHANGE_REQUIRED", 403, "비밀번호를 먼저 변경해 주세요."],
    [
      "ROOM_FIXED_MEMO_FORBIDDEN",
      403,
      "이 객실의 고정 메모에 접근할 수 없습니다.",
    ],
    [
      "ROOM_FIXED_MEMO_INVALID",
      400,
      "메모는 500자 이내이며 개인정보·PIN·링크를 포함할 수 없습니다.",
    ],
  ];
