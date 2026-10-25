/** GitHub App installation tokens restricted to this repository's issue alerts. */
const repositoryId = 1346229617;
const repositoryName = "wrongstory/room-management-system-backend";
const failure = "BACKUP_ALERT_AUTH_FAILED";
function assert(ok: unknown): asserts ok {
  if (!ok) throw new Error(failure);
}
function record(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");
}
function der(tag: number, content: Uint8Array): Uint8Array {
  assert(content.length < 65536);
  const length = content.length < 128
    ? [content.length]
    : content.length < 256
    ? [0x81, content.length]
    : [0x82, content.length >> 8, content.length & 255];
  const result = new Uint8Array(1 + length.length + content.length);
  result.set([tag, ...length]);
  result.set(content, 1 + length.length);
  return result;
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}
function privateKeyBytes(pem: string): Uint8Array {
  assert(pem.length < 16384);
  const match =
    /^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*([A-Za-z0-9+/=\r\n\t ]+)\s*-----END \1-----$/
      .exec(pem.trim());
  assert(match);
  const encoded = match[2]?.replace(/\s+/g, "");
  assert(
    encoded && encoded.length % 4 === 0 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(encoded),
  );
  const decoded = atob(encoded);
  assert(
    btoa(decoded) === encoded && decoded.length > 256 && decoded.length < 8192,
  );
  const bytes = Uint8Array.from(decoded, (value) => value.charCodeAt(0));
  if (match[1] === "PRIVATE KEY") return bytes;
  // RFC 5208 PrivateKeyInfo(version=0, rsaEncryption + NULL, PKCS#1 OCTET STRING).
  // GitHub downloads PKCS#1; WebCrypto imports the equivalent PKCS#8 container.
  const result = der(
    0x30,
    concat(
      new Uint8Array([0x02, 0x01, 0x00]),
      new Uint8Array([
        0x30,
        0x0d,
        0x06,
        0x09,
        0x2a,
        0x86,
        0x48,
        0x86,
        0xf7,
        0x0d,
        0x01,
        0x01,
        0x01,
        0x05,
        0x00,
      ]),
      der(0x04, bytes),
    ),
  );
  bytes.fill(0);
  return result;
}
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error(failure));
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, () => {
      signal.removeEventListener("abort", abort);
      reject(new Error(failure));
    });
    if (signal.aborted) abort();
  });
}

export async function createBackupAlertToken(input: {
  appId: number;
  installationId: number;
  privateKeyPem: string;
  fetcher?: typeof fetch;
  now?: Date;
}): Promise<string> {
  let keyBytes: Uint8Array | undefined;
  try {
    const now = input.now ?? new Date();
    assert(Number.isSafeInteger(input.appId) && input.appId > 0);
    assert(
      Number.isSafeInteger(input.installationId) && input.installationId > 0 &&
        Number.isFinite(now.getTime()),
    );
    keyBytes = privateKeyBytes(input.privateKeyPem);
    const key = await crypto.subtle.importKey(
      "pkcs8",
      new Uint8Array(keyBytes),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const algorithm = key.algorithm as RsaHashedKeyAlgorithm;
    assert(algorithm.modulusLength >= 2048 && algorithm.modulusLength <= 4096);
    keyBytes.fill(0);
    keyBytes = undefined;
    const encoder = new TextEncoder();
    const seconds = Math.floor(now.getTime() / 1000);
    const header = base64url(
      encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
    );
    const payload = base64url(
      encoder.encode(
        JSON.stringify({
          iss: String(input.appId),
          iat: seconds - 60,
          exp: seconds + 120,
        }),
      ),
    );
    const unsigned = `${header}.${payload}`;
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        encoder.encode(unsigned),
      ),
    );
    const jwt = `${unsigned}.${base64url(signature)}`;
    const url =
      `https://api.github.com/app/installations/${input.installationId}/access_tokens`;
    const signal = AbortSignal.timeout(10000);
    const response = await bounded(
      (input.fetcher ?? fetch)(url, {
        method: "POST",
        redirect: "error",
        signal,
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
          "User-Agent": "rms-reservation-backup-monitor",
        },
        body: JSON.stringify({
          repository_ids: [repositoryId],
          permissions: { issues: "write" },
        }),
      }),
      signal,
    );
    if (
      response.status !== 201 || response.redirected ||
      (response.url && response.url !== url)
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(failure);
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/.test(length) || Number(length) > 65536)) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(failure);
    }
    const reader = response.body?.getReader();
    assert(reader);
    const parts: Uint8Array[] = [];
    let size = 0;
    let result: Record<string, unknown>;
    try {
      for (;;) {
        const part = await bounded(reader.read(), signal);
        if (part.done) break;
        size += part.value.byteLength;
        assert(size <= 65536);
        parts.push(part.value);
      }
      const bytes = concat(...parts);
      try {
        result = record(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      } finally {
        bytes.fill(0);
        for (const part of parts) part.fill(0);
      }
    } finally {
      void reader.cancel().catch(() => undefined);
    }
    // Both classic and newer ghs_APPID_JWT installation tokens are supported.
    assert(
      typeof result.token === "string" &&
        /^ghs_[A-Za-z0-9_.-]{20,4092}$/.test(result.token),
    );
    assert(
      typeof result.expires_at === "string" &&
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result.expires_at),
    );
    const expires = Date.parse(result.expires_at);
    assert(
      expires > now.getTime() + 30000 && expires <= now.getTime() + 3660000,
    );
    assert(
      new Date(expires).toISOString().replace(".000Z", "Z") ===
        result.expires_at,
    );
    const permissions = record(result.permissions);
    assert(
      permissions.issues === "write" &&
        Object.entries(permissions).every(([name, level]) =>
          (name === "issues" && level === "write") ||
          (name === "metadata" && level === "read")
        ),
    );
    assert(
      result.repository_selection === "selected" &&
        Array.isArray(result.repositories) && result.repositories.length === 1,
    );
    const repository = record(result.repositories[0]);
    assert(
      repository.id === repositoryId && repository.full_name === repositoryName,
    );
    return result.token;
  } catch {
    throw new Error(failure);
  } finally {
    keyBytes?.fill(0);
  }
}
