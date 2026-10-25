import type { ResetCensus } from "./reset-row-impact.js";

const referencePaths = [
  ["public.cleaning_targets", "template_snapshot.id"],
  ["public.cleaning_attempts", "template_snapshot.id"],
  [
    "private.target_photo_snapshot_contracts",
    "frozen_snapshot.templateVersionId",
  ],
  ["private.target_photo_slot_snapshots", "template_version_id"],
  ["private.flat_evidence_migration_receipts", "previous_template_snapshot.id"],
  [
    "private.flat_evidence_migration_receipts",
    "previous_photo_contract.templateVersionId",
  ],
  [
    "private.flat_evidence_migration_receipts",
    "previous_slots.template_version_id",
  ],
] as const;
export const RESET_TEMPLATE_REFERENCE_PATHS = Object.freeze(
  referencePaths.map((path) => Object.freeze(path)),
);
const statuses = ["draft", "published", "retired"] as const;
const kinds = ["checkout", "stayover", "additional", "reclean"];
const invalid = (): never => {
  throw new Error("RESET_TEMPLATE_EVIDENCE_INVALID");
};
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return invalid();
  }
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  ) return invalid();
  return value;
}
function count(value: unknown): number {
  if (
    !Number.isSafeInteger(value) || (value as number) < 0 ||
    (value as number) > 10000
  ) return invalid();
  return value as number;
}
function truth(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}
function agrees(census: ResetCensus, name: string, rows: number) {
  if (census.get(name)?.known !== true || census.get(name)?.count !== rows) {
    invalid();
  }
}

/** Trusted RPC evidence only. Digests cover template content/provenance; raw IDs,
 * slot labels and creator fields never leave this adapter. No digest is a backup,
 * fresh authorization, preserved-history receipt or permission to publish.
 */
