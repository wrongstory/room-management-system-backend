import { z } from 'zod';
import { requestHash } from '../../lib/command.js';
import { findResetLogicalReferenceRule, RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT,
  type LogicalReferenceRule } from './logical-reference-registry.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const relation = z.string().regex(/^(public|private)\.[a-z][a-z0-9_]*$/).max(128);
const path = z.string().regex(/^[a-z][a-zA-Z0-9_.]*$/).max(160);
const surface = z.object({ relation, path }).strict();
const binding = z.object({ projectRef: z.string().regex(/^[a-z]{20}$/), sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  catalogFingerprint: hash, classificationFingerprint: hash, contentFingerprint: hash, snapshotId: hash }).strict();
const preserved = z.enum(['preserve', 'roomBaseline', 'photoHold']);
const value = z.string().max(1024 * 1024).nullable();
const expectedSchema = z.object({ binding, registryFingerprint: hash,
  surfaces: z.array(surface).max(1000) }).strict();
const evidenceSchema = z.object({ binding, complete: z.boolean(),
  // Independent counts of PRESERVED rows, including zero, in the same snapshot.
  // Do not compute these counts from the observation array below.
  census: z.array(surface.extend({ count: z.number().int().min(0).max(10000) }).strict()).max(1000),
  observations: z.array(surface.extend({ rowToken: hash, disposition: preserved,
    variant: z.string().max(80).nullable(), before: value, retained: value,
    target: z.object({ relation, value: z.string().max(80),
      disposition: z.enum(['preserve', 'roomBaseline', 'photoHold', 'remove', 'unresolved']),
    }).strict().nullable(),
  }).strict()).max(10000),
}).strict();
const identity = (v: { relation: string; path: string }) => `${v.relation}:${v.path}`;
class InputError extends Error {}

// Bound strings, object traversal, arrays and depth before schema validation.
// Accessors, symbols, cycles and sparse/custom objects cannot execute here.
function boundedCopy(input: unknown) {
  let bytes = 8 * 1024 * 1024, nodes = 200000;
  const seen = new Set<object>();
  function copy(v: unknown, depth = 0): unknown {
    if (--nodes < 0 || depth > 12) throw new InputError('LOGICAL_REFERENCE_LIMIT_EXCEEDED');
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') {
      bytes -= Buffer.byteLength(v, 'utf8');
      if (bytes < 0) throw new InputError('LOGICAL_REFERENCE_LIMIT_EXCEEDED');
      return v;
    }
    if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
    if (!v || typeof v !== 'object' || seen.has(v)) throw new InputError('LOGICAL_REFERENCE_INPUT_INVALID');
    const array = Array.isArray(v);
    if (Object.getPrototypeOf(v) !== (array ? Array.prototype : Object.prototype)) throw new InputError('LOGICAL_REFERENCE_INPUT_INVALID');
    const descriptors = Object.getOwnPropertyDescriptors(v);
    const keys = Reflect.ownKeys(descriptors).filter(key => !(array && key === 'length'));
    if (keys.length > 10000 || keys.some(key => typeof key !== 'string')) throw new InputError('LOGICAL_REFERENCE_INPUT_INVALID');
    if (array && (keys.length !== v.length || keys.some((key, i) => key !== String(i)))) throw new InputError('LOGICAL_REFERENCE_INPUT_INVALID');
    seen.add(v);
    const entries = keys.map(key => {
      const d = descriptors[String(key)];
      if (!d || !('value' in d) || !d.enumerable || key === '__proto__') throw new InputError('LOGICAL_REFERENCE_INPUT_INVALID');
      bytes -= Buffer.byteLength(String(key), 'utf8') + 1;
      if (bytes < 0) throw new InputError('LOGICAL_REFERENCE_LIMIT_EXCEEDED');
      return [String(key), copy(d.value, depth + 1)] as const;
    });
    seen.delete(v);
    return array ? entries.map(([, entry]) => entry) : Object.fromEntries(entries);
  }
  return copy(input);
}
function validValue(rule: LogicalReferenceRule, input: string | null) {
  if (input === null) return rule.nullable;
  switch (rule.codec) {
    case 'uuid': return /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(input);
    case 'provider-id': return /^[A-Za-z0-9_-]{10,200}$/.test(input);
    case 'room-number': return /^[0-9]{3}$/.test(input);
    case 'folder-room': return input === '' || /^[0-9]{3}$/.test(input);
    case 'file-name': return input.length > 0 && input.length <= 512 &&
      ![...input].some(character => character.charCodeAt(0) < 32 || character === '/' || character === '\\');
    case 'json-object': {
      // Validate syntax/root only. Compare the lossless PG text unchanged below;
      // never reserialize JS numbers or claim legacy domain-shape readability.
      try { const parsed: unknown = JSON.parse(input); return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed); }
      catch { return false; }
    }
  }
}

/** Server-internal, source-bounded non-FK inspection. The expected surface list
 * must come from an independent reviewed catalog inventory, not HTTP input or
 * filtering that inventory down to this registry. Every unregistered surface
 * blocks, even if its census is zero. Rows/census/target resolution and preserved
 * candidate values must come from the same trusted content snapshot/plan.
 * This does not assert DB isolation, live provider existence, readable history,
 * complete template/FK coverage, retention permission, or execution authority.
 */
