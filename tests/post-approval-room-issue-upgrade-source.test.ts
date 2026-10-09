import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

// Pure source/catalog mocks only; never execute the exported DB runner here.
const { execFileSync } = vi.hoisted(() => ({ execFileSync: vi.fn(() => { throw new Error('PROCESS_ACCESS_FORBIDDEN_IN_SOURCE_TEST'); }) }));
vi.mock('node:child_process', () => ({ execFileSync }));
const { filesystem } = vi.hoisted(() => ({ filesystem: Object.fromEntries([
  'mkdirSync', 'mkdtempSync', 'copyFileSync', 'writeFileSync', 'readFileSync', 'rmSync', 'realpathSync', 'lstatSync',
].map(name => [name, vi.fn<(...args: unknown[]) => unknown>(() => { throw new Error('FILESYSTEM_ACCESS_FORBIDDEN_IN_SOURCE_TEST'); })])) }));
vi.mock('node:fs', async importOriginal => ({ ...await importOriginal<typeof import('node:fs')>(), ...filesystem }));
import { POST_APPROVAL_UPGRADE_FILE_PREFIX_SHA256, POST_APPROVAL_UPGRADE_FRESH_TABLES, POST_APPROVAL_UPGRADE_PATCHES, POST_APPROVAL_UPGRADE_PREFIX_SHA256,
  POST_APPROVAL_UPGRADE_TABLES, assertPostApprovalUpgradeCallers, assertPostApprovalUpgradeCatalog,
  assertPostApprovalUpgradeFresh, assertPostApprovalUpgradeHistory, parsePostApprovalUpgradePlan, postApprovalUpgradeFreshSql, preparePostApprovalUpgradeWorkspace,
  validatePostApprovalUpgradeLocal, validatePostApprovalUpgradeSource, postApprovalUpgradeSqlState, postApprovalUpgradeLegacyFixture,
  type UpgradeFunctionSpec, type UpgradeSourceEntry } from '../scripts/test-post-approval-room-issue-upgrade.mjs';

const sourceUrl = new URL('../scripts/test-post-approval-room-issue-upgrade.mjs', import.meta.url);
describe('upgrade SQL diagnostics', () => {
  it('keeps the real legacy workflow separate from both historical source rooms without changing its commands', async () => {
    const source = await readFile(new URL('../supabase/tests/auth_session_hard_expiry_fixture.psql', import.meta.url), 'utf8');
    const result = postApprovalUpgradeLegacyFixture(source);
    expect(result.replace('order by room_number desc limit', 'order by room_number limit')).toBe(source);
    expect(result).toContain('private.execute_cleaning_attempt_at(');
    expect(() => postApprovalUpgradeLegacyFixture(source + source)).toThrow('Exact legacy fixture room selector required');
    expect(() => postApprovalUpgradeLegacyFixture(source.replace('order by room_number limit', 'order by id limit'))).toThrow();
  });
  it('returns only one SQLSTATE and never raw SQL, identifiers or canary secrets', () => {
    expect(postApprovalUpgradeSqlState({ stderr: 'ERROR: 23505\n' })).toBe('23505');
    expect(postApprovalUpgradeSqlState({ stderr: Buffer.from('ERROR: 42P01\r\n') })).toBe('42P01');
    for (const value of [null, 'synthetic-secret', {}, { stderr: 'ERROR: raw-synthetic-secret' },
      { stderr: 'ERROR: 23505 raw-synthetic-secret' }, { stderr: 'ERROR: 23505\nERROR: 42P01\n' }]) {
      expect(postApprovalUpgradeSqlState(value)).toBeNull();
    }
    const getter = Object.defineProperty({}, 'stderr', { get() { throw new Error('synthetic-secret'); } });
    expect(postApprovalUpgradeSqlState(getter)).toBeNull();
  });
});
const script = await readFile(sourceUrl, 'utf8');
const manifest = JSON.parse(await readFile(new URL('../supabase/migration-manifest.dev.json', import.meta.url), 'utf8')) as {
  totalCount: number; migrations: { order: number; name: string; sha256: string }[];
};
const config = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8');
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
// Independent literal inventory: all prior 27 gates must remain in this exact
// order. The candidate is gate28, never a replacement for an older upgrade.
const previousUpgradeCommands = Object.freeze([
  'test-production-v56-upgrade.mjs', 'test-production-v73-upgrade.mjs',
  'test-payroll-payment-upgrade.mjs', 'test-room-pin-nonce-upgrade.mjs',
  'test-checkout-incident-upgrade.mjs', 'test-cleaning-template-duration-upgrade.mjs',
  'test-reservation-during-stay-upgrade.mjs', 'test-photo-retention-upgrade.mjs',
  'test-room-pin-entitlement-upgrade.mjs', 'test-reservation-long-stay-upgrade.mjs',
  'test-reservation-bookability-upgrade.mjs', 'test-flat-evidence-upgrade.mjs',
  'test-cleaning-overdue-upgrade.mjs', 'test-cleaning-started-upgrade.mjs',
  'test-cleaning-overdue-preview-upgrade.mjs', 'test-cleaning-overdue-commit-upgrade.mjs',
  'test-cleaning-report-notifications-upgrade.mjs', 'test-complaint-response-attention-upgrade.mjs',
  'test-manual-cleaning-cancel-upgrade.mjs', 'test-assignment-target-read-upgrade.mjs',
  'test-assignment-reservation-schedule-upgrade.mjs', 'test-checkout-incident-list-upgrade.mjs',
  'test-payroll-adjustment-book-upgrade.mjs', 'test-payroll-work-details-upgrade.mjs',
  'test-payroll-remittance-marker-upgrade.mjs', 'test-auth-session-hard-expiry-upgrade.mjs',
  'test-limited-existing-session-upgrade.mjs',
].map(file => `node scripts/${file}`));
const candidateUpgradeCommand = 'node scripts/test-post-approval-room-issue-upgrade.mjs';
const fullSqlCommand = 'supabase test db supabase/tests --local';
const expectedDbCommands = [...previousUpgradeCommands, candidateUpgradeCommand, fullSqlCommand];
function assertRequiredDbTestCommand(command: string): void {
  const commands = command.split(' && ');
  expect(commands).toEqual(expectedDbCommands);
  expect(new Set(commands).size).toBe(29);
}
const migrationRoot = new URL('../supabase/migrations/', import.meta.url);
const files = (await readdir(migrationRoot)).filter(file => file.endsWith('.sql')).sort();
const entries: UpgradeSourceEntry[] = await Promise.all(files.map(async file => ({ file,
  raw: await readFile(new URL(file, migrationRoot)), isFile: true, isSymbolicLink: false })));
