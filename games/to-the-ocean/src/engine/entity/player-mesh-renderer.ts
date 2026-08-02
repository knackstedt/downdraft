import type { BackendBindGroup, BackendBindGroupLayout, BackendBuffer, BackendRenderPassEncoder, BackendRenderPipeline, BackendSampler, BackendTexture } from "@downdraft/core/render/backend/types";
import type { MeshData, ModelData } from "@downdraft/plugin-models";
import { MAX_BONES } from "@shared/constants";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "../graphicsConfig";
import { PLAYER_WGSL, SKINNED_PLAYER_WGSL, SKINNING_COMPUTE_WGSL } from "../shaders/entity-shaders";
import { SkeletonAnimator } from "../SkeletonAnimator";
import type { EntityRenderContext } from "./render-context";

interface ClothingPiece {
  name: string;
  vertices: GPUBuffer | BackendBuffer;
  indices: GPUBuffer | BackendBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  texture: GPUTexture | BackendTexture | null;
  visible: boolean;
}

export class PlayerMeshRenderer {
  private ctx: EntityRenderContext;

  // Static player mesh
  private playerMeshVertices: GPUBuffer | BackendBuffer | null = null;
  private playerMeshIndices: GPUBuffer | BackendBuffer | null = null;
  private playerMeshIndexCount = 0;
  private playerMeshIndexFormat: GPUIndexFormat = "uint16";
  playerPipeline: GPURenderPipeline | BackendRenderPipeline | null = null;
  playerBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private playerBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;
  private playerTexture: GPUTexture | BackendTexture | null = null;
  private playerSampler: GPUSampler | BackendSampler | null = null;

  // Skinned player mesh
  private skinnedPlayerVertices: GPUBuffer | BackendBuffer | null = null;
  private skinnedPlayerIndices: GPUBuffer | BackendBuffer | null = null;
  private skinnedPlayerIndexCount = 0;
  private skinnedPlayerIndexFormat: GPUIndexFormat = "uint16";
  skinnedPlayerPipeline: GPURenderPipeline | BackendRenderPipeline | null = null;
  skinnedPlayerBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  skinnedPlayerBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;
  private boneMatrixBuffer: GPUBuffer | BackendBuffer | null = null;
  private skeletonAnimator: SkeletonAnimator | null = null;

  // GPU skinning compute pipeline
  private skinningComputePipeline: GPUComputePipeline | null = null;
  private skinningComputeBindGroup: GPUBindGroup | BackendBindGroup | null = null;
  private skinningComputeBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null = null;
  private skinningUniformBuffer: GPUBuffer | BackendBuffer | null = null;
  private localPosBuffer: GPUBuffer | BackendBuffer | null = null;
  private localRotBuffer: GPUBuffer | BackendBuffer | null = null;
  private localScaleBuffer: GPUBuffer | BackendBuffer | null = null;
  private parentIndexBuffer: GPUBuffer | BackendBuffer | null = null;
  private inverseBindBuffer: GPUBuffer | BackendBuffer | null = null;
  private skinningBoneCount = 0;

  // Clothing pieces
  private clothingPieces: ClothingPiece[] = [];

  constructor(ctx: EntityRenderContext) {
    this.ctx = ctx;
  }

