import { describe, expect, it } from 'vitest';
import { resetReviewFixture, reviewId } from './helpers/reset-review.js';
import { RESET_HANDOVER_POLICY_FINGERPRINT } from '../src/modules/developer-reset/approved-handover-policy.js';
const required = <T>(v: T | undefined): T => { if (!v) throw new Error('fixture missing'); return v; };
function fixture() {
  const f = resetReviewFixture(), template = required(f.rows.find(r => r.relation === 'public.cleaning_template_versions'));
  const set = (name: string, val: string) => { required(template.values.find(c => c.name === name)).value = val; };
  set('created_at', '2026-01-01 00:00:00+00');
  set('version', '10');
  const old = structuredClone(template); old.key.forEach(c => { c.value = reviewId(16); });
  required(old.values.find(c => c.name === 'id')).value = reviewId(16);
  required(old.values.find(c => c.name === 'status')).value = 'retired';
  required(old.values.find(c => c.name === 'version')).value = '9';
  f.rows.push(old); f.sidecar.templateEvidence.templateCount++;
  f.sidecar.templateEvidence.templates.push({ ...required(f.sidecar.templateEvidence.templates[0]), sourceId: reviewId(16), status: 'retired', slotRows: 0 });
  const history = { sourceTemplateVersionId: reviewId(16), newTemplateVersionId: reviewId(6), plannedAt: '2025-12-01T00:00:00.000Z',
    registrationTime: '2026-01-01T00:00:00.000Z', version: 10, policyFingerprint: RESET_HANDOVER_POLICY_FINGERPRINT,
    commandHash: 'a'.repeat(64), payloadHash: 'b'.repeat(64) };
  f.push('public.audit_events', 80, { entity_id: reviewId(6), before_state: null, after_state: JSON.stringify(history) });
  const row = required(f.rows.find(r => r.relation === 'public.audit_events'));
  const fields = { event_type: ['text', 'cleaning_template.operational_handover'], entity_type: ['text', 'cleaning_template_version'],
    reason_code: ['text', 'OPERATIONAL_HANDOVER_INITIALIZATION'], actor_profile_id: ['uuid', reviewId(1)], actor_display_name_snapshot: ['text', null],
    request_id: ['text', null], request_hash: ['text', history.payloadHash], idempotency_key: ['text', `reset-template-handover:${history.commandHash}:${reviewId(6)}`],
    effective_at: ['timestamptz', '2026-01-01 00:00:00+00'], recorded_at: ['timestamptz', '2026-01-01 00:00:00.1+00'], created_at: ['timestamptz', '2026-01-01 00:00:00.1+00'] };
  const relation = required(f.metadata.relations.find(r => r.relation === row.relation));
  for (const [name, [type, value]] of Object.entries(fields)) {
    const cell = { name, pgType: `pg_catalog.${type}`, value: value ?? null }, existing = row.values.find(c => c.name === name);
    if (existing) existing.value = cell.value; else row.values.push(cell);
    if (!relation.columns.some(c => c.name === name)) relation.columns.push({ name, pgType: cell.pgType });
  }
  f.expected.relations = structuredClone(f.metadata.relations); f.refreshCensus();
  return { f, row, history, sync: () => { required(row.values.find(c => c.name === 'after_state')).value = JSON.stringify(history); f.refreshCensus(); } };
}
describe('same-capture preserved handover provenance (no DB)', () => {
  it('retains full historical JSON and explicit old/new template identities without current-pointer authority', async () => {
    const { f } = fixture(), result = await f.run();
    expect(result.review).toMatchObject({ reviewPrepared: true, logical: { logicalReferencesValid: true }, executionEnabled: false });
    expect(JSON.stringify(result)).not.toContain('sourceTemplateVersionId');
  });
  it.each(['reason', 'entity', 'source-missing', 'target-missing', 'source-remove', 'target-remove', 'same-id', 'actual-time', 'creator', 'body-extra', 'removed'] as const)
    ('keeps malformed %s provenance non-executable rather than dropping its protection', async mode => {
      const h = fixture();
      if (mode === 'reason') required(h.row.values.find(c => c.name === 'reason_code')).value = 'wrong';
      if (mode === 'entity') required(h.row.values.find(c => c.name === 'entity_id')).value = reviewId(91);
      if (mode === 'source-missing') h.history.sourceTemplateVersionId = reviewId(92);
      if (mode === 'target-missing') h.history.newTemplateVersionId = reviewId(92);
      if (mode === 'source-remove' || mode === 'target-remove') {
        const id = mode === 'source-remove' ? h.history.sourceTemplateVersionId : h.history.newTemplateVersionId;
        required(h.f.rows.find(r => r.relation === 'public.cleaning_template_versions' && r.values.some(c => c.name === 'id' && c.value === id))).disposition = 'remove';
      }
      if (mode === 'same-id') h.history.sourceTemplateVersionId = h.history.newTemplateVersionId;
      if (mode === 'actual-time') h.history.registrationTime = '2026-01-01T00:00:00.001Z';
      if (mode === 'creator') required(h.row.values.find(c => c.name === 'actor_profile_id')).value = reviewId(93);
      if (mode === 'body-extra') Object.assign(h.history, { futureAuthority: true });
      if (mode === 'removed') h.row.disposition = 'remove';
      h.sync(); const result = await h.f.run();
      expect(result.review).toBeNull(); expect(result.executionEnabled).toBe(false);
      expect(result.blockers.join(',')).toMatch(/RESET_REVIEW_HANDOVER_AUDIT/);
    });
});
