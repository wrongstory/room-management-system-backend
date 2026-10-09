/** #378 bounded decoded history/source models. No DB, wire codec or SQL accessor. */
import { createHash } from 'node:crypto';
import { isOwnedMigrationSourceBundle } from './migration-source-bundle.mjs';

export const HISTORY_CODEC_CLI_VERSION = '2.115.0';
export const HISTORY_CODEC_CLI_COMMIT = '18ae43a34a2257458197b62f74e2a97e2b5cf7f9';
export const HISTORY_CODEC_MAX_SQL_BYTES = 2 * 1024 * 1024;
export const HISTORY_CODEC_MAX_ROWS = 512;
export const HISTORY_CODEC_MAX_STATEMENTS = 10_000;
export const HISTORY_CODEC_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const maxDepth = 64;
const models = new WeakMap();
const snapshots = new WeakMap();
const errors = new WeakMap();
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const typedArrayOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const flags = Object.freeze({ executionAllowed: false, operationalApproval: false,
  DBHistoryVerified: false, fullStateVerified: false, cliParityVerified: false });
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const digest = (format, value) => sha256(JSON.stringify({ format, value }));

function fail(code) { const error = new Error(code); errors.set(error, code); throw error; }
function guarded(action) {
  try { return action(); }
  catch (error) { throw new Error(errors.get(error) ?? 'HISTORY_CODEC_INPUT_INVALID'); }
}
function data(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).length !== keys.length) fail('HISTORY_CODEC_INPUT_INVALID');
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('HISTORY_CODEC_INPUT_INVALID');
    result[key] = descriptor.value;
  }
  return result;
}
function list(value, limit) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
    || value.length > limit || Reflect.ownKeys(value).length !== value.length + 1) fail('HISTORY_CODEC_INPUT_INVALID');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('HISTORY_CODEC_INPUT_INVALID');
    return descriptor.value;
  });
}
function string(value, maximum) {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')
    || !value.isWellFormed() || Buffer.byteLength(value, 'utf8') > maximum) fail('HISTORY_CODEC_TEXT_INVALID');
  return value;
}
function version(value) {
  if (typeof value !== 'string' || !/^\d{14}$/u.test(value)) fail('HISTORY_CODEC_VERSION_INVALID');
  return value;
}
function inputBytes(value) {
  if (!(value instanceof Uint8Array) || !Buffer.isBuffer(value) && Object.getPrototypeOf(value) !== Uint8Array.prototype) fail('HISTORY_CODEC_BYTES_INVALID');
  // Read actual typed-array slots, not caller-overridable length/buffer getters.
  const length = typedArrayLength.call(value);
  if (length > HISTORY_CODEC_MAX_SQL_BYTES) fail('HISTORY_CODEC_BYTES_INVALID');
  const raw = Buffer.from(new Uint8Array(typedArrayBuffer.call(value), typedArrayOffset.call(value), length));
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); }
  catch { fail('HISTORY_CODEC_ENCODING_INVALID'); }
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(raw)) fail('HISTORY_CODEC_ENCODING_INVALID');
  // These file-level execution semantics are deliberately not implemented here.
  if (text.includes('\ufeff') || /--\s*pg-delta\s*:/iu.test(text)) fail('HISTORY_CODEC_FILE_DIRECTIVE_UNSUPPORTED');
  if (/\r(?!\n)/u.test(text)) fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
  return { raw, text };
}
const identifierRune = (character) => /[\p{L}\p{Nd}_$]/u.test(character);
const tagRune = (character) => /[\p{L}\p{Nd}_]/u.test(character);

