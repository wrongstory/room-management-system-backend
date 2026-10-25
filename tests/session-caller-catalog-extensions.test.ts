import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// Source/mock regression only. No database/driver/process access; the real
// pg_proc/ACL interpretation and pgTAP execution are separate required gates.
const migrationUrl = new URL('../supabase/migrations/20261003140716_limited_existing_session_discovery.sql', import.meta.url);
const testUrl = new URL('../supabase/tests/limited_existing_session_discovery.sql', import.meta.url);
const migration = (await readFile(migrationUrl, 'utf8')).replaceAll('\r\n', '\n');
const sql = (await readFile(testUrl, 'utf8')).replaceAll('\r\n', '\n');
const snapshot = 'private.assert_attempt_actor_session(';
const fresh = 'private.assert_attempt_actor_session_fresh(';
const core = 'private.assert_attempt_actor_session_at_clock(';
type Kind = 'snapshot' | 'fresh';
type Acl = { grantor: string; grantee: string; privilege: string; grantable: boolean };
type Routine = { signature: string; name: string; source: string; kind: string | null; language: string | null;
  volatility: string | null; secdef: boolean | null; owner: string | null; config: string[] | null; acl: Acl[] | null };
type Extension = { signature: string; name: string; helper: Kind; volatility: string; acl: 'service-only' | 'owner-only' };
const expectedExtensions: Extension[] = [
  { signature: 'public.get_room_board_projection(uuid,uuid,date,uuid)', name: 'public.get_room_board_projection', helper: 'snapshot', volatility: 's', acl: 'service-only' },
  { signature: 'public.list_room_reports_page(uuid,uuid,uuid,integer,timestamptz,uuid)', name: 'public.list_room_reports_page', helper: 'fresh', volatility: 'v', acl: 'service-only' },
  { signature: 'public.get_post_approval_room_issue_source(uuid,uuid,uuid)', name: 'public.get_post_approval_room_issue_source', helper: 'snapshot', volatility: 's', acl: 'service-only' },
  { signature: 'private.assert_post_approval_room_issue_actor_fresh(uuid,uuid)', name: 'private.assert_post_approval_room_issue_actor_fresh', helper: 'fresh', volatility: 'v', acl: 'owner-only' },
];
const extensionIndexes = [0, 1, 2, 3];
const ownerAcl: Acl = { grantor: 'postgres', grantee: 'postgres', privilege: 'EXECUTE', grantable: false };
const serviceAcl: Acl = { grantor: 'postgres', grantee: 'service_role', privilege: 'EXECUTE', grantable: false };
const copy = <T>(value: T): T => structuredClone(value);

function required(value: string | undefined): string {
  if (value === undefined) throw new Error('SYNTHETIC_SOURCE_SHAPE_INVALID');
  return value;
}
function names(needle: string): string[] {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const section = required(migration.match(new RegExp(`\\('${escaped}',array\\[([\\s\\S]*?)\\]::text\\[\\]\\)`))?.[1]);
  return [...section.matchAll(/'((?:public|private)\.[a-z_]+)'/gu)].map((match) => required(match[1]));
}
const baselineSnapshot = names(snapshot);
const baselineFresh = names(fresh);
const baselineCore = names(core);
const initialSignatures = [...required(migration.match(/from \(values\n([\s\S]*?)\n {4}\) classified\(signature\);/u)?.[1])
  .matchAll(/'((?:public|private)\.[a-z_]+\([^']*\))'/gu)].map((match) => required(match[1]));
const originalSignatures = [...initialSignatures,
  'public.list_limited_cleaning_attempts(uuid,uuid)',
  'private.create_cleaning_submission_session_core(uuid,uuid,uuid,uuid,bigint,integer,text,text)',
  'public.get_photo_upload_receipt_with_session(uuid,uuid,uuid)',
];
const helperSignatures = ['private.assert_attempt_actor_session(uuid,uuid,boolean)',
  'private.assert_attempt_actor_session_fresh(uuid,uuid,boolean)',
  'private.assert_attempt_actor_session_at_clock(uuid,uuid,boolean,timestamptz)'];

