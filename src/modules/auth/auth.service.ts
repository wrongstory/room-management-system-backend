import { createHash, randomUUID } from 'node:crypto';
import type { Actor, AppRole } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import { requestHash } from '../../lib/command.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { toSupabaseAuthPassword } from './password.js';

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

type PasswordChangeState =
  | 'absent'
  | 'execute'
  | 'busy'
  | 'recover'
  | 'completed'
  | 'failed'
  | 'inconsistent'
  | 'other_in_progress';

interface PasswordChangeReceiptState {
  state: PasswordChangeState;
  attemptCount?: number;
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
      password: toSupabaseAuthPassword(input.password)
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
    const activeSessionId = sessionId(actor.accessToken);
    if (!activeSessionId) {
      throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.');
    }
    const fingerprint = requestHash({
      actorProfileId: actor.profileId,
      command: 'account.password.change'
    });
    const inspected = await this.passwordChangeRpc('inspect_password_change', {
      p_actor_profile_id: actor.profileId,
      p_auth_user_id: actor.authUserId,
      p_session_id: activeSessionId,
      p_idempotency_key: idempotencyKey
    });

    if (inspected.state === 'completed') {
      if (!(await this.verifyPassword(actor.profileId, newPassword))) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 비밀번호 변경에 사용한 Idempotency-Key입니다.');
      }
      return;
    }
    if (inspected.state === 'failed') {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 종료된 비밀번호 변경에 사용한 Idempotency-Key입니다.');
    }
    if (inspected.state === 'busy' || inspected.state === 'other_in_progress') {
      throw new AppError(409, 'PASSWORD_CHANGE_IN_PROGRESS', '다른 비밀번호 변경 요청이 처리 중입니다.');
    }

    let currentVerified = false;
    if (inspected.state === 'absent') {
      currentVerified = await this.verifyPassword(actor.profileId, currentPassword);
      if (!currentVerified) {
        throw new AppError(401, 'INVALID_CURRENT_PASSWORD', '현재 비밀번호가 올바르지 않습니다.');
      }
    }

    const claimDigest = createHash('sha256')
      .update(`password-change-claim:v1\0${randomUUID()}`)
      .digest('hex');
    const prepared = await this.passwordChangeRpc('prepare_password_change', {
      p_actor_profile_id: actor.profileId,
      p_auth_user_id: actor.authUserId,
      p_session_id: activeSessionId,
      p_idempotency_key: idempotencyKey,
      p_request_hash: fingerprint,
      p_claim_digest: claimDigest
    });

    if (prepared.state === 'completed') {
      if (!(await this.verifyPassword(actor.profileId, newPassword))) {
        throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 비밀번호 변경에 사용한 Idempotency-Key입니다.');
      }
      return;
    }
    if (prepared.state === 'failed') {
      throw new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 종료된 비밀번호 변경에 사용한 Idempotency-Key입니다.');
    }
    if (prepared.state === 'busy' || prepared.state === 'other_in_progress') {
      throw new AppError(409, 'PASSWORD_CHANGE_IN_PROGRESS', '다른 비밀번호 변경 요청이 처리 중입니다.');
    }

    if (prepared.state === 'recover') {
      if (await this.verifyPassword(actor.profileId, newPassword)) {
        await this.completePasswordChange(actor, activeSessionId, idempotencyKey, fingerprint, claimDigest);
        return;
      }
      await this.finishPasswordChangeFailure(
        actor,
        activeSessionId,
        idempotencyKey,
        claimDigest,
        'PASSWORD_STATE_INCONSISTENT'
      );
      throw new AppError(
        500,
        'PASSWORD_STATE_INCONSISTENT',
        '비밀번호 변경 결과를 안전하게 확인할 수 없습니다. 관리자에게 비밀번호 초기화를 요청해 주세요.'
      );
    }

    if (prepared.state !== 'execute' || !currentVerified) {
      throw new AppError(500, 'PASSWORD_STATE_INCONSISTENT', '비밀번호 변경 상태가 올바르지 않습니다.');
    }

    const { error: updateError } = await this.clients.admin.auth.admin.updateUserById(
      actor.authUserId,
      { password: toSupabaseAuthPassword(newPassword) }
    );
    if (updateError) {
      if (await this.verifyPassword(actor.profileId, newPassword)) {
        await this.completePasswordChange(actor, activeSessionId, idempotencyKey, fingerprint, claimDigest);
        return;
      }
      if (await this.verifyPassword(actor.profileId, currentPassword)) {
        await this.finishPasswordChangeFailure(
          actor,
          activeSessionId,
          idempotencyKey,
          claimDigest,
          'AUTH_PASSWORD_CHANGE_FAILED'
        );
        throw new AppError(502, 'AUTH_PASSWORD_CHANGE_FAILED', '비밀번호를 변경하지 못했습니다.');
      }
      await this.finishPasswordChangeFailure(
        actor,
        activeSessionId,
        idempotencyKey,
        claimDigest,
        'PASSWORD_STATE_INCONSISTENT'
      );
      throw new AppError(
        500,
        'PASSWORD_STATE_INCONSISTENT',
        '비밀번호 변경 결과를 안전하게 확인할 수 없습니다. 관리자에게 비밀번호 초기화를 요청해 주세요.'
      );
    }

    await this.completePasswordChange(actor, activeSessionId, idempotencyKey, fingerprint, claimDigest);
  }

  private async verifyPassword(profileId: string, password: string): Promise<boolean> {
    const { data, error } = await this.clients.publicClient.auth.signInWithPassword({
      email: syntheticEmail(profileId),
      password: toSupabaseAuthPassword(password)
    });
    if (error || !data.session) {
      return false;
    }
    const { error: signOutError } = await this.clients.admin.auth.admin.signOut(
      data.session.access_token,
      'local'
    );
    if (signOutError) {
      throw new AppError(
        500,
        'PASSWORD_VERIFICATION_SESSION_REVOKE_FAILED',
        '비밀번호 확인 세션을 안전하게 폐기하지 못했습니다.'
      );
    }
    return true;
  }

  private async passwordChangeRpc(
    name: string,
    parameters: Record<string, string>
  ): Promise<PasswordChangeReceiptState> {
    const { data, error } = await this.clients.admin.rpc(name, parameters);
    if (error || !data || typeof data !== 'object' || typeof (data as { state?: unknown }).state !== 'string') {
      throw this.passwordChangeDatabaseError(error);
    }
    return data as PasswordChangeReceiptState;
  }

  private async completePasswordChange(
    actor: Actor,
    activeSessionId: string,
    idempotencyKey: string,
    fingerprint: string,
    claimDigest: string
  ): Promise<void> {
    const { error } = await this.clients.admin.rpc('complete_password_change', {
      p_actor_profile_id: actor.profileId,
      p_auth_user_id: actor.authUserId,
      p_session_id: activeSessionId,
      p_idempotency_key: idempotencyKey,
      p_request_hash: fingerprint,
      p_claim_digest: claimDigest
    });
    if (error) {
      throw this.passwordChangeDatabaseError(error, true);
    }
  }

  private async finishPasswordChangeFailure(
    actor: Actor,
    activeSessionId: string,
    idempotencyKey: string,
    claimDigest: string,
    failureCode: 'AUTH_PASSWORD_CHANGE_FAILED' | 'PASSWORD_STATE_INCONSISTENT'
  ): Promise<void> {
    const { error } = await this.clients.admin.rpc('finish_password_change_failure', {
      p_actor_profile_id: actor.profileId,
      p_auth_user_id: actor.authUserId,
      p_session_id: activeSessionId,
      p_idempotency_key: idempotencyKey,
      p_claim_digest: claimDigest,
      p_failure_code: failureCode
    });
    if (error) {
      throw new AppError(
        500,
        'PASSWORD_STATE_INCONSISTENT',
        '비밀번호 변경 결과를 저장하지 못했습니다. 관리자에게 비밀번호 초기화를 요청해 주세요.'
      );
    }
  }

  private passwordChangeDatabaseError(
    error: { message?: string } | null,
    completion = false
  ): AppError {
    const message = error?.message ?? '';
    if (message.includes('IDEMPOTENCY_KEY_REUSED') || message.includes('PASSWORD_CHANGE_CLAIM_STALE')) {
      return new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 비밀번호 변경에 사용한 Idempotency-Key입니다.');
    }
    if (message.includes('PASSWORD_CHANGE_IN_PROGRESS')) {
      return new AppError(409, 'PASSWORD_CHANGE_IN_PROGRESS', '다른 비밀번호 변경 요청이 처리 중입니다.');
    }
    if (message.includes('SESSION_REVOKED')) {
      return new AppError(401, 'SESSION_REVOKED', '로그인이 만료되었습니다. 다시 로그인해 주세요.');
    }
    if (message.includes('PASSWORD_CHANGE_SESSION_MISMATCH')) {
      return new AppError(
        409,
        'PASSWORD_CHANGE_SESSION_MISMATCH',
        '비밀번호 변경은 시작한 로그인 세션에서만 재시도할 수 있습니다.'
      );
    }
    if (message.includes('ACTIVE_ACCOUNT_REQUIRED')) {
      return new AppError(403, 'ACCOUNT_INACTIVE', '현재 사용할 수 없는 계정입니다.');
    }
    return new AppError(
      500,
      completion ? 'PASSWORD_STATE_UPDATE_FAILED' : 'PASSWORD_CHANGE_RECEIPT_FAILED',
      completion
        ? '비밀번호는 변경됐을 수 있습니다. 같은 Idempotency-Key로 다시 시도해 주세요.'
        : '비밀번호 변경 요청 상태를 준비하지 못했습니다.'
    );
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
