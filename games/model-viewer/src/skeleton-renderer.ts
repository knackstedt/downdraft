import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import type { SkinData } from "@downdraft/plugin-models";

const SKELETON_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  model: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) isJoint: f32,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) isJoint: f32) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = uniforms.model * vec4<f32>(position, 1.0);
  output.clipPos = uniforms.viewProj * worldPos;
  output.isJoint = isJoint;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  // Bones (lines) are green, joints (points rendered as small lines) are yellow
  let isJoint = input.isJoint > 0.5;
  let color = select(
    vec3<f32>(0.2, 0.9, 0.3),  // bone lines — green
    vec3<f32>(1.0, 0.9, 0.2),  // joints — yellow
    isJoint,
  );
  let alpha = select(0.7, 1.0, isJoint);
  return vec4<f32>(color, alpha);
}
`;

const GIZMO_WGSL = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  model: mat4x4<f32>,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOutput {
  @builtin(position) clipPos: vec4<f32>,
  @location(0) color: vec3<f32>,
};

@vertex
fn vs_main(@location(0) position: vec3<f32>, @location(1) color: vec3<f32>) -> VertexOutput {
  var output: VertexOutput;
  let worldPos = uniforms.model * vec4<f32>(position, 1.0);
  output.clipPos = uniforms.viewProj * worldPos;
  output.color = color;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  return vec4<f32>(input.color, 1.0);
}
`;

/**
 * Renders a skeleton (bone hierarchy) as lines between bone rest positions,
 * with small cross-shaped joint markers at each bone.
 *
 * The skeleton is built from SkinData bone rest translations. Lines connect
 * each bone to its parent. Joint markers are small 3-axis crosses.
 */
