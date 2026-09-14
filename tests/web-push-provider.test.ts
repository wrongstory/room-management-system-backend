import { createECDH } from 'node:crypto';
import { describe,expect,it,vi } from 'vitest';
import { encryptWebPushAes128Gcm,parseRetryAfter,RfcWebPushProvider,validateWebPushProviderConfig } from '../src/modules/notifications/web-push-provider.js';

const decode=(value:string)=>new Uint8Array(Buffer.from(value,'base64url'));
const receiver='BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const auth='BTBZMqHH6r4Tts7J_aSIgg';
const senderPublic='BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const senderPrivate='yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw';
const notificationId='60000000-0000-4000-8000-000000000006';
const payload=JSON.stringify({notificationId,title:'PIN 1234 홍길동',body:'raw secret',deepLink:{kind:'cleaningTarget',entityId:'50000000-0000-4000-8000-000000000005'}});
const subscription={endpoint:'https://fcm.googleapis.com/send/opaque?token=%2F',expirationTime:null,keys:{p256dh:receiver,auth}};
const config={subject:'mailto:push@example.com',currentVersion:'v1',current:{publicKey:senderPublic,privateKey:senderPrivate},keyring:{}};

describe('RFC Web Push provider',()=>{
  it('matches the RFC 8291 official aes128gcm vector byte for byte',async()=>{
    const body=await encryptWebPushAes128Gcm('When I grow up, I want to be a watermelon',receiver,auth,{salt:decode('DGv6ra1nlYgDCS1FRnbzlw'),senderPrivateKey:decode(senderPrivate),senderPublicKey:decode(senderPublic)});
    expect(Buffer.from(body).toString('base64url')).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  });
  it('validates that each configured VAPID public/private key pair matches',async()=>{
    await expect(validateWebPushProviderConfig(config)).resolves.toBeUndefined();
    const other=createECDH('prime256v1');other.generateKeys();
    await expect(validateWebPushProviderConfig({...config,current:{...config.current,privateKey:other.getPrivateKey().toString('base64url')}})).rejects.toThrow();
    for(const subject of ['mailto:not-an-address','mailto:a@example.com?subject=leak','http://example.com','https://user@example.com/contact','https://example.com/contact#fragment']){
      await expect(validateWebPushProviderConfig({...config,subject})).rejects.toThrow();
    }
  });
  it.each([[201,'accepted'],[202,'accepted'],[204,'accepted'],[404,'endpoint_gone'],[410,'endpoint_gone'],[400,'payload_rejected'],[413,'payload_rejected'],[408,'retryable'],[500,'retryable'],[503,'retryable'],[401,'provider_configuration_error'],[403,'provider_configuration_error'],[302,'provider_configuration_error']])('maps provider status %i without reading body',async(status,outcome)=>{
    const fetcher=vi.fn(async()=>new Response(status===204?null:'forbidden raw provider body',{status}));
    const result=await new RfcWebPushProvider(config,fetcher as typeof fetch,()=>1_000).send(subscription,payload,notificationId,5_000,'v1');
    expect(result.outcome).toBe(outcome);expect(fetcher).toHaveBeenCalledOnce();
  });
  it('normalizes Retry-After and keeps endpoint/title/PIN out of encrypted request bytes',async()=>{
    let request:RequestInit|undefined;
    const provider=new RfcWebPushProvider(config,async(_url,init)=>{request=init;return new Response(null,{status:429,headers:{'retry-after':'99999'}});},()=>1_000);
    expect(await provider.send(subscription,payload,notificationId,5_000,'v1')).toEqual({outcome:'retryable',reason:'RATE_LIMITED',retryAfterSeconds:3600});
    const body=Buffer.from(request?.body as Uint8Array).toString('utf8');expect(body).not.toContain('1234');expect(body).not.toContain('홍길동');expect((request?.redirect)).toBe('manual');
    expect(parseRetryAfter(new Date(4_000).toUTCString(),1_000)).toBe(3);
  });
  it('rejects SSRF/disallowed hosts and unknown VAPID versions before fetch',async()=>{
    for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://push.apple.com/x','https://evilpush.apple.com/x','https://fcm.googleapis.com:444/x','https://user@fcm.googleapis.com/x']){
      const fetcher=vi.fn();const result=await new RfcWebPushProvider(config,fetcher as typeof fetch,()=>0).send({...subscription,endpoint},payload,notificationId,5_000,'v1');expect(result.outcome).toBe('provider_configuration_error');expect(fetcher).not.toHaveBeenCalled();
    }
    const fetcher=vi.fn();expect((await new RfcWebPushProvider(config,fetcher as typeof fetch,()=>0).send(subscription,payload,notificationId,5_000,'missing')).outcome).toBe('provider_configuration_error');expect(fetcher).not.toHaveBeenCalled();
  });
  it('maps abort and network failures without leaking raw error detail',async()=>{
    const network=new RfcWebPushProvider(config,vi.fn(async()=>{throw new Error('DNS endpoint secret');}) as typeof fetch,()=>0);
    expect(await network.send(subscription,payload,notificationId,5_000,'v1')).toEqual({outcome:'retryable',reason:'NETWORK_ERROR'});
    expect((await network.send(subscription,payload,notificationId,-1,'v1'))).toEqual({outcome:'retryable',reason:'TIMEOUT'});
  });
});
