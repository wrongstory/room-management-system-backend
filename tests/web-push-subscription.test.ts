import { createECDH } from 'node:crypto';
import Fastify from 'fastify';
import { describe,expect,it,vi } from 'vitest';
import type { Actor } from '../src/domain/actor.js';
import { AppError } from '../src/lib/app-error.js';
import { createWebPushEnvelope,decryptWebPushEnvelope,type WebPushSubscriptionInput } from '../src/modules/push-subscriptions/web-push-crypto.js';
import { createWebPushSubscriptionRoutes } from '../src/modules/push-subscriptions/web-push-subscription.routes.js';
import { SupabaseWebPushSubscriptionService,type WebPushSubscriptionService } from '../src/modules/push-subscriptions/web-push-subscription.service.js';

const ids={profile:'11000000-0000-4000-8000-000000000001',session:'11000000-0000-4000-8000-000000000901',subscription:'11000000-0000-4000-8000-000000001001'};
const token=`e30.${Buffer.from(JSON.stringify({session_id:ids.session})).toString('base64url')}.x`;
const actor:Actor={authUserId:'11000000-0000-4000-8000-000000000101',profileId:ids.profile,displayName:'push maid',role:'maid',mustChangePassword:false,accessToken:token};
const ecdh=createECDH('prime256v1');ecdh.generateKeys();
const subscription:WebPushSubscriptionInput={endpoint:'https://push.example.invalid/send/opaque-capability',expirationTime:null,keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,7).toString('base64url')}};
const key=Buffer.alloc(32,4).toString('base64');
const config={key,keyVersion:'v2',keyring:{v1:Buffer.alloc(32,3).toString('base64')},bindingSecret:'web-push-binding-test-secret-123456789',vapidKeyVersion:'vapid-v2',vapidPublicKey:subscription.keys.p256dh};
const vectorSubscription:WebPushSubscriptionInput={
  endpoint:'https://PUSH.Example.Invalid:443/send/%2Fopaque?b=2&a=%2F',expirationTime:null,
  keys:{p256dh:'BGsX0fLhLEJH-Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU',auth:'BwcHBwcHBwcHBwcHBwcHBw'}
};
const vectorIds={profile:'A1000000-0000-4000-8000-00000000000A',session:'B1000000-0000-4000-8000-00000000000B',subscription:'C1000000-0000-4000-8000-00000000000C'};
const vectorConfig={...config,keyring:{},nonce:new Uint8Array([...Array(12).keys()])};

