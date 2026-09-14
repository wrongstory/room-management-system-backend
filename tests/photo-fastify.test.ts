import { readFile } from 'node:fs/promises';
import { ImageMagick, MagickColors, MagickFormat } from '@imagemagick/magick-wasm';
import Fastify from 'fastify';
import { beforeAll, describe, expect, it } from 'vitest';
import { initializePhotoDecoder } from '../src/modules/photos/photo-binary.js';
import { createPhotoRoutes, createPhotoHttpServices } from '../src/modules/photos/photo.routes.js';
import { PhotoService, type PhotoIdentity } from '../src/modules/photos/photo-service.js';
import type { PhotoProvider } from '../src/modules/photos/google-drive.js';
import type { SupabaseClients } from '../src/lib/supabase.js';
import type { AppEnv } from '../src/config/env.js';
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity: PhotoIdentity = { profileId: id(1), sessionId: id(2), role: 'maid', profileStatus: 'active' };
let jpeg: Uint8Array;
beforeAll(async () => { await initializePhotoDecoder(await readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm'))));
  jpeg = ImageMagick.read(MagickColors.White, 16, 16, image => image.write(MagickFormat.Jpeg, b => Uint8Array.from(b))); });
function pad(n:number) { const out = new Uint8Array(n), chunks = [jpeg.slice(0,2)]; let remain = n - jpeg.length;
  while(remain) { const size = Math.min(65537,remain), c = new Uint8Array(size); c.set([255,254,(size-2)>>8,(size-2)&255]); chunks.push(c);remain-=size; }
  chunks.push(jpeg.slice(2));let p=0;for(const c of chunks){out.set(c,p);p+=c.length;}return out; }
describe('Fastify photo parity through actual raw parser/router', () => {
  it('raw 307200 JPEG succeeds, 307201 rejects; malformed MIME and method aliases do not execute', async () => {
    const calls:string[]=[]; const t = new Date().toISOString();
    const service = new PhotoService({ rpc: async name => { calls.push(name);return {error:null,data:name==='admit_photo_upload'?{admissionId:id(9),quotaWarning:false}:name==='begin_admitted_photo_upload'?{
      operationId:id(5),objectId:id(6),attemptId:id(3),targetSlotId:id(4),status:'accepted',leaseVersion:1,leaseExpiresAt:null,photoId:id(7),photoVersion:1,
      uploadedAt:t,purgeAfter:new Date(Date.parse(t)+604800000).toISOString(),compensationAllowed:false
    }:null};}},()=>({} as PhotoProvider),async()=>{});
    const app=Fastify({logger:false});await app.register(createPhotoRoutes({service,authenticate:async()=>identity,denied:async()=>{}}));
    const url=`/v1/attempts/${id(3)}/photo-slots/${id(4)}/upload?assignmentId=${id(8)}&assignmentRevision=1&expectedPhotoRevision=0`;
    try {
      const good=await app.inject({method:'POST',url,headers:{'content-type':'image/jpeg','idempotency-key':'synthetic-key-01'},payload:Buffer.from(pad(307200))});
      expect(good.statusCode).toBe(200);expect(good.json().status).toBe('accepted');expect(good.headers['cache-control']).toBe('no-store');
      const large=await app.inject({method:'POST',url,headers:{'content-type':'image/jpeg','idempotency-key':'synthetic-key-02'},payload:Buffer.from(pad(307201))});
      expect(large.statusCode).toBe(413);expect(large.json().error.code).toBe('PHOTO_TOO_LARGE');
      const mime=await app.inject({method:'POST',url,headers:{'content-type':'image/png','idempotency-key':'synthetic-key-03'},payload:Buffer.from(jpeg)});
      expect(mime.statusCode).toBe(415); expect(calls.filter(x=>x==='begin_admitted_photo_upload')).toHaveLength(1);
      const alias=await app.inject({method:'GET',url});expect(alias.statusCode).toBe(404);
    } finally {await app.close();}
  });
  it('separate photo authentication validates Auth, latest status, password and active session without exposing bearer', async () => {
    let role='maid',status='active',active=true,password=false;
    const query={select:()=>query,eq:()=>query,single:async()=>({error:null,data:{id:id(1),auth_user_id:id(10),role,status,must_change_password:password}})};
    const clients={publicClient:{auth:{getUser:async()=>({data:{user:{id:id(10)}},error:null})}},admin:{from:()=>query,rpc:async()=>({data:active,error:null})}} as unknown as SupabaseClients;
    const auth=createPhotoHttpServices(clients,{} as AppEnv).authenticate;
    const request=new Request('http://local/',{headers:{authorization:`Bearer h.${Buffer.from(JSON.stringify({session_id:id(2)})).toString('base64url')}.synthetic`}});
    expect(await auth(request,false)).toEqual(identity);
    for(const s of ['deactivation_pending','upload_only']){status=s;expect((await auth(request,false)).profileStatus).toBe(s);await expect(auth(request,true)).rejects.toMatchObject({code:'ACCOUNT_INACTIVE'});}
    for(const s of ['inactive','departed']){status=s;await expect(auth(request,false)).rejects.toMatchObject({code:'CAPABILITY_ACCESS_REQUIRED'});}
    status='active';role='developer';await expect(auth(request,false)).rejects.toMatchObject({code:'CAPABILITY_ACCESS_REQUIRED'});
    role='maid';active=false;await expect(auth(request,false)).rejects.toMatchObject({code:'SESSION_REVOKED'});
    active=true;password=true;await expect(auth(request,false)).rejects.toMatchObject({code:'PASSWORD_CHANGE_REQUIRED'});
  });
});
