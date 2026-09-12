// ============================================================================
// TaskMarkerPass — renders colored outlines on the WebGPU canvas for queued
// task markers. Draws as 2D screen-space quads after the 3D scene.
//
// Each marker is a 1x1 block quad (in world space at Z=0) rendered as a
// colored border. Uses the same view-projection matrix as the block grid
// pass so markers stay aligned with blocks at any camera angle/zoom.
// ============================================================================

import { createValidatedShaderModule } from "@downdraft/core";
import { DEPTH_FORMAT } from "@downdraft/core";
import type { StructView, WgslStruct } from "@downdraft/shader-graph";
import { f32, mat4x4f, wgsl } from "@downdraft/shader-graph";

// ─── Uniform/storage structs (single source of truth for layout) ───────────
const UniformsStruct: WgslStruct = wgsl.struct("Uniforms", {
  viewProj: mat4x4f,
  canvasW: f32,
  canvasH: f32,
  markerCount: f32,
  _pad: f32,
});

const MarkerStruct: WgslStruct = wgsl.struct("Marker", {
  gridX: f32,
  gridY: f32,
  z: f32,
  colorR: f32,
  colorG: f32,
  colorB: f32,
});

const MARKER_WGSL = `
${UniformsStruct.wgsl}

${MarkerStruct.wgsl}

@group(0) @binding(0) var<uniform> uniforms : Uniforms;
@group(0) @binding(1) var<storage, read> markers : array<Marker>;

struct VsOut {
  @builtin(position) pos : vec4f,
  @location(0) color : vec3f,
  @location(1) uv : vec2f,
};

// Draw each marker as a quad (4 verts → triangle strip).
// UVs go 0→1 across the quad so the fragment shader can draw a border.
@vertex
fn vs_main(@builtin(vertex_index) vi : u32, @builtin(instance_index) ii : u32) -> VsOut {
  let marker = markers[ii];
  // Quad corners with UVs
  let corners = array<vec4f, 4>(
    vec4f(0.0, 0.0, 0.0, 0.0),  // pos.xy, uv.xy
    vec4f(1.0, 0.0, 1.0, 0.0),
    vec4f(0.0, 1.0, 0.0, 1.0),
    vec4f(1.0, 1.0, 1.0, 1.0),
  );
  let c = corners[vi];
  let worldPos = vec4f(marker.gridX + c.x, marker.gridY + c.y, marker.z, 1.0);
  var out : VsOut;
  out.pos = uniforms.viewProj * worldPos;
  out.color = vec3f(marker.colorR, marker.colorG, marker.colorB);
  out.uv = c.zw;
  return out;
}

@fragment
fn fs_main(in : VsOut) -> @location(0) vec4f {
  // Border: keep fragments near the edges, discard the center.
  // uv ranges 0..1 across the quad. borderWidth is in UV space (0..1).
  let borderWidth = 0.08;
  let dx = min(in.uv.x, 1.0 - in.uv.x);
  let dy = min(in.uv.y, 1.0 - in.uv.y);
  let edgeDist = min(dx, dy);
  if (edgeDist > borderWidth) {
    discard;
  }
  return vec4f(in.color, 0.85);
}
`;

const MAX_MARKERS = 100;

// Per-marker: gridX, gridY, r, g, b, pad = 6 floats × 4 bytes = 24 bytes
const MARKER_STRIDE = 6 * 4;


export interface MarkerData {
  gridX: number;
  gridY: number;
  z: number;
  color: [number, number, number];
}

export class TaskMarkerPass {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private markerBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private markerCount = 0;
  // Preallocated buffers (avoid per-frame allocation)
  private _uniformBuf: Float32Array<ArrayBuffer> | null = null;
  private _uniformView: StructView | null = null;
  private _markerData: Float32Array<ArrayBuffer> = new Float32Array(MAX_MARKERS * 6);

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shader = createValidatedShaderModule(this.device, { code: MARKER_WGSL, label: "TaskMarkerPass" });

    // Uniform buffer: mat4x4 (64 bytes) + 4 floats (16 bytes) = 80 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this._uniformBuf = new Float32Array(UniformsStruct.floatCount);
    this._uniformView = UniformsStruct.view(this._uniformBuf);

    // Marker storage buffer
    this.markerBuffer = this.device.createBuffer({
      size: MAX_MARKERS * MARKER_STRIDE,
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
        { binding: 1, resource: { buffer: this.markerBuffer } },
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
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          },
        }],
      },
      primitive: { topology: "triangle-strip" },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always", // markers always render on top
      },
    });
  }

  /** Update marker instance data — call only when markers change. */
  updateInstances(markers: MarkerData[]): void {
    if (!this.markerBuffer) return;
    const count = Math.min(markers.length, MAX_MARKERS);
    const data = this._markerData;
    for (let i = 0; i < count; i++) {
      const m = markers[i];
      const view = MarkerStruct.view(data.subarray(i * 6, i * 6 + 6));
      view.set("gridX", m.gridX);
      view.set("gridY", m.gridY);
      view.set("z", m.z);
      view.set("colorR", m.color[0]);
      view.set("colorG", m.color[1]);
      view.set("colorB", m.color[2]);
    }
    if (count > 0) {
      this.device.queue.writeBuffer(
        this.markerBuffer, 0,
        data.buffer,
        data.byteOffset,
        count * 6 * 4,
      );
    }
    this.markerCount = count;
  }

  /** Update camera uniforms — call every frame. */
  updateCamera(viewProj: Float32Array, canvasW: number, canvasH: number): void {
    if (!this.uniformBuffer) return;
    const view = this._uniformView!;
    view.set("viewProj", viewProj);
    view.set("canvasW", canvasW);
    view.set("canvasH", canvasH);
    view.set("markerCount", this.markerCount);
    view.set("_pad", 0);
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this._uniformBuf!);
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.pipeline || !this.bindGroup || this.markerCount === 0) return;
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(4, this.markerCount); // 4 verts per quad, N instances
  }

  destroy(): void {
    this.uniformBuffer?.destroy();
    this.markerBuffer?.destroy();
    this._uniformBuf = null;
    this._uniformView = null;
  }
}
