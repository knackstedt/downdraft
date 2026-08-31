// ============================================================================
// ASCII System — renders the scene as ASCII characters
//
// Samples the scene color at each grid cell, computes luminance, maps it to
// a glyph from a 10-character atlas (" .:-=+*#%@"), and renders the glyph.
// Optionally preserves the original color (vs. classic green terminal).
//
// Usage:
//   const ascii = new AsciiSystem(device, format);
//   ascii.init();
//   ascii.setEnabled(true);
//   ascii.setCellSize(8);
//   ascii.setUseColor(false);
//   // Each frame:
//   ascii.ensureTargets(w, h);
//   // ... render scene into ascii.getSceneColorView() ...
//   ascii.apply(encoder, canvasView, w, h);
// ============================================================================

const FULLSCREEN_VS = /* wgsl */ `
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

const BLIT_FS = /* wgsl */ `
@group(0) @binding(0) var colorTex: texture_2d<f32>;
@group(0) @binding(1) var dummyTex: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> u: U;
struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(colorTex, samp, input.uv);
}
`;

export class AsciiSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;

  private pipeline: GPURenderPipeline | null = null;
  private blitPipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private sampler: GPUSampler | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private glyphTex: GPUTexture | null = null;

  private sceneColor: GPUTexture | null = null;
  private width = 0;
  private height = 0;
  private bindGroup: GPUBindGroup | null = null;

  private cellSize = 8;
  private useColor = false;
  private enabled = false;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    this.sampler = this.device.createSampler({
      magFilter: "nearest",
      minFilter: "nearest",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Uniforms: texelSize (vec2) + cellSize (f32) + useColor (f32) + screenW (f32) + screenH (f32) = 20 bytes, padded to 32.
    this.uniformBuffer = this.device.createBuffer({
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    const asciiShader = this.device.createShaderModule({ code: FULLSCREEN_VS + "\n" + ASCII_FS });
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: asciiShader, entryPoint: "vs_main" },
      fragment: { module: asciiShader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });

    const blitShader = this.device.createShaderModule({ code: FULLSCREEN_VS + "\n" + BLIT_FS });
    this.blitPipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: blitShader, entryPoint: "vs_main" },
      fragment: { module: blitShader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
    });

    this.createGlyphAtlas();
  }

  /** Creates the 10-glyph atlas: " .:-=+*#%@" rendered as a 160×16 texture. */
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

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setCellSize(size: number): void {
    this.cellSize = Math.max(2, Math.floor(size));
  }

  getCellSize(): number {
    return this.cellSize;
  }

  setUseColor(useColor: boolean): void {
    this.useColor = useColor;
  }

  getUseColor(): boolean {
    return this.useColor;
  }

  /** Ensures the offscreen scene color texture matches the canvas size. */
  ensureTargets(canvasWidth: number, canvasHeight: number): void {
    if (canvasWidth === this.width && canvasHeight === this.height && this.sceneColor) return;

    this.sceneColor?.destroy();

    this.sceneColor = this.device.createTexture({
      size: [canvasWidth, canvasHeight, 1],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.width = canvasWidth;
    this.height = canvasHeight;

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout!,
      entries: [
        { binding: 0, resource: this.sceneColor.createView() },
        { binding: 1, resource: this.glyphTex!.createView() },
        { binding: 2, resource: this.sampler! },
        { binding: 3, resource: { buffer: this.uniformBuffer! } },
      ],
    });
  }

  /** The offscreen color texture view the game should render the scene into. */
  getSceneColorView(): GPUTextureView {
    if (!this.sceneColor) throw new Error("AsciiSystem: targets not created. Call ensureTargets() first.");
    return this.sceneColor.createView();
  }

  /**
   * Applies the ASCII effect and outputs to `canvasView`.
   * When disabled, performs a blit pass that copies the scene to the canvas.
   */
  apply(encoder: GPUCommandEncoder, canvasView: GPUTextureView, canvasWidth: number, canvasHeight: number): void {
    const data = new Float32Array(12);
    data[0] = 1.0 / canvasWidth;
    data[1] = 1.0 / canvasHeight;
    data[2] = this.cellSize;
    data[3] = this.useColor ? 1.0 : 0.0;
    data[4] = canvasWidth;
    data[5] = canvasHeight;
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, data as unknown as GPUAllowSharedBufferSource);

    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: canvasView,
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    pass.setViewport(0, 0, canvasWidth, canvasHeight, 0, 1);
    pass.setScissorRect(0, 0, canvasWidth, canvasHeight);
    pass.setPipeline(this.enabled ? this.pipeline! : this.blitPipeline!);
    pass.setBindGroup(0, this.bindGroup!);
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    this.sceneColor?.destroy();
    this.glyphTex?.destroy();
    this.uniformBuffer?.destroy();
    this.pipeline?.destroy();
    this.blitPipeline?.destroy();
    this.sceneColor = null;
    this.glyphTex = null;
    this.uniformBuffer = null;
    this.pipeline = null;
    this.blitPipeline = null;
    this.bindGroupLayout = null;
    this.bindGroup = null;
    this.sampler = null;
  }
}
