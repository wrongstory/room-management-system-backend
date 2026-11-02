export interface ResetCatalogRelation {
  name: string; kind: 'r' | 'p' | 'f'; rls: boolean; forceRls: boolean;
  columns: { name: string; position: number; type: string; nullable: boolean }[];
  keys: { name: string; columns: string[]; primary: boolean; valid: boolean;
    immediate: boolean; partial: boolean; expressions: boolean }[];
}
export interface ResetCatalogForeignKey {
  source: string; target: string; name: string; definition: string;
  sourceColumns: string[]; targetColumns: string[]; targetKey: string;
  match: 's' | 'f' | 'p'; onDelete: string; onUpdate: string;
  validated: boolean; deferrable: boolean; initiallyDeferred: boolean;
}
export interface ResetCatalog {
  format: 'reset-catalog-v2'; readOnly: true;
  relations: ResetCatalogRelation[]; boundaryRelations: ResetCatalogRelation[];
  foreignKeys: ResetCatalogForeignKey[];
  triggers: { relation: string; name: string; enabled: string; definitionHash: string; functionHash: string }[];
}
export function validateResetCatalog(input: unknown): {
  catalog: ResetCatalog; catalogFingerprint: string;
  unsupportedKeyCount: number; unsupportedForeignKeyCount: number; missingPrimaryKeyCount: number;
};
