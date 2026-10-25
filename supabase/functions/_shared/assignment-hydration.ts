/** Request-local display relations. The caller MUST perform its final authority
 * RPC after this completes; nothing here grants a command or a live departure. */
export interface AssignmentHydrationBinding {
  id: string;
  cleaning_target_id: string;
  maid_profile_id: string;
}
type Row = Record<string, unknown>;
const relations = [
  "targets",
  "profiles",
  "attempts",
  "submissions",
  "schedules",
] as const;
type Relation = typeof relations[number];
type Hydration = Record<Relation, Row[]>;
export class AssignmentHydrationError extends Error {
  constructor() {
    super("ASSIGNMENT_HYDRATION_INCOMPLETE");
  }
}
function reject(): never {
  throw new AssignmentHydrationError();
}
function object(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return reject();
  }
  return value as Row;
}
function exact(value: Row, keys: readonly string[]): void {
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) reject();
}
function id(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return reject();
  return value;
}
function key(relation: Relation, row: Row): string {
  if (relation === "submissions" || relation === "schedules") {
    const revision = relation === "submissions" ? row.version : row.revision;
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) {
      return reject();
    }
    return JSON.stringify([
      id(
        relation === "submissions"
          ? row.cleaning_attempt_id
          : row.cleaning_target_id,
      ),
      revision,
    ]);
  }
  return id(row.id);
}
/** Count envelopes detect missing/truncated data. Bindings prohibit cross-ID
 * hydration even when a service RPC returns a structurally plausible payload. */
export function parseAssignmentHydration(
  value: unknown,
  bindings: readonly AssignmentHydrationBinding[],
): Hydration {
  const payload = object(value);
  exact(payload, ["assignments", ...relations]);
  if (
    bindings.length < 1 || bindings.length > 100 ||
    new Set(bindings.map((row) => row.id)).size !== bindings.length ||
    !Array.isArray(payload.assignments) ||
    payload.assignments.length !== bindings.length
  ) return reject();
  const expected = new Map(bindings.map((row) => [row.id, row]));
  const seen = new Set<string>();
  for (const raw of payload.assignments) {
    const binding = object(raw);
    exact(binding, ["id", "cleaning_target_id", "maid_profile_id"]);
    const bindingId = id(binding.id), match = expected.get(bindingId);
    if (
      !match || seen.has(bindingId) ||
      binding.cleaning_target_id !== match.cleaning_target_id ||
      binding.maid_profile_id !== match.maid_profile_id
    ) return reject();
    seen.add(bindingId);
  }
  const result = {} as Hydration;
  for (const relation of relations) {
    const envelope = object(payload[relation]);
    exact(envelope, ["rows", "count"]);
    if (
      !Array.isArray(envelope.rows) || !Number.isSafeInteger(envelope.count) ||
      (envelope.count as number) < 0 || (envelope.count as number) > 1000 ||
      envelope.rows.length !== envelope.count
    ) return reject();
    result[relation] = envelope.rows.map(object);
    if (
      new Set(result[relation].map((row) => key(relation, row))).size !==
        result[relation].length
    ) return reject();
  }
  const targets = new Set(bindings.map((row) => row.cleaning_target_id));
  const profiles = new Set(bindings.map((row) => row.maid_profile_id));
  if (
    result.targets.length !== targets.size ||
    result.targets.some((row) => !targets.has(id(row.id))) ||
    result.profiles.length !== profiles.size ||
    result.profiles.some((row) => !profiles.has(id(row.id))) ||
    result.attempts.some((row) => !expected.has(id(row.assignment_id))) ||
    result.schedules.some((row) => !targets.has(id(row.cleaning_target_id)))
  ) return reject();
  const latest = new Map<string, Row>();
  for (const attempt of result.attempts) {
    if (
      !Number.isSafeInteger(attempt.attempt_number) ||
      (attempt.attempt_number as number) < 1
    ) return reject();
    const assignment = id(attempt.assignment_id),
      previous = latest.get(assignment);
    if (
      !previous ||
      (attempt.attempt_number as number) > (previous.attempt_number as number)
    ) latest.set(assignment, attempt);
  }
  const latestIds = new Set([...latest.values()].map((row) => id(row.id)));
  if (
    result.submissions.some((row) =>
      !latestIds.has(id(row.cleaning_attempt_id))
    )
  ) return reject();
  result.attempts.sort((a, b) =>
    (b.attempt_number as number) - (a.attempt_number as number)
  );
  result.submissions.sort((a, b) =>
    (b.version as number) - (a.version as number)
  );
  return result;
}
export async function loadAssignmentHydration(
  bindings: readonly AssignmentHydrationBinding[],
  read: (ids: string[]) => Promise<unknown>,
): Promise<Hydration> {
  if (
    bindings.length > 1000 ||
    new Set(bindings.map((row) => row.id)).size !== bindings.length
  ) return reject();
  const merged = Object.fromEntries(
    relations.map((relation) => [relation, new Map<string, Row>()]),
  ) as Record<Relation, Map<string, Row>>;
  for (let offset = 0; offset < bindings.length; offset += 100) {
    const batch = bindings.slice(offset, offset + 100);
    const parsed = parseAssignmentHydration(
      await read(batch.map((row) => row.id)),
      batch,
    );
    for (const relation of relations) {
      for (const row of parsed[relation]) {
        const rowKey = key(relation, row),
          previous = merged[relation].get(rowKey);
        // Shared targets/history/profiles may occur in several batches. Deduplicate
        // identical evidence, but fail closed if the shared display facts drift.
        if (
          previous && JSON.stringify(previous) !== JSON.stringify(row)
        ) return reject();
        merged[relation].set(rowKey, row);
      }
    }
  }
  // The original history query grouped 100 distinct target IDs, not 100
  // assignment IDs. Preserve that cap even if shared targets split across RPCs.
  const targetOrder = [
    ...new Set(bindings.map((row) => row.cleaning_target_id)),
  ];
  const targetBatch = new Map(
    targetOrder.map((target, index) => [target, Math.floor(index / 100)]),
  );
  const counts = new Map<number, number>();
  for (const row of merged.schedules.values()) {
    const batch = targetBatch.get(id(row.cleaning_target_id));
    if (batch === undefined) return reject();
    const count = (counts.get(batch) ?? 0) + 1;
    if (count > 1000) return reject();
    counts.set(batch, count);
  }
  return Object.fromEntries(
    relations.map((relation) => [relation, [...merged[relation].values()]]),
  ) as Hydration;
}
