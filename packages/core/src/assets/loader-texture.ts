export interface TextureData {
  width: number;
  height: number;
  data: Uint8Array | Float32Array;
  format: GPUTextureFormat;
  mipLevels: number;
  isHDR: boolean;
}

export type TextureFormat = "png" | "webp" | "ktx2" | "unknown";

export function detectTextureFormat(uri: string): TextureFormat {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".webp")) return "webp";
  if (lower.endsWith(".ktx2")) return "ktx2";
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

  const mipLevels = generateMips
    ? Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height))) + 1
    : 1;

  return {
    width: bitmap.width,
    height: bitmap.height,
    data: new Uint8Array(imageData.data.buffer),
    format,
    mipLevels,
    isHDR: false,
  };
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
  return {
    vkFormat: view.getUint32(12, true),
    typeSize: view.getUint32(16, true),
    pixelWidth: view.getUint32(20, true),
    pixelHeight: view.getUint32(24, true),
    pixelDepth: view.getUint32(28, true),
    layerCount: view.getUint32(32, true),
    faceCount: view.getUint32(36, true),
    levelCount: view.getUint32(40, true),
  };
}

const VK_FORMAT_MAP: Record<number, GPUTextureFormat> = {
  37: "rgba8unorm",
  43: "rgba8unorm-srgb",
  45: "bgra8unorm",
  50: "bgra8unorm-srgb",
  91: "bc7-unorm" as GPUTextureFormat,
  92: "bc7-unorm-srgb" as GPUTextureFormat,
  97: "bc6h-ufloat" as GPUTextureFormat,
  98: "bc6h-sfloat" as GPUTextureFormat,
  76: "astc-4x4-unorm",
  77: "astc-4x4-unorm-srgb",
};

export async function loadKTX2Texture(uri: string): Promise<TextureData | null> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  const data = new Uint8Array(buffer);
  const header = readKTX2Header(data);
  if (!header) return null;

  const format = VK_FORMAT_MAP[header.vkFormat] ?? "rgba8unorm";
  const isCompressed = header.vkFormat >= 100;

  return {
    width: header.pixelWidth,
    height: header.pixelHeight,
    data: isCompressed ? data : data,
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

  return loadTextureFromImage(uri, options.format, options.generateMips);
}

export function createGPUTextureFromData(
  device: GPUDevice,
  texture: TextureData,
  usage: GPUTextureUsageFlags = GPUTextureUsage.TEXTURE_BINDING |
    GPUTextureUsage.COPY_DST |
    GPUTextureUsage.RENDER_ATTACHMENT,
): GPUTexture {
  const gpuTexture = device.createTexture({
    size: [texture.width, texture.height],
    format: texture.format,
    usage,
    mipLevelCount: texture.mipLevels,
  });

  if (texture.data instanceof Uint8Array && !isCompressedFormat(texture.format)) {
    device.queue.writeTexture(
      { texture: gpuTexture },
      texture.data.buffer as ArrayBuffer,
      { bytesPerRow: texture.width * 4 },
      { width: texture.width, height: texture.height },
    );
  }

  return gpuTexture;
}

function isCompressedFormat(format: GPUTextureFormat): boolean {
  return format.startsWith("bc") || format.startsWith("astc") || format.startsWith("etc");
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
