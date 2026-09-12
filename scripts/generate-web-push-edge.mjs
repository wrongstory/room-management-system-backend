import { readFile, writeFile } from 'node:fs/promises';

const source = 'src/modules/notifications/web-push-provider.ts';
const destination = 'supabase/functions/_shared/web-push-provider.ts';
const generated = `// Generated from ${source}. DO NOT EDIT.\n${await readFile(source, 'utf8')}`;

if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== generated) throw new Error('Web Push provider Edge source drift');
} else {
  await writeFile(destination, generated);
}
