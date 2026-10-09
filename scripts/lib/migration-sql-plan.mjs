/** #378 AST evidence only. No DB driver, credentials, SQL execution or approval. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';

export const SQL_PLAN_MODE = 'AST_SOURCE_ONLY';
export const SQL_PLAN_PACKAGE = '@pgsql/parser';
export const SQL_PLAN_PACKAGE_VERSION = '1.5.0';
export const SQL_PLAN_MAX_BYTES = 2 * 1024 * 1024;
export const SQL_PLAN_TIMEOUT_MS = 10_000;
const maxStatements = 10_000;
const maxAstNodes = 200_000;
const sourceKeys = ['projectRef', 'sourceRef', 'headSha1', 'treeSha1', 'manifestSha256', 'historySha256'];
const plans = new WeakMap();
const safeErrors = new WeakMap();
const sourceReviewKinds = new Set([
  'CreateSchemaStmt', 'GrantStmt', 'CreateEnumStmt', 'CreateFunctionStmt', 'CreateStmt',
  'ViewStmt', 'IndexStmt', 'CreateTrigStmt', 'InsertStmt', 'UpdateStmt', 'AlterTableStmt',
  'CreatePolicyStmt', 'AlterDefaultPrivilegesStmt', 'DropStmt', 'AlterEnumStmt',
  'CommentStmt', 'DoStmt', 'DeleteStmt', 'AlterObjectSchemaStmt', 'RenameStmt',
  'AlterFunctionStmt', 'SelectStmt', 'LockStmt', 'AlterOwnerStmt', 'CreateSeqStmt', 'AlterSeqStmt',
]);
const forbiddenKinds = new Set([
  'VacuumStmt', 'ReindexStmt', 'CreatedbStmt', 'DropdbStmt', 'AlterDatabaseStmt',
  'AlterDatabaseSetStmt', 'CreateTableSpaceStmt', 'DropTableSpaceStmt', 'AlterSystemStmt',
  'CopyStmt', 'CreateExtensionStmt', 'AlterExtensionStmt', 'AlterExtensionContentsStmt',
  'CreateFdwStmt', 'AlterFdwStmt', 'CreateForeignServerStmt', 'AlterForeignServerStmt',
  'ImportForeignSchemaStmt', 'CreateSubscriptionStmt', 'AlterSubscriptionStmt',
  'DropSubscriptionStmt', 'AlterRoleSetStmt', 'VariableSetStmt', 'CallStmt', 'TruncateStmt',
]);

function fail(code) {
  const error = new Error(code);
  safeErrors.set(error, code);
  throw error;
}
function safeCode(error) { return safeErrors.get(error) ?? 'SQL_PLAN_INPUT_INVALID'; }
function data(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('SQL_PLAN_INPUT_INVALID');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail('SQL_PLAN_INPUT_INVALID');
  const properties = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(properties).length !== keys.length) fail('SQL_PLAN_INPUT_INVALID');
  const copy = {};
  for (const key of keys) {
    const descriptor = properties[key];
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail('SQL_PLAN_INPUT_INVALID');
    copy[key] = descriptor.value;
  }
  return copy;
}
function hash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function validHash(value, length = 64) {
  if (typeof value !== 'string' || !(length === 64 ? /^[a-f0-9]{64}$/u : /^[a-f0-9]{40}$/u).test(value)) fail('SQL_PLAN_BINDING_INVALID');
  return value;
}
function source(value) {
  const copy = data(value, sourceKeys);
  if (typeof copy.projectRef !== 'string' || !/^[a-z]{20}$/u.test(copy.projectRef)
    || typeof copy.sourceRef !== 'string' || !/^refs\/heads\/(?:main|release\/v\d+\.\d+\.\d+)$/u.test(copy.sourceRef)) fail('SQL_PLAN_BINDING_INVALID');
  for (const key of ['headSha1', 'treeSha1']) validHash(copy[key], 40);
  for (const key of ['manifestSha256', 'historySha256']) validHash(copy[key]);
  return Object.freeze(copy);
}
function equalSource(left, right) { return sourceKeys.every((key) => left[key] === right[key]); }
function bytes(value) {
  if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype && !Buffer.isBuffer(value)) fail('SQL_PLAN_INPUT_INVALID');
  if (value.byteLength < 1 || value.byteLength > SQL_PLAN_MAX_BYTES) fail('SQL_PLAN_SIZE_INVALID');
  const copy = Buffer.from(value);
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(copy); }
  catch { fail('SQL_PLAN_ENCODING_INVALID'); }
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(copy)) fail('SQL_PLAN_ENCODING_INVALID');
  return copy;
}
function boundary(raw, offset) {
  return Number.isSafeInteger(offset) && offset >= 0 && offset <= raw.length
    && (offset === raw.length || (raw[offset] & 0xc0) !== 0x80);
}
function astInventory(node, declarationSettings) {
  const stack = [node];
  let count = 0;
  while (stack.length) {
    const value = stack.pop();
    if (value === null || typeof value !== 'object') continue;
    if (++count > maxAstNodes) fail('SQL_PLAN_AST_LIMIT');
    for (const [key, child] of Object.entries(value)) {
      const declarationSetting = key === 'VariableSetStmt' && declarationSettings.has(value);
      if ((!declarationSetting && forbiddenKinds.has(key)) || key === 'TransactionStmt') fail('SQL_PLAN_NESTED_UNSAFE');
      if (child !== null && typeof child === 'object') stack.push(child);
    }
  }
}

/** Untrusted/mock AST codec only: never a parser-owned plan or execution proof. */
export function inspectMigrationSqlAst(sqlBytes, parsed, parserMajor) {
  try { return analyze(bytes(sqlBytes), parsed, parserMajor); }
  catch (error) { throw new Error(safeCode(error)); }
}
function analyze(raw, parsed, parserMajor) {
  if (![15, 17].includes(parserMajor) || parsed === null || typeof parsed !== 'object'
    || !Number.isSafeInteger(parsed.version) || Math.trunc(parsed.version / 10_000) !== parserMajor
    || !Array.isArray(parsed.stmts) || parsed.stmts.length < 1 || parsed.stmts.length > maxStatements) fail('SQL_PLAN_AST_INVALID');
  const statements = [];
  let previousEnd = 0;
  for (const [index, entry] of parsed.stmts.entries()) {
    if (!entry || typeof entry !== 'object' || !entry.stmt || typeof entry.stmt !== 'object') fail('SQL_PLAN_AST_INVALID');
    const kinds = Object.keys(entry.stmt);
    if (kinds.length !== 1) fail('SQL_PLAN_AST_INVALID');
    const kind = kinds[0];
    const node = entry.stmt[kind];
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail('SQL_PLAN_AST_INVALID');
    const startByte = entry.stmt_location ?? 0;
    const stmtLength = entry.stmt_len ?? 0;
    if (!boundary(raw, startByte) || !Number.isSafeInteger(stmtLength) || stmtLength < 0
      || (stmtLength === 0 && index !== parsed.stmts.length - 1)) fail('SQL_PLAN_POSITION_INVALID');
    const endByte = stmtLength === 0 ? raw.length : startByte + stmtLength;
    if (!boundary(raw, endByte) || endByte <= startByte || startByte < previousEnd
      || (stmtLength > 0 && raw[endByte] !== 59)) fail('SQL_PLAN_POSITION_INVALID');
    if (kind === 'TransactionStmt') {
      const allowedKeys = parserMajor === 17 ? ['kind', 'location'] : ['kind'];
      if (Object.keys(node).some((key) => !allowedKeys.includes(key))
        || (Object.hasOwn(node, 'location') && node.location !== -1)
        || !['TRANS_STMT_BEGIN', 'TRANS_STMT_COMMIT'].includes(node.kind)) fail('SQL_PLAN_TRANSACTION_DISALLOWED');
    } else {
      if (forbiddenKinds.has(kind)) fail('SQL_PLAN_STATEMENT_DISALLOWED');
      if (!sourceReviewKinds.has(kind)) fail('SQL_PLAN_UNKNOWN_AST');
      if ((kind === 'IndexStmt' || kind === 'DropStmt') && node.concurrent) fail('SQL_PLAN_TRANSACTION_OUTSIDE');
      if (kind === 'DropStmt' && ['OBJECT_EXTENSION', 'OBJECT_FOREIGN_SERVER', 'OBJECT_FDW', 'OBJECT_SUBSCRIPTION'].includes(node.removeType)) fail('SQL_PLAN_STATEMENT_DISALLOWED');
      if (kind === 'CreateFunctionStmt') {
        const languages = (node.options ?? []).filter((option) => option.DefElem?.defname === 'language');
        if (languages.length !== 1 || !['sql', 'plpgsql'].includes(languages[0].DefElem?.arg?.String?.sval)) fail('SQL_PLAN_EXTERNAL_LANGUAGE');
      }
      if (kind === 'DoStmt') {
        const languages = (node.args ?? []).filter((option) => option.DefElem?.defname === 'language');
        if (languages.length > 1 || languages.length === 1 && languages[0].DefElem?.arg?.String?.sval !== 'plpgsql') fail('SQL_PLAN_EXTERNAL_LANGUAGE');
      }
      const declarationSettings = new WeakSet();
      if (kind === 'CreateFunctionStmt' || kind === 'AlterFunctionStmt') {
        // SET search_path inside a function declaration is not a top-level SET.
        // This exception is positional and still requires source/body review.
        for (const option of node.options ?? node.actions ?? []) {
          const argument = option.DefElem?.arg;
          if (option.DefElem?.defname === 'set' && argument?.VariableSetStmt?.name === 'search_path'
            && argument.VariableSetStmt.kind === 'VAR_SET_VALUE') declarationSettings.add(argument);
        }
      }
      astInventory(node, declarationSettings);
    }
    statements.push(Object.freeze({ index, astKind: kind, startByte, endByte,
      sha256: hash(raw.subarray(startByte, endByte)), transactionKind: kind === 'TransactionStmt' ? node.kind : null,
      requiresBodyReview: kind === 'DoStmt' || kind === 'CreateFunctionStmt', sourceReviewRequired: true }));
    previousEnd = endByte;
  }
  const transactions = statements.filter((item) => item.transactionKind !== null);
  if (transactions.length && (transactions.length !== 2 || statements.length <= 2
    || statements[0].transactionKind !== 'TRANS_STMT_BEGIN'
    || statements.at(-1).transactionKind !== 'TRANS_STMT_COMMIT')) fail('SQL_PLAN_TRANSACTION_DISALLOWED');
  return Object.freeze({ mode: SQL_PLAN_MODE, executionAllowed: false, parserEvidenceVerified: false,
    parserMajor, astVersion: parsed.version, statements: Object.freeze(statements) });
}
function approval(value, expectedSource) {
  if (value === null) return null;
  const copy = data(value, ['modelSource', 'sqlSha256', 'begin', 'commit']);
  if (!equalSource(source(copy.modelSource), expectedSource)) fail('SQL_PLAN_WRAPPER_BINDING_MISMATCH');
  validHash(copy.sqlSha256);
  for (const key of ['begin', 'commit']) {
    copy[key] = Object.freeze(data(copy[key], ['startByte', 'endByte', 'sha256']));
    validHash(copy[key].sha256);
    if (!Number.isSafeInteger(copy[key].startByte) || !Number.isSafeInteger(copy[key].endByte)
      || copy[key].startByte < 0 || copy[key].endByte <= copy[key].startByte) fail('SQL_PLAN_WRAPPER_BINDING_MISMATCH');
  }
  return copy;
}
function bindWrapper(statements, wrapper, sqlSha256) {
  const transactions = statements.filter((item) => item.transactionKind !== null);
  if (transactions.length === 0) {
    if (wrapper !== null) fail('SQL_PLAN_WRAPPER_UNEXPECTED');
    return null;
  }
  if (!wrapper || wrapper.sqlSha256 !== sqlSha256) fail('SQL_PLAN_WRAPPER_APPROVAL_REQUIRED');
  for (const [key, statement] of [['begin', transactions[0]], ['commit', transactions[1]]]) {
    if (!['startByte', 'endByte', 'sha256'].every((field) => wrapper[key][field] === statement[field])) fail('SQL_PLAN_WRAPPER_BINDING_MISMATCH');
  }
  return Object.freeze({ begin: transactions[0], commit: transactions[1], sourceReviewRequired: true });
}

