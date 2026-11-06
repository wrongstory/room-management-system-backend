import {describe, expect, it} from 'vitest';
import {forceRecallArgs, recallProjection} from '../src/modules/assignments/force-recall.js';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const parser = createRequire(import.meta.url)('@pgsql/parser/v17');
const target = '10000000-0000-4000-8000-000000000142';
const body = {expectedCurrentAssignmentId:target,expectedAssignmentVersion:4,expectedAttemptId:target,expectedExecutionVersion:3};
describe('dedicated admin force recall',()=>{
  it('binds current assignment and attempt versions and strips private response data',()=>{
    const args=forceRecallArgs(body,target,target,target)!;
    expect(args.p_expected_execution_version).toBe(3);
    const result={cleaningTargetId:target,assignmentId:target,attemptId:target,reassignTargetId:target,assignmentVersion:5,status:'unassigned'};
    expect(recallProjection({...result,private:'hidden'},args)).toEqual(result);
    expect(recallProjection({...result,status:'submitted'},args)).toBeNull();
  });
  it.each([{...body,expectedAttemptId:null},{...body,expectedExecutionVersion:0},{...body,reasonCode:'MAID_INJURED'}])('rejects stale shape and aliases',input=>{
    expect(forceRecallArgs(input,target,target,target)).toBeNull();
  });
  it('parses the new migration and isolated rollback scenario without executing SQL',async()=>{
    for(const file of ['supabase/migrations/20261106041703_assignment_force_recall.sql','supabase/tests/assignment_force_recall.sql']){
      expect((await parser.parse(readFileSync(file,'utf8'))).stmts.length).toBeGreaterThan(8);
    }
  });
});
