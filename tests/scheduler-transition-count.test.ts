import { describe, expect, it } from "vitest";
import { schedulerTransitionCount } from "../supabase/functions/_shared/scheduler-transition-count.js";

const reservation = { checked_in_count: 1, checked_out_count: 2, blocked_check_in_count: 3, purged_guest_name_count: 4 };
const assignment = { activatedCount: 5, rolledOverCount: 0 };

describe("scheduler attention heartbeat", () => {
  it("counts cleaning and complaint attention separately without losing existing transitions", () => {
    expect(schedulerTransitionCount(reservation, { ...assignment, overdueCount: 6, complaintAttentionCount: 7 })).toBe(28);
  });
  it("accepts old immutable receipts without either optional counter", () => {
    expect(schedulerTransitionCount(reservation, assignment)).toBe(15);
    expect(schedulerTransitionCount(reservation, { ...assignment, overdueCount: 6 })).toBe(21);
  });
  it.each([-1, 0.5, NaN, Infinity, "1", null, {}, Number.MAX_SAFE_INTEGER + 1])("fails closed for malformed complaint count %s", (count) => {
    expect(schedulerTransitionCount(reservation, { ...assignment, complaintAttentionCount: count })).toBeNull();
  });
  it("requires all existing counters and valid object envelopes", () => {
    expect(schedulerTransitionCount({}, assignment)).toBeNull();
    expect(schedulerTransitionCount(reservation, {})).toBeNull();
    expect(schedulerTransitionCount(null, assignment)).toBeNull();
    expect(schedulerTransitionCount(reservation, [])).toBeNull();
    expect(schedulerTransitionCount(reservation, { ...assignment, overdueCount: -1 })).toBeNull();
  });
  it("rejects a total beyond the safe integer range", () => {
    expect(schedulerTransitionCount(reservation, { ...assignment, complaintAttentionCount: Number.MAX_SAFE_INTEGER })).toBeNull();
  });
});