async function boundedParse(raw, parserMajor) {
  const deadline = performance.now() + SQL_PLAN_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    let worker;
    let timer;
    let settled = false;
    const finish = (code, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (worker) void worker.terminate().catch(() => {});
      if (code) { const error = new Error(code); safeErrors.set(error, code); reject(error); }
      else resolve(result);
    };
    try {
      worker = new Worker(new URL(import.meta.url), { workerData: { task: 'MIGRATION_SQL_AST_PRIVATE', raw, parserMajor },
        stdout: true, stderr: true, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 } });
      // Drain private output without forwarding SQL/native errors to console/logs.
      worker.stdout.resume(); worker.stderr.resume();
      timer = setTimeout(() => finish('SQL_PLAN_PARSE_TIMEOUT'), SQL_PLAN_TIMEOUT_MS);
      worker.once('error', () => finish('SQL_PLAN_PARSER_FAILED'));
      worker.once('exit', () => finish('SQL_PLAN_PARSER_FAILED'));
      worker.once('message', (message) => {
        if (performance.now() >= deadline) return finish('SQL_PLAN_PARSE_TIMEOUT');
        if (message?.status !== 'OK') return finish(typeof message?.code === 'string' && /^SQL_PLAN_[A-Z_]+$/u.test(message.code) ? message.code : 'SQL_PLAN_PARSER_FAILED');
        finish(null, message.result);
      });
    } catch { finish('SQL_PLAN_PARSER_FAILED'); }
  });
}

