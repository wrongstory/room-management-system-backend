/** Fixed, successful business routes only; no auth/public/error timing disclosure. */
export function apiTimingEligible(
  method: string,
  path: string,
  status: number,
): boolean {
  return method !== "OPTIONS" && method !== "HEAD" && status >= 200 &&
    status < 300 &&
    /^\/v1\/(?:rooms|room-types|reservations|assignments|availability|payroll|cleaning-history|work-history|inspections|attempts|submissions|notifications|complaints|cleaning-templates|photos|photo-uploads)(?:\/|$)/
      .test(path);
}

/** Caller supplies server-owned response headers, never request header values. */
export function apiTimingHeaders(elapsed: number, timing = "", exposed = "") {
  const ms = Number.isFinite(elapsed)
    ? Math.min(3600000, Math.max(0, elapsed))
    : 0;
  const names = exposed.split(",").map((name) => name.trim()).filter(Boolean);
  if (!names.some((name) => name.toLowerCase() === "server-timing")) {
    names.push("Server-Timing");
  }
  return {
    "server-timing": [timing, `api_total;dur=${ms.toFixed(1)}`].filter(Boolean)
      .join(", "),
    "access-control-expose-headers": names.join(", "),
  };
}
