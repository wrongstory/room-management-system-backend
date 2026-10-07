import { readFile } from 'node:fs/promises';
import type { AppEnv } from '../../config/env.js';
import { initializePhotoDecoder } from './photo-binary.js';
import { GoogleDriveProvider, type PhotoProvider } from './google-drive.js';

export interface PhotoRuntimeDependencies {
  provider: () => PhotoProvider;
  initializeDecoder: () => Promise<void>;
}

/** Shared lazy dependencies only. Construction never contacts Drive, reads WASM,
 * changes authentication policy, starts workers or schedules provider deletion. */
export function createPhotoRuntimeDependencies(env: Pick<AppEnv,
  'GOOGLE_DRIVE_CLIENT_ID' | 'GOOGLE_DRIVE_CLIENT_SECRET' | 'GOOGLE_DRIVE_REFRESH_TOKEN' | 'GOOGLE_DRIVE_ROOT_FOLDER_ID'>): PhotoRuntimeDependencies {
  let provider: GoogleDriveProvider | undefined;
  let decoder: Promise<void> | undefined;
  return Object.freeze({
    provider() {
      provider ??= new GoogleDriveProvider({
        clientId: env.GOOGLE_DRIVE_CLIENT_ID ?? '',
        clientSecret: env.GOOGLE_DRIVE_CLIENT_SECRET ?? '',
        refreshToken: env.GOOGLE_DRIVE_REFRESH_TOKEN ?? '',
        rootFolderId: env.GOOGLE_DRIVE_ROOT_FOLDER_ID ?? ''
      });
      return provider;
    },
    initializeDecoder() {
      decoder ??= readFile(new URL(import.meta.resolve('@imagemagick/magick-wasm/magick.wasm')))
        .then(initializePhotoDecoder);
      return decoder;
    }
  });
}
