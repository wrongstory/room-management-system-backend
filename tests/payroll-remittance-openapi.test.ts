import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

describe('#331 remittance display is separate from payout', () => {
  const schemas = openApiDocument.components.schemas;
  const path = openApiDocument.paths['/v1/payroll/remittance-marker'];
  it('publishes authenticated read/set/reconfirm/history and no fake paid transition', () => {
    expect(Object.keys(path)).toEqual(['get', 'put']);
    expect(path.get['x-required-roles']).toEqual(['admin', 'maid']);
    expect(path.put['x-required-roles']).toEqual(['admin']);
    expect(path.put.parameters[0]).toMatchObject({ name: 'Idempotency-Key', required: true });
    expect(path.put.description).toContain('동일 on 요청으로 지우지');
    expect(path.put.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(openApiDocument.paths['/v1/payroll/remittance-marker/reconfirm'].post.operationId)
      .toBe('reconfirmPayrollRemittanceMarker');
    expect(openApiDocument.paths['/v1/payroll/remittance-marker/history'].get.parameters.at(-2)?.schema)
      .toMatchObject({ minimum: 1, maximum: 100, default: 20 });
  });
  it('has exact required fields, signed correction basis and no sensitive payout evidence', () => {
    for (const schema of [schemas.PayrollRemittanceBasis, schemas.PayrollRemittanceMarker,
      schemas.PayrollRemittanceSetInput, schemas.PayrollRemittanceReconfirmInput,
      schemas.PayrollRemittanceHistoryEvent, schemas.PayrollRemittanceHistory]) {
      expect(schema.additionalProperties).toBe(false);
      expect(schema.required.slice().sort()).toEqual(Object.keys(schema.properties).sort());
      expect(JSON.stringify(schema)).not.toMatch(/providerReferenceId|sessionId|accessToken|bankAccount/);
    }
    expect(schemas.PayrollRemittanceBasis.properties.adjustmentAmount.minimum).toBe(-Number.MAX_SAFE_INTEGER);
    expect(schemas.PayrollRemittanceBasis.properties.lockedAmount.type).toEqual(['integer', 'null']);
    expect(schemas.PayrollRemittanceHistory.properties.entries.maxItems).toBe(100);
    expect(schemas.PayrollRemittanceSetInput.properties.expectedBasisFingerprint.pattern).toBe('^[0-9a-f]{64}$');
    expect(Object.keys(schemas.PayrollRemittanceReconfirmInput.properties)).not.toContain('marked');
    expect(schemas.PayrollRemittanceMarker.properties.setBlockedReason.enum).toContain('ADMIN_REQUIRED');
  });
});
