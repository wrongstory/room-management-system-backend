import { createHash } from 'node:crypto';
import { BASELINE_HISTORY_FIELDS, BASELINE_CATALOG_FIELDS } from '../../scripts/lib/migration-baseline-metadata.mjs';
export type MetadataResult = { command: string; rowCount: number | null; rows: (string | null)[][];
  fields: { name: string; dataTypeID: number; format: string }[] };
export const hashMetadata = (value: string) => createHash('sha256').update(value).digest('hex');
export const metadataSelect = (fields: readonly string[], rows: (string | null)[][]): MetadataResult => ({ command: 'SELECT', rowCount: rows.length,
  rows, fields: fields.map(name => ({ name,dataTypeID: 25,format: 'text' })) });
export function baselineMetadataFixture() {
  const expected = Array.from({ length: 122 },(_,i) => ({ version: String(20261001000000+i),name: `synthetic_${i}` }));
  const history = metadataSelect(BASELINE_HISTORY_FIELDS,expected.map(row => [row.version,hashMetadata(row.name),'1','1','1','1',
    JSON.stringify([['1','9',hashMetadata('SELECT 1;')]]),'122']));
  const catalogRows = ['auth','private','public'].map(name => ['schema',hashMetadata(JSON.stringify([name])),'4',hashMetadata('null'),'3','12']);
  catalogRows.sort((a,b) => (a[1] ?? '').localeCompare(b[1] ?? ''));
  return { expected,history,catalog: metadataSelect(BASELINE_CATALOG_FIELDS,catalogRows) };
}
