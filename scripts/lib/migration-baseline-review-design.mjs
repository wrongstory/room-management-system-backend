/** H1 review planning only. This module has no database, approval, codec or execution entry. */
import { createHash } from 'node:crypto';
import evidence from '../migration-baseline-review-evidence.json' with { type: 'json' };
import { isOwnedMigrationSourceBundle, migrationHistorySourceBytes } from './migration-source-bundle.mjs';

const evidenceSha256 = '44151aabadfbcbafaed278c330227789da7a48659b35db1f835c4a3ee70f4c12';
const sha = value => createHash('sha256').update(value).digest('hex');
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
freeze(evidence);

// These are required review stages, not configurable query callbacks or proof claims.
const checks = freeze([
  { id: 'EXACT_HISTORY_122', status: 'NOT_OBSERVED', scope: 'All raw rows, dimensions, versions, names and ordered hashes; preserve the existing 110 checks.' },
  { id: 'HISTORIC_ARTIFACTS', status: 'NOT_ACCEPTED', scope: 'Owned historical blob, documented wrapper artifact, and unresolved initial/complaint provenance.' },
  { id: 'BASELINE_122_CATALOG', status: 'NOT_OBSERVED', scope: 'Independent source-derived prefix122 catalog, not pending123+ and not production as its own oracle.' },
  { id: 'EFFECTIVE_AUTHORITY', status: 'NOT_OBSERVED', scope: 'Owners, role closure, default/object/column/function ACL, RLS/policies, SECURITY DEFINER and auth dependencies.' },
  { id: 'FOLLOWUP_EFFECTS', status: 'NOT_REVIEWED', scope: 'Exact subsequent source writes and dependencies through122; overrides do not prove historical execution or data effects.' },
  { id: 'CATALOG_COVERAGE', status: 'NOT_REVIEWED', scope: 'All declared classes and managed-schema boundaries; unsupported or omitted classes block.' },
  { id: 'OBSERVATION_LIFECYCLE', status: 'NOT_OBSERVED', scope: 'Owned read-only snapshot, finite budget, cleanup, target identity and drift recheck.' },
  { id: 'SEPARATE_BASELINE_ACCEPTANCE', status: 'NOT_REQUESTED', scope: 'Exact completed evidence and residual-risk review, separate from H1 design and D04 execution approval.' },
]);

function reproduce(row, raw) {
  const source = raw.toString('utf8');
  if (row.explanation === 'EXACT_COMMENT_DIFFERENCE') {
    // Only this frozen source/hash is supported; never normalize observed history.
    return Buffer.from(source.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n').trimEnd());
  }
  const prefix = "begin;\nset local lock_timeout='5s';\nset local statement_timeout='60s';\n";
  if (row.explanation === 'EXACT_TIMEOUT_WRAPPER') return Buffer.from(`${prefix}${source}commit;`);
  if (row.explanation === 'EXACT_TIMEOUT_WRAPPER_EXISTING_TRANSACTION') {
    if (!/^begin;\n/iu.test(source) || !/commit;\n$/iu.test(source)) throw new Error();
    return Buffer.from(`${prefix}\n${source.replace(/^begin;\n/iu, '').replace(/commit;\n$/iu, '')}commit;`);
  }
  // The current source cannot stand in for a different historical Git blob,
  // a document-only wrapper hash, or a missing original artifact.
  return null;
}

/** Accepts only the existing module-owned immutable local Git bundle. Returns a review document, never a capability. */
export function createHistoricalBaselineReviewDesign(bundle) {
  try {
    if (!isOwnedMigrationSourceBundle(bundle) || sha(JSON.stringify(evidence)) !== evidenceSha256
      || bundle.modelSource.projectRef !== evidence.projectRef || bundle.totalCount < evidence.baselineCount
      || bundle.files[evidence.baselineCount - 1]?.name !== evidence.baselineHead) throw new Error();
    const records = evidence.rows.map(row => {
      const file = bundle.files.find(item => item.path === row.path);
      const raw = migrationHistorySourceBytes(bundle, row.path);
      if (!file || file.name !== row.name || file.order > evidence.baselineCount
        || file.gitRawSha256 !== row.sourceSha256 || raw.length !== row.sourceBytes || sha(raw) !== row.sourceSha256) throw new Error();
      const candidate = reproduce(row, raw);
      if (candidate && (candidate.length !== row.historyBytes || sha(candidate) !== row.historyStatementSha256)) throw new Error();
      return { ...row, localSourceBound: true, archivedRepresentationReproduced: candidate !== null,
        liveHistoryVerified: false, currentCatalogVerified: false, baselineAccepted: false,
        artifactReview: candidate ? 'REPRODUCED_BYTES_STILL_REQUIRE_REVIEW' : 'SEPARATE_ARTIFACT_REQUIRED' };
    });
    const result = { format: 'historical-baseline-review-design-v1', status: 'DESIGN_ONLY_NOT_ACCEPTED',
      evidenceSha256, sourceBundleSha256: bundle.bundleSha256, modelSource: bundle.modelSource,
      evidenceScope: evidence.evidenceScope, baselineCount: evidence.baselineCount,
      records, checks, references: evidence.references,
      baselineAccepted: false, executionAllowed: false, operationalApproval: false,
      DBHistoryVerified: false, fullStateVerified: false, remoteSourceVerified: false,
      liveObservationCollected: false, runtimeHistoryModel: false };
    return freeze({ ...result, designSha256: sha(JSON.stringify(result)) });
  } catch {
    // Never forward SQL, native paths/errors or forged input values.
    throw new Error('BASELINE_REVIEW_DESIGN_UNAVAILABLE');
  }
}
