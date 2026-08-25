import type { SupabaseClients } from '../../lib/supabase.js';
import { AppError } from '../../lib/app-error.js';
import type { Actor, AppRole } from '../../domain/actor.js';

export interface LoginInput {
  loginId: string;
  password: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: Omit<Actor, 'accessToken'>;
}

export interface AuthService {
  login(input: LoginInput): Promise<LoginResult>;
  authenticate(accessToken: string): Promise<Actor>;
}

interface ProfileRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  role: AppRole;
  status: string;
  locked_until: string | null;
}

function normalizeLoginId(loginId: string): string {
  return loginId.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
}

function syntheticEmail(profileId: string): string {
  return `user-${profileId}@auth.castletheart.invalid`;
}

export class SupabaseAuthService implements AuthService {
  constructor(private readonly clients: SupabaseClients) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const alias = normalizeLoginId(input.loginId);
    const { data: aliasRow, error: aliasError } = await this.clients.admin
      .from('login_aliases')
      .select('profile_id')
      .eq('alias_normalized', alias)
      .eq('active', true)
      .maybeSingle();

    if (aliasError) {
      throw new AppError(500, 'AUTH_LOOKUP_FAILED', '로그인 정보를 확인하지 못했습니다.');
    }
    if (!aliasRow) {
      throw new AppError(401, 'INVALID_CREDENTIALS', '아이디 또는 로그인 비밀번호가 올바르지 않습니다.');
    }

    const profile = await this.getProfileById(aliasRow.profile_id);
    if (profile.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', '현재 사용할 수 없는 계정입니다.');
    }
    if (profile.locked_until && Date.parse(profile.locked_until) > Date.now()) {
      throw new AppError(423, 'ACCOUNT_LOCKED', '로그인 실패가 반복되어 계정이 잠겼습니다. 잠시 후 다시 시도해 주세요.');
    }

    const { data, error } = await this.clients.publicClient.auth.signInWithPassword({
      email: syntheticEmail(profile.id),
      password: input.password
    });

    if (error || !data.session) {
      await this.clients.admin.rpc('record_login_failure', { p_profile_id: profile.id });
      throw new AppError(401, 'INVALID_CREDENTIALS', '아이디 또는 로그인 비밀번호가 올바르지 않습니다.');
    }

    await this.clients.admin.rpc('record_login_success', { p_profile_id: profile.id });

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in,
      user: {
        authUserId: profile.auth_user_id,
        profileId: profile.id,
        displayName: profile.display_name,
        role: profile.role
      }
    };
  }

  async authenticate(accessToken: string): Promise<Actor> {
    const { data, error } = await this.clients.publicClient.auth.getUser(accessToken);
    if (error || !data.user) {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
    }

    const profile = await this.getProfileByAuthUserId(data.user.id);
    if (profile.status !== 'active') {
      throw new AppError(403, 'ACCOUNT_INACTIVE', '현재 사용할 수 없는 계정입니다.');
    }

    return {
      authUserId: profile.auth_user_id,
      profileId: profile.id,
      displayName: profile.display_name,
      role: profile.role,
      accessToken
    };
  }

  private async getProfileById(profileId: string): Promise<ProfileRow> {
    return this.fetchProfile('id', profileId);
  }

  private async getProfileByAuthUserId(authUserId: string): Promise<ProfileRow> {
    return this.fetchProfile('auth_user_id', authUserId);
  }

  private async fetchProfile(column: 'id' | 'auth_user_id', value: string): Promise<ProfileRow> {
    const { data, error } = await this.clients.admin
      .from('profiles')
      .select('id,auth_user_id,display_name,role,status,locked_until')
      .eq(column, value)
      .single();

    if (error || !data) {
      throw new AppError(401, 'PROFILE_NOT_FOUND', '계정 프로필을 찾을 수 없습니다.');
    }

    return data as ProfileRow;
  }
}
