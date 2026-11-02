/** Strict bounded data copying for source-side release evidence. Never invoke input getters. */
export function copyMigrationData(value, depth = 0, budget = { nodes: 0, bytes: 0 }) {
  if (++budget.nodes > 200_000 || depth > 16) throw new Error('MIGRATION_EVIDENCE_INVALID');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && value.isWellFormed() && !value.includes('\0')) {
    budget.bytes += Buffer.byteLength(value);
    if (budget.bytes > 4 * 1024 * 1024) throw new Error('MIGRATION_EVIDENCE_INVALID');
    return value;
  }
  const array = Array.isArray(value);
  if (!value || Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype)) throw new Error('MIGRATION_EVIDENCE_INVALID');
  const keys = Reflect.ownKeys(value);
  if (array && (value.length > 10_000 || keys.length !== value.length + 1)) throw new Error('MIGRATION_EVIDENCE_INVALID');
  const result = array ? [] : {};
  for (const key of keys) {
    if (array && key === 'length') continue;
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('MIGRATION_EVIDENCE_INVALID');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('MIGRATION_EVIDENCE_INVALID');
    result[key] = copyMigrationData(descriptor.value, depth + 1, budget);
  }
  return Object.freeze(result);
}
export function exactMigrationKeys(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== keys.length
    || keys.some(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value');
    })) throw new Error('MIGRATION_EVIDENCE_INVALID');
}