export class SkeletonRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private vertexBuffer: GPUBuffer | null = null;
  private vertexCount = 0;

  // Gizmo pipeline (per-vertex colored lines)
  private gizmoPipeline: GPURenderPipeline | null = null;
  private gizmoVertexBuffer: GPUBuffer | null = null;
  private gizmoVertexCount = 0;

  // Cached bone world positions (for gizmo placement)
  private boneWorldPositions: [number, number, number][] = [];
  // Cached bone parent indices (for rebuilding vertex buffer in updateBonePositions)
  private boneParentIndices: number[] = [];
  private boneCount = 0;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  init() {
    this.uniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const shaderModule = this.device.createShaderModule({ code: SKELETON_WGSL });
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      }],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });

    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 16, // pos(3) + isJoint(1)
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32" },
          ],
        }],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });

    // Gizmo pipeline — per-vertex colored lines (pos(3) + color(3) = 6 floats)
    const gizmoShader = this.device.createShaderModule({ code: GIZMO_WGSL });
    this.gizmoPipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: gizmoShader,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 24, // pos(3) + color(3)
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
          ],
        }],
      },
      fragment: {
        module: gizmoShader,
        entryPoint: "fs_main",
        targets: [{
          format: this.format,
          blend: {
            color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
            alpha: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
          },
        }],
      },
      primitive: { topology: "line-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: false,
        depthCompare: "always",
      },
    });
  }

  /** Build vertex data from skin bone rest positions. Call when a model loads.
   *
   *  Bone restTranslation/restRotation are LOCAL (relative to parent bone).
   *  We must traverse the hierarchy to compute world-space positions, then
   *  apply skin.normalizationMatrix (which encodes the unit/auto-fit transforms
   *  applied to mesh vertices but NOT to bone rest data).
   *
   *  Optionally, a bone offset can be applied to a single bone's rest position
   *  for debugging — this shifts that bone (and all its children) in local space
   *  before the world matrix is computed. */
  setSkin(skin: SkinData, boneOffset?: { index: number; offset: [number, number, number] }) {
    const verts: number[] = [];
    const jointSize = 0.02; // 2cm joint crosses

    // --- Matrix helpers (column-major 4x4) ---

    const composeMat4 = (
      pos: [number, number, number],
      rot: [number, number, number, number],
      scale: [number, number, number],
      m: Float32Array,
    ): void => {
      const x = rot[0], y = rot[1], z = rot[2], w = rot[3];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      m[0] = (1 - (yy + zz)) * scale[0];
      m[1] = (xy + wz) * scale[0];
      m[2] = (xz - wy) * scale[0];
      m[3] = 0;
      m[4] = (xy - wz) * scale[1];
      m[5] = (1 - (xx + zz)) * scale[1];
      m[6] = (yz + wx) * scale[1];
      m[7] = 0;
      m[8] = (xz + wy) * scale[2];
      m[9] = (yz - wx) * scale[2];
      m[10] = (1 - (xx + yy)) * scale[2];
      m[11] = 0;
      m[12] = pos[0];
      m[13] = pos[1];
      m[14] = pos[2];
      m[15] = 1;
    };

    const multiplyMat4 = (a: Float32Array, b: Float32Array, out: Float32Array): void => {
      for (let i = 0; i < 4; i++) {
        const bi0 = b[i * 4], bi1 = b[i * 4 + 1], bi2 = b[i * 4 + 2], bi3 = b[i * 4 + 3];
        out[i * 4] = a[0] * bi0 + a[4] * bi1 + a[8] * bi2 + a[12] * bi3;
        out[i * 4 + 1] = a[1] * bi0 + a[5] * bi1 + a[9] * bi2 + a[13] * bi3;
        out[i * 4 + 2] = a[2] * bi0 + a[6] * bi1 + a[10] * bi2 + a[14] * bi3;
        out[i * 4 + 3] = a[3] * bi0 + a[7] * bi1 + a[11] * bi2 + a[15] * bi3;
      }
    };

    // --- Compute world-space bone matrices by traversing the hierarchy ---

    const bones = skin.bones;
    const worldMats: Float32Array[] = bones.map(() => new Float32Array(16));
    const localMat = new Float32Array(16);
    const scratch = new Float32Array(16);

    // Cache bone hierarchy for updateBonePositions()
    this.boneCount = bones.length;
    this.boneParentIndices = bones.map((b) => b.parentIndex);

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      // Apply debug offset to the selected bone's local position
      const pos: [number, number, number] = boneOffset && boneOffset.index === i
        ? [bone.restTranslation[0] + boneOffset.offset[0],
           bone.restTranslation[1] + boneOffset.offset[1],
           bone.restTranslation[2] + boneOffset.offset[2]]
        : bone.restTranslation;
      composeMat4(pos, bone.restRotation, bone.restScale, localMat);

      const worldMat = worldMats[i];
      if (bone.parentIndex >= 0 && bone.rootAncestorMatrix) {
        // Child bone with non-bone intermediates: world = parent * intermediate * local
        multiplyMat4(bone.rootAncestorMatrix, localMat, scratch);
        multiplyMat4(worldMats[bone.parentIndex], scratch, worldMat);
      } else if (bone.parentIndex >= 0) {
        // Normal child: world = parent * local
        multiplyMat4(worldMats[bone.parentIndex], localMat, worldMat);
      } else if (bone.rootAncestorMatrix) {
        // Root bone with non-bone ancestors: world = ancestorWorld * local
        multiplyMat4(bone.rootAncestorMatrix, localMat, worldMat);
      } else {
        // Root bone: world = local
        worldMat.set(localMat);
      }
    }

    // --- Apply normalization matrix and extract translations ---

    const normMat = skin.normalizationMatrix;
    const positions: [number, number, number][] = [];
    for (let i = 0; i < bones.length; i++) {
      const wm = worldMats[i];
      if (normMat) {
        multiplyMat4(normMat, wm, scratch);
        positions.push([scratch[12], scratch[13], scratch[14]]);
      } else {
        positions.push([wm[12], wm[13], wm[14]]);
      }
    }

    // Cache world positions for gizmo placement
    this.boneWorldPositions = positions;

    // --- Build vertex buffer ---

    for (let i = 0; i < bones.length; i++) {
      const pos = positions[i];

      // Joint marker: small 3-axis cross at the bone position (isJoint = 1)
      verts.push(pos[0] - jointSize, pos[1], pos[2], 1, pos[0] + jointSize, pos[1], pos[2], 1);
      verts.push(pos[0], pos[1] - jointSize, pos[2], 1, pos[0], pos[1] + jointSize, pos[2], 1);
      verts.push(pos[0], pos[1], pos[2] - jointSize, 1, pos[0], pos[1], pos[2] + jointSize, 1);

      // Bone line: from this bone to its parent (isJoint = 0)
      const bone = bones[i];
      if (bone.parentIndex >= 0 && bone.parentIndex < positions.length) {
        const ppos = positions[bone.parentIndex];
        verts.push(ppos[0], ppos[1], ppos[2], 0, pos[0], pos[1], pos[2], 0);
      }
    }

    this.vertexCount = verts.length / 4;
    if (this.vertexBuffer) this.vertexBuffer.destroy();
    this.vertexBuffer = this.device.createBuffer({
      size: verts.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(verts));
  }

  /**
   * Update the skeleton vertex buffer from animated bone world matrices.
   * Called each frame after the animator samples so the skeleton visualization
   * reflects the current animation pose instead of the static rest pose.
   *
   * @param worldMats Animated bone world matrices (column-major mat4s, one per
   *                  bone, in pre-normalization space) from ModelAnimator.
   * @param normMat   The normalization matrix to apply (or null for identity).
   */
  updateBonePositions(
    worldMats: Float32Array[],
    normMat: Float32Array | null,
  ): void {
    if (this.boneCount === 0 || worldMats.length < this.boneCount) return;

    const jointSize = 0.02;
    const verts: number[] = [];
    const scratch = new Float32Array(16);

    // Compute normalized world positions for each bone
    const positions: [number, number, number][] = [];
    for (let i = 0; i < this.boneCount; i++) {
      const wm = worldMats[i];
      if (normMat) {
        // scratch = normMat * wm (column-major multiply)
        for (let c = 0; c < 4; c++) {
          const wm0 = wm[c * 4], wm1 = wm[c * 4 + 1], wm2 = wm[c * 4 + 2], wm3 = wm[c * 4 + 3];
          scratch[c * 4]     = normMat[0] * wm0 + normMat[4] * wm1 + normMat[8]  * wm2 + normMat[12] * wm3;
          scratch[c * 4 + 1] = normMat[1] * wm0 + normMat[5] * wm1 + normMat[9]  * wm2 + normMat[13] * wm3;
          scratch[c * 4 + 2] = normMat[2] * wm0 + normMat[6] * wm1 + normMat[10] * wm2 + normMat[14] * wm3;
          scratch[c * 4 + 3] = normMat[3] * wm0 + normMat[7] * wm1 + normMat[11] * wm2 + normMat[15] * wm3;
        }
        positions.push([scratch[12], scratch[13], scratch[14]]);
      } else {
        positions.push([wm[12], wm[13], wm[14]]);
      }
    }

    // Update cached world positions (for gizmo placement)
    this.boneWorldPositions = positions;

    // Build vertex buffer (same layout as setSkin: joint markers + bone lines)
    for (let i = 0; i < this.boneCount; i++) {
      const pos = positions[i];

      // Joint marker: small 3-axis cross (isJoint = 1)
      verts.push(pos[0] - jointSize, pos[1], pos[2], 1, pos[0] + jointSize, pos[1], pos[2], 1);
      verts.push(pos[0], pos[1] - jointSize, pos[2], 1, pos[0], pos[1] + jointSize, pos[2], 1);
      verts.push(pos[0], pos[1], pos[2] - jointSize, 1, pos[0], pos[1], pos[2] + jointSize, 1);

      // Bone line: from parent to this bone (isJoint = 0)
      const parentIdx = this.boneParentIndices[i];
      if (parentIdx >= 0 && parentIdx < positions.length) {
        const ppos = positions[parentIdx];
        verts.push(ppos[0], ppos[1], ppos[2], 0, pos[0], pos[1], pos[2], 0);
      }
    }

    this.vertexCount = verts.length / 4;
    if (this.vertexBuffer) this.vertexBuffer.destroy();
    this.vertexBuffer = this.device.createBuffer({
      size: verts.length * 4,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.vertexBuffer, 0, new Float32Array(verts));
  }

  render(passEncoder: GPURenderPassEncoder, camera: CameraState, modelMatrix: Float32Array | null = null) {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer || !this.vertexBuffer || this.vertexCount === 0) return;

    const viewProj = calculateViewProj(camera);
    // Uniform buffer: viewProj (16 floats) + model (16 floats) = 32 floats
    const uniforms = new Float32Array(32);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    if (modelMatrix) {
      for (let i = 0; i < 16; i++) uniforms[16 + i] = modelMatrix[i];
    } else {
      // Identity matrix
      uniforms[16] = 1; uniforms[21] = 1; uniforms[26] = 1; uniforms[31] = 1;
    }

    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.vertexBuffer);
    passEncoder.draw(this.vertexCount);
  }

  /** Get the world-space position of a bone (for gizmo placement). */
  getBoneWorldPosition(index: number): [number, number, number] | null {
    if (index < 0 || index >= this.boneWorldPositions.length) return null;
    return this.boneWorldPositions[index];
  }

  /** Render a gizmo from vertex data built by GizmoManager. */
  renderGizmo(passEncoder: GPURenderPassEncoder, camera: CameraState, vertices: Float32Array, vertexCount: number, modelMatrix: Float32Array | null = null) {
    if (!this.gizmoPipeline || !this.bindGroup || !this.uniformBuffer || vertexCount === 0) return;

    // Update gizmo vertex buffer
    if (this.gizmoVertexBuffer) this.gizmoVertexBuffer.destroy();
    this.gizmoVertexBuffer = this.device.createBuffer({
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(this.gizmoVertexBuffer, 0, vertices.buffer as ArrayBuffer, vertices.byteOffset, vertices.byteLength);

    // Update uniforms (shared with skeleton pipeline)
    const viewProj = calculateViewProj(camera);
    const uniforms = new Float32Array(32);
    for (let i = 0; i < 16; i++) uniforms[i] = viewProj[i];
    if (modelMatrix) {
      for (let i = 0; i < 16; i++) uniforms[16 + i] = modelMatrix[i];
    } else {
      uniforms[16] = 1; uniforms[21] = 1; uniforms[26] = 1; uniforms[31] = 1;
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, uniforms);

    passEncoder.setPipeline(this.gizmoPipeline);
    passEncoder.setBindGroup(0, this.bindGroup);
    passEncoder.setVertexBuffer(0, this.gizmoVertexBuffer);
    passEncoder.draw(vertexCount);
  }

  destroy() {
    this.vertexBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
