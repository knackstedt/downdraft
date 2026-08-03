// ============================================================================
// World Space UI Pass — Renders OSR textures as billboarded quads in 3D space
// ============================================================================

import type { WorldSpaceUIElement } from "../types.ts";

const SHADER_CODE = /* wgsl */ `
struct CameraUniforms {
  viewProj: mat4x4<f32>,
  cameraRight: vec4<f32>,
  cameraUp: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var uiSampler: sampler;

@group(1) @binding(0) var uiTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) clipPosition: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) errorFlag: f32,
};

struct InstanceInput {
  @location(1) position: vec3<f32>,
  @location(2) size: vec2<f32>,
  @location(3) uvOffset: vec2<f32>,
  @location(4) uvScale: vec2<f32>,
  @location(5) billboardMode: f32,
  @location(6) textureIndex: f32,
  @location(7) errorFlag: f32,
};

@vertex
fn vs_main(@location(0) quadUV: vec2<f32>, instance: InstanceInput) -> VertexOutput {
  var output: VertexOutput;
  output.errorFlag = instance.errorFlag;

  var worldOffset: vec3<f32>;
  if (instance.billboardMode == 0.0) {
    worldOffset = camera.cameraRight.xyz * (quadUV.x - 0.5) * instance.size.x
                + camera.cameraUp.xyz * (quadUV.y - 0.5) * instance.size.y;
  } else if (instance.billboardMode == 1.0) {
    worldOffset = vec3<f32>((quadUV.x - 0.5) * instance.size.x, 0.0, 0.0)
                + camera.cameraUp.xyz * (quadUV.y - 0.5) * instance.size.y;
  } else {
    worldOffset = vec3<f32>((quadUV.x - 0.5) * instance.size.x, 0.0, (quadUV.y - 0.5) * instance.size.y);
  }

  let worldPos = vec4<f32>(instance.position + worldOffset, 1.0);
  output.clipPosition = camera.viewProj * worldPos;
  output.uv = instance.uvOffset + quadUV * instance.uvScale;

  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(uiTexture, uiSampler, input.uv);
  let errorColor = vec4<f32>(1.0, 0.0, 0.0, 0.85);
  return mix(texColor, errorColor, select(0.0, 1.0, input.errorFlag > 0.5));
}
`;

// Instance data layout: position(3) + pad(1) + size(2) + uvOffset(2) + uvScale(2) +
//   billboardMode(1) + textureIndex(1) + errorFlag(1) + pad(1) = 14 floats = 56 bytes
const INSTANCE_FLOATS = 14;
const INSTANCE_BYTES = INSTANCE_FLOATS * 4;

// Quad vertices: 6 vertices × 2 floats (uv) = 12 floats
// Flipped horizontally (U: 1→0) to correct mirrored rendering
const QUAD_VERTICES = new Float32Array([
  1, 0,
  0, 0,
  1, 1,
  1, 1,
  0, 0,
  0, 1,
]);

export interface CameraState {
  viewProj: Float32Array;
  cameraRight: [number, number, number];
  cameraUp: [number, number, number];
  cameraPosition: [number, number, number];
  canvasWidth: number;
  canvasHeight: number;
}

export class WorldSpaceUIPass {
  private device: GPUDevice;
  private surfaceFormat: GPUTextureFormat;
  private depthFormat: GPUTextureFormat;
  private shaderModule: GPUShaderModule | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private sampler: GPUSampler | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private instanceCount = 0;
  private maxInstances = 256;
  private bindGroupLayout0: GPUBindGroupLayout | null = null;
  private bindGroup0: GPUBindGroup | null = null;
  private textureBindGroups: Map<number, GPUBindGroup> = new Map();
  private currentTextures: { textureView: GPUTextureView }[] = [];

  constructor(device: GPUDevice, surfaceFormat: GPUTextureFormat = "bgra8unorm", depthFormat: GPUTextureFormat = "depth24plus") {
    this.device = device;
    this.surfaceFormat = surfaceFormat;
    this.depthFormat = depthFormat;
  }

