// Synthetic OS child only: no database/credentials/import of production execution code.
process.once('message', message => {
  const nonce = message.nonce;
  const mode = process.argv[2];
  if (mode === 'block-preflight') { while (true) { /* intentionally block this owned child */ } }
  if (mode === 'unexpected-output') { process.stdout.write('SYNTHETIC_PRIVATE_OUTPUT'); return; }
  process.send({ type: 'INPUT_READY', nonce });
  process.once('message', () => {
    process.stdin.resume();
    process.stdin.once('end', () => {
      process.send({ type: 'EXECUTION_READY', nonce, requestSha256: 'a'.repeat(64), overallMs: mode === 'complete' ? 1000 : 40 });
      process.once('message', () => {
        if (mode === 'complete') {
          process.send({ type: 'RESULT', nonce, result: { mode: 'APPLY_RESULT', classification: 'APPLIED', code: 'MIGRATION_SUPERVISOR_COMPLETE', appliedCount: 1, pendingCount: 1,
            requestSha256: 'a'.repeat(64), runId: '20000000-0000-4000-8000-000000000001', elapsedMs: 1, retryAllowed: false, evidenceScope: 'TRUSTED_ADAPTER_RESULTS', fullDbProofRunId: 1 } }, () => process.disconnect());
        } else while (true) { /* parent watchdog must remain responsive */ }
      });
    });
  });
});
process.send({ type: 'READY_TO_START' });
