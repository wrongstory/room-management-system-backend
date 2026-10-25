import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { checkServerIdentity, TLSSocket } from 'node:tls';
import { Client, type CustomTypesConfig } from 'pg';
import { z } from 'zod';
import { migrationPostgresConnectionInput, migrationPostgresTlsIdentity } from '../../../scripts/lib/migration-readonly-postgres.mjs';
import { inspectResetReadOnlySource, inspectResetReadOnlyReview, type OpenResetReadClient } from './snapshot-read-source.js';

const inputSchema = z.object({
  source: z.object({ catalog: z.unknown(), binding: z.object({ projectRef: z.string(), sourceCommit: z.string(),
    catalogFingerprint: z.string(), classificationFingerprint: z.string() }).strict(), database: z.literal('postgres'), role: z.string() }).strict(),
  connection: z.object({ target: z.unknown(), credential: z.unknown(), caPem: z.unknown() }).strict(),
}).strict();
const types: CustomTypesConfig = { getTypeParser: ((oid: number, format: string) => {
  if (oid !== 25 || format !== 'text') throw new Error('RESET_NATIVE_TEXT_CODEC_INVALID');
  return (value: string) => value;
}) as CustomTypesConfig['getTypeParser'] };
type OwnedClient = Client & { connection: EventEmitter & { stream?: TLSSocket };
  password: string | null; connectionParameters: { password: string | null } };
const unavailable = () => ({ snapshotValid: false, executionEnabled: false, fingerprint: null, counts: null,
  consistency: null, blockers: ['RESET_NATIVE_INPUT_OR_CONNECTION_INVALID'], liveDatabaseVerified: false });

/** Internal native transport entry. No factory, caller SQL, environment fallback,
 * generic query handle, public route or execution authority is exported. Actual
 * live SQL/permissions still need approved validation; synthetic tests are not it.
 */
export async function inspectResetNativePostgres(input: unknown, signal?: AbortSignal) {
  return inspectNative(input, signal);
}
/** Internal review-only entry; uses the identical owned TLS/read-only connection. */
export function inspectResetNativeReview(input: unknown, request: unknown, signal?: AbortSignal) {
  return inspectNative(input, signal, request ?? null);
}
async function inspectNative(input: unknown, signal?: AbortSignal, request?: unknown) {
  let settings: ReturnType<typeof migrationPostgresConnectionInput> | undefined;
  try {
    const parsed = inputSchema.safeParse(input); if (!parsed.success) return unavailable();
    const { source, connection } = parsed.data;
    settings = migrationPostgresConnectionInput({ ...connection, expectedVersions: [], deadlineMs: 4500, queryMs: 4000 });
    if (settings.target.scope !== 'SUPABASE' || settings.target.projectRef !== source.binding.projectRef ||
        settings.target.database !== source.database || settings.target.role !== source.role || signal?.aborted) return unavailable();
    const validated = settings;
    const open: OpenResetReadClient = async (abort, bounds) => {
      if (abort.aborted || bounds.maxWireBytes !== 16 * 1024 * 1024 || bounds.deadlineMilliseconds !== 4500 || !validated.password) throw new Error('RESET_NATIVE_CONNECTION_INVALID');
      const config = { host: validated.target.host, port: validated.target.port, database: validated.target.database,
        user: validated.target.mode === 'session' ? `${validated.target.role}.${validated.target.projectRef}` : validated.target.role,
        password: validated.password, ssl: { ca: validated.caPem, rejectUnauthorized: true, checkServerIdentity, minVersion: 'TLSv1.2' as const },
        sslnegotiation: 'postgres' as const, application_name: `rms_reset_native_${randomUUID()}`, client_encoding: 'UTF8', replication: 'false' as const,
        options: '-c default_transaction_read_only=on -c standard_conforming_strings=on -c statement_timeout=4000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=4000',
        connectionTimeoutMillis: 4000, query_timeout: 4000, statement_timeout: 4000, lock_timeout: 1000,
        idle_in_transaction_session_timeout: 4000, binary: false, pipeline: false, enableChannelBinding: true, scramMaxIterations: 100000, types };
      const client = new Client(config) as OwnedClient;
      let socket: TLSSocket | undefined, broken = false, cleaned = false, ending: Promise<void> | undefined, bytes = 0;
      const clean = () => {
        if (cleaned) return; cleaned = true;
        abort.removeEventListener('abort', destroy); socket?.removeListener('data', onData);
        client.connection.removeListener('sslconnect', onTls);
        (client as unknown as { password: string | null }).password = null; client.connectionParameters.password = null;
        (config as { password: string | null }).password = null;
      };
      const end = () => {
        ending ??= Promise.resolve().then(() => client.end());
        return ending;
      };
      const destroy = () => {
        broken = true;
        try { client.connection.stream?.destroy(); } catch { /* Native errors never escape. */ }
        clean(); void end().catch(() => {});
      };
      const onData = (chunk: unknown) => {
        if (!Buffer.isBuffer(chunk)) { destroy(); return; }
        bytes += chunk.byteLength; if (bytes > bounds.maxWireBytes) destroy();
      };
      const onTls = () => {
        const stream = client.connection.stream;
        if (!(stream instanceof TLSSocket) || !stream.encrypted || socket) { destroy(); return; }
        socket = stream; socket.disableRenegotiation(); socket.prependListener('data', onData);
      };
      // Keep the inert client error handler after teardown: late native errors
      // must not become uncaught EventEmitter errors or expose provider details.
      abort.addEventListener('abort', destroy, { once: true }); client.on('error', destroy); client.connection.once('sslconnect', onTls);
      try {
        await client.connect();
        const peer = migrationPostgresTlsIdentity(client, validated.target.host);
        if (broken || abort.aborted || peer.socket !== socket) throw new Error('RESET_NATIVE_TLS_INVALID');
        const checkPeer = () => {
          const current = migrationPostgresTlsIdentity(client, validated.target.host);
          if (broken || abort.aborted || current.socket !== socket || current.peerCertificateSha256 !== peer.peerCertificateSha256) throw new Error('RESET_NATIVE_TLS_INVALID');
        };
        return {
          async query(text, values, querySignal) {
            try {
              if (querySignal !== abort) throw new Error('RESET_NATIVE_SCOPE_INVALID'); checkPeer();
              const query = { text, values: [...values], rowMode: 'array' as const, binary: false, types, query_timeout: 4000 };
              const result = await client.query(query);
              checkPeer(); return result;
            } catch { destroy(); throw new Error('RESET_NATIVE_QUERY_FAILED'); }
          },
          destroy,
          async close() {
            try { checkPeer(); await end(); if (broken || abort.aborted) throw new Error('RESET_NATIVE_CLOSE_FAILED'); }
            catch { destroy(); throw new Error('RESET_NATIVE_CLOSE_FAILED'); }
            finally { clean(); }
          },
        };
      } catch { destroy(); throw new Error('RESET_NATIVE_CONNECTION_FAILED'); }
    };
    return await (request === undefined ? inspectResetReadOnlySource(source, open, signal)
      : inspectResetReadOnlyReview(source, request, open, signal));
  } catch { return unavailable(); }
  finally { if (settings) settings.password = null; }
}
