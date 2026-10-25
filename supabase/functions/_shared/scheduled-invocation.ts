/** Short-lived, purpose-bound invocation. The signing key never enters pg_net headers.
 * A captured signature can replay this fixed operation within 60 seconds; worker
 * claims/idempotency remain responsible for preventing duplicate delivery/alerts.
 */
const utf8 = (value: string) => new TextEncoder().encode(value);
const buffer = (value: Uint8Array) =>
  value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
export type ScheduledAudience =
  | "notification-delivery:aodikrxcczbogjpsjwjt"
  | "reservation-backup-monitor:matalcofimnhuzslfhdd"
  | "reservation-scheduler:aodikrxcczbogjpsjwjt";
export function scheduledInvokeMode(
  value: string | undefined,
): "legacy" | "signed-v1" {
  if (value === undefined || value === "legacy") return "legacy";
  if (value === "signed-v1") return value;
  throw new Error("SCHEDULED_INVOKE_CONFIG_INVALID");
}
export async function verifyScheduledInvocation(
  headers: Headers,
  keyMaterial: Uint8Array,
  audience: ScheduledAudience,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    const at = headers.get("x-rms-invoke-at") ?? "";
    const nonce = headers.get("x-rms-invoke-nonce") ?? "";
    const signature = headers.get("x-rms-invoke-signature") ?? "";
    if (
      keyMaterial.byteLength < 32 || keyMaterial.byteLength > 4096 ||
      !/^[1-9][0-9]{9}$/.test(at) || !/^[a-f0-9]{32}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(signature) || !Number.isSafeInteger(nowMs)
    ) return false;
    const ageMs = nowMs - Number(at) * 1000;
    if (ageMs < -5000 || ageMs >= 60000) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      buffer(keyMaterial),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const message = utf8(
      `rms-scheduled-invocation-v1\n${audience}\n${at}\n${nonce}\nPOST`,
    );
    const supplied = Uint8Array.from(
      signature.match(/../g)!,
      (value) => parseInt(value, 16),
    );
    return await crypto.subtle.verify(
      "HMAC",
      key,
      buffer(supplied),
      buffer(message),
    );
  } catch {
    return false;
  }
}
