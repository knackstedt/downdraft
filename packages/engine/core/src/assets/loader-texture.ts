
import { assertCount, MAX_MIP_LEVELS, MAX_TEXTURE_DIM } from "../safety/bounds";
import { loadDDSTexture } from "./loader-dds";
import { loadHDRFile } from "./loader-hdr";

export interface TextureData {
  width: number;
  height: number;
  data: Uint8Array | Float32Array;
  format: GPUTextureFormat;
  mipLevels: number;
  isHDR: boolean;
}

export type TextureFormat = "png" | "webp" | "ktx2" | "dds" | "hdr" | "exr" | "unknown";

export function detectTextureFormat(uri: string): TextureFormat {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".ktx2")) return "ktx2";
  if (lower.endsWith(".dds")) return "dds";
  if (lower.endsWith(".hdr")) return "hdr";
  if (lower.endsWith(".exr")) return "exr";
  return "unknown";
}

export async function loadImageBitmap(uri: string): Promise<ImageBitmap> {
  const response = await fetch(uri);
  const blob = await response.blob();
  return await createImageBitmap(blob);
}

export async function loadTextureFromImage(
  uri: string,
  format: GPUTextureFormat = "rgba8unorm",
  generateMips: boolean = false,
): Promise<TextureData> {
  const bitmap = await loadImageBitmap(uri);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);

  let data: Uint8Array = new Uint8Array(imageData.data.buffer);
  let mipLevels = 1;

  if (generateMips) {
    mipLevels = Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1;
    const mipChain = generateMipChain(data, bitmap.width, bitmap.height, mipLevels);
    data = mipChain;
  }

  return {
    width: bitmap.width,
    height: bitmap.height,
    data,
    format,
    mipLevels,
    isHDR: false,
  };
}

function generateMipChain(
  baseData: Uint8Array,
  baseWidth: number,
  baseHeight: number,
  mipLevels: number,
): Uint8Array {
  const levels: Uint8Array[] = [baseData];
  let prevWidth = baseWidth;
  let prevHeight = baseHeight;

  for (let level = 1; level < mipLevels; level++) {
    const w = Math.max(1, Math.floor(prevWidth / 2));
    const h = Math.max(1, Math.floor(prevHeight / 2));
    const prevCanvas = new OffscreenCanvas(prevWidth, prevHeight);
    const prevCtx = prevCanvas.getContext("2d")!;
    const prevImageData = prevCtx.createImageData(prevWidth, prevHeight);
    prevImageData.data.set(levels[level - 1]);
    prevCtx.putImageData(prevImageData, 0, 0);

    const mipCanvas = new OffscreenCanvas(w, h);
    const mipCtx = mipCanvas.getContext("2d")!;
    mipCtx.drawImage(prevCanvas, 0, 0, w, h);
    const mipImageData = mipCtx.getImageData(0, 0, w, h);
    levels.push(new Uint8Array(mipImageData.data.buffer));
    prevWidth = w;
    prevHeight = h;
  }

  const totalSize = levels.reduce((sum, l) => sum + l.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  levels.forEach((level) => {
    result.set(level, offset);
    offset += level.length;
  });
  return result;
}

interface KTX2Header {
  vkFormat: number;
  typeSize: number;
  pixelWidth: number;
  pixelHeight: number;
  pixelDepth: number;
  layerCount: number;
  faceCount: number;
  levelCount: number;
}

const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];

/** True when the bytes start with the KTX2 file identifier. */
export function isKTX2Data(data: ArrayBuffer | Uint8Array): boolean {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 12) return false;
  for (let i = 0; i < 12; i++) {
    if (bytes[i] !== KTX2_MAGIC[i]) return false;
  }
  return true;
}

