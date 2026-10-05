/** #378 fixed PostgreSQL readback only. No SQL accessor, executor or approval capability. */
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { checkServerIdentity, TLSSocket } from 'node:tls';
import { Client } from 'pg';
import {
  compareMigrationHistorySnapshots,
  createDecodedMigrationHistorySnapshot,
  HISTORY_CODEC_MAX_ROWS,
  HISTORY_CODEC_MAX_STATEMENTS,
  HISTORY_CODEC_MAX_TOTAL_BYTES,
} from './migration-history-codec.mjs';

export const READONLY_POSTGRES_DRIVER_VERSION = '8.23.1';
export const READONLY_POSTGRES_MAX_DEADLINE_MS = 30_000;
export const READONLY_POSTGRES_MAX_QUERY_MS = 5_000;
const closeMillis = 500;
const maxWireBytes = 40 * 1024 * 1024;
const observations = new WeakMap();
const errors = new WeakMap();
const flags = Object.freeze({ executionAllowed: false, operationalApproval: false,
  DBHistoryVerified: false, fullStateVerified: false, cliParityVerified: false,
  remoteProjectVerified: false, projectIdentityIsCallerClaim: true });
const hash = (value) => createHash('sha256').update(value).digest('hex');
const textTypes = Object.freeze({ getTypeParser(oid, format) {
  if (oid !== 25 || format !== 'text') fail('POSTGRES_RESULT_INVALID');
  return (value) => value;
} });

// These are internal constants, never caller SQL. Fully qualify catalog access.
const identitySql = `SELECT pg_catalog.pg_backend_pid()::text AS backend_pid,
 pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')::text AS backend_start,
 a.application_name::text AS connection_nonce, pg_catalog.current_database()::text AS database_name,
 d.oid::text AS database_oid,
 (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = current_user)::text AS role_oid,
 session_user::text AS session_role, current_user::text AS current_role,
 pg_catalog.current_setting('server_version_num')::text AS server_version,
 pg_catalog.current_setting('transaction_read_only')::text AS read_only,
 pg_catalog.current_setting('transaction_isolation')::text AS isolation,
 pg_catalog.current_setting('client_encoding')::text AS encoding,
 pg_catalog.current_setting('server_encoding')::text AS server_encoding,
 (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'statement_timeout')::text AS statement_timeout,
 (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'lock_timeout')::text AS lock_timeout,
 (SELECT setting FROM pg_catalog.pg_settings WHERE name = 'idle_in_transaction_session_timeout')::text AS idle_timeout
 FROM pg_catalog.pg_stat_activity AS a JOIN pg_catalog.pg_database AS d ON d.datname = pg_catalog.current_database()
 WHERE a.pid = pg_catalog.pg_backend_pid()`;
const identityFields = ['backend_pid', 'backend_start', 'connection_nonce', 'database_name', 'database_oid', 'role_oid',
  'session_role', 'current_role', 'server_version', 'read_only', 'isolation', 'encoding', 'server_encoding',
  'statement_timeout', 'lock_timeout', 'idle_timeout'];
const catalogSql = `SELECT a.attname::text AS column_name, a.atttypid::text AS type_oid,
 a.attnotnull::text AS not_null, c.relkind::text AS relation_kind,
 c.relrowsecurity::text AS rls, c.relforcerowsecurity::text AS force_rls,
 c.relispartition::text AS partition, c.relhassubclass::text AS has_children,
 (SELECT pg_catalog.count(*)::text FROM pg_catalog.pg_index AS i
   WHERE i.indrelid = c.oid AND i.indisprimary AND i.indisvalid AND i.indisready
     AND i.indnkeyatts = 1 AND i.indkey[0] =
       (SELECT v.attnum FROM pg_catalog.pg_attribute AS v WHERE v.attrelid = c.oid
         AND v.attname = 'version' AND v.attnum > 0 AND NOT v.attisdropped)) AS version_primary_key
 FROM pg_catalog.pg_class AS c JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
 JOIN pg_catalog.pg_attribute AS a ON a.attrelid = c.oid
 WHERE n.nspname = 'supabase_migrations' AND c.relname = 'schema_migrations'
   AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 4`;
