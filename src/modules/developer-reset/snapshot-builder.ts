import { createHmac, randomFillSync } from 'node:crypto';
import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { inspectResetSnapshot, inspectResetSnapshotCapture } from './reset-snapshot.js';
import { composeResetReview, resetReviewRequestSchema, resetReviewFailureCode, assertResetReviewActor, assertResetReviewEnvelope, type ReviewRow } from './review-composition.js';
import { captureResetPlanContent } from './plan-revalidation.js';
import { inspectResetProtectionPlan } from './reset-protection-plan.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const name = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const relation = z.string().regex(/^(public|private|auth)\.[a-z][a-z0-9_]{0,62}$/);
const pgType = z.string().regex(/^[a-z][a-z0-9_]*\.[a-z_][a-z0-9_]*(?:\[\])?$/).max(128);
const column = z.object({ name, pgType }).strict();
const cell = z.object({ name, pgType, value: z.string().nullable() }).strict();
const bindingSchema = z.object({ projectRef: z.string().regex(/^[a-z]{20}$/),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), catalogFingerprint: hash, classificationFingerprint: hash }).strict();
const consistency = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stable-statement'), statementId: hash }).strict(),
  z.object({ kind: z.literal('repeatable-read'), transactionId: hash }).strict(),
]);
const metadataSchema = z.object({
  binding: bindingSchema, consistency,
  relations: z.array(z.object({ relation, columns: z.array(column).min(1).max(1600),
    primaryKey: z.array(name).min(1).max(64) }).strict()).min(1).max(1000),
  foreignKeys: z.array(z.object({ source: relation, target: relation, name,
    sourceNullable: z.array(z.boolean()).min(1).max(64), match: z.enum(['s', 'f']), validated: z.literal(true),
  }).strict()).max(10000),
}).strict();
const expectedSchema = metadataSchema.omit({ consistency: true });
const contentSchema = z.object({ scopeId: hash, relation, key: z.array(cell).min(1).max(64),
  values: z.array(cell).min(1).max(1600) }).strict();
const rowSchema = contentSchema.extend({ disposition: z.enum(['keep', 'remove', 'roomBaseline', 'templateSource', 'unresolved']),
  references: z.array(z.object({ constraint: name, targetKey: z.array(cell).min(1).max(64).nullable(),
    sourceNulls: z.array(z.boolean()).min(1).max(64) }).strict()).max(200),
}).strict();
const censusHeader = z.object({ scopeId: hash, relation, count: z.number().int().min(0).max(10000) }).strict();
type Binding = z.infer<typeof bindingSchema>;
type Metadata = z.infer<typeof metadataSchema>;
type Cell = z.infer<typeof cell>;

/** Internal source port, never an HTTP request or self-reported client proof.
 * The adapter must obtain metadata, independently queried COUNTs, the row stream,
 * and an independent content stream in one STABLE statement or one READ ONLY
 * REPEATABLE READ transaction. FK targets are resolved by PostgreSQL equality,
 * and targetKey is the matched target's PK, not the source FK value.
 * Values use the adapter's fixed, lossless PostgreSQL text codec; no JS numbers
 * for numeric/temporal/byte values. No Auth fields beyond auth.users.id.
 */
export interface ResetSnapshotSource {
  collect(signal: AbortSignal): Promise<{
    metadata: unknown;
    rows: AsyncIterable<unknown>;
    census: AsyncIterable<{ header: unknown; contents: AsyncIterable<unknown> }>;
    review?: unknown;
  }>;
}
export interface ResetSnapshotLimits { rows?: number; bytes?: number; milliseconds?: number }
class CaptureFailure extends Error {}
const fail = (code: string): never => { throw new CaptureFailure(code); };
const maxRows = 10000;
const maxBytes = 16 * 1024 * 1024;
const maxMilliseconds = 5000;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** One-use, server-internal builder. It holds no raw rows after build returns and
 * exposes neither its ephemeral key nor row identities/content tokens. This is
 * coherent-input validation, not a live DB collector, reset permit, backup proof,
 * cross-snapshot approval recheck, TTL policy or guarantee of remote cancellation.
 */
