// ============================================================================
// Model Renderer — renders imported 3D models (FBX/GLTF/OBJ) via WebGPU
//
// Bindless binding model: per-draw material data lives in a shared material
// SSBO (@group(3)), indexed by a `materialIndex` written into the per-draw
// uniform struct (@group(0)). Textures are registered into the
// BindlessTextureRegistry's texture_2d_array buckets. The bindless bind group
// (@group(3)) is set once per frame by the caller (via setBindlessBindGroup)
// — no per-draw bind-group creation or texture bind-group churn.
// ============================================================================

import {
    calculateViewProj,
    createLogger,
    DEPTH_FORMAT,
    MSAA_SAMPLE_COUNT,
    type BindlessMaterialManager,
    type BindlessTextureRegistry,
    type CameraState,
    type MaterialParams,
} from "@downdraft/core";
import type { MaterialData, MeshData } from "@downdraft/library-models";
import MODEL_WGSL from "./shaders/model.wgsl?raw";

const log = createLogger();


interface ModelGPUResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  uniformOffset: number;
  materialIndex: number;
  // Skinning (optional): second vertex buffer with joints+weights, and a flag
  // to select the skinned pipeline + skin-matrix bind group.
  skinVertexBuffer?: GPUBuffer;
  skinned: boolean;
}

export interface ModelRendererBindlessDeps {
  registry: BindlessTextureRegistry;
  materialManager: BindlessMaterialManager;
  /** Bind group layout for @group(3) bindless resources. */
  bindGroupLayout: GPUBindGroupLayout;
}

export class ModelRenderer {
  private device: GPUDevice;
  private format: GPUTextureFormat;
  private pipeline: GPURenderPipeline | null = null;
  private bindGroupLayout: GPUBindGroupLayout | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;

  private static readonly MAX_MODELS = 256;
  private static readonly UNIFORM_SIZE = 256; // 64 floats, padded to 256
  /** Initial bone buffer capacity. Grows dynamically when larger skeletons are loaded. */
  private static readonly INITIAL_BONE_CAPACITY = 256;

  private modelResources: Map<string, ModelGPUResources[]> = new Map();
  // Per-model instance uniform base offsets. Key = nodeId, value = array of
  // base offsets (in bytes) for each instance. Instance 0 uses the original
  // offsets from modelResources; instances 1+ use allocated offsets from here.
  private modelInstanceOffsets: Map<string, number[]> = new Map();
  private viewProjCache: Float32Array | null = null;
  private cameraPosCache: [number, number, number] = [0, 0, 0];
  // Light state for the fragment shader (defaults match the old hardcoded values).
  // lightDir is in world space (does not need to be normalized — the shader normalizes).
  private lightDirCache: [number, number, number] = [0.5, 0.8, 0.3];
  private lightAmbientCache = 0.5;
  private lightIntensityCache = 0.5;
  private nextUniformOffset = 0;
  private reusableUniforms = new Float32Array(64);
  private reusableUniformsU32 = new Uint32Array(this.reusableUniforms.buffer);
  private textureLoadVersion = new Map<string, number>();

  // Skinning: a shared storage buffer of bone matrices (MAX_BONES * mat4),
  // updated per-frame via updateSkinMatrices. Bound at @group(1) for skinned
  // draws only.
  private skinMatrixBuffer: GPUBuffer | null = null;
  private skinBindGroupLayout: GPUBindGroupLayout | null = null;
  private skinBindGroup: GPUBindGroup | null = null;
  private skinnedPipeline: GPURenderPipeline | null = null;
  private skinBindGroupSetThisFrame = false;
  /** Current bone capacity (number of mat4s the skin buffer can hold). Grows on demand. */
  private boneCapacity = ModelRenderer.INITIAL_BONE_CAPACITY;

