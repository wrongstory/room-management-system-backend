import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOCAL_DB_CONTAINER, LOCAL_PROJECT_ID, SUPABASE_CLI_VERSION, validateLocalContainer,
  validateLocalDockerEndpoint, validateLocalProjectConfig } from './db-lint-baseline.mjs';

// Exact isolated local110 ->111 gate, not a production/recovery migration tool.
// Importing this module does not read fixtures, create files or start processes.
// SOURCE CANDIDATE: source/mock PASS is not an actual database upgrade PASS.
const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'node_modules', 'supabase', 'dist', 'supabase.js');
const migrationDirectory = join(root, 'supabase', 'migrations');
const manifestPath = join(root, 'supabase', 'migration-manifest.dev.json');
const migrationPattern = /^(\d{14})_([a-z0-9_]+)\.sql$/;
const temporaryPrefix = 'post-approval-room-issue-upgrade-';
const baselineVersion = '20261005011912', ledgerVersion = '20261005023103';
// dev8bdaec3 + #376: only unapplied db_static_warning_remediation changes.
// SHA256(JSON.stringify(the exact ordered 110 manifest records)).
export const POST_APPROVAL_UPGRADE_PREFIX_SHA256 = '607b6a288718b250a74319027a4b63ba43dd47212c7fc8fec1f7985a1e5de6d5';
// Same reviewed prefix: SHA256(JSON.stringify(ordered {file,sha256} pairs)).
// Manifest records omit versions; this independently pins every filename too.
export const POST_APPROVAL_UPGRADE_FILE_PREFIX_SHA256 = 'c2d8a88d2d458fc7ae185fbbb4f358c12a5074fb96493aeb77a638070b6d90b9';
export const POST_APPROVAL_UPGRADE_TABLES = Object.freeze([
  'private.post_approval_room_issue_drafts', 'private.post_approval_room_issue_draft_revisions',
  'private.post_approval_room_issue_reports', 'private.post_approval_issue_collections',
  'private.post_approval_issue_upload_admissions', 'private.post_approval_issue_quota_permits',
  'private.post_approval_issue_quota_refreshes', 'private.post_approval_issue_quota_permit_uses',
  'private.post_approval_issue_upload_operations', 'private.post_approval_issue_upload_handovers',
  'private.post_approval_issue_upload_states', 'private.post_approval_issue_upload_events',
  'private.post_approval_issue_provider_objects', 'private.post_approval_issue_folder_bindings',
  'private.post_approval_issue_identity_tombstones', 'private.post_approval_issue_evidence_acceptances',
  'private.post_approval_issue_evidence_items', 'private.post_approval_issue_report_seals',
  'private.post_approval_issue_report_closures', 'private.post_approval_issue_quota_pending',
  'private.post_approval_issue_delete_barriers', 'private.post_approval_issue_purge_jobs',
  'private.post_approval_issue_purge_scan',
]);
export const POST_APPROVAL_UPGRADE_PATCHES = Object.freeze([
  { signature: 'private.photo_quota_context(timestamp with time zone)',
    needle: "return jsonb_build_object('revision',q.revision",
    replacement: "pending:=pending+(select coalesce(sum(reserved_bytes),0)::bigint from private.post_approval_issue_quota_pending where operation_id is not null or expires_at>p_at)\n    +307200*(select count(*) from (select distinct actor_profile_id,key_digest from private.post_approval_issue_quota_permits p where p.expires_at>p_at\n      and not exists(select 1 from private.post_approval_issue_upload_admissions ad where ad.actor_profile_id=p.actor_profile_id and ad.idempotency_key_digest=p.key_digest)) permits);\n    return jsonb_build_object('revision',q.revision" },
  { signature: 'public.admit_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text)',
    needle: "'compensation_pending')))>=" + '8 then',
    replacement: "'compensation_pending')))+private.post_approval_issue_extra_inflight(p_actor_profile_id,at_time)>=8 then" },
  { signature: 'public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)',
    needle: "'compensation_pending'))) >= 8 then",
    replacement: "'compensation_pending'))) + private.post_approval_issue_extra_inflight(p_actor_profile_id,at_time) >= 8 then" },
  { signature: 'public.begin_photo_upload(uuid,uuid,uuid,uuid,bigint,uuid,bigint,text,text,integer,text,text)',
    needle: "(select count(*) from private.photo_upload_states where actor_profile_id=p_actor_profile_id and status in ('reserved','provider_succeeded'))>=8",
    replacement: 'private.post_approval_issue_single_transition_inflight(p_actor_profile_id,p_attempt_id,p_assignment_id,p_assignment_revision,p_target_slot_id,p_expected_photo_revision,p_idempotency_key_digest,clock_timestamp())>=8' },
  { signature: 'private.capture_photo_identity_tombstone()',
    needle: 'insert into private.photo_provider_identity_tombstones(locator_digest,object_id,folder_registry_id)',
    replacement: "if exists(select 1 from private.post_approval_issue_identity_tombstones where locator_digest=dig) then raise exception using errcode='23505',message='PHOTO_PROVIDER_IDENTITY_CONFLICT'; end if; insert into private.photo_provider_identity_tombstones(locator_digest,object_id,folder_registry_id)" },
  { signature: 'private.maybe_retire_photo_folder(uuid,timestamp with time zone)', needle: 'if eligible then',
    replacement: 'if exists(select 1 from private.post_approval_issue_provider_objects o where o.provider_folder_id=folder.provider_folder_id and o.purged_at is null)\n    or exists(select 1 from private.post_approval_issue_folder_bindings b join private.post_approval_issue_provider_objects o on o.operation_id=b.operation_id\n      where b.folder_registry_id=folder.id and o.purged_at is null) then eligible:=false; end if; if eligible then' },
  { signature: 'private.notification_source_is_valid(text,uuid,uuid,text,uuid,uuid,uuid)', needle: '\nbegin\n',
    replacement: "\nbegin\n if p_event_family='post_approval_room_issue.reported_admin' then return private.post_approval_issue_notification_valid(p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity); end if;\n" },
].map(Object.freeze));
export const POST_APPROVAL_UPGRADE_NOTIFICATION = Object.freeze({
  event_family: 'post_approval_room_issue.reported_admin', category: 'room_issue_reported',
  source_entity_kind: 'post_approval_room_issue_report', recipient_capability: 'admin.inspection_queue',
  requires_action: false, push_eligible: true, resolver_kind: 'none', deep_link_kind: 'submission',
  group_family: 'post_approval_room_issue_reported', group_scope_kind: 'room', contract_version: 1,
});
const oldTableTriggers = Object.freeze({
  'private.photo_storage_quota_snapshot.post_approval_issue_refresh_quota': {
    table: 'private.photo_storage_quota_snapshot', name: 'post_approval_issue_refresh_quota', type: 21,
    function: 'private.post_approval_issue_sync_quota', when: null,
  },
  'public.audit_events.post_approval_issue_report_notification': {
    table: 'public.audit_events', name: 'post_approval_issue_report_notification', type: 5,
    function: 'private.dispatch_post_approval_issue_notification',
    when: "new.event_type = 'post_approval_room_issue.reported'::text",
  },
});
const foreignKeysToOldTables = Object.freeze([
  ['private.post_approval_room_issue_drafts', ['reported_by_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_room_issue_drafts', ['assignment_id'], 'public.cleaning_assignments', ['id']],
  ['private.post_approval_room_issue_drafts', ['original_performer_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_room_issue_drafts', ['room_id'], 'public.rooms', ['id']],
  ['private.post_approval_room_issue_drafts', ['source_submission_id', 'cleaning_attempt_id'], 'public.cleaning_submissions', ['id', 'cleaning_attempt_id']],
  ['private.post_approval_room_issue_drafts', ['cleaning_attempt_id', 'cleaning_target_id'], 'public.cleaning_attempts', ['id', 'cleaning_target_id']],
  ['private.post_approval_room_issue_draft_revisions', ['actor_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_room_issue_reports', ['reported_by_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_issue_upload_admissions', ['actor_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_issue_quota_permits', ['actor_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_issue_upload_handovers', ['previous_actor_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_issue_upload_handovers', ['actor_profile_id'], 'public.profiles', ['id']],
  ['private.post_approval_issue_folder_bindings', ['folder_registry_id'], 'private.photo_drive_folder_identities', ['id']],
  ['private.post_approval_issue_report_closures', ['closed_by_profile_id'], 'public.profiles', ['id']],
]);
const snapshotNames = ['public.get_cleaning_attempt_lifecycle_impact', 'public.get_limited_cleaning_attempt',
  'public.get_offline_event_quarantine', 'public.list_checkout_cleaning_templates', 'public.list_offline_event_quarantine',
  'public.list_room_type_catalog', 'public.get_room_board_projection'];
const freshNames = ['private.assert_photo_upload_actor', 'private.cancel_unavailable_cleaning_assignment_at',
  'private.complete_limited_attempt_at', 'private.create_cleaning_submission_session_core',
  'private.manage_cleaning_attempt_lifecycle_at', 'private.resolve_offline_quarantine_at', 'private.start_attempt_with_lease_at',
  'private.sync_attempt_event_at', 'public.correct_room_occupancy', 'public.get_photo_upload_receipt_with_session',
  'public.list_limited_cleaning_attempts', 'public.list_room_events', 'public.list_room_issues', 'public.list_room_issues_page',
  'public.list_room_operation_blocks', 'public.list_room_operation_blocks_page', 'public.override_room_display_status',
  'public.publish_checkout_cleaning_template', 'public.list_room_reports_page'];
const callerNeedles = ['private.assert_attempt_actor_session(', 'private.assert_attempt_actor_session_fresh(',
  'private.assert_attempt_actor_session_at_clock('];
const oldProtectedTables = ['public.rooms', 'public.cleaning_targets', 'public.cleaning_assignments', 'public.cleaning_attempts',
  'public.cleaning_submissions', 'public.inspection_decisions', 'public.earnings', 'public.payroll_cycles',
  'private.attempt_photo_versions', 'private.submission_photo_bindings', 'private.submission_photo_binding_sets',
  'private.photo_provider_objects', 'private.photo_upload_acceptances', 'private.photo_retention_records',
  'private.photo_retention_links', 'private.attempt_room_issue_reports'];
const freshRelations = [...oldProtectedTables.filter(table => table !== 'public.rooms'),
  'auth.users', 'auth.sessions', 'public.profiles', 'public.reservations', 'private.command_executions',
  'private.notification_delivery_outbox', 'private.photo_upload_admissions', 'private.photo_upload_operations',
  'private.photo_upload_states', 'private.photo_provider_identity_tombstones', 'private.photo_storage_names',
  'private.photo_drive_folder_identities', 'private.photo_quota_pending', ...POST_APPROVAL_UPGRADE_TABLES];
export const POST_APPROVAL_UPGRADE_FRESH_TABLES = Object.freeze([...freshRelations]);
const sha = value => createHash('sha256').update(value).digest('hex');
const literal = value => `'${value.replaceAll("'", "''")}'`;
const same = (actual, expected, message) => assert.deepEqual([...actual].sort(), [...expected].sort(), message);
const count = (source, needle) => source.split(needle).length - 1;
const normalizeType = type => ({ timestamptz: 'timestamp with time zone', int: 'integer', bool: 'boolean' })[type] ?? type;
const identity = (name, types) => `${name}(${types.map(normalizeType).join(',')})`;
const ownerAcl = { grantor: 'postgres', grantee: 'postgres', privilege: 'EXECUTE', grantable: false };
const serviceAcl = { ...ownerAcl, grantee: 'service_role' };

export function validatePostApprovalUpgradeSource(manifest, entries) {
  assert.equal(manifest.schemaVersion, 1); assert.equal(manifest.release, 'dev');
  assert.equal(manifest.hashAlgorithm, 'sha256-lf-utf8'); assert([111,112,113].includes(manifest.totalCount));
  assert.equal(manifest.migrations.length, manifest.totalCount); assert.equal(entries.length, manifest.totalCount);
  assert.equal(manifest.head, { 111: 'post_approval_room_issue_ledger', 112: 'room_event_effective_lookup_indexes', 113: 'common_auth_context_read' }[manifest.totalCount]);
  assert.equal(manifest.pending.head, manifest.head); assert.equal(manifest.pending.count, manifest.totalCount - 78);
  assert.deepEqual(manifest.baseline, { count: 78, head: 'reservation_bookability_optional_guest_count' });
  assert.equal(sha(JSON.stringify(manifest.migrations.slice(0, 110))), POST_APPROVAL_UPGRADE_PREFIX_SHA256);
  let previous = '';
  const validated = [...entries].sort((a, b) => a.file.localeCompare(b.file)).map((entry, index) => {
    const match = migrationPattern.exec(entry.file), record = manifest.migrations[index];
    assert(entry.isFile === true && entry.isSymbolicLink === false && match && match[1] > previous);
    assert.deepEqual(Object.keys(record).sort(), ['name', 'order', 'sha256']);
    assert.equal(record.order, index + 1); assert.equal(record.name, match[2]);
    const bytes = Buffer.from(entry.raw), raw = bytes.toString('utf8');
    assert.deepEqual(Buffer.from(raw, 'utf8'), bytes, 'Reject non UTF-8 input instead of silently replacing bytes');
    const canonical = raw.replaceAll('\r\n', '\n'); assert(!canonical.includes('\r'));
    assert.equal(sha(canonical), record.sha256); previous = match[1];
    return { file: entry.file, version: match[1], name: match[2], sha256: record.sha256, rawSha256: sha(bytes), canonical };
  });
  assert.equal(sha(JSON.stringify(validated.slice(0, 110).map(({ file, sha256 }) => ({ file, sha256 })))),
    POST_APPROVAL_UPGRADE_FILE_PREFIX_SHA256, 'Exact dev110 filename/version and source SHA prefix required');
  assert.equal(validated[109].file, `${baselineVersion}_room_candle_session_hard_expiry.sql`);
  assert.equal(validated[110].file, `${ledgerVersion}_post_approval_room_issue_ledger.sql`);
  if (validated.length >= 112) {
    assert.equal(validated[111].file, '20261009081846_room_event_effective_lookup_indexes.sql');
    assert.equal(validated[111].sha256, 'dc9ee95371faa2b0daae9cd3b279c0b0d38c243581ca73bdc5e5260375aae41c',
      'Only the reviewed index-only112 tail is permitted, not arbitrary future migrations');
  }
  if (validated.length === 113) {
    assert.equal(validated[112].file, '20261010143530_common_auth_context_read.sql');
    assert.equal(validated[112].sha256, '522b9c0c146243a0c78013f756a4711ac491569361faae24cbd8749969784ffd',
      'Only the source-reviewed auth-context113 tail is permitted, not arbitrary future migrations');
  }
  return { entries: validated, ledger: validated[110].canonical };
}
export function validatePostApprovalUpgradeLocal({ args, env, config, endpoint, status, container, cliVersion }) {
  assert.deepEqual(args, [], 'No URL, target, version or skip override is accepted');
  for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
    'SUPABASE_WORKDIR', 'SUPABASE_PROJECT_ID', 'SUPABASE_DB_PORT', 'SUPABASE_SERVICES_HOSTNAME', 'SUPABASE_CLI_BINARY_OVERRIDE'])
    assert(!env[name], `Environment override is forbidden: ${name}`);
  const local = validateLocalProjectConfig(config); assert.equal(local.dbPort, 54322);
  const localEndpoint = validateLocalDockerEndpoint(endpoint); validateLocalContainer(container, local.dbPort);
  const address = new URL(status.API_URL);
  assert.equal(address.protocol, 'http:'); assert(['127.0.0.1', 'localhost'].includes(address.hostname));
  assert.equal(address.port, '54321'); assert.equal(address.pathname, '/');
  assert(!address.username && !address.password && !address.search && !address.hash);
  assert.equal(cliVersion.trim(), SUPABASE_CLI_VERSION);
  return { ...local, endpoint: localEndpoint };
}
export function assertPostApprovalUpgradeHistory(actual, source, installed = source.entries.length) {
  assert([110, 111, 112, 113].includes(installed) && installed <= source.entries.length);
  assert.deepEqual(actual, source.entries.slice(0, installed).map(({ version, name }) => ({ version, name })),
    'Exact version/name history is required, not count/head only');
}
export function assertPostApprovalUpgradeFresh(value) {
  assert.deepEqual(value, { rooms: 121, roomTypes: 4, publicWithoutRls: 0,
    rows: Object.fromEntries(freshRelations.map(relation => [relation, 0])) }, 'Fresh disposable local business/Auth baseline required');
}
export function postApprovalUpgradeFreshSql() {
  // 51 relations exceed PostgreSQL's 100-argument limit if expanded into
  // jsonb_build_object directly. VALUES + aggregation has no variadic limit.
  return `select jsonb_build_object('rooms',(select count(*) from public.rooms),
    'roomTypes',(select count(*) from public.room_types),'publicWithoutRls',(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind='r' and not c.relrowsecurity),'rows',
    (select jsonb_object_agg(relation,row_count) from (values ${freshRelations.map(table => `(${literal(table)},(select count(*) from ${table}))`).join(',')}) counts(relation,row_count)));`;
}
export function parsePostApprovalUpgradePlan(source) {
  const tables = [...source.matchAll(/^create table (private\.[a-z_]+)\s*\(/gm)].map(match => match[1]);
  same(tables, POST_APPROVAL_UPGRADE_TABLES, 'Exactly the approved 23 new private tables');
  const patchCalls = [...source.matchAll(/select private\.post_approval_issue_patch\('([^']+)',\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'\);/g)]
    .map(match => ({ signature: match[1].replaceAll('timestamptz', 'timestamp with time zone'),
      needle: match[2].replaceAll("''", "'"), replacement: match[3].replaceAll("''", "'") }));
  assert.deepEqual(patchCalls, POST_APPROVAL_UPGRADE_PATCHES.slice(0, 6));
  assert(source.includes("extension:=needle||' if p_event_family=''post_approval_room_issue.reported_admin'' then return private.post_approval_issue_notification_valid(p_actor,p_recipient,p_source_id,p_room,p_cleaning_target,p_deep_link_entity); end if;'||E'\\n';"));
  assert(source.includes("needle text:=E'\\nbegin\\n'"));
  const functions = [...source.matchAll(/create function ((?:public|private)\.[a-z_]+)\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\bas \$\$([\s\S]*?)\$\$;/g)]
    .filter(match => match[1] !== 'private.post_approval_issue_patch').map(match => {
      const args = match[2].trim() ? match[2].split(',').map(arg => arg.trim().split(/\s+/)) : [];
      const header = match[3];
      return { signature: identity(match[1], args.map(parts => parts[1])), name: match[1], source: match[4],
        language: /\blanguage (sql|plpgsql)\b/.exec(header)?.[1], returns: header.split(/\s+language\s+/)[0].trim().replace(/^setof /, ''),
        returnsSet: /^setof /.test(header),
        volatility: /\bimmutable\b/.test(header) ? 'i' : /\bstable\b/.test(header) ? 's' : 'v',
        securityDefiner: /\bsecurity definer\b/.test(header), args: args.map(parts => parts[0]),
        defaults: args.filter(parts => parts[2] === 'default').map(parts => parts.slice(3).join(' ')).join(', ').toUpperCase(),
        defaultCount: args.filter(parts => parts[2] === 'default').length,
      };
    });
  assert.equal(functions.length, 64); assert.equal(new Set(functions.map(fn => fn.signature)).size, 64);
  for (const fn of functions) assert(['sql', 'plpgsql'].includes(fn.language));
  return { tables, functions };
}
function exactPatchedSource(previous, patch) {
  assert.equal(count(previous, patch.needle), 1, 'An approved source anchor must appear exactly once');
  return previous.replace(patch.needle, patch.replacement);
}
function aclEqual(actual, expected) {
  assert(Array.isArray(actual), 'NULL or missing function ACL is not owner-only');
  const tuple = permission => JSON.stringify([permission.grantor, permission.grantee, permission.privilege, permission.grantable]);
  same(actual.map(tuple), expected.map(tuple), 'Exact grantor/grantee/EXECUTE/no-grant-option ACL');
}
export function assertPostApprovalUpgradeCallers(functions, installed) {
  assert([110, 111].includes(installed));
  const expected = [[...snapshotNames], [...freshNames], ['private.assert_attempt_actor_session', 'private.assert_attempt_actor_session_fresh']];
  if (installed === 111) { expected[0].push('public.get_post_approval_room_issue_source'); expected[1].push('private.assert_post_approval_room_issue_actor_fresh'); }
  for (const [index, needle] of callerNeedles.entries()) {
    const callers = Object.values(functions).filter(fn => fn.source.includes(needle));
    same(callers.map(fn => fn.name), expected[index], 'Exact global public/private helper inventory; no overload/name/count exception');
    if (index < 2) for (const fn of callers) assert.equal(fn.volatility, index === 0 ? 's' : 'v');
  }
  if (installed === 111) for (const [signature, own, acl] of [
    ['public.get_post_approval_room_issue_source(uuid,uuid,uuid)', 0, [ownerAcl, serviceAcl]],
    ['private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)', 1, [ownerAcl]],
  ]) {
    const fn = functions[signature]; assert(fn);
    for (const [index, needle] of callerNeedles.entries()) assert.equal(count(fn.source, needle), index === own ? 1 : 0);
    aclEqual(fn.acl, acl);
  }
}
export function assertPostApprovalUpgradeCatalog(before, after, plan) {
  const newSet = new Set(plan.tables);
  same(Object.keys(after.tables).filter(key => !Object.hasOwn(before.tables, key)), plan.tables);
  for (const group of ['tables', 'policies', 'indexes', 'constraints', 'triggers']) {
    for (const [key, value] of Object.entries(before[group])) assert.deepEqual(after[group][key], value, `Existing ${group} contract must remain exact`);
    if (group === 'tables' || group === 'triggers') continue;
    for (const [key, value] of Object.entries(after[group]).filter(([key]) => !Object.hasOwn(before[group], key))) {
      assert(newSet.has(value.table), `Unexpected ${group} addition outside new private tables: ${key}`);
      if (group === 'policies') assert.fail('New private tables must not gain a runtime policy');
    }
  }
  for (const table of plan.tables) {
    const contract = after.tables[table]; assert(contract);
    assert.equal(contract.owner, 'postgres'); assert.equal(contract.rls, true); assert.equal(contract.forceRls, true);
    assert.deepEqual(contract.runtimePrivileges, { anon: false, authenticated: false, service_role: false });
    assert.deepEqual(contract.runtimeColumnPrivileges, { anon: false, authenticated: false, service_role: false });
    assert(Array.isArray(contract.permissions) && contract.permissions.length > 0);
    for (const permission of contract.permissions) {
      assert.equal(permission.grantor, 'postgres'); assert.equal(permission.grantee, 'postgres'); assert.equal(permission.grantable, false);
    }
    assert(Array.isArray(contract.columns) && contract.columns.length > 0);
    for (const column of contract.columns) {
      assert(column.attribute && (column.attribute.attacl === null || Array.isArray(column.attribute.attacl)));
      assert(Array.isArray(column.permissions));
      if (column.attribute.attacl === null) assert.equal(column.permissions.length, 0);
      else assert(column.attribute.attacl.length > 0 && column.permissions.length > 0);
      for (const permission of column.permissions) {
        assert.equal(permission.grantor, 'postgres'); assert.equal(permission.grantee, 'postgres'); assert.equal(permission.grantable, false);
        assert(['SELECT', 'INSERT', 'UPDATE', 'REFERENCES'].includes(permission.privilege));
      }
    }
  }
  const foreignKeys = Object.values(after.constraints).filter(value => !Object.values(before.constraints).some(old => old.oid === value.oid)
    && value.kind === 'f' && Object.hasOwn(before.tables, value.references));
  same(foreignKeys.map(fk => JSON.stringify([fk.table, fk.columns, fk.references, fk.referenceColumns])), foreignKeysToOldTables.map(fk => JSON.stringify(fk)));
  for (const fk of foreignKeys) {
    assert.equal(fk.onDelete, 'r'); assert.equal(fk.onUpdate, 'a'); assert.equal(fk.match, 's');
    assert.equal(fk.deferrable, false); assert.equal(fk.deferred, false); assert.equal(fk.validated, true);
  }
  const additions = Object.entries(after.triggers).filter(([key, value]) => !Object.hasOwn(before.triggers, key) && Object.hasOwn(before.tables, value.table));
  const ordinary = additions.filter(([, trigger]) => !trigger.internal), internal = additions.filter(([, trigger]) => trigger.internal);
  same(ordinary.map(([key]) => key), Object.keys(oldTableTriggers));
  for (const [key, trigger] of ordinary) {
    const expected = oldTableTriggers[key];
    for (const field of ['table', 'name', 'type', 'function', 'when']) assert.deepEqual(trigger[field], expected[field]);
    assert.equal(trigger.enabled, 'O'); assert.equal(trigger.constraintOid, 0); assert.equal(trigger.args, '');
  }
  assert.equal(internal.length, foreignKeys.length * 2, 'Only exact FK-generated action triggers may be added to old tables');
  for (const fk of foreignKeys) {
    const triggers = internal.filter(([, trigger]) => trigger.constraintOid === fk.oid);
    same(triggers.map(([, trigger]) => trigger.function), ['pg_catalog.RI_FKey_noaction_upd', 'pg_catalog.RI_FKey_restrict_del']);
    for (const [, trigger] of triggers) {
      assert.equal(trigger.table, fk.references); assert(/^RI_ConstraintTrigger_a_\d+$/.test(trigger.name));
      assert.equal(trigger.enabled, 'O'); assert.equal(trigger.when, null); assert.equal(trigger.args, '');
      assert.equal(trigger.type, trigger.function.endsWith('_upd') ? 17 : 9);
    }
  }
  const changed = [];
  for (const [signature, prior] of Object.entries(before.functions)) {
    const current = after.functions[signature]; assert(current, 'No existing function may be removed or renamed');
    const patch = POST_APPROVAL_UPGRADE_PATCHES.find(value => value.signature === signature);
    if (!patch) { assert.deepEqual(current, prior, 'All non-allowlisted functions stay byte-exact'); continue; }
    const { source: oldSource, definition: oldDefinition, ...oldContract } = prior;
    const { source: newSource, definition: newDefinition, ...newContract } = current;
    assert.deepEqual(newContract, oldContract, 'Patched function OID/ACL/owner/language/defaults/types/config/volatility contract is unchanged');
    assert.equal(newSource, exactPatchedSource(oldSource, patch), 'Only the one exact approved source replacement is allowed');
    assert.notEqual(newDefinition, oldDefinition); changed.push(signature);
  }
  same(changed, POST_APPROVAL_UPGRADE_PATCHES.map(patch => patch.signature));
  const added = Object.keys(after.functions).filter(key => !Object.hasOwn(before.functions, key));
  same(added, plan.functions.map(fn => fn.signature));
  for (const expected of plan.functions) {
    const fn = after.functions[expected.signature];
    for (const key of ['name', 'source', 'language', 'returns', 'volatility', 'securityDefiner', 'args', 'defaultCount']) assert.deepEqual(fn[key], expected[key]);
    assert.equal(fn.owner, 'postgres'); assert.equal(fn.kind, 'f'); assert.deepEqual(fn.config, ['search_path=""']);
    assert.equal(fn.defaults.replaceAll('NULL::UUID', 'NULL'), expected.defaults);
    assert.equal(fn.strict, false); assert.equal(fn.leakproof, false); assert.equal(fn.parallel, 'u'); assert.equal(fn.returnsSet, expected.returnsSet);
    aclEqual(fn.acl, expected.name.startsWith('public.') ? [ownerAcl, serviceAcl] : [ownerAcl]);
  }
  assertPostApprovalUpgradeCallers(before.functions, 110); assertPostApprovalUpgradeCallers(after.functions, 111);
}

const catalogSql = `select jsonb_build_object(
 'tables',(select coalesce(jsonb_object_agg(n.nspname||'.'||c.relname,jsonb_build_object(
  'oid',c.oid,'rowType',c.reltype,'owner',pg_get_userbyid(c.relowner),'acl',to_jsonb(c.relacl),'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,
  'kind',c.relkind,'persistence',c.relpersistence,'replicaIdentity',c.relreplident,
  'permissions',(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
   'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)
   from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a),
  'runtimePrivileges',jsonb_build_object('anon',has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
   'authenticated',has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'),
   'service_role',has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')),
  'runtimeColumnPrivileges',jsonb_build_object('anon',has_any_column_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'),
   'authenticated',has_any_column_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,REFERENCES'),
   'service_role',has_any_column_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,REFERENCES')),
  'columns',(select jsonb_agg(jsonb_build_object('attribute',to_jsonb(a),'default',pg_get_expr(d.adbin,d.adrelid),
   'permissions',(select coalesce(jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(p.grantor),
    'grantee',case when p.grantee=0 then 'PUBLIC' else pg_get_userbyid(p.grantee) end,
    'privilege',p.privilege_type,'grantable',p.is_grantable) order by p.grantor,p.grantee,p.privilege_type,p.is_grantable),'[]'::jsonb)
    from aclexplode(a.attacl) p)) order by a.attnum)
   from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped))), '{}')
  from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth') and c.relkind in('r','p')),
 'policies',(select coalesce(jsonb_object_agg(n.nspname||'.'||c.relname||'.'||p.polname,jsonb_build_object('table',n.nspname||'.'||c.relname,
  'catalog',to_jsonb(p),'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))), '{}')
  from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','private','auth')),
 'indexes',(select coalesce(jsonb_object_agg(n.nspname||'.'||c.relname,jsonb_build_object('table',tn.nspname||'.'||t.relname,
  'catalog',to_jsonb(i),'definition',pg_get_indexdef(c.oid),'owner',pg_get_userbyid(c.relowner))), '{}')
  from pg_index i join pg_class c on c.oid=i.indexrelid join pg_namespace n on n.oid=c.relnamespace join pg_class t on t.oid=i.indrelid
  join pg_namespace tn on tn.oid=t.relnamespace where n.nspname in('public','private','auth')),
 'constraints',(select coalesce(jsonb_object_agg(n.nspname||'.'||c.relname||'.'||x.conname,jsonb_build_object('table',n.nspname||'.'||c.relname,
  'oid',x.oid::bigint,'kind',x.contype,'catalog',to_jsonb(x),'definition',pg_get_constraintdef(x.oid,true),'references',rn.nspname||'.'||rc.relname,
  'columns',(select jsonb_agg(a.attname order by keys.ordinality) from unnest(x.conkey) with ordinality keys(num,ordinality)
   join pg_attribute a on a.attrelid=x.conrelid and a.attnum=keys.num),
  'referenceColumns',(select jsonb_agg(a.attname order by keys.ordinality) from unnest(x.confkey) with ordinality keys(num,ordinality)
   join pg_attribute a on a.attrelid=x.confrelid and a.attnum=keys.num),
  'onDelete',x.confdeltype,'onUpdate',x.confupdtype,'match',x.confmatchtype,'deferrable',x.condeferrable,'deferred',x.condeferred,'validated',x.convalidated)), '{}')
  from pg_constraint x join pg_class c on c.oid=x.conrelid join pg_namespace n on n.oid=c.relnamespace
  left join pg_class rc on rc.oid=x.confrelid left join pg_namespace rn on rn.oid=rc.relnamespace where n.nspname in('public','private','auth')),
 'triggers',(select coalesce(jsonb_object_agg(n.nspname||'.'||c.relname||'.'||t.tgname,jsonb_build_object('table',n.nspname||'.'||c.relname,
  'name',t.tgname,'oid',t.oid,'catalog',to_jsonb(t),'definition',pg_get_triggerdef(t.oid,true),'internal',t.tgisinternal,'type',t.tgtype,
  'enabled',t.tgenabled,'constraintOid',t.tgconstraint::bigint,'function',fnn.nspname||'.'||fn.proname,'args',encode(t.tgargs,'hex'),
  'when',case when t.tgqual is null then null else substring(pg_get_triggerdef(t.oid,true) from ' WHEN \\((.*)\\) EXECUTE FUNCTION ') end)), '{}')
  from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
  join pg_proc fn on fn.oid=t.tgfoid join pg_namespace fnn on fnn.oid=fn.pronamespace where n.nspname in('public','private','auth')),
 'functions',(select coalesce(jsonb_object_agg(n.nspname||'.'||p.proname||'('||replace(oidvectortypes(p.proargtypes),', ',',')||')',jsonb_build_object(
  'name',n.nspname||'.'||p.proname,'oid',p.oid,'definition',pg_get_functiondef(p.oid),'source',p.prosrc,'kind',p.prokind,'owner',pg_get_userbyid(p.proowner),
  'acl',(select jsonb_agg(jsonb_build_object('grantor',pg_get_userbyid(a.grantor),'grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,
   'privilege',a.privilege_type,'grantable',a.is_grantable) order by a.grantor,a.grantee,a.privilege_type,a.is_grantable)
   from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),
  'rawAcl',to_jsonb(p.proacl),'config',to_jsonb(p.proconfig),'volatility',p.provolatile,'securityDefiner',p.prosecdef,'returns',p.prorettype::regtype::text,
  'language',l.lanname,'strict',p.proisstrict,'leakproof',p.proleakproof,'parallel',p.proparallel,'returnsSet',p.proretset,
  'args',coalesce(p.proargnames,array[]::text[]),'argumentTypes',p.proargtypes::text,'argumentModes',p.proargmodes,'allArgumentTypes',p.proallargtypes,
  'defaultCount',p.pronargdefaults,'defaults',upper(coalesce(pg_get_expr(p.proargdefaults,0),'')),'cost',p.procost,'rows',p.prorows,'variadic',p.provariadic)), '{}')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang where n.nspname in('public','private','auth') and p.prokind='f'));`;

function readSource() {
  const manifestRaw = readFileSync(manifestPath), manifest = JSON.parse(manifestRaw.toString('utf8'));
  const entries = readdirSync(migrationDirectory).filter(file => file.endsWith('.sql')).map(file => {
    const path = join(migrationDirectory, file), info = lstatSync(path);
    assert(info.isFile() && !info.isSymbolicLink(), 'Only regular non-symlink migration source files');
    return { file, raw: readFileSync(path), isFile: info.isFile(), isSymbolicLink: info.isSymbolicLink() };
  });
  return { ...validatePostApprovalUpgradeSource(manifest, entries), manifestRawSha256: sha(manifestRaw) };
}
export function postApprovalUpgradeLegacyFixture(source) {
  const anchor = 'from (select id from public.rooms order by room_number limit 1) r cross join session_fixture_clock c;';
  assert.equal(count(source, anchor), 1, 'Exact legacy fixture room selector required');
  // The supplemental history uses rooms1/2. Keep the real legacy workflow in
  // a different room so its start guard sees a valid independent workflow.
  return source.replace(anchor, anchor.replace('order by room_number limit', 'order by room_number desc limit'));
}
function fixtureParts() {
  const source = readFileSync(join(root, 'supabase', 'tests', 'post_approval_room_issue_ledger.sql'), 'utf8').replaceAll('\r\n', '\n');
  const begin = '-- BEGIN POST APPROVAL ROOM ISSUE SHARED FIXTURE', end = '-- END POST APPROVAL ROOM ISSUE SHARED FIXTURE';
  assert.equal(count(source, begin), 1); assert.equal(count(source, end), 1);
  const shared = source.split(begin)[1].split(end)[0];
  const cut = shared.indexOf('create function pg_temp.old_digest()'); assert(cut > 0);
  const legacy = shared.slice(0, cut); assert(legacy.trimEnd().endsWith('set local session_replication_role=origin;'));
  const idEnd = legacy.indexOf('insert into auth.users'); assert(idEnd > 0);
  const idFunction = legacy.slice(0, idEnd);
  const start = source.indexOf('create function pg_temp.typed_upload('), finish = source.indexOf('end $$;', start);
  assert(start >= 0 && finish > start);
  const uploadHelper = source.slice(start, finish + 7);
  const old = postApprovalUpgradeLegacyFixture(readFileSync(join(root, 'supabase', 'tests', 'auth_session_hard_expiry_fixture.psql'), 'utf8').replaceAll('\r\n', '\n'));
  for (const fragment of [legacy, idFunction, uploadHelper, old]) assert(!/\\ir|\b(?:no_plan|plan|finish)\s*\(/i.test(fragment));
  return { legacy, idFunction, uploadHelper, old };
}
function assertGeneratedWorkspace(workspace) {
  const taskTmp = realpathSync(join(root, '.tmp')), target = realpathSync(workspace);
  assert.equal(relative(realpathSync(root), taskTmp), '.tmp');
  assert.equal(relative(taskTmp, target), basename(workspace));
  assert(basename(workspace).startsWith(temporaryPrefix)); assert(!lstatSync(workspace).isSymbolicLink());
  return target;
}
export function preparePostApprovalUpgradeWorkspace(source) {
  const taskTmp = join(root, '.tmp'); mkdirSync(taskTmp, { recursive: true });
  assert.equal(relative(realpathSync(root), realpathSync(taskTmp)), '.tmp');
  const workspace = mkdtempSync(join(taskTmp, temporaryPrefix));
  try {
    assertGeneratedWorkspace(workspace);
    const target = join(workspace, 'supabase', 'migrations'); mkdirSync(target, { recursive: true });
    copyFileSync(join(root, 'supabase', 'config.toml'), join(workspace, 'supabase', 'config.toml'), constants.COPYFILE_EXCL);
    for (const entry of source.entries) {
      const destination = join(target, entry.file);
      assert(migrationPattern.test(entry.file)); assert.equal(relative(target, destination), entry.file);
      assert.equal(sha(entry.canonical), entry.sha256);
      writeFileSync(destination, entry.canonical, { encoding: 'utf8', flag: 'wx' });
      assert.equal(sha(readFileSync(destination)), entry.sha256);
    }
    return workspace;
  } catch (error) {
    try { rmSync(assertGeneratedWorkspace(workspace), { recursive: true, force: false }); }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], 'POST_APPROVAL_UPGRADE_PREPARE_AND_CLEANUP_FAILED'); }
    throw error;
  }
}
export function postApprovalUpgradeSqlState(error) {
  if (!error || typeof error !== 'object') return null;
  const value = Object.getOwnPropertyDescriptor(error, 'stderr')?.value;
  const stderr = typeof value === 'string' ? value : Buffer.isBuffer(value) ? value.toString('utf8') : '';
  const states = [...stderr.matchAll(/^ERROR:\s+([0-9A-Z]{5})\s*$/gm)].map(match => match[1]);
  return states.length === 1 ? states[0] : null;
}
export function runPostApprovalRoomIssueUpgrade() {
  let phase = 'source-preflight', resetStarted = false, workspace, source;
  const failures = [];
  const workspaces = [];
  const options = { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: false };
  const run = (binary, args, settings = {}) => execFileSync(binary, args, { ...options, ...settings });
  let localEnv;
  const sql = input => {
    try { return run('docker', ['--context', 'default', 'exec', '-i', LOCAL_DB_CONTAINER, 'psql', '-X', '-qAt',
      '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-U', 'postgres', '-d', 'postgres'], { input: `set statement_timeout='45s';set search_path='';${input}`, env: localEnv }).trim(); }
    catch (error) { throw Object.assign(new Error('POST_APPROVAL_UPGRADE_LOCAL_SQL_FAILED'), { sqlState: postApprovalUpgradeSqlState(error) }); }
  };
  const history = () => JSON.parse(sql("select coalesce(jsonb_agg(jsonb_build_object('version',version,'name',name) order by version),'[]'::jsonb) from supabase_migrations.schema_migrations;"));
  const fresh = () => assertPostApprovalUpgradeFresh(JSON.parse(sql(postApprovalUpgradeFreshSql())));
  const reset = version => run(process.execPath, [cli, '--workdir', assertGeneratedWorkspace(workspace), 'db', 'reset', '--local', '--no-seed',
    ...(version ? ['--version', version] : [])], { cwd: workspace, env: localEnv, timeout: 180000 });
  const rowsDigest = (tables, excludeNotification = false) => sql(`select md5(coalesce(string_agg(tag||':'||data,'|' order by tag,data),'')) from (
    ${tables.map(table => { assert(/^(public|private|auth)\.[a-z_][a-z_0-9]*$/.test(table));
      return `select ${literal(table)} tag,to_jsonb(t)::text data from ${table} t${excludeNotification && table === 'private.notification_event_catalog'
        ? " where event_family<>'post_approval_room_issue.reported_admin'" : ''}`; }).join(' union all ')}) old_whole_rows;`);
  const denied = (command, message) => sql(`do $deny$ begin begin ${command.replace(/^select /, 'perform ')}
    raise exception 'EXPECTED_POST_APPROVAL_UPGRADE_DENIAL'; exception when sqlstate '42501' then
      if sqlerrm<>${literal(message)} then raise exception 'UNEXPECTED_POST_APPROVAL_UPGRADE_DENIAL'; end if; end; end $deny$;`);
  const oldId = n => `f3520000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const id = n => `b3360000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const legacyCommand = (session = 201) => `select public.manage_cleaning_attempt_lifecycle('${oldId(1)}','${oldId(session)}',
    '${oldId(801)}',2,'${oldId(701)}',2,1,'allow_finish','{}','DEACTIVATION_FINISH_CURRENT','post-approval-upgrade-old-receipt',repeat('b',64));`;
  try {
    source = readSource(); const plan = parsePostApprovalUpgradePlan(source.ledger), fixtures = fixtureParts();
    phase = 'local-identity';
    assert.deepEqual(process.argv.slice(2), []);
    for (const name of ['DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
      'SUPABASE_WORKDIR', 'SUPABASE_PROJECT_ID', 'SUPABASE_DB_PORT', 'SUPABASE_SERVICES_HOSTNAME', 'SUPABASE_CLI_BINARY_OVERRIDE']) assert(!process.env[name]);
    const endpoint = run('docker', ['--context', 'default', 'context', 'inspect', 'default', '--format', '{{json .Endpoints.docker.Host}}']);
    validateLocalDockerEndpoint(endpoint);
    const container = run('docker', ['--context', 'default', 'inspect', '--format', '{"name":{{json .Name}},"running":{{json .State.Running}},"project":{{json (index .Config.Labels "com.supabase.cli.project")}},"ports":{{json .NetworkSettings.Ports}}}', LOCAL_DB_CONTAINER]);
    const status = JSON.parse(run(process.execPath, [cli, '--workdir', root, 'status', '--output', 'json'],
      { env: { ...process.env, DOCKER_HOST: validateLocalDockerEndpoint(endpoint), DOCKER_CONTEXT: 'default' } }));
    const local = validatePostApprovalUpgradeLocal({ args: process.argv.slice(2), env: process.env,
      config: readFileSync(join(root, 'supabase', 'config.toml'), 'utf8'), endpoint, status, container,
      cliVersion: run(process.execPath, [cli, '--version']) });
    localEnv = { ...process.env, DOCKER_HOST: local.endpoint, DOCKER_CONTEXT: 'default', SUPABASE_PROJECT_ID: LOCAL_PROJECT_ID,
      SUPABASE_DB_PORT: String(local.dbPort), SUPABASE_SERVICES_HOSTNAME: '127.0.0.1' };
    phase = 'initial-exact-tip-fresh'; assertPostApprovalUpgradeHistory(history(), source); fresh();
    // Keep the historical110->111 experiment exact. Never let a later index
    // migration run before the original whole-row/catalog preservation checks.
    workspace = preparePostApprovalUpgradeWorkspace({ ...source, entries: source.entries.slice(0,111) });
    workspaces.push(workspace); resetStarted = true;
    phase = 'baseline110'; reset(baselineVersion); assertPostApprovalUpgradeHistory(history(), source, 110);
    phase = 'legacy-fixture-seed';
    // Only historical fixture seeding disables triggers. Migration, replay and
    // every new command run with origin triggers; no old workflow PASS claim.
    sql(`begin;${fixtures.legacy}${fixtures.old}
      set local session_replication_role=replica;
      insert into public.earnings(id,earning_entitlement_id,submission_id,maid_profile_id,earned_on,base_amount,bomb_room_bonus)
        values('${id(5602)}','${id(4002)}','${id(4002)}','${id(2)}',(clock_timestamp() at time zone 'Asia/Seoul')::date-9,10000,0);
      set local session_replication_role=origin;commit;`);
    phase = 'legacy-real-receipt';
    const receipt = JSON.parse(sql(legacyCommand()));
    phase = 'legacy-catalog-and-digest';
    const before = JSON.parse(sql(catalogSql)); assertPostApprovalUpgradeCallers(before.functions, 110);
    const tables = Object.keys(before.tables).sort();
    const oldDigest = rowsDigest(tables), protectedDigest = rowsDigest(oldProtectedTables);
    const oldDto = sql(`select private.submission_projection('${id(4002)}');`);
    phase = 'upgrade110-to111'; run(process.execPath, [cli, '--workdir', workspace, 'migration', 'up', '--local'], { cwd: workspace, env: localEnv, timeout: 180000 });
    assertPostApprovalUpgradeHistory(history(), source, 111);
    const after = JSON.parse(sql(catalogSql)); assertPostApprovalUpgradeCatalog(before, after, plan);
    assert.equal(rowsDigest(tables, true), oldDigest, 'Every old whole row is preserved except the exact one new notification catalog row');
    assert.deepEqual(JSON.parse(sql("select to_jsonb(c) from private.notification_event_catalog c where event_family='post_approval_room_issue.reported_admin';")), POST_APPROVAL_UPGRADE_NOTIFICATION);
    for (const table of plan.tables) assert.equal(sql(`select count(*) from ${table};`), '0', 'New private tables are empty; no historical backfill');
    phase = 'old-receipt-replay-and-expired-session-denial';
    assert.deepEqual(JSON.parse(sql(legacyCommand())), receipt);
    denied(legacyCommand(401), 'SESSION_REVOKED');
    assert.equal(rowsDigest(tables, true), oldDigest, 'Legacy replay and denial cannot renew or rewrite old rows/receipts');
    phase = 'new-minimal-report-flow';
    const draft = `select public.save_post_approval_room_issue_draft('${id(2)}','${id(202)}','${id(4002)}','${id(6601)}',0,'synthetic memo',repeat('6',64),repeat('7',64));`;
    const finalized = `select public.finalize_post_approval_room_issue_report('${id(2)}','${id(202)}','${id(4002)}','${id(6601)}',1,1,
      'synthetic memo',jsonb_build_array(jsonb_build_object('evidenceId','${id(6701)}','revision',1,'displayOrder',0)),repeat('8',64),repeat('9',64));`;
    const result = JSON.parse(sql(`begin;${fixtures.idFunction}${fixtures.uploadHelper}
      create temp table upgrade_results(label text primary key,value jsonb);
      select public.refresh_photo_storage_quota(clock_timestamp(),1000);
      insert into upgrade_results values('draft',(${draft.replace(/^select /, '').replace(/;$/, '')}));
      insert into upgrade_results values('upload',pg_temp.typed_upload(6601,6701));
      insert into upgrade_results values('report',(${finalized.replace(/^select /, '').replace(/;$/, '')}));
      select jsonb_object_agg(label,value) from upgrade_results;commit;`).split('\n').at(-1));
    assert.equal(result.draft.draft.draftRevision, 1); assert.equal(result.upload.status, 'accepted');
    const report = JSON.parse(sql(finalized)); assert.deepEqual(report, result.report);
    denied(`select public.get_post_approval_room_issue_source('${id(3)}','${id(203)}','${id(4002)}');`, 'POST_APPROVAL_ROOM_ISSUE_ACCESS_REQUIRED');
    denied(draft.replace(id(202), id(205)), 'SESSION_REVOKED');
    assert.equal(sql(`select count(*) from private.post_approval_room_issue_reports where source_submission_id='${id(4002)}' and client_report_id='${id(6601)}' and evidence_count=1;`), '1');
    assert.equal(sql(`select count(*) from private.post_approval_issue_report_seals s join private.post_approval_room_issue_reports r on r.id=s.report_id where r.client_report_id='${id(6601)}';`), '1');
    assert.equal(rowsDigest(oldProtectedTables), protectedDigest, 'New report cannot rewrite old submission/photos/inspection/earnings/room business state');
    assert.equal(sql(`select private.submission_projection('${id(4002)}');`), oldDto);
  } catch (error) {
    const sqlState = error?.sqlState;
    const sourceLine = error instanceof Error ? error.stack?.match(/test-post-approval-room-issue-upgrade\.mjs:(\d+):\d+/)?.[1] : null;
    failures.push({ phase, kind: error instanceof assert.AssertionError ? 'ASSERTION_FAILED' : 'VALIDATION_FAILED',
      sqlState: typeof sqlState === 'string' && /^[0-9A-Z]{5}$/.test(sqlState) ? sqlState : null,
      sourceLine: sourceLine ? Number(sourceLine) : null });
  }
  finally {
    if (resetStarted) {
      try {
        phase = 'final-fresh-tip-cleanup';
        if (source.entries.length > 111) {
          workspace = preparePostApprovalUpgradeWorkspace(source); workspaces.push(workspace);
        }
        reset(); assertPostApprovalUpgradeHistory(history(), source); fresh();
      }
      catch { failures.push({ phase, kind: 'FRESH_CLEANUP_FAILED' }); }
    }
    if (source) {
      try {
        assert.equal(sha(readFileSync(manifestPath)), source.manifestRawSha256);
        same(readdirSync(migrationDirectory).filter(file => file.endsWith('.sql')), source.entries.map(entry => entry.file));
        for (const entry of source.entries) {
          const path = join(migrationDirectory, entry.file), info = lstatSync(path);
          assert(info.isFile() && !info.isSymbolicLink()); assert.equal(sha(readFileSync(path)), entry.rawSha256);
        }
      }
      catch { failures.push({ phase: 'source-raw-preservation', kind: 'SOURCE_CHANGED' }); }
    }
    for (const generated of workspaces) {
      try { rmSync(assertGeneratedWorkspace(generated), { recursive: true, force: false }); }
      catch { failures.push({ phase: 'temporary-workspace-cleanup', kind: 'GENERATED_CLEANUP_FAILED' }); }
    }
  }
  if (failures.length) { console.error(`Post-approval room issue upgrade FAIL: ${JSON.stringify({ failures })}`); return false; }
  console.log(`Post-approval room issue upgrade110->111 PASS: exact frozen110 prefix +111; old whole rows, OID/ACL/RLS/catalog preserved; seven exact source patches/two old-table triggers plus exact FK action triggers; 23 empty new private tables; real old receipt replay/denial; actual new typed report; final fresh${source.entries.length} cleanup; raw originals unchanged.`);
  return true;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!runPostApprovalRoomIssueUpgrade()) process.exitCode = 1;
}
