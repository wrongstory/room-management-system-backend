import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { openApiDocument } from '../supabase/functions/_shared/openapi.js';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/build-swagger-pages.mjs', import.meta.url));
const workflowUrl = new URL('../.github/workflows/swagger-pages.yml', import.meta.url);
const templateUrl = new URL('../docs/swagger-portal/index.template.html', import.meta.url);
const initializerUrl = new URL('../docs/swagger-portal/swagger-initializer.js', import.meta.url);
const temporaryDirectories: string[] = [];
const apiBaseUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/api';
const releaseContractArguments = [
  '--expected-version',
  '0.5.1',
  '--expected-path-count',
  '129',
  '--expected-operation-count',
  '139'
];

interface FixtureOptions {
  version?: string;
  pathCount?: number;
  operationCount?: number;
}

function pagesJobTimeout(workflow: string, job: 'build' | 'deploy'): number {
  const normalized = workflow.replaceAll('\r\n', '\n');
  const body = normalized.split(`\n  ${job}:\n`)[1]
    ?.split(/\n {2}[a-z][a-z0-9_-]*:\n/)[0];
  const raw = body?.match(/^ {4}timeout-minutes:[ \t]*([^\n]*)$/m)?.[1]?.trim();
  return raw && /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
}

function hasApprovedPagesBudget(workflow: string): boolean {
  const build = pagesJobTimeout(workflow, 'build');
  const deploy = pagesJobTimeout(workflow, 'deploy');
  return Number.isFinite(build) && build === 5 && Number.isFinite(deploy) && deploy === 10;
}

