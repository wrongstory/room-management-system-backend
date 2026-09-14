import { createHash, randomUUID } from 'node:crypto';
import type { Actor } from '../../domain/actor.js';
import { AppError } from '../../lib/app-error.js';
import type { SupabaseClients } from '../../lib/supabase.js';
import { canonicalWebPushUuid, createWebPushEnvelope, type WebPushCryptoConfig, type WebPushSubscriptionInput } from './web-push-crypto.js';
import { issueWebPushBindingProof, verifyWebPushBindingProof, WebPushBindingProofError } from './web-push-binding-proof.js';

export interface WebPushExpectedCurrent { subscriptionId: string; version: number }
export interface RegisterWebPushInput { bindingProof:string; subscription: WebPushSubscriptionInput; expectedCurrent?: WebPushExpectedCurrent | undefined }
export interface RetireWebPushInput { subscriptionId: string; expectedVersion: number }
export interface WebPushSubscriptionService {
  config(actor: Actor): Promise<{ keyVersion: string; publicKey: string; bindingProof:string; proofExpiresAt:string }>;
  register(actor: Actor, input: RegisterWebPushInput, idempotencyKey: string): Promise<unknown>;
  retire(actor: Actor, input: RetireWebPushInput, idempotencyKey: string): Promise<unknown>;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function strictRfc3339(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match=timestampPattern.exec(value); if(!match) return false;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]);
  const offsetHour=match[8]==='Z'?0:Number(match[10]),offsetMinute=match[8]==='Z'?0:Number(match[11]);
  const leap=year%4===0&&(year%100!==0||year%400===0);
  const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
  return year>=1&&month>=1&&month<=12&&day>=1&&day<=(days[month-1]??0)
    &&hour<=23&&minute<=59&&second<=59&&offsetHour<=23&&offsetMinute<=59
    &&Number.isFinite(Date.parse(value));
}

function sessionId(actor: Actor): string {
  try {
    const value = JSON.parse(Buffer.from(actor.accessToken.split('.')[1] ?? '', 'base64url').toString('utf8')) as { session_id?: unknown };
    if (typeof value.session_id !== 'string' || !uuidPattern.test(value.session_id)) throw new Error();
    return value.session_id.toLowerCase();
  } catch { throw new AppError(401, 'INVALID_ACCESS_TOKEN', '로그인이 필요합니다.'); }
}

function databaseError(error: { message?: string } | null): AppError {
  const message = error?.message ?? '';
  const mappings: Array<[string, number, string, string]> = [
    ['WEB_PUSH_SESSION_REVOKED',401,'SESSION_REVOKED','로그인이 만료되었습니다. 다시 로그인해 주세요.'],
    ['WEB_PUSH_ACCESS_REQUIRED',403,'WEB_PUSH_ACCESS_REQUIRED','Web Push 구독 권한이 필요합니다.'],
    ['WEB_PUSH_SUBSCRIPTION_NOT_FOUND',404,'WEB_PUSH_SUBSCRIPTION_NOT_FOUND','Web Push 구독을 찾을 수 없습니다.'],
    ['WEB_PUSH_RATE_LIMITED',429,'WEB_PUSH_RATE_LIMITED','Web Push 구독 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.'],
    ['WEB_PUSH_PROFILE_LIMIT',409,'WEB_PUSH_PROFILE_LIMIT','등록 가능한 Web Push 기기 수를 초과했습니다.'],
    ['WEB_PUSH_ENDPOINT_CONFLICT',409,'WEB_PUSH_ENDPOINT_CONFLICT','이 Web Push 구독을 사용할 수 없습니다.'],
    ['WEB_PUSH_SUBSCRIPTION_CONFLICT',409,'WEB_PUSH_SUBSCRIPTION_CONFLICT','Web Push 구독 상태가 변경되었습니다.'],
    ['WEB_PUSH_CAS_REQUIRED',409,'WEB_PUSH_CAS_REQUIRED','현재 구독 ID와 version이 필요합니다.'],
    ['WEB_PUSH_STALE_VERSION',409,'WEB_PUSH_STALE_VERSION','Web Push 구독 version이 변경되었습니다.'],
    ['IDEMPOTENCY_KEY_REUSED',409,'IDEMPOTENCY_KEY_REUSED','이미 다른 요청에 사용한 Idempotency-Key입니다.'],
    ['INVALID_WEB_PUSH',400,'INVALID_WEB_PUSH_SUBSCRIPTION','Web Push 구독 값이 올바르지 않습니다.']
  ];
  for (const [needle,status,code,korean] of mappings) if (message.includes(needle)) return new AppError(status,code,korean);
  return new AppError(500,'WEB_PUSH_COMMAND_FAILED','Web Push 구독을 처리하지 못했습니다.');
}

function proofError(error:unknown):AppError {
  if(error instanceof WebPushBindingProofError&&error.reason==='INVALID_CONFIGURATION') {
    return new AppError(503,'WEB_PUSH_NOT_CONFIGURED','Web Push 공개키 설정이 올바르지 않습니다.');
  }
  return new AppError(400,'WEB_PUSH_BINDING_PROOF_INVALID','Web Push 구독 키 증명이 만료되었거나 올바르지 않습니다.');
}

