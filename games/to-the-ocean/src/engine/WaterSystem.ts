// ============================================================================
// Water System — thin adapter wrapping @downdraft/plugin-water WaterRenderer
// ============================================================================
// Maintains the game's original API while delegating to the shared plugin.
//

import { WeatherType } from "@shared/types";
import { WaterBufferReader } from "@shared/water-buffer";
import { CameraState } from "./CameraSystem";
import { DEPTH_FORMAT, MSAA_SAMPLE_COUNT } from "./graphicsConfig";
import { calculateViewProj } from "./mathUtils";
import {
  WaterRenderer,
  type WaterRenderConfig,
} from "@downdraft/plugin-water";

export class WaterSystem {
  private renderer: WaterRenderer;
  private device: GPUDevice;
  private format: GPUTextureFormat;

  static readonly MAX_WAKES = 16;
  static readonly MAX_SHORES = 128;
  static readonly WAKE_FLOATS = 6;
  static readonly SHORE_FLOATS = 4;

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device;
    this.format = format;
    this.renderer = new WaterRenderer({
      format,
      depthFormat: DEPTH_FORMAT as GPUTextureFormat,
      msaaSampleCount: MSAA_SAMPLE_COUNT,
    });
  }

  async init(): Promise<void> {
    await this.renderer.init(this.device);
    console.log(`[Water] Initialized flat-shaded water`);
  }

  setLightBindGroup(bg: GPUBindGroup): void {
    this.renderer.setLightBindGroup(bg);
  }

  getLightBindGroupLayout(): GPUBindGroupLayout | null {
    return this.renderer.getLightBindGroupLayout();
  }

  updateDynamics(
    wakes: Float32Array,
    wakeCount: number,
    shores: Float32Array,
    shoreCount: number,
  ): void {
    this.renderer.updateDynamics(wakes, wakeCount, shores, shoreCount);
  }

  render(
    passEncoder: GPURenderPassEncoder,
    camera: CameraState,
    waterReader: WaterBufferReader,
    timeOfDay: number,
    weatherType: WeatherType,
    visibility: number,
    windSpeed: number,
    windDirX: number,
    windDirZ: number,
    weatherIntensity: number,
    sunDir: [number, number, number],
    sunIntensity: number,
  ): void {
    if (!waterReader.isValid()) return;

    const viewProj = calculateViewProj(camera);
    const config: WaterRenderConfig = {
      timeOfDay,
      weatherType,
      visibility,
      windSpeed,
      windDirX,
      windDirZ,
      weatherIntensity,
      sunDir,
      sunIntensity,
    };

    // Adapt WaterBufferReader to WaterBuffer interface
    const adapter = {
      getHeightsRef: () => waterReader.heights,
      getPatchSize: () => waterReader.getPatchSize(),
      getOrigin: () => ({ x: 0, z: 0 }),
    };

    this.renderer.render(
      passEncoder,
      viewProj,
      camera.position,
      adapter as never,
      config,
    );
  }
}