function routine(signature: string, source: string, volatility = 'v', service = false): Routine {
  return { signature, name: signature.split('(')[0] ?? '', source, kind: 'f', language: 'plpgsql', volatility,
    secdef: true, owner: 'postgres', config: ['search_path=""'], acl: copy(service ? [ownerAcl, serviceAcl] : [ownerAcl]) };
}
function catalog(extensionCount = 0): Routine[] {
  const result = originalSignatures.map((signature) => {
    const read = baselineSnapshot.includes(signature.split('(')[0] ?? '');
    return routine(signature, read ? snapshot : fresh, read ? 's' : 'v');
  });
  result.push(routine(required(helperSignatures[0]), core, 's'), routine(required(helperSignatures[1]), core),
    routine(required(helperSignatures[2]), 'select authority without any wrapper;', 's'));
  result.push(...expectedExtensions.slice(0, extensionCount).map((e) => routine(e.signature,
    e.helper === 'snapshot' ? snapshot : fresh, e.volatility, e.acl === 'service-only')));
  return result;
}
function sameSet(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());
}
function aclMatches(actual: Acl[] | null, expected: Acl[]): boolean {
  // SQL applies acldefault('f', owner) for NULL; that includes PUBLIC EXECUTE.
  const effective = actual ?? [ownerAcl, { ...ownerAcl, grantee: 'PUBLIC' }];
  return sameSet(effective.map((a) => JSON.stringify(a)), expected.map((a) => JSON.stringify(a)));
}
function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}
function attributes(value: Routine): boolean {
  return value.kind === 'f' && value.language === 'plpgsql' && value.secdef === true && value.owner === 'postgres'
    && JSON.stringify(value.config) === JSON.stringify(['search_path=""']);
}
function classify(rows: Routine[]): { snapshot: number; fresh: number; core: number } {
  const extensions = expectedExtensions.filter((e) => rows.some((r) => r.signature === e.signature));
  for (const e of expectedExtensions) {
    const sameName = rows.filter((r) => r.name === e.name);
    if (sameName.some((r) => r.signature !== e.signature) || sameName.length > 1) throw new Error('CATALOG_OVERLOAD');
  }
  const installed = (index: number): boolean => extensions.some((e) => e.signature === expectedExtensions[index]?.signature);
  if ((installed(1) && !installed(0)) || installed(2) !== installed(3)
    || (installed(2) && (!installed(0) || !installed(1)))) throw new Error('CATALOG_ORDER');
  for (const e of extensions) {
    const value = rows.find((r) => r.signature === e.signature);
    const expectedAcl = e.acl === 'service-only' ? [ownerAcl, serviceAcl] : [ownerAcl];
    if (!value || !attributes(value) || value.volatility !== e.volatility || !aclMatches(value.acl, expectedAcl)
      || occurrences(value.source, e.helper === 'snapshot' ? snapshot : fresh) !== 1
      || occurrences(value.source, e.helper === 'snapshot' ? fresh : snapshot) !== 0 || occurrences(value.source, core) !== 0) throw new Error('CATALOG_EXTENSION_DRIFT');
  }
  const counts = { snapshot: 0, fresh: 0, core: 0 };
  for (const [kind, needle, base, volatility] of [
    ['snapshot', snapshot, baselineSnapshot, 's'], ['fresh', fresh, baselineFresh, 'v'], ['core', core, baselineCore, null],
  ] as const) {
    const actual = rows.filter((r) => r.source.includes(needle));
    const expected = [...base, ...extensions.filter((e) => e.helper === kind).map((e) => e.name)];
    if (!sameSet(actual.map((r) => r.name), expected) || (volatility && actual.some((r) => r.volatility !== volatility))) throw new Error('CATALOG_GLOBAL_DRIFT');
    counts[kind] = actual.length;
  }
  const direct = rows.filter((r) => r.source.includes(snapshot) || r.source.includes(fresh));
  if (!sameSet(direct.map((r) => r.signature), [...originalSignatures, ...extensions.map((e) => e.signature)])) throw new Error('CATALOG_SIGNATURE_DRIFT');
  for (const signature of helperSignatures) {
    const value = rows.find((r) => r.signature === signature);
    if (!value || rows.filter((r) => r.name === value.name).length !== 1 || !attributes(value)
      || !aclMatches(value.acl, [ownerAcl]) || value.volatility !== (signature.includes('_fresh(') ? 'v' : 's')) throw new Error('CATALOG_HELPER_DRIFT');
  }
  return counts;
}
function extension(rows: Routine[], index = 0): Routine {
  const e = expectedExtensions[index];
  const value = rows.find((r) => r.signature === e?.signature);
  if (!value) throw new Error('SYNTHETIC_EXTENSION_MISSING');
  return value;
}

