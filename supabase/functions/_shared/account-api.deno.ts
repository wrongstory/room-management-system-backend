import {
  changeAccountRole,
  changePassword,
  createAccount,
  listAccounts,
  login,
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
): Request {
  return new Request("http://localhost", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": idempotency,
    },
    body: JSON.stringify(body),
  });
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
    wrongEvents.includes("rpc:record_login_failure"),
    "known account failure must increment the account lock counter",
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
