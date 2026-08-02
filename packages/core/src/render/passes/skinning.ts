const SKINNING_COMPUTE_SHADER = `
struct BoneTransform {
  position: vec3<f32>,
  _pad0: f32,
  rotation: vec4<f32>,
  scale: vec3<f32>,
  _pad1: f32,
};

struct BoneInput {
  transforms: array<BoneTransform>,
};

struct InverseBindInput {
  matrices: array<mat4x4<f32>>,
};

struct SkinMatrixOutput {
  matrices: array<mat4x4<f32>>,
};

@group(0) @binding(0) var<uniform> boneCount: u32;
@group(0) @binding(1) var<storage, read> boneData: BoneInput;
@group(0) @binding(2) var<storage, read> inverseBindData: InverseBindInput;
@group(0) @binding(3) var<storage, read_write> skinMatrices: SkinMatrixOutput;

fn composeMatrix(pos: vec3<f32>, rot: vec4<f32>, scale: vec3<f32>) -> mat4x4<f32> {
  let nq = normalize(rot);
  let xx = nq.x * nq.x;
  let yy = nq.y * nq.y;
  let zz = nq.z * nq.z;
  let xy = nq.x * nq.y;
  let xz = nq.x * nq.z;
  let yz = nq.y * nq.z;
  let wx = nq.w * nq.x;
  let wy = nq.w * nq.y;
  let wz = nq.w * nq.z;

  var m: mat4x4<f32>;
  m[0] = vec4<f32>(
    (1.0 - 2.0 * (yy + zz)) * scale.x,
    (2.0 * (xy + wz)) * scale.x,
    (2.0 * (xz - wy)) * scale.x,
    0.0,
  );
  m[1] = vec4<f32>(
    (2.0 * (xy - wz)) * scale.y,
    (1.0 - 2.0 * (xx + zz)) * scale.y,
    (2.0 * (yz + wx)) * scale.y,
    0.0,
  );
  m[2] = vec4<f32>(
    (2.0 * (xz + wy)) * scale.z,
    (2.0 * (yz - wx)) * scale.z,
    (1.0 - 2.0 * (xx + yy)) * scale.z,
    0.0,
  );
  m[3] = vec4<f32>(pos.x, pos.y, pos.z, 1.0);
  return m;
}

@compute @workgroup_size(64)
fn cs_main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= boneCount) {
    return;
  }

  let bone = boneData.transforms[idx];
  let localMatrix = composeMatrix(bone.position, bone.rotation, bone.scale);
  let inverseBind = inverseBindData.matrices[idx];
  skinMatrices.matrices[idx] = localMatrix * inverseBind;
}
`;

export interface SkinningComputePassResources {
  boneTransformBuffer: GPUBuffer;
  inverseBindBuffer: GPUBuffer;
  skinMatrixBuffer: GPUBuffer;
  boneCountBuffer: GPUBuffer;
  bindGroup: GPUBindGroup;
  pipeline: GPUComputePipeline;
}

export class SkinningComputePass {
  readonly name = "skinning-compute";
  private device: GPUDevice;
  private pipeline: GPUComputePipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private boneCountBuffer: GPUBuffer | null = null;
  private boneTransformBuffer: GPUBuffer | null = null;
  private inverseBindBuffer: GPUBuffer | null = null;
  private skinMatrixBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private maxBones: number;

  constructor(device: GPUDevice, maxBones: number = 256) {
    this.device = device;
    this.maxBones = maxBones;
  }

  prepare(boneCount: number): void {
    const shaderModule = this.device.createShaderModule({
      label: "skinning-compute",
      code: SKINNING_COMPUTE_SHADER,
    });

    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });

    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout],
    });

    this.pipeline = this.device.createComputePipeline({
      label: "skinning-compute",
      layout: pipelineLayout,
      compute: { module: shaderModule, entryPoint: "cs_main" },
    });

    const boneTransformSize = this.maxBones * 12 * 4;
    const inverseBindSize = this.maxBones * 16 * 4;
    const skinMatrixSize = this.maxBones * 16 * 4;

    this.boneCountBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.boneTransformBuffer = this.device.createBuffer({
      size: boneTransformSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.inverseBindBuffer = this.device.createBuffer({
      size: inverseBindSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    this.skinMatrixBuffer = this.device.createBuffer({
      size: skinMatrixSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });

    const boneCountBuf = new Uint32Array([boneCount]);
    this.device.queue.writeBuffer(this.boneCountBuffer, 0, boneCountBuf.buffer as ArrayBuffer, 0, boneCountBuf.byteLength);

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
      { binding: 0, resource: { buffer: this.boneCountBuffer } },
      { binding: 1, resource: { buffer: this.boneTransformBuffer } },
      { binding: 2, resource: { buffer: this.inverseBindBuffer } },
      { binding: 3, resource: { buffer: this.skinMatrixBuffer } },
      ],
    });
  }

  updateBoneTransforms(transforms: Float32Array): void {
    if (!this.boneTransformBuffer) return;
    this.device.queue.writeBuffer(this.boneTransformBuffer, 0, transforms.buffer as ArrayBuffer, 0, transforms.byteLength);
  }

  updateInverseBindMatrices(matrices: Float32Array): void {
    if (!this.inverseBindBuffer) return;
    this.device.queue.writeBuffer(this.inverseBindBuffer, 0, matrices.buffer as ArrayBuffer, 0, matrices.byteLength);
  }

  updateBoneCount(count: number): void {
    if (!this.boneCountBuffer) return;
    const buf = new Uint32Array([count]);
    this.device.queue.writeBuffer(this.boneCountBuffer, 0, buf.buffer as ArrayBuffer, 0, buf.byteLength);
  }

  getSkinMatrixBuffer(): GPUBuffer | null {
    return this.skinMatrixBuffer;
  }

  execute(encoder: GPUCommandEncoder, boneCount: number): void {
    if (!this.pipeline || !this.bindGroup) return;

    const workgroupCount = Math.ceil(boneCount / 64);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.dispatchWorkgroups(workgroupCount);
    pass.end();
  }

  destroy(): void {
    this.boneCountBuffer?.destroy();
    this.boneTransformBuffer?.destroy();
    this.inverseBindBuffer?.destroy();
    this.skinMatrixBuffer?.destroy();
    this.boneCountBuffer = null;
    this.boneTransformBuffer = null;
    this.inverseBindBuffer = null;
    this.skinMatrixBuffer = null;
    this.bindGroup = null;
    this.pipeline = null;
    this.bindGroupLayout = null;
  }
}

