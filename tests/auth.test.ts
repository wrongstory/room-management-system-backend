import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClients } from '../src/lib/supabase.js';
import { SupabaseAuthService } from '../src/modules/auth/auth.service.js';

describe('password change consistency', () => {
  it('restores the previous Auth password when the profile transaction fails', async () => {
    const updateUserById = vi.fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: null });
    const clients = {
      publicClient: {
        auth: {
          signInWithPassword: vi.fn(async () => ({
            data: { session: { access_token: 'verification-token' } },
            error: null
          }))
        }
      },
      admin: {
        auth: {
          admin: {
            updateUserById,
            signOut: vi.fn(async () => ({ error: null }))
          }
        },
        rpc: vi.fn(async () => ({ data: null, error: { message: 'database unavailable' } }))
      }
    } as unknown as SupabaseClients;
    const service = new SupabaseAuthService(clients);

    await expect(service.changePassword({
      authUserId: 'auth-user-id',
      profileId: 'profile-id',
      displayName: '관리자',
      role: 'admin',
      mustChangePassword: true,
      accessToken: 'access-token'
    }, '1234', '654321', 'password-change-0001')).rejects.toMatchObject({
      code: 'PASSWORD_STATE_UPDATE_FAILED'
    });

    expect(updateUserById).toHaveBeenNthCalledWith(1, 'auth-user-id', { password: '654321' });
    expect(updateUserById).toHaveBeenNthCalledWith(2, 'auth-user-id', { password: '1234' });
  });

  it('reports manual recovery when Auth password rollback also fails', async () => {
    const clients = {
      publicClient: {
        auth: {
          signInWithPassword: vi.fn(async () => ({
            data: { session: { access_token: 'verification-token' } },
            error: null
          }))
        }
      },
      admin: {
        auth: {
          admin: {
            updateUserById: vi.fn()
              .mockResolvedValueOnce({ error: null })
              .mockResolvedValueOnce({ error: { message: 'rollback failed' } }),
            signOut: vi.fn(async () => ({ error: null }))
          }
        },
        rpc: vi.fn(async () => ({ data: null, error: { message: 'database unavailable' } }))
      }
    } as unknown as SupabaseClients;
    const service = new SupabaseAuthService(clients);

    await expect(service.changePassword({
      authUserId: 'auth-user-id',
      profileId: 'profile-id',
      displayName: '관리자',
      role: 'admin',
      mustChangePassword: true,
      accessToken: 'access-token'
    }, '1234', '654321', 'password-change-0002')).rejects.toMatchObject({
      code: 'PASSWORD_STATE_INCONSISTENT'
    });
  });
});
