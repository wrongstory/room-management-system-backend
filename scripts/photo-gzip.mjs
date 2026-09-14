import { gzipSync } from 'node:zlib';

/** RFC1952 canonical header: no optional fields, mtime=0, OS=255 (unknown).
 * Windows/Linux zlib emit different OS bytes despite identical DEFLATE payloads.
 * Do not normalize payload/trailer: the pinned complete SHA still rejects algorithm drift.
 */
export function canonicalGzipHeader(input) {
  if (input.length < 18 || input[0] !== 31 || input[1] !== 139 || input[2] !== 8 || input[3] !== 0 || input[8] !== 2) {
    throw new Error('Unexpected photo gzip header');
  }
  const result = Buffer.from(input);
  result.fill(0, 4, 8);
  result[9] = 255;
  return result;
}

export function canonicalPhotoGzip(input) {
  return canonicalGzipHeader(gzipSync(input, { level: 9 }));
}
