export interface PixelScanOptions {
  tolerance?: number;
  region?: { x: number; y: number; width: number; height: number };
  sampleRate?: number;
}

export interface PixelScanResult {
  passed: boolean;
  mismatchedPixels: number;
  totalPixels: number;
  mismatchRatio: number;
  maxDelta: number;
  averageDelta: number;
  regions: Array<{ x: number; y: number; width: number; height: number; passed: boolean }>;
}

export function comparePixels(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
  height: number,
  options: PixelScanOptions = {},
): PixelScanResult {
  const tolerance = options.tolerance ?? 0;
  const sampleRate = options.sampleRate ?? 1;
  const region = options.region ?? { x: 0, y: 0, width, height };

  let mismatched = 0;
  let total = 0;
  let maxDelta = 0;
  let sumDelta = 0;

  for (let y = region.y; y < region.y + region.height; y += sampleRate) {
    for (let x = region.x; x < region.x + region.width; x += sampleRate) {
      const idx = (y * width + x) * 4;
      if (idx + 3 >= actual.length || idx + 3 >= expected.length) continue;

      const dr = Math.abs(actual[idx] - expected[idx]);
      const dg = Math.abs(actual[idx + 1] - expected[idx + 1]);
      const db = Math.abs(actual[idx + 2] - expected[idx + 2]);
      const da = Math.abs(actual[idx + 3] - expected[idx + 3]);

      const delta = Math.max(dr, dg, db, da);
      maxDelta = Math.max(maxDelta, delta);
      sumDelta += delta;

      if (delta > tolerance) {
        mismatched++;
      }
      total++;
    }
  }

  const mismatchRatio = total > 0 ? mismatched / total : 0;
  const averageDelta = total > 0 ? sumDelta / total : 0;

  return {
    passed: mismatchRatio === 0,
    mismatchedPixels: mismatched,
    totalPixels: total,
    mismatchRatio,
    maxDelta,
    averageDelta,
    regions: [{ ...region, passed: mismatchRatio === 0 }],
  };
}

export interface RegionCheck {
  region: { x: number; y: number; width: number; height: number };
  expectedColor: { r: number; g: number; b: number; a?: number };
  tolerance?: number;
}

export function scanRegions(
  pixels: Uint8Array,
  width: number,
  height: number,
  checks: RegionCheck[],
): PixelScanResult {
  let allPassed = true;
  let totalMismatched = 0;
  let totalPixels = 0;
  let maxDelta = 0;
  let sumDelta = 0;
  const regions: Array<{ x: number; y: number; width: number; height: number; passed: boolean }> = [];

  checks.forEach((check) => {
    const { region, expectedColor, tolerance = 5 } = check;
    let regionMismatched = 0;
    let regionTotal = 0;

    for (let y = region.y; y < region.y + region.height; y++) {
      for (let x = region.x; x < region.x + region.width; x++) {
        const idx = (y * width + x) * 4;
        if (idx + 3 >= pixels.length) continue;

        const dr = Math.abs(pixels[idx] - expectedColor.r);
        const dg = Math.abs(pixels[idx + 1] - expectedColor.g);
        const db = Math.abs(pixels[idx + 2] - expectedColor.b);
        const da = expectedColor.a !== undefined ? Math.abs(pixels[idx + 3] - expectedColor.a) : 0;
        const delta = Math.max(dr, dg, db, da);

        maxDelta = Math.max(maxDelta, delta);
        sumDelta += delta;

        if (delta > tolerance) {
          regionMismatched++;
        }
        regionTotal++;
      }
    }

    totalMismatched += regionMismatched;
    totalPixels += regionTotal;
    const regionPassed = regionMismatched === 0;
    if (!regionPassed) allPassed = false;
    regions.push({ ...region, passed: regionPassed });
  });

  return {
    passed: allPassed,
    mismatchedPixels: totalMismatched,
    totalPixels,
    mismatchRatio: totalPixels > 0 ? totalMismatched / totalPixels : 0,
    maxDelta,
    averageDelta: totalPixels > 0 ? sumDelta / totalPixels : 0,
    regions,
  };
}

export function getPixel(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): { r: number; g: number; b: number; a: number } {
  const idx = (y * width + x) * 4;
  return {
    r: pixels[idx],
    g: pixels[idx + 1],
    b: pixels[idx + 2],
    a: pixels[idx + 3],
  };
}

export function averageColor(
  pixels: Uint8Array,
  width: number,
  region: { x: number; y: number; width: number; height: number },
): { r: number; g: number; b: number; a: number } {
  let r = 0, g = 0, b = 0, a = 0, count = 0;
  for (let y = region.y; y < region.y + region.height; y++) {
    for (let x = region.x; x < region.x + region.width; x++) {
      const idx = (y * width + x) * 4;
      if (idx + 3 >= pixels.length) continue;
      r += pixels[idx];
      g += pixels[idx + 1];
      b += pixels[idx + 2];
      a += pixels[idx + 3];
      count++;
    }
  }
  if (count === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: Math.round(r / count),
    g: Math.round(g / count),
    b: Math.round(b / count),
    a: Math.round(a / count),
  };
}
