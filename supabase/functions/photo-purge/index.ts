import { GoogleDriveProvider } from "../_shared/google-drive.ts";
import { handlePhotoPurge, PhotoPurgeWorker } from "../_shared/photo-purge.ts";
import { createEdgeClients } from "../_shared/runtime.ts";

// No business-user route or actor credential; operator explicitly provisions this separate secret.
Deno.serve((request) =>
  handlePhotoPurge(
    request,
    Deno.env.get("PHOTO_PURGE_INVOKE_SECRET"),
    async () => {
      const provider = new GoogleDriveProvider({
        clientId: Deno.env.get("GOOGLE_DRIVE_CLIENT_ID") ?? "",
        clientSecret: Deno.env.get("GOOGLE_DRIVE_CLIENT_SECRET") ?? "",
        refreshToken: Deno.env.get("GOOGLE_DRIVE_REFRESH_TOKEN") ?? "",
        rootFolderId: Deno.env.get("GOOGLE_DRIVE_ROOT_FOLDER_ID") ?? "",
      });
      return await new PhotoPurgeWorker(createEdgeClients().admin, provider)
        .run();
    },
  )
);
