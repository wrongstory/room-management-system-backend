import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateResetCatalog } from '../../../scripts/reset-catalog-contract.mjs';
import { requestHash } from '../../lib/command.js';
import { createResetSnapshotBuilder, type ResetSnapshotSource } from './snapshot-builder.js';
import { createResetReadPlan, resetCatalogReadSql, resetReadIdentitySql, resetReadSafetySql } from './snapshot-read-plan.js';
import { resetReviewStatementId } from './review-composition.js';

/** Internal dedicated connection port. No default connection, credentials, CLI or HTTP entry.
 * The owner must open a new connection with verified transport, read-only defaults,
 * bounded wire bytes and text-only OID25 decoding. Never pass a pooled/in-use transaction.
 * Synthetic implementations test the source but cannot mint live DB/transport proof.
 */
export interface ResetReadClient {
  query(text: string, values: readonly string[], signal: AbortSignal): Promise<unknown>;
  destroy(): void;
  close(): Promise<void>;
}
export type OpenResetReadClient = (signal: AbortSignal, bounds: { maxWireBytes: number; deadlineMilliseconds: number }) => Promise<ResetReadClient>;
const inputSchema = z.object({ catalog: z.unknown(), binding: z.unknown(),
  database: z.literal('postgres'), role: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/) }).strict();
const identityNames = ['pid', 'database_name', 'role_name', 'read_only', 'isolation', 'row_security', 'nonce', 'encoding',
  'timezone', 'datestyle', 'intervalstyle', 'bytea_output', 'float_digits', 'bypass_rls', 'snapshot', 'statement_timeout', 'lock_timeout'];
const settings = { statement_timeout: '4000ms', lock_timeout: '1000ms', idle_in_transaction_session_timeout: '4000ms',
  search_path: 'pg_catalog', row_security: 'off', TimeZone: 'UTC', DateStyle: 'ISO, MDY', IntervalStyle: 'iso_8601',
  bytea_output: 'hex', extra_float_digits: '3' };
const catalogSql = `SELECT source.payload::pg_catalog.text AS payload FROM (${resetCatalogReadSql.replace(/;$/, '')}) source(payload)`;
const byteLimit = 16 * 1024 * 1024;
// Existing STABLE collectors only. No policy configuration or write function.
export const resetReviewEvidenceSql = `SELECT pg_catalog.jsonb_build_object(
  'databaseSnapshot', pg_catalog.pg_current_snapshot()::pg_catalog.text,
  'statementAt', pg_catalog.statement_timestamp()::pg_catalog.text,
  'statementId', pg_catalog.encode(extensions.digest(pg_catalog.pg_current_snapshot()::pg_catalog.text || pg_catalog.statement_timestamp()::pg_catalog.text, 'sha256'), 'hex'),
  'templateEvidence', private.collect_developer_reset_template_inventory(),
  'gateEvidence', private.collect_developer_operation_gates())::pg_catalog.text AS payload`;
const blocked = (code: string) => ({ snapshotValid: false, executionEnabled: false, fingerprint: null, counts: null,
  consistency: null, blockers: [code], liveDatabaseVerified: false });
async function* stream<T>(rows: T[]) { for (const row of rows) yield row; }

/** Executes only the closed read plan through an owned internal port. No reset permission.
 * Returned evidence is coherent port input, not proof of a trusted live connector.
 */
export async function inspectResetReadOnlySource(input: unknown, open: OpenResetReadClient, signal?: AbortSignal) {
  const { review: _review, ...result } = await inspect(input, open, signal); return result;
}

