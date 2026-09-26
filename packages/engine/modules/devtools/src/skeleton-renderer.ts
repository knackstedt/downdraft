import { calculateViewProj, composeMat4Into, createValidatedShaderModule, DEPTH_FORMAT, invertMat4, MSAA_SAMPLE_COUNT, multiplyMat4Into, type CameraState } from "@downdraft/engine";
import type { SkinData } from "@downdraft/engine/libraries/models";

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

  // Cached bone world positions (for gizmo placement)
  private boneWorldPositions: [number, number, number][] = [];
  // Cached bone parent indices (for rebuilding vertex buffer in updateBonePositions)
  private boneParentIndices: number[] = [];
  // Per-bone inverse of the bone's root ancestor transform. The animated
  // path (updateBonePositions, fed by Skeleton.computeSkinMatrices) applies
  // rootAncestorMatrix to root bones while setSkin deliberately ignores it —
  // it typically encodes the FBX scene's unit scale (e.g. 0.01 for cm→m) and
  // bone rest translations already live in raw mesh space. Premultiplying by
  // this inverse keeps the animated skeleton in the same space as setSkin.
  private boneCorrections: (Float32Array | null)[] = [];
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

    const shaderModule = createValidatedShaderModule(this.device, { code: SKELETON_WGSL, label: "SkeletonRenderer" });
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

    // --- Matrix helpers (column-major 4x4) — imported from @downdraft/engine ---

    // --- Compute world-space bone matrices by traversing the hierarchy ---

    const bones = skin.bones;
    const worldMats: Float32Array[] = bones.map(() => new Float32Array(16));
    const localMat = new Float32Array(16);
    const scratch = new Float32Array(16);

    // Cache bone hierarchy for updateBonePositions()
    this.boneCount = bones.length;
    this.boneParentIndices = bones.map((b) => b.parentIndex);
    this.boneCorrections = bones.map((_b, i) => {
      let r = i;
      while (bones[r].parentIndex >= 0) r = bones[r].parentIndex;
      const a = bones[r].rootAncestorMatrix;
      if (!a) return null;
      const inv = invertMat4(new Float32Array(a));
      // invertMat4 returns zeros for singular matrices — treat as no correction.
      return inv[15] !== 0 ? inv : null;
    });

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      // Apply debug offset to the selected bone's local position
      const pos: [number, number, number] = boneOffset && boneOffset.index === i
        ? [bone.restTranslation[0] + boneOffset.offset[0],
           bone.restTranslation[1] + boneOffset.offset[1],
           bone.restTranslation[2] + boneOffset.offset[2]]
        : bone.restTranslation;
      composeMat4Into(pos, bone.restRotation, bone.restScale, localMat);

      const worldMat = worldMats[i];
      if (bone.parentIndex >= 0 && bone.rootAncestorMatrix) {
        // Child bone with non-bone intermediates: world = parent * intermediate * local
        multiplyMat4Into(bone.rootAncestorMatrix, localMat, scratch);
        multiplyMat4Into(worldMats[bone.parentIndex], scratch, worldMat);
      } else if (bone.parentIndex >= 0) {
        // Normal child: world = parent * local
        multiplyMat4Into(worldMats[bone.parentIndex], localMat, worldMat);
      } else {
        // Root bone: world = local (NOT rootAncestorMatrix * local).
        // The rootAncestorMatrix often encodes the FBX scene's unit scale
        // (e.g. 0.01 for cm→m), which would shrink the skeleton relative to
        // the mesh vertices that stay in raw FBX coordinates. For visualization,
        // bone rest translations are already in the same coordinate space as
        // the mesh vertices, so we use the local transform directly.
        worldMat.set(localMat);
      }
    }

    // --- Apply normalization matrix and extract translations ---

    const normMat = skin.normalizationMatrix;
    const positions: [number, number, number][] = [];
    for (let i = 0; i < bones.length; i++) {
      const wm = worldMats[i];
      if (normMat) {
        multiplyMat4Into(normMat, wm, scratch);
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
    const corrected = new Float32Array(16);

    // Compute normalized world positions for each bone. Strip the root
    // ancestor transform first (see boneCorrections in setSkin) so the
    // positions land in raw mesh space, then apply the normalization matrix.
    const positions: [number, number, number][] = [];
    for (let i = 0; i < this.boneCount; i++) {
      const corr = this.boneCorrections[i];
      let base = worldMats[i];
      if (corr) {
        multiplyMat4Into(corr, base, corrected);
        base = corrected;
      }
      if (normMat) {
        multiplyMat4Into(normMat, base, scratch);
        positions.push([scratch[12], scratch[13], scratch[14]]);
      } else {
        positions.push([base[12], base[13], base[14]]);
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

  /**
   * Drop all bone geometry. Call when a skin-less model is selected so stale
   * geometry from the previous skinned model doesn't linger on screen.
   */
  clear() {
    this.vertexCount = 0;
    this.boneCount = 0;
    this.boneWorldPositions = [];
    this.boneParentIndices = [];
    this.boneCorrections = [];
    this.vertexBuffer?.destroy();
    this.vertexBuffer = null;
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

  destroy() {
    this.vertexBuffer?.destroy();
    this.uniformBuffer?.destroy();
  }
}
