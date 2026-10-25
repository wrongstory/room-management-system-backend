import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { checkServerIdentity, rootCertificates, TLSSocket } from 'node:tls';
import { Client, type ClientConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateResetCatalog } from '../scripts/reset-catalog-contract.mjs';
import { RESET_ROW_RULE_FINGERPRINT } from '../scripts/reset-row-policy.mjs';
import { inspectResetNativePostgres, inspectResetNativeReview } from '../src/modules/developer-reset/snapshot-native-postgres.js';
import { resetReviewEvidenceSql } from '../src/modules/developer-reset/snapshot-read-source.js';
import { resetReviewFixture } from './helpers/reset-review.js';
import { resetReadIdentitySql, resetReadSafetySql } from '../src/modules/developer-reset/snapshot-read-plan.js';
import { resetCatalog } from './helpers/reset-catalog.js';
import { createResetPlanRevalidation } from '../src/modules/developer-reset/plan-revalidation.js';
import { reviewSourceHarness } from './helpers/reset-review-source.js';

vi.mock('pg', () => ({ Client: vi.fn() }));
const ca = rootCertificates.find(pem => { const cert = new X509Certificate(pem);
  return cert.ca && Date.parse(cert.validFrom) < Date.now() && Date.parse(cert.validTo) > Date.now(); });
if (!ca) throw new Error('Public synthetic CA fixture unavailable');
const raw = new X509Certificate(ca).raw;
const project = 'a'.repeat(20), profileId = '11111111-1111-4111-8111-111111111111', authId = '22222222-2222-4222-8222-222222222222';
function fixture() {
  const catalog = resetCatalog(); catalog.relations[0]?.columns.push({ name: 'role', position: 3, type: 'public.app_role', nullable: false });
  return { source: { catalog, binding: { projectRef: project, sourceCommit: 'a'.repeat(40),
    catalogFingerprint: validateResetCatalog(catalog).catalogFingerprint, classificationFingerprint: RESET_ROW_RULE_FINGERPRINT }, database: 'postgres', role: 'postgres' },
  connection: { target: { scope: 'SUPABASE', mode: 'direct', projectRef: project, host: `db.${project}.supabase.co`, port: 5432, database: 'postgres', role: 'postgres' },
    credential: { password: 'synthetic-password-no-real-secret' }, caPem: ca } };
}
const names = ['pid', 'database_name', 'role_name', 'read_only', 'isolation', 'row_security', 'nonce', 'encoding',
  'timezone', 'datestyle', 'intervalstyle', 'bytea_output', 'float_digits', 'bypass_rls', 'snapshot', 'statement_timeout', 'lock_timeout'];
const select = (names: string[], rows: (string | null)[][]) => ({ command: 'SELECT', rowCount: rows.length,
  fields: names.map(name => ({ name, dataTypeID: 25, format: 'text' })), rows });
const json = (value: unknown) => select(['payload'], [[JSON.stringify(value)]]);
const cell = (name: string, value: string, pgType = 'pg_catalog.uuid') => ({ name, value, pgType });
const content = [
  { relation: 'public.profiles', key: [cell('id', profileId)], values: [cell('id', profileId), cell('auth_user_id', authId), cell('role', 'developer', 'public.app_role')],
    candidate: 'preserve', references: [{ constraint: 'profiles_auth_fkey', targetKey: [cell('id', authId)], sourceNulls: [false] }] },
  { relation: 'auth.users', key: [cell('id', authId)], values: [cell('id', authId)], candidate: 'preserve', references: [] },
];
type Query = { text: string; values: string[]; rowMode: string; binary: boolean; query_timeout: number;
  types: { getTypeParser(oid: number, format: string): (s: string) => string } };
let clients: FakeClient[];
let scenario: { connect?: (client: FakeClient) => Promise<void>; query?: (client: FakeClient, query: Query) => Promise<void>; end?: () => Promise<void>;
  result?: (query: Query) => Promise<unknown> };
