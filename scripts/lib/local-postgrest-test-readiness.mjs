// Local test diagnostics only: never log raw RPC errors, data, headers or input.
const knownCodes = new Set([
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '22000', '22001', '22003', '22004', '22007', '22008', '22012', '22023', '22P02',
  '23502', '23503', '23505', '23514', '23P01', '25006', '25P02', '28000', '28P01',
  '40001', '40P01', '42501', '42601', '42703', '42704', '42883', '42P01',
  '53300', '53400', '54000', '55000', '55P03', '57014', '57P01', '57P02', '57P03',
  '58000', '58030', 'XX000', 'P0001', 'P0002', 'P0003', 'P0004',
  ...[0, 1, 2, 3, 100, 101, 102, 103, 105, 106, 107, 108, 111, 112, 114, 115,
    116, 117, 118, 120, 121, 122, 123, 124, 125, 126, 127, 128, 200, 201, 202,
    203, 204, 205, 300, 301, 302, 303].map((code) => `PGRST${String(code).padStart(3, '0')}`),
  'PGRSTX00',
]);
const transientCodes = new Set(['PGRST000', 'PGRST001', 'PGRST002']);
const transientNetworkCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
]);
const requiredArguments = {
  p_actor_profile_id: 'uuid',
  p_as_of: 'timestamp with time zone',
  p_idempotency_key: 'text',
  p_request_hash: 'text',
};

function ownValue(value, property) {
  try {
    return value !== null && typeof value === 'object'
      ? Object.getOwnPropertyDescriptor(value, property)?.value
      : undefined;
  } catch { return undefined; }
}

async function boundedResponseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('INVALID_RESPONSE');
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > 4 * 1024 * 1024) throw new Error('INVALID_RESPONSE');
    chunks.push(decoder.decode(value, { stream: true }));
  }
  return JSON.parse(chunks.join('') + decoder.decode());
}

export function safeRpcResultSummary(result) {
  const status = ownValue(result, 'status');
  const code = ownValue(ownValue(result, 'error'), 'code');
  return {
    status: Number.isInteger(status) && (status === 0 || (status >= 100 && status <= 599)) ? status : null,
    code: code === undefined || code === null ? null :
      typeof code === 'string' && code.length <= 8 && /^(?:[A-Z0-9]{5}|PGRST(?:\d{3}|X00))$/.test(code)
        && knownCodes.has(code) ? code : 'UNRECOGNIZED',
  };
}

function hasRequiredRpc(spec) {
  if (ownValue(spec, 'swagger') !== '2.0') return false;
  const post = ownValue(ownValue(ownValue(spec, 'paths'), '/rpc/process_due_assignment_lifecycle'), 'post');
  const parameters = ownValue(post, 'parameters');
  if (!Array.isArray(parameters) || parameters.length > 32) return false;
  const bodies = parameters.filter((parameter) => ownValue(parameter, 'in') === 'body');
  if (bodies.length !== 1 || ownValue(bodies[0], 'required') !== true) return false;
  const schema = ownValue(bodies[0], 'schema');
  const properties = ownValue(schema, 'properties');
  const required = ownValue(schema, 'required');
  if (!properties || !Array.isArray(required) || required.length !== 4 || Object.keys(properties).length !== 4) return false;
  return Object.entries(requiredArguments).every(([name, format]) => required.includes(name)
    && ownValue(ownValue(properties, name), 'type') === 'string'
    && ownValue(ownValue(properties, name), 'format') === format);
}

/** A read-only GET gate, never a retry wrapper for a business RPC. */
export async function waitForLocalPostgrestReady({
  apiUrl, apiKey, requiredRpc = 'process_due_assignment_lifecycle', fetchImpl = fetch,
  nowImpl = () => performance.now(), sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  maxTotalMs = 30_000, maxAttempts = 30, requestTimeoutMs = 2_000, intervalMs = 250,
}) {
  let attempts = 0;
  let startedAt = 0;
  let last = { status: null, code: null };
  const fail = (kind, reason) => {
    const error = new Error(`LOCAL_POSTGREST_READINESS_${kind}`);
    error.summary = { reason, attempts, elapsedMs: Math.max(0, Math.floor(nowImpl() - startedAt)), ...last };
    throw error;
  };
  let endpoint;
  try {
    const url = new URL(apiUrl);
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname)
      || url.pathname !== '/' || url.search || url.hash || url.username || url.password
      || typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\r\n]/.test(apiKey)
      || requiredRpc !== 'process_due_assignment_lifecycle'
      || ![maxTotalMs, maxAttempts, requestTimeoutMs, intervalMs].every(Number.isInteger)
      || maxTotalMs < 1 || maxTotalMs > 30_000 || maxAttempts < 1 || maxAttempts > 30
      || requestTimeoutMs < 1 || requestTimeoutMs > maxTotalMs || intervalMs < 1 || intervalMs > maxTotalMs
      || typeof fetchImpl !== 'function' || typeof nowImpl !== 'function' || typeof sleepImpl !== 'function') {
      throw new Error('INVALID_CONFIG');
    }
    endpoint = new URL('/rest/v1/', url);
  } catch {
    // Configuration errors contain no supplied URL/key and do not touch the network.
    const error = new Error('LOCAL_POSTGREST_READINESS_INVALID_CONFIG');
    error.summary = { reason: 'invalid_config', attempts: 0, elapsedMs: 0, ...last };
    throw error;
  }
  startedAt = nowImpl();
  for (;;) {
    const remainingMs = maxTotalMs - (nowImpl() - startedAt);
    if (remainingMs <= 0 || attempts >= maxAttempts) fail('TIMEOUT', 'retry_budget_exhausted');
    attempts += 1;
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    let retry = false;
    let failureReason = 'network_error';
    try {
      const probe = (async () => {
        const response = await fetchImpl(endpoint, {
          method: 'GET', redirect: 'error', signal: controller.signal,
          headers: { apikey: apiKey, Accept: 'application/openapi+json' },
        });
        const status = response.status;
        const summary = safeRpcResultSummary({ status });
        if (summary.status === null) return { reason: 'invalid_response', retry: false, summary };
        let body;
        try { body = await boundedResponseJson(response); } catch { return { reason: 'invalid_response', retry: false, summary }; }
        if (status !== 200) {
          const errorSummary = safeRpcResultSummary({ status, error: body });
          return { reason: 'http_error', retry: status === 503 && transientCodes.has(errorSummary.code), summary: errorSummary };
        }
        return hasRequiredRpc(body) ? null : { reason: 'rpc_signature_unavailable', retry: false, summary };
      })();
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          resolve({ reason: 'probe_timeout', retry: true, summary: { status: null, code: null } });
        }, Math.min(requestTimeoutMs, remainingMs));
      });
      const outcome = await Promise.race([probe, timeout]);
      if (outcome === null) return { attempts, elapsedMs: Math.max(0, Math.floor(nowImpl() - startedAt)) };
      last = outcome.summary;
      retry = outcome.retry;
      failureReason = outcome.reason;
    } catch (error) {
      const causeCode = ownValue(ownValue(error, 'cause'), 'code') ?? ownValue(error, 'code');
      retry = timedOut || transientNetworkCodes.has(causeCode);
      // Error text, URL, cause and thrown values are deliberately discarded.
      last = { status: null, code: null };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    if (!retry) fail('FATAL', failureReason);
    if (attempts >= maxAttempts || nowImpl() - startedAt >= maxTotalMs) fail('TIMEOUT', 'retry_budget_exhausted');
    await sleepImpl(Math.min(intervalMs, maxTotalMs - (nowImpl() - startedAt)));
  }
}