export function createResetSnapshotBuilder(expectedInput: unknown, limits: ResetSnapshotLimits = {}) {
  let used = false;
  let disposed = false;
  let active: AbortController | undefined;
  // Capture the server-selected binding now; later caller mutation cannot retarget it.
  const expectedResult = expectedSchema.safeParse(expectedInput);
  const expectedCapture = expectedResult.success ? expectedResult.data : null;
  const limit = (value: number | undefined, maximum: number) => {
    const result = value ?? maximum;
    if (!Number.isSafeInteger(result) || result < 1 || result > maximum) return fail('RESET_SNAPSHOT_LIMIT_INVALID');
    return result;
  };
  const rowLimit = limit(limits.rows, maxRows);
  const byteLimit = limit(limits.bytes, maxBytes);
  const timeLimit = limit(limits.milliseconds, maxMilliseconds);

  async function collect(source: ResetSnapshotSource, signal?: AbortSignal, reviewInput?: unknown, planCapture?: object) {
    if (used || disposed) return { ...blocked('RESET_SNAPSHOT_BUILDER_CLOSED'), review: null };
    used = true;
    const secret = Buffer.alloc(32);
    const controller = new AbortController();
    active = controller;
    const joined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeLimit);
    const deadline = performance.now() + timeLimit;
    let remainingBytes = byteLimit;
    const reviewRows: ReviewRow[] = [];
    const independent: { relation: string; key: string }[] = [];
    const check = () => {
      if (performance.now() >= deadline) { timedOut = true; controller.abort(); }
      if (joined.aborted || disposed) fail(timedOut ? 'RESET_SNAPSHOT_TIMEOUT' : 'RESET_SNAPSHOT_CANCELLED');
    };
    const abortFailure = () => new CaptureFailure(timedOut ? 'RESET_SNAPSHOT_TIMEOUT' : 'RESET_SNAPSHOT_CANCELLED');
    const wait = async <T>(work: Promise<T>): Promise<T> => {
      check();
      let rejectAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = () => reject(abortFailure());
        joined.addEventListener('abort', rejectAbort, { once: true });
      });
      try { const value = await Promise.race([work, aborted]); check(); return value; }
      finally { if (rejectAbort) joined.removeEventListener('abort', rejectAbort); }
    };
    const copy = (input: unknown, seen = new Set<object>(), depth = 0): unknown => {
      check();
      if (depth > 12) return fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
      if (input === null || typeof input === 'boolean') return input;
      if (typeof input === 'number') {
        if (!Number.isSafeInteger(input)) return fail('RESET_SNAPSHOT_INPUT_INVALID');
        return input;
      }
      if (typeof input === 'string') {
        remainingBytes -= Buffer.byteLength(input, 'utf8');
        if (remainingBytes < 0) return fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
        return input;
      }
      if (typeof input !== 'object' || !input || seen.has(input)) return fail('RESET_SNAPSHOT_INPUT_INVALID');
      const array = Array.isArray(input);
      if (Object.getPrototypeOf(input) !== (array ? Array.prototype : Object.prototype)) return fail('RESET_SNAPSHOT_INPUT_INVALID');
      seen.add(input);
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const keys = Object.keys(descriptors).filter(key => !(array && key === 'length'));
      if (keys.length > 20000 || Reflect.ownKeys(input).some(key => typeof key === 'symbol')) return fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
      const entries = keys.map(key => {
        remainingBytes -= Buffer.byteLength(key, 'utf8') + 1;
        if (remainingBytes < 0) return fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
        const d = descriptors[key];
        if (!d || !('value' in d) || !d.enumerable || key === '__proto__') return fail('RESET_SNAPSHOT_INPUT_INVALID');
        return [key, copy(d.value, seen, depth + 1)] as const;
      });
      seen.delete(input);
      if (array) {
        if (keys.length !== input.length || keys.some((key, i) => key !== String(i))) return fail('RESET_SNAPSHOT_INPUT_INVALID');
        return entries.map(([, value]) => value);
      }
      return Object.fromEntries(entries);
    };
    const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
      const result = schema.safeParse(copy(input));
      if (!result.success) return fail('RESET_SNAPSHOT_INPUT_INVALID');
      return result.data;
    };
    const each = async <T>(stream: AsyncIterable<T>, visit: (row: T) => Promise<void> | void) => {
      const iterator = stream[Symbol.asyncIterator]();
      let finished = false;
      try {
        while (true) {
          const next = await wait(iterator.next());
          if (next.done) { finished = true; break; }
          await visit(next.value);
        }
      } finally {
        if (!finished && iterator.return) {
          // Best effort only; never await an uncooperative provider during cleanup.
          try { Promise.resolve(iterator.return()).catch(() => {}); }
          catch { /* Preserve the original failure even if provider cleanup throws. */ }
        }
      }
    };
    try {
      randomFillSync(secret);
      const selected = expectedCapture ?? fail('RESET_SNAPSHOT_INPUT_INVALID');
      // Clone the reviewed intent before yielding to the source. No callback,
      // capture token or raw row handle is ever returned to the caller.
      const reviewRequest = reviewInput === undefined ? null : parse(resetReviewRequestSchema, reviewInput);
      const expected: Binding = parse(bindingSchema, selected.binding);
      const collected = await wait(source.collect(joined));
      const reviewSidecar = reviewRequest ? copy(collected.review) : null;
      const metadata: Metadata = parse(metadataSchema, collected.metadata);
      if (requestHash(expected) !== requestHash(metadata.binding)) fail('RESET_SNAPSHOT_BINDING_MISMATCH');
      const catalog = (input: Pick<Metadata, 'relations' | 'foreignKeys'>) => ({
        relations: input.relations.map(table => ({ ...table,
          columns: [...table.columns].sort((a, b) => compare(a.name, b.name)) })).sort((a, b) => compare(a.relation, b.relation)),
        foreignKeys: [...input.foreignKeys].sort((a, b) => compare(`${a.source}:${a.name}`, `${b.source}:${b.name}`)),
      });
      if (requestHash(catalog(selected)) !== requestHash(catalog(metadata))) fail('RESET_SNAPSHOT_CATALOG_MISMATCH');
      const scopeId = metadata.consistency.kind === 'stable-statement'
        ? metadata.consistency.statementId : metadata.consistency.transactionId;
      const isolation = metadata.consistency.kind === 'stable-statement' ? 'stable statement' : 'repeatable read';
      const snapshotId = createHmac('sha256', secret).update(JSON.stringify(['snapshot-v1', expected, isolation, scopeId])).digest('hex');
      const tables = new Map(metadata.relations.map(row => [row.relation, row]));
      if (tables.size !== metadata.relations.length) fail('RESET_SNAPSHOT_INPUT_INVALID');
      for (const table of tables.values()) {
        if (new Set(table.columns.map(c => c.name)).size !== table.columns.length ||
            new Set(table.primaryKey).size !== table.primaryKey.length ||
            table.primaryKey.some(key => !table.columns.some(c => c.name === key))) fail('RESET_SNAPSHOT_INPUT_INVALID');
        if (table.relation.startsWith('auth.') && (table.relation !== 'auth.users' || table.columns.length !== 1 ||
            table.columns[0]?.name !== 'id' || table.columns[0]?.pgType !== 'pg_catalog.uuid' ||
            table.primaryKey.length !== 1 || table.primaryKey[0] !== 'id')) fail('RESET_SNAPSHOT_AUTH_BOUNDARY');
      }
      const keys = (tableName: string, cells: Cell[], primary: boolean) => {
        const table = tables.get(tableName);
        if (!table) return fail('RESET_SNAPSHOT_INPUT_INVALID');
        const names = primary ? table.primaryKey : table.columns.map(c => c.name);
        if (cells.length !== names.length || new Set(cells.map(c => c.name)).size !== cells.length ||
            cells.some(c => !names.includes(c.name) || !table.columns.some(meta => meta.name === c.name && meta.pgType === c.pgType) ||
              (primary && c.value === null))) return fail('RESET_SNAPSHOT_INPUT_INVALID');
        const sorted = [...cells].sort((a, b) => compare(a.name, b.name));
        return sorted.map(c => [c.name, c.pgType, c.value]);
      };
      const token = (purpose: string, table: string, value: unknown) => createHmac('sha256', secret)
        .update(JSON.stringify(['reset-snapshot-v1', expected, isolation, scopeId, purpose, table, value])).digest('hex');
      const encode = (row: z.infer<typeof contentSchema>) => {
        if (row.scopeId !== scopeId) fail('RESET_SNAPSHOT_MIXED_SCOPE');
        const identity = keys(row.relation, row.key, true);
        const values = keys(row.relation, row.values, false);
        for (const [name, type, value] of identity) {
          if (!values.some(v => v[0] === name && v[1] === type && v[2] === value)) fail('RESET_SNAPSHOT_KEY_CONTENT_MISMATCH');
        }
        return { key: token('row-identity', row.relation, identity), contentToken: token('row-content', row.relation, values) };
      };
      const fks = new Map(metadata.foreignKeys.map(fk => [`${fk.source}:${fk.name}`, fk]));
      if (fks.size !== metadata.foreignKeys.length || metadata.foreignKeys.some(fk => !tables.has(fk.source) || !tables.has(fk.target))) fail('RESET_SNAPSHOT_INPUT_INVALID');
      const rows: { relation: string; key: string; disposition: z.infer<typeof rowSchema>['disposition']; references: { constraint: string; targetKey: string | null }[] }[] = [];
      const content: { relation: string; key: string; snapshotId: string; contentToken: string }[] = [];
      const nullEvidence: { relation: string; key: string; constraint: string; snapshotId: string; sourceNulls: boolean[] }[] = [];
      await each(collected.rows, raw => {
        if (rows.length >= rowLimit) fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
        const row = parse(rowSchema, raw); const encoded = encode(row);
        const references = row.references.map(ref => {
          const fk = fks.get(`${row.relation}:${ref.constraint}`);
          if (!fk) return fail('RESET_SNAPSHOT_INPUT_INVALID');
          nullEvidence.push({ relation: row.relation, key: encoded.key, constraint: ref.constraint, snapshotId, sourceNulls: ref.sourceNulls });
          if (nullEvidence.length > 100000) fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
          return { constraint: ref.constraint, targetKey: ref.targetKey === null ? null : token('row-identity', fk.target, keys(fk.target, ref.targetKey, true)) };
        });
        rows.push({ relation: row.relation, key: encoded.key, disposition: row.disposition, references });
        content.push({ relation: row.relation, snapshotId, ...encoded });
        if (reviewRequest) reviewRows.push({ relation: row.relation, key: encoded.key, keyFields: row.key.map(c => c.name), values: row.values, disposition: row.disposition });
      });
      const census: { relation: string; count: number; snapshotId: string; contentFingerprint: string }[] = [];
      let censusRows = 0;
      await each(collected.census, async chunk => {
        if (census.length >= tables.size) fail('RESET_SNAPSHOT_INPUT_INVALID');
        const header = parse(censusHeader, chunk.header);
        if (header.scopeId !== scopeId) fail('RESET_SNAPSHOT_MIXED_SCOPE');
        if (!tables.has(header.relation) || census.some(c => c.relation === header.relation)) fail('RESET_SNAPSHOT_INPUT_INVALID');
        const contents: { key: string; contentToken: string }[] = [];
        await each(chunk.contents, raw => {
          if (++censusRows > rowLimit) fail('RESET_SNAPSHOT_LIMIT_EXCEEDED');
          const item = parse(contentSchema, raw);
          if (item.relation !== header.relation) fail('RESET_SNAPSHOT_INPUT_INVALID');
          const encoded = encode(item); contents.push(encoded);
          if (reviewRequest) independent.push({ relation: item.relation, key: encoded.key });
        });
        if (header.count !== contents.length || new Set(contents.map(c => c.key)).size !== contents.length) fail('RESET_SNAPSHOT_CENSUS_MISMATCH');
        contents.sort((a, b) => compare(a.key, b.key));
        const captured = content.filter(row => row.relation === header.relation)
          .map(({ key, contentToken }) => ({ key, contentToken })).sort((a, b) => compare(a.key, b.key));
        if (requestHash(captured) !== requestHash(contents)) fail('CENSUS_CONTENT_MISMATCH');
        census.push({ relation: header.relation, count: header.count, snapshotId, contentFingerprint: requestHash(contents) });
      });
      check();
      if (census.length !== tables.size) fail('MISSING_RELATION_COUNT');
      const pending = new Set<string>();
      for (const row of rows) {
        if (row.disposition === 'roomBaseline') pending.add('RESET_ROOM_BASELINE_DISPOSITION_UNRESOLVED');
        if (row.disposition === 'templateSource') pending.add('RESET_TEMPLATE_DISPOSITION_UNRESOLVED');
        if (row.disposition === 'unresolved') pending.add('RESET_ROW_DISPOSITION_UNRESOLVED');
      }
      const snapshotInput = { expected, snapshot: { ...expected, id: snapshotId, readOnly: true, isolation },
        plan: { catalogFingerprint: expected.catalogFingerprint, snapshotCatalogFingerprint: metadata.binding.catalogFingerprint,
          complete: true, relations: [...tables.keys()], relationRowCounts: census.map(({ relation, count }) => ({ relation, count })),
          foreignKeys: metadata.foreignKeys.map(({ source, target, name }) => ({ source, target, name })), rows },
        census, content, foreignKeys: metadata.foreignKeys.map(({ source, name, sourceNullable, match, validated }) => ({ source, name, sourceNullable, match, validated })), nullEvidence };
      // Pending policy must never bypass technical FK/NULL/target completeness.
      // The capture checker retains undecided labels and grants no plan validity.
      const structure = inspectResetSnapshotCapture(snapshotInput);
      const contentFingerprint = requestHash({ snapshotId, census: [...census].sort((a, b) => compare(a.relation, b.relation)) });
      const reviewBinding = { ...expected, snapshotId, contentFingerprint };
      if (!structure.structureValid) {
        // Complete structural/content observations may diagnose a preservation
        // conflict. Other technical failures never expose a partial manifest.
        let protection: ReturnType<typeof inspectResetProtectionPlan> | null = null;
        if (reviewRequest && metadata.consistency.kind === 'repeatable-read' &&
          structure.blockers.length > 0 && structure.blockers.every(code => code === 'PRESERVED_ROW_REFERENCES_REMOVED_ROW')) {
          assertResetReviewEnvelope(scopeId, reviewSidecar);
          if (assertResetReviewActor(reviewRequest, reviewRows, [...tables.keys()])) protection = inspectResetProtectionPlan({ binding: reviewBinding, selection: { binding: reviewBinding,
            templateSelection: reviewRequest.templateSelection, requestFingerprint: requestHash({ binding: reviewBinding, request: reviewRequest }),
            reviewPlanFingerprint: null }, referenceCapture: snapshotInput.plan });
        }
        check();
        return { ...blocked([...new Set([...structure.blockers, ...pending])].sort()), review: null, protection };
      }
      let review = null;
      if (reviewRequest) {
        if (metadata.consistency.kind !== 'repeatable-read') fail('RESET_REVIEW_REPEATABLE_READ_REQUIRED');
        if (planCapture) captureResetPlanContent(planCapture, { binding: expected, ...catalog(selected) }, reviewRequest, reviewRows);
        review = { ...composeResetReview({ request: reviewRequest, binding: reviewBinding,
          scopeId, relations: [...tables.keys()], rows: reviewRows, independent, census, sidecar: reviewSidecar, pending: [...pending].sort() }, planCapture, snapshotInput.plan),
          reviewPrepared: true, contentVerified: true };
        check();
      }
      // Content has been independently compared, but unresolved candidates are
      // never converted into a keep/remove decision or a valid reference plan.
      if (pending.size) return { ...blocked([...pending].sort()), review };
      const result = inspectResetSnapshot(snapshotInput);
      // Technical FK/content failure must not expose a partial composition or receipt.
      if (!result.snapshotValid) review = null;
      return { ...result, consistency: metadata.consistency.kind, review, protection: null };
    } catch (error) {
      return { ...blocked(error instanceof CaptureFailure ? error.message : resetReviewFailureCode(error) ?? 'RESET_SNAPSHOT_SOURCE_UNAVAILABLE'), review: null };
    } finally {
      reviewRows.length = 0; independent.length = 0;
      clearTimeout(timer); secret.fill(0); disposed = true; controller.abort(); active = undefined;
    }
  }
  return Object.freeze({
    build: async (source: ResetSnapshotSource, signal?: AbortSignal) => {
      const { review: _review, ...result } = await collect(source, signal); return result;
    },
    buildReview: (source: ResetSnapshotSource, request: unknown, signal?: AbortSignal, planCapture?: object) => collect(source, signal, request ?? null, planCapture),
    dispose: () => { disposed = true; active?.abort(); },
  });
}
function blocked(code: string | string[]) {
  return { snapshotValid: false, executionEnabled: false, fingerprint: null, counts: null,
    consistency: null, protection: null, blockers: Array.isArray(code) ? code : [code] };
}