function readKTX2Header(data: Uint8Array): KTX2Header | null {
  if (data.byteLength < 80 || !isKTX2Data(data)) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const pixelWidth = view.getUint32(20, true);
  const pixelHeight = view.getUint32(24, true);
  const levelCount = view.getUint32(40, true);

  // Validate texture dimensions and mip level count
  assertCount("ktx2-dim", Math.max(pixelWidth, pixelHeight), MAX_TEXTURE_DIM);
  assertCount("ktx2-levels", levelCount, MAX_MIP_LEVELS);

  return {
    vkFormat: view.getUint32(12, true),
    typeSize: view.getUint32(16, true),
    pixelWidth,
    pixelHeight,
    pixelDepth: view.getUint32(28, true),
    layerCount: view.getUint32(32, true),
    faceCount: view.getUint32(36, true),
    levelCount,
  };
}

// Vulkan VkFormat enum → WebGPU texture format. Values follow the Vulkan
// spec's core-format numbering (VK_FORMAT_*).
const VK_FORMAT_MAP: Record<number, GPUTextureFormat> = {
  // Unpacked formats
  37: "rgba8unorm", // VK_FORMAT_R8G8B8A8_UNORM
  43: "rgba8unorm-srgb", // VK_FORMAT_R8G8B8A8_SRGB
  44: "bgra8unorm", // VK_FORMAT_B8G8R8A8_UNORM
  50: "bgra8unorm-srgb", // VK_FORMAT_B8G8R8A8_SRGB
  76: "r16float", // VK_FORMAT_R16_SFLOAT
  97: "rgba16float", // VK_FORMAT_R16G16B16A16_SFLOAT
  100: "r32float", // VK_FORMAT_R32_SFLOAT
  103: "rg32float", // VK_FORMAT_R32G32_SFLOAT
  109: "rgba32float", // VK_FORMAT_R32G32B32A32_SFLOAT

  // BC compressed (VK_FORMAT_BC*_*_BLOCK = 131-146). WebGPU has no bc1-rgb
  // format — BC1_RGB maps to bc1-rgba (opaque alpha).
  131: "bc1-rgba-unorm",
  132: "bc1-rgba-unorm-srgb",
  133: "bc1-rgba-unorm",
  134: "bc1-rgba-unorm-srgb",
  135: "bc2-rgba-unorm",
  136: "bc2-rgba-unorm-srgb",
  137: "bc3-rgba-unorm",
  138: "bc3-rgba-unorm-srgb",
  139: "bc4-r-unorm",
  140: "bc4-r-snorm",
  141: "bc5-rg-unorm",
  142: "bc5-rg-snorm",
  143: "bc6h-rgb-ufloat",
  144: "bc6h-rgb-float",
  145: "bc7-rgba-unorm",
  146: "bc7-rgba-unorm-srgb",

  // ETC2/EAC compressed (VK_FORMAT_ETC2/EAC_*_BLOCK = 147-156)
  147: "etc2-rgb8unorm",
  148: "etc2-rgb8unorm-srgb",
  149: "etc2-rgb8a1unorm",
  150: "etc2-rgb8a1unorm-srgb",
  151: "etc2-rgba8unorm",
  152: "etc2-rgba8unorm-srgb",
  153: "eac-r11unorm",
  154: "eac-r11snorm",
  155: "eac-rg11unorm",
  156: "eac-rg11snorm",

  // ASTC compressed (VK_FORMAT_ASTC_*_UNORM/SRGB_BLOCK = 157-184; unorm/srgb
  // pairs ordered by footprint 4x4,5x4,5x5,6x5,6x6,8x5,8x6,8x8,10x5,10x6,
  // 10x8,10x10,12x10,12x12)
  157: "astc-4x4-unorm",
  158: "astc-4x4-unorm-srgb",
  159: "astc-5x4-unorm",
  160: "astc-5x4-unorm-srgb",
  161: "astc-5x5-unorm",
  162: "astc-5x5-unorm-srgb",
  163: "astc-6x5-unorm",
  164: "astc-6x5-unorm-srgb",
  165: "astc-6x6-unorm",
  166: "astc-6x6-unorm-srgb",
  167: "astc-8x5-unorm",
  168: "astc-8x5-unorm-srgb",
  169: "astc-8x6-unorm",
  170: "astc-8x6-unorm-srgb",
  171: "astc-8x8-unorm",
  172: "astc-8x8-unorm-srgb",
  173: "astc-10x5-unorm",
  174: "astc-10x5-unorm-srgb",
  175: "astc-10x6-unorm",
  176: "astc-10x6-unorm-srgb",
  177: "astc-10x8-unorm",
  178: "astc-10x8-unorm-srgb",
  179: "astc-10x10-unorm",
  180: "astc-10x10-unorm-srgb",
  181: "astc-12x10-unorm",
  182: "astc-12x10-unorm-srgb",
  183: "astc-12x12-unorm",
  184: "astc-12x12-unorm-srgb",
};

