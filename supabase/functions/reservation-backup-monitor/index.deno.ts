import { handleBackupMonitor } from "./index.ts";

const variables = [
  "RESERVATION_BACKUP_MONITOR_KEY_SHA256",
  "RESERVATION_BACKUP_MONITOR_INVOKE_MODE",
  "RESERVATION_BACKUP_MONITOR_ENABLED",
  "SUPABASE_URL",
];
const old = new Map(variables.map((name) => [name, Deno.env.get(name)]));
const key = "1".repeat(64);
const digest = [
  ...new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  ),
]
  .map((value) => value.toString(16).padStart(2, "0")).join("");
function assert(value: unknown) {
  if (!value) throw new Error("Monitor boundary assertion failed");
}
const request = (value = key) =>
  new Request("https://example.test/reservation-backup-monitor", {
    method: "POST",
    headers: { "x-rms-backup-monitor-key": value },
    body: "{}",
  });
Deno.test("backup monitor refuses invalid requests and secrets without external calls", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("No external request expected");
  }) as typeof fetch;
  try {
    Deno.env.delete("RESERVATION_BACKUP_MONITOR_INVOKE_MODE");
    Deno.env.set("RESERVATION_BACKUP_MONITOR_KEY_SHA256", digest);
    Deno.env.set("RESERVATION_BACKUP_MONITOR_ENABLED", "true");
    Deno.env.set("SUPABASE_URL", "https://matalcofimnhuzslfhdd.supabase.co");
    for (
      const input of [
        new Request("https://example.test/"),
        new Request("https://example.test/?secret=synthetic", {
          method: "POST",
        }),
      ]
    ) {
      assert((await handleBackupMonitor(input)).status === 400);
    }
    assert((await handleBackupMonitor(request("2".repeat(64)))).status === 401);
    assert((await handleBackupMonitor(request(""))).status === 401);
    Deno.env.set("RESERVATION_BACKUP_MONITOR_ENABLED", "false");
    assert((await handleBackupMonitor(request())).status === 503);
    Deno.env.set("RESERVATION_BACKUP_MONITOR_ENABLED", "true");
    Deno.env.set("SUPABASE_URL", "https://aodikrxcczbogjpsjwjt.supabase.co");
    assert((await handleBackupMonitor(request())).status === 503);
    assert(calls === 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of old) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});

Deno.test("backup monitor signed mode authenticates bounded purpose without raw key or external calls", async () => {
  const saved = new Map(variables.map((name) => [name, Deno.env.get(name)]));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (() => {
    calls++;
    throw new Error("Unexpected network");
  }) as typeof fetch;
  const make = async (
    audience = "reservation-backup-monitor:matalcofimnhuzslfhdd",
    ageSeconds = 0,
  ) => {
    const at = String(Math.floor(Date.now() / 1000) - ageSeconds);
    const nonce = "ab".repeat(16);
    const signingKey = await crypto.subtle.importKey(
      "raw",
      Uint8Array.from(digest.match(/../g)!, (value) => parseInt(value, 16)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        signingKey,
        new TextEncoder().encode(
          `rms-scheduled-invocation-v1\n${audience}\n${at}\n${nonce}\nPOST`,
        ),
      ),
    );
    return new Headers({
      "x-rms-invoke-at": at,
      "x-rms-invoke-nonce": nonce,
      "x-rms-invoke-signature": [...signature].map((value) =>
        value.toString(16).padStart(2, "0")
      ).join(""),
    });
  };
  const invoke = (headers: Headers, path = "/reservation-backup-monitor") =>
    handleBackupMonitor(
      new Request(`https://example.test${path}`, {
        method: "POST",
        headers,
        body: "{}",
      }),
    );
  try {
    Deno.env.set("RESERVATION_BACKUP_MONITOR_KEY_SHA256", digest);
    Deno.env.set("RESERVATION_BACKUP_MONITOR_INVOKE_MODE", "signed-v1");
    Deno.env.set("RESERVATION_BACKUP_MONITOR_ENABLED", "false");
    Deno.env.set("SUPABASE_URL", "https://matalcofimnhuzslfhdd.supabase.co");
    // Disabled response proves authentication succeeded without executing a check/send.
    assert((await invoke(await make())).status === 503);
    assert(
      (await invoke(await make(), "/functions/v1/reservation-backup-monitor"))
        .status === 503,
    );
    assert(
      (await invoke(await make("notification-delivery:aodikrxcczbogjpsjwjt")))
        .status === 401,
    );
    assert((await invoke(await make(undefined, 61))).status === 401);
    assert((await invoke(await make(undefined, -10))).status === 401);
    assert(
      (await invoke(await make(), "/reservation-backup-monitor/extra"))
        .status === 400,
    );
    const downgraded = await make();
    downgraded.set("x-rms-backup-monitor-key", key);
    assert((await invoke(downgraded)).status === 401);
    assert((await handleBackupMonitor(request())).status === 401);
    const tampered = await make();
    tampered.set("x-rms-invoke-nonce", "cd".repeat(16));
    assert((await invoke(tampered)).status === 401);
    Deno.env.set("RESERVATION_BACKUP_MONITOR_INVOKE_MODE", "typo");
    assert((await invoke(await make())).status === 503);
    assert(calls === 0);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [name, value] of saved) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
});
