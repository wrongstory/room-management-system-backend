import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

describe('#325 latest payroll adjustment book OpenAPI', () => {
  const operation = openApiDocument.paths['/v1/payroll/adjustment-book'].get;
  const schemas = openApiDocument.components.schemas;
  it('publishes only an authenticated admin GET with two required query fields and no-store', () => {
    expect(Object.keys(openApiDocument.paths['/v1/payroll/adjustment-book'])).toEqual(['get']);
    expect(operation.operationId).toBe('getPayrollAdjustmentBook');
    expect(operation['x-required-roles']).toEqual(['admin']);
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation.parameters.map(({ name, in: location, required }) => [name, location, required]))
      .toEqual([['maidProfileId', 'query', true], ['weekStart', 'query', true]]);
    expect(operation.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(Object.keys(operation.responses)).toEqual(['200', '400', '401', '403', '404', '409', '500', '503']);
    expect(operation.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/PayrollAdjustmentBookEnvelope');
    expect(operation.description).toContain('전역 CAS');
    expect(operation.description).toContain('stale 409');
  });
  it('publishes exactly three required safe fields, no book ID, private state or command fields', () => {
    const fields = ['maidProfileId', 'weekStart', 'currentBookVersion'];
    expect(schemas.PayrollAdjustmentBook.required).toEqual(fields);
    expect(Object.keys(schemas.PayrollAdjustmentBook.properties)).toEqual(fields);
    expect(schemas.PayrollAdjustmentBook.additionalProperties).toBe(false);
    expect(schemas.PayrollAdjustmentBook.properties.currentBookVersion.type).toBe('integer');
    expect(schemas.PayrollAdjustmentBook.properties.currentBookVersion.minimum).toBe(0);
    expect(schemas.PayrollAdjustmentBook.properties.currentBookVersion.maximum).toBe(Number.MAX_SAFE_INTEGER);
    expect(schemas.PayrollAdjustmentBookEnvelope.required).toEqual(['adjustmentBook']);
    expect(schemas.PayrollAdjustmentBookEnvelope.additionalProperties).toBe(false);
    expect(Object.keys(schemas.PayrollAdjustmentBookEnvelope.properties)).toEqual(['adjustmentBook']);
    expect(Object.keys(schemas.PayrollAdjustmentEntry.properties)).not.toContain('currentBookVersion');
    expect(schemas.PayrollAdjustment.properties).toHaveProperty('bookVersion');
  });
  it('keeps a reviewed complete inventory and documents strict real-calendar query', () => {
    expect(Object.keys(openApiDocument.paths)).toHaveLength(133);
    expect(Object.values(openApiDocument.paths).flatMap((item) => Object.keys(item)
      .filter((method) => ['get', 'post', 'put', 'patch', 'delete'].includes(method)))).toHaveLength(143);
    const date = operation.parameters.find(({ name }) => name === 'weekStart');
    if (!date) throw new Error('weekStart query contract missing');
    expect(date.schema).toMatchObject({ type: 'string', format: 'date', minLength: 10, maxLength: 10 });
    const pattern = 'pattern' in date.schema ? date.schema.pattern : '';
    expect(new RegExp(pattern).test('0000-01-01')).toBe(false);
    expect(new RegExp(pattern).test('0001-01-01')).toBe(true);
    expect(date.description).toContain('미래 주차는 409');
  });
});
