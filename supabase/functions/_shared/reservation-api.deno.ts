import {
  cancelManualCleaningRequest,
  cancelReservation,
  changeReservation,
  cleaningTargetIdFromPath,
  createManualCleaningRequest,
  createReservation,
  getReservation,
  listReservations,
  manualCheckoutReservation,
  processReservationTransitions,
  reservationDatabaseError,
  reservationIdFromPath,
  type ReservationRow,
  toManualCleaningRequest,
  toReservation,
} from "./reservation-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { authenticate, EdgeError } from "./runtime.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function captureEdgeError(
  run: () => Promise<unknown>,
): Promise<EdgeError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof EdgeError) return error;
    throw error;
  }
  throw new Error("Expected EdgeError");
}

const admin: EdgeActor = {
  authUserId: "10000000-0000-4000-8000-000000000001",
  profileId: "20000000-0000-4000-8000-000000000001",
  displayName: "운영 관리자",
  role: "admin",
  mustChangePassword: false,
};

const developer: EdgeActor = {
  ...admin,
  profileId: "20000000-0000-4000-8000-000000000002",
  displayName: "developer",
  role: "developer",
};

const maid: EdgeActor = {
  ...admin,
  profileId: "20000000-0000-4000-8000-000000000003",
  displayName: "메이드",
  role: "maid",
};

const reservationRow: ReservationRow = {
  id: "40000000-0000-4000-8000-000000000001",
  room_id: "50000000-0000-4000-8000-000000000001",
  check_in_at: "2026-09-01T16:00:00+09:00",
  check_out_at: "2026-09-02T11:00:00+09:00",
  guest_count: 2,
  guest_name_encrypted: null,
  status: "active",
  preparation_obligation_id: "60000000-0000-4000-8000-000000000001",
  checkout_obligation_id: "70000000-0000-4000-8000-000000000001",
  version: 1,
  actual_check_in_at: null,
  actual_checkout_at: null,
  cancelled_at: null,
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-01T00:00:00Z",
  room_state_version: 2,
};

const cleaningRow = {
  id: "80000000-0000-4000-8000-000000000001",
  room_id: reservationRow.room_id,
  reservation_id: reservationRow.id,
  cleaning_kind: "stayover" as const,
  status: "planned",
  service_date: "2026-09-01",
  available_from: "2026-09-01T08:00:00Z",
  due_at: "2026-09-01T09:00:00Z",
  version: 1,
};

function commandRequest(
  path: string,
  body: Record<string, unknown>,
  method = "POST",
  key = "reservation-test-0001",
): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
}

function configurePii(): void {
  const key = new Uint8Array(32);
  key.fill(7);
  let binary = "";
  for (const byte of key) binary += String.fromCharCode(byte);
  Deno.env.set("RESERVATION_PII_KEY_BASE64", btoa(binary));
  Deno.env.set("RESERVATION_PII_KEY_VERSION", "test-v1");
  Deno.env.set("RESERVATION_PII_KEYRING_JSON", "{}");
  Deno.env.set(
    "RESERVATION_GUEST_NAME_PEPPER",
    "reservation-guest-name-pepper-test-value",
  );
}

function jwtWithSession(sessionId: string): string {
  const encode = (value: Record<string, unknown>) =>
    btoa(JSON.stringify(value)).replace(/=/g, "").replace(/\+/g, "-")
      .replace(/\//g, "_");
  return `${encode({ alg: "none" })}.${encode({ session_id: sessionId })}.test`;
}

function authenticationClients(options: {
  status?: string;
  activeSession?: boolean;
  invalidUser?: boolean;
}) {
  const profile = {
    id: admin.profileId,
    auth_user_id: admin.authUserId,
    display_name: admin.displayName,
    role: admin.role,
    status: options.status ?? "active",
    must_change_password: false,
  };
  return {
    publicClient: {
      auth: {
        getUser: () =>
          Promise.resolve(
            options.invalidUser
              ? { data: { user: null }, error: { message: "invalid" } }
              : { data: { user: { id: admin.authUserId } }, error: null },
          ),
      },
    },
    admin: {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          single: () => Promise.resolve({ data: profile, error: null }),
        };
        return builder;
      },
      rpc: (name: string) =>
        Promise.resolve(
          name === "is_active_auth_session"
            ? { data: options.activeSession ?? true, error: null }
            : { data: [reservationRow], error: null },
        ),
    },
  } as unknown as EdgeClients;
}

