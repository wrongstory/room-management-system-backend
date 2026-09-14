import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { ImageMagick, MagickFormat, MagickReadSettings, ResourceLimits } from '@imagemagick/magick-wasm';
import { initializeCompressedPhotoDecoder, verifyPhotoBinary } from '../src/modules/photos/photo-binary.js';
const isDeno = 'Deno' in globalThis;
function cpuUsage(previous?: {user:number;system:number}) {
  if (!isDeno) return process.cpuUsage(previous);
  // Linux Docker CLK_TCK=100, measured independently with getconf. No host/user data is read.
  const stat = readFileSync('/proc/self/stat', 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { user: Number(fields[11]) * 10000 - (previous?.user ?? 0), system: Number(fields[12]) * 10000 - (previous?.system ?? 0) };
}

// Synthetic-only reproducible resource probe. Each cap/size uses an independent process; not a claim of hosted CPU equivalence.
if (!process.argv.includes('--child')) {
  for (const cap of [64, 96, 128]) for (const [width, height] of [[1000,1000], [1280,960], [1500,1000], [1600,1250], [2048,2048]]) {
    const child = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/benchmark-photo-decoder.ts', '--child', String(cap), String(width), String(height)], { encoding: 'utf8' });
    process.stdout.write(child.stdout);
    if (child.status !== 0) { process.stderr.write('Photo decoder benchmark child failed\n'); process.exit(1); }
  }
} else {
  const [cap, width, height] = process.argv.slice(-3).map(Number) as [number, number, number];
  const initCpu = cpuUsage(), initWall = performance.now();
  await initializeCompressedPhotoDecoder(readFileSync('supabase/functions/api/assets/magick.wasm.gz'));
  const init = { cpuMs: (cpuUsage(initCpu).user + cpuUsage(initCpu).system) / 1000, wallMs: performance.now() - initWall };
  ResourceLimits.memory = BigInt(cap * 1024 * 1024); ResourceLimits.maxMemoryRequest = BigInt(cap * 1024 * 1024);
  const rgb = new Uint8Array(width * height * 3);
  // Deterministic high-frequency texture with blocks/gradients. No photographs or personal data.
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = (y * width + x) * 3, v = ((x >> 3) * 13 + (y >> 3) * 7 + ((x ^ y) & 7)) & 255;
    rgb[index] = v; rgb[index + 1] = (v + (y >> 4)) & 255; rgb[index + 2] = (v + (x >> 4)) & 255;
  }
  const settings = new MagickReadSettings({ format: MagickFormat.Rgb, width, height, depth: 8 });
  const results = [];
  for (const [mime, format] of [['image/jpeg', MagickFormat.Jpeg], ['image/webp', MagickFormat.WebP]] as const) {
    let raw = new Uint8Array();
    for (const quality of [75, 50, 25, 10]) {
      raw = ImageMagick.read(rgb, settings, image => { image.quality = quality; return image.write(format, b => Uint8Array.from(b)); });
      if (raw.length <= 307200) break;
    }
    const cpu = cpuUsage(), start = performance.now(); let outcome = 'accepted', outputBytes = 0;
    try { outputBytes = (await verifyPhotoBinary(raw, mime)).sizeBytes; }
    catch (e) { outcome = e instanceof Error ? e.message : 'failed'; }
    const elapsedCpu = cpuUsage(cpu);
    results.push({ mime, inputBytes: raw.length, outputBytes, outcome, cpuMs: Math.round((elapsedCpu.user + elapsedCpu.system) / 1000), wallMs: Math.round(performance.now() - start) });
  }
  const maxRssKiB = isDeno ? Number(readFileSync('/proc/self/status', 'utf8').match(/VmHWM:\s+(\d+)/)?.[1]) : process.resourceUsage().maxRSS;
  console.info(JSON.stringify({ runtime: isDeno ? 'Deno' : 'Node', capMiB: cap, width, height, initCpuMs: Math.round(init.cpuMs), initWallMs: Math.round(init.wallMs), maxRssKiB, results }));
}
