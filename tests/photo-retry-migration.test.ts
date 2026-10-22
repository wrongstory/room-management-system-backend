import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// Source guard only; this is explicitly NOT live SQL/role/concurrency validation.
it('keeps pre-provider release fenced, authenticated, non-destructive and service-only', () => {
  const sql = readFileSync('supabase/migrations/20261021142440_photo_upload_pre_provider_retry.sql', 'utf8');
  for (const guard of ['assert_admitted_photo_operation', 'actor_profile_id=p_actor_profile_id',
    'assert_photo_upload_actor', 'for update', 'assert_photo_operation_session',
    's.lease_version is distinct from p_lease_version', 's.lease_claim_digest is distinct from p_claim_digest',
    "s.status<>'reserved'", 'private.photo_upload_acceptances', 'private.photo_drive_identities',
    'provider_locator is not null or uploaded_at is not null', 'from public,anon,authenticated',
    'to service_role']) expect(sql).toContain(guard);
  expect(sql).toContain('lease_expires_at=clock_timestamp(),revision=revision+1');
  expect(sql).not.toMatch(/delete from|truncate|disable trigger|lease_version\s*=/i);
});
