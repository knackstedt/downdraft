// ============================================================================
// StickmanPass — renders the blockhead as a 1×2×1 3D box
//
// The blockhead hitbox is 1 block wide × 2 blocks tall × 1 block deep.
// We render a 3D box at the blockhead's world position, transformed by the
// 3D view-projection matrix. This matches the block rendering perspective,
// so the player visually appears 2 blocks tall (not 4, as a flat rectangle
// would look due to the missing top-face perspective).
// ============================================================================

import { DEPTH_FORMAT } from "@downdraft/core";

import { type Mat4 } from "./matrix";

// Uniform layout (must match the WGSL below):
//   viewProj: mat4x4           -> 64 bytes
//   color:    vec4             -> 16 bytes
// Total = 80 bytes = 20 float32s.
const UNIFORM_SIZE = 80;
const UNIFORM_FLOATS = 20;

const BOX_WGSL = /* wgsl */ `
struct BoxUniforms {
  viewProj: mat4x4<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> u: BoxUniforms;

struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(@location(0) worldPos: vec3<f32>) -> VSOut {
  var out: VSOut;
  out.pos = u.viewProj * vec4<f32>(worldPos, 1.0);
  out.color = u.color;
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4<f32> {
  return in.color;
}
`;

// Box geometry: 8 corners, 12 triangles (36 vertices, no index buffer)
// Corners of a unit box (0..1 in X, 0..1 in Y, 0..1 in Z):
//   0: (0,0,0)  1: (1,0,0)  2: (1,1,0)  3: (0,1,0)  -- back face (Z=0)
//   4: (0,0,1)  5: (1,0,1)  6: (1,1,1)  7: (0,1,1)  -- front face (Z=1)
// World Y goes down, so Y=0 is top, Y=1 is bottom.
const BOX_VERTS = new Float32Array(36 * 3); // 12 triangles × 3 verts × 3 floats
{
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], // back (Z=0)
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1], // front (Z=1)
  ];
  // 12 triangles (6 faces × 2 each)
  const tris = [
    // Front (Z=1): 4,5,6, 4,6,7
    [4, 5, 6], [4, 6, 7],
    // Back (Z=0): 1,0,3, 1,3,2
    [1, 0, 3], [1, 3, 2],
    // Top (Y=0): 0,1,5, 0,5,4
    [0, 1, 5], [0, 5, 4],
    // Bottom (Y=1): 3,7,6, 3,6,2
    [3, 7, 6], [3, 6, 2],
    // Right (X=1): 1,2,6, 1,6,5
    [1, 2, 6], [1, 6, 5],
    // Left (X=0): 0,4,7, 0,7,3
    [0, 4, 7], [0, 7, 3],
  ];
  let i = 0;
  for (const tri of tris) {
    for (const idx of tri) {
      BOX_VERTS[i++] = c[idx][0];
      BOX_VERTS[i++] = c[idx][1];
      BOX_VERTS[i++] = c[idx][2];
    }
  }
}

