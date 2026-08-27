import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const patterns = [
  ['Supabase secret key', /\bsb_secret_[A-Za-z0-9_-]{20,}\b/g],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g],
  ['Google OAuth client secret', /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g],
  ['Google OAuth refresh token', /\b1\/\/[A-Za-z0-9_-]{20,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['Database URL with password', /postgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@/g]
];

const trackedFiles = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { encoding: 'utf8' }
)
  .split('\0')
  .filter(Boolean);
const findings = [];

for (const file of trackedFiles) {
  const content = readFileSync(file);
  if (content.includes(0) || content.byteLength > 2_000_000) continue;

  const text = content.toString('utf8');
  for (const [name, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split('\n').length;
      findings.push(`${file}:${line} ${name}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Potential secrets detected:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${trackedFiles.length} tracked files.`);
}
