import { X509Certificate } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { checkServerIdentity, rootCertificates, TLSSocket } from 'node:tls';
import { Client, type ClientConfig } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// No network/database/TLS handshake. This double exercises the real adapter's internal I/O path.
vi.mock('pg', () => ({ Client: vi.fn() }));
type Observation = { mode: string; scope: string; driverReadbackObserved: true; tlsPeerValidated: true;
  observedHistorySha256: string; rowCount: number; backend: { pid: number; backendStart: string; connectionNonce: string; major: number };
  executionAllowed: false; operationalApproval: false; DBHistoryVerified: false; fullStateVerified: false; cliParityVerified: false };
type Api = { observePostgresMigrationHistory(input: unknown): Promise<Observation>;
  isOwnedPostgresHistoryObservation(input: unknown): boolean;
  comparePostgresHistoryObservation(input: unknown): { matches: boolean; DBHistoryVerified: false; executionAllowed: false; observedHistoryIsCallerClaim: false } };
const api = await import(new URL('../scripts/lib/migration-readonly-postgres.mjs', import.meta.url).href) as Api;
const codec = await import(new URL('../scripts/lib/migration-history-codec.mjs', import.meta.url).href) as {
  createMigrationHistoryModel(input: unknown): unknown; createExpectedMigrationHistorySnapshot(input: unknown): unknown;
  createDecodedMigrationHistorySnapshot(input: unknown): { historySha256: string };
};
type Result = { command: string; rowCount: number | null; rows: (string | null)[][];
  fields: { name: string; dataTypeID: number; format: string }[] };
type FixedQuery = { text: string; values: string[]; rowMode: string; binary: boolean; query_timeout: number;
  types: { getTypeParser(oid: number, format: string): (value: string) => string } };
type Scenario = { history: (string | null)[][]; transform?: (kind: string, result: Result, client: HermeticClient) => Result;
  connect?: () => Promise<void>; query?: (kind: string, client: HermeticClient) => Promise<void>; end?: () => Promise<void> };
const version = '20261001000000';
const projectRef = 'abcdefghijklmnopqrst';
const syntheticPassword = 'synthetic-only-password-no-real-secret';
const caPem = rootCertificates.find((pem) => {
  const certificate = new X509Certificate(pem);
  return certificate.ca && Date.parse(certificate.validFrom) < Date.now() && Date.parse(certificate.validTo) > Date.now();
});
if (!caPem) throw new Error('Synthetic public CA fixture unavailable');
const peerRaw = new X509Certificate(caPem).raw;
const identityFields = ['backend_pid', 'backend_start', 'connection_nonce', 'database_name', 'database_oid', 'role_oid',
  'session_role', 'current_role', 'server_version', 'read_only', 'isolation', 'encoding', 'server_encoding', 'statement_timeout', 'lock_timeout', 'idle_timeout'];
const catalogFields = ['column_name', 'type_oid', 'not_null', 'relation_kind', 'rls', 'force_rls', 'partition', 'has_children', 'version_primary_key'];
const historyFields = ['version', 'name', 'statement_values', 'dimensions', 'lower_bound', 'dimension_length', 'cardinality'];
const select = (fields: string[], rows: (string | null)[][]): Result => ({ command: 'SELECT', rowCount: rows.length,
  rows, fields: fields.map((name) => ({ name, dataTypeID: 25, format: 'text' })) });
const command = (name: string): Result => ({ command: name, rowCount: null, rows: [], fields: [] });
const historyRow = (values: (string | null)[] | null = ['SELECT 1'], lowerBound = 1, name: string | null = 'first'): (string | null)[] => [
  version, name, values === null ? null : JSON.stringify(values), values?.length ? '1' : null,
  values?.length ? String(lowerBound) : null, values?.length ? String(values.length) : null, values === null ? null : String(values.length),
];
const input = () => ({ target: { scope: 'SUPABASE', mode: 'direct', projectRef, host: `db.${projectRef}.supabase.co`, port: 5432, database: 'postgres', role: 'postgres' },
  credential: { password: syntheticPassword }, caPem, expectedVersions: [version], deadlineMs: 30_000, queryMs: 5_000 });
