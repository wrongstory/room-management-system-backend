export type BaselineReviewRecord = Readonly<{
  historyVersion: string; name: string; path: string; sourceBytes: number; sourceSha256: string;
  historyBytes: number; historyStatementSha256: string; explanation: string;
  localSourceBound: true; archivedRepresentationReproduced: boolean;
  liveHistoryVerified: false; currentCatalogVerified: false; baselineAccepted: false;
  artifactReview: 'REPRODUCED_BYTES_STILL_REQUIRE_REVIEW' | 'SEPARATE_ARTIFACT_REQUIRED';
}>;
export type HistoricalBaselineReviewDesign = Readonly<{
  format: 'historical-baseline-review-design-v1'; status: 'DESIGN_ONLY_NOT_ACCEPTED';
  evidenceSha256: string; sourceBundleSha256: string; designSha256: string;
  modelSource: Readonly<Record<string, string>>; evidenceScope: string; baselineCount: 122;
  records: readonly BaselineReviewRecord[];
  checks: readonly Readonly<{ id: string; status: string; scope: string }>[];
  references: Readonly<Record<string, unknown>>;
  baselineAccepted: false; executionAllowed: false; operationalApproval: false;
  DBHistoryVerified: false; fullStateVerified: false; remoteSourceVerified: false;
  liveObservationCollected: false; runtimeHistoryModel: false;
}>;
export function createHistoricalBaselineReviewDesign(bundle: unknown): HistoricalBaselineReviewDesign;
