export function resetTable(name: string) {
  return {
    name, kind: 'r', rls: true, forceRls: false,
    columns: [{ name: 'id', position: 1, type: 'pg_catalog.uuid', nullable: false }],
    keys: [{ name: `${name.split('.')[1]}_pkey`, columns: ['id'], primary: true,
      valid: true, immediate: true, partial: false, expressions: false }],
  };
}

export function resetCatalog() {
  const profile = resetTable('public.profiles');
  profile.columns.push({ name: 'auth_user_id', position: 2, type: 'pg_catalog.uuid', nullable: false });
  return {
    format: 'reset-catalog-v2', readOnly: true,
    relations: [profile, resetTable('public.rooms')],
    boundaryRelations: [resetTable('auth.users')],
    foreignKeys: [{ source: 'public.profiles', target: 'auth.users', name: 'profiles_auth_fkey',
      definition: 'FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE RESTRICT',
      sourceColumns: ['auth_user_id'], targetColumns: ['id'], targetKey: 'users_pkey',
      match: 's', onDelete: 'r', onUpdate: 'a', validated: true, deferrable: false, initiallyDeferred: false }],
    triggers: [{ relation: 'public.profiles', name: 'guard', enabled: 'O',
      definitionHash: 'a'.repeat(32), functionHash: 'b'.repeat(32) }],
  };
}
