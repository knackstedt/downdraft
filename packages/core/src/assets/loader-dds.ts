import type { TextureData } from "./loader-texture.ts";

const DDS_MAGIC = 0x20534444; // "DDS "

const DDS_HEADER_SIZE = 124;
const DDS_PIXEL_FOURCC = 0x00000004;
const DDS_PIXEL_RGB = 0x00000040;
const DDS_PIXEL_RGBA = 0x00000041;
const DDS_PIXEL_LUMINANCE = 0x00020000;
const DDS_PIXEL_LUMINANCE_ALPHA = 0x00020001;

const DDS_FOURCC_DXT1 = 0x31545844; // "DXT1"
const DDS_FOURCC_DXT3 = 0x33545844; // "DXT3"
const DDS_FOURCC_DXT5 = 0x35545844; // "DXT5"
const DDS_FOURCC_ATI1 = 0x31495441; // "ATI1"
const DDS_FOURCC_ATI2 = 0x32495441; // "ATI2"
const DDS_FOURCC_BC4U = 0x55344243; // "BC4U"
const DDS_FOURCC_BC5U = 0x55354243; // "BC5U"

const DDS_HEADER_FLAGS_MIPMAP = 0x00020000;
const DDS_SURFACE_FLAGS_MIPMAP = 0x40000008;

interface DDSHeader {
  height: number;
  width: number;
  pitchOrLinearSize: number;
  mipMapCount: number;
  fourCC: number;
  pixelFlags: number;
  rgbBitCount: number;
  rBitMask: number;
  gBitMask: number;
  bBitMask: number;
  aBitMask: number;
  hasDX10Header: boolean;
  dx10Format: number;
}

function readDDSHeader(view: DataView): DDSHeader | null {
  if (view.byteLength < DDS_HEADER_SIZE + 4) return null;

  const magic = view.getUint32(0, true);
  if (magic !== DDS_MAGIC) return null;

  const size = view.getUint32(4, true);
  if (size !== 124) return null;

  const flags = view.getUint32(8, true);
  const height = view.getUint32(12, true);
  const width = view.getUint32(16, true);
  const pitchOrLinearSize = view.getUint32(20, true);
  const mipMapCount = view.getUint32(28, true);

  const pixelFlags = view.getUint32(76, true);
  const fourCC = view.getUint32(84, true);
  const rgbBitCount = view.getUint32(88, true);
  const rBitMask = view.getUint32(92, true);
  const gBitMask = view.getUint32(96, true);
  const bBitMask = view.getUint32(100, true);
  const aBitMask = view.getUint32(104, true);

  // Check for DX10 extended header (fourCC === "DX10")
  const DDS_FOURCC_DX10 = 0x30315844; // "DX10"
  const hasDX10Header = fourCC === DDS_FOURCC_DX10;
  let dx10Format = 0;

  if (hasDX10Header) {
    if (view.byteLength < DDS_HEADER_SIZE + 4 + 20) return null;
    dx10Format = view.getUint32(DDS_HEADER_SIZE + 4, true);
  }

  return {
    height,
    width,
    pitchOrLinearSize,
    mipMapCount: (flags & DDS_HEADER_FLAGS_MIPMAP) ? Math.max(1, mipMapCount) : 1,
    fourCC,
    pixelFlags,
    rgbBitCount,
    rBitMask,
    gBitMask,
    bBitMask,
    aBitMask,
    hasDX10Header,
    dx10Format,
  };
}

interface FormatInfo {
  format: GPUTextureFormat;
  blockSize: number;
  blockWidth: number;
  blockHeight: number;
  isCompressed: boolean;
  isHDR: boolean;
  bytesPerPixel: number;
}

