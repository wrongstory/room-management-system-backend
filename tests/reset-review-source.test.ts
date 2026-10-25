import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { inspectResetReadOnlyReview, resetReviewEvidenceSql } from '../src/modules/developer-reset/snapshot-read-source.js';
import { reviewSourceHarness } from './helpers/reset-review-source.js';
describe('closed review collector composition with an inert connection port', () => {
  it('collects both observations and the existing STABLE sidecar inside the same RR then rolls back and closes', async () => {
    const h = reviewSourceHarness(); const result = await h.run();
    expect(result.review).toMatchObject({ reviewPrepared: true, receiptStatus: { status: 'PREPARED' }, executionEnabled: false, liveDatabaseVerified: false });
    expect(h.client.query.mock.calls).toHaveLength(14);
    expect(h.client.query.mock.calls.findIndex(([sql]) => sql === resetReviewEvidenceSql)).toBe(9);
    expect(h.client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK'); expect(h.client.close).toHaveBeenCalledOnce();
    expect(h.client.destroy).not.toHaveBeenCalled();
  });
  it.each(['snapshot', 'statement', 'template', 'extra'])('rejects a %s sidecar substitution instead of trusting its labels', async mode => {
    const h = reviewSourceHarness();
    if (mode === 'snapshot') h.state.scope = '200:300:';
    if (mode === 'statement') h.state.statementId = '1'.repeat(64);
    if (mode === 'template') h.f.sidecar.templateEvidence.snapshotId = '1'.repeat(64);
    if (mode === 'extra') h.state.mutate = value => ({ ...(value as object), authorized: true });
    expect((await h.run()).review).toBeNull();
  });
  it('returns no partial candidate after census mutation or connection close failure', async () => {
    for (const name of ['corruptContent', 'failClose'] as const) {
      const h = reviewSourceHarness(); h.state[name] = true;
      const result = await h.run(); expect(result.review).toBeNull(); expect(result.snapshotValid).toBe(false);
      expect(JSON.stringify(result)).not.toContain('private transport');
    }
  });
  it('rejects absent/malformed review intent before opening a connection', async () => {
    const h = reviewSourceHarness();
    expect((await inspectResetReadOnlyReview(h.source, undefined, h.open)).review).toBeNull();
    expect(h.open).not.toHaveBeenCalled();
  });
  it('parses the fixed read-only statement on PostgreSQL15/17 without executing SQL', async () => {
    const require = createRequire(import.meta.url);
    const { Parser } = require('@pgsql/parser');
    for (const version of [15, 17]) {
      const parser = new Parser({ version });
      expect(await parser.parse(resetReviewEvidenceSql)).toBeTruthy();
    }
  });
});
