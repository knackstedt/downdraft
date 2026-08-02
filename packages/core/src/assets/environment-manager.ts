import type { BackendTexture } from "../render/backend/types.ts";
import { EquirectToCubemapConverter } from "./cubemap-converter.ts";
import { IrradianceGenerator } from "./irradiance-generator.ts";
import { createEquirectangularGPUTexture, createGPUCubemap, loadCubemapFromFiles } from "./loader-cubemap.ts";
import { loadHDRFile } from "./loader-hdr.ts";
import type { TextureData } from "./loader-texture.ts";
import { PrefilteredSpecularGenerator } from "./prefilter-generator.ts";

export interface EnvironmentMap {
  cubemap: GPUTexture | BackendTexture;
  irradiance: GPUTexture | BackendTexture;
  prefilteredSpecular: (GPUTexture | BackendTexture)[];
  prefilteredMaxMip: number;
  brdfLUT: GPUTexture | BackendTexture | null;
  faceSize: number;
}

export interface EnvironmentManagerOptions {
  device: GPUDevice;
  faceSize?: number;
  prefilterLevels?: number;
  prefilterSamples?: number;
}

export class EnvironmentManager {
  private device: GPUDevice;
  private equirectConverter: EquirectToCubemapConverter;
  private irradianceGen: IrradianceGenerator;
  private prefilterGen: PrefilteredSpecularGenerator;
  private faceSize: number;
  private prefilterLevels: number;
  private prefilterSamples: number;
  private currentEnv: EnvironmentMap | null = null;

  constructor(options: EnvironmentManagerOptions) {
    this.device = options.device;
    this.equirectConverter = new EquirectToCubemapConverter(this.device);
    this.irradianceGen = new IrradianceGenerator(this.device);
    this.prefilterGen = new PrefilteredSpecularGenerator(this.device);
    this.faceSize = options.faceSize ?? 256;
    this.prefilterLevels = options.prefilterLevels ?? 5;
    this.prefilterSamples = options.prefilterSamples ?? 512;
  }

  async loadFromEquirectangular(uri: string): Promise<EnvironmentMap> {
    const texData = await loadHDRFile(uri);
    const equirectTex = createEquirectangularGPUTexture(this.device, texData, "rgba16float");

    const cubemap = this.equirectConverter.convert(equirectTex, {
      faceSize: this.faceSize,
    });

    equirectTex.destroy();

    return this.generateIBLMaps(cubemap);
  }

  async loadFromCubemapFiles(
    faceUris: [string, string, string, string, string, string],
  ): Promise<EnvironmentMap> {
    const cubemapData = await loadCubemapFromFiles(faceUris);
    const cubemap = createGPUCubemap(this.device, cubemapData, "rgba16float");
    return this.generateIBLMaps(cubemap);
  }

  async loadFromHDRData(texData: TextureData): Promise<EnvironmentMap> {
    const equirectTex = createEquirectangularGPUTexture(this.device, texData, "rgba16float");
    const cubemap = this.equirectConverter.convert(equirectTex, {
      faceSize: this.faceSize,
    });
    equirectTex.destroy();
    return this.generateIBLMaps(cubemap);
  }

  private generateIBLMaps(cubemap: GPUTexture): EnvironmentMap {
    const irradiance = this.irradianceGen.generate(cubemap, {
      faceSize: 32,
    });

    const prefilteredSpecular = this.prefilterGen.generateMipmapChain(
      cubemap,
      this.faceSize,
      this.prefilterLevels,
      this.prefilterSamples,
    );

    const envMap: EnvironmentMap = {
      cubemap,
      irradiance,
      prefilteredSpecular,
      prefilteredMaxMip: this.prefilterLevels - 1,
      brdfLUT: null,
      faceSize: this.faceSize,
    };

    this.currentEnv = envMap;
    return envMap;
  }

  getCurrentEnvironment(): EnvironmentMap | null {
    return this.currentEnv;
  }

  setBRDFLUT(lut: GPUTexture): void {
    if (this.currentEnv) {
      this.currentEnv.brdfLUT = lut;
    }
  }

  destroy(): void {
    if (!this.currentEnv) return;
    this.currentEnv.cubemap.destroy();
    this.currentEnv.irradiance.destroy();
    for (const tex of this.currentEnv.prefilteredSpecular) {
      tex.destroy();
    }
    this.currentEnv = null;
  }
}