const source = validatePostApprovalUpgradeSource(manifest, entries);
describe('#376 reviewed prefix transition', () => {
  it('differs from the previous pinned prefix only in the unapplied remediation hash', () => {
    const previous = structuredClone(manifest.migrations.slice(0, 110));
    const remediation = previous.find(row => row.name === 'db_static_warning_remediation');
    expect(remediation?.sha256).toBe('3a1e8ac07b23b04e5f4745f5a079d5bb9493e4bc6d07b0033d14905385c3338b');
    if (!remediation) throw new Error('REMEDIATION_MISSING');
    remediation.sha256 = '9f6eab7b1389b5c552ace273726533a69a1b0aebc6813090771b068d28f16dc8';
    expect(createHash('sha256').update(JSON.stringify(previous)).digest('hex'))
      .toBe('42bc765c49aa9bf5e31fd0ef775afc1182420a3eb73860c465d44eca51080c66');
    expect(createHash('sha256').update(JSON.stringify(files.slice(0, 110).map((file, i) =>
      ({ file, sha256: previous[i]?.sha256 })))).digest('hex'))
      .toBe('508f635d1981de6f9a881ab5cc60c1188a152019094f8a23bc97ea369d0deaa0');
  });
});
const plan = parsePostApprovalUpgradePlan(source.ledger);
const clone = <T>(value: T): T => structuredClone(value);
function get<T>(record: Record<string, T>, key: string): T {
  const value = record[key]; if (!value) throw new Error('SYNTHETIC_CATALOG_ENTRY_MISSING'); return value;
}
const ownerAcl = { grantor: 'postgres', grantee: 'postgres', privilege: 'EXECUTE', grantable: false };
const serviceAcl = { ...ownerAcl, grantee: 'service_role' };
type Acl = typeof ownerAcl;
type Fn = Partial<UpgradeFunctionSpec> & { name: string; source: string; definition: string; volatility: string;
  oid: number; owner: string; acl: Acl[] | null; kind: string; config: string[] | null;
  strict: boolean; leakproof: boolean; parallel: string; returnsSet: boolean };
type Table = { owner: string; rls: boolean; forceRls: boolean; columns: { attribute: { attname: string; attacl: string[] | null }; default: null; permissions: Acl[] }[];
  runtimePrivileges: { anon: boolean; authenticated: boolean; service_role: boolean };
  runtimeColumnPrivileges: { anon: boolean; authenticated: boolean; service_role: boolean }; permissions: Acl[] };
type Constraint = { table: string; oid: number; kind: string; references: string | null;
  columns: string[]; referenceColumns: string[]; onDelete: string; onUpdate: string; match: string;
  deferrable: boolean; deferred: boolean; validated: boolean };
type Trigger = { table: string; name: string; oid: number; internal: boolean; type: number;
  enabled: string; function: string; when: string | null; args: string; constraintOid: number };
type Catalog = { tables: Record<string, Table>; policies: Record<string, { table: string; check: string }>;
  indexes: Record<string, { table: string; definition: string }>; constraints: Record<string, Constraint>;
  triggers: Record<string, Trigger>; functions: Record<string, Fn> };
