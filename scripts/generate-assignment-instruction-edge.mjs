import { readFile, writeFile } from 'node:fs/promises';

const sourcePath = 'src/modules/assignments/instruction-memo.ts';
const destinationPath = 'supabase/functions/_shared/assignment-instruction-memo.ts';
const normalize = (text) => text.replace(/\r\n?/g, '\n');
const generated = `// Generated from ${sourcePath}. DO NOT EDIT.\n${normalize(await readFile(sourcePath, 'utf8'))}`;
if (process.argv.includes('--check')) {
  if (normalize(await readFile(destinationPath, 'utf8')) !== generated) {
    throw new Error('Assignment instruction memo Edge source drift');
  }
} else {
  await writeFile(destinationPath, generated);
}
