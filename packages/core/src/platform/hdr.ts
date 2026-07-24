export type HDRMode = "hdr" | "sdr";

export interface HDRConfig {
  mode: HDRMode;
  format: "rgba16f" | "rgba8";
  colorSpace: "scrgb" | "srgb";
}

export class HDRManager {
  private config: HDRConfig = {
    mode: "sdr",
    format: "rgba8",
    colorSpace: "srgb",
  };
  private available: boolean = false;
  private handlers: Array<(config: HDRConfig) => void> = [];

  isAvailable(): boolean {
    return this.available;
  }

  setAvailable(available: boolean): void {
    this.available = available;
    if (available && this.config.mode === "sdr") {
      this.setMode("hdr");
    }
  }

  getMode(): HDRMode {
    return this.config.mode;
  }

  getConfig(): HDRConfig {
    return this.config;
  }

  setMode(mode: HDRMode): void {
    if (mode === this.config.mode) return;
    this.config = mode === "hdr"
      ? { mode: "hdr", format: "rgba16f", colorSpace: "scrgb" }
      : { mode: "sdr", format: "rgba8", colorSpace: "srgb" };
    for (let i = 0; i < this.handlers.length; i++) {
      this.handlers[i](this.config);
    }
  }

  onModeChange(fn: (config: HDRConfig) => void): void {
    this.handlers.push(fn);
  }
}
