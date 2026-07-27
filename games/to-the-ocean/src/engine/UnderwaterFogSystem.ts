// ============================================================================
// Underwater Fog System — fullscreen fog overlay when camera is below water
// ============================================================================

const FOG_WGSL = /* wgsl */ `
struct Uniforms {
  depth: f32,
  time: f32,
  _pad0: f32,
  _pad1: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VertexOutput {
  var output: VertexOutput;
  let positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 3.0, -1.0),
    vec2<f32>(-1.0,  3.0),
  );
  let pos = positions[vi];
  output.clipPos = vec4<f32>(pos, 0.0, 1.0);
  output.uv = pos * 0.5 + 0.5;
  return output;
}

fn hash2d(p: vec2<f32>) -> vec2<f32> {
  let k = vec2<f32>(0.3183099, 0.3678794);
  let q = fract(p * k);
  return -1.0 + 2.0 * fract(vec2<f32>(
    dot(q, vec2<f32>(127.1, 311.7)),
    dot(q, vec2<f32>(269.5, 183.3))
  ) * 43758.5453);
}

fn perlin2d(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  let ga = hash2d(i);
  let gb = hash2d(i + vec2<f32>(1.0, 0.0));
  let gc = hash2d(i + vec2<f32>(0.0, 1.0));
  let gd = hash2d(i + vec2<f32>(1.0, 1.0));

  let va = dot(ga, f);
  let vb = dot(gb, f - vec2<f32>(1.0, 0.0));
  let vc = dot(gc, f - vec2<f32>(0.0, 1.0));
  let vd = dot(gd, f - vec2<f32>(1.0, 1.0));

  return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y) * 0.5 + 0.5;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let depth = max(uniforms.depth, 0.3);
  let fogIntensity = 1.0 - exp(-depth * 0.8);

  // Animated caustic-like pattern
  let causticUV = input.uv * 6.0 + vec2<f32>(uniforms.time * 0.25, uniforms.time * 0.18);
  let n1 = perlin2d(causticUV);
  let n2 = perlin2d(causticUV * 2.0 + 10.0);
  let n3 = perlin2d(causticUV * 4.0 + 20.0);
  let caustic = (n1 * 0.5 + n2 * 0.3 + n3 * 0.2);

  // Underwater fog color — deep blue-green, gets darker with depth
  var fogColor = vec3<f32>(0.05, 0.25, 0.35);
  fogColor = fogColor + vec3<f32>(0.0, 0.06, 0.08) * caustic;

  // Deeper = darker and more blue
  fogColor = mix(fogColor, vec3<f32>(0.0, 0.08, 0.15), min(depth * 0.04, 0.7));

  // Stronger alpha — ensure visible even at shallow depths
  let alpha = clamp(fogIntensity * 1.5, 0.4, 0.95);
  return vec4<f32>(fogColor, alpha);
}
`;

export class UnderwaterFogSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shaderModule = this.device.createShaderModule({ code: FOG_WGSL });

    this.uniformBuffer = this.device.createBuffer({
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });
  }

  render(
    passEncoder: GPURenderPassEncoder,
    depth: number,
    time: number,
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer) return;

    const uniforms = new Float32Array(4);
    uniforms[0] = depth;
    uniforms[1] = time;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.draw(3);
  }
}
