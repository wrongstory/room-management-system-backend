import type { Buffer } from 'node:buffer';

export const BACKUP_ARTIFACT_MAX_PAYLOAD_BYTES: number;
export type BackupArtifactKind =
  | 'database-dump'
  | 'schema-dump'
  | 'data-dump'
  | 'roles-dump'
  | 'migration-history'
  | 'verification-manifest';
export interface BackupArtifactMetadata {
  /** Exact source project reference, 20 lowercase ASCII letters. */
  projectRef: string;
  /** Fresh lowercase RFC 4122 version 4 run UUID, not a user/entity UUID. */
  runId: string;
  artifactKind: BackupArtifactKind;
  /** Verified Git source commit SHA-1, 40 lowercase hexadecimal characters. */
  sourceCommit: string;
  /** Optional SHA-256 of the entire artifact plaintext, not a person/credential field. */
  payloadSha256?: string;
}
export interface BackupArtifactLimits {
  /** Integer 0..64 MiB; defaults to the hard 64 MiB bound when options are omitted. */
  maxPayloadBytes: number;
}
/** Fresh one-time key bytes. No storage, wrapping, credential access, or disposal of caller copies. */
export function generateBackupArtifactKey(): Buffer;
/**
 * Bounded ordinary Buffer only; proxies, shared backing memory, custom prototypes,
 * and shadowed byte properties/methods are rejected. Nonce is always internal.
 */
export function encryptBackupArtifact(
  plaintext: Buffer,
  key: Buffer,
  metadata: BackupArtifactMetadata,
  options?: BackupArtifactLimits,
): Buffer;
/**
 * Ordinary Buffer inputs only, with the same byte-property restrictions as encryption.
 * Never exposes provisional plaintext: authentication and optional hash must succeed first.
 */
export function decryptBackupArtifact(
  artifact: Buffer,
  key: Buffer,
  expectedMetadata: BackupArtifactMetadata,
  options?: BackupArtifactLimits,
): { plaintext: Buffer; metadata: Readonly<BackupArtifactMetadata> };
