import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { readResetPreview, summarizeResetPreview } from '../src/modules/developer-reset/reset-preview.js';
import { resetRelationGroups } from '../src/modules/developer-reset/reset-preview-groups.js';

const id = '00000000-0000-4000-8000-000000000001';
const actor = { profileId: id, authUserId: id, role: 'developer', mustChangePassword: false };
function inventory() {
  return { format: 'reset-preview-inventory-v1', readOnly: true, capturedAt: '2026-10-25T00:00:00+00:00', snapshotId: 'a'.repeat(64),
    relations: Object.values(resetRelationGroups).flat().map(relation => ({ relation: relation as string, kind: 'r', partition: false, observedRows: 1 as number | null, exact: true })) };
}
function first<T>(rows: T[]) { const row = rows[0]; if (!row) throw new Error('missing fixture'); return row; }

describe('read-only developer reset inventory preview', () => {
  it('completes diagnostic collection independently of execution gates and excludes raw names', () => {
    const result = summarizeResetPreview(inventory());
    expect(result).toMatchObject({ diagnosticComplete: true, executionEnabled: false, readOnly: true, relationCount: 183,
      candidateImpact: { preserve: { relations: 3, observedRows: 3, exact: true }, mixed: { relations: 10 }, review: { relations: 125 } } });
    expect(result.blockers).toContain('RESET_RECOVERY_SCOPE_UNDECIDED');
    expect(result.blockers).toContain('PHOTO_DELETION_ON_HOLD');
    expect(JSON.stringify(result)).not.toContain('public.profiles');
  });
  it('marks bounded counts as lower bounds rather than exact totals', () => {
    const value = inventory(); first(value.relations).observedRows = 10001; first(value.relations).exact = false;
    expect(summarizeResetPreview(value)).toMatchObject({ diagnosticComplete: false, truncatedRelations: 1,
      candidateImpact: { preserve: { exact: false, observedRows: 10003 } } });
  });
  it('does not query or claim counts for foreign/partitioned relations', () => {
    const value = inventory(); const row = first(value.relations); row.kind = 'f'; row.observedRows = null; row.exact = false;
    expect(summarizeResetPreview(value)).toMatchObject({ diagnosticComplete: false, unsupportedRelations: 1,
      candidateImpact: { preserve: { exact: false } } });
  });
  it('reveals unknown/missing coverage without treating another table as a replacement', () => {
    const value = inventory(); first(value.relations).relation = 'private.unreviewed';
    expect(summarizeResetPreview(value)).toMatchObject({ diagnosticComplete: false, unknownRelations: 1, missingRelations: 1,
      candidateImpact: { preserve: { exact: false } } });
  });
  it.each([
    (value: ReturnType<typeof inventory>) => { value.relations.push(first(value.relations)); },
    (value: ReturnType<typeof inventory>) => { first(value.relations).observedRows = -1; },
    (value: ReturnType<typeof inventory>) => { first(value.relations).observedRows = 10001; },
    (value: ReturnType<typeof inventory>) => { first(value.relations).observedRows = null; },
    (value: ReturnType<typeof inventory>) => { first(value.relations).kind = 'f'; },
    (value: ReturnType<typeof inventory>) => { value.readOnly = false; },
    (value: ReturnType<typeof inventory>) => { value.capturedAt = '2026'; },
  ])('rejects inconsistent server inventories', change => {
    const value = inventory(); change(value);
    expect(() => summarizeResetPreview(value)).toThrow('RESET_PREVIEW_UNAVAILABLE');
  });
  it('binds verified identity/session to one fixed server RPC and validates output', async () => {
    const rpc = vi.fn(async () => ({ data: inventory(), error: null }));
    expect(await readResetPreview(rpc, actor, id)).toMatchObject({ diagnosticComplete: true, executionEnabled: false });
    expect(rpc).toHaveBeenCalledExactlyOnceWith('get_developer_reset_preview', { p_auth_user_id: id, p_actor_profile_id: id, p_session_id: id }, expect.any(AbortSignal));
  });
  it.each(['admin', 'maid'])('denies %s before collection', async role => {
    const rpc = vi.fn(); await expect(readResetPreview(rpc, { ...actor, role }, id)).rejects.toMatchObject({ status: 403 });
    expect(rpc).not.toHaveBeenCalled();
  });
  it('denies password/session changes and sanitizes provider errors', async () => {
    const rpc = vi.fn();
    await expect(readResetPreview(rpc, { ...actor, mustChangePassword: true }, id)).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    await expect(readResetPreview(rpc, actor, 'invalid')).rejects.toMatchObject({ code: 'INVALID_ACCESS_TOKEN' });
    expect(rpc).not.toHaveBeenCalled();
    await expect(readResetPreview(async () => ({ data: inventory(), error: { code: '42501', message: 'sensitive' } }), actor, id))
      .rejects.toMatchObject({ status: 403, message: 'RESET_PREVIEW_AUTHORIZATION_FAILED' });
    await expect(readResetPreview(async () => { throw new Error('sensitive'); }, actor, id))
      .rejects.toMatchObject({ status: 503, message: 'RESET_PREVIEW_UNAVAILABLE' });
    await expect(readResetPreview(async () => ({ data: { ...inventory(), raw: 'sensitive' }, error: null }), actor, id))
      .rejects.toMatchObject({ status: 503, message: 'RESET_PREVIEW_UNAVAILABLE' });
  });
  it('keeps generated platform contracts identical', () => {
    expect(() => execFileSync(process.execPath, ['scripts/generate-reset-preview-edge.mjs', '--check'])).not.toThrow();
  });
  it('aborts and fails closed when the collector ignores cancellation or reports a statement timeout', async () => {
    vi.useFakeTimers();
    try {
      const rpc = vi.fn((_name: string, _args: Record<string, unknown>, _signal: AbortSignal) => new Promise<{ data: unknown; error: unknown }>(() => {}));
      const pending = readResetPreview(rpc, actor, id);
      const check = expect(pending).rejects.toMatchObject({ code: 'RESET_PREVIEW_TIMEOUT', status: 503 });
      await vi.advanceTimersByTimeAsync(8000); await check;
      expect(rpc.mock.calls[0]?.[2].aborted).toBe(true);
      await expect(readResetPreview(async () => ({ data: inventory(), error: { code: '57014' } }), actor, id))
        .rejects.toMatchObject({ code: 'RESET_PREVIEW_TIMEOUT' });
    } finally { vi.useRealTimers(); }
  });
  it('enforces safe SQL source boundaries without executing SQL', () => {
    const sql = readFileSync('supabase/migrations/20261025021139_developer_reset_preview.sql', 'utf8');
    expect(sql).toContain('stable security definer set search_path = pg_catalog');
    expect(sql).toContain('volatile security definer set search_path = pg_catalog');
    expect(sql).toContain('for pass in 1..2 loop');
    expect(sql).toContain("set statement_timeout = '7s'");
    expect(sql.match(/clock_timestamp\(\) >= deadline/g)).toHaveLength(2);
    expect(sql).toContain("deadline timestamptz := clock_timestamp()+interval '5 seconds'");
    expect(sql).toContain('public.get_active_auth_context(p_auth_user_id,p_session_id)');
    expect(sql).toContain("select count(*) from (select 1 from only %I.%I limit 10001) bounded");
    expect(sql).toContain("r.relkind='r' and not r.relispartition");
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/\b(?:delete\s+from|insert\s+into|update\s+(?:public|private|auth)\.|truncate|alter\s+table|disable\s+trigger)\b/i);
  });
});
