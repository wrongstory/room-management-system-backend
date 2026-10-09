import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { transformSync } from 'esbuild';
import { generateReportBundle } from './generate-post-approval-report-bundle.mjs';

const image = 'denoland/deno:2.1.4@sha256:3bf75873714baa410dcf7fabaf76d806d20f0ac8a7579df11577b4ed97416e34';
const sourcePaths = [
  'supabase/functions/_shared/runtime.ts',
  'supabase/functions/_shared/activity-contract.ts',
  'supabase/functions/_shared/activity-api.ts',
  'supabase/functions/_shared/post-approval-openapi.ts',
  'supabase/functions/_shared/account-api.ts',
  'supabase/functions/_shared/availability-api.ts',
  'supabase/functions/_shared/assignment-api.ts',
  'supabase/functions/_shared/assignment-schedule-core.ts',
  'supabase/functions/_shared/attempt-api.ts',
  'supabase/functions/_shared/attempt-lifecycle-api.ts',
  'src/modules/limited-attempts/limited-attempt-contract.ts',
  'supabase/functions/_shared/attempt-offline-api.ts',
  'supabase/functions/_shared/checkout-incident-api.ts',
  'supabase/functions/_shared/checkout-incident-cursor.ts',
  'supabase/functions/_shared/cleaning-template-api.ts',
  'supabase/functions/_shared/cleaning-history-api.ts',
  'supabase/functions/_shared/work-history-api.ts',
  'supabase/functions/_shared/photo-submission-contract.ts',
  'supabase/functions/_shared/photo-upload-contract.ts',
  'supabase/functions/_shared/photo-binary.ts',
  'supabase/functions/_shared/photo-storage-name.ts',
  'supabase/functions/_shared/google-drive.ts',
  'supabase/functions/_shared/photo-service.ts',
  'supabase/functions/_shared/photo-purge.ts',
  'supabase/functions/_shared/photo-api.ts',
  'supabase/functions/_shared/inspection-cursor.ts',
  'supabase/functions/_shared/submission-api.ts',
  'supabase/functions/_shared/assignment-preview-core.ts',
  'supabase/functions/_shared/assignment-preview-api.ts',
  'supabase/functions/_shared/reservation-api.ts',
  'supabase/functions/_shared/payroll-cursor.ts',
  'supabase/functions/_shared/payroll-api.ts',
  'supabase/functions/_shared/payroll-remittance-marker-core.ts',
  'supabase/functions/_shared/payroll-remittance-marker-api.ts',
  'src/modules/payroll/payroll-remittance-marker.ts',
  'supabase/functions/_shared/payroll-work-details-core.ts',
  'supabase/functions/_shared/payroll-work-details-api.ts',
  'supabase/functions/_shared/payroll-work-details-cursor.ts',
  'src/modules/payroll/payroll-work-details.ts',
  'supabase/functions/_shared/complaint-cursor.ts',
  'supabase/functions/_shared/complaint-api.ts',
  'supabase/functions/_shared/notification-cursor.ts',
  'supabase/functions/_shared/notification-api.ts',
  'supabase/functions/_shared/web-push-binding-proof.ts',
  'supabase/functions/_shared/web-push-subscription-api.ts',
  'supabase/functions/_shared/notification-delivery-worker.ts',
  'supabase/functions/_shared/web-push-provider.ts',
  'supabase/functions/_shared/developer-api.ts',
  'supabase/functions/_shared/openapi.ts',
  'supabase/functions/_shared/room-operation-cursor.ts',
  'supabase/functions/_shared/room-api.ts',
  'supabase/functions/_shared/room-pin-crypto.ts',
  'supabase/functions/_shared/room-pin-api.ts',
  'supabase/functions/_shared/room-pin-sheet-operations-api.ts',
  'supabase/functions/_shared/google-sheets-pin.ts',
  'supabase/functions/_shared/room-pin-sheet-sync.ts',
  'supabase/functions/api/index.ts',
  'supabase/functions/reservation-scheduler/index.ts',
  'supabase/functions/_shared/scheduler-transition-count.ts',
  'supabase/functions/photo-purge/index.ts'
  ,'supabase/functions/notification-delivery/index.ts',
  'supabase/functions/room-pin-sheet-sync/index.ts'
];
const testPaths = [
  'supabase/functions/_shared/scheduler-transition-count.deno.ts',
  'supabase/functions/_shared/activity-api.deno.ts',
  'supabase/functions/_shared/account-api.deno.ts',
  'supabase/functions/_shared/availability-api.deno.ts',
  'supabase/functions/_shared/assignment-api.deno.ts',
  'supabase/functions/_shared/attempt-api.deno.ts',
  'supabase/functions/_shared/attempt-lifecycle-api.deno.ts',
  'supabase/functions/_shared/attempt-offline-api.deno.ts',
  'supabase/functions/_shared/checkout-incident-api.deno.ts',
  'supabase/functions/_shared/checkout-incident-cursor.deno.ts',
  'supabase/functions/_shared/cleaning-template-api.deno.ts',
  'supabase/functions/_shared/cleaning-history-api.deno.ts',
  'supabase/functions/_shared/work-history-api.deno.ts',
  'supabase/functions/_shared/photo-submission-contract.deno.ts',
  'supabase/functions/_shared/photo-upload-contract.deno.ts',
  'supabase/functions/_shared/photo-api.deno.ts',
  'supabase/functions/_shared/photo-storage-name.deno.ts',
  'supabase/functions/_shared/submission-api.deno.ts',
  'supabase/functions/_shared/photo-purge.deno.ts',
  'supabase/functions/_shared/photo-binary.deno.ts',
  'supabase/functions/_shared/assignment-preview-core.deno.ts',
  'supabase/functions/_shared/assignment-preview-api.deno.ts',
  'supabase/functions/_shared/reservation-api.deno.ts',
  'supabase/functions/_shared/payroll-api.deno.ts',
  'supabase/functions/_shared/payroll-remittance-marker-api.deno.ts',
  'supabase/functions/_shared/payroll-work-details-api.deno.ts',
  'supabase/functions/_shared/complaint-api.deno.ts',
  'supabase/functions/_shared/notification-api.deno.ts',
  'supabase/functions/_shared/web-push-binding-proof.deno.ts',
  'supabase/functions/_shared/web-push-subscription-api.deno.ts',
  'supabase/functions/_shared/notification-delivery-worker.deno.ts',
  'supabase/functions/_shared/web-push-provider.deno.ts',
  'supabase/functions/_shared/developer-api.deno.ts',
  'supabase/functions/_shared/openapi.deno.ts',
  'supabase/functions/_shared/room-api.deno.ts',
  'supabase/functions/_shared/room-pin-crypto.deno.ts',
  'supabase/functions/_shared/room-pin-api.deno.ts',
  'supabase/functions/_shared/room-pin-sheet-operations-api.deno.ts',
  'supabase/functions/api/index.deno.ts'
  ,'supabase/functions/api/checkout-incident-list.deno.ts'
  ,'supabase/functions/notification-delivery/index.deno.ts'
];

