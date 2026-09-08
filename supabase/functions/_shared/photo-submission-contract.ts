/**
 * #30 저장소/HTTP와 독립적인 사진 snapshot·완전성 보조 계약.
 * 입력은 신뢰된 서버가 읽은 projection이어야 한다. 클라이언트가 보낸 verified,
 * uploadedAt 등의 값은 실제 업로드/파일 검증 증명이 아니다. 이 함수는 사진 바이트,
 * Drive 객체, actor/capability, 제출·검수·입실 준비 권한을 검증하거나 생성하지 않는다.
 */
export class PhotoSubmissionContractError extends Error {
  readonly code = "INVALID_PHOTO_SUBMISSION_CONTRACT";
  constructor() {
    super("INVALID_PHOTO_SUBMISSION_CONTRACT");
  }
}

/** 완전성 검사 전용 projection. label/section/repeat 등 원본 slot snapshot을 대체하지 않는다. */
export interface PhotoTemplateValidationSlot {
  readonly slotKey: string;
  readonly required: boolean;
  readonly displayOrder: number;
}
export interface PhotoTemplateValidationSnapshot {
  readonly templateVersionId: string;
  readonly version: number;
  readonly roomTypeCode:
    | "standard"
    | "premium"
    | "oceanPremium"
    | "oceanFamily";
  readonly cleaningKind: "checkout" | "stayover" | "additional" | "reclean";
  readonly slots: readonly PhotoTemplateValidationSlot[];
}
export interface SubmissionPhotoReference {
  readonly targetSlotId: string;
  readonly slotKey: string;
  readonly photoId: string;
  readonly photoVersion: number;
}
export interface PhotoCompleteness {
  /** 필수 슬롯의 메타데이터 완전성일 뿐 canSubmit/ready/approval이 아니다. */
  readonly complete: boolean;
  readonly targetId: string;
  readonly attemptId: string;
  readonly templateVersionId: string;
  readonly templateVersion: number;
  readonly missingRequiredSlotKeys: readonly string[];
  /** 선택 슬롯도 사진이 current로 선택되었다면 유효해야 한다. 비어있는 선택 슬롯은 허용. */
  readonly invalidCurrentSlotKeys: readonly string[];
  /** 현재 유효 사진만 참조한다. 이후 pointer 교체로 이 값은 변경되지 않는다. */
  readonly photoReferences: readonly SubmissionPhotoReference[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CHECKOUT_COUNTS = {
  standard: 10,
  premium: 11,
  oceanPremium: 13,
  oceanFamily: 15,
} as const;
const KINDS = ["checkout", "stayover", "additional", "reclean"] as const;
function fail(): never {
  throw new PhotoSubmissionContractError();
}
function record(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail();
  }
  const row = input as Record<string, unknown>;
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key))
  ) fail();
  return row;
}
function id(value: unknown): string {
  if (typeof value !== "string" || !UUID.test(value)) fail();
  return value.toLowerCase();
}
function integer(value: unknown, minimum = 1): number {
  if (
    typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum
  ) fail();
  return value;
}
function slotKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9-]{0,79}$/.test(value)) {
    fail();
  }
  return value;
}
function timestamp(value: unknown): bigint {
  if (typeof value !== "string") fail();
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/
      .exec(value);
  if (!match || Number(match[1]) < 1) fail();
  const date = `${match[1]}-${match[2]}-${match[3]}`;
  const day = new Date(`${date}T00:00:00Z`);
  if (
    !Number.isFinite(day.getTime()) ||
    day.toISOString().slice(0, 10) !== date || Number(match[4]) > 23 ||
    Number(match[5]) > 59 || Number(match[6]) > 59
  ) fail();
  const ms = Date.parse(
    `${date}T${match[4]}:${match[5]}:${match[6]}${match[8]}`,
  );
  if (
    !Number.isFinite(ms) || ms < Date.parse("0001-01-01T00:00:00Z") ||
    ms > Date.parse("9999-12-31T23:59:59.999Z")
  ) fail();
  // PostgreSQL timestamptz의 microsecond 정밀도를 유지한다. Date의 ms 절삭으로
  // exact 7-day retention이나 만료 직전/직후를 같은 시각으로 취급하지 않는다.
  return BigInt(ms) * 1000n + BigInt((match[7] ?? "").padEnd(6, "0"));
}

