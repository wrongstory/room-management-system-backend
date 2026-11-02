import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const read = (name) => readFileSync(`supabase/migrations/${name}.sql`, 'utf8').replaceAll('\r\n', '\n');
const base = read('20260916090000_extra_proof_photo_collection');
const migration = read('20261025022445_photo_collection_upload_batch');
const signature = 'public.admit_photo_collection_upload(uuid,uuid,uuid,uuid,bigint,uuid,uuid,bigint,bigint,text)';
const opening = 'if ad.id is not null or not exists(select 1 from private.photo_upload_batch_members\n'
  + '    where actor_profile_id=p_actor_profile_id and idempotency_key_digest=p_idempotency_key_digest) then\n  ';

async function sourceParts(version) {
  const parser = require(`@pgsql/parser/v${version}`);
  const original = (await parser.parse(base)).stmts.map(({ stmt }) => stmt.CreateFunctionStmt)
    .find((fn) => fn?.funcname?.map((part) => part.String.sval).join('.') === 'public.admit_photo_collection_upload');
  const body = original.options.find(({ DefElem }) => DefElem.defname === 'as').DefElem.arg.List.items[0].String.sval;
  const patches = (await parser.parse(migration)).stmts
    .map(({ stmt }) => stmt.SelectStmt?.targetList?.[0]?.ResTarget?.val?.FuncCall)
    .filter((call) => call?.funcname?.map((part) => part.String.sval).join('.') === 'private.patch_photo_batch_source')
    .map((call) => call.args.map((arg) => arg.A_Const.sval.sval))
    .filter(([target]) => target === signature);
  return { body, patches, ratePatches: patches.filter(([, needle]) => needle.includes('photo_upload_admission_limits')) };
}

// The SQL parser does not compile PL/pgSQL string bodies. These checks enforce the
// complete counter replacement at every helper call; real DB validation is separate.
describe.each([15, 17])('photo batch migration patch boundaries, PG%s source parser', (version) => {
  it('wraps the complete existing counter statement in one balanced replacement', async () => {
    const { body, ratePatches } = await sourceParts(version);
    expect(ratePatches).toHaveLength(1);
    const [, needle, replacement] = ratePatches[0];
    const counter = body.match(/insert into private\.photo_upload_admission_limits[\s\S]*?;/)?.[0];
    expect(needle).toBe(counter);
    expect(needle).toContain('on conflict (actor_profile_id) do update set');
    expect(needle).toContain('then photo_upload_admission_limits.occurrence_count + 1 else 1 end;');
    expect(body.split(needle)).toHaveLength(2);
    expect(replacement).toBe(`${opening}${needle}\n  end if;`);
    expect(migration).not.toMatch(/check_function_bodies|exception\s+when\s+others/i);
  });

  it('keeps the intended final body and all rate, actor, quota and CAS guards unchanged', async () => {
    const { body, patches, ratePatches } = await sourceParts(version);
    expect(ratePatches).toHaveLength(1);
    const [, counter, replacement] = ratePatches[0];
    const firstLine = counter.split('\n')[0];
    const closeNeedle = 'then photo_upload_admission_limits.occurrence_count + 1 else 1 end;\n  if ad.id is null then';
    expect(body.split(firstLine)).toHaveLength(2);
    expect(body.split(closeNeedle)).toHaveLength(2);
    // The former two calls intended this final source, but the first call could
    // never compile. Compare only in memory, without executing that broken state.
    const intended = body.replace(firstLine, opening + firstLine)
      .replace(closeNeedle, closeNeedle.replace('\n  if ad.id', '\n  end if;\n  if ad.id'));
    expect(body.replace(counter, replacement)).toBe(intended);
    expect(body).toContain('lim.occurrence_count >= 30');
    for (const [, needle] of patches) expect(body.split(needle)).toHaveLength(2);
    expect(migration).toContain("raise exception 'PHOTO_BATCH_SOURCE_DRIFT: %',p_signature");
  });
});
