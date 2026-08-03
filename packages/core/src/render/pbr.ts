// ============================================================================
// PBR System — BRDF integration LUT + IBL environment textures
// Generates a pre-computed BRDF LUT on CPU and uploads via writeTexture.
// Provides bind group layout for PBR resources shared across all entity pipelines.
// ============================================================================

const BRDF_LUT_SIZE = 256;
const SAMPLE_COUNT = 1024;

const PI = Math.PI;

function radicalInverseVdC(bits: number): number {
  let v = bits >>> 0;
  v = ((v >>> 16) & 0xffff) | ((v & 0xffff) << 16);
  v = ((v >>> 8) & 0x00ff00ff) | ((v & 0x00ff00ff) << 8);
  v = ((v >>> 4) & 0x0f0f0f0f) | ((v & 0x0f0f0f0f) << 4);
  v = ((v >>> 2) & 0x33333333) | ((v & 0x33333333) << 2);
  v = ((v >>> 1) & 0x55555555) | ((v & 0x55555555) << 1);
  return (v >>> 0) / 4294967296.0;
}

function hammersley(i: number, n: number): [number, number] {
  return [i / n, radicalInverseVdC(i)];
}

function geometrySchlickGGX(NdotV: number, roughness: number): number {
  const r = roughness + 1.0;
  const k = (r * r) / 8.0;
  return NdotV / (NdotV * (1.0 - k) + k);
}

function geometrySmith(NdotV: number, NdotL: number, roughness: number): number {
  return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

function integrateBRDF(NdotV: number, roughness: number): [number, number] {
  const V = [
    Math.sqrt(1.0 - NdotV * NdotV),
    0.0,
    NdotV,
  ];

  let A = 0.0;
  let B = 0.0;

  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const xi = hammersley(i, SAMPLE_COUNT);

    const a = roughness * roughness;
    const phi = 2.0 * PI * xi[0];
    const cosTheta = Math.sqrt((1.0 - xi[1]) / (1.0 + (a * a - 1.0) * xi[1]));
    const sinTheta = Math.sqrt(1.0 - cosTheta * cosTheta);

    const Hx = sinTheta * Math.cos(phi);
    const Hy = sinTheta * Math.sin(phi);
    const Hz = cosTheta;

    const VdotH = Math.max(V[0] * Hx + V[1] * Hy + V[2] * Hz, 0.0);
    const NdotH = Math.max(Hz, 0.0);

    const Lx = 2.0 * VdotH * Hx - V[0];
    const Ly = 2.0 * VdotH * Hy - V[1];
    const Lz = 2.0 * VdotH * Hz - V[2];
    const Llen = Math.sqrt(Lx * Lx + Ly * Ly + Lz * Lz) || 1.0;
    const NdotL = Math.max(Lz / Llen, 0.0);

    if (NdotL > 0.0) {
      const G = geometrySmith(NdotV, NdotL, roughness);
      const G_Vis = (G * VdotH) / (NdotH * NdotV + 0.0001);
      const Fc = Math.pow(1.0 - VdotH, 5.0);

      A += (1.0 - Fc) * G_Vis;
      B += Fc * G_Vis;
    }
  }

  A /= SAMPLE_COUNT;
  B /= SAMPLE_COUNT;

  return [A, B];
}

function floatToHalf(val: number): number {
  const floatView = new Float32Array(1);
  const intView = new Uint32Array(floatView.buffer);
  floatView[0] = val;
  const x = intView[0];

  const sign = (x >>> 31) & 1;
  let exponent = (x >>> 23) & 0xff;
  let mantissa = x & 0x7fffff;

  if (exponent === 0xff) {
    return (sign << 15) | 0x7c00 | (mantissa ? 0x200 : 0);
  }

  exponent = exponent - 112;

  if (exponent <= 0) {
    mantissa = (mantissa | 0x800000) >> (1 - exponent);
    return (sign << 15) | (mantissa >> 13);
  }

  if (exponent >= 31) {
    return (sign << 15) | 0x7c00;
  }

  return (sign << 15) | (exponent << 10) | (mantissa >> 13);
}

export class PBRSystem {
  private device: GPUDevice;

  brdfLUT: GPUTexture | null = null;
  brdfLUTView: GPUTextureView | null = null;
  brdfSampler: GPUSampler | null = null;
  bindGroupLayout: GPUBindGroupLayout | null = null;
  bindGroup: GPUBindGroup | null = null;

  private lutResolve: () => void = () => {};
  readonly lutReady: Promise<void> = new Promise(resolve => { this.lutResolve = resolve; });

  constructor(device: GPUDevice) {
    this.device = device;
  }

  init(): void {
    const dev = this.device;
    this.brdfLUT = dev.createTexture({
      size: [BRDF_LUT_SIZE, BRDF_LUT_SIZE],
      format: "rgba16float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.brdfLUTView = this.brdfLUT.createView();
    this.brdfSampler = dev.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    this.bindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });
    this.bindGroup = dev.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: this.brdfLUTView },
        { binding: 1, resource: this.brdfSampler },
      ],
    });
    this.generateLUTAsync().then(() => this.lutResolve());
  }

  private async generateLUTAsync(): Promise<void> {
    const ROWS_PER_CHUNK = 8;
    const data = new Uint16Array(BRDF_LUT_SIZE * BRDF_LUT_SIZE * 4);

    for (let rowStart = 0; rowStart < BRDF_LUT_SIZE; rowStart += ROWS_PER_CHUNK) {
      const rowEnd = Math.min(rowStart + ROWS_PER_CHUNK, BRDF_LUT_SIZE);

      for (let y = rowStart; y < rowEnd; y++) {
        for (let x = 0; x < BRDF_LUT_SIZE; x++) {
          const NdotV = (x + 0.5) / BRDF_LUT_SIZE;
          const roughness = (y + 0.5) / BRDF_LUT_SIZE;
          const [scale, bias] = integrateBRDF(NdotV, roughness);

          const idx = (y * BRDF_LUT_SIZE + x) * 4;
          data[idx] = floatToHalf(scale);
          data[idx + 1] = floatToHalf(bias);
          data[idx + 2] = 0;
          data[idx + 3] = floatToHalf(1.0);
        }
      }

      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }

    this.device.queue.writeTexture(
      { texture: this.brdfLUT! },
      data,
      { bytesPerRow: BRDF_LUT_SIZE * 4 * 2, rowsPerImage: BRDF_LUT_SIZE },
      { width: BRDF_LUT_SIZE, height: BRDF_LUT_SIZE },
    );
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.bindGroupLayout;
  }

  getBindGroup(): GPUBindGroup | null {
    return this.bindGroup;
  }
}