function runDeno(args, mountRoot = process.cwd()) {
  const result = spawnSync('docker', [
    'run',
    '--rm',
    '-v',
    `${mountRoot}:/workspace`,
    '-w',
    '/workspace',
    image,
    'deno',
    ...args
  ], { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Deno validation failed (${result.status ?? 1})`);
  }
}

/** CRLF checkout portability only: no syntax/spacing changes and never rewrite tracked sources. */
function cleanupFormatCopy(temporary, base) {
  if (dirname(temporary) !== base || !basename(temporary).startsWith('edge-fmt-') || realpathSync(temporary) !== temporary) throw new Error('Unsafe format cleanup target');
  rmSync(temporary, { recursive: true, force: false });
}
export function withLfFormatCopy(paths, check, workspace = process.cwd()) {
  const root = realpathSync(workspace), base = resolve(root, '.tmp');
  mkdirSync(base, { recursive: true });
  if (realpathSync(base) !== base) throw new Error('Unsafe format temporary base');
  const temporary = mkdtempSync(resolve(base, 'edge-fmt-'));
  try {
    for (const path of paths) {
      const source = resolve(root, path), sourceRelative = relative(root, source);
      if (isAbsolute(path) || !sourceRelative || sourceRelative.startsWith(`..${sep}`) || sourceRelative === '..' || isAbsolute(sourceRelative)) throw new Error('Unsafe format source path');
      const destination = resolve(temporary, sourceRelative);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, readFileSync(source, 'utf8').replaceAll('\r\n', '\n'));
    }
    return check(temporary);
  } finally {
    // Delete only the exact mkdtemp directory after rechecking its real absolute boundary.
    cleanupFormatCopy(temporary, base);
  }
}

export function verifyEdgeBundle() {
  withLfFormatCopy([], temporary => {
    const output = resolve(temporary, 'api.eszip');
    const relativeOutput = relative(process.cwd(), output).split(sep).join('/');
    const result = spawnSync('docker', ['run', '--rm', '-v', `${process.cwd()}:/workspace`, '-w', '/workspace/supabase/functions',
      'public.ecr.aws/supabase/edge-runtime:v1.74.3@sha256:c52405002a890ca9fcf77978671c57f3a988e03174afb277f84ac65bc917013c',
      'bundle', '--entrypoint', 'api/index.ts',
      '--static', 'api/assets/magick.wasm.gz',
      '--static', 'api/assets/magick.NOTICE',
      '--output', `/workspace/${relativeOutput}`, '--checksum', 'sha256', '--timeout', '60'], { stdio: 'inherit', timeout: 70000 });
    if (result.error || result.status !== 0) throw new Error('Pinned Edge bundle failed');
    const size = statSync(output).size;
    if (!Number.isSafeInteger(size) || size <= 0 || size >= 20000000) throw new Error('Edge bundle must remain below 20,000,000 bytes');
    console.log(`Edge bundle size gate PASS: ${size} bytes`);
  });
}

/** Candidate graph only, never writes production entrypoint/config/lock or deploys. */
export function verifyPostApprovalReportEdgeBundle({ rawSourceDiagnostic = false } = {}) {
  withLfFormatCopy([], temporary => {
    const config = JSON.parse(readFileSync('supabase/functions/deno.json', 'utf8'));
    // This diagnostic config is mounted at /output, outside the actual source
    // directory. Preserve the original base of every relative import mapping.
    const importsBase = 'file:///workspace/supabase/functions/';
    config.imports = Object.fromEntries(Object.entries(config.imports).map(([key, value]) => [
      key.startsWith('.') ? new URL(key, importsBase).href : key,
      value.startsWith('.') ? new URL(value, importsBase).href : value
    ]));
    config.imports['@imagemagick/magick-wasm'] = 'file:///workspace/supabase/functions/api/assets/magick.ts';
    writeFileSync(resolve(temporary, 'deno.json'), JSON.stringify(config));
    let reportEntry = 'file:///workspace/supabase/functions/_shared/post-approval-report-runtime.ts';
    if (!rawSourceDiagnostic) {
      const { artifact } = generateReportBundle({ check: true });
      const code = readFileSync(artifact, 'utf8').replace(/\r\n?/g, '\n');
      const runtimeImport = 'from "./runtime.ts"';
      if (!code.includes(runtimeImport)) throw new Error('Generated runtime import drift');
      writeFileSync(resolve(temporary, 'report.js'), code.replaceAll(runtimeImport,
        'from "file:///workspace/supabase/functions/_shared/runtime.ts"').replaceAll('from "./photo-binary.ts"',
        'from "file:///workspace/supabase/functions/_shared/photo-binary.ts"'));
      console.log(`Generated report JavaScript bytes: ${statSync(resolve(temporary, 'report.js')).size}`);
      const testPaths = [];
      for (const name of ['report-service', 'report-api', 'report-runtime', 'evidence-api', 'module-runtime']) {
        const source = readFileSync(`supabase/functions/_shared/post-approval-${name}.deno.ts`, 'utf8');
        const testCode = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' }).code;
        const rewritten = testCode.replaceAll(/from "\.\/post-approval-(?:report-(?:service|api|runtime|error|command)|evidence-api|module-runtime)\.ts"/g,
          'from "./report.js"').replaceAll('from "./runtime.ts"', 'from "file:///workspace/supabase/functions/_shared/runtime.ts"')
          .replaceAll('from "../api/index.ts"', 'from "file:///workspace/supabase/functions/api/index.ts"');
        const known = rewritten.replaceAll('from "./report.js"', '')
          .replaceAll('from "file:///workspace/supabase/functions/_shared/runtime.ts"', '')
          .replaceAll('from "file:///workspace/supabase/functions/api/index.ts"', '');
        if (rewritten === testCode || /from ["'][^"']+["']/.test(known)) {
          throw new Error('Generated artifact test import drift');
        }
        const testFile = resolve(temporary, `${name}.test.js`);
        writeFileSync(testFile, rewritten);
        testPaths.push(relative(process.cwd(), testFile).split(sep).join('/'));
      }
      // Execute the same service/HTTP/authentication assertions against emitted JavaScript.
      // Original TS source typechecking remains mandatory in the normal gate.
      runDeno(['test', '--allow-env=CORS_ORIGINS,POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64,SUPABASE_ANON_KEY,SUPABASE_PUBLISHABLE_KEY,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_SECRET_KEY,ACCOUNT_PHONE_PEPPER,RESERVATION_PII_KEY_BASE64,RESERVATION_GUEST_NAME_PEPPER,ROOM_PIN_KEY_BASE64,PAYROLL_CURSOR_HMAC_SECRET,NOTIFICATION_CURSOR_HMAC_SECRET,INSPECTION_CURSOR_HMAC_SECRET,WEB_PUSH_SUBSCRIPTION_KEY_BASE64,WEB_PUSH_BINDING_DIGEST_SECRET,GOOGLE_DRIVE_CLIENT_ID,GOOGLE_DRIVE_CLIENT_SECRET,GOOGLE_DRIVE_REFRESH_TOKEN,GOOGLE_DRIVE_ROOT_FOLDER_ID,GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY,SCHEDULER_INVOKE_SECRET,PHOTO_PURGE_INVOKE_SECRET,NOTIFICATION_DELIVERY_INVOKE_SECRET,ROOM_PIN_SHEET_SYNC_INVOKE_SECRET,VAPID_PRIVATE_KEY,ROOM_PIN_KEYRING_JSON,RESERVATION_PII_KEYRING_JSON,WEB_PUSH_SUBSCRIPTION_KEYRING_JSON,VAPID_KEYRING_JSON', '--frozen', '--config', 'supabase/functions/post-approval-report.deno.json',
        '--lock', 'supabase/functions/post-approval-report.deno.lock', ...testPaths]);
      reportEntry = './report.js';
    }
    writeFileSync(resolve(temporary, 'candidate.ts'),
      'export { handleApiRequest } from "file:///workspace/supabase/functions/api/index.ts";\n' +
      `export { ${rawSourceDiagnostic ? 'createSupabasePostApprovalReportEdgeHandler' : 'createSupabasePostApprovalReportEdgeHandler, createSupabasePostApprovalModuleEdgeHandler'} } from "${reportEntry}";\n`);
    const result = spawnSync('docker', ['run', '--rm', '-v', `${process.cwd()}:/workspace:ro`, '-v', `${temporary}:/output`,
      '-w', '/output',
      'public.ecr.aws/supabase/edge-runtime:v1.74.3@sha256:c52405002a890ca9fcf77978671c57f3a988e03174afb277f84ac65bc917013c',
      'bundle', '--entrypoint', '/output/candidate.ts',
      '--static', '/workspace/supabase/functions/api/assets/magick.wasm.gz', '--static', '/workspace/supabase/functions/api/assets/magick.NOTICE',
      '--output', '/output/candidate.eszip', '--checksum', 'sha256', '--timeout', '60'], { stdio: 'inherit', timeout: 70000 });
    if (result.error || result.status !== 0) throw new Error('Report candidate Edge bundle failed');
    const size = statSync(resolve(temporary, 'candidate.eszip')).size;
    console.log(`Report candidate Edge bundle bytes: ${size}`);
    if (!Number.isSafeInteger(size) || size <= 0 || size >= 20000000) throw new Error('Report candidate Edge bundle must remain below 20,000,000 bytes');
  });
}

function main() {
const reports = spawnSync(process.execPath, ['scripts/generate-post-approval-report-edge.mjs', '--check'], { stdio: 'inherit' });
if (reports.status !== 0) throw new Error('Report generated source verification failed');
// Fresh npm ci builds the ignored JS from the reviewed manifest, without rewriting it.
generateReportBundle({ assetsOnly: true });
generateReportBundle({ check: true });
// The candidate module imports the existing photo decoder wrapper at load time.
// Prepare ignored, checksum-pinned assets before any candidate Deno check on npm ci.
for (const args of [['--assets-only'], ['--check']]) {
  const generated = spawnSync(process.execPath, ['scripts/generate-photo-edge.mjs', ...args], { stdio: 'inherit' });
  if (generated.status !== 0) throw new Error('Photo generated asset verification failed');
}
const reportSpec = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/generate-post-approval-openapi.ts', '--check'], { stdio: 'inherit' });
if (reportSpec.status !== 0) throw new Error('Report generated data-only OpenAPI verification failed');
const runtimeLock = spawnSync(process.execPath, ['scripts/generate-edge-runtime-lock.mjs', '--check'], { stdio: 'inherit' });
if (runtimeLock.status !== 0) throw new Error('Edge runtime lock verification failed');
// Raw report source validation uses a separate frozen lock; actual api/index.ts
// imports the reviewed generated JS instead of the heavier raw npm/Node graph.
// Both actual entrypoint and source-plus-artifact diagnostic bundles stay size-gated.
runDeno(['test', '--allow-env=CORS_ORIGINS,POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64,SUPABASE_ANON_KEY,SUPABASE_PUBLISHABLE_KEY,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_SECRET_KEY,ACCOUNT_PHONE_PEPPER,RESERVATION_PII_KEY_BASE64,RESERVATION_GUEST_NAME_PEPPER,ROOM_PIN_KEY_BASE64,PAYROLL_CURSOR_HMAC_SECRET,NOTIFICATION_CURSOR_HMAC_SECRET,INSPECTION_CURSOR_HMAC_SECRET,WEB_PUSH_SUBSCRIPTION_KEY_BASE64,WEB_PUSH_BINDING_DIGEST_SECRET,GOOGLE_DRIVE_CLIENT_ID,GOOGLE_DRIVE_CLIENT_SECRET,GOOGLE_DRIVE_REFRESH_TOKEN,GOOGLE_DRIVE_ROOT_FOLDER_ID,GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY,SCHEDULER_INVOKE_SECRET,PHOTO_PURGE_INVOKE_SECRET,NOTIFICATION_DELIVERY_INVOKE_SECRET,ROOM_PIN_SHEET_SYNC_INVOKE_SECRET,VAPID_PRIVATE_KEY,ROOM_PIN_KEYRING_JSON,RESERVATION_PII_KEYRING_JSON,WEB_PUSH_SUBSCRIPTION_KEYRING_JSON,VAPID_KEYRING_JSON', '--frozen', '--config', 'supabase/functions/post-approval-report.deno.json',
  '--lock', 'supabase/functions/post-approval-report.deno.lock',
  'supabase/functions/_shared/post-approval-report-service.deno.ts',
  'supabase/functions/_shared/post-approval-report-api.deno.ts',
  'supabase/functions/_shared/post-approval-report-runtime.deno.ts',
  'supabase/functions/_shared/post-approval-evidence-api.deno.ts',
  'supabase/functions/_shared/post-approval-module-runtime.deno.ts']);
for (const args of [[], ['--check']]) {
  const generated = spawnSync(process.execPath, ['scripts/generate-web-push-edge.mjs', ...args], { stdio: 'inherit' });
  if (generated.status !== 0) throw new Error('Web Push provider generated source verification failed');
}
for (const args of [[], ['--check']]) {
  const generated = spawnSync(process.execPath, ['scripts/generate-room-pin-sheet-edge.mjs', ...args], { stdio: 'inherit' });
  if (generated.status !== 0) throw new Error('Room PIN Sheet generated source verification failed');
}
withLfFormatCopy([...sourcePaths, ...testPaths], temporary => runDeno(['fmt', '--check', ...sourcePaths, ...testPaths], temporary));
runDeno([
  'check',
  '--frozen',
  '--lock',
  'supabase/functions/post-approval-report.deno.lock',
  '--config',
  'supabase/functions/deno.json',
  ...sourcePaths.slice(3)
]);
runDeno([
  'test',
  '--allow-read=supabase/functions/api/assets',
  '--allow-env=CORS_ORIGINS,SUPABASE_URL,SUPABASE_ANON_KEY,SUPABASE_PUBLISHABLE_KEY,SUPABASE_SERVICE_ROLE_KEY,SUPABASE_SECRET_KEY,ACCOUNT_PHONE_PEPPER,RESERVATION_PII_KEY_BASE64,RESERVATION_PII_KEY_VERSION,RESERVATION_PII_KEYRING_JSON,RESERVATION_GUEST_NAME_PEPPER,SCHEDULER_INVOKE_SECRET,GOOGLE_DRIVE_CLIENT_ID,GOOGLE_DRIVE_CLIENT_SECRET,GOOGLE_DRIVE_REFRESH_TOKEN,GOOGLE_DRIVE_ROOT_FOLDER_ID,PHOTO_PURGE_INVOKE_SECRET,POST_APPROVAL_ROOM_ISSUE_HANDOVER_KEY_BASE64,PAYROLL_CURSOR_HMAC_SECRET,NOTIFICATION_CURSOR_HMAC_SECRET,INSPECTION_CURSOR_HMAC_SECRET,WEB_PUSH_SUBSCRIPTION_KEY_BASE64,WEB_PUSH_SUBSCRIPTION_KEY_VERSION,WEB_PUSH_SUBSCRIPTION_KEYRING_JSON,WEB_PUSH_BINDING_DIGEST_SECRET,VAPID_SUBJECT,VAPID_CURRENT_KEY_VERSION,VAPID_PUBLIC_KEY,VAPID_PUBLIC_KEYRING_JSON,VAPID_PRIVATE_KEY,VAPID_KEYRING_JSON,NOTIFICATION_DELIVERY_INVOKE_SECRET,ROOM_PIN_KEY_BASE64,ROOM_PIN_KEY_VERSION,ROOM_PIN_KEYRING_JSON,ROOM_PIN_INITIAL_DIGITS,ROOM_PIN_SHEET_SYNC_INVOKE_SECRET,GOOGLE_SHEETS_SERVICE_ACCOUNT_EMAIL,GOOGLE_SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY,GOOGLE_SHEETS_SPREADSHEET_ID,GOOGLE_SHEETS_ROOM_PIN_TAB,RUNTIME_ENVIRONMENT,SUPABASE_PROJECT_REF',
  '--frozen',
  '--lock',
  'supabase/functions/post-approval-report.deno.lock',
  '--config',
  'supabase/functions/deno.json',
  ...testPaths
]);
verifyEdgeBundle();
verifyPostApprovalReportEdgeBundle();
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--report-raw-bundle-diagnostic')) verifyPostApprovalReportEdgeBundle({ rawSourceDiagnostic: true });
  else if (process.argv.includes('--report-prebundle-diagnostic')) verifyPostApprovalReportEdgeBundle();
  else if (process.argv.includes('--report-bundle-only')) verifyPostApprovalReportEdgeBundle();
  else main();
}
