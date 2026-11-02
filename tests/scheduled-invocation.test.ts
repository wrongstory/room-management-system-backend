import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type ScheduledAudience, scheduledInvokeMode, verifyScheduledInvocation } from '../supabase/functions/_shared/scheduled-invocation.js';

const at = '1792893600';
const now = Number(at) * 1000;
const key = Buffer.from('synthetic-scheduler-key-for-tests-only-12345');
const audience: ScheduledAudience = 'notification-delivery:aodikrxcczbogjpsjwjt';
function signed(target: ScheduledAudience = audience, timestamp = at) {
  const nonce = '6a54b053f31449dc9b052fe1b96210ae';
  // Independent Node implementation corresponds to the PostgreSQL HMAC input bytes.
  const signature = createHmac('sha256', key).update(`rms-scheduled-invocation-v1\n${target}\n${timestamp}\n${nonce}\nPOST`).digest('hex');
  return new Headers({ 'x-rms-invoke-at': timestamp, 'x-rms-invoke-nonce': nonce, 'x-rms-invoke-signature': signature });
}
describe('scheduled worker signatures', () => {
  it('requires explicit mode selection and never downgrades unknown configuration', () => {
    expect(scheduledInvokeMode(undefined)).toBe('legacy');
    expect(scheduledInvokeMode('signed-v1')).toBe('signed-v1');
    for (const value of ['', 'SIGNED-V1', 'signed', 'false']) expect(() => scheduledInvokeMode(value)).toThrow();
  });
  it('verifies independent HMAC without transmitting the key', async () => {
    const headers = signed();
    expect(await verifyScheduledInvocation(headers, key, audience, now)).toBe(true);
    expect(JSON.stringify([...headers])).not.toContain(key.toString());
  });
  it.each([-5001, 60000, 90000])('rejects clock outside the bounded window %d', async delta => {
    expect(await verifyScheduledInvocation(signed(), key, audience, now + delta)).toBe(false);
  });
  it.each([-5000, 0, 59999])('accepts only the documented bounded window %d', async delta => {
    expect(await verifyScheduledInvocation(signed(), key, audience, now + delta)).toBe(true);
  });
  it('binds project/function purpose and key', async () => {
    expect(await verifyScheduledInvocation(signed('reservation-backup-monitor:matalcofimnhuzslfhdd'), key, audience, now)).toBe(false);
    expect(await verifyScheduledInvocation(signed(), Buffer.alloc(32, 1), audience, now)).toBe(false);
  });
  it.each([
    ['x-rms-invoke-at', '01792893600'], ['x-rms-invoke-at', `${at}, ${at}`],
    ['x-rms-invoke-nonce', 'A'.repeat(32)], ['x-rms-invoke-nonce', '../anything'],
    ['x-rms-invoke-signature', '0'.repeat(64)], ['x-rms-invoke-signature', 'a'.repeat(65)],
    ['x-rms-invoke-signature', ''],
  ])('rejects malformed or altered %s', async (name, value) => {
    const headers = signed(); headers.set(name, value);
    expect(await verifyScheduledInvocation(headers, key, audience, now)).toBe(false);
  });
  it('rejects missing headers, invalid clock and key size without throwing', async () => {
    expect(await verifyScheduledInvocation(new Headers(), key, audience, now)).toBe(false);
    expect(await verifyScheduledInvocation(signed(), key, audience, NaN)).toBe(false);
    expect(await verifyScheduledInvocation(signed(), new Uint8Array(31), audience, now)).toBe(false);
    expect(await verifyScheduledInvocation(signed(), new Uint8Array(4097), audience, now)).toBe(false);
  });
});
