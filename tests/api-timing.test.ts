import { describe, expect, it } from 'vitest';
import { apiTimingEligible, apiTimingHeaders } from '../src/lib/api-timing.js';

describe('bounded common API timing', () => {
  it.each(['/v1/rooms', '/v1/payroll/entries', '/v1/availability', '/v1/photos/synthetic/content'])('includes successful business handler %s', path => {
    expect(apiTimingEligible('GET', path, 200)).toBe(true);
  });
  it.each(['/health', '/openapi.json', '/v1/auth/login', '/v1/accounts', '/v1/rooms-extra'])('excludes public/auth/unlisted routes %s', path => {
    expect(apiTimingEligible('GET', path, 200)).toBe(false);
  });
  it.each([400, 401, 403, 404, 409, 429, 500, 503])('excludes errors %s', status => {
    expect(apiTimingEligible('GET', '/v1/rooms', status)).toBe(false);
  });
  it('excludes HEAD/preflight and preserves existing photo and disposition headers', () => {
    expect(apiTimingEligible('OPTIONS', '/v1/rooms', 204)).toBe(false);
    expect(apiTimingEligible('HEAD', '/v1/rooms', 200)).toBe(false);
    expect(apiTimingHeaders(12.25, 'photo_db;dur=8.0', 'Content-Disposition, server-timing')).toEqual({
      'server-timing': 'photo_db;dur=8.0, api_total;dur=12.3',
      'access-control-expose-headers': 'Content-Disposition, server-timing',
    });
  });
  it.each([[-1, '0.0'], [Number.NaN, '0.0'], [Infinity, '0.0'], [99999999, '3600000.0']])('clamps unsafe clocks %s', (elapsed, expected) => {
    expect(apiTimingHeaders(elapsed)['server-timing']).toBe(`api_total;dur=${expected}`);
  });
});
