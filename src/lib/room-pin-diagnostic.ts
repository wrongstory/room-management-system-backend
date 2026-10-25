/** #317: a closed projection, never serialize an exception or request. */
export function roomPinOperation(
  method: string,
  rawPath: string,
): string | null {
  if (method !== "POST") return null;
  const path = rawPath.split("?")[0];
  if (path === "/v1/rooms/pins/bootstrap") return "bootstrap";
  const match =
    /^\/v1\/rooms\/[^/]+\/(pin\/reveal|pin\/generated\/confirm|pin-changes\/prepare|pin-changes\/[^/]+\/(?:confirm|rollback))$/
      .exec(path ?? "");
  if (!match) return null;
  if (match[1] === "pin/reveal") return "reveal";
  if (match[1] === "pin/generated/confirm") return "generated-confirm";
  if (match[1] === "pin-changes/prepare") return "prepare";
  return match[1]?.endsWith("/rollback") ? "rollback" : "confirm";
}

const codes = new Set([
  "ROOM_PIN_COMMAND_FAILED",
  "ROOM_COMMAND_FAILED",
  "ROOM_PIN_BOOTSTRAP_FAILED",
  "ROOM_PIN_NOT_CONFIGURED",
  "ROOM_PIN_CRYPTO_CONFIG_INVALID",
  "ROOM_PIN_KEY_UNAVAILABLE",
  "ROOM_PIN_DECRYPT_FAILED",
  "ROOM_PIN_ENCRYPT_FAILED",
  "ROOM_PIN_ENVELOPE_INVALID",
  "INTERNAL_SERVER_ERROR",
]);
const operations = new Set([
  "reveal",
  "prepare",
  "bootstrap",
  "generated-confirm",
  "confirm",
  "rollback",
]);

export function roomPinFailureDiagnostic(
  operation: string | null,
  requestId: string,
  status: number,
  code: unknown,
) {
  if (
    !operation || !operations.has(operation) || !Number.isInteger(status) ||
    status < 500 || status > 599
  ) return null;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(requestId)
  ) return null;
  return {
    operation,
    requestId,
    status,
    code: typeof code === "string" && codes.has(code)
      ? code
      : "INTERNAL_SERVER_ERROR",
  };
}
