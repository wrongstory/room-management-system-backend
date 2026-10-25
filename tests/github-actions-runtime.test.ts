import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const workflowsDirectory = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

const checkoutPin =
  'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6.1.0';
const setupNodePin =
  'actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6.5.0';
const setupPythonPin =
  'actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1 # v6.3.0';

async function workflows(): Promise<Array<{ name: string; source: string }>> {
  const names = (await readdir(workflowsDirectory)).filter(
    (name) => name.endsWith('.yml') || name.endsWith('.yaml'),
  );
  return Promise.all(
    names.map(async (name) => ({
      name,
      source: await readFile(`${workflowsDirectory}/${name}`, 'utf8'),
    })),
  );
}

describe('GitHub Actions runtime pins', () => {
  it('pins every runtime action use to the approved immutable Node 24 revisions', async () => {
    const sources = await workflows();
    let checkoutUses = 0;
    let setupNodeUses = 0;
    let setupPythonUses = 0;

    for (const { name, source } of sources) {
      for (const line of source.split(/\r?\n/)) {
        if (line.includes('actions/checkout@')) {
          checkoutUses += 1;
          expect(line.trim(), name).toBe(`- uses: ${checkoutPin}`);
        }
        if (line.includes('actions/setup-node@')) {
          setupNodeUses += 1;
          expect(line.trim(), name).toBe(`- uses: ${setupNodePin}`);
        }
        if (line.includes('actions/setup-python@')) {
          setupPythonUses += 1;
          expect(line.trim(), name).toBe(`- uses: ${setupPythonPin}`);
        }
      }
    }

    expect(checkoutUses).toBe(6);
    expect(setupNodeUses).toBe(5);
    expect(setupPythonUses).toBe(2);
  });

  it('keeps the application on Node 22 with explicit npm cache boundaries', async () => {
    const sources = new Map(
      (await workflows()).map(({ name, source }) => [name, source]),
    );
    const quality = sources.get('quality.yml');
    const swaggerPages = sources.get('swagger-pages.yml');

    expect(quality).toBeDefined();
    expect(quality?.match(/node-version: 22/g)).toHaveLength(2);
    expect(quality?.match(/cache: npm/g)).toHaveLength(2);
    expect(quality?.match(/cache-dependency-path: package-lock\.json/g)).toHaveLength(2);
    expect(quality?.match(/- run: npm ci/g)).toHaveLength(2);

    expect(swaggerPages).toBeDefined();
    expect(swaggerPages).toContain('node-version: 22');
    expect(swaggerPages).toContain('package-manager-cache: false');
  });
  it('keeps reservation backup opt-in, main-only and out of PR/artifact workflows', async () => {
    const source = (await workflows()).find(w => w.name === 'reservation-backup.yml')?.source;
    expect(source).toBeDefined();
    expect(source).toContain("github.ref == 'refs/heads/main' && vars.RESERVATION_BACKUP_ENABLED == 'true'");
    expect(source).toContain('environment: reservation-backup');
    expect(source).toContain('cancel-in-progress: false');
    expect(source).toContain('contents: read');
    expect(source).not.toMatch(/^\s+(pull_request|pull_request_target|push):/m);
    expect(source).not.toContain('upload-artifact');
    expect(source).not.toMatch(/db:reset|migration up|db push/);
    const alertJob = source?.split('\n  alert:')[1];
    expect(alertJob).toContain('needs: backup');
    expect(alertJob).toContain('issues: write');
    expect(alertJob).toContain("needs.backup.result != 'success'");
    expect(alertJob).not.toContain('secrets.RESERVATION_BACKUP');
    expect(alertJob).not.toContain('environment: reservation-backup');
  });
});