const catalogFields = ['column_name', 'type_oid', 'not_null', 'relation_kind', 'rls', 'force_rls', 'partition', 'has_children', 'version_primary_key'];
const censusSql = `SELECT pg_catalog.count(*)::text AS row_count,
 pg_catalog.count(*) FILTER (WHERE version IS NULL OR pg_catalog.octet_length(version) <> 14
   OR (name IS NOT NULL AND pg_catalog.octet_length(name) > 256)
   OR (statements IS NOT NULL AND (pg_catalog.cardinality(statements) > ${HISTORY_CODEC_MAX_STATEMENTS}
     OR (pg_catalog.cardinality(statements) > 0 AND pg_catalog.array_ndims(statements) <> 1))))::text AS invalid_shape
 FROM ONLY supabase_migrations.schema_migrations`;
const sizeSql = `SELECT (COALESCE(pg_catalog.sum(pg_catalog.octet_length(version)
 + COALESCE(pg_catalog.octet_length(name), 0)
 + COALESCE(pg_catalog.octet_length(pg_catalog.array_to_json(statements)::text), 0)), 0))::text AS encoded_bytes
 FROM ONLY supabase_migrations.schema_migrations`;
const historySql = `SELECT version::text AS version, name::text AS name,
 pg_catalog.array_to_json(statements)::text AS statement_values,
 pg_catalog.array_ndims(statements)::text AS dimensions,
 pg_catalog.array_lower(statements, 1)::text AS lower_bound,
 pg_catalog.array_length(statements, 1)::text AS dimension_length,
 pg_catalog.cardinality(statements)::text AS cardinality
 FROM ONLY supabase_migrations.schema_migrations ORDER BY version COLLATE "C" LIMIT ${HISTORY_CODEC_MAX_ROWS + 1}`;
const historyFields = ['version', 'name', 'statement_values', 'dimensions', 'lower_bound', 'dimension_length', 'cardinality'];
const configureSql = `SELECT pg_catalog.set_config('statement_timeout', $1, true)::text AS statement_timeout,
 pg_catalog.set_config('lock_timeout', $2, true)::text AS lock_timeout,
 pg_catalog.set_config('idle_in_transaction_session_timeout', $1, true)::text AS idle_timeout,
 pg_catalog.set_config('search_path', 'pg_catalog', true)::text AS search_path`;