  init(lightBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null, pbrBindGroupLayout: GPUBindGroupLayout | BackendBindGroupLayout | null): void {
    const device = this.ctx.device;
    const backend = this.ctx.backend;
    const format = this.ctx.format;
    const uniformBuffer = this.ctx.uniformBuffer;

    if (backend && !device) {
      const playerShaderModule = backend.createShaderModule({ wgsl: PLAYER_WGSL }, "wgsl");
      const playerBindGroupLayout = backend.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x3, buffer: { type: "uniform", hasDynamicOffset: true } },
          { binding: 1, visibility: 0x8, sampler: { type: "filtering" } },
          { binding: 2, visibility: 0x8, texture: { sampleType: "float" } },
        ],
      });
      this.playerBindGroupLayout = playerBindGroupLayout;
      this.playerSampler = backend.createSampler({
        magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
        addressModeU: "repeat", addressModeV: "repeat",
      });
      this.playerTexture = backend.createTexture({
        size: [1, 1], format: "rgba8unorm",
        usage: 0x8 | 0x4,
      });
      backend.queue.writeTexture(
        { texture: this.playerTexture as any },
        new Uint8Array([255, 255, 255, 255]),
        { bytesPerRow: 4 },
        { width: 1, height: 1 },
      );
      this.playerBindGroup = backend.createBindGroup({
        layout: playerBindGroupLayout as any,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer! as any, size: 256 } },
          { binding: 1, resource: this.playerSampler as any },
          { binding: 2, resource: (this.playerTexture as any).createView() as any },
        ],
      });
      this.playerPipeline = backend.createRenderPipeline({
        layout: backend.createPipelineLayout({
          bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
            ? [playerBindGroupLayout as any, lightBindGroupLayout as any, pbrBindGroupLayout as any]
            : lightBindGroupLayout
              ? [playerBindGroupLayout as any, lightBindGroupLayout as any]
              : [playerBindGroupLayout as any],
        }) as any,
        vertex: {
          module: playerShaderModule, entryPoint: "vs_main",
          buffers: [{ arrayStride: 44, attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x3" },
          ]}],
        },
        fragment: { module: playerShaderModule, entryPoint: "fs_main", targets: [{ format: format as any }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: MSAA_SAMPLE_COUNT },
        depthStencil: { format: DEPTH_FORMAT as any, depthWriteEnabled: true, depthCompare: "less" },
      });

      // Skinned player pipeline (no compute skinning in WebGL2 — CPU skinning fallback)
      const skinnedPlayerShaderModule = backend.createShaderModule({ wgsl: SKINNED_PLAYER_WGSL }, "wgsl");
      const skinnedPlayerBindGroupLayout = backend.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: 0x3, buffer: { type: "uniform", hasDynamicOffset: true } },
          { binding: 1, visibility: 0x8, sampler: { type: "filtering" } },
          { binding: 2, visibility: 0x8, texture: { sampleType: "float" } },
          { binding: 3, visibility: 0x1, buffer: { type: "read-only-storage" } },
        ],
      });
      this.skinnedPlayerBindGroupLayout = skinnedPlayerBindGroupLayout;
      this.boneMatrixBuffer = backend.createBuffer({ size: MAX_BONES * 16 * 4, usage: 0x80 });

      this.skinnedPlayerPipeline = backend.createRenderPipeline({
        layout: backend.createPipelineLayout({
          bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
            ? [skinnedPlayerBindGroupLayout as any, lightBindGroupLayout as any, pbrBindGroupLayout as any]
            : lightBindGroupLayout
              ? [skinnedPlayerBindGroupLayout as any, lightBindGroupLayout as any]
              : [skinnedPlayerBindGroupLayout as any],
        }) as any,
        vertex: {
          module: skinnedPlayerShaderModule, entryPoint: "vs_main",
          buffers: [{ arrayStride: 64, attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x3" },
            { shaderLocation: 1, offset: 12, format: "float32x3" },
            { shaderLocation: 2, offset: 24, format: "float32x2" },
            { shaderLocation: 3, offset: 32, format: "float32x3" },
            { shaderLocation: 4, offset: 44, format: "uint8x4" },
            { shaderLocation: 5, offset: 48, format: "float32x4" },
          ]}],
        },
        fragment: { module: skinnedPlayerShaderModule, entryPoint: "fs_main", targets: [{ format: format as any }] },
        primitive: { topology: "triangle-list" },
        multisample: { count: MSAA_SAMPLE_COUNT },
        depthStencil: { format: DEPTH_FORMAT as any, depthWriteEnabled: true, depthCompare: "less" },
      });
      return;
    }

    const dev = device!;

    // Player textured pipeline
    const playerShaderModule = dev.createShaderModule({ code: PLAYER_WGSL });
    const playerBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });
    this.playerBindGroupLayout = playerBindGroupLayout;
    this.playerSampler = dev.createSampler({
      magFilter: "linear", minFilter: "linear", mipmapFilter: "linear",
      addressModeU: "repeat", addressModeV: "repeat",
    });
    this.playerTexture = dev.createTexture({
      size: [1, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    dev.queue.writeTexture(
      { texture: this.playerTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      { width: 1, height: 1 },
    );
    this.playerBindGroup = dev.createBindGroup({
      layout: playerBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer! as any, size: 256 } },
        { binding: 1, resource: this.playerSampler as any },
        { binding: 2, resource: this.playerTexture!.createView() as any },
      ],
    });
    this.playerPipeline = dev.createRenderPipeline({
      layout: dev.createPipelineLayout({
        bindGroupLayouts: (lightBindGroupLayout && pbrBindGroupLayout)
          ? [playerBindGroupLayout, lightBindGroupLayout as any, pbrBindGroupLayout as any]
          : lightBindGroupLayout
            ? [playerBindGroupLayout, lightBindGroupLayout as any]
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

    // Skinned player pipeline
    const skinnedPlayerShaderModule = dev.createShaderModule({ code: SKINNED_PLAYER_WGSL });
    const skinnedPlayerBindGroupLayout = dev.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", hasDynamicOffset: true } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
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
          ? [skinnedPlayerBindGroupLayout, lightBindGroupLayout as any, pbrBindGroupLayout as any]
          : lightBindGroupLayout
            ? [skinnedPlayerBindGroupLayout, lightBindGroupLayout as any]
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
    const device = this.ctx.device ?? this.ctx.backend as any;
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
    this.playerMeshVertices = device.createBuffer({ size: vertArray.byteLength, usage: this.ctx.device ? (GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST) : (0x20 | 0x08) });
    device.queue.writeBuffer(this.playerMeshVertices as any, 0, vertArray as any);
    this.playerMeshIndexFormat = useUint32 ? "uint32" : "uint16";
    this.playerMeshIndexCount = allIdx.length;
    this.playerMeshIndices = device.createBuffer({ size: idxArray.byteLength, usage: this.ctx.device ? (GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST) : (0x10 | 0x08) });
    device.queue.writeBuffer(this.playerMeshIndices as any, 0, idxArray as any);
  }

  setSkinnedPlayerMesh(modelData: ModelData): void {
    const device = this.ctx.device ?? this.ctx.backend as any;
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

    const isWebGPU = !!this.ctx.device;
    const vertUsage = isWebGPU ? (GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST) : (0x20 | 0x08);
    const idxUsage = isWebGPU ? (GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST) : (0x10 | 0x08);
    this.skinnedPlayerVertices = device.createBuffer({ size: vertBuffer.byteLength, usage: vertUsage });
    device.queue.writeBuffer(this.skinnedPlayerVertices as any, 0, vertBuffer as any);
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    this.skinnedPlayerIndexFormat = useUint32 ? "uint32" : "uint16";
    this.skinnedPlayerIndexCount = allIdx.length;
    this.skinnedPlayerIndices = device.createBuffer({ size: idxArray.byteLength, usage: idxUsage });
    device.queue.writeBuffer(this.skinnedPlayerIndices as any, 0, idxArray as any);

    this.skinnedPlayerBindGroup = device.createBindGroup({
      layout: this.skinnedPlayerBindGroupLayout as any,
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer! as any, size: 256 } },
        { binding: 1, resource: this.playerSampler! as any },
        { binding: 2, resource: this.playerTexture!.createView() as any },
        { binding: 3, resource: { buffer: this.boneMatrixBuffer! as any } },
      ],
    });

    if (this.skeletonAnimator) {
      const boneCount = this.skeletonAnimator.getBoneCount();
      this.skinningBoneCount = boneCount;
      const skinningUniformSize = 144;
      this.skinningUniformBuffer = device.createBuffer({ size: skinningUniformSize, usage: isWebGPU ? (GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST) : (0x40 | 0x08) });
      this.localPosBuffer = device.createBuffer({ size: boneCount * 4 * 4, usage: isWebGPU ? (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) : (0x80 | 0x08) });
      this.localRotBuffer = device.createBuffer({ size: boneCount * 4 * 4, usage: isWebGPU ? (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) : (0x80 | 0x08) });
      this.localScaleBuffer = device.createBuffer({ size: boneCount * 4 * 4, usage: isWebGPU ? (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) : (0x80 | 0x08) });
      this.parentIndexBuffer = device.createBuffer({ size: boneCount * 4, usage: isWebGPU ? (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) : (0x80 | 0x08) });
      this.inverseBindBuffer = device.createBuffer({ size: boneCount * 16 * 4, usage: isWebGPU ? (GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST) : (0x80 | 0x08) });

      const parentIndices = this.skeletonAnimator.getParentIndices();
      const parentCopy = new Int32Array(parentIndices.length); parentCopy.set(parentIndices);
      device.queue.writeBuffer(this.parentIndexBuffer as any, 0, parentCopy.buffer as any);
      const inverseBind = this.skeletonAnimator.getInverseBindMatricesFlat();
      const ibmCopy = new Float32Array(inverseBind.length); ibmCopy.set(inverseBind);
      device.queue.writeBuffer(this.inverseBindBuffer as any, 0, ibmCopy.buffer as any);

      const nm = this.skeletonAnimator.getNormalizationMatrix();
      const inm = this.skeletonAnimator.getInverseNormalizationMatrix();
      const hasNorm = nm && inm ? 1 : 0;
      const uniformData = new ArrayBuffer(skinningUniformSize);
      const u32View = new Uint32Array(uniformData);
      const f32U = new Float32Array(uniformData);
      u32View[0] = boneCount; u32View[1] = hasNorm;
      if (nm) f32U.set(nm, 4);
      if (inm) f32U.set(inm, 20);
      device.queue.writeBuffer(this.skinningUniformBuffer as any, 0, uniformData);

      this.skinningComputeBindGroup = device.createBindGroup({
        layout: this.skinningComputeBindGroupLayout! as any,
        entries: [
          { binding: 0, resource: { buffer: this.skinningUniformBuffer! as any } },
          { binding: 1, resource: { buffer: this.localPosBuffer! as any } },
          { binding: 2, resource: { buffer: this.localRotBuffer! as any } },
          { binding: 3, resource: { buffer: this.localScaleBuffer! as any } },
          { binding: 4, resource: { buffer: this.parentIndexBuffer! as any } },
          { binding: 5, resource: { buffer: this.inverseBindBuffer! as any } },
          { binding: 6, resource: { buffer: this.boneMatrixBuffer! as any } },
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
    const device = this.ctx.device ?? this.ctx.backend as any;
    const pos = this.skeletonAnimator.getLocalPosFlat();
    const rot = this.skeletonAnimator.getLocalRotFlat();
    const scale = this.skeletonAnimator.getLocalScaleFlat();
    const posCopy = new Float32Array(pos.length); posCopy.set(pos);
    const rotCopy = new Float32Array(rot.length); rotCopy.set(rot);
    const scaleCopy = new Float32Array(scale.length); scaleCopy.set(scale);
    device.queue.writeBuffer(this.localPosBuffer as any, 0, posCopy.buffer);
    device.queue.writeBuffer(this.localRotBuffer as any, 0, rotCopy.buffer);
    device.queue.writeBuffer(this.localScaleBuffer as any, 0, scaleCopy.buffer);
  }

  dispatchSkinningCompute(encoder: GPUCommandEncoder | import("@downdraft/core/render/backend/types").BackendCommandEncoder): void {
    if (!this.skinningComputePipeline || !this.skinningComputeBindGroup || this.skinningBoneCount === 0) return;
    const passEncoder = encoder.beginComputePass();
    passEncoder.setPipeline(this.skinningComputePipeline as any);
    passEncoder.setBindGroup(0, this.skinningComputeBindGroup as any);
    const workgroupCount = Math.ceil(this.skinningBoneCount / 64);
    passEncoder.dispatchWorkgroups(workgroupCount);
    passEncoder.end();
  }

  getSkeletonAnimator(): SkeletonAnimator | null {
    return this.skeletonAnimator;
  }

  addClothingPiece(name: string, modelData: ModelData): void {
    const device = this.ctx.device ?? this.ctx.backend as any;
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

    const isWebGPU = !!this.ctx.device;
    const vertGPUBuffer = device.createBuffer({ size: vertBuffer.byteLength, usage: isWebGPU ? (GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST) : (0x20 | 0x08) });
    device.queue.writeBuffer(vertGPUBuffer as any, 0, vertBuffer as any);
    const useUint32 = allIdx.length > 65535 || vertOffset > 65535;
    const idxArray = useUint32 ? new Uint32Array(allIdx) : new Uint16Array(allIdx);
    const idxGPUBuffer = device.createBuffer({ size: idxArray.byteLength, usage: isWebGPU ? (GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST) : (0x10 | 0x08) });
    device.queue.writeBuffer(idxGPUBuffer as any, 0, idxArray as any);

    this.clothingPieces.push({
      name, vertices: vertGPUBuffer, indices: idxGPUBuffer,
      indexCount: allIdx.length, indexFormat: useUint32 ? "uint32" : "uint16",
      texture: null, visible: true,
    });
    console.log(`[PlayerMeshRenderer] Clothing piece "${name}" loaded: ${allVertCount} vertices, ${allIdx.length} indices`);
  }

  setPlayerTexture(image: ImageBitmap | HTMLImageElement): void {
    const device = this.ctx.device ?? this.ctx.backend as any;
    const uniformBuffer = this.ctx.uniformBuffer;
    if (this.playerTexture) this.playerTexture.destroy();
    this.playerTexture = device.createTexture({
      size: [image.width, image.height], format: "rgba8unorm",
      usage: this.ctx.device ? (GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT) : (0x8 | 0x4 | 0x10),
    });
    device.queue.copyExternalImageToTexture(
      { source: image as any },
      { texture: this.playerTexture as any },
      [image.width, image.height],
    );
    if (this.playerBindGroupLayout && this.playerSampler && uniformBuffer) {
      this.playerBindGroup = device.createBindGroup({
        layout: this.playerBindGroupLayout as any,
        entries: [
          { binding: 0, resource: { buffer: uniformBuffer as any, size: 256 } },
          { binding: 1, resource: this.playerSampler as any },
          { binding: 2, resource: this.playerTexture!.createView() as any },
        ],
      });
    }
  }

  renderSkinnedPlayer(passEncoder: GPURenderPassEncoder | BackendRenderPassEncoder, idx: number): number {
    if (!this.skinnedPlayerVertices || !this.skinnedPlayerIndices || !this.skinnedPlayerPipeline || !this.skinnedPlayerBindGroup) return 0;
    let tris = 0;
    passEncoder.setPipeline(this.skinnedPlayerPipeline as any);
    passEncoder.setBindGroup(0, this.skinnedPlayerBindGroup as any, [idx * 256]);
    passEncoder.setVertexBuffer(0, this.skinnedPlayerVertices as any);
    passEncoder.setIndexBuffer(this.skinnedPlayerIndices as any, this.skinnedPlayerIndexFormat);
    passEncoder.drawIndexed(this.skinnedPlayerIndexCount);
    tris += Math.floor(this.skinnedPlayerIndexCount / 3);
    for (let ci = 0; ci < this.clothingPieces.length; ci++) {
      const piece = this.clothingPieces[ci];
      if (!piece.visible) continue;
      passEncoder.setVertexBuffer(0, piece.vertices as any);
      passEncoder.setIndexBuffer(piece.indices as any, piece.indexFormat);
      passEncoder.drawIndexed(piece.indexCount);
      tris += Math.floor(piece.indexCount / 3);
    }
    return tris;
  }

  renderStaticPlayer(passEncoder: GPURenderPassEncoder | BackendRenderPassEncoder, idx: number): number {
    if (!this.playerMeshVertices || !this.playerMeshIndices || !this.playerPipeline || !this.playerBindGroup) return 0;
    passEncoder.setPipeline(this.playerPipeline as any);
    passEncoder.setBindGroup(0, this.playerBindGroup as any, [idx * 256]);
    passEncoder.setVertexBuffer(0, this.playerMeshVertices as any);
    passEncoder.setIndexBuffer(this.playerMeshIndices as any, this.playerMeshIndexFormat);
    passEncoder.drawIndexed(this.playerMeshIndexCount);
    return Math.floor(this.playerMeshIndexCount / 3);
  }

  hasSkinnedMesh(): boolean {
    return this.skinnedPlayerVertices !== null && this.skinnedPlayerPipeline !== null && this.skinnedPlayerBindGroup !== null;
  }

  hasStaticMesh(): boolean {
    return this.playerMeshVertices !== null && this.playerPipeline !== null && this.playerBindGroup !== null;
  }
}