/** Independent conservative lexer: no upstream FSM/classes/source are embedded. */
function logicalStatements(text) {
  const result = [];
  let start = 0;
  let position = 0;
  let parentheses = 0;
  const emit = (end) => {
    // The pinned CLI removes trailing separators BEFORE trimming whitespace.
    const token = text.slice(start, end).replace(/;+$/u, '').trim();
    if (token.length > 0) {
      if (result.length >= HISTORY_CODEC_MAX_STATEMENTS) fail('HISTORY_CODEC_STATEMENT_LIMIT');
      result.push(token);
    }
    start = end;
  };
  while (position < text.length) {
    const character = String.fromCodePoint(text.codePointAt(position));
    if (text.startsWith('--', position)) {
      const newline = text.indexOf('\n', position + 2);
      position = newline < 0 ? text.length : newline + 1;
    } else if (text.startsWith('/*', position)) {
      let depth = 1;
      position += 2;
      while (depth > 0) {
        if (position >= text.length) fail('HISTORY_CODEC_SCANNER_UNTERMINATED');
        if (text.startsWith('/*', position)) { if (++depth > maxDepth) fail('HISTORY_CODEC_DEPTH_LIMIT'); position += 2; }
        else if (text.startsWith('*/', position)) { depth--; position += 2; }
        else position++;
      }
    } else if (character === "'" || character === '"') {
      const quote = character;
      // E-prefixed strings have escape semantics outside this conservative slice,
      // even when this particular literal happens not to contain a backslash.
      if (quote === "'" && /e/iu.test(text[position - 1] ?? '')) fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
      position++;
      let closed = false;
      while (position < text.length) {
        if (text[position] === '\\') fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
        if (text[position] === quote) {
          if (text[position + 1] === quote) { position += 2; continue; }
          position++; closed = true; break;
        }
        position++;
      }
      if (!closed) fail('HISTORY_CODEC_SCANNER_UNTERMINATED');
    } else if (character === '$') {
      // Parameter syntax and dollar-containing identifiers are not guessed.
      const previousUnit = text.charCodeAt(position - 1);
      const previousPosition = position - (previousUnit >= 0xdc00 && previousUnit <= 0xdfff ? 2 : 1);
      if (position > 0 && identifierRune(String.fromCodePoint(text.codePointAt(previousPosition)))) fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
      let end = position + 1;
      while (end < text.length && text[end] !== '$') {
        const rune = String.fromCodePoint(text.codePointAt(end));
        if (!tagRune(rune) || end - position > 128) fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
        if (end === position + 1 && /\p{Nd}/u.test(rune)) fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
        end += rune.length;
      }
      if (end >= text.length) fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
      const delimiter = text.slice(position, end + 1);
      const closing = text.indexOf(delimiter, end + 1);
      if (closing < 0) fail('HISTORY_CODEC_SCANNER_UNTERMINATED');
      position = closing + delimiter.length;
    } else if (character === '\\') {
      fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
    } else if (character === '(') {
      if (++parentheses > maxDepth) fail('HISTORY_CODEC_DEPTH_LIMIT');
      position++;
    } else if (character === ')') {
      if (parentheses === 0) fail('HISTORY_CODEC_SCANNER_AMBIGUOUS');
      parentheses--; position++;
    } else if (character === ';') {
      position++;
      if (parentheses === 0) emit(position);
    } else if (tagRune(character)) {
      const begin = position;
      do { position += String.fromCodePoint(text.codePointAt(position)).length; }
      while (position < text.length && tagRune(String.fromCodePoint(text.codePointAt(position))));
      // Unquoted ATOMIC is outside this slice, including BEGIN ATOMIC bodies.
      if (text.slice(begin, position).toUpperCase() === 'ATOMIC') fail('HISTORY_CODEC_SCANNER_UNSUPPORTED');
    } else {
      position += character.length;
    }
  }
  if (parentheses !== 0) fail('HISTORY_CODEC_SCANNER_UNTERMINATED');
  if (start < text.length) emit(text.length);
  return Object.freeze(result);
}
function textArray(value, budget) {
  if (value === null) return null;
  const decoded = data(value, ['dimensions', 'values']);
  const dimensions = list(decoded.dimensions, 1).map((entry) => {
    const dimension = data(entry, ['length', 'lowerBound']);
    if (!Number.isSafeInteger(dimension.length) || dimension.length < 1 || dimension.length > HISTORY_CODEC_MAX_STATEMENTS
      || !Number.isSafeInteger(dimension.lowerBound) || dimension.lowerBound < -2147483648
      || dimension.lowerBound > 2147483647 || dimension.lowerBound + dimension.length - 1 > 2147483647) fail('HISTORY_CODEC_ARRAY_SHAPE_INVALID');
    return Object.freeze(dimension);
  });
  const values = list(decoded.values, HISTORY_CODEC_MAX_STATEMENTS).map((item) => {
    if (item === null) return null;
    const text = string(item, HISTORY_CODEC_MAX_SQL_BYTES);
    budget.bytes += Buffer.byteLength(text, 'utf8');
    if (budget.bytes > HISTORY_CODEC_MAX_TOTAL_BYTES) fail('HISTORY_CODEC_SIZE_LIMIT');
    return text;
  });
  if (values.length !== (dimensions[0]?.length ?? 0)) fail('HISTORY_CODEC_ARRAY_SHAPE_INVALID');
  return Object.freeze({ dimensions: Object.freeze(dimensions), values: Object.freeze(values) });
}
function row(value, budget) {
  const result = data(value, ['version', 'name', 'statements']);
  result.version = version(result.version);
  if (result.name !== null) result.name = string(result.name, 256);
  result.statements = textArray(result.statements, budget);
  return Object.freeze(result);
}
function expectedArray(values) {
  return Object.freeze({ dimensions: Object.freeze(values.length ? [Object.freeze({ length: values.length, lowerBound: 1 })] : []), values });
}
function sourceBinding(value, raw, expectedVersion, expectedName) {
  if (value === null) return null;
  const binding = data(value, ['bundle', 'path']);
  if (!isOwnedMigrationSourceBundle(binding.bundle)) fail('HISTORY_CODEC_SOURCE_NOT_OWNED');
  if (typeof binding.path !== 'string') fail('HISTORY_CODEC_SOURCE_MISMATCH');
  const file = binding.bundle.files.find((candidate) => candidate.path === binding.path);
  if (!file?.plan || file.version !== expectedVersion || file.name !== expectedName
    || file.plan.sqlSha256 !== sha256(raw) || file.plan.byteLength !== raw.length) fail('HISTORY_CODEC_SOURCE_MISMATCH');
  return Object.freeze({ bundleSha256: binding.bundle.bundleSha256, path: binding.path,
    planSqlSha256: file.plan.sqlSha256, planStatementsSha256: file.plan.statementsSha256 });
}
function snapshot(rows, provenance) {
  const frozen = Object.freeze(rows);
  const serialized = JSON.stringify({ format: 'decoded-pg-history-snapshot-v1', value: frozen });
  const result = Object.freeze({ ...flags, mode: 'DECODED_HISTORY_SOURCE_MODEL', provenance,
    rowCount: rows.length, historySha256: sha256(serialized),
    rows: Object.freeze(rows.map((item) => Object.freeze({ version: item.version, name: item.name,
      statementsIsNull: item.statements === null, statementCount: item.statements?.values.length ?? null,
      rowSha256: digest('decoded-pg-history-row-v1', item) }))) });
  snapshots.set(result, { rows: frozen, serialized });
  return result;
}

