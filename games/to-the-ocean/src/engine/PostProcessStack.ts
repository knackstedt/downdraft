// ============================================================================
// PostProcess Stack — chainable WebGPU postprocessing effects
// Implements: FXAA, Depth of Field, Sobel edge detection, Afterimage, Bloom, ASCII
// Based on Three.js examples:
//   webgpu_postprocessing_fxaa, webgpu_postprocessing_dof,
//   webgl_postprocessing_sobel, webgl_postprocessing_afterimage,
//   webgl_postprocessing (bloom), webgl_effects_ascii
// ============================================================================

export interface ViewportRect { x: number; y: number; w: number; h: number; }

// ── Common fullscreen-triangle vertex shader ────────────────────────────────
const VS = /* wgsl */ `
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var p = array<vec2<f32>, 3>(
    vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0),
  );
  var o: VertexOutput;
  o.clipPos = vec4(p[vi], 0.0, 1.0);
  o.uv = vec2(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}
fn lum(c: vec3<f32>) -> f32 { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// ── FXAA ────────────────────────────────────────────────────────────────────
const FXAA_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, _p6: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let t = u.texelSize;
  let cM = textureSample(colorTex, samp, uv);
  let cN = textureSample(colorTex, samp, uv + vec2(0.0, -t.y));
  let cS = textureSample(colorTex, samp, uv + vec2(0.0,  t.y));
  let cW = textureSample(colorTex, samp, uv + vec2(-t.x, 0.0));
  let cE = textureSample(colorTex, samp, uv + vec2( t.x, 0.0));
  let cNE = textureSample(colorTex, samp, uv + vec2( t.x, -t.y));
  let cNW = textureSample(colorTex, samp, uv + vec2(-t.x, -t.y));
  let cSE = textureSample(colorTex, samp, uv + vec2( t.x,  t.y));
  let cSW = textureSample(colorTex, samp, uv + vec2(-t.x,  t.y));
  let cP1H = textureSample(colorTex, samp, uv + vec2(0.0, t.y * 0.5));
  let cP2H = textureSample(colorTex, samp, uv - vec2(0.0, t.y * 0.5));
  let cP1V = textureSample(colorTex, samp, uv + vec2(t.x * 0.5, 0.0));
  let cP2V = textureSample(colorTex, samp, uv - vec2(t.x * 0.5, 0.0));

  let lM = lum(cM.rgb);
  let lN = lum(cN.rgb);
  let lS = lum(cS.rgb);
  let lW = lum(cW.rgb);
  let lE = lum(cE.rgb);
  let lNE = lum(cNE.rgb);
  let lNW = lum(cNW.rgb);
  let lSE = lum(cSE.rgb);
  let lSW = lum(cSW.rgb);

  let lMin = min(lM, min(min(lN, lS), min(lW, lE)));
  let lMax = max(lM, max(max(lN, lS), max(lW, lE)));
  let lRange = lMax - lMin;
  let skipLow = lRange < max(0.0312, 0.125 * lMax);

  let edgeH = abs(-2.0 * lW + (lNE + lNW)) + abs(2.0 * lE + (lSE + lSW));
  let edgeV = abs(-2.0 * lN + (lNE + lNW)) + abs(2.0 * lS + (lSE + lSW));
  let isH = edgeH >= edgeV;
  let l1 = select(lN, lW, isH);
  let l2 = select(lS, lE, isH);
  let grad = abs(l1 - lM) + abs(l2 - lM);
  let skipGrad = grad < 0.125 * lRange;

  let cP1 = select(cP1H, cP1V, isH);
  let cP2 = select(cP2H, cP2V, isH);
  let blend = clamp(0.5 + 0.5 * grad / lRange, 0.0, 1.0);
  let aaColor = mix(cM, (cP1 + cP2) * 0.5, blend * 0.5);

  return select(select(aaColor, cM, skipGrad), cM, skipLow);
}
`;

