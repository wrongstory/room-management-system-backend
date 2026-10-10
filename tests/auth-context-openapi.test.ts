import { describe, expect, it } from 'vitest';
const { openApiDocument } = await import(new URL('../supabase/functions/_shared/openapi.ts', import.meta.url).href);
describe('#442 authentication availability contract', () => {
  it('documents safe 503 on protected APIs without changing path count', () => {
    for (const [path, method] of [['/v1/auth/me', 'get'], ['/v1/accounts', 'get'], ['/v1/rooms', 'get'], ['/v1/auth/password', 'post']] as const) {
      expect(openApiDocument.paths[path][method].responses['503']).toBeDefined();
      expect(openApiDocument.paths[path][method].responses['503'].headers['Cache-Control'].schema.const).toBe('no-store');
    }
    expect(openApiDocument.components.schemas.ErrorCode.enum).toContain('AUTH_CONTEXT_UNAVAILABLE');
    expect(openApiDocument.info.description).toContain('503 AUTH_CONTEXT_UNAVAILABLE');
    expect(Object.keys(openApiDocument.paths)).toHaveLength(151);
  });
  it('documents common-auth photo content but does not inject it on limited identity routes', () => {
    expect(openApiDocument.paths['/v1/photos/{photoId}/content'].get.responses['503']).toBeDefined();
    expect(openApiDocument.paths['/v1/photos/{photoId}/content'].get.responses['503'].headers['Cache-Control'].schema.const).toBe('no-store');
    expect(openApiDocument.paths['/v1/auth/password'].post.responses['503'].content['application/json'].schema.$ref).toBe('#/components/schemas/ErrorEnvelope');
    for (const [path, method] of [
      ['/v1/limited/attempts', 'get'], ['/v1/offline-events', 'post'],
      ['/v1/attempts/{attemptId}/submissions', 'post'],
      ['/v1/attempts/{attemptId}/photo-slots', 'get'], ['/v1/photo-uploads/{operationId}', 'get']] as const) {
      expect(openApiDocument.paths[path][method].responses['503']?.description ?? '').not.toContain('공통 인증 조회 불가');
    }
  });
});
