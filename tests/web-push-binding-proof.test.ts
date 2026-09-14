import { createECDH } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  issueWebPushBindingProof,
  validateWebPushBindingKeySet,
  verifyWebPushBindingProof,
} from '../src/modules/push-subscriptions/web-push-binding-proof.js';

const actor = {
  authUserId: '11000000-0000-4000-8000-000000000101',
  profileId: '11000000-0000-4000-8000-000000000001',
  sessionId: '11000000-0000-4000-8000-000000000901',
};
const publicKey = 'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU';
const secret = 'web-push-binding-proof-vector-secret-123456';
const nowMs = 1_789_156_800_000;
const vector = 'eyJ2IjoxLCJrIjoidmFwaWQtdjEiLCJwIjoiYVl2cVk5eEVvMFJtUF9GQ211b1FoQzN5ZTJ1Wkh2SllackxHd0N6Y3hiNCIsImkiOjE3ODkxNTY4MDAsImUiOjE3ODkxNTc0MDB9.4LD3jOoNUC5iW6tjMCc9g1andFsJEwJlWrCLbDiJ5Hg';

function nextPublicKey(): string {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh.getPublicKey().toString('base64url');
}

describe('Web Push VAPID binding proof', () => {
  it('matches the shared Node/Deno vector and binds actor/profile/session', async () => {
    const keys = { currentVersion: 'vapid-v1', currentPublicKey: publicKey, publicKeyring: {} };
    await expect(issueWebPushBindingProof(actor, keys, secret, nowMs)).resolves.toEqual({
      bindingProof: vector,
      proofExpiresAt: '2026-09-11T20:10:00.000Z',
    });
    await expect(verifyWebPushBindingProof(vector, actor, keys, secret, nowMs + 599_000)).resolves.toEqual({ keyVersion: 'vapid-v1', publicKey });
    for (const changed of [
      { ...actor, authUserId: '11000000-0000-4000-8000-000000000102' },
      { ...actor, profileId: '11000000-0000-4000-8000-000000000002' },
      { ...actor, sessionId: '11000000-0000-4000-8000-000000000902' },
    ]) {
      await expect(verifyWebPushBindingProof(vector, changed, keys, secret, nowMs)).rejects.toMatchObject({ reason: 'INVALID_PROOF' });
    }
  });

  it('accepts a prior key only while it remains in the bounded public keyring', async () => {
    const oldKeys = { currentVersion: 'vapid-v1', currentPublicKey: publicKey, publicKeyring: {} };
    const proof = (await issueWebPushBindingProof(actor, oldKeys, secret, nowMs)).bindingProof;
    const next = nextPublicKey();
    await expect(verifyWebPushBindingProof(proof, actor, {
      currentVersion: 'vapid-v2', currentPublicKey: next, publicKeyring: { 'vapid-v1': publicKey },
    }, secret, nowMs + 1_000)).resolves.toEqual({ keyVersion: 'vapid-v1', publicKey });
    await expect(verifyWebPushBindingProof(proof, actor, {
      currentVersion: 'vapid-v2', currentPublicKey: next, publicKeyring: {},
    }, secret, nowMs + 1_000)).rejects.toMatchObject({ reason: 'INVALID_PROOF' });
  });

  it('rejects expired/tampered proofs, malformed curve points and oversized keyrings', async () => {
    const keys = { currentVersion: 'vapid-v1', currentPublicKey: publicKey, publicKeyring: {} };
    await expect(verifyWebPushBindingProof(vector, actor, keys, secret, nowMs + 600_000)).rejects.toMatchObject({ reason: 'INVALID_PROOF' });
    await expect(verifyWebPushBindingProof(`${vector.slice(0, -1)}A`, actor, keys, secret, nowMs)).rejects.toMatchObject({ reason: 'INVALID_PROOF' });
    await expect(validateWebPushBindingKeySet({
      ...keys,
      currentPublicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 0xff)]).toString('base64url'),
    })).rejects.toMatchObject({ reason: 'INVALID_CONFIGURATION' });
    const publicKeyring = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`v${index}`, nextPublicKey()]));
    await expect(validateWebPushBindingKeySet({ ...keys, publicKeyring })).rejects.toMatchObject({ reason: 'INVALID_CONFIGURATION' });
  });
});
