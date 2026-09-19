import { randomUUID } from "node:crypto";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export async function testReservationLongStayConcurrency({ client, actorProfileId }) {
  const roomResult = await client.from("rooms")
    .select("id,state_version,room_type_id")
    .order("room_number")
    .limit(121);
  assert(!roomResult.error, `long-stay room fixture query failed: ${roomResult.error?.message}`);
  const byType = new Map();
  for (const room of roomResult.data ?? []) {
    const group = byType.get(room.room_type_id) ?? [];
    group.push(room);
    byType.set(room.room_type_id, group);
  }
  const rooms = [...byType.values()].find((group) => group.length >= 5);
  assert(rooms, "long-stay concurrency requires five rooms of one room type");

  const createId = randomUUID();
  const createKey = `long-stay-create-${randomUUID()}`;
  const createArgs = {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: createId,
    p_room_id: rooms[0].id,
    p_reservation_type: "long_stay",
    p_check_in_at: "2046-01-01T06:00:00.000Z",
    p_check_out_at: null,
    p_guest_count: 1,
    p_guest_name_encrypted: null,
    p_expected_room_version: rooms[0].state_version,
    p_idempotency_key: createKey,
    p_request_hash: "a".repeat(64),
  };
  const createRace = await Promise.all([
    client.rpc("create_reservation_v2", createArgs),
    client.rpc("create_reservation_v2", createArgs),
  ]);
  assert(createRace.every((result) => !result.error), "identical open-ended creates must replay");
  const createRows = await client.from("reservations").select("id,version")
    .eq("id", createId);
  assert(!createRows.error && createRows.data.length === 1, "open-ended create is exactly once");

  const fixedAt = "2046-03-01T02:00:00.000Z";
  const changeRace = await Promise.all([0, 1].map((index) =>
    client.rpc("change_reservation_v2", {
      p_actor_profile_id: actorProfileId,
      p_reservation_id: createId,
      p_room_id: rooms[0].id,
      p_reservation_type: "long_stay",
      p_check_in_at: createArgs.p_check_in_at,
      p_check_out_at: fixedAt,
      p_guest_count: 1,
      p_guest_name_mode: "keep",
      p_guest_name_encrypted: null,
      p_expected_version: 1,
      p_reason_code: "LONG_STAY_END_CONFIRMED",
      p_idempotency_key: `long-stay-set-end-${index}-${randomUUID()}`,
      p_request_hash: `${index + 1}`.repeat(64),
    })
  ));
  assert(changeRace.filter((result) => !result.error).length === 1, "end confirmation has one CAS winner");
  assert(changeRace.filter((result) => result.error?.message === "STALE_VERSION").length === 1,
    "end confirmation loser is the stable stale-version conflict");
  const fixedGraph = await Promise.all([
    client.from("checkout_cleaning_obligations").select("id").eq("reservation_id", createId),
    client.from("cleaning_targets").select("id").eq("reservation_id", createId).eq("cleaning_kind", "checkout"),
  ]);
  assert(fixedGraph.every((result) => !result.error && result.data.length === 1),
    "end confirmation creates one checkout graph");

  const checkoutId = randomUUID();
  const checkoutCreate = await client.rpc("create_reservation_v2", {
    ...createArgs,
    p_reservation_id: checkoutId,
    p_room_id: rooms[1].id,
    p_expected_room_version: rooms[1].state_version,
    p_check_in_at: "2046-04-01T06:00:00.000Z",
    p_idempotency_key: `long-stay-checkout-create-${randomUUID()}`,
    p_request_hash: "c".repeat(64),
  });
  assert(!checkoutCreate.error, `manual-checkout fixture failed: ${checkoutCreate.error?.message}`);
  const checkedIn = await client.from("reservations")
    .update({ actual_check_in_at: "2046-04-01T06:00:00.000Z" }).eq("id", checkoutId);
  assert(!checkedIn.error, `manual-checkout check-in fixture failed: ${checkedIn.error?.message}`);
  const checkoutKey = `long-stay-manual-checkout-${randomUUID()}`;
  const checkoutArgs = {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: checkoutId,
    p_expected_version: 1,
    p_reason_code: "EARLY_DEPARTURE",
    p_effective_at: "2046-04-05T02:00:00.000Z",
    p_idempotency_key: checkoutKey,
    p_request_hash: "d".repeat(64),
  };
  const checkoutRace = await Promise.all([
    client.rpc("manual_checkout_reservation", checkoutArgs),
    client.rpc("manual_checkout_reservation", checkoutArgs),
  ]);
  assert(checkoutRace.every((result) => !result.error), "identical manual checkout must replay");
  const checkoutGraph = await Promise.all([
    client.from("checkout_cleaning_obligations").select("id").eq("reservation_id", checkoutId),
    client.from("cleaning_targets").select("id").eq("reservation_id", checkoutId).eq("cleaning_kind", "checkout"),
  ]);
  assert(checkoutGraph.every((result) => !result.error && result.data.length === 1),
    "manual checkout creates one checkout graph");

  const moveId = randomUUID();
  const moveCheckIn = "2046-06-01T06:00:00.000Z";
  const moveCreate = await client.rpc("create_reservation_v2", {
    ...createArgs,
    p_reservation_id: moveId,
    p_room_id: rooms[2].id,
    p_expected_room_version: rooms[2].state_version,
    p_check_in_at: moveCheckIn,
    p_idempotency_key: `long-stay-move-create-${randomUUID()}`,
    p_request_hash: "e".repeat(64),
  });
  assert(!moveCreate.error, `room-move fixture failed: ${moveCreate.error?.message}`);
  const versions = await Promise.all([
    client.from("reservations").select("version").eq("id", moveId).single(),
    client.from("rooms").select("state_version").eq("id", rooms[2].id).single(),
    client.from("rooms").select("state_version").eq("id", rooms[4].id).single(),
  ]);
  assert(versions.every((result) => !result.error), "open-ended move version fixture");
  const preview = await client.rpc("preview_reservation_room_move", {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: moveId,
    p_target_room_id: rooms[4].id,
    p_expected_reservation_version: versions[0].data.version,
    p_expected_source_room_version: versions[1].data.state_version,
    p_expected_target_room_version: versions[2].data.state_version,
    p_effective_at: moveCheckIn,
    p_reason_code: "GUEST_REQUEST",
  });
  assert(
    !preview.error && preview.data?.eligible,
    `open-ended pre-checkin preview failed: ${preview.error?.message ?? JSON.stringify(preview.data)}`,
  );
  const moveArgs = {
    p_actor_profile_id: actorProfileId,
    p_reservation_id: moveId,
    p_target_room_id: rooms[4].id,
    p_expected_reservation_version: preview.data.reservationVersion,
    p_expected_source_room_version: preview.data.sourceRoomVersion,
    p_expected_target_room_version: preview.data.targetRoomVersion,
    p_preview_evaluated_at: preview.data.evaluatedAt,
    p_preview_expires_at: preview.data.expiresAt,
    p_effective_at: preview.data.effectiveAt,
    p_impact_fingerprint: preview.data.impactFingerprint,
    p_reason_code: "GUEST_REQUEST",
    p_idempotency_key: `long-stay-move-${randomUUID()}`,
    p_request_hash: "f".repeat(64),
  };
  const moveRace = await Promise.all([
    client.rpc("commit_reservation_room_move", moveArgs),
    client.rpc("commit_reservation_room_move", moveArgs),
  ]);
  assert(moveRace.every((result) => !result.error), "identical pre-checkin move must replay");
  const moveEvidence = await Promise.all([
    client.from("audit_events").select("id").eq("entity_id", moveId)
      .eq("event_type", "reservation.room_moved"),
    client.from("checkout_cleaning_obligations").select("id").eq("reservation_id", moveId),
  ]);
  assert(!moveEvidence[0].error && moveEvidence[0].data.length === 1,
    "open-ended move writes one immutable audit event");
  assert(!moveEvidence[1].error && moveEvidence[1].data.length === 0,
    "open-ended move does not invent a checkout graph");
}