function projection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw databaseError(null);
  const row=value as Record<string,unknown>;
  const expected=['createdAt','id','retiredAt','status','updatedAt','version'];
  if (typeof row.id!=='string'||!uuidPattern.test(row.id)||!Number.isInteger(row.version)||!['active','retired'].includes(String(row.status))
    ||Object.keys(row).sort().join(',')!==expected.join(',')
    ||!strictRfc3339(row.createdAt)||!strictRfc3339(row.updatedAt)
    ||(row.retiredAt!==null&&!strictRfc3339(row.retiredAt))) throw databaseError(null);
  return { id:row.id.toLowerCase(),version:row.version,status:row.status,createdAt:row.createdAt,updatedAt:row.updatedAt,retiredAt:row.retiredAt };
}

export function assertWebPushResponseSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value),'utf8')>128*1024) throw new AppError(500,'WEB_PUSH_RESPONSE_TOO_LARGE','Web Push 구독 응답 크기 제한을 초과했습니다.');
}

export class SupabaseWebPushSubscriptionService implements WebPushSubscriptionService {
  constructor(private readonly clients: SupabaseClients, private readonly cryptoConfig: WebPushCryptoConfig) {}
  private async rpc(name:string,args:Record<string,unknown>):Promise<unknown>{
    const {data,error}=await this.clients.admin.rpc(name,args); if(error||data===null) throw databaseError(error); return data;
  }
  private actorBinding(actor:Actor){return {authUserId:canonicalWebPushUuid(actor.authUserId),profileId:canonicalWebPushUuid(actor.profileId),sessionId:canonicalWebPushUuid(sessionId(actor))};}
  private keys(){return {currentVersion:this.cryptoConfig.vapidKeyVersion,currentPublicKey:this.cryptoConfig.vapidPublicKey,publicKeyring:this.cryptoConfig.vapidPublicKeyring};}
  async config(actor:Actor):Promise<{keyVersion:string;publicKey:string;bindingProof:string;proofExpiresAt:string}>{
    if(actor.role!=='admin'&&actor.role!=='maid') throw databaseError({message:'WEB_PUSH_ACCESS_REQUIRED'});
    const proof=await issueWebPushBindingProof(this.actorBinding(actor),this.keys(),this.cryptoConfig.bindingSecret).catch((error:unknown)=>{throw proofError(error);});
    const result={keyVersion:this.cryptoConfig.vapidKeyVersion,publicKey:this.cryptoConfig.vapidPublicKey,...proof};
    assertWebPushResponseSize(result); return result;
  }
  async register(actor:Actor,input:RegisterWebPushInput,idempotencyKey:string):Promise<unknown>{
    if(actor.role!=='admin'&&actor.role!=='maid') throw databaseError({message:'WEB_PUSH_ACCESS_REQUIRED'});
    const actorProfileId=canonicalWebPushUuid(actor.profileId);
    const sid=canonicalWebPushUuid(sessionId(actor));
    const binding=await verifyWebPushBindingProof(input.bindingProof,this.actorBinding(actor),this.keys(),this.cryptoConfig.bindingSecret).catch((error:unknown)=>{throw proofError(error);});
    const expectedSubscriptionId=input.expectedCurrent===undefined?null:canonicalWebPushUuid(input.expectedCurrent.subscriptionId);
    const proposed=canonicalWebPushUuid(expectedSubscriptionId??randomUUID());
    const revision=(input.expectedCurrent?.version??0)+1;
    const envelope=createWebPushEnvelope(input.subscription,actorProfileId,sid,proposed,revision,{...this.cryptoConfig,vapidKeyVersion:binding.keyVersion,vapidPublicKey:binding.publicKey},expectedSubscriptionId,input.bindingProof);
    const result=projection(await this.rpc('register_web_push_subscription',{
      p_actor_profile_id:actorProfileId,p_session_id:sid,p_proposed_subscription_id:proposed,
      p_expected_subscription_id:expectedSubscriptionId,p_expected_version:input.expectedCurrent?.version??null,
      p_endpoint_digest:envelope.endpointDigest,p_session_digest:envelope.sessionDigest,p_material_digest:envelope.materialDigest,
      p_expiration_at:envelope.expirationAt,p_key_version:envelope.keyVersion,p_ciphertext_base64:envelope.ciphertextBase64,
      p_nonce_base64:envelope.nonceBase64,p_auth_tag_base64:envelope.authTagBase64,p_idempotency_key:idempotencyKey,
      p_request_hash:envelope.requestHash,p_vapid_key_version:binding.keyVersion
    })); assertWebPushResponseSize(result); return result;
  }
  async retire(actor:Actor,input:RetireWebPushInput,idempotencyKey:string):Promise<unknown>{
    if(actor.role!=='admin'&&actor.role!=='maid') throw databaseError({message:'WEB_PUSH_ACCESS_REQUIRED'});
    const actorProfileId=canonicalWebPushUuid(actor.profileId);
    const sid=canonicalWebPushUuid(sessionId(actor));
    const subscriptionId=canonicalWebPushUuid(input.subscriptionId);
    const hash=createHash('sha256').update(JSON.stringify({subscriptionId,expectedVersion:input.expectedVersion})).digest('hex');
    const result=projection(await this.rpc('retire_web_push_subscription',{
      p_actor_profile_id:actorProfileId,p_session_id:sid,p_subscription_id:subscriptionId,
      p_expected_version:input.expectedVersion,p_idempotency_key:idempotencyKey,p_request_hash:hash
    })); assertWebPushResponseSize(result); return result;
  }
}