// vkFormats that carry float/HDR texels.
const HDR_VK_FORMATS = new Set([76, 97, 100, 103, 109, 143, 144]);

export interface EmbeddedTextureOptions {
  /**
   * GPU texture-compression features the target device supports
   * (e.g. "texture-compression-bc"). Passed to the basisu codec so it can
   * transcode to a compressed format the device uploads natively.
   */
  compressionFeatures?: readonly string[];
  /** Whether the pixel data is sRGB-encoded (baseColor/emissive: true). */
  srgb?: boolean;
}

/**
 * The texture-compression features a device exposes, as strings consumable by
 * `EmbeddedTextureOptions.compressionFeatures`. Returns [] for devices
 * without a `features` set (mocks, software fallbacks).
 */
export function deviceCompressionFeatures(device: GPUDevice): string[] {
  const supported = (device as { features?: { has?(name: string): boolean } }).features;
  const features: string[] = [];
  ["texture-compression-bc", "texture-compression-astc", "texture-compression-etc2"].forEach((name) => {
    try {
      if (supported?.has?.(name)) features.push(name);
    } catch {
      // Feature sets that throw on unknown names — treat as absent.
    }
  });
  return features;
}

/**
 * Decode embedded texture bytes (glTF bufferView contents) into TextureData.
 *
 * - Non-KTX2 input (PNG/JPG/WebP/...) returns null — callers should fall back
 *   to createImageBitmap.
 * - KTX2 with vkFormat=0 (Basis Universal) transcodes through the glTF codec
 *   registry (KHR_texture_basisu) to the best format for the device's
 *   compressionFeatures (BC7/ASTC/ETC2 or RGBA32 fallback).
 * - KTX2 with a concrete vkFormat parses directly via parseKTX2FromBuffer.
 */
export async function decodeEmbeddedTexture(
  buffer: ArrayBuffer,
  options: EmbeddedTextureOptions = {},
): Promise<TextureData | null> {
  if (!isKTX2Data(buffer)) return null;
  let header: KTX2Header | null;
  try {
    header = readKTX2Header(new Uint8Array(buffer));
  } catch {
    return null;
  }
  if (!header) return null;
  if (header.vkFormat === 0) {
    // Basis Universal supercompression — transcode via the glTF texture codec.
    const { getDefaultCodecRegistry } = await import("@downdraft/engine/libraries/models");
    const codec = getDefaultCodecRegistry()?.getTextureCodec("KHR_texture_basisu");
    if (!codec) return null;
    const out = await codec.decode({
      data: new Uint8Array(buffer),
      extension: {},
      compressionFeatures: options.compressionFeatures,
      srgb: options.srgb ?? false,
    });
    return {
      width: out.width,
      height: out.height,
      data: out.data,
      format: out.format as GPUTextureFormat,
      mipLevels: out.mipLevels,
      isHDR: out.isHDR,
    };
  }
  return parseKTX2FromBuffer(buffer);
}

export async function loadKTX2Texture(
  uri: string,
  options: EmbeddedTextureOptions = {},
): Promise<TextureData | null> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return decodeEmbeddedTexture(buffer, options);
}

