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
const assignmentApiUrl = new URL(
  '../supabase/functions/_shared/assignment-api.ts',
  import.meta.url
);
const reservationApiUrl = new URL(
  '../supabase/functions/_shared/reservation-api.ts',
  import.meta.url
);
const roomApiUrl = new URL('../supabase/functions/_shared/room-api.ts', import.meta.url);
const developerApiUrl = new URL('../supabase/functions/_shared/developer-api.ts', import.meta.url);
const activityApiUrl = new URL('../supabase/functions/_shared/activity-api.ts', import.meta.url);
const activityContractUrl = new URL(
  '../supabase/functions/_shared/activity-contract.ts',
  import.meta.url
);
const openApiUrl = new URL('../supabase/functions/_shared/openapi.ts', import.meta.url);
const fastifyPasswordUrl = new URL('../src/modules/auth/password.ts', import.meta.url);
const fastifyAuthRoutesUrl = new URL('../src/modules/auth/auth.routes.ts', import.meta.url);
const fastifyReservationRoutesUrl = new URL(
  '../src/modules/reservations/reservation.routes.ts',
  import.meta.url
);
const fastifyGuestNameUrl = new URL(
  '../src/modules/reservations/guest-name-crypto.ts',
  import.meta.url
);
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
    const [runtime, roomApi] = await Promise.all([
      readFile(runtimeUrl, 'utf8'),
      readFile(roomApiUrl, 'utf8')
    ]);

    expect(runtime).toMatch(/publicClient\.auth\s*\.getUser\(accessToken\)/);
    expect(runtime).toMatch(/\.from\(["']profiles["']\)/);
    expect(runtime).toMatch(/profile\.status !== ["']active["']/);
    expect(runtime).toMatch(/["']is_active_auth_session["']/);
    expect(runtime).toMatch(/role:\s*["']developer["']\s*\|\s*["']admin["']\s*\|\s*["']maid["']/);
    expect(runtime).toMatch(/actor\.role !== ["']admin["']/);
    expect(roomApi).toMatch(/requireBusinessAdmin\(actor\)/);
    expect(roomApi).toMatch(/["']get_room_operational_projection["']/);
  });

  it('keeps the cron invocation secret and scheduler actor checks ahead of the command RPC', async () => {
    const scheduler = await readFile(schedulerUrl, 'utf8');
    const secretCheck = scheduler.indexOf('matchesSecret(providedSecret, expectedSecret)');
    const actorCheck = scheduler.search(
      /requiredEnv\(\s*["']RESERVATION_SCHEDULER_ACTOR_PROFILE_ID["']/
    );
    const command = scheduler.search(/["']process_due_reservation_transitions["']/);
    const assignmentCommand = scheduler.search(
      /["']process_due_assignment_lifecycle["']/
    );

    expect(secretCheck).toBeGreaterThan(0);
    expect(actorCheck).toBeGreaterThan(secretCheck);
    expect(command).toBeGreaterThan(actorCheck);
    expect(assignmentCommand).toBeGreaterThan(command);
    expect(scheduler).toContain('crypto.subtle.verify');
    expect(scheduler).toContain('reservation-scheduler-$' + '{bucket}');
    expect(scheduler).toContain("const commandAt = new Date().toISOString()");
    expect(scheduler).toMatch(/p_as_of:\s*commandAt/);
    expect(scheduler).toContain('"assignment.process_due_lifecycle"');
    expect(scheduler).toContain("assignments: assignmentData");
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
      'expectedMigrationName = "assignment_attempt_activation"'
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
    expect(contract).toContain('edge.authorization.assignments');
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

  it('ports assignment draft revisions through RLS reads and an actor-bound command', async () => {
    const [api, assignmentApi, openApi] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(assignmentApiUrl, 'utf8'),
      readFile(openApiUrl, 'utf8')
    ]);

    expect(api).toContain('path === "/v1/assignments"');
    expect(api).toContain('path === "/v1/assignments/drafts"');
    expect(api).toContain('path === "/v1/assignments/commit-impact"');
    expect(api).toContain('path === "/v1/assignments/commit"');
    expect(api).toContain('assignmentTargetIdFromPath(path)');
    expect(assignmentApi).toContain('clients.forAccessToken(bearerToken(request))');
    expect(assignmentApi).toContain('"save_cleaning_assignment_draft"');
    expect(assignmentApi).toContain('"get_assignment_commit_impact"');
    expect(assignmentApi).toContain('"commit_and_notify_assignments"');
    expect(assignmentApi).toContain('p_actor_profile_id: actor.profileId');
    expect(assignmentApi).toContain('requireBusinessAdmin(actor)');
    expect(assignmentApi).toContain('requirePasswordChanged(actor)');
    expect(openApi).toContain('operationId: "listAssignments"');
    expect(openApi).toContain('operationId: "getAssignmentHistory"');
    expect(openApi).toContain('operationId: "saveAssignmentDraft"');
    expect(openApi).toContain('operationId: "getAssignmentCommitImpact"');
    expect(openApi).toContain('operationId: "commitAndNotifyAssignments"');
  });

  it('ports all reservation operations through the existing actor-bound RPCs', async () => {
    const [
      api,
      reservationApi,
      openApi,
      consoleExport,
      fastifyReservationRoutes,
      fastifyGuestName
    ] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(reservationApiUrl, 'utf8'),
      readFile(openApiUrl, 'utf8'),
      readFile(new URL('../scripts/export-backend-console-openapi.ts', import.meta.url), 'utf8'),
      readFile(fastifyReservationRoutesUrl, 'utf8'),
      readFile(fastifyGuestNameUrl, 'utf8')
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
    expect(reservationApi).toContain('startsWith("reservation-scheduler-")');
    expect(fastifyReservationRoutes).toContain("startsWith('reservation-scheduler-')");
    expect(reservationApi).toContain('RESERVED_IDEMPOTENCY_KEY');
    expect(fastifyReservationRoutes).toContain('RESERVED_IDEMPOTENCY_KEY');
    expect(openApi).toContain('not: { pattern: "^reservation-scheduler-" }');
    expect(openApi).toContain('"RESERVED_IDEMPOTENCY_KEY"');
    for (const source of [reservationApi, fastifyGuestName]) {
      const rawLengthCheck = source.indexOf('value.length < 1 || value.length > 80');
      const normalization = source.indexOf("normalize(\"NFKC\")") >= 0
        ? source.indexOf("normalize(\"NFKC\")")
        : source.indexOf("normalize('NFKC')");
      expect(rawLengthCheck).toBeGreaterThan(0);
      expect(normalization).toBeGreaterThan(rawLengthCheck);
    }
    expect(consoleExport).not.toContain('"/v1/reservations"');
  });

  it('ports all room operations through the existing actor-bound RPCs without PIN material', async () => {
    const [api, roomApi, openApi] = await Promise.all([
      readFile(apiUrl, 'utf8'),
      readFile(roomApiUrl, 'utf8'),
      readFile(openApiUrl, 'utf8')
    ]);
    for (const path of [
      '/v1/rooms/',
      '/master-data',
      '/operation-blocks',
      '/candles',
      '/issues',
      '/pin-sync-events'
    ]) {
      expect(api).toContain(path);
    }
    for (const rpc of [
      'get_room_operational_projection',
      'change_room_master_data',
      'mutate_room_operation'
    ]) {
      expect(roomApi).toContain(`"${rpc}"`);
    }
    for (const action of [
      'create_block',
      'release_block',
      'set_candle_count',
      'report_issue',
      'resolve_issue',
      'record_pin_sync'
    ]) {
      expect(roomApi).toContain(`"${action}"`);
    }
    expect(roomApi).toContain('requireBusinessAdmin(actor)');
    expect(roomApi).toContain('requirePasswordChanged(actor)');
    expect(api).toContain('roomDetailIdFromPath(path)');
    expect(api).not.toContain(
      'request.method === "GET" && path.startsWith("/v1/rooms/")'
    );
    expect(roomApi).toContain('SENSITIVE_TEXT_NOT_ALLOWED');
    expect(roomApi).toContain('PIN_MATERIAL_NOT_ALLOWED');
    expect(openApi).toContain('"changeRoomMasterData"');
    expect(openApi).toContain('"recordRoomPinSync"');
    expect(openApi).toContain('additionalProperties: false');
    expect(roomApi).not.toContain('.from("rooms")');
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
