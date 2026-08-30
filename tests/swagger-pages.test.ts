import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(new URL('../scripts/build-swagger-pages.mjs', import.meta.url));
const workflowUrl = new URL('../.github/workflows/swagger-pages.yml', import.meta.url);
const templateUrl = new URL('../docs/swagger-portal/index.template.html', import.meta.url);
const initializerUrl = new URL('../docs/swagger-portal/swagger-initializer.js', import.meta.url);
const temporaryDirectories: string[] = [];
const apiBaseUrl = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/api';

async function createFixture(version = '0.2.0'): Promise<string> {
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
      paths: {
        '/health': { get: { responses: { 200: { description: 'OK' } } } },
        '/openapi.json': { get: { responses: { 200: { description: 'OK' } } } },
        '/v1/auth/login': { post: { responses: { 200: { description: 'OK' } } } }
      }
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
  it('deploys from main with minimum Pages permissions and no embedded project ref', async () => {
    const [workflow, template, initializer] = await Promise.all([
      readFile(workflowUrl, 'utf8'),
      readFile(templateUrl, 'utf8'),
      readFile(initializerUrl, 'utf8')
    ]);

    expect(workflow).toContain('branches: [main]');
    expect(workflow).toMatch(/PUBLIC_API_BASE_URL: \$\{\{ vars\.PUBLIC_API_BASE_URL \}\}/);
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
      '--output-dir',
      outputDirectory
    ]);

    const [index, initializer, specText, manifestText] = await Promise.all([
      readFile(join(outputDirectory, 'index.html'), 'utf8'),
      readFile(join(outputDirectory, 'swagger-initializer.js'), 'utf8'),
      readFile(join(outputDirectory, 'openapi.json'), 'utf8'),
      readFile(join(outputDirectory, 'portal-manifest.json'), 'utf8')
    ]);
    const spec = JSON.parse(specText) as { servers: Array<{ url: string }>; paths: object };
    const manifest = JSON.parse(manifestText) as {
      apiBaseUrl: string;
      pathCount: number;
      readOnly: boolean;
      sha256: string;
    };

    expect(index).toContain('CASTLE THE ART API');
    expect(index).toContain('0.2.0');
    expect(index).toContain('3개');
    expect(index).not.toMatch(/__[A-Z0-9_]+__/);
    expect(initializer).toContain('supportedSubmitMethods: []');
    expect(initializer).toContain('persistAuthorization: false');
    expect(initializer).toContain('tryItOutEnabled: false');
    expect(spec.servers).toEqual([{ url: apiBaseUrl, description: '운영 Supabase Edge API' }]);
    expect(Object.keys(spec.paths)).toHaveLength(3);
    expect(manifest).toMatchObject({ apiBaseUrl, pathCount: 3, readOnly: true });
    expect(manifest.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects unsafe API base URLs and untrusted API versions', async () => {
    const fixturePath = await createFixture('<script>alert(1)</script>');
    const outputDirectory = await mkdtemp(join(tmpdir(), 'swagger-pages-output-'));
    temporaryDirectories.push(outputDirectory);

    await expect(
      execFileAsync(process.execPath, [
        scriptPath,
        '--source-file',
        fixturePath,
        '--api-base-url',
        'http://example.com/functions/v1/api',
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
        '--output-dir',
        outputDirectory
      ])
    ).rejects.toThrow();
  });
});
