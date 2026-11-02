import { handleHeldPhotoPurge } from "../_shared/photo-purge.ts";

export { handleHeldPhotoPurge };

// User deletion HOLD: no environment/credential read, DB client or provider.
// There is deliberately no request flag, secret, or environment unlock mode.
if (import.meta.main) Deno.serve(handleHeldPhotoPurge);
