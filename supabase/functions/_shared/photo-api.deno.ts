import { handleApiRequest } from "../api/index.ts";
import { authenticate, type EdgeClients } from "./runtime.ts";
import { PhotoService } from "./photo-service.ts";
import type { PhotoProvider } from "./google-drive.ts";

const id = (n: number) =>
  `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const auth = `header.${
  btoa(JSON.stringify({ session_id: id(2) }))
}.verified-by-auth-double`;
function setup(
  role = "maid",
  status = "active",
  revoked = false,
  password = false,
  denied = false,
) {
  const calls: string[] = [];
  const profile = {
    id: id(1),
    auth_user_id: id(10),
    role,
    status,
    display_name: "합성 계정",
    must_change_password: password,
  };
  const query = {
    select: () => query,
    eq: () => query,
    single: () => Promise.resolve({ data: profile, error: null }),
  };
  const clients = {
    publicClient: {
      auth: {
        getUser: () =>
          Promise.resolve({ data: { user: { id: id(10) } }, error: null }),
      },
    },
    admin: {
      from: () => query,
      rpc: (name: string) => {
        calls.push(name);
        const error = denied && name !== "is_active_auth_session" &&
            name !== "record_authorization_denial"
          ? { message: "PHOTO_ACCESS_REQUIRED" }
          : null;
        return Promise.resolve({
          error,
          data: name === "is_active_auth_session"
            ? !revoked
            : name === "get_attempt_photo_slots"
            ? {
              attemptId: id(3),
              assignmentId: id(8),
              assignmentRevision: 1,
              slots: [{
                slotId: id(4),
                slotKey: "tv",
                required: true,
                displayOrder: 0,
                currentRevision: 0,
                uploadStatus: "missing",
                photoId: null,
                providerFileId: "private_provider_never_output",
              }],
            }
            : name === "get_admitted_photo_upload"
            ? {
              operationId: id(5),
              objectId: id(6),
              attemptId: id(3),
              targetSlotId: id(4),
              status: "reserved",
              leaseVersion: 0,
              leaseExpiresAt: null,
              photoId: null,
              photoVersion: null,
              uploadedAt: null,
              purgeAfter: null,
              compensationAllowed: false,
            }
            : name === "authorize_photo_read"
            ? {
              photoId: id(7),
              providerFileId: "private_file_123",
              sha256: "a".repeat(64),
              mimeType: "image/jpeg",
              sizeBytes: 3,
              purgeAfter: new Date(Date.now() + 60000).toISOString(),
            }
            : name === "admit_photo_upload"
            ? { admissionId: id(9), quotaWarning: false }
            : null,
        });
      },
    },
  } as unknown as EdgeClients;
  const provider = {
    read: () => {
      calls.push("provider.read");
      return Promise.resolve(new Uint8Array([1, 2, 3]));
    },
  } as unknown as PhotoProvider;
  const service = new PhotoService(clients.admin, () => provider, () => {
    calls.push("decoder");
    return Promise.resolve();
  });
  return {
    calls,
    dependencies: {
      createClients: () => clients,
      authenticateRequest: authenticate,
      photoService: () => service,
    },
  };
}
function request(method: string, path: string, body?: Uint8Array) {
  return new Request(`http://localhost/functions/v1/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${auth}`,
      "content-type": "image/jpeg",
      "idempotency-key": "fixture-key-0001",
    },
    body,
  });
}
Deno.test("photo exact HTTP routes use verified latest active/limited identity and never expose provider context", async () => {
  for (const state of ["active", "deactivation_pending", "upload_only"]) {
    const s = setup("maid", state);
    for (
      const path of [
        `/v1/attempts/${id(3)}/photo-slots`,
        `/v1/photo-uploads/${id(5)}`,
      ]
    ) {
      const response = await handleApiRequest(
        request("GET", path),
        s.dependencies,
      );
      assert(response.status === 200, "own authorized safe metadata");
      const text = await response.text();
      assert(
        !/private_provider|session_id|claimDigest/.test(text),
        "no provider/session in public projection",
      );
    }
    const content = await handleApiRequest(
      request("GET", `/v1/photos/${id(7)}/content`),
      s.dependencies,
    );
    assert(
      content.status === (state === "active" ? 200 : 403),
      "limited upload permission never grants original read",
    );
  }
  for (const role of ["admin", "developer"]) {
    const s = setup(role);
    const metadata = await handleApiRequest(
      request("GET", `/v1/attempts/${id(3)}/photo-slots`),
      s.dependencies,
    );
    assert(
      metadata.status === 403 && !s.calls.includes("get_attempt_photo_slots"),
      "exact maid metadata",
    );
    const content = await handleApiRequest(
      request("GET", `/v1/photos/${id(7)}/content`),
      s.dependencies,
    );
    assert(
      content.status === (role === "admin" ? 200 : 403),
      "business admin content only",
    );
  }
  for (
    const [state, revoked, password] of [
      ["inactive", false, false],
      ["departed", false, false],
      ["active", true, false],
      ["active", false, true],
    ] as const
  ) {
    const s = setup("maid", state, revoked, password);
    for (
      const path of [
        `/v1/attempts/${id(3)}/photo-slots`,
        `/v1/photos/${id(7)}/content`,
      ]
    ) {
      const response = await handleApiRequest(
        request("GET", path),
        s.dependencies,
      );
      assert(
        [401, 403].includes(response.status) &&
          !s.calls.includes("provider.read"),
        "inactive/revoked/password gate before data",
      );
    }
  }
});
Deno.test("photo routing rejects aliases, unsupported methods, oversized raw body and records bounded capability denial", async () => {
  const upload = `/v1/attempts/${id(3)}/photo-slots/${id(4)}/upload`;
  const s = setup();
  for (
    const [method, path] of [
      ["GET", upload],
      ["POST", `/v1/photos/${id(7)}/content`],
      ["GET", `/v1/photos/${id(7)}/content/extra`],
      ["GET", `/v1/attempts/${id(3)}/photo-slots/`],
      ["GET", `/v1/photos//${id(7)}/content`],
    ]
  ) {
    const response = await handleApiRequest(
      request(method ?? "", path ?? ""),
      s.dependencies,
    );
    assert(
      response.status === 404 &&
        (await response.json()).error.code === "ROUTE_NOT_FOUND",
      "exact method/path unknown route contract",
    );
  }
  const response = await handleApiRequest(
    request(
      "POST",
      `${upload}?assignmentId=${
        id(8)
      }&assignmentRevision=1&expectedPhotoRevision=0`,
      new Uint8Array(307201),
    ),
    s.dependencies,
  );
  assert(
    response.status === 413 &&
      (await response.json()).error.code === "PHOTO_TOO_LARGE",
    "raw overflow before decoder/provider",
  );
  assert(
    s.calls.includes("admit_photo_upload") && !s.calls.includes("decoder"),
    "admission bounds CPU",
  );
  for (const status of ["active", "deactivation_pending", "upload_only"]) {
    const denied = setup("maid", status, false, false, true);
    const response = await handleApiRequest(
      request("GET", `/v1/attempts/${id(3)}/photo-slots`),
      denied.dependencies,
    );
    assert(
      response.status === 403 &&
        (await response.json()).error.code === "PHOTO_ACCESS_REQUIRED",
      "DB capability denied stable 403",
    );
    assert(
      denied.calls.includes("record_authorization_denial"),
      "finite photos denial source; no raw URL/body logging",
    );
  }
});