export function parseKTX2FromBuffer(buffer: ArrayBuffer): TextureData | null {
  const data = new Uint8Array(buffer);
  const header = readKTX2Header(data);
  if (!header) return null;
  // vkFormat=0 means Basis Universal supercompression — it has no concrete
  // GPU format and must go through the transcode path (decodeEmbeddedTexture).
  if (header.vkFormat === 0) return null;
  const format = VK_FORMAT_MAP[header.vkFormat];
  if (!format) return null;

  // Level index: max(1, levelCount) entries of {u64 byteOffset, u64 byteLength,
  // u64 uncompressedByteLength} immediately after the 80-byte header. Entries
  // are ordered mip level 0 → N; their byteOffsets may be unordered (KTX2
  // commonly stores smallest mip first).
  const view = new DataView(buffer);
  const levelCount = Math.max(1, header.levelCount);
  const slices: { offset: number; length: number }[] = [];
  for (let i = 0; i < levelCount; i++) {
    const base = 80 + i * 24;
    if (base + 24 > data.byteLength) break;
    const byteOffset = Number(view.getBigUint64(base, true));
    const byteLength = Number(view.getBigUint64(base + 8, true));
    if (byteLength > 0 && byteOffset + byteLength <= data.byteLength) {
      slices.push({ offset: byteOffset, length: byteLength });
    }
  }
  if (slices.length === 0) return null;

  const total = slices.reduce((s, l) => s + l.length, 0);
  const payload = new Uint8Array(total);
  let off = 0;
  slices.forEach((l) => {
    payload.set(data.subarray(l.offset, l.offset + l.length), off);
    off += l.length;
  });

  return {
    width: header.pixelWidth,
    height: header.pixelHeight,
    data: payload,
    format,
    mipLevels: slices.length,
    isHDR: HDR_VK_FORMATS.has(header.vkFormat),
  };
}

export async function loadTexture(
  uri: string,
  options: { format?: GPUTextureFormat; generateMips?: boolean } & EmbeddedTextureOptions = {},
): Promise<TextureData> {
  const fmt = detectTextureFormat(uri);

  if (fmt === "ktx2") {
    const result = await loadKTX2Texture(uri, options);
    if (result) return result;
  }

  if (fmt === "dds") {
    const result = await loadDDSTexture(uri);
    if (result) return result;
  }

  if (fmt === "hdr" || fmt === "exr") {
    const result = await loadHDRFile(uri);
    if (result) return result;
  }

  return loadTextureFromImage(uri, options.format, options.generateMips);
}

// Compressed formats with 8-byte blocks; all others (bc2/3/5/6h/7, astc-*,
// etc2-rgba8, eac-rg11) use 16-byte blocks.
const COMPRESSED_8_BYTE_FORMATS = new Set<GPUTextureFormat>([
  "bc1-rgba-unorm", "bc1-rgba-unorm-srgb",
  "bc4-r-unorm", "bc4-r-snorm",
  "etc2-rgb8unorm", "etc2-rgb8unorm-srgb",
  "etc2-rgb8a1unorm", "etc2-rgb8a1unorm-srgb",
  "eac-r11unorm", "eac-r11snorm",
] as GPUTextureFormat[]);

/**
 * Compressed-block geometry for a format: block footprint in texels and bytes
 * per block. BC/ETC/EAC are 4x4; ASTC footprints are parsed from the format
 * name (e.g. "astc-6x6-unorm" → 6x6).
 */
export function compressedBlockInfo(format: GPUTextureFormat): {
  blockWidth: number;
  blockHeight: number;
  blockBytes: number;
} {
  const astc = /^astc-(\d+)x(\d+)-/.exec(format);
  return {
    blockWidth: astc ? Number(astc[1]) : 4,
    blockHeight: astc ? Number(astc[2]) : 4,
    blockBytes: COMPRESSED_8_BYTE_FORMATS.has(format) ? 8 : 16,
  };
}

