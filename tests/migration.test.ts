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
const roomReservationMigrationUrl = new URL(
  '../supabase/migrations/20260827224644_room_reservation_commands.sql',
  import.meta.url
);

const availabilityMigrationUrl = new URL(
  '../supabase/migrations/20260828220417_weekly_availability_contract.sql',
  import.meta.url
);

const developerRoleMigrationUrl = new URL(
  '../supabase/migrations/20260829120003_add_developer_role.sql',
  import.meta.url
);

const developerContractMigrationUrl = new URL(
  '../supabase/migrations/20260829120005_developer_account_contract.sql',
  import.meta.url
);

const edgeLoginRateLimitMigrationUrl = new URL(
  '../supabase/migrations/20260830015035_edge_login_rate_limit.sql',
  import.meta.url
);

const accountReceiptHardeningMigrationUrl = new URL(
  '../supabase/migrations/20260830045832_harden_account_receipts_and_login_limits.sql',
  import.meta.url
);
const clientIsolationMigrationUrl = new URL(
  '../supabase/migrations/20260830054446_isolate_login_rate_limit_clients.sql',
  import.meta.url
);
const developerOperationsMigrationUrl = new URL(
  '../supabase/migrations/20260830123241_developer_operations_projections.sql',
  import.meta.url
);
const actorActivityMigrationUrl = new URL(
  '../supabase/migrations/20260831124140_actor_activity_audit_contract.sql',
  import.meta.url
);
const assignmentCoreMigrationUrl = new URL(
  '../supabase/migrations/20260903102758_assignment_core.sql',
  import.meta.url
);
const assignmentCommitMigrationUrl = new URL(
  '../supabase/migrations/20260903141742_assignment_commit.sql',
  import.meta.url
);
const assignmentAttemptActivationMigrationUrl = new URL(
  '../supabase/migrations/20260905002657_assignment_attempt_activation.sql',
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
      await readFile(domainIndexMigrationUrl, 'utf8'),
      await readFile(roomReservationMigrationUrl, 'utf8'),
      await readFile(availabilityMigrationUrl, 'utf8')
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

  it('separates the singleton developer from business administrators', async () => {
    const roleSql = await readFile(developerRoleMigrationUrl, 'utf8');
    const contractSql = await readFile(developerContractMigrationUrl, 'utf8');

    expect(roleSql).toContain("add value if not exists 'developer'");
    expect(contractSql).toContain('profiles_singleton_developer_idx');
    expect(contractSql).toContain('create function public.bootstrap_first_developer_profile');
    expect(contractSql).toContain("'account.bootstrap_developer_created'");
    expect(contractSql).toContain("message = 'DEVELOPER_ACCOUNT_PROTECTED'");
    expect(contractSql).toContain("or new.login_id <> 'admin'");
    expect(contractSql).toContain("or new.login_id_normalized <> 'admin'");
    expect(contractSql).toMatch(
      /'admin',\r?\n\s+'admin',\r?\n\s+0,\r?\n\s+'developer'/
    );
    expect(contractSql).toContain('from service_role');
    expect(contractSql).toContain('to service_role');
    expect(contractSql).not.toContain('grant execute on function public.bootstrap_first_admin_profile');
  });

  it('stores Edge login throttling in a service-only durable fixed window', async () => {
    const sql = await readFile(edgeLoginRateLimitMigrationUrl, 'utf8');

    expect(sql).toContain('create table private.login_rate_limit_windows');
    expect(sql).toContain('create function public.consume_login_rate_limit(');
    expect(sql).toContain('on conflict (key_hash) do update');
    expect(sql).toContain('allowed := v_attempt_count <= p_limit');
    expect(sql).toContain('retry_after_seconds := case');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
  });

  it('bounds rotating login IDs and scopes account command receipts', async () => {
    const sql = await readFile(accountReceiptHardeningMigrationUrl, 'utf8');

    expect(sql).toContain('create function public.consume_login_rate_limits(');
    expect(sql).toContain("'global'::text");
    expect(sql).toContain('limit 64');
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain('create function public.replay_account_command(');
    expect(sql).toContain("'account.create'");
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain('private.audit_command_key(');
    expect(sql).toContain('p_request_hash');
    expect(sql).toContain('from service_role');
    expect(sql).toContain('to service_role');
  });

  it('isolates abusive clients before login and emergency global limits', async () => {
    const sql = await readFile(clientIsolationMigrationUrl, 'utf8');

    expect(sql).toContain('p_client_key_hash text');
    expect(sql).toContain('p_client_limit integer default 30');
    expect(sql).toContain('p_login_limit integer default 10');
    expect(sql).toContain('p_global_limit integer default 600');
    expect(sql).toContain("'client'::text");
    expect(sql.indexOf('p_client_key_hash')).toBeLessThan(sql.indexOf('p_login_key_hash'));
    expect(sql).toContain('attempt_count < p_limit + 1');
    expect(sql).toContain('from service_role');
    expect(sql).toContain('to service_role');
  });

  it('uses stable migration names and exact critical RPC privilege contracts', async () => {
    const sql = await readFile(developerOperationsMigrationUrl, 'utf8');

    expect(sql).toContain('p_expected_migration_name text');
    expect(sql).toContain('where name = $1');
    expect(sql).not.toContain('p_expected_migration_version');
    expect(sql).toContain('pg_catalog.to_regprocedure(expected.signature)');
    expect(sql).toContain("'service_role', resolved.function_oid, 'EXECUTE'");
    expect(sql).toContain("'authenticated', resolved.function_oid, 'EXECUTE'");
    expect(sql).toContain(
      'public.create_account_profile(uuid,uuid,uuid,text,text,public.app_role,text,text,text,text)'
    );
  });

  it('separates immutable domain audit from bounded private security activity', async () => {
    const sql = await readFile(actorActivityMigrationUrl, 'utf8');

    expect(sql).toContain('create table private.actor_activity_events');
    expect(sql).toContain('create table private.actor_activity_aggregates');
    expect(sql).toContain(
      'create table private.actor_authorization_denial_aggregates'
    );
    expect(sql).toContain('create function public.record_actor_activity_event(');
    expect(sql).toContain('create function public.record_unknown_login_failure(');
    expect(sql).toContain('create function public.record_authorization_denial(');
    expect(sql).toContain('create function public.list_developer_activity_events(');
    expect(sql).toContain("set search_path = ''");
    expect(sql).toContain("'auth.login_succeeded'");
    expect(sql).toContain("'authorization.denied'");
    expect(sql).toContain("'sensitive.read'");
    expect(sql).toMatch(/least\(\s*private\.actor_activity_aggregates\.occurrence_count \+ 1,\s*600\s*\)/);
    expect(sql).toMatch(
      /least\(\s*private\.actor_authorization_denial_aggregates\.occurrence_count \+ 1,\s*600\s*\)/
    );
    expect(sql).toContain("v_to - v_from > interval '31 days'");
    expect(sql).toContain('p_limit not between 1 and 100');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
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

  it('keeps weekly availability versioned, service-only, and RLS scoped', async () => {
    const sql = await readFile(availabilityMigrationUrl, 'utf8');

    expect(sql).toContain('availability_versions_one_current_per_week');
    expect(sql).toContain('AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS');
    expect(sql).toContain('OUTSIDE_AVAILABILITY_WINDOW');
    expect(sql).toContain('STALE_VERSION');
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain("'availability.submit'");
    expect(sql).toContain("'availability.change_requested'");
    expect(sql).toContain("'availability.change_decided'");
    expect(sql).toContain('with (security_invoker = true, security_barrier = true)');
    expect(sql).toContain('alter table public.availability_versions enable row level security');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
  });

  it('keeps assignment drafts revisioned, snapshot-bound, and service-only', async () => {
    const sql = await readFile(assignmentCoreMigrationUrl, 'utf8');

    expect(sql).toContain('add column service_date date');
    expect(sql).toContain('alter column service_date set not null');
    expect(sql).toContain('cleaning_assignments_current_maid_date_sequence');
    expect(sql).toContain('ASSIGNMENT_SNAPSHOT_IMMUTABLE');
    expect(sql).toContain('ASSIGNMENT_SNAPSHOT_MISMATCH');
    expect(sql).toContain('create function public.save_cleaning_assignment_draft(');
    expect(sql).toContain("'assignment.save_draft'");
    expect(sql).toContain("'assignment.draft_saved'");
    expect(sql).toContain("change_reason_code = 'DRAFT_REVISED'");
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain('private.audit_command_key(');
    expect(sql).toContain('for update');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant execute[\s\S]*to authenticated/);
  });

  it('commits assignment notification subsets atomically through a private outbox', async () => {
    const sql = await readFile(assignmentCommitMigrationUrl, 'utf8');

    expect(sql).toContain('create table private.notification_outbox');
    expect(sql).toContain('alter table private.notification_outbox enable row level security');
    expect(sql).toContain('create function public.get_assignment_commit_impact(');
    expect(sql).toContain('create function public.commit_and_notify_assignments(');
    expect(sql).toContain("'assignment.commit_notify'");
    expect(sql).toContain("'assignment.notified'");
    expect(sql).toContain('ASSIGNMENT_IMPACT_CHANGED');
    expect(sql).toContain('ASSIGNMENT_AVAILABILITY_STALE');
    expect(sql).toContain("at time zone 'Asia/Seoul'");
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant execute[\s\S]*to authenticated/);
    expect(sql).not.toContain('http_post');
  });

  it('activates notified assignments and rolls missed targets through one scheduler command', async () => {
    const sql = await readFile(assignmentAttemptActivationMigrationUrl, 'utf8');

    expect(sql).toContain('create function private.activate_cleaning_attempt_at(');
    expect(sql).toContain('create function private.rollover_cleaning_target_at(');
    expect(sql).toContain('create function public.process_due_assignment_lifecycle(');
    expect(sql).toContain("'assignment.process_due_lifecycle'");
    expect(sql).toContain("'assignment.attempt_activated'");
    expect(sql).toContain("'assignment.rolled_over'");
    expect(sql).toContain("status = 'notified'");
    expect(sql).toContain("obligation.status in ('materialized', 'completed')");
    expect(sql).toContain('planned_cleaning_target_id');
    expect(sql).toContain('for update');
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant execute[\s\S]*to authenticated/);
  });

  it('adds reservation history, obligations, occupancy ledgers, and CAS commands', async () => {
    const sql = await readFile(roomReservationMigrationUrl, 'utf8');

    expect(sql).toContain('create table public.reservation_schedule_revisions');
    expect(sql).toContain('create table public.preparation_obligations');
    expect(sql).toContain('create table public.checkout_cleaning_obligations');
    expect(sql).toContain('create table public.room_occupancy_events');
    expect(sql).toContain('create function public.create_reservation(');
    expect(sql).toContain('create function public.change_reservation(');
    expect(sql).toContain('create function public.cancel_reservation(');
    expect(sql).toContain('create function public.manual_checkout_reservation(');
    expect(sql).toContain('create function public.process_due_reservation_transitions(');
    expect(sql).toContain("message = 'STALE_VERSION'");
    expect(sql).toContain("message = 'IDEMPOTENCY_KEY_REUSED'");
    expect(sql).toContain("message = 'RESERVATION_OVERLAP'");
    expect(sql).toContain("at time zone 'Asia/Seoul'");
    expect(sql).toContain('cleaning_targets_checkout_obligation_contract_fk');
    expect(sql).toContain('checkout_obligations_current_target_contract_fk');
    expect(sql).toContain('preparation_obligations_submission_attempt_fk');
    expect(sql).toContain('approved_submission_id uuid unique');
    expect(sql).toContain('create table private.preparation_proof_usages');
    expect(sql).toContain('preparation_proof_usages_append_only');
    expect(sql).toContain('inspection_decisions_append_only');
    expect(sql).toContain('consumed_preparation_submission_immutable');
    expect(sql).toContain('preparation_obligations_enforce_proof');
    expect(sql).toContain('invalidate_stale_preparation_proofs');
    expect(sql).toContain("a.status = 'approved'");
    expect(sql).toContain('a.started_at >= t.available_from');
    expect(sql).toContain('s.submitted_at >= a.ended_at');
    expect(sql).toContain('d.decided_at >= s.submitted_at');
    expect(sql).toContain('checkout_obligations_enforce_target_state');
    expect(sql).toContain('checkout_obligations_validate_terminal_contract');
    expect(sql).toContain('cleaning_targets_validate_checkout_terminal_contract');
    expect(sql).toContain('room_pin_leases_attempt_contract_fk');
    expect(sql).toContain('room_pin_access_leases_enforce_contract');
    expect(sql).toContain('attempt_id uuid not null');
    expect(sql).toContain('Close due stays first');
  });

  it('keeps new room ledgers append-only and service commands private', async () => {
    const sql = await readFile(roomReservationMigrationUrl, 'utf8');

    expect(sql).toContain('reservation_schedule_revisions_append_only');
    expect(sql).toContain('room_occupancy_events_append_only');
    expect(sql).toContain('room_candle_events_append_only');
    expect(sql).toContain('room_pin_sync_events_append_only');
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/for all to authenticated/);
    expect(sql).not.toMatch(/grant (insert|delete|update) on public\.(reservation|room_)/);
  });
});