const sourceExpected = (sql = 'SELECT 1;') => codec.createExpectedMigrationHistorySnapshot({ models: [codec.createMigrationHistoryModel({ version, name: 'first', sqlBytes: Buffer.from(sql), sourceBinding: null })] });
let scenario: Scenario;
let clients: HermeticClient[];
class HermeticClient extends EventEmitter {
  readonly config: ClientConfig;
  readonly initialPassword: unknown;
  password: unknown;
  connectionParameters: { password: unknown };
  connection = Object.assign(new EventEmitter(), { stream: new TLSSocket(new Socket()) });
  queries: FixedQuery[] = [];
  endCalls = 0;
  identityCalls = 0;
  constructor(config: ClientConfig) {
    super(); this.config = config; this.initialPassword = config.password;
    this.password = config.password; this.connectionParameters = { password: config.password };
    Object.defineProperty(this.connection.stream, 'authorized', { value: true, writable: true });
    Object.defineProperty(this.connection.stream, 'authorizationError', { value: null, writable: true });
    Object.defineProperty(this.connection.stream, 'getPeerCertificate', { configurable: true, value: () => ({
      raw: peerRaw, subjectaltname: `DNS:${config.host}, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1`, subject: { CN: config.host },
    }) });
    clients.push(this);
  }
  async connect() { this.connection.emit('sslconnect'); await scenario.connect?.(); }
  async end() { this.endCalls++; await scenario.end?.(); this.connection.stream.destroy(); }
  async query(query: FixedQuery): Promise<Result> {
    this.queries.push(query);
    let kind: string;
    let result: Result;
    if (query.text === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY') { kind = 'begin'; result = command('BEGIN'); }
    else if (query.text === 'ROLLBACK') { kind = 'rollback'; result = command('ROLLBACK'); }
    else if (query.text.includes('set_config')) { kind = 'configure'; result = select(['statement_timeout', 'lock_timeout', 'idle_timeout', 'search_path'], [[query.values[0] ?? null, query.values[1] ?? null, query.values[0] ?? null, 'pg_catalog']]); }
    else if (query.text.includes('pg_stat_activity')) {
      kind = this.identityCalls++ === 0 ? 'identity-before' : 'identity-after';
      result = select(identityFields, [['12345', '2026-10-05T01:02:03.123456Z', this.config.application_name ?? null,
        'postgres', '5', '10', 'postgres', 'postgres', '170006', 'on', 'repeatable read', 'UTF8', 'UTF8',
        String(this.config.statement_timeout), String(this.config.lock_timeout), String(this.config.idle_in_transaction_session_timeout)]]);
    } else if (query.text.includes('pg_attribute')) {
      kind = 'catalog'; result = select(catalogFields, ['version', 'name', 'statements'].map((name, index) => [name, index === 2 ? '1009' : '25', index === 0 ? 'true' : 'false', 'r', 'false', 'false', 'false', 'false', '1']));
    } else if (query.text.includes('invalid_shape')) { kind = 'census'; result = select(['row_count', 'invalid_shape'], [[String(scenario.history.length), '0']]); }
    else if (query.text.includes('encoded_bytes')) { kind = 'size'; result = select(['encoded_bytes'], [['128']]); }
    else if (query.text.includes('statement_values')) { kind = 'history'; result = select(historyFields, structuredClone(scenario.history)); }
    else throw new Error('Unrecognized fixed query in hermetic fixture');
    await scenario.query?.(kind, this);
    return scenario.transform?.(kind, result, this) ?? result;
  }
}
beforeEach(() => {
  clients = []; scenario = { history: [historyRow()] };
  vi.mocked(Client).mockImplementation(function(this: Client, config?: string | ClientConfig) {
    if (!this || typeof config === 'string') throw new Error('Constructed object config required in hermetic fixture');
    return new HermeticClient(config ?? {}) as unknown as Client;
  });
  vi.spyOn(TLSSocket.prototype, 'connect').mockImplementation(() => { throw new Error('Network forbidden in hermetic source QA'); });
});
afterEach(() => { for (const client of clients) client.connection.stream.destroy(); vi.restoreAllMocks(); vi.useRealTimers(); vi.clearAllMocks(); });
const observe = () => api.observePostgresMigrationHistory(input());
function change(kind: string, mutate: (result: Result, client: HermeticClient) => void) {
  scenario.transform = (phase, result, client) => { if (phase === kind) mutate(result, client); return result; };
}

describe('#378 actual internal Client readback path with hermetic driver only', () => {
  it.each([
    ['version', 'statements', 'name'],
    ['name', 'version', 'statements'],
  ])('accepts exact named history catalog independent of physical attnum order: %j', async (...order) => {
    change('catalog', (result) => {
      const byName = new Map(result.rows.map((row) => [row[0], row]));
      result.rows = order.map((name) => {
        const row = byName.get(name);
        if (!row) throw new Error('Missing named catalog fixture');
        return row;
      });
    });
    expect((await observe()).rowCount).toBe(1);
  });
  it('runs fixed finite I/O, validates tuple and issues an owned opaque observation without execution authority', async () => {
    const result = await observe(); const client = clients[0]; if (!client) throw new Error('Missing fixture');
    expect(api.isOwnedPostgresHistoryObservation(result)).toBe(true);
    expect(result).toMatchObject({ mode: 'POSTGRES_DRIVER_READ_ONLY_OBSERVATION', scope: 'SUPABASE', rowCount: 1,
      driverReadbackObserved: true, tlsPeerValidated: true, executionAllowed: false, operationalApproval: false,
      DBHistoryVerified: false, fullStateVerified: false, cliParityVerified: false });
    expect(result.backend).toMatchObject({ pid: 12345, backendStart: '2026-10-05T01:02:03.123456Z', major: 17 });
    expect(result.backend.connectionNonce).toMatch(/^rms_ro_[0-9a-f-]{36}$/u);
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.backend)).toBe(true);
    expect(client.queries).toHaveLength(9); expect(client.queries[0]?.text).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(client.queries.at(-1)?.text).toBe('ROLLBACK'); expect(client.endCalls).toBe(1);
    expect(client.config.ssl).toMatchObject({ ca: caPem, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2' });
    expect(client.config).toMatchObject({ user: 'postgres', port: 5432, database: 'postgres', sslnegotiation: 'postgres', client_encoding: 'UTF8', replication: 'false', pipeline: false, binary: false, enableChannelBinding: true,
      connectionTimeoutMillis: 5000, query_timeout: 5000, statement_timeout: 5000, lock_timeout: 2500, idle_in_transaction_session_timeout: 5000 });
    expect(client.initialPassword).toBe(syntheticPassword); expect(client.password).toBeNull(); expect(client.connectionParameters.password).toBeNull(); expect(client.config.password).toBeNull();
    expect(client.queries.every((query) => query.rowMode === 'array' && query.binary === false && query.query_timeout > 0 && query.query_timeout <= 5000)).toBe(true);
    expect(client.queries[0]?.types.getTypeParser(25, 'text')('Unicode 😀')).toBe('Unicode 😀');
    expect(() => client.queries[0]?.types.getTypeParser(1009, 'text')).toThrow('POSTGRES_RESULT_INVALID');
    expect(JSON.stringify(result)).not.toContain(syntheticPassword); expect(JSON.stringify(result)).not.toContain('SELECT 1'); expect(JSON.stringify(result)).not.toContain('supabase.co');
    expect(api.comparePostgresHistoryObservation({ observation: result, expected: sourceExpected() })).toMatchObject({ matches: true, observedHistoryIsCallerClaim: false, DBHistoryVerified: false, executionAllowed: false });
  });
  it('creates independent internal nonces and closes only each owned connection', async () => {
    const first = await observe(); const second = await observe();
    expect(first.backend.connectionNonce).not.toBe(second.backend.connectionNonce);
    expect(clients.every((client) => client.endCalls === 1 && client.connection.stream.destroyed)).toBe(true);
  });
  it('allows confirmed session hostname and builds only the project-qualified role username', async () => {
    const value = input(); value.target.mode = 'session'; value.target.host = 'aws-0-ap-south-1.pooler.supabase.com';
    await api.observePostgresMigrationHistory(value); expect(clients[0]?.config.user).toBe(`postgres.${projectRef}`);
  });
  it.each(['localhost', '127.0.0.1', '::1'])('keeps isolated local direct target separate: %s', async (host) => {
    const value = { ...input(), target: { ...input().target, scope: 'ISOLATED_LOCAL', projectRef: null, host, port: 54322 } };
    expect((await api.observePostgresMigrationHistory(value)).scope).toBe('ISOLATED_LOCAL');
  });
  it('does not mint proof from a copied, serialized, fabricated or codec caller-model handle', async () => {
    const result = await observe();
    for (const forged of [{ ...result }, JSON.parse(JSON.stringify(result)), { mode: 'VERIFIED', driverReadbackObserved: true }, sourceExpected(), null, 'VERIFIED']) {
      expect(api.isOwnedPostgresHistoryObservation(forged)).toBe(false);
      expect(() => api.comparePostgresHistoryObservation({ observation: forged, expected: sourceExpected() })).toThrow('POSTGRES_OBSERVATION_NOT_OWNED');
    }
    expect(() => api.comparePostgresHistoryObservation({ observation: result, expected: { historySha256: result.observedHistorySha256 } })).toThrow('POSTGRES_EXPECTED_MODEL_NOT_OWNED');
    expect(api.comparePostgresHistoryObservation({ observation: result, expected: sourceExpected('SELECT 2;') }).matches).toBe(false);
  });
});

describe('#378 fail-closed inputs before any driver creation', () => {
  it.each([
    ['mode', 'transaction'], ['port', 6543], ['host', 'db.other.supabase.co'], ['host', 'db.abcdefghijklmnopqrst.supabase.co.evil.test'],
    ['host', '/tmp/postgres'], ['projectRef', 'UNKNOWN'], ['database', 'other'], ['role', 'postgres;SELECT 1'], ['role', ''], ['scope', 'PRODUCTION_VERIFIED'],
  ])('rejects unsupported target %s=%j', async (key, value) => {
    const request = input(); Object.assign(request.target, { [String(key)]: value });
    await expect(api.observePostgresMigrationHistory(request)).rejects.toThrow('POSTGRES_TARGET_INVALID'); expect(Client).not.toHaveBeenCalled();
  });
  it.each([['deadlineMs', 0], ['deadlineMs', 30_001], ['deadlineMs', 249], ['queryMs', 0], ['queryMs', 5001], ['queryMs', 99], ['queryMs', 1.5]])('rejects invalid deadline %s=%j', async (key, value) => {
    await expect(api.observePostgresMigrationHistory({ ...input(), [String(key)]: value })).rejects.toThrow('POSTGRES_DEADLINE_INVALID'); expect(Client).not.toHaveBeenCalled();
  });
  it.each(['', null, 42, () => syntheticPassword, `bad\0password`])('rejects absent/coerced password %#', async (password) => {
    await expect(api.observePostgresMigrationHistory({ ...input(), credential: { password } })).rejects.toThrow('POSTGRES_INPUT_INVALID'); expect(Client).not.toHaveBeenCalled();
  });
  it.each(['not pem', '', '-----BEGIN CERTIFICATE-----\ninvalid\n-----END CERTIFICATE-----', `${caPem}\nprivate input garbage`])('rejects missing/malformed/extra CA bytes %#', async (pem) => {
    await expect(api.observePostgresMigrationHistory({ ...input(), caPem: pem })).rejects.toThrow(/POSTGRES_(?:INPUT|CA)_INVALID/u); expect(Client).not.toHaveBeenCalled();
  });
  it.each([[version, version], ['20261002000000', version], ['unknown'], [version, 'not-a-version']].map((versions) => ({ versions })))('rejects wrong/duplicate/reordered expected versions $versions', async ({ versions }) => {
    await expect(api.observePostgresMigrationHistory({ ...input(), expectedVersions: versions })).rejects.toThrow('POSTGRES_HISTORY_EXPECTATION_INVALID'); expect(Client).not.toHaveBeenCalled();
  });
  it.each(['connectionString', 'driver', 'query', 'ssl', 'VERIFIED'])('does not accept %s override', async (key) => {
    await expect(api.observePostgresMigrationHistory({ ...input(), [key]: syntheticPassword })).rejects.toThrow('POSTGRES_INPUT_INVALID'); expect(Client).not.toHaveBeenCalled();
  });
  it('rejects getters, symbol and sparse array without invoking input getters', async () => {
    const getter = vi.fn(() => { throw new Error(syntheticPassword); });
    const request = input(); Object.defineProperty(request.credential, 'password', { get: getter });
    await expect(api.observePostgresMigrationHistory(request)).rejects.toThrow('POSTGRES_INPUT_INVALID'); expect(getter).not.toHaveBeenCalled();
    await expect(api.observePostgresMigrationHistory({ ...input(), [Symbol('secret')]: true })).rejects.toThrow('POSTGRES_INPUT_INVALID');
    await expect(api.observePostgresMigrationHistory({ ...input(), expectedVersions: new Array(1) })).rejects.toThrow('POSTGRES_INPUT_INVALID'); expect(Client).not.toHaveBeenCalled();
  });
});

describe('#378 exact decoded history/null/dimensions readback', () => {
  it.each([
    [null, 1, null], [[], 1, ''], [['', null, 'NULL', '😀\r\n--x;'], -2, null], [['SELECT 1'], 0, 'first'], [['SELECT 1'], -2147483648, 'first'],
  ] as [(string | null)[] | null, number, string | null][])('preserves nullable ordered model %#', async (values, lowerBound, name) => {
    scenario.history = [historyRow(values, lowerBound, name)]; const result = await observe();
    const snapshot = codec.createDecodedMigrationHistorySnapshot({ expectedVersions: [version], rows: [{ version, name,
      statements: values === null ? null : { dimensions: values.length ? [{ length: values.length, lowerBound }] : [], values } }] });
    expect(result.observedHistorySha256).toBe(snapshot.historySha256);
  });
  it('keeps explicit BEGIN/COMMIT and Unicode CRLF/comment/dollar body values in history domain', async () => {
    const sql = 'BEGIN; -- 가\r\nSELECT $$😀;$$; COMMIT;';
    scenario.history = [historyRow(['BEGIN', '-- 가\r\nSELECT $$😀;$$', 'COMMIT'])];
    const result = await observe(); expect(api.comparePostgresHistoryObservation({ observation: result, expected: sourceExpected(sql) }).matches).toBe(true);
  });
  it.each([
    ['statement_values', '"wire array string"'], ['statement_values', '[["SELECT 1"]]'], ['statement_values', '[42]'], ['statement_values', 'not-json'],
    ['dimensions', '2'], ['lower_bound', null], ['lower_bound', '01'], ['lower_bound', '2147483648'], ['dimension_length', '2'], ['cardinality', '2'], ['cardinality', null], ['version', 'unknown'],
  ])('rejects malformed exact history %s=%j', async (field, value) => {
    const row = scenario.history[0]; if (!row) throw new Error('Missing row'); row[historyFields.indexOf(String(field))] = value === null ? null : String(value);
    await expect(observe()).rejects.toThrow('POSTGRES_HISTORY_INVALID');
  });
  it('does not conflate null and empty metadata or accept dimension upper overflow', async () => {
    scenario.history = [historyRow(null)]; if (scenario.history[0]) scenario.history[0][6] = '0'; await expect(observe()).rejects.toThrow('POSTGRES_HISTORY_INVALID');
    scenario.history = [historyRow([], 1)]; if (scenario.history[0]) scenario.history[0][3] = '0'; await expect(observe()).rejects.toThrow('POSTGRES_HISTORY_INVALID');
    scenario.history = [historyRow(['a', 'b'], 2147483647)]; await expect(observe()).rejects.toThrow('POSTGRES_HISTORY_INVALID');
  });
  it.each(['unknown', 'missing', 'duplicate', 'reverse'])('rejects %s full row set', async (kind) => {
    const request = input(); request.expectedVersions = [version, '20261002000000'];
    const second = historyRow(); second[0] = '20261002000000'; scenario.history = [historyRow(), second];
    if (kind === 'unknown') second[0] = '20261003000000'; if (kind === 'missing') scenario.history.pop();
    if (kind === 'duplicate') second[0] = version; if (kind === 'reverse') scenario.history.reverse();
    await expect(api.observePostgresMigrationHistory(request)).rejects.toThrow('POSTGRES_HISTORY_INVALID');
  });
  it('accepts exact empty history only with empty expectation and keeps no array fallback', async () => {
    scenario.history = []; expect((await api.observePostgresMigrationHistory({ ...input(), expectedVersions: [] })).rowCount).toBe(0);
    scenario.history = [historyRow()]; await expect(api.observePostgresMigrationHistory({ ...input(), expectedVersions: [] })).rejects.toThrow('POSTGRES_HISTORY_INVALID');
  });
});

describe('#378 real adapter transport/identity/result bounds, simulated I/O only', () => {
  it.each(['unauthorized', 'plain', 'wrong-host', 'no-peer', 'authorization-error'])('refuses invalid TLS metadata %s before query', async (kind) => {
    scenario.connect = async () => {
      const socket = clients[0]?.connection.stream; if (!socket) throw new Error('Missing socket');
      if (kind === 'unauthorized') Object.defineProperty(socket, 'authorized', { value: false });
      if (kind === 'plain') Object.defineProperty(socket, 'encrypted', { value: false });
      if (kind === 'authorization-error') Object.defineProperty(socket, 'authorizationError', { value: 'native private CA diagnostic' });
      if (kind === 'wrong-host' || kind === 'no-peer') Object.defineProperty(socket, 'getPeerCertificate', { value: () => kind === 'no-peer' ? {} : { raw: peerRaw, subjectaltname: 'DNS:other.invalid', subject: { CN: 'other.invalid' } } });
    };
    await expect(observe()).rejects.toThrow('POSTGRES_TLS_INVALID'); expect(clients[0]?.queries).toHaveLength(0);
  });
  it.each([
    ['backend_pid', '0'], ['backend_start', 'date-coerced'], ['connection_nonce', 'caller VERIFIED'], ['database_name', 'other'], ['database_oid', '0'], ['role_oid', '0'],
    ['session_role', 'other'], ['current_role', 'other'], ['server_version', '160001'], ['read_only', 'off'], ['isolation', 'read committed'], ['encoding', 'SQL_ASCII'], ['server_encoding', 'SQL_ASCII'], ['statement_timeout', '0'], ['lock_timeout', '5000'], ['idle_timeout', '0'],
  ])('requires actual identity %s=%s', async (field, value) => {
    change('identity-before', (result) => { const row = result.rows[0]; if (row) row[identityFields.indexOf(String(field))] = String(value); });
    await expect(observe()).rejects.toThrow('POSTGRES_IDENTITY_INVALID'); expect(clients[0]?.queries.some((query) => query.text.includes('statement_values'))).toBe(false);
  });
  it.each(['backend_pid', 'backend_start', 'connection_nonce', 'database_oid', 'role_oid', 'server_version'])('rejects changed tuple %s even when PID could be reused', async (field) => {
    change('identity-after', (result) => {
      const row = result.rows[0]; if (!row) throw new Error('Missing row');
      row[identityFields.indexOf(field)] = ({ backend_pid: '12346', backend_start: '2026-10-05T01:02:03.123457Z', connection_nonce: 'different', database_oid: '6', role_oid: '11', server_version: '170007' } as Record<string, string>)[field] ?? null;
    });
    await expect(observe()).rejects.toThrow(/POSTGRES_IDENTITY_(?:INVALID|CHANGED)/u); expect(clients[0]?.queries.at(-1)?.text).not.toBe('ROLLBACK');
  });
  it.each(['column_name', 'type_oid', 'not_null', 'relation_kind', 'rls', 'force_rls', 'partition', 'has_children', 'version_primary_key'])('refuses incompatible history schema %s', async (field) => {
    change('catalog', (result) => { const row = result.rows[0]; if (row) row[catalogFields.indexOf(field)] = 'wrong'; });
    await expect(observe()).rejects.toThrow('POSTGRES_HISTORY_SCHEMA_INVALID');
  });
  it.each(['format', 'type', 'row-count', 'field-name', 'truncated-fields', 'extra-row', 'nontext', 'command-array'])('rejects wrong native result shape %s', async (kind) => {
    change('history', (result) => {
      if (kind === 'format' && result.fields[0]) result.fields[0].format = 'binary';
      if (kind === 'type' && result.fields[0]) result.fields[0].dataTypeID = 1009;
      if (kind === 'field-name' && result.fields[0]) result.fields[0].name = 'unknown';
      if (kind === 'row-count') result.rowCount = 0; if (kind === 'truncated-fields') result.fields.pop();
      if (kind === 'extra-row') result.rows[0]?.push('extra'); if (kind === 'nontext' && result.rows[0]) (result.rows[0] as unknown[])[0] = 42;
      if (kind === 'command-array') result.command = 'UPDATE';
    });
    await expect(observe()).rejects.toThrow('POSTGRES_RESULT_INVALID');
  });
  it.each(['row-count', 'array-shape', 'encoded-size'])('fails preflight %s before receiving history bytes', async (kind) => {
    change(kind === 'encoded-size' ? 'size' : 'census', (result) => { const row = result.rows[0]; if (row) row[kind === 'array-shape' ? 1 : 0] = kind === 'array-shape' ? '1' : kind === 'row-count' ? '513' : String(32 * 1024 * 1024 + 1); });
    await expect(observe()).rejects.toThrow(/POSTGRES_HISTORY_(?:INVALID|LIMIT)/u); expect(clients[0]?.queries.some((query) => query.text.includes('statement_values'))).toBe(false);
  });
  it('bounds decrypted transport before decoding and never calls PID-only cancellation', async () => {
    scenario.query = async (kind, client) => { if (kind === 'history') client.connection.stream.emit('data', Buffer.alloc(40 * 1024 * 1024 + 1)); };
    await expect(observe()).rejects.toThrow('POSTGRES_CONNECTION_FAILED'); expect(clients[0]?.connection.stream.destroyed).toBe(true);
    expect(clients[0]?.queries.some((query) => /pg_cancel_backend|pg_terminate_backend|INSERT|UPDATE|DELETE|COMMIT/u.test(query.text))).toBe(false);
  });
  it('installs the same decrypted cap before startup/authentication completes', async () => {
    scenario.connect = async () => {
      const client = clients[0]; if (!client) throw new Error('Missing fixture');
      expect(client.connection.stream.listenerCount('data')).toBe(1);
      client.connection.stream.emit('data', Buffer.alloc(40 * 1024 * 1024 + 1));
    };
    await expect(observe()).rejects.toThrow('POSTGRES_CONNECTION_FAILED');
    expect(clients[0]?.queries).toHaveLength(0);
    expect(clients[0]?.connection.stream.destroyed).toBe(true);
  });
  it('keeps one total wire budget across startup and subsequent history reads', async () => {
    scenario.connect = async () => { clients[0]?.connection.stream.emit('data', Buffer.alloc(20 * 1024 * 1024)); };
    scenario.query = async (kind, client) => { if (kind === 'history') client.connection.stream.emit('data', Buffer.alloc(20 * 1024 * 1024 + 1)); };
    await expect(observe()).rejects.toThrow('POSTGRES_CONNECTION_FAILED');
    expect(clients[0]?.connection.stream.destroyed).toBe(true);
  });
  it.each(['connect', 'query', 'close'])('returns fixed safe code for native %s failure, hides every diagnostic', async (phase) => {
    const native = new Error(`private password=${syntheticPassword}; host=db.private; SELECT private`); Object.assign(native, { code: 'private_native_code', cause: syntheticPassword });
    if (phase === 'connect') scenario.connect = async () => { throw native; };
    if (phase === 'query') scenario.query = async () => { throw native; };
    if (phase === 'close') scenario.end = async () => { throw native; };
    let caught: unknown; try { await observe(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(Error); expect((caught as Error).message).toBe(`POSTGRES_${phase === 'connect' ? 'CONNECTION' : phase === 'query' ? 'QUERY' : 'CLOSE'}_FAILED`);
    expect(String((caught as Error).stack)).not.toContain(syntheticPassword); expect(Object.hasOwn(caught as object, 'cause')).toBe(false);
    expect(clients[0]?.password).toBeNull(); expect(clients[0]?.connection.stream.destroyed).toBe(true);
  });
  it.each(['connect', 'query', 'close'])('bounds hung %s and rejects late completion rather than issuing proof', async (phase) => {
    vi.useFakeTimers(); let complete: (() => void) | undefined; const hung = () => new Promise<void>((resolve) => { complete = resolve; });
    if (phase === 'connect') scenario.connect = hung; if (phase === 'query') scenario.query = hung; if (phase === 'close') scenario.end = hung;
    const result = observe(); const assertion = expect(result).rejects.toThrow(/POSTGRES_(?:CONNECTION|QUERY|CLOSE)_FAILED/u); assertion.catch(() => {});
    await vi.advanceTimersByTimeAsync(6000); await assertion; complete?.(); await Promise.resolve();
    expect(clients[0]?.connection.stream.destroyed).toBe(true); expect(api.isOwnedPostgresHistoryObservation(result)).toBe(false);
  });
  it('uses a single monotonic deadline and sends no next query when it is exhausted', async () => {
    let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    scenario.query = async (kind) => { if (kind === 'size') clock = 30_000; };
    await expect(observe()).rejects.toThrow('POSTGRES_DEADLINE_EXCEEDED');
    expect(clients[0]?.queries.some((query) => query.text.includes('statement_values'))).toBe(false);
  });
  it('fails closed on asynchronous Client error without printing notices or native error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scenario.query = async (kind, client) => { if (kind === 'size') { client.emit('notice', new Error(syntheticPassword)); client.emit('error', new Error(syntheticPassword)); } };
    await expect(observe()).rejects.toThrow('POSTGRES_CONNECTION_FAILED'); expect(consoleSpy).not.toHaveBeenCalled();
  });
});