/** Same closed transaction with internal composition. No public request or live-proof minting. */
export function inspectResetReadOnlyReview(input: unknown, request: unknown, open: OpenResetReadClient, signal?: AbortSignal) {
  return inspect(input, open, signal, request ?? null);
}
async function inspect(input: unknown, open: OpenResetReadClient, signal?: AbortSignal, request?: unknown) {
  const reject = (code: string) => ({ ...blocked(code), review: null });
  const parsed = inputSchema.safeParse(input); if (!parsed.success) return reject('RESET_READ_INPUT_INVALID');
  let plan: ReturnType<typeof createResetReadPlan>;
  try { plan = createResetReadPlan(parsed.data.catalog, parsed.data.binding); }
  catch { return reject('RESET_READ_PLAN_REJECTED'); }
  const builder = createResetSnapshotBuilder(plan.expected);
  let sourceFailure: string | undefined;
  let client: ResetReadClient | undefined;
  let closed = false;
  let expired = false;
  let remaining = byteLimit;
  const start = performance.now();
  const deadline = start + 4500;
  const capturedRows: Record<string, unknown>[] = [];
  const census: { header: { scopeId: string; relation: string; count: number }; contents: Record<string, unknown>[] }[] = [];
  const fail = (code: string): never => { sourceFailure = code; throw new Error(code); };
  const destroy = () => { try { client?.destroy(); } catch { /* No provider details escape. */ } };
  const wait = async <T>(operation: () => Promise<T>, abort: AbortSignal, budget = 4000): Promise<T> => {
    const duration = Math.min(budget, Math.floor(deadline - performance.now()));
    if (abort.aborted || expired) return fail('RESET_READ_CANCELLED');
    if (duration <= 0) return fail('RESET_READ_DEADLINE');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let listener: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_resolve, reject) => {
        const stop = (code: string) => { expired = true; sourceFailure = code; destroy(); reject(new Error(code)); };
        timer = setTimeout(() => stop('RESET_READ_DEADLINE'), duration);
        listener = () => stop('RESET_READ_CANCELLED'); abort.addEventListener('abort', listener, { once: true });
      });
      const result = await Promise.race([Promise.resolve().then(operation), stopped]);
      if (expired || abort.aborted || performance.now() >= deadline) return fail('RESET_READ_CANCELLED');
      return result;
    } finally { if (timer) clearTimeout(timer); if (listener) abort.removeEventListener('abort', listener); }
  };
  const records = (input: unknown, names: string[], maximum: number) => {
    const value = input as { command?: unknown; fields?: { name?: unknown; dataTypeID?: unknown }[]; rows?: unknown[][] };
    if (value?.command !== 'SELECT' || !Array.isArray(value.fields) || !Array.isArray(value.rows) ||
        value.fields.length !== names.length || value.fields.some((field, index) => field.name !== names[index] || field.dataTypeID !== 25) ||
        value.rows.length > maximum) return fail('RESET_READ_RESULT_INVALID');
    for (const row of value.rows) {
      if (!Array.isArray(row) || row.length !== names.length || row.some(cell => cell !== null && typeof cell !== 'string')) return fail('RESET_READ_RESULT_INVALID');
      for (const cell of row) remaining -= cell === null ? 1 : Buffer.byteLength(cell as string, 'utf8');
      if (remaining < 0) return fail('RESET_READ_WIRE_LIMIT');
    }
    return value.rows as (string | null)[][];
  };
  const oneJson = (result: unknown) => {
    const rows = records(result, ['payload'], 1); if (rows.length !== 1 || typeof rows[0]?.[0] !== 'string') return fail('RESET_READ_RESULT_INVALID');
    try { return JSON.parse(rows[0][0]) as unknown; } catch { return fail('RESET_READ_RESULT_INVALID'); }
  };
  const source: ResetSnapshotSource = { collect: async abort => {
    const nonce = `rms_reset_${randomUUID()}`;
    const pending = Promise.resolve().then(() => open(abort, { maxWireBytes: byteLimit, deadlineMilliseconds: 4500 }));
    pending.then(value => { if (expired || abort.aborted) { try { value.destroy(); } catch {} } }, () => {});
    try {
      client = await wait(() => pending, abort);
      const query = (sql: string, values: readonly string[] = []) => wait(() => {
        if (!client) return Promise.reject(new Error('RESET_READ_CONNECTION')); return client.query(sql, values, abort);
      }, abort);
      const command = async (sql: string, expected: string) => {
        const result = await query(sql) as { command?: unknown; rows?: unknown };
        if (!result || result.command !== expected || !Array.isArray(result.rows) || result.rows.length) fail('RESET_READ_COMMAND_INVALID');
      };
      await command('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'BEGIN');
      // SET and LOCK utilities do not freeze the RR snapshot. Acquire every
      // relation lock before the first SELECT, including identity/config reads.
      const configSql = Object.entries({ ...settings, application_name: nonce })
        .map(([name, value]) => `SET LOCAL ${name} = '${value}'`).join(';');
      const config = await query(configSql) as { command?: unknown; rows?: unknown }[];
      if (!Array.isArray(config) || config.length !== 11 || config.some(item => item.command !== 'SET' || !Array.isArray(item.rows) || item.rows.length)) fail('RESET_READ_CONFIG_INVALID');
      await command(plan.lockSql, 'LOCK');
      const identity = (result: unknown) => {
        const rows = records(result, identityNames, 1); const row = rows[0];
        if (rows.length !== 1 || !row || !/^[1-9][0-9]*$/.test(row[0] ?? '') || row[1] !== parsed.data.database || row[2] !== parsed.data.role ||
            row[3] !== 'on' || row[4] !== 'repeatable read' || row[5] !== 'off' || row[6] !== nonce || row[7] !== 'UTF8' ||
            row[8] !== 'UTC' || row[9] !== 'ISO, MDY' || row[10] !== 'iso_8601' || row[11] !== 'hex' || row[12] !== '3' ||
            row[13] !== 'true' || !/^[0-9]+:[0-9]+:(?:[0-9]+(?:,[0-9]+)*)?$/.test(row[14] ?? '') ||
            !['4s', '4000ms'].includes(row[15] ?? '') || !['1s', '1000ms'].includes(row[16] ?? '')) fail('RESET_READ_IDENTITY_INVALID');
        return row;
      };
      const before = identity(await query(resetReadIdentitySql));
      const verifyCatalog = (result: unknown) => {
        const actual = validateResetCatalog(oneJson(result));
        if (actual.catalogFingerprint !== plan.catalogFingerprint) fail('RESET_READ_CATALOG_CHANGED');
      };
      verifyCatalog(await query(catalogSql));
      const checkSafety = (value: unknown) => {
        const safety = z.object({ relations: z.number().int(), unsafeRelations: z.literal(0), unsafeTypes: z.literal(0),
          relationIdentities: z.array(z.object({ name: z.string(), oid: z.string().regex(/^[1-9][0-9]*$/) }).strict()).max(1000),
          unlockedRelations: z.literal(0), foreignKeyColumns: z.number().int(), unsafeEquality: z.literal(0) }).strict().safeParse(oneJson(value));
        if (!safety.success) return fail('RESET_READ_SEMANTICS_UNSUPPORTED');
        const identities = safety.data.relationIdentities;
        if (safety.data.relations !== plan.statements.length || safety.data.foreignKeyColumns !== plan.foreignKeyColumns ||
            new Set(identities.map(item => item.oid)).size !== plan.statements.length ||
            requestHash(identities.map(item => item.name).sort()) !== requestHash(plan.statements.map(item => item.relation).sort())) return fail('RESET_READ_SEMANTICS_UNSUPPORTED');
        return identities.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      };
      const safetyArgs = [JSON.stringify(plan.statements.map(item => item.relation))];
      const relationIdentities = checkSafety(await query(resetReadSafetySql, safetyArgs));
      const scopeId = requestHash({ nonce, identity: before, binding: plan.binding, relationIdentities });
      const countSql = plan.statements.map(statement => `SELECT '${statement.relation}'::text AS relation, counted.row_count FROM (${statement.countSql}) counted`).join(' UNION ALL ');
      const counts = records(await query(countSql), ['relation', 'row_count'], 1000);
      const countMap = new Map<string, number>(); let total = 0;
      for (const [name, count] of counts) {
        if (!name || !plan.statements.some(item => item.relation === name) || countMap.has(name) || !/^(0|[1-9][0-9]*)$/.test(count ?? '')) return fail('RESET_READ_CENSUS_INVALID');
        const n = Number(count); total += n;
        if (!Number.isSafeInteger(n) || n > 10000 || total > 10000) fail('RESET_READ_ROW_LIMIT');
        countMap.set(name, n);
      }
      if (countMap.size !== plan.statements.length) fail('RESET_READ_CENSUS_INVALID');
      const parsePayload = (row: (string | null)[], fields: string[]) => {
        try { const value: unknown = JSON.parse(row[0] ?? ''); if (!value || typeof value !== 'object' || Array.isArray(value) ||
          Object.keys(value).length !== fields.length || fields.some(field => !Object.hasOwn(value, field))) return fail('RESET_READ_RESULT_INVALID'); return value as Record<string, unknown>; }
        catch { return fail('RESET_READ_RESULT_INVALID'); }
      };
      for (const row of records(await query(plan.statements.map(item => `(${item.rowsSql})`).join(' UNION ALL ')), ['payload'], 10000)) {
        const value = parsePayload(row, ['relation', 'key', 'values', 'candidate', 'references']); const { candidate, ...content } = value;
        const candidates = ['preserve', 'resetCandidate', 'photoHold', 'roomBaseline', 'templateSource', 'unresolved'];
        if (typeof candidate !== 'string' || !candidates.includes(candidate)) fail('RESET_READ_CANDIDATE_INVALID');
        capturedRows.push({ ...content, scopeId, disposition: candidate === 'preserve' || candidate === 'photoHold' ? 'keep' : candidate === 'resetCandidate' ? 'remove' : candidate });
      }
      const groups = new Map<string, Record<string, unknown>[]>();
      for (const row of records(await query(plan.statements.map(item => `(${item.contentSql})`).join(' UNION ALL ')), ['payload'], 10000)) {
        const value = parsePayload(row, ['relation', 'key', 'values']); if (typeof value.relation !== 'string' || !countMap.has(value.relation)) return fail('RESET_READ_RESULT_INVALID');
        const group = groups.get(value.relation) ?? []; group.push({ ...value, scopeId }); groups.set(value.relation, group);
      }
      for (const [name, count] of countMap) census.push({ header: { relation: name, count, scopeId }, contents: groups.get(name) ?? [] });
      let review: unknown;
      if (request !== undefined) {
        const parsed = z.object({ databaseSnapshot: z.string(), statementAt: z.string(), statementId: z.string(),
          templateEvidence: z.unknown(), gateEvidence: z.unknown() }).strict().safeParse(oneJson(await query(resetReviewEvidenceSql)));
        if (!parsed.success || parsed.data.databaseSnapshot !== before?.[14] ||
          parsed.data.statementId !== resetReviewStatementId(parsed.data.databaseSnapshot, parsed.data.statementAt)) return fail('RESET_READ_REVIEW_SCOPE_CHANGED');
        const { databaseSnapshot: _databaseSnapshot, ...observed } = parsed.data;
        review = { scopeId, ...observed };
      }
      verifyCatalog(await query(catalogSql));
      if (requestHash(checkSafety(await query(resetReadSafetySql, safetyArgs))) !== requestHash(relationIdentities)) fail('RESET_READ_RELATION_IDENTITY_CHANGED');
      if (requestHash(identity(await query(resetReadIdentitySql))) !== requestHash(before)) fail('RESET_READ_IDENTITY_CHANGED');
      await command('ROLLBACK', 'ROLLBACK');
      await wait(() => client?.close() ?? Promise.resolve(), abort, 350); closed = true;
      return { metadata: { ...plan.expected, consistency: { kind: 'repeatable-read', transactionId: scopeId } },
        rows: stream(capturedRows), census: stream(census.map(entry => ({ header: entry.header, contents: stream(entry.contents) }))), review };
    } catch { if (!sourceFailure) sourceFailure = 'RESET_READ_SOURCE_FAILED'; destroy(); throw new Error(sourceFailure); }
  } };
  try {
    const result = request === undefined ? { ...await builder.build(source, signal), review: null } : await builder.buildReview(source, request, signal);
    return sourceFailure ? reject(sourceFailure) : { ...result, liveDatabaseVerified: false };
  } finally {
    builder.dispose(); if (!closed) destroy(); capturedRows.length = 0;
    for (const entry of census) entry.contents.length = 0; census.length = 0;
  }
}
