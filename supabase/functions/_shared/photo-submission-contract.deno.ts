import {
  assessPhotoCompleteness,
  PhotoSubmissionContractError,
  projectPhotoTemplateForValidation,
  validatePhotoTemplateSnapshot,
} from "./photo-submission-contract.ts";

function assert(value: unknown): asserts value {
  if (!value) throw new Error("Photo contract regression");
}
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture");
  return value;
}
function rejects(run: () => unknown) {
  try {
    run();
  } catch (error) {
    assert(error instanceof PhotoSubmissionContractError);
    assert(error.message === "INVALID_PHOTO_SUBMISSION_CONTRACT");
    return;
  }
  throw new Error("Expected fail-closed");
}
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function template(roomTypeCode = "standard", count = 10, version = 7) {
  return {
    templateVersionId: id(1),
    version,
    roomTypeCode,
    cleaningKind: "checkout",
    slots: Array.from({ length: count }, (_, index) => ({
      slotKey: index === 0 && version >= 7 ? "tv-on" : `fixture-${index}`,
      required: index < count - 1,
      displayOrder: index,
    })),
  };
}
function fixture() {
  const snapshot = template();
  return {
    targetId: id(2),
    attemptId: id(3),
    snapshot,
    slotSnapshots: snapshot.slots.map((slot, index) => ({
      id: id(10 + index),
      targetId: id(2),
      templateVersionId: id(1),
      ...slot,
    })),
    currentPhotos: snapshot.slots.filter((slot) => slot.required).map((
      _,
      index,
    ) => ({
      id: id(100 + index),
      attemptId: id(3),
      targetId: id(2),
      targetSlotId: id(10 + index),
      version: 1,
      validationStatus: "verified",
      uploadedAt: "2037-01-05T12:00:00Z" as string | null,
      purgeAfter: "2037-01-12T12:00:00Z" as string | null,
      purgedAt: null as string | null,
    })),
    asOf: "2037-01-06T00:00:00Z",
  };
}

