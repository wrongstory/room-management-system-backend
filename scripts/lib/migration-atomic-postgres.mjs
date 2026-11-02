/** Authorized atomic PostgreSQL adapter. Constructing the factory performs no connection. */
import { createHash } from 'node:crypto';
import { checkServerIdentity, TLSSocket } from 'node:tls';
import { Client } from 'pg';
import { copyMigrationData } from './migration-evidence-input.mjs';
import { migrationHistoryPolicyRows, migrationHistoryWriteMaterial } from './migration-history-codec.mjs';
import { readPostgresMigrationState } from './migration-postgres-state.mjs';
import { migrationPostgresConnectionInput, migrationPostgresTlsIdentity, readMigrationHistoryInTransaction } from './migration-readonly-postgres.mjs';
import { migrationReleaseConfiguration } from './migration-release-preflight.mjs';
import { isOwnedMigrationSourceBundle, migrationExecutionMaterial } from './migration-source-bundle.mjs';
import { createMigrationStateSnapshot, migrationStateDigests } from './migration-state-snapshot.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = () => { throw new Error('MIGRATION_ATOMIC_DRIVER_FAILED'); };
const types = Object.freeze({ getTypeParser(_oid, format) { if (format !== 'text') fail(); return value => value; } });
const identitySql = `SELECT pg_catalog.pg_backend_pid()::text,
 pg_catalog.to_char(a.backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')::text,
 d.oid::text,(SELECT oid FROM pg_catalog.pg_roles WHERE rolname=current_user)::text,
 session_user::text,current_user::text,a.application_name::text,pg_catalog.current_setting('server_version_num')::text,
 pg_catalog.current_setting('transaction_read_only')::text,pg_catalog.current_setting('transaction_isolation')::text,
 pg_catalog.current_setting('client_encoding')::text,pg_catalog.current_setting('server_encoding')::text,
 pg_catalog.current_setting('standard_conforming_strings')::text
 FROM pg_catalog.pg_stat_activity a JOIN pg_catalog.pg_database d ON d.datname=pg_catalog.current_database() WHERE a.pid=pg_catalog.pg_backend_pid()`;
const configureSql = `SELECT pg_catalog.set_config('statement_timeout',$1,true)::text,
 pg_catalog.set_config('lock_timeout',$2,true)::text,pg_catalog.set_config('idle_in_transaction_session_timeout',$3,true)::text,
 pg_catalog.set_config('search_path','pg_catalog',true)::text,pg_catalog.set_config('TimeZone','UTC',true)::text,
 pg_catalog.set_config('DateStyle','ISO, YMD',true)::text,pg_catalog.set_config('IntervalStyle','iso_8601',true)::text,
 pg_catalog.set_config('extra_float_digits','3',true)::text,pg_catalog.set_config('bytea_output','hex',true)::text,
 pg_catalog.set_config('standard_conforming_strings','on',true)::text`;
function one(result, width) {
  if (result?.command !== 'SELECT' || result.rowCount !== 1 || !Array.isArray(result.rows) || result.rows.length !== 1
    || result.rows[0].length !== width || result.rows[0].some(value => typeof value !== 'string')
    || result.fields?.length !== width || result.fields.some(field => field.dataTypeID !== 25 || field.format !== 'text')) fail();
  return result.rows[0];
}
function command(result, expected) { if (Array.isArray(result) || result?.command !== expected) fail(); }
function identity(result, target, runId, nonce, major, readOnly) {
  const row = one(result, 13);
  if (!/^[1-9][0-9]{0,9}$/u.test(row[0]) || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/u.test(row[1])
    || !/^[1-9][0-9]{0,9}$/u.test(row[2]) || !/^[1-9][0-9]{0,9}$/u.test(row[3])
    || row[4] !== target.role || row[5] !== target.role || row[6] !== nonce || Math.floor(Number(row[7]) / 10000) !== major
    || row[8] !== (readOnly ? 'on' : 'off') || row[9] !== 'repeatable read'
    || row[10] !== 'UTF8' || row[11] !== 'UTF8' || row[12] !== 'on') fail();
  return Object.freeze({ pid: Number(row[0]), backendStart: row[1], databaseOid: Number(row[2]), roleOid: Number(row[3]), runId, connectionMode: target.mode });
}