// ── Depth of Field ──────────────────────────────────────────────────────────
const DOF_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, focusDist: f32, focusRange: f32, maxBlur: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var depthTex: texture_depth_2d;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let depth = textureSample(depthTex, samp, uv);
  let coc = clamp(abs(depth - u.focusDist) / u.focusRange, 0.0, 1.0);
  let sharp = textureSample(colorTex, samp, uv);
  var color = vec3(0.0);
  let N = 16;
  for (var i = 0; i < N; i++) {
    let a = f32(i) * 6.28318 / f32(N);
    let r = coc * u.maxBlur * (0.5 + 0.5 * sin(a * 3.0));
    let off = vec2(cos(a), sin(a)) * r * u.texelSize;
    color += textureSample(colorTex, samp, uv + off).rgb;
  }
  let blurred = color / f32(N);
  return vec4(select(blurred, sharp.rgb, coc < 0.01), 1.0);
}
`;

// ── Sobel edge detection ────────────────────────────────────────────────────
const SOBEL_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, _p6: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv; let t = u.texelSize;
  let tl = lum(textureSample(colorTex, samp, uv + vec2(-t.x, -t.y)).rgb);
  let tm = lum(textureSample(colorTex, samp, uv + vec2(0.0, -t.y)).rgb);
  let tr = lum(textureSample(colorTex, samp, uv + vec2( t.x, -t.y)).rgb);
  let ml = lum(textureSample(colorTex, samp, uv + vec2(-t.x, 0.0)).rgb);
  let mr = lum(textureSample(colorTex, samp, uv + vec2( t.x, 0.0)).rgb);
  let bl = lum(textureSample(colorTex, samp, uv + vec2(-t.x,  t.y)).rgb);
  let bm = lum(textureSample(colorTex, samp, uv + vec2(0.0,  t.y)).rgb);
  let br = lum(textureSample(colorTex, samp, uv + vec2( t.x,  t.y)).rgb);
  let gx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
  let gy = -tl - 2.0 * tm - tr + bl + 2.0 * bm + br;
  let g = sqrt(gx * gx + gy * gy);
  let edge = clamp(g, 0.0, 1.0);
  let c = textureSample(colorTex, samp, uv);
  return vec4(c.rgb * (1.0 - edge) + vec3(edge) * 0.5, c.a);
}
`;

// ── Afterimage ──────────────────────────────────────────────────────────────
const AFTERIMAGE_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, damp: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var prevTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let cur = textureSample(colorTex, samp, input.uv);
  let prev = textureSample(prevTex, samp, input.uv);
  return mix(cur, prev, u.damp);
}
`;

// ── Bloom: bright pass ──────────────────────────────────────────────────────
const BLOOM_BRIGHT_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, threshold: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let c = textureSample(colorTex, samp, input.uv);
  let l = lum(c.rgb);
  if (l > u.threshold) { return c; }
  return vec4(0.0);
}
`;

// ── Bloom: separable blur (direction via uniform) ───────────────────────────
const BLOOM_BLUR_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, dirX: f32, dirY: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let uv = input.uv;
  let dir = vec2(u.dirX, u.dirY) * u.texelSize;
  var sum = textureSample(colorTex, samp, uv).rgb * 0.227027;
  sum += textureSample(colorTex, samp, uv + dir * 1.0).rgb * 0.1945946;
  sum += textureSample(colorTex, samp, uv - dir * 1.0).rgb * 0.1945946;
  sum += textureSample(colorTex, samp, uv + dir * 2.0).rgb * 0.1216216;
  sum += textureSample(colorTex, samp, uv - dir * 2.0).rgb * 0.1216216;
  sum += textureSample(colorTex, samp, uv + dir * 3.0).rgb * 0.0675676;
  sum += textureSample(colorTex, samp, uv - dir * 3.0).rgb * 0.0675676;
  return vec4(sum, 1.0);
}
`;

// ── Bloom: composite ────────────────────────────────────────────────────────
const BLOOM_COMPOSITE_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, strength: f32, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var brightTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let c = textureSample(colorTex, samp, input.uv);
  let b = textureSample(brightTex, samp, input.uv);
  return vec4(c.rgb + b.rgb * u.strength, c.a);
}
`;

