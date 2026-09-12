import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { WebPushSubscriptionService } from './web-push-subscription.service.js';

const idempotencySchema=z.string().min(8).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const subscriptionSchema=z.object({
  endpoint:z.string().min(1).max(4096),
  expirationTime:z.number().int().safe().nullable(),
  keys:z.object({p256dh:z.string().min(1).max(256),auth:z.string().min(1).max(128)}).strict()
}).strict();
const registerSchema=z.object({
  subscription:subscriptionSchema,
  expectedCurrent:z.object({subscriptionId:z.uuid(),version:z.number().int().min(1)}).strict().optional()
}).strict();
const retireSchema=z.object({expectedVersion:z.number().int().min(1)}).strict();
const paramSchema=z.object({subscriptionId:z.uuid()}).strict();

function key(request:FastifyRequest):string{return idempotencySchema.parse(request.headers['idempotency-key']);}
function exactQuery(request:FastifyRequest):void{
  const q=new URL(request.raw.url??'/','http://backend.internal').searchParams;
  if([...q.keys()].length) throw new z.ZodError([{code:'custom',path:['query'],message:'query 항목은 허용되지 않습니다.'}]);
}

export function createWebPushSubscriptionRoutes(service:WebPushSubscriptionService):FastifyPluginAsync{
  return async(app)=>{
    app.addHook('onRequest',async(_request,reply)=>{reply.header('cache-control','no-store');});
    const authenticated=[app.authenticate,app.requirePasswordChanged];
    app.get('/config',{preHandler:authenticated},async(request)=>{
      exactQuery(request); return service.config(request.actor);
    });
    app.post('/',{preHandler:authenticated,prefixTrailingSlash:'no-slash'},async(request,reply)=>{
      exactQuery(request); const result=await service.register(request.actor,registerSchema.parse(request.body),key(request));
      return reply.code(201).send({subscription:result});
    });
    app.post('/:subscriptionId/retire',{preHandler:authenticated},async(request)=>{
      exactQuery(request); const params=paramSchema.parse(request.params); const body=retireSchema.parse(request.body);
      return {subscription:await service.retire(request.actor,{subscriptionId:params.subscriptionId,expectedVersion:body.expectedVersion},key(request))};
    });
  };
}
