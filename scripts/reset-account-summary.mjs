import { z } from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const schema = z.object({
  format: z.literal('reset-accounts-v2'), readOnly: z.literal(true),
  profiles: count, developers: count, eligibleDevelopers: count,
  resetCandidates: count, otherProfiles: count,
  developerAuthLinks: count, developerLoginAliases: count,
  developerPasswordVersions: count, developerAliasRows: count,
  missingAuthLinks: count, unlinkedAuthUsers: count,
  unresolvedPasswordChanges: count, preparedPasswordResets: count,
  developerCrossAccountMarkers: count, developerCommandLinks: count,
}).strict();

/** Count-only necessary conditions, never a login, authorization or backup proof. */
export function summarizeResetAccounts(input) {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error('RESET_ACCOUNTS_REJECTED');
  const c = parsed.data;
  const total = c.developers + c.resetCandidates + c.otherProfiles;
  if (!Number.isSafeInteger(total) || total !== c.profiles ||
      c.eligibleDevelopers > c.developers || c.developerAuthLinks > c.developers ||
      c.developerLoginAliases > c.developers || c.developerPasswordVersions > c.developers ||
      c.developerLoginAliases > c.developerAliasRows || c.missingAuthLinks > c.profiles ||
      (c.developers === 0 && c.developerAliasRows !== 0)) {
    throw new Error('RESET_ACCOUNTS_REJECTED');
  }
  const blockers = [];
  if (c.developers !== 1) blockers.push('DEVELOPER_SINGLETON_REQUIRED');
  if (c.eligibleDevelopers !== 1) blockers.push('DEVELOPER_PROFILE_NOT_READY');
  if (c.developerAuthLinks !== 1) blockers.push('DEVELOPER_AUTH_LINK_MISSING');
  if (c.developerLoginAliases !== 1) blockers.push('DEVELOPER_LOGIN_ALIAS_MISSING');
  if (c.developerPasswordVersions !== 1) blockers.push('DEVELOPER_PASSWORD_VERSION_MISSING');
  if (c.missingAuthLinks) blockers.push('PROFILE_AUTH_LINK_MISSING');
  if (c.otherProfiles || c.unlinkedAuthUsers) blockers.push('UNCLASSIFIED_ACCOUNTS');
  if (c.unresolvedPasswordChanges || c.preparedPasswordResets) blockers.push('AUTH_OPERATION_NOT_DRAINED');
  if (c.developerCrossAccountMarkers || c.developerCommandLinks) blockers.push('DEVELOPER_RECEIPT_FK_REVIEW_REQUIRED');
  return {
    scope: 'local-account-diagnostic', executionEnabled: false,
    classificationComplete: false, necessaryConditionsMet: blockers.length === 0,
    counts: c, blockers,
  };
}
