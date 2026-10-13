import { generateKeyPairSync } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { GoogleRoomPinImportSource } from '../src/modules/rooms/google-sheets-pin-import.js';
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
