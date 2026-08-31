import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const configUrl = new URL('../supabase/config.toml', import.meta.url);
const apiUrl = new URL('../supabase/functions/api/index.ts', import.meta.url);
const runtimeUrl = new URL('../supabase/functions/_shared/runtime.ts', import.meta.url);
const accountApiUrl = new URL('../supabase/functions/_shared/account-api.ts', import.meta.url);
const availabilityApiUrl = new URL(
  '../supabase/functions/_shared/availability-api.ts',
  import.meta.url
);
const reservationApiUrl = new URL(
  '../supabase/functions/_shared/reservation-api.ts',
  import.meta.url
);
const developerApiUrl = new URL('../supabase/functions/_shared/developer-api.ts', import.meta.url);
const activityApiUrl = new URL('../supabase/functions/_shared/activity-api.ts', import.meta.url);
const activityContractUrl = new URL(
  '../supabase/functions/_shared/activity-contract.ts',
  import.meta.url
);
const openApiUrl = new URL('../supabase/functions/_shared/openapi.ts', import.meta.url);
const fastifyPasswordUrl = new URL('../src/modules/auth/password.ts', import.meta.url);
const fastifyAuthRoutesUrl = new URL('../src/modules/auth/auth.routes.ts', import.meta.url);
const schedulerUrl = new URL('../supabase/functions/reservation-scheduler/index.ts', import.meta.url);
const loginRateLimitMigrationUrl = new URL(
  '../supabase/migrations/20260830015035_edge_login_rate_limit.sql',
  import.meta.url
);
const accountSecurityMigrationUrl = new URL(
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

describe('Supabase Edge runtime PoC contract', () => {
  it('allows existing email accounts to sign in while public signup remains disabled', async () => {
    const config = await readFile(configUrl, 'utf8');

    expect(config).toMatch(/\[auth\]\r?\n/);
    expect(config).toMatch(/\[auth\][\s\S]*?enable_signup = false/);
    expect(config).toMatch(/\[auth\.email\][\s\S]*?enable_signup = true/);
  });

  it('revalidates Auth user, active profile, and active session before service-role RPCs', async () => {
    const [api, runtime] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(runtimeUrl, 'utf8')
    ]);

    expect(runtime).toMatch(/publicClient\.auth\s*\.getUser\(accessToken\)/);
    expect(runtime).toMatch(/\.from\(["']profiles["']\)/);
    expect(runtime).toMatch(/profile\.status !== ["']active["']/);
    expect(runtime).toMatch(/["']is_active_auth_session["']/);
    expect(runtime).toMatch(/role:\s*["']developer["']\s*\|\s*["']admin["']\s*\|\s*["']maid["']/);
    expect(runtime).toMatch(/actor\.role !== ["']admin["']/);
    expect(api).toMatch(/requireBusinessAdmin\(actor\)/);
    expect(api).toMatch(/["']get_room_operational_projection["']/);
  });

  it('keeps the cron invocation secret and scheduler actor checks ahead of the command RPC', async () => {
    const scheduler = await readFile(schedulerUrl, 'utf8');
    const secretCheck = scheduler.indexOf('matchesSecret(providedSecret, expectedSecret)');
    const actorCheck = scheduler.search(
      /requiredEnv\(\s*["']RESERVATION_SCHEDULER_ACTOR_PROFILE_ID["']/
    );
    const command = scheduler.search(/["']process_due_reservation_transitions["']/);

    expect(secretCheck).toBeGreaterThan(0);
    expect(actorCheck).toBeGreaterThan(secretCheck);
    expect(command).toBeGreaterThan(actorCheck);
    expect(scheduler).toContain('crypto.subtle.verify');
    expect(scheduler).toContain('reservation-scheduler-$' + '{bucket}');
    expect(scheduler).toMatch(/p_as_of:\s*new Date\(\)\.toISOString\(\)/);
  });

  it('uses a durable database-backed limiter before looking up a login alias', async () => {
    const [accountApi, originalMigration, securityMigration, isolationMigration] = await Promise.all([
      readFile(accountApiUrl, 'utf8'),
      readFile(loginRateLimitMigrationUrl, 'utf8'),
      readFile(accountSecurityMigrationUrl, 'utf8'),
      readFile(clientIsolationMigrationUrl, 'utf8')
    ]);
    const limiter = accountApi.indexOf('await consumeLoginRateLimit(request, clients, alias)');
    const aliasLookup = accountApi.indexOf('.from("login_aliases")');

    expect(limiter).toBeGreaterThan(0);
    expect(aliasLookup).toBeGreaterThan(limiter);
    expect(accountApi).not.toMatch(/new\s+Map\s*</);
    expect(accountApi).toContain('edge-login-rate-limit:client:v1:');
    expect(accountApi).toContain('"edge-login-rate-limit:global-emergency:v1"');
    expect(accountApi).toMatch(/edge-login-rate-limit:\$\{normalizedLoginId\}/);
    expect(accountApi).toContain('request.headers.get("cf-connecting-ip")');
    expect(accountApi).toContain('request.headers.get("x-real-ip")');
    expect(accountApi).toContain('"consume_login_rate_limits"');
    expect(originalMigration).toContain('create table private.login_rate_limit_windows');
    expect(securityMigration).toContain('create function public.consume_login_rate_limits(');
    expect(securityMigration).toContain('p_global_key_hash');
    expect(securityMigration).toContain('limit 64');
    expect(securityMigration).toContain('to service_role');
    expect(securityMigration).toContain('from public, anon, authenticated');
    expect(isolationMigration).toContain('p_client_key_hash');
    expect(isolationMigration).toContain("'client'::text");
    expect(isolationMigration).toContain('p_global_limit integer default 600');
    expect(isolationMigration).toContain('attempt_count < p_limit + 1');
    expect(isolationMigration).toContain('from service_role');
  });

  it('uses scoped request-hashed receipts before account-create Auth side effects', async () => {
    const [accountApi, migration] = await Promise.all([
      readFile(accountApiUrl, 'utf8'),
      readFile(accountSecurityMigrationUrl, 'utf8')
    ]);
    const replay = accountApi.indexOf('await replayAccountProfile(');
    const authCreate = accountApi.indexOf('.createUser({');

    expect(replay).toBeGreaterThan(0);
    expect(authCreate).toBeGreaterThan(replay);
    expect(accountApi).not.toContain('.from("audit_events")');
    expect(accountApi).toContain('p_request_hash: hash');
    expect(migration).toContain('private.replay_command(');
    expect(migration).toContain('private.complete_command(');
    expect(migration).toContain('private.audit_command_key(');
  });

  it('exposes account lifecycle routes without a developer bootstrap or promotion route', async () => {
    const [api, accountApi] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(accountApiUrl, 'utf8')
    ]);

    expect(api).toContain('path === "/v1/auth/login"');
    expect(api).toContain('path === "/v1/auth/password"');
    expect(api).toContain('path === "/v1/accounts"');
    expect(api).toContain('profileIdFromPath(path, "role")');
    expect(api).toContain('profileIdFromPath(path, "status")');
    expect(api).toContain('profileIdFromPath(path, "unlock")');
    expect(api).toContain('profileIdFromPath(path, "password-reset")');
    expect(accountApi).toMatch(/roleValue !== "admin" && roleValue !== "maid"/);
    expect(accountApi).toMatch(/body\.role !== "admin" && body\.role !== "maid"/);
    expect(accountApi).not.toContain('bootstrap_first_developer_profile');
  });

  it('publishes pinned Swagger UI and an OpenAPI contract without persisting authorization', async () => {
    const [api, openApi] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(openApiUrl, 'utf8')
    ]);

    expect(api).toContain('path === "/openapi.json"');
    expect(api).toContain('path === "/docs"');
    expect(openApi).toContain('openapi: "3.1.1"');
    expect(openApi).toMatch(/bearerAuth:\s*\{[\s\S]*?type:\s*"http"[\s\S]*?scheme:\s*"bearer"/);
    expect(openApi).toContain('name: "Idempotency-Key"');
    expect(openApi).toContain('const swaggerUiVersion = "5.32.11"');
    expect(openApi).toMatch(/swagger-ui-dist@\$\{swaggerUiVersion\}/);
    expect(openApi).toContain('persistAuthorization: false');
    expect(openApi).toContain('content-security-policy');
    expect(openApi).toMatch(/integrity="\$\{swaggerCssIntegrity\}"/);
    expect(openApi).toMatch(/integrity="\$\{swaggerBundleIntegrity\}"/);
    expect(openApi).toContain('/blob/main/docs/FRONTEND_API_INTEGRATION.md');
    expect(openApi).not.toContain('/blob/dev/docs/FRONTEND_API_INTEGRATION.md');
    expect(openApi).not.toMatch(/example:\s*["']?(?:Bearer|eyJ|010\d{8})/);
  });

  it('keeps developer operations behind exact-role and app-owned projections', async () => {
    const [api, runtime, developerApi, migration, activityMigration, openApi] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(runtimeUrl, 'utf8'),
      readFile(developerApiUrl, 'utf8'),
      readFile(developerOperationsMigrationUrl, 'utf8'),
      readFile(actorActivityMigrationUrl, 'utf8'),
      readFile(openApiUrl, 'utf8')
    ]);

    expect(runtime).toMatch(/actor\.role !== ["']developer["']/);
    expect(api).toContain('path === "/v1/developer/overview"');
    expect(api).toContain('path === "/v1/developer/audit-events"');
    expect(api).toContain('path === "/v1/developer/activity-events"');
    expect(api).toContain('path === "/v1/developer/diagnostics"');
    expect(api).toContain('requireDeveloper(actor)');
    expect(developerApi).toContain(
      'expectedMigrationName = "actor_activity_audit_contract"'
    );
    expect(developerApi).toContain('secretConfigurationAllowlist');
    expect(developerApi).not.toMatch(/Object\.(?:keys|entries)\(Deno\.env/);
    expect(migration).toContain('private.assert_active_developer');
    expect(migration).toContain('private.scheduler_invocation_heartbeats');
    expect(migration).toContain('private.developer_diagnostic_rate_limits');
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('to service_role');
    expect(activityMigration).toContain('private.actor_activity_events');
    expect(activityMigration).toContain('private.actor_activity_aggregates');
    expect(activityMigration).toContain(
      'private.actor_authorization_denial_aggregates'
    );
    expect(activityMigration).toContain('public.list_developer_activity_events');
    expect(openApi).toContain('DeveloperAuditPage');
    expect(openApi).toContain('DIAGNOSTICS_RATE_LIMITED');
  });

  it('records only source-controlled security activity through server-owned RPCs', async () => {
    const [api, accountApi, activityApi, contract, migration] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(accountApiUrl, 'utf8'),
      readFile(activityApiUrl, 'utf8'),
      readFile(activityContractUrl, 'utf8'),
      readFile(actorActivityMigrationUrl, 'utf8')
    ]);

    expect(accountApi).toContain('recordUnknownLoginFailed(clients)');
    expect(accountApi).toContain('recordLoginSucceeded(');
    expect(accountApi).toContain('recordKnownLoginFailed(');
    expect(api).toContain('recordAuthorizationDenied(clients, actor, source, error.code)');
    expect(contract).toContain('edge.authorization.reservations');
    expect(contract).toContain('edge.authorization.rooms');
    expect(activityApi).toContain('record_actor_activity_event');
    expect(activityApi).toContain('record_unknown_login_failure');
    expect(activityApi).toContain('record_authorization_denial');
    expect(activityApi).toContain('p_request_id: serverActivityRequestId()');
    expect(migration).toContain("set search_path = ''");
    expect(migration).toContain('from public, anon, authenticated');
    expect(migration).toContain('revoke all on table private.actor_activity_events');
    expect(migration).not.toMatch(/\b(access_token|refresh_token|authorization_header|client_ip|request_body)\b/i);
  });

  it('ports weekly availability through authenticated RLS reads and actor-bound commands', async () => {
    const [api, runtime, availabilityApi, openApi] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(runtimeUrl, 'utf8'),
      readFile(availabilityApiUrl, 'utf8'),
      readFile(openApiUrl, 'utf8')
    ]);

    expect(runtime).toContain('forAccessToken: (accessToken: string)');
    expect(runtime).toMatch(/Authorization:\s*`Bearer \$\{accessToken\}`/);
    expect(api).toContain('path === "/v1/availability"');
    expect(api).toContain('path === "/v1/availability/submissions"');
    expect(api).toContain('path === "/v1/availability/change-requests"');
    expect(api).toContain('path === "/v1/availability/candidates"');
    expect(api).toContain('availabilityDecisionRequestId(path)');
    expect(availabilityApi).toContain('clients.forAccessToken(bearerToken(request))');
    expect(availabilityApi).toContain('"submit_weekly_availability"');
    expect(availabilityApi).toContain('"request_availability_change"');
    expect(availabilityApi).toContain('"decide_availability_change"');
    expect(availabilityApi).toContain('p_actor_profile_id: actor.profileId');
    expect(availabilityApi).toContain('actor.role !== "maid"');
    expect(availabilityApi).toContain('requireBusinessAdmin(actor)');
    expect(availabilityApi).toContain('requirePasswordChanged(actor)');
    expect(openApi).toContain('operationId: "submitAvailability"');
    expect(openApi).toContain('AvailabilityChangeRequestInput');
    expect(openApi).toContain('"OUTSIDE_AVAILABILITY_WINDOW"');
    expect(openApi).toContain('"STALE_VERSION"');
  });

  it('ports all reservation operations through the existing actor-bound RPCs', async () => {
    const [api, reservationApi, openApi, consoleExport] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(reservationApiUrl, 'utf8'),
      readFile(openApiUrl, 'utf8'),
      readFile(new URL('../scripts/export-backend-console-openapi.ts', import.meta.url), 'utf8')
    ]);
    for (const path of [
      '/v1/reservations',
      '/v1/reservations/cleaning-requests',
      '/v1/reservations/transitions/process'
    ]) {
      expect(api).toContain(path);
    }
    for (const rpc of [
      'list_reservations',
      'get_reservation_detail',
      'create_reservation',
      'change_reservation',
      'cancel_reservation',
      'manual_checkout_reservation',
      'create_manual_cleaning_request',
      'cancel_manual_cleaning_request',
      'process_due_reservation_transitions'
    ]) {
      expect(reservationApi).toContain(`"${rpc}"`);
    }
    expect(reservationApi).toContain('recordSensitiveReservationRead');
    expect(reservationApi).toContain('requireBusinessAdmin(actor)');
    expect(reservationApi).toContain('requirePasswordChanged(actor)');
    expect(openApi).toContain('operationId: "listReservations"');
    expect(openApi).toContain('operationId: "processReservationTransitions"');
    expect(consoleExport).not.toContain('"/v1/reservations"');
  });

  it('keeps Fastify and Edge password and rate-limit contracts aligned', async () => {
    const [accountApi, password, authRoutes, openApi] = await Promise.all([
      readFile(accountApiUrl, 'utf8'),
      readFile(fastifyPasswordUrl, 'utf8'),
      readFile(fastifyAuthRoutesUrl, 'utf8'),
      readFile(openApiUrl, 'utf8')
    ]);

    const printableAsciiContract = String.raw`[\x20-\x7e]+`;
    expect(accountApi).toContain(printableAsciiContract);
    expect(password).toContain(printableAsciiContract);
    expect(accountApi).toMatch(/`tmp:\$\{value\}`/);
    expect(password).toMatch(/`tmp:\$\{password\}`/);
    expect(authRoutes).toContain("'LOGIN_RATE_LIMITED'");
    expect(accountApi).toContain('"LOGIN_RATE_LIMITED"');
    expect(openApi).toContain('"LOGIN_RATE_LIMITED"');
  });
});
