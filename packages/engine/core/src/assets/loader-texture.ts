
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

function readKTX2Header(data: Uint8Array): KTX2Header | null {
  const KTX2_MAGIC = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 12; i++) {
    if (data[i] !== KTX2_MAGIC[i]) return null;
  }
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

const VK_FORMAT_MAP: Record<number, GPUTextureFormat> = {
  // Unpacked formats (VK_FORMAT_* enum values)
  37: "rgba8unorm",
  43: "rgba8unorm-srgb",
  45: "bgra8unorm",
  50: "bgra8unorm-srgb",
  76: "r16float" as GPUTextureFormat,
  100: "r32float" as GPUTextureFormat,
  103: "rg32float" as GPUTextureFormat,
  109: "rgba32float" as GPUTextureFormat,

  // BC compressed (VK_FORMAT_BC*_*_BLOCK enum values)
  130: "bc1-rgba-unorm-srgb" as GPUTextureFormat,
  131: "bc1-rgba-unorm" as GPUTextureFormat,
  132: "bc2-rgba-unorm-srgb" as GPUTextureFormat,
  133: "bc2-rgba-unorm" as GPUTextureFormat,
  134: "bc3-rgba-unorm-srgb" as GPUTextureFormat,
  135: "bc3-rgba-unorm" as GPUTextureFormat,
  138: "bc4-r-unorm-srgb" as GPUTextureFormat,
  139: "bc4-r-unorm" as GPUTextureFormat,
  140: "bc5-rg-unorm-srgb" as GPUTextureFormat,
  141: "bc5-rg-unorm" as GPUTextureFormat,
  91: "bc7-unorm" as GPUTextureFormat,
  92: "bc7-unorm-srgb" as GPUTextureFormat,
  97: "bc6h-ufloat" as GPUTextureFormat,
  98: "bc6h-sfloat" as GPUTextureFormat,

  // ETC2/EAC compressed (VK_FORMAT_ETC2/EAC_*_BLOCK enum values)
  146: "etc2-rgb8unorm-srgb" as GPUTextureFormat,
  147: "etc2-rgb8unorm" as GPUTextureFormat,
  150: "etc2-rgba8unorm-srgb" as GPUTextureFormat,
  151: "etc2-rgba8unorm" as GPUTextureFormat,
  152: "eac-r11unorm" as GPUTextureFormat,
  154: "eac-rg11unorm" as GPUTextureFormat,

  // ASTC compressed (VK_FORMAT_ASTC_*_BLOCK enum values = 168-195)
  168: "astc-4x4-unorm" as GPUTextureFormat,
  169: "astc-4x4-unorm-srgb" as GPUTextureFormat,
  170: "astc-5x4-unorm" as GPUTextureFormat,
  171: "astc-5x4-unorm-srgb" as GPUTextureFormat,
  172: "astc-5x5-unorm" as GPUTextureFormat,
  173: "astc-5x5-unorm-srgb" as GPUTextureFormat,
  174: "astc-6x5-unorm" as GPUTextureFormat,
  175: "astc-6x5-unorm-srgb" as GPUTextureFormat,
  176: "astc-6x6-unorm" as GPUTextureFormat,
  177: "astc-6x6-unorm-srgb" as GPUTextureFormat,
  178: "astc-8x5-unorm" as GPUTextureFormat,
  179: "astc-8x5-unorm-srgb" as GPUTextureFormat,
  180: "astc-8x6-unorm" as GPUTextureFormat,
  181: "astc-8x6-unorm-srgb" as GPUTextureFormat,
  182: "astc-8x8-unorm" as GPUTextureFormat,
  183: "astc-8x8-unorm-srgb" as GPUTextureFormat,
  184: "astc-10x5-unorm" as GPUTextureFormat,
  185: "astc-10x5-unorm-srgb" as GPUTextureFormat,
  186: "astc-10x6-unorm" as GPUTextureFormat,
  187: "astc-10x6-unorm-srgb" as GPUTextureFormat,
  188: "astc-10x8-unorm" as GPUTextureFormat,
  189: "astc-10x8-unorm-srgb" as GPUTextureFormat,
  190: "astc-10x10-unorm" as GPUTextureFormat,
  191: "astc-10x10-unorm-srgb" as GPUTextureFormat,
  192: "astc-12x10-unorm" as GPUTextureFormat,
  193: "astc-12x10-unorm-srgb" as GPUTextureFormat,
  194: "astc-12x12-unorm" as GPUTextureFormat,
  195: "astc-12x12-unorm-srgb" as GPUTextureFormat,
};

export async function loadKTX2Texture(uri: string): Promise<TextureData | null> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return parseKTX2FromBuffer(buffer);
}

export function parseKTX2FromBuffer(buffer: ArrayBuffer): TextureData | null {
  const data = new Uint8Array(buffer);
  const header = readKTX2Header(data);
  if (!header) return null;

  const format = VK_FORMAT_MAP[header.vkFormat] ?? "rgba8unorm";
  const isCompressed = isCompressedFormat(format);

  return {
    width: header.pixelWidth,
    height: header.pixelHeight,
    data: data.subarray(80),
    format,
    mipLevels: header.levelCount,
    isHDR: header.vkFormat === 97 || header.vkFormat === 98,
  };
}

export async function loadTexture(
  uri: string,
  options: { format?: GPUTextureFormat; generateMips?: boolean } = {},
): Promise<TextureData> {
  const fmt = detectTextureFormat(uri);

  if (fmt === "ktx2") {
    const result = await loadKTX2Texture(uri);
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

export function createGPUTextureFromData(
  device: GPUDevice,
  texture: TextureData,
  usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.RENDER_ATTACHMENT,
): GPUTexture {
  const isCompressed = isCompressedFormat(texture.format);
  const gpuTexture = device.createTexture({
    size: [texture.width, texture.height],
    format: texture.format,
    usage: isCompressed ? usage | GPUTextureUsage.COPY_DST : usage,
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
    let offset = 0;
    let w = texture.width;
    let h = texture.height;
    for (let level = 0; level < texture.mipLevels; level++) {
      const blockSize = texture.format.startsWith("bc") ? 16 : 8;
      const blocksX = Math.max(1, Math.ceil(w / 4));
      const blocksY = Math.max(1, Math.ceil(h / 4));
      const levelSize = blocksX * blocksY * blockSize;
      if (offset + levelSize <= texture.data.length) {
        device.queue.writeTexture(
          { texture: gpuTexture, mipLevel: level },
          texture.data.subarray(offset, offset + levelSize) as unknown as BufferSource,
          { bytesPerRow: blocksX * blockSize },
          { width: w, height: h },
        );
      }
      offset += levelSize;
      w = Math.max(1, Math.floor(w / 2));
      h = Math.max(1, Math.floor(h / 2));
    }
  }

  return gpuTexture;
}

function isCompressedFormat(format: GPUTextureFormat): boolean {
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
