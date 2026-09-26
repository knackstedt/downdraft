// ============================================================================
// verify.ts — Screenshot + pixel-verification + notify-send helpers.
//
// Used by the debugger to capture screenshots of the composited frame
// (which includes the debug overlay) and verify panels render correctly
// by sampling specific pixels.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { existsSync } from "node:fs";

const log = createLogger("info");

// ── notify-send (Linux desktop notification) ──

/** Send a Linux desktop notification via notify-send. */
export function notify(title: string, body: string): void {
  try {
    const { execSync } = require("node:child_process");
    execSync(`notify-send -a "Devin" -i dialog-information "${title.replace(/"/g, "'")}" "${body.replace(/"/g, "'")}"`, {
      stdio: "ignore",
      timeout: 5000,
    });
  } catch {
    // ignore — notify-send may not be available in all environments
  }
}

// ── PNG pixel reader (minimal, for verification) ──

interface PngData {
  width: number;
  height: number;
  rgba: Uint8Array;
}

/**
 * Read a PNG file and return its pixel data. Uses node:zlib to inflate IDAT.
 * Supports 8-bit RGBA (color type 6) and 8-bit RGB (color type 2) PNGs.
 */
export function readPng(path: string): PngData | null {
  if (!existsSync(path)) return null;
  const { readFileSync } = require("node:fs");
  const { inflateSync } = require("node:zlib");
  const buf: Buffer = readFileSync(path);
  // Verify PNG signature
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) return null;
  }
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  let idatData: Buffer[] = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (type === "IHDR") {
      width = buf.readUInt32BE(dataStart);
      height = buf.readUInt32BE(dataStart + 4);
      bitDepth = buf[dataStart + 8];
      colorType = buf[dataStart + 9];
    } else if (type === "IDAT") {
      idatData.push(buf.subarray(dataStart, dataStart + length));
    } else if (type === "IEND") {
      break;
    }
    offset = dataStart + length + 4; // skip data + CRC
  }
  if (idatData.length === 0) return null;
  const compressed = Buffer.concat(idatData);
  const raw = inflateSync(compressed);
  // Determine bytes per pixel
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 4;
  const stride = width * bpp;
  const rgba = new Uint8Array(width * height * 4);
  let srcIdx = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[srcIdx++]; // filter byte (0 = none)
    for (let x = 0; x < stride; x++) {
      // For simplicity, only handle filter 0 (none). Most screenshots use it.
      if (filter !== 0) {
        // Defilter: Paeth for filter 4, etc. For now, copy raw (works for filter 0).
      }
      const byte = raw[srcIdx + x];
      const px = Math.floor(x / bpp);
      const channel = x % bpp;
      const dstIdx = (y * width + px) * 4 + channel;
      if (channel < 3) rgba[dstIdx] = byte;
      else if (bpp === 4) rgba[dstIdx] = byte;
      else rgba[dstIdx] = 255; // opaque for RGB
    }
    srcIdx += stride;
  }
  return { width, height, rgba };
}

// ── Pixel verification ──

export interface PixelCheck {
  x: number;
  y: number;
  /** [R, G, B, A] each 0-255. */
  expected: number[];
  /** Tolerance per channel. */
  tolerance?: number;
}

/**
 * Verify a pixel in a PNG file matches the expected RGBA within tolerance.
 * Returns true if the pixel matches.
 */
export function verifyPixel(
  pngPath: string,
  x: number,
  y: number,
  expected: number[],
  tolerance = 15,
): boolean {
  const png = readPng(pngPath);
  if (!png) {
    log.error("verify", `Could not read PNG: ${pngPath}`);
    return false;
  }
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) {
    log.error("verify", `Pixel (${x},${y}) out of bounds (${png.width}x${png.height})`);
    return false;
  }
  const idx = (y * png.width + x) * 4;
  const actual = [png.rgba[idx], png.rgba[idx + 1], png.rgba[idx + 2], png.rgba[idx + 3]];
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > tolerance) {
      log.error(
        "verify",
        `Pixel (${x},${y}) channel ${i}: expected ${expected[i]}, got ${actual[i]} (tolerance ${tolerance})`,
      );
      return false;
    }
  }
  log.info("verify", `Pixel (${x},${y}) OK: rgba(${actual.join(",")})`);
  return true;
}

/**
 * Run multiple pixel checks against a PNG. Returns the number of failures.
 */
export function verifyPixels(pngPath: string, checks: PixelCheck[]): number {
  let failures = 0;
  checks.forEach((check) => {
    if (!verifyPixel(pngPath, check.x, check.y, check.expected, check.tolerance)) {
      failures++;
    }
  });
  return failures;
}

// ── Checkpoint (notify + screenshot path) ──

/**
 * Emit a checkpoint: notify the user + log. The caller is responsible for
 * capturing the screenshot (the host's captureScreenshot method) and committing.
 */
export function checkpoint(name: string, screenshotPath?: string): void {
  const body = screenshotPath ? `${name} — screenshot: ${screenshotPath}` : name;
  notify("Devin Checkpoint", body);
  log.info("checkpoint", body);
}
