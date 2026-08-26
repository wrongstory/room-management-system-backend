export type AppRole = 'admin' | 'maid';

export interface Actor {
  authUserId: string;
  profileId: string;
  displayName: string;
  role: AppRole;
  mustChangePassword: boolean;
  accessToken: string;
}
