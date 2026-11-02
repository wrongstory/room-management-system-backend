import {describe,it,expect,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {SupabaseRoomService} from '../src/modules/rooms/room.service.js';
import {MAX_ROOM_TYPE_CLEANING_FEE,parseRoomTypeFeeInput,parseRoomTypeFeeResult} from '../src/modules/rooms/room-type-fee-contract.js';
import {optimizeAssignmentPreview} from '../src/modules/assignments/assignment-preview-core.js';
import {zeroPreviewSnapshot} from './fixtures/assignment-preview.js';
import {httpAdmissionRoute} from '../src/modules/developer-reset/http-admission.js';
import type {Actor} from '../src/domain/actor.js';
import type {SupabaseClients} from '../src/lib/supabase.js';
const id='40000000-0000-4000-8000-000000000001',session='50000000-0000-4000-8000-000000000001';
const actor:Actor={authUserId:id,profileId:id,role:'admin',displayName:'합성 관리자',mustChangePassword:false,
 accessToken:`e30.${Buffer.from(JSON.stringify({session_id:session})).toString('base64url')}.signature`};
const body=(fee=18000)=>({baseCleaningFee:fee,expectedVersion:1,confirmFutureTargetsOnly:true as const});
const result=(fee=18000)=>({roomTypeId:id,baseCleaningFee:fee,version:2,effectiveFor:'NEW_TARGETS_ONLY'});
function service(data:unknown=result(),error:unknown=null){const rpc=vi.fn(async()=>({data,error}));return {rpc,api:new SupabaseRoomService({admin:{rpc}} as unknown as SupabaseClients)};}
describe('admin room type cleaning fee577',()=>{
 it.each([0,1,16000,18000,1000001,MAX_ROOM_TYPE_CLEANING_FEE])('accepts integer KRW %i without repricing confirmation ambiguity',fee=>expect(parseRoomTypeFeeInput(body(fee)).baseCleaningFee).toBe(fee));
 it.each([Object.assign(Object.create(body()),{a:1,b:2,c:3}),null,{},[],{...body(),baseCleaningFee:-1},{...body(),baseCleaningFee:0.1},{...body(),baseCleaningFee:'18000'},
  {...body(),baseCleaningFee:MAX_ROOM_TYPE_CLEANING_FEE+1},{...body(),expectedVersion:0},{...body(),expectedVersion:Number.MAX_SAFE_INTEGER},
  {...body(),confirmFutureTargetsOnly:false},{baseCleaningFee:18000,expectedVersion:1},{...body(),repriceExisting:true}])('rejects malformed or retroactive requests %j',v=>expect(()=>parseRoomTypeFeeInput(v)).toThrow());
 it.each([0,18000,MAX_ROOM_TYPE_CLEANING_FEE])('binds session, type, fee, confirmation and canonical receipt hash for %i',async fee=>{
  const {api,rpc}=service(result(fee));expect(await api.setTypeCleaningFee(actor,{roomTypeId:id,body:body(fee),idempotencyKey:'fee577-key'})).toEqual(result(fee));
  expect(rpc).toHaveBeenCalledWith('set_room_type_cleaning_fee',expect.objectContaining({p_actor_profile_id:id,p_session_id:session,p_room_type_id:id,p_base_cleaning_fee:fee,p_expected_version:1,p_confirm_future_targets_only:true,p_request_hash:expect.stringMatching(/^[0-9a-f]{64}$/)}));
 });
 it.each(['maid','developer'] as const)('rejects %s before RPC',async role=>{const {api,rpc}=service();await expect(api.setTypeCleaningFee({...actor,role},{roomTypeId:id,body:body(),idempotencyKey:'fee577-key'})).rejects.toMatchObject({statusCode:403});expect(rpc).not.toHaveBeenCalled();});
 it('keeps password gate and rejects malformed ids before any RPC',async()=>{const {api,rpc}=service();await expect(api.setTypeCleaningFee({...actor,mustChangePassword:true},{roomTypeId:id,body:body(),idempotencyKey:'fee577-key'})).rejects.toMatchObject({statusCode:403});await expect(api.setTypeCleaningFee(actor,{roomTypeId:'bad',body:body(),idempotencyKey:'fee577-key'})).rejects.toMatchObject({statusCode:400});expect(rpc).not.toHaveBeenCalled();});
 it.each([['STALE_VERSION',409],['IDEMPOTENCY_KEY_REUSED',409],['ROOM_TYPE_NOT_FOUND',404],['ROOM_TYPE_CLEANING_FEE_INVALID',400],['SESSION_REVOKED',401]] as const)('preserves %s rejection',async(message,statusCode)=>{const {api}=service(null,{message,code:'P0001'});await expect(api.setTypeCleaningFee(actor,{roomTypeId:id,body:body(),idempotencyKey:'fee577-key'})).rejects.toMatchObject({statusCode,code:message});});
 it('keeps historical receipt versions and strips private output fields',()=>{expect(parseRoomTypeFeeResult({...result(),actor:'secret'},id,body())).toEqual(result());expect(parseRoomTypeFeeResult({...result(),version:1},id,body()).version).toBe(1);for(const patch of [{baseCleaningFee:999},{version:3},{roomTypeId:session},{effectiveFor:'ALL_TARGETS'}])expect(()=>parseRoomTypeFeeResult({...result(),...patch},id,body())).toThrow();});
 it.each([1000001,MAX_ROOM_TYPE_CLEANING_FEE])('keeps allocation preview valid with a supported fee %i',async fee=>{const snapshot=zeroPreviewSnapshot('2037-01-05');for(const target of snapshot.targets)target.feeSnapshot=fee;await expect(optimizeAssignmentPreview(snapshot,'fee577')).resolves.toBeDefined();});
 it('admits only the exact admin write route',()=>{expect(httpAdmissionRoute('PUT',`/v1/room-types/${id}/cleaning-fee`)).toMatchObject({routeId:'setRoomTypeCleaningFee',rpc:'set_room_type_cleaning_fee'});expect(httpAdmissionRoute('PATCH',`/v1/room-types/${id}/cleaning-fee`)).toBeUndefined();});
 it.each([15,17])('parses the append migration with PostgreSQL %i grammar only',async version=>{const parser=createRequire(import.meta.url)(`@pgsql/parser/v${version}`);expect((await parser.parse(readFileSync('supabase/migrations/20261102111756_room_type_cleaning_fee.sql','utf8'))).stmts.length).toBeGreaterThan(5);});
 it('rechecks after receipt/lock waits and never writes target/earning/payment history',()=>{const sql=readFileSync('supabase/migrations/20261102111756_room_type_cleaning_fee.sql','utf8');expect(sql.match(/private.assert_attempt_actor_session_fresh\(/g)).toHaveLength(3);expect(sql).toContain("hashtextextended('room-management:reservation-command',0)");expect(sql).toContain('for update');expect(sql).toContain('item.version<>p_expected_version');expect(sql).toContain('private.complete_command');expect(sql).not.toMatch(/(?:update|delete from|insert into) public\.(?:cleaning_targets|earnings|payroll_items|payroll_cycles)/i);});
});
