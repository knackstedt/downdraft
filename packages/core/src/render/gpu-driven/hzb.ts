export interface HzbSize {
  width: number;
  height: number;
  levels: number;
}

export function nextPowerOf2(v: number): number {
  v--;
  v |= v >> 1;
  v |= v >> 2;
  v |= v >> 4;
  v |= v >> 8;
  v |= v >> 16;
  return v + 1;
}

export function computeHzbSize(screenWidth: number, screenHeight: number): HzbSize {
  const width = nextPowerOf2(Math.max(1, Math.ceil(screenWidth)));
  const height = nextPowerOf2(Math.max(1, Math.ceil(screenHeight)));
  const levels = Math.max(1, Math.floor(Math.log2(Math.max(width, height))) + 1);
  return { width, height, levels };
}

export class HzbBuilder {
  private device: GPUDevice;
  private width = 0;
  private height = 0;
  private hzbTexture: GPUTexture | null = null;
  private hzbViews: GPUTextureView[] = [];
  private depthToHzbPipeline: GPUComputePipeline | null = null;
  private reducePipeline: GPUComputePipeline | null = null;
  private reduceBindGroups: GPUBindGroup[] = [];
  private uniformBuffer: GPUBuffer | null = null;
  private initialized = false;

  constructor(device: GPUDevice) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  get size(): HzbSize {
    return { width: this.width, height: this.height, levels: this.hzbViews.length };
  }

  get topLevelView(): GPUTextureView | null {
    return this.hzbViews[0] ?? null;
  }

  get levels(): number {
    return this.hzbViews.length;
  }

  /** Reallocate the HZB texture if the viewport size changes. Returns true if allocated/ resized. */
  ensureSize(screenWidth: number, screenHeight: number): boolean {
    const { width: w, height: h, levels } = computeHzbSize(screenWidth, screenHeight);

    if (this.hzbTexture && this.width === w && this.height === h) {
      return false;
    }

    this.hzbTexture?.destroy();
    this.width = w;
    this.height = h;

    this.hzbTexture = this.device.createTexture({
      size: [w, h, 1],
      mipLevelCount: levels,
      format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING,
    });

    this.hzbViews = [];
    for (let i = 0; i < levels; i++) {
      this.hzbViews.push(this.hzbTexture.createView({
        dimension: "2d",
        baseMipLevel: i,
        mipLevelCount: 1,
      }));
    }

    this.reduceBindGroups = [];
    this.initialized = false;
    return true;
  }

  /** Build HZB from a depth texture. The depth view should match the current viewport. */
  build(encoder: GPUCommandEncoder, depthTextureView: GPUTextureView, depthWidth: number, depthHeight: number): void {
    if (!this.hzbTexture || !this.uniformBuffer) return;
    if (!this.initialized) this.preparePipelines();

    const u = new Uint32Array(4);
    u[0] = this.width;
    u[1] = this.height;
    u[2] = depthWidth;
    u[3] = depthHeight;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u as unknown as BufferSource);

    const depthToHzbBg = this.device.createBindGroup({
      layout: this.depthToHzbPipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: depthTextureView },
        { binding: 2, resource: this.hzbViews[0]! },
      ],
    });

    const pass = encoder.beginComputePass({ label: "hzb-build" });

    // 0. Convert depth to HZB[0]
    pass.setPipeline(this.depthToHzbPipeline!);
    pass.setBindGroup(0, depthToHzbBg);
    const wx = Math.ceil(this.width / 8);
    const wy = Math.ceil(this.height / 8);
    pass.dispatchWorkgroups(wx, wy);

    // 1. Reduce HZB[i-1] -> HZB[i]
    pass.setPipeline(this.reducePipeline!);
    for (let i = 1; i < this.hzbViews.length; i++) {
      const dstW = Math.max(1, this.width >> i);
      const dstH = Math.max(1, this.height >> i);
      pass.setBindGroup(0, this.reduceBindGroups[i - 1]!);
      const rx = Math.max(1, Math.ceil(dstW / 8));
      const ry = Math.max(1, Math.ceil(dstH / 8));
      pass.dispatchWorkgroups(rx, ry);
    }

    pass.end();
  }

  private preparePipelines(): void {
    this.depthToHzbPipeline = this.device.createComputePipeline({
      label: "hzb-depth-to-hzb",
      layout: "auto",
      compute: { module: this.device.createShaderModule({ code: DEPTH_TO_HZB_WGSL }), entryPoint: "cs_main" },
    });

    this.reducePipeline = this.device.createComputePipeline({
      label: "hzb-reduce",
      layout: "auto",
      compute: { module: this.device.createShaderModule({ code: HZB_REDUCE_WGSL }), entryPoint: "cs_main" },
    });

    this.reduceBindGroups = [];
    for (let i = 1; i < this.hzbViews.length; i++) {
      this.reduceBindGroups.push(this.device.createBindGroup({
        layout: this.reducePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.hzbViews[i - 1]! },
          { binding: 1, resource: this.hzbViews[i]! },
        ],
      }));
    }

    this.initialized = true;
  }

  destroy(): void {
    this.hzbTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.hzbTexture = null;
    this.uniformBuffer = null;
    this.hzbViews = [];
    this.reduceBindGroups = [];
    this.depthToHzbPipeline = null;
    this.reducePipeline = null;
    this.initialized = false;
  }
}

const DEPTH_TO_HZB_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> u: vec4<u32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var hzbOut: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dims = textureDimensions(depthTex, 0);
  if (gid.x >= u.x || gid.y >= u.y) { return; }
  let coord = vec2<i32>(i32(gid.x), i32(gid.y));
  var d: f32 = 1.0;
  if (gid.x < u32(dims.x) && gid.y < u32(dims.y)) {
    d = textureLoad(depthTex, coord, 0);
  }
  textureStore(hzbOut, coord, vec4<f32>(d, 0.0, 0.0, 0.0));
}
`;

const HZB_REDUCE_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var dst: texture_storage_2d<r32float, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dstDims = textureDimensions(dst, 0);
  if (gid.x >= u32(dstDims.x) || gid.y >= u32(dstDims.y)) { return; }
  let srcCoord = vec2<i32>(i32(gid.x * 2u), i32(gid.y * 2u));
  var d: f32 = 1.0;
  let srcDims = textureDimensions(src, 0);
  for (var y: i32 = 0; y < 2; y = y + 1) {
    for (var x: i32 = 0; x < 2; x = x + 1) {
      let c = srcCoord + vec2<i32>(x, y);
      if (c.x >= 0 && c.x < i32(srcDims.x) && c.y >= 0 && c.y < i32(srcDims.y)) {
        d = min(d, textureLoad(src, c, 0).r);
      }
    }
  }
  textureStore(dst, vec2<i32>(i32(gid.x), i32(gid.y)), vec4<f32>(d, 0.0, 0.0, 0.0));
}
`;