/** Source/history handles are checked before accepting a password or creating a pg.Client. */
export function createAtomicMigrationSessionFactory({ request, bundle, historyModels, connection, coverage }) {
  try {
    const config = migrationReleaseConfiguration(request);
    if (!isOwnedMigrationSourceBundle(bundle) || !Object.keys(config.policy.expectedSource).every(key => bundle.modelSource[key] === config.policy.expectedSource[key])) fail();
    const source = new Map();
    for (const migration of config.policy.pending) {
      const file = bundle.files.find(row => row.version === migration.version && row.name === migration.name);
      if (!file?.plan || file.plan.sqlSha256 !== migration.sqlSha256
        || JSON.stringify(file.plan.statementSha256s) !== JSON.stringify(migration.statementSha256s)) fail();
      const model = historyModels.find(row => row.version === migration.version && row.name === migration.name);
      if (!model || model.sourceBinding?.bundleSha256 !== bundle.bundleSha256 || model.historyStatementsSha256 !== migration.statementsSha256) fail();
      const material = migrationExecutionMaterial(bundle, file.path);
      const history = migrationHistoryWriteMaterial(model);
      const statements = material.plan.statements.filter(row => row.transactionKind === null).map(row => material.sqlBytes.subarray(row.startByte, row.endByte));
      if (statements.length !== migration.statementSha256s.length || statements.some((bytes, index) => hash(bytes) !== migration.statementSha256s[index])) fail();
      source.set(migration.version, { statements, history });
    }
    const declaredCoverage = copyMigrationData(coverage);
    if (!Array.isArray(declaredCoverage) || declaredCoverage.length !== config.policy.pending.length) fail();
    const coverageFor = new Map();
    for (const [index, item] of declaredCoverage.entries()) {
      const migration = config.policy.pending[index];
      if (item.version !== migration.version || Object.keys(item).length !== 3) fail();
      for (const [key, expected] of [['before', migration.preState], ['after', migration.postState]]) {
        const declaration = item[key];
        const shape = createMigrationStateSnapshot({ coverage: declaration, catalog: [], data: declaration.dataRelations.map(table => ({ relation: table.name, rows: [] })),
          sequences: declaration.sequences.map(name => ({ name, lastValue: '0', isCalled: false })) });
        if (shape.coverageSha256 !== expected.coverageSha256 || declaration.serverMajor !== bundle.parserMajor) fail();
      }
      coverageFor.set(item.version, item);
    }
    const settings = migrationPostgresConnectionInput({ ...connection, expectedVersions: config.policy.expectedHistory.map(row => row.version), deadlineMs: 30000, queryMs: 5000 });
    if (settings.target.projectRef !== config.policy.expectedSource.projectRef) fail();
    const lockKey = BigInt.asIntN(64, BigInt(`0x${hash(Buffer.from(settings.target.projectRef)).slice(0, 16)}`)).toString();
    let destroyed = false;
    async function connect(context, readOnly, signal) {
      if (destroyed || signal.aborted) fail();
      const nonce = `rms_mig_${context.runId}`;
      const limit = context.budget.statementMs;
      const client = new Client({ host: settings.target.host, port: settings.target.port, database: settings.target.database,
        user: settings.target.mode === 'session' ? `${settings.target.role}.${settings.target.projectRef}` : settings.target.role,
        password: settings.password, ssl: { ca: settings.caPem, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2' },
        sslnegotiation: 'postgres', application_name: nonce, client_encoding: 'UTF8', replication: 'false',
        options: `-c default_transaction_read_only=${readOnly ? 'on' : 'off'} -c standard_conforming_strings=on -c statement_timeout=${limit} -c lock_timeout=${context.budget.lockMs} -c idle_in_transaction_session_timeout=${context.budget.idleTransactionMs}`,
        connectionTimeoutMillis: limit, query_timeout: limit, statement_timeout: limit, lock_timeout: context.budget.lockMs,
        idle_in_transaction_session_timeout: context.budget.idleTransactionMs, binary: false, pipeline: false,
        enableChannelBinding: true, scramMaxIterations: 100000, types });
      let stream; let bytes = 0; let broken = false;
      const abort = () => { broken = true; try { client.connection?.stream?.destroy(); } catch { /* no native data */ } };
      const onData = chunk => {
        if (!Buffer.isBuffer(chunk)) { abort(); return; }
        bytes += chunk.length;
        if (bytes > 40 * 1024 * 1024) abort();
      };
      const onTls = () => {
        stream = client.connection?.stream;
        if (!(stream instanceof TLSSocket) || !stream.encrypted) { abort(); return; }
        stream.disableRenegotiation(); stream.prependListener('data', onData);
      };
      signal.addEventListener('abort', abort, { once: true }); client.on('error', abort); client.connection.once('sslconnect', onTls);
      let peer;
      async function close() {
        try { await client.end(); } finally {
          signal.removeEventListener('abort', abort); stream?.removeListener('data', onData);
          client.password = null; if (client.connectionParameters) client.connectionParameters.password = null;
        }
      }
      try {
        await client.connect();
        if (broken || signal.aborted) fail();
        peer = migrationPostgresTlsIdentity(client, settings.target.host);
        if (peer.socket !== stream) fail();
      } catch { abort(); void close().catch(() => {}); fail(); }
      const query = async (text, values = [], limitMs = limit) => {
        if (broken || signal.aborted || migrationPostgresTlsIdentity(client, settings.target.host).peerCertificateSha256 !== peer.peerCertificateSha256) fail();
        try { return await client.query({ text, values, rowMode: 'array', binary: false, types, query_timeout: limitMs }); }
        catch { abort(); fail(); }
      };
      const configure = async limits => {
        await query(configureSql, [`${limits.statementMs}ms`, `${limits.lockMs}ms`, `${limits.idleTransactionMs}ms`], limits.statementMs);
        const values = one(await query(`SELECT
          (SELECT setting FROM pg_catalog.pg_settings WHERE name='statement_timeout')::text,
          (SELECT setting FROM pg_catalog.pg_settings WHERE name='lock_timeout')::text,
          (SELECT setting FROM pg_catalog.pg_settings WHERE name='idle_in_transaction_session_timeout')::text`), 3);
        if (values[0] !== String(limits.statementMs) || values[1] !== String(limits.lockMs) || values[2] !== String(limits.idleTransactionMs)) fail();
      };
      return { query, configure, close, abort, nonce };
    }
    return Object.freeze({
      dispose() { destroyed = true; settings.password = null; for (const item of source.values()) for (const bytes of item.statements) bytes.fill(0); },
      async openSession(context) {
        let writer;
        try {
          const material = source.get(context.migration.version);
          if (!material || context.requestSha256 !== request.requestSha256 || context.signal.aborted) fail();
          writer = await connect(context, false, context.signal);
          if (one(await writer.query('SELECT pg_catalog.pg_try_advisory_lock($1::bigint)::text', [lockKey]), 1)[0] !== 'true') fail();
          // Identify inside a read-only transaction, then begin() revalidates in the write transaction.
          command(await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), 'BEGIN');
          const owned = identity(await writer.query(identitySql), settings.target, context.runId, writer.nonce, bundle.parserMajor, true);
          command(await writer.query('ROLLBACK'), 'ROLLBACK');
          let next = 0; let phase = 'READY';
          const beforeVersions = context.expectedHistory.map(row => row.version);
          const afterVersions = [...beforeVersions, context.migration.version];
          const session = {
            identity: owned, abort: writer.abort,
            async begin(limits) {
              if (phase !== 'READY') fail();
              command(await writer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE', [], limits.statementMs), 'BEGIN');
              await writer.configure(limits);
              const current = identity(await writer.query(identitySql), settings.target, context.runId, writer.nonce, bundle.parserMajor, false);
              if (JSON.stringify(current) !== JSON.stringify(owned)) fail();
              const history = await readMigrationHistoryInTransaction(writer.query, beforeVersions);
              const state = await readPostgresMigrationState(writer.query, coverageFor.get(context.migration.version).before);
              phase = 'SQL';
              return { modelSource: context.modelSource, historySha256: history.historySha256, history: migrationHistoryPolicyRows(history), state: migrationStateDigests(state),
                backend: { identity: owned, transactionStatus: 'IN_TRANSACTION' } };
            },
            async executeStatement({ statementIndex, statementSha256, limits }) {
              if (phase !== 'SQL' || statementIndex !== next || !material.statements[next] || hash(material.statements[next]) !== statementSha256) fail();
              await writer.configure(limits);
              const result = await writer.query(material.statements[next].toString('utf8'), [], limits.statementMs);
              if (Array.isArray(result)) fail();
              next += 1;
            },
            async recordHistory(limits) {
              if (phase !== 'SQL' || next !== material.statements.length) fail();
              await writer.configure(limits);
              if (JSON.stringify(identity(await writer.query(identitySql), settings.target, context.runId, writer.nonce, bundle.parserMajor, false)) !== JSON.stringify(owned)) fail();
              const result = await writer.query('INSERT INTO supabase_migrations.schema_migrations (version,name,statements) VALUES ($1,$2,$3::text[])',
                [material.history.version, material.history.name, material.history.statements], limits.statementMs);
              if (result?.command !== 'INSERT' || result.rowCount !== 1) fail();
              phase = 'HISTORY';
            },
            async commit(limits) {
              if (phase !== 'HISTORY') fail();
              await writer.configure(limits); command(await writer.query('COMMIT', [], limits.statementMs), 'COMMIT'); phase = 'COMMITTED';
            },
            async readback({ signal, remainingMs }) {
              let observer;
              try {
                if (remainingMs <= 1) fail();
                const statementMs = Math.min(context.budget.statementMs, remainingMs);
                const budget = { overallMs: remainingMs, statementMs, lockMs: Math.min(context.budget.lockMs, statementMs - 1), idleTransactionMs: Math.min(context.budget.idleTransactionMs, remainingMs) };
                observer = await connect({ ...context, budget }, true, signal);
                command(await observer.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), 'BEGIN'); await observer.configure(budget);
                identity(await observer.query(identitySql), settings.target, context.runId, observer.nonce, bundle.parserMajor, true);
                const history = await readMigrationHistoryInTransaction(observer.query, beforeVersions, afterVersions);
                const state = await readPostgresMigrationState(observer.query, history.rowCount === afterVersions.length
                  ? coverageFor.get(context.migration.version).after : coverageFor.get(context.migration.version).before);
                const status = await observer.query(`SELECT pg_catalog.to_char(backend_start AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')::text,
                  datid::text,usesysid::text,application_name::text,state::text FROM pg_catalog.pg_stat_activity WHERE pid=$1`, [owned.pid]);
                if (status?.command !== 'SELECT' || !Array.isArray(status.rows) || status.rows.length > 1 || status.rowCount !== status.rows.length) fail();
                const row = status.rows[0];
                const same = row && row.length === 5 && row[0] === owned.backendStart && row[1] === String(owned.databaseOid)
                  && row[2] === String(owned.roleOid) && row[3] === writer.nonce;
                const backend = { verification: 'VERIFIED', identity: owned,
                  status: !row ? 'DEFINITIVELY_GONE' : same ? 'SAME_BACKEND_LIVE' : 'PID_REUSED',
                  transactionStatus: !row ? 'NO_BACKEND' : same && row[4] === 'idle' ? 'IDLE' : 'UNKNOWN' };
                command(await observer.query('ROLLBACK'), 'ROLLBACK'); await observer.close(); observer = null;
                return { verification: 'VERIFIED', snapshotKind: 'INDEPENDENT_COMMITTED_SNAPSHOT', modelSource: context.modelSource,
                  historySha256: history.historySha256, history: migrationHistoryPolicyRows(history), state: migrationStateDigests(state), backend };
              } catch { observer?.abort(); if (observer) void observer.close().catch(() => {}); fail(); }
            },
            async close() { await writer.close(); },
          };
          return Object.freeze(session);
        } catch { writer?.abort(); if (writer) void writer.close().catch(() => {}); fail(); }
      },
    });
  } catch { throw new Error('MIGRATION_ATOMIC_DRIVER_INVALID'); }
}