  // Bindless deps
  private bindless: ModelRendererBindlessDeps | null = null;
  private bindlessLayout: GPUBindGroupLayout | null = null;
  private bindlessBindGroup: GPUBindGroup | null = null;
  private bindlessBindGroupSetThisFrame = false;
  /** materialIndex for the default white material (albedo = default white layer). */
  private defaultMaterialIndex = 0;
  /** Composite key `${nodeId}:${matIdx}` → bindless materialIndex, so reupload reuses the same slot. */
  private meshMaterialIndex = new Map<string, number>();
  /** Composite key `${nodeId}:${matIdx}` → texture sourceId (used for async update + cleanup). */
  private meshTextureSourceId = new Map<string, string>();

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  /** Provide the bindless texture registry + material manager. Required before init. */
  setBindlessDeps(deps: ModelRendererBindlessDeps): void {
    this.bindless = deps;
    this.bindlessLayout = deps.bindGroupLayout;
    // Register a default white material (all texture slots → default white handle).
    this.defaultMaterialIndex = deps.materialManager.registerMaterial({
      baseColor: [1, 1, 1, 1],
      roughness: 1,
      metallic: 0,
      emissiveIntensity: 0,
      albedoTexHandle: deps.registry.defaultWhiteHandle,
      normalTexHandle: deps.registry.defaultWhiteHandle,
      metallicRoughnessTexHandle: deps.registry.defaultWhiteHandle,
      aoTexHandle: deps.registry.defaultWhiteHandle,
      emissiveTexHandle: deps.registry.defaultWhiteHandle,
    });
  }

  /** Set the shared bindless bind group (@group(3)) for the frame. */
  setBindlessBindGroup(bg: GPUBindGroup | null): void {
    this.bindlessBindGroup = bg;
    this.bindlessBindGroupSetThisFrame = false;
  }