// ── ASCII ───────────────────────────────────────────────────────────────────
const ASCII_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, cellSize: f32, useColor: f32, screenW: f32, screenH: f32, _p0: f32, _p1: f32, _p2: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var glyphTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
const NUM_GLYPHS = 10.0;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let screen = vec2(u.screenW, u.screenH);
  let cellPx = u.cellSize;
  let cellCoord = floor(input.uv * screen / cellPx);
  let cellCenter = (cellCoord + vec2(0.5)) * cellPx / screen;
  let color = textureSample(colorTex, samp, cellCenter);
  let l = lum(color.rgb);
  let charIdx = clamp(floor(l * (NUM_GLYPHS - 1.0)), 0.0, NUM_GLYPHS - 1.0);
  let local = fract(input.uv * screen / cellPx);
  let glyphUV = vec2((charIdx + local.x) / NUM_GLYPHS, local.y);
  let glyph = textureSample(glyphTex, samp, glyphUV).r;
  let outColor = mix(vec3(0.0, 1.0, 0.0), color.rgb, u.useColor);
  return vec4(outColor * glyph, 1.0);
}
`;

// ── Blit (simple copy) ──────────────────────────────────────────────────────
const BLIT_FS = /* wgsl */ `
struct U { texelSize: vec2<f32>, _p0: f32, _p1: f32, _p2: f32, _p3: f32, _p4: f32, _p5: f32, _p6: f32, };
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(colorTex, samp, input.uv);
}
`;

// ── PostProcessStack class ──────────────────────────────────────────────────

type EffectId = "fxaa" | "dof" | "sobel" | "afterimage" | "bloom" | "ascii";
const ALL_EFFECTS: EffectId[] = ["fxaa", "dof", "sobel", "afterimage", "bloom", "ascii"];
const CHAIN_ORDER: EffectId[] = ["dof", "bloom", "fxaa", "sobel", "afterimage", "ascii"];

export class PostProcessStack {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  // Pipelines
  private pipelines: Record<EffectId, GPURenderPipeline | null> = {
    fxaa: null, dof: null, sobel: null, afterimage: null, bloom: null, ascii: null,
  };
  private bloomBlurPipeline: GPURenderPipeline | null = null;
  private bloomCompositePipeline: GPURenderPipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;

  // Layouts
  private ccLayout: GPUBindGroupLayout | null = null; // color + color + sampler + uniform
  private cdLayout: GPUBindGroupLayout | null = null; // color + depth + sampler + uniform

  // Samplers
  private linearSampler: GPUSampler | null = null;
  private nearestSampler: GPUSampler | null = null;

  // Uniform buffers (one per effect)
  private uniformBuffers: Record<EffectId, GPUBuffer | null> = {
    fxaa: null, dof: null, sobel: null, afterimage: null, bloom: null, ascii: null,
  };
  private bloomBlurUniform: GPUBuffer | null = null;
  private bloomCompositeUniform: GPUBuffer | null = null;
  private blitUniform: GPUBuffer | null = null;

  // Scene render targets (full-res)
  private sceneColor: GPUTexture | null = null;
  private sceneDepth: GPUTexture | null = null;
  private texW = 0; private texH = 0;

  // Ping-pong textures for chaining
  private pingPong: [GPUTexture | null, GPUTexture | null] = [null, null];

  // Afterimage persistent
  private afterimageTex: GPUTexture | null = null;

  // Bloom half-res textures
  private bloomBright: GPUTexture | null = null;
  private bloomBlurH: GPUTexture | null = null;
  private bloomBlurV: GPUTexture | null = null;

  // Dummy 1x1 texture for unused binding slots
  private dummyTex: GPUTexture | null = null;

  // Glyph atlas for ASCII
  private glyphTex: GPUTexture | null = null;

  // Settings
  private enabled: Record<EffectId, boolean> = {
    fxaa: false, dof: false, sobel: false, afterimage: false, bloom: false, ascii: false,
  };
  private dofFocusDist = 0.5;
  private dofFocusRange = 0.3;
  private dofMaxBlur = 8.0;
  private afterimageDamp = 0.96;
  private bloomThreshold = 0.8;
  private bloomStrength = 1.0;
  private asciiCellSize = 8;
  private asciiUseColor = 1.0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    // ── Samplers ──
    this.linearSampler = this.device.createSampler({
      magFilter: "linear", minFilter: "linear",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });
    this.nearestSampler = this.device.createSampler({
      magFilter: "nearest", minFilter: "nearest",
      addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge",
    });

    // ── Bind group layouts ──
    this.ccLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.cdLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "non-filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    // ── Dummy 1x1 texture ──
    this.dummyTex = this.device.createTexture({
      size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.dummyTex },
      new Uint8Array([0, 0, 0, 255]),
      { bytesPerRow: 4, rowsPerImage: 1 },
      [1, 1],
    );

    // ── Uniform buffers ──
    for (const id of ALL_EFFECTS) {
      this.uniformBuffers[id] = this.device.createBuffer({
        size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
    }
    this.bloomBlurUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.bloomCompositeUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.blitUniform = this.device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });

    // ── Pipelines ──
    this.pipelines.fxaa = this.makePipeline(FXAA_FS, this.ccLayout!);
    this.pipelines.dof = this.makePipeline(DOF_FS, this.cdLayout!);
    this.pipelines.sobel = this.makePipeline(SOBEL_FS, this.ccLayout!);
    this.pipelines.afterimage = this.makePipeline(AFTERIMAGE_FS, this.ccLayout!);
    this.pipelines.bloom = this.makePipeline(BLOOM_BRIGHT_FS, this.ccLayout!);
    this.bloomBlurPipeline = this.makePipeline(BLOOM_BLUR_FS, this.ccLayout!);
    this.bloomCompositePipeline = this.makePipeline(BLOOM_COMPOSITE_FS, this.ccLayout!);
    this.pipelines.ascii = this.makePipeline(ASCII_FS, this.ccLayout!);
    this.blitPipeline = this.makePipeline(BLIT_FS, this.ccLayout!);

    // ── Glyph atlas ──
    this.createGlyphAtlas();
  }

  private makePipeline(fsCode: string, layout: GPUBindGroupLayout): GPURenderPipeline {
    const shader = this.device.createShaderModule({ code: VS + "\n" + fsCode });
    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
    return this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });
  }

  private createGlyphAtlas(): void {
    const chars = " .:-=+*#%@";
    const glyphW = 16, glyphH = 16;
    const cols = chars.length;
    const canvas = document.createElement("canvas");
    canvas.width = cols * glyphW;
    canvas.height = glyphH;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "white";
    ctx.font = `bold ${glyphH - 2}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 0; i < chars.length; i++) {
      ctx.fillText(chars[i], i * glyphW + glyphW / 2, glyphH / 2);
    }
    this.glyphTex = this.device.createTexture({
      size: [canvas.width, canvas.height],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });
    this.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture: this.glyphTex },
      [canvas.width, canvas.height],
    );
  }

  // ── Public API ──

  hasEnabledEffects(): boolean {
    return Object.values(this.enabled).some(v => v);
  }

  setEnabled(id: EffectId, enabled: boolean): void {
    this.enabled[id] = enabled;
  }

  setDOFFocusDist(v: number): void { this.dofFocusDist = v; }
  setDOFFocusRange(v: number): void { this.dofFocusRange = v; }
  setDOFMaxBlur(v: number): void { this.dofMaxBlur = v; }
  setAfterimageDamp(v: number): void { this.afterimageDamp = v; }
  setBloomThreshold(v: number): void { this.bloomThreshold = v; }
  setBloomStrength(v: number): void { this.bloomStrength = v; }
  setASCIICellSize(v: number): void { this.asciiCellSize = Math.max(2, Math.floor(v)); }
  setASCIIUseColor(v: boolean): void { this.asciiUseColor = v ? 1.0 : 0.0; }

  ensureTargets(w: number, h: number): void {
    if (w === this.texW && h === this.texH && this.sceneColor) return;
    this.sceneColor?.destroy();
    this.sceneDepth?.destroy();
    this.pingPong[0]?.destroy();
    this.pingPong[1]?.destroy();
    this.afterimageTex?.destroy();
    this.bloomBright?.destroy();
    this.bloomBlurH?.destroy();
    this.bloomBlurV?.destroy();

    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING
      | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    this.sceneColor = this.device.createTexture({ size: [w, h], format: this.format, usage });
    this.sceneDepth = this.device.createTexture({ size: [w, h], format: "depth32float", usage });
    this.pingPong[0] = this.device.createTexture({ size: [w, h], format: this.format, usage });
    this.pingPong[1] = this.device.createTexture({ size: [w, h], format: this.format, usage });
    this.afterimageTex = this.device.createTexture({ size: [w, h], format: this.format, usage });

    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));
    this.bloomBright = this.device.createTexture({ size: [hw, hh], format: this.format, usage });
    this.bloomBlurH = this.device.createTexture({ size: [hw, hh], format: this.format, usage });
    this.bloomBlurV = this.device.createTexture({ size: [hw, hh], format: this.format, usage });

    this.texW = w; this.texH = h;
  }

  getSceneColorView(): GPUTextureView {
    if (!this.sceneColor) throw new Error("PostProcess targets not created");
    return this.sceneColor.createView();
  }

  getSceneDepthView(): GPUTextureView {
    if (!this.sceneDepth) throw new Error("PostProcess targets not created");
    return this.sceneDepth.createView();
  }

  // ── Apply the chain ──
  applyChain(
    encoder: GPUCommandEncoder,
    depthView: GPUTextureView | null,
    canvasView: GPUTextureView,
    w: number, h: number,
  ): void {
    const active = CHAIN_ORDER.filter(id => this.enabled[id]);
    if (active.length === 0) return;

    let inputView = this.sceneColor!.createView();
    let pingIdx = 0;

    for (let i = 0; i < active.length; i++) {
      const effect = active[i];
      const isLast = i === active.length - 1;

      if (effect === "afterimage") {
        // Always render to pingPong so we can copy to persistent texture
        const outTex = this.pingPong[pingIdx]!;
        const outView = outTex.createView();
        this.applyAfterimage(encoder, inputView, outView, w, h);
        // Copy output → persistent afterimage texture for next frame
        encoder.copyTextureToTexture(
          { texture: outTex }, { texture: this.afterimageTex! }, [w, h],
        );
        if (isLast) {
          // Blit pingPong → canvas
          this.applyBlit(encoder, outView, canvasView, w, h);
        } else {
          inputView = outView;
          pingIdx = 1 - pingIdx;
        }
      } else if (effect === "bloom") {
        const outView = isLast ? canvasView : this.pingPong[pingIdx]!.createView();
        this.applyBloom(encoder, inputView, outView, w, h);
        if (!isLast) {
          inputView = this.pingPong[pingIdx]!.createView();
          pingIdx = 1 - pingIdx;
        }
      } else {
        const outView = isLast ? canvasView : this.pingPong[pingIdx]!.createView();
        this.applySimple(encoder, effect, inputView, outView, depthView, w, h);
        if (!isLast) {
          inputView = this.pingPong[pingIdx]!.createView();
          pingIdx = 1 - pingIdx;
        }
      }
    }
  }

  private writeUniform(buf: GPUBuffer, data: Float32Array): void {
    this.device.queue.writeBuffer(buf, 0, data as unknown as Float32Array<ArrayBuffer>);
  }

  private applySimple(
    encoder: GPUCommandEncoder,
    effect: EffectId,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    depthView: GPUTextureView | null,
    w: number, h: number,
  ): void {
    const pipeline = this.pipelines[effect]!;
    const buf = this.uniformBuffers[effect]!;
    const texelX = 1.0 / w, texelY = 1.0 / h;
    const useLinear = effect === "fxaa";

    const data = new Float32Array(8);
    data[0] = texelX; data[1] = texelY;
    if (effect === "dof") {
      data[2] = this.dofFocusDist; data[3] = this.dofFocusRange; data[4] = this.dofMaxBlur;
    } else if (effect === "ascii") {
      data[2] = this.asciiCellSize; data[3] = this.asciiUseColor; data[4] = w; data[5] = h;
    }
    this.writeUniform(buf, data);

    const layout = effect === "dof" ? this.cdLayout! : this.ccLayout!;
    const sampler = useLinear ? this.linearSampler! : this.nearestSampler!;

    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: inputView },
      { binding: 2, resource: sampler },
      { binding: 3, resource: { buffer: buf } },
    ];

    if (effect === "dof" && depthView) {
      entries.push({ binding: 1, resource: depthView });
    } else if (effect === "ascii") {
      entries.push({ binding: 1, resource: this.glyphTex!.createView() });
    } else {
      entries.push({ binding: 1, resource: this.dummyTex!.createView() });
    }

    const bg = this.device.createBindGroup({ layout, entries });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp,
        storeOp: "store" as GPUStoreOp,
      }],
    });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setScissorRect(0, 0, w, h);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private applyBloom(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const hw = Math.max(1, Math.floor(w / 2));
    const hh = Math.max(1, Math.floor(h / 2));

    // Pass 1: Bright extract (full-res → half-res)
    const brightData = new Float32Array(8);
    brightData[0] = 1.0 / w; brightData[1] = 1.0 / h; brightData[2] = this.bloomThreshold;
    this.writeUniform(this.uniformBuffers.bloom!, brightData);

    const brightBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.uniformBuffers.bloom! } },
      ],
    });
    const pass1 = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomBright!.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass1.setViewport(0, 0, hw, hh, 0, 1);
    pass1.setPipeline(this.pipelines.bloom!);
    pass1.setBindGroup(0, brightBg);
    pass1.draw(3);
    pass1.end();

    // Pass 2: Horizontal blur (half-res → half-res)
    const blurHData = new Float32Array(8);
    blurHData[0] = 1.0 / hw; blurHData[1] = 1.0 / hh; blurHData[2] = 1.0; blurHData[3] = 0.0;
    this.writeUniform(this.bloomBlurUniform!, blurHData);

    const blurHBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: this.bloomBright!.createView() },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.bloomBlurUniform! } },
      ],
    });
    const pass2 = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomBlurH!.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass2.setViewport(0, 0, hw, hh, 0, 1);
    pass2.setPipeline(this.bloomBlurPipeline!);
    pass2.setBindGroup(0, blurHBg);
    pass2.draw(3);
    pass2.end();

    // Pass 3: Vertical blur (half-res → half-res)
    const blurVData = new Float32Array(8);
    blurVData[0] = 1.0 / hw; blurVData[1] = 1.0 / hh; blurVData[2] = 0.0; blurVData[3] = 1.0;
    this.writeUniform(this.bloomBlurUniform!, blurVData);

    const blurVBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: this.bloomBlurH!.createView() },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.bloomBlurUniform! } },
      ],
    });
    const pass3 = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.bloomBlurV!.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass3.setViewport(0, 0, hw, hh, 0, 1);
    pass3.setPipeline(this.bloomBlurPipeline!);
    pass3.setBindGroup(0, blurVBg);
    pass3.draw(3);
    pass3.end();

    // Pass 4: Composite (original + blurred → output)
    const compData = new Float32Array(8);
    compData[0] = 1.0 / w; compData[1] = 1.0 / h; compData[2] = this.bloomStrength;
    this.writeUniform(this.bloomCompositeUniform!, compData);

    const compBg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.bloomBlurV!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.bloomCompositeUniform! } },
      ],
    });
    const pass4 = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass4.setViewport(0, 0, w, h, 0, 1);
    pass4.setPipeline(this.bloomCompositePipeline!);
    pass4.setBindGroup(0, compBg);
    pass4.draw(3);
    pass4.end();
  }

  private applyAfterimage(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const data = new Float32Array(8);
    data[0] = 1.0 / w; data[1] = 1.0 / h; data[2] = this.afterimageDamp;
    this.writeUniform(this.uniformBuffers.afterimage!, data);

    const bg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.afterimageTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.uniformBuffers.afterimage! } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setPipeline(this.pipelines.afterimage!);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  private applyBlit(
    encoder: GPUCommandEncoder,
    inputView: GPUTextureView,
    outputView: GPUTextureView,
    w: number, h: number,
  ): void {
    const data = new Float32Array(8);
    data[0] = 1.0 / w; data[1] = 1.0 / h;
    this.writeUniform(this.blitUniform!, data);

    const bg = this.device.createBindGroup({
      layout: this.ccLayout!,
      entries: [
        { binding: 0, resource: inputView },
        { binding: 1, resource: this.dummyTex!.createView() },
        { binding: 2, resource: this.linearSampler! },
        { binding: 3, resource: { buffer: this.blitUniform! } },
      ],
    });
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: outputView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear" as GPULoadOp, storeOp: "store" as GPUStoreOp,
      }],
    });
    pass.setViewport(0, 0, w, h, 0, 1);
    pass.setPipeline(this.blitPipeline!);
    pass.setBindGroup(0, bg);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.sceneColor?.destroy();
    this.sceneDepth?.destroy();
    this.pingPong[0]?.destroy();
    this.pingPong[1]?.destroy();
    this.afterimageTex?.destroy();
    this.bloomBright?.destroy();
    this.bloomBlurH?.destroy();
    this.bloomBlurV?.destroy();
    this.dummyTex?.destroy();
    this.glyphTex?.destroy();
    for (const id of ALL_EFFECTS) {
      this.uniformBuffers[id]?.destroy();
    }
    this.bloomBlurUniform?.destroy();
    this.bloomCompositeUniform?.destroy();
    this.blitUniform?.destroy();
  }
}
