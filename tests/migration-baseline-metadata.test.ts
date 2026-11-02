import { createRequire } from 'node:module';
import { describe,expect,it,vi } from 'vitest';
import { BASELINE_METADATA_QUERIES,BASELINE_METADATA_QUERY_SHA256,BASELINE_OUTPUT_CONFIGURE_SQL,BASELINE_OUTPUT_READ_SQL,decodeBaselineMetadata,readBaselineMetadata } from '../scripts/lib/migration-baseline-metadata.mjs';
import { baselineMetadataFixture,hashMetadata } from './helpers/baseline-metadata.js';
const { Parser } = createRequire(import.meta.url)('@pgsql/parser') as { Parser: new (o: { version: number }) => { parse(sql: string): Promise<{ stmts: { stmt: object }[] }> } };
describe('#14 hash-only metadata projection without a database',() => {
  it('decodes exact122 history and stable hashed catalog with no acceptance/live authority',() => {
    const f=baselineMetadataFixture(),r=decodeBaselineMetadata(f.history,f.catalog,f.expected);
    expect(r.history).toHaveLength(122);expect(r.catalog).toHaveLength(3);
    expect(r).toMatchObject({ baselineAccepted:false,executionAllowed:false,liveObservationVerified:false,globalCoverageVerified:false,historicalEffectsVerified:false });
    expect(r.querySha256).toBe(BASELINE_METADATA_QUERY_SHA256);expect(Object.isFrozen(r.catalog[0])).toBe(true);
    expect(JSON.stringify(r)).not.toContain('SELECT 1');
  });
  it.each([15,17])('parses every fixed statement as SELECT only on PostgreSQL %i',async version => {
    for(const sql of [...Object.values(BASELINE_METADATA_QUERIES),BASELINE_OUTPUT_CONFIGURE_SQL,BASELINE_OUTPUT_READ_SQL]) {
      const parsed=await new Parser({ version }).parse(sql);expect(parsed.stmts).toHaveLength(1);
      expect(Object.keys(parsed.stmts[0]?.stmt ?? {})).toEqual(['SelectStmt']);
    }
  });
  it('does not project definition/body/name or read business/Auth rows/sequence values',() => {
    const c=BASELINE_METADATA_QUERIES.catalog;
    expect(c).toContain('FROM pg_catalog.pg_sequence');expect(c).not.toMatch(/\bFROM\s+(?:ONLY\s+)?(?:public|private|auth)\./iu);
    expect(c).not.toMatch(/\b(?:last_value|is_called|rolpassword|encrypted_password|token|amr)\b/iu);
    expect(c.slice(c.lastIndexOf(' SELECT kind'))).toContain('definition_sha256');
    expect(c.slice(c.lastIndexOf(' SELECT kind'))).not.toContain('definition::text');
    expect(BASELINE_METADATA_QUERIES.history).toContain('statement_hashes');
    expect(BASELINE_METADATA_QUERIES.history).not.toContain('array_to_json(statements)');
  });
  it.each(['count','order','missing','name','version','dimensions','null','ordinal','bytes','hash','extra','type'])( 'rejects history %s drift',kind => {
    const f=baselineMetadataFixture();const r=f.history.rows[0];if(!r)throw new Error();
    if(kind==='count')r[7]='123';if(kind==='order')f.history.rows.reverse();
    if(kind==='missing'){f.history.rows.pop();f.history.rowCount=121;}
    if(kind==='name')r[1]=hashMetadata('another');if(kind==='version')r[0]='20261002000000';
    if(kind==='dimensions')r[2]='2';if(kind==='null')r[6]=null;
    if(kind==='ordinal')r[6]=JSON.stringify([['2','9','a'.repeat(64)]]);
    if(kind==='bytes')r[6]=JSON.stringify([['1','2097153','a'.repeat(64)]]);
    if(kind==='hash')r[6]=JSON.stringify([['1','9','SQL private text']]);
    if(kind==='extra')r.push('unexpected');if(kind==='type'){const field=f.history.fields[0];if(!field)throw new Error();field.dataTypeID=23;}
    expect(()=>decodeBaselineMetadata(f.history,f.catalog,f.expected)).toThrow('BASELINE_METADATA_UNAVAILABLE');
  });
  it.each(['count','duplicate','order','missing-schema','size','hash','kind','width'])('rejects catalog %s ambiguity',kind => {
    const f=baselineMetadataFixture();const r=f.catalog.rows[0];if(!r)throw new Error();
    if(kind==='count')r[4]='4';if(kind==='duplicate')f.catalog.rows[1]=[...r];if(kind==='order')f.catalog.rows.reverse();
    if(kind==='missing-schema')r[1]='0'.repeat(64);if(kind==='size')r[5]='33554433';
    if(kind==='hash')r[3]='secret';if(kind==='kind')r[0]='unknown-class';if(kind==='width')r.pop();
    expect(()=>decodeBaselineMetadata(f.history,f.catalog,f.expected)).toThrow('BASELINE_METADATA_UNAVAILABLE');
  });
  it('uses fixed queries only and suppresses driver/parser error details',async () => {
    const f=baselineMetadataFixture(),query=vi.fn().mockResolvedValueOnce(f.history).mockResolvedValueOnce(f.catalog);
    expect((await readBaselineMetadata(query,f.expected)).history).toHaveLength(122);
    expect(query.mock.calls.map(c=>c[0])).toEqual([BASELINE_METADATA_QUERIES.history,BASELINE_METADATA_QUERIES.catalog]);
    await expect(readBaselineMetadata(async()=>{throw new Error('secret provider connection');},f.expected)).rejects.toThrow(/^BASELINE_METADATA_UNAVAILABLE$/);
  });
  it('rejects getter/clone-shaped expectation tricks without invoking getters',() => {
    const f=baselineMetadataFixture(),get=vi.fn();Object.defineProperty(f.expected[0],'name',{get,enumerable:true});
    expect(()=>decodeBaselineMetadata(f.history,f.catalog,f.expected)).toThrow();expect(get).not.toHaveBeenCalled();
  });
  it('retains unsupported object evidence without treating it as accepted coverage',() => {
    const f=baselineMetadataFixture();f.catalog.rows.push(['unsupported','a'.repeat(64),'4','b'.repeat(64),'4','16']);
    for(const r of f.catalog.rows){r[4]='4';r[5]='16';}f.catalog.rowCount=4;
    expect(decodeBaselineMetadata(f.history,f.catalog,f.expected)).toMatchObject({unsupportedObjectCount:1,globalCoverageVerified:false,baselineAccepted:false});
  });
});
