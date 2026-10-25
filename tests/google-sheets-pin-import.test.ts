import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { GoogleRoomPinImportSource } from '../src/modules/rooms/google-sheets-pin-import.js';
import { roomPinImportCredentials } from '../src/modules/rooms/google-sheets-pin.js';
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account = { email: 'synthetic@synthetic.iam.gserviceaccount.com', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
const id = 'synthetic-import-spreadsheet-001';
function fixture(overrides: Record<string,unknown> = {}) {
  const payload = { sheets: [{ properties: { sheetId: 17, title: '시트 1', gridProperties: { rowCount: 1000 } },
    data: [{ startRow: 1, startColumn: 1, rowData: [
      { values: [{}, { userEnteredValue: { stringValue: '비번 ' } }] },
      { values: [{ userEnteredValue: { stringValue: '701(1.5)' } }, { userEnteredValue: { stringValue: '701-001234' } }] }
    ] }], ...overrides }] };
  const fetcher = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(
    String(url).includes('oauth2') ? { access_token: 'synthetic-access-token-value', token_type: 'Bearer' } : payload
  )));
  return { source: new GoogleRoomPinImportSource(id, 17, account, 'different-projection-sheet', fetcher), fetcher, payload };
}
it('uses readonly OAuth and only exact source tab B/C without writing or reading notes', async () => {
  const f = fixture();
  expect(await f.source.read()).toEqual([['','비번 '],['701(1.5)','701-001234']]);
  const auth = f.fetcher.mock.calls[0]![1]!;
  const assertion = (auth.body as URLSearchParams).get('assertion')!;
  const claims = JSON.parse(Buffer.from(assertion.split('.')[1]!, 'base64url').toString());
  expect(claims.scope).toBe('https://www.googleapis.com/auth/spreadsheets.readonly');
  const read = f.fetcher.mock.calls[1]!;
  expect(read[1]?.method).toBe('GET');
  expect(new URL(String(read[0])).searchParams.get('ranges')).toBe("'시트 1'!B2:C1002");
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it.each([
  { properties: { sheetId: 18, title: '시트 1', gridProperties: { rowCount: 1000 } } },
  { properties: { sheetId: 17, title: '시트1', gridProperties: { rowCount: 1000 } } },
  { properties: { sheetId: 17, title: '시트 1', gridProperties: { rowCount: 1002 } } },
  { data: [] }
])('rejects identity/shape changes without leaking provider data', async overrides => {
  await expect(fixture(overrides).source.read()).rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
});
it('blocks projection source collision before contacting Google', async () => {
  const f = fixture();
  await expect(new GoogleRoomPinImportSource(id,17,account,id,f.fetcher).read()).rejects.toMatchObject({ reason: 'PROVIDER_CONFIGURATION_ERROR' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it('does not turn formulas or numeric values into PIN text', async () => {
  const f = fixture();
  f.payload.sheets[0]!.data[0]!.rowData[1]!.values[1] = { userEnteredValue: { formulaValue: 'synthetic formula' } } as never;
  expect((await f.source.read())[1]?.[1]).toBeNull();
});

const oauth = { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', refreshToken: 'synthetic-refresh' };
it('reuses photo OAuth via bounded refresh and GET without requesting broader scope', async () => {
  const f = fixture();
  const source = new GoogleRoomPinImportSource(id, 17, oauth, undefined, f.fetcher);
  expect(await source.read()).toEqual([['', '비번 '], ['701(1.5)', '701-001234']]);
  const [url, init] = f.fetcher.mock.calls[0]!;
  expect(url).toBe('https://oauth2.googleapis.com/token');
  expect(Object.fromEntries(init!.body as URLSearchParams)).toEqual({
    grant_type: 'refresh_token', client_id: oauth.clientId,
    client_secret: oauth.clientSecret, refresh_token: oauth.refreshToken
  });
  for (const [, request] of f.fetcher.mock.calls) {
    expect(request?.redirect).toBe('error');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  }
  expect(f.fetcher.mock.calls[1]![1]!.method).toBe('GET');
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it('prefers photo OAuth and preserves service account only when OAuth is entirely absent', () => {
  const env: Record<string, string> = { GOOGLE_DRIVE_CLIENT_ID: oauth.clientId,
    GOOGLE_DRIVE_CLIENT_SECRET: oauth.clientSecret, GOOGLE_DRIVE_REFRESH_TOKEN: oauth.refreshToken,
    GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL: account.email, GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY: account.privateKeyPem };
  expect(roomPinImportCredentials(key => env[key])).toEqual(oauth);
  expect(roomPinImportCredentials(key => key.startsWith('GOOGLE_SHEETS') ? env[key] : undefined)).toEqual(account);
});
it.each(['', 'bad\nvalue', 'x'.repeat(4097)])('rejects incomplete/invalid OAuth before Google without fallback', async clientSecret => {
  const f = fixture();
  await expect(new GoogleRoomPinImportSource(id, 17, { ...oauth, clientSecret }, undefined, f.fetcher).read())
    .rejects.toMatchObject({ reason: 'PROVIDER_CONFIGURATION_ERROR' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([[401, 'AUTHENTICATION_FAILED'], [403, 'AUTHORIZATION_FAILED'], [404, 'AUTHORIZATION_FAILED'],
  [429, 'RATE_LIMITED'], [500, 'PROVIDER_UNAVAILABLE']])('classifies Sheets %s without leaking response', async (status, reason) => {
  const transport = vi.fn(async (url: string | URL | Request) => String(url).includes('oauth2')
    ? new Response(JSON.stringify({ access_token: 'synthetic-access-token-value', token_type: 'Bearer' }))
    : new Response('sensitive-provider-response', { status: Number(status) }));
  await expect(new GoogleRoomPinImportSource(id, 17, oauth, undefined, transport).read())
    .rejects.toMatchObject({ reason, message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
  expect(transport).toHaveBeenCalledTimes(2);
});
it('blocks OAuth projection collision before refresh', async () => {
  const f = fixture();
  await expect(new GoogleRoomPinImportSource(id, 17, oauth, id, f.fetcher).read())
    .rejects.toMatchObject({ reason: 'PROVIDER_CONFIGURATION_ERROR' });
  expect(f.fetcher).not.toHaveBeenCalled();
});
it.each([[400, 'AUTHENTICATION_FAILED'], [429, 'RATE_LIMITED'], [503, 'PROVIDER_UNAVAILABLE']])('stops after OAuth %s without fallback or sheet request', async (status, reason) => {
  const transport = vi.fn(async () => new Response('sensitive-auth-response', { status: Number(status) }));
  await expect(new GoogleRoomPinImportSource(id, 17, oauth, undefined, transport).read())
    .rejects.toMatchObject({ reason, message: 'ROOM_PIN_SHEET_PROVIDER_FAILED' });
  expect(transport).toHaveBeenCalledTimes(1);
});
it.each(['bad\r\nAuthorization-value', 'x'.repeat(4097), 'short'])('rejects malformed access token without sending it to Sheets', async access_token => {
  const transport = vi.fn(async () => Response.json({ access_token, token_type: 'Bearer' }));
  await expect(new GoogleRoomPinImportSource(id, 17, oauth, undefined, transport).read())
    .rejects.toMatchObject({ reason: 'PROVIDER_RESPONSE_INVALID' });
  expect(transport).toHaveBeenCalledTimes(1);
});
