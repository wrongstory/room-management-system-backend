import { createHash } from 'node:crypto';
import { RESET_RELATION_GROUPS, RESET_RELATION_NAMES } from './reset-relation-classification.mjs';
import { RESET_REVIEW_REQUIREMENTS } from './reset-review-requirements.mjs';

// Read-only candidate labels, never a DELETE/UPDATE predicate or execution allowlist.
// The source inventory is explicit. New relations receive no inherited policy.
const rules = new Map();
const add = (names, kind) => names.forEach(name => {
  if (rules.has(name)) throw new Error('RESET_ROW_RULE_DUPLICATE');
  rules.set(name, { relation: name, kind });
});
add(RESET_RELATION_GROUPS.preserve, 'preserve');
add(RESET_RELATION_GROUPS.reseed, 'templateSource');
add(RESET_RELATION_GROUPS.clear.filter(name => name !== 'public.submission_photos'), 'resetCandidate');
add(['public.submission_photos'], 'photoHold');
for (const group of RESET_REVIEW_REQUIREMENTS) {
  if (group.code === 'ACCOUNT_SECURITY' || group.code === 'ROOM_AND_RESERVATION') continue;
  add(group.relations, group.code === 'PHOTO_AND_EVIDENCE' ? 'photoHold' : 'resetCandidate');
}
add(['public.rooms'], 'roomBaseline');
add(RESET_REVIEW_REQUIREMENTS.find(group => group.code === 'ROOM_AND_RESERVATION').relations
  .filter(name => name !== 'public.rooms'), 'resetCandidate');
add(['private.actor_activity_aggregates', 'private.login_rate_limit_windows'], 'preserve');
add(['public.profiles'], 'profileRole');
add(['public.login_aliases'], 'profileLink');
add(['private.auth_password_versions'], 'authLink');
add(['private.password_change_commands', 'private.password_reset_auth_markers',
  'private.password_verification_rate_limits', 'private.developer_catalog_previews',
  'private.developer_diagnostic_rate_limits', 'private.actor_activity_events',
  'private.actor_authorization_denial_aggregates'], 'actorLink');
// Command receipts and test domain audit events are reset candidates even when
// the actor is a developer. Preserved security markers pointing to such receipts
// are reported as FK conflicts; the collector never rewrites or drops history.
// The exact operational handover execution audit is the explicit preserve exception.
add(['private.command_executions'], 'resetCandidate');
add(['public.audit_events'], 'handoverAudit');
if (JSON.stringify([...rules.keys()].sort()) !== JSON.stringify(RESET_RELATION_NAMES)) {
  throw new Error('RESET_ROW_RULE_COVERAGE_MISMATCH');
}
export const RESET_ROW_RULES = Object.freeze([...rules.values()].sort((a, b) => a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0));
export const RESET_ROW_RULE_FINGERPRINT = createHash('sha256').update(JSON.stringify({
  version: '396-row-candidates-v1',
  rules: RESET_ROW_RULES.map(rule => ({ ...rule, expression: resetRowDispositionExpression(rule.relation, 'r') })),
  authBoundary: resetRowDispositionExpression('auth.users', 'r'),
})).digest('hex');
export const RESET_ROW_DISPOSITIONS = Object.freeze(['preserve', 'roomBaseline', 'resetCandidate', 'templateSource', 'photoHold', 'unresolved']);

export function resetRowDispositionExpression(relation, alias) {
  if (!['r', 's', 't'].includes(alias)) throw new Error('RESET_ROW_ALIAS_REJECTED');
  const kind = relation === 'auth.users' ? 'authBoundary' : rules.get(relation)?.kind;
  if (!kind) return null;
  if (kind === 'handoverAudit') return `case when ${alias}.event_type='cleaning_template.operational_handover' then 'preserve' else 'resetCandidate' end`;
  const role = value => `case ${value} when 'developer' then 'preserve' when 'admin' then 'resetCandidate' when 'maid' then 'resetCandidate' else 'unresolved' end`;
  if (kind === 'profileRole') return role(`${alias}.role::text`);
  if (kind === 'authBoundary' || kind === 'authLink') {
    const field = kind === 'authBoundary' ? 'id' : 'auth_user_id';
    return role(`(select p.role::text from public.profiles p where p.auth_user_id=${alias}.${field})`);
  }
  if (kind === 'profileLink' || kind === 'actorLink') {
    const field = kind === 'profileLink' ? 'profile_id' : 'actor_profile_id';
    return role(`(select p.role::text from public.profiles p where p.id=${alias}.${field})`);
  }
  return `'${kind}'::text`;
}

// Synthetic adapter for the same finite policy. Only role/link identity is read;
// passwords, PINs, audit bodies and provider values are never policy inputs.
export function evaluateResetRowCandidate(relation, row, profiles) {
  const kind = relation === 'auth.users' ? 'authBoundary' : rules.get(relation)?.kind;
  if (!kind) return 'unresolved';
  if (kind === 'handoverAudit') return row.event_type === 'cleaning_template.operational_handover' ? 'preserve' : 'resetCandidate';
  if (['preserve', 'roomBaseline', 'resetCandidate', 'templateSource', 'photoHold'].includes(kind)) return kind;
  let role;
  if (kind === 'profileRole') role = row.role;
  else {
    const byAuth = kind === 'authBoundary' || kind === 'authLink';
    const id = row[kind === 'authBoundary' ? 'id' : kind === 'authLink' ? 'auth_user_id' : kind === 'profileLink' ? 'profile_id' : 'actor_profile_id'];
    const matches = profiles.filter(profile => profile[byAuth ? 'auth_user_id' : 'id'] === id);
    if (typeof id !== 'string' || matches.length !== 1) return 'unresolved';
    role = matches[0].role;
  }
  return role === 'developer' ? 'preserve' : ['admin', 'maid'].includes(role) ? 'resetCandidate' : 'unresolved';
}
