import {
  PhotoError,
  PHOTO_DECODE_BUDGET_MS,
  PHOTO_INPUT_MAX_BYTES,
  photoMime,
  readPhotoBody,
  verifyPhotoBinary,
} from "./photo-binary.js";
import type {
  DriveObject,
  DriveReadObject,
  PhotoProvider,
} from "./google-drive.js";
import {
  createPhotoUploadClaim,
  PhotoUploadContractError,
  photoMediaAvailabilities,
  photoRetentionPolicies,
  photoUploadDatabaseError,
  type PhotoMediaAvailability,
  type PhotoRetentionPolicy,
  type PhotoUploadOperationProjection,
  preparePhotoCollectionDelete,
  preparePhotoCollectionUploadBegin,
  preparePhotoCollectionUploadKey,
  preparePhotoUploadBegin,
  preparePhotoUploadKey,
  projectPhotoUploadOperation,
} from "./photo-upload-contract.js";

export interface PhotoIdentity {
  profileId: string;
  sessionId: string;
  role: "admin" | "developer" | "maid";
  profileStatus: string;
}
export interface PhotoRpc {
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{ data: unknown; error: unknown }>;
}
export type PhotoUploadResponse = PhotoUploadOperationProjection & {
  quotaWarning: boolean;
};
export type PhotoRoute =
  | { kind: "upload"; attemptId: string; slotId: string; photoItemId?: string }
  | {
    kind: "delete-item";
    attemptId: string;
    slotId: string;
    photoItemId: string;
  }
  | { kind: "slots"; attemptId: string }
  | { kind: "status"; operationId: string }
  | { kind: "content"; photoId: string };
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function invalid(): never {
  throw new PhotoError(400, "VALIDATION_ERROR");
}
function failed(): never {
  throw new PhotoError(500, "PHOTO_UPLOAD_FAILED");
}
function uuid(v: unknown): string {
  if (typeof v !== "string" || !uuidPattern.test(v)) return invalid();
  return v.toLowerCase();
}
function row(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return failed();
  return v as Record<string, unknown>;
}
function integer(v: unknown, min = 0): number {
  if (
    typeof v !== "number" || !Number.isSafeInteger(v) || v < min ||
    v >= Number.MAX_SAFE_INTEGER
  ) return invalid();
  return v;
}
function time(v: unknown): string {
  if (typeof v !== "string" || !Number.isFinite(Date.parse(v))) return failed();
  return v;
}
interface PhotoRetentionMetadata {
  readonly retentionPolicy: PhotoRetentionPolicy;
  readonly retentionStartsAt: string | null;
  readonly expiresAt: string | null;
  readonly purgedAt: string | null;
  readonly mediaAvailability: PhotoMediaAvailability;
}
function nullableTime(v: unknown): string | null {
  return v === null ? null : time(v);
}
function retentionMetadata(value: unknown): PhotoRetentionMetadata {
  const r = row(value);
  if (
    !photoRetentionPolicies.includes(r.retentionPolicy as PhotoRetentionPolicy) ||
    !photoMediaAvailabilities.includes(
      r.mediaAvailability as PhotoMediaAvailability,
    )
  ) return failed();
  const metadata = {
    retentionPolicy: r.retentionPolicy as PhotoRetentionPolicy,
    retentionStartsAt: nullableTime(r.retentionStartsAt),
    expiresAt: nullableTime(r.expiresAt),
    purgedAt: nullableTime(r.purgedAt),
    mediaAvailability: r.mediaAvailability as PhotoMediaAvailability,
  };
  if (
    (metadata.mediaAvailability === "purged") !==
      (metadata.purgedAt !== null) ||
    (metadata.expiresAt !== null &&
      (metadata.retentionStartsAt === null ||
        Date.parse(metadata.expiresAt) <
          Date.parse(metadata.retentionStartsAt)))
  ) return failed();
  return metadata;
}
function locator(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{10,200}$/.test(v)) {
    return failed();
  }
  return v;
}
export function photoRoute(method: string, path: string): PhotoRoute | null {
  const upload = path.match(
    /^\/v1\/attempts\/([^/]+)\/photo-slots\/([^/]+)\/upload$/,
  );
  const collectionUpload = path.match(
    /^\/v1\/attempts\/([^/]+)\/photo-slots\/([^/]+)\/photos\/([^/]+)\/upload$/,
  );
  const collectionItem = path.match(
    /^\/v1\/attempts\/([^/]+)\/photo-slots\/([^/]+)\/photos\/([^/]+)$/,
  );
  const slots = path.match(/^\/v1\/attempts\/([^/]+)\/photo-slots$/);
  const status = path.match(/^\/v1\/photo-uploads\/([^/]+)$/);
  const content = path.match(/^\/v1\/photos\/([^/]+)\/content$/);
  if (method === "POST" && upload) {
    return {
      kind: "upload",
      attemptId: uuid(upload[1]),
      slotId: uuid(upload[2]),
    };
  }
  if (method === "POST" && collectionUpload) {
    return {
      kind: "upload",
      attemptId: uuid(collectionUpload[1]),
      slotId: uuid(collectionUpload[2]),
      photoItemId: uuid(collectionUpload[3]),
    };
  }
  if (method === "DELETE" && collectionItem) {
    return {
      kind: "delete-item",
      attemptId: uuid(collectionItem[1]),
      slotId: uuid(collectionItem[2]),
      photoItemId: uuid(collectionItem[3]),
    };
  }
  if (method === "GET" && slots) {
    return { kind: "slots", attemptId: uuid(slots[1]) };
  }
  if (method === "GET" && status) {
    return { kind: "status", operationId: uuid(status[1]) };
  }
  if (method === "GET" && content) {
    return { kind: "content", photoId: uuid(content[1]) };
  }
  return null;
}
export function photoError(error: unknown): PhotoError {
  if (error instanceof PhotoError) return error;
  if (error instanceof PhotoUploadContractError) {
    return new PhotoError(error.statusCode, error.code);
  }
  return new PhotoError(500, "PHOTO_UPLOAD_FAILED");
}
function query(request: Request, keys: string[]): URLSearchParams {
  const params = new URL(request.url).searchParams;
  if (
    params.size !== keys.length ||
    keys.some((k) => params.getAll(k).length !== 1) ||
    [...params.keys()].some((k) => !keys.includes(k))
  ) invalid();
  return params;
}
function readObject(value: unknown): DriveReadObject {
  const r = row(value);
  if (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(r.sha256)) {
    return failed();
  }
  const sizeBytes = integer(r.sizeBytes, 1);
  if (sizeBytes > 307200) return failed();
  const mime = photoMime(typeof r.mimeType === "string" ? r.mimeType : null);
  if (mime !== "image/jpeg" && mime !== "image/webp") return failed();
  return {
    fileId: locator(r.providerFileId),
    mime,
    sizeBytes,
    sha256: r.sha256,
  };
}
function workerObject(value: unknown): DriveObject {
  const r = row(value);
  return {
    ...readObject(r),
    folderId: locator(r.providerFolderId),
    objectId: uuid(r.objectId),
  };
}
export class PhotoService {
  #quotaRefresh: Promise<void> | undefined;
  constructor(
    private readonly db: PhotoRpc,
    private readonly provider: () => PhotoProvider,
    private readonly initializeDecoder: () => Promise<void>,
  ) {}
  async #rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let response: { data: unknown; error: unknown };
    try {
      response = await this.db.rpc(name, args);
    } catch {
      return failed();
    }
    if (response.error) {
      const code = row(response.error).message;
      const extra: Record<string, number> = {
        PHOTO_QUOTA_SNAPSHOT_INVALID: 503,
        PHOTO_QUOTA_SNAPSHOT_STALE: 503,
        PHOTO_STORAGE_QUOTA_UNAVAILABLE: 503,
        PHOTO_STORAGE_QUOTA_EXCEEDED: 409,
        PHOTO_ADMISSION_EXPIRED: 409,
        PHOTO_PROVIDER_DATE_MISMATCH: 409,
        PHOTO_FOLDER_PARENT_REQUIRED: 409,
      };
      if (typeof code === "string" && Object.hasOwn(extra, code)) {
        const status = extra[code];
        if (status !== undefined) throw new PhotoError(status, code);
      }
      throw photoUploadDatabaseError(response.error);
    }
    return response.data;
  }
  #actor(i: PhotoIdentity): Record<string, unknown> {
    return {
      p_actor_profile_id: uuid(i.profileId),
      p_session_id: uuid(i.sessionId),
    };
  }
  #uploadActor(i: PhotoIdentity): void {
    if (
      i.role !== "maid" ||
      !["active", "deactivation_pending", "upload_only"].includes(
        i.profileStatus,
      )
    ) throw new PhotoError(403, "PHOTO_ACCESS_REQUIRED");
  }
  async #refreshQuota(): Promise<void> {
    this.#quotaRefresh ??= (async () => {
      const value = await this.provider().quota();
      try {
        await this.#rpc("refresh_photo_storage_quota", {
          p_request_started_at: value.refreshStartedAt,
          p_usage_bytes: value.usageBytes,
        });
      } catch (error) {
        if (photoError(error).code !== "PHOTO_QUOTA_SNAPSHOT_STALE") {
          throw error;
        }
      }
    })();
    try {
      await this.#quotaRefresh;
    } finally {
      this.#quotaRefresh = undefined;
    }
  }
  async upload(
    request: Request,
    i: PhotoIdentity,
    attemptId: string,
    slotId: string,
    photoItemId?: string,
  ): Promise<PhotoUploadResponse> {
    this.#uploadActor(i);
    const mime = photoMime(request.headers.get("content-type"));
    if (
      request.headers.has("content-encoding") ||
      request.headers.has("content-range")
    ) invalid();
    const collection = photoItemId !== undefined;
    const revisionKeys = collection
      ? ["expectedCollectionRevision", "expectedItemRevision"]
      : ["expectedPhotoRevision"];
    const params = query(request, [
      "assignmentId",
      "assignmentRevision",
      ...revisionKeys,
    ]);
    for (const key of ["assignmentRevision", ...revisionKeys]) {
      if (!/^(0|[1-9]\d{0,15})$/.test(params.get(key) ?? "")) invalid();
    }
    const common = {
      attemptId: uuid(attemptId),
      targetSlotId: uuid(slotId),
      assignmentId: uuid(params.get("assignmentId")),
      assignmentRevision: integer(Number(params.get("assignmentRevision")), 1),
    };
    const binding = collection
      ? {
        ...common,
        photoItemId: uuid(photoItemId),
        expectedCollectionRevision: integer(
          Number(params.get("expectedCollectionRevision")),
        ),
        expectedItemRevision: integer(
          Number(params.get("expectedItemRevision")),
        ),
      }
      : {
        ...common,
        expectedPhotoRevision: integer(
          Number(params.get("expectedPhotoRevision")),
        ),
      };
    const key = request.headers.get("idempotency-key");
    const keyDigest = collection
      ? await preparePhotoCollectionUploadKey(i.profileId, key)
      : await preparePhotoUploadKey(i.profileId, key);
    const admissionArgs = "photoItemId" in binding
      ? {
        ...this.#actor(i),
        p_attempt_id: binding.attemptId,
        p_assignment_id: binding.assignmentId,
        p_assignment_revision: binding.assignmentRevision,
        p_target_slot_id: binding.targetSlotId,
        p_photo_item_id: binding.photoItemId,
        p_expected_collection_revision: binding.expectedCollectionRevision,
        p_expected_item_revision: binding.expectedItemRevision,
        p_idempotency_key_digest: keyDigest,
      }
      : {
        ...this.#actor(i),
        p_attempt_id: binding.attemptId,
        p_assignment_id: binding.assignmentId,
        p_assignment_revision: binding.assignmentRevision,
        p_target_slot_id: binding.targetSlotId,
        p_expected_photo_revision: binding.expectedPhotoRevision,
        p_idempotency_key_digest: keyDigest,
      };
    const admissionRpc = collection
      ? "admit_photo_collection_upload"
      : "admit_photo_upload";
    let admission: unknown;
    try {
      admission = await this.#rpc(admissionRpc, admissionArgs);
    } catch (error) {
      if (photoError(error).code !== "PHOTO_STORAGE_QUOTA_UNAVAILABLE") {
        throw error;
      }
      await this.#refreshQuota();
      admission = await this.#rpc(admissionRpc, admissionArgs);
    }
    const quotaWarning = row(admission).quotaWarning;
    if (typeof quotaWarning !== "boolean") return failed();
    const response = (
      value: PhotoUploadOperationProjection,
    ): PhotoUploadResponse => ({ ...value, quotaWarning });
    // No allocation/decode before latest ownership and durable CPU/quota admission.
    const raw = await readPhotoBody(
      request.body,
      request.headers.get("content-length"),
      PHOTO_INPUT_MAX_BYTES,
    );
    await this.initializeDecoder();
    const decodeStarted = performance.now();
    let verified = await verifyPhotoBinary(raw, mime);
    const decodeElapsed = performance.now() - decodeStarted;
    const beginUpload = async () => {
      const prepared = "photoItemId" in binding
        ? await preparePhotoCollectionUploadBegin(i.profileId, {
          ...binding,
          sha256: verified.sha256,
          mime: verified.mime,
          sizeBytes: verified.sizeBytes,
        }, key)
        : await preparePhotoUploadBegin(i.profileId, {
          ...binding,
          sha256: verified.sha256,
          mime: verified.mime,
          sizeBytes: verified.sizeBytes,
        }, key);
      return projectPhotoUploadOperation(
        await this.#rpc(
          collection
            ? "begin_admitted_photo_collection_upload"
            : "begin_admitted_photo_upload",
          {
            ...this.#actor(i),
            p_admission_id: uuid(row(admission).admissionId),
            p_sha256: verified.sha256,
            p_mime_type: verified.mime,
            p_size_bytes: verified.sizeBytes,
            p_idempotency_key_digest: prepared.idempotencyKeyDigest,
            p_request_hash: prepared.requestHash,
          },
        ),
      );
    };
    let begin: PhotoUploadOperationProjection;
    try {
      begin = await beginUpload();
    } catch (error) {
      // Decode optimization may change normalized bytes. Only an existing-key conflict
      // can replay the previous codec; the same DB request/hash/CAS checks still apply.
      if (
        mime !== "image/jpeg" ||
        photoError(error).code !== "IDEMPOTENCY_KEY_REUSED"
      ) throw error;
      const legacyStarted = performance.now();
      const legacy = await verifyPhotoBinary(raw, mime, "legacy");
      if (
        decodeElapsed + performance.now() - legacyStarted >
          PHOTO_DECODE_BUDGET_MS
      ) {
        throw new PhotoError(413, "PHOTO_DECODE_LIMIT_EXCEEDED", {
          phase: "BUDGET",
          kind: "LIMIT",
        });
      }
      if (legacy.sha256 === verified.sha256) throw error;
      verified = legacy;
      begin = await beginUpload();
    }
    if (begin.status === "accepted") return response(begin);
    const { claimDigest } = await createPhotoUploadClaim(begin.operationId);
    const claimed = projectPhotoUploadOperation(
      await this.#rpc("claim_admitted_photo_upload", {
        ...this.#actor(i),
        p_operation_id: begin.operationId,
        p_claim_digest: claimDigest,
      }),
    );
    if (claimed.status === "accepted") return response(claimed);
    const worker = {
      p_operation_id: begin.operationId,
      p_lease_version: claimed.leaseVersion,
      p_claim_digest: claimDigest,
    };
    try {
      let context = row(
        await this.#rpc("get_photo_provider_context", {
          ...this.#actor(i),
          ...worker,
        }),
      );
      const provider = this.provider();
      if (
        context.providerFileId === null && context.providerFolderId === null
      ) {
        if (
          typeof context.uploadDate !== "string" ||
          typeof context.roomNumber !== "string"
        ) return failed();
        const [dateCandidate, roomCandidate, fileId] = await provider.generateUploadIds();
        let folderId: string | undefined;
        for (const scope of ["date", "room"] as const) {
          const reserved = row(
            await this.#rpc("reserve_photo_drive_folder", {
              ...this.#actor(i),
              ...worker,
              p_scope: scope,
              p_root_folder_id: provider.rootFolderId(),
              p_candidate_folder_id: scope === "date" ? dateCandidate : roomCandidate,
            }),
          );
          if (
            reserved.scope !== scope ||
            reserved.uploadDate !== context.uploadDate ||
            reserved.roomNumber !==
              (scope === "date" ? null : context.roomNumber)
          ) return failed();
          const parentFolderId = locator(reserved.parentFolderId);
          if (
            parentFolderId !==
              (scope === "date" ? provider.rootFolderId() : folderId)
          ) return failed();
          folderId = locator(reserved.folderId);
          await provider.ensureFolder({
            folderId,
            parentFolderId,
            name: scope === "date" ? context.uploadDate : context.roomNumber,
          });
        }
        context = row(
          await this.#rpc("reserve_photo_provider_identity", {
            ...this.#actor(i),
            ...worker,
            p_provider_file_id: fileId,
            p_provider_folder_id: folderId,
          }),
        );
      }
      const object = workerObject(context);
      if (
        object.objectId !== begin.objectId ||
        object.sha256 !== verified.sha256 ||
        object.sizeBytes !== verified.sizeBytes || object.mime !== verified.mime
      ) return failed();
      if (claimed.status !== "provider_succeeded") {
        if (
          context.uploadDate !==
            new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10)
        ) throw new PhotoError(409, "PHOTO_PROVIDER_DATE_MISMATCH");
        const success = await provider.upload(object, verified.bytes);
        await this.#rpc("record_admitted_photo_provider_success", {
          ...worker,
          p_provider_locator: object.fileId,
          p_uploaded_at: success.uploadedAt,
        });
      }
      return response(
        projectPhotoUploadOperation(
          await this.#rpc("finalize_admitted_photo_upload", {
            ...this.#actor(i),
            ...worker,
          }),
        ),
      );
    } catch (error) {
      // Lost finalize response is not rejection. A failed reconciliation NEVER authorizes deletion.
      try {
        const reconciled = await this.reconcile(begin.operationId);
        if (reconciled.status === "accepted") return response(reconciled);
      } catch {
        /* Durable operation remains for fenced reconciliation; do not log raw provider errors. */
      }
      throw photoError(error);
    }
  }
  async deleteItem(
    request: Request,
    i: PhotoIdentity,
    attemptId: string,
    slotId: string,
    photoItemId: string,
  ): Promise<unknown> {
    this.#uploadActor(i);
    const params = query(request, [
      "assignmentId",
      "assignmentRevision",
      "expectedCollectionRevision",
      "expectedItemRevision",
    ]);
    for (
      const key of [
        "assignmentRevision",
        "expectedCollectionRevision",
        "expectedItemRevision",
      ]
    ) if (!/^[1-9]\d{0,15}$/.test(params.get(key) ?? "")) invalid();
    const input = {
      attemptId: uuid(attemptId),
      targetSlotId: uuid(slotId),
      photoItemId: uuid(photoItemId),
      assignmentId: uuid(params.get("assignmentId")),
      assignmentRevision: integer(Number(params.get("assignmentRevision")), 1),
      expectedCollectionRevision: integer(
        Number(params.get("expectedCollectionRevision")),
        1,
      ),
      expectedItemRevision: integer(
        Number(params.get("expectedItemRevision")),
        1,
      ),
    };
    const prepared = await preparePhotoCollectionDelete(
      i.profileId,
      input,
      request.headers.get("idempotency-key"),
    );
    const result = row(
      await this.#rpc("delete_photo_collection_item", {
        ...this.#actor(i),
        p_attempt_id: input.attemptId,
        p_assignment_id: input.assignmentId,
        p_assignment_revision: input.assignmentRevision,
        p_target_slot_id: input.targetSlotId,
        p_photo_item_id: input.photoItemId,
        p_expected_collection_revision: input.expectedCollectionRevision,
        p_expected_item_revision: input.expectedItemRevision,
        p_idempotency_key_digest: prepared.idempotencyKeyDigest,
        p_request_hash: prepared.requestHash,
      }),
    );
    if (result.deleted !== true) return failed();
    return {
      attemptId: uuid(result.attemptId),
      targetSlotId: uuid(result.targetSlotId),
      photoItemId: uuid(result.photoItemId),
      collectionRevision: integer(result.collectionRevision, 1),
      itemRevision: integer(result.itemRevision, 1),
      deleted: true,
    };
  }
  async status(
    request: Request,
    i: PhotoIdentity,
    operationId: string,
  ): Promise<PhotoUploadOperationProjection> {
    this.#uploadActor(i);
    query(request, []);
    return projectPhotoUploadOperation(
      await this.#rpc("get_admitted_photo_upload", {
        ...this.#actor(i),
        p_operation_id: uuid(operationId),
      }),
    );
  }
  async slots(
    request: Request,
    i: PhotoIdentity,
    attemptId: string,
  ): Promise<unknown> {
    this.#uploadActor(i);
    query(request, []);
    const result = row(
      await this.#rpc("get_attempt_photo_slots", {
        ...this.#actor(i),
        p_attempt_id: uuid(attemptId),
      }),
    );
    if (!Array.isArray(result.slots) || result.slots.length > 100) {
      return failed();
    }
    return {
      attemptId: uuid(result.attemptId),
      assignmentId: uuid(result.assignmentId),
      assignmentRevision: integer(result.assignmentRevision, 1),
      slots: result.slots.map((value) => {
        const r = row(value);
        if (
          typeof r.slotKey !== "string" ||
          !/^[a-z][a-z0-9-]{0,79}$/.test(r.slotKey) ||
          typeof r.required !== "boolean" ||
          ![
            "missing",
            "cleared",
            "verified",
            "pending",
            "failed",
            "purged",
            "expired",
            "unavailable",
          ].includes(String(r.uploadStatus))
        ) return failed();
        const maxPhotos = r.maxPhotos === undefined
          ? 1
          : integer(r.maxPhotos, 1);
        if (![1, 10].includes(maxPhotos)) return failed();
        const legacyPhotos = r.photoId === null || r.photoId === undefined
          ? []
          : [{
            photoItemId: null,
            itemRevision: integer(r.currentRevision, 1),
            displayOrder: 0,
            photoId: r.photoId,
            photoVersion: integer(r.currentRevision, 1),
            uploadStatus: r.uploadStatus,
            retentionPolicy: r.retentionPolicy,
            retentionStartsAt: r.retentionStartsAt,
            expiresAt: r.expiresAt,
            purgedAt: r.purgedAt,
            mediaAvailability: r.mediaAvailability,
          }];
        const photos = r.photos === undefined ? legacyPhotos : r.photos;
        if (!Array.isArray(photos) || photos.length > 10) return failed();
        return {
          slotId: uuid(r.slotId),
          slotKey: r.slotKey,
          required: r.required,
          displayOrder: integer(r.displayOrder),
          maxPhotos,
          currentRevision: integer(r.currentRevision),
          collectionRevision:
            r.collectionRevision === null || r.collectionRevision === undefined
              ? null
              : integer(r.collectionRevision),
          photoCount: r.photoCount === undefined
            ? photos.length
            : integer(r.photoCount),
          uploadStatus: r.uploadStatus,
          photoId: i.profileStatus === "active" && r.photoId !== null &&
              r.photoId !== undefined
            ? uuid(r.photoId)
            : null,
          ...(photos.length === 1 ? retentionMetadata(r) : {}),
          photos: photos.map((value) => {
            const photo = row(value);
            if (
              ![
                "verified",
                "pending",
                "failed",
                "purged",
                "expired",
                "unavailable",
              ].includes(
                String(photo.uploadStatus),
              )
            ) return failed();
            return {
              photoItemId: photo.photoItemId === null
                ? null
                : uuid(photo.photoItemId),
              itemRevision: integer(photo.itemRevision, 1),
              displayOrder: integer(photo.displayOrder),
              photoId: i.profileStatus === "active" && photo.photoId !== null
                ? uuid(photo.photoId)
                : null,
              photoVersion: integer(photo.photoVersion, 1),
              uploadStatus: photo.uploadStatus,
              ...retentionMetadata(photo),
            };
          }),
        };
      }),
    };
  }
  async content(
    request: Request,
    i: PhotoIdentity,
    photoId: string,
  ): Promise<Response> {
    if (i.profileStatus !== "active" || !["admin", "maid"].includes(i.role)) {
      throw new PhotoError(403, "PHOTO_ACCESS_REQUIRED");
    }
    query(request, []);
    if (request.headers.has("range")) invalid();
    const args = { ...this.#actor(i), p_photo_id: uuid(photoId) };
    const first = row(await this.#rpc("authorize_photo_read", args));
    const object = readObject(first);
    const firstRetention = retentionMetadata(first);
    if (
      firstRetention.mediaAvailability !== "available" ||
      (firstRetention.expiresAt !== null &&
        Date.parse(firstRetention.expiresAt) <= Date.now())
    ) throw new PhotoError(403, "PHOTO_ACCESS_REQUIRED");
    const bytes = await this.provider().read(object);
    const latest = row(await this.#rpc("authorize_photo_read", args));
    const latestRetention = retentionMetadata(latest);
    if (
      latest.providerFileId !== first.providerFileId ||
      latest.sha256 !== first.sha256 ||
      JSON.stringify(latestRetention) !== JSON.stringify(firstRetention) ||
      latestRetention.mediaAvailability !== "available" ||
      (latestRetention.expiresAt !== null &&
        Date.parse(latestRetention.expiresAt) <= Date.now())
    ) throw new PhotoError(403, "PHOTO_ACCESS_REQUIRED");
    return new Response(Uint8Array.from(bytes), {
      headers: {
        "content-type": object.mime,
        "content-length": String(bytes.length),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-disposition": `inline; filename="photo.${
          object.mime === "image/jpeg" ? "jpg" : "webp"
        }"`,
      },
    });
  }
  /** Internal worker only. Never routed publicly. An accepted identity is terminal even after access revocation. */
  async reconcile(
    operationId: string,
  ): Promise<PhotoUploadOperationProjection> {
    const { claimDigest } = await createPhotoUploadClaim(operationId);
    let result = projectPhotoUploadOperation(
      await this.#rpc("reconcile_admitted_photo_upload", {
        p_operation_id: uuid(operationId),
        p_claim_digest: claimDigest,
      }),
    );
    if (result.status === "accepted" || result.status === "compensated") {
      return result;
    }
    const args = {
      p_operation_id: operationId,
      p_lease_version: result.leaseVersion,
      p_claim_digest: claimDigest,
    };
    let context = row(
      await this.#rpc("get_photo_reconciliation_context", args),
    );
    if (result.status === "reconciliation_pending") {
      // No second upload. Only verified existing bytes at the reserved identity can resolve uncertainty.
      const object = workerObject(context),
        success = await this.provider().inspect(object);
      result = projectPhotoUploadOperation(
        await this.#rpc("record_admitted_photo_provider_success", {
          ...args,
          p_provider_locator: object.fileId,
          p_uploaded_at: success.uploadedAt,
        }),
      );
      if (
        result.status !== "compensation_pending" || !result.compensationAllowed
      ) return result;
      context = row(await this.#rpc("get_photo_reconciliation_context", args));
    }
    if (
      context.status !== "compensation_pending" ||
      context.compensationAllowed !== true
    ) return result;
    const outcome = await this.provider().remove(
      locator(context.providerFileId),
    );
    return projectPhotoUploadOperation(
      await this.#rpc("settle_admitted_photo_compensation", {
        ...args,
        p_outcome: outcome,
      }),
    );
  }
}