/** 미설정·빈 snapshot은 거부하고 과거 version에 최신 템플릿을 보충하지 않는다. */
export function validatePhotoTemplateSnapshot(
  input: unknown,
): PhotoTemplateValidationSnapshot {
  const row = record(input, [
    "templateVersionId",
    "version",
    "roomTypeCode",
    "cleaningKind",
    "slots",
  ]);
  const templateVersionId = id(row.templateVersionId),
    version = integer(row.version);
  if (version > 2147483647) fail();
  // 100/80/99는 DB와 일치하는 구조적 자원 상한이며 필수 사진 개수 정책이 아니다.
  if (
    typeof row.roomTypeCode !== "string" ||
    !Object.hasOwn(CHECKOUT_COUNTS, row.roomTypeCode) ||
    !KINDS.includes(
      row.cleaningKind as PhotoTemplateValidationSnapshot["cleaningKind"],
    ) || !Array.isArray(row.slots) || row.slots.length === 0 ||
    row.slots.length > 100
  ) fail();
  const roomTypeCode = row
      .roomTypeCode as PhotoTemplateValidationSnapshot["roomTypeCode"],
    cleaningKind = row
      .cleaningKind as PhotoTemplateValidationSnapshot["cleaningKind"];
  const seenKeys = new Set<string>(), seenOrders = new Set<number>();
  const slots = row.slots.map((value) => {
    const slot = record(value, ["slotKey", "required", "displayOrder"]);
    const key = slotKey(slot.slotKey), order = integer(slot.displayOrder, 0);
    if (
      typeof slot.required !== "boolean" || order > 99 || seenKeys.has(key) ||
      seenOrders.has(order)
    ) fail();
    seenKeys.add(key);
    seenOrders.add(order);
    return Object.freeze({
      slotKey: key,
      required: slot.required,
      displayOrder: order,
    });
  }).sort((a, b) => a.displayOrder - b.displayOrder);
  if (!slots.some((slot) => slot.required)) fail();
  if (cleaningKind === "checkout" && version >= 7) {
    if (
      slots.length !== CHECKOUT_COUNTS[roomTypeCode] ||
      slots.filter((slot) => slot.required).length !== slots.length - 1
    ) fail();
    if (
      slots.filter((slot) => slot.slotKey === "tv-on" && slot.required)
        .length !== 1
    ) fail();
  }
  return Object.freeze({
    templateVersionId,
    version,
    roomTypeCode,
    cleaningKind,
    slots: Object.freeze(slots),
  });
}

/**
 * 신뢰된 서버의 full frozen snapshot에서 검사 전용 DTO를 만든다.
 * 원본 label/section/description/repeat instance/count는 DB의 immutable
 * frozen_snapshot/slot_snapshot이 정본이며 이 축약 결과로 덮어쓰면 안 된다.
 * 추가 metadata를 반환하지도, 그 값을 upload proof로 승격하지도 않는다.
 */
export function projectPhotoTemplateForValidation(
  input: unknown,
): PhotoTemplateValidationSnapshot {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    fail();
  }
  const row = input as Record<string, unknown>;
  if (!Array.isArray(row.slots) || row.slots.length > 100) fail();
  return validatePhotoTemplateSnapshot({
    templateVersionId: row.templateVersionId,
    version: row.version,
    roomTypeCode: row.roomTypeCode,
    cleaningKind: row.cleaningKind,
    slots: row.slots.map((inputSlot) => {
      if (
        inputSlot === null || typeof inputSlot !== "object" ||
        Array.isArray(inputSlot)
      ) fail();
      const slot = inputSlot as Record<string, unknown>;
      return {
        slotKey: slot.slotKey,
        required: slot.required,
        displayOrder: slot.displayOrder,
      };
    }),
  });
}

/**
 * 단일 target/attempt의 frozen slot과 서버 current-photo projection만 받는다.
 * currentPhotos는 이력 전체가 아니다. 슬롯당 하나, 사진 버전당 불변 binding을 검증한다.
 * pending/failed/purged/7일 만료 사진은 필수 사진을 채우지 못한다.
 */
