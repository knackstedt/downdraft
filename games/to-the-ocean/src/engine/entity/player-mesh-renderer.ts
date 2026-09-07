import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "@downdraft/core";
import type { MeshData, ModelData } from "@downdraft/library-models";
import { MAX_BONES } from "@shared/constants";
import { PLAYER_WGSL, SKINNED_PLAYER_WGSL, SKINNING_COMPUTE_WGSL } from "../shaders/entity-shaders";
import { SkeletonAnimator } from "../skeleton-animator";
import type { EntityRenderContext } from "./render-context";

interface ClothingPiece {
  name: string;
  vertices: GPUBuffer;
  indices: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  texture: GPUTexture | null;
  visible: boolean;
}

export class PlayerMeshRenderer {
  private ctx: EntityRenderContext;

  // Static player mesh
  private playerMeshVertices: GPUBuffer | null = null;
  private playerMeshIndices: GPUBuffer | null = null;
  private playerMeshIndexCount = 0;
  private playerMeshIndexFormat: GPUIndexFormat = "uint16";
  playerPipeline: GPURenderPipeline | null = null;
  playerBindGroup: GPUBindGroup | null = null;
  private playerBindGroups: GPUBindGroup[] = [];
  private playerBindGroupLayout: GPUBindGroupLayout | null = null;

  // Skinned player mesh
  private skinnedPlayerVertices: GPUBuffer | null = null;
  private skinnedPlayerIndices: GPUBuffer | null = null;
  private skinnedPlayerIndexCount = 0;
  private skinnedPlayerIndexFormat: GPUIndexFormat = "uint16";
  skinnedPlayerPipeline: GPURenderPipeline | null = null;
  skinnedPlayerBindGroup: GPUBindGroup | null = null;
  private skinnedPlayerBindGroups: GPUBindGroup[] = [];
  skinnedPlayerBindGroupLayout: GPUBindGroupLayout | null = null;
  private boneMatrixBuffer: GPUBuffer | null = null;
  private skeletonAnimator: SkeletonAnimator | null = null;

  // GPU skinning compute pipeline
  private skinningComputePipeline: GPUComputePipeline | null = null;
  private skinningComputeBindGroup: GPUBindGroup | null = null;
  private skinningComputeBindGroupLayout: GPUBindGroupLayout | null = null;
  private skinningUniformBuffer: GPUBuffer | null = null;
  private localPosBuffer: GPUBuffer | null = null;
  private localRotBuffer: GPUBuffer | null = null;
  private localScaleBuffer: GPUBuffer | null = null;
  private parentIndexBuffer: GPUBuffer | null = null;
  private inverseBindBuffer: GPUBuffer | null = null;
  private skinningBoneCount = 0;

  // Clothing pieces
  private clothingPieces: ClothingPiece[] = [];

