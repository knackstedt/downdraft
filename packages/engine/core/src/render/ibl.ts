import type { EnvironmentMap } from "../assets/environment-manager";
import { EnvironmentManager } from "../assets/environment-manager";
import { IrradianceGenerator } from "../assets/irradiance-generator";
import { PrefilteredSpecularGenerator } from "../assets/prefilter-generator";
import { IBLBindGroup } from "./ibl-bind-group";
import { CubemapCapturePass } from "./passes/cubemap-capture";
import type { SkyDomeUniforms } from "./passes/sky-dome";

export interface IBLSystemOptions {
  faceSize?: number;
  prefilterLevels?: number;
  prefilterSamples?: number;
  recaptureInterval?: number;
  includeBRDFLUT?: boolean;
}

export class IBLSystem {
  private device: GPUDevice;
  private faceSize: number;
  private prefilterLevels: number;
  private prefilterSamples: number;
  private recaptureInterval: number;
  private includeBRDFLUT: boolean;

  private cubemapCapture: CubemapCapturePass;
  private irradianceGen: IrradianceGenerator;
  private prefilterGen: PrefilteredSpecularGenerator;
  private envManager: EnvironmentManager;
  private iblBindGroup: IBLBindGroup;

  private currentEnv: EnvironmentMap | null = null;
  private brdfLUTTexture: GPUTexture | null = null;
  private frameCounter: number = 0;
  private lastTimeOfDay: number = -1;
  private initialized: boolean = false;
  private pendingDestroy: GPUTexture[] = [];

  constructor(device: GPUDevice, options: IBLSystemOptions = {}) {
    this.device = device;
    this.faceSize = options.faceSize ?? 256;
    this.prefilterLevels = options.prefilterLevels ?? 5;
    this.prefilterSamples = options.prefilterSamples ?? 512;
    this.recaptureInterval = options.recaptureInterval ?? 60;
    this.includeBRDFLUT = options.includeBRDFLUT ?? true;

    this.cubemapCapture = new CubemapCapturePass(device, { faceSize: this.faceSize });
    this.irradianceGen = new IrradianceGenerator(device);
    this.prefilterGen = new PrefilteredSpecularGenerator(device);
    this.envManager = new EnvironmentManager({
      device, faceSize: this.faceSize,
      prefilterLevels: this.prefilterLevels, prefilterSamples: this.prefilterSamples,
    });
    this.iblBindGroup = new IBLBindGroup(device, { includeBRDFLUT: this.includeBRDFLUT });
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
  }

  setBRDFLUT(lut: GPUTexture): void {
    this.brdfLUTTexture = lut;
  }

  captureFromSkyDome(uniforms: Omit<SkyDomeUniforms, "viewProj" | "cameraPos">): void {
    const cubemap = this.cubemapCapture.capture(uniforms);

    const irradiance = this.irradianceGen.generate(cubemap, { faceSize: 32 });
    const prefilteredSpecular = this.prefilterGen.generateMipmapChain(
      cubemap,
      this.faceSize,
      this.prefilterLevels,
      this.prefilterSamples,
    );

    if (this.currentEnv) {
      // Defer destruction — the old env textures may still be referenced by
      // in-flight command buffers from the current frame's render passes.
      // They will be destroyed after the frame completes via endFrame().
      this.pendingDestroy.push(this.currentEnv.irradiance);
      this.currentEnv.prefilteredSpecular.forEach((tex) => {
        this.pendingDestroy.push(tex);
      });
      // The cubemap is also deferred (not destroyed immediately) because it
      // may still be referenced by a previously submitted command buffer, and
      // CubemapCapturePass now creates a fresh texture each capture so the
      // old one is safe to release after the frame completes.
      if (this.currentEnv.cubemap) {
        this.pendingDestroy.push(this.currentEnv.cubemap);
      }
    }

    this.currentEnv = {
      cubemap,
      irradiance,
      prefilteredSpecular,
      prefilteredMaxMip: this.prefilterLevels - 1,
      brdfLUT: this.brdfLUTTexture,
      faceSize: this.faceSize,
    };

    if (this.currentEnv) {
      this.iblBindGroup.createBindGroup(this.currentEnv);
    }
  }

  async loadFromEquirectangular(uri: string): Promise<void> {
    const envMap = await this.envManager.loadFromEquirectangular(uri);
    if (this.brdfLUTTexture) {
      envMap.brdfLUT = this.brdfLUTTexture;
    }
    this.currentEnv = envMap;
    this.iblBindGroup.createBindGroup(envMap);
  }

  async loadFromCubemapFiles(
    faceUris: [string, string, string, string, string, string],
  ): Promise<void> {
    const envMap = await this.envManager.loadFromCubemapFiles(faceUris);
    if (this.brdfLUTTexture) {
      envMap.brdfLUT = this.brdfLUTTexture;
    }
    this.currentEnv = envMap;
    this.iblBindGroup.createBindGroup(envMap);
  }

  shouldRecapture(timeOfDay: number): boolean {
    this.frameCounter++;
    if (this.frameCounter < this.recaptureInterval) return false;
    const timeDelta = Math.abs(timeOfDay - this.lastTimeOfDay);
    if (this.lastTimeOfDay >= 0 && timeDelta < 0.02 && this.currentEnv) return false;
    return true;
  }

  updateFromSkyDome(
    uniforms: Omit<SkyDomeUniforms, "viewProj" | "cameraPos">,
    timeOfDay: number,
  ): void {
    if (!this.shouldRecapture(timeOfDay)) return;
    this.captureFromSkyDome(uniforms);
    this.lastTimeOfDay = timeOfDay;
    this.frameCounter = 0;
  }

  getBindGroup(): GPUBindGroup | null {
    return this.iblBindGroup?.getBindGroup() ?? null;
  }

  getBindGroupLayout(): GPUBindGroupLayout | null {
    return this.iblBindGroup?.getBindGroupLayout() ?? null;
  }

  getCurrentEnvironment(): EnvironmentMap | null {
    return this.currentEnv;
  }

  isReady(): boolean {
    return this.currentEnv !== null && (this.iblBindGroup?.getBindGroup() ?? null) !== null;
  }

  /** Destroy textures deferred from a mid-frame recapture. Call after the frame's command buffers have been submitted. */
  endFrame(): void {
    this.pendingDestroy.forEach((tex) => {
      try { tex.destroy(); } catch {}
    });
    this.pendingDestroy = [];
  }

  destroy(): void {
    this.cubemapCapture?.destroy();
    this.iblBindGroup?.destroy();
    this.envManager?.destroy();
    this.pendingDestroy.forEach((tex) => {
      try { tex.destroy(); } catch {}
    });
    this.pendingDestroy = [];
    this.currentEnv = null;
    this.initialized = false;
  }
}
