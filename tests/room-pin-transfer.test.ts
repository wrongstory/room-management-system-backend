import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { RoomPinTransfer, parseRoomPinRows, RoomPinTransferError } from '../src/modules/rooms/room-pin-transfer.js';
import { encryptRoomPin, decryptRoomPin, isValidRoomPin } from '../src/modules/rooms/room-pin-crypto.js';
import { roomPinTransferDatabaseError, roomPinTransferFailure } from '../src/modules/rooms/room-pin-transfer-http.js';
import { createRoomPinTransferRoutes } from '../src/modules/rooms/room-pin-transfer.routes.js';
import type { Actor } from '../src/domain/actor.js';

const actor = { profileId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222' };
const cryptoConfig = { key: Buffer.alloc(32, 3).toString('base64'), keyVersion: 'v1', keyring: {}, environment: 'test', projectRef: 'local' };
const secret = 'synthetic-import-hmac-secret-'.repeat(2);
const room = { roomId: '33333333-3333-4333-8333-333333333333', roomNumber: '701', stateVersion: 1, pinVersion: 0, envelope: null };
function fixture(Type = RoomPinTransfer) {
  let time = 1791800000000;
  const rows: unknown[][] = [['', '비번 '], ['701(1.5)', '701-001234']];
  const rooms = [{ ...room }];
  const source = { identity: 'synthetic-source', read: vi.fn(async () => rows) };
  let receipt: unknown = null;
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'get_room_pin_transfer_snapshot') return args.p_expected ? { checked: true } : rooms;
    if (args.p_candidates === null) return receipt;
    receipt = { updated: (args.p_candidates as unknown[]).length, unchanged: args.p_unchanged };
    return receipt;
  });
  return { rows, rooms, source, rpc, advance: () => { time += 300001; },
    service: new Type(rpc, cryptoConfig, source, secret, () => time) };
}

describe('room PIN import validation', () => {
  it('matches master identity and preserves full strings regardless of room type or row order', () => {
    const another = { ...room, roomId: '44444444-4444-4444-8444-444444444444', roomNumber: '702' };
    const result = parseRoomPinRows([['','비번 '], ['702(2)', '702-0012'], ['피트니스','six digit facility'],
      ['701(1.5)', '701-00-Ab한글!'], []], [room, another]);
    expect(result.issues).toEqual([]);
    expect(result.ignored).toBe(1);
    expect(result.candidates.map(c => c.credential)).toEqual(['701-00-Ab한글!', '702-0012']);
  });
  it.each([
    [['701','702-0012'], 'INVALID_ROOM_CREDENTIAL'],
    [['701',''], 'INVALID_ROOM_CREDENTIAL'],
    [['701',7010012], 'INVALID_ROOM_CREDENTIAL'],
    [['999','999-1234'], 'UNKNOWN_ROOM'],
    [['장기숙박','001234'], 'UNKNOWN_ROOM'],
  ] as const)('rejects invalid cell data without including it in diagnostics', (row, code) => {
    const result = parseRoomPinRows([['','비번'], [...row]], [room]);
    expect(result.issues).toEqual([{ row: 3, code }]);
    expect(result.candidates).toEqual([]);
  });
  it('rejects duplicates, missing header and no room rows', () => {
    expect(parseRoomPinRows([['','비번'],['701','701-1234'],['701','701-5678']], [room]).issues)
      .toEqual([{ row: 4, code: 'DUPLICATE_ROOM' }]);
    expect(parseRoomPinRows([], [room]).issues[0]?.code).toBe('INVALID_SHEET_HEADER');
    expect(parseRoomPinRows([['','비번']], [room]).issues[0]?.code).toBe('NO_ROOM_ROWS');
  });
  it.each(['0012','001234','a','A-비번!','a'.repeat(128),'🔑'.repeat(32)])('round-trips supported plaintext %s', async value => {
    expect(isValidRoomPin(value)).toBe(true);
    const envelope = await encryptRoomPin('701-' + value, room.roomId, 1, cryptoConfig);
    expect(await decryptRoomPin(envelope, room.roomId, '701', 1, cryptoConfig)).toBe('701-' + value);
  });
  it.each(['', ' ', 'a'.repeat(129),'🔑'.repeat(33), '\u0000','\uD800','\uFFFF'])('bounds invalid input', value => {
    expect(isValidRoomPin(value)).toBe(false);
  });
});