class FakeClient extends EventEmitter {
  readonly connection = Object.assign(new EventEmitter(), { stream: new TLSSocket(new Socket()) });
  password: unknown; connectionParameters: { password: unknown }; queries: Query[] = []; ends = 0; nonce = '';
  readonly originalPassword: unknown;
  constructor(readonly config: ClientConfig) {
    super(); this.originalPassword = config.password; this.password = config.password; this.connectionParameters = { password: config.password };
    Object.defineProperty(this.connection.stream, 'authorized', { value: true, writable: true });
    Object.defineProperty(this.connection.stream, 'authorizationError', { value: null, writable: true });
    Object.defineProperty(this.connection.stream, 'getPeerCertificate', { configurable: true,
      value: () => ({ raw, subjectaltname: `DNS:${config.host}`, subject: { CN: config.host } }) });
    clients.push(this);
  }
  async connect() { this.connection.emit('sslconnect'); await scenario.connect?.(this); }
  async end() { this.ends++; await scenario.end?.(); this.connection.stream.destroy(); }
  async query(query: Query) {
    this.queries.push(query); await scenario.query?.(this, query); const sql = query.text;
    if (scenario.result) return scenario.result(query);
    if (sql.startsWith('BEGIN')) return { command: 'BEGIN', rows: [] };
    if (sql.startsWith('LOCK TABLE')) return { command: 'LOCK', rows: [] };
    if (sql === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
    if (sql.startsWith('SET LOCAL')) { this.nonce = sql.match(/application_name = '([^']+)'/)?.[1] ?? ''; return Array.from({ length: 11 }, () => ({ command: 'SET', rows: [] })); }
    if (sql === resetReadIdentitySql) return select(names, [['123', 'postgres', 'postgres', 'on', 'repeatable read', 'off', this.nonce,
      'UTF8', 'UTC', 'ISO, MDY', 'iso_8601', 'hex', '3', 'true', '100:200:110,112', '4s', '1s']]);
    if (sql === resetReadSafetySql) return json({ relations: 3, unsafeRelations: 0, unsafeTypes: 0, foreignKeyColumns: 1, unsafeEquality: 0,
      relationIdentities: ['auth.users', 'public.profiles', 'public.rooms'].map((name, i) => ({ name, oid: String(i + 100) })), unlockedRelations: 0 });
    if (sql.includes('WITH app_relations AS')) return json(fixture().source.catalog);
    if (sql.includes('counted.row_count')) return select(['relation', 'row_count'], [['public.profiles', '1'], ['public.rooms', '0'], ['auth.users', '1']]);
    if (sql.includes("'candidate'")) return select(['payload'], content.map(row => [JSON.stringify(row)]));
    return select(['payload'], content.map(({ candidate: _c, references: _r, ...row }) => [JSON.stringify(row)]));
  }
}
beforeEach(() => {
  clients = []; scenario = {};
  vi.mocked(Client).mockImplementation(function(this: Client, config?: string | ClientConfig) {
    if (!this || !config || typeof config === 'string') throw new Error('Object client config required');
    return new FakeClient(config) as unknown as Client;
  });
  vi.spyOn(TLSSocket.prototype, 'connect').mockImplementation(() => { throw new Error('Network forbidden'); });
});
afterEach(() => { for (const client of clients) client.connection.stream.destroy(); vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });

describe('native reset connector with hermetic pg module (real DB zero)', () => {
  it('keeps native revalidation bound to the approved source while excluding credentials from the content commitment', async () => {
    const h = reviewSourceHarness(); scenario.result = query => h.client.query(query.text);
    const input = { source: h.source, connection: fixture().connection };
    const owner = createResetPlanRevalidation({ expiresAt: h.f.request.receipt.expiresAt });
    try {
      const prepared = await owner.prepareNative(input, h.f.request); expect(prepared.status).toBe('PREPARED');
      input.connection.credential.password = 'another-synthetic-transport-password';
      const checked = await owner.recheckNative(input, h.f.request); expect(checked.status).toBe('MATCHED');
      expect(checked.summary).toEqual(prepared.summary); expect(Client).toHaveBeenCalledTimes(2);
      expect(clients.every(client => client.password === null && client.config.password === null)).toBe(true);
      expect(JSON.stringify(checked)).not.toContain('password');
    } finally { owner.dispose(); }
  });
  it('routes review through the owned native transport and refuses a missing bound sidecar', async () => {
    const result = await inspectResetNativeReview(fixture(), resetReviewFixture().request);
    expect(result).toMatchObject({ snapshotValid: false, executionEnabled: false, liveDatabaseVerified: false });
    expect(clients[0]?.queries.some(q => q.text === resetReviewEvidenceSql)).toBe(true);
    expect(clients[0]?.password).toBeNull();
    expect(JSON.stringify(result)).not.toContain('PREPARED');
  });
  it('does not fall back to basic inspection when review intent is absent', async () => {
    expect((await inspectResetNativeReview(fixture(), undefined)).snapshotValid).toBe(false);
    expect(Client).not.toHaveBeenCalled();
  });
  it('composes the real closed collector and native owned transport without minting live DB proof', async () => {
    const result = await inspectResetNativePostgres(fixture());
    expect(result).toMatchObject({ snapshotValid: true, liveDatabaseVerified: false, executionEnabled: false });
    const client = clients[0]; if (!client) throw new Error('missing client');
    expect(client.queries).toHaveLength(13); expect(client.ends).toBe(1);
    expect(client.config).toMatchObject({ host: `db.${project}.supabase.co`, user: 'postgres', database: 'postgres', port: 5432,
      sslnegotiation: 'postgres', client_encoding: 'UTF8', replication: 'false', pipeline: false, binary: false, enableChannelBinding: true,
      scramMaxIterations: 100000, connectionTimeoutMillis: 4000, statement_timeout: 4000, lock_timeout: 1000 });
    expect(client.config.options).toContain('default_transaction_read_only=on');
    expect(client.config.ssl).toMatchObject({ ca, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2' });
    expect(client.originalPassword).toBe(fixture().connection.credential.password);
    expect(client.password).toBeNull(); expect(client.connectionParameters.password).toBeNull(); expect(client.config.password).toBeNull();
    expect(client.connection.stream.listenerCount('data')).toBe(0);
    expect(client.queries.every(q => q.rowMode === 'array' && !q.binary && q.query_timeout === 4000)).toBe(true);
    expect(client.queries[0]?.types.getTypeParser(25, 'text')('9007199254740993')).toBe('9007199254740993');
    expect(() => client.queries[0]?.types.getTypeParser(1009, 'text')).toThrow('RESET_NATIVE_TEXT_CODEC_INVALID');
    expect(() => client.queries[0]?.types.getTypeParser(25, 'binary')).toThrow('RESET_NATIVE_TEXT_CODEC_INVALID');
    for (const secret of [profileId, authId, fixture().connection.credential.password, project, 'supabase.co']) expect(JSON.stringify(result)).not.toContain(secret);
  });
  it('uses an explicit session-pooler username without transaction pooler or environment fallback', async () => {
    const input = fixture(); input.connection.target.mode = 'session'; input.connection.target.host = 'aws-0-ap-south-1.pooler.supabase.com';
    expect((await inspectResetNativePostgres(input)).snapshotValid).toBe(true);
    expect(clients[0]?.config.user).toBe(`postgres.${project}`);
  });
  it.each(['host', 'port', 'project', 'role', 'password', 'ca', 'factory'])('rejects invalid %s before constructing pg', async kind => {
    const input = fixture();
    if (kind === 'host') input.connection.target.host = 'other.invalid';
    if (kind === 'port') input.connection.target.port = 6543;
    if (kind === 'project') input.source.binding.projectRef = 'b'.repeat(20);
    if (kind === 'role') input.source.role = 'other';
    if (kind === 'password') input.connection.credential.password = '';
    if (kind === 'ca') input.connection.caPem = 'invalid';
    const result = await inspectResetNativePostgres(kind === 'factory' ? { ...input, clientFactory: () => {} } : input);
    expect(result.snapshotValid).toBe(false); expect(Client).not.toHaveBeenCalled();
  });
  it.each(['unauthorized', 'wrong-san', 'wire-limit', 'error'])('rejects %s before SQL and masks provider details', async kind => {
    scenario.connect = async client => {
      if (kind === 'unauthorized') Object.defineProperty(client.connection.stream, 'authorized', { value: false });
      if (kind === 'wrong-san') Object.defineProperty(client.connection.stream, 'getPeerCertificate', { value: () => ({ raw, subjectaltname: 'DNS:wrong.invalid' }) });
      if (kind === 'wire-limit') client.connection.stream.emit('data', Buffer.alloc(16 * 1024 * 1024 + 1));
      if (kind === 'error') throw new Error('synthetic-provider-secret');
    };
    const result = await inspectResetNativePostgres(fixture());
    expect(result.snapshotValid).toBe(false); expect(clients[0]?.queries).toHaveLength(0);
    expect(clients[0]?.password).toBeNull(); expect(JSON.stringify(result)).not.toContain('synthetic-provider-secret');
  });
  it('checks peer identity again after each query and rejects a substituted socket', async () => {
    scenario.query = async client => {
      Object.defineProperty(client.connection.stream, 'getPeerCertificate', { value: () => ({ raw, subjectaltname: 'DNS:wrong.invalid' }) });
    };
    expect((await inspectResetNativePostgres(fixture())).snapshotValid).toBe(false);
    expect(clients[0]?.queries).toHaveLength(1); expect(clients[0]?.connection.stream.destroyed).toBe(true);
  });
  it('destroys a pending native connect on abort and clears owned credentials', async () => {
    const abort = new AbortController();
    scenario.connect = async () => { queueMicrotask(() => abort.abort()); return new Promise(() => {}); };
    const result = await inspectResetNativePostgres(fixture(), abort.signal);
    expect(result.snapshotValid).toBe(false); expect(clients[0]?.connection.stream.destroyed).toBe(true);
    expect(clients[0]?.password).toBeNull(); expect(clients[0]?.connection.stream.listenerCount('data')).toBe(0);
  });
  it('fails closed on a hanging native close without waiting indefinitely', async () => {
    vi.useFakeTimers(); scenario.end = () => new Promise(() => {});
    const running = inspectResetNativePostgres(fixture()); await vi.advanceTimersByTimeAsync(351);
    expect((await running).snapshotValid).toBe(false); expect(clients[0]?.connection.stream.destroyed).toBe(true);
    expect(clients[0]?.password).toBeNull(); expect(clients[0]?.ends).toBe(1);
  });
});
