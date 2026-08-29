export type AppRole = 'developer' | 'admin' | 'maid';

export function canManageAccounts(role: AppRole): boolean {
  return role === 'developer' || role === 'admin';
}

export interface Actor {
  authUserId: string;
  profileId: string;
  displayName: string;
  role: AppRole;
  mustChangePassword: boolean;
  accessToken: string;
}
