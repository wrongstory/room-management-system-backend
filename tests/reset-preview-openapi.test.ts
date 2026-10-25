import { Ajv2020 } from 'ajv/dist/2020.js';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import { summarizeResetPreview } from '../src/modules/developer-reset/reset-preview.js';
import { createDeveloperResetPreviewRoutes } from '../src/modules/developer-reset/reset-preview.routes.js';
import { resetPreviewContractInputs } from './fixtures/reset-preview.js';

const edgeModule = '../supabase/functions/_shared/reset-preview.ts';
const { summarizeResetPreview: edgePreview } = await import(edgeModule);
const document = JSON.parse(JSON.stringify(openApiDocument));
const ajv = new Ajv2020({ strict: false, validateFormats: false, allErrors: true });
const validate = ajv.compile({ $ref: '#/components/schemas/DeveloperResetPreview', components: document.components });
const validateEnvelope = ajv.compile({
  ...document.paths['/v1/developer/reset/preview'].get.responses['200'].content['application/json'].schema,
  components: document.components,
});
const samples = resetPreviewContractInputs();
describe('actual Node/Edge reset preview and complete strict wire schema', () => {
  it.each(samples)('accepts the complete $name projection including nullable gates', ({ input }) => {
    const node = summarizeResetPreview(input);
    const edge = edgePreview(input);
    expect(edge).toEqual(node);
    for (const response of [node, edge]) {
      expect(validate(response), JSON.stringify(validate.errors)).toBe(true);
      expect(validateEnvelope({ preview: response }), JSON.stringify(validateEnvelope.errors)).toBe(true);
    }
  });
  it('validates the actual Fastify reply against its full documented response envelope', async () => {
    const app = Fastify();
    // Authentication is tested separately; this regression exercises the real route serializer.
    app.decorate('authenticate', async () => {});
    app.decorate('requirePasswordChanged', async () => {});
    app.decorate('requireDeveloper', async () => {});
    const sample = samples[2]; if (!sample) throw new Error('fixture missing');
    await app.register(createDeveloperResetPreviewRoutes({ read: async () => summarizeResetPreview(sample.input) }),
      { prefix: '/v1/developer' });
    try {
      const response = await app.inject({ method: 'GET', url: '/v1/developer/reset/preview' });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(validateEnvelope(response.json()), JSON.stringify(validateEnvelope.errors)).toBe(true);
      expect(validateEnvelope({ ...response.json(), rawSession: 'private-value' })).toBe(false);
    } finally { await app.close(); }
  });
  it('requires explicit operationGates even for a legacy null result', () => {
    const sample = samples[0]; if (!sample) throw new Error('fixture missing');
    const response: Record<string, unknown> = { ...summarizeResetPreview(sample.input) };
    delete response.operationGates;
    expect(validate(response)).toBe(false);
  });
  it('requires the template field and rejects selected-policy or raw template data promotion', () => {
    const sample = samples.find(row => row.name === 'templates-all-statuses');
    if (!sample) throw new Error('fixture missing');
    const body = summarizeResetPreview(sample.input);
    const missing: Record<string, unknown> = { ...body }; delete missing.templateEvidence;
    expect(validate(missing)).toBe(false);
    for (const patch of [{ executionEnabled: true }, { templateCount: -1 }, { sourceId: 'private-value' }]) {
      expect(validate({ ...body, templateEvidence: { ...body.templateEvidence, ...patch } })).toBe(false);
    }
    const alternatives = body.templateEvidence.selectionAlternatives;
    expect(validate({ ...body, templateEvidence: { ...body.templateEvidence,
      selectionAlternatives: alternatives?.map(row => ({ ...row, statusPolicyDecided: true })) } })).toBe(false);
  });
  it('rejects promoted permission, malformed state, omissions and raw private fields', () => {
    const sample = samples[2]; if (!sample) throw new Error('fixture missing');
    const body = summarizeResetPreview(sample.input);
    for (const patch of [ { executionEnabled: true }, { coverage: 'COMPLETE' }, { recentReauthentication: true },
      { lifecycle: 'READY_TO_RESET' }, { unfinishedAdmissions: -1 }, { controlVersion: 12 }, { sessionId: 'private-value' } ]) {
      expect(validate({ ...body, operationGates: { ...body.operationGates, ...patch } })).toBe(false);
    }
    for (const key of Object.keys(body.operationGates ?? {})) {
      const gates: Record<string, unknown> = { ...body.operationGates }; delete gates[key];
      expect(validate({ ...body, operationGates: gates }), key).toBe(false);
    }
    expect(validate({ ...body, rawNonce: 'private-value' })).toBe(false);
  });
});
