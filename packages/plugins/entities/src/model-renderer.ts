// ============================================================================
// Model Renderer — renders imported 3D models (FBX/GLTF/OBJ) via WebGPU
// ============================================================================

import { calculateViewProj, DEPTH_FORMAT, MSAA_SAMPLE_COUNT, type CameraState } from "@downdraft/core";
import type { MaterialData, MeshData } from "@downdraft/plugin-models";
import MODEL_WGSL from "./shaders/model.wgsl?raw";


interface ModelGPUResources {
  vertexBuffer: GPUBuffer;
  indexBuffer: GPUBuffer;
  indexCount: number;
  indexFormat: GPUIndexFormat;
  uniformOffset: number;
  textureBindGroup: GPUBindGroup;
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
  private modelTextures: Map<string, GPUTexture> = new Map();
  private viewProjCache: Float32Array | null = null;
  private cameraPosCache: [number, number, number] = [0, 0, 0];
  private nextUniformOffset = 0;
  private reusableUniforms = new Float32Array(64);
  private textureLoadVersion = new Map<string, number>();

  private sampler: GPUSampler | null = null;
  private defaultTexture: GPUTexture | null = null;
  private defaultTextureView: GPUTextureView | null = null;
  private textureBindGroupLayout: GPUBindGroupLayout | null = null;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
  }

  async init(): Promise<void> {
    this.uniformBuffer = this.device.createBuffer({
      size: ModelRenderer.MAX_MODELS * ModelRenderer.UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

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

    // Texture bind group layout (group 1): sampler + texture
    this.textureBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "filtering" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "float" } },
      ],
    });

    // Shared sampler
    this.sampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    });

    // Default 1x1 white texture (used when model has no texture)
    this.defaultTexture = this.device.createTexture({
      size: [1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.defaultTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    );
    this.defaultTextureView = this.defaultTexture.createView();

    const shaderModule = this.device.createShaderModule({ code: MODEL_WGSL });
    const pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout, this.textureBindGroupLayout],
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

    // Brief summary log
    const hasTexture = materials?.some(m => m.textureData && m.textureData.byteLength > 0) ?? false;
    console.log(`[ModelRenderer] uploadModel ${nodeId}: ${meshes.length} meshes, ${materials?.length ?? 0} materials, hasTexture=${hasTexture}`);

    const resources: ModelGPUResources[] = [];
    let uniformOffset = this.nextUniformOffset;

    // Create default texture bind group (white 1x1) — will be replaced if texture loads
    const defaultTexBindGroup = this.device.createBindGroup({
      layout: this.textureBindGroupLayout!,
      entries: [
        { binding: 0, resource: this.sampler! },
        { binding: 1, resource: this.defaultTextureView! },
      ],
    });

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
      // WebGPU requires buffer sizes and writeBuffer data to be multiples of 4 bytes
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
        textureBindGroup: defaultTexBindGroup,
      });
      uniformOffset++;
    }

    this.nextUniformOffset = uniformOffset;
    this.modelResources.set(nodeId, resources);

    // Async load embedded texture data if available
    if (materials) {
      const texMaterial = materials.find((m) => m.textureData && m.textureData.byteLength > 0);
      if (texMaterial && texMaterial.textureData) {
        const version = (this.textureLoadVersion.get(nodeId) ?? 0) + 1;
        this.textureLoadVersion.set(nodeId, version);
        this.loadModelTexture(nodeId, texMaterial.textureData, version);
      }
    }
  }

  private async loadModelTexture(nodeId: string, textureData: ArrayBuffer, version: number): Promise<void> {
    try {
      const blob = new Blob([textureData]);
      const imageBitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });

      // Check if this texture load is still valid (not superseded by reuploadModel)
      if (this.textureLoadVersion.get(nodeId) !== version) {
        imageBitmap.close();
        return;
      }

      const texture = this.device.createTexture({
        size: [imageBitmap.width, imageBitmap.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      });
      this.device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture },
        [imageBitmap.width, imageBitmap.height],
      );

      const bindGroup = this.device.createBindGroup({
        layout: this.textureBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.sampler! },
          { binding: 1, resource: texture.createView() },
        ],
      });

      const resources = this.modelResources.get(nodeId);
      if (resources) {
        for (let i = 0; i < resources.length; i++) {
          resources[i].textureBindGroup = bindGroup;
        }
        console.log(`[ModelRenderer] Texture ready for ${nodeId}: ${imageBitmap.width}x${imageBitmap.height}`);
      }

      this.modelTextures.set(nodeId, texture);
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
      // Reclaim uniform slots: subtract the number of sub-meshes this model used
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - resources.length);
      this.modelResources.delete(nodeId);
    }
    const texture = this.modelTextures.get(nodeId);
    if (texture) {
      texture.destroy();
      this.modelTextures.delete(nodeId);
    }
    this.textureLoadVersion.delete(nodeId);
  }

  reuploadModel(nodeId: string, meshes: MeshData[], materials?: MaterialData[]): void {
    // Preserve existing texture to avoid flickering on part selection changes
    const existingTexture = this.modelTextures.get(nodeId);

    // If texture already exists, bump version to cancel any stale in-flight load
    // If texture doesn't exist yet, keep the current version so the in-flight load
    // from uploadModel can still complete and update our new resources
    let version = this.textureLoadVersion.get(nodeId) ?? 0;
    if (existingTexture) {
      version = version + 1;
      this.textureLoadVersion.set(nodeId, version);
    }

    // Remove mesh resources but keep texture if it exists
    const oldResources = this.modelResources.get(nodeId);
    if (oldResources) {
      for (let i = 0; i < oldResources.length; i++) {
        oldResources[i].vertexBuffer.destroy();
        oldResources[i].indexBuffer.destroy();
      }
      this.nextUniformOffset = Math.max(0, this.nextUniformOffset - oldResources.length);
      this.modelResources.delete(nodeId);
    }
    // Don't destroy texture — we'll reuse it

    // Re-upload meshes
    const newResources: ModelGPUResources[] = [];
    let uniformOffset = this.nextUniformOffset;

    // Create a fresh bind group from the existing texture if available
    // (don't reuse old bind group — it may be stale if async texture load hasn't completed)
    let texBindGroup: GPUBindGroup;
    if (existingTexture) {
      texBindGroup = this.device.createBindGroup({
        layout: this.textureBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.sampler! },
          { binding: 1, resource: existingTexture.createView() },
        ],
      });
    } else {
      texBindGroup = this.device.createBindGroup({
        layout: this.textureBindGroupLayout!,
        entries: [
          { binding: 0, resource: this.sampler! },
          { binding: 1, resource: this.defaultTextureView! },
        ],
      });
    }

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

      newResources.push({
        vertexBuffer,
        indexBuffer,
        indexCount: mesh.indexCount,
        indexFormat,
        uniformOffset: uniformOffset * ModelRenderer.UNIFORM_SIZE,
        textureBindGroup: texBindGroup,
      });
      uniformOffset++;
    }

    this.nextUniformOffset = uniformOffset;
    this.modelResources.set(nodeId, newResources);

    // If no existing texture and no in-flight load, start one
    if (!existingTexture && version === 0 && materials) {
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

      this.device.queue.writeBuffer(
        this.uniformBuffer,
        res.uniformOffset,
        uniforms as Float32Array<ArrayBuffer>,
      );

      passEncoder.setPipeline(this.pipeline);
      passEncoder.setBindGroup(0, this.bindGroup, [res.uniformOffset]);
      passEncoder.setBindGroup(1, res.textureBindGroup);
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
    this.defaultTexture?.destroy();
    this.defaultTexture = null;
    this.defaultTextureView = null;
  }
}