function namesFromMigration(needle: string): string[] {
  const immutable = source.entries[100]?.canonical; if (!immutable) throw new Error('SYNTHETIC_BASELINE_MISSING');
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const section = immutable.match(new RegExp(`\\('${escaped}',array\\[([\\s\\S]*?)\\]::text\\[\\]\\)`))?.[1];
  if (!section) throw new Error('SYNTHETIC_BASELINE_CALLERS_MISSING');
  return [...section.matchAll(/'((?:public|private)\.[a-z_]+)'/gu)].map(match => String(match[1]));
}
const needles = ['private.assert_attempt_actor_session(', 'private.assert_attempt_actor_session_fresh(', 'private.assert_attempt_actor_session_at_clock('];
const snapshotNames = [...namesFromMigration(String(needles[0])), 'public.get_room_board_projection'];
const freshNames = [...namesFromMigration(String(needles[1])), 'public.list_room_reports_page'];
const coreNames = namesFromMigration(String(needles[2]));
function table(): Table {
  return { owner: 'postgres', rls: true, forceRls: true, columns: [{ attribute: { attname: 'id', attacl: null }, default: null, permissions: [] }],
    runtimePrivileges: { anon: false, authenticated: false, service_role: false },
    runtimeColumnPrivileges: { anon: false, authenticated: false, service_role: false }, permissions: [clone(ownerAcl)] };
}
function fn(name: string, body: string, volatility = 'v', oid = 100): Fn {
  return { name, source: body, definition: `CREATE FUNCTION ${name}\n${body}`, volatility,
    oid, owner: 'postgres', acl: [clone(ownerAcl)], kind: 'f', config: ['search_path=""'],
    strict: false, leakproof: false, parallel: 'u', returnsSet: false };
}
function baseline(): Catalog {
  const result: Catalog = { tables: {}, policies: {}, indexes: {}, constraints: {}, triggers: {}, functions: {} };
  for (const name of ['public.profiles', 'public.cleaning_assignments', 'public.rooms', 'public.cleaning_submissions',
    'public.cleaning_attempts', 'private.photo_drive_folder_identities', 'private.photo_storage_quota_snapshot', 'public.audit_events'])
    result.tables[name] = table();
  result.policies.old = { table: 'public.profiles', check: 'own identity' };
  result.indexes.old = { table: 'public.profiles', definition: 'CREATE UNIQUE INDEX old' };
  result.constraints.old = { table: 'public.profiles', oid: 50, kind: 'p', references: null, columns: ['id'], referenceColumns: [],
    onDelete: ' ', onUpdate: ' ', match: ' ', deferrable: false, deferred: false, validated: true };
  result.triggers.old = { table: 'public.profiles', name: 'old', oid: 51, internal: false, type: 7,
    enabled: 'O', function: 'private.old', when: null, args: '', constraintOid: 0 };
  for (const [index, names] of [snapshotNames, freshNames, coreNames].entries()) for (const name of names)
    result.functions[`${name}(uuid)`] = fn(name, String(needles[index]), index === 0 ? 's' : index === 1 ? 'v' : 's');
  for (const patch of POST_APPROVAL_UPGRADE_PATCHES) result.functions[patch.signature] = fn(patch.signature.split('(')[0] ?? '', `prefix${patch.needle}suffix`);
  return result;
}
function installed(before: Catalog): Catalog {
  const result = clone(before);
  for (const name of plan.tables) result.tables[name] = table();
  for (const patch of POST_APPROVAL_UPGRADE_PATCHES) {
    const value = get(result.functions, patch.signature); value.source = value.source.replace(patch.needle, patch.replacement);
    value.definition = `CREATE FUNCTION ${value.name}\n${value.source}`;
  }
  for (const spec of plan.functions) result.functions[spec.signature] = { ...spec,
    defaults: spec.defaults === 'NULL' ? 'NULL::UUID' : spec.defaults,
    oid: 500 + Object.keys(result.functions).length, owner: 'postgres', definition: `CREATE FUNCTION ${spec.name}\n${spec.source}`,
    acl: clone(spec.name.startsWith('public.') ? [ownerAcl, serviceAcl] : [ownerAcl]), kind: 'f', config: ['search_path=""'],
    strict: false, leakproof: false, parallel: 'u' };
  result.triggers['private.photo_storage_quota_snapshot.post_approval_issue_refresh_quota'] = { table: 'private.photo_storage_quota_snapshot',
    name: 'post_approval_issue_refresh_quota', oid: 800, internal: false, type: 21, enabled: 'O',
    function: 'private.post_approval_issue_sync_quota', when: null, args: '', constraintOid: 0 };
  result.triggers['public.audit_events.post_approval_issue_report_notification'] = { table: 'public.audit_events',
    name: 'post_approval_issue_report_notification', oid: 801, internal: false, type: 5, enabled: 'O',
    function: 'private.dispatch_post_approval_issue_notification', when: "new.event_type = 'post_approval_room_issue.reported'::text", args: '', constraintOid: 0 };
  // Derive source-declared FK pairs independently; do not import validator's
  // allowlist or exempt every internal trigger indiscriminately.
  for (const match of source.ledger.matchAll(/^create table (private\.[a-z_]+)\s*\(([\s\S]*?)^\);/gmu)) {
    const name = String(match[1]), body = String(match[2]);
    const refs = [...body.matchAll(/(?:^|,)\s*((?!foreign\b)[a-z_]+) [^,\n]*?references ((?:public|private)\.[a-z_]+)\(([^)]+)\) on delete restrict/gmu)]
      .map(fk => ({ columns: [String(fk[1])], target: String(fk[2]), targetColumns: String(fk[3]).split(',') }));
    refs.push(...[...body.matchAll(/foreign key\(([^)]+)\)\s+references ((?:public|private)\.[a-z_]+)\(([^)]+)\) on delete restrict/gu)]
      .map(fk => ({ columns: String(fk[1]).split(','), target: String(fk[2]), targetColumns: String(fk[3]).split(',') })));
    for (const reference of refs.filter(fk => Object.hasOwn(before.tables, fk.target))) {
      const oid = 1000 + Object.keys(result.constraints).length;
      result.constraints[`${name}.fk_${oid}`] = { table: name, oid, kind: 'f', references: reference.target,
        columns: reference.columns, referenceColumns: reference.targetColumns, onDelete: 'r', onUpdate: 'a', match: 's',
        deferrable: false, deferred: false, validated: true };
      for (const action of ['upd', 'del']) {
        const trigger = `RI_ConstraintTrigger_a_${oid * 2 + (action === 'del' ? 1 : 0)}`;
        result.triggers[`${reference.target}.${trigger}`] = { table: reference.target, name: trigger, oid: oid * 2,
          internal: true, type: action === 'upd' ? 17 : 9, enabled: 'O', function: `pg_catalog.RI_FKey_${action === 'upd' ? 'noaction_upd' : 'restrict_del'}`,
          when: null, args: '', constraintOid: oid };
      }
    }
  }
  return result;
}
const localInput = { args: [], env: {}, config, endpoint: JSON.stringify('unix:///var/run/docker.sock'),
  status: { API_URL: 'http://127.0.0.1:54321' }, cliVersion: '2.115.0',
  container: JSON.stringify({ name: '/supabase_db_room-management-system-backend', running: true,
    project: 'room-management-system-backend', ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '54322' }] } }) };

