import {
  createPhotoUploadClaim,
  decidePhotoCompensation,
  isPhotoUploadTransitionAllowed,
  photoUploadDatabaseError,
  preparePhotoUploadBegin,
  projectPhotoUploadOperation,
  validatePhotoCompensationSettlement,
  validatePhotoProviderSuccess,
  validatePhotoUploadBegin,
  validatePhotoUploadOperationCommand,
} from "./photo-upload-contract.ts";
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Photo upload contract regression");
}
function rejects(run: () => unknown) {
  let failed = false;
  try {
    run();
  } catch {
    failed = true;
  }
  assert(failed);
}
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const input = () => ({
  attemptId: id(1),
  assignmentId: id(2),
  assignmentRevision: 1,
  targetSlotId: id(3),
  expectedPhotoRevision: 0,
  sha256: "a".repeat(64),
  mime: "image/jpeg",
  sizeBytes: 307200,
});
const row = () => ({
  operationId: id(4),
  objectId: id(5),
  attemptId: id(1),
  targetSlotId: id(3),
  status: "reserved",
  leaseVersion: 1,
  leaseExpiresAt: "2037-01-01T00:05:00Z",
  photoId: null,
  photoVersion: null,
  uploadedAt: null,
  purgeAfter: null,
  compensationAllowed: false,
});
const uploaded = {
  uploadedAt: "2037-01-01T00:00:00.123456Z",
  purgeAfter: "2037-01-08T00:00:00.123456Z",
};
Deno.test("photo upload exact metadata boundary and request key hash are Deno compatible", async () => {
  assert(validatePhotoUploadBegin(input()).sizeBytes === 307200);
  for (
    const patch of [
      { sizeBytes: 307201 },
      { sizeBytes: 0 },
      { mime: "image/png" },
      { verified: true },
      { requestId: id(9) },
      { expectedPhotoRevision: Number.MAX_SAFE_INTEGER },
    ]
  ) rejects(() => validatePhotoUploadBegin({ ...input(), ...patch }));
  const first = await preparePhotoUploadBegin(
    id(8),
    input(),
    "synthetic-key-123",
  );
  const retry = await preparePhotoUploadBegin(
    id(8),
    input(),
    "synthetic-key-123",
  );
  assert(
    first.requestHash === retry.requestHash &&
      first.idempotencyKeyDigest === retry.idempotencyKeyDigest,
  );
  assert(!JSON.stringify(first).includes("synthetic-key-123"));
  const changed = await preparePhotoUploadBegin(id(8), {
    ...input(),
    sizeBytes: 100,
  }, "synthetic-key-123");
  assert(
    first.requestHash !== changed.requestHash &&
      first.idempotencyKeyDigest === changed.idempotencyKeyDigest,
  );
  assert(
    (await preparePhotoUploadBegin(id(9), input(), "synthetic-key-123"))
      .idempotencyKeyDigest !== first.idempotencyKeyDigest,
  );
});
Deno.test("photo claims are generated server-side and required for fenced internal commands", async () => {
  const [a, b] = await Promise.all([
    createPhotoUploadClaim(id(4)),
    createPhotoUploadClaim(id(4)),
  ]);
  assert(
    a.claimDigest !== b.claimDigest && /^[a-f0-9]{64}$/.test(a.claimDigest),
  );
  validatePhotoUploadOperationCommand("claim", { operationId: id(4), ...a });
  validatePhotoUploadOperationCommand("finalize", {
    operationId: id(4),
    leaseVersion: 1,
    ...a,
  });
  rejects(() =>
    validatePhotoUploadOperationCommand("finalize", {
      operationId: id(4),
      leaseVersion: 1,
    })
  );
  assert(
    !Object.hasOwn(
      projectPhotoUploadOperation({ ...row(), ...a }),
      "claimDigest",
    ),
  );
});
Deno.test("photo result projection redacts provider identity and enforces exact retention precision", () => {
  const result = projectPhotoUploadOperation({
    ...row(),
    providerLocator: "private_fixture",
    requestHash: "a".repeat(64),
    token: "private_fixture",
  });
  assert(!JSON.stringify(result).includes("private_fixture"));
  rejects(() =>
    projectPhotoUploadOperation({ ...row(), compensationAllowed: true })
  );
  rejects(() => projectPhotoUploadOperation({ ...row(), status: "accepted" }));
  rejects(() =>
    projectPhotoUploadOperation({
      ...row(),
      ...uploaded,
      purgeAfter: "2037-01-08T00:00:00.123455Z",
    })
  );
});
Deno.test("photo compensation never treats timeout or accepted result as deletion authority", () => {
  assert(decidePhotoCompensation(null, 1) === "reconcile");
  assert(
    decidePhotoCompensation(
      { ...row(), status: "reconciliation_pending" },
      1,
    ) === "reconcile",
  );
  assert(
    decidePhotoCompensation({
      ...row(),
      ...uploaded,
      status: "provider_succeeded",
    }, 1) === "reconcile",
  );
  const candidate = {
    ...row(),
    ...uploaded,
    status: "compensation_pending",
    compensationAllowed: true,
  };
  assert(decidePhotoCompensation(candidate, 1) === "candidate_deletion");
  assert(decidePhotoCompensation(candidate, 2) === "stale_fence");
  assert(
    decidePhotoCompensation({
      ...row(),
      ...uploaded,
      status: "accepted",
      photoId: id(7),
      photoVersion: 1,
    }, 2) === "preserve_accepted",
  );
  assert(!isPhotoUploadTransitionAllowed("accepted", "compensation_pending"));
  assert(
    isPhotoUploadTransitionAllowed(
      "reconciliation_pending",
      "compensation_pending",
    ),
  );
});
Deno.test("photo internal provider command validates identity and stable errors redact raw values", () => {
  const base = {
    operationId: id(4),
    leaseVersion: 1,
    claimDigest: "b".repeat(64),
  };
  validatePhotoProviderSuccess({
    ...base,
    providerLocator: "synthetic_object_123",
    uploadedAt: uploaded.uploadedAt,
  });
  rejects(() =>
    validatePhotoProviderSuccess({
      ...base,
      providerLocator: "https://unsafe.invalid",
      uploadedAt: uploaded.uploadedAt,
    })
  );
  rejects(() =>
    validatePhotoProviderSuccess({
      ...base,
      providerLocator: "synthetic_object_123",
      uploadedAt: "0000-01-01T00:00:00Z",
    })
  );
  validatePhotoCompensationSettlement({ ...base, outcome: "not_found" });
  rejects(() =>
    validatePhotoCompensationSettlement({ ...base, outcome: "timeout" })
  );
  assert(
    photoUploadDatabaseError({ message: "PHOTO_UPLOAD_FENCE_CONFLICT" })
      .statusCode === 409,
  );
  assert(
    photoUploadDatabaseError({ message: "raw private SQL" }).code ===
      "PHOTO_UPLOAD_FAILED",
  );
});
