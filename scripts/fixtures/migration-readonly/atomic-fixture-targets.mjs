/** Isolated test identities only. These names never select a network destination. */
export const ATOMIC_FIXTURE_SUITE_NAME = 'actual isolated atomic PG17 writer and independent committed readback';
export const ATOMIC_FIXTURE_TARGETS = Object.freeze([
  ['commit', 'a', 'commits exact SQL and history once and verifies the real state'],
  ['history-loss', 'b', 'rolls back real SQL after transport loss: history-loss'],
  ['before-commit', 'c', 'rolls back real SQL after transport loss: before-commit'],
  ['after-commit', 'd', 'reconciles an acknowledged-server COMMIT whose response is hidden'],
  ['constraint', 'e', 'rolls back a real constraint failure without recording history'],
  ['readback-loss', 'f', 'keeps UNKNOWN when committed readback is unavailable; it never retries SQL'],
  ['wrong-ca', 'g', 'rejects an actual untrusted TLS peer before SQL'],
  ['advisory-lock', 'h', 'respects a real held project advisory lock before SQL'],
].map(([caseId, letter, title]) => {
  const project = letter.repeat(20);
  return Object.freeze({ caseId, project, host: `db.${project}.supabase.co`, title,
    fullName: `${ATOMIC_FIXTURE_SUITE_NAME} ${title}` });
}));

const reject = () => { throw new Error('FIXTURE_TRANSPORT_REJECTED'); };

export function atomicFixtureTarget(caseId) {
  const target = ATOMIC_FIXTURE_TARGETS.find(item => item.caseId === caseId);
  if (!target) reject();
  return target;
}

/** Preserve real TLS/driver options, but only the current owned case can reach loopback. */
export function mapAtomicFixtureConnection(config, target, port) {
  if (!ATOMIC_FIXTURE_TARGETS.includes(target) || !Number.isInteger(port) || port <= 1024 || port > 65535
    || !config || config.host !== target.host || config.port !== 5432
    || config.database !== 'postgres' || config.user !== 'postgres'
    || typeof config.application_name !== 'string' || !config.application_name.startsWith('rms_mig_')) reject();
  return { ...config, host: '127.0.0.1', port };
}
