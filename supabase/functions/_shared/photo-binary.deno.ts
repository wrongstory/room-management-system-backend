import {
  ImageMagick,
  MagickColors,
  MagickFormat,
} from "@imagemagick/magick-wasm";
import {
  checkPhotoEnvelope,
  checkPhotoInputEnvelope,
  initializeCompressedPhotoDecoder,
  PHOTO_INPUT_MAX_BYTES,
  readPhotoBody,
  verifyPhotoBinary,
} from "./photo-binary.ts";

Deno.test("plain JPEG Samsung SEF input strips metadata but rejects corrupt tails and dirty output", async () => {
  await initializeCompressedPhotoDecoder(
    await Deno.readFile("supabase/functions/api/assets/magick.wasm.gz"),
  );
  const jpeg = ImageMagick.read(
    MagickColors.White,
    32,
    32,
    (image) => image.write(MagickFormat.Jpeg, (data) => Uint8Array.from(data)),
  );
  const name = new TextEncoder().encode("Image_UTC_Data");
  const field = new Uint8Array(8 + name.length + 4),
    fieldView = new DataView(field.buffer);
  fieldView.setUint32(0, 0x0a010000, true);
  fieldView.setUint32(4, name.length, true);
  field.set(name, 8);
  const directory = new Uint8Array(32), view = new DataView(directory.buffer);
  directory.set(new TextEncoder().encode("SEFH"));
  view.setUint32(4, 106, true);
  view.setUint32(8, 1, true);
  view.setUint32(12, 0x0a010000, true);
  view.setUint32(16, field.length, true);
  view.setUint32(20, field.length, true);
  view.setUint32(24, 24, true);
  directory.set(new TextEncoder().encode("SEFT"), 28);
  const input = new Uint8Array([...jpeg, ...field, ...directory]);
  checkPhotoInputEnvelope(input, "image/jpeg");
  const plain = await verifyPhotoBinary(jpeg, "image/jpeg"),
    normalized = await verifyPhotoBinary(input, "image/jpeg");
  if (plain.sha256 !== normalized.sha256 || normalized.sizeBytes > 307200) {
    throw new Error("SEF normalization mismatch");
  }
  checkPhotoEnvelope(normalized.bytes, normalized.mime, true);
  const corrupt = input.slice();
  new DataView(corrupt.buffer).setUint32(corrupt.length - 16, 1, true);
  for (
    const candidate of [
      corrupt,
      input.slice(0, -1),
      new Uint8Array([...input, 0]),
    ]
  ) {
    let rejected = false;
    try {
      checkPhotoInputEnvelope(candidate, "image/jpeg");
    } catch (error) {
      rejected = error instanceof Error &&
        error.message === "INVALID_PHOTO_BINARY";
    }
    if (!rejected) throw new Error("corrupt SEF accepted");
  }
  let dirtyOutputRejected = false;
  try {
    checkPhotoEnvelope(input, "image/jpeg", true);
  } catch (error) {
    dirtyOutputRejected = error instanceof Error &&
      error.message === "INVALID_PHOTO_BINARY";
  }
  if (!dirtyOutputRejected) throw new Error("SEF accepted as stored output");
});

Deno.test("real pinned WASM JPEG/WebP decode, EXIF strip, final hash and 5MiB raw boundary", async () => {
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
      c.enqueue(new Uint8Array(PHOTO_INPUT_MAX_BYTES + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    await readPhotoBody(body, null, PHOTO_INPUT_MAX_BYTES);
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

Deno.test("12MP JPEG downsample preserves rotation and small JPEG legacy output", async () => {
  await initializeCompressedPhotoDecoder(
    await Deno.readFile("supabase/functions/api/assets/magick.wasm.gz"),
  );
  const jpeg = ImageMagick.read(
    MagickColors.White,
    4032,
    3024,
    (image) => image.write(MagickFormat.Jpeg, (data) => Uint8Array.from(data)),
  );
  const exif = Uint8Array.from([
    255,
    225,
    0,
    34,
    69,
    120,
    105,
    102,
    0,
    0,
    73,
    73,
    42,
    0,
    8,
    0,
    0,
    0,
    1,
    0,
    18,
    1,
    3,
    0,
    1,
    0,
    0,
    0,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
  const input = new Uint8Array([
    ...jpeg.slice(0, 2),
    ...exif,
    ...jpeg.slice(2),
  ]);
  let previous = "";
  for (let index = 0; index < 3; index++) {
    const output = await verifyPhotoBinary(input, "image/jpeg");
    if (output.sizeBytes > 307200 || (previous && previous !== output.sha256)) {
      throw new Error("12MP normalization mismatch");
    }
    previous = output.sha256;
    ImageMagick.read(output.bytes, (image) => {
      if (
        image.width !== 960 || image.height !== 1280 ||
        image.profileNames.length
      ) throw new Error("rotation/metadata mismatch");
    });
  }
  const small = ImageMagick.read(
    MagickColors.White,
    640,
    480,
    (image) => image.write(MagickFormat.Jpeg, (data) => Uint8Array.from(data)),
  );
  const current = await verifyPhotoBinary(small, "image/jpeg"),
    legacy = await verifyPhotoBinary(small, "image/jpeg", "legacy");
  if (current.sha256 !== legacy.sha256) throw new Error("small JPEG changed");
});
