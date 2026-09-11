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
const config={key,keyVersion:'v2',keyring:{v1:Buffer.alloc(32,3).toString('base64')},bindingSecret:'web-push-binding-test-secret-123456789'};

describe('Web Push envelope',()=>{
  it('round-trips canonical AES-GCM and binds AAD to actor/session/endpoint/subscription/revision',()=>{
    const envelope=createWebPushEnvelope(subscription,ids.profile,ids.session,ids.subscription,1,config);
    expect(decryptWebPushEnvelope(envelope,{actorProfileId:ids.profile,sessionDigest:envelope.sessionDigest,endpointDigest:envelope.endpointDigest,subscriptionId:ids.subscription,revisionNo:1},config)).toEqual({subscription,sessionId:ids.session});
    expect(()=>decryptWebPushEnvelope(envelope,{actorProfileId:ids.profile,sessionDigest:envelope.sessionDigest,endpointDigest:envelope.endpointDigest,subscriptionId:ids.subscription,revisionNo:2},config)).toThrow();
    expect(JSON.stringify(envelope)).not.toContain(subscription.endpoint);
    expect(envelope.endpointDigest).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects non-HTTPS, credentials, fragments, expired values, noncanonical keys and invalid P-256 points',()=>{
    const invalids=[
      {...subscription,endpoint:'http://push.example.invalid/x'},
      {...subscription,endpoint:'https://user:pass@push.example.invalid/x'},
      {...subscription,endpoint:'https://@push.example.invalid/x'},
      {...subscription,endpoint:'https://push.example.invalid/x#secret'},
      {...subscription,endpoint:'https://push.example.invalid/x#'},
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
    await expect(service.register({...actor,role:'developer'},{subscription},'push-register-0002')).rejects.toMatchObject({code:'WEB_PUSH_ACCESS_REQUIRED'});
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
    const service:WebPushSubscriptionService={register:vi.fn(async()=>({id:ids.subscription})),retire:vi.fn(async()=>({id:ids.subscription}))};const instance=await app(service);
    const registered=await instance.inject({method:'POST',url:'/v1/push-subscriptions',headers:{'idempotency-key':'push-route-0001'},payload:{subscription}});
    expect(registered.statusCode).toBe(201);expect(registered.headers['cache-control']).toBe('no-store');
    const retired=await instance.inject({method:'POST',url:`/v1/push-subscriptions/${ids.subscription}/retire`,headers:{'idempotency-key':'push-route-0002'},payload:{expectedVersion:1}});
    expect(retired.statusCode).toBe(200);expect(retired.headers['cache-control']).toBe('no-store');
    for(const request of [
      {method:'POST' as const,url:'/v1/push-subscriptions/',headers:{'idempotency-key':'push-route-0003'},payload:{subscription}},
      {method:'POST' as const,url:'/v1/push-subscriptions?x=1',headers:{'idempotency-key':'push-route-0004'},payload:{subscription}},
      {method:'POST' as const,url:`/v1/push-subscriptions/${ids.subscription}/retire/extra`,headers:{'idempotency-key':'push-route-0005'},payload:{expectedVersion:1}},
      {method:'POST' as const,url:`/v1/push-subscriptions/${ids.subscription}/retire`,headers:{'idempotency-key':'push-route-0006'},payload:{expectedVersion:1,endpoint:'forbidden'}}
    ])expect((await instance.inject(request)).statusCode).toBeGreaterThanOrEqual(400);
    await instance.close();
  });
});
