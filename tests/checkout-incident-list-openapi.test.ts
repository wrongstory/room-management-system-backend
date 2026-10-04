import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

describe('#327 checkout incident list OpenAPI', () => {
  const operation = openApiDocument.paths['/v1/checkout-incidents'].get;
  const schemas = openApiDocument.components.schemas;
  it('publishes an admin-only no-store bounded read with strict filter inventory', () => {
    expect(operation.operationId).toBe('listCheckoutIncidents');
    expect(operation['x-required-roles']).toEqual(['admin']);
    expect(operation.security).toEqual([{ bearerAuth: [] }]);
    expect(operation.parameters.map((parameter) => parameter.name)).toEqual([
      'roomId', 'cleaningTargetId', 'serviceDate', 'limit', 'cursor'
    ]);
    expect(operation.parameters.find((parameter) => parameter.name === 'limit')?.schema)
      .toEqual({ type: 'integer', minimum: 1, maximum: 100, default: 50 });
    expect(operation.responses['200'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(Object.keys(operation.responses)).toEqual(['200', '400', '401', '403', '500']);
    expect(operation.responses['200'].content['application/json'].schema.$ref)
      .toBe('#/components/schemas/CheckoutIncidentListEnvelope');
  });
  it('keeps discovery separate from latest detail and decision CAS', () => {
    const item = schemas.CheckoutIncidentListItem;
    const fields = ['incidentId', 'status', 'roomId', 'roomNumber', 'cleaningTargetId',
      'assignmentId', 'attemptId', 'reportedAt', 'serviceDate', 'allowedDecisions'];
    expect(item.required).toEqual(fields);
    expect(Object.keys(item.properties)).toEqual(fields);
    expect(item.additionalProperties).toBe(false);
    expect(item.properties.status.enum).toEqual(['open']);
    expect(item.properties.allowedDecisions.items.enum).toEqual([
      'EXTEND_CHECKOUT', 'CONFIRM_DEPARTED', 'FALSE_REPORT'
    ]);
    expect(item.properties.allowedDecisions.prefixItems.map((entry) => entry.enum)).toEqual([
      ['EXTEND_CHECKOUT'], ['CONFIRM_DEPARTED'], ['FALSE_REPORT']
    ]);
    expect(new RegExp(item.properties.reportedAt.pattern).test('2026-10-02T16:00:00.000001Z')).toBe(true);
    expect(new RegExp(item.properties.reportedAt.pattern).test('2026-10-02T16:00:00.000Z')).toBe(false);
    expect(schemas.CheckoutIncidentListEnvelope.required).toEqual(['items', 'nextCursor']);
    expect(schemas.CheckoutIncidentListEnvelope.properties.items.maxItems).toBe(100);
    expect(schemas.CheckoutIncidentListEnvelope.properties.nextCursor.anyOf[1]).toEqual({ type: 'null' });
    expect(schemas.CheckoutIncident.required).toContain('version');
    expect(schemas.CheckoutIncident.required).toContain('impactFingerprint');
    expect(openApiDocument.paths['/v1/checkout-incidents/{incidentId}'].get['x-required-roles'])
      .toEqual(['admin', 'maid']);
  });
});
