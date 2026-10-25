import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function admissionRouteRows(routes) {
  if (!Array.isArray(routes) || !routes.length) throw new Error('ADMISSION_MANIFEST_INVALID');
  const seen = new Set();
  const literal = value => value === null ? 'null' : `'${value.replaceAll("'", "''")}'`;
  return routes.flatMap(route => {
    if (!route || !/^[A-Za-z][A-Za-z0-9_]+$/.test(route.routeId) || seen.has(route.routeId)
      || !['ACTIVE_SESSION', 'LIMITED_SESSION', 'LOGIN'].includes(route.authority)
      || !['BUSINESS_WRITE', 'AUTH_WRITE'].includes(route.kind)
      || !['CALLER', 'SQL_AVAILABILITY', 'NONE', 'READ_ONLY', 'ATOMIC_RPC'].includes(route.hashMode)
      || (route.authority === 'LOGIN') !== (route.routeId === 'AUTH_LOGIN')
      || !['p_idempotency_key', 'p_idempotency_key_digest'].includes(route.keyArgument)) {
      throw new Error('ADMISSION_MANIFEST_INVALID');
    }
    seen.add(route.routeId);
    // The append137 adapter reuses the fixed source130 opaque route in the same
    // transaction. This tag must never regenerate a different historical SQL.
    if (route.completionAdapter !== undefined && (route.completionAdapter !== 'LIFECYCLE_V137'
      || route.routeId !== 'manageAttemptLifecycle' || route.hashMode !== 'NONE'
      || route.rpc !== null || route.commandName !== null || route.kind !== 'BUSINESS_WRITE'
      || route.authority !== 'ACTIVE_SESSION' || route.keyArgument !== 'p_idempotency_key')) {
      throw new Error('ADMISSION_MANIFEST_INVALID');
    }
    if (route.hashMode === 'ATOMIC_RPC') {
      if (route.routeId !== 'markNotificationRead' || route.rpc !== 'mark_notification_read'
        || route.commandName !== null || route.authority !== 'ACTIVE_SESSION') {
        throw new Error('ADMISSION_MANIFEST_INVALID');
      }
      return [];
    }
    const receipt = ['CALLER', 'SQL_AVAILABILITY'].includes(route.hashMode);
    if (receipt ? !/^[a-z][a-z0-9_.]+$/.test(route.commandName ?? '') || !route.rpc
      : route.commandName !== null || route.rpc !== null) throw new Error('ADMISSION_MANIFEST_INVALID');
    if (route.hashMode === 'SQL_AVAILABILITY'
      && !['submitAvailability', 'requestAvailabilityChange', 'decideAvailabilityChange'].includes(route.routeId)) {
      throw new Error('ADMISSION_MANIFEST_INVALID');
    }
    if (route.hashMode === 'READ_ONLY') return [];
    return [`    (${[route.routeId, route.kind, route.authority, route.hashMode,
      route.commandName, route.keyArgument].map(literal).join(', ')})`];
  }).join(',\n');
}

export function generateAdmissionSql(routes, template) {
  if (template.split('@@HTTP_ROUTES@@').length !== 2) throw new Error('ADMISSION_TEMPLATE_INVALID');
  return template.replaceAll('\r\n', '\n').replace('@@HTTP_ROUTES@@', admissionRouteRows(routes));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const routes = JSON.parse(readFileSync('src/modules/developer-reset/http-admission-routes.json', 'utf8'));
  const output = generateAdmissionSql(routes, readFileSync('scripts/operation-admission.sql.in', 'utf8'));
  const target = 'supabase/migrations/20261025032719_operation_admission_authority.sql';
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8').replaceAll('\r\n', '\n') !== output) throw new Error('ADMISSION_SQL_SOURCE_DRIFT');
  } else writeFileSync(target, output);
}
