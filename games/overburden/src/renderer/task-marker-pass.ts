// ============================================================================
// TaskMarkerPass — renders colored outlines on the WebGPU canvas for queued
// task markers. Draws as 2D screen-space quads after the 3D scene.
//
// Each marker is a 1x1 block quad (in world space at Z=0) rendered as a
// colored border. Uses the same view-projection matrix as the block grid
// pass so markers stay aligned with blocks at any camera angle/zoom.
// ============================================================================

const MARKER_WGSL = `
struct Uniforms {
  viewProj : mat4x4f,
  canvasW : f32,
  canvasH : f32,
  markerCount : f32,
  _pad : f32,
};

struct Marker {
  gridX : f32,
  gridY : f32,
  colorR : f32,
  colorG : f32,
  colorB : f32,
  _pad : f32,
};

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
  let worldPos = vec4f(marker.gridX + c.x, marker.gridY + c.y, 0.05, 1.0);
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

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init(): void {
    const shader = this.device.createShaderModule({ code: MARKER_WGSL });

    // Uniform buffer: mat4x4 (64 bytes) + 4 floats (16 bytes) = 80 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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
        format: "depth24plus",
        depthWriteEnabled: false,
        depthCompare: "always", // markers always render on top
      },
    });
  }

  update(viewProj: Float32Array, canvasW: number, canvasH: number, markers: MarkerData[]): void {
    if (!this.uniformBuffer || !this.markerBuffer) return;

    // Write uniforms
    const u = new Float32Array(20); // 16 (mat4) + 4
    u.set(viewProj, 0);
    u[16] = canvasW;
    u[17] = canvasH;
    u[18] = Math.min(markers.length, MAX_MARKERS);
    u[19] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, u);

    // Write marker data
    const count = Math.min(markers.length, MAX_MARKERS);
    const data = new Float32Array(MAX_MARKERS * 6);
    for (let i = 0; i < count; i++) {
      const m = markers[i];
      data[i * 6 + 0] = m.gridX;
      data[i * 6 + 1] = m.gridY;
      data[i * 6 + 2] = m.color[0];
      data[i * 6 + 3] = m.color[1];
      data[i * 6 + 4] = m.color[2];
      data[i * 6 + 5] = 0;
    }
    this.device.queue.writeBuffer(this.markerBuffer, 0, data);
    this.markerCount = count;
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
  }
}