export class StickmanPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  // Preallocated uniform + vertex arrays (avoid per-frame allocation)
  private _uniform: Float32Array<ArrayBuffer> = new Float32Array(UNIFORM_FLOATS);
  private _verts: Float32Array<ArrayBuffer> = new Float32Array(36 * 3);

  constructor(device: GPUDevice, format: GPUTextureFormat, depthFormat: GPUTextureFormat = DEPTH_FORMAT) {
    this.device = device;
    this.format = format;
    this.depthFormat = depthFormat;
  }

  init(): void {
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // 36 vertices (12 triangles), each vec3 = 12 bytes
    this.vertexBuffer = this.device.createBuffer({
      size: 36 * 12,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    const shader = this.device.createShaderModule({ code: BOX_WGSL });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 12, // vec3
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: shader, entryPoint: "fs_main", targets: [{ format: this.format }] },
      primitive: { topology: "triangle-list", cullMode: "back" },
      depthStencil: {
        format: this.depthFormat,
        depthWriteEnabled: false,
        depthCompare: "always", // render on top of blocks
      },
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
      ],
    });
  }

  /**
   * 2D update (legacy orthographic — not used in 3D mode but kept for compat).
   */
  update(
    px: number, py: number, _facing: number, _animFrame: number,
    camX: number, camY: number, zoom: number,
    canvasW: number, canvasH: number,
    health: number, _onGround: boolean, _vx: number,
  ): void {
    if (!this.vertexBuffer || !this.uniformBuffer) return;

    // Build box vertices at (px, py) with size 1×2×1 (reuse preallocated buffer)
    const verts = this._verts;
    for (let i = 0; i < 36; i++) {
      verts[i * 3]     = px + BOX_VERTS[i * 3];        // X: px + localX
      verts[i * 3 + 1] = py + BOX_VERTS[i * 3 + 1] * 2; // Y: py + localY * 2 (2 tall)
      verts[i * 3 + 2] = BOX_VERTS[i * 3 + 2];          // Z: localZ
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, verts as unknown as BufferSource);

    // Simple orthographic transform
    const scaleX = (zoom * 2) / canvasW;
    const scaleY = (-zoom * 2) / canvasH;
    const offsetX = -camX * scaleX;
    const offsetY = -camY * scaleY;

    const viewProj = new Float32Array(16);
    viewProj[0] = scaleX;  viewProj[5] = scaleY; viewProj[10] = 1;
    viewProj[12] = offsetX; viewProj[13] = offsetY; viewProj[15] = 1;

    this.writeUniforms(viewProj, health);
  }

  /**
   * 3D version: render the box through the 3D view-projection matrix.
   * The box is BH_W wide × BH_H tall × 1 deep, positioned at (px, py).
   * The box is placed at layer 2 (Z=-1..0) so the player appears between
   * the two foreground layers (layer 1 at Z=0, layer 2 at Z=-1).
   */
  update3D(
    px: number, py: number, _facing: number, _animFrame: number,
    viewProj: Mat4, _canvasW: number, _canvasH: number,
    health: number, _onGround: boolean, _vx: number,
    _zDepth: number = -1.0,
  ): void {
    if (!this.vertexBuffer || !this.uniformBuffer) return;

    // Build box vertices at (px, py) with size BH_W × BH_H × 1 (reuse preallocated buffer).
    // The visual box matches the collision AABB exactly: [px, px+BH_W] × [py, py+BH_H].
    // No centering offset — the collision box starts at bh.x (left-aligned).
    const PLAYER_W = 0.7;
    const PLAYER_H = 1.95;
    const verts = this._verts;
    for (let i = 0; i < 36; i++) {
      verts[i * 3]     = px + BOX_VERTS[i * 3] * PLAYER_W;             // X: left-aligned with collision
      verts[i * 3 + 1] = py + BOX_VERTS[i * 3 + 1] * PLAYER_H;         // Y: scaled to height
      verts[i * 3 + 2] = BOX_VERTS[i * 3 + 2] - 1.0;                   // Z: localZ - 1 (−1..0, layer 2)
    }
    this.device.queue.writeBuffer(this.vertexBuffer, 0, verts as unknown as BufferSource);

    this.writeUniforms(viewProj, health);
  }

  private writeUniforms(viewProj: Mat4, health: number): void {
    if (!this.uniformBuffer) return;

    // Health-tinted color: red -> yellow -> green
    const hp = Math.max(0, Math.min(1, health / 100));
    let r: number, g: number, b: number;
    if (hp > 0.5) {
      const t = (hp - 0.5) * 2;
      r = 1.0 - t;
      g = 0.85 + (1.0 - 0.85) * t;
      b = 0.2 * t;
    } else {
      const t = hp * 2;
      r = 1.0;
      g = 0.85 * t;
      b = 0.0;
    }

    const data = this._uniform;
    // viewProj (column-major, 16 floats)
    for (let i = 0; i < 16; i++) data[i] = viewProj[i];
    // color (vec4)
    data[16] = r;
    data[17] = g;
    data[18] = b;
    data[19] = 1.0; // alpha
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || !this.vertexBuffer) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.setVertexBuffer(0, this.vertexBuffer);
    pass.draw(36); // 12 triangles
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
  }
}
