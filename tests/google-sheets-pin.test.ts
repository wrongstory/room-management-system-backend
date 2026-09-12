import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertApprovedRoomPinSheetTarget, GoogleSheetsPinProvider, LOCAL_ROOM_PIN_SHEET_TARGET, ROOM_PIN_SHEET_HEADERS, RoomPinSheetProviderError, type RoomPinSheetRow } from '../src/modules/rooms/google-sheets-pin.js';

const encode = (value: Uint8Array): string => { let raw = ''; for (const part of value) raw += String.fromCharCode(part); return btoa(raw); };
async function privatePem(): Promise<string> {
  const keys = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: Uint8Array.of(1, 0, 1), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', keys.privateKey));
  const chunks = encode(der).match(/.{1,64}/g); if (!chunks) throw new Error('test key export failed');
  const wrapped = chunks.join('\n');
  const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const footer = ['-----END', 'PRIVATE KEY-----'].join(' ');
  return `${header}\n${wrapped}\n${footer}`;
}
const target = { ...LOCAL_ROOM_PIN_SHEET_TARGET };
const row: RoomPinSheetRow = { sheetRow: 2, roomNumber: '101', canonicalPin: '101-1234', pinVersion: 3, effectiveAt: '2026-09-13T00:00:00.000Z', syncStatus: 'verified', reasonCode: 'PIN_CHANGE_CONFIRMED', environment: 'local' };
async function harness(sheetCells: unknown[] | unknown[][] = [], writeStatus = 200) {
  const calls: Array<{ url: URL; init: RequestInit }> = [], key = await privatePem();
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); calls.push({ url, init }); expect(init.redirect).toBe('error');
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_access_token_long_enough', expires_in: 3600, token_type: 'Bearer' });
    expect(url.hostname).toBe('sheets.googleapis.com'); expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic_access_token_long_enough');
    if (init.method === 'POST') return writeStatus === 200 ? Response.json({ totalUpdatedRows: 2 }) : new Response(null, { status: writeStatus });
    const board = sheetCells.length && Array.isArray(sheetCells[0]) ? sheetCells : sheetCells.length ? [sheetCells] : [];
    return Response.json({ valueRanges: [{ values: [[...ROOM_PIN_SHEET_HEADERS]] }, { values: board }] });
  };
  return { provider: new GoogleSheetsPinProvider(target, { email: 'synthetic@project.iam.gserviceaccount.com', privateKeyPem: key }, fetcher), calls };
}

