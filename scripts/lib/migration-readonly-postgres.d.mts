import type { TLSSocket } from 'node:tls';
import type { BaselineMetadata } from './migration-baseline-metadata.mjs';
export function observePostgresBaselineMetadata(input: unknown,bundle: unknown): Promise<{
  mode:'POSTGRES_BASELINE_HASH_METADATA_OBSERVATION';metadata:BaselineMetadata;sourceBundleSha256:string;designSha256:string;
  baselineAccepted:false;executionAllowed:false;operationalApproval:false;DBHistoryVerified:false;fullStateVerified:false;
  driverReadbackObserved:true;tlsPeerValidated:true;readOnlySnapshotObserved:true;connectionClosed:true;
  globalCoverageVerified:false;historicalEffectsVerified:false;
}>;
export function isOwnedPostgresBaselineObservation(value: unknown): boolean;
export function migrationPostgresConnectionInput(input: unknown): {
  target: { scope: string; mode: string; projectRef: string | null; host: string; port: number; database: string; role: string };
  password: string | null; caPem: string; caFingerprints: readonly string[];
  versions: string[]; deadlineMs: number; queryMs: number; lockMs: number;
};
export function migrationPostgresTlsIdentity(client: unknown, host: string): { socket: TLSSocket; peerCertificateSha256: string };
