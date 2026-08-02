import type { EnvironmentMap } from "../assets/environment-manager.ts";
import { EnvironmentManager } from "../assets/environment-manager.ts";
import { IrradianceGenerator } from "../assets/irradiance-generator.ts";
import { PrefilteredSpecularGenerator } from "../assets/prefilter-generator.ts";
import type { RenderBackend } from "./backend/render-backend.ts";
import type { BackendBindGroup, BackendBindGroupLayout, BackendTexture } from "./backend/types.ts";
import { IBLBindGroup } from "./ibl-bind-group.ts";
import { CubemapCapturePass } from "./passes/cubemap-capture.ts";
import type { SkyDomeUniforms } from "./passes/sky-dome.ts";

export interface IBLSystemOptions {
  faceSize?: number;
  prefilterLevels?: number;
  prefilterSamples?: number;
  recaptureInterval?: number;
  includeBRDFLUT?: boolean;
}

export class IBLSystem {
  private device: GPUDevice | null;
  private backend: RenderBackend | null;
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
  private brdfLUTTexture: GPUTexture | BackendTexture | null = null;
  private frameCounter: number = 0;
  private lastTimeOfDay: number = -1;
  private initialized: boolean = false;

  constructor(device: GPUDevice | null, options: IBLSystemOptions = {}, backend?: RenderBackend | null) {
    this.device = device;
    this.backend = backend ?? null;
    this.faceSize = options.faceSize ?? 256;
    this.prefilterLevels = options.prefilterLevels ?? 5;
    this.prefilterSamples = options.prefilterSamples ?? 512;
    this.recaptureInterval = options.recaptureInterval ?? 60;
    this.includeBRDFLUT = options.includeBRDFLUT ?? true;

    // Compute-based IBL sub-systems require WebGPU — skip on backend
    if (device) {
      this.cubemapCapture = new CubemapCapturePass(device, { faceSize: this.faceSize });
      this.irradianceGen = new IrradianceGenerator(device);
      this.prefilterGen = new PrefilteredSpecularGenerator(device);
      this.envManager = new EnvironmentManager({
        device, faceSize: this.faceSize,
        prefilterLevels: this.prefilterLevels, prefilterSamples: this.prefilterSamples,
      });
      this.iblBindGroup = new IBLBindGroup(device, { includeBRDFLUT: this.includeBRDFLUT });
    } else {
      // Stub objects for backend path — compute not supported
      this.cubemapCapture = null as any;
      this.irradianceGen = null as any;
      this.prefilterGen = null as any;
      this.envManager = null as any;
      this.iblBindGroup = null as any;
    }
  }

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
  }

  setBRDFLUT(lut: GPUTexture | BackendTexture): void {
    this.brdfLUTTexture = lut;
  }

  captureFromSkyDome(uniforms: Omit<SkyDomeUniforms, "viewProj" | "cameraPos">): void {
    if (!this.device) return; // Skip on backend — compute not supported
    const cubemap = this.cubemapCapture.capture(uniforms);

    const irradiance = this.irradianceGen.generate(cubemap, { faceSize: 32 });
    const prefilteredSpecular = this.prefilterGen.generateMipmapChain(
      cubemap,
      this.faceSize,
      this.prefilterLevels,
      this.prefilterSamples,
    );

    if (this.currentEnv) {
      this.currentEnv.irradiance.destroy();
      for (const tex of this.currentEnv.prefilteredSpecular) {
        tex.destroy();
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
    if (!this.envManager) return; // Skip on backend
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
    if (!this.envManager) return; // Skip on backend
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
    if (this.lastTimeOfDay >= 0 && timeDelta < 0.05 && this.currentEnv) return false;
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

  getBindGroup(): GPUBindGroup | BackendBindGroup | null {
    return this.iblBindGroup?.getBindGroup() ?? null;
  }

  getBindGroupLayout(): GPUBindGroupLayout | BackendBindGroupLayout | null {
    return this.iblBindGroup?.getBindGroupLayout() ?? null;
  }

  getCurrentEnvironment(): EnvironmentMap | null {
    return this.currentEnv;
  }

  isReady(): boolean {
    return this.currentEnv !== null && (this.iblBindGroup?.getBindGroup() ?? null) !== null;
  }

  destroy(): void {
    this.cubemapCapture?.destroy();
    this.iblBindGroup?.destroy();
    this.envManager?.destroy();
    this.currentEnv = null;
    this.initialized = false;
  }
}
