import { readFile, writeFile } from 'node:fs/promises';

const files = [
  ['src/modules/rooms/google-sheets-pin.ts', 'supabase/functions/_shared/google-sheets-pin.ts'],
  ['src/modules/rooms/room-pin-sheet-sync.ts', 'supabase/functions/_shared/room-pin-sheet-sync.ts']
];
for (const [source, destination] of files) {
  const body = (await readFile(source, 'utf8')).replace(
    /(from\s+["']\.\/[a-z-]+)\.js(["'])/g,
    '$1.ts$2'
  );
  const generated = `// Generated from ${source}. DO NOT EDIT.\n${body}`;
  if (process.argv.includes('--check')) {
    if (await readFile(destination, 'utf8') !== generated) throw new Error(`Room PIN Sheet generated source drift: ${source}`);
  } else await writeFile(destination, generated);
}
