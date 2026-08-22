// ============================================================================
// SkyPass — renders a gradient sky background behind the block grid.
//
// The sky is a full-screen quad with a vertical gradient from horizon to
// zenith. The gradient changes based on the time of day (daylight level).
// At night the sky is dark blue; at day it's light blue; at dawn/dusk it's
// orange/pink.
// ============================================================================

const SKY_WGSL = /* wgsl */ `
struct SkyUniforms {
  // Gradient colors (linear RGB, 0-1)
  topColor: vec4f,     // zenith color
  bottomColor: vec4f,  // horizon color
  // Screen dimensions
  screenSize: vec2f,
  _pad: vec2f,
};

@group(0) @binding(0) var<uniform> u: SkyUniforms;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  // Full-screen triangle: 3 vertices covering the screen
  var pos = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  return vec4f(pos[vi], 0.0, 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let t = clamp(fragCoord.y / u.screenSize.y, 0.0, 1.0);
  // Mix from bottom (horizon) to top (zenith)
  let color = mix(u.bottomColor, u.topColor, t);
  return vec4f(color.rgb, 1.0);
}
`;

const UNIFORM_SIZE = 48; // 2 vec4s + 1 vec4 (screenSize + pad)

export class SkyPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat = "depth24plus") {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shader = this.device.createShaderModule({ code: SKY_WGSL });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,  // sky doesn't write depth (renders behind everything)
        depthCompare: "always",    // always passes (renders first)
      },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  /** Update sky colors based on daylight level (0=night, 15=full day). */
  update(canvasW: number, canvasH: number, daylight: number): void {
    if (!this.uniformBuffer) return;

    // Daylight: 0 (midnight) to 15 (noon)
    const t = daylight / 15; // 0 to 1

    // Day colors
    const dayTop = [0.3, 0.6, 0.95];     // light blue
    const dayBottom = [0.6, 0.8, 1.0];   // pale blue (horizon)

    // Night colors
    const nightTop = [0.02, 0.02, 0.08];    // deep dark blue
    const nightBottom = [0.05, 0.05, 0.12]; // slightly lighter dark blue

    // Dawn/dusk colors (at t~0.3-0.5)
    const duskTop = [0.15, 0.1, 0.3];       // purple
    const duskBottom = [0.8, 0.4, 0.2];     // orange

    // Blend between night, dusk, and day based on t
    let topR: number, topG: number, topB: number;
    let botR: number, botG: number, botB: number;

    if (t < 0.3) {
      // Night to dusk
      const s = t / 0.3;
      topR = nightTop[0] + (duskTop[0] - nightTop[0]) * s;
      topG = nightTop[1] + (duskTop[1] - nightTop[1]) * s;
      topB = nightTop[2] + (duskTop[2] - nightTop[2]) * s;
      botR = nightBottom[0] + (duskBottom[0] - nightBottom[0]) * s;
      botG = nightBottom[1] + (duskBottom[1] - nightBottom[1]) * s;
      botB = nightBottom[2] + (duskBottom[2] - nightBottom[2]) * s;
    } else if (t < 0.6) {
      // Dusk to day
      const s = (t - 0.3) / 0.3;
      topR = duskTop[0] + (dayTop[0] - duskTop[0]) * s;
      topG = duskTop[1] + (dayTop[1] - duskTop[1]) * s;
      topB = duskTop[2] + (dayTop[2] - duskTop[2]) * s;
      botR = duskBottom[0] + (dayBottom[0] - duskBottom[0]) * s;
      botG = duskBottom[1] + (dayBottom[1] - duskBottom[1]) * s;
      botB = duskBottom[2] + (dayBottom[2] - duskBottom[2]) * s;
    } else {
      // Full day
      topR = dayTop[0];
      topG = dayTop[1];
      topB = dayTop[2];
      botR = dayBottom[0];
      botG = dayBottom[1];
      botB = dayBottom[2];
    }

    const data = new Float32Array(12);
    data[0] = topR;
    data[1] = topG;
    data[2] = topB;
    data[3] = 1.0;
    data[4] = botR;
    data[5] = botG;
    data[6] = botB;
    data[7] = 1.0;
    data[8] = canvasW;
    data[9] = canvasH;
    data[10] = 0;
    data[11] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
  }
}
