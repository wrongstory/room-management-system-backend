import {
  photoContentDisposition,
  photoStorageFileName,
} from "./photo-storage-name.ts";

Deno.test("storage names preserve canonical categories, bigint sequence and Unicode headers", () => {
  for (const category of ["일반방", "폭탄방", "특이사항"]) {
    for (const sequence of ["01", "99", "100", "9223372036854775807"]) {
      const name = `2026-10-05_${category}_350_${sequence}.jpg`;
      if (photoStorageFileName(name, "image/jpeg") !== name) {
        throw new Error("canonical server name changed");
      }
      if (
        photoContentDisposition(name, "image/jpeg") !==
          `inline; filename="photo.jpg"; filename*=UTF-8''${
            encodeURIComponent(name)
          }`
      ) throw new Error("Unicode server filename header changed");
    }
  }
  if (photoStorageFileName(null, "image/jpeg") !== null) {
    throw new Error("legacy identity must not be backfilled");
  }
  if (
    photoContentDisposition(undefined, "image/webp") !==
      'inline; filename="photo.webp"'
  ) throw new Error("legacy safe header changed");
});

Deno.test("storage names fail closed on untrusted dates, type, path, extension and number", () => {
  for (
    const value of [
      "2026-02-29_일반방_350_01.jpg",
      "2026-10-05_고객이름_350_01.jpg",
      "2026-10-05_일반방_350_00.jpg",
      "2026-10-05_일반방_350_1.jpg",
      "2026-10-05_일반방_350_010.jpg",
      "2026-10-05_일반방_350_9223372036854775808.jpg",
      "2026-10-05_일반방_350_01.webp",
      "2026-10-05_일반방_350_01.jpg\r\nX-Secret: value",
      "../2026-10-05_일반방_350_01.jpg",
      "2026-10-05_일반방_35_01.jpg",
      "2026-10-05_일반방_350_01.JPG",
      "",
      1,
      {},
    ]
  ) {
    let rejected = false;
    try {
      photoStorageFileName(value, "image/jpeg");
    } catch (error) {
      rejected = error instanceof Error &&
        "code" in error && error.code === "PHOTO_UPLOAD_FAILED";
    }
    if (!rejected) throw new Error("untrusted filename was not rejected");
  }
});
