// ============================================================================
// DropPass — renders world drop items as 2D spinning quads
//
// Each drop is a small flat quad (0.4×0.4 blocks) that spins around the
// vertical (Y) axis. The quad is positioned at the drop's active-grid
// coordinates and rendered through the same 3D view-projection matrix as
// the block grid, so it stays aligned with the world at any camera angle.
//
// The spin creates a pseudo-3D "billboard" effect: as the quad rotates, it
// narrows and widens, mimicking a spinning item. The fragment shader draws
// a simple colored square with a subtle border so the item is visible at
// any rotation angle.
// ============================================================================

import { getDropColor } from "../shared/drop-registry";
import { type Mat4 } from "./matrix";

const DROP_WGSL = `
struct Uniforms {
  viewProj : mat4x4f,
  canvasW : f32,
  canvasH : f32,
  dropCount : f32,
  _pad : f32,
};

struct Drop {
  x : f32,
  y : f32,
  _vx : f32,
  _vy : f32,
  spin : f32,
  _spinSpeed : f32,
  itemCode : f32,
  _lifetime : f32,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> drops : array<Drop>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
  @location(1) edgeDist : f32,
};

// Quad corners (unit square 0..1, centered at 0.5)
// Triangle strip: bottom-left, bottom-right, top-left, top-right
const QUAD_SIZE = 0.4; // blocks

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  let drop = drops[ii];
  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5),  // bottom-left
    vec2f( 0.5, -0.5),  // bottom-right
    vec2f(-0.5,  0.5),  // top-left
    vec2f( 0.5,  0.5),  // top-right
  );
  let c = corners[vi];

  // Spin: rotate the quad around the Y axis. In a 2.5D top-down perspective,
  // this means scaling the X dimension by cos(spin) to simulate rotation.
  let cosA = cos(drop.spin);
  let rotX = c.x * cosA;

  // Position the quad at the drop's location, centered on the cell
  let worldX = drop.x + rotX * QUAD_SIZE;
  let worldY = drop.y + c.y * QUAD_SIZE;
  // Place at Z=-0.5 (between foreground and background, in front of layer 3)
  let worldZ = -0.5;

  var out : VsOut;
  out.pos = uniforms.viewProj * vec4f(worldX, worldY, worldZ, 1.0);
  // Pass color based on item code (looked up on CPU side and packed)
  // We encode color in the drop's itemCode as an index into a color table
  // on the CPU. Here we just pass a placeholder; the actual color is set
  // via a per-instance color buffer. But to keep it simple, we pass the
  // item code and look up color in the fragment shader via a color array.
  out.color = vec3f(1.0, 1.0, 1.0); // placeholder, overridden by instance color
  // Edge distance for border effect (0 = center, 1 = edge)
  out.edgeDist = max(abs(c.x), abs(c.y)) * 2.0;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  // Simple solid color with a subtle border darkening
  let border = smoothstep(0.85, 1.0, in.edgeDist);
  let col = in.color * (1.0 - border * 0.4);
  return vec4f(col, 1.0);
}
`;

// We need per-instance colors. Instead of a separate buffer, we'll use a
// combined storage buffer that includes color data alongside position data.
// To keep the SAB layout simple, the renderer reads drop data from the SAB
// and builds a combined buffer here with colors resolved from the drop registry.

const DROP_WGSL_COLORED = `
struct Uniforms {
  viewProj : mat4x4f,
  canvasW : f32,
  canvasH : f32,
  dropCount : f32,
  _pad : f32,
};

struct DropInstance {
  x : f32,
  y : f32,
  spin : f32,
  r : f32,
  g : f32,
  b : f32,
  _pad1 : f32,
  _pad2 : f32,
};

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> drops : array<DropInstance>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
  @location(1) edgeDist : f32,
};

const QUAD_SIZE = 0.4;

@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  let drop = drops[ii];
  let corners = array<vec2f, 4>(
    vec2f(-0.5, -0.5),
    vec2f( 0.5, -0.5),
    vec2f(-0.5,  0.5),
    vec2f( 0.5,  0.5),
  );
  let c = corners[vi];

  // Spin: scale X by cos(spin) to simulate Y-axis rotation
  let cosA = cos(drop.spin);
  let rotX = c.x * cosA;

  let worldX = drop.x + rotX * QUAD_SIZE;
  let worldY = drop.y + c.y * QUAD_SIZE;
  let worldZ = -0.5;

  var out : VsOut;
  out.pos = uniforms.viewProj * vec4f(worldX, worldY, worldZ, 1.0);
  out.color = vec3f(drop.r, drop.g, drop.b);
  out.edgeDist = max(abs(c.x), abs(c.y)) * 2.0;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  let border = smoothstep(0.85, 1.0, in.edgeDist);
  let col = in.color * (1.0 - border * 0.4);
  return vec4f(col, 1.0);
}
`;

const MAX_DROP_INSTANCES = 128;
// Per instance: x, y, spin, r, g, b, pad, pad = 8 floats
const DROP_INSTANCE_STRIDE = 8;

export interface DropRenderData {
  x: number;
  y: number;
  spin: number;
  itemCode: number;
}

export class DropPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private dropCount = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shader = this.device.createShaderModule({ code: DROP_WGSL_COLORED });

    // Uniform buffer: mat4x4 (64 bytes) + 4 floats (16 bytes) = 80 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Instance storage buffer
    this.instanceBuffer = this.device.createBuffer({
      size: MAX_DROP_INSTANCES * DROP_INSTANCE_STRIDE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: { buffer: this.instanceBuffer } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: { module: shader, entryPoint: "vs_main" },
      fragment: {
        module: shader,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-strip" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always", // drops always render on top
      },
    });
  }

  update(viewProj: Mat4, canvasW: number, canvasH: number, dropData: DropRenderData[]): void {
    if (!this.uniformBuffer || !this.instanceBuffer) return;

    // Write uniforms
    const u = new Float32Array(20); // 16 (mat4) + 4
    u.set(viewProj, 0);
    u[16] = canvasW;
    u[17] = canvasH;
    u[18] = Math.min(dropData.length, MAX_DROP_INSTANCES);
    u[19] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // Build instance data with resolved colors
    const count = Math.min(dropData.length, MAX_DROP_INSTANCES);
    const data = new Float32Array(MAX_DROP_INSTANCES * DROP_INSTANCE_STRIDE);
    for (let i = 0; i < count; i++) {
      const d = dropData[i];
      const color = getDropColor(d.itemCode);
      const off = i * DROP_INSTANCE_STRIDE;
      data[off + 0] = d.x;
      data[off + 1] = d.y;
      data[off + 2] = d.spin;
      // Normalize color to 0..1
      data[off + 3] = color[0] / 255;
      data[off + 4] = color[1] / 255;
      data[off + 5] = color[2] / 255;
      data[off + 6] = 0;
      data[off + 7] = 0;
    }
    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
    this.dropCount = count;
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || this.dropCount === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(4, this.dropCount); // 4 verts per quad, N instances
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.instanceBuffer?.destroy();
  }
}
