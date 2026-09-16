#!/usr/bin/env node

import { openApiDocument } from '../supabase/functions/_shared/openapi.ts';

const document = structuredClone(openApiDocument);
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const operations = [];
for (const [path, pathItem] of Object.entries(document.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) operations.push({ path, method, operation, pathItem });
  }
}

const resolveRef = (value, seen = new Set()) => {
  if (!value?.$ref) return value;
  assert(!seen.has(value.$ref), `Circular OpenAPI reference while resolving ${value.$ref}.`);
  seen.add(value.$ref);
  const resolved = value.$ref.slice(2).split('/').reduce((current, key) => current?.[key], document);
  assert(resolved, `OpenAPI reference does not resolve: ${value.$ref}.`);
  return resolveRef(resolved, seen);
};

assert(document.openapi === '3.1.1', `Frontend generator requires OpenAPI 3.1.1, received ${document.openapi}.`);
assert(document.info.version === '0.2.0', `Unexpected source API version ${document.info.version}.`);
assert(Object.keys(document.paths).length === 109, 'Update the frontend contract snapshot and reviewed path inventory.');
assert(operations.length === 117, 'Update the frontend contract snapshot and reviewed operation inventory.');
const operationIds = operations.map(({ operation }) => operation.operationId);
assert(operationIds.every(Boolean), 'Every frontend-visible operation requires operationId.');
assert(new Set(operationIds).size === operationIds.length, 'Frontend-visible operationId values must be unique.');

const requiredAreas = {
  auth: /^\/v1\/auth\//,
  account: /^\/v1\/accounts(?:\/|$)/,
  room: /^\/v1\/rooms(?:\/|$)/,
  reservation: /^\/v1\/reservations(?:\/|$)/,
  availability: /^\/v1\/availability(?:\/|$)/,
  assignment: /^\/v1\/(?:assignments|assignment-change-requests|assignment-preview)(?:\/|$)/,
  attempt: /^\/v1\/(?:attempts|limited\/attempts)(?:\/|$)/,
  submission: /^\/v1\/attempts\/\{attemptId\}\/submissions$/,
  inspection: /^\/v1\/inspections(?:\/|$)/,
  payroll: /^\/v1\/payroll(?:\/|$)/,
  notification: /^\/v1\/(?:notifications|push-subscriptions)(?:\/|$)/,
  pin: /^\/v1\/(?:rooms\/.*pin|room-pin-sheet-sync)(?:\/|$)/,
};
for (const [area, pattern] of Object.entries(requiredAreas)) assert(operations.some(({ path }) => pattern.test(path)), `Frontend ${area} API area is missing.`);

const allowedWithoutIdempotency = new Set(['login', 'runDeveloperDiagnostics', 'syncOfflineCompletion', 'previewAssignments', 'markNotificationRead', 'revealRoomPin']);
for (const { operation, pathItem } of operations.filter(({ method }) => method !== 'get')) {
  const parameters = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])].map((parameter) => resolveRef(parameter));
  assert(
    allowedWithoutIdempotency.has(operation.operationId) || parameters.some((parameter) => parameter.name === 'Idempotency-Key' && parameter.in === 'header' && parameter.required === true),
    `${operation.operationId} is missing the frontend Idempotency-Key contract.`,
  );
}

const errorEnvelopeRef = '#/components/schemas/ErrorEnvelope';
for (const { path, method, operation } of operations) {
  for (const [status, response] of Object.entries(operation.responses ?? {})) {
    if (Number(status) < 400) continue;
    const responseRef = response.content?.['application/json']?.schema?.$ref;
    const previewConflict = operation.operationId === 'previewAssignments' && status === '409' && responseRef === '#/components/schemas/AssignmentPreviewUnconfirmed';
    assert(responseRef === errorEnvelopeRef || previewConflict, `${method.toUpperCase()} ${path} ${status} lost the stable error contract.`);
  }
}

const forbidden = ['serviceRoleKey', 'supabaseServiceRoleKey', 'pinPlaintext', 'pinHash', 'pinCiphertext', 'accessTokenHash', 'refreshTokenHash'];
const serializedSchemas = JSON.stringify(document.components?.schemas);
for (const property of forbidden) assert(!serializedSchemas.includes(`"${property}"`), `Sensitive property ${property} must not enter the frontend OpenAPI.`);

process.stdout.write(`Frontend OpenAPI source contract passed: ${Object.keys(document.paths).length} paths / ${operations.length} operations.\n`);