describe('#389/#336 immutable source and bounded approved catalog declarations', () => {
  it('keeps the original migration LF UTF-8 bytes and strict install inventories immutable', () => {
    expect(createHash('sha256').update(migration, 'utf8').digest('hex')).toBe('dadd5abddedb74e9e66f20f1b970e53d3398ddabf0764b926a713aeee6e8b603');
    expect(initialSignatures).toHaveLength(21);
    expect(baselineSnapshot).toHaveLength(6); expect(baselineFresh).toHaveLength(18); expect(baselineCore).toHaveLength(2);
    expect(migration).not.toContain('public.get_room_board_projection');
    expect(migration).not.toContain('public.list_room_reports_page');
    expect(migration).not.toContain('public.get_post_approval_room_issue_source');
    expect(migration).not.toContain('private.assert_post_approval_room_issue_actor_fresh');
  });
  it('declares precisely the four approved signatures and ACL kinds, not a name or count exemption', () => {
    const section = required(sql.split('-- BEGIN APPROVED SESSION CALLER EXTENSIONS')[1]?.split('-- END APPROVED SESSION CALLER EXTENSIONS')[0]);
    const declarations = [...section.matchAll(/\('([^']+)','([^']+)','(snapshot|fresh)','([sv])','(service-only|owner-only)'\)/gu)]
      .map((m) => ({ signature: required(m[1]), name: required(m[2]), helper: required(m[3]), volatility: required(m[4]), acl: required(m[5]) }));
    expect(declarations).toEqual(expectedExtensions);
    expect(sql).toContain('where p.oid is distinct from to_regprocedure(e.signature)::oid');
    expect(sql.match(/where helper_kind='(?:snapshot|fresh)' and to_regprocedure\(signature\) is not null/gu)).toHaveLength(4);
    expect(sql).toContain("'approved installation order is baseline 6/18 then room board 7/18 then registered reports 7/19'");
    expect(sql).toContain("'approved #336 snapshot/fresh pair installs atomically after registered reports as exact 8/20 and core2'");
    for (const signature of expectedExtensions.map((e) => e.signature)) {
      expect(sql).toContain(`to_regprocedure('${signature}') is not null`);
    }
    for (const signature of expectedExtensions.slice(2).map((e) => e.signature)) {
      expect(sql).toContain(`to_regprocedure('${signature}') is null`);
    }
  });
  it('retains full public/private exact names, exact OIDs and core catalog comparison', () => {
    for (const needle of [snapshot, fresh, core]) expect(sql).toContain(`strpos(p.prosrc,'${needle}')>0`);
    for (const name of [...baselineSnapshot, ...baselineFresh, ...baselineCore]) expect(sql).toContain(`'${name}'`);
    for (const signature of originalSignatures) expect(sql).toContain(`('${signature}')`);
    expect(sql).toContain('array_agg(p.oid order by p.oid)');
    expect(sql).toContain('array_agg(to_regprocedure(signature)::oid order by to_regprocedure(signature)::oid)');
    expect(sql).toContain("n.nspname in ('public','private')");
    expect(sql).not.toMatch(/proname\s+not\s+in|proname\s*!=|proname\s*<>|count\(\*\)\s*>=|skip\(/iu);
  });
  it('enforces extension source/attributes and helper exact ACL without NULL success', () => {
    for (const source of ["p.prokind='f'", "l.lanname='plpgsql'", 'p.prosecdef', "p.proowner='postgres'::regrole",
      "p.proconfig=array['search_path=\"\"']::text[]", 'p.provolatile::text=e.volatility',
      'aclexplode(coalesce(p.proacl,acldefault(\'f\',p.proowner)))', 'a.grantor', 'a.grantee', 'a.is_grantable',
      "':EXECUTE:false'", 'coalesce((select', '),false)', "not has_function_privilege(role_name,p.oid,'EXECUTE')"])
      expect(sql).toContain(source);
    expect(sql).toContain('and same_name.proname=p.proname');
    expect(sql).toContain("and strpos(p.prosrc,'private.assert_attempt_actor_session_at_clock(')=0");
    expect(sql).toContain("case e.acl_kind when 'service-only' then");
    expect(sql).toContain("when 'owner-only' then array[(p.proowner::text||':'||p.proowner::text||':EXECUTE:false')] end");
    expect(sql).toContain("case when role_name='service_role' and e.acl_kind='service-only'");
    expect(sql).toContain("then has_function_privilege(role_name,p.oid,'EXECUTE')");
    expect(sql).toContain("else not has_function_privilege(role_name,p.oid,'EXECUTE') end");
    expect(sql).toContain("/length(case when e.helper_kind='snapshot'");
    expect(sql).toContain("else 'private.assert_attempt_actor_session_fresh(' end)=1");
  });
  it('preserves transaction rollback and original post-catalog runtime regression', () => {
    expect(sql.startsWith('begin;\nselect no_plan();\n\\ir limited_existing_session_fixture.psql')).toBe(true);
    expect(sql.endsWith('select * from finish();\nrollback;\n')).toBe(true);
    expect(sql).toContain('exact main lifecycle lock anchor rechecks session after its fresh clock');
    expect(sql).toContain('actual service old submission cannot bypass limited freeze');
    expect(sql).toContain("'42501','SESSION_REVOKED','private core denies exact hard deadline equality'");
  });
});

describe('#389/#336 approved catalog source/mock matrix (not actual pgTAP)', () => {
  it.each([[0, 6, 18], [1, 7, 18], [2, 7, 19], [4, 8, 20]])('accepts only approved installed count %i as exact %i/%i and core2', (installed, snapshotCount, freshCount) => {
    expect(classify(catalog(installed))).toEqual({ snapshot: snapshotCount, fresh: freshCount, core: 2 });
  });
  it('rejects the report extension before the room-board extension', () => {
    const rows = catalog(2).filter((r) => r.signature !== expectedExtensions[0]?.signature);
    expect(() => classify(rows)).toThrow('CATALOG_ORDER');
  });
  it.each(Array.from({ length: 16 }, (_, mask) => mask))('checks exact extension installation subset %i, not counts alone', (mask) => {
    const rows = catalog(4).filter((r) => {
      const index = expectedExtensions.findIndex((e) => e.signature === r.signature);
      return index === -1 || (mask & (1 << index)) !== 0;
    });
    if ([0, 1, 3, 15].includes(mask)) expect(() => classify(rows)).not.toThrow();
    else expect(() => classify(rows)).toThrow('CATALOG_ORDER');
  });
  it.each([2, 3])('rejects a partial #336 pair missing extension %i even with both predecessors', (index) => {
    const rows = catalog(4).filter((r) => r.signature !== expectedExtensions[index]?.signature);
    expect(() => classify(rows)).toThrow('CATALOG_ORDER');
  });
  it.each(['snapshot', 'fresh', 'core'])('rejects an unknown %s caller in the whole catalog', (kind) => {
    const rows = catalog(4); rows.push(routine('public.unknown_session_caller(uuid)', kind === 'snapshot' ? snapshot : kind === 'fresh' ? fresh : core));
    expect(() => classify(rows)).toThrow('CATALOG_GLOBAL_DRIFT');
  });
  it.each(extensionIndexes)('rejects missing exact extension %i hidden by a same-name overload', (index) => {
    const rows = catalog(4); extension(rows, index).signature = `${expectedExtensions[index]?.name}(text)`;
    expect(() => classify(rows)).toThrow('CATALOG_OVERLOAD');
  });
  it.each(extensionIndexes)('rejects an extra overload of extension %i even without helper calls', (index) => {
    const rows = catalog(4); rows.push(routine(`${expectedExtensions[index]?.name}(text)`, 'no session helper'));
    expect(() => classify(rows)).toThrow('CATALOG_OVERLOAD');
  });
  it('rejects a baseline signature replaced by the same name/count overload', () => {
    const rows = catalog(4); const baseline = rows[0]; if (!baseline) throw new Error('SYNTHETIC_BASELINE_MISSING');
    baseline.signature = `${baseline.name}(text)`;
    expect(() => classify(rows)).toThrow('CATALOG_SIGNATURE_DRIFT');
  });
  it('rejects a missing baseline plus unknown caller even when counts remain unchanged', () => {
    const rows = catalog(4); const removed = rows.shift(); if (!removed) throw new Error('SYNTHETIC_BASELINE_MISSING');
    rows.push(routine('public.unknown_replacement(uuid)', removed.source, required(removed.volatility ?? undefined)));
    expect(() => classify(rows)).toThrow('CATALOG_GLOBAL_DRIFT');
  });
  it.each(extensionIndexes)('rejects extension %i wrong helper, zero/two calls or bypass of shared core', (index) => {
    const ownNeedle = expectedExtensions[index]?.helper === 'snapshot' ? snapshot : fresh;
    for (const source of ['', ownNeedle.repeat(2), ownNeedle === snapshot ? fresh : snapshot, `${ownNeedle}${core}`, `${snapshot}${fresh}`]) {
      const rows = catalog(4); extension(rows, index).source = source;
      expect(() => classify(rows)).toThrow('CATALOG_EXTENSION_DRIFT');
    }
  });
  it.each(['kind', 'language', 'volatility', 'secdef', 'owner', 'config'] as const)('rejects each extension metadata %s drift and NULL', (field) => {
    for (const index of extensionIndexes) for (const invalid of [null, field === 'secdef' ? false : field === 'config' ? ['search_path=public'] : 'wrong']) {
      const rows = catalog(4); const value = extension(rows, index) as unknown as Record<string, unknown>; value[field] = invalid;
      expect(() => classify(rows)).toThrow('CATALOG_EXTENSION_DRIFT');
    }
  });
  it.each(['PUBLIC', 'anon', 'authenticated', 'unexpected_role'])('rejects unapproved extension ACL grantee %s', (grantee) => {
    for (const index of extensionIndexes) {
      const rows = catalog(4); extension(rows, index).acl?.push({ ...ownerAcl, grantee });
      expect(() => classify(rows)).toThrow('CATALOG_EXTENSION_DRIFT');
    }
  });
  it.each(['null', 'empty', 'owner-missing', 'service-missing', 'grant-option', 'grantor', 'privilege', 'duplicate'])('rejects extension ACL %s drift', (kind) => {
    for (const index of [0, 1, 2]) {
      const rows = catalog(4); const value = extension(rows, index);
      if (kind === 'null') value.acl = null;
      if (kind === 'empty') value.acl = [];
      if (kind === 'owner-missing') value.acl = [copy(serviceAcl)];
      if (kind === 'service-missing') value.acl = [copy(ownerAcl)];
      if (kind === 'grant-option') value.acl = [copy(ownerAcl), { ...serviceAcl, grantable: true }];
      if (kind === 'grantor') value.acl = [copy(ownerAcl), { ...serviceAcl, grantor: 'unexpected_role' }];
      if (kind === 'privilege') value.acl = [copy(ownerAcl), { ...serviceAcl, privilege: 'ALL' }];
      if (kind === 'duplicate') value.acl?.push(copy(serviceAcl));
      expect(() => classify(rows)).toThrow('CATALOG_EXTENSION_DRIFT');
    }
  });
  it.each(['service-execute', 'null', 'empty', 'owner-missing', 'grant-option', 'grantor', 'privilege', 'duplicate'])('rejects #336 private owner-only ACL %s drift', (kind) => {
    const rows = catalog(4); const value = extension(rows, 3);
    if (kind === 'service-execute') value.acl?.push(copy(serviceAcl));
    if (kind === 'null') value.acl = null;
    if (kind === 'empty') value.acl = [];
    if (kind === 'owner-missing') value.acl = [copy(serviceAcl)];
    if (kind === 'grant-option') value.acl = [{ ...ownerAcl, grantable: true }];
    if (kind === 'grantor') value.acl = [{ ...ownerAcl, grantor: 'unexpected_role' }];
    if (kind === 'privilege') value.acl = [{ ...ownerAcl, privilege: 'ALL' }];
    if (kind === 'duplicate') value.acl?.push(copy(ownerAcl));
    expect(() => classify(rows)).toThrow('CATALOG_EXTENSION_DRIFT');
  });
  it.each(helperSignatures)('rejects owner-helper metadata/ACL/overload drift: %s', (signature) => {
    for (const kind of ['service-execute', 'default-acl', 'wrong-owner', 'search-path', 'secdef', 'overload', 'missing']) {
      const rows = catalog(4); const value = rows.find((r) => r.signature === signature);
      if (!value) throw new Error('SYNTHETIC_HELPER_MISSING');
      if (kind === 'service-execute') value.acl?.push(copy(serviceAcl));
      if (kind === 'default-acl') value.acl = null;
      if (kind === 'wrong-owner') value.owner = 'service_role';
      if (kind === 'search-path') value.config = null;
      if (kind === 'secdef') value.secdef = null;
      if (kind === 'overload') rows.push(routine(`${value.name}(text)`, 'no helper'));
      if (kind === 'missing') rows.splice(rows.indexOf(value), 1);
      expect(() => classify(rows)).toThrow(/CATALOG_(?:HELPER|GLOBAL)_DRIFT/u);
    }
  });
  it('does not accept an empty catalog or a baseline caller with changed volatility', () => {
    expect(() => classify([])).toThrow('CATALOG_GLOBAL_DRIFT');
    const rows = catalog(); const value = rows[0]; if (!value) throw new Error('SYNTHETIC_BASELINE_MISSING');
    value.volatility = null;
    expect(() => classify(rows)).toThrow('CATALOG_GLOBAL_DRIFT');
  });
});
