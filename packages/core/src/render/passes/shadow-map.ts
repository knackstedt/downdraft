// ============================================================================
// Shadow Map System — single-cascade directional shadow mapping
// Renders scene depth from the sun's perspective into a depth texture.
// Provides a bind group with the shadow map, comparison sampler, and light VP
// matrix for PCF-filtered shadow sampling in lit shaders.
// ============================================================================

import { mat4 } from "wgpu-matrix";

export interface ShadowMapOptions {
  depthFormat?: GPUTextureFormat;
  shadowMapSize?: number;
  shadowDistance?: number;
  shadowRadius?: number;
}

const DEFAULT_SHADOW_MAP_SIZE = 2048;
const DEFAULT_SHADOW_DISTANCE = 600;
const DEFAULT_SHADOW_RADIUS = 350;

export class ShadowMapSystem {
  private device: GPUDevice;
  private depthFormat: GPUTextureFormat;
  private shadowMapSize: number;
  private shadowDistance: number;
  private shadowRadius: number;

  private shadowTexture: GPUTexture | null = null;
  private shadowDepthView: GPUTextureView | null = null;
  private shadowUniformBuffer: GPUBuffer | null = null;
  private shadowSampler: GPUSampler | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowBindGroup: GPUBindGroup | null = null;

  private shadowUniformData = new Float32Array(20);
  private lightVP = new Float32Array(16);

  constructor(device: GPUDevice, options?: ShadowMapOptions) {
    this.device = device;
    this.depthFormat = options?.depthFormat ?? "depth32float";
    this.shadowMapSize = options?.shadowMapSize ?? DEFAULT_SHADOW_MAP_SIZE;
    this.shadowDistance = options?.shadowDistance ?? DEFAULT_SHADOW_DISTANCE;
    this.shadowRadius = options?.shadowRadius ?? DEFAULT_SHADOW_RADIUS;
  }

  init(): void {
    this.shadowTexture = this.device.createTexture({
      size: [this.shadowMapSize, this.shadowMapSize],
      format: this.depthFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowDepthView = this.shadowTexture.createView();

    this.shadowUniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    this.shadowSampler = this.device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    this.shadowBindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      ],
    });

    this.shadowBindGroup = this.device.createBindGroup({
      layout: this.shadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.shadowUniformBuffer } },
        { binding: 1, resource: this.shadowDepthView },
        { binding: 2, resource: this.shadowSampler },
      ],
    });
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.shadowBindGroupLayout;
  }

  getBindGroup(): GPUBindGroup | null {
    return this.shadowBindGroup;
  }

  getShadowDepthView(): GPUTextureView | null {
    return this.shadowDepthView;
  }

  getShadowUniformBuffer(): GPUBuffer | null {
    return this.shadowUniformBuffer;
  }

  getShadowSampler(): GPUSampler | null {
    return this.shadowSampler;
  }

  getLightVP(): Float32Array {
    return this.lightVP;
  }

  getShadowMapSize(): number {
    return this.shadowMapSize;
  }

  updateLightVP(
    sunDir: [number, number, number],
    cameraTarget: [number, number, number],
  ): void {
    const len = Math.sqrt(sunDir[0] ** 2 + sunDir[1] ** 2 + sunDir[2] ** 2) || 1;
    const dir: [number, number, number] = [
      sunDir[0] / len,
      sunDir[1] / len,
      sunDir[2] / len,
    ];

    const lightPos: [number, number, number] = [
      cameraTarget[0] - dir[0] * this.shadowDistance,
      cameraTarget[1] - dir[1] * this.shadowDistance,
      cameraTarget[2] - dir[2] * this.shadowDistance,
    ];

    const up: [number, number, number] =
      Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];

    const lightView = mat4.lookAt(lightPos, cameraTarget, up);

    const lightProj = mat4.ortho(
      -this.shadowRadius, this.shadowRadius,
      -this.shadowRadius, this.shadowRadius,
      1.0, this.shadowDistance * 2.0,
    );

    this.lightVP = mat4.multiply(lightProj, lightView, this.lightVP);

    for (let i = 0; i < 16; i++) {
      this.shadowUniformData[i] = this.lightVP[i];
    }
    this.shadowUniformData[16] = 1.0 / this.shadowMapSize;
    this.shadowUniformData[17] = 0.003;
    this.shadowUniformData[18] = 0.015;
    this.shadowUniformData[19] = 0.85;

    this.device.queue.writeBuffer(this.shadowUniformBuffer!, 0, this.shadowUniformData as unknown as GPUAllowSharedBufferSource);
  }

  destroy(): void {
    this.shadowTexture?.destroy();
    this.shadowUniformBuffer?.destroy();
    this.shadowTexture = null;
    this.shadowDepthView = null;
    this.shadowUniformBuffer = null;
  }
}
