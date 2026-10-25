import { describe, expect, it, vi } from 'vitest';
const processes = vi.hoisted(() => ({ execFileSync: vi.fn(() => { throw new Error('NO_DB'); }), spawn: vi.fn(() => { throw new Error('NO_DB'); }) }));
vi.mock('node:child_process', () => processes);
const { assertAuthContextFresh, assertAuthContextRace } = await import('../scripts/test-auth-context-concurrency.mjs');
describe('#442 race runner source/preflight only; actual DB NOT RUN', () => {
  it('imports without subprocess or DB execution', () => {
    expect(processes.execFileSync).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();
  });
  it('requires fresh empty local data and migration count/head (not a full history/hash proof)', () => {
    const manifest = { totalCount: 113, head: 'common_auth_context_read' };
    const value = { users: 0, profiles: 0, sessions: 0, targets: 0, count: 113, head: manifest.head };
    expect(() => assertAuthContextFresh(value, manifest)).not.toThrow();
    for (const key of ['users', 'profiles', 'sessions', 'targets', 'count']) {
      expect(() => assertAuthContextFresh({ ...value, [key]: 1 }, manifest)).toThrow();
    }
    expect(() => assertAuthContextFresh({ ...value, head: 'previous' }, manifest)).toThrow();
  });
  it('does not report a race PASS for stale success, process failure or missing output', () => {
    expect(() => assertAuthContextRace({ exitCode: 0, output: 'SESSION_REVOKED\n' })).not.toThrow();
    for (const output of ['OK', '', 'SESSION_REVOKED\nOK']) {
      expect(() => assertAuthContextRace({ exitCode: 0, output })).toThrow();
    }
    expect(() => assertAuthContextRace({ exitCode: 1, output: 'SESSION_REVOKED' })).toThrow();
  });
});
