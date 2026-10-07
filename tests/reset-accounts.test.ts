import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
const modulePath = '../scripts/reset-account-summary.mjs';
const { summarizeResetAccounts } = await import(modulePath);
const valid = () => ({
  format: 'reset-accounts-v2', readOnly: true,
  profiles: 3, developers: 1, eligibleDevelopers: 1, resetCandidates: 2, otherProfiles: 0,
  developerAuthLinks: 1, developerLoginAliases: 1, developerPasswordVersions: 1,
  developerAliasRows: 2, missingAuthLinks: 0, unlinkedAuthUsers: 0,
  unresolvedPasswordChanges: 0, preparedPasswordResets: 0,
  developerCrossAccountMarkers: 0, developerCommandLinks: 0,
});

describe('reset account preservation diagnostic', () => {
  it.each(['unresolvedPasswordChanges', 'preparedPasswordResets'])('blocks undrained %s', (key) => {
    const result = summarizeResetAccounts({ ...valid(), [key]: 1 });
    expect(result.blockers).toContain('AUTH_OPERATION_NOT_DRAINED');
    expect(result.necessaryConditionsMet).toBe(false);
  });
  it.each(['developerCrossAccountMarkers', 'developerCommandLinks'])('blocks unreviewed %s', (key) => {
    const result = summarizeResetAccounts({ ...valid(), [key]: 1 });
    expect(result.blockers).toContain('DEVELOPER_RECEIPT_FK_REVIEW_REQUIRED');
    expect(result.executionEnabled).toBe(false);
  });
  it.each(['unresolvedPasswordChanges', 'preparedPasswordResets', 'developerCrossAccountMarkers', 'developerCommandLinks'])
    ('rejects missing security count %s', (key) => {
      const input: Record<string, unknown> = valid(); delete input[key];
      expect(() => summarizeResetAccounts(input)).toThrow('RESET_ACCOUNTS_REJECTED');
    });
  it('rejects stale v1 snapshots rather than defaulting new gates to zero', () => {
    expect(() => summarizeResetAccounts({ ...valid(), format: 'reset-accounts-v1' })).toThrow('RESET_ACCOUNTS_REJECTED');
  });
  it('checks necessary links without enabling execution or claiming full classification', () => {
    expect(summarizeResetAccounts(valid())).toMatchObject({
      necessaryConditionsMet: true, executionEnabled: false, classificationComplete: false, blockers: [],
    });
  });
  it.each(['eligibleDevelopers', 'developerAuthLinks', 'developerLoginAliases', 'developerPasswordVersions'])
    ('blocks missing %s', (key) => {
      expect(summarizeResetAccounts({ ...valid(), [key]: 0 })).toMatchObject({ necessaryConditionsMet: false });
    });
  it('blocks the empty database, rather than treating no accounts as safe', () => {
    const input = Object.fromEntries(Object.entries(valid()).map(([k,v]) => [k, typeof v === 'number' ? 0 : v]));
    expect(summarizeResetAccounts(input).blockers).toContain('DEVELOPER_SINGLETON_REQUIRED');
  });
  it('blocks multiple developers', () => {
    expect(summarizeResetAccounts({ ...valid(), profiles: 4, developers: 2 }).blockers)
      .toContain('DEVELOPER_SINGLETON_REQUIRED');
  });
  it.each(['missingAuthLinks', 'unlinkedAuthUsers'])('blocks %s', (key) => {
    expect(summarizeResetAccounts({ ...valid(), [key]: 1 }).necessaryConditionsMet).toBe(false);
  });
  it('blocks unclassified profile roles', () => {
    expect(summarizeResetAccounts({ ...valid(), profiles: 4, otherProfiles: 1 }).blockers)
      .toContain('UNCLASSIFIED_ACCOUNTS');
  });
  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1', null])('rejects invalid count %s', (value) => {
    expect(() => summarizeResetAccounts({ ...valid(), developers: value })).toThrow('RESET_ACCOUNTS_REJECTED');
  });
  it.each([
    { profiles: 4 }, { developerAuthLinks: 2 }, { developerLoginAliases: 2 },
    { developerAliasRows: 0 }, { developerPasswordVersions: 2 }, { missingAuthLinks: 4 },
    { profiles: Number.MAX_SAFE_INTEGER, resetCandidates: Number.MAX_SAFE_INTEGER },
    { readOnly: false }, { email: 'sensitive-fixture' },
  ])('rejects contradictory or unexpected data %s', (change) => {
    expect(() => summarizeResetAccounts({ ...valid(), ...change })).toThrow(/^RESET_ACCOUNTS_REJECTED$/);
  });
  it('uses bounded read-only aggregate SQL, with no credential columns or DML', () => {
    const sql = readFileSync(new URL('../scripts/reset-accounts.sql',import.meta.url),'utf8');
    expect(sql).toContain('REPEATABLE READ READ ONLY');
    expect(sql).toContain("statement_timeout = '10s'");
    expect(sql).toContain('ROLLBACK;');
    expect(sql).not.toMatch(/\b(?:encrypted_password|email|refresh_token|DELETE|INSERT|UPDATE|TRUNCATE)\b/i);
  });
});
