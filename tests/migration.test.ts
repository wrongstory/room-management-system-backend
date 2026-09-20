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
const availabilityAnyDayMigrationUrl = new URL(
  '../supabase/migrations/20260920091536_availability_any_day_submission.sql',
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
const plannedCheckoutRoomChangeMigrationUrl = new URL(
  '../supabase/migrations/20260912082738_planned_checkout_room_change_fk.sql',
  import.meta.url
);
const payrollPaymentResultsMigrationUrl = new URL(
  '../supabase/migrations/20260910114525_payroll_payment_results.sql',
  import.meta.url
);
const notificationInboxMigrationUrl = new URL(
  '../supabase/migrations/20260911004142_notification_inbox_read_contract.sql',
  import.meta.url
);
const webPushSubscriptionMigrationUrl = new URL(
  '../supabase/migrations/20260911050151_web_push_subscription_revisions.sql',
  import.meta.url
);
const roomPinSheetFullResyncMigrationUrl = new URL(
  '../supabase/migrations/20260912225031_room_pin_sheet_full_resync.sql',
  import.meta.url
);
const cleaningTemplateDurationMigrationUrl = new URL(
  '../supabase/migrations/20260915000628_cleaning_template_duration_optional.sql',
  import.meta.url
);
const currentRoomStatusMigrationUrl = new URL(
  '../supabase/migrations/20260916165715_current_room_status_projection.sql',
  import.meta.url
);
const reservationArrivalLifecycleMigrationUrl = new URL(
  '../supabase/migrations/20260916194539_reservation_arrival_lifecycle_projection.sql',
  import.meta.url
);
const reservationRoomMoveMigrationUrl = new URL(
  '../supabase/migrations/20260916204500_reservation_room_change_before_checkin.sql',
  import.meta.url
);
const reservationDuringStayMoveMigrationUrl = new URL(
  '../supabase/migrations/20260916210000_reservation_during_stay_room_move.sql',
  import.meta.url
);
const reservationBookabilityMigrationUrl = new URL(
  '../supabase/migrations/20260918010000_reservation_bookability.sql',
  import.meta.url
);
const photoRetentionV2MigrationUrl = new URL(
  '../supabase/migrations/20260917090000_photo_retention_v2.sql',
  import.meta.url
);
const photoSlotContractV8MigrationUrl = new URL(
  '../supabase/migrations/20260916030930_photo_slot_contract_v8.sql',
  import.meta.url
);
const roomStatusAdminCorrectionMigrationUrl = new URL(
  '../supabase/migrations/20260920143711_room_status_admin_correction.sql',
  import.meta.url
);

describe('initial migration contract', () => {
  it('versions the A-contract without rewriting v7 photo evidence', async () => {
    const sql = await readFile(photoSlotContractV8MigrationUrl, 'utf8');

    expect(sql).toContain('create or replace function private.photo_snapshot_valid');
    expect(sql).toContain('when uses_a_contract then 9 else 10');
    expect(sql).toContain("bool_and(value ? 'maxPhotos')");
    expect(sql).toContain("if p_snapshot->>'cleaningKind'='checkout' and version_number>=7 and (");
    expect(sql).toContain("uses_a_contract:=p_snapshot->>'cleaningKind'='checkout'");
    expect(sql).toContain("where not (slot ? 'maxPhotos')");
    expect(sql).toContain("value->>'slotKey'='entry-number'");
    expect(sql).toContain("value->>'slotKey'='entry-storage'");
    expect(sql).toContain("value->>'slotKey'='extra-proof'");
    expect(sql).toContain("value->>'maxPhotos'='10'");
    expect(sql).toContain('greatest(v_max_version + 1, 8)');
    expect(sql).not.toMatch(/update public\.cleaning_targets|update public\.cleaning_attempts|update public\.cleaning_submissions/);
  });

  it('allows an unestimated checkout template without weakening other template kinds', async () => {
    const sql = await readFile(cleaningTemplateDurationMigrationUrl, 'utf8');

    expect(sql).toContain('alter column duration_minutes drop not null');
    expect(sql).toContain("check (cleaning_kind = 'checkout' or duration_minutes is not null)");
    expect(sql).toContain('p_duration_minutes is not null');
    expect(sql).toContain('p_duration_minutes not between 1 and 10080');
    expect(sql).toContain('jsonb_strip_nulls');
    expect(sql).toContain('cleaning_attempts.started_at and field_completed_at');
    expect(sql).toContain('assignment_duration_policy_versions');
    expect(sql).toContain('t.available_from is not null');
    expect(sql).toContain('t.due_at is not null');
    expect(sql).not.toContain("coalesce((t.template_snapshot ->> 'durationMinutes')::integer, 1)");
    expect(sql).toContain("incident.status = 'open'");
    expect(sql).toContain("running_attempt.status = 'in_progress'");
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
  });

  it('separates future reservation schedules from current cleaning state', async () => {
    const sql = await readFile(currentRoomStatusMigrationUrl, 'utf8');

    expect(sql).toContain('private.room_current_cleaning_required_at');
    expect(sql).toContain('obligation.current_cleaning_target_id = target.id');
    expect(sql).toContain("obligation.status = 'materialized'");
    expect(sql).toContain('reservation.actual_checkout_at <= p_at');
    expect(sql).toContain('private.room_reservation_phase_at');
    expect(sql).toContain("then 'current'");
    expect(sql).toContain("then 'upcoming'");
    expect(sql).toContain("array_append(v_reasons, 'RESERVATION_CURRENT')");
    expect(sql).toContain('and p_preparation_reservation_id is null');
    expect(sql).toContain('v_evaluated_at timestamptz := clock_timestamp()');
    expect(sql).toContain('p_preparation_reservation_id is not null');
    expect(sql).toContain('obligation.reservation_id = p_preparation_reservation_id');
    expect(sql).toContain('drop function public.get_room_operational_projection(uuid, uuid)');
    expect(sql).toContain('to service_role');
    expect(sql).not.toContain('current_date');
  });

  it('adds KST arrival lifecycle axes without replacing the compatible room projection', async () => {
    const sql = await readFile(reservationArrivalLifecycleMigrationUrl, 'utf8');

    expect(sql).toContain('private.room_reservation_lifecycle_at');
    expect(sql).toContain("p_at at time zone 'Asia/Seoul'");
    expect(sql).toContain("then 'ARRIVAL_PENDING'");
    expect(sql).toContain("then 'RESERVATION_PRESENT'");
    expect(sql).toContain("else 'FUTURE'");
    expect(sql).toContain("when v_current then 'OCCUPIED'");
    expect(sql).toContain('order by reservation.check_in_at, reservation.id');
    expect(sql).toContain('v_evaluated_at timestamptz := clock_timestamp()');
    expect(sql).toMatch(/v_evaluated_at,\r?\n\s+case when state\.occupied/);
    expect(sql).toContain("when readiness.readiness_status = 'CHECKIN_BLOCKED' then 'BLOCKED'");
    expect(sql).toContain("when lifecycle.reservation_lifecycle = 'OCCUPIED' then 'OCCUPIED'");
    expect(sql).toContain("when state.cleaning_required then 'CLEANING_REQUIRED'");
    expect(sql).toContain("when p_pin_sync_status = 'mismatch' then 'PIN_MISMATCH'");
    expect(sql).toContain("when p_pin_sync_status = 'unconfigured' then 'PIN_UNCONFIGURED'");
    expect(sql).toContain('from public, anon, authenticated, service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/create table|alter table|insert into|update public\./);
  });

  it('separates canonical occupancy, room blocking, and readiness with an admin correction ledger', async () => {
    const sql = await readFile(roomStatusAdminCorrectionMigrationUrl, 'utf8');

    expect(sql).toContain('create table private.room_occupancy_corrections');
    expect(sql).toContain('create or replace function private.room_occupied_at');
    expect(sql).toContain('segment.starts_at <= p_at');
    expect(sql).toContain('(segment.ends_at is null or segment.ends_at > p_at)');
    expect(sql).toContain('reservation.actual_checkout_at is null');
    expect(sql).toContain('create or replace function public.correct_room_occupancy(');
    expect(sql).toContain('private.assert_attempt_actor_session(p_actor_profile_id, p_session_id, true)');
    expect(sql).toContain("'room.occupancy_correction'");
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain('p_expected_room_version');
    expect(sql).toContain('p_effective_at');
    expect(sql).toContain('p_reason_code');
    expect(sql).toContain('room_occupancy_corrections_immutable');
    expect(sql).toContain('cardinality(readiness.blocking_reason_codes) > 0');
    expect(sql).toContain('not state.occupied and cardinality(readiness.readiness_reason_codes) = 0');
    expect(sql).toContain('from public, anon, authenticated, service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant (select|insert|update|delete) on (table )?private\.room_occupancy_corrections to (anon|authenticated)/);
  });

  it('moves pre-check-in reservations only through a replay-safe dedicated command', async () => {
    const sql = await readFile(reservationRoomMoveMigrationUrl, 'utf8');

    expect(sql).toContain('create function public.preview_reservation_room_move(');
    expect(sql).toContain('create function public.commit_reservation_room_move(');
    expect(sql).toContain('private.replay_command(');
    expect(sql.indexOf('private.replay_command(')).toBeLessThan(
      sql.indexOf("message = 'ROOM_CHANGE_PREVIEW_STALE'")
    );
    expect(sql).toMatch(
      /v_response := private\.replay_command\([\s\S]+when unique_violation then[\s\S]+message = 'IDEMPOTENCY_KEY_REUSED'[\s\S]+detail = private\.reservation_room_move_conflict_detail\(/
    );
    expect(sql).toMatch(
      /coalesce\(\r?\n\s+current_setting\('app\.reservation_room_move_writer_mode', true\)/
    );
    expect(sql).toContain("'before_checkin_v1'");
    expect(sql).toContain('order by room.id');
    expect(sql).toContain("message = 'RESERVATION_VERSION_CONFLICT'");
    expect(sql).toContain("message = 'SOURCE_ROOM_VERSION_CONFLICT'");
    expect(sql).toContain("message = 'TARGET_ROOM_VERSION_CONFLICT'");
    expect(sql).toContain("message = 'TARGET_ROOM_OVERLAP'");
    expect(sql).toContain("message = 'CLEANING_ASSIGNMENT_LOCKED'");
    expect(sql).toContain("message = 'PIN_LEASE_ACTIVE'");
    expect(sql).toContain('create function private.reservation_room_move_conflict_detail(');
    expect(sql).toContain("'reloadResources', jsonb_build_array(");
    expect(sql).toContain("'reservationVersion', v_reservation_version");
    expect(sql).toContain("'sourceRoomVersion', v_source_room_version");
    expect(sql).toContain("'targetRoomVersion', v_target_room_version");
    expect(sql).toContain('detail = private.reservation_room_move_conflict_detail(');
    expect(sql).toMatch(
      /revoke all on function private\.reservation_room_move_conflict_detail\(\r?\n\s+uuid, uuid, uuid\r?\n\) from public, anon, authenticated, service_role/
    );
    expect(sql).toContain("'reservation.room_moved'");
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/\b(?:http_post|net\.http_post)\b/);
  });

  it('moves checked-in stays through immutable room segments and bounded cleanup', async () => {
    const sql = await readFile(reservationDuringStayMoveMigrationUrl, 'utf8');

    expect(sql).toContain('create table private.reservation_stays');
    expect(sql).toContain('create table private.stay_room_segments');
    expect(sql).toContain('stay_room_segments_no_room_overlap');
    expect(sql).toContain("mode='DURING_STAY'");
    expect(sql).toContain("message='INVALID_MOVE_EFFECTIVE_AT'");
    expect(sql).toContain("'stay_room_move_checkout'");
    expect(sql).toContain('room_pin_access_scheduled_revocations');
    expect(sql).toContain('set ends_at=p_effective_at');
    expect(sql).toContain('p_effective_at,reservation.check_out_at');
    expect(sql).toContain('private.assignment_preview_source_reason_before_stay_segments');
    expect(sql).toContain('private.assignment_commit_candidates_at_before_stay_segments');
    expect(sql).toContain("segment.ends_at>p_checkout_at-interval '1 microsecond'");
    expect(sql).toContain('update private.stay_segment_checkout_obligations');
    expect(sql).toContain("'stay_room_move_checkout')");
    expect(sql).toContain('v_earning.compensation_entitlement_id is not null');
    // The v61 reservation command parity intentionally keeps the encrypted
    // guest-name input/retention path. What must never enter the new move
    // ledger, audit or response projection is a plaintext/public guest-name
    // field, PIN plaintext, or authorization material.
    expect(sql).not.toMatch(/['"]guestName['"]|\bpin_plain\b|authorization header/i);
  });

  it('adds bounded reservation reads and a non-authoritative interval preview', async () => {
    const sql = await readFile(reservationBookabilityMigrationUrl, 'utf8');

    expect(sql).toContain('create index reservations_calendar_range_idx');
    expect(sql).toContain('create function public.preview_reservation_bookability(');
    expect(sql).toContain('create function public.list_reservations_page(');
    expect(sql).toContain("p_reservation_type is distinct from 'standard'");
    expect(sql).toContain("v_room_type_ids uuid[] := nullif(p_room_type_ids, array[]::uuid[])");
    expect(sql).toContain('private.room_reservation_lifecycle_at(');
    expect(sql).toContain('lifecycle.current_checkin_pending');
    expect(sql).toContain("tstzrange(p_check_in_at, p_check_out_at, '[)')");
    expect(sql).toContain('segment.retired_at is null');
    expect(sql).toContain('segment.source_reservation_id is distinct from p_exclude_reservation_id');
    expect(sql).toContain("v_excluded.status <> 'active'");
    expect(sql).toContain("'interval_bookable', candidate.interval_bookable");
    expect(sql).toContain("'check_in_ready', candidate.check_in_ready");
    expect(sql).toContain("'evaluated_at', v_evaluated_at");
    expect(sql).toContain("p_to - p_from > interval '31 days'");
    expect(sql).toContain('p_limit < 1 or p_limit > 50');
    expect(sql).toContain('(reservation.check_in_at, reservation.id) > (p_after_check_in_at, p_after_id)');
    expect(sql).toContain("tstzrange(segment.starts_at, segment.ends_at, '[)')");
    expect(sql).toContain('private.reservation_projected_room_id(');
    expect(sql).toContain('v_server_time');
    expect(sql).toContain("'server_time', v_server_time");
    expect(sql).toContain('from public, anon, authenticated');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/['"]guest_name['"]|guest_name_(?:ciphertext|iv|auth_tag)/i);
    expect(sql).not.toMatch(/\blong_stay\b|open[-_ ]ended/i);
  });

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
    const [sql, policySql] = await Promise.all([
      readFile(availabilityMigrationUrl, 'utf8'),
      readFile(availabilityAnyDayMigrationUrl, 'utf8')
    ]);

    expect(sql).toContain('availability_versions_one_current_per_week');
    expect(sql).toContain('AVAILABILITY_WEEK_REQUIRES_SEVEN_DAYS');
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
    expect(policySql).toContain(
      'create or replace function private.submit_weekly_availability_at('
    );
    expect(policySql).toContain('AVAILABILITY_WEEK_OUT_OF_RANGE');
    expect(policySql).toContain('PAST_AVAILABILITY_DATE_NOT_ALLOWED');
    expect(policySql).toContain("at time zone 'Asia/Seoul'");
    expect(policySql).toContain('private.replay_command(');
    expect(policySql).toContain('private.complete_command(');
    expect(policySql).not.toContain('OUTSIDE_AVAILABILITY_WINDOW');
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

  it('defers the planned checkout reservation-room FK without removing commit enforcement', async () => {
    const sql = await readFile(plannedCheckoutRoomChangeMigrationUrl, 'utf8');

    expect(sql).toContain('alter table public.cleaning_targets');
    expect(sql).toContain('alter constraint cleaning_targets_reservation_room_fk');
    expect(sql).toContain('deferrable initially deferred');
    expect(sql).not.toContain('drop constraint cleaning_targets_reservation_room_fk');
    expect(sql).not.toContain('not valid');
    expect(sql).not.toContain('disable trigger');
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

  it('keeps external payroll payment results typed, immutable, and provider-free', async () => {
    const sql = await readFile(payrollPaymentResultsMigrationUrl, 'utf8');

    expect(sql).toContain('create table public.payroll_payment_attempts');
    expect(sql).toContain('create table public.payroll_payment_results');
    expect(sql).toContain('payroll_payment_results_terminal_attempt_unique');
    expect(sql).toContain('payroll_payment_results_reference_unique');
    expect(sql).toContain('PAYROLL_PAYMENT_EVIDENCE_IMMUTABLE');
    expect(sql).toContain('private.payroll_payment_projection_transitions');
    expect(sql).toContain('payroll_payment_projection_requires_evidence');
    expect(sql).toContain('payroll_payment_attempt_requires_transition');
    expect(sql).toContain('payroll_payment_result_requires_transition');
    expect(sql).toContain('PAYROLL_PAYMENT_EVIDENCE_REQUIRED');
    expect(sql).toContain('new.check_reason is distinct from old.check_reason');
    expect(sql).toContain('new.last_reopen_reason is distinct from old.last_reopen_reason');
    expect(sql).toContain("old.status='check' and new.status='paid'");
    expect(sql).toContain('private.current_payroll_attempt_has_typed_check');
    expect(sql.match(/private\.current_payroll_attempt_has_typed_check/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("when v_cycle.status='check' and not v_has_typed_check");
    expect(sql).toContain('revoke select on public.payroll_cycles from authenticated');
    expect(sql).toContain('revoke select(check_reason,last_reopen_reason) on public.payroll_cycles from authenticated');
    expect(sql).toContain("else 'TRANSFER_RESULT_UNCERTAIN' end");
    expect(sql).toContain("else 'NO_TRANSFER_CONFIRMED' end");
    expect(sql).toContain("'TRANSFER_RESULT_UNCERTAIN'");
    expect(sql).toContain("'NO_TRANSFER_CONFIRMED'");
    expect(sql).toContain("'bank_transfer'");
    expect(sql).toContain('private.replay_command(');
    expect(sql).toContain('private.complete_command(');
    expect(sql).toContain('alter table public.payroll_payment_results enable row level security');
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/https?:\/\//);
    expect(sql).not.toMatch(/\b(?:http_post|net\.http_post)\b/);
  });

  it('keeps notification inbox reads service-only, bounded, and immutable', async () => {
    const sql = await readFile(notificationInboxMigrationUrl, 'utf8');

    expect(sql).toContain('notifications_recipient_occurred_id_idx');
    expect(sql).toContain('recipient_profile_id, occurred_at desc, id desc');
    expect(sql).toContain('create function public.list_notifications_page(');
    expect(sql).toContain('create function public.mark_notification_read(');
    expect(sql).toContain('private.assert_notification_actor');
    expect(sql).toContain('auth.sessions');
    expect(sql).toContain('not actor.must_change_password');
    expect(sql).toContain("actor.role in ('admin', 'maid')");
    expect(sql).toContain('NOTIFICATION_NOT_FOUND');
    expect(sql).toContain('app.notification_write_mode');
    expect(sql).toContain('clock_timestamp()');
    expect(sql).toContain('NOTIFICATION_CONTENT_IMMUTABLE');
    expect(sql).toContain('NOTIFICATION_READ_AT_IMMUTABLE');
    expect(sql).toContain('NOTIFICATION_RESOLVED_AT_IMMUTABLE');
    expect(sql).toContain('revoke select, update on table public.notifications');
    expect(sql).toContain('from public, anon, authenticated, service_role');
    expect(sql).toContain('grant execute on function public.list_notifications_page');
    expect(sql).toContain('public.mark_notification_read(uuid, uuid, uuid)');
    expect(sql).toContain('to service_role');
  });

  it('keeps Web Push subscriptions encrypted, revisioned, service-only, and provider-free', async () => {
    const sql = await readFile(webPushSubscriptionMigrationUrl, 'utf8');

    for (const table of [
      'web_push_subscriptions',
      'web_push_subscription_revisions',
      'web_push_subscription_secrets',
      'web_push_subscription_events',
      'web_push_registration_limits'
    ]) {
      expect(sql).toContain(`create table private.${table}`);
      expect(sql).toContain(`alter table private.${table} enable row level security`);
    }
    expect(sql).toContain('web_push_subscriptions_active_endpoint_uidx');
    expect(sql).toContain('web_push_subscriptions_active_session_uidx');
    expect(sql).toContain('web_push_subscriptions_current_revision_idx');
    expect(sql).toContain('web_push_subscription_revisions_profile_idx');
    expect(sql).toContain("coalesce(current_setting('app.web_push_writer_mode',true),'') <> 'typed_v1'");
    expect(sql).toContain('create function public.register_web_push_subscription(');
    expect(sql).toContain('create function public.retire_web_push_subscription(');
    expect(sql).toContain('create function public.purge_retired_web_push_subscription_metadata(');
    expect(sql).toContain('auth.sessions');
    expect(sql).toContain('v_profile.must_change_password');
    expect(sql).toContain("v_profile.role::text not in ('admin','maid')");
    expect(sql.match(/pg_advisory_xact_lock\(hashtextextended\('web-push:membership:v1',0\)\)/g)).toHaveLength(2);
    expect(sql).not.toContain("'web-push:endpoint:'||p_endpoint_digest");
    expect(sql).toContain('delete from private.web_push_subscription_secrets');
    expect(sql).toContain("interval '90 days'");
    expect(sql).toContain('p_limit not between 1 and 100');
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant (select|insert|update|delete) on (table )?private\.web_push/);
    expect(sql).not.toMatch(/\b(?:http_post|net\.http_post|vapid)\b/i);
  });

  it('keeps full PIN Sheet repair immutable, fenced, bounded, and provider-free', async () => {
    const sql = await readFile(roomPinSheetFullResyncMigrationUrl, 'utf8');

    expect(sql).toContain('create table private.room_pin_sheet_full_resync_runs');
    expect(sql).toContain('create table private.room_pin_sheet_full_resync_items');
    expect(sql).toContain('snapshot_room_count integer not null check (snapshot_room_count = 121)');
    expect(sql).toContain('target_identity_digest text not null');
    expect(sql).toContain('recovery_root_run_id uuid not null');
    expect(sql).toContain('new.recovery_root_run_id=new.id');
    expect(sql).toContain('new.recovery_root_run_id<>old.recovery_root_run_id');
    expect(sql).toContain('create function public.request_room_pin_sheet_full_resync(');
    expect(sql).toContain('create function public.claim_room_pin_sheet_full_resync(');
    expect(sql).toContain('create function public.authorize_room_pin_sheet_full_resync_write(');
    expect(sql).toContain('create function public.settle_room_pin_sheet_full_resync(');
    expect(sql).toContain('outbox.created_at<=run.provider_write_started_at');
    expect(sql).toContain('cleanup_limit constant integer:=32');
    expect(sql).toContain("last_error_code='SNAPSHOT_STALE'");
    expect(sql).toContain("last_error_code='DB_SETTLE_UNCERTAIN'");
    expect(sql).toContain("where status in ('pending','processing','failed')");
    expect(sql).toContain("'room_pin_sheet.full_resync_requested'");
    expect(sql).toContain("'room_pin_sheet.full_resync_succeeded'");
    expect(sql).toContain('from public,anon,authenticated,service_role');
    expect(sql).toContain('to service_role');
    expect(sql).not.toMatch(/grant (select|insert|update|delete) on (table )?private\.room_pin_sheet_full_resync/);
    expect(sql).not.toMatch(/\b(?:http_post|net\.http_post|oauth|private_key|access_token)\b/i);
  });

  it('keeps photo retention domain-bound, private, and independent from legacy purge_after', async () => {
    const sql = await readFile(photoRetentionV2MigrationUrl, 'utf8');

    expect(sql).toContain('create table private.photo_retention_records');
    expect(sql).toContain('create table private.photo_retention_links');
    expect(sql).toContain("'cleaning_submission','room_issue','complaint','interruption','sync_conflict','mixed','orphan'");
    expect(sql).toContain("'retentionPolicy', 'legacy_upload'");
    expect(sql).toContain("event.event_type = 'closed'");
    expect(sql).toContain("interval '168 hours'");
    expect(sql).toContain("interval '180 days'");
    expect(sql).toContain("interval '30 days'");
    expect(sql).toContain('private.photo_media_usable');
    expect(sql).toContain('create or replace function public.authorize_photo_read');
    expect(sql).toContain('create or replace function public.claim_due_photo_purges');
    expect(sql).toContain('from public, anon, authenticated, service_role');
    expect(sql).not.toMatch(/grant (select|insert|update|delete) on (table )?private\.photo_retention/);
  });
});
