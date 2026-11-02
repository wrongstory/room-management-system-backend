import { resetRelationGroups } from "./reset-preview-groups.js";
import { summarizeOperationGates } from "./operation-gates.js";
import {
  type ResetCensus,
  summarizeResetRowImpact,
} from "./reset-row-impact.js";
import { summarizeResetTemplateEvidence } from "./reset-template-evidence.js";

export class ResetPreviewError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}
export interface ResetPreviewActor {
  profileId: string;
  authUserId: string;
  role: string;
  mustChangePassword: boolean;
}
export type ResetPreviewRpc = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<{ data: unknown; error: unknown }>;
type Group = keyof typeof resetRelationGroups;
const groups = Object.keys(resetRelationGroups) as Group[];
const classifications = new Map<string, Group>(
  groups.flatMap((group) =>
    resetRelationGroups[group].map((name) => [name, group] as const)
  ),
);
const failed = () => {
  throw new ResetPreviewError(503, "RESET_PREVIEW_UNAVAILABLE");
};
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return failed();
  }
  return input as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(value).length !== names.length ||
    names.some((name) => !(name in value))
  ) failed();
}

/** Only accepts server RPC output. Candidate impact never establishes execution authority. */
export function summarizeResetPreview(input: unknown) {
  const value = object(input);
  fields(value, [
    "format",
    "readOnly",
    "capturedAt",
    "snapshotId",
    "relations",
    ...(Object.hasOwn(value, "rowImpact") ? ["rowImpact"] : []),
    ...(Object.hasOwn(value, "gateEvidence") ? ["gateEvidence"] : []),
    ...(Object.hasOwn(value, "templateEvidence") ? ["templateEvidence"] : []),
  ]);
  if (
    value.format !== "reset-preview-inventory-v1" || value.readOnly !== true ||
    typeof value.capturedAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
      .test(value.capturedAt) ||
    !Number.isFinite(Date.parse(value.capturedAt)) ||
    typeof value.snapshotId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.snapshotId) ||
    !Array.isArray(value.relations) || value.relations.length > 1000
  ) return failed();
  const seen = new Set<string>();
  const census: ResetCensus = new Map();
  const summary = Object.fromEntries(
    groups.map(
      (group) => [group, { relations: 0, observedRows: 0, exact: true }],
    ),
  ) as Record<
    Group,
    { relations: number; observedRows: number; exact: boolean }
  >;
  let unsupportedRelations = 0;
  let truncatedRelations = 0;
  let unknownRelations = 0;
  for (const item of value.relations) {
    const row = object(item);
    fields(row, ["relation", "kind", "partition", "observedRows", "exact"]);
    if (
      typeof row.relation !== "string" ||
      !/^(public|private)\.[a-z][a-z0-9_]{0,62}$/.test(row.relation) ||
      seen.has(row.relation) ||
      !["r", "p", "f"].includes(String(row.kind)) ||
      typeof row.partition !== "boolean" || typeof row.exact !== "boolean"
    ) return failed();
    seen.add(row.relation);
    const supported = row.kind === "r" && !row.partition;
    if (supported) {
      if (
        !Number.isSafeInteger(row.observedRows) ||
        (row.observedRows as number) < 0 ||
        (row.observedRows as number) > 10001 ||
        row.exact !== ((row.observedRows as number) <= 10000)
      ) return failed();
      if (!row.exact) truncatedRelations++;
    } else {
      if (row.observedRows !== null || row.exact !== false) return failed();
      unsupportedRelations++;
    }
    const group = classifications.get(row.relation);
    census.set(row.relation, {
      count: row.observedRows as number | null,
      known: group !== undefined,
    });
    if (!group) {
      unknownRelations++;
      continue;
    }
    summary[group].relations++;
    summary[group].observedRows += (row.observedRows as number | null) ?? 0;
    summary[group].exact &&= row.exact;
  }
  const missingRelations =
    [...classifications.keys()].filter((name) => !seen.has(name)).length;
  for (const [name, group] of classifications) {
    if (!seen.has(name)) summary[group].exact = false;
  }
  const blockers = [
    "RESET_RECOVERY_SCOPE_UNDECIDED",
    "PHOTO_DELETION_ON_HOLD",
    "RESET_EXECUTION_NOT_IMPLEMENTED",
  ];
  if (missingRelations || unknownRelations) {
    blockers.push("INVENTORY_CLASSIFICATION_MISMATCH");
  }
  if (unsupportedRelations) blockers.push("UNSUPPORTED_RELATIONS");
  if (truncatedRelations) blockers.push("INVENTORY_ROW_LIMIT_EXCEEDED");
  let rowImpact: ReturnType<typeof summarizeResetRowImpact>;
  let operationGates: ReturnType<typeof summarizeOperationGates> | null;
  let templateEvidence: ReturnType<typeof summarizeResetTemplateEvidence>;
  try {
    operationGates = Object.hasOwn(value, "gateEvidence")
      ? summarizeOperationGates(value.gateEvidence)
      : null;
    rowImpact = summarizeResetRowImpact(
      value.rowImpact,
      census,
      value.snapshotId,
    );
    templateEvidence = summarizeResetTemplateEvidence(
      value.templateEvidence,
      census,
      value.snapshotId,
    );
  } catch {
    return failed();
  }
  blockers.push(...rowImpact.blockers);
  blockers.push(
    ...(operationGates?.blockers ?? ["OPERATION_GATES_NOT_COLLECTED"]),
  );
  blockers.push(...templateEvidence.blockers);
  return {
    readOnly: true,
    diagnosticComplete:
      missingRelations + unknownRelations + unsupportedRelations +
          truncatedRelations === 0,
    executionEnabled: false,
    capturedAt: value.capturedAt,
    snapshotId: value.snapshotId,
    relationCount: seen.size,
    missingRelations,
    unknownRelations,
    unsupportedRelations,
    truncatedRelations,
    // These are table candidate groups. mixed/review totals are never deletion counts.
    candidateImpact: summary,
    rowImpact,
    operationGates,
    templateEvidence,
    blockers,
  };
}

export async function readResetPreview(
  rpc: ResetPreviewRpc,
  actor: ResetPreviewActor,
  sessionId: string,
) {
  if (actor.role !== "developer") {
    throw new ResetPreviewError(403, "DEVELOPER_REQUIRED");
  }
  if (actor.mustChangePassword) {
    throw new ResetPreviewError(403, "PASSWORD_CHANGE_REQUIRED");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(sessionId)
  ) {
    throw new ResetPreviewError(401, "INVALID_ACCESS_TOKEN");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ResetPreviewError(503, "RESET_PREVIEW_TIMEOUT"));
    }, 8000);
  });
  try {
    const result = await Promise.race([
      rpc("get_developer_reset_preview", {
        p_auth_user_id: actor.authUserId,
        p_actor_profile_id: actor.profileId,
        p_session_id: sessionId,
      }, controller.signal),
      timeout,
    ]);
    if (result.error) {
      const error = object(result.error);
      if (error.code === "42501") {
        throw new ResetPreviewError(403, "RESET_PREVIEW_AUTHORIZATION_FAILED");
      }
      if (error.code === "57014") {
        throw new ResetPreviewError(503, "RESET_PREVIEW_TIMEOUT");
      }
      return failed();
    }
    return summarizeResetPreview(result.data);
  } catch (error) {
    if (error instanceof ResetPreviewError) throw error;
    return failed();
  } finally {
    clearTimeout(timer);
  }
}
