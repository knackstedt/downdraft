import { loadHDRFile } from "./loader-hdr";
import type { TextureData } from "./loader-texture";

export interface CubemapFaceData {
  width: number;
  height: number;
  data: Float32Array;
}

export interface CubemapData {
  width: number;
  height: number;
  faces: CubemapFaceData[]; // 6 faces: +X, -X, +Y, -Y, +Z, -Z
  isHDR: boolean;
}

const FACE_NAMES = ["px", "nx", "py", "ny", "pz", "nz"] as const;

export async function loadCubemapFromFiles(
  faceUris: [string, string, string, string, string, string],
): Promise<CubemapData> {
  const faces: CubemapFaceData[] = [];

  for (let i = 0; i < 6; i++) {
    const texData = await loadHDRFile(faceUris[i]);
    if (!texData) continue;
    if (texData.data instanceof Float32Array) {
      faces.push({
        width: texData.width,
        height: texData.height,
        data: texData.data,
      });
    } else {
      // Convert Uint8Array to Float32Array
      const uint8Data = texData.data as Uint8Array;
      const floatData = new Float32Array(uint8Data.length);
      for (let j = 0; j < uint8Data.length; j++) {
        floatData[j] = uint8Data[j] / 255;
      }
      faces.push({
        width: texData.width,
        height: texData.height,
        data: floatData,
      });
    }
  }

  const width = faces[0].width;
  const height = faces[0].height;
  const isHDR = faces.every((f) => f.data.every((v, idx) => idx % 4 !== 3 || v <= 1.0)) || faces[0].data.some((v) => v > 1.0);

  return { width, height, faces, isHDR };
}

export async function loadCubemapFromDirectory(
  basePath: string,
  prefix: string = "",
  extension: string = ".hdr",
): Promise<CubemapData> {
  const faceUris = FACE_NAMES.map((name) => `${basePath}/${prefix}${name}${extension}`) as [
    string, string, string, string, string, string,
  ];
  return loadCubemapFromFiles(faceUris);
}

export function createGPUCubemap(
  device: GPUDevice,
  cubemap: CubemapData,
  format: GPUTextureFormat = "rgba16float",
): GPUTexture {
  const { width, height, faces } = cubemap;

  const texture = device.createTexture({
    size: [width, height, 6],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING |
           GPUTextureUsage.COPY_DST |
           GPUTextureUsage.RENDER_ATTACHMENT,
  });

  for (let face = 0; face < 6; face++) {
    const faceData = faces[face];
    // Convert Float32Array to Uint16Array for rgba16float
    if (format === "rgba16float") {
      const halfData = new Uint16Array(faceData.data.length);
      for (let i = 0; i < faceData.data.length; i++) {
        halfData[i] = floatToHalf(faceData.data[i]);
      }
      device.queue.writeTexture(
        { texture, origin: [0, 0, face] },
        halfData as unknown as GPUAllowSharedBufferSource,
        { bytesPerRow: width * 8 },
        { width, height },
      );
    } else if (format === "rgba32float") {
      device.queue.writeTexture(
        { texture, origin: [0, 0, face] },
        faceData.data as unknown as GPUAllowSharedBufferSource,
        { bytesPerRow: width * 16 },
        { width, height },
      );
    } else {
      // Assume 8-bit format
      const uint8Data = new Uint8Array(faceData.data.length);
      for (let i = 0; i < faceData.data.length; i++) {
        uint8Data[i] = Math.min(255, Math.max(0, Math.round(faceData.data[i] * 255)));
      }
      device.queue.writeTexture(
        { texture, origin: [0, 0, face] },
        uint8Data as unknown as GPUAllowSharedBufferSource,
        { bytesPerRow: width * 4 },
        { width, height },
      );
    }
  }

  return texture;
}

export function createEquirectangularGPUTexture(
  device: GPUDevice,
  texData: TextureData,
  format: GPUTextureFormat = "rgba16float",
): GPUTexture {
  const { width, height, data } = texData;
  const texture = device.createTexture({
    size: [width, height],
    format,
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });

  if (data instanceof Float32Array) {
    if (format === "rgba16float") {
      const halfData = new Uint16Array(data.length);
      for (let i = 0; i < data.length; i++) {
        halfData[i] = floatToHalf(data[i]);
      }
      device.queue.writeTexture(
        { texture },
        halfData,
        { bytesPerRow: width * 8 },
        { width, height },
      );
    } else {
      device.queue.writeTexture(
        { texture },
        data as unknown as GPUAllowSharedBufferSource,
        { bytesPerRow: width * 16 },
        { width, height },
      );
    }
  } else {
    device.queue.writeTexture(
      { texture },
      data as unknown as GPUAllowSharedBufferSource,
      { bytesPerRow: width * 4 },
      { width, height },
    );
  }

  return texture;
}

function floatToHalf(f: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = f;
  const x = u32[0];
  const sign = (x >>> 31) & 1;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;

  if (exp === 0xff) {
    // Inf or NaN
    return (sign << 15) | 0x7c00 | (mant ? 1 : 0);
  }

  if (exp === 0) {
    // Subnormal or zero
    if (mant === 0) return sign << 15;
    // Normalize subnormal
    let shift = 0;
    while ((mant & 0x400000) === 0) {
      mant <<= 1;
      shift++;
    }
    mant &= 0x7fffff;
    exp = 1 - shift;
  }

  exp = exp - 127 + 15;
  if (exp <= 0) {
    if (exp < -10) return sign << 15;
    mant |= 0x800000;
    const shift = 14 - exp;
    mant >>= shift;
    return (sign << 15) | mant;
  }
  if (exp > 30) {
    return (sign << 15) | 0x7c00;
  }

  return (sign << 15) | (exp << 10) | (mant >> 13);
}