  async init(): Promise<void> {
    this.uniformBuffer = this.device.createBuffer({
      size: ModelRenderer.MAX_MODELS * ModelRenderer.UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Explicit bind group layout for group(0) — per-draw uniform with
    // hasDynamicOffset so we can index into the uniform buffer per instance.
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform", hasDynamicOffset: true },
        },
      ],
    });

    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer, size: ModelRenderer.UNIFORM_SIZE } },
      ],
    });

    const shaderModule = this.device.createShaderModule({ code: MODEL_WGSL });
    // Explicit pipeline layout: group(0) = per-draw uniform (dynamic offset),
    // group(3) = bindless materials SSBO + texture arrays. Groups 1 and 2
    // are unused by the model shader but reserved as empty layouts.
    const emptyLayout = this.device.createBindGroupLayout({ entries: [] });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout, emptyLayout, emptyLayout, this.bindlessLayout],
    });
    this.pipeline = this.device.createRenderPipeline({
      layout: pipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_main",
        buffers: [
          {
            arrayStride: 44, // pos3 + normal3 + uv2 + color3 = 11 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x3" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });

    // ── Skinning resources ──
    // Shared storage buffer for bone matrices. Starts at INITIAL_BONE_CAPACITY
    // and grows on demand when larger skeletons are loaded.
    this.skinMatrixBuffer = this.device.createBuffer({
      size: this.boneCapacity * 64, // mat4x4 = 64 bytes
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Bind group layout for @group(1): a single read-only storage buffer.
    this.skinBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX,
          buffer: { type: "read-only-storage" },
        },
      ],
    });

    this.skinBindGroup = this.device.createBindGroup({
      layout: this.skinBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.skinMatrixBuffer } }],
    });

    // Skinned pipeline: same pipeline layout (group 1 is now the skin layout
    // instead of an empty layout), with a second vertex buffer for joints +
    // weights and the vs_skinned entry point.
    const skinnedPipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout, this.skinBindGroupLayout, emptyLayout, this.bindlessLayout],
    });
    this.skinnedPipeline = this.device.createRenderPipeline({
      layout: skinnedPipelineLayout,
      vertex: {
        module: shaderModule,
        entryPoint: "vs_skinned",
        buffers: [
          {
            arrayStride: 44, // pos3 + normal3 + uv2 + color3 = 11 floats
            attributes: [
              { shaderLocation: 0, offset: 0, format: "float32x3" },
              { shaderLocation: 1, offset: 12, format: "float32x3" },
              { shaderLocation: 2, offset: 24, format: "float32x2" },
              { shaderLocation: 3, offset: 32, format: "float32x3" },
            ],
          },
          {
            // joints (4 x uint8 packed as uint32x4 = 16 bytes) + weights (4 x float32 = 16 bytes) = 32 bytes
            arrayStride: 32,
            attributes: [
              { shaderLocation: 4, offset: 0, format: "uint32x4" },
              { shaderLocation: 5, offset: 16, format: "float32x4" },
            ],
          },
        ],
      },
      fragment: {
        module: shaderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.format }],
      },
      primitive: { topology: "triangle-list" },
      multisample: { count: MSAA_SAMPLE_COUNT },
      depthStencil: {
        format: DEPTH_FORMAT,
        depthWriteEnabled: true,
        depthCompare: "less",
      },
    });
  }

  uploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    this.removeModel(nodeId);

    const hasTexture = materials?.some(m => m.textureData && m.textureData.byteLength > 0) ?? false;
    log.info("ModelRenderer", `uploadModel ${nodeId}: ${meshes.length} meshes, ${materials?.length ?? 0} materials, hasTexture=${hasTexture}`);

    const resources: ModelGPUResources[] = [];
    let uniformOffset = this.nextUniformOffset;

    for (let i = 0; i < meshes.length && uniformOffset < ModelRenderer.MAX_MODELS; i++) {
      const mesh = meshes[i];
      const vertexCount = mesh.vertexCount;
      const stride = 11; // pos3 + normal3 + uv2 + color3
      const interleaved = new Float32Array(vertexCount * stride);

      for (let v = 0; v < vertexCount; v++) {
        interleaved[v * stride] = mesh.vertices[v * 6];
        interleaved[v * stride + 1] = mesh.vertices[v * 6 + 1];
        interleaved[v * stride + 2] = mesh.vertices[v * 6 + 2];
        interleaved[v * stride + 3] = mesh.vertices[v * 6 + 3];
        interleaved[v * stride + 4] = mesh.vertices[v * 6 + 4];
        interleaved[v * stride + 5] = mesh.vertices[v * 6 + 5];
        interleaved[v * stride + 6] = mesh.uvs ? mesh.uvs[v * 2] : 0;
        interleaved[v * stride + 7] = mesh.uvs ? mesh.uvs[v * 2 + 1] : 0;
        interleaved[v * stride + 8] = mesh.colors ? mesh.colors[v * 3] : 1;
        interleaved[v * stride + 9] = mesh.colors ? mesh.colors[v * 3 + 1] : 1;
        interleaved[v * stride + 10] = mesh.colors ? mesh.colors[v * 3 + 2] : 1;
      }

      const vertexBuffer = this.device.createBuffer({
        size: interleaved.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, interleaved as Float32Array<ArrayBuffer>);

      const indexFormat: GPUIndexFormat =
        mesh.indices instanceof Uint32Array ? "uint32" : "uint16";
      const indexByteLength = mesh.indices.byteLength;
      const paddedIndexSize = Math.ceil(indexByteLength / 4) * 4;
      const indexBuffer = this.device.createBuffer({
        size: paddedIndexSize,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      if (paddedIndexSize === indexByteLength) {
        this.device.queue.writeBuffer(indexBuffer, 0, mesh.indices as (Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>));
      } else {
        const padded = new Uint8Array(paddedIndexSize);
        padded.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, indexByteLength));
        this.device.queue.writeBuffer(indexBuffer, 0, padded);
      }

      // Determine the bindless material index for this mesh based on its
      // materialIndex field (index into ModelData.materials). Each unique
      // (nodeId, matIdx) gets its own bindless material slot so multi-material
      // models render each sub-mesh with its own texture.
      const matIdx = mesh.materialIndex ?? 0;
      const materialKey = `${nodeId}:${matIdx}`;
      let bindlessMatIndex = this.defaultMaterialIndex;
      if (this.bindless) {
        const existing = this.meshMaterialIndex.get(materialKey);
        if (existing !== undefined) {
          bindlessMatIndex = existing;
        } else {
          const mat = materials?.[matIdx];
          const texLen = mat?.textureData?.byteLength ?? 0;
          log.info("ModelRenderer", `  mesh[${i}] matIdx=${matIdx} key=${materialKey} baseColor=[${mat?.baseColor?.join(',')}] texData=${texLen}`);
          bindlessMatIndex = this.bindless.materialManager.registerMaterial({
            baseColor: mat?.baseColor ?? [1, 1, 1, 1],
            roughness: mat?.roughness ?? 1,
            metallic: mat?.metallic ?? 0,
            emissiveIntensity: 0,
            albedoTexHandle: this.bindless.registry.defaultWhiteHandle,
            normalTexHandle: this.bindless.registry.defaultWhiteHandle,
            metallicRoughnessTexHandle: this.bindless.registry.defaultWhiteHandle,
            aoTexHandle: this.bindless.registry.defaultWhiteHandle,
            emissiveTexHandle: this.bindless.registry.defaultWhiteHandle,
          });
          this.meshMaterialIndex.set(materialKey, bindlessMatIndex);

          // Async load this material's texture
          if (mat?.textureData && mat.textureData.byteLength > 0) {
            const version = (this.textureLoadVersion.get(materialKey) ?? 0) + 1;
            this.textureLoadVersion.set(materialKey, version);
            this.loadMeshTexture(materialKey, mat.textureData, version);
          }
        }
      }

      // Build the skin vertex buffer (joints + weights) if this mesh is skinned.
      const skinVertexBuffer = this.buildSkinVertexBuffer(mesh);

      resources.push({
        vertexBuffer,
        indexBuffer,
        indexCount: mesh.indexCount,
        indexFormat,
        uniformOffset: uniformOffset * ModelRenderer.UNIFORM_SIZE,
        materialIndex: bindlessMatIndex,
        skinVertexBuffer,
        skinned: skinVertexBuffer !== undefined,
      });
      uniformOffset++;
    }

    this.nextUniformOffset = uniformOffset;
    this.modelResources.set(nodeId, resources);
  }

  /**
   * Allocate an additional uniform slot for an existing model, sharing its
   * vertex/index buffers. Returns the instance index (1-based, since instance
   * 0 uses the original offsets), or -1 if the model doesn't exist or the
   * uniform buffer is full.
   *
   * Use with render()'s instanceIndex parameter to draw multiple instances of
   * the same model at different positions in a single frame. Without this,
   * multiple render() calls with the same nodeId overwrite each other's
   * uniforms (device.queue.writeBuffer is a queue-level op, so all writes
   * execute before the render pass — only the last write is visible).
   */
  allocateInstance(nodeId: string): number {
    const resources = this.modelResources.get(nodeId);
    if (!resources || resources.length === 0) return -1;

    const meshCount = resources.length;
    if (this.nextUniformOffset + meshCount > ModelRenderer.MAX_MODELS) return -1;

    // Allocate `meshCount` contiguous uniform slots for this instance.
    const baseOffset = this.nextUniformOffset * ModelRenderer.UNIFORM_SIZE;
    this.nextUniformOffset += meshCount;

    const instances = this.modelInstanceOffsets.get(nodeId) ?? [];
    instances.push(baseOffset);
    this.modelInstanceOffsets.set(nodeId, instances);
    return instances.length; // 1-based instance index
  }

  /**
   * Free all instance uniform slots for a model (except instance 0 which is
   * tied to the model upload). Call when an instance is no longer needed.
   */
  freeInstances(nodeId: string): void {
    const instances = this.modelInstanceOffsets.get(nodeId);
    if (instances && instances.length > 0) {
      // Reclaim uniform slots (simple: just reset nextUniformOffset if these
      // were the last allocated. A production implementation would use a free
      // list, but instance lifetimes are typically long-lived.)
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - instances.length * this.modelResources.get(nodeId)!.length);
      instances.length = 0;
    }
    this.modelInstanceOffsets.delete(nodeId);
  }

  /** Get the number of allocated instances for a model (0 = only the original). */
  getInstanceCount(nodeId: string): number {
    return this.modelInstanceOffsets.get(nodeId)?.length ?? 0;
  }

  /**
   * Build the per-mesh skin vertex buffer: joints as uint32x4 (4 bone indices,
   * upcast from uint8/uint16/uint32 source) followed by weights as float32x4.
   * 32 bytes/vertex. Returns undefined when the mesh has no skinning data.
   */
  private buildSkinVertexBuffer(mesh: MeshData): GPUBuffer | undefined {
    if (!mesh.joints || !mesh.weights || mesh.joints.length < mesh.vertexCount * 4) return undefined;
    const vertexCount = mesh.vertexCount;
    // 8 slots of 4 bytes per vertex: [j0,j1,j2,j3, w0,w1,w2,w3] = 32 bytes.
    const data = new Float32Array(vertexCount * 8);
    const dataU32 = new Uint32Array(data.buffer);
    for (let v = 0; v < vertexCount; v++) {
      const src = v * 4;
      const dst = v * 8;
      dataU32[dst] = mesh.joints[src];
      dataU32[dst + 1] = mesh.joints[src + 1];
      dataU32[dst + 2] = mesh.joints[src + 2];
      dataU32[dst + 3] = mesh.joints[src + 3];
      data[dst + 4] = mesh.weights[src];
      data[dst + 5] = mesh.weights[src + 1];
      data[dst + 6] = mesh.weights[src + 2];
      data[dst + 7] = mesh.weights[src + 3];
    }
    const buffer = this.device.createBuffer({
      size: data.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });
    this.device.queue.writeBuffer(buffer, 0, data as Float32Array<ArrayBuffer>);
    return buffer;
  }

  private async loadMeshTexture(materialKey: string, textureData: ArrayBuffer, version: number): Promise<void> {
    if (!this.bindless) return;
    try {
      const blob = new Blob([textureData]);
      const imageBitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

      if (this.textureLoadVersion.get(materialKey) !== version) {
        imageBitmap.close();
        return;
      }

      // Register the bitmap into the bindless texture registry. The sourceId
      // is the materialKey so reuploadModel can reuse/update it.
      const sourceId = `model:${materialKey}`;
      const existing = this.bindless.registry.getRegistration(sourceId);
      let handle: number;
      if (existing) {
        // Update in place (same dimensions expected).
        this.bindless.registry.updateFromImageBitmap(sourceId, imageBitmap);
        handle = existing.handle;
      } else {
        const reg = this.bindless.registry.registerFromImageBitmap(sourceId, imageBitmap, "rgba8unorm", 1);
        handle = reg.handle;
      }
      this.meshTextureSourceId.set(materialKey, sourceId);

      // Update the material to point at the real albedo texture.
      const materialIndex = this.meshMaterialIndex.get(materialKey);
      if (materialIndex !== undefined) {
        const matParams: MaterialParams = {
          baseColor: [1, 1, 1, 1],
          roughness: 1,
          metallic: 0,
          emissiveIntensity: 0,
          albedoTexHandle: handle,
          normalTexHandle: this.bindless.registry.defaultWhiteHandle,
          metallicRoughnessTexHandle: this.bindless.registry.defaultWhiteHandle,
          aoTexHandle: this.bindless.registry.defaultWhiteHandle,
          emissiveTexHandle: this.bindless.registry.defaultWhiteHandle,
        };
        this.bindless.materialManager.updateMaterial(materialIndex, matParams);
      }

      log.info("ModelRenderer", `Texture ready for ${materialKey}: ${imageBitmap.width}x${imageBitmap.height} (bindless)`);
      imageBitmap.close();
    } catch (e) {
      console.error(`[ModelRenderer] Failed to load texture for ${materialKey}:`, e);
    }
  }

  removeModel(nodeId: string): void {
    const resources = this.modelResources.get(nodeId);
    if (resources) {
      for (let i = 0; i < resources.length; i++) {
        resources[i].vertexBuffer.destroy();
        resources[i].indexBuffer.destroy();
        resources[i].skinVertexBuffer?.destroy();
      }
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - resources.length);
      this.modelResources.delete(nodeId);
    }
    // Unregister all per-mesh textures + materials from the bindless managers.
    // Clean up any materialKey that starts with `${nodeId}:`.
    const prefix = `${nodeId}:`;
    for (const [materialKey, matIdx] of this.meshMaterialIndex) {
      if (materialKey.startsWith(prefix)) {
        const sourceId = this.meshTextureSourceId.get(materialKey);
        if (sourceId && this.bindless) {
          this.bindless.registry.unregister(sourceId);
          this.meshTextureSourceId.delete(materialKey);
        }
        if (this.bindless && matIdx !== this.defaultMaterialIndex) {
          this.bindless.materialManager.unregisterMaterial(matIdx);
        }
        this.meshMaterialIndex.delete(materialKey);
        this.textureLoadVersion.delete(materialKey);
      }
    }
  }

  reuploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    // Preserve existing per-mesh texture registrations to avoid flickering on
    // part selection changes. Per-mesh material indices are reused.
    const oldResources = this.modelResources.get(nodeId);
    if (oldResources) {
      for (let i = 0; i < oldResources.length; i++) {
        oldResources[i].vertexBuffer.destroy();
        oldResources[i].indexBuffer.destroy();
        oldResources[i].skinVertexBuffer?.destroy();
      }
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - oldResources.length);
      this.modelResources.delete(nodeId);
    }

    const newResources: ModelGPUResources[] = [];
    let uniformOffset = this.nextUniformOffset;

    for (let i = 0; i < meshes.length && uniformOffset < ModelRenderer.MAX_MODELS; i++) {
      const mesh = meshes[i];
      const vertexCount = mesh.vertexCount;
      const stride = 11;
      const interleaved = new Float32Array(vertexCount * stride);

      for (let v = 0; v < vertexCount; v++) {
        interleaved[v * stride] = mesh.vertices[v * 6];
        interleaved[v * stride + 1] = mesh.vertices[v * 6 + 1];
        interleaved[v * stride + 2] = mesh.vertices[v * 6 + 2];
        interleaved[v * stride + 3] = mesh.vertices[v * 6 + 3];
        interleaved[v * stride + 4] = mesh.vertices[v * 6 + 4];
        interleaved[v * stride + 5] = mesh.vertices[v * 6 + 5];
        interleaved[v * stride + 6] = mesh.uvs ? mesh.uvs[v * 2] : 0;
        interleaved[v * stride + 7] = mesh.uvs ? mesh.uvs[v * 2 + 1] : 0;
        interleaved[v * stride + 8] = mesh.colors ? mesh.colors[v * 3] : 1;
        interleaved[v * stride + 9] = mesh.colors ? mesh.colors[v * 3 + 1] : 1;
        interleaved[v * stride + 10] = mesh.colors ? mesh.colors[v * 3 + 2] : 1;
      }

      const vertexBuffer = this.device.createBuffer({
        size: interleaved.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      });
      this.device.queue.writeBuffer(vertexBuffer, 0, interleaved as Float32Array<ArrayBuffer>);

      const indexFormat: GPUIndexFormat =
        mesh.indices instanceof Uint32Array ? "uint32" : "uint16";
      const indexByteLength = mesh.indices.byteLength;
      const paddedIndexSize = Math.ceil(indexByteLength / 4) * 4;
      const indexBuffer = this.device.createBuffer({
        size: paddedIndexSize,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      });
      if (paddedIndexSize === indexByteLength) {
        this.device.queue.writeBuffer(indexBuffer, 0, mesh.indices as (Uint16Array<ArrayBuffer> | Uint32Array<ArrayBuffer>));
      } else {
        const padded = new Uint8Array(paddedIndexSize);
        padded.set(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, indexByteLength));
        this.device.queue.writeBuffer(indexBuffer, 0, padded);
      }

      // Per-mesh material: reuse existing bindless material if already registered,
      // otherwise register a new one and start async texture load.
      const matIdx = mesh.materialIndex ?? 0;
      const materialKey = `${nodeId}:${matIdx}`;
      let bindlessMatIndex = this.defaultMaterialIndex;
      if (this.bindless) {
        const existing = this.meshMaterialIndex.get(materialKey);
        if (existing !== undefined) {
          bindlessMatIndex = existing;
        } else {
          const mat = materials?.[matIdx];
          bindlessMatIndex = this.bindless.materialManager.registerMaterial({
            baseColor: mat?.baseColor ?? [1, 1, 1, 1],
            roughness: mat?.roughness ?? 1,
            metallic: mat?.metallic ?? 0,
            emissiveIntensity: 0,
            albedoTexHandle: this.bindless.registry.defaultWhiteHandle,
            normalTexHandle: this.bindless.registry.defaultWhiteHandle,
            metallicRoughnessTexHandle: this.bindless.registry.defaultWhiteHandle,
            aoTexHandle: this.bindless.registry.defaultWhiteHandle,
            emissiveTexHandle: this.bindless.registry.defaultWhiteHandle,
          });
          this.meshMaterialIndex.set(materialKey, bindlessMatIndex);

          // Start async texture load if this material has texture data and no
          // existing registration (first time seeing this material).
          if (mat?.textureData && mat.textureData.byteLength > 0 && !this.meshTextureSourceId.has(materialKey)) {
            const version = (this.textureLoadVersion.get(materialKey) ?? 0) + 1;
            this.textureLoadVersion.set(materialKey, version);
            this.loadMeshTexture(materialKey, mat.textureData, version);
          }
        }
      }

      const skinVertexBuffer = this.buildSkinVertexBuffer(mesh);

      newResources.push({
        vertexBuffer,
        indexBuffer,
        indexCount: mesh.indexCount,
        indexFormat,
        uniformOffset: uniformOffset * ModelRenderer.UNIFORM_SIZE,
        materialIndex: bindlessMatIndex,
        skinVertexBuffer,
        skinned: skinVertexBuffer !== undefined,
      });
      uniformOffset++;
    }

    this.nextUniformOffset = uniformOffset;
    this.modelResources.set(nodeId, newResources);
  }

  beginFrame(camera: CameraState): void {
    this.viewProjCache = calculateViewProj(camera);
    this.cameraPosCache = [camera.position[0], camera.position[1], camera.position[2]];
    this.bindlessBindGroupSetThisFrame = false;
    this.skinBindGroupSetThisFrame = false;
  }

  /**
   * Set the directional light state for the fragment shader.
   * Call once per frame before render(). All values are in world space.
   *
   * @param dir Light direction (the direction the light travels). The shader
   *   normalizes this. For a sun at the top of the sky in a Y-down world, use
   *   a negative Y (e.g. [0.5, -0.8, 0.3]).
   * @param ambient Ambient light level (0-1). Combined with directional.
   * @param intensity Directional light intensity (0-1). Final lighting = ambient + ndotl * intensity.
   */
  setLightState(dir: [number, number, number], ambient: number, intensity: number): void {
    this.lightDirCache = dir;
    this.lightAmbientCache = ambient;
    this.lightIntensityCache = intensity;
  }

  /**
   * Upload bone skin matrices for the current frame. The `matrices` buffer is
   * a flat Float32Array of boneCount * 16 floats (column-major mat4s). It is
   * copied into the shared skin matrix storage buffer. If the buffer is too
   * small for the current skeleton, it is recreated (grown) automatically.
   * Call once per frame before render() for skinned models.
   */
  updateSkinMatrices(matrices: Float32Array): void {
    if (!this.skinMatrixBuffer) return;

    const requiredBones = matrices.length / 16;
    if (requiredBones > this.boneCapacity) {
      // Grow the skin matrix buffer to fit the larger skeleton.
      // Round up to the next power of 2 to reduce reallocations.
      const newCapacity = Math.max(requiredBones, this.boneCapacity * 2);
      this.skinMatrixBuffer.destroy();
      this.skinMatrixBuffer = this.device.createBuffer({
        size: newCapacity * 64,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      this.boneCapacity = newCapacity;
      // Recreate the bind group with the new buffer
      if (this.skinBindGroupLayout) {
        this.skinBindGroup = this.device.createBindGroup({
          layout: this.skinBindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: this.skinMatrixBuffer } }],
        });
      }
      this.skinBindGroupSetThisFrame = false; // force re-bind
    }

    this.device.queue.writeBuffer(
      this.skinMatrixBuffer,
      0,
      matrices as Float32Array<ArrayBuffer>,
    );
  }

  render(
    passEncoder: GPURenderPassEncoder,
    nodeId: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    scale: [number, number, number],
    instanceIndex: number = 0,
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer || !this.viewProjCache) return;

    const resources = this.modelResources.get(nodeId);
    if (!resources) return;

    // For instance 0, use the original uniform offsets stored in resources.
    // For instance 1+, compute offsets from the allocated instance base.
    let instanceBaseOffset = 0; // in bytes, added to each mesh's uniformOffset
    if (instanceIndex > 0) {
      const instances = this.modelInstanceOffsets.get(nodeId);
      if (!instances || instanceIndex > instances.length) return;
      instanceBaseOffset = instances[instanceIndex - 1];
      // instanceBaseOffset is the absolute byte offset for mesh 0 of this
      // instance. Mesh r's offset = instanceBaseOffset + r * UNIFORM_SIZE.
      // But res.uniformOffset is already mesh 0's original offset + r * UNIFORM_SIZE.
      // So the per-mesh offset for this instance = instanceBaseOffset + r * UNIFORM_SIZE.
      // We compute it as: instanceBaseOffset - resources[0].uniformOffset + res.uniformOffset
      // = instanceBaseOffset + (res.uniformOffset - resources[0].uniformOffset)
      // = instanceBaseOffset + r * UNIFORM_SIZE (since original offsets are contiguous).
    }

    // Set the bindless material bind group once per frame (group 3).
    if (this.bindlessBindGroup && !this.bindlessBindGroupSetThisFrame) {
      passEncoder.setBindGroup(3, this.bindlessBindGroup);
      this.bindlessBindGroupSetThisFrame = true;
    }
    // Set the skin-matrix bind group once per frame (group 1) when any skinned
    // mesh is drawn. The skin matrix buffer is updated per-frame by the caller
    // via updateSkinMatrices().
    const hasSkinned = resources.some((r) => r.skinned);
    if (hasSkinned && this.skinBindGroup && !this.skinBindGroupSetThisFrame) {
      passEncoder.setBindGroup(1, this.skinBindGroup);
      this.skinBindGroupSetThisFrame = true;
    }

    const mesh0Offset = resources[0].uniformOffset;
    for (let r = 0; r < resources.length; r++) {
      const res = resources[r];
      // Compute the uniform offset for this instance + mesh.
      const uniformOffset = instanceIndex === 0
        ? res.uniformOffset
        : instanceBaseOffset + (res.uniformOffset - mesh0Offset);
      const uniforms = this.reusableUniforms;
      for (let i = 0; i < 16; i++) uniforms[i] = this.viewProjCache[i];
      uniforms[16] = this.cameraPosCache[0];
      uniforms[17] = this.cameraPosCache[1];
      uniforms[18] = this.cameraPosCache[2];
      uniforms[19] = performance.now() / 1000;
      uniforms[20] = position[0];
      uniforms[21] = position[1];
      uniforms[22] = position[2];
      // uniforms[23] = padding (vec3<f32> alignment in WGSL uniform layout)
      uniforms[24] = scale[0];
      uniforms[25] = scale[1];
      uniforms[26] = scale[2];
      // uniforms[27] = padding (vec4<f32> alignment in WGSL uniform layout)
      uniforms[28] = rotation[0];
      uniforms[29] = rotation[1];
      uniforms[30] = rotation[2];
      uniforms[31] = rotation[3];
      // materialIndex (u32) at float slot 32 — write via Uint32Array view so
      // the shader reads the correct u32 bit pattern (not a float reinterpretation).
      this.reusableUniformsU32[32] = res.materialIndex;
      // Light state at float slots 33-35 (the former _pad3/_pad4/_pad5 slots):
      //   33: lightDir.x, 34: lightDir.y, 35: lightDir.z
      //   36: ambient, 37: intensity
      uniforms[33] = this.lightDirCache[0];
      uniforms[34] = this.lightDirCache[1];
      uniforms[35] = this.lightDirCache[2];
      uniforms[36] = this.lightAmbientCache;
      uniforms[37] = this.lightIntensityCache;

      this.device.queue.writeBuffer(
        this.uniformBuffer,
        uniformOffset,
        uniforms as Float32Array<ArrayBuffer>,
      );

      // Select the skinned pipeline + skin vertex buffer for skinned meshes,
      // otherwise the standard non-skinned pipeline.
      if (res.skinned && this.skinnedPipeline && res.skinVertexBuffer) {
        passEncoder.setPipeline(this.skinnedPipeline);
        passEncoder.setBindGroup(0, this.bindGroup, [uniformOffset]);
        passEncoder.setVertexBuffer(0, res.vertexBuffer);
        passEncoder.setVertexBuffer(1, res.skinVertexBuffer);
        passEncoder.setIndexBuffer(res.indexBuffer, res.indexFormat);
        passEncoder.drawIndexed(res.indexCount);
      } else {
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, this.bindGroup, [uniformOffset]);
        passEncoder.setVertexBuffer(0, res.vertexBuffer);
        passEncoder.setIndexBuffer(res.indexBuffer, res.indexFormat);
        passEncoder.drawIndexed(res.indexCount);
      }
    }
  }

  hasModel(nodeId: string): boolean {
    return this.modelResources.has(nodeId);
  }

  destroy(): void {
    const ids = Array.from(this.modelResources.keys());
    for (let i = 0; i < ids.length; i++) {
      this.removeModel(ids[i]);
    }
    this.skinMatrixBuffer?.destroy();
  }
}
