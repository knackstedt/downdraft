// ============================================================================
// compare.ts — Pixel comparison for browser vs native screenshots.
//
// Decodes two PNGs with pngjs, compares them channel-by-channel, and reports:
//   - meanPerChannel: average absolute difference per channel (0-255)
//   - maxDiff: largest single-channel difference
//   - mismatchPercent: fraction of pixels whose max-channel diff exceeds
//     `tolerance`
//   - a diff PNG (red = native differs, scaled for visibility)
//
// Two thresholds determine pass/fail:
//   - `maxMeanPerChannel` (default 6.0): the average difference must be below
//     this. Fonts and GPU backends introduce small rasterization deltas, so a
//     small allowance is needed; a real rendering bug blows way past this.
//   - `mismatchTolerance` (default 24): per-pixel channel difference below
//     this counts as "matching" (anti-aliasing fringe).
// ============================================================================

import { PNG } from "pngjs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface CompareOptions {
  /** Max allowed average absolute difference per channel (0-255). */
  maxMeanPerChannel?: number;
  /** Per-pixel channel diff at or below this counts as "matching". */
  mismatchTolerance?: number;
  /** If provided, writes a visual diff PNG here. */
  diffPath?: string;
}

export interface CompareResult {
  pass: boolean;
  meanPerChannel: number;
  maxDiff: number;
  mismatchPercent: number;
  width: number;
  height: number;
  /** Actual thresholds used (defaults applied). */
  thresholds: { maxMeanPerChannel: number; mismatchTolerance: number };
}

function loadPng(path: string): PNG {
  const buf = readFileSync(resolve(path));
  return PNG.sync.read(buf);
}

export function compareScreenshots(
  browserPath: string,
  nativePath: string,
  opts: CompareOptions = {},
): CompareResult {
  const maxMeanPerChannel = opts.maxMeanPerChannel ?? 6.0;
  const mismatchTolerance = opts.mismatchTolerance ?? 24;

  const a = loadPng(browserPath);
  const b = loadPng(nativePath);

  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(
      `Size mismatch: browser ${a.width}x${a.height} vs native ${b.width}x${b.height}`,
    );
  }

  const width = a.width;
  const height = a.height;
  const n = width * height;
  const channels = 4;

  let totalAbsDiff = 0;
  let maxDiff = 0;
  let mismatchedPixels = 0;

  // Optional diff image (amplify differences for visibility).
  let diff: PNG | null = null;
  if (opts.diffPath) diff = new PNG({ width, height });

  for (let i = 0; i < n; i++) {
    const off = i * channels;
    let pixelMax = 0;
    let absSum = 0;
    for (let c = 0; c < channels; c++) {
      const d = Math.abs(a.data[off + c] - b.data[off + c]);
      if (d > pixelMax) pixelMax = d;
      absSum += d;
    }
    totalAbsDiff += absSum;
    if (pixelMax > maxDiff) maxDiff = pixelMax;
    if (pixelMax > mismatchTolerance) mismatchedPixels++;

    if (diff) {
      // Red channel encodes the max-channel difference (scaled x8, clamped).
      const v = Math.min(255, pixelMax * 8);
      diff.data[off] = v;
      diff.data[off + 1] = 0;
      diff.data[off + 2] = 0;
      diff.data[off + 3] = 255;
    }
  }

  const meanPerChannel = totalAbsDiff / (n * channels);
  const mismatchPercent = (mismatchedPixels / n) * 100;

  if (diff && opts.diffPath) {
    const { writeFileSync } = require("node:fs");
    writeFileSync(resolve(opts.diffPath), PNG.sync.write(diff));
  }

  const pass = meanPerChannel <= maxMeanPerChannel;
  return {
    pass,
    meanPerChannel,
    maxDiff,
    mismatchPercent,
    width,
    height,
    thresholds: { maxMeanPerChannel, mismatchTolerance },
  };
}
