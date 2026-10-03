import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

describe('#324 separate earnings and workflow OpenAPI', () => {
  const path = openApiDocument.paths['/v1/payroll/work-details'];
  const schemas = openApiDocument.components.schemas;
  it('publishes one no-store authenticated GET with bounded query and unchanged legacy kind', () => {
    expect(Object.keys(path)).toEqual(['get']);
    expect(path.get.operationId).toBe('listPayrollWorkDetails');
    expect(path.get.security).toEqual([{ bearerAuth: [] }]);
    expect(path.get['x-required-roles']).toEqual(['admin', 'maid']);
    expect(path.get.parameters.map(({ name, required }) => [name, required])).toEqual([['weekStart', true], ['maidProfileId', true], ['kind', true], ['limit', false], ['cursor', false]]);
    expect(path.get.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(schemas.PayrollEntriesEnvelope.properties.kind.enum).toEqual(['items', 'lateEarnings', 'adjustments']);
    expect(schemas.PayrollItem.properties.amount.minimum).toBe(1);
    expect(schemas.PayrollWorkDetailsEnvelope.properties.entries.maxItems).toBe(50);
    expect(path.get.description).toContain('summary.accrualAmount');
    expect(path.get.description).toContain('영구 snapshot은 보장하지');
  });
  it('makes all nullable workflow fields required and permits actual zero-KRW earnings only in the new DTO', () => {
    for (const schema of [schemas.PayrollWorkDetailsEnvelope, schemas.PayrollWorkEarning, schemas.PayrollWorkWorkflow, schemas.PayrollWorkSummary]) {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required.slice().sort()).toEqual(Object.keys(schema.properties).sort());
    }
    expect(schemas.PayrollWorkEarning.properties.totalAmount.minimum).toBe(0);
    expect(schemas.PayrollWorkWorkflow.properties.totalAmount.type).toBe('null');
    expect(schemas.PayrollWorkWorkflow.properties.expectedBombContributionAmount.minimum).toBe(0);
    expect(schemas.PayrollWorkSummary.properties.adjustmentAmount.minimum).toBe(-Number.MAX_SAFE_INTEGER);
    expect(schemas.PayrollWorkSummary.properties.lockedAmount.type).toEqual(['integer', 'null']);
    expect(JSON.stringify(schemas.PayrollWorkDetailsEnvelope)).not.toContain('sessionId');
  });
});
