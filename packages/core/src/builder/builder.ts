export type BuilderMode = "dev" | "debug" | "prod";

export interface BuilderConfig {
  mode: BuilderMode;
  webview: "chromium" | "webkit" | "system";
  devtools: boolean;
  telemetry: boolean;
  hotReload: boolean;
  debugDraw: boolean;
  inputContexts: ("editor" | "game" | "ui")[];
}

export function getBuilderConfig(mode: BuilderMode): BuilderConfig {
  switch (mode) {
    case "dev":
      return {
        mode,
        webview: "chromium",
        devtools: true,
        telemetry: true,
        hotReload: true,
        debugDraw: true,
        inputContexts: ["editor", "game", "ui"],
      };
    case "debug":
      return {
        mode,
        webview: "webkit",
        devtools: false,
        telemetry: true,
        hotReload: false,
        debugDraw: false,
        inputContexts: ["game"],
      };
    case "prod":
      return {
        mode,
        webview: "system",
        devtools: false,
        telemetry: false,
        hotReload: false,
        debugDraw: false,
        inputContexts: ["game"],
      };
  }
}

export class Builder {
  private config: BuilderConfig;

  constructor(mode: BuilderMode = "dev") {
    this.config = getBuilderConfig(mode);
  }

  getConfig(): BuilderConfig {
    return this.config;
  }

  isDev(): boolean {
    return this.config.mode === "dev";
  }

  isDebug(): boolean {
    return this.config.mode === "debug";
  }

  isProd(): boolean {
    return this.config.mode === "prod";
  }

  telemetryEnabled(): boolean {
    return this.config.telemetry;
  }

  devtoolsEnabled(): boolean {
    return this.config.devtools;
  }

  hotReloadEnabled(): boolean {
    return this.config.hotReload;
  }
}
