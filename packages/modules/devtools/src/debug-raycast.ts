// ============================================================================
// DebugRaycast — 3D aim ray visualization with entity highlighting
// Generic GPU rendering logic; game provides raycast results via IRaycastProvider.
// ============================================================================

import { calculateViewProj, createValidatedShaderModule, DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "@downdraft/core";
import type { IRaycastProvider, IRaycastResult } from "./types";

const RAY_MAX_DIST = 60;
const RAY_THICKNESS = 0.06;

const DEBUG_RAY_WGSL = /* wgsl */ `
struct DebugRayUniforms {
  viewProj: mat4x4<f32>,
  color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: DebugRayUniforms;

struct VSIn {
  @location(0) position: vec3<f32>,
};

struct VSOut {
  @builtin(position) clipPos: vec4<f32>,
};

@vertex
fn vs_main(input: VSIn) -> VSOut {
  var out: VSOut;
  out.clipPos = uniforms.viewProj * vec4<f32>(input.position, 1.0);
  return out;
}

@fragment
fn fs_main(input: VSOut) -> @location(0) vec4<f32> {
  return uniforms.color;
}
`;

const CUBE_EDGE_VERTS = new Float32Array([
  -1, -1, -1,  1, -1, -1,
   1, -1, -1,  1, -1,  1,
   1, -1,  1, -1, -1,  1,
  -1, -1,  1, -1, -1, -1,
  -1,  1, -1,  1,  1, -1,
   1,  1, -1,  1,  1,  1,
   1,  1,  1, -1,  1,  1,
  -1,  1,  1, -1,  1, -1,
  -1, -1, -1, -1,  1, -1,
   1, -1, -1,  1,  1, -1,
   1, -1,  1,  1,  1,  1,
  -1, -1,  1, -1,  1,  1,
]);

const rayBoxVerts = new Float32Array(36 * 3);
const cubeVerts = new Float32Array(CUBE_EDGE_VERTS.length);
const rayUniformData = new Float32Array(20);
const highlightUniformData = new Float32Array(20);

export class DebugRaycast {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private show = false;
  private provider: IRaycastProvider | null = null;

  private triPipeline: GPURenderPipeline | null = null;
  private linePipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;

  private rayUniformBuffer: GPUBuffer | null = null;
  private rayBindGroup: GPUBindGroup | null = null;
  private highlightUniformBuffer: GPUBuffer | null = null;
  private highlightBindGroup: GPUBindGroup | null = null;

  private rayVertBuffer: GPUBuffer | null = null;
  private cubeVertBuffer: GPUBuffer | null = null;

  private viewProj: Float32Array = new Float32Array(16);

  private rayOrigin: [number, number, number] = [0, 0, 0];
  private rayEnd: [number, number, number] = [0, 0, 0];
  private hit: IRaycastResult | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  setProvider(provider: IRaycastProvider): void {
    this.provider = provider;
  }

  init(): void {
    this.rayUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.highlightUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" },
        },
      ],
    });

    this.rayBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.rayUniformBuffer } }],
    });
    this.highlightBindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.highlightUniformBuffer } }],
    });

    const shaderModule = createValidatedShaderModule(this.device, { code: DEBUG_RAY_WGSL, label: "DebugRaycast" });

    const blendState: GPUBlendState = {
      alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
      color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
    };
    const depthState: GPUDepthStencilState = {
      format: DEPTH_FORMAT,
      depthWriteEnabled: false,
      depthCompare: "less-equal",
    };
    const vertexState = {
      module: shaderModule,
      entryPoint: "vs_main",
      buffers: [
        {
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat }],
        },
      ],
    };
    const fragmentState = {
      module: shaderModule,
      entryPoint: "fs_main",
      targets: [{ format: this.format, blend: blendState }],
    };

    this.triPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: vertexState,
      fragment: fragmentState,
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: depthState,
    });

    this.linePipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bindGroupLayout] }),
      vertex: vertexState,
      fragment: fragmentState,
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: depthState,
    });

    this.rayVertBuffer = this.device.createBuffer({
      size: 432,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    this.cubeVertBuffer = this.device.createBuffer({
      size: CUBE_EDGE_VERTS.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
  }

  setShow(show: boolean): void {
    this.show = show;
  }

  isShown(): boolean {
    return this.show;
  }

  update(
    camera: Parameters<typeof calculateViewProj>[0],
    origin: [number, number, number],
    direction: [number, number, number],
  ): void {
    if (!this.show || !this.provider) return;

    this.viewProj = calculateViewProj(camera);

    const [ox, oy, oz] = origin;
    const [dx, dy, dz] = direction;

    const hit = this.provider.raycast(ox, oy, oz, dx, dy, dz, RAY_MAX_DIST);

    if (hit) {
      this.rayOrigin = [ox, oy, oz];
      this.rayEnd = [hit.worldX, hit.worldY, hit.worldZ];
      this.hit = hit;
    } else {
      this.rayOrigin = [ox, oy, oz];
      this.rayEnd = [ox + dx * RAY_MAX_DIST, oy + dy * RAY_MAX_DIST, oz + dz * RAY_MAX_DIST];
      this.hit = null;
    }
  }

  private buildRayBoxVerts(
    ox: number, oy: number, oz: number,
    ex: number, ey: number, ez: number,
    out: Float32Array,
  ): void {
    let dx = ex - ox;
    let dy = ey - oy;
    let dz = ez - oz;
    const dlen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dlen < 1e-6) { dx = 0; dy = 1; dz = 0; } else { dx /= dlen; dy /= dlen; dz /= dlen; }

    let ux: number, uy: number, uz: number;
    if (Math.abs(dy) < 0.99) {
      ux = dz; uy = 0; uz = -dx;
    } else {
      ux = 0; uy = -dz; uz = dy;
    }
    const ulen = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ulen; uy /= ulen; uz /= ulen;
    const vx = dy * uz - dz * uy;
    const vy = dz * ux - dx * uz;
    const vz = dx * uy - dy * ux;

    const r = RAY_THICKNESS;
    const o0x = ox - r * ux - r * vx, o0y = oy - r * uy - r * vy, o0z = oz - r * uz - r * vz;
    const o1x = ox + r * ux - r * vx, o1y = oy + r * uy - r * vy, o1z = oz + r * uz - r * vz;
    const o2x = ox + r * ux + r * vx, o2y = oy + r * uy + r * vy, o2z = oz + r * uz + r * vz;
    const o3x = ox - r * ux + r * vx, o3y = oy - r * uy + r * vy, o3z = oz - r * uz + r * vz;
    const e0x = ex - r * ux - r * vx, e0y = ey - r * uy - r * vy, e0z = ez - r * uz - r * vz;
    const e1x = ex + r * ux - r * vx, e1y = ey + r * uy - r * vy, e1z = ez + r * uz - r * vz;
    const e2x = ex + r * ux + r * vx, e2y = ey + r * uy + r * vy, e2z = ez + r * uz + r * vz;
    const e3x = ex - r * ux + r * vx, e3y = ey - r * uy + r * vy, e3z = ez - r * uz + r * vz;

    const tris = [
      o0x, o0y, o0z, o1x, o1y, o1z, o2x, o2y, o2z,
      o0x, o0y, o0z, o2x, o2y, o2z, o3x, o3y, o3z,
      e0x, e0y, e0z, e2x, e2y, e2z, e1x, e1y, e1z,
      e0x, e0y, e0z, e3x, e3y, e3z, e2x, e2y, e2z,
      o0x, o0y, o0z, e0x, e0y, e0z, e1x, e1y, e1z,
      o0x, o0y, o0z, e1x, e1y, e1z, o1x, o1y, o1z,
      o1x, o1y, o1z, e1x, e1y, e1z, e2x, e2y, e2z,
      o1x, o1y, o1z, e2x, e2y, e2z, o2x, o2y, o2z,
      o2x, o2y, o2z, e2x, e2y, e2z, e3x, e3y, e3z,
      o2x, o2y, o2z, e3x, e3y, e3z, o3x, o3y, o3z,
      o3x, o3y, o3z, e3x, e3y, e3z, e0x, e0y, e0z,
      o3x, o3y, o3z, e0x, e0y, e0z, o0x, o0y, o0z,
    ];
    out.set(tris, 0);
  }

  render(passEncoder: GPURenderPassEncoder): void {
    if (!this.show || !this.triPipeline || !this.linePipeline) return;
    if (!this.rayBindGroup || !this.highlightBindGroup) return;
    if (!this.rayUniformBuffer || !this.highlightUniformBuffer) return;
    if (!this.rayVertBuffer || !this.cubeVertBuffer) return;

    rayUniformData.set(this.viewProj, 0);
    rayUniformData[16] = 0.0;
    rayUniformData[17] = 1.0;
    rayUniformData[18] = 1.0;
    rayUniformData[19] = 0.7;
    this.device.queue.writeBuffer(this.rayUniformBuffer, 0, rayUniformData);

    this.buildRayBoxVerts(
      this.rayOrigin[0], this.rayOrigin[1], this.rayOrigin[2],
      this.rayEnd[0], this.rayEnd[1], this.rayEnd[2],
      rayBoxVerts,
    );
    this.device.queue.writeBuffer(this.rayVertBuffer, 0, rayBoxVerts);

    highlightUniformData.set(this.viewProj, 0);
    highlightUniformData[16] = 1.0;
    highlightUniformData[17] = 0.93;
    highlightUniformData[18] = 0.0;
    highlightUniformData[19] = 0.9;
    this.device.queue.writeBuffer(this.highlightUniformBuffer, 0, highlightUniformData);

    if (this.hit) {
      const h = this.hit;
      const halfExtent = h.scale > 0 ? h.scale : 1;
      for (let v = 0; v < CUBE_EDGE_VERTS.length; v += 3) {
        cubeVerts[v]     = h.posX + CUBE_EDGE_VERTS[v]     * halfExtent;
        cubeVerts[v + 1] = h.posY + CUBE_EDGE_VERTS[v + 1] * halfExtent;
        cubeVerts[v + 2] = h.posZ + CUBE_EDGE_VERTS[v + 2] * halfExtent;
      }
      this.device.queue.writeBuffer(this.cubeVertBuffer, 0, cubeVerts);
    }

    passEncoder.setPipeline(this.triPipeline);
    passEncoder.setBindGroup(0, this.rayBindGroup);
    passEncoder.setVertexBuffer(0, this.rayVertBuffer);
    passEncoder.draw(36);

    if (this.hit) {
      passEncoder.setPipeline(this.linePipeline);
      passEncoder.setBindGroup(0, this.highlightBindGroup);
      passEncoder.setVertexBuffer(0, this.cubeVertBuffer);
      passEncoder.draw(24);
    }
  }

  destroy(): void {
    this.triPipeline = null;
    this.linePipeline = null;
    this.bindGroupLayout = null;
    this.rayBindGroup = null;
    this.highlightBindGroup = null;
    this.rayUniformBuffer?.destroy();
    this.highlightUniformBuffer?.destroy();
    this.rayVertBuffer?.destroy();
    this.cubeVertBuffer?.destroy();
    this.rayUniformBuffer = null;
    this.highlightUniformBuffer = null;
    this.rayVertBuffer = null;
    this.cubeVertBuffer = null;
  }
}