export function assessPhotoCompleteness(input: unknown): PhotoCompleteness {
  const row = record(input, [
    "targetId",
    "attemptId",
    "snapshot",
    "slotSnapshots",
    "currentPhotos",
    "asOf",
  ]);
  const targetId = id(row.targetId),
    attemptId = id(row.attemptId),
    asOf = timestamp(row.asOf);
  const snapshot = validatePhotoTemplateSnapshot(row.snapshot);
  if (
    !Array.isArray(row.slotSnapshots) ||
    row.slotSnapshots.length !== snapshot.slots.length ||
    !Array.isArray(row.currentPhotos) ||
    row.currentPhotos.length > row.slotSnapshots.length
  ) fail();
  const slots = new Map<string, PhotoTemplateValidationSlot>();
  const seenKeys = new Set<string>();
  for (const value of row.slotSnapshots) {
    const slot = record(value, [
      "id",
      "targetId",
      "templateVersionId",
      "slotKey",
      "required",
      "displayOrder",
    ]);
    const slotId = id(slot.id), key = slotKey(slot.slotKey);
    const frozen = snapshot.slots.find((item) => item.slotKey === key);
    if (
      id(slot.targetId) !== targetId ||
      id(slot.templateVersionId) !== snapshot.templateVersionId || !frozen ||
      frozen.required !== slot.required ||
      frozen.displayOrder !== slot.displayOrder || slots.has(slotId) ||
      seenKeys.has(key)
    ) fail();
    slots.set(slotId, frozen);
    seenKeys.add(key);
  }
  const seenSlots = new Set<string>(), seenPhotos = new Set<string>();
  const references: SubmissionPhotoReference[] = [];
  const invalidCurrentSlotKeys: string[] = [];
  for (const value of row.currentPhotos) {
    const photo = record(value, [
      "id",
      "attemptId",
      "targetId",
      "targetSlotId",
      "version",
      "validationStatus",
      "uploadedAt",
      "purgeAfter",
      "purgedAt",
    ]);
    const photoId = id(photo.id),
      targetSlotId = id(photo.targetSlotId),
      photoVersion = integer(photo.version);
    const slot = slots.get(targetSlotId);
    if (
      id(photo.attemptId) !== attemptId || id(photo.targetId) !== targetId ||
      !slot || seenSlots.has(targetSlotId) || seenPhotos.has(photoId) ||
      !["verified", "pending", "failed"].includes(
        photo.validationStatus as string,
      )
    ) fail();
    seenSlots.add(targetSlotId);
    seenPhotos.add(photoId);
    const uploadedAt = photo.uploadedAt === null
      ? null
      : timestamp(photo.uploadedAt);
    const purgeAfter = photo.purgeAfter === null
      ? null
      : timestamp(photo.purgeAfter);
    const purgedAt = photo.purgedAt === null ? null : timestamp(photo.purgedAt);
    if (
      (uploadedAt === null) !== (purgeAfter === null) ||
      (uploadedAt !== null && purgeAfter !== uploadedAt + 604800000000n) ||
      (purgedAt !== null && (uploadedAt === null || purgedAt < uploadedAt))
    ) fail();
    if (photo.validationStatus === "verified" && uploadedAt === null) fail();
    if (
      photo.validationStatus === "verified" && uploadedAt !== null &&
      purgeAfter !== null && uploadedAt <= asOf && asOf < purgeAfter &&
      purgedAt === null
    ) {
      references.push(
        Object.freeze({
          targetSlotId,
          slotKey: slot.slotKey,
          photoId,
          photoVersion,
        }),
      );
    } else {
      invalidCurrentSlotKeys.push(slot.slotKey);
    }
  }
  const filled = new Set(references.map((photo) => photo.slotKey));
  const missing = snapshot.slots.filter((slot) =>
    slot.required && !filled.has(slot.slotKey)
  ).map((slot) => slot.slotKey);
  references.sort((a, b) =>
    (slots.get(a.targetSlotId)?.displayOrder ?? 0) -
    (slots.get(b.targetSlotId)?.displayOrder ?? 0)
  );
  invalidCurrentSlotKeys.sort();
  return Object.freeze({
    complete: missing.length === 0 && invalidCurrentSlotKeys.length === 0,
    targetId,
    attemptId,
    templateVersionId: snapshot.templateVersionId,
    templateVersion: snapshot.version,
    missingRequiredSlotKeys: Object.freeze(missing),
    invalidCurrentSlotKeys: Object.freeze(invalidCurrentSlotKeys),
    photoReferences: Object.freeze(references),
  });
}