/** Identity only; this handle is never a DB proof or execution capability. */
export function isOwnedMigrationHistoryModel(value) { return models.has(value); }

/** Raw source input -> private ordered CLI logical tokens, including wrappers. */
export function createMigrationHistoryModel(input) {
  return guarded(() => {
    const value = data(input, ['version', 'name', 'sqlBytes', 'sourceBinding']);
    const expectedVersion = version(value.version);
    const expectedName = string(value.name, 256);
    const { raw, text } = inputBytes(value.sqlBytes);
    const binding = sourceBinding(value.sourceBinding, raw, expectedVersion, expectedName);
    const statements = logicalStatements(text);
    const expectedRow = Object.freeze({ version: expectedVersion, name: expectedName, statements: expectedArray(statements) });
    const result = Object.freeze({ ...flags, mode: 'CLI_HISTORY_SOURCE_MODEL',
      provenance: binding ? 'OWNED_LOCAL_SOURCE_BOUND_MODEL' : 'UNTRUSTED_INPUT_MODEL',
      cliVersion: HISTORY_CODEC_CLI_VERSION, cliSourceCommit: HISTORY_CODEC_CLI_COMMIT,
      parserEvidenceBound: binding !== null, sourceReviewRequired: true, version: expectedVersion, name: expectedName,
      sqlSha256: sha256(raw), byteLength: raw.length, logicalStatementCount: statements.length,
      historyStatementsSha256: digest('cli-history-logical-statements-v1', statements),
      rowSha256: digest('decoded-pg-history-row-v1', expectedRow), sourceBinding: binding });
    models.set(result, expectedRow);
    return result;
  });
}

/** Only already-decoded values + independently collected PG dimensions. No coerce/coalesce. */
export function createDecodedMigrationHistorySnapshot(input) {
  return guarded(() => {
    const value = data(input, ['expectedVersions', 'rows']);
    const versions = list(value.expectedVersions, HISTORY_CODEC_MAX_ROWS).map(version);
    for (let index = 1; index < versions.length; index++) if (versions[index] <= versions[index - 1]) fail('HISTORY_CODEC_VERSION_ORDER_INVALID');
    const budget = { bytes: 0 };
    const rows = list(value.rows, HISTORY_CODEC_MAX_ROWS).map((item) => row(item, budget));
    if (rows.length !== versions.length || rows.some((item, index) => item.version !== versions[index])) fail('HISTORY_CODEC_ROW_SET_MISMATCH');
    return snapshot(rows, 'UNTRUSTED_DECODED_ROW_MODEL');
  });
}

/** Build expected rows from owned models without exposing their statement strings. */
export function createExpectedMigrationHistorySnapshot(input) {
  return guarded(() => {
    const value = data(input, ['models']);
    const handles = list(value.models, HISTORY_CODEC_MAX_ROWS);
    const rows = handles.map((handle) => {
      if (!models.has(handle)) fail('HISTORY_CODEC_MODEL_NOT_OWNED');
      return models.get(handle);
    });
    for (let index = 1; index < rows.length; index++) if (rows[index].version <= rows[index - 1].version) fail('HISTORY_CODEC_VERSION_ORDER_INVALID');
    const budget = { bytes: 0 };
    for (const item of rows) textArray(item.statements, budget);
    return snapshot(rows, handles.every((handle) => handle.parserEvidenceBound) && handles.length > 0
      ? 'OWNED_LOCAL_SOURCE_BOUND_MODEL' : 'UNTRUSTED_INPUT_MODEL');
  });
}

/** Exact decoded model equality only, never history execution/application evidence. */
export function compareMigrationHistorySnapshots(input) {
  return guarded(() => {
    const value = data(input, ['expected', 'observed']);
    if (!snapshots.has(value.expected) || !snapshots.has(value.observed)) fail('HISTORY_CODEC_SNAPSHOT_NOT_OWNED');
    return Object.freeze({ ...flags, mode: 'DECODED_HISTORY_MODEL_COMPARISON',
      matches: snapshots.get(value.expected).serialized === snapshots.get(value.observed).serialized,
      expectedHistorySha256: value.expected.historySha256, observedHistorySha256: value.observed.historySha256,
      observedHistoryIsCallerClaim: true });
  });
}
