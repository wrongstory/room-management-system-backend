import {describe,it,expect,vi} from 'vitest';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {feeFixture,feeCommand,feeId,feeConcurrencyLimits} from '../scripts/test-room-type-fee-concurrency.mjs';
vi.mock('node:child_process',()=>({execFileSync:vi.fn(()=>{throw new Error('DB forbidden');})}));
const input=()=>({actor:feeId(1),session:feeId(201),type:feeId(99),version:1,fee:18000,key:'fee577-unit'});
describe('fee concurrency source preparation, actual DB NOT RUN',()=>{
 it('imports and extracts only setup without executing CLI',()=>{expect(feeFixture()).toContain('bootstrap_first_developer_profile');expect(feeFixture()).not.toMatch(/no_plan|finish\(\)/);expect(execFileSync).not.toHaveBeenCalled();});
 it('uses parameters and logical payload hashes independent of retry key/session',()=>{const a=feeCommand(input());expect(a.text).not.toContain(feeId(1));expect(a.values).toContain(18000);expect(a.values[5]).toBe(true);expect(feeCommand({...input(),key:'fee577-other',session:feeId(202)}).values[7]).toBe(a.values[7]);expect(feeCommand({...input(),fee:9000}).values[7]).not.toBe(a.values[7]);});
 it.each([{fee:-1},{fee:0.1},{fee:1073741824},{version:0},{version:Number.MAX_SAFE_INTEGER},{key:"';select 1"},{actor:'remote'}])('fails before any connection for %j',patch=>expect(()=>feeCommand({...input(),...patch})).toThrow());
 it('declares six observed two-session lock races and both real creation orders',()=>{const source=readFileSync('scripts/test-room-type-fee-concurrency.mjs','utf8');expect(source.match(/await pair\(/g)).toHaveLength(6);expect(source).toContain('pg_blocking_pids');expect(source).toContain('FEE_COMMITTED_PRICE_PRECEDES_CREATION');expect(source).toContain('FEE_CREATED_TARGET_PRESERVED_AFTER_CATALOG_CHANGE');expect(source).toContain('SESSION_REVOKED');expect(source).toContain("entry.client.on('error'");expect(source).toContain('set local role service_role');expect(source).toContain('FEE_EXACT_AUDIT_AND_RECEIPT_EFFECTS');expect(source).toContain('await effects(6,15000)');expect(source).toContain('FEE_PRIOR_TARGET_FULL_ROW_PRESERVED');expect(source).toContain("'--local','--no-seed'");expect(feeConcurrencyLimits).toEqual({workMs:90000,cleanupMs:10000});});
});
