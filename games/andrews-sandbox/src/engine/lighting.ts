// ============================================================================
// SandboxLighting — frame-global lighting state for the sandbox.
//
// Owns a uniform buffer + bind group (group 2) providing:
//   - Sun direction + color
//   - Hemisphere ambient (sky color from above, ground color from below)
//   - Ambient intensity multiplier
//   - Up to 8 colored point lights (position, color, intensity, radius)
//
// The bind group is bound at @group(2) in both the procedural shaders
// (cube/sphere/ground) and the ModelRenderer shader (model.wgsl).
// ============================================================================

export interface PointLight {
  position: [number, number, number];
  color: [number, number, number];
  intensity: number;
  radius: number;
}

const MAX_POINT_LIGHTS = 8;
// UBO layout (vec4-aligned):
//   0: sunDir.xyz, ambientIntensity
//   1: sunColor.xyz, pointLightCount
//   2: skyAmbient.xyz, _pad
//   3: groundAmbient.xyz, _pad
//   4..4+2*N: point lights (2 vec4s each: pos.xyz+radius, color.rgb+intensity)
const UBO_FLOATS = 16 + MAX_POINT_LIGHTS * 8; // 16 + 64 = 80 floats = 320 bytes

export class SandboxLighting {
  private device: GPUDevice;
  private uniformBuffer: GPUBuffer;
  private bindGroup: GPUBindGroup;
  private bindGroupLayout: GPUBindGroupLayout;
  private uniformData = new Float32Array(UBO_FLOATS);
  private uniformDataU32 = new Uint32Array(this.uniformData.buffer);

  // Current state
  private sunDir: [number, number, number] = [0.4, 0.8, 0.3];
  private sunColor: [number, number, number] = [1.0, 0.95, 0.85]; // warm sun
  private skyAmbient: [number, number, number] = [0.22, 0.28, 0.38]; // cool sky (dimmed)
  private groundAmbient: [number, number, number] = [0.25, 0.22, 0.20]; // warm ground
  private ambientIntensity = 0.4;
  private pointLights: PointLight[] = [];
  private pointLightsEnabled = true;

  constructor(device: GPUDevice) {
    this.device = device;
    this.uniformBuffer = device.createBuffer({
      label: "sandbox-lighting",
      size: UBO_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      label: "sandbox-lighting-layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    });
    this.bindGroup = device.createBindGroup({
      label: "sandbox-lighting-bg",
      layout: this.bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
  }

  getBindGroup(): GPUBindGroup { return this.bindGroup; }
  getBindGroupLayout(): GPUBindGroupLayout { return this.bindGroupLayout; }
  getUniformBuffer(): GPUBuffer { return this.uniformBuffer; }

  setSunDirection(dir: [number, number, number]): void { this.sunDir = dir; }
  setSunColor(color: [number, number, number]): void { this.sunColor = color; }
  setSkyAmbient(color: [number, number, number]): void { this.skyAmbient = color; }
  setGroundAmbient(color: [number, number, number]): void { this.groundAmbient = color; }
  setAmbientIntensity(v: number): void { this.ambientIntensity = v; }
  setPointLights(lights: PointLight[]): void { this.pointLights = lights.slice(0, MAX_POINT_LIGHTS); }
  setPointLightsEnabled(enabled: boolean): void { this.pointLightsEnabled = enabled; }

  getSunDirection(): [number, number, number] { return this.sunDir; }
  getAmbientIntensity(): number { return this.ambientIntensity; }

  /** Upload the uniform data to the GPU. Call once per frame before rendering. */
  upload(): void {
    const d = this.uniformData;
    // vec4 0: sunDir.xyz, ambientIntensity
    d[0] = this.sunDir[0]; d[1] = this.sunDir[1]; d[2] = this.sunDir[2]; d[3] = this.ambientIntensity;
    // vec4 1: sunColor.xyz, pointLightCount (u32 — write via Uint32Array view)
    const count = this.pointLightsEnabled ? this.pointLights.length : 0;
    d[4] = this.sunColor[0]; d[5] = this.sunColor[1]; d[6] = this.sunColor[2];
    this.uniformDataU32[7] = count;
    // vec4 2: skyAmbient.xyz, _pad
    d[8] = this.skyAmbient[0]; d[9] = this.skyAmbient[1]; d[10] = this.skyAmbient[2]; d[11] = 0;
    // vec4 3: groundAmbient.xyz, _pad
    d[12] = this.groundAmbient[0]; d[13] = this.groundAmbient[1]; d[14] = this.groundAmbient[2]; d[15] = 0;
    // Point lights: 2 vec4s each
    for (let i = 0; i < MAX_POINT_LIGHTS; i++) {
      const base = 16 + i * 8;
      if (i < count) {
        const pl = this.pointLights[i];
        d[base + 0] = pl.position[0]; d[base + 1] = pl.position[1]; d[base + 2] = pl.position[2]; d[base + 3] = pl.radius;
        d[base + 4] = pl.color[0]; d[base + 5] = pl.color[1]; d[base + 6] = pl.color[2]; d[base + 7] = pl.intensity;
      } else {
        for (let j = 0; j < 8; j++) d[base + j] = 0;
      }
    }
    this.device.queue.writeBuffer(this.uniformBuffer, 0, d as Float32Array<ArrayBuffer>);
  }

  destroy(): void {
    this.uniformBuffer.destroy();
  }
}
