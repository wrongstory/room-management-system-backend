import type { TLSSocket } from 'node:tls';
export function migrationPostgresConnectionInput(input: unknown): {
  target: { scope: string; mode: string; projectRef: string | null; host: string; port: number; database: string; role: string };
  password: string | null; caPem: string; caFingerprints: readonly string[];
  versions: string[]; deadlineMs: number; queryMs: number; lockMs: number;
};
export function migrationPostgresTlsIdentity(client: unknown, host: string): { socket: TLSSocket; peerCertificateSha256: string };
