import type { TextureData } from "./loader-texture";

// ============================================================================
// HDR (Radiance) Loader
// ============================================================================

interface HDRHeader {
  width: number;
  height: number;
  format: string;
  exposure: number;
  colorSpace: string;
}

function parseHDRHeader(data: Uint8Array): { header: HDRHeader; dataOffset: number } | null {
  let offset = 0;
  let format = "RGBE";
  let exposure = 1.0;
  let colorSpace = "";
  let width = 0;
  let height = 0;

  // Check for "#?RADIANCE" or "#?RGBE" magic
  const magic = new TextDecoder().decode(data.subarray(0, 10));
  if (!magic.startsWith("#?RADIANCE") && !magic.startsWith("#?RGBE")) {
    // Some HDR files don't have the magic, try to parse anyway
  }

  // Read header lines until empty line
  while (offset < data.length) {
    const lineEnd = data.indexOf(10, offset); // newline
    if (lineEnd === -1) return null;

    const line = new TextDecoder().decode(data.subarray(offset, lineEnd)).trim();
    offset = lineEnd + 1;

    if (line === "") break; // Empty line separates header from data

    if (line.startsWith("FORMAT=")) {
      format = line.substring(7).trim();
    } else if (line.startsWith("EXPOSURE=")) {
      exposure = parseFloat(line.substring(9).trim());
    } else if (line.startsWith("COLORCORR=") || line.startsWith("GAMMA=")) {
      // Ignore these
    } else if (line.startsWith(" primaries")) {
      colorSpace = line;
    }
  }

  // Read resolution line (e.g., "-Y 1024 +X 2048")
  const resEnd = data.indexOf(10, offset);
  if (resEnd === -1) return null;
  const resLine = new TextDecoder().decode(data.subarray(offset, resEnd)).trim();
  offset = resEnd + 1;

  const resMatch = resLine.match(/-Y\s+(\d+)\s+\+X\s+(\d+)/);
  if (resMatch) {
    height = parseInt(resMatch[1]);
    width = parseInt(resMatch[2]);
  } else {
    const altMatch = resLine.match(/\+Y\s+(\d+)\s+\+X\s+(\d+)/);
    if (altMatch) {
      height = parseInt(altMatch[1]);
      width = parseInt(altMatch[2]);
    } else {
      return null;
    }
  }

  return { header: { width, height, format, exposure, colorSpace }, dataOffset: offset };
}

function decodeRGBE(data: Uint8Array, offset: number, width: number, height: number): Float32Array {
  const pixels = new Float32Array(width * height * 4);
  const numPixels = width * height;
  let pixelIdx = 0;
  let pos = offset;

  while (pixelIdx < numPixels && pos < data.length) {
    // Check for RLE encoding (first two bytes equal, third != 2)
    if (data[pos] === 2 && data[pos + 1] === 2 && (data[pos + 2] & 0x80) !== 0) {
      // RLE scanline encoding
      const scanlineWidth = (data[pos + 2] << 8) | data[pos + 3];
      pos += 4;

      if (scanlineWidth !== width || pixelIdx + scanlineWidth > numPixels) {
        // Fallback to flat decoding
        break;
      }

      // Read 4 channel streams
      const channels: Uint8Array[] = [new Uint8Array(scanlineWidth), new Uint8Array(scanlineWidth), new Uint8Array(scanlineWidth), new Uint8Array(scanlineWidth)];
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < scanlineWidth && pos < data.length) {
          const count = data[pos++];
          if (count > 128) {
            // RLE run
            const val = data[pos++];
            const runLen = count - 128;
            for (let i = 0; i < runLen && x < scanlineWidth; i++) {
              channels[c][x++] = val;
            }
          } else {
            // Raw run
            for (let i = 0; i < count && x < scanlineWidth && pos < data.length; i++) {
              channels[c][x++] = data[pos++];
            }
          }
        }
      }

      // Convert RGBE to float
      for (let x = 0; x < scanlineWidth; x++) {
        const e = channels[3][x];
        const scale = e > 0 ? Math.pow(2, e - 128) / 256 : 0;
        const idx = pixelIdx * 4;
        pixels[idx] = channels[0][x] * scale;
        pixels[idx + 1] = channels[1][x] * scale;
        pixels[idx + 2] = channels[2][x] * scale;
        pixels[idx + 3] = 1.0;
        pixelIdx++;
      }
    } else {
      // Flat RGBE encoding (4 bytes per pixel)
      const r = data[pos++];
      const g = data[pos++];
      const b = data[pos++];
      const e = data[pos++];

      const scale = e > 0 ? Math.pow(2, e - 128) / 256 : 0;
      const idx = pixelIdx * 4;
      pixels[idx] = r * scale;
      pixels[idx + 1] = g * scale;
      pixels[idx + 2] = b * scale;
      pixels[idx + 3] = 1.0;
      pixelIdx++;
    }
  }

  return pixels;
}

