const dayMillis = 86_400_000;
function date(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Availability fixture date is invalid');
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error('Availability fixture date is invalid');
  return parsed;
}

// This fixture's original seven days are all true. Preserve every past true
// day while removing today, so the approval reaches the assignment guard.
export function pastAvailableDatesForApproval(weekStart, today) {
  const start = date(weekStart);
  const current = date(today);
  const offset = (current.getTime() - start.getTime()) / dayMillis;
  if (start.getUTCDay() !== 1 || offset < 0 || offset > 6) throw new Error('Availability fixture week changed');
  return Array.from({ length: offset }, (_, index) => new Date(start.getTime() + index * dayMillis).toISOString().slice(0, 10));
}

// Current-week writes require approval; next-week writes remain maid submissions.
// Derive the route from the real KST week without moving the shared service date.
export function availabilityRaceWriteMode(weekStart, commandAt) {
  if (!(commandAt instanceof Date) || !Number.isFinite(commandAt.getTime())) throw new Error('Availability fixture clock is invalid');
  const current = date(new Date(commandAt.getTime() + 9 * 3_600_000).toISOString().slice(0, 10));
  current.setUTCDate(current.getUTCDate() - ((current.getUTCDay() + 6) % 7));
  const target = date(weekStart);
  const difference = (target.getTime() - current.getTime()) / dayMillis;
  if (difference === 0) return 'approve_current_week';
  if (difference === 7) return 'submit_next_week';
  throw new Error('Availability fixture week is outside the current or next week');
}

// Target[0] has already been notified for this maid/date. The availability
// writer must lose to that business guard, not an unrelated date/authority error.
export function isExpectedAvailabilityCommitCollision(results) {
  return Array.isArray(results) && results.length === 2 && results[0] != null
    && results[0].error == null && results[1]?.error?.code === '40001'
    && results[1].error.message === 'ASSIGNMENT_AVAILABILITY_STALE';
}
