import { createHmac, randomUUID } from 'node:crypto';
import { type Actor, type AppRole, canManageAccounts } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { isPersonalPassword, toSupabaseAuthPassword } from '../auth/password.js';

export type ManagedRole = Exclude<AppRole, 'developer'>;

export type AccountStatus =
  | 'active'
  | 'deactivation_pending'
  | 'upload_only'
  | 'inactive'
  | 'departed';

export interface Account {
  id: string;
  displayName: string;
  loginId: string;
  role: AppRole;
  status: AccountStatus;
  phoneLastFour: string | null;
  mustChangePassword: boolean;
  failedLoginCount: number;
  lockedUntil: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAccountInput {
  displayName: string;
  role: ManagedRole;
  phone: string;
  idempotencyKey: string;
}

export interface AccountMutationInput {
  targetProfileId: string;
  idempotencyKey: string;
}

export interface ChangeAccountRoleInput extends AccountMutationInput {
  role: ManagedRole;
}

export interface ChangeAccountStatusInput extends AccountMutationInput {
  status: Extract<AccountStatus, 'active' | 'inactive' | 'departed'>;
  reasonCode: string;
}

export interface CreatedAccount {
  account: Account;
  temporaryPassword: string;
}

export interface BootstrapDeveloperInput {
  displayName: string;
  phone: string;
  password: string;
  idempotencyKey: string;
}

export interface AccountService {
  list(actor: Actor): Promise<Account[]>;
  create(actor: Actor, input: CreateAccountInput): Promise<CreatedAccount>;
  changeRole(actor: Actor, input: ChangeAccountRoleInput): Promise<Account>;
  changeStatus(actor: Actor, input: ChangeAccountStatusInput): Promise<Account>;
  unlock(actor: Actor, input: AccountMutationInput): Promise<Account>;
  resetPassword(actor: Actor, input: AccountMutationInput): Promise<Account>;
}

interface ProfileRow {
  id: string;
  auth_user_id: string;
  display_name: string;
  display_name_normalized: string;
  login_id: string;
  login_id_normalized: string;
  role: AppRole;
  status: AccountStatus;
  phone_last_four: string | null;
  phone_lookup_hash: string | null;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

const accountColumns = [
  'id',
  'auth_user_id',
  'display_name',
  'display_name_normalized',
  'login_id',
  'login_id_normalized',
  'role',
  'status',
  'phone_last_four',
  'phone_lookup_hash',
  'must_change_password',
  'failed_login_count',
  'locked_until',
  'created_at',
  'updated_at'
].join(',');

export function normalizeDisplayName(value: string): { displayName: string; normalized: string } {
  const displayName = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  return {
    displayName,
    normalized: displayName.toLocaleLowerCase('ko-KR')
  };
}

export function normalizeKoreanMobile(value: string): { canonical: string; lastFour: string } {
  const digits = value.replace(/\D/g, '');
  const domestic = digits.startsWith('82') ? `0${digits.slice(2)}` : digits;

  if (!/^010\d{8}$/.test(domestic)) {
    throw new AppError(400, 'INVALID_PHONE', '휴대전화 번호를 010으로 시작하는 11자리로 입력해 주세요.');
  }

  return {
    canonical: `+82${domestic.slice(1)}`,
    lastFour: domestic.slice(-4)
  };
}

function syntheticEmail(profileId: string): string {
  return `user-${profileId}@auth.castletheart.invalid`;
}

function toAccount(row: ProfileRow): Account {
  return {
    id: row.id,
    displayName: row.display_name,
    loginId: row.login_id,
    role: row.role,
    status: row.status,
    phoneLastFour: row.phone_last_four,
    mustChangePassword: row.must_change_password,
    failedLoginCount: row.failed_login_count,
    lockedUntil: row.locked_until,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function ensureAccountManager(actor: Actor): void {
  if (!canManageAccounts(actor.role)) {
    throw new AppError(403, 'ACCOUNT_MANAGER_REQUIRED', '계정 관리 권한이 필요합니다.');
  }
  if (actor.mustChangePassword) {
    throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', '계속하려면 먼저 임시 비밀번호를 변경해 주세요.');
  }
}

interface AccountCreationFingerprint {
  displayNameNormalized: string;
  role: AppRole;
  phoneLookupHash: string;
}

export function assertIdempotentAccountCreation(
  existing: Pick<ProfileRow, 'display_name_normalized' | 'role' | 'phone_lookup_hash'>,
  requested: AccountCreationFingerprint
): void {
  if (
    existing.display_name_normalized !== requested.displayNameNormalized ||
    existing.role !== requested.role ||
    existing.phone_lookup_hash !== requested.phoneLookupHash
  ) {
    throw new AppError(
      409,
      'IDEMPOTENCY_KEY_REUSED',
      '이미 다른 요청에 사용한 Idempotency-Key입니다.'
    );
  }
}

function databaseError(error: { code?: string; message?: string } | null): AppError {
  const message = error?.message ?? '';
  if (message.includes('LAST_ACTIVE_ADMIN_REQUIRED')) {
    return new AppError(409, 'LAST_ACTIVE_ADMIN_REQUIRED', '마지막 활성 관리자 계정은 변경할 수 없습니다.');
  }
  if (message.includes('ACCOUNT_MUST_BE_INACTIVE_BEFORE_DEPARTURE')) {
    return new AppError(409, 'ACCOUNT_MUST_BE_INACTIVE', '퇴사 처리 전에 계정을 먼저 비활성화해 주세요.');
  }
  if (message.includes('DEPARTED_ACCOUNT_IMMUTABLE')) {
    return new AppError(409, 'DEPARTED_ACCOUNT_IMMUTABLE', '퇴사 처리된 계정은 변경할 수 없습니다.');
  }
  if (message.includes('ACCOUNT_NOT_FOUND')) {
    return new AppError(404, 'ACCOUNT_NOT_FOUND', '계정을 찾을 수 없습니다.');
  }
  if (message.includes('FIRST_ADMIN_ALREADY_EXISTS')) {
    return new AppError(409, 'FIRST_ADMIN_ALREADY_EXISTS', '최초 관리자가 이미 생성되어 관리자 API를 사용해야 합니다.');
  }
  if (message.includes('DEVELOPER_ALREADY_EXISTS')) {
    return new AppError(409, 'DEVELOPER_ALREADY_EXISTS', '최상위 개발자 계정이 이미 생성되어 있습니다.');
  }
  if (message.includes('DEVELOPER_ACCOUNT_PROTECTED')) {
    return new AppError(403, 'DEVELOPER_ACCOUNT_PROTECTED', '최상위 개발자 계정은 이 작업으로 변경할 수 없습니다.');
  }
  if (message.includes('ACTIVE_ACCOUNT_MANAGER_REQUIRED')) {
    return new AppError(403, 'ACCOUNT_MANAGER_REQUIRED', '활성 계정 관리자 권한이 필요합니다.');
  }
  if (message.includes('IDEMPOTENCY_KEY_REUSED')) {
    return new AppError(409, 'IDEMPOTENCY_KEY_REUSED', '이미 다른 요청에 사용한 Idempotency-Key입니다.');
  }
  if (error?.code === '23505' && message.includes('phone_lookup_hash')) {
    return new AppError(409, 'PHONE_ALREADY_REGISTERED', '이미 등록된 휴대전화 번호입니다. 기존 계정을 복구해 주세요.');
  }
  if (error?.code === '23505') {
    return new AppError(409, 'LOGIN_ID_CONFLICT', '로그인 아이디를 만들 수 없습니다. 이름을 확인해 주세요.');
  }
  return new AppError(500, 'ACCOUNT_COMMAND_FAILED', '계정 변경을 완료하지 못했습니다.');
}

export class SupabaseAccountService implements AccountService {
  constructor(
    private readonly clients: SupabaseClients,
    private readonly phonePepper: string
  ) {}

  async list(actor: Actor): Promise<Account[]> {
    ensureAccountManager(actor);
    const { data, error } = await this.clients.admin
      .from('profiles')
      .select(accountColumns)
      .order('created_at', { ascending: true });

    if (error) {
      throw databaseError(error);
    }
    return (data as unknown as ProfileRow[]).map(toAccount);
  }

  async create(actor: Actor, input: CreateAccountInput): Promise<CreatedAccount> {
    ensureAccountManager(actor);
    const name = normalizeDisplayName(input.displayName);
    const phone = normalizeKoreanMobile(input.phone);
    const phoneHash = createHmac('sha256', this.phonePepper).update(phone.canonical).digest('hex');
    const fingerprint = {
      displayNameNormalized: name.normalized,
      role: input.role,
      phoneLookupHash: phoneHash
    };
    const existing = await this.findIdempotentProfile(input.idempotencyKey, 'account.created');

    if (existing) {
      assertIdempotentAccountCreation(existing, fingerprint);
      return {
        account: toAccount(existing),
        temporaryPassword: existing.phone_last_four ?? phone.lastFour
      };
    }

    const profileId = randomUUID();
    const { data: authData, error: authError } = await this.clients.admin.auth.admin.createUser({
      id: profileId,
      email: syntheticEmail(profileId),
      password: toSupabaseAuthPassword(phone.lastFour),
      email_confirm: true,
      app_metadata: { profile_id: profileId, role: input.role }
    });

    if (authError || !authData.user) {
      throw new AppError(502, 'AUTH_USER_CREATE_FAILED', '인증 계정을 만들지 못했습니다.');
    }

    try {
      const { data, error } = await this.clients.admin.rpc('create_account_profile', {
        p_profile_id: profileId,
        p_auth_user_id: authData.user.id,
        p_actor_profile_id: actor.profileId,
        p_display_name: name.displayName,
        p_display_name_normalized: name.normalized,
        p_role: input.role,
        p_phone_last_four: phone.lastFour,
        p_phone_lookup_hash: phoneHash,
        p_idempotency_key: input.idempotencyKey
      });

      if (error || !data) {
        throw databaseError(error);
      }

      const row = data as ProfileRow;
      assertIdempotentAccountCreation(row, fingerprint);
      if (row.id !== profileId) {
        await this.clients.admin.auth.admin.deleteUser(profileId);
      }
      return {
        account: toAccount(row),
        temporaryPassword: row.phone_last_four ?? phone.lastFour
      };
    } catch (error) {
      await this.clients.admin.auth.admin.deleteUser(profileId);
      throw error;
    }
  }

  async bootstrapFirstDeveloper(input: BootstrapDeveloperInput): Promise<Account> {
    const name = normalizeDisplayName(input.displayName);
    if (name.normalized !== 'admin') {
      throw new AppError(400, 'DEVELOPER_LOGIN_ID_MUST_BE_ADMIN', '개발자 로그인 아이디는 admin이어야 합니다.');
    }
    if (!isPersonalPassword(input.password)) {
      throw new AppError(400, 'INVALID_PASSWORD', '허용된 강도의 개인 비밀번호가 필요합니다.');
    }
    const phone = normalizeKoreanMobile(input.phone);
    const phoneHash = createHmac('sha256', this.phonePepper).update(phone.canonical).digest('hex');
    const fingerprint = {
      displayNameNormalized: name.normalized,
      role: 'developer' as const,
      phoneLookupHash: phoneHash
    };
    const existing = await this.findIdempotentProfile(
      input.idempotencyKey,
      'account.bootstrap_developer_created'
    );
    if (existing) {
      assertIdempotentAccountCreation(existing, fingerprint);
      return toAccount(existing);
    }

    const profileId = randomUUID();
    const { data: authData, error: authError } = await this.clients.admin.auth.admin.createUser({
      id: profileId,
      email: syntheticEmail(profileId),
      password: toSupabaseAuthPassword(input.password),
      email_confirm: true,
      app_metadata: { profile_id: profileId, role: 'developer' }
    });
    if (authError || !authData.user) {
      throw new AppError(502, 'AUTH_USER_CREATE_FAILED', '최상위 개발자 인증 계정을 만들지 못했습니다.');
    }

    try {
      const { data, error } = await this.clients.admin.rpc('bootstrap_first_developer_profile', {
        p_profile_id: profileId,
        p_auth_user_id: authData.user.id,
        p_display_name: name.displayName,
        p_display_name_normalized: name.normalized,
        p_phone_last_four: phone.lastFour,
        p_phone_lookup_hash: phoneHash,
        p_idempotency_key: input.idempotencyKey
      });
      if (error || !data) {
        throw databaseError(error);
      }
      const row = data as ProfileRow;
      assertIdempotentAccountCreation(row, fingerprint);
      if (row.id !== profileId) {
        await this.clients.admin.auth.admin.deleteUser(profileId);
      }
      return toAccount(row);
    } catch (error) {
      await this.clients.admin.auth.admin.deleteUser(profileId);
      throw error;
    }
  }

  async changeRole(actor: Actor, input: ChangeAccountRoleInput): Promise<Account> {
    ensureAccountManager(actor);
    const before = await this.getProfile(input.targetProfileId);
    if (before.role === 'developer') {
      throw new AppError(403, 'DEVELOPER_ACCOUNT_PROTECTED', '최상위 개발자 역할은 변경할 수 없습니다.');
    }
    const { error: authError } = await this.clients.admin.auth.admin.updateUserById(before.auth_user_id, {
      app_metadata: { profile_id: before.id, role: input.role }
    });
    if (authError) {
      throw new AppError(502, 'AUTH_USER_UPDATE_FAILED', '인증 계정 역할을 변경하지 못했습니다.');
    }

    const { data, error } = await this.clients.admin.rpc('change_account_role', {
      p_actor_profile_id: actor.profileId,
      p_target_profile_id: input.targetProfileId,
      p_role: input.role,
      p_idempotency_key: input.idempotencyKey
    });
    if (error || !data) {
      await this.clients.admin.auth.admin.updateUserById(before.auth_user_id, {
        app_metadata: { profile_id: before.id, role: before.role }
      });
      throw databaseError(error);
    }
    return toAccount(data as ProfileRow);
  }

  async changeStatus(actor: Actor, input: ChangeAccountStatusInput): Promise<Account> {
    ensureAccountManager(actor);
    const before = await this.getProfile(input.targetProfileId);
    if (before.role === 'developer') {
      throw new AppError(403, 'DEVELOPER_ACCOUNT_PROTECTED', '최상위 개발자 상태는 변경할 수 없습니다.');
    }
    const { data, error } = await this.clients.admin.rpc('change_account_status', {
      p_actor_profile_id: actor.profileId,
      p_target_profile_id: input.targetProfileId,
      p_status: input.status,
      p_reason_code: input.reasonCode,
      p_idempotency_key: input.idempotencyKey
    });
    if (error || !data) {
      throw databaseError(error);
    }

    const row = data as ProfileRow;
    const nextBanDuration = row.status === 'active' ? 'none' : '876000h';
    const { error: authError } = await this.clients.admin.auth.admin.updateUserById(
      before.auth_user_id,
      { ban_duration: nextBanDuration }
    );
    if (authError) {
      throw new AppError(
        502,
        'ACCOUNT_AUTH_STATE_INCONSISTENT',
        'DB 계정 상태는 변경됐지만 Auth 동기화에 실패했습니다. 동일한 Idempotency-Key로 다시 시도해 주세요.'
      );
    }
    return toAccount(row);
  }

  async unlock(actor: Actor, input: AccountMutationInput): Promise<Account> {
    ensureAccountManager(actor);
    return this.runAccountRpc('unlock_account', {
      p_actor_profile_id: actor.profileId,
      p_target_profile_id: input.targetProfileId,
      p_idempotency_key: input.idempotencyKey
    });
  }

  async resetPassword(actor: Actor, input: AccountMutationInput): Promise<Account> {
    ensureAccountManager(actor);
    const before = await this.getProfile(input.targetProfileId);
    if (before.role === 'developer') {
      throw new AppError(403, 'DEVELOPER_ACCOUNT_PROTECTED', '최상위 개발자 비밀번호는 본인만 변경할 수 있습니다.');
    }
    const { data, error } = await this.clients.admin.rpc('prepare_account_password_reset', {
      p_actor_profile_id: actor.profileId,
      p_target_profile_id: input.targetProfileId,
      p_idempotency_key: input.idempotencyKey
    });
    if (error || !data) {
      throw databaseError(error);
    }

    const row = data as ProfileRow;
    if (!row.phone_last_four) {
      throw new AppError(409, 'PHONE_REQUIRED_FOR_RESET', '등록된 휴대전화 번호가 없어 초기화할 수 없습니다.');
    }
    const { error: authError } = await this.clients.admin.auth.admin.updateUserById(row.auth_user_id, {
      password: toSupabaseAuthPassword(row.phone_last_four)
    });
    if (authError) {
      throw new AppError(502, 'AUTH_PASSWORD_RESET_FAILED', '인증 비밀번호를 초기화하지 못했습니다. 다시 시도해 주세요.');
    }
    return toAccount(row);
  }

  private async runAccountRpc(name: string, parameters: Record<string, string>): Promise<Account> {
    const { data, error } = await this.clients.admin.rpc(name, parameters);
    if (error || !data) {
      throw databaseError(error);
    }
    return toAccount(data as ProfileRow);
  }

  private async getProfile(profileId: string): Promise<ProfileRow> {
    const { data, error } = await this.clients.admin
      .from('profiles')
      .select(accountColumns)
      .eq('id', profileId)
      .single();
    if (error || !data) {
      throw new AppError(404, 'ACCOUNT_NOT_FOUND', '계정을 찾을 수 없습니다.');
    }
    return data as unknown as ProfileRow;
  }

  private async findIdempotentProfile(key: string, eventType: string): Promise<ProfileRow | null> {
    const { data, error } = await this.clients.admin
      .from('audit_events')
      .select('entity_id')
      .eq('idempotency_key', key)
      .eq('event_type', eventType)
      .maybeSingle();
    if (error) {
      throw databaseError(error);
    }
    if (!data?.entity_id) {
      return null;
    }
    return this.getProfile(data.entity_id);
  }
}