export function parseHDR(data: ArrayBuffer): TextureData | null {
  const bytes = new Uint8Array(data);
  const result = parseHDRHeader(bytes);
  if (!result) return null;

  const { header, dataOffset } = result;
  const pixels = decodeRGBE(bytes, dataOffset, header.width, header.height);

  return {
    width: header.width,
    height: header.height,
    data: pixels,
    format: "rgba16float" as GPUTextureFormat,
    mipLevels: 1,
    isHDR: true,
  };
}

export async function loadHDRTexture(uri: string): Promise<TextureData | null> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return parseHDR(buffer);
}

// ============================================================================
// EXR (OpenEXR) Loader — minimal pure-JS parser for float32 RGBA
// Supports: scanline EXR with HALF (16-bit) or FLOAT (32-bit) channels,
// no compression (compression type 0) and RLE compression (type 1).
// ============================================================================

const EXR_MAGIC = 20000630;

interface EXRChannel {
  name: string;
  pixelType: number; // 0=UINT, 1=HALF, 2=FLOAT
  pLinear: number;
  xSampling: number;
  ySampling: number;
}

interface EXRHeader {
  channels: EXRChannel[];
  compression: number;
  dataWindow: { xMin: number; yMin: number; xMax: number; yMax: number };
  displayWindow: { xMin: number; yMin: number; xMax: number; yMax: number };
  lineOrder: number;
  pixelAspectRatio: number;
}

function readEXRString(view: DataView, offset: number): { str: string; next: number } {
  let end = offset;
  while (end < view.byteLength && view.getUint8(end) !== 0) end++;
  const str = new TextDecoder().decode(new Uint8Array(view.buffer, offset, end - offset));
  return { str, next: end + 1 };
}

function readEXRChannelList(view: DataView, offset: number, size: number): { channels: EXRChannel[]; next: number } {
  const channels: EXRChannel[] = [];
  const end = offset + size;
  let pos = offset;

  while (pos < end) {
    const { str: name, next: afterName } = readEXRString(view, pos);
    pos = afterName;
    if (name === "") break; // Null-terminated list

    if (pos + 16 > end) break;
    const pixelType = view.getInt32(pos, true); pos += 4;
    const pLinear = view.getUint32(pos, true); pos += 4;
    pos += 4; // reserved
    const xSampling = view.getInt32(pos, true); pos += 4;
    const ySampling = view.getInt32(pos, true); pos += 4;

    channels.push({ name, pixelType, pLinear, xSampling, ySampling });
  }

  channels.sort((a, b) => a.name.localeCompare(b.name));
  return { channels, next: end };
}

