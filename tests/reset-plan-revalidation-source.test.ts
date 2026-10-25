import { afterEach, describe, expect, it } from 'vitest';
import { createResetPlanRevalidation } from '../src/modules/developer-reset/plan-revalidation.js';
import { resetReviewStatementId } from '../src/modules/developer-reset/review-composition.js';
import { reviewSourceHarness } from './helpers/reset-review-source.js';

const owners: ReturnType<typeof createResetPlanRevalidation>[] = [];
afterEach(() => { for (const owner of owners) owner.dispose(); owners.length = 0; });
const required = <T>(value: T | undefined | null): T => { if (value === undefined || value === null) throw new Error('fixture missing'); return value; };
function fixture() {
  const h = reviewSourceHarness(), owner = createResetPlanRevalidation({ expiresAt: h.f.request.receipt.expiresAt }); owners.push(owner);
  const secondSnapshot = () => {
    h.state.identitySnapshot = '200:300:201'; h.state.scope = h.state.identitySnapshot;
    h.state.statementId = resetReviewStatementId(h.state.scope, h.f.sidecar.statementAt);
    h.f.sidecar.templateEvidence.snapshotId = h.state.statementId;
  };
  return { ...h, owner, secondSnapshot, prepare: () => owner.prepare(h.source, h.f.request, h.open),
    recheck: () => owner.recheck(h.source, h.f.request, h.open) };
}
describe('reset plan revalidation through the real closed collector (no DB)', () => {
  it('matches fresh RR scopes and ephemeral row identities while retaining the original plan allocations', async () => {
    const h = fixture(); const first = await h.prepare(); expect(first.status).toBe('PREPARED'); h.secondSnapshot();
    const next = await h.recheck(); expect(next.status).toBe('MATCHED'); expect(next.summary).toEqual(first.summary);
    expect(next.summary?.blockers).toContain('RESET_REVIEW_FULL_COVERAGE_NOT_VERIFIED');
    expect(h.owner.consume(required(first.summary).commitment).status).toBe('CONSUMED');
    expect(h.client.close).toHaveBeenCalledTimes(2); expect(h.client.destroy).not.toHaveBeenCalled();
    expect(h.client.query.mock.calls.filter(([sql]) => sql === 'ROLLBACK')).toHaveLength(2);
    for (const value of ['synthetic_file_secret', 'synthetic_folder_secret', 'synthetic private slot', h.f.rows[0]?.key[0]?.value]) {
      if (value) expect(JSON.stringify(next)).not.toContain(value);
    }
  });
  it.each(['same-count-content', 'same-count-key', 'photo-hold', 'new-receipt', 'template-content', 'independent-census'])
    ('blocks %s changes without deciding preservation exceptions', async change => {
      const h = fixture(); expect((await h.prepare()).status).toBe('PREPARED'); h.secondSnapshot();
      const photo = required(h.f.rows.find(row => row.relation === 'private.photo_drive_identities'));
      if (change === 'same-count-content') required(photo.values.find(cell => cell.name === 'provider_file_id')).value = 'changed-private-locator';
      if (change === 'same-count-key') {
        const value = '00000000-0000-4000-8000-000000000050'; required(photo.key[0]).value = value;
        required(photo.values.find(cell => cell.name === 'id')).value = value;
      }
      if (change === 'photo-hold') photo.disposition = 'remove';
      if (change === 'new-receipt') h.f.push('private.developer_reset_receipt_heads', 50, {
        actor_profile_id: '00000000-0000-4000-8000-000000000001', binding: '{}', header: '{}' });
      if (change === 'template-content') {
        const template = required(h.f.rows.find(row => row.relation === 'public.cleaning_template_versions'));
        required(template.values.find(cell => cell.name === 'duration_minutes')).value = '31';
      }
      h.f.refreshCensus(); if (change === 'independent-census') h.state.corruptContent = true;
      expect((await h.recheck()).status).toBe('REJECTED');
      const calls = h.client.query.mock.calls.length; expect((await h.recheck()).status).toBe('REJECTED');
      expect(h.client.query).toHaveBeenCalledTimes(calls);
    });
  it('blocks changed selection/actor/source intent before opening a second connection', async () => {
    for (const change of ['selection', 'actor', 'source'] as const) {
      const h = fixture(); await h.prepare();
      if (change === 'selection') h.f.request.templateSelection = 'ALL_VERSIONS';
      if (change === 'actor') h.f.request.receipt.actorProfileId = '00000000-0000-4000-8000-000000000050';
      if (change === 'source') h.source.binding.sourceCommit = 'f'.repeat(40);
      expect((await h.recheck()).status).toBe('REJECTED'); expect(h.open).toHaveBeenCalledOnce();
    }
  });
  it('rejects cancelled collection and later reuse without reporting a rollback proof', async () => {
    const h = fixture(); await h.prepare(); const control = new AbortController(); control.abort();
    const result = await h.owner.recheck(h.source, h.f.request, h.open, control.signal);
    expect(result).toMatchObject({ status: 'REJECTED', revalidated: false, executionEnabled: false });
    expect((await h.recheck()).status).toBe('REJECTED');
  });
});
