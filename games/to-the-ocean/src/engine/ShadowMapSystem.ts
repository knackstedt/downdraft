// ============================================================================
// Shadow Map System — single-cascade directional shadow mapping
// Renders scene depth from the sun's perspective into a depth texture.
// Provides a bind group with the shadow map, comparison sampler, and light VP
// matrix for PCF-filtered shadow sampling in lit shaders.
// ============================================================================

import { mat4, vec3 } from "wgpu-matrix";

const SHADOW_MAP_SIZE = 2048;
const SHADOW_DISTANCE = 600;   // distance from camera target to light source
const SHADOW_RADIUS = 350;     // orthographic half-extent (world units)

export class ShadowMapSystem {
  private device: GPUDevice;

  private shadowTexture: GPUTexture | null = null;
  private shadowDepthView: GPUTextureView | null = null;
  private shadowUniformBuffer: GPUBuffer | null = null;
  private shadowSampler: GPUSampler | null = null;
  private shadowBindGroupLayout: GPUBindGroupLayout | null = null;
  private shadowBindGroup: GPUBindGroup | null = null;

  // Shadow uniform data: lightViewProj (16 floats) + shadowParams (4 floats) = 20 floats
  private shadowUniformData = new Float32Array(20);

  // Cached light VP matrix for CPU-side use (e.g. shadow pass rendering)
  private lightVP = new Float32Array(16);

  constructor(device: GPUDevice) {
    this.device = device;
  }

  init(): void {
    // Shadow depth texture — depth32float, used as render attachment AND texture binding
    this.shadowTexture = this.device.createTexture({
      size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
    this.shadowDepthView = this.shadowTexture.createView();

    // Uniform buffer: lightViewProj (mat4x4) + shadowParams (vec4) = 80 bytes, padded to 256
    this.shadowUniformBuffer = this.device.createBuffer({
      size: 256,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Comparison sampler for hardware PCF
    this.shadowSampler = this.device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    });

    // Bind group layout:
    //   binding 0: uniform buffer (light VP + params)
    //   binding 1: depth texture (shadow map)
    //   binding 2: comparison sampler
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

    console.log("[Shadow] ShadowMapSystem initialized");
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

  getLightVP(): Float32Array {
    return this.lightVP;
  }

  getShadowMapSize(): number {
    return SHADOW_MAP_SIZE;
  }

  // Compute light VP matrix from sun direction and camera target.
  // Uses an orthographic projection centered on the camera target.
  updateLightVP(
    sunDir: [number, number, number],
    cameraTarget: [number, number, number],
  ): void {
    // Normalize sun direction
    const len = Math.sqrt(sunDir[0] ** 2 + sunDir[1] ** 2 + sunDir[2] ** 2) || 1;
    const dir: [number, number, number] = [
      sunDir[0] / len,
      sunDir[1] / len,
      sunDir[2] / len,
    ];

    // Light position: behind the camera target along the sun direction
    const lightPos: [number, number, number] = [
      cameraTarget[0] - dir[0] * SHADOW_DISTANCE,
      cameraTarget[1] - dir[1] * SHADOW_DISTANCE,
      cameraTarget[2] - dir[2] * SHADOW_DISTANCE,
    ];

    // Choose up vector — avoid degenerate case when sun is directly overhead
    const up: [number, number, number] =
      Math.abs(dir[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0];

    // Light view matrix
    const lightView = mat4.lookAt(lightPos, cameraTarget, up);

    // Orthographic projection
    const lightProj = mat4.ortho(
      -SHADOW_RADIUS, SHADOW_RADIUS,
      -SHADOW_RADIUS, SHADOW_RADIUS,
      1.0, SHADOW_DISTANCE * 2.0,
    );

    // Light VP = proj * view
    this.lightVP = mat4.multiply(lightProj, lightView, this.lightVP);

    // Write to uniform buffer: lightVP (16 floats) + params (4 floats)
    for (let i = 0; i < 16; i++) {
      this.shadowUniformData[i] = this.lightVP[i];
    }
    this.shadowUniformData[16] = 1.0 / SHADOW_MAP_SIZE;  // texelSize
    this.shadowUniformData[17] = 0.003;                   // bias
    this.shadowUniformData[18] = 0.015;                   // normalBias
    this.shadowUniformData[19] = 0.85;                    // shadowDarkness

    this.device.queue.writeBuffer(this.shadowUniformBuffer, 0, this.shadowUniformData);
  }

  destroy(): void {
    this.shadowTexture?.destroy();
    this.shadowUniformBuffer?.destroy();
    this.shadowTexture = null;
    this.shadowDepthView = null;
    this.shadowUniformBuffer = null;
  }
}