/** Source-only pinned parser evidence. Caller claims do not authenticate Git/DB/approval. */
export async function createMigrationSqlPlan(input) {
  try {
    const value = data(input, ['sqlBytes', 'parserMajor', 'expectedSource', 'observedSource', 'expectedSqlSha256', 'wrapperApproval']);
    const original = bytes(value.sqlBytes);
    if (![15, 17].includes(value.parserMajor)) fail('SQL_PLAN_VERSION_UNSUPPORTED');
    const expectedSource = source(value.expectedSource);
    if (!equalSource(expectedSource, source(value.observedSource))) fail('SQL_PLAN_SOURCE_MISMATCH');
    const sqlSha256 = hash(original);
    if (sqlSha256 !== validHash(value.expectedSqlSha256)) fail('SQL_PLAN_SQL_HASH_MISMATCH');
    const wrapperApproval = approval(value.wrapperApproval, expectedSource);
    const result = await boundedParse(original, value.parserMajor);
    const statements = Object.freeze(result.statements.map((item) => Object.freeze(item)));
    const wrapper = bindWrapper(statements, wrapperApproval, sqlSha256);
    const body = statements.filter((item) => item.transactionKind === null);
    const statementSha256s = Object.freeze(body.map((item) => item.sha256));
    const plan = Object.freeze({ mode: SQL_PLAN_MODE, executionAllowed: false,
      parserEvidenceVerified: true, sourceEvidenceVerified: false, sourceReviewRequired: true,
      parserPackage: SQL_PLAN_PACKAGE, parserPackageVersion: SQL_PLAN_PACKAGE_VERSION,
      parserMajor: result.parserMajor, astVersion: result.astVersion, modelSource: expectedSource,
      sqlSha256, byteLength: original.length, statements, wrapper,
      statementSha256s, statementsSha256: hash(JSON.stringify({ format: 'exact-byte-statements-v1', statementSha256s })) });
    // Only a parser-owned handle retains original bytes. No public SQL accessor.
    plans.set(plan, original);
    return plan;
  } catch (error) { throw new Error(safeCode(error)); }
}

