import { readFile, writeFile } from 'node:fs/promises';

const files = [
  ['src/modules/notifications/web-push-provider.ts', 'supabase/functions/_shared/web-push-provider.ts'],
  ['src/modules/push-subscriptions/web-push-binding-proof.ts', 'supabase/functions/_shared/web-push-binding-proof.ts']
];
for (const [source,destination] of files) {
  const generated = `// Generated from ${source}. DO NOT EDIT.\n${await readFile(source, 'utf8')}`;
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8') !== generated) throw new Error(`Web Push generated source drift: ${source}`);
  } else {
    await writeFile(destination, generated);
  }
}
