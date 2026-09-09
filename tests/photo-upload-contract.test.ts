import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';
import {
  createPhotoUploadClaim, decidePhotoCompensation, isPhotoUploadTransitionAllowed,PhotoUploadContractError,
  photoUploadDatabaseError, photoUploadStatuses,
  preparePhotoUploadBegin, projectPhotoUploadOperation, validatePhotoCompensationSettlement,
  validatePhotoProviderSuccess, validatePhotoUploadBegin, validatePhotoUploadOperationCommand
} from '../supabase/functions/_shared/photo-upload-contract.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const input = () => ({ attemptId:id(1), assignmentId:id(2), assignmentRevision:1,
  targetSlotId:id(3), expectedPhotoRevision:0, sha256:'a'.repeat(64), mime:'image/jpeg', sizeBytes:307200 });
const row = () => ({ operationId:id(4), objectId:id(5), attemptId:id(1), targetSlotId:id(3),
  status:'reserved', leaseVersion:1, leaseExpiresAt:'2037-01-01T00:05:00Z', photoId:null,
  photoVersion:null, uploadedAt:null, purgeAfter:null, compensationAllowed:false });
const uploaded = {uploadedAt:'2037-01-01T00:00:00.123456Z',purgeAfter:'2037-01-08T00:00:00.123456Z'};