function failure(code) { const error = new Error(code); errors.set(error, code); return error; }
function fail(code) { throw failure(code); }
function data(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length) fail('POSTGRES_INPUT_INVALID');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('POSTGRES_INPUT_INVALID');
    result[key] = descriptor.value;
  }
  return result;
}
function list(value, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1) fail('POSTGRES_INPUT_INVALID');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('POSTGRES_INPUT_INVALID');
    return descriptor.value;
  });
}
function text(value, minimum, maximum) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum || value.includes('\0')
    || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > maximum) fail('POSTGRES_INPUT_INVALID');
  return value;
}
function integer(value, minimum, maximum, code = 'POSTGRES_RESULT_INVALID') {
  if (typeof value !== 'string' || !/^(?:0|-?[1-9][0-9]*)$/u.test(value)) fail(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(code);
  return parsed;
}
function validateInput(input) {
  const value = data(input, ['target', 'credential', 'caPem', 'expectedVersions', 'deadlineMs', 'queryMs']);
  const target = data(value.target, ['scope', 'mode', 'projectRef', 'host', 'port', 'database', 'role']);
  const credential = data(value.credential, ['password']);
  if (!['direct', 'session'].includes(target.mode)) fail('POSTGRES_TARGET_INVALID');
  if (!Number.isSafeInteger(target.port) || typeof target.role !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/u.test(target.role)
    || target.database !== 'postgres') fail('POSTGRES_TARGET_INVALID');
  if (target.scope === 'SUPABASE') {
    if (typeof target.projectRef !== 'string' || !/^[a-z]{20}$/u.test(target.projectRef) || target.port !== 5432) fail('POSTGRES_TARGET_INVALID');
    if (target.mode === 'direct' && target.host !== `db.${target.projectRef}.supabase.co`) fail('POSTGRES_TARGET_INVALID');
    if (target.mode === 'session' && (typeof target.host !== 'string'
      || !/^aws-[0-9]{1,6}-[a-z]{2}(?:-[a-z]+){1,2}-[0-9]{1,2}\.pooler\.supabase\.com$/u.test(target.host))) fail('POSTGRES_TARGET_INVALID');
  } else if (target.scope === 'ISOLATED_LOCAL') {
    if (target.projectRef !== null || target.mode !== 'direct' || !['localhost', '127.0.0.1', '::1'].includes(target.host)
      || target.port < 1024 || target.port > 65535 || target.port === 6543) fail('POSTGRES_TARGET_INVALID');
  } else fail('POSTGRES_TARGET_INVALID');
  if (!Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 250 || value.deadlineMs > READONLY_POSTGRES_MAX_DEADLINE_MS
    || !Number.isSafeInteger(value.queryMs) || value.queryMs < 100 || value.queryMs > READONLY_POSTGRES_MAX_QUERY_MS
    || value.queryMs > value.deadlineMs) fail('POSTGRES_DEADLINE_INVALID');
  const password = text(credential.password, 1, 1024); // Nonempty: pg cannot fall back to pgpass/environment.
  const caPem = text(value.caPem, 1, 128 * 1024);
  const certificates = caPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu);
  if (!certificates || certificates.length > 4 || caPem.replace(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/gu, '').trim()) fail('POSTGRES_CA_INVALID');
  const caFingerprints = certificates.map((pem) => {
    let certificate;
    try { certificate = new X509Certificate(pem); } catch { fail('POSTGRES_CA_INVALID'); }
    const now = Date.now();
    if (!certificate.ca || Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) fail('POSTGRES_CA_INVALID');
    return hash(certificate.raw);
  });
  const versions = list(value.expectedVersions, HISTORY_CODEC_MAX_ROWS);
  if (versions.some((item, index) => typeof item !== 'string' || !/^[0-9]{14}$/u.test(item)
    || index > 0 && item <= versions[index - 1])) fail('POSTGRES_HISTORY_EXPECTATION_INVALID');
  return { target, password, caPem, caFingerprints: Object.freeze(caFingerprints), versions,
    deadlineMs: value.deadlineMs, queryMs: value.queryMs, lockMs: Math.floor(value.queryMs / 2) };
}
function rows(result, fields, maximum) {
  if (result?.command !== 'SELECT' || !Array.isArray(result.rows) || result.rows.length > maximum
    || result.rowCount !== result.rows.length || !Array.isArray(result.fields) || result.fields.length !== fields.length
    || result.fields.some((field, index) => field.name !== fields[index] || field.dataTypeID !== 25 || field.format !== 'text')) fail('POSTGRES_RESULT_INVALID');
  return result.rows.map((row) => {
    if (!Array.isArray(row) || row.length !== fields.length || row.some((item) => item !== null && typeof item !== 'string')) fail('POSTGRES_RESULT_INVALID');
    return row;
  });
}
function command(result, name) {
  if (!result || Array.isArray(result) || result.command !== name || result.rowCount !== null
    || !Array.isArray(result.rows) || result.rows.length !== 0 || !Array.isArray(result.fields) || result.fields.length !== 0) fail('POSTGRES_RESULT_INVALID');
}
function validateIdentity(result, value, nonce) {
  const records = rows(result, identityFields, 1);
  if (records.length !== 1) fail('POSTGRES_IDENTITY_INVALID');
  const row = records[0];
  const pid = integer(row[0], 1, 2147483647, 'POSTGRES_IDENTITY_INVALID');
  const databaseOid = integer(row[4], 1, 4294967295, 'POSTGRES_IDENTITY_INVALID');
  const roleOid = integer(row[5], 1, 4294967295, 'POSTGRES_IDENTITY_INVALID');
  const serverVersion = integer(row[8], 150000, 179999, 'POSTGRES_IDENTITY_INVALID');
  const major = Math.floor(serverVersion / 10000);
  if (![15, 17].includes(major) || typeof row[1] !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$/u.test(row[1])
    || row[2] !== nonce || row[3] !== value.target.database || row[6] !== value.target.role || row[7] !== value.target.role
    || row[9] !== 'on' || row[10] !== 'repeatable read' || row[11] !== 'UTF8' || row[12] !== 'UTF8'
    || integer(row[13], 1, value.queryMs, 'POSTGRES_IDENTITY_INVALID') !== value.queryMs
    || integer(row[14], 1, value.lockMs, 'POSTGRES_IDENTITY_INVALID') !== value.lockMs
    || integer(row[15], 1, value.queryMs, 'POSTGRES_IDENTITY_INVALID') !== value.queryMs) fail('POSTGRES_IDENTITY_INVALID');
  return Object.freeze({ pid, backendStart: row[1], connectionNonce: nonce, databaseOid, roleOid, serverVersion, major });
}
function validateCatalog(result) {
  const records = rows(result, catalogFields, 3);
  const columns = new Map(records.map((row) => [row[0], row]));
  // CLI creates version, then adds statements, then name. Physical attnum order
  // is not the decoded row contract; require the exact named set and every type.
  if (records.length !== 3 || columns.size !== 3 || ['version', 'name', 'statements'].some((name) => {
    const row = columns.get(name);
    return !row || row[1] !== (name === 'statements' ? '1009' : '25')
      || row[2] !== (name === 'version' ? 'true' : 'false') || row[3] !== 'r'
      || row.slice(4, 8).some((value) => value !== 'false') || row[8] !== '1';
  })) fail('POSTGRES_HISTORY_SCHEMA_INVALID');
}
function decodeHistory(result, value, count) {
  const records = rows(result, historyFields, HISTORY_CODEC_MAX_ROWS);
  if (records.length !== count) fail('POSTGRES_HISTORY_INVALID');
  let byteCount = 0;
  const decoded = records.map((row) => {
    byteCount += row.reduce((size, item) => size + (item === null ? 0 : Buffer.byteLength(item, 'utf8')), 0);
    if (byteCount > HISTORY_CODEC_MAX_TOTAL_BYTES + HISTORY_CODEC_MAX_ROWS * 128) fail('POSTGRES_HISTORY_LIMIT');
    let statements = null;
    if (row[2] === null) {
      if (row.slice(3).some((item) => item !== null)) fail('POSTGRES_HISTORY_INVALID');
    } else {
      let values;
      try { values = JSON.parse(row[2]); } catch { fail('POSTGRES_HISTORY_INVALID'); }
      if (!Array.isArray(values) || values.some((item) => item !== null && typeof item !== 'string')) fail('POSTGRES_HISTORY_INVALID');
      const cardinality = integer(row[6], 0, HISTORY_CODEC_MAX_STATEMENTS, 'POSTGRES_HISTORY_INVALID');
      if (values.length !== cardinality) fail('POSTGRES_HISTORY_INVALID');
      if (cardinality === 0) {
        if (row.slice(3, 6).some((item) => item !== null)) fail('POSTGRES_HISTORY_INVALID');
        statements = { dimensions: [], values };
      } else {
        if (row[3] !== '1' || integer(row[5], 1, HISTORY_CODEC_MAX_STATEMENTS, 'POSTGRES_HISTORY_INVALID') !== cardinality) fail('POSTGRES_HISTORY_INVALID');
        statements = { dimensions: [{ length: cardinality, lowerBound: integer(row[4], -2147483648, 2147483647, 'POSTGRES_HISTORY_INVALID') }], values };
      }
    }
    return { version: row[0], name: row[1], statements };
  });
  try { return createDecodedMigrationHistorySnapshot({ expectedVersions: value.versions, rows: decoded }); }
  catch { fail('POSTGRES_HISTORY_INVALID'); }
}
function destroyOwned(client) {
  try { client?.connection?.stream?.destroy(); } catch { /* No native error or secret is emitted. */ }
}
async function bounded(operation, state, maximum, code, ignoreFailure = false) {
  const duration = Math.min(maximum, Math.floor(state.deadline - performance.now()));
  if (duration <= 0 || state.failed && !ignoreFailure) fail('POSTGRES_DEADLINE_EXCEEDED');
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { state.failed = true; destroyOwned(state.client); reject(failure(code)); }, duration);
    Promise.resolve().then(operation).then((result) => {
      clearTimeout(timer);
      if (state.failed && !ignoreFailure) reject(failure('POSTGRES_CONNECTION_FAILED'));
      else resolve(result);
    }, (error) => { clearTimeout(timer); state.failed = true; destroyOwned(state.client); reject(failure(errors.get(error) ?? code)); });
  });
}
function validateTls(client, host) {
  const socket = client.connection?.stream;
  if (!(socket instanceof TLSSocket) || socket.encrypted !== true || socket.authorized !== true || socket.authorizationError) fail('POSTGRES_TLS_INVALID');
  const certificate = socket.getPeerCertificate();
  if (!Buffer.isBuffer(certificate?.raw) || certificate.raw.length === 0 || checkServerIdentity(host, certificate) !== undefined) fail('POSTGRES_TLS_INVALID');
  return { socket, peerCertificateSha256: hash(certificate.raw) };
}