Deno.test("reservation projections expose camelCase without guest ciphertext", () => {
  const reservation = toReservation({
    ...reservationRow,
    guest_name_encrypted: "ciphertext-must-not-leak",
  });
  const cleaningRequest = toManualCleaningRequest(cleaningRow);

  assert(reservation.roomId === reservationRow.room_id, "roomId mapping");
  assert(reservation.roomStateVersion === 2, "room CAS mapping");
  assert(!("room_id" in reservation), "snake_case must not leak");
  assert(
    !("guestName" in reservation),
    "list/command projection has no guestName",
  );
  assert(
    !JSON.stringify(reservation).includes("ciphertext-must-not-leak"),
    "ciphertext must not leak",
  );
  assert(cleaningRequest.serviceDate === "2026-09-01", "cleaning projection");
});

Deno.test("reservation role and password gates reject non-business actors", async () => {
  const request = new Request("http://localhost/v1/reservations");
  for (const actor of [developer, maid]) {
    const error = await captureEdgeError(() =>
      listReservations(request, {} as EdgeClients, actor)
    );
    assert(error.code === "ADMIN_REQUIRED", `${actor.role} must be denied`);
  }
  const temporary = await captureEdgeError(() =>
    listReservations(
      request,
      {} as EdgeClients,
      { ...admin, mustChangePassword: true },
    )
  );
  assert(
    temporary.code === "PASSWORD_CHANGE_REQUIRED",
    "temporary password must be denied",
  );
});

Deno.test("reservation authentication blocks inactive and revoked identities", async () => {
  const token = jwtWithSession("30000000-0000-4000-8000-000000000001");
  const request = new Request("http://localhost/v1/reservations", {
    headers: { authorization: `Bearer ${token}` },
  });

  const activeClients = authenticationClients({});
  const authenticated = await authenticate(request, activeClients);
  const reservations = await listReservations(
    request,
    activeClients,
    authenticated,
  );
  assert(authenticated.role === "admin", "active admin authenticates");
  assert(reservations.length === 1, "active admin reaches reservation read");

  for (const status of ["inactive", "upload_only", "deactivation_pending"]) {
    const error = await captureEdgeError(() =>
      authenticate(request, authenticationClients({ status }))
    );
    assert(error.code === "ACCOUNT_INACTIVE", `${status} must be blocked`);
  }

  const revoked = await captureEdgeError(() =>
    authenticate(request, authenticationClients({ activeSession: false }))
  );
  assert(revoked.code === "SESSION_REVOKED", "revoked session must be blocked");

  const invalid = await captureEdgeError(() =>
    authenticate(request, authenticationClients({ invalidUser: true }))
  );
  assert(
    invalid.code === "INVALID_ACCESS_TOKEN",
    "invalid JWT must be blocked",
  );
});

