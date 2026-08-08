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
import type { MaterialData, MeshData } from "@downdraft/plugin-models";
import MODEL_WGSL from "./shaders/model.wgsl?raw";

const log = createLogger();


interface ModelGPUResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  uniformOffset: number;
  materialIndex: number;
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

  private modelResources: Map<string, ModelGPUResources[]> = new Map();
  private viewProjCache: Float32Array | null = null;
  private cameraPosCache: [number, number, number] = [0, 0, 0];
  private nextUniformOffset = 0;
  private reusableUniforms = new Float32Array(64);
  private reusableUniformsU32 = new Uint32Array(this.reusableUniforms.buffer);
  private textureLoadVersion = new Map<string, number>();

  // Bindless deps
  private bindless: ModelRendererBindlessDeps | null = null;
  private bindlessLayout: GPUBindGroupLayout | null = null;
  private bindlessBindGroup: GPUBindGroup | null = null;
  private bindlessBindGroupSetThisFrame = false;
  /** materialIndex for the default white material (albedo = default white layer). */
  private defaultMaterialIndex = 0;
  /** sourceId → materialIndex, so reupload reuses the same slot. */
  private modelMaterialIndex = new Map<string, number>();
  /** sourceId for the texture registered for a model (used for async update). */
  private modelTextureSourceId = new Map<string, string>();

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
  }

  uploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    this.removeModel(nodeId);

    const hasTexture = materials?.some(m => m.textureData && m.textureData.byteLength > 0) ?? false;
    log.info("ModelRenderer", `uploadModel ${nodeId}: ${meshes.length} meshes, ${materials?.length ?? 0} materials, hasTexture=${hasTexture}`);

    // Allocate (or reuse) a material index for this model. Starts with the
    // default white material; updated when the async texture load completes.
    let materialIndex = this.defaultMaterialIndex;
    if (this.bindless) {
      const existing = this.modelMaterialIndex.get(nodeId);
      if (existing !== undefined) {
        materialIndex = existing;
      } else {
        materialIndex = this.bindless.materialManager.registerMaterial({
          baseColor: [1, 1, 1, 1],
          roughness: 1,
          metallic: 0,
          emissiveIntensity: 0,
          albedoTexHandle: this.bindless.registry.defaultWhiteHandle,
          normalTexHandle: this.bindless.registry.defaultWhiteHandle,
          metallicRoughnessTexHandle: this.bindless.registry.defaultWhiteHandle,
          aoTexHandle: this.bindless.registry.defaultWhiteHandle,
          emissiveTexHandle: this.bindless.registry.defaultWhiteHandle,
        });
        this.modelMaterialIndex.set(nodeId, materialIndex);
      }
    }

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

      resources.push({
        vertexBuffer,
        indexBuffer,
        indexCount: mesh.indexCount,
        indexFormat,
        uniformOffset: uniformOffset * ModelRenderer.UNIFORM_SIZE,
        materialIndex,
      });
      uniformOffset++;
    }

    this.nextUniformOffset = uniformOffset;
    this.modelResources.set(nodeId, resources);

    // Async load embedded texture data if available
    if (materials && this.bindless) {
      const texMaterial = materials.find((m) => m.textureData && m.textureData.byteLength > 0);
      if (texMaterial && texMaterial.textureData) {
        const version = (this.textureLoadVersion.get(nodeId) ?? 0) + 1;
        this.textureLoadVersion.set(nodeId, version);
        this.loadModelTexture(nodeId, texMaterial.textureData, version);
      }
    }
  }

  private async loadModelTexture(nodeId: string, textureData: ArrayBuffer, version: number): Promise<void> {
    if (!this.bindless) return;
    try {
      const blob = new Blob([textureData]);
      const imageBitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

      if (this.textureLoadVersion.get(nodeId) !== version) {
        imageBitmap.close();
        return;
      }

      // Register the bitmap into the bindless texture registry. The sourceId
      // is the nodeId so reuploadModel can reuse/update it.
      const sourceId = `model:${nodeId}`;
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
      this.modelTextureSourceId.set(nodeId, sourceId);

      // Update the material to point at the real albedo texture.
      const materialIndex = this.modelMaterialIndex.get(nodeId);
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

      log.info("ModelRenderer", `Texture ready for ${nodeId}: ${imageBitmap.width}x${imageBitmap.height} (bindless)`);
      imageBitmap.close();
    } catch (e) {
      console.error(`[ModelRenderer] Failed to load texture for ${nodeId}:`, e);
    }
  }

  removeModel(nodeId: string): void {
    const resources = this.modelResources.get(nodeId);
    if (resources) {
      for (let i = 0; i < resources.length; i++) {
        resources[i].vertexBuffer.destroy();
        resources[i].indexBuffer.destroy();
      }
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - resources.length);
      this.modelResources.delete(nodeId);
    }
    // Unregister the texture + material from the bindless managers.
    const sourceId = this.modelTextureSourceId.get(nodeId);
    if (sourceId && this.bindless) {
      this.bindless.registry.unregister(sourceId);
      this.modelTextureSourceId.delete(nodeId);
    }
    const matIdx = this.modelMaterialIndex.get(nodeId);
    if (matIdx !== undefined && this.bindless && matIdx !== this.defaultMaterialIndex) {
      this.bindless.materialManager.unregisterMaterial(matIdx);
      this.modelMaterialIndex.delete(nodeId);
    }
    this.textureLoadVersion.delete(nodeId);
  }

  reuploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    // Preserve existing texture registration to avoid flickering on part
    // selection changes. The material index is reused.
    const existingSourceId = this.modelTextureSourceId.get(nodeId);

    let version = this.textureLoadVersion.get(nodeId) ?? 0;
    if (existingSourceId) {
      version = version + 1;
      this.textureLoadVersion.set(nodeId, version);
    }

    const oldResources = this.modelResources.get(nodeId);
    if (oldResources) {
      for (let i = 0; i < oldResources.length; i++) {
        oldResources[i].vertexBuffer.destroy();
        oldResources[i].indexBuffer.destroy();
      }
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - oldResources.length);
      this.modelResources.delete(nodeId);
    }

    const materialIndex = this.modelMaterialIndex.get(nodeId) ?? this.defaultMaterialIndex;

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

      newResources.push({
        vertexBuffer,
        indexBuffer,
        indexCount: mesh.indexCount,
        indexFormat,
        uniformOffset: uniformOffset * ModelRenderer.UNIFORM_SIZE,
        materialIndex,
      });
      uniformOffset++;
    }

    this.nextUniformOffset = uniformOffset;
    this.modelResources.set(nodeId, newResources);

    // If no existing texture and no in-flight load, start one
    if (!existingSourceId && version === 0 && materials && this.bindless) {
      const texMaterial = materials.find((m) => m.textureData && m.textureData.byteLength > 0);
      if (texMaterial && texMaterial.textureData) {
        version = 1;
        this.textureLoadVersion.set(nodeId, version);
        this.loadModelTexture(nodeId, texMaterial.textureData, version);
      }
    }
  }

  beginFrame(camera: CameraState): void {
    this.viewProjCache = calculateViewProj(camera);
    this.cameraPosCache = [camera.position[0], camera.position[1], camera.position[2]];
    this.bindlessBindGroupSetThisFrame = false;
  }

  render(
    passEncoder: GPURenderPassEncoder,
    nodeId: string,
    position: [number, number, number],
    rotation: [number, number, number, number],
    scale: [number, number, number],
  ): void {
    if (!this.pipeline || !this.bindGroup || !this.uniformBuffer || !this.viewProjCache) return;

    const resources = this.modelResources.get(nodeId);
    if (!resources) return;

    // Set the bindless material bind group once per frame (group 3).
    if (this.bindlessBindGroup && !this.bindlessBindGroupSetThisFrame) {
      passEncoder.setBindGroup(3, this.bindlessBindGroup);
      this.bindlessBindGroupSetThisFrame = true;
    }

    for (let r = 0; r < resources.length; r++) {
      const res = resources[r];
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

      this.device.queue.writeBuffer(
        this.uniformBuffer,
        res.uniformOffset,
        uniforms as Float32Array<ArrayBuffer>,
      );

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup, [res.uniformOffset]);
      passEncoder.setVertexBuffer(0, res.vertexBuffer);
      passEncoder.setIndexBuffer(res.indexBuffer, res.indexFormat);
      passEncoder.drawIndexed(res.indexCount);
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
  }
}