describe('Web Push envelope',()=>{
  it('round-trips canonical AES-GCM and binds AAD to actor/session/endpoint/subscription/revision',()=>{
    const envelope=createWebPushEnvelope(subscription,ids.profile,ids.session,ids.subscription,1,config);
    expect(decryptWebPushEnvelope(envelope,{actorProfileId:ids.profile,sessionDigest:envelope.sessionDigest,endpointDigest:envelope.endpointDigest,subscriptionId:ids.subscription,revisionNo:1},config)).toEqual({subscription,sessionId:ids.session});
    expect(()=>decryptWebPushEnvelope(envelope,{actorProfileId:ids.profile,sessionDigest:envelope.sessionDigest,endpointDigest:envelope.endpointDigest,subscriptionId:ids.subscription,revisionNo:2},config)).toThrow();
    expect(JSON.stringify(envelope)).not.toContain(subscription.endpoint);
    expect(envelope.endpointDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('matches the shared Node/Deno canonical identity and deterministic encryption vector',()=>{
    const envelope=createWebPushEnvelope(vectorSubscription,vectorIds.profile,vectorIds.session,vectorIds.subscription,2,vectorConfig,vectorIds.subscription);
    expect(envelope).toEqual({
      endpointDigest:'2fe510b0721dfd9416ab10f1796e4e6f0d80d9eb01a65ff94227ff030d42dd04',
      sessionDigest:'ad62c364ce8addd4bcf1907f41d66dc40f72310efd8174c5b63a9409a00a9a93',
      materialDigest:'c08827336099b39bb92bd93ce466377eaa11712cc50f7539b7a8dfa5d4a58714',expirationAt:null,keyVersion:'v2',
      ciphertextBase64:'QKZyBOAIcKJ15U/1CBgEkJPN2MKesgrJzlZmAAMWi9XJTjdMQ3SgkdDR/Mk2zQtLGCKAFkaEp/vBj2cZ4AhLTmF8LBUfQ4KN4vI0IkeKmoqk2mKDmqEpLLAUH7UG9ostoBCSfaSGAWhqZyqnx9TQYJDuP+he1iQECM0k+M77Qxx6kW7UJRO7kNKj0LaAsCZkKCMRJGCo9GnSWlPMV7r92GJxcHjtzojdgCCZcFcKomlJ7qeOYDwvmX/q5Ld+D1WaMwoV8KmlhmilUfbUNki1tJOpHzyqKWI+zinuAJVtJFubhHrJ3p+4BfMnCjR+DON89cbf4Yqg1iADgkmK7oNwEX8jyIqjlDup0uOr4V8OdLA=',
      nonceBase64:'AAECAwQFBgcICQoL',authTagBase64:'z2dR/v7MHCXYiNtRehTrOA==',
      requestHash:'a19b60927ac456910cda60cff24c9a671655e367d49431914ed067fdf7a2624c'
    });
    expect(decryptWebPushEnvelope(envelope,{actorProfileId:vectorIds.profile,sessionDigest:envelope.sessionDigest,endpointDigest:envelope.endpointDigest,subscriptionId:vectorIds.subscription,revisionNo:2},vectorConfig)).toEqual({
      subscription:{...vectorSubscription,endpoint:'https://push.example.invalid/send/%2Fopaque?b=2&a=%2F'},
      sessionId:vectorIds.session.toLowerCase()
    });
  });
  it('rejects non-HTTPS, credentials, fragments, expired values, noncanonical keys and invalid P-256 points',()=>{
    const invalids=[
      {...subscription,endpoint:'http://push.example.invalid/x'},
      {...subscription,endpoint:'https://user:pass@push.example.invalid/x'},
      {...subscription,endpoint:'https://@push.example.invalid/x'},
      {...subscription,endpoint:'https://push.example.invalid/x#secret'},
      {...subscription,endpoint:'https://push.example.invalid/x#'},
      {...subscription,endpoint:`https://push.example.invalid/${'x'.repeat(4096)}`},
      {...subscription,endpoint:`https://push.example.invalid/${' '.repeat(4000)}x`},
      {...subscription,expirationTime:Date.now()-1},
      {...subscription,keys:{...subscription.keys,auth:`${subscription.keys.auth}=`}},
      {...subscription,keys:{...subscription.keys,p256dh:Buffer.alloc(65,4).toString('base64url')}}
    ];
    for(const input of invalids)expect(()=>createWebPushEnvelope(input,ids.profile,ids.session,ids.subscription,1,config)).toThrowError(expect.objectContaining({code:'INVALID_WEB_PUSH_SUBSCRIPTION'}));
  });
  it('decrypts an older keyring revision and fails closed without its key',()=>{
    const old={...config,key:config.keyring.v1 as string,keyVersion:'v1'};
    const envelope=createWebPushEnvelope(subscription,ids.profile,ids.session,ids.subscription,1,old);
    const binding={actorProfileId:ids.profile,sessionDigest:envelope.sessionDigest,endpointDigest:envelope.endpointDigest,subscriptionId:ids.subscription,revisionNo:1};
    expect(decryptWebPushEnvelope(envelope,binding,config)).toEqual({subscription,sessionId:ids.session});
    expect(()=>decryptWebPushEnvelope(envelope,binding,{key:config.key,keyVersion:'v2',keyring:{}})).toThrowError(expect.objectContaining({code:'WEB_PUSH_KEY_UNAVAILABLE'}));
  });
});

describe('Web Push service and routes',()=>{
  it('passes only encrypted/digest material to the service-role RPC and exposes a safe projection',async()=>{
    const rpc=vi.fn(async (..._args:unknown[])=>({data:{id:ids.subscription,version:1,status:'active',createdAt:'2026-09-11T05:00:00Z',updatedAt:'2026-09-11T05:00:00Z',retiredAt:null},error:null}));
    const service=new SupabaseWebPushSubscriptionService({admin:{rpc}} as never,config);
    const result=await service.register(actor,{subscription},'push-register-0001');
    expect(result).toEqual({id:ids.subscription,version:1,status:'active',createdAt:'2026-09-11T05:00:00Z',updatedAt:'2026-09-11T05:00:00Z',retiredAt:null});
    const args=rpc.mock.calls[0]?.[1] as Record<string,unknown>;
    expect(JSON.stringify(args)).not.toContain(subscription.endpoint);
    expect(args).not.toHaveProperty('p_endpoint');expect(args).not.toHaveProperty('p_auth');expect(args).not.toHaveProperty('p_p256dh');
    expect(args.p_vapid_key_version).toBe('vapid-v2');
    await expect(service.register({...actor,role:'developer'},{subscription},'push-register-0002')).rejects.toMatchObject({code:'WEB_PUSH_ACCESS_REQUIRED'});
  });
  it('canonicalizes uppercase UUIDs and equivalent endpoints before AAD, hash and RPC',async()=>{
    const rpc=vi.fn(async (..._args:unknown[])=>({data:{id:vectorIds.subscription.toLowerCase(),version:2,status:'active',createdAt:'2026-09-11T05:00:00+09:00',updatedAt:'2026-09-11T05:01:00Z',retiredAt:null},error:null}));
    const service=new SupabaseWebPushSubscriptionService({admin:{rpc}} as never,vectorConfig);
    const upperToken=`e30.${Buffer.from(JSON.stringify({session_id:vectorIds.session})).toString('base64url')}.x`;
    await service.register({...actor,profileId:vectorIds.profile,accessToken:upperToken},{subscription:vectorSubscription,expectedCurrent:{subscriptionId:vectorIds.subscription,version:1}},'push-vector-0001');
    const args=rpc.mock.calls[0]?.[1] as Record<string,unknown>;
    expect(args).toMatchObject({p_actor_profile_id:vectorIds.profile.toLowerCase(),p_session_id:vectorIds.session.toLowerCase(),p_proposed_subscription_id:vectorIds.subscription.toLowerCase(),p_expected_subscription_id:vectorIds.subscription.toLowerCase(),p_endpoint_digest:'2fe510b0721dfd9416ab10f1796e4e6f0d80d9eb01a65ff94227ff030d42dd04'});
  });
  it('fails closed with the same internal error for malformed timestamps or projection shape',async()=>{
    for(const data of [
      {id:ids.subscription,version:1,status:'active',createdAt:'2026-02-30T05:00:00Z',updatedAt:'2026-09-11T05:00:00Z',retiredAt:null},
      {id:ids.subscription,version:1,status:'active',createdAt:'2026-09-11T05:00:00',updatedAt:'2026-09-11T05:00:00Z',retiredAt:null},
      {id:ids.subscription,version:1,status:'active',createdAt:'2026-09-11T05:00:00Z',updatedAt:'2026-09-11T05:00:60Z',retiredAt:null},
      {id:ids.subscription,version:1,status:'active',createdAt:'2026-09-11T05:00:00Z',updatedAt:'2026-09-11T05:00:00Z',retiredAt:null,raw:'forbidden'}
    ]){
      const service=new SupabaseWebPushSubscriptionService({admin:{rpc:vi.fn(async()=>({data,error:null}))}} as never,config);
      await expect(service.register(actor,{subscription},'push-projection-bad')).rejects.toMatchObject({statusCode:500,code:'WEB_PUSH_COMMAND_FAILED',message:'Web Push 구독을 처리하지 못했습니다.'});
    }
  });
  it('maps unexpected database detail to a stable secret-free error',async()=>{
    const raw='https://push.example.invalid/private-capability?p256dh=secret&auth=secret';
    const service=new SupabaseWebPushSubscriptionService({admin:{rpc:vi.fn(async()=>({data:null,error:{message:raw}}))}} as never,config);
    await expect(service.register(actor,{subscription},'push-register-error')).rejects.toMatchObject({code:'WEB_PUSH_COMMAND_FAILED',message:'Web Push 구독을 처리하지 못했습니다.'});
    try{await service.register(actor,{subscription},'push-register-error2');}catch(error){expect(JSON.stringify(error)).not.toContain(raw);}
  });

  async function app(service:WebPushSubscriptionService){
    const instance=Fastify({logger:false});instance.decorateRequest('actor');instance.decorate('authenticate',async request=>{request.actor=actor;});instance.decorate('requirePasswordChanged',async()=>undefined);
    instance.setErrorHandler((error,request,reply)=>error instanceof AppError?reply.code(error.statusCode).send({error:{code:error.code,message:error.message},requestId:request.id}):reply.code(400).send({error:{code:'VALIDATION_ERROR'}}));
    await instance.register(createWebPushSubscriptionRoutes(service),{prefix:'/v1/push-subscriptions'});return instance;
  }
  it('supports only exact register/retire routes, strict bodies, idempotency and no-store',async()=>{
    const service:WebPushSubscriptionService={config:vi.fn(async()=>({keyVersion:'vapid-v2',publicKey:subscription.keys.p256dh})),register:vi.fn(async()=>({id:ids.subscription})),retire:vi.fn(async()=>({id:ids.subscription}))};const instance=await app(service);
    const configured=await instance.inject({method:'GET',url:'/v1/push-subscriptions/config'});
    expect(configured.statusCode).toBe(200);expect(configured.json()).toEqual({keyVersion:'vapid-v2',publicKey:subscription.keys.p256dh});expect(configured.headers['cache-control']).toBe('no-store');
    const registered=await instance.inject({method:'POST',url:'/v1/push-subscriptions',headers:{'idempotency-key':'push-route-0001'},payload:{subscription}});
    expect(registered.statusCode).toBe(201);expect(registered.headers['cache-control']).toBe('no-store');
    const retired=await instance.inject({method:'POST',url:`/v1/push-subscriptions/${ids.subscription}/retire`,headers:{'idempotency-key':'push-route-0002'},payload:{expectedVersion:1}});
    expect(retired.statusCode).toBe(200);expect(retired.headers['cache-control']).toBe('no-store');
    for(const request of [
      {method:'POST' as const,url:'/v1/push-subscriptions/',headers:{'idempotency-key':'push-route-0003'},payload:{subscription}},
      {method:'POST' as const,url:'/v1/push-subscriptions?x=1',headers:{'idempotency-key':'push-route-0004'},payload:{subscription}},
      {method:'POST' as const,url:'/v1/push-subscriptions',headers:{'idempotency-key':'push-route-0007'},payload:{subscription,vapidKeyVersion:'client-forbidden'}},
      {method:'POST' as const,url:`/v1/push-subscriptions/${ids.subscription}/retire/extra`,headers:{'idempotency-key':'push-route-0005'},payload:{expectedVersion:1}},
      {method:'POST' as const,url:`/v1/push-subscriptions/${ids.subscription}/retire`,headers:{'idempotency-key':'push-route-0006'},payload:{expectedVersion:1,endpoint:'forbidden'}}
    ])expect((await instance.inject(request)).statusCode).toBeGreaterThanOrEqual(400);
    await instance.close();
  });
});