Deno.test("reservation list never returns guest names and supports the room filter", async () => {
  let rpcArguments: Record<string, unknown> = {};
  const clients = {
    admin: {
      async rpc(_name: string, argumentsValue: Record<string, unknown>) {
        rpcArguments = argumentsValue;
        return {
          data: [{ ...reservationRow, guest_name_encrypted: "opaque-value" }],
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  const result = await listReservations(
    new Request(
      `http://localhost/v1/reservations?roomId=${reservationRow.room_id}`,
    ),
    clients,
    admin,
  );

  assert(result.length === 1, "one reservation");
  assert(!("guestName" in result[0]), "guest name is detail-only");
  assert(
    rpcArguments.p_actor_profile_id === admin.profileId,
    "actor must reach the DB command",
  );
  assert(rpcArguments.p_room_id === reservationRow.room_id, "room filter");
});

Deno.test("guest-name create is randomized but keeps a stable request fingerprint", async () => {
  configurePii();
  const calls: Array<Record<string, unknown>> = [];
  const clients = {
    admin: {
      async rpc(_name: string, argumentsValue: Record<string, unknown>) {
        calls.push(argumentsValue);
        return { data: reservationRow, error: null };
      },
    },
  } as unknown as EdgeClients;
  const body = {
    roomId: reservationRow.room_id,
    checkInAt: reservationRow.check_in_at,
    checkOutAt: reservationRow.check_out_at,
    guestCount: 2,
    guestName: "홍길동",
    expectedRoomVersion: 1,
  };

  await Promise.all([
    createReservation(
      commandRequest("/v1/reservations", body, "POST", "same-create-key"),
      clients,
      admin,
    ),
    createReservation(
      commandRequest("/v1/reservations", body, "POST", "same-create-key"),
      clients,
      admin,
    ),
  ]);

  assert(calls.length === 2, "two concurrent invocations");
  assert(
    calls[0].p_request_hash === calls[1].p_request_hash,
    "same payload must keep its canonical hash",
  );
  assert(
    calls[0].p_guest_name_encrypted !== calls[1].p_guest_name_encrypted,
    "AES-GCM IV must be randomized",
  );
  assert(
    !JSON.stringify(calls).includes("홍길동"),
    "plaintext must not enter RPC/audit parameters",
  );
});

Deno.test("detail records sensitive activity only when a decrypted name is returned", async () => {
  configurePii();
  let encrypted = "";
  const createClients = {
    admin: {
      async rpc(_name: string, argumentsValue: Record<string, unknown>) {
        encrypted = String(argumentsValue.p_guest_name_encrypted);
        return { data: reservationRow, error: null };
      },
    },
  } as unknown as EdgeClients;
  await createReservation(
    commandRequest("/v1/reservations", {
      roomId: reservationRow.room_id,
      checkInAt: reservationRow.check_in_at,
      checkOutAt: reservationRow.check_out_at,
      guestCount: 2,
      guestName: "홍길동",
      expectedRoomVersion: 1,
    }),
    createClients,
    admin,
  );

  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, argumentsValue: Record<string, unknown>) {
        calls.push([name, argumentsValue]);
        if (name === "get_reservation_detail") {
          return {
            data: [{ ...reservationRow, guest_name_encrypted: encrypted }],
            error: null,
          };
        }
        return { data: null, error: null };
      },
    },
  } as unknown as EdgeClients;

  const detail = await getReservation(clients, admin, reservationRow.id);
  assert(detail.guestName === "홍길동", "detail decrypts the guest name");
  assert(calls[1][0] === "record_actor_activity_event", "activity RPC");
  assert(calls[1][1].p_event_type === "sensitive.read", "sensitive event");
  assert(
    calls[1][1].p_resource_id === reservationRow.id,
    "resource is the reservation UUID",
  );
  assert(
    !JSON.stringify(calls[1]).includes("홍길동") &&
      !JSON.stringify(calls[1]).includes(encrypted),
    "activity must contain neither plaintext nor ciphertext",
  );
});

Deno.test("sensitive detail fails closed when activity recording fails", async () => {
  configurePii();
  let encrypted = "";
  const clients = {
    admin: {
      async rpc(name: string, argumentsValue: Record<string, unknown>) {
        if (name === "create_reservation") {
          encrypted = String(argumentsValue.p_guest_name_encrypted);
          return { data: reservationRow, error: null };
        }
        if (name === "get_reservation_detail") {
          return {
            data: [{ ...reservationRow, guest_name_encrypted: encrypted }],
            error: null,
          };
        }
        return { data: null, error: { message: "activity unavailable" } };
      },
    },
  } as unknown as EdgeClients;
  await createReservation(
    commandRequest("/v1/reservations", {
      roomId: reservationRow.room_id,
      checkInAt: reservationRow.check_in_at,
      checkOutAt: reservationRow.check_out_at,
      guestCount: 2,
      guestName: "홍길동",
      expectedRoomVersion: 1,
    }),
    clients,
    admin,
  );
  const error = await captureEdgeError(() =>
    getReservation(clients, admin, reservationRow.id)
  );
  assert(error.code === "ACTIVITY_LOG_UNAVAILABLE", "fail closed");
});

Deno.test("reservation mutations preserve RPC, actor, CAS and idempotency", async () => {
  configurePii();
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, argumentsValue: Record<string, unknown>) {
        calls.push([name, argumentsValue]);
        if (name.includes("cleaning")) {
          return { data: cleaningRow, error: null };
        }
        if (name === "process_due_reservation_transitions") {
          return {
            data: {
              as_of: "2026-09-01T00:00:00Z",
              checked_in_count: 1,
              checked_out_count: 1,
              blocked_check_in_count: 0,
              purged_guest_name_count: 0,
            },
            error: null,
          };
        }
        return { data: reservationRow, error: null };
      },
    },
  } as unknown as EdgeClients;

  await changeReservation(
    commandRequest(`/v1/reservations/${reservationRow.id}`, {
      roomId: reservationRow.room_id,
      checkInAt: reservationRow.check_in_at,
      checkOutAt: reservationRow.check_out_at,
      guestCount: 2,
      expectedVersion: 1,
      reasonCode: "SCHEDULE_CHANGED",
    }, "PATCH"),
    clients,
    admin,
    reservationRow.id,
  );
  await cancelReservation(
    commandRequest(`/v1/reservations/${reservationRow.id}/cancel`, {
      expectedVersion: 1,
      reasonCode: "GUEST_CANCELLED",
    }),
    clients,
    admin,
    reservationRow.id,
  );
  await manualCheckoutReservation(
    commandRequest(`/v1/reservations/${reservationRow.id}/manual-checkout`, {
      expectedVersion: 1,
      reasonCode: "EARLY_DEPARTURE",
    }),
    clients,
    admin,
    reservationRow.id,
  );
  await createManualCleaningRequest(
    commandRequest("/v1/reservations/cleaning-requests", {
      roomId: reservationRow.room_id,
      reservationId: reservationRow.id,
      cleaningKind: "stayover",
      serviceDate: "2026-09-01",
      availableFrom: "2026-09-01T08:00:00Z",
      dueAt: "2026-09-01T09:00:00Z",
      expectedRoomVersion: 1,
      reasonCode: "ADMIN_REQUEST",
    }),
    clients,
    admin,
  );
  await cancelManualCleaningRequest(
    commandRequest(
      `/v1/reservations/cleaning-requests/${cleaningRow.id}/cancel`,
      { expectedVersion: 1, reasonCode: "REQUEST_WITHDRAWN" },
    ),
    clients,
    admin,
    cleaningRow.id,
  );
  await processReservationTransitions(
    commandRequest("/v1/reservations/transitions/process", {}),
    clients,
    admin,
  );

  assert(
    calls.map(([name]) => name).join(",") === [
      "change_reservation",
      "cancel_reservation",
      "manual_checkout_reservation",
      "create_manual_cleaning_request",
      "cancel_manual_cleaning_request",
      "process_due_reservation_transitions",
    ].join(","),
    "exact existing RPC set",
  );
  for (const [, argumentsValue] of calls) {
    assert(
      argumentsValue.p_actor_profile_id === admin.profileId,
      "DB actor revalidation",
    );
    assert(
      typeof argumentsValue.p_request_hash === "string" &&
        /^[0-9a-f]{64}$/.test(argumentsValue.p_request_hash as string),
      "canonical request hash",
    );
  }
  assert(calls[0][1].p_expected_version === 1, "reservation CAS");
  assert(calls[3][1].p_expected_room_version === 1, "room CAS");
});

