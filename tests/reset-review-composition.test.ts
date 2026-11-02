import { describe, expect, it } from 'vitest';
import { createResetSnapshotBuilder } from '../src/modules/developer-reset/snapshot-builder.js';
import { RESET_TEMPLATE_REFERENCE_PATHS } from '../src/modules/developer-reset/reset-template-evidence.js';
import { composeResetReview } from '../src/modules/developer-reset/review-composition.js';
import { resetReviewFixture, reviewId, reviewStream } from './helpers/reset-review.js';
const required = <T>(v: T | undefined): T => { if (v === undefined) throw new Error('fixture missing'); return v; };

describe('same-snapshot internal review composition (no DB or effects)', () => {
  it('connects the real content/registry/template/gate/receipt components without releasing raw capture or execution authority', async () => {
    const f = resetReviewFixture(), result = await f.run();
    expect(result.review).toMatchObject({ reviewPrepared: true, contentVerified: true, executionEnabled: false,
      liveDatabaseVerified: false, completeResetCoverage: false, logical: { logicalReferencesValid: true },
      templates: { proposal: { generated: true, counts: { inventory: 1, selected: 1, historicalReferences: 2 } } },
      receiptStatus: { valid: true, status: 'PREPARED', executionEnabled: false } });
    expect(result.snapshotValid).toBe(false);
    expect(result.review?.blockers).toEqual(expect.arrayContaining(['RESET_ROOM_BASELINE_DISPOSITION_UNRESOLVED',
      'RESET_TEMPLATE_DISPOSITION_UNRESOLVED', 'ADMISSION_COVERAGE_NOT_INTEGRATED', 'TEMPLATE_HISTORY_PROTECTION_REQUIRED']));
    const encoded = JSON.stringify(result);
    for (const raw of [reviewId(1), reviewId(6), 'synthetic', 'rowToken', 'originalProvenance', 'slotKey']) expect(encoded).not.toContain(raw);
  });
  it('has no implicit template selection, receipt TTL, publishing or preservation policy', async () => {
    const f = resetReviewFixture(); f.request.templateSelection = null; f.request.developerId = null;
    const result = await createResetSnapshotBuilder(f.expected).buildReview(f.source, { ...f.request, receipt: null });
    expect(result.review).toMatchObject({ reviewPrepared: true, templates: { proposal: null }, receipt: null });
    expect(result.review?.blockers).toEqual(expect.arrayContaining(['RESET_REVIEW_TEMPLATE_SELECTION_REQUIRED', 'RESET_REVIEW_RECEIPT_INTENT_REQUIRED']));
  });
  it('rejects missing/duplicate/unknown surface inventory even if its count is zero', async () => {
    const missing = resetReviewFixture(); missing.request.surfaces.pop();
    expect((await missing.run()).blockers).toContain('RESET_REVIEW_SURFACE_INVENTORY_INCOMPLETE');
    const duplicate = resetReviewFixture(); duplicate.request.surfaces.push({ ...required(duplicate.request.surfaces[0]) });
    expect((await duplicate.run()).review?.logical.blockers).toContain('LOGICAL_REFERENCE_DUPLICATE_SURFACE');
    const unknown = resetReviewFixture(); unknown.request.surfaces.push({ relation: 'private.photo_storage_names', path: 'unreviewed' });
    expect((await unknown.run()).review?.logical.blockers).toContain('LOGICAL_REFERENCE_UNREGISTERED_SURFACE');
  });
  it.each([
    ['RESET_REVIEW_MIXED_SCOPE', (f: ReturnType<typeof resetReviewFixture>) => { f.sidecar.scopeId = '0'.repeat(64); }],
    ['RESET_REVIEW_GATE_CONTROL_DRIFT', (f: ReturnType<typeof resetReviewFixture>) => { Object.assign(f.sidecar.gateEvidence, { policyConfigured: true, controlVersion: '1', maintenance: 'REQUESTED' }); }],
    ['RESET_REVIEW_GATE_CENSUS_DRIFT', (f: ReturnType<typeof resetReviewFixture>) => { f.sidecar.gateEvidence.unfinishedAdmissions = 1; }],
    ['CENSUS_CONTENT_MISMATCH', (f: ReturnType<typeof resetReviewFixture>) => { const c = required(f.census.find(c => c.header.relation === 'private.photo_drive_identities')); required(required(c.contents[0]).values[1]).value = 'changed_provider_secret'; }],
    ['RESET_SNAPSHOT_MIXED_SCOPE', (f: ReturnType<typeof resetReviewFixture>) => { required(f.census[0]).header.scopeId = '0'.repeat(64); }],
    ['MISSING_RELATION_COUNT', (f: ReturnType<typeof resetReviewFixture>) => { f.census.pop(); }],
  ])('refuses a partial composition for %s', async (code, change) => {
    const f = resetReviewFixture(); change(f); const result = await f.run();
    expect(result.review).toBeNull(); expect(result.blockers).toContain(code);
  });
  it('rejects arbitrary coverage/authorization booleans or unbound template sidecars', async () => {
    for (const field of ['executionEnabled', 'coverage', 'snapshotId']) {
      const f = resetReviewFixture();
      if (field === 'snapshotId') f.sidecar.templateEvidence.snapshotId = '0'.repeat(64);
      else Object.assign(f.sidecar.gateEvidence, { [field]: true });
      expect((await f.run()).review).toBeNull();
    }
  });
  it('does not mint a reusable capture or permit builder replay', async () => {
    const f = resetReviewFixture(); const builder = createResetSnapshotBuilder(f.expected);
    const first = await builder.buildReview(f.source, f.request);
    const second = await builder.buildReview(f.source, f.request);
    expect(first.review?.receiptStatus?.status).toBe('PREPARED');
    expect(second).toMatchObject({ review: null, blockers: ['RESET_SNAPSHOT_BUILDER_CLOSED'] });
    expect((await f.run()).review?.contentFingerprint).not.toBe(first.review?.contentFingerprint);
  });
  it('captures intent and sidecars before asynchronously yielded row mutation', async () => {
    const f = resetReviewFixture();
    const source = { collect: async () => ({ metadata: f.metadata, review: f.sidecar,
      rows: (async function* () { f.request.templateSelection = null; f.sidecar.scopeId = '0'.repeat(64); yield* reviewStream(f.rows); })(),
      census: reviewStream(f.census.map(c => ({ header: c.header, contents: reviewStream(c.contents) }))) }) };
    const result = await createResetSnapshotBuilder(f.expected).buildReview(source, f.request);
    expect(result.review?.templates.proposal?.generated).toBe(true);
  });
  it('refuses source accessors rather than invoking untrusted getters', async () => {
    const f = resetReviewFixture(); let called = false;
    Object.defineProperty(f.sidecar, 'scopeId', { get: () => { called = true; return 'd'.repeat(64); }, enumerable: true });
    expect((await f.run()).review).toBeNull(); expect(called).toBe(false);
  });
  it.each(['MISSING_REFERENCE', 'DUPLICATE_REFERENCE', 'MISSING_TARGET_ROW', 'MATCH_FULL_PARTIAL_NULL', 'NULL_EDGE_MISMATCH'])
    ('does not skip technical %s verification when dispositions remain undecided', async code => {
      const f = resetReviewFixture();
      const fk = { source: 'public.profiles', target: 'auth.users', name: 'profiles_auth_fkey', sourceNullable: [true, true], match: 's' as 's' | 'f', validated: true as const };
      f.metadata.foreignKeys.push(fk); f.expected.foreignKeys.push(structuredClone(fk));
      const profile = required(f.rows.find(r => r.relation === 'public.profiles'));
      const auth = required(f.rows.find(r => r.relation === 'auth.users'));
      const ref = { constraint: fk.name, targetKey: structuredClone(auth.key) as typeof auth.key | null, sourceNulls: [false, false] };
      if (code !== 'MISSING_REFERENCE') profile.references.push(ref);
      if (code === 'DUPLICATE_REFERENCE') profile.references.push(structuredClone(ref));
      if (code === 'MISSING_TARGET_ROW') required(required(ref.targetKey ?? [])[0]).value = reviewId(999);
      if (code === 'MATCH_FULL_PARTIAL_NULL') {
        fk.match = 'f'; required(f.expected.foreignKeys[0]).match = 'f'; ref.sourceNulls = [true, false]; ref.targetKey = null;
      }
      if (code === 'NULL_EDGE_MISMATCH') ref.targetKey = null;
      const result = await f.run();
      expect(result.review).toBeNull();
      expect(result.blockers).toEqual(expect.arrayContaining([code, 'RESET_TEMPLATE_DISPOSITION_UNRESOLVED', 'RESET_ROOM_BASELINE_DISPOSITION_UNRESOLVED']));
    });
  it('keeps exact microsecond expiry and unresolved Auth counts separate from zero-drain claims', async () => {
    const f = resetReviewFixture();
    f.push('private.developer_operation_admissions', 20, { completed_at: null, deadline_at: '2026-10-25 01:02:03.123456+00' });
    f.push('private.developer_operation_admissions', 21, { completed_at: null, deadline_at: '2026-10-25 01:02:03.123457+00' });
    f.push('private.password_change_commands', 22, { state: 'auth_pending', actor_profile_id: reviewId(1) });
    f.push('private.password_reset_auth_markers', 23, { state: 'prepared', actor_profile_id: reviewId(1) }); f.refreshCensus();
    Object.assign(f.sidecar.gateEvidence, { unfinishedAdmissions: 2, expiredUnfinishedAdmissions: 1, unresolvedPasswordChanges: 1, preparedPasswordResets: 1 });
    const good = await f.run();
    expect(good.review?.gates).toMatchObject({ unfinishedAdmissions: 2, expiredUnfinishedAdmissions: 1, unresolvedPasswordChanges: 1, preparedPasswordResets: 1 });
    expect(good.review?.blockers).toEqual(expect.arrayContaining(['ADMISSION_EFFECT_UNKNOWN', 'AUTH_OPERATION_NOT_DRAINED']));
    f.sidecar.gateEvidence.expiredUnfinishedAdmissions = 2;
    expect((await f.run()).blockers).toContain('RESET_REVIEW_GATE_CENSUS_DRIFT');
  });
  it('does not authorize a retained current pointer into a selected removed row', async () => {
    const f = resetReviewFixture(); f.push('private.developer_catalog_previews', 24, {
      actor_profile_id: reviewId(1), preview_kind: 'room_type_capacity', entity_id: reviewId(4) });
    required(f.rows.find(r => r.relation === 'public.room_types')).disposition = 'remove'; f.refreshCensus();
    const result = await f.run(); expect(result.review?.logical.blockers).toContain('LOGICAL_REFERENCE_PRESERVED_TO_REMOVED');
    expect(result.review?.receipt).toBeNull();
  });
  it('preserves source135 journal bytes and detached actor provenance without creating a current target', async () => {
    const f = resetReviewFixture();
    f.push('private.developer_reset_receipt_heads', 30, { actor_profile_id: reviewId(999), binding: '{"actorProfileId":"removed-actor","historical":9007199254740993}', header: '{"old":"historical-header"}' });
    f.push('private.developer_reset_receipt_events', 31, { receipt_id: reviewId(30), sequence: '1', entry: '{"event":{"type":"STARTED"},"untrustedHistoricalField":true}' });
    const fk = { source: 'private.developer_reset_receipt_events', target: 'private.developer_reset_receipt_heads',
      name: 'receipt_events_receipt_fk', sourceNullable: [false], match: 's' as const, validated: true as const };
    f.metadata.foreignKeys.push(fk); f.expected.foreignKeys.push(structuredClone(fk));
    required(f.rows.find(r => r.relation === fk.source)).references.push({ constraint: fk.name,
      targetKey: structuredClone(required(f.rows.find(r => r.relation === fk.target)).key), sourceNulls: [false] });
    f.refreshCensus();
    const good = await f.run();
    expect(good.review?.logical).toMatchObject({ logicalReferencesValid: true, completeResetCoverage: false, counts: { historicalSnapshots: 6 } });
    expect(JSON.stringify(good)).not.toContain('removed-actor'); expect(JSON.stringify(good)).not.toContain('9007199254740993');
    const c = required(f.census.find(c => c.header.relation === 'private.developer_reset_receipt_events'));
    required(required(c.contents[0]).values.find(c => c.name === 'entry')).value = '{"event":{"type":"FINAL_VERIFIED"}}';
    expect((await f.run()).blockers).toContain('CENSUS_CONTENT_MISMATCH');
  });
  it('rejects a partial seven-path template sidecar rather than trusting referencesComplete', async () => {
    const f = resetReviewFixture(); f.sidecar.templateEvidence.references.pop();
    expect((await f.run()).review).toBeNull();
  });
  it('preserves the existing strict keep/remove plan contract instead of upgrading pending review to valid', async () => {
    const f = resetReviewFixture(); const result = await f.run();
    expect(result).toMatchObject({ snapshotValid: false, fingerprint: null, counts: null });
    expect(result.review?.completeResetCoverage).toBe(false);
  });
  it.each(['actor', 'auth', 'role', 'status', 'password'])('rejects divergent %s provenance within the same content snapshot', async mode => {
    const f = resetReviewFixture();
    if (mode === 'actor') f.request.receipt.actorProfileId = reviewId(999);
    else if (mode === 'auth') f.request.receipt.authUserId = reviewId(999);
    else {
      const profile = required(f.rows.find(r => r.relation === 'public.profiles'));
      const column = mode === 'password' ? 'must_change_password' : mode;
      required(profile.values.find(c => c.name === column)).value = mode === 'role' ? 'admin' : mode === 'status' ? 'inactive' : 'true';
      f.refreshCensus();
    }
    const result = await f.run(); expect(result.review).toBeNull();
    expect(result.blockers).toContain(mode === 'actor' || mode === 'auth' ? 'RESET_REVIEW_ACTOR_MISMATCH' : 'RESET_REVIEW_ACTOR_UNAVAILABLE');
  });
  it('freezes both the seven-path inventory and each path tuple', () => {
    expect(Object.isFrozen(RESET_TEMPLATE_REFERENCE_PATHS)).toBe(true);
    expect(RESET_TEMPLATE_REFERENCE_PATHS.every(Object.isFrozen)).toBe(true);
  });
  it('does not treat multiple developer identities as the singleton platform actor', async () => {
    const f = resetReviewFixture();
    f.push('public.profiles', 45, { auth_user_id: reviewId(2), role: 'developer', status: 'active', must_change_password: 'false' }); f.refreshCensus();
    expect((await f.run()).blockers).toContain('RESET_REVIEW_ACTOR_UNAVAILABLE');
  });
  it.each(['forged-class', 'clone', 'native', 'cause'])('masks a %s provider error instead of treating class/message as an owned diagnostic', async kind => {
    const f = resetReviewFixture(); const secret = 'synthetic-sensitive-provider-error';
    class ResetReviewFailure extends Error {}
    const error = kind === 'forged-class' ? new ResetReviewFailure(secret)
      : kind === 'clone' ? { name: 'ResetReviewFailure', message: secret }
        : kind === 'cause' ? new Error('failure', { cause: secret }) : new Error(secret);
    const result = await createResetSnapshotBuilder(f.expected).buildReview({ collect: async () => { throw error; } }, f.request);
    expect(result.blockers).toEqual(['RESET_SNAPSHOT_SOURCE_UNAVAILABLE']);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('forwards only the private immutable error code even if the error object was changed', async () => {
    const f = resetReviewFixture(); let captured: unknown;
    try {
      composeResetReview({ request: f.request, binding: { ...f.expected.binding, snapshotId: '1'.repeat(64), contentFingerprint: '2'.repeat(64) },
        scopeId: '0'.repeat(64), relations: [], rows: [], independent: [], census: [], sidecar: f.sidecar, pending: [] });
    } catch (error) { captured = error; }
    if (!(captured instanceof Error)) throw new Error('expected owned failure');
    captured.message = 'synthetic-sensitive-provider-error';
    const result = await createResetSnapshotBuilder(f.expected).buildReview({ collect: async () => { throw captured; } }, f.request);
    expect(result.blockers).toEqual(['RESET_REVIEW_MIXED_SCOPE']);
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive');
  });
});