describe('photo upload pure application contract (no provider or HTTP calls)', () => {
  it('accepts exactly 307200 bytes JPEG/WebP and rejects untrusted extra assertions', () => {
    expect(validatePhotoUploadBegin(input()).sizeBytes).toBe(307200);
    expect(validatePhotoUploadBegin({...input(),mime:'image/webp',sizeBytes:1}).mime).toBe('image/webp');
    for(const patch of [{sizeBytes:307201},{sizeBytes:0},{sizeBytes:'20'},{mime:'image/png'},
      {mime:'IMAGE/JPEG'},{verified:true},{providerLocator:'unsafe'},{exifRemoved:true},
      {expectedPhotoRevision:Number.MAX_SAFE_INTEGER},{assignmentRevision:0},{sha256:'A'.repeat(64)}]) {
      expect(() => validatePhotoUploadBegin({...input(),...patch})).toThrow(PhotoUploadContractError);
    }
  });
  it('hashes raw key once with actor/command scope and preserves payload retry identity', async () => {
    const a=await preparePhotoUploadBegin(id(8),input(),'synthetic-key-123');
    const replay=await preparePhotoUploadBegin(id(8),input(),'synthetic-key-123');
    expect(replay).toEqual(a);
    expect(JSON.stringify(a)).not.toContain('synthetic-key-123');
    const differentActor=await preparePhotoUploadBegin(id(9),input(),'synthetic-key-123');
    expect(differentActor.idempotencyKeyDigest).not.toBe(a.idempotencyKeyDigest);
    const differentKey=await preparePhotoUploadBegin(id(8),input(),'synthetic-key-456');
    expect(differentKey.requestHash).toBe(a.requestHash);
    expect(differentKey.idempotencyKeyDigest).not.toBe(a.idempotencyKeyDigest);
    const canonical={actorProfileId:id(8),command:'photo.upload',...input()};
    const serialized=JSON.stringify(Object.fromEntries(Object.entries(canonical).sort(([a],[b])=>a<b?-1:a>b?1:0)));
    expect(a.requestHash).toBe(createHash('sha256').update(serialized).digest('hex'));
    for(const patch of [{attemptId:id(11)},{assignmentId:id(12)},{assignmentRevision:2},{targetSlotId:id(13)},
      {expectedPhotoRevision:1},{sha256:'b'.repeat(64)},{mime:'image/webp'},{sizeBytes:100}]) {
      const changed=await preparePhotoUploadBegin(id(8),{...input(),...patch},'synthetic-key-123');
      expect(changed.idempotencyKeyDigest).toBe(a.idempotencyKeyDigest);
      expect(changed.requestHash).not.toBe(a.requestHash);
    }
  });
  it('rejects invalid raw key before returning loggable material', async () => {
    for(const key of ['', 'short', 'x'.repeat(129), 'Bearer x', {key:'test'}])
      await expect(preparePhotoUploadBegin(id(8),input(),key)).rejects.toMatchObject({code:'VALIDATION_ERROR'});
  });
  it('generates isolated server claim identities, requires claim digest and never projects it', async () => {
    const [a,b]=await Promise.all([createPhotoUploadClaim(id(4)),createPhotoUploadClaim(id(4))]);
    expect(a.claimDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(a.claimDigest).not.toBe(b.claimDigest);
    expect(validatePhotoUploadOperationCommand('claim',{operationId:id(4),...a})).toMatchObject(a);
    expect(validatePhotoUploadOperationCommand('finalize',{operationId:id(4),leaseVersion:1,...a})).toMatchObject(a);
    expect(() => validatePhotoUploadOperationCommand('claim',{operationId:id(4)})).toThrow();
    expect(() => validatePhotoUploadOperationCommand('finalize',{operationId:id(4),...a})).toThrow();
    expect(projectPhotoUploadOperation({...row(),...a,claimId:id(20)})).not.toHaveProperty('claimDigest');
  });
  it('allows provider metadata only in internal strict commands and recognizes deletion 404', () => {
    const command={operationId:id(4),leaseVersion:1,claimDigest:'b'.repeat(64),providerLocator:'synthetic_object_123',uploadedAt:uploaded.uploadedAt};
    expect(validatePhotoProviderSuccess(command)).toEqual(command);
    for(const patch of [{providerLocator:'https://unsafe.invalid/file'}, {uploadedAt:'2037-02-30T00:00:00Z'}, {claimDigest:''},{uploadedAt:'0000-01-01T00:00:00Z'}])
      expect(() => validatePhotoProviderSuccess({...command,...patch})).toThrow();
    expect(validatePhotoCompensationSettlement({operationId:id(4),leaseVersion:1,claimDigest:'b'.repeat(64),outcome:'not_found'}).outcome).toBe('not_found');
    expect(() => validatePhotoCompensationSettlement({operationId:id(4),leaseVersion:1,claimDigest:'b'.repeat(64),outcome:'timeout'})).toThrow();
  });
  it('projects safe app IDs only and refuses false-green or malformed backend DTO', () => {
    const secret={providerLocator:'synthetic_provider_secret',requestHash:'a'.repeat(64),idempotencyKey:'synthetic_key',token:'synthetic_token',claimDigest:'b'.repeat(64)};
    expect(projectPhotoUploadOperation({...row(),...secret})).toEqual(row());
    for(const patch of [{status:'accepted'},{compensationAllowed:true},{photoId:id(6)},
      {status:'provider_succeeded'},{...uploaded,purgeAfter:'2037-01-08T00:00:00.123455Z'},
      {leaseVersion:NaN},{leaseExpiresAt:'2037-02-30T00:00:00Z'}])
      expect(() => projectPhotoUploadOperation({...row(),...patch})).toThrow(PhotoUploadContractError);
  });
  it('never deletes accepted, uncertain or provider-only result and fences candidate deletion', () => {
    const candidate={...row(),...uploaded,status:'compensation_pending',compensationAllowed:true};
    expect(decidePhotoCompensation(null,1)).toBe('reconcile');
    expect(decidePhotoCompensation({...row(),status:'reconciliation_pending'},1)).toBe('reconcile');
    expect(decidePhotoCompensation({...row(),...uploaded,status:'provider_succeeded'},1)).toBe('reconcile');
    expect(decidePhotoCompensation(candidate,1)).toBe('candidate_deletion');
    expect(decidePhotoCompensation(candidate,2)).toBe('stale_fence');
    expect(decidePhotoCompensation({...candidate,compensationAllowed:false},1)).toBe('reconcile');
    expect(decidePhotoCompensation({...row(),...uploaded,status:'accepted',photoId:id(6),photoVersion:1},2)).toBe('preserve_accepted');
  });
  it('permits only known state transitions with accepted and compensated terminal', () => {
    for(const status of photoUploadStatuses) {
      expect(isPhotoUploadTransitionAllowed(status,status)).toBe(true);
      if(status!=='accepted')expect(isPhotoUploadTransitionAllowed('accepted',status)).toBe(false);
      if(status!=='compensated')expect(isPhotoUploadTransitionAllowed('compensated',status)).toBe(false);
    }
    expect(isPhotoUploadTransitionAllowed('reserved','accepted')).toBe(false);
    expect(isPhotoUploadTransitionAllowed('reserved','provider_succeeded')).toBe(true);
    expect(isPhotoUploadTransitionAllowed('reconciliation_pending','compensation_pending')).toBe(true);
    expect(isPhotoUploadTransitionAllowed('provider_succeeded','compensated')).toBe(false);
  });
  it('maps stable errors without reflecting arbitrary provider or DB raw errors', () => {
    for(const [code,statusCode] of [['SESSION_REVOKED',401],['PHOTO_ACCESS_REQUIRED',403],['PHOTO_UPLOAD_INVALID',400],['IDEMPOTENCY_KEY_REUSED',409],['PHOTO_UPLOAD_FENCE_CONFLICT',409],['PHOTO_UPLOAD_RATE_LIMITED',429]] as const)
      expect(photoUploadDatabaseError({message:code,details:'hidden'})).toMatchObject({code,statusCode});
    for(const message of ['raw SQL private value','toString','__proto__']) {
      const error=photoUploadDatabaseError({message,details:'hidden'});
      expect(error.code).toBe('PHOTO_UPLOAD_FAILED');
      expect(error.message).not.toContain(message);
    }
  });
  it('retains the complete safe DB photo audit summary alongside four photo HTTP routes', () => {
    const schemas=openApiDocument.components.schemas;
    expect(schemas.DeveloperAuditEventType.enum).toContain('photo.upload_accepted');
    expect(schemas.DeveloperAuditEventType.enum).toHaveLength(49);
    const sample={cleaningTargetId:id(1),attemptId:id(2),targetSlotId:id(3),photoId:id(4),photoVersion:1,...uploaded};
    const summary=schemas.DeveloperAuditEvent.properties.summary;
    expect(summary.additionalProperties).toBe(false);
    for(const key of Object.keys(sample))expect(summary.properties).toHaveProperty(key);
    for(const key of ['requestHash','idempotencyKey','providerLocator','claimDigest','token','rawAfterState'])
      expect(summary.properties).not.toHaveProperty(key);
    expect(Object.keys(openApiDocument.paths)).toHaveLength(77);
  });
});
