import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const initialMigrationUrl = new URL(
  '../supabase/migrations/20260825141441_initial_core_schema.sql',
  import.meta.url
);

const hardeningMigrationUrl = new URL(
  '../supabase/migrations/20260825163315_harden_data_api_grants.sql',
  import.meta.url
);

const accountMigrationUrl = new URL(
  '../supabase/migrations/20260826021457_account_lifecycle_contract.sql',
  import.meta.url
);

const accountHardeningMigrationUrl = new URL(
  '../supabase/migrations/20260826023016_harden_account_command_idempotency.sql',
  import.meta.url
);
const domainIntegrityMigrationUrl = new URL(
  '../supabase/migrations/20260826114731_harden_domain_integrity.sql',
  import.meta.url
);
const domainIndexMigrationUrl = new URL(
  '../supabase/migrations/20260826115804_add_domain_integrity_indexes.sql',
  import.meta.url
);

const notificationGrantMigrationUrl = new URL(
  '../supabase/migrations/20260827211304_restrict_notification_recipient_updates.sql',
  import.meta.url
);

describe('initial migration contract', () => {
  it('seeds 121 unique room numbers', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const catalogSection = sql.slice(sql.indexOf('with catalog('), sql.indexOf('insert into public.rooms'));
    const roomNumbers = [...catalogSection.matchAll(/\('([0-9]+)','(?:standard|premium|oceanPremium|oceanFamily)'/g)]
      .map((match) => match[1]);

    expect(roomNumbers).toHaveLength(121);
    expect(new Set(roomNumbers).size).toBe(121);
  });

  it('enables RLS for every public base table', async () => {
    const sql = [
      await readFile(initialMigrationUrl, 'utf8'),
      await readFile(accountMigrationUrl, 'utf8'),
      await readFile(accountHardeningMigrationUrl, 'utf8'),
      await readFile(domainIntegrityMigrationUrl, 'utf8'),
      await readFile(domainIndexMigrationUrl, 'utf8')
    ].join('\n');
    const tables = [...sql.matchAll(/create table public\.([a-z_]+)/g)].map((match) => match[1]);
    const rlsTables = [...sql.matchAll(/alter table public\.([a-z_]+) enable row level security/g)]
      .map((match) => match[1]);

    expect(new Set(rlsTables)).toEqual(new Set(tables));
  });

  it('keeps business state mutations behind the server command boundary', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const authenticatedGrants = sql.slice(
      sql.indexOf('revoke all privileges on all tables in schema public'),
      sql.indexOf('-- The backend secret')
    );

    expect(authenticatedGrants).not.toMatch(/grant (insert|delete)\b/);
    expect(authenticatedGrants).not.toContain('grant update on');
    expect(authenticatedGrants).toContain('grant update (read_at, resolved_at)');
    expect(sql).not.toContain('auth.role()');
    expect(sql).not.toContain('user_metadata');
    expect(sql).toContain(
      'revoke all privileges on all tables in schema public from anon, authenticated'
    );
  });

  it('stores only Drive photo metadata with a 300 KiB and seven-day policy', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');
    const authenticatedGrants = sql.slice(
      sql.indexOf('revoke all privileges on all tables in schema public'),
      sql.indexOf('-- The backend secret')
    );

    expect(sql).toContain('drive_file_id text not null unique');
    expect(sql).toContain('size_bytes > 0 and size_bytes <= 307200');
    expect(sql).toContain("new.purge_after = new.uploaded_at + interval '7 days'");
    expect(sql).not.toContain('insert into storage.buckets');
    expect(authenticatedGrants).not.toContain('public.submission_photos');
  });

  it('hardens existing projects that auto-expose Data API privileges', async () => {
    const sql = await readFile(hardeningMigrationUrl, 'utf8');

    expect(sql).toContain('revoke all on schema public from public, anon, authenticated');
    expect(sql).toContain('revoke all privileges on all tables in schema public');
    expect(sql).toContain('alter default privileges for role postgres in schema public');
    expect(sql).toContain('drop policy if exists notifications_read_scoped');
    expect(sql).toContain('create policy notifications_read_scoped');
  });

  it('locks after five failures for a fixed fifteen-minute window', async () => {
    const sql = await readFile(initialMigrationUrl, 'utf8');

    expect(sql).toContain("when p.locked_until is not null and p.locked_until <= now() then 1");
    expect(sql).toContain(") >= 5 then now() + interval '15 minutes'");
    expect(sql).toContain('set failed_login_count = 0, locked_until = null');
  });

  it('keeps account lifecycle commands service-only and protects the last admin', async () => {
    const sql = await readFile(accountMigrationUrl, 'utf8');

    expect(sql).toContain("message = 'LAST_ACTIVE_ADMIN_REQUIRED'");
    expect(sql).toContain("event_type = 'account.created'");
    expect(sql).toContain("grant execute on function public.create_account_profile(");
    expect(sql).toContain('to service_role');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('delete from auth.sessions where user_id = v_result.auth_user_id');
    expect(sql).toContain('create function public.is_active_auth_session');
  });

  it('renames the first duplicate login id and retires its old alias on new-id login', async () => {
    const sql = await readFile(accountMigrationUrl, 'utf8');

    expect(sql).toContain("login_id = p_display_name || '1'");
    expect(sql).toContain('set expires_after_new_login = true');
    expect(sql).toContain('and p.login_id_normalized = p_login_alias_normalized');
    expect(sql).toContain('set active = false, retired_at = now()');
  });

  it('guards idempotency keys and allows only a one-time first admin bootstrap', async () => {
    const sql = await readFile(accountHardeningMigrationUrl, 'utf8');

    expect(sql).toContain("message = 'IDEMPOTENCY_KEY_REUSED'");
    expect(sql).toContain('before insert on public.audit_events');
    expect(sql).toContain("message = 'FIRST_ADMIN_ALREADY_EXISTS'");
    expect(sql).toContain('create function public.bootstrap_first_admin_profile');
    expect(sql).toContain('to service_role');
    expect(sql).toContain('from public, anon, authenticated');
  });

  it('hardens cross-table cleaning and payroll integrity', async () => {
    const sql = await readFile(domainIntegrityMigrationUrl, 'utf8');
    const indexSql = await readFile(domainIndexMigrationUrl, 'utf8');

    expect(sql).toContain('drop index public.cleaning_targets_one_active_per_room');
    expect(sql).toContain('cleaning_targets_one_checkout_per_reservation');
    expect(sql).toContain('cleaning_attempts_assignment_contract_fk');
    expect(sql).toContain('cleaning_submissions_attempt_maid_fk');
    expect(sql).toContain('earnings_submission_maid_fk');
    expect(sql).toContain('drop column reclean_compensation_decision_id');
    expect(sql).toContain('earnings_bomb_bonus_exact_check');
    expect(sql).toContain('drop column locked_earning_ids');
    expect(sql).toContain('create table public.payroll_items');
    expect(sql).toContain('earning_id uuid not null unique');
    expect(sql).toContain('alter table public.payroll_items enable row level security');
    expect(indexSql).toContain('create policy login_aliases_read_scoped');
    expect(indexSql).toContain('cleaning_attempts_assignment_contract_idx');
    expect(indexSql).toContain('payroll_items_earning_maid_idx');
  });

  it('allows recipients to update read_at but not resolve notifications', async () => {
    const sql = await readFile(notificationGrantMigrationUrl, 'utf8');

    expect(sql).toContain(
      'revoke update (read_at, resolved_at) on public.notifications from authenticated'
    );
    expect(sql).toContain('grant update (read_at) on public.notifications to authenticated');
    expect(sql).not.toContain('grant update (read_at, resolved_at)');
  });
});