  prepare(): void {
    // Shader module
    this.shaderModule = this.device.createShaderModule({ code: SHADER_CODE });
    this.shaderModule.getCompilationInfo().then((info) => {
      for (const msg of info.messages) {
        if (msg.type === "error") console.error("[WorldSpaceUIPass] Shader error:", msg.message);
        else console.warn("[WorldSpaceUIPass] Shader warning:", msg.message);
      }
    }).catch(() => {});

    // Sampler
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Uniform buffer: viewProj(64) + cameraRight(16) + cameraUp(16) = 96 bytes
    this.uniformBuffer = this.device.createBuffer({
      size: 96,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Vertex buffer (quad UVs)
    this.vertexBuffer = this.device.createBuffer({
      size: QUAD_VERTICES.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, QUAD_VERTICES);

    // Instance buffer
    this.instanceBuffer = this.device.createBuffer({
      size: this.maxInstances * INSTANCE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    // Bind group layout 0: camera uniform + sampler
    this.bindGroupLayout0 = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
      ],
    });

    this.bindGroup0 = this.device.createBindGroup({
      layout: this.bindGroupLayout0,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
      ],
    });

    // Bind group layout 1: texture
    const bindGroupLayout1 = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    // Pipeline layout
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout0, bindGroupLayout1],
    });

    // Render pipeline
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            // Vertex buffer — quad UVs
            arrayStride: 8,
            stepMode: "vertex",
            attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }],
          },
          {
            // Instance buffer — per-instance data
            arrayStride: INSTANCE_BYTES,
            stepMode: "instance",
            attributes: [
              { shaderLocation: 1, offset: 0, format: "float32x3" },      // position
              { shaderLocation: 2, offset: 16, format: "float32x2" },     // size
              { shaderLocation: 3, offset: 24, format: "float32x2" },     // uvOffset
              { shaderLocation: 4, offset: 32, format: "float32x2" },     // uvScale
              { shaderLocation: 5, offset: 40, format: "float32" },       // billboardMode
              { shaderLocation: 6, offset: 44, format: "float32" },       // textureIndex
              { shaderLocation: 7, offset: 48, format: "float32" },       // errorFlag
            ],
          },
        ],
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.surfaceFormat,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
              operation: "add",
            },
          },
        }],
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        depthWriteEnabled: false,
        depthCompare: "less",
        format: this.depthFormat as GPUTextureFormat,
      },
    });
  }

  updateInstances(elements: WorldSpaceUIElement[], errorTextureIndices: Set<number>): void {
    if (!this.instanceBuffer) return;

    this.instanceCount = elements.length;

    // Grow buffer if needed
    if (this.instanceCount > this.maxInstances) {
      this.maxInstances = Math.ceil(this.instanceCount * 1.5);
      this.instanceBuffer.destroy();
      this.instanceBuffer = this.device.createBuffer({
        size: this.maxInstances * INSTANCE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
    }

    const data = new Float32Array(this.instanceCount * INSTANCE_FLOATS);
    for (let i = 0; i < this.instanceCount; i++) {
      const el = elements[i];
      const offset = i * INSTANCE_FLOATS;
      data[offset + 0] = el.position[0];
      data[offset + 1] = el.position[1];
      data[offset + 2] = el.position[2];
      data[offset + 3] = 0; // pad
      data[offset + 4] = el.size[0];
      data[offset + 5] = el.size[1];
      data[offset + 6] = el.uvOffset[0];
      data[offset + 7] = el.uvOffset[1];
      data[offset + 8] = el.uvScale[0];
      data[offset + 9] = el.uvScale[1];
      data[offset + 10] = el.billboardMode;
      data[offset + 11] = el.textureIndex;
      data[offset + 12] = errorTextureIndices.has(el.textureIndex) ? 1 : 0;
      data[offset + 13] = 0; // pad
    }

    this.device.queue.writeBuffer(this.instanceBuffer, 0, data);
  }

  updateCamera(camera: CameraState): void {
    if (!this.uniformBuffer) return;
    // WGSL uniform struct layout (vec4 = 16 bytes each):
    //   viewProj: mat4x4 at offset 0  (16 floats = 64 bytes)
    //   cameraRight: vec4 at offset 64 (floats 16-19)
    //   cameraUp: vec4 at offset 80   (floats 20-23)
    const data = new Float32Array(24);
    data.set(camera.viewProj, 0);
    data[16] = camera.cameraRight[0];
    data[17] = camera.cameraRight[1];
    data[18] = camera.cameraRight[2];
    data[19] = 0;
    data[20] = camera.cameraUp[0];
    data[21] = camera.cameraUp[1];
    data[22] = camera.cameraUp[2];
    data[23] = 0;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  setTextures(textures: { textureView: GPUTextureView }[]): void {
    this.currentTextures = textures;
    this.textureBindGroups.clear();

    if (!this.pipeline) return;

    const bindGroupLayout1 = this.pipeline.getBindGroupLayout(1);
    for (let i = 0; i < textures.length; i++) {
      this.textureBindGroups.set(i, this.device.createBindGroup({
        layout: bindGroupLayout1,
        entries: [{ binding: 0, resource: textures[i].textureView }],
      }));
    }
  }

  execute(passEncoder: GPURenderPassEncoder, elements: WorldSpaceUIElement[], errorTextureIndices: Set<number>): void {
    if (!this.pipeline || !this.bindGroup0 || !this.vertexBuffer || !this.instanceBuffer) return;
    if (elements.length === 0) return;

    // Sort elements by textureIndex so instances are contiguous per texture group
    const sorted = [...elements].sort((a, b) => a.textureIndex - b.textureIndex);
    this.updateInstances(sorted, errorTextureIndices);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup0);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.setVertexBuffer(1, this.instanceBuffer);

    // Group sorted instances by textureIndex — each group is contiguous
    let firstInstance = 0;
    let currentTexIdx = sorted[0].textureIndex;
    let groupCount = 0;

    for (let i = 0; i <= sorted.length; i++) {
      const texIdx = i < sorted.length ? sorted[i].textureIndex : -1;
      if (texIdx !== currentTexIdx) {
        // Draw the accumulated group
        const bg = this.textureBindGroups.get(currentTexIdx);
        if (bg) {
          passEncoder.setBindGroup(1, bg);
          passEncoder.draw(6, groupCount, 0, firstInstance);
        }
        firstInstance += groupCount;
        groupCount = 0;
        currentTexIdx = texIdx;
      }
      groupCount++;
    }
  }

  destroy(): void {
    this.shaderModule?.destroy();
    this.pipeline = null;
    this.uniformBuffer?.destroy();
    this.vertexBuffer?.destroy();
    this.instanceBuffer?.destroy();
    this.bindGroupLayout0 = null;
    this.bindGroup0 = null;
    this.textureBindGroups.clear();
  }
}
