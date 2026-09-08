import { GoogleDriveProvider } from "./google-drive.ts";
import { initializeCompressedPhotoDecoder } from "./photo-binary.ts";
import { PhotoService } from "./photo-service.ts";
import type { EdgeClients } from "./runtime.ts";

let provider: GoogleDriveProvider | undefined;
function configuredProvider(): GoogleDriveProvider {
  provider ??= new GoogleDriveProvider({
    clientId: Deno.env.get("GOOGLE_DRIVE_CLIENT_ID") ?? "",
    clientSecret: Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET") ?? "",
    refreshToken: Deno.env.get("GOOGLE_DRIVE_REFRESH_TOKEN") ?? "",
    rootFolderId: Deno.env.get("GOOGLE_DRIVE_ROOT_FOLDER_ID") ?? "",
  });
  return provider;
}
let decoder: Promise<void> | undefined;
export function createPhotoService(clients: EdgeClients): PhotoService {
  return new PhotoService(clients.admin, configuredProvider, () => {
    decoder ??= Deno.readFile(
      new URL("../api/assets/magick.wasm.gz", import.meta.url),
    )
      .then(initializeCompressedPhotoDecoder);
    return decoder;
  });
}