if (!isMainThread && workerData?.task === 'MIGRATION_SQL_AST_PRIVATE') {
  try {
    const require = createRequire(import.meta.url);
    const entry = require.resolve(SQL_PLAN_PACKAGE);
    if (JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')).version !== SQL_PLAN_PACKAGE_VERSION) fail('SQL_PLAN_PACKAGE_MISMATCH');
    const { Parser } = require(SQL_PLAN_PACKAGE);
    const parser = new Parser({ version: workerData.parserMajor });
    const raw = bytes(workerData.raw);
    const parsed = await parser.parse(raw.toString('utf8'));
    const result = analyze(raw, parsed, workerData.parserMajor);
    // Parser must account for every byte: omitted separators/comments parse empty,
    // and each exact slice must independently parse as exactly the same one AST kind.
    let previousEnd = 0;
    for (const statement of result.statements) {
      const gap = raw.subarray(previousEnd, statement.startByte).toString('utf8');
      if (gap && (await parser.parse(gap)).stmts.length !== 0) fail('SQL_PLAN_COVERAGE_INVALID');
      const slice = await parser.parse(raw.subarray(statement.startByte, statement.endByte).toString('utf8'));
      if (slice.stmts.length !== 1 || Object.keys(slice.stmts[0].stmt)[0] !== statement.astKind) fail('SQL_PLAN_COVERAGE_INVALID');
      previousEnd = statement.endByte;
    }
    const tail = raw.subarray(previousEnd).toString('utf8');
    if (tail && (await parser.parse(tail)).stmts.length !== 0) fail('SQL_PLAN_COVERAGE_INVALID');
    parentPort.postMessage({ status: 'OK', result });
  } catch (error) {
    parentPort.postMessage({ status: 'FAIL', code: safeErrors.get(error) ?? 'SQL_PLAN_PARSER_FAILED' });
  }
}
