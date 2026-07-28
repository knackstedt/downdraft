// ============================================================================
// Terrain System — seabed, islands, ports rendering
// ============================================================================

import { CameraState } from "./CameraSystem";
import { calculateViewProj } from "./mathUtils";

const TERRAIN_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  cameraPos: vec3<f32>,
  time: f32,
  patchSize: f32,
  originX: f32,
  originZ: f32,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexInput {
  @location(0) position: vec2<f32>,
};

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) worldPos: vec3<f32>,
  @location(1) depth: f32,
};

fn hash(p: vec2<f32>) -> f32 {
  return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn noise(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash(i);
  let b = hash(i + vec2<f32>(1.0, 0.0));
  let c = hash(i + vec2<f32>(0.0, 1.0));
  let d = hash(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn terrainHeight(x: f32, z: f32) -> f32 {
  let p = vec2<f32>(x * 0.01, z * 0.01);
  var h = 0.0;
  h += noise(p) * 40.0;
  h += noise(p * 2.0) * 20.0;
  h += noise(p * 4.0) * 10.0;
  h += noise(p * 8.0) * 5.0;
  return -h - 10.0; // below sea level
}

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
  var output: VertexOutput;
  let worldX = uniforms.originX + input.position.x * 4.0;
  let worldZ = uniforms.originZ + input.position.y * 4.0;
  let h = terrainHeight(worldX, worldZ);
  let worldPos = vec3<f32>(worldX, h, worldZ);
  output.worldPos = worldPos;
  output.depth = -h;
  output.clipPos = uniforms.viewProj * vec4<f32>(worldPos, 1.0);
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let depth = input.depth;

  // Color based on depth
  let shallowColor = vec3<f32>(0.6, 0.5, 0.3);   // sandy
  let midColor = vec3<f32>(0.3, 0.3, 0.2);        // rocky
  let deepColor = vec3<f32>(0.1, 0.1, 0.05);      // dark seabed

  var color = mix(shallowColor, midColor, smoothstep(10.0, 50.0, depth));
  color = mix(color, deepColor, smoothstep(50.0, 200.0, depth));

  // Distance fog
  let dist = length(uniforms.cameraPos - input.worldPos);
  let fogFactor = min(dist / 500.0, 1.0);
  color = mix(color, vec3<f32>(0.0, 0.1, 0.2), fogFactor);

  return vec4<f32>(color, 1.0);
}
`;

export class TerrainSystem {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private indexBuffer: GPUBuffer | null = null;
  private indexCount = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
    const shaderModule = this.device.createShaderModule({ code: TERRAIN_WGSL });

    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Generate terrain grid (128x128)
    const gridSize = 128;
    const vertices: number[] = [];
    for (let z = 0; z <= gridSize; z++) {
      for (let x = 0; x <= gridSize; x++) {
        vertices.push(x, z);
      }
    }
    this.vertexBuffer = this.device.createBuffer({
      size: vertices.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(vertices));

    // Generate indices
    const indices: number[] = [];
    for (let z = 0; z < gridSize; z++) {
      for (let x = 0; x < gridSize; x++) {
        const i = z * (gridSize + 1) + x;
        indices.push(i, i + 1, i + gridSize + 1);
        indices.push(i + 1, i + gridSize + 2, i + gridSize + 1);
      }
    }
    this.indexCount = indices.length;
    this.indexBuffer = this.device.createBuffer({
      size: indices.length * 2,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.indexBuffer, 0, new Uint16Array(indices));

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
        buffers: [{
          arrayStride: 8,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: 4 },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  render(
    passEncoder: GPURenderPassEncoder,
    camera: CameraState,
    playerPos: { x: number; y: number; z: number },
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer) return;

    const viewProj = calculateViewProj(camera);

    const uniforms = new Float32Array(16 + 8);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    uniforms[16] = camera.position[0];
    uniforms[17] = camera.position[1];
    uniforms[18] = camera.position[2];
    uniforms[19] = performance.now() / 1000;
    uniforms[20] = 512; // patch size
    // Snap origin to vertex spacing (4.0) so grid vertices always sample
    // the same world positions, preventing terrain from boiling/flickering
    const spacing = 4.0;
    uniforms[21] = Math.round((playerPos.x - 256) / spacing) * spacing;
    uniforms[22] = Math.round((playerPos.z - 256) / spacing) * spacing;

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setIndexBuffer(this.indexBuffer!, "uint16");
    passEncoder.drawIndexed(this.indexCount);
  }

}
