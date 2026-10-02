import { schedulerTransitionCount } from "./scheduler-transition-count.ts";

const reservation = {
  checked_in_count: 1,
  checked_out_count: 2,
  blocked_check_in_count: 3,
  purged_guest_name_count: 4,
};
const assignment = { activatedCount: 5, rolledOverCount: 0 };
function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) {
    throw new Error("Scheduler heartbeat count mismatch");
  }
}
Deno.test("scheduler includes complaint attention and preserves old receipts", () => {
  equal(
    schedulerTransitionCount(reservation, {
      ...assignment,
      overdueCount: 6,
      complaintAttentionCount: 7,
    }),
    28,
  );
  equal(schedulerTransitionCount(reservation, assignment), 15);
  equal(
    schedulerTransitionCount(reservation, { ...assignment, overdueCount: 6 }),
    21,
  );
});
Deno.test("scheduler rejects malformed attention counters and envelopes", () => {
  for (
    const count of [
      -1,
      0.5,
      NaN,
      Infinity,
      "1",
      null,
      {},
      Number.MAX_SAFE_INTEGER + 1,
    ]
  ) {
    equal(
      schedulerTransitionCount(reservation, {
        ...assignment,
        complaintAttentionCount: count,
      }),
      null,
    );
  }
  equal(schedulerTransitionCount(null, assignment), null);
  equal(schedulerTransitionCount(reservation, []), null);
  equal(schedulerTransitionCount({}, assignment), null);
  equal(
    schedulerTransitionCount(reservation, {
      ...assignment,
      complaintAttentionCount: Number.MAX_SAFE_INTEGER,
    }),
    null,
  );
});