Deno.test("reservation database errors redact unknown details", () => {
  const stale = reservationDatabaseError({ message: "STALE_VERSION" });
  const overlap = reservationDatabaseError({
    code: "23P01",
    message: "detail",
  });
  const unknown = reservationDatabaseError({
    message: "private database detail",
  });

  assert(stale.status === 409 && stale.code === "STALE_VERSION", "stale CAS");
  assert(overlap.code === "RESERVATION_OVERLAP", "overlap constraint");
  assert(
    unknown.status === 500 && unknown.code === "RESERVATION_COMMAND_FAILED" &&
      !unknown.message.includes("private database detail"),
    "unknown DB errors are redacted",
  );
});

Deno.test("reservation path helpers require exact UUID routes", () => {
  assert(
    reservationIdFromPath(`/v1/reservations/${reservationRow.id}`) ===
      reservationRow.id,
    "detail route",
  );
  assert(
    reservationIdFromPath(
      `/v1/reservations/${reservationRow.id}/manual-checkout`,
      "manual-checkout",
    ) === reservationRow.id,
    "manual checkout route",
  );
  assert(
    cleaningTargetIdFromPath(
      `/v1/reservations/cleaning-requests/${cleaningRow.id}/cancel`,
    ) === cleaningRow.id,
    "cleaning cancel route",
  );
});
