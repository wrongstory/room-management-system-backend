/** Rolling deployments may replay receipts created before attention counters existed. */
export function schedulerTransitionCount(
  reservationValue: unknown,
  assignmentValue: unknown,
): number | null {
  if (
    !reservationValue || Array.isArray(reservationValue) ||
    typeof reservationValue !== "object" || !assignmentValue ||
    Array.isArray(assignmentValue) || typeof assignmentValue !== "object"
  ) return null;
  const reservation = reservationValue as Record<string, unknown>;
  const assignment = assignmentValue as Record<string, unknown>;
  const counts = [
    reservation.checked_in_count,
    reservation.checked_out_count,
    reservation.blocked_check_in_count,
    reservation.purged_guest_name_count,
    assignment.activatedCount,
    assignment.rolledOverCount,
    assignment.overdueCount ?? 0,
    assignment.complaintAttentionCount === undefined
      ? 0
      : assignment.complaintAttentionCount,
  ];
  if (
    counts.some((count) =>
      typeof count !== "number" || !Number.isSafeInteger(count) || count < 0
    )
  ) {
    return null;
  }
  const total = (counts as number[]).reduce((sum, count) => sum + count, 0);
  return Number.isSafeInteger(total) ? total : null;
}
