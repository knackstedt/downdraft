// ============================================================================
// screenshot.ts — Screenshot capture from a wgpu render target
//
// Copies a render target texture to a buffer, reads back the pixels,
// encodes them as a PNG file using a minimal PNG encoder.
// ============================================================================

import { writeFileSync } from "node:fs";
import { WgpuDevice, WgpuTexture } from "../gpu/wgpu-wrapper";

// ── Minimal PNG encoder (uncompressed, using zlib for deflate) ──
import { deflateSync } from "node:zlib";

export function encodePNG(width: number, height: number, rgba: Uint8Array): Buffer {
  // PNG signature
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // IDAT chunk — raw pixel data with filter bytes
  // Each scanline starts with a filter byte (0 = none)
  const rawData = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    rawData[y * (1 + width * 4)] = 0; // filter: none
    const srcOffset = y * width * 4;
    const dstOffset = y * (1 + width * 4) + 1;
    rawData.set(rgba.subarray(srcOffset, srcOffset + width * 4), dstOffset);
  }
  const compressed = deflateSync(rawData);

  // IEND chunk
  const iend = Buffer.alloc(0);

  // Build the PNG file
  const chunks: Buffer[] = [signature];
  chunks.push(makeChunk("IHDR", ihdr));
  chunks.push(makeChunk("IDAT", compressed));
  chunks.push(makeChunk("IEND", iend));

  return Buffer.concat(chunks);
}

function makeChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuf = Buffer.from(type, "ascii");
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuf, data, crcBuf]);
}

// CRC32 for PNG chunks
const crcTable: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) c = 0xEDB88320 ^ (c >>> 1);
      else c = c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = crcTable[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return crc ^ 0xFFFFFFFF;
}

/**
 * Convert a padded wgpu copyTextureToBuffer readback into tightly-packed RGBA.
 * Strips the 256-byte row padding and swaps B↔R for BGRA surface formats.
 * Shared by captureScreenshot() and consumers that own their own copy pass
 * (e.g. games that piggyback the copy on the renderer's encoder).
 */
export function paddedReadbackToRGBA(
  pixels: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
  format?: GPUTextureFormat | string,
): Uint8Array {
  const bytesPerPixel = 4;
  const isBGRA = format === "bgra8unorm" || format === "bgra8unorm-srgb";
  const unpadded = new Uint8Array(width * height * bytesPerPixel);
  const rowBytes = width * bytesPerPixel;
  if (!isBGRA) {
    // Fast path: row-wise copy, no per-pixel work.
    for (let y = 0; y < height; y++) {
      unpadded.set(pixels.subarray(y * bytesPerRow, y * bytesPerRow + rowBytes), y * rowBytes);
    }
    return unpadded;
  }
  for (let y = 0; y < height; y++) {
    const srcOffset = y * bytesPerRow;
    const dstOffset = y * rowBytes;
    for (let x = 0; x < width; x++) {
      const src = srcOffset + x * 4;
      const dst = dstOffset + x * 4;
      // Swap B and R channels: BGRA → RGBA
      unpadded[dst] = pixels[src + 2];     // R ← B
      unpadded[dst + 1] = pixels[src + 1]; // G ← G
      unpadded[dst + 2] = pixels[src];     // B ← R
      unpadded[dst + 3] = pixels[src + 3]; // A ← A
    }
  }
  return unpadded;
}

// ── Screenshot capture ──

export interface ScreenshotOptions {
  width: number;
  height: number;
  format?: GPUTextureFormat;
  outputPath: string;
}

/**
 * Read back a render target's pixels as tightly-packed RGBA8.
 * Shared by captureScreenshot (file output) and the native bridge's
 * capturePage (ArrayBuffer output for MCP tooling).
 */
export function captureScreenshotPixels(
  device: WgpuDevice,
  sourceTexture: WgpuTexture,
  width: number,
  height: number,
  format?: GPUTextureFormat,
): Uint8Array {
  // Create a destination buffer for the copy
  const bytesPerPixel = 4;
  // Padded bytesPerRow to 256 (wgpu requirement)
  const bytesPerRow = Math.ceil((width * bytesPerPixel) / 256) * 256;
  const paddedBufferSize = bytesPerRow * height;

  const destBuffer = device.createBuffer({
    size: paddedBufferSize,
    usage: 0x0001 | 0x0008, // MAP_READ | COPY_DST
  });

  // Copy texture to buffer
  const encoder = device.createCommandEncoder();
  (encoder as any).copyTextureToBuffer(
    { texture: sourceTexture },
    {
      buffer: destBuffer,
      offset: 0,
      bytesPerRow,
      rowsPerImage: height,
    },
    { width, height, depthOrArrayLayers: 1 },
  );
  const cmdBuffer = encoder.finish();
  device.queue.submit([cmdBuffer]);

  // Map the buffer and read back the pixels.
  // mapAsync completes synchronously in the shim — the returned promise is
  // already resolved, but we still handle rejections for correctness.
  void destBuffer.mapAsync(1, 0, paddedBufferSize); // 1 = READ

  const mappedRange = destBuffer.getMappedRange(0, paddedBufferSize);
  const pixels = new Uint8Array(mappedRange);
  const unpadded = paddedReadbackToRGBA(pixels, width, height, bytesPerRow, format);

  destBuffer.unmap();
  destBuffer.destroy();
  return unpadded;
}

export function captureScreenshot(
  device: WgpuDevice,
  sourceTexture: WgpuTexture,
  width: number,
  height: number,
  outputPath: string,
  format?: GPUTextureFormat,
): void {
  const unpadded = captureScreenshotPixels(device, sourceTexture, width, height, format);
  // Encode as PNG and write to file
  const png = encodePNG(width, height, unpadded);
  writeFileSync(outputPath, png);
  console.log(`[screenshot] Saved ${width}x${height} to ${outputPath} (${png.length} bytes)`);
}
