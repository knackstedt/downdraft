export interface HDRConfig {
  enabled: boolean;
  format: GPUTextureFormat;
  colorSpace: "srgb" | "scrgb" | "display-p3";
  maxLuminance: number;
}

export class HDRSupport {
  private config: HDRConfig = {
    enabled: false,
    format: "bgra8unorm",
    colorSpace: "srgb",
    maxLuminance: 80.0,
  };

  async detect(adapter: GPUAdapter): Promise<HDRConfig> {
    const features = adapter.features;
    const hasBC = features.has("texture-compression-bc");

    if (hasBC) {
      this.config = {
        enabled: true,
        format: "rgba16float",
        colorSpace: "scrgb",
        maxLuminance: 1000.0,
      };
    } else {
      this.config = {
        enabled: false,
        format: "bgra8unorm",
        colorSpace: "srgb",
        maxLuminance: 80.0,
      };
    }

    return this.config;
  }

  getConfig(): HDRConfig {
    return this.config;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getFormat(): GPUTextureFormat {
    return this.config.format;
  }

  getColorSpace(): string {
    return this.config.colorSpace;
  }

  getMaxLuminance(): number {
    return this.config.maxLuminance;
  }

  getSurfaceConfig(): {
    format: GPUTextureFormat;
    viewFormats: GPUTextureFormat[];
    alphaMode: GPUCanvasAlphaMode;
  } {
    if (this.config.enabled) {
      return {
        format: "rgba16float",
        viewFormats: ["rgba16float"],
        alphaMode: "opaque",
      };
    }
    return {
      format: "bgra8unorm",
      viewFormats: [],
      alphaMode: "opaque",
    };
  }

  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
    if (enabled) {
      this.config.format = "rgba16float";
      this.config.colorSpace = "scrgb";
    } else {
      this.config.format = "bgra8unorm";
      this.config.colorSpace = "srgb";
    }
  }
}
