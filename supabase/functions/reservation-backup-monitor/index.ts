import { collectBackupHealth } from "../_shared/reservation-backup-monitor.ts";
import { publishBackupAlert } from "../_shared/reservation-backup-alert.ts";
import { createBackupAlertToken } from "../_shared/reservation-backup-github-app.ts";
import {
  scheduledInvokeMode,
  verifyScheduledInvocation,
} from "../_shared/scheduled-invocation.ts";

const reply = (status: number, code: string) =>
  new Response(JSON.stringify({ code }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
export async function handleBackupMonitor(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "POST" || url.search ||
    !["/functions/v1/reservation-backup-monitor", "/reservation-backup-monitor"]
      .includes(url.pathname)
  ) {
    return reply(400, "MONITOR_REQUEST_INVALID");
  }
  const supplied = request.headers.get("x-rms-backup-monitor-key") ?? "";
  const expected = Deno.env.get("RESERVATION_BACKUP_MONITOR_KEY_SHA256") ?? "";
  let mode: ReturnType<typeof scheduledInvokeMode>;
  try {
    mode = scheduledInvokeMode(
      Deno.env.get("RESERVATION_BACKUP_MONITOR_INVOKE_MODE"),
    );
  } catch {
    return reply(503, "MONITOR_DISABLED");
  }
  if (
    !/^[a-f0-9]{64}$/.test(expected) ||
    (mode === "legacy" && !/^[a-f0-9]{64}$/.test(supplied)) ||
    (mode === "signed-v1" && request.headers.has("x-rms-backup-monitor-key"))
  ) {
    return reply(401, "MONITOR_UNAUTHORIZED");
  }
  const expectedBytes = Uint8Array.from(
    expected.match(/../g) ?? [],
    (value) => parseInt(value, 16),
  );
  let difference = 0;
  if (mode === "signed-v1") {
    difference = await verifyScheduledInvocation(
        request.headers,
        expectedBytes,
        "reservation-backup-monitor:matalcofimnhuzslfhdd",
      )
      ? 0
      : 1;
  } else {
    const bytes = new TextEncoder().encode(supplied);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    for (let i = 0; i < digest.length; i++) {
      difference |= digest[i]! ^ expectedBytes[i]!;
    }
    bytes.fill(0);
    digest.fill(0);
  }
  expectedBytes.fill(0);
  if (difference) return reply(401, "MONITOR_UNAUTHORIZED");
  if (
    Deno.env.get("RESERVATION_BACKUP_MONITOR_ENABLED") !== "true" ||
    Deno.env.get("SUPABASE_URL") !== "https://matalcofimnhuzslfhdd.supabase.co"
  ) return reply(503, "MONITOR_DISABLED");
  // No caller-controlled clock, credentials, project, query, callback, or notification recipient.
  try {
    const health = await collectBackupHealth(
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    );
    const token = await createBackupAlertToken({
      appId: Number(Deno.env.get("RESERVATION_BACKUP_ALERT_APP_ID")),
      installationId: Number(
        Deno.env.get("RESERVATION_BACKUP_ALERT_INSTALLATION_ID"),
      ),
      privateKeyPem: Deno.env.get("RESERVATION_BACKUP_ALERT_PRIVATE_KEY") ?? "",
    });
    await publishBackupAlert(health, {
      token,
      issue: Number(Deno.env.get("RESERVATION_BACKUP_ALERT_ISSUE")),
    });
    return reply(health.code === "HEALTHY" ? 200 : 503, health.code);
  } catch {
    return reply(503, "MONITOR_CHECK_FAILED");
  }
}

if (import.meta.main) Deno.serve(handleBackupMonitor);
