export type ProceduralTextureType =
  | "checkerboard"
  | "noise"
  | "perlin"
  | "voronoi"
  | "brick"
  | "wood"
  | "marble"
  | "grid"
  | "gradient";

export interface ProceduralTextureConfig {
  type: ProceduralTextureType;
  width: number;
  height: number;
  scale: number;
  octaves: number;
  persistence: number;
  lacunarity: number;
  seed: number;
  colorA: [number, number, number, number];
  colorB: [number, number, number, number];
}

export const DEFAULT_PROCEDURAL_CONFIG: ProceduralTextureConfig = {
  type: "checkerboard",
  width: 256,
  height: 256,
  scale: 8,
  octaves: 4,
  persistence: 0.5,
  lacunarity: 2.0,
  seed: 0,
  colorA: [1, 1, 1, 1],
  colorB: [0, 0, 0, 1],
};

function hash(x: number, y: number, seed: number): number {
  let h = x * 374761393 + y * 668265263 + seed * 982451653;
  h = (h ^ (h >> 13)) * 1274126177;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const a = hash(ix, iy, seed);
  const b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed);
  const d = hash(ix + 1, iy + 1, seed);
  const ux = smoothstep(0, 1, fx);
  const uy = smoothstep(0, 1, fy);
  return lerp(lerp(a, b, ux), lerp(c, d, ux), uy);
}

function fbm(x: number, y: number, octaves: number, persistence: number, lacunarity: number, seed: number): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let maxValue = 0;
  for (let i = 0; i < octaves; i++) {
    total += valueNoise(x * frequency, y * frequency, seed + i) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= lacunarity;
  }
  return total / maxValue;
}

export function generateProceduralTexture(config: ProceduralTextureConfig): Uint8Array {
  const { width, height, scale, type, colorA, colorB, octaves, persistence, lacunarity, seed } = config;
  const data = new Uint8Array(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const u = x / width;
      const v = y / height;
      let t = 0;

      switch (type) {
        case "checkerboard": {
          const cx = Math.floor(u * scale);
          const cy = Math.floor(v * scale);
          t = (cx + cy) % 2 === 0 ? 0 : 1;
          break;
        }
        case "noise": {
          t = hash(Math.floor(u * scale), Math.floor(v * scale), seed);
          break;
        }
        case "perlin": {
          t = fbm(u * scale, v * scale, octaves, persistence, lacunarity, seed);
          break;
        }
        case "voronoi": {
          const px = u * scale;
          const py = v * scale;
          const ix = Math.floor(px);
          const iy = Math.floor(py);
          let minDist = Infinity;
          for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
              const cx = ix + dx + hash(ix + dx, iy + dy, seed);
              const cy = iy + dy + hash(ix + dx, iy + dy, seed + 1);
              const dist = (cx - px) ** 2 + (cy - py) ** 2;
              minDist = Math.min(minDist, dist);
            }
          }
          t = Math.sqrt(minDist);
          break;
        }
        case "brick": {
          const bx = Math.floor(u * scale);
          const by = Math.floor(v * scale * 0.5);
          const offset = by % 2 === 0 ? 0 : 0.5;
          const bxOffset = Math.floor((u + offset) * scale);
          const mortar = Math.abs((u + offset) * scale - bxOffset - 0.5);
          const mortarY = Math.abs(v * scale * 0.5 - by - 0.5);
          t = (mortar < 0.05 || mortarY < 0.05) ? 1 : 0;
          break;
        }
        case "wood": {
          const nx = u * scale - scale * 0.5;
          const ny = v * scale - scale * 0.5;
          const dist = Math.sqrt(nx * nx + ny * ny);
          t = Math.sin(dist * 2.0 + fbm(u * scale * 0.5, v * scale * 0.5, 3, 0.5, 2, seed) * 5) * 0.5 + 0.5;
          break;
        }
        case "marble": {
          t = Math.sin((u + fbm(u * scale, v * scale, octaves, persistence, lacunarity, seed)) * scale * 2) * 0.5 + 0.5;
          break;
        }
        case "grid": {
          const gx = Math.abs((u * scale) % 1 - 0.5);
          const gy = Math.abs((v * scale) % 1 - 0.5);
          t = (gx < 0.02 || gy < 0.02) ? 1 : 0;
          break;
        }
        case "gradient": {
          t = v;
          break;
        }
      }

      const idx = (y * width + x) * 4;
      data[idx] = Math.round(lerp(colorA[0], colorB[0], t) * 255);
      data[idx + 1] = Math.round(lerp(colorA[1], colorB[1], t) * 255);
      data[idx + 2] = Math.round(lerp(colorA[2], colorB[2], t) * 255);
      data[idx + 3] = Math.round(lerp(colorA[3], colorB[3], t) * 255);
    }
  }

  return data;
}

export function createProceduralGpuTexture(
  device: GPUDevice,
  config: ProceduralTextureConfig,
): GPUTexture {
  const data = generateProceduralTexture(config);
  const texture = device.createTexture({
    label: `procedural-${config.type}`,
    size: [config.width, config.height],
    format: "rgba8unorm",
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture(
    { texture },
    data,
    { bytesPerRow: config.width * 4, rowsPerImage: config.height },
    [config.width, config.height],
  );
  return texture;
}
