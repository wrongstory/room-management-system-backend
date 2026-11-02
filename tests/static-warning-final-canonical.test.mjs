// Source-only lineage checks: no database connection or SQL execution.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const source = path => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
const md5 = text => createHash('md5').update(text).digest('hex');
const signature = 'public.list_cleaning_inspections_page(uuid,uuid,timestamptz,uuid,integer)';
const historicalHash = 'a8138f7f69f796fc0dd1d8d7d8b72569';
const finalHash = '69f85dd6e4dc95fd1b17973e7fe8e5cc';

it('derives the final function from the exact original, remediation and READY patch sources', () => {
  const original = source('supabase/migrations/20260923020000_inspection_queue_pagination.sql');
  const start = original.indexOf('as $$', original.indexOf('create function public.list_cleaning_inspections_page')) + 5;
  const body = original.slice(start, original.indexOf('$$;', start));
  expect(md5(body)).toBe('af65520fb460db7dc858645f13246450');
  const remediation = source('supabase/migrations/20261003231702_db_static_warning_remediation.sql');
  expect(remediation).toContain("jsonb_build_array(E'  v_actor public.profiles;\\n', '', 1)");
  expect(remediation).toContain("'v_actor := private.assert_inspection_queue_actor('");
  expect(remediation).toContain("'perform private.assert_inspection_queue_actor(', 1)");
  const canonical = body.replace('  v_actor public.profiles;\n', '')
    .replace('v_actor := private.assert_inspection_queue_actor(', 'perform private.assert_inspection_queue_actor(');
  expect(md5(canonical)).toBe(historicalHash);
  const ready = source('supabase/migrations/20261030123748_room_ready_correction.sql');
  const patchStart = ready.indexOf(`('${signature}',`);
  expect(patchStart).toBeGreaterThan(0);
  const patch = ready.slice(patchStart, ready.indexOf("\n    ('", patchStart + 1));
  const literals = [...patch.matchAll(/'((?:''|[^'])*)'/g)].map(match => match[1].replaceAll("''", "'"));
  expect(literals).toHaveLength(3);
  expect(literals[0]).toBe(signature);
  expect(canonical.split(literals[1])).toHaveLength(2);
  expect(literals[2]).toContain('private.room_ready_cancelled_attempt(cancelled_attempt)');
  expect(md5(canonical.replace(literals[1], literals[2]))).toBe(finalHash);
});

it('keeps final-source SQL and historical100-to101 canonical checks separate and exact', () => {
  const sql = source('supabase/tests/db_static_warning_remediation.sql');
  expect(sql).toContain(`('${signature}',\n   '${finalHash}')`);
  expect(sql).not.toContain(historicalHash);
  expect(sql).toContain('select md5(prosrc) from pg_proc where oid=signature::regprocedure');
  expect(sql).toContain("('public.get_developer_room_catalog(uuid)','f9bd73161810abfaec749042fa8be758')");
  const historical = source('scripts/test-db-static-warning-upgrade.mjs');
  expect(historical).toContain(`post: '${historicalHash}'`);
  expect(historical).not.toContain(finalHash);
  expect(historical).toContain("lf: 'af65520fb460db7dc858645f13246450'");
  expect(historical).toContain("crlf: 'a5105bb901c8f1f507965e9b04f52911'");
  expect(historical).toContain('fifteen unauthorized-body rejections');
});
