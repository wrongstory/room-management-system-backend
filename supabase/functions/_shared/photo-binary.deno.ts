import {
  ImageMagick,
  MagickColors,
  MagickFormat,
} from "@imagemagick/magick-wasm";
import {
  initializeCompressedPhotoDecoder,
  readPhotoBody,
  verifyPhotoBinary,
} from "./photo-binary.ts";

Deno.test("real pinned WASM JPEG/WebP decode, EXIF strip, final hash and 307201 raw boundary", async () => {
  const start = performance.now();
  const compressed = await Deno.readFile(
    "supabase/functions/api/assets/magick.wasm.gz",
  );
  const corrupted = compressed.slice();
  corrupted[100] ^= 1;
  try {
    await initializeCompressedPhotoDecoder(corrupted);
    throw new Error("tampered decoder accepted");
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "PHOTO_DECODER_UNAVAILABLE"
    ) throw error;
  }
  await initializeCompressedPhotoDecoder(compressed);
  for (const mime of ["image/jpeg", "image/webp"] as const) {
    const bytes = ImageMagick.read(
      MagickColors.White,
      2048,
      2048,
      (i) =>
        i.write(
          mime === "image/jpeg" ? MagickFormat.Jpeg : MagickFormat.WebP,
          (b) => Uint8Array.from(b),
        ),
    );
    const a = await verifyPhotoBinary(bytes, mime),
      b = await verifyPhotoBinary(bytes, mime);
    if (a.sha256 !== b.sha256 || a.sizeBytes > 307200 || !a.sizeBytes) {
      throw new Error("decoder contract");
    }
  }
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(307201));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    await readPhotoBody(body, null);
    throw new Error("oversize accepted");
  } catch (error) {
    if (
      !(error instanceof Error) || error.message !== "PHOTO_TOO_LARGE" ||
      !cancelled
    ) throw error;
  }
  // Only synthetic timing/asset data; no user bytes or provider credentials.
  console.info(
    JSON.stringify({
      photoDecoder: "WASM actual 4MP JPEG/WebP",
      elapsedMs: Math.round(performance.now() - start),
    }),
  );
});