/** 동일한 합성 회귀를 Node/Vitest와 Deno에서 실행한다. */
export function registerPhotoContractTests(
  register: (name: string, run: () => void) => void,
) {
  register(
    "full slot metadata is preserved separately from validation-only projection",
    () => {
      const source = template();
      const full = {
        ...source,
        slots: source.slots.map((slot) => ({
          ...slot,
          label: "합성 표시명",
          section: "fixture",
          description: "합성 설명",
          repeat: { instance: 1, count: 2 },
          uploaded: true,
        })),
      };
      const before = JSON.stringify(full);
      const projected = projectPhotoTemplateForValidation(full);
      assert(
        JSON.stringify(full) === before &&
          !Object.hasOwn(required(projected.slots[0]), "uploaded"),
      );
      const input = fixture();
      assert(
        !assessPhotoCompleteness({
          ...input,
          snapshot: projected,
          currentPhotos: [],
        }).complete,
      );
      rejects(() => validatePhotoTemplateSnapshot(full));
    },
  );
  register(
    "photo template v7 checkout requires exact type counts and one required tv-on",
    () => {
      for (
        const [type, count] of [["standard", 10], ["premium", 11], [
          "oceanPremium",
          13,
        ], ["oceanFamily", 15]] as const
      ) {
        assert(
          validatePhotoTemplateSnapshot(template(type, count)).slots.length ===
            count,
        );
        rejects(() => validatePhotoTemplateSnapshot(template(type, count - 1)));
        const noTv = template(type, count);
        required(noTv.slots[0]).slotKey = "fixture-no-tv";
        rejects(() => validatePhotoTemplateSnapshot(noTv));
        const optionalTv = template(type, count);
        required(optionalTv.slots[0]).required = false;
        required(optionalTv.slots[count - 1]).required = true;
        rejects(() => validatePhotoTemplateSnapshot(optionalTv));
      }
    },
  );
  register(
    "legacy v6 snapshot keeps its original count without inserting tv-on",
    () => {
      for (
        const [type, count] of [["standard", 9], ["premium", 10], [
          "oceanPremium",
          12,
        ], ["oceanFamily", 14]] as const
      ) {
        const input = template(type, count, 6),
          original = JSON.stringify(input);
        const result = validatePhotoTemplateSnapshot(input);
        assert(result.version === 6 && result.slots.length === count);
        assert(!result.slots.some((slot) => slot.slotKey === "tv-on"));
        assert(JSON.stringify(input) === original);
      }
    },
  );
  register(
    "templates reject absent empty malformed duplicate and unconfirmed inputs",
    () => {
      for (
        const input of [
          null,
          {},
          { ...template(), slots: [] },
          { ...template(), version: 0 },
          { ...template(), roomTypeCode: "unknown" },
          { ...template(), cleaningKind: "guess" },
          { ...template(), published: true },
        ]
      ) rejects(() => validatePhotoTemplateSnapshot(input));
      for (const field of ["slotKey", "displayOrder"] as const) {
        const input = template();
        Object.assign(required(input.slots[1]), {
          [field]: required(input.slots[0])[field],
        });
        rejects(() => validatePhotoTemplateSnapshot(input));
      }
      const invalid = template();
      required(invalid.slots[0]).slotKey = "TV On";
      rejects(() => validatePhotoTemplateSnapshot(invalid));
      for (const cleaningKind of ["checkout", "additional"]) {
        const allOptional = template("standard", 9, 6);
        allOptional.cleaningKind = cleaningKind;
        allOptional.slots.forEach((slot) => {
          slot.required = false;
        });
        rejects(() => validatePhotoTemplateSnapshot(allOptional));
      }
    },
  );
  register(
    "required verified photos are complete without requiring optional photos",
    () => {
      const input = fixture(), original = JSON.stringify(input);
      const result = assessPhotoCompleteness(input);
      assert(
        result.complete && result.missingRequiredSlotKeys.length === 0 &&
          result.photoReferences.length === 9,
      );
      assert(JSON.stringify(input) === original);
      assert(!("canSubmit" in result) && !("ready" in result));
      assert(
        Object.isFrozen(result) && Object.isFrozen(result.photoReferences) &&
          Object.isFrozen(result.photoReferences[0]),
      );
    },
  );
  register(
    "zero photos do not satisfy required slots or mutate physical completion",
    () => {
      const input = fixture();
      input.currentPhotos = [];
      const result = assessPhotoCompleteness(input);
      assert(!result.complete && result.missingRequiredSlotKeys.length === 9);
      assert(!("attemptStatus" in result) && !("fieldCompletedAt" in result));
    },
  );
  register(
    "target slot snapshots must exactly match frozen template membership",
    () => {
      for (
        const fields of [
          { targetId: id(999) },
          { templateVersionId: id(999) },
          { slotKey: "another-slot" },
          { required: false },
          { displayOrder: 99 },
          { id: null },
        ]
      ) {
        const input = fixture();
        Object.assign(required(input.slotSnapshots[0]), fields);
        rejects(() => assessPhotoCompleteness(input));
      }
      const input = fixture();
      input.slotSnapshots[1] = { ...required(input.slotSnapshots[0]) };
      rejects(() => assessPhotoCompleteness(input));
    },
  );
  register(
    "cross attempt target slot null and duplicate current references fail closed",
    () => {
      for (
        const fields of [
          { attemptId: id(999) },
          { targetId: id(999) },
          { targetSlotId: id(999) },
          { targetSlotId: null },
          { version: 0 },
          { validationStatus: "uploaded" },
          { driveFileId: "never-accept-client-locator" },
        ]
      ) {
        const input = fixture();
        Object.assign(required(input.currentPhotos[0]), fields);
        rejects(() => assessPhotoCompleteness(input));
      }
      for (const fields of [{ targetSlotId: id(10) }, { id: id(100) }]) {
        const input = fixture();
        Object.assign(required(input.currentPhotos[1]), fields);
        rejects(() => assessPhotoCompleteness(input));
      }
    },
  );
  register(
    "pending failed purged expired and future uploaded photos cannot fill a slot",
    () => {
      for (
        const fields of [
          { validationStatus: "pending", uploadedAt: null, purgeAfter: null },
          { validationStatus: "failed" },
          { purgedAt: "2037-01-05T13:00:00Z" },
          {
            uploadedAt: "2036-12-29T12:00:00Z",
            purgeAfter: "2037-01-05T12:00:00Z",
          },
          {
            uploadedAt: "2037-01-07T12:00:00Z",
            purgeAfter: "2037-01-14T12:00:00Z",
          },
        ]
      ) {
        const input = fixture();
        Object.assign(required(input.currentPhotos[0]), fields);
        const result = assessPhotoCompleteness(input);
        assert(
          !result.complete && result.missingRequiredSlotKeys.join() === "tv-on",
        );
      }
      const boundary = fixture();
      boundary.asOf = "2037-01-12T12:00:00Z";
      assert(!assessPhotoCompleteness(boundary).complete);
    },
  );
  register(
    "server photo metadata requires exact retention and valid calendar timestamps",
    () => {
      for (
        const fields of [
          { uploadedAt: null, purgeAfter: null },
          { purgeAfter: "2037-01-13T12:00:00Z" },
          { uploadedAt: "2037-02-30T12:00:00Z" },
          { uploadedAt: "0000-01-01T12:00:00Z" },
          { purgedAt: "2037-01-04T12:00:00Z" },
        ]
      ) {
        const input = fixture();
        Object.assign(required(input.currentPhotos[0]), fields);
        rejects(() => assessPhotoCompleteness(input));
      }
    },
  );
  register(
    "replacing current photo creates a new reference without rewriting old manifest",
    () => {
      const input = fixture(), first = assessPhotoCompleteness(input);
      required(input.currentPhotos[0]).id = id(999);
      required(input.currentPhotos[0]).version = 2;
      const second = assessPhotoCompleteness(input);
      assert(
        required(first.photoReferences[0]).photoId === id(100) &&
          required(first.photoReferences[0]).photoVersion === 1,
      );
      assert(
        required(second.photoReferences[0]).photoId === id(999) &&
          required(second.photoReferences[0]).photoVersion === 2,
      );
      assert(
        !JSON.stringify(second).includes("uploadedAt") &&
          !JSON.stringify(second).includes("validationStatus"),
      );
    },
  );
  register(
    "microsecond retention and expiry boundaries do not round to milliseconds",
    () => {
      const input = fixture();
      required(input.currentPhotos[0]).uploadedAt =
        "2037-01-05T12:00:00.000001Z";
      required(input.currentPhotos[0]).purgeAfter =
        "2037-01-12T12:00:00.000002Z";
      rejects(() => assessPhotoCompleteness(input));
      required(input.currentPhotos[0]).purgeAfter =
        "2037-01-12T12:00:00.000001Z";
      input.asOf = "2037-01-12T12:00:00.000000Z";
      assert(
        assessPhotoCompleteness(input).photoReferences.some((photo) =>
          photo.slotKey === "tv-on"
        ),
      );
      input.asOf = "2037-01-12T12:00:00.000001Z";
      assert(
        !assessPhotoCompleteness(input).photoReferences.some((photo) =>
          photo.slotKey === "tv-on"
        ),
      );
    },
  );
  register(
    "optional empty is allowed but a selected invalid optional photo blocks completeness",
    () => {
      const input = fixture();
      assert(assessPhotoCompleteness(input).complete);
      input.currentPhotos.push({
        ...required(input.currentPhotos[0]),
        id: id(999),
        targetSlotId: id(19),
        validationStatus: "failed",
      });
      const invalid = assessPhotoCompleteness(input);
      assert(
        !invalid.complete && invalid.missingRequiredSlotKeys.length === 0 &&
          invalid.invalidCurrentSlotKeys.join() === "fixture-9",
      );
      input.currentPhotos.pop();
      assert(assessPhotoCompleteness(input).complete);
    },
  );
}

const runtime = globalThis as typeof globalThis & {
  Deno?: { test: (name: string, run: () => void) => void };
};
if (runtime.Deno) registerPhotoContractTests(runtime.Deno.test);
