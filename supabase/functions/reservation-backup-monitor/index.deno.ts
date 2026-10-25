import { handleBackupMonitor } from "./index.ts";

const variables = [
  "RESERVATION_BACKUP_MONITOR_KEY_SHA256",
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