export function createGPUTextureFromData(
  device: GPUDevice,
  texture: TextureData,
  // COPY_SRC is included so textures can be copied into bindless bucket pages
  // via copyTextureToTexture (registerFromTexture/updateFromTexture).
  usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.COPY_SRC |
    GPUTextureUsage.RENDER_ATTACHMENT,
): GPUTexture {
  const isCompressed = isCompressedFormat(texture.format);
  const gpuTexture = device.createTexture({
    size: [texture.width, texture.height],
    format: texture.format,
    // Compressed formats aren't renderable — strip RENDER_ATTACHMENT (the
    // default usage includes it) or device validation rejects the texture.
    usage: isCompressed ? (usage | GPUTextureUsage.COPY_DST) & ~GPUTextureUsage.RENDER_ATTACHMENT : usage,
    mipLevelCount: texture.mipLevels,
  });

  if (texture.data instanceof Float32Array) {
    // HDR float data
    const bytesPerRow = texture.width * 4 * (texture.format === "rgba32float" ? 4 : 2);
    device.queue.writeTexture(
      { texture: gpuTexture },
      texture.data as unknown as BufferSource,
      { bytesPerRow },
      { width: texture.width, height: texture.height },
    );
  } else if (texture.data instanceof Uint8Array && !isCompressed) {
    if (texture.mipLevels > 1) {
      let offset = 0;
      let w = texture.width;
      let h = texture.height;
      for (let level = 0; level < texture.mipLevels; level++) {
        const levelSize = w * h * 4;
        device.queue.writeTexture(
          { texture: gpuTexture, mipLevel: level },
          texture.data.subarray(offset, offset + levelSize) as unknown as BufferSource,
          { bytesPerRow: w * 4 },
          { width: w, height: h },
        );
        offset += levelSize;
        w = Math.max(1, Math.floor(w / 2));
        h = Math.max(1, Math.floor(h / 2));
      }
    } else {
      device.queue.writeTexture(
        { texture: gpuTexture },
        texture.data as unknown as BufferSource,
        { bytesPerRow: texture.width * 4 },
        { width: texture.width, height: texture.height },
      );
    }
  } else if (texture.data instanceof Uint8Array && isCompressed) {
    const { blockWidth, blockHeight, blockBytes } = compressedBlockInfo(texture.format);
    let offset = 0;
    let w = texture.width;
    let h = texture.height;
    for (let level = 0; level < texture.mipLevels; level++) {
      const blocksX = Math.max(1, Math.ceil(w / blockWidth));
      const blocksY = Math.max(1, Math.ceil(h / blockHeight));
      const levelSize = blocksX * blocksY * blockBytes;
      if (offset + levelSize <= texture.data.length) {
        device.queue.writeTexture(
          { texture: gpuTexture, mipLevel: level },
          texture.data.subarray(offset, offset + levelSize) as unknown as BufferSource,
          { bytesPerRow: blocksX * blockBytes },
          // Copy extents must be block multiples; the physical mip extent for
          // compressed formats is block-aligned, so edge blocks are covered.
          { width: blocksX * blockWidth, height: blocksY * blockHeight },
        );
      }
      offset += levelSize;
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  return gpuTexture;
}

export function isCompressedFormat(format: GPUTextureFormat): boolean {
  return format.startsWith("bc") || format.startsWith("astc") || format.startsWith("etc") || format.startsWith("eac");
}

export function createSampler(
  device: GPUDevice,
  options: {
    magFilter?: GPUFilterMode;
    minFilter?: GPUFilterMode;
    mipmapFilter?: GPUFilterMode;
    addressModeU?: GPUAddressMode;
    addressModeV?: GPUAddressMode;
  } = {},
): GPUSampler {
  return device.createSampler({
    magFilter: options.magFilter ?? "linear",
    minFilter: options.minFilter ?? "linear",
    mipmapFilter: options.mipmapFilter ?? "linear",
    addressModeU: options.addressModeU ?? "repeat",
    addressModeV: options.addressModeV ?? "repeat",
  });
}