describe('#336 isolated110->111 source/preflight only (no DB PASS claim)', () => {
  it('accepts historical111 and only the reviewed112 tail despite a matching altered manifest hash', () => {
    const historical = { ...manifest, totalCount: 111, head: 'post_approval_room_issue_ledger',
      pending: { count: 33, head: 'post_approval_room_issue_ledger' }, migrations: manifest.migrations.slice(0,111) };
    expect(() => validatePostApprovalUpgradeSource(historical, entries.slice(0,111))).not.toThrow();
    const changed = clone(entries), last = changed[111];
    const changedManifest = clone(manifest), record = changedManifest.migrations[111];
    if (!last || !record) throw new Error('EXPECTED112_TAIL');
    last.raw = Buffer.from('select 1;\n');
    record.sha256 = createHash('sha256').update(last.raw).digest('hex');
    expect(() => validatePostApprovalUpgradeSource(changedManifest, changed)).toThrow('Only the reviewed index-only112 tail');
    const renamed = clone(entries), tail = renamed[111];
    if (!tail) throw new Error('EXPECTED112_TAIL');
    tail.file = '20261009081847_room_event_effective_lookup_indexes.sql';
    expect(() => validatePostApprovalUpgradeSource(manifest, renamed)).toThrow();
  });
  it('runs every prior27 upgrade unchanged, the candidate exactly once as28, then the unchanged full local SQL suite', () => {
    expect(previousUpgradeCommands).toHaveLength(27);
    const command = get(packageJson.scripts, 'db:test');
    assertRequiredDbTestCommand(command);
    expect(command.split(' && ').slice(0, 27)).toEqual(previousUpgradeCommands);
    expect(command.split(' && ')[27]).toBe(candidateUpgradeCommand);
    expect(command.split(' && ')[28]).toBe(fullSqlCommand);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it.each(['omit-old', 'reorder-old', 'duplicate-old', 'omit-candidate', 'duplicate-candidate', 'candidate-before-old', 'omit-sql', 'linked-sql', 'skip-on-failure'])
    ('rejects requiredCI db:test %s bypass without executing database commands', (kind) => {
      const commands = [...expectedDbCommands];
      if (kind === 'omit-old') commands.splice(12, 1);
      if (kind === 'reorder-old') commands.splice(0, 2, String(previousUpgradeCommands[1]), String(previousUpgradeCommands[0]));
      if (kind === 'duplicate-old') commands.splice(13, 0, String(previousUpgradeCommands[12]));
      if (kind === 'omit-candidate') commands.splice(27, 1);
      if (kind === 'duplicate-candidate') commands.splice(28, 0, candidateUpgradeCommand);
      if (kind === 'candidate-before-old') { commands.splice(27, 1); commands.unshift(candidateUpgradeCommand); }
      if (kind === 'omit-sql') commands.pop();
      if (kind === 'linked-sql') commands[28] = 'supabase test db supabase/tests --linked';
      if (kind === 'skip-on-failure') commands[27] = `${candidateUpgradeCommand} || true`;
      expect(() => assertRequiredDbTestCommand(commands.join(' && '))).toThrow();
      expect(execFileSync).not.toHaveBeenCalled();
    });
  it('rejects omission of each individual prior27 gate, not merely a runner count mismatch', () => {
    for (const [index, command] of previousUpgradeCommands.entries()) {
      const commands = [...expectedDbCommands];
      expect(commands[index]).toBe(command); commands.splice(index, 1);
      expect(() => assertRequiredDbTestCommand(commands.join(' && '))).toThrow();
    }
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('imports the pure module without processes and keeps destructive work behind an exact main guard', () => {
    expect(execFileSync).not.toHaveBeenCalled();
    expect(script).toContain('if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)');
    expect(script).toContain("'SOURCE_CHANGED'"); expect(script).toContain('entry.rawSha256');
    expect(script).toContain('source.manifestRawSha256');
    expect(script).toContain("same(readdirSync(migrationDirectory).filter(file => file.endsWith('.sql')), source.entries.map(entry => entry.file))");
    expect(script).toContain("flag: 'wx'"); expect(script).toContain('constants.COPYFILE_EXCL');
    expect(script).toContain('rmSync(assertGeneratedWorkspace(workspace), { recursive: true, force: false })');
    expect(script).toContain("phase = 'final-fresh-tip-cleanup'");
    expect(script).toContain('entries: source.entries.slice(0,111)');
    expect(script).toContain('assertPostApprovalUpgradeHistory(history(), source, 111)');
    expect(script).not.toMatch(/--linked|--db-url|--project-ref|docker desktop start|Docker Desktop\.exe|SUPABASE_ACCESS_TOKEN/iu);
  });
  it('pins the exact dev110 prefix and exact111 manifest without modifying original CRLF bytes', () => {
    expect(createHash('sha256').update(JSON.stringify(manifest.migrations.slice(0, 110))).digest('hex')).toBe(POST_APPROVAL_UPGRADE_PREFIX_SHA256);
    expect(createHash('sha256').update(JSON.stringify(source.entries.slice(0, 110).map(({ file, sha256 }) => ({ file, sha256 })))).digest('hex'))
      .toBe(POST_APPROVAL_UPGRADE_FILE_PREFIX_SHA256);
    const crlf = entries.map(entry => ({ ...entry, raw: Buffer.from(Buffer.from(entry.raw).toString('utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')) }));
    const before = crlf.map(entry => createHash('sha256').update(entry.raw).digest('hex'));
    const checked = validatePostApprovalUpgradeSource(manifest, crlf);
    expect(checked.entries.every(entry => !entry.canonical.includes('\r'))).toBe(true);
    expect(crlf.map(entry => createHash('sha256').update(entry.raw).digest('hex'))).toEqual(before);
    expect(checked.entries.map(entry => entry.rawSha256)).toEqual(before);
  });
  it.each(['old-sha', 'old-order', 'new-sha', 'new-name', 'count', 'extra-record'])('rejects manifest %s drift', (kind) => {
    const changed = clone(manifest);
    if (kind === 'old-sha') get(Object.fromEntries(changed.migrations.map((entry, index) => [String(index), entry])), '0').sha256 = '0'.repeat(64);
    if (kind === 'old-order') { const entry = changed.migrations[0]; if (entry) entry.order = 2; }
    if (kind === 'new-sha') { const entry = changed.migrations[110]; if (entry) entry.sha256 = '0'.repeat(64); }
    if (kind === 'new-name') { const entry = changed.migrations[110]; if (entry) entry.name = 'unknown'; }
    if (kind === 'count') changed.totalCount = manifest.totalCount + 1;
    if (kind === 'extra-record') changed.migrations.push({ order: 112, name: 'unknown', sha256: '0'.repeat(64) });
    expect(() => validatePostApprovalUpgradeSource(changed, entries)).toThrow();
  });
  it.each(['content', 'name', 'version-rename', 'duplicate', 'missing', 'directory', 'symlink', 'lone-cr', 'invalid-utf8'])('rejects source %s drift before any process', (kind) => {
    const changed = clone(entries), entry = changed[0]; if (!entry) throw new Error('SYNTHETIC_SOURCE_MISSING');
    if (kind === 'content') entry.raw = Buffer.concat([Buffer.from(entry.raw), Buffer.from('\n-- drift')]);
    if (kind === 'name') entry.file = '../remote.sql';
    // Same name, SHA, order and contents: only the old migration timestamp changes.
    if (kind === 'version-rename') entry.file = entry.file.replace('20260825141441_', '20260825141442_');
    if (kind === 'duplicate') changed.push(clone(entry));
    if (kind === 'missing') changed.shift();
    if (kind === 'directory') entry.isFile = false;
    if (kind === 'symlink') entry.isSymbolicLink = true;
    if (kind === 'lone-cr') entry.raw = Buffer.concat([Buffer.from(entry.raw), Buffer.from('\r')]);
    if (kind === 'invalid-utf8') entry.raw = Uint8Array.of(0xff);
    expect(() => validatePostApprovalUpgradeSource(manifest, changed)).toThrow(); expect(execFileSync).not.toHaveBeenCalled();
  });
  it.each(['mkdir', 'copy', 'write', 'hash', 'cleanup'])('cleans partial isolated LF workspace on preparation %s failure without file/process access', (fault) => {
    const taskRoot = resolve(fileURLToPath(new URL('..', sourceUrl)));
    const workspace = join(taskRoot, '.tmp', 'post-approval-room-issue-upgrade-source-mock');
    const io = (name: string) => get(filesystem, name);
    for (const mock of Object.values(filesystem)) mock.mockReset();
    io('mkdirSync').mockImplementationOnce(() => undefined).mockImplementation(() => {
      if (fault === 'mkdir') throw new Error('SYNTHETIC_PREPARE_FAILURE');
    });
    io('mkdtempSync').mockReturnValue(workspace);
    io('realpathSync').mockImplementation(value => resolve(String(value)));
    io('lstatSync').mockReturnValue({ isSymbolicLink: () => false });
    io('copyFileSync').mockImplementation(() => { if (fault === 'copy' || fault === 'cleanup') throw new Error('SYNTHETIC_PREPARE_FAILURE'); });
    io('writeFileSync').mockImplementation(() => { if (fault === 'write') throw new Error('SYNTHETIC_PREPARE_FAILURE'); });
    io('readFileSync').mockReturnValue(Buffer.from('synthetic hash drift'));
    io('rmSync').mockImplementation(() => { if (fault === 'cleanup') throw new Error('SYNTHETIC_CLEANUP_FAILURE'); });
    try {
      expect(() => preparePostApprovalUpgradeWorkspace(source)).toThrow();
      if (fault === 'cleanup') {
        try { preparePostApprovalUpgradeWorkspace(source); }
        catch (error) {
          expect(error).toBeInstanceOf(AggregateError);
          if (!(error instanceof AggregateError)) throw error;
          expect(error.errors).toHaveLength(2);
        }
        io('rmSync').mockClear();
        expect(() => preparePostApprovalUpgradeWorkspace(source)).toThrow('POST_APPROVAL_UPGRADE_PREPARE_AND_CLEANUP_FAILED');
      }
      expect(io('rmSync')).toHaveBeenCalledExactlyOnceWith(workspace, { recursive: true, force: false });
      expect(execFileSync).not.toHaveBeenCalled();
    } finally {
      for (const mock of Object.values(filesystem)) mock.mockReset().mockImplementation(() => { throw new Error('FILESYSTEM_ACCESS_FORBIDDEN_IN_SOURCE_TEST'); });
    }
  });
  it('accepts only an approved local project/container/endpoint and CLI version', () => {
    expect(validatePostApprovalUpgradeLocal(localInput)).toEqual({ projectId: 'room-management-system-backend', dbPort: 54322, endpoint: 'unix:///var/run/docker.sock' });
  });
  it.each(['args', 'env', 'project', 'port', 'remote-docker', 'remote-api', 'api-credentials', 'api-path', 'api-port', 'wrong-container', 'stopped', 'wrong-label', 'cli'])('rejects local identity %s drift', (kind) => {
    const changed = clone(localInput) as Parameters<typeof validatePostApprovalUpgradeLocal>[0];
    if (kind === 'args') changed.args = ['--target', 'production'];
    if (kind === 'env') changed.env = { DOCKER_CONTEXT: 'remote' };
    if (kind === 'project') changed.config = config.replace('room-management-system-backend', 'recovery');
    if (kind === 'port') changed.config = config.replace('port = 54322', 'port = 15432');
    if (kind === 'remote-docker') changed.endpoint = JSON.stringify('tcp://remote:2376');
    if (kind.startsWith('api-') || kind === 'remote-api') changed.status = { API_URL: kind === 'remote-api' ? 'https://remote.supabase.co'
      : kind === 'api-credentials' ? 'http://password@127.0.0.1:54321' : kind === 'api-path' ? 'http://127.0.0.1:54321/remote' : 'http://127.0.0.1:12345' };
    const container = JSON.parse(changed.container) as { name: string; running: boolean; project: string };
    if (kind === 'wrong-container') container.name = '/supabase_db_other';
    if (kind === 'stopped') container.running = false;
    if (kind === 'wrong-label') container.project = 'recovery';
    changed.container = JSON.stringify(container);
    if (kind === 'cli') changed.cliVersion = '2.120.0';
    expect(() => validatePostApprovalUpgradeLocal(changed)).toThrow(); expect(execFileSync).not.toHaveBeenCalled();
  });
  it('compares whole installed history, not count/head only, and exact fresh business/Auth/new-table state', () => {
    const history = source.entries.map(({ version, name }) => ({ version, name }));
    expect(() => assertPostApprovalUpgradeHistory(history, source)).not.toThrow();
    expect(() => assertPostApprovalUpgradeHistory(history.slice(0, 110), source, 110)).not.toThrow();
    const wrong = clone(history); if (wrong[0]) wrong[0].name = 'unknown';
    expect(() => assertPostApprovalUpgradeHistory(wrong, source)).toThrow();
    const fresh = { rooms: 121, roomTypes: 4, publicWithoutRls: 0, rows: Object.fromEntries(POST_APPROVAL_UPGRADE_FRESH_TABLES.map(table => [table, 0])) };
    expect(() => assertPostApprovalUpgradeFresh(fresh)).not.toThrow();
    for (const table of POST_APPROVAL_UPGRADE_FRESH_TABLES) {
      const changed = clone(fresh); changed.rows[table] = 1; expect(() => assertPostApprovalUpgradeFresh(changed)).toThrow();
    }
  });
  it('queries every fresh relation without exceeding PostgreSQL variadic argument limits', () => {
    const query = postApprovalUpgradeFreshSql();
    expect(POST_APPROVAL_UPGRADE_FRESH_TABLES).toHaveLength(51);
    expect(query).toContain('jsonb_object_agg(relation,row_count)');
    expect(query.match(/jsonb_build_object\(/gu)).toHaveLength(1);
    for (const table of POST_APPROVAL_UPGRADE_FRESH_TABLES) expect(query).toContain(`('${table}',(select count(*) from ${table}))`);
    expect(execFileSync).not.toHaveBeenCalled();
  });
  it('bounds source patches/new tables/new function signatures and does not call old fixture SQL a workflow PASS', () => {
    expect(plan.tables).toHaveLength(23); expect([...plan.tables].sort()).toEqual([...POST_APPROVAL_UPGRADE_TABLES].sort());
    expect(plan.functions).toHaveLength(64); expect(POST_APPROVAL_UPGRADE_PATCHES).toHaveLength(7);
    expect(plan.functions.filter(spec => spec.returnsSet).map(spec => spec.name)).toEqual(['private.post_approval_issue_notified_assignment']);
    expect(() => parsePostApprovalUpgradePlan(source.ledger.replace('if eligible then', 'if drift then'))).toThrow();
    expect(() => parsePostApprovalUpgradePlan(source.ledger.replace('private.post_approval_issue_purge_scan', 'private.unknown_table'))).toThrow();
    expect(script).toContain('no old workflow PASS claim');
    expect(script).toContain('Every old whole row is preserved except the exact one new notification catalog row');
    expect(script).toContain('New private tables are empty; no historical backfill');
    expect(script).toContain('old-receipt-replay-and-expired-session-denial');
    expect(script).toContain('new-minimal-report-flow');
  });
});

describe('#336 upgrade strict catalog mock matrix (not actual pg_proc)', () => {
  it('accepts exact7/19/core2->8/20/core2 and approved function/catalog additions only', () => {
    const before = baseline(), after = installed(before);
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).not.toThrow();
    expect(Object.values(after.constraints).filter(value => value.kind === 'f')).toHaveLength(14);
  });
  it('accepts PostgreSQL JSONB key ordering, typed NULL defaults and the exact SETOF read helper', () => {
    const before = baseline(), after = installed(before);
    for (const spec of plan.functions) {
      const value = get(after.functions, spec.signature);
      value.acl = value.acl?.map(permission => ({ grantee: permission.grantee, grantor: permission.grantor,
        grantable: permission.grantable, privilege: permission.privilege })) ?? null;
    }
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).not.toThrow();
  });
  it('permits an explicit owner-only column ACL but denies inherited runtime column access', () => {
    const before = baseline(), after = installed(before), value = get(after.tables, String(plan.tables[0]));
    value.columns = [{ attribute: { attname: 'id', attacl: ['postgres=r/postgres'] }, default: null,
      permissions: [{ ...ownerAcl, privilege: 'SELECT' }] }];
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).not.toThrow();
    value.runtimeColumnPrivileges.authenticated = true;
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
  });
  it.each(['anon', 'authenticated', 'service_role', 'PUBLIC', 'unexpected_role', 'grant-option', 'null-permissions', 'missing-columns'])
    ('rejects new table column-only %s grant/drift even without table privileges', (kind) => {
      const before = baseline(), after = installed(before), value = get(after.tables, String(plan.tables[0]));
      value.columns = [{ attribute: { attname: 'id', attacl: [`${kind}=r/postgres`] }, default: null,
        permissions: [{ ...ownerAcl, privilege: 'SELECT', grantee: kind }] }];
      if (kind === 'grant-option') value.columns[0] = { attribute: { attname: 'id', attacl: ['postgres=r*/postgres'] }, default: null,
        permissions: [{ ...ownerAcl, privilege: 'SELECT', grantable: true }] };
      if (kind === 'null-permissions') value.columns[0] = { attribute: { attname: 'id', attacl: ['service_role=r/postgres'] }, default: null, permissions: [] };
      if (kind === 'missing-columns') value.columns = [];
      expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
    });
  it.each(['tables', 'policies', 'indexes', 'constraints', 'triggers', 'functions'] as const)('rejects removed/changed old %s contract', (group) => {
    for (const mode of ['remove', 'change']) {
      const before = baseline(), after = installed(before), key = Object.keys(before[group])[0]; if (!key) throw new Error('SYNTHETIC_GROUP_MISSING');
      if (mode === 'remove') delete after[group][key];
      else { const value = after[group][key]; if (!value) throw new Error('SYNTHETIC_GROUP_MISSING');
        (value as unknown as Record<string, unknown>).drift = true; }
      expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
    }
  });
  it.each(['oid', 'owner', 'acl', 'volatility', 'config', 'source', 'missing-anchor', 'duplicate-anchor'])('rejects existing patched function %s drift', (field) => {
    const before = baseline(), key = POST_APPROVAL_UPGRADE_PATCHES[0]?.signature; if (!key) throw new Error('SYNTHETIC_PATCH_MISSING');
    const previous = get(before.functions, key);
    if (field === 'missing-anchor') previous.source = 'no anchor';
    if (field === 'duplicate-anchor') previous.source += String(POST_APPROVAL_UPGRADE_PATCHES[0]?.needle);
    const after = installed(before), value = get(after.functions, key) as unknown as Record<string, unknown>;
    if (!field.endsWith('anchor')) value[field] = field === 'oid' ? -1 : field === 'acl' || field === 'config' ? null : 'drift';
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
  });
  it.each(['unknown', 'overload', 'wrong-helper', 'zero-calls', 'two-calls', 'core-bypass', 'public-acl', 'private-service', 'null-acl', 'owner', 'language', 'config', 'default', 'setof'])('rejects new function %s drift', (kind) => {
    const before = baseline(), after = installed(before), key = 'public.get_post_approval_room_issue_source(uuid,uuid,uuid)';
    const value = get(after.functions, key);
    if (kind === 'unknown') after.functions['public.unknown(uuid)'] = fn('public.unknown', 'unknown');
    if (kind === 'overload') after.functions['public.get_post_approval_room_issue_source(text)'] = fn(value.name, 'unknown');
    if (kind === 'wrong-helper') value.source = String(needles[1]);
    if (kind === 'zero-calls') value.source = 'no helper';
    if (kind === 'two-calls') value.source += String(needles[0]);
    if (kind === 'core-bypass') value.source += String(needles[2]);
    if (kind === 'public-acl') value.acl?.push({ ...ownerAcl, grantee: 'PUBLIC' });
    if (kind === 'private-service') get(after.functions, 'private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)').acl?.push(clone(serviceAcl));
    if (kind === 'null-acl') value.acl = null;
    if (kind === 'owner') value.owner = 'service_role';
    if (kind === 'language') value.language = 'sql';
    if (kind === 'config') value.config = null;
    if (kind === 'default') value.defaults = '999';
    if (kind === 'setof') value.returnsSet = true;
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
  });
  it.each(['rls', 'forceRls', 'runtimePrivileges', 'permissions', 'owner', 'extra', 'missing'])('rejects new private table %s drift', (field) => {
    const before = baseline(), after = installed(before), key = String(plan.tables[0]);
    const value = get(after.tables, key);
    if (field === 'rls') value.rls = false;
    if (field === 'forceRls') value.forceRls = false;
    if (field === 'runtimePrivileges') value.runtimePrivileges.service_role = true;
    if (field === 'permissions') value.permissions.push({ ...ownerAcl, grantee: 'unexpected_role' });
    if (field === 'owner') value.owner = 'service_role';
    if (field === 'extra') after.tables['private.unknown'] = table();
    if (field === 'missing') delete after.tables[key];
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
  });
  it.each(['unknown', 'missing', 'condition', 'disabled', 'function', 'fk-extra', 'fk-missing', 'fk-rule', 'fk-target'])('rejects old-table trigger/FK addition %s drift', (kind) => {
    const before = baseline(), after = installed(before), key = 'public.audit_events.post_approval_issue_report_notification';
    if (kind === 'unknown') after.triggers['public.audit_events.unknown'] = { ...get(after.triggers, key), name: 'unknown' };
    if (kind === 'missing') delete after.triggers[key];
    if (kind === 'condition') get(after.triggers, key).when = null;
    if (kind === 'disabled') get(after.triggers, key).enabled = 'D';
    if (kind === 'function') get(after.triggers, key).function = 'private.unknown';
    const foreign = Object.entries(after.triggers).find(([, trigger]) => trigger.internal);
    const constraint = Object.values(after.constraints).find(value => value.kind === 'f');
    if (!foreign || !constraint) throw new Error('SYNTHETIC_FK_MISSING');
    if (kind === 'fk-extra') after.triggers['public.profiles.unknown'] = clone(foreign[1]);
    if (kind === 'fk-missing') delete after.triggers[foreign[0]];
    if (kind === 'fk-rule') constraint.onDelete = 'c';
    if (kind === 'fk-target') constraint.references = 'public.rooms';
    expect(() => assertPostApprovalUpgradeCatalog(before, after, plan)).toThrow();
  });
  it('rejects unknown/overloaded global callers even if an approved caller is missing and counts still match', () => {
    const before = baseline(), after = installed(before);
    const replaced = after.functions['public.get_room_board_projection(uuid)']; if (!replaced) throw new Error('SYNTHETIC_CALLER_MISSING');
    delete after.functions['public.get_room_board_projection(uuid)'];
    after.functions['public.unknown(uuid)'] = { ...replaced, name: 'public.unknown' };
    expect(() => assertPostApprovalUpgradeCallers(after.functions, 111)).toThrow();
    const duplicate = installed(before); duplicate.functions['public.get_room_board_projection(text)'] = clone(replaced);
    expect(() => assertPostApprovalUpgradeCallers(duplicate.functions, 111)).toThrow();
    expect(execFileSync).not.toHaveBeenCalled();
  });
});
