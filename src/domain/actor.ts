export type AppRole = 'admin' | 'maid';

export interface Actor {
  authUserId: string;
  profileId: string;
  displayName: string;
  role: AppRole;
  accessToken: string;
}

