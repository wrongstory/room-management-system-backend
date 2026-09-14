import {
  encryptWebPushAes128Gcm,
  parseRetryAfter,
  RfcWebPushProvider,
} from "./web-push-provider.ts";
const assert = (value: boolean, message = "assertion failed") => {
  if (!value) throw new Error(message);
};
const decode = (value: string) =>
  Uint8Array.from(
    atob(
      value.replace(/-/g, "+").replace(/_/g, "/") +
        "=".repeat((4 - value.length % 4) % 4),
    ),
    (c) => c.charCodeAt(0),
  );
const receiver =
  "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
const auth = "BTBZMqHH6r4Tts7J_aSIgg",
  senderPublic =
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  senderPrivate = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
Deno.test("RFC 8291 official vector and Node/Deno bytes remain exact", async () => {
  const body = await encryptWebPushAes128Gcm(
    "When I grow up, I want to be a watermelon",
    receiver,
    auth,
    {
      salt: decode("DGv6ra1nlYgDCS1FRnbzlw"),
      senderPrivateKey: decode(senderPrivate),
      senderPublicKey: decode(senderPublic),
    },
  );
  const encoded = btoa(String.fromCharCode(...body)).replace(/=/g, "").replace(
    /\+/g,
    "-",
  ).replace(/\//g, "_");
  assert(
    encoded ===
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});
Deno.test("Edge provider applies allowlist, status and retry-after contracts", async () => {
  const payload = JSON.stringify({
    notificationId: "60000000-0000-4000-8000-000000000006",
    deepLink: {
      kind: "cleaningTarget",
      entityId: "50000000-0000-4000-8000-000000000005",
    },
  });
  const subscription = {
    endpoint: "https://updates.push.services.mozilla.com/wpush/opaque",
    expirationTime: null,
    keys: { p256dh: receiver, auth },
  };
  let calls = 0;
  const provider = new RfcWebPushProvider({
    subject: "https://example.com/push-contact",
    currentVersion: "v1",
    current: { publicKey: senderPublic, privateKey: senderPrivate },
    keyring: {},
  }, async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "retry-after": "0" } });
  }, () => 1000);
  const result = await provider.send(
    subscription,
    payload,
    "60000000-0000-4000-8000-000000000006",
    5000,
    "v1",
  );
  assert(result.outcome === "retryable" && result.retryAfterSeconds === 1);
  assert(calls === 1);
  assert(parseRetryAfter("bogus", 0) === undefined);
  const denied = await provider.send(
    { ...subscription, endpoint: "https://localhost/private" },
    payload,
    "60000000-0000-4000-8000-000000000006",
    5000,
    "v1",
  );
  assert(denied.outcome === "provider_configuration_error" && calls === 1);
});
