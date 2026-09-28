import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const cli='node_modules/supabase/dist/supabase.js';
const run=(cmd,args,input)=>execFileSync(cmd,args,{encoding:'utf8',input,stdio:input?['pipe','pipe','pipe']:'inherit'});
const sql=input=>run('docker',['exec','-i','supabase_db_room-management-system-backend','psql','-X','-qAt','-v','ON_ERROR_STOP=1','-U','postgres','-d','postgres'],input).trim();
const snapshot=()=>sql(`select md5(string_agg(data,'|' order by data)) from (
 select row_to_json(x)::text data from public.cleaning_submissions x union all
 select row_to_json(x)::text from private.attempt_photo_versions x union all
 select row_to_json(x)::text from private.submission_photo_bindings x) all_rows;`);
try {
 run(process.execPath,[cli,'db','reset','--local','--no-seed','--version','20260926010110']);
 const fixture=readFileSync('supabase/tests/photo_submission_base.sql','utf8').split('-- Flat workflow:')[0]
   .replace('\\ir room_pin_fixture.psql',()=>readFileSync('supabase/tests/room_pin_fixture.psql','utf8'));
 sql(`create extension if not exists pgtap with schema extensions; set search_path=public,extensions;\n${fixture}\nCOMMIT;`);
 const before=snapshot();
 const eligible=Number(sql(`select count(*) from public.cleaning_targets t where t.status not in ('approved','cancelled')
 and exists(select 1 from public.cleaning_template_versions v join public.room_types rt on rt.id=v.room_type_id where v.status='published' and v.cleaning_kind=t.cleaning_kind and rt.code=t.room_type_snapshot->>'code')
 and not exists(select 1 from public.cleaning_attempts a where a.cleaning_target_id=t.id and (a.status<>'scheduled' or a.started_at is not null))
 and not exists(select 1 from private.photo_upload_admissions p where p.cleaning_target_id=t.id)
 and not exists(select 1 from private.photo_upload_operations p where p.cleaning_target_id=t.id)
 and not exists(select 1 from private.attempt_photo_versions p where p.cleaning_target_id=t.id);`));
 assert(eligible>0,'Upgrade fixture must contain untouched legacy targets');
 run(process.execPath,[cli,'migration','up','--local']);
 assert.equal(snapshot(),before,'Existing submissions and photo versions remain byte-for-byte unchanged');
 assert.equal(Number(sql('select count(*) from private.flat_evidence_migration_receipts')),eligible);
 assert.equal(sql(`select bool_and(c.ready and c.frozen_snapshot->'slots'=private.flat_cleaning_photo_slots())
 from private.target_photo_snapshot_contracts c join private.flat_evidence_migration_receipts r on r.cleaning_target_id=c.cleaning_target_id;`),'t');
 console.log(`Flat evidence upgrade: PASS; ${eligible} untouched targets converted, submitted photos preserved.`);
} finally {
 run(process.execPath,[cli,'db','reset','--local','--no-seed']);
}