export function summarizeResetTemplateEvidence(
  input: unknown,
  census: ResetCensus,
  snapshotId: string,
) {
  if (input === undefined) {
    return {
      available: false,
      diagnosticComplete: false,
      executionEnabled: false,
      templateCount: null,
      slotCount: null,
      contentFingerprintsCollected: null,
      statusCounts: null,
      referenceCounts: null,
      selectionAlternatives: null,
      historicallyUnreadable: null,
      registrationShapeInvalid: null,
      unsupportedPublicationPaths: null,
      slotProjectionMismatches: null,
      missingCreators: null,
      exhaustedVersions: null,
      blockers: ["TEMPLATE_INVENTORY_NOT_COLLECTED"],
    };
  }
  const data = object(input, [
    "format",
    "snapshotId",
    "templateCount",
    "slotCount",
    "orphanSlots",
    "templates",
    "references",
  ]);
  if (
    data.format !== "reset-template-inventory-v1" ||
    data.snapshotId !== snapshotId ||
    !Array.isArray(data.templates) || !Array.isArray(data.references)
  ) return invalid();
  const templateCount = count(data.templateCount);
  const slotCount = count(data.slotCount);
  const orphanSlots = count(data.orphanSlots);
  if (
    data.templates.length !== templateCount || orphanSlots > slotCount ||
    data.references.length !== RESET_TEMPLATE_REFERENCE_PATHS.length
  ) return invalid();
  agrees(census, "public.cleaning_template_versions", templateCount);
  agrees(census, "private.photo_template_slots", slotCount);
  const statusCounts = { draft: 0, published: 0, retired: 0 };
  const seen = new Set<string>();
  let collectedSlots = orphanSlots;
  let historicallyUnreadable = 0;
  let registrationShapeInvalid = 0;
  let unsupportedPublicationPaths = 0;
  let slotProjectionMismatches = orphanSlots;
  let missingCreators = 0;
  let exhaustedVersions = 0;
  for (const item of data.templates) {
    const row = object(item, [
      "sourceId",
      "status",
      "cleaningKind",
      "contentDigest",
      "slotRows",
      "historicallyReadable",
      "registrationShapeValid",
      "slotProjectionMatches",
      "versionAvailable",
      "currentPublicationPathSupported",
      "creatorExists",
    ]);
    if (
      typeof row.sourceId !== "string" ||
      !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(row.sourceId) ||
      seen.has(row.sourceId.toLowerCase()) ||
      !statuses.includes(row.status as typeof statuses[number]) ||
      !kinds.includes(String(row.cleaningKind)) ||
      typeof row.contentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(row.contentDigest)
    ) return invalid();
    seen.add(row.sourceId.toLowerCase());
    statusCounts[row.status as typeof statuses[number]]++;
    collectedSlots += count(row.slotRows);
    historicallyUnreadable += Number(!truth(row.historicallyReadable));
    registrationShapeInvalid += Number(!truth(row.registrationShapeValid));
    slotProjectionMismatches += Number(!truth(row.slotProjectionMatches));
    missingCreators += Number(!truth(row.creatorExists));
    exhaustedVersions += Number(!truth(row.versionAvailable));
    const supported = truth(row.currentPublicationPathSupported);
    if (
      supported !== (row.cleaningKind === "checkout") ||
      (row.registrationShapeValid === true && row.versionAvailable === false)
    ) return invalid();
    unsupportedPublicationPaths += Number(!supported);
  }
  if (collectedSlots !== slotCount) return invalid();
  const paths = new Set<string>();
  const referenceCounts = {
    edges: 0,
    absent: 0,
    malformed: 0,
    detached: 0,
    matched: 0,
  };
  for (const item of data.references) {
    const row = object(item, [
      "relation",
      "path",
      "sourceRows",
      "edgeRows",
      "absent",
      "malformed",
      "detached",
      "matched",
    ]);
    const relation = String(row.relation);
    const path = String(row.path);
    const key = `${relation}:${path}`;
    if (
      !RESET_TEMPLATE_REFERENCE_PATHS.some(([r, p]) =>
        r === relation && p === path
      ) ||
      paths.has(key)
    ) return invalid();
    paths.add(key);
    const sourceRows = count(row.sourceRows);
    const edgeRows = count(row.edgeRows);
    agrees(census, relation, sourceRows);
    if (
      path !== "previous_slots.template_version_id" && sourceRows !== edgeRows
    ) return invalid();
    if (sourceRows === 0 && edgeRows !== 0) return invalid();
    let sum = 0;
    for (
      const name of ["absent", "malformed", "detached", "matched"] as const
    ) {
      const value = count(row[name]);
      sum += value;
      referenceCounts[name] += value;
    }
    if (sum !== edgeRows) return invalid();
    referenceCounts.edges += edgeRows;
  }
  const blockers: string[] = [];
  if (historicallyUnreadable) {
    blockers.push("TEMPLATE_HISTORICAL_SHAPE_UNREADABLE");
  }
  if (templateCount) {
    blockers.push(
      "TEMPLATE_SELECTION_AND_STATUS_POLICY_REQUIRED",
      "TEMPLATE_HISTORY_ARCHIVE_NOT_VERIFIED",
    );
  }
  if (registrationShapeInvalid) {
    blockers.push("TEMPLATE_FRESH_REGISTRATION_SHAPE_INCOMPATIBLE");
  }
  if (unsupportedPublicationPaths) {
    blockers.push("TEMPLATE_EXISTING_PUBLICATION_PATH_NOT_APPLICABLE");
  }
  if (slotProjectionMismatches) {
    blockers.push("TEMPLATE_SLOT_PROJECTION_MISMATCH");
  }
  if (missingCreators) blockers.push("TEMPLATE_CREATOR_REFERENCE_MISSING");
  if (exhaustedVersions) blockers.push("TEMPLATE_VERSION_RANGE_EXHAUSTED");
  if (referenceCounts.malformed) {
    blockers.push("TEMPLATE_HISTORICAL_REFERENCE_MALFORMED");
  }
  if (referenceCounts.matched + referenceCounts.detached) {
    blockers.push("TEMPLATE_HISTORICAL_REFERENCES_REQUIRE_PROTECTION");
  }
  return {
    available: true,
    diagnosticComplete: true,
    executionEnabled: false,
    templateCount,
    slotCount,
    contentFingerprintsCollected: seen.size,
    statusCounts,
    referenceCounts,
    historicallyUnreadable,
    registrationShapeInvalid,
    unsupportedPublicationPaths,
    slotProjectionMismatches,
    missingCreators,
    exhaustedVersions,
    // These select source content only. Neither option chooses statuses for new
    // records, converts legacy slots, publishes every version or drops history.
    selectionAlternatives: [
      {
        scope: "currentPublished",
        selected: statusCounts.published,
        excludedDraft: statusCounts.draft,
        excludedRetired: statusCounts.retired,
        statusPolicyDecided: false,
      },
      {
        scope: "allVersions",
        selected: templateCount,
        excludedDraft: 0,
        excludedRetired: 0,
        statusPolicyDecided: false,
      },
    ],
    blockers,
  };
}