/** Only this internal pg.Client I/O path can mint an observation. No driver/factory callback input. */
export async function observePostgresMigrationHistory(input) {
  let value;
  let client;
  let config;
  let state;
  let socket;
  let wireListener;
  let tlsStarted;
  let connectionClosed = false;
  try {
    const started = performance.now();
    value = validateInput(input);
    const nonce = `rms_ro_${randomUUID()}`;
    config = { host: value.target.host, port: value.target.port, database: value.target.database,
      user: value.target.mode === 'session' ? `${value.target.role}.${value.target.projectRef}` : value.target.role,
      password: value.password, ssl: { ca: value.caPem, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2' },
      sslnegotiation: 'postgres', application_name: nonce, client_encoding: 'UTF8', replication: 'false',
      options: `-c default_transaction_read_only=on -c statement_timeout=${value.queryMs} -c lock_timeout=${value.lockMs} -c idle_in_transaction_session_timeout=${value.queryMs}`,
      connectionTimeoutMillis: value.queryMs, query_timeout: value.queryMs, statement_timeout: value.queryMs,
      lock_timeout: value.lockMs, idle_in_transaction_session_timeout: value.queryMs,
      binary: false, pipeline: false, enableChannelBinding: true, scramMaxIterations: 100_000, types: textTypes };
    state = { deadline: started + value.deadlineMs, failed: false, client: null };
    client = new Client(config);
    state.client = client;
    client.on('error', () => { state.failed = true; destroyOwned(client); });
    let wireBytes = 0;
    wireListener = (chunk) => {
      if (!Buffer.isBuffer(chunk)) { state.failed = true; destroyOwned(client); return; }
      wireBytes += chunk.byteLength;
      if (wireBytes > maxWireBytes) { state.failed = true; destroyOwned(client); }
    };
    // pg emits sslconnect immediately after creating its native TLS socket and
    // before startup/authentication. Hook before connect(), not after ReadyForQuery.
    tlsStarted = () => {
      const stream = client.connection?.stream;
      if (!(stream instanceof TLSSocket) || stream.encrypted !== true || socket) {
        state.failed = true; destroyOwned(client); return;
      }
      socket = stream;
      socket.disableRenegotiation();
      socket.prependListener('data', wireListener);
    };
    client.connection.once('sslconnect', tlsStarted);
    await bounded(() => client.connect(), state, value.queryMs, 'POSTGRES_CONNECTION_FAILED');
    const tls = validateTls(client, value.target.host);
    if (tls.socket !== socket) fail('POSTGRES_TLS_INVALID');
    const query = (sql, values = []) => bounded(() => client.query({ text: sql, values,
      rowMode: 'array', binary: false, types: textTypes, query_timeout: Math.max(1, Math.min(value.queryMs, Math.floor(state.deadline - performance.now()))) }),
      state, value.queryMs, 'POSTGRES_QUERY_FAILED');
    command(await query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), 'BEGIN');
    rows(await query(configureSql, [`${value.queryMs}ms`, `${value.lockMs}ms`]), ['statement_timeout', 'lock_timeout', 'idle_timeout', 'search_path'], 1);
    const identity = validateIdentity(await query(identitySql), value, nonce);
    validateCatalog(await query(catalogSql));
    const census = rows(await query(censusSql), ['row_count', 'invalid_shape'], 1);
    if (census.length !== 1 || census[0][1] !== '0') fail('POSTGRES_HISTORY_INVALID');
    const count = integer(census[0][0], 0, HISTORY_CODEC_MAX_ROWS, 'POSTGRES_HISTORY_LIMIT');
    const sizes = rows(await query(sizeSql), ['encoded_bytes'], 1);
    if (sizes.length !== 1) fail('POSTGRES_HISTORY_INVALID');
    integer(sizes[0][0], 0, HISTORY_CODEC_MAX_TOTAL_BYTES, 'POSTGRES_HISTORY_LIMIT');
    const snapshot = decodeHistory(await query(historySql), value, count);
    const after = validateIdentity(await query(identitySql), value, nonce);
    if (JSON.stringify(after) !== JSON.stringify(identity) || validateTls(client, value.target.host).peerCertificateSha256 !== tls.peerCertificateSha256) fail('POSTGRES_IDENTITY_CHANGED');
    command(await query('ROLLBACK'), 'ROLLBACK');
    await bounded(() => client.end(), state, closeMillis, 'POSTGRES_CLOSE_FAILED');
    connectionClosed = true;
    const result = Object.freeze({ ...flags, mode: 'POSTGRES_DRIVER_READ_ONLY_OBSERVATION', scope: value.target.scope,
      driverVersion: READONLY_POSTGRES_DRIVER_VERSION, driverReadbackObserved: true, tlsPeerValidated: true,
      readOnlySnapshotObserved: true, connectionClosed: true, observedHistorySha256: snapshot.historySha256,
      rowCount: snapshot.rowCount, backend: identity, caFingerprints: value.caFingerprints,
      peerCertificateSha256: tls.peerCertificateSha256, observedAt: new Date().toISOString() });
    observations.set(result, { snapshot });
    return result;
  } catch (error) {
    destroyOwned(client);
    throw failure(errors.get(error) ?? 'POSTGRES_READBACK_FAILED');
  } finally {
    if (socket && wireListener) socket.removeListener('data', wireListener);
    if (client && tlsStarted) client.connection?.removeListener('sslconnect', tlsStarted);
    if (client) {
      // Best effort bounded teardown only. Socket destruction is not server rollback proof.
      if (!connectionClosed) {
        try { await bounded(() => client.end(), { deadline: performance.now() + closeMillis, failed: false, client }, closeMillis, 'POSTGRES_CLOSE_FAILED', true); } catch { destroyOwned(client); }
      }
      client.password = null;
      if (client.connectionParameters) client.connectionParameters.password = null;
    }
    if (config) config.password = null;
    if (value) value.password = null; // JS strings/caller memory cannot be securely zeroized.
  }
}

/** Object identity only, not DB application/CLI parity/full-state/production approval. */
export function isOwnedPostgresHistoryObservation(value) { return observations.has(value); }

/** Exact private readback vs owned source model. The expected model may still be untrusted. */
export function comparePostgresHistoryObservation(input) {
  try {
    const value = data(input, ['observation', 'expected']);
    if (!observations.has(value.observation)) fail('POSTGRES_OBSERVATION_NOT_OWNED');
    let comparison;
    try { comparison = compareMigrationHistorySnapshots({ expected: value.expected, observed: observations.get(value.observation).snapshot }); }
    catch { fail('POSTGRES_EXPECTED_MODEL_NOT_OWNED'); }
    return Object.freeze({ ...flags, mode: 'POSTGRES_READBACK_MODEL_COMPARISON', matches: comparison.matches,
      observedHistoryIsCallerClaim: false, expectedModelIsOperationalApproval: false,
      expectedHistorySha256: comparison.expectedHistorySha256, observedHistorySha256: comparison.observedHistorySha256 });
  } catch (error) { throw failure(errors.get(error) ?? 'POSTGRES_INPUT_INVALID'); }
}
