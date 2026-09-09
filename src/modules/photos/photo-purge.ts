/** Server-only maintenance contract. No browser input, raw provider errors, or client clocks. */
export const PHOTO_PURGE_BATCH_LIMIT = 10;
export const PHOTO_PURGE_RUN_BUDGET_MS = 45000;
export const PHOTO_PURGE_HEARTBEAT_RESERVE_MS = 6000;
export const PHOTO_PURGE_SETTLE_RESERVE_MS = 6000;
export const PHOTO_PURGE_MIN_PROVIDER_START_MS = 250;
export type PurgeReason = 'RATE_LIMITED' | 'PROVIDER_ERROR' | 'NETWORK_ERROR';
export class PhotoPurgeError extends Error {
  constructor(readonly code: string, readonly statusCode = 503) { super(code); this.name = 'PhotoPurgeError'; }
}
export class PhotoPurgeProviderError extends PhotoPurgeError {
  constructor(readonly reason: PurgeReason) { super('PHOTO_PURGE_PROVIDER_UNAVAILABLE'); }
}
export interface PurgeProvider {
  purgeRemove(fileId: string, deadlineAt: number): Promise<'deleted' | 'not_found'>;
  purgeExists(fileId: string, deadlineAt: number): Promise<boolean>;
  purgeEmptyFolder(folderId: string, parentId: string, deadlineAt: number): Promise<'empty' | 'not_found' | 'not_empty'>;
}
interface PurgeRpcCall extends PromiseLike<{ data: unknown; error: unknown }> {
  abortSignal?(signal: AbortSignal): PromiseLike<{ data: unknown; error: unknown }>;
}
export interface PurgeRpc { rpc(name: string, args: Record<string, unknown>): PurgeRpcCall }
export interface PurgeRunResult {
  claimed: number; deleted: number; notFound: number; retryable: number; deferred: number; blocked: number;
  acceptedClaimed: number; orphanClaimed: number; folderClaimed: number;
}
interface PurgeClaim { items: Record<string, unknown>[]; blocked: number }
class PhotoPurgeDeadlineError extends Error {
  constructor() { super('PHOTO_PURGE_DEADLINE'); this.name = 'PhotoPurgeDeadlineError'; }
}
const failed = (): never => { throw new PhotoPurgeError('PHOTO_PURGE_FAILED', 500); };
function record(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return failed(); return value as Record<string, unknown>; }
function uuid(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) return failed(); return value; }
function locator(value: unknown): string { if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{10,200}$/.test(value)) return failed(); return value; }
function version(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return failed(); return value; }
export async function newPurgeClaim(): Promise<string> {
  const value = new TextEncoder().encode(`photo.purge:${crypto.randomUUID()}`);
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', value)), n => n.toString(16).padStart(2, '0')).join('');
}
export class PhotoPurgeWorker {
  constructor(private readonly db: PurgeRpc, private readonly provider: PurgeProvider, private readonly clock: () => number = Date.now) {}
  #remaining(deadlineAt: number): number { return Math.floor(deadlineAt - this.clock()); }
  #canStart(deadlineAt: number, reserve = 1): boolean { return this.#remaining(deadlineAt) >= reserve; }
  async #bounded<T>(promise: PromiseLike<T>, deadlineAt: number, capMs?: number): Promise<T> {
    const remaining = this.#remaining(deadlineAt);
    if (remaining <= 0) throw new PhotoPurgeDeadlineError();
    const timeoutMs = Math.max(1, Math.min(capMs ?? remaining, remaining));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve(promise), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PhotoPurgeDeadlineError()), timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  async rpc(name: string, args: Record<string, unknown>, deadlineAt: number): Promise<unknown> {
    const remaining = this.#remaining(deadlineAt);
    if (remaining <= 0) return failed();
    const timeoutMs = Math.max(1, Math.min(5000, remaining));
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = this.db.rpc(name, args);
      const request = raw.abortSignal ? raw.abortSignal(controller.signal) : raw;
      const response = await Promise.race([Promise.resolve(request), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new PhotoPurgeDeadlineError()); }, timeoutMs);
      })]);
      if (response.error) return failed(); return response.data;
    } catch { return failed(); }
    finally { if (timer) clearTimeout(timer); }
  }
  async #claim(name: string, claim: string, limit: number, deadlineAt: number): Promise<PurgeClaim> {
    if (limit === 0) return { items: [], blocked: 0 };
    const batch = record(await this.rpc(name, { p_claim_digest: claim, p_limit: limit }, deadlineAt));
    if (!Array.isArray(batch.items) || batch.items.length > limit) return failed();
    if (typeof batch.blocked !== 'number' || !Number.isSafeInteger(batch.blocked) || batch.blocked < 0 || batch.blocked > limit || batch.items.length + batch.blocked > limit) return failed();
    return { items: batch.items.map(record), blocked: batch.blocked };
  }
  async #remove(fileId: string, deadlineAt: number): Promise<{ outcome: 'deleted' | 'not_found' | 'retryable'; reason: PurgeReason | null }> {
    try { return { outcome: await this.#bounded(this.provider.purgeRemove(fileId, deadlineAt), deadlineAt), reason: null }; }
    catch (error) {
      let reason: PurgeReason = error instanceof PhotoPurgeProviderError ? error.reason : 'NETWORK_ERROR';
      try {
        if (this.#canStart(deadlineAt) && !await this.#bounded(this.provider.purgeExists(fileId, deadlineAt), deadlineAt)) return { outcome: 'not_found', reason: null };
      }
      catch { reason = 'NETWORK_ERROR'; }
      return { outcome: 'retryable', reason };
    }
  }
  async #files(items: Record<string, unknown>[], claim: string, kind: 'accepted' | 'orphan', providerDeadline: number, settleDeadline: number, result: PurgeRunResult): Promise<void> {
    for (const row of items) {
      // The provider deadline ends before the settle/heartbeat reserves. DB alone decides the µs due boundary.
      if (!this.#canStart(providerDeadline, PHOTO_PURGE_MIN_PROVIDER_START_MS)) { result.deferred++; continue; }
      const key = kind === 'accepted' ? { p_object_id: uuid(row.objectId) } : { p_operation_id: uuid(row.operationId) };
      const args = { ...key, p_lease_version: version(row.leaseVersion), p_claim_digest: claim };
      const context = record(await this.rpc(kind === 'accepted' ? 'get_photo_purge_context' : 'get_photo_orphan_purge_context', args, providerDeadline));
      if (context.objectId !== row.objectId) return failed();
      const fileId = locator(context.providerFileId);
      if (!this.#canStart(providerDeadline, PHOTO_PURGE_MIN_PROVIDER_START_MS)) { result.deferred++; continue; }
      const { outcome, reason } = await this.#remove(fileId, providerDeadline);
      // Failed callback leaves the DB lease for another worker: it must never report logical success.
      const settled = record(await this.rpc(kind === 'accepted' ? 'settle_photo_purge' : 'settle_photo_orphan_purge', { ...args, p_outcome: outcome, p_reason_code: reason }, settleDeadline));
      if (outcome === 'retryable' && settled.status !== 'retry' && settled.status !== 'blocked') return failed();
      if (outcome !== 'retryable' && settled.status !== 'purged') return failed();
      if (outcome === 'deleted') result.deleted++;
      else if (outcome === 'not_found') result.notFound++;
      else if (settled.status === 'blocked') result.blocked++;
      else result.retryable++;
    }
  }
  async #folders(items: Record<string, unknown>[], claim: string, providerDeadline: number, settleDeadline: number, result: PurgeRunResult): Promise<void> {
    for (const row of items) {
      if (!this.#canStart(providerDeadline, PHOTO_PURGE_MIN_PROVIDER_START_MS)) { result.deferred++; continue; }
      const args = { p_folder_registry_id: uuid(row.folderRegistryId), p_lease_version: version(row.leaseVersion), p_claim_digest: claim };
      const context = record(await this.rpc('get_photo_folder_purge_context', args, providerDeadline));
      const folderId = locator(context.providerFolderId), parentId = locator(context.parentFolderId);
      let outcome: 'deleted' | 'not_found' | 'not_empty' | 'retryable'; let reason: PurgeReason | null = null;
      try {
        const inspection = await this.#bounded(this.provider.purgeEmptyFolder(folderId, parentId, providerDeadline), providerDeadline);
        if (inspection === 'not_found') outcome = 'not_found';
        else if (inspection === 'not_empty') outcome = 'not_empty';
        else {
          if (!this.#canStart(providerDeadline, PHOTO_PURGE_MIN_PROVIDER_START_MS)) { result.deferred++; continue; }
          ({ outcome, reason } = await this.#remove(folderId, providerDeadline));
        }
      } catch (error) { outcome = 'retryable'; reason = error instanceof PhotoPurgeProviderError ? error.reason : 'NETWORK_ERROR'; }
      const settled = record(await this.rpc('settle_photo_folder_purge', { ...args, p_outcome: outcome, p_reason_code: reason }, settleDeadline));
      if ((outcome === 'retryable' || outcome === 'not_empty') && settled.status !== 'retry' && settled.status !== 'blocked') return failed();
      if (outcome !== 'retryable' && outcome !== 'not_empty' && settled.status !== 'purged') return failed();
      if (outcome === 'deleted') result.deleted++;
      else if (outcome === 'not_found') result.notFound++;
      else if (settled.status === 'blocked') result.blocked++;
      else result.retryable++;
    }
  }
  async run(): Promise<PurgeRunResult> {
    const startedAt = this.clock(), runDeadline = startedAt + PHOTO_PURGE_RUN_BUDGET_MS;
    const settleDeadline = runDeadline - PHOTO_PURGE_HEARTBEAT_RESERVE_MS;
    const providerDeadline = settleDeadline - PHOTO_PURGE_SETTLE_RESERVE_MS;
    const claim = await newPurgeClaim();
    const result: PurgeRunResult = { claimed: 0, deleted: 0, notFound: 0, retryable: 0, deferred: 0, blocked: 0, acceptedClaimed: 0, orphanClaimed: 0, folderClaimed: 0 };
    try {
      const accepted = await this.#claim('claim_due_photo_purges', claim, PHOTO_PURGE_BATCH_LIMIT, providerDeadline);
      result.acceptedClaimed = accepted.items.length; result.claimed += accepted.items.length; result.blocked += accepted.blocked;
      await this.#files(accepted.items, claim, 'accepted', providerDeadline, settleDeadline, result);
      if (this.#canStart(providerDeadline)) {
        const orphan = await this.#claim('claim_due_photo_orphan_purges', claim, PHOTO_PURGE_BATCH_LIMIT - result.claimed - result.blocked, providerDeadline);
        result.orphanClaimed = orphan.items.length; result.claimed += orphan.items.length; result.blocked += orphan.blocked;
        await this.#files(orphan.items, claim, 'orphan', providerDeadline, settleDeadline, result);
      } else result.deferred++;
      if (this.#canStart(providerDeadline)) {
        const folders = await this.#claim('claim_due_photo_folder_purges', claim, PHOTO_PURGE_BATCH_LIMIT - result.claimed - result.blocked, providerDeadline);
        result.folderClaimed = folders.items.length; result.claimed += folders.items.length; result.blocked += folders.blocked;
        await this.#folders(folders.items, claim, providerDeadline, settleDeadline, result);
      } else result.deferred++;
      await this.rpc('record_photo_purge_heartbeat', {
        p_status: result.retryable > 0 || result.deferred > 0 || result.blocked > 0 ? 'degraded' : 'succeeded', p_claimed: result.claimed,
        p_purged: result.deleted + result.notFound, p_retrying: result.retryable, p_blocked: result.blocked,
        p_accepted_claimed: result.acceptedClaimed, p_orphan_claimed: result.orphanClaimed, p_folder_claimed: result.folderClaimed,
        p_error_code: null,
      }, runDeadline);
      return result;
    } catch (error) {
      try { await this.rpc('record_photo_purge_heartbeat', { p_status: 'failed', p_claimed: result.claimed, p_purged: result.deleted + result.notFound,
        p_retrying: result.retryable, p_blocked: result.blocked, p_accepted_claimed: result.acceptedClaimed, p_orphan_claimed: result.orphanClaimed,
        p_folder_claimed: result.folderClaimed, p_error_code: 'PHOTO_PURGE_FAILED' }, runDeadline); } catch { /* original failure remains authoritative */ }
      throw error;
    }
  }
}

/** Exact dedicated route; no CORS, bearer fallback, request IDs, caller clock or payload persistence. */
export async function handlePhotoPurge(request: Request, secret: string | undefined, worker: () => Promise<PurgeRunResult>): Promise<Response> {
  const respond = (status: number, value: unknown) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
  try {
    const url = new URL(request.url);
    if (!['/photo-purge', '/functions/v1/photo-purge'].includes(url.pathname) || url.search) return respond(404, { error: { code: 'ROUTE_NOT_FOUND' } });
    if (request.method !== 'POST') return respond(405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    if (!secret || secret.length < 32 || secret.length > 4096) return respond(503, { error: { code: 'PHOTO_PURGE_NOT_CONFIGURED' } });
    const given = request.headers.get('x-photo-purge-secret') ?? '';
    if (given.length < 32 || given.length > 4096) return respond(401, { error: { code: 'INVALID_PHOTO_PURGE_SECRET' } });
    const encoder = new TextEncoder(), algorithm = { name: 'HMAC', hash: 'SHA-256' };
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), algorithm, false, ['verify']);
    const candidate = await crypto.subtle.importKey('raw', encoder.encode(given), algorithm, false, ['sign']);
    const message = encoder.encode('photo-purge-invocation');
    if (!await crypto.subtle.verify('HMAC', key, await crypto.subtle.sign('HMAC', candidate, message), message)) return respond(401, { error: { code: 'INVALID_PHOTO_PURGE_SECRET' } });
    // A hosted zero-byte POST can still have a stream. Stop at the first byte, with a short read deadline.
    if ((request.headers.get('content-length') ?? '0') !== '0') return respond(400, { error: { code: 'INVALID_PHOTO_PURGE_REQUEST' } });
    if (request.body) {
      const reader = request.body.getReader(); let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        for (let zeroChunks = 0; zeroChunks < 8; zeroChunks++) {
          const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('body timeout')), 1000); })]);
          if (timer) { clearTimeout(timer); timer = undefined; }
          if (part.done) break;
          if ((part.value?.byteLength ?? 0) > 0) { void reader.cancel().catch(() => {}); return respond(400, { error: { code: 'INVALID_PHOTO_PURGE_REQUEST' } }); }
          if (zeroChunks === 7) throw new Error('body did not terminate');
        }
      } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
    }
    const result = await worker();
    return respond(200, { result: { claimed: result.claimed, deleted: result.deleted, notFound: result.notFound, retryable: result.retryable, deferred: result.deferred, blocked: result.blocked } });
  } catch { return respond(503, { error: { code: 'PHOTO_PURGE_FAILED' } }); }
}
