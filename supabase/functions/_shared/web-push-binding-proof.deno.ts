import {
  issueWebPushBindingProof,
  verifyWebPushBindingProof,
} from "./web-push-binding-proof.ts";

const assert = (value: unknown, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const actor = {
  authUserId: "11000000-0000-4000-8000-000000000101",
  profileId: "11000000-0000-4000-8000-000000000001",
  sessionId: "11000000-0000-4000-8000-000000000901",
};
const publicKey =
  "BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU";
const secret = "web-push-binding-proof-vector-secret-123456";
const nowMs = 1_789_156_800_000;
const vector =
  "eyJ2IjoxLCJrIjoidmFwaWQtdjEiLCJwIjoiYVl2cVk5eEVvMFJtUF9GQ211b1FoQzN5ZTJ1Wkh2SllackxHd0N6Y3hiNCIsImkiOjE3ODkxNTY4MDAsImUiOjE3ODkxNTc0MDB9.4LD3jOoNUC5iW6tjMCc9g1andFsJEwJlWrCLbDiJ5Hg";

Deno.test("Web Push binding proof matches Node vector and actor/session scope", async () => {
  const keys = {
    currentVersion: "vapid-v1",
    currentPublicKey: publicKey,
    publicKeyring: {},
  };
  const issued = await issueWebPushBindingProof(actor, keys, secret, nowMs);
  assert(issued.bindingProof === vector);
  assert(issued.proofExpiresAt === "2026-09-11T20:10:00.000Z");
  const verified = await verifyWebPushBindingProof(
    vector,
    actor,
    keys,
    secret,
    nowMs + 599_000,
  );
  assert(
    verified.keyVersion === "vapid-v1" && verified.publicKey === publicKey,
  );
  let rejected = 0;
  for (
    const changed of [
      { ...actor, authUserId: "11000000-0000-4000-8000-000000000102" },
      { ...actor, sessionId: "11000000-0000-4000-8000-000000000902" },
    ]
  ) {
    try {
      await verifyWebPushBindingProof(vector, changed, keys, secret, nowMs);
    } catch {
      rejected++;
    }
  }
  assert(rejected === 2);
});

Deno.test("Web Push binding proof honors prior-key overlap and removal/expiry", async () => {
  const nextPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const nextPublicKey = btoa(
    String.fromCharCode(
      ...new Uint8Array(
        await crypto.subtle.exportKey("raw", nextPair.publicKey),
      ),
    ),
  )
    .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const overlap = {
    currentVersion: "vapid-v2",
    currentPublicKey: nextPublicKey,
    publicKeyring: { "vapid-v1": publicKey },
  };
  await verifyWebPushBindingProof(
    vector,
    actor,
    overlap,
    secret,
    nowMs + 1_000,
  );
  for (
    const [keys, at] of [
      [{
        currentVersion: "vapid-v2",
        currentPublicKey: nextPublicKey,
        publicKeyring: {},
      }, nowMs + 1_000],
      [overlap, nowMs + 600_000],
    ] as const
  ) {
    let rejected = false;
    try {
      await verifyWebPushBindingProof(vector, actor, keys, secret, at);
    } catch {
      rejected = true;
    }
    assert(rejected);
  }
});