describe.each([['Node',RoomPinTransfer]] as const)('%s transfer orchestration', (_name, Type) => {
  it('previews without plaintext then encrypts all candidates and supports response-loss replay', async () => {
    const f = fixture(Type);
    const preview = await f.service.preview(actor);
    expect(preview).toMatchObject({ valid: true, total: 1, changed: 1, unchanged: 0 });
    expect(JSON.stringify(preview)).not.toContain('001234');
    expect(await f.service.apply(actor, preview.previewToken!, 'import-key-001')).toEqual({ updated: 1, unchanged: 0 });
    const args = f.rpc.mock.calls.find(([name, args]) => name === 'apply_room_pin_transfer' && args.p_candidates !== null)![1];
    expect(JSON.stringify(args)).not.toContain('701-001234');
    const candidate = (args.p_candidates as Array<Parameters<typeof decryptRoomPin>[0]>)[0]!;
    expect(await decryptRoomPin(candidate, room.roomId, '701', 1, cryptoConfig)).toBe('701-001234');
    f.advance(); f.source.read.mockRejectedValue(new Error('Google down'));
    expect(await f.service.apply(actor, preview.previewToken!, 'import-key-001')).toEqual({ updated: 1, unchanged: 0 });
    expect(f.source.read).toHaveBeenCalledTimes(2);
  });
  it.each(['source','db','expiry','token','session'] as const)('rejects changed %s before mutation', async change => {
    const f = fixture(Type), preview = await f.service.preview(actor);
    let token = preview.previewToken!, identity = actor;
    if (change === 'source') f.rows[1] = ['701','701-other-value'];
    if (change === 'db') f.rooms[0]!.stateVersion++;
    if (change === 'expiry') f.advance();
    if (change === 'token') token = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    if (change === 'session') identity = { ...actor, sessionId: '55555555-5555-4555-8555-555555555555' };
    await expect(f.service.apply(identity, token, 'import-key-001')).rejects.toBeInstanceOf(Error);
    expect(f.rpc.mock.calls.some(([name,args]) => name === 'apply_room_pin_transfer' && args.p_candidates !== null)).toBe(false);
  });
  it('withholds token for any invalid row and does not modify any rooms', async () => {
    const f = fixture(Type); f.rows.push(['unknown', 'sensitive-secret']);
    expect(await f.service.preview(actor)).toMatchObject({ valid: false, previewToken: null });
    expect(f.rpc.mock.calls.every(([name]) => name === 'get_room_pin_transfer_snapshot')).toBe(true);
  });
  it('exports stored credentials and rechecks authorization/version before releasing bytes', async () => {
    const envelope = await encryptRoomPin('701-001234', room.roomId, 1, cryptoConfig);
    const rpc = vi.fn(async (_name: string, args: Record<string,unknown>) => args.p_expected
      ? { checked: true } : [{ ...room, pinVersion: 1, envelope }]);
    const service = new Type(rpc, cryptoConfig);
    const file = await service.export(actor);
    expect(Buffer.from(file).subarray(0,4).toString('hex')).toBe('504b0304');
    const decoded = new TextDecoder().decode(file);
    expect(decoded).toContain('701-001234'); expect(decoded).toContain('시트 1');
    expect(decoded).toContain('r="C3" t="inlineStr"');
    expect(rpc.mock.calls[1]?.[1]).toMatchObject({ p_export: true, p_expected: [{ roomId: room.roomId, roomNumber: '701', stateVersion: 1, pinVersion: 1 }] });
  });
});

describe('HTTP authorization and sanitization', () => {
  it.each(['developer','maid','admin'] as const)('allows only admin (%s)', async role => {
    const f = fixture(), app = Fastify();
    app.decorateRequest('actor');
    app.decorate('authenticate', async (request: { actor: Actor }) => { request.actor = {
      profileId: actor.profileId, authUserId: actor.profileId, displayName: 'synthetic', role,
      mustChangePassword: false, accessToken: 'e30.' + Buffer.from(JSON.stringify({ session_id: actor.sessionId })).toString('base64url') + '.sig'
    }; });
    app.decorate('requirePasswordChanged', async () => {});
    await app.register(createRoomPinTransferRoutes(f.service), { prefix: '/v1/rooms/pins' });
    const response = await app.inject({ method: 'POST', url: '/v1/rooms/pins/import/preview', payload: {} });
    expect(response.statusCode).toBe(role === 'admin' ? 200 : 403);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.source.read).toHaveBeenCalledTimes(role === 'admin' ? 1 : 0);
    await app.close();
  });
  it('never returns raw DB/provider/crypto messages', () => {
    expect(roomPinTransferFailure(roomPinTransferDatabaseError('raw secret 701-1234'))).toMatchObject({ status: 500, code: 'ROOM_PIN_TRANSFER_FAILED' });
    expect(roomPinTransferFailure(new RoomPinTransferError('SESSION_REVOKED'))).toMatchObject({ status: 401 });
  });
});