function resolveDDSFormat(header: DDSHeader): FormatInfo {
  const DX10_FORMAT_MAP: Record<number, GPUTextureFormat> = {
    98: "bc6h-sfloat" as GPUTextureFormat,
    97: "bc6h-ufloat" as GPUTextureFormat,
    131: "bc1-rgba-unorm" as GPUTextureFormat,
    130: "bc1-rgba-unorm-srgb" as GPUTextureFormat,
    133: "bc2-rgba-unorm" as GPUTextureFormat,
    132: "bc2-rgba-unorm-srgb" as GPUTextureFormat,
    135: "bc3-rgba-unorm" as GPUTextureFormat,
    134: "bc3-rgba-unorm-srgb" as GPUTextureFormat,
    139: "bc4-r-unorm" as GPUTextureFormat,
    138: "bc4-r-unorm-srgb" as GPUTextureFormat,
    141: "bc5-rg-unorm" as GPUTextureFormat,
    140: "bc5-rg-unorm-srgb" as GPUTextureFormat,
  };

  if (header.hasDX10Header) {
    const fmt = DX10_FORMAT_MAP[header.dx10Format];
    if (fmt) {
      const isBC6H = fmt.startsWith("bc6h");
      return {
        format: fmt,
        blockSize: isBC6H ? 16 : (fmt.startsWith("bc1") || fmt.startsWith("bc4") ? 8 : 16),
        blockWidth: 4,
        blockHeight: 4,
        isCompressed: true,
        isHDR: isBC6H,
        bytesPerPixel: 0,
      };
    }
  }

  if (header.pixelFlags & DDS_PIXEL_FOURCC) {
    switch (header.fourCC) {
      case DDS_FOURCC_DXT1:
        return { format: "bc1-rgba-unorm" as GPUTextureFormat, blockSize: 8, blockWidth: 4, blockHeight: 4, isCompressed: true, isHDR: false, bytesPerPixel: 0 };
      case DDS_FOURCC_DXT3:
        return { format: "bc2-rgba-unorm" as GPUTextureFormat, blockSize: 16, blockWidth: 4, blockHeight: 4, isCompressed: true, isHDR: false, bytesPerPixel: 0 };
      case DDS_FOURCC_DXT5:
      case DDS_FOURCC_ATI2:
      case DDS_FOURCC_BC5U:
        return { format: "bc3-rgba-unorm" as GPUTextureFormat, blockSize: 16, blockWidth: 4, blockHeight: 4, isCompressed: true, isHDR: false, bytesPerPixel: 0 };
      case DDS_FOURCC_ATI1:
      case DDS_FOURCC_BC4U:
        return { format: "bc4-r-unorm" as GPUTextureFormat, blockSize: 8, blockWidth: 4, blockHeight: 4, isCompressed: true, isHDR: false, bytesPerPixel: 0 };
    }
  }

  if (header.pixelFlags & DDS_PIXEL_RGBA || (header.pixelFlags & DDS_PIXEL_RGB && header.aBitMask !== 0)) {
    if (header.rgbBitCount === 32) {
      if (header.rBitMask === 0x00FF0000 && header.gBitMask === 0x0000FF00 && header.bBitMask === 0x000000FF) {
        return { format: "bgra8unorm" as GPUTextureFormat, blockSize: 0, blockWidth: 1, blockHeight: 1, isCompressed: false, isHDR: false, bytesPerPixel: 4 };
      }
      return { format: "rgba8unorm" as GPUTextureFormat, blockSize: 0, blockWidth: 1, blockHeight: 1, isCompressed: false, isHDR: false, bytesPerPixel: 4 };
    }
  }

  if (header.pixelFlags & DDS_PIXEL_RGB) {
    return { format: "rgba8unorm" as GPUTextureFormat, blockSize: 0, blockWidth: 1, blockHeight: 1, isCompressed: false, isHDR: false, bytesPerPixel: 4 };
  }

  if (header.pixelFlags & DDS_PIXEL_LUMINANCE) {
    return { format: "r8unorm" as GPUTextureFormat, blockSize: 0, blockWidth: 1, blockHeight: 1, isCompressed: false, isHDR: false, bytesPerPixel: 1 };
  }

  if (header.pixelFlags & DDS_PIXEL_LUMINANCE_ALPHA) {
    return { format: "rg8unorm" as GPUTextureFormat, blockSize: 0, blockWidth: 1, blockHeight: 1, isCompressed: false, isHDR: false, bytesPerPixel: 2 };
  }

  return { format: "rgba8unorm" as GPUTextureFormat, blockSize: 0, blockWidth: 1, blockHeight: 1, isCompressed: false, isHDR: false, bytesPerPixel: 4 };
}

function computeLevelSize(width: number, height: number, info: FormatInfo): number {
  if (info.isCompressed) {
    const blocksX = Math.max(1, Math.ceil(width / info.blockWidth));
    const blocksY = Math.max(1, Math.ceil(height / info.blockHeight));
    return blocksX * blocksY * info.blockSize;
  }
  return width * height * info.bytesPerPixel;
}

export function parseDDS(data: ArrayBuffer): TextureData | null {
  const view = new DataView(data);
  const header = readDDSHeader(view);
  if (!header) return null;

  const info = resolveDDSFormat(header);
  const dataOffset = header.hasDX10Header ? DDS_HEADER_SIZE + 4 + 20 : DDS_HEADER_SIZE + 4;

  const mipLevels = header.mipMapCount;
  const levels: Uint8Array[] = [];
  let offset = dataOffset;
  let w = header.width;
  let h = header.height;

  for (let level = 0; level < mipLevels; level++) {
    const levelSize = computeLevelSize(w, h, info);
    if (offset + levelSize > data.byteLength) break;
    levels.push(new Uint8Array(data, offset, levelSize));
    offset += levelSize;
    w = Math.max(1, Math.floor(w / 2));
    h = Math.max(1, Math.floor(h / 2));
  }

  if (levels.length === 0) return null;

  const totalSize = levels.reduce((sum, l) => sum + l.length, 0);
  const combined = new Uint8Array(totalSize);
  let dstOffset = 0;
  for (const level of levels) {
    combined.set(level, dstOffset);
    dstOffset += level.length;
  }

  return {
    width: header.width,
    height: header.height,
    data: combined,
    format: info.format,
    mipLevels: levels.length,
    isHDR: info.isHDR,
  };
}

export async function loadDDSTexture(uri: string): Promise<TextureData | null> {
  const response = await fetch(uri);
  const buffer = await response.arrayBuffer();
  return parseDDS(buffer);
}

export function loadDDSFromBuffer(data: ArrayBuffer): TextureData | null {
  return parseDDS(data);
}