function parseEXRHeader(data: ArrayBuffer): { header: EXRHeader; offsetTableOffset: number } | null {
  const view = new DataView(data);

  if (view.byteLength < 8) return null;
  const magic = view.getInt32(0, true);
  if (magic !== EXR_MAGIC) return null;

  const version = view.getInt32(4, true);
  const isMultiPart = (version & 0x800) !== 0;
  if (isMultiPart) return null; // Multi-part EXR not supported

  let pos = 8;
  let channels: EXRChannel[] = [];
  let compression = 0;
  let dataWindow = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let displayWindow = { xMin: 0, yMin: 0, xMax: 0, yMax: 0 };
  let lineOrder = 0;
  let pixelAspectRatio = 1.0;

  while (pos < view.byteLength) {
    const { str: attrName, next: afterName } = readEXRString(view, pos);
    pos = afterName;
    if (attrName === "") break; // End of header

    const { str: attrType, next: afterType } = readEXRString(view, pos);
    pos = afterType;
    const attrSize = view.getInt32(pos, true);
    pos += 4;
    const attrDataStart = pos;

    if (attrName === "channels" && attrType === "chlist") {
      const result = readEXRChannelList(view, attrDataStart, attrSize);
      channels = result.channels;
    } else if (attrName === "compression" && attrType === "compression") {
      compression = view.getUint8(attrDataStart);
    } else if (attrName === "dataWindow" && attrType === "box2i") {
      dataWindow = {
        xMin: view.getInt32(attrDataStart, true),
        yMin: view.getInt32(attrDataStart + 4, true),
        xMax: view.getInt32(attrDataStart + 8, true),
        yMax: view.getInt32(attrDataStart + 12, true),
      };
    } else if (attrName === "displayWindow" && attrType === "box2i") {
      displayWindow = {
        xMin: view.getInt32(attrDataStart, true),
        yMin: view.getInt32(attrDataStart + 4, true),
        xMax: view.getInt32(attrDataStart + 8, true),
        yMax: view.getInt32(attrDataStart + 12, true),
      };
    } else if (attrName === "lineOrder" && attrType === "lineOrder") {
      lineOrder = view.getUint8(attrDataStart);
    } else if (attrName === "pixelAspectRatio" && attrType === "float") {
      pixelAspectRatio = view.getFloat32(attrDataStart, true);
    }

    pos = attrDataStart + attrSize;
  }

  return {
    header: { channels, compression, dataWindow, displayWindow, lineOrder, pixelAspectRatio },
    offsetTableOffset: pos,
  };
}

function decodeHalf16(halfBits: number): number {
  // IEEE 754 half-float to float32 conversion
  const sign = (halfBits >> 15) & 1;
  const exp = (halfBits >> 10) & 0x1f;
  const mant = halfBits & 0x3ff;

  let result: number;
  if (exp === 0) {
    if (mant === 0) {
      result = sign ? -0 : 0;
    } else {
      // Subnormal
      result = Math.pow(-1, sign) * mant / 1024 * Math.pow(2, -14);
    }
  } else if (exp === 31) {
    result = mant ? NaN : (sign ? -Infinity : Infinity);
  } else {
    result = Math.pow(-1, sign) * (1 + mant / 1024) * Math.pow(2, exp - 15);
  }
  return result;
}

function rleDecompress(data: Uint8Array, expectedSize: number): Uint8Array {
  const output = new Uint8Array(expectedSize);
  let inPos = 0;
  let outPos = 0;

  while (inPos < data.length && outPos < expectedSize) {
    const count = data[inPos++];
    if (count < 128) {
      // Raw run: count+1 bytes
      const runLen = count + 1;
      for (let i = 0; i < runLen && outPos < expectedSize && inPos < data.length; i++) {
        output[outPos++] = data[inPos++];
      }
    } else {
      // RLE run: (count-127) copies of next byte
      const runLen = count - 127;
      const val = data[inPos++];
      for (let i = 0; i < runLen && outPos < expectedSize; i++) {
        output[outPos++] = val;
      }
    }
  }

  return output;
}