  // Bindless: player material index + texture source id
  private playerMaterialIndex = 0;
  private playerTextureSourceId = "player:texture";
  private bindlessBindGroupSetThisFrame = false;

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(
    lightBindGroupLayout: GPUBindGroupLayout | null,
    pbrBindGroupLayout: GPUBindGroupLayout | null,
    bindlessBindGroupLayout: GPUBindGroupLayout | null = null,
  ): void {
    const device = this.ctx.device;
    const format = this.ctx.format;
    const uniformBuffer = this.ctx.uniformBuffer;

    const dev = device;

    // Register a default player material (white) in the bindless manager.
    const registry = this.ctx.bindlessRegistry;
    const matMgr = this.ctx.bindlessMaterialManager;
    if (registry && matMgr) {
      this.playerMaterialIndex = matMgr.registerMaterial({
        baseColor: [1, 1, 1, 1],
        roughness: 1,
        metallic: 0,
        emissiveIntensity: 0,
        albedoTexHandle: registry.defaultWhiteHandle,
        normalTexHandle: registry.defaultWhiteHandle,
        metallicRoughnessTexHandle: registry.defaultWhiteHandle,
        aoTexHandle: registry.defaultWhiteHandle,
        emissiveTexHandle: registry.defaultWhiteHandle,
      });
    }

    // Player pipeline — group 0 has only the uniform (bindless textures via @group(3))
    const playerShaderModule = dev.createShaderModule({ code: PLAYER_WGSL });
    const playerBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
      ],
    });
    this.playerBindGroupLayout = playerBindGroupLayout;
    this.playerBindGroup = dev.createBindGroup({
      layout: playerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer!, size: 256 } },
      ],
    });
    // Per-entity bind groups for native mode (no dynamic offset support)
    this.playerBindGroups = [];
    for (let i = 0; i < 512; i++) {
      this.playerBindGroups.push(dev.createBindGroup({
        layout: playerBindGroupLayout,
        entries: [{ binding: 0, resource: { buffer: uniformBuffer!, offset: i * 256, size: 256 } }],
      }));
    }
    this.playerPipeline = dev.createRenderPipeline({
      layout: dev.createPipelineLayout({
        bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
          ? bindlessBindGroupLayout
            ? [playerBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout, bindlessBindGroupLayout]
            : [playerBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout]
          : lightBindGroupLayout
            ? bindlessBindGroupLayout
              ? [playerBindGroupLayout, lightBindGroupLayout, dev.createBindGroupLayout({ entries: [] }), bindlessBindGroupLayout]
              : [playerBindGroupLayout, lightBindGroupLayout]
            : bindlessBindGroupLayout
              ? [playerBindGroupLayout, dev.createBindGroupLayout({ entries: [] }), dev.createBindGroupLayout({ entries: [] }), bindlessBindGroupLayout]
              : [playerBindGroupLayout],
      }),
      vertex: {
        module: playerShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 44,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x3" },
          ],
        }],
      },
      fragment: { module: playerShaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });

    // Skinned player pipeline — group 0 has uniform + bone storage (bindless textures via @group(3))
    const skinnedPlayerShaderModule = dev.createShaderModule({ code: SKINNED_PLAYER_WGSL });
    const skinnedPlayerBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    });
    this.skinnedPlayerBindGroupLayout = skinnedPlayerBindGroupLayout;
    this.boneMatrixBuffer = dev.createBuffer({
      size: MAX_BONES * 16 * 4,
      usage: GPUBufferUsage.STORAGE,
    });

    // Skinning compute pipeline
    const skinningComputeShaderModule = dev.createShaderModule({ code: SKINNING_COMPUTE_WGSL });
    const skinningComputeBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
      ],
    });
    this.skinningComputeBindGroupLayout = skinningComputeBindGroupLayout;
    this.skinningComputePipeline = dev.createComputePipeline({
      layout: dev.createPipelineLayout({ bindGroupLayouts: [skinningComputeBindGroupLayout] }),
      compute: { module: skinningComputeShaderModule, entryPoint: "cs_main" },
    });

    this.skinnedPlayerPipeline = dev.createRenderPipeline({
      layout: dev.createPipelineLayout({
        bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
          ? bindlessBindGroupLayout
            ? [skinnedPlayerBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout, bindlessBindGroupLayout]
            : [skinnedPlayerBindGroupLayout, lightBindGroupLayout, pbrBindGroupLayout]
          : lightBindGroupLayout
            ? bindlessBindGroupLayout
              ? [skinnedPlayerBindGroupLayout, lightBindGroupLayout, dev.createBindGroupLayout({ entries: [] }), bindlessBindGroupLayout]
              : [skinnedPlayerBindGroupLayout, lightBindGroupLayout]
            : bindlessBindGroupLayout
              ? [skinnedPlayerBindGroupLayout, dev.createBindGroupLayout({ entries: [] }), dev.createBindGroupLayout({ entries: [] }), bindlessBindGroupLayout]
              : [skinnedPlayerBindGroupLayout],
      }),
      vertex: {
        module: skinnedPlayerShaderModule,
        entryPoint: "vs_main",
        buffers: [{
          arrayStride: 64,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x3" },
            { shaderLocation: 4, offset: 44, format: "uint8x4" },
            { shaderLocation: 5, offset: 48, format: "float32x4" },
          ],
        }],
      },
      fragment: { module: skinnedPlayerShaderModule, entryPoint: "fs_main", targets: [{ format }] },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: { format: DEPTH_FORMAT, depthWriteEnabled: true, depthCompare: "less" },
    });
  }

  setPlayerMesh(meshes: MeshData[]): void {
    const device = this.ctx.device;
    const allVerts: number[] = [];
    const allIdx: number[] = [];
    let vertOffset = 0;

    for (const mesh of meshes) {
      const vCount = mesh.vertexCount;
      for (let i = 0; i < vCount; i++) {
        for (let j = 0; j < 6; j++) allVerts.push(mesh.vertices[i * 6 + j]);
        if (mesh.uvs) { allVerts.push(mesh.uvs[i * 2], mesh.uvs[i * 2 + 1]); }
        else { allVerts.push(0, 0); }
        if (mesh.colors) { allVerts.push(mesh.colors[i * 3], mesh.colors[i * 3 + 1], mesh.colors[i * 3 + 2]); }
        else { allVerts.push(1, 1, 1); }
      }
      for (let i = 0; i < mesh.indexCount; i++) allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      vertOffset += vCount;
    }

    const stride = 11;
    for (let i = 0; i < allVerts.length; i += stride) {
      const py = allVerts[i + 1], pz = allVerts[i + 2];
      allVerts[i + 1] = pz; allVerts[i + 2] = -py;
      const ny = allVerts[i + 4], nz = allVerts[i + 5];
      allVerts[i + 4] = nz; allVerts[i + 5] = -ny;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < allVerts.length; i += stride) {
      const x = allVerts[i], y = allVerts[i + 1], z = allVerts[i + 2];
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    const height = maxY - minY;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const scale = height > 0 ? 1.0 / height : 1.0;
    for (let i = 0; i < allVerts.length; i += stride) {
      allVerts[i] = (allVerts[i] - cx) * scale;
      allVerts[i + 1] = (allVerts[i + 1] - minY) * scale;
      allVerts[i + 2] = (allVerts[i + 2] - cz) * scale;
    }

    const vertexCount = allVerts.length / stride;
    const newNormals = new Float32Array(vertexCount * 3);
    for (let i = 0; i < allIdx.length; i += 3) {
      const a = allIdx[i], b = allIdx[i + 1], c = allIdx[i + 2];
      const ax = allVerts[a * stride], ay = allVerts[a * stride + 1], az = allVerts[a * stride + 2];
      const bx = allVerts[b * stride], by = allVerts[b * stride + 1], bz = allVerts[b * stride + 2];
      const cxv = allVerts[c * stride], cyv = allVerts[c * stride + 1], czv = allVerts[c * stride + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      newNormals[a * 3] += nx; newNormals[a * 3 + 1] += ny; newNormals[a * 3 + 2] += nz;
      newNormals[b * 3] += nx; newNormals[b * 3 + 1] += ny; newNormals[b * 3 + 2] += nz;
      newNormals[c * 3] += nx; newNormals[c * 3 + 1] += ny; newNormals[c * 3 + 2] += nz;
    }
    for (let i = 0; i < vertexCount; i++) {
      const nx = newNormals[i * 3], ny = newNormals[i * 3 + 1], nz = newNormals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      allVerts[i * stride + 3] = nx / len;
      allVerts[i * stride + 4] = ny / len;
      allVerts[i * stride + 5] = nz / len;
    }

    const vertArray = new Float32Array(allVerts);
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    this.playerMeshVertices = device.createBuffer({ size: vertArray.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.playerMeshVertices, 0, vertArray as any);
    this.playerMeshIndexFormat = useUint32 ? "uint32" : "uint16";
    this.playerMeshIndexCount = allIdx.length;
    this.playerMeshIndices = device.createBuffer({ size: idxArray.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.playerMeshIndices, 0, idxArray as any);
  }

  setSkinnedPlayerMesh(modelData: ModelData): void {
    const device = this.ctx.device;
    const uniformBuffer = this.ctx.uniformBuffer;
    if (!modelData.skin || !this.boneMatrixBuffer || !this.skinnedPlayerBindGroupLayout) {
      console.warn("[PlayerMeshRenderer] Cannot set skinned player mesh: missing skin data or pipeline");
      return;
    }

    const isYUp = modelData.format === "gltf" || modelData.format === "glb" || modelData.format === "fbx";
    this.skeletonAnimator = new SkeletonAnimator(modelData.skin);
    if (modelData.animations) this.skeletonAnimator.registerAnimations(modelData.animations);

    const meshes = modelData.meshes;
    const allVertCount = meshes.reduce((sum, m) => sum + m.vertexCount, 0);
    const stride = 64;
    const vertBuffer = new ArrayBuffer(allVertCount * stride);
    const f32View = new Float32Array(vertBuffer);
    const u8View = new Uint8Array(vertBuffer);
    const allIdx: number[] = [];
    let vertOffset = 0;
    let f32Offset = 0;

    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const vCount = mesh.vertexCount;
      for (let i = 0; i < vCount; i++) {
        const fOff = f32Offset + i * 16;
        if (isYUp) {
          f32View[fOff] = mesh.vertices[i * 6];
          f32View[fOff + 1] = mesh.vertices[i * 6 + 1];
          f32View[fOff + 2] = mesh.vertices[i * 6 + 2];
          f32View[fOff + 3] = mesh.vertices[i * 6 + 3];
          f32View[fOff + 4] = mesh.vertices[i * 6 + 4];
          f32View[fOff + 5] = mesh.vertices[i * 6 + 5];
        } else {
          f32View[fOff] = mesh.vertices[i * 6];
          f32View[fOff + 1] = mesh.vertices[i * 6 + 2];
          f32View[fOff + 2] = -mesh.vertices[i * 6 + 1];
          f32View[fOff + 3] = mesh.vertices[i * 6 + 3];
          f32View[fOff + 4] = mesh.vertices[i * 6 + 5];
          f32View[fOff + 5] = -mesh.vertices[i * 6 + 4];
        }
        if (mesh.uvs) { f32View[fOff + 6] = mesh.uvs[i * 2]; f32View[fOff + 7] = mesh.uvs[i * 2 + 1]; }
        else { f32View[fOff + 6] = 0; f32View[fOff + 7] = 0; }
        if (mesh.colors) { f32View[fOff + 8] = mesh.colors[i * 3]; f32View[fOff + 9] = mesh.colors[i * 3 + 1]; f32View[fOff + 10] = mesh.colors[i * 3 + 2]; }
        else { f32View[fOff + 8] = 1; f32View[fOff + 9] = 1; f32View[fOff + 10] = 1; }
        const byteOff = (f32Offset + i * 16) * 4 + 44;
        if (mesh.joints) {
          u8View[byteOff] = mesh.joints[i * 4];
          u8View[byteOff + 1] = mesh.joints[i * 4 + 1];
          u8View[byteOff + 2] = mesh.joints[i * 4 + 2];
          u8View[byteOff + 3] = mesh.joints[i * 4 + 3];
        }
        if (mesh.weights) {
          f32View[fOff + 12] = mesh.weights[i * 4];
          f32View[fOff + 13] = mesh.weights[i * 4 + 1];
          f32View[fOff + 14] = mesh.weights[i * 4 + 2];
          f32View[fOff + 15] = mesh.weights[i * 4 + 3];
        }
      }
      for (let i = 0; i < mesh.indexCount; i++) allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      vertOffset += vCount;
      f32Offset += vCount * 16;
    }

    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      const x = f32View[fOff], y = f32View[fOff + 1], z = f32View[fOff + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const height = maxY - minY;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const scale = height > 0 ? 1.0 / height : 1.0;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      f32View[fOff] = (f32View[fOff] - cx) * scale;
      f32View[fOff + 1] = (f32View[fOff + 1] - minY) * scale;
      f32View[fOff + 2] = (f32View[fOff + 2] - cz) * scale;
    }

    const normMat = new Float32Array(16);
    const invNormMat = new Float32Array(16);
    const invScale = 1.0 / scale;
    if (isYUp) {
      normMat[0] = scale; normMat[5] = scale; normMat[10] = scale;
      normMat[12] = -cx * scale; normMat[13] = -minY * scale; normMat[14] = -cz * scale; normMat[15] = 1;
      invNormMat[0] = invScale; invNormMat[5] = invScale; invNormMat[10] = invScale;
      invNormMat[12] = cx; invNormMat[13] = minY; invNormMat[14] = cz; invNormMat[15] = 1;
    } else {
      normMat[0] = scale; normMat[6] = -scale; normMat[9] = scale;
      normMat[12] = -cx * scale; normMat[13] = -minY * scale; normMat[14] = -cz * scale; normMat[15] = 1;
      invNormMat[0] = invScale; invNormMat[6] = invScale; invNormMat[9] = -invScale;
      invNormMat[12] = cx; invNormMat[13] = minY; invNormMat[14] = cz; invNormMat[15] = 1;
    }
    if (this.skeletonAnimator) this.skeletonAnimator.setNormalizationMatrix(normMat, invNormMat);

    // Recompute smooth normals
    const newNormals = new Float32Array(allVertCount * 3);
    for (let i = 0; i < allIdx.length; i += 3) {
      const a = allIdx[i], b = allIdx[i + 1], c = allIdx[i + 2];
      const ax = f32View[a * 16], ay = f32View[a * 16 + 1], az = f32View[a * 16 + 2];
      const bx = f32View[b * 16], by = f32View[b * 16 + 1], bz = f32View[b * 16 + 2];
      const cxv = f32View[c * 16], cyv = f32View[c * 16 + 1], czv = f32View[c * 16 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cxv - ax, vy = cyv - ay, vz = czv - az;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      newNormals[a * 3] += nx; newNormals[a * 3 + 1] += ny; newNormals[a * 3 + 2] += nz;
      newNormals[b * 3] += nx; newNormals[b * 3 + 1] += ny; newNormals[b * 3 + 2] += nz;
      newNormals[c * 3] += nx; newNormals[c * 3 + 1] += ny; newNormals[c * 3 + 2] += nz;
    }
    for (let i = 0; i < allVertCount; i++) {
      const nx = newNormals[i * 3], ny = newNormals[i * 3 + 1], nz = newNormals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      f32View[i * 16 + 3] = nx / len;
      f32View[i * 16 + 4] = ny / len;
      f32View[i * 16 + 5] = nz / len;
    }

    this.skinnedPlayerVertices = device.createBuffer({ size: vertBuffer.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.skinnedPlayerVertices, 0, vertBuffer as any);
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    this.skinnedPlayerIndexFormat = useUint32 ? "uint32" : "uint16";
    this.skinnedPlayerIndexCount = allIdx.length;
    this.skinnedPlayerIndices = device.createBuffer({ size: idxArray.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(this.skinnedPlayerIndices, 0, idxArray as any);

    this.skinnedPlayerBindGroup = device.createBindGroup({
      layout: this.skinnedPlayerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer!, size: 256 } },
        { binding: 3, resource: { buffer: this.boneMatrixBuffer! } },
      ],
    });
    // Per-entity bind groups for native mode (no dynamic offset support)
    this.skinnedPlayerBindGroups = [];
    for (let i = 0; i < 512; i++) {
      this.skinnedPlayerBindGroups.push(device.createBindGroup({
        layout: this.skinnedPlayerBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer!, offset: i * 256, size: 256 } },
          { binding: 3, resource: { buffer: this.boneMatrixBuffer! } },
        ],
      }));
    }

    if (this.skeletonAnimator) {
      const boneCount = this.skeletonAnimator.getBoneCount();
      this.skinningBoneCount = boneCount;
      const skinningUniformSize = 144;
      this.skinningUniformBuffer = device.createBuffer({ size: skinningUniformSize, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      this.localPosBuffer = device.createBuffer({ size: boneCount * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.localRotBuffer = device.createBuffer({ size: boneCount * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.localScaleBuffer = device.createBuffer({ size: boneCount * 4 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.parentIndexBuffer = device.createBuffer({ size: boneCount * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.inverseBindBuffer = device.createBuffer({ size: boneCount * 16 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });

      const parentIndices = this.skeletonAnimator.getParentIndices();
      const parentCopy = new Int32Array(parentIndices.length); parentCopy.set(parentIndices);
      device.queue.writeBuffer(this.parentIndexBuffer, 0, parentCopy.buffer as any);
      const inverseBind = this.skeletonAnimator.getInverseBindMatricesFlat();
      const ibmCopy = new Float32Array(inverseBind.length); ibmCopy.set(inverseBind);
      device.queue.writeBuffer(this.inverseBindBuffer, 0, ibmCopy.buffer as any);

      const nm = this.skeletonAnimator.getNormalizationMatrix();
      const inm = this.skeletonAnimator.getInverseNormalizationMatrix();
      const hasNorm = nm && inm ? 1 : 0;
      const uniformData = new ArrayBuffer(skinningUniformSize);
      const u32View = new Uint32Array(uniformData);
      const f32U = new Float32Array(uniformData);
      u32View[0] = boneCount; u32View[1] = hasNorm;
      if (nm) f32U.set(nm, 4);
      if (inm) f32U.set(inm, 20);
      device.queue.writeBuffer(this.skinningUniformBuffer, 0, uniformData);

      this.skinningComputeBindGroup = device.createBindGroup({
        layout: this.skinningComputeBindGroupLayout!,
        entries: [
          { binding: 0, resource: { buffer: this.skinningUniformBuffer! } },
          { binding: 1, resource: { buffer: this.localPosBuffer! } },
          { binding: 2, resource: { buffer: this.localRotBuffer! } },
          { binding: 3, resource: { buffer: this.localScaleBuffer! } },
          { binding: 4, resource: { buffer: this.parentIndexBuffer! } },
          { binding: 5, resource: { buffer: this.inverseBindBuffer! } },
          { binding: 6, resource: { buffer: this.boneMatrixBuffer! } },
        ],
      });

      this.skeletonAnimator.update(0, 0, 0);
      this.updateBoneLocalTransforms();
      const initEncoder = device.createCommandEncoder();
      this.dispatchSkinningCompute(initEncoder);
      device.queue.submit([initEncoder.finish()]);
    }

    console.log(`[PlayerMeshRenderer] Skinned player mesh loaded: ${allVertCount} vertices, ${allIdx.length} indices, ${modelData.skin?.bones.length ?? 0} bones`);
  }

  updateBoneLocalTransforms(): void {
    if (!this.skeletonAnimator || !this.localPosBuffer || !this.localRotBuffer || !this.localScaleBuffer) return;
    const device = this.ctx.device;
    const pos = this.skeletonAnimator.getLocalPosFlat();
    const rot = this.skeletonAnimator.getLocalRotFlat();
    const scale = this.skeletonAnimator.getLocalScaleFlat();
    const posCopy = new Float32Array(pos.length); posCopy.set(pos);
    const rotCopy = new Float32Array(rot.length); rotCopy.set(rot);
    const scaleCopy = new Float32Array(scale.length); scaleCopy.set(scale);
    device.queue.writeBuffer(this.localPosBuffer, 0, posCopy.buffer);
    device.queue.writeBuffer(this.localRotBuffer, 0, rotCopy.buffer);
    device.queue.writeBuffer(this.localScaleBuffer, 0, scaleCopy.buffer);
  }

  dispatchSkinningCompute(encoder: GPUCommandEncoder): void {
    if (!this.skinningComputePipeline || !this.skinningComputeBindGroup || this.skinningBoneCount === 0) return;
    const passEncoder = encoder.beginComputePass();
    passEncoder.setPipeline(this.skinningComputePipeline);
    passEncoder.setBindGroup(0, this.skinningComputeBindGroup);
    const workgroupCount = Math.ceil(this.skinningBoneCount / 64);
    passEncoder.dispatchWorkgroups(workgroupCount);
    passEncoder.end();
  }

  getSkeletonAnimator(): SkeletonAnimator | null {
    return this.skeletonAnimator;
  }

  addClothingPiece(name: string, modelData: ModelData): void {
    const device = this.ctx.device;
    if (!modelData.skin || !this.skinnedPlayerBindGroupLayout) {
      console.warn(`[PlayerMeshRenderer] Cannot add clothing piece "${name}": missing skin data or pipeline`);
      return;
    }

    const meshes = modelData.meshes;
    const allVertCount = meshes.reduce((sum, m) => sum + m.vertexCount, 0);
    const stride = 64;
    const vertBuffer = new ArrayBuffer(allVertCount * stride);
    const f32View = new Float32Array(vertBuffer);
    const u8View = new Uint8Array(vertBuffer);
    const allIdx: number[] = [];
    let vertOffset = 0;
    let f32Offset = 0;

    for (let mi = 0; mi < meshes.length; mi++) {
      const mesh = meshes[mi];
      const vCount = mesh.vertexCount;
      for (let i = 0; i < vCount; i++) {
        const fOff = f32Offset + i * 16;
        f32View[fOff] = mesh.vertices[i * 6];
        f32View[fOff + 1] = mesh.vertices[i * 6 + 2];
        f32View[fOff + 2] = -mesh.vertices[i * 6 + 1];
        f32View[fOff + 3] = mesh.vertices[i * 6 + 3];
        f32View[fOff + 4] = mesh.vertices[i * 6 + 5];
        f32View[fOff + 5] = -mesh.vertices[i * 6 + 4];
        if (mesh.uvs) { f32View[fOff + 6] = mesh.uvs[i * 2]; f32View[fOff + 7] = mesh.uvs[i * 2 + 1]; }
        if (mesh.colors) { f32View[fOff + 8] = mesh.colors[i * 3]; f32View[fOff + 9] = mesh.colors[i * 3 + 1]; f32View[fOff + 10] = mesh.colors[i * 3 + 2]; }
        else { f32View[fOff + 8] = 1; f32View[fOff + 9] = 1; f32View[fOff + 10] = 1; }
        const byteOff = (f32Offset + i * 16) * 4 + 44;
        if (mesh.joints && modelData.skin) {
          for (let j = 0; j < 4; j++) {
            const clothingBoneIdx = mesh.joints[i * 4 + j];
            const boneName = modelData.skin.bones[clothingBoneIdx]?.name ?? "";
            const mainBoneIdx = this.skeletonAnimator
              ? (this.skeletonAnimator as any).boneNameToIndex.get(boneName) ?? 0
              : 0;
            u8View[byteOff + j] = mainBoneIdx;
          }
        }
        if (mesh.weights) {
          f32View[fOff + 12] = mesh.weights[i * 4];
          f32View[fOff + 13] = mesh.weights[i * 4 + 1];
          f32View[fOff + 14] = mesh.weights[i * 4 + 2];
          f32View[fOff + 15] = mesh.weights[i * 4 + 3];
        }
      }
      for (let i = 0; i < mesh.indexCount; i++) allIdx.push((mesh.indices[i] >>> 0) + vertOffset);
      vertOffset += vCount;
      f32Offset += vCount * 16;
    }

    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      const x = f32View[fOff], y = f32View[fOff + 1], z = f32View[fOff + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }
    const height = maxY - minY;
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    const scale = height > 0 ? 1.0 / height : 1.0;
    for (let i = 0; i < allVertCount; i++) {
      const fOff = i * 16;
      f32View[fOff] = (f32View[fOff] - cx) * scale;
      f32View[fOff + 1] = (f32View[fOff + 1] - minY) * scale;
      f32View[fOff + 2] = (f32View[fOff + 2] - cz) * scale;
    }

    const newNormals = new Float32Array(allVertCount * 3);
    for (let i = 0; i < allIdx.length; i += 3) {
      const a = allIdx[i], b = allIdx[i + 1], c = allIdx[i + 2];
      const ux = f32View[b * 16] - f32View[a * 16], uy = f32View[b * 16 + 1] - f32View[a * 16 + 1], uz = f32View[b * 16 + 2] - f32View[a * 16 + 2];
      const vx = f32View[c * 16] - f32View[a * 16], vy = f32View[c * 16 + 1] - f32View[a * 16 + 1], vz = f32View[c * 16 + 2] - f32View[a * 16 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      newNormals[a * 3] += nx; newNormals[a * 3 + 1] += ny; newNormals[a * 3 + 2] += nz;
      newNormals[b * 3] += nx; newNormals[b * 3 + 1] += ny; newNormals[b * 3 + 2] += nz;
      newNormals[c * 3] += nx; newNormals[c * 3 + 1] += ny; newNormals[c * 3 + 2] += nz;
    }
    for (let i = 0; i < allVertCount; i++) {
      const nx = newNormals[i * 3], ny = newNormals[i * 3 + 1], nz = newNormals[i * 3 + 2];
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      f32View[i * 16 + 3] = nx / len;
      f32View[i * 16 + 4] = ny / len;
      f32View[i * 16 + 5] = nz / len;
    }

    const vertGPUBuffer = device.createBuffer({ size: vertBuffer.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(vertGPUBuffer, 0, vertBuffer as any);
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    const idxGPUBuffer = device.createBuffer({ size: idxArray.byteLength, usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(idxGPUBuffer, 0, idxArray as any);

    this.clothingPieces.push({
      name, vertices: vertGPUBuffer, indices: idxGPUBuffer,
      indexCount: allIdx.length, indexFormat: useUint32 ? "uint32" : "uint16",
      texture: null, visible: true,
    });
    console.log(`[PlayerMeshRenderer] Clothing piece "${name}" loaded: ${allVertCount} vertices, ${allIdx.length} indices`);
  }

  setPlayerTexture(image: ImageBitmap | HTMLImageElement): void {
    const registry = this.ctx.bindlessRegistry;
    const matMgr = this.ctx.bindlessMaterialManager;
    if (!registry || !matMgr) return;

    // Register/update the player texture in the bindless registry.
    const sourceId = this.playerTextureSourceId;
    const existing = registry.getRegistration(sourceId);
    let handle: number;
    if (existing) {
      // Update in place — dimensions must match.
      if (image instanceof ImageBitmap) {
        registry.updateFromImageBitmap(sourceId, image);
      }
      handle = existing.handle;
    } else {
      // Register new — only ImageBitmap is supported for bindless registration.
      if (image instanceof ImageBitmap) {
        const reg = registry.registerFromImageBitmap(sourceId, image, "rgba8unorm", 1);
        handle = reg.handle;
      } else {
        // For HTMLImageElement, create a temporary ImageBitmap.
        // Fallback: use default white texture.
        handle = registry.defaultWhiteHandle;
      }
    }

    // Update the player material to point at the real albedo texture.
    matMgr.updateMaterial(this.playerMaterialIndex, {
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      metallic: 0,
      emissiveIntensity: 0,
      albedoTexHandle: handle,
      normalTexHandle: registry.defaultWhiteHandle,
      metallicRoughnessTexHandle: registry.defaultWhiteHandle,
      aoTexHandle: registry.defaultWhiteHandle,
      emissiveTexHandle: registry.defaultWhiteHandle,
    });
  }

  /** Set the bindless bind group for the frame. Called once per frame by the host. */
  setBindlessBindGroup(bg: GPUBindGroup | null): void {
    if (bg && !this.bindlessBindGroupSetThisFrame) {
      // The bind group is set on the pass encoder in the render methods.
      this.bindlessBindGroupSetThisFrame = false; // will be set in render
    }
    this._pendingBindlessBg = bg;
  }
  private _pendingBindlessBg: GPUBindGroup | null = null;

  private ensureBindlessBound(passEncoder: GPURenderPassEncoder): void {
    if (this._pendingBindlessBg && !this.bindlessBindGroupSetThisFrame) {
      passEncoder.setBindGroup(3, this._pendingBindlessBg);
      this.bindlessBindGroupSetThisFrame = true;
    }
  }

  /** Reset per-frame state. Called by the host at the start of each frame. */
  beginFrame(): void {
    this.bindlessBindGroupSetThisFrame = false;
  }

  renderSkinnedPlayer(passEncoder: GPURenderPassEncoder, idx: number): number {
    if (!this.skinnedPlayerVertices || !this.skinnedPlayerIndices || !this.skinnedPlayerPipeline || !this.skinnedPlayerBindGroup) return 0;
    this.ensureBindlessBound(passEncoder);
    // Write materialIndex into the uniform slot (float 44 = byte offset 176).
    this.writeMaterialIndex(idx);
    let tris = 0;
    passEncoder.setPipeline(this.skinnedPlayerPipeline);
    const sBg = this.skinnedPlayerBindGroups[idx] ?? this.skinnedPlayerBindGroup;
    if (this.skinnedPlayerBindGroups.length > 0) passEncoder.setBindGroup(0, sBg);
    else passEncoder.setBindGroup(0, sBg, [idx * 256]);
    passEncoder.setVertexBuffer(0, this.skinnedPlayerVertices);
    passEncoder.setIndexBuffer(this.skinnedPlayerIndices, this.skinnedPlayerIndexFormat);
    passEncoder.drawIndexed(this.skinnedPlayerIndexCount);
    tris += Math.floor(this.skinnedPlayerIndexCount / 3);
    for (let ci = 0; ci < this.clothingPieces.length; ci++) {
      const piece = this.clothingPieces[ci];
      if (!piece.visible) continue;
      passEncoder.setVertexBuffer(0, piece.vertices);
      passEncoder.setIndexBuffer(piece.indices, piece.indexFormat);
      passEncoder.drawIndexed(piece.indexCount);
      tris += Math.floor(piece.indexCount / 3);
    }
    return tris;
  }

  renderStaticPlayer(passEncoder: GPURenderPassEncoder, idx: number): number {
    if (!this.playerMeshVertices || !this.playerMeshIndices || !this.playerPipeline || !this.playerBindGroup) return 0;
    this.ensureBindlessBound(passEncoder);
    this.writeMaterialIndex(idx);
    passEncoder.setPipeline(this.playerPipeline);
    const pBg = this.playerBindGroups[idx] ?? this.playerBindGroup;
    if (this.playerBindGroups.length > 0) passEncoder.setBindGroup(0, pBg);
    else passEncoder.setBindGroup(0, pBg, [idx * 256]);
    passEncoder.setVertexBuffer(0, this.playerMeshVertices);
    passEncoder.setIndexBuffer(this.playerMeshIndices, this.playerMeshIndexFormat);
    passEncoder.drawIndexed(this.playerMeshIndexCount);
    return Math.floor(this.playerMeshIndexCount / 3);
  }

  /** Write the player materialIndex into the entity uniform slot (float 44). */
  private writeMaterialIndex(idx: number): void {
    if (!this.ctx.uniformBuffer) return;
    const buf = new Float32Array(1);
    buf[0] = this.playerMaterialIndex;
    this.ctx.device.queue.writeBuffer(
      this.ctx.uniformBuffer,
      idx * 256 + 44 * 4,
      buf as Float32Array<ArrayBuffer>,
    );
  }

  hasSkinnedMesh(): boolean {
    return this.skinnedPlayerVertices !== null && this.skinnedPlayerPipeline !== null && this.skinnedPlayerBindGroup !== null;
  }

  hasStaticMesh(): boolean {
    return this.playerMeshVertices !== null && this.playerPipeline !== null && this.playerBindGroup !== null;
  }
}
