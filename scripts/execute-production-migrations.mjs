/** Public launcher. Database and approval work run only in its owned child. */
import { pathToFileURL } from 'node:url';
import { runMigrationProcess } from './lib/migration-process-supervisor.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => runMigrationProcess(process.argv.slice(2))).then(result => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.mode !== 'PLAN_ONLY' && result.code !== 'MIGRATION_SUPERVISOR_COMPLETE') process.exitCode = 1;
  }, () => { process.stderr.write('MIGRATION_EXECUTION_FAILED\n'); process.exitCode = 1; });
}
