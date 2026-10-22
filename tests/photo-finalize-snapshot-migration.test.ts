import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the combined RPC service-only and delegates all existing guards (source only, not SQL validation)', () => {
  const sql = readFileSync('supabase/migrations/20261022041603_photo_finalize_snapshot.sql', 'utf8');
  expect(sql).toContain("volatile security invoker set search_path=''");
  expect(sql).toContain('from public,anon,authenticated');
  expect(sql).toContain('to service_role');
  expect(sql).toContain("(result->>'attemptId')::uuid");
  expect(sql.indexOf('result := public.finalize_admitted_photo_upload')).toBeLessThan(sql.indexOf('    begin'));
  expect(sql).toContain('snapshot := public.get_attempt_photo_slots');
  expect(sql).toContain('exception when others then\n      snapshot := null;');
  expect(sql).not.toMatch(/security definer|insert into|update private|delete from|record_admitted_photo_provider_success|when query_canceled/i);
});