export function parseEXR(data: ArrayBuffer): TextureData | null {
  const result = parseEXRHeader(data);
  if (!result) return null;

  const { header, offsetTableOffset } = result;
  const view = new DataView(data);

  const width = header.dataWindow.xMax - header.dataWindow.xMin + 1;
  const height = header.dataWindow.yMax - header.dataWindow.yMin + 1;

  if (width <= 0 || height <= 0) return null;

  // Read offset table (one int64 per scanline)
  const numScanlines = height;
  const offsets: number[] = [];
  let pos = offsetTableOffset;
  for (let i = 0; i < numScanlines; i++) {
    if (pos + 8 > view.byteLength) return null;
    // Read as two uint32 (int64 in EXR, but high bits should be 0 for normal files)
    const low = view.getUint32(pos, true);
    pos += 8;
    offsets.push(low);
  }

  // Allocate output (RGBA float32)
  const pixels = new Float32Array(width * height * 4);

  // Find channel indices (sorted alphabetically: B, G, R, A typically)
  let rChannel = -1, gChannel = -1, bChannel = -1, aChannel = -1;
  for (let i = 0; i < header.channels.length; i++) {
    const name = header.channels[i].name;
    if (name === "R") rChannel = i;
    else if (name === "G") gChannel = i;
    else if (name === "B") bChannel = i;
    else if (name === "A") aChannel = i;
  }

  const bytesPerChannel = header.channels.map(c => c.pixelType === 1 ? 2 : (c.pixelType === 2 ? 4 : 4));
  const bytesPerPixel = bytesPerChannel.reduce((a, b) => a + b, 0);

  for (let scanlineIdx = 0; scanlineIdx < numScanlines; scanlineIdx++) {
    const offset = offsets[scanlineIdx];
    if (offset === 0 || offset + 4 > view.byteLength) continue;

    let scanPos = offset;
    const yCoord = view.getInt32(scanPos, true);
    scanPos += 4;
    const pixelDataSize = view.getInt32(scanPos, true);
    scanPos += 4;

    const y = yCoord - header.dataWindow.yMin;
    if (y < 0 || y >= height) continue;

    let pixelData: Uint8Array;
    if (header.compression === 0) {
      // No compression
      pixelData = new Uint8Array(data, scanPos, Math.min(pixelDataSize, data.byteLength - scanPos));
    } else if (header.compression === 1) {
      // RLE compression
      const compressed = new Uint8Array(data, scanPos, Math.min(pixelDataSize, data.byteLength - scanPos));
      pixelData = rleDecompress(compressed, width * bytesPerPixel);
    } else {
      // Unsupported compression (ZIP, PIZ, etc.)
      continue;
    }

    const pixelView = new DataView(pixelData.buffer, pixelData.byteOffset, pixelData.byteLength);
    let pPos = 0;

    for (let x = 0; x < width; x++) {
      for (let c = 0; c < header.channels.length; c++) {
        let val = 0;
        if (header.channels[c].pixelType === 1) {
          // HALF (16-bit)
          if (pPos + 2 <= pixelView.byteLength) {
            val = decodeHalf16(pixelView.getUint16(pPos, true));
          }
          pPos += 2;
        } else if (header.channels[c].pixelType === 2) {
          // FLOAT (32-bit)
          if (pPos + 4 <= pixelView.byteLength) {
            val = pixelView.getFloat32(pPos, true);
          }
          pPos += 4;
        } else {
          pPos += 4;
        }

        const pixelIdx = (y * width + x) * 4;
        if (c === rChannel) pixels[pixelIdx] = val;
        else if (c === gChannel) pixels[pixelIdx + 1] = val;
        else if (c === bChannel) pixels[pixelIdx + 2] = val;
        else if (c === aChannel) pixels[pixelIdx + 3] = val;
      }
      // Default alpha to 1.0 if no alpha channel
      if (aChannel === -1) {
        pixels[(y * width + x) * 4 + 3] = 1.0;
      }
    }
  }

  return {
    width,
    height,
    data: pixels,
    format: "rgba16float" as GPUTextureFormat,
    mipLevels: 1,
    isHDR: true,
  };
}

export async function loadEXRTexture(uri: string): Promise<TextureData | null> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return parseEXR(buffer);
}

// ============================================================================
// Unified HDR loading entry point
// ============================================================================

export async function loadHDRFile(uri: string): Promise<TextureData | null> {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".hdr")) return loadHDRTexture(uri);
  if (lower.endsWith(".exr")) return loadEXRTexture(uri);
  return null;
}