describe('Google Sheets PIN projection adapter', () => {
  afterEach(() => vi.useRealTimers());
  it('has no hosted approved target and fails before any provider use', () => {
    expect(() => assertApprovedRoomPinSheetTarget({ ...target, environment: 'production', projectRef: 'prod', spreadsheetId: 'same-looking-hosted-id-00000001' })).toThrowError(new RoomPinSheetProviderError('PROVIDER_CONFIGURATION_ERROR'));
    expect(() => assertApprovedRoomPinSheetTarget({ ...target, projectRef: '127.0.0.1' })).toThrowError(new RoomPinSheetProviderError('PROVIDER_CONFIGURATION_ERROR'));
    expect(() => assertApprovedRoomPinSheetTarget(target)).not.toThrow();
  });
  it('uses a signed service-account assertion with only the Sheets scope', async () => {
    const value = await harness([]); await value.provider.inspect(row, Date.now() + 5000);
    const oauth = value.calls.find(call => call.url.hostname === 'oauth2.googleapis.com'); expect(oauth).toBeDefined();
    const body = oauth?.init.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const segments = body.get('assertion')?.split('.') ?? []; expect(segments).toHaveLength(3); expect(segments[2]?.length).toBeGreaterThan(100);
    const decode = (segment: string) => JSON.parse(atob(segment.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - segment.length % 4) % 4)));
    expect(decode(segments[0] ?? '')).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claim = decode(segments[1] ?? '');
    expect(claim).toMatchObject({ iss: 'synthetic@project.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token' });
    expect(claim.exp - claim.iat).toBe(3600);
    expect(JSON.stringify(value.provider)).toBe('{}');
  });
  it('redacts service-account material, assertions, and tokens from provider errors', async () => {
    const key = await privatePem(); let assertion = '';
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') {
        assertion = (init.body as URLSearchParams).get('assertion') ?? '';
        return Response.json({ access_token: 'synthetic_access_token_long_enough', expires_in: 3600, token_type: 'Bearer' });
      }
      return new Response(JSON.stringify({ error: `raw-${assertion}-synthetic_access_token_long_enough-${key}` }), { status: 403 });
    };
    const provider = new GoogleSheetsPinProvider(target, { email: 'synthetic@project.iam.gserviceaccount.com', privateKeyPem: key }, transport);
    let caught: unknown;
    try { await provider.inspect(row, Date.now() + 5000); } catch (error) { caught = error; }
    expect(caught).toMatchObject({ reason: 'AUTHORIZATION_FAILED', message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
    const serialized = JSON.stringify(caught);
    expect(serialized).not.toContain(assertion); expect(serialized).not.toContain('synthetic_access_token'); expect(serialized).not.toContain('PRIVATE KEY');
  });
  it('treats exact equal version as current but repairs equal-version PIN or marker tampering', async () => {
    const exact = await harness([row.roomNumber, row.canonicalPin, '3', row.syncStatus, row.effectiveAt, 'ignored-clock', row.reasonCode, row.environment]);
    expect(await exact.provider.inspect(row, Date.now() + 5000)).toEqual({ outcome: 'current', sheetRow: 2 });
    for (const changed of [
      [row.roomNumber, '101-9999', '3', row.syncStatus, row.effectiveAt, '', row.reasonCode, row.environment],
      [row.roomNumber, row.canonicalPin, '3', 'stale', row.effectiveAt, '', row.reasonCode, row.environment]
    ]) expect(await (await harness(changed)).provider.inspect(row, Date.now() + 5000)).toEqual({ outcome: 'write', sheetRow: 2 });
  });
  it('finds room identity after a row move, blocks duplicates, and never overwrites another room', async () => {
    const moved = await harness([[], [], [row.roomNumber, row.canonicalPin, '2', row.syncStatus, row.effectiveAt, '', row.reasonCode, row.environment]]);
    expect(await moved.provider.inspect(row, Date.now() + 5000)).toEqual({ outcome: 'write', sheetRow: 4 });
    await moved.provider.write({ ...row, sheetRow: 4 }, Date.now() + 5000);
    const movedWrite = moved.calls.find(call => call.init.method === 'POST' && call.url.hostname === 'sheets.googleapis.com');
    expect(movedWrite).toBeDefined(); expect(JSON.parse(String(movedWrite?.init.body)).data[1].range).toContain('A4:H4');
    const duplicate = await harness([[row.roomNumber], [row.roomNumber]]);
    await expect(duplicate.provider.inspect(row, Date.now() + 5000)).rejects.toMatchObject({ reason: 'PROVIDER_CONFIGURATION_ERROR' });
    const occupied = await harness([['102']]);
    await expect(occupied.provider.inspect(row, Date.now() + 5000)).rejects.toMatchObject({ reason: 'PROVIDER_CONFIGURATION_ERROR' });
  });
  it('bounds the complete 121-room board read and still finds the final room identity', async () => {
    const board = Array.from({ length: 121 }, (_, index) => index === 120
      ? [row.roomNumber, row.canonicalPin, '2', row.syncStatus, row.effectiveAt, '', row.reasonCode, row.environment]
      : [String(200 + index)]);
    const value = await harness(board);
    expect(await value.provider.inspect(row, Date.now() + 5000)).toEqual({ outcome: 'write', sheetRow: 122 });
    const read = value.calls.find(call => call.init.method === 'GET' && call.url.hostname === 'sheets.googleapis.com');
    expect(read?.url.searchParams.getAll('ranges')).toContain("'객실_PIN_현황'!A2:H122");
    await expect((await harness([...board, ['overflow']])).provider.inspect(row, Date.now() + 5000)).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
  });
  it('writes stale/blank rows with deterministic headers and room-number row identity', async () => {
    const { provider, calls } = await harness([]); expect(await provider.inspect(row, Date.now() + 5000)).toEqual({ outcome: 'write', sheetRow: 2 });
    await provider.write(row, Date.now() + 5000);
    const write = calls.find(call => call.init.method === 'POST' && call.url.hostname === 'sheets.googleapis.com'); expect(write).toBeDefined();
    const body = JSON.parse(String(write?.init.body));
    expect(body).toMatchObject({ valueInputOption: 'RAW', includeValuesInResponse: false });
    expect(body.data[1].range).toContain('A2:H2'); expect(body.data[1].values[0]).toContain(row.canonicalPin);
  });
  it('blocks a sheet-ahead version and wrong room/environment identity', async () => {
    for (const cells of [
      [row.roomNumber, row.canonicalPin, '4', row.syncStatus, row.effectiveAt, '', row.reasonCode, row.environment],
      ['102', row.canonicalPin, '3', row.syncStatus, row.effectiveAt, '', row.reasonCode, row.environment],
      [row.roomNumber, row.canonicalPin, '3', row.syncStatus, row.effectiveAt, '', row.reasonCode, 'production']
    ]) await expect((await harness(cells)).provider.inspect(row, Date.now() + 5000)).rejects.toMatchObject({ reason: 'PROVIDER_CONFIGURATION_ERROR', message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
  });
  it.each([[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHORIZATION_FAILED'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE']] as const)('classifies provider HTTP %i without exposing provider data', async (status, reason) => {
    const value = await harness([], status);
    await expect(value.provider.write(row, Date.now() + 5000)).rejects.toMatchObject({ reason, message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
    await expect(value.provider.write(row, Date.now() + 5000)).rejects.not.toHaveProperty('cause');
  });
  it('shares one absolute deadline across OAuth/read and treats only an aborted write as uncertain', async () => {
    const key = await privatePem(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    const transport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_access_token_long_enough', expires_in: 3600, token_type: 'Bearer' });
      return await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('raw sheet value', 'AbortError')), { once: true }));
    };
    const provider = new GoogleSheetsPinProvider(target, { email: 'synthetic@project.iam.gserviceaccount.com', privateKeyPem: key }, transport, Date.now);
    const read = provider.inspect(row, Date.now() + 1000); const readAssertion = expect(read).rejects.toMatchObject({ reason: 'PROVIDER_UNAVAILABLE', message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
    await vi.advanceTimersByTimeAsync(1000); await readAssertion;
    const writeTransport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'second_synthetic_access_token', expires_in: 3600, token_type: 'Bearer' });
      if (init.method === 'GET') return Response.json({ valueRanges: [{ values: [[...ROOM_PIN_SHEET_HEADERS]] }, { values: [] }] });
      return await new Promise<Response>((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('raw sheet value', 'AbortError')), { once: true }));
    };
    const writeProvider = new GoogleSheetsPinProvider(target, { email: 'synthetic@project.iam.gserviceaccount.com', privateKeyPem: key }, writeTransport, Date.now);
    await writeProvider.inspect(row, Date.now() + 5000);
    const write = writeProvider.write(row, Date.now() + 1000); const writeAssertion = expect(write).rejects.toMatchObject({ reason: 'WRITE_OUTCOME_UNCERTAIN', message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
    await vi.advanceTimersByTimeAsync(0); await vi.advanceTimersByTimeAsync(1000); await writeAssertion;
  });
  it('applies the same absolute deadline while streaming provider response bodies', async () => {
    const key = await privatePem(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-13T00:00:00Z'));
    const hangingBody = () => new ReadableStream<Uint8Array>({ start() { /* intentionally never closes */ } });
    const inspectTransport: typeof fetch = async input => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'synthetic_access_token_long_enough', expires_in: 3600, token_type: 'Bearer' });
      return new Response(hangingBody(), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const inspectProvider = new GoogleSheetsPinProvider(target, { email: 'synthetic@project.iam.gserviceaccount.com', privateKeyPem: key }, inspectTransport, Date.now);
    const inspect = inspectProvider.inspect(row, Date.now() + 1000); const inspectAssertion = expect(inspect).rejects.toMatchObject({ reason: 'PROVIDER_UNAVAILABLE' });
    await vi.advanceTimersByTimeAsync(1000); await inspectAssertion;

    let writes = 0;
    const writeTransport: typeof fetch = async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'second_synthetic_access_token', expires_in: 3600, token_type: 'Bearer' });
      if (init.method === 'GET') return Response.json({ valueRanges: [{ values: [[...ROOM_PIN_SHEET_HEADERS]] }, { values: [] }] });
      writes++; return new Response(hangingBody(), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const writeProvider = new GoogleSheetsPinProvider(target, { email: 'synthetic@project.iam.gserviceaccount.com', privateKeyPem: key }, writeTransport, Date.now);
    await writeProvider.inspect(row, Date.now() + 5000);
    const write = writeProvider.write(row, Date.now() + 1000); const writeAssertion = expect(write).rejects.toMatchObject({ reason: 'WRITE_OUTCOME_UNCERTAIN' });
    await vi.advanceTimersByTimeAsync(1000); await writeAssertion; expect(writes).toBe(1);
  });
});
