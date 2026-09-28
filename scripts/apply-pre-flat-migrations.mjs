// Historical upgrade assertions stop before the explicitly authorized v0.6 rewrite.
// test-flat-evidence-upgrade.mjs verifies that rewrite and its preservation receipts.
import {execFileSync} from 'node:child_process';
import {cpSync,mkdirSync,mkdtempSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
const root=mkdtempSync(join(tmpdir(),'rms-historical-upgrade-'));
try {
 mkdirSync(join(root,'supabase','migrations'),{recursive:true});
 cpSync('supabase/config.toml',join(root,'supabase','config.toml'));
 for(const file of readdirSync('supabase/migrations')) {
  if(file.endsWith('.sql')&&file.slice(0,14)<='20260926010110')cpSync(join('supabase','migrations',file),join(root,'supabase','migrations',file));
 }
 execFileSync(process.execPath,[resolve('node_modules/supabase/dist/supabase.js'),'migration','up','--local','--workdir',root],{stdio:'inherit'});
} finally { rmSync(root,{recursive:true,force:true}); }
