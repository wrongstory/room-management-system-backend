import { describe, expect, it } from 'vitest';
import { summarizeOperationGates } from '../src/modules/developer-reset/operation-gates.js';
import { summarizeResetPreview } from '../src/modules/developer-reset/reset-preview.js';
import { resetRelationGroups } from '../src/modules/developer-reset/reset-preview-groups.js';

const gates = () => ({ format: 'developer-operation-gates-v1', lifecycle: 'UNKNOWN', controlVersion: null as string | null,
  maintenance: 'UNKNOWN', policyConfigured: false, unfinishedAdmissions: 0, expiredUnfinishedAdmissions: 0,
  unresolvedPasswordChanges: 0, preparedPasswordResets: 0, coverage: 'NOT_INTEGRATED',
  recentReauthentication: 'NOT_EVALUATED', executionEnabled: false });
const configured = () => ({ ...gates(), lifecycle: 'PROVISIONING', controlVersion: '1', maintenance: 'REQUESTED', policyConfigured: true });
const inventory = () => ({ format: 'reset-preview-inventory-v1', readOnly: true,
  capturedAt: '2026-10-25T10:00:00Z', snapshotId: 'a'.repeat(64),
  relations: Object.values(resetRelationGroups).flat().map(relation => ({ relation, kind: 'r', partition: false, observedRows: 0, exact: true })) });
describe('aggregate operational gate evidence', () => {
  it('does not equate absent lifecycle configuration to provisioning', () => {
    expect(summarizeOperationGates(gates()).blockers).toEqual(expect.arrayContaining(['PRE_OPERATION_STATE_UNKNOWN', 'OPERATION_POLICY_UNCONFIGURED']));
  });
  it('blocks started operation even when other observed counts are zero', () => {
    expect(summarizeOperationGates({ ...configured(), lifecycle: 'STARTED' }).blockers).toContain('OPERATION_ALREADY_STARTED');
  });
  it('never promotes maintenance requested or zero counts to complete admission coverage', () => {
    const result = summarizeOperationGates(configured());
    expect(result.executionEnabled).toBe(false);
    expect(result.blockers).toContain('ADMISSION_COVERAGE_NOT_INTEGRATED');
    expect(result.blockers).toContain('RECENT_REAUTHENTICATION_NOT_EVALUATED');
  });
  it('keeps expired unfinished work unknown and blocks unreconciled Auth effects', () => {
    const result = summarizeOperationGates({ ...configured(), unfinishedAdmissions: 2, expiredUnfinishedAdmissions: 1,
      unresolvedPasswordChanges: 1, preparedPasswordResets: 1 });
    expect(result.blockers).toEqual(expect.arrayContaining(['ADMISSIONS_NOT_DRAINED', 'ADMISSION_EFFECT_UNKNOWN', 'AUTH_OPERATION_NOT_DRAINED']));
  });
  it.each([
    null, true, { ...gates(), coverage: 'COMPLETE' }, { ...gates(), executionEnabled: true },
    { ...gates(), policyConfigured: true }, { ...gates(), lifecycle: 'PROVISIONING' },
    { ...gates(), recentReauthentication: true }, { ...gates(), target: 'raw-project' },
    { ...gates(), unfinishedAdmissions: -1 }, { ...gates(), unfinishedAdmissions: Number.MAX_SAFE_INTEGER + 1 },
    { ...gates(), expiredUnfinishedAdmissions: 1 }, { ...configured(), controlVersion: '1e2' },
    { ...configured(), controlVersion: '9223372036854775808' },
  ])('fails closed on contradictory/untrusted shape %#', value => {
    expect(() => summarizeOperationGates(value)).toThrow('OPERATION_GATES_UNAVAILABLE');
  });
  it('legacy preview data is explicitly uncollected rather than fabricated evidence', () => {
    expect(summarizeResetPreview(inventory())).toMatchObject({ operationGates: null,
      executionEnabled: false, blockers: expect.arrayContaining(['OPERATION_GATES_NOT_COLLECTED']) });
  });
  it('includes only strict aggregate evidence in preview, and rejects malformed new data', () => {
    expect(summarizeResetPreview({ ...inventory(), gateEvidence: gates() }).operationGates?.lifecycle).toBe('UNKNOWN');
    expect(() => summarizeResetPreview({ ...inventory(), gateEvidence: true })).toThrow('RESET_PREVIEW_UNAVAILABLE');
  });
});
