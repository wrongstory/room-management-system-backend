import {
  cancelManualCleaningRequest,
  cancelReservation,
  changeReservation,
  cleaningTargetIdFromPath,
  commitReservationRoomMove,
  createManualCleaningRequest,
  createReservation,
  getReservation,
  listReservations,
  manualCheckoutReservation,
  previewReservationBookability,
  previewReservationRoomMove,
  processReservationTransitions,
  reservationDatabaseError,
  reservationIdFromPath,
  reservationRoomMoveIdFromPath,
  type ReservationRow,
  toManualCleaningRequest,
  toReservation,
} from "./reservation-api.ts";
import type { EdgeActor, EdgeClients } from "./runtime.ts";
import { authenticate, EdgeError, errorResponse } from "./runtime.ts";

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
  reservation_type: "standard",
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
  assert(Array.isArray(reservations), "legacy read keeps array response");
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

  assert(Array.isArray(result), "legacy room filter keeps array response");
  assert(result.length === 1, "one reservation");
  assert(!("guestName" in result[0]), "guest name is detail-only");
  assert(
    rpcArguments.p_actor_profile_id === admin.profileId,
    "actor must reach the DB command",
  );
  assert(rpcArguments.p_room_id === reservationRow.room_id, "room filter");
});

Deno.test("reservation range list emits a scoped opaque cursor and rejects tampering", async () => {
  configurePii();
  const calls: Array<Record<string, unknown>> = [];
  const clients = {
    admin: {
      rpc(name: string, argumentsValue: Record<string, unknown>) {
        assert(
          name === "list_reservations_page",
          "range mode uses bounded page RPC",
        );
        calls.push(argumentsValue);
        return Promise.resolve({
          data: {
            server_time: "2026-09-01T00:00:00Z",
            reservations: [{
              ...reservationRow,
              guest_name_encrypted: "never-return",
            }],
            has_more: calls.length === 1,
          },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const range =
    `from=2026-09-01T00%3A00%3A00Z&to=2026-09-30T00%3A00%3A00Z&roomId=${reservationRow.room_id}`;
  const first = await listReservations(
    new Request(`http://localhost/v1/reservations?${range}`),
    clients,
    admin,
  );
  assert(!Array.isArray(first), "range mode returns page envelope");
  assert(
    first.reservations.length === 1 && first.nextCursor,
    "first page has cursor",
  );
  assert(
    !JSON.stringify(first).includes("never-return"),
    "range page excludes guest PII",
  );

  const second = await listReservations(
    new Request(
      `http://localhost/v1/reservations?${range}&cursor=${
        encodeURIComponent(first.nextCursor)
      }`,
    ),
    clients,
    admin,
  );
  assert(
    !Array.isArray(second) && second.nextCursor === null,
    "last page closes cursor",
  );
  assert(
    calls[1].p_after_check_in_at === reservationRow.check_in_at,
    "cursor binds keyset timestamp",
  );
  assert(calls[1].p_after_id === reservationRow.id, "cursor binds keyset id");

  const tampered = `${first.nextCursor.slice(0, -1)}${
    first.nextCursor.endsWith("A") ? "B" : "A"
  }`;
  const error = await captureEdgeError(() =>
    listReservations(
      new Request(
        `http://localhost/v1/reservations?${range}&cursor=${tampered}`,
      ),
      clients,
      admin,
    )
  );
  assert(
    error.code === "INVALID_RESERVATION_CURSOR",
    "tampered cursor is stable 400",
  );
  assert(calls.length === 2, "invalid cursor never reaches the database");
});

Deno.test("reservation bookability keeps PIN readiness separate and supports empty candidates", async () => {
  let empty = false;
  const rpcInputs: Array<Record<string, unknown>> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        assert(
          name === "preview_reservation_bookability",
          "preview uses exact RPC",
        );
        rpcInputs.push(args);
        return Promise.resolve({
          data: {
            evaluated_at: "2026-09-01T00:00:00Z",
            candidates: empty ? [] : [{
              room_id: reservationRow.room_id,
              room_number: "117",
              room_type_id: "51000000-0000-4000-8000-000000000001",
              room_state_version: 2,
              interval_bookable: true,
              check_in_ready: false,
              reason_codes: ["PIN_UNCONFIGURED"],
              evaluated_at: "2026-09-01T00:00:00Z",
            }],
          },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const body = {
    reservationType: "standard",
    checkInAt: "2026-10-01T16:00:00+09:00",
    checkOutAt: "2026-10-02T11:00:00+09:00",
    guestCount: 2,
    roomTypeIds: [],
    excludeReservationId: null,
  };
  const preview = await previewReservationBookability(
    commandRequest("/v1/reservations/bookability/preview", body),
    clients,
    admin,
  );
  assert(
    preview.candidates[0].intervalBookable,
    "PIN does not alter interval bookability",
  );
  assert(
    !preview.candidates[0].checkInReady,
    "PIN remains a readiness concern",
  );
  assert(
    preview.commitAuthority === "CREATE_OR_CHANGE_REVALIDATES",
    "commit is final authority",
  );

  const omittedGuestCount = await previewReservationBookability(
    commandRequest("/v1/reservations/bookability/preview", {
      reservationType: "standard",
      checkInAt: body.checkInAt,
      checkOutAt: body.checkOutAt,
    }),
    clients,
    admin,
  );
  assert(
    omittedGuestCount.guestCount === null &&
      rpcInputs.at(-1)?.p_guest_count === null,
    "omitted guestCount disables capacity filtering without a default",
  );

  const nullGuestCount = await previewReservationBookability(
    commandRequest("/v1/reservations/bookability/preview", {
      reservationType: "standard",
      checkInAt: body.checkInAt,
      checkOutAt: body.checkOutAt,
      guestCount: null,
    }),
    clients,
    admin,
  );
  assert(
    nullGuestCount.guestCount === null &&
      rpcInputs.at(-1)?.p_guest_count === null,
    "explicit null guestCount has the same canonical RPC input",
  );

  empty = true;
  const none = await previewReservationBookability(
    commandRequest("/v1/reservations/bookability/preview", {
      reservationType: "standard",
      checkInAt: body.checkInAt,
      checkOutAt: body.checkOutAt,
      guestCount: body.guestCount,
    }),
    clients,
    admin,
  );
  assert(
    none.candidates.length === 0,
    "zero matching rooms remains a successful preview",
  );
  assert(
    none.evaluatedAt === "2026-09-01T00:00:00Z",
    "empty result keeps evaluatedAt",
  );
  assert(
    rpcInputs.length === 4 &&
      rpcInputs.every((input) =>
        input.p_room_type_ids === null &&
        input.p_exclude_reservation_id === null &&
        input.p_reservation_type === "standard"
      ),
    "empty and omitted roomTypeIds normalize to the same all-types RPC input",
  );
});

Deno.test("open-ended long-stay requests keep null checkout across preview, create and change", async () => {
  const openEndedRow: ReservationRow = {
    ...reservationRow,
    reservation_type: "long_stay",
    check_out_at: null,
    checkout_obligation_id: null,
  };
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push([name, args]);
        if (name === "preview_reservation_bookability") {
          return Promise.resolve({
            data: {
              evaluated_at: "2026-09-01T00:00:00Z",
              candidates: [],
            },
            error: null,
          });
        }
        return Promise.resolve({ data: openEndedRow, error: null });
      },
    },
  } as unknown as EdgeClients;

  const preview = await previewReservationBookability(
    commandRequest("/v1/reservations/bookability/preview", {
      reservationType: "long_stay",
      checkInAt: openEndedRow.check_in_at,
      checkOutAt: null,
      guestCount: 2,
    }),
    clients,
    admin,
  );
  const created = await createReservation(
    commandRequest("/v1/reservations", {
      roomId: openEndedRow.room_id,
      reservationType: "long_stay",
      checkInAt: openEndedRow.check_in_at,
      checkOutAt: null,
      guestCount: 2,
      expectedRoomVersion: 1,
    }),
    clients,
    admin,
  );
  const changed = await changeReservation(
    commandRequest(`/v1/reservations/${openEndedRow.id}`, {
      roomId: openEndedRow.room_id,
      reservationType: "long_stay",
      checkInAt: openEndedRow.check_in_at,
      checkOutAt: null,
      guestCount: 2,
      expectedVersion: 1,
      reasonCode: "GUEST_COUNT_CHANGED",
    }, "PATCH"),
    clients,
    admin,
    openEndedRow.id,
  );

  assert(
    preview.reservationType === "long_stay" && preview.checkOutAt === null,
    "preview preserves open-ended identity",
  );
  assert(
    created.reservationType === "long_stay" && created.checkOutAt === null &&
      created.checkoutObligationId === null,
    "create projection preserves open-ended identity and absent checkout graph",
  );
  assert(
    changed.reservationType === "long_stay" && changed.checkOutAt === null,
    "change projection preserves open-ended identity",
  );
  assert(
    calls.map(([name]) => name).join(",") ===
        "preview_reservation_bookability,create_reservation_v2,change_reservation_v2" &&
      calls.every(([, args]) =>
        args.p_reservation_type === "long_stay" && args.p_check_out_at === null
      ),
    "all runtime paths pass the same type and null checkout to the database",
  );

  const invalid = await captureEdgeError(() =>
    createReservation(
      commandRequest("/v1/reservations", {
        roomId: openEndedRow.room_id,
        reservationType: "standard",
        checkInAt: openEndedRow.check_in_at,
        checkOutAt: null,
        guestCount: 2,
        expectedRoomVersion: 1,
      }),
      clients,
      admin,
    )
  );
  assert(invalid.status === 400, "standard null checkout fails before RPC");
  assert(
    calls.length === 3,
    "invalid standard request does not reach database",
  );
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
    reservationType: "standard",
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

Deno.test("guest-name validation enforces raw and normalized 80-character limits", async () => {
  configurePii();
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, argumentsValue: Record<string, unknown>) {
        calls.push([name, argumentsValue]);
        return { data: reservationRow, error: null };
      },
    },
  } as unknown as EdgeClients;
  const createBody = (guestName: unknown) => ({
    roomId: reservationRow.room_id,
    reservationType: "standard",
    checkInAt: reservationRow.check_in_at,
    checkOutAt: reservationRow.check_out_at,
    guestCount: 2,
    guestName,
    expectedRoomVersion: 1,
  });

  await createReservation(
    commandRequest(
      "/v1/reservations",
      createBody("가".repeat(80)),
      "POST",
      "guest-name-raw-80",
    ),
    clients,
    admin,
  );

  for (
    const invalidName of [
      "가".repeat(81),
      `${" ".repeat(80)}홍`,
      " ".repeat(80),
      "\uFB03".repeat(27),
    ]
  ) {
    const error = await captureEdgeError(() =>
      createReservation(
        commandRequest(
          "/v1/reservations",
          createBody(invalidName),
          "POST",
          `guest-name-invalid-${invalidName.length}`,
        ),
        clients,
        admin,
      )
    );
    assert(error.code === "INVALID_GUEST_NAME", "stable guest-name error");
  }

  await changeReservation(
    commandRequest(
      `/v1/reservations/${reservationRow.id}`,
      {
        roomId: reservationRow.room_id,
        reservationType: "standard",
        checkInAt: reservationRow.check_in_at,
        checkOutAt: reservationRow.check_out_at,
        guestCount: 2,
        guestName: "  김   영희  ",
        expectedVersion: 1,
        reasonCode: "GUEST_NAME_CORRECTED",
      },
      "PATCH",
      "guest-name-korean-change",
    ),
    clients,
    admin,
    reservationRow.id,
  );

  assert(calls.length === 2, "only valid create and change reach RPC");
  assert(calls[0][0] === "create_reservation_v2", "raw length 80 create");
  assert(calls[1][0] === "change_reservation_v2", "Korean name change");
  assert(
    !JSON.stringify(calls).includes("김   영희"),
    "normalized plaintext must not enter RPC parameters",
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
      reservationType: "standard",
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
        if (name === "create_reservation_v2") {
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
      reservationType: "standard",
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
      reservationType: "standard",
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
      "change_reservation_v2",
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

Deno.test("manual transitions reject the scheduler idempotency namespace", async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const clients = {
    admin: {
      async rpc(name: string, argumentsValue: Record<string, unknown>) {
        calls.push([name, argumentsValue]);
        return {
          data: {
            as_of: "2026-09-01T04:30:00Z",
            checked_in_count: 0,
            checked_out_count: 0,
            blocked_check_in_count: 0,
            purged_guest_name_count: 0,
          },
          error: null,
        };
      },
    },
  } as unknown as EdgeClients;
  const schedulerKey = "reservation-scheduler-202609010430";

  await clients.admin.rpc("process_due_reservation_transitions", {
    p_actor_profile_id: admin.profileId,
    p_as_of: "2026-09-01T04:30:00Z",
    p_idempotency_key: schedulerKey,
    p_request_hash: "a".repeat(64),
  });
  const reserved = await captureEdgeError(() =>
    processReservationTransitions(
      commandRequest(
        "/v1/reservations/transitions/process",
        {},
        "POST",
        schedulerKey,
      ),
      clients,
      admin,
    )
  );

  assert(reserved.status === 400, "reserved namespace is a bad manual request");
  assert(
    reserved.code === "RESERVED_IDEMPOTENCY_KEY",
    "stable reserved namespace error",
  );
  assert(
    [1].includes(calls.length),
    "manual rejection does not invoke the RPC",
  );
  assert(
    calls[0][1].p_actor_profile_id === admin.profileId,
    "scheduler and manual actor are identical in the regression",
  );

  await processReservationTransitions(
    commandRequest(
      "/v1/reservations/transitions/process",
      {},
      "POST",
      "manual-transition-retry-0001",
    ),
    clients,
    admin,
  );
  await processReservationTransitions(
    commandRequest(
      "/v1/reservations/transitions/process",
      {},
      "POST",
      "manual-transition-retry-0001",
    ),
    clients,
    admin,
  );
  assert(
    [3].includes(calls.length),
    "ordinary manual retries reach the DB receipt",
  );
  assert(
    calls[1][1].p_idempotency_key === "manual-transition-retry-0001" &&
      calls[2][1].p_idempotency_key === "manual-transition-retry-0001",
    "ordinary manual retry key is preserved",
  );
  assert(
    calls[1][1].p_request_hash === calls[2][1].p_request_hash,
    "ordinary manual retry keeps the same request hash",
  );
});

Deno.test("room move preview and commit preserve strict CAS, fingerprint and timestamps", async () => {
  const targetRoomId = "50000000-0000-4000-8000-000000000002";
  const evaluatedAt = "2026-09-01T00:00:00.000Z";
  const expiresAt = "2026-09-01T00:05:00.000Z";
  const impactFingerprint = "a".repeat(64);
  const calls: Array<[string, Record<string, unknown>]> = [];
  const preview = {
    mode: "BEFORE_CHECKIN",
    reservationType: "standard",
    eligible: true,
    rejectionReasonCodes: [],
    blockingReasonCodes: [],
    warnings: [],
    targetBlockReasonCodes: [],
    sourceOutcome: {
      occupancyStatus: "VACANT",
      readinessStatus: "READY",
      stateVersion: 2,
    },
    targetOutcome: {
      occupancyStatus: "VACANT",
      readinessStatus: "READY",
      stateVersion: 3,
    },
    impactFingerprint,
    evaluatedAt,
    expiresAt,
    effectiveAt: reservationRow.check_in_at,
    reservationId: reservationRow.id,
    reservationVersion: 1,
    stayId: "45000000-0000-4000-8000-000000000001",
    stayVersion: 1,
    sourceSegmentId: "46000000-0000-4000-8000-000000000001",
    sourceSegmentVersion: 1,
    sourceRoomId: reservationRow.room_id,
    sourceRoomVersion: 2,
    targetRoomId,
    targetRoomVersion: 3,
    checkInAt: reservationRow.check_in_at,
    checkOutAt: reservationRow.check_out_at,
    guestCount: reservationRow.guest_count,
    preparationObligationId: reservationRow.preparation_obligation_id,
    checkoutObligationId: reservationRow.checkout_obligation_id,
    checkoutObligationVersion: 1,
    plannedCheckoutTargetId: "50000000-0000-4000-8000-000000000003",
    plannedCheckoutTargetVersion: 1,
    guestName: "must-not-leak",
  };
  const clients = {
    admin: {
      async rpc(name: string, argumentsValue: Record<string, unknown>) {
        calls.push([name, argumentsValue]);
        return name === "preview_reservation_room_move"
          ? { data: preview, error: null }
          : {
            data: {
              reservation: { ...reservationRow, room_id: targetRoomId },
              mode: "BEFORE_CHECKIN",
              evaluatedAt,
              expiresAt,
              effectiveAt: reservationRow.check_in_at,
              movedAt: "2026-09-01T00:01:00.000Z",
              sourceRoomId: reservationRow.room_id,
              targetRoomId,
              sourceRoomVersion: 3,
              targetRoomVersion: 4,
              plannedCheckoutTargetId: preview.plannedCheckoutTargetId,
              plannedCheckoutTargetVersion: 2,
              sourceOutcome: { ...preview.sourceOutcome, stateVersion: 3 },
              targetOutcome: { ...preview.targetOutcome, stateVersion: 4 },
              pin: "must-not-leak",
            },
            error: null,
          };
      },
    },
  } as unknown as EdgeClients;
  const cas = {
    targetRoomId,
    expectedReservationVersion: 1,
    expectedSourceRoomVersion: 2,
    expectedTargetRoomVersion: 3,
    reasonCode: "GUEST_REQUEST",
  };

  const resultPreview = await previewReservationRoomMove(
    commandRequest(
      `/v1/reservations/${reservationRow.id}/room-change/preview`,
      cas,
    ),
    clients,
    admin,
    reservationRow.id,
  );
  const resultCommit = await commitReservationRoomMove(
    commandRequest(
      `/v1/reservations/${reservationRow.id}/room-change`,
      {
        ...cas,
        evaluatedAt,
        expiresAt,
        effectiveAt: reservationRow.check_in_at,
        impactFingerprint,
        reasonCode: "GUEST_REQUEST",
      },
      "POST",
      "reservation-room-move-0001",
    ),
    clients,
    admin,
    reservationRow.id,
  );

  assert(
    !("guestName" in resultPreview) && !("pin" in resultCommit),
    "room move projections allowlist fields and redact extras",
  );
  assert(
    resultPreview.preparationObligationId ===
      reservationRow.preparation_obligation_id,
    "the real RPC preview shape includes the required preparation obligation identity",
  );
  assert(
    (resultCommit.reservation as { roomId: string }).roomId === targetRoomId,
    "nested reservation is redacted and mapped",
  );
  assert(calls[0][0] === "preview_reservation_room_move", "preview RPC");
  assert(calls[1][0] === "commit_reservation_room_move", "commit RPC");
  assert(
    calls[1][1].p_preview_evaluated_at === evaluatedAt &&
      calls[1][1].p_preview_expires_at === expiresAt &&
      calls[1][1].p_effective_at === reservationRow.check_in_at,
    "authoritative timestamps are echoed",
  );
  assert(
    typeof calls[1][1].p_request_hash === "string" &&
      /^[0-9a-f]{64}$/.test(calls[1][1].p_request_hash as string),
    "commit has a canonical request hash",
  );

  const invalidReason = await captureEdgeError(() =>
    commitReservationRoomMove(
      commandRequest(
        `/v1/reservations/${reservationRow.id}/room-change`,
        {
          ...cas,
          evaluatedAt,
          expiresAt,
          effectiveAt: reservationRow.check_in_at,
          impactFingerprint,
          reasonCode: "ARBITRARY_TEXT",
        },
      ),
      clients,
      admin,
      reservationRow.id,
    )
  );
  assert(invalidReason.code === "VALIDATION_ERROR", "reason allowlist");
  assert(calls.length === 2, "invalid requests do not reach the database");

  for (
    const invalidTimestamp of [
      "2026-02-29T00:00:00Z",
      "2026-04-31T00:00:00Z",
      "2026-09-01T00:00Z",
      "2026-09-01T00:00:00",
      "2026-09-01T00:00:00+24:00",
    ]
  ) {
    const invalidTime = await captureEdgeError(() =>
      commitReservationRoomMove(
        commandRequest(
          `/v1/reservations/${reservationRow.id}/room-change`,
          {
            ...cas,
            evaluatedAt: invalidTimestamp,
            expiresAt,
            effectiveAt: reservationRow.check_in_at,
            impactFingerprint,
            reasonCode: "GUEST_REQUEST",
          },
        ),
        clients,
        admin,
        reservationRow.id,
      )
    );
    assert(
      invalidTime.code === "VALIDATION_ERROR",
      `strict RFC3339 ${invalidTimestamp}`,
    );
  }

  preview.evaluatedAt = "2026-02-29T00:00:00Z";
  const malformedTimestamp = await captureEdgeError(() =>
    previewReservationRoomMove(
      commandRequest(
        `/v1/reservations/${reservationRow.id}/room-change/preview`,
        cas,
      ),
      clients,
      admin,
      reservationRow.id,
    )
  );
  assert(
    malformedTimestamp.status === 500 &&
      malformedTimestamp.code === "RESERVATION_PROJECTION_INVALID",
    "malformed DB timestamps fail closed without raw detail",
  );
  preview.evaluatedAt = evaluatedAt;
  preview.reservationId = "not-a-uuid";
  const malformedUuid = await captureEdgeError(() =>
    previewReservationRoomMove(
      commandRequest(
        `/v1/reservations/${reservationRow.id}/room-change/preview`,
        cas,
      ),
      clients,
      admin,
      reservationRow.id,
    )
  );
  assert(
    malformedUuid.status === 500 &&
      malformedUuid.code === "RESERVATION_PROJECTION_INVALID",
    "malformed DB UUIDs fail closed without raw detail",
  );
  preview.reservationId = reservationRow.id;
  preview.eligible = false;
  (preview as { rejectionReasonCodes: string[] }).rejectionReasonCodes = [
    "RESERVATION_NOT_ACTIVE",
  ];
  for (
    const [caseName, historicalSegmentId] of [
      ["same-instant checked-out", "46000000-0000-4000-8000-000000000001"],
      ["cancelled retired", "46000000-0000-4000-8000-000000000009"],
    ] as const
  ) {
    preview.sourceSegmentId = historicalSegmentId;
    const inactivePreview = await previewReservationRoomMove(
      commandRequest(
        `/v1/reservations/${reservationRow.id}/room-change/preview`,
        cas,
      ),
      clients,
      admin,
      reservationRow.id,
    );
    assert(
      !inactivePreview.eligible &&
        inactivePreview.sourceSegmentId === historicalSegmentId &&
        inactivePreview.rejectionReasonCodes.includes("RESERVATION_NOT_ACTIVE"),
      `${caseName} reservation remains a 200 ineligible projection`,
    );
  }
});

Deno.test("during-stay room move exposes only bounded stay, segment, cleaning and PIN metadata", async () => {
  const targetRoomId = "50000000-0000-4000-8000-000000000002";
  const effectiveAt = "2026-09-01T01:00:00.000Z";
  const evaluatedAt = "2026-09-01T00:59:00.000Z";
  const expiresAt = "2026-09-01T01:04:00.000Z";
  const stayId = "45000000-0000-4000-8000-000000000001";
  const sourceSegmentId = "46000000-0000-4000-8000-000000000001";
  const targetSegmentId = "46000000-0000-4000-8000-000000000002";
  const sourceCleaningTargetId = "80000000-0000-4000-8000-000000000002";
  const clients = {
    admin: {
      rpc(name: string) {
        if (name === "preview_reservation_room_move") {
          return Promise.resolve({
            data: {
              mode: "DURING_STAY",
              reservationType: "standard",
              eligible: true,
              rejectionReasonCodes: [],
              blockingReasonCodes: [],
              warnings: [],
              targetBlockReasonCodes: [],
              sourceOutcome: {
                occupancyStatus: "OCCUPIED",
                readinessStatus: "READY",
                stateVersion: 2,
              },
              targetOutcome: {
                occupancyStatus: "VACANT",
                readinessStatus: "READY",
                stateVersion: 3,
              },
              impactFingerprint: "b".repeat(64),
              evaluatedAt,
              expiresAt,
              effectiveAt,
              reservationId: reservationRow.id,
              reservationVersion: 1,
              stayId,
              stayVersion: 1,
              sourceSegmentId,
              sourceSegmentVersion: 1,
              sourceRoomId: reservationRow.room_id,
              sourceRoomVersion: 2,
              targetRoomId,
              targetRoomVersion: 3,
              checkInAt: reservationRow.check_in_at,
              checkOutAt: reservationRow.check_out_at,
              guestCount: 2,
              preparationObligationId: reservationRow.preparation_obligation_id,
              checkoutObligationId: reservationRow.checkout_obligation_id,
              checkoutObligationVersion: 1,
              plannedCheckoutTargetId: "80000000-0000-4000-8000-000000000001",
              plannedCheckoutTargetVersion: 1,
            },
            error: null,
          });
        }
        return Promise.resolve({
          data: {
            reservation: { ...reservationRow, version: 2 },
            mode: "DURING_STAY",
            evaluatedAt,
            expiresAt,
            effectiveAt,
            movedAt: effectiveAt,
            sourceRoomId: reservationRow.room_id,
            targetRoomId,
            sourceRoomVersion: 3,
            targetRoomVersion: 4,
            plannedCheckoutTargetId: "80000000-0000-4000-8000-000000000001",
            plannedCheckoutTargetVersion: 2,
            sourceOutcome: {
              occupancyStatus: "VACANT",
              readinessStatus: "CLEANING_REQUIRED",
              stateVersion: 3,
            },
            targetOutcome: {
              occupancyStatus: "OCCUPIED",
              readinessStatus: "READY",
              stateVersion: 4,
            },
            stay: {
              id: stayId,
              version: 2,
              currentRoomId: reservationRow.room_id,
            },
            segments: [
              {
                id: sourceSegmentId,
                roomId: reservationRow.room_id,
                startsAt: reservationRow.check_in_at,
                endsAt: effectiveAt,
              },
              {
                id: targetSegmentId,
                roomId: targetRoomId,
                startsAt: effectiveAt,
                endsAt: reservationRow.check_out_at,
              },
            ],
            sourceCleaningTargetId,
            pinAccessEndsAt: effectiveAt,
            pin: "must-not-leak",
          },
          error: null,
        });
      },
    },
  } as unknown as EdgeClients;
  const common = {
    targetRoomId,
    effectiveAt,
    reasonCode: "GUEST_REQUEST",
    expectedReservationVersion: 1,
    expectedSourceRoomVersion: 2,
    expectedTargetRoomVersion: 3,
  };

  const preview = await previewReservationRoomMove(
    commandRequest(
      `/v1/reservations/${reservationRow.id}/room-change/preview`,
      common,
    ),
    clients,
    admin,
    reservationRow.id,
  );
  const result = await commitReservationRoomMove(
    commandRequest(
      `/v1/reservations/${reservationRow.id}/room-change`,
      { ...common, evaluatedAt, expiresAt, impactFingerprint: "b".repeat(64) },
      "POST",
      "during-stay-room-move-0001",
    ),
    clients,
    admin,
    reservationRow.id,
  );

  assert(
    preview.mode === "DURING_STAY" && preview.stayId === stayId,
    "during-stay preview identity",
  );
  assert(result.mode === "DURING_STAY", "during-stay commit mode");
  assert(
    result.stay?.id === stayId && result.segments?.length === 2,
    "bounded stay segment result",
  );
  assert(
    result.sourceCleaningTargetId === sourceCleaningTargetId,
    "source checkout target result",
  );
  assert(
    result.pinAccessEndsAt === effectiveAt && !("pin" in result),
    "PIN cutoff without material",
  );
});

Deno.test("reservation database errors redact unknown details", async () => {
  const stale = reservationDatabaseError({ message: "STALE_VERSION" });
  const overlap = reservationDatabaseError({
    code: "23P01",
    message: "detail",
  });
  const unknown = reservationDatabaseError({
    message: "private database detail",
  });
  const conflictDetail = {
    reloadResources: [
      "reservation",
      "sourceRoom",
      "targetRoom",
      "roomMovePreview",
    ],
    latestVersions: {
      reservationVersion: 4,
      sourceRoomVersion: 7,
      targetRoomVersion: 9,
    },
  };
  const conflict = reservationDatabaseError({
    message: "TARGET_ROOM_VERSION_CONFLICT",
    details: JSON.stringify(conflictDetail),
  });
  const malformedConflict = reservationDatabaseError({
    message: "ROOM_CHANGE_PREVIEW_STALE",
    details: JSON.stringify({
      ...conflictDetail,
      reservationId: reservationRow.id,
      pin: "1234",
      rawError: "private database detail",
    }),
  });
  const roomMoveIdempotencyConflict = reservationDatabaseError({
    message: "IDEMPOTENCY_KEY_REUSED",
    details: JSON.stringify(conflictDetail),
  }, true);
  const genericIdempotencyConflict = reservationDatabaseError({
    message: "IDEMPOTENCY_KEY_REUSED",
    details: JSON.stringify(conflictDetail),
  });

  assert(stale.status === 409 && stale.code === "STALE_VERSION", "stale CAS");
  assert(overlap.code === "RESERVATION_OVERLAP", "overlap constraint");
  assert(
    JSON.stringify(conflict.conflict) === JSON.stringify(conflictDetail),
    "valid conflict detail is allowlisted exactly",
  );
  assert(
    JSON.stringify(roomMoveIdempotencyConflict.conflict) ===
        JSON.stringify(conflictDetail) &&
      genericIdempotencyConflict.conflict === undefined,
    "idempotency reuse metadata is scoped to the room move command",
  );
  assert(
    JSON.stringify(malformedConflict.conflict) === JSON.stringify({
      reloadResources: [
        "reservation",
        "sourceRoom",
        "targetRoom",
        "roomMovePreview",
      ],
      latestVersions: {
        reservationVersion: null,
        sourceRoomVersion: null,
        targetRoomVersion: null,
      },
    }),
    "malformed conflict detail is replaced with a safe reload contract",
  );
  const serializedConflict = await errorResponse(conflict, "request-1", {})
    .json();
  assert(
    JSON.stringify(serializedConflict) === JSON.stringify({
      error: {
        code: "TARGET_ROOM_VERSION_CONFLICT",
        message: "도착 객실 상태가 변경됐습니다. 다시 확인해 주세요.",
        conflict: conflictDetail,
      },
      requestId: "request-1",
    }),
    "edge error response emits the exact safe conflict object",
  );
  const serializedIdempotencyConflict = await errorResponse(
    roomMoveIdempotencyConflict,
    "request-2",
    {},
  ).json();
  assert(
    JSON.stringify(serializedIdempotencyConflict) === JSON.stringify({
      error: {
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "이미 다른 요청에 사용한 Idempotency-Key입니다.",
        conflict: conflictDetail,
      },
      requestId: "request-2",
    }),
    "room move idempotency reuse emits the exact safe conflict object",
  );
  assert(
    !JSON.stringify(malformedConflict).includes(reservationRow.id) &&
      !JSON.stringify(malformedConflict).includes("1234") &&
      !JSON.stringify(malformedConflict).includes("private database detail"),
    "malformed conflict detail does not leak identifiers, PINs, or raw errors",
  );
  for (
    const code of [
      "RESERVATION_VERSION_CONFLICT",
      "SOURCE_ROOM_VERSION_CONFLICT",
      "TARGET_ROOM_VERSION_CONFLICT",
      "TARGET_ROOM_OVERLAP",
      "ROOM_CHANGE_PREVIEW_STALE",
      "CLEANING_ASSIGNMENT_LOCKED",
      "PIN_LEASE_ACTIVE",
      "TARGET_ROOM_BLOCKED",
      "TARGET_ROOM_NOT_READY",
      "OPEN_ENDED_STAY_REQUIRES_END",
      "MOVE_ALREADY_APPLIED",
    ]
  ) {
    assert(
      reservationDatabaseError({ message: code }).code === code,
      `${code} remains stable`,
    );
  }
  const invalidEffectiveAt = reservationDatabaseError({
    message: "INVALID_MOVE_EFFECTIVE_AT",
  });
  assert(
    invalidEffectiveAt.status === 400 &&
      invalidEffectiveAt.code === "INVALID_MOVE_EFFECTIVE_AT",
    "invalid effectiveAt remains a stable validation error",
  );
  assert(
    unknown.status === 500 && unknown.code === "RESERVATION_COMMAND_FAILED" &&
      !unknown.message.includes("private database detail"),
    "unknown DB errors are redacted",
  );
  assert(
    reservationRoomMoveIdFromPath(
      `/v1/reservations/${reservationRow.id}/room-change/preview`,
      "preview",
    ) === reservationRow.id,
    "room move preview route",
  );
  assert(
    reservationRoomMoveIdFromPath(
      `/v1/reservations/${reservationRow.id}/room-change`,
      "commit",
    ) === reservationRow.id,
    "room move commit route",
  );
  const legacyCommitRoute = await captureEdgeError(() =>
    Promise.resolve(
      reservationRoomMoveIdFromPath(
        `/v1/reservations/${reservationRow.id}/room-change/commit`,
        "commit",
      ),
    )
  );
  assert(
    legacyCommitRoute.code === "VALIDATION_ERROR",
    "legacy room move commit route is not an alias",
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
