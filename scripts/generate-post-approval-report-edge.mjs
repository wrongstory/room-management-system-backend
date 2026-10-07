import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const directory = 'supabase/functions/_shared/';
const read = async path => (await readFile(path, 'utf8')).replace(/\r\n?/g, '\n');
const replace = (source, from, to) => {
  if (source.split(from).length !== 2) throw new Error(`Report Edge bridge source drift: ${from}`);
  return source.replace(from, to);
};
const files = [
  ['src/domain/actor.ts', 'post-approval-report-actor.ts'],
  ['src/lib/app-error.ts', 'post-approval-report-error.ts'],
  ['src/lib/command.ts', 'post-approval-report-command.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue-contract.ts', 'post-approval-report-contract.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue.service.ts', 'post-approval-report-service.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue.routes.ts', 'post-approval-report-http-errors.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue-upload-contract.ts', 'post-approval-evidence-contract.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue-handover-contract.ts', 'post-approval-evidence-handover-contract.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue-evidence.routes.ts', 'post-approval-evidence-http-errors.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue-evidence.service.ts', 'post-approval-evidence-service.ts'],
  ['src/modules/post-approval-room-issues/post-approval-room-issue-handover.service.ts', 'post-approval-evidence-handover-service.ts']
];
for (const [source, target] of files) {
  let value = await read(source);
  if (target.endsWith('-http-errors.ts')) {
    const declaration = target.startsWith('post-approval-evidence')
      ? 'export const postApprovalRoomIssueEvidenceHttpErrorStatuses:'
      : 'export const postApprovalRoomIssueHttpErrorStatuses:';
    const start = value.indexOf(declaration);
    const end = value.indexOf('\nfunction invalid()', start);
    if (start < 0 || end < 0) throw new Error('Report HTTP error map source drift');
    value = value.slice(start, end);
  }
  if (target.endsWith('-contract.ts') || target.endsWith('-service.ts')) {
    if (target !== 'post-approval-evidence-handover-service.ts') value = replace(value, "from 'zod'", "from 'npm:zod@4.4.3'");
    if (target.startsWith('post-approval-report') || target.endsWith('-service.ts')) value = replace(value, "from '../../domain/actor.js'", "from './post-approval-report-actor.ts'");
    value = replace(value, "from '../../lib/app-error.js'", "from './post-approval-report-error.ts'");
  }
  if (target.endsWith('-contract.ts') || target === 'post-approval-evidence-service.ts') value = replace(value, "from '../../lib/command.js'", "from './post-approval-report-command.ts'");
  if (target === 'post-approval-report-service.ts') {
    value = replace(value, "import type { SupabaseClients } from '../../lib/supabase.js';",
      "import { Buffer } from 'node:buffer';\ninterface SupabaseClients { admin: { rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> } }");
    value = replace(value, "from './post-approval-room-issue-contract.js'", "from './post-approval-report-contract.ts'");
  }
  if (target === 'post-approval-evidence-service.ts' || target === 'post-approval-evidence-handover-service.ts') {
    value = "import { Buffer } from 'node:buffer';\n" + value;
    value = replace(value, "from './post-approval-room-issue-upload-contract.js'", "from './post-approval-evidence-contract.ts'");
  }
  if (target === 'post-approval-evidence-service.ts') {
    value = replace(value, "from '../photos/google-drive.js'", "from './google-drive.ts'");
    value = replace(value, "from '../photos/photo-binary.js'", "from './photo-binary.ts'");
  }
  if (target === 'post-approval-evidence-handover-service.ts') {
    value = replace(value, "from './post-approval-room-issue-handover-contract.js'", "from './post-approval-evidence-handover-contract.ts'");
    value = replace(value, "from './post-approval-room-issue-evidence.service.js'", "from './post-approval-evidence-service.ts'");
  }
  value = `// Generated from ${source}. DO NOT EDIT.\n${value}`;
  const formatted = spawnSync('docker', ['run', '--rm', '-i', image, 'deno', 'fmt', '--ext=ts', '-'], { input: value, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (formatted.status !== 0) throw new Error('Pinned report Edge generation format failed');
  if (process.argv.includes('--check')) {
    if (await read(directory + target) !== formatted.stdout) throw new Error(`Report Edge generated drift: ${target}`);
  } else await writeFile(directory + target, formatted.stdout);
}