async function createFixture({
  version = '0.5.1',
  pathCount = 129,
  operationCount = 139
}: FixtureOptions = {}): Promise<string> {
  if (pathCount < 3 || operationCount < 3) {
    throw new Error('fixture path/operation count가 올바르지 않습니다.');
  }
  const operation = { responses: { 200: { description: 'OK' } } };
  const paths: Record<string, Record<string, typeof operation>> = {
    '/health': { get: operation },
    '/openapi.json': { get: operation },
    '/v1/auth/login': { post: operation }
  };
  for (let index = 0; Object.keys(paths).length < pathCount; index += 1) {
    paths[`/v1/release-fixture/${index}`] = {};
  }
  let remainingOperations = operationCount - 3;
  for (const pathItem of Object.values(paths)) {
    for (const method of ['get', 'post', 'patch', 'put', 'delete', 'options', 'head', 'trace']) {
      if (remainingOperations === 0) break;
      if (!(method in pathItem)) {
        pathItem[method] = operation;
        remainingOperations -= 1;
      }
    }
    if (remainingOperations === 0) break;
  }
  if (remainingOperations !== 0) {
    throw new Error('fixture operation count를 구성할 수 없습니다.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'swagger-pages-fixture-'));
  temporaryDirectories.push(directory);
  const fixturePath = join(directory, 'openapi.json');
  await writeFile(
    fixturePath,
    JSON.stringify({
      openapi: '3.1.1',
      info: {
        title: 'CASTLE THE ART Room Management API',
        version
      },
      servers: [{ url: '.' }],
      paths
    }),
    'utf8'
  );
  return fixturePath;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('GitHub Pages Swagger portal', () => {
  it('keeps the build budget at five minutes and the bounded deploy budget at ten', async () => {
    const workflow = await readFile(workflowUrl, 'utf8');
    expect(pagesJobTimeout(workflow, 'build')).toBe(5);
    expect(pagesJobTimeout(workflow, 'deploy')).toBe(10);
    expect(hasApprovedPagesBudget(workflow)).toBe(true);
  });

  it('rejects stale, missing, unbounded and non-literal Pages deployment budgets', () => {
    const fixture = (deploy: string | null, build = '5') =>
      `jobs:\n  build:\n    timeout-minutes: ${build}\n  deploy:\n${deploy === null ? '' : `    timeout-minutes: ${deploy}\n`}    steps: []\n`;
    expect(hasApprovedPagesBudget(fixture('10'))).toBe(true);
    expect(hasApprovedPagesBudget(fixture('10').replaceAll('\n', '\r\n'))).toBe(true);
    for (const timeout of [
      null, '', '5', '0', '-1', '10.5', 'Infinity', 'NaN',
      `\${{ vars.DEPLOY_TIMEOUT }}`, '9'.repeat(400)
    ]) {
      expect(hasApprovedPagesBudget(fixture(timeout))).toBe(false);
    }
    for (const timeout of ['0', '4', '10', `\${{ vars.BUILD_TIMEOUT }}`]) {
      expect(hasApprovedPagesBudget(fixture('10', timeout))).toBe(false);
    }
  });

  it('deploys only by manual dispatch with minimum Pages permissions', async () => {
    const [workflow, template, initializer] = await Promise.all([
      readFile(workflowUrl, 'utf8'),
      readFile(templateUrl, 'utf8'),
      readFile(initializerUrl, 'utf8')
    ]);

    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).not.toMatch(/^\s*push:/m);
    expect(workflow).not.toContain('branches: [main]');
    expect(workflow).toContain("if: github.ref == 'refs/heads/main'");
    expect(workflow).toMatch(/PUBLIC_API_BASE_URL: \$\{\{ vars\.PUBLIC_API_BASE_URL \}\}/);
    expect(workflow).toContain('EXPECTED_OPENAPI_VERSION: "0.6.0"');
    expect(workflow).toContain('EXPECTED_OPENAPI_PATH_COUNT: "138"');
    expect(workflow).toContain('EXPECTED_OPENAPI_OPERATION_COUNT: "149"');
    expect(workflow).toContain('--expected-version "$EXPECTED_OPENAPI_VERSION"');
    expect(workflow).toContain('--expected-path-count "$EXPECTED_OPENAPI_PATH_COUNT"');
    expect(workflow).toContain('--expected-operation-count "$EXPECTED_OPENAPI_OPERATION_COUNT"');
    expect(workflow).toContain('pages: write');
    expect(workflow).toContain('id-token: write');
    expect(workflow).toContain('actions/configure-pages@v5');
    expect(workflow).toContain('actions/upload-pages-artifact@v4');
    expect(workflow).toContain('actions/deploy-pages@v4');
    expect(workflow).not.toContain('aodikrxcczbogjpsjwjt');
    expect(template).toContain('http-equiv="Content-Security-Policy"');
    expect(template).toContain('integrity="sha384-');
    expect(initializer).toContain('supportedSubmitMethods: []');
    expect(initializer).not.toContain('localStorage');
    expect(initializer).not.toContain('sessionStorage');
  });

  it('builds a same-origin read-only portal from a validated OpenAPI document', async () => {
    const fixturePath = await createFixture();
    const outputDirectory = await mkdtemp(join(tmpdir(), 'swagger-pages-output-'));
    temporaryDirectories.push(outputDirectory);

    await execFileAsync(process.execPath, [
      scriptPath,
      '--source-file',
      fixturePath,
      '--api-base-url',
      apiBaseUrl,
      ...releaseContractArguments,
      '--output-dir',
      outputDirectory
    ]);

    const [index, initializer, specText, manifestText] = await Promise.all([
      readFile(join(outputDirectory, 'index.html'), 'utf8'),
      readFile(join(outputDirectory, 'swagger-initializer.js'), 'utf8'),
      readFile(join(outputDirectory, 'openapi.json'), 'utf8'),
      readFile(join(outputDirectory, 'portal-manifest.json'), 'utf8')
    ]);
    const spec = JSON.parse(specText) as {
      info: { version: string };
      servers: Array<{ url: string }>;
      paths: object;
    };
    const manifest = JSON.parse(manifestText) as {
      apiBaseUrl: string;
      pathCount: number;
      operationCount: number;
      readOnly: boolean;
      sha256: string;
    };

    expect(index).toContain('CASTLE THE ART API');
    expect(index).toContain('0.5.1');
    expect(index).toContain('129개');
    expect(index).not.toMatch(/__[A-Z0-9_]+__/);
    expect(initializer).toContain('supportedSubmitMethods: []');
    expect(initializer).toContain('persistAuthorization: false');
    expect(initializer).toContain('tryItOutEnabled: false');
    expect(spec.info.version).toBe('0.5.1');
    expect(spec.servers).toEqual([{ url: apiBaseUrl, description: '운영 Supabase Edge API' }]);
    expect(Object.keys(spec.paths)).toHaveLength(129);
    expect(manifest).toMatchObject({
      apiBaseUrl,
      pathCount: 129,
      operationCount: 139,
      readOnly: true
    });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('builds the exact current source contract and rejects stale release and production counts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'swagger-v08-release-'));
    temporaryDirectories.push(directory);
    const sourceFile = join(directory, 'release-openapi.json');
    await writeFile(sourceFile, JSON.stringify(openApiDocument), 'utf8');
    const outputDirectory = join(directory, 'portal');
    const args = [
      scriptPath, '--source-file', sourceFile, '--api-base-url', apiBaseUrl,
      '--expected-version', '0.6.0', '--output-dir', outputDirectory
    ];
    const result = await execFileAsync(process.execPath, [
      ...args, '--expected-path-count', '138', '--expected-operation-count', '149'
    ]);
    expect(result.stdout).toContain('version=0.6.0 paths=138 operations=149');
    const manifest = JSON.parse(await readFile(join(outputDirectory, 'portal-manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      apiVersion: '0.6.0', pathCount: 138, operationCount: 149, readOnly: true
    });
    await expect(execFileAsync(process.execPath, [
      ...args, '--expected-path-count', '131', '--expected-operation-count', '141'
    ])).rejects.toThrow(/path 수가 release 계약/);
    await expect(execFileAsync(process.execPath, [
      ...args, '--expected-path-count', '137', '--expected-operation-count', '148'
    ])).rejects.toThrow(/path 수가 release 계약/);
  });

  it('rejects the stale v0.2.0 production contract', async () => {
    const fixturePath = await createFixture({ version: '0.2.0', pathCount: 39, operationCount: 43 });
    const outputDirectory = await mkdtemp(join(tmpdir(), 'swagger-pages-output-'));
    temporaryDirectories.push(outputDirectory);

    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        '--source-file',
        fixturePath,
        '--api-base-url',
        apiBaseUrl,
        ...releaseContractArguments,
        '--output-dir',
        outputDirectory
      ])
    ).rejects.toThrow(/release 계약/);
  });

  it('rejects unsafe API base URLs and untrusted API versions', async () => {
    const fixturePath = await createFixture({ version: '<script>alert(1)</script>' });
    const outputDirectory = await mkdtemp(join(tmpdir(), 'swagger-pages-output-'));
    temporaryDirectories.push(outputDirectory);

    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        '--source-file',
        fixturePath,
        '--api-base-url',
        'http://example.com/functions/v1/api',
        ...releaseContractArguments,
        '--output-dir',
        outputDirectory
      ])
    ).rejects.toThrow();

    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        '--source-file',
        fixturePath,
        '--api-base-url',
        apiBaseUrl,
        ...releaseContractArguments,
        '--output-dir',
        outputDirectory
      ])
    ).rejects.toThrow();

    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        '--source-url',
        'https://different-project.supabase.co/functions/v1/api/openapi.json',
        '--api-base-url',
        apiBaseUrl,
        ...releaseContractArguments,
        '--output-dir',
        outputDirectory
      ])
    ).rejects.toThrow();
  });
});
