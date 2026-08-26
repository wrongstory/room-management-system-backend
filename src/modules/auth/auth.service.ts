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
  changePassword(
    actor: Actor,
    currentPassword: string,
    newPassword: string,
    idempotencyKey: string
  ): Promise<void>;
}

interface ProfileRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  role: AppRole;
  status: string;
  locked_until: string | null;
  must_change_password: boolean;
}

function normalizeLoginId(loginId: string): string {
  return loginId.normalize('NFKC').trim().toLocaleLowerCase('ko-KR');
}

function syntheticEmail(profileId: string): string {
  return `user-${profileId}@auth.castletheart.invalid`;
}

function sessionId(accessToken: string): string | null {
  try {
    const payload = accessToken.split('.')[1];
    if (!payload) {
      return null;
    }
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      session_id?: unknown;
    };
    return typeof claims.session_id === 'string' ? claims.session_id : null;
  } catch {
    return null;
  }
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

    const { data: retiredAliasCount, error: successError } = await this.clients.admin.rpc(
      'record_login_success',
      { p_profile_id: profile.id, p_login_alias_normalized: alias }
    );
    if (successError) {
      await this.clients.admin.auth.admin.signOut(data.session.access_token, 'local');
      throw new AppError(500, 'LOGIN_STATE_UPDATE_FAILED', '로그인 상태를 갱신하지 못했습니다.');
    }
    if (typeof retiredAliasCount === 'number' && retiredAliasCount > 0) {
      await this.clients.admin.auth.admin.signOut(data.session.access_token, 'others');
    }

    return {
      accessToken: data.session.access_token,
      refreshToken: data.session.refresh_token,
      expiresIn: data.session.expires_in,
      user: {
        authUserId: profile.auth_user_id,
        profileId: profile.id,
        displayName: profile.display_name,
        role: profile.role,
        mustChangePassword: profile.must_change_password
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

    const activeSessionId = sessionId(accessToken);
    if (!activeSessionId) {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
    }
    const { data: isActiveSession, error: sessionError } = await this.clients.admin.rpc(
      'is_active_auth_session',
      { p_auth_user_id: data.user.id, p_session_id: activeSessionId }
    );
    if (sessionError || isActiveSession !== true) {
      throw new AppError(401, 'SESSION_REVOKED', '로그인이 만료되었습니다. 다시 로그인해 주세요.');
    }

    return {
      authUserId: profile.auth_user_id,
      profileId: profile.id,
      displayName: profile.display_name,
      role: profile.role,
      mustChangePassword: profile.must_change_password,
      accessToken
    };
  }

  async changePassword(
    actor: Actor,
    currentPassword: string,
    newPassword: string,
    idempotencyKey: string
  ): Promise<void> {
    const { data: verification, error: verificationError } =
      await this.clients.publicClient.auth.signInWithPassword({
        email: syntheticEmail(actor.profileId),
        password: currentPassword
      });
    if (verificationError || !verification.session) {
      throw new AppError(401, 'INVALID_CURRENT_PASSWORD', '현재 비밀번호가 올바르지 않습니다.');
    }

    const { error: updateError } = await this.clients.admin.auth.admin.updateUserById(
      actor.authUserId,
      { password: newPassword }
    );
    if (updateError) {
      await this.clients.admin.auth.admin.signOut(verification.session.access_token, 'local');
      throw new AppError(502, 'AUTH_PASSWORD_CHANGE_FAILED', '비밀번호를 변경하지 못했습니다.');
    }

    await this.clients.admin.auth.admin.signOut(actor.accessToken, 'others');
    const { error } = await this.clients.admin.rpc('complete_password_change', {
      p_actor_profile_id: actor.profileId,
      p_idempotency_key: idempotencyKey
    });
    if (error) {
      throw new AppError(500, 'PASSWORD_STATE_UPDATE_FAILED', '비밀번호 변경 상태를 저장하지 못했습니다.');
    }
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
      .select('id,auth_user_id,display_name,role,status,locked_until,must_change_password')
      .eq(column, value)
      .single();

    if (error || !data) {
      throw new AppError(401, 'PROFILE_NOT_FOUND', '계정 프로필을 찾을 수 없습니다.');
    }

    return data as ProfileRow;
  }
}
