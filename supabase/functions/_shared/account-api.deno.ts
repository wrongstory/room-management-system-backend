import {
  changeAccountRole,
  changeAccountStatus,
  changePassword,
  createAccount,
  listAccounts,
  login,
  resetAccountPassword,
} from "./account-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEquals(
  actual: unknown,
  expected: unknown,
  message: string,
): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${message}: expected ${JSON.stringify(expected)}, got ${
        JSON.stringify(actual)
      }`,
    );
  }
}

async function captureEdgeError(
  run: () => Promise<unknown>,
): Promise<EdgeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EdgeError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected EdgeError");
}

function request(
  body: Record<string, unknown>,
  idempotency = "edge-test-0001",
  clientIp = "192.0.2.10",
): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotency,
      "cf-connecting-ip": clientIp,
    },
    body: JSON.stringify(body),
  });
}

function passwordRequest(
  body: Record<string, unknown>,
  idempotency = "edge-password-0001",
): Request {
  const sessionId = "30000000-0000-4000-8000-000000000001";
  const claims = btoa(JSON.stringify({ session_id: sessionId }))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const value = request(body, idempotency);
  value.headers.set("authorization", `Bearer x.${claims}.y`);
  return value;
}

const developer: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "developer",
  role: "developer",
  mustChangePassword: false,
};

const maid: EdgeActor = {
  ...developer,
  role: "maid",
};

const temporaryAdmin: EdgeActor = {
  ...developer,
  role: "admin",
  mustChangePassword: true,
};

const profile = {
  id: "20000000-0000-4000-8000-000000000002",
  auth_user_id: "10000000-0000-4000-8000-000000000002",
  display_name: "운영 관리자",
  display_name_normalized: "운영 관리자",
  login_id: "운영 관리자",
  login_id_normalized: "운영 관리자",
  role: "admin",
  status: "active",
  phone_last_four: "1234",
  phone_lookup_hash: "phone-hash",
  must_change_password: true,
  failed_login_count: 0,
  locked_until: null,
  created_at: "2026-08-30T00:00:00.000Z",
  updated_at: "2026-08-30T00:00:00.000Z",
};

const passwordEffectMarker = "e".repeat(64);
const allowedPasswordVerification = {
  data: [{ allowed: true, retry_after_seconds: 0 }],
  error: null,
};

function queryResult(data: unknown, error: unknown = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => Promise.resolve({ data, error }),
    single: () => Promise.resolve({ data, error }),
    maybeSingle: () => Promise.resolve({ data, error }),
  };
  return chain;
}

Deno.test("unknown alias and wrong password share INVALID_CREDENTIALS", async () => {
  Deno.env.set("ACCOUNT_PHONE_PEPPER", "test-only-login-pepper-32-characters");
  const unknownEvents: string[] = [];
  const unknownClients = {
    admin: {
      rpc: (name: string) => {
        unknownEvents.push(`rpc:${name}`);
        return Promise.resolve({
          data: [{ allowed: true, retry_after_seconds: 0 }],
          error: null,
        });
      },
      from: (table: string) => {
        unknownEvents.push(`from:${table}`);
        return queryResult(null);
      },
    },
    publicClient: { auth: { signInWithPassword: () => Promise.resolve({}) } },
  } as unknown as EdgeClients;

  const unknown = await captureEdgeError(() =>
    login(request({ loginId: "unknown", password: "1234" }), unknownClients)
  );

  const wrongEvents: string[] = [];
  const wrongClients = {
    admin: {
      rpc: (name: string) => {
        wrongEvents.push(`rpc:${name}`);
        if (name === "consume_login_rate_limits") {
          return Promise.resolve({
            data: [{ allowed: true, retry_after_seconds: 0 }],
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      },
      from: (table: string) => {
        wrongEvents.push(`from:${table}`);
        return table === "login_aliases"
          ? queryResult({ profile_id: profile.id })
          : queryResult(profile);
      },
    },
    publicClient: {
      auth: {
        signInWithPassword: () =>
          Promise.resolve({ data: {}, error: { message: "bad" } }),
      },
    },
  } as unknown as EdgeClients;
  const wrong = await captureEdgeError(() =>
    login(
      request({ loginId: profile.login_id, password: "0000" }),
      wrongClients,
    )
  );

  assertEquals(unknown.code, "INVALID_CREDENTIALS", "unknown alias code");
  assertEquals(wrong.code, "INVALID_CREDENTIALS", "wrong password code");
  assertEquals(unknown.message, wrong.message, "credential error message");
  assertEquals(
    unknownEvents.slice(0, 2),
    ["rpc:consume_login_rate_limits", "from:login_aliases"],
    "durable limiter runs before alias lookup",
  );
  assert(
    unknownEvents.includes("rpc:record_unknown_login_failure"),
    "unknown account failure must use the bounded activity aggregate",
  );
  assert(
    wrongEvents.includes("rpc:record_login_failure"),
    "known account failure must increment the account lock counter",
  );
  assert(
    wrongEvents.includes("rpc:record_actor_activity_event"),
    "known account failure must append a safe activity event",
  );
});

Deno.test("rate limit response includes Retry-After", async () => {
  Deno.env.set("ACCOUNT_PHONE_PEPPER", "test-only-login-pepper-32-characters");
  const clients = {
    admin: {
      rpc: () =>
        Promise.resolve({
          data: [{ allowed: false, retry_after_seconds: 17 }],
          error: null,
        }),
    },
    publicClient: {},
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    login(request({ loginId: "admin", password: "1234" }), clients)
  );

  assertEquals(error.status, 429, "rate-limit status");
  assertEquals(error.code, "LOGIN_RATE_LIMITED", "rate-limit code");
  assertEquals(error.headers["retry-after"], "17", "Retry-After header");
});

Deno.test("an exhausted client bucket does not block another client", async () => {
  Deno.env.set("ACCOUNT_PHONE_PEPPER", "test-only-login-pepper-32-characters");
  const attempts = new Map<string, number>();
  const limiterParameters: Array<Record<string, string | number>> = [];
  const clients = {
    admin: {
      rpc: (name: string, parameters: Record<string, string | number>) => {
        if (name === "record_unknown_login_failure") {
          return Promise.resolve({ data: null, error: null });
        }
        assertEquals(name, "consume_login_rate_limits", "login limiter RPC");
        limiterParameters.push(parameters);
        const clientKey = String(parameters.p_client_key_hash);
        const next = (attempts.get(clientKey) ?? 0) + 1;
        attempts.set(clientKey, next);
        return Promise.resolve({
          data: [{
            allowed: next <= 2,
            retry_after_seconds: next <= 2 ? 0 : 30,
            blocked_scope: next <= 2 ? null : "client",
          }],
          error: null,
        });
      },
      from: () => queryResult(null),
    },
    publicClient: { auth: { signInWithPassword: () => Promise.resolve({}) } },
  } as unknown as EdgeClients;

  for (const loginId of ["rotating-1", "rotating-2"]) {
    const error = await captureEdgeError(() =>
      login(
        request({ loginId, password: "1234" }, undefined, "198.51.100.10"),
        clients,
      )
    );
    assertEquals(error.code, "INVALID_CREDENTIALS", "allowed attacker request");
  }
  const blocked = await captureEdgeError(() =>
    login(
      request(
        { loginId: "rotating-3", password: "1234" },
        undefined,
        "198.51.100.10",
      ),
      clients,
    )
  );
  const normal = await captureEdgeError(() =>
    login(
      request(
        { loginId: "admin", password: "1234" },
        undefined,
        "203.0.113.20",
      ),
      clients,
    )
  );

  assertEquals(blocked.code, "LOGIN_RATE_LIMITED", "attacker client denial");
  assertEquals(normal.code, "INVALID_CREDENTIALS", "normal client isolation");
  assertEquals(attempts.size, 2, "two trusted client buckets");
  assertEquals(
    limiterParameters[0]?.p_client_limit,
    30,
    "client production limit",
  );
  assertEquals(
    limiterParameters[0]?.p_login_limit,
    10,
    "login production limit",
  );
  assertEquals(
    limiterParameters[0]?.p_global_limit,
    600,
    "emergency global limit",
  );
  assert(
    limiterParameters[0]?.p_global_key_hash ===
      limiterParameters[3]?.p_global_key_hash,
    "all clients share only the high emergency bucket",
  );
});

Deno.test("platform Cloudflare address wins over spoofable fallback headers", async () => {
  Deno.env.set("ACCOUNT_PHONE_PEPPER", "test-only-login-pepper-32-characters");
  const clientKeys: string[] = [];
  const clients = {
    admin: {
      rpc: (name: string, parameters: Record<string, string>) => {
        if (name === "record_unknown_login_failure") {
          return Promise.resolve({ data: null, error: null });
        }
        clientKeys.push(parameters.p_client_key_hash);
        return Promise.resolve({
          data: [{ allowed: true, retry_after_seconds: 0 }],
          error: null,
        });
      },
      from: () => queryResult(null),
    },
    publicClient: { auth: { signInWithPassword: () => Promise.resolve({}) } },
  } as unknown as EdgeClients;

  const first = request({ loginId: "unknown", password: "1234" });
  first.headers.set("x-real-ip", "198.51.100.1");
  first.headers.set("x-forwarded-for", "198.51.100.2");
  const second = request({ loginId: "unknown", password: "1234" });
  second.headers.set("x-real-ip", "203.0.113.1");
  second.headers.set("x-forwarded-for", "203.0.113.2");

  await captureEdgeError(() => login(first, clients));
  await captureEdgeError(() => login(second, clients));

  assertEquals(clientKeys.length, 2, "two limiter calls");
  assertEquals(
    clientKeys[0],
    clientKeys[1],
    "spoofable fallbacks cannot change a Cloudflare client bucket",
  );
});

Deno.test("hosted Supabase fails closed without platform client metadata", async () => {
  Deno.env.set("ACCOUNT_PHONE_PEPPER", "test-only-login-pepper-32-characters");
  const hostedRequest = new Request(
    "https://example.supabase.co/functions/v1/api/v1/auth/login",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ loginId: "admin", password: "1234" }),
    },
  );
  const error = await captureEdgeError(() =>
    login(hostedRequest, {} as EdgeClients)
  );

  assertEquals(
    error.code,
    "LOGIN_CLIENT_ID_UNAVAILABLE",
    "hosted requests require Cloudflare client metadata",
  );
});

Deno.test("account API rejects maid and temporary-password admin", async () => {
  const clients = {} as EdgeClients;
  const maidError = await captureEdgeError(() => listAccounts(clients, maid));
  const passwordError = await captureEdgeError(() =>
    listAccounts(clients, temporaryAdmin)
  );

  assertEquals(maidError.code, "ACCOUNT_MANAGER_REQUIRED", "maid denial");
  assertEquals(
    passwordError.code,
    "PASSWORD_CHANGE_REQUIRED",
    "temporary admin denial",
  );
});

Deno.test("account creation accepts only admin or maid roles", async () => {
  const error = await captureEdgeError(() =>
    createAccount(
      request({
        displayName: "추가 개발자",
        role: "developer",
        phone: "01000000000",
      }),
      {} as EdgeClients,
      developer,
    )
  );

  assertEquals(error.code, "VALIDATION_ERROR", "developer role input denial");
});

Deno.test("developer and active admin create separate business accounts", async () => {
  Deno.env.set("ACCOUNT_PHONE_PEPPER", "test-only-login-pepper-32-characters");
  const activeAdmin: EdgeActor = { ...developer, role: "admin" };
  for (
    const [index, entry] of [
      { actor: developer, role: "admin", displayName: "운영 관리자" },
      { actor: activeAdmin, role: "maid", displayName: "현장 메이드" },
    ].entries()
  ) {
    const clients = {
      admin: {
        from: () => queryResult(null),
        rpc: (name: string, parameters: Record<string, string>) => {
          if (name === "replay_account_command") {
            assert(
              /^[0-9a-f]{64}$/.test(parameters.p_request_hash),
              "account replay requires a canonical request hash",
            );
            return Promise.resolve({ data: null, error: null });
          }
          assertEquals(name, "create_account_profile", "account create RPC");
          assert(
            /^[0-9a-f]{64}$/.test(parameters.p_request_hash),
            "account create requires a canonical request hash",
          );
          return Promise.resolve({
            data: {
              ...profile,
              id: parameters.p_profile_id,
              auth_user_id: parameters.p_auth_user_id,
              display_name: parameters.p_display_name,
              display_name_normalized: parameters.p_display_name_normalized,
              login_id: parameters.p_display_name,
              login_id_normalized: parameters.p_display_name_normalized,
              role: parameters.p_role,
              phone_last_four: parameters.p_phone_last_four,
              phone_lookup_hash: parameters.p_phone_lookup_hash,
            },
            error: null,
          });
        },
        auth: {
          admin: {
            createUser: (attributes: { id: string }) =>
              Promise.resolve({
                data: { user: { id: attributes.id } },
                error: null,
              }),
            deleteUser: () => Promise.resolve({ data: null, error: null }),
          },
        },
      },
    } as unknown as EdgeClients;

    const result = await createAccount(
      request(
        {
          displayName: entry.displayName,
          role: entry.role,
          phone: "01012345678",
        },
        `edge-create-${index}-0001`,
      ),
      clients,
      entry.actor,
    );

    assertEquals(result.account.role, entry.role, "created account role");
    assertEquals(
      result.temporaryPassword,
      "5678",
      "temporary password contract",
    );
  }
});

Deno.test("Edge password validation matches the Fastify printable-ASCII contract", async () => {
  const error = await captureEdgeError(() =>
    changePassword(
      request({ currentPassword: "123456", newPassword: "Abcdef1!한글" }),
      {} as EdgeClients,
      developer,
    )
  );

  assertEquals(
    error.code,
    "VALIDATION_ERROR",
    "non-ASCII strong password denial",
  );
});

Deno.test("Edge password change serializes Auth mutation through a nonsecret receipt", async () => {
  const rpcCalls: Array<{ name: string; parameters: Record<string, string> }> =
    [];
  const states = [
    { state: "absent" },
    { state: "execute", effectMarker: passwordEffectMarker },
  ];
  let updateCount = 0;
  let authUpdate: unknown = null;
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: ({ password }: { password: string }) =>
          Promise.resolve(
            password === "123456"
              ? {
                data: { session: { access_token: "verification-token" } },
                error: null,
              }
              : { data: { session: null }, error: { message: "invalid" } },
          ),
      },
    },
    admin: {
      rpc: (name: string, parameters: Record<string, string>) => {
        rpcCalls.push({ name, parameters });
        if (name === "consume_password_verification_rate_limit") {
          return Promise.resolve(allowedPasswordVerification);
        }
        if (name === "complete_password_change") {
          return Promise.resolve({ data: { completed: true }, error: null });
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({ data: states.shift(), error: null });
      },
      auth: {
        admin: {
          updateUserById: (_id: string, attributes: unknown) => {
            updateCount += 1;
            authUpdate = attributes;
            return Promise.resolve({ data: null, error: null });
          },
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;

  await changePassword(
    passwordRequest({ currentPassword: "123456", newPassword: "654321" }),
    clients,
    developer,
  );

  assertEquals(updateCount, 1, "Auth mutates exactly once");
  assert(
    JSON.stringify(authUpdate).includes(
      `"profile_id":"${developer.profileId}"`,
    ) &&
      JSON.stringify(authUpdate).includes('"role":"developer"') &&
      !JSON.stringify(authUpdate).includes(passwordEffectMarker),
    "password mutation preserves identity metadata without exposing the private version",
  );
  assertEquals(
    rpcCalls.map((call) => call.name).filter((name) =>
      name !== "consume_password_verification_rate_limit"
    ),
    [
      "inspect_password_change",
      "prepare_password_change",
      "get_auth_password_version",
      "complete_password_change",
    ],
    "receipt lifecycle order",
  );
  const persistedArguments = JSON.stringify(rpcCalls);
  assert(
    !persistedArguments.includes("123456"),
    "current password is never sent to DB",
  );
  assert(
    !persistedArguments.includes("654321"),
    "new password is never sent to DB",
  );
  assert(
    /^[0-9a-f]{64}$/.test(
      rpcCalls.find((call) => call.name === "prepare_password_change")
        ?.parameters.p_request_hash ?? "",
    ),
    "safe request fingerprint",
  );
  assert(
    /^[0-9a-f]{64}$/.test(
      rpcCalls.find((call) => call.name === "prepare_password_change")
        ?.parameters.p_claim_digest ?? "",
    ),
    "nonsecret random claim digest",
  );
});

Deno.test("Edge completed password receipt replays 204 semantics without Auth mutation", async () => {
  let updateCount = 0;
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: ({ password }: { password: string }) =>
          Promise.resolve(
            password === "654321"
              ? {
                data: { session: { access_token: "verification-token" } },
                error: null,
              }
              : { data: { session: null }, error: { message: "invalid" } },
          ),
      },
    },
    admin: {
      rpc: (name: string) => {
        if (name === "consume_password_verification_rate_limit") {
          return Promise.resolve(allowedPasswordVerification);
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({
          data: {
            state: "completed",
            effectMarker: passwordEffectMarker,
          },
          error: null,
        });
      },
      auth: {
        admin: {
          updateUserById: () => {
            updateCount += 1;
            return Promise.resolve({ data: null, error: null });
          },
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;

  await changePassword(
    passwordRequest(
      { currentPassword: "123456", newPassword: "654321" },
      "edge-password-replay-0002",
    ),
    clients,
    developer,
  );
  assertEquals(updateCount, 0, "completed replay does not mutate Auth");
});

Deno.test("Edge completed replay fails closed if the password version rotates during proof", async () => {
  const versions = [passwordEffectMarker, "f".repeat(64)];
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: () =>
          Promise.resolve({
            data: { session: { access_token: "verification-token" } },
            error: null,
          }),
      },
    },
    admin: {
      rpc: (name: string) => {
        if (name === "consume_password_verification_rate_limit") {
          return Promise.resolve(allowedPasswordVerification);
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: versions.shift(), error: null });
        }
        return Promise.resolve({
          data: {
            state: "completed",
            effectMarker: passwordEffectMarker,
          },
          error: null,
        });
      },
      auth: {
        admin: {
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changePassword(
      passwordRequest(
        { currentPassword: "123456", newPassword: "654321" },
        "edge-password-concurrent-version-0013",
      ),
      clients,
      developer,
    )
  );
  assertEquals(error.status, 409, "concurrent password update conflict status");
  assertEquals(
    error.code,
    "IDEMPOTENCY_KEY_REUSED",
    "concurrent password update conflict code",
  );
});

Deno.test("Edge completed key with a different current Auth password fails closed", async () => {
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: () =>
          Promise.resolve({
            data: { session: null },
            error: { message: "invalid" },
          }),
      },
    },
    admin: {
      rpc: (name: string) => {
        if (name === "consume_password_verification_rate_limit") {
          return Promise.resolve(allowedPasswordVerification);
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({
          data: {
            state: "completed",
            effectMarker: passwordEffectMarker,
          },
          error: null,
        });
      },
      auth: {
        admin: {
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;
  const error = await captureEdgeError(() =>
    changePassword(
      passwordRequest(
        { currentPassword: "123456", newPassword: "654321" },
        "edge-password-conflict-0003",
      ),
      clients,
      developer,
    )
  );
  assertEquals(error.status, 409, "conflict status");
  assertEquals(error.code, "IDEMPOTENCY_KEY_REUSED", "conflict code");
});

Deno.test("Edge expired password receipt recovers an Auth-success DB-failure window", async () => {
  const rpcNames: string[] = [];
  const states = [
    { state: "recover", effectMarker: passwordEffectMarker },
    { state: "recover", effectMarker: passwordEffectMarker },
  ];
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: ({ password }: { password: string }) =>
          Promise.resolve(
            password === "654321"
              ? {
                data: { session: { access_token: "verification-token" } },
                error: null,
              }
              : { data: { session: null }, error: { message: "invalid" } },
          ),
      },
    },
    admin: {
      rpc: (name: string) => {
        rpcNames.push(name);
        if (name === "consume_password_verification_rate_limit") {
          return Promise.resolve(allowedPasswordVerification);
        }
        if (name === "complete_password_change") {
          return Promise.resolve({ data: { completed: true }, error: null });
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({ data: states.shift(), error: null });
      },
      auth: {
        admin: {
          updateUserById: () => {
            throw new Error("recovery must not mutate Auth again");
          },
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;
  await changePassword(
    passwordRequest(
      { currentPassword: "123456", newPassword: "654321" },
      "edge-password-recover-0004",
    ),
    clients,
    developer,
  );
  assertEquals(
    rpcNames.filter((name) =>
      name !== "consume_password_verification_rate_limit"
    ),
    [
      "inspect_password_change",
      "prepare_password_change",
      "get_auth_password_version",
      "get_auth_password_version",
      "complete_password_change",
    ],
    "recovery finishes the durable DB state",
  );
});

Deno.test("Edge crash-before-Auth ambiguity is persisted as inconsistent without a second Auth mutation", async () => {
  const rpcNames: string[] = [];
  const states = [
    { state: "recover", effectMarker: passwordEffectMarker },
    { state: "recover", effectMarker: passwordEffectMarker },
  ];
  let updateCount = 0;
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: () =>
          Promise.resolve({
            data: { session: null },
            error: { message: "invalid" },
          }),
      },
    },
    admin: {
      rpc: (name: string) => {
        rpcNames.push(name);
        if (name === "consume_password_verification_rate_limit") {
          return Promise.resolve(allowedPasswordVerification);
        }
        if (name === "finish_password_change_failure") {
          return Promise.resolve({ data: null, error: null });
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({ data: states.shift(), error: null });
      },
      auth: {
        admin: {
          updateUserById: () => {
            updateCount += 1;
            return Promise.resolve({ data: null, error: null });
          },
          signOut: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changePassword(
      passwordRequest(
        { currentPassword: "123456", newPassword: "654321" },
        "edge-password-crash-before-auth-0005",
      ),
      clients,
      developer,
    )
  );

  assertEquals(
    error.code,
    "PASSWORD_STATE_INCONSISTENT",
    "strict recovery result",
  );
  assertEquals(
    updateCount,
    0,
    "recovery never performs a second Auth mutation",
  );
  assertEquals(
    rpcNames.filter((name) =>
      name !== "consume_password_verification_rate_limit"
    ),
    [
      "inspect_password_change",
      "prepare_password_change",
      "get_auth_password_version",
      "finish_password_change_failure",
    ],
    "ambiguous recovery persists an explicit inconsistent terminal state",
  );
});

Deno.test("Edge cross-session receipt takeover maps to the stable conflict", async () => {
  const clients = {
    admin: {
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: "PASSWORD_CHANGE_SESSION_MISMATCH" },
        }),
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changePassword(
      passwordRequest(
        { currentPassword: "123456", newPassword: "654321" },
        "edge-password-session-mismatch-0006",
      ),
      clients,
      developer,
    )
  );

  assertEquals(error.status, 409, "session mismatch status");
  assertEquals(
    error.code,
    "PASSWORD_CHANGE_SESSION_MISMATCH",
    "session mismatch code",
  );
});

Deno.test("Edge password verification limiter blocks Auth probes before sign-in", async () => {
  let signInCount = 0;
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: () => {
          signInCount += 1;
          return Promise.resolve({ data: { session: null }, error: null });
        },
      },
    },
    admin: {
      rpc: (name: string) =>
        Promise.resolve(
          name === "consume_password_verification_rate_limit"
            ? {
              data: [{ allowed: false, retry_after_seconds: 60 }],
              error: null,
            }
            : { data: { state: "absent" }, error: null },
        ),
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changePassword(
      passwordRequest(
        { currentPassword: "999999", newPassword: "654321" },
        "edge-password-limited-0007",
      ),
      clients,
      developer,
    )
  );
  assertEquals(error.status, 429, "verification limiter status");
  assertEquals(
    error.code,
    "PASSWORD_VERIFICATION_RATE_LIMITED",
    "verification limiter code",
  );
  assertEquals(signInCount, 0, "rate limit blocks before Auth password probe");
});

Deno.test("Edge completed replay requires the original password effect version", async () => {
  let signInCount = 0;
  const clients = {
    publicClient: {
      auth: {
        signInWithPassword: () => {
          signInCount += 1;
          return Promise.resolve({ data: { session: null }, error: null });
        },
      },
    },
    admin: {
      rpc: (name: string) =>
        Promise.resolve(
          name === "get_auth_password_version"
            ? { data: "f".repeat(64), error: null }
            : {
              data: { state: "completed", effectMarker: passwordEffectMarker },
              error: null,
            },
        ),
      auth: {
        admin: {},
      },
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changePassword(
      passwordRequest(
        { currentPassword: "654321", newPassword: "777777" },
        "edge-password-old-effect-0008",
      ),
      clients,
      developer,
    )
  );
  assertEquals(error.status, 409, "old password version conflict status");
  assertEquals(error.code, "IDEMPOTENCY_KEY_REUSED", "old marker conflict");
  assertEquals(signInCount, 0, "marker mismatch blocks before password probe");
});

Deno.test("Edge admin reset finalizes self-change recovery only after password version success", async () => {
  const rpcNames: string[] = [];
  const clients = {
    admin: {
      from: () => queryResult(profile),
      rpc: (name: string) => {
        rpcNames.push(name);
        if (name === "prepare_account_password_reset") {
          return Promise.resolve({ data: profile, error: null });
        }
        if (name === "prepare_password_change_admin_reset") {
          return Promise.resolve({
            data: { state: "prepared", effectMarker: passwordEffectMarker },
            error: null,
          });
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({ data: { completed: true }, error: null });
      },
      auth: {
        admin: {
          updateUserById: () => Promise.resolve({ data: null, error: null }),
        },
      },
    },
  } as unknown as EdgeClients;

  await resetAccountPassword(
    request({}, "edge-reset-recovery-0009"),
    clients,
    developer,
    profile.id,
  );
  assertEquals(
    rpcNames,
    [
      "prepare_account_password_reset",
      "prepare_password_change_admin_reset",
      "get_auth_password_version",
      "finalize_password_change_admin_reset",
    ],
    "reset recovery finalizes only after Auth verification",
  );
});

Deno.test("Edge completed admin reset replay is a no-op only while its marker is current", async () => {
  const rpcNames: string[] = [];
  let updateCount = 0;
  const clients = {
    admin: {
      from: () => queryResult(profile),
      rpc: (name: string) => {
        rpcNames.push(name);
        if (name === "prepare_account_password_reset") {
          return Promise.resolve({ data: profile, error: null });
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: passwordEffectMarker, error: null });
        }
        return Promise.resolve({
          data: { state: "completed", effectMarker: passwordEffectMarker },
          error: null,
        });
      },
      auth: {
        admin: {
          updateUserById: () => {
            updateCount += 1;
            return Promise.resolve({ data: null, error: null });
          },
        },
      },
    },
  } as unknown as EdgeClients;

  await resetAccountPassword(
    request({}, "edge-reset-completed-replay-0011"),
    clients,
    developer,
    profile.id,
  );
  assertEquals(updateCount, 0, "completed replay never mutates Auth again");
  assertEquals(
    rpcNames,
    [
      "prepare_account_password_reset",
      "prepare_password_change_admin_reset",
      "get_auth_password_version",
    ],
    "completed replay does not finalize again",
  );
});

Deno.test("Edge completed admin reset key is stale after a later password effect", async () => {
  let updateCount = 0;
  const clients = {
    admin: {
      from: () => queryResult(profile),
      rpc: (name: string) => {
        if (name === "prepare_account_password_reset") {
          return Promise.resolve({ data: profile, error: null });
        }
        if (name === "get_auth_password_version") {
          return Promise.resolve({ data: "f".repeat(64), error: null });
        }
        return Promise.resolve({
          data: { state: "completed", effectMarker: passwordEffectMarker },
          error: null,
        });
      },
      auth: {
        admin: {
          updateUserById: () => {
            updateCount += 1;
            return Promise.resolve({ data: null, error: null });
          },
        },
      },
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    resetAccountPassword(
      request({}, "edge-reset-completed-stale-0012"),
      clients,
      developer,
      profile.id,
    )
  );
  assertEquals(error.status, 409, "stale reset replay status");
  assertEquals(error.code, "IDEMPOTENCY_KEY_REUSED", "stale reset replay code");
  assertEquals(updateCount, 0, "stale reset replay never mutates Auth");
});

Deno.test("Edge admin reset Auth failure never finalizes recovery", async () => {
  const rpcNames: string[] = [];
  const clients = {
    admin: {
      from: () => queryResult(profile),
      rpc: (name: string) => {
        rpcNames.push(name);
        if (name === "prepare_account_password_reset") {
          return Promise.resolve({ data: profile, error: null });
        }
        return Promise.resolve({
          data: { state: "prepared", effectMarker: passwordEffectMarker },
          error: null,
        });
      },
      auth: {
        admin: {
          updateUserById: () =>
            Promise.resolve({ data: null, error: { message: "unavailable" } }),
        },
      },
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    resetAccountPassword(
      request({}, "edge-reset-auth-failure-0010"),
      clients,
      developer,
      profile.id,
    )
  );
  assertEquals(error.code, "AUTH_PASSWORD_RESET_FAILED", "Auth reset failure");
  assert(
    !rpcNames.includes("finalize_password_change_admin_reset"),
    "failed Auth reset leaves recovery unresolved",
  );
});

Deno.test("developer account cannot be promoted or demoted", async () => {
  const developerProfile = {
    ...profile,
    id: developer.profileId,
    auth_user_id: developer.authUserId,
    login_id: "admin",
    login_id_normalized: "admin",
    role: "developer",
    must_change_password: false,
  };
  const clients = {
    admin: {
      from: () => queryResult(developerProfile),
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changeAccountRole(
      request({ role: "admin" }),
      clients,
      developer,
      developer.profileId,
    )
  );

  assertEquals(
    error.code,
    "DEVELOPER_ACCOUNT_PROTECTED",
    "developer target denial",
  );
});

Deno.test("failed Auth role rollback reports an explicit inconsistent state", async () => {
  let updateCount = 0;
  const clients = {
    admin: {
      from: () => queryResult(profile),
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: "LAST_ACTIVE_ADMIN_REQUIRED" },
        }),
      auth: {
        admin: {
          getUserById: () =>
            Promise.resolve({
              data: { user: { app_metadata: {} } },
              error: null,
            }),
          updateUserById: () => {
            updateCount += 1;
            return Promise.resolve({
              data: null,
              error: updateCount === 1
                ? null
                : { message: "rollback unavailable" },
            });
          },
        },
      },
    },
  } as unknown as EdgeClients;

  const error = await captureEdgeError(() =>
    changeAccountRole(
      request({ role: "maid" }),
      clients,
      developer,
      profile.id,
    )
  );

  assertEquals(
    error.code,
    "ACCOUNT_AUTH_STATE_INCONSISTENT",
    "rollback failure code",
  );
  assertEquals(updateCount, 2, "Auth update and rollback attempts");
});

Deno.test("in-progress account status fails before Auth, role preserves existing metadata compensation", async () => {
  const updates: unknown[] = [];
  const clients = {
    admin: {
      from: () => queryResult({ ...profile, role: "maid" }),
      rpc: () =>
        Promise.resolve({
          data: null,
          error: { message: "ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED" },
        }),
      auth: {
        admin: {
          updateUserById: (_id: string, change: unknown) => {
            updates.push(change);
            return Promise.resolve({ data: null, error: null });
          },
        },
      },
    },
  } as unknown as EdgeClients;
  const status = await captureEdgeError(() =>
    changeAccountStatus(
      request({ status: "inactive", reasonCode: "ADMIN_REQUEST" }),
      clients,
      developer,
      profile.id,
    )
  );
  assert(
    status.status === 409 &&
      status.code === "ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED",
    "stable execution lifecycle guard",
  );
  assertEquals(updates.length, 0, "DB rejection must not ban Auth");
  const role = await captureEdgeError(() =>
    changeAccountRole(
      request({ role: "admin" }),
      clients,
      developer,
      profile.id,
    )
  );
  assertEquals(
    role.code,
    "ACCOUNT_EXECUTION_LIFECYCLE_REQUIRED",
    "role transition guard",
  );
  assertEquals(
    updates.length,
    2,
    "existing role metadata update plus compensation retained",
  );
  assert(
    JSON.stringify(updates[1]).includes('"role":"maid"'),
    "metadata compensated to existing maid",
  );
});