export function packBoneTransforms(
  positions: Array<[number, number, number]>,
  rotations: Array<[number, number, number, number]>,
  scales: Array<[number, number, number]>,
): Float32Array {
  const boneCount = positions.length;
  const buffer = new Float32Array(boneCount * 12);
  for (let i = 0; i < boneCount; i++) {
    const offset = i * 12;
    buffer[offset + 0] = positions[i][0];
    buffer[offset + 1] = positions[i][1];
    buffer[offset + 2] = positions[i][2];
    buffer[offset + 3] = 0;
    buffer[offset + 4] = rotations[i][0];
    buffer[offset + 5] = rotations[i][1];
    buffer[offset + 6] = rotations[i][2];
    buffer[offset + 7] = rotations[i][3];
    buffer[offset + 8] = scales[i][0];
    buffer[offset + 9] = scales[i][1];
    buffer[offset + 10] = scales[i][2];
    buffer[offset + 11] = 0;
  }
  return buffer;
}

export function packBoneTransformsVec4(
  positions: Array<[number, number, number]>,
  rotations: Array<[number, number, number, number]>,
  scales: Array<[number, number, number]>,
): Float32Array {
  const boneCount = positions.length;
  const buffer = new Float32Array(boneCount * 12);
  for (let i = 0; i < boneCount; i++) {
    const offset = i * 12;
    buffer[offset + 0] = positions[i][0];
    buffer[offset + 1] = positions[i][1];
    buffer[offset + 2] = positions[i][2];
    buffer[offset + 3] = rotations[i][0];
    buffer[offset + 4] = rotations[i][1];
    buffer[offset + 5] = rotations[i][2];
    buffer[offset + 6] = rotations[i][3];
    buffer[offset + 7] = scales[i][0];
    buffer[offset + 8] = scales[i][1];
    buffer[offset + 9] = scales[i][2];
    buffer[offset + 10] = 0;
    buffer[offset + 11] = 0;
  }
  return buffer;
}

export class VertexSkinningPass {
  readonly name = "skinning-vertex";
  private device: GPUDevice | null;
  private boneTransformBuffer: GPUBuffer | null = null;
  private inverseBindBuffer: GPUBuffer | null = null;
  private boneCountBuffer: GPUBuffer | null = null;
  private maxBones: number;

  constructor(device: GPUDevice | null, maxBones: number = 256) {
    this.device = device;
    this.maxBones = maxBones;
  }

  prepare(): void {
    if (!this.device) return;

    const boneTransformSize = this.maxBones * 12 * 4;
    const inverseBindSize = this.maxBones * 16 * 4;

    this.boneTransformBuffer = this.device.createBuffer({
      size: boneTransformSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.inverseBindBuffer = this.device.createBuffer({
      size: inverseBindSize,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.boneCountBuffer = this.device.createBuffer({
      size: 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
  }

  updateBoneTransforms(transforms: Float32Array): void {
    if (!this.boneTransformBuffer || !this.device) return;
    this.device.queue.writeBuffer(this.boneTransformBuffer, 0, transforms.buffer as ArrayBuffer, 0, transforms.byteLength);
  }

  updateInverseBindMatrices(matrices: Float32Array): void {
    if (!this.inverseBindBuffer || !this.device) return;
    this.device.queue.writeBuffer(this.inverseBindBuffer, 0, matrices.buffer as ArrayBuffer, 0, matrices.byteLength);
  }

  updateBoneCount(count: number): void {
    if (!this.boneCountBuffer || !this.device) return;
    const buf = new Uint32Array([count]);
    this.device.queue.writeBuffer(this.boneCountBuffer, 0, buf.buffer as ArrayBuffer, 0, buf.byteLength);
  }

  getBoneTransformBuffer(): GPUBuffer | null { return this.boneTransformBuffer; }
  getInverseBindBuffer(): GPUBuffer | null { return this.inverseBindBuffer; }
  getBoneCountBuffer(): GPUBuffer | null { return this.boneCountBuffer; }

  destroy(): void {
    this.boneTransformBuffer?.destroy();
    this.inverseBindBuffer?.destroy();
    this.boneCountBuffer?.destroy();
    this.boneTransformBuffer = null;
    this.inverseBindBuffer = null;
    this.boneCountBuffer = null;
  }
}