export function inspectResetLogicalReferences(expectedInput: unknown, observedInput: unknown) {
  const result = (blockers: string[], counts: { surfaces: number; rows: number; currentPointers: number; historicalSnapshots: number; externalLocators: number } | null) => ({
    logicalReferencesValid: blockers.length === 0, executionEnabled: false,
    coverageScope: 'registered-nontemplate-surfaces' as const,
    completeResetCoverage: false, externalObjectsVerified: false,
    registryFingerprint: RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT, blockers, counts,
  });
  try {
    const copied = boundedCopy({ expected: expectedInput, observed: observedInput }) as { expected: unknown; observed: unknown };
    const expectedResult = expectedSchema.safeParse(copied.expected), observedResult = evidenceSchema.safeParse(copied.observed);
    if (!expectedResult.success || !observedResult.success) return result(['LOGICAL_REFERENCE_INPUT_INVALID'], null);
    const expected = expectedResult.data, observed = observedResult.data;
    const blockers = new Set<string>();
    if (!observed.complete) blockers.add('LOGICAL_REFERENCE_INCOMPLETE');
    if (requestHash(expected.binding) !== requestHash(observed.binding)) blockers.add('LOGICAL_REFERENCE_SNAPSHOT_MISMATCH');
    if (expected.registryFingerprint !== RESET_LOGICAL_REFERENCE_REGISTRY_FINGERPRINT) blockers.add('LOGICAL_REFERENCE_REGISTRY_CHANGED');
    const surfaces = new Map(expected.surfaces.map(s => [identity(s), s]));
    if (surfaces.size !== expected.surfaces.length) blockers.add('LOGICAL_REFERENCE_DUPLICATE_SURFACE');
    for (const s of surfaces.values()) {
      if (!findResetLogicalReferenceRule(s.relation, s.path)) blockers.add('LOGICAL_REFERENCE_UNREGISTERED_SURFACE');
    }
    const census = new Map<string, number>();
    for (const c of observed.census) {
      const key = identity(c);
      if (census.has(key)) blockers.add('LOGICAL_REFERENCE_DUPLICATE_CENSUS');
      if (!surfaces.has(key)) blockers.add('LOGICAL_REFERENCE_UNKNOWN_CENSUS');
      census.set(key, c.count);
    }
    const seen = new Set<string>(), counted = new Map<string, number>();
    const counts = { surfaces: surfaces.size, rows: 0, currentPointers: 0, historicalSnapshots: 0, externalLocators: 0 };
    for (const row of observed.observations) {
      const key = identity(row), rowId = `${key}:${row.rowToken}`;
      if (seen.has(rowId)) blockers.add('LOGICAL_REFERENCE_DUPLICATE_ROW');
      seen.add(rowId);
      counted.set(key, (counted.get(key) ?? 0) + 1);
      if (!surfaces.has(key)) blockers.add('LOGICAL_REFERENCE_UNEXPECTED_SURFACE');
      const rule = findResetLogicalReferenceRule(row.relation, row.path);
      if (!rule) { blockers.add('LOGICAL_REFERENCE_UNREGISTERED_SURFACE'); continue; }
      if (!validValue(rule, row.before) || !validValue(rule, row.retained)) blockers.add('LOGICAL_REFERENCE_VALUE_INVALID');
      if (row.before !== row.retained) blockers.add('LOGICAL_REFERENCE_PRESERVED_VALUE_CHANGED');
      if (row.variant === null ? (rule.variants.length > 0 && row.before !== null) : !rule.variants.includes(row.variant)) {
        blockers.add('LOGICAL_REFERENCE_VARIANT_UNREGISTERED');
      }
      if (rule.variants.length && ((row.before === null) !== (row.variant === null))) {
        blockers.add('LOGICAL_REFERENCE_VARIANT_UNREGISTERED');
      }
      counts.rows++;
      if (rule.semantics === 'CURRENT_POINTER') {
        counts.currentPointers++;
        const target = row.target;
        if (!target || row.variant === null || target.relation !== rule.targets[row.variant] ||
            !row.before || target.value.toLowerCase() !== row.before.toLowerCase()) blockers.add('LOGICAL_REFERENCE_TARGET_UNRESOLVED');
        else if (target.disposition === 'remove') blockers.add('LOGICAL_REFERENCE_PRESERVED_TO_REMOVED');
        else if (target.disposition === 'unresolved') blockers.add('LOGICAL_REFERENCE_TARGET_UNRESOLVED');
      } else {
        // Historical snapshots and external locators carry no current DB target.
        // A caller cannot smuggle a lookup/rewrite or provider proof into them.
        if (row.target !== null) blockers.add('LOGICAL_REFERENCE_UNEXPECTED_TARGET');
        if (rule.semantics === 'HISTORICAL_SNAPSHOT') counts.historicalSnapshots++;
        else counts.externalLocators++;
      }
    }
    for (const key of surfaces.keys()) {
      if (!census.has(key)) blockers.add('LOGICAL_REFERENCE_MISSING_CENSUS');
      else if (census.get(key) !== (counted.get(key) ?? 0)) blockers.add('LOGICAL_REFERENCE_ROW_COUNT_MISMATCH');
    }
    return result([...blockers].sort(), blockers.size ? null : counts);
  } catch (error) {
    return result([error instanceof InputError ? error.message : 'LOGICAL_REFERENCE_SOURCE_UNAVAILABLE'], null);
  }
}
