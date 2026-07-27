// ============================================================================
// PerlinNoise3D — seeded 3D Perlin noise with fBm for cave/terrain generation
// ============================================================================

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

// 3D gradient function — 12 gradient directions (corners of a cube's edges)
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1],
];

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 11;
  const g = GRAD3[h];
  return g[0] * x + g[1] * y + g[2] * z;
}

export class PerlinNoise3D {
  private perm: Uint8Array;

  constructor(seed: number) {
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;

    const rng = mulberry32(seed);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }

    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  noise3D(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;

    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);

    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const A = this.perm[X] + Y;
    const AA = this.perm[A] + Z;
    const AB = this.perm[A + 1] + Z;
    const B = this.perm[X + 1] + Y;
    const BA = this.perm[B] + Z;
    const BB = this.perm[B + 1] + Z;

    const x1 = lerp(
      grad3(this.perm[AA], xf, yf, zf),
      grad3(this.perm[BA], xf - 1, yf, zf),
      u,
    );
    const x2 = lerp(
      grad3(this.perm[AB], xf, yf - 1, zf),
      grad3(this.perm[BB], xf - 1, yf - 1, zf),
      u,
    );
    const y1 = lerp(x1, x2, v);

    const x3 = lerp(
      grad3(this.perm[AA + 1], xf, yf, zf - 1),
      grad3(this.perm[BA + 1], xf - 1, yf, zf - 1),
      u,
    );
    const x4 = lerp(
      grad3(this.perm[AB + 1], xf, yf - 1, zf - 1),
      grad3(this.perm[BB + 1], xf - 1, yf - 1, zf - 1),
      u,
    );
    const y2 = lerp(x3, x4, v);

    return lerp(y1, y2, w);
  }

  fbm3D(
    x: number, y: number, z: number,
    octaves: number, persistence: number, lacunarity: number,
  ): number {
    let total = 0;
    let frequency = 1;
    let amplitude = 1;
    let maxValue = 0;
    for (let i = 0; i < octaves; i++) {
      total += this.noise3D(x * frequency, y * frequency, z * frequency) * amplitude;
      maxValue += amplitude;
      amplitude *= persistence;
      frequency *= lacunarity;
    }
    return total / maxValue;
  }
}
