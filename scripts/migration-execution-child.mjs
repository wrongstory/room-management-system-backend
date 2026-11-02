/** Private IPC child. Direct invocation cannot open an execution path. */
import { copyMigrationData, exactMigrationKeys } from './lib/migration-evidence-input.mjs';

if (!process.send || !process.connected || process.argv.length !== 2) process.exitCode = 1;
else {
  let started = false; let nonce; let arm;
  const fail = () => { process.exit(1); };
  process.on('disconnect', fail);
  process.on('message', async raw => {
    try {
      const message = copyMigrationData(raw);
      if (!started) {
        exactMigrationKeys(message, ['type', 'nonce', 'args']);
        if (message.type !== 'START' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(message.nonce)) throw new Error();
        started = true; nonce = message.nonce;
        const { runMigrationCommand } = await import('./lib/migration-execution-command.mjs');
        const grant = (type, expectedType, boundary = {}) => new Promise((resolve, reject) => {
          const timer = setTimeout(() => { arm = null; reject(new Error()); }, 1000);
          arm = { expectedType, hash: boundary.requestSha256, resolve: () => { clearTimeout(timer); arm = null; resolve(); } };
          process.send({ type, nonce, ...boundary }, error => { if (error) { clearTimeout(timer); arm = null; reject(new Error()); } });
        });
        const result = await runMigrationCommand(message.args, process.stdin,
          boundary => grant('EXECUTION_READY', 'EXECUTION_ARMED', boundary), () => grant('INPUT_READY', 'INPUT_ARMED'));
        process.send({ type: 'RESULT', nonce, result }, error => {
          if (error) fail(); else { process.removeListener('disconnect', fail); process.disconnect(); }
        });
      } else {
        exactMigrationKeys(message, message.type === 'INPUT_ARMED' ? ['type', 'nonce'] : ['type', 'nonce', 'requestSha256']);
        if (!arm || message.type !== arm.expectedType || message.nonce !== nonce || message.requestSha256 !== arm.hash) throw new Error();
        arm.resolve();
      }
    } catch { fail(); }
  });
  process.send({ type: 'READY_TO_START' }, error => { if (error) fail(); });
}
