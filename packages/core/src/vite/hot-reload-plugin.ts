import type { Plugin, ViteDevServer } from "vite";

export interface HotReloadPluginOptions {
  simPaths: string[];
  rendererPaths: string[];
  excludePaths?: string[];
  shaderExts: string[];
  assetExts: string[];
}

interface HotReloadPayload {
  file: string;
  timestamp: number;
  deleted?: boolean;
}

export function hotReloadPlugin(options: HotReloadPluginOptions): Plugin {
  const { simPaths, rendererPaths, excludePaths = [], shaderExts, assetExts } = options;

  // Debounce: track last event time per category to coalesce bursts
  const lastEventTime: Record<string, number> = {};
  const DEBOUNCE_MS = 100;

  function matchesPath(filePath: string, patterns: string[]): boolean {
    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, "/");
    return patterns.some((p) => normalized.includes(p));
  }

  function matchesExt(filePath: string, exts: string[]): boolean {
    return exts.some((ext) => filePath.endsWith(ext));
  }

  function sendEvent(
    server: ViteDevServer,
    event: string,
    payload: HotReloadPayload,
  ): void {
    const now = Date.now();
    if (now - (lastEventTime[event] ?? 0) < DEBOUNCE_MS) return;
    lastEventTime[event] = now;
    server.ws.send({ type: "custom", event, data: payload });
  }

  return {
    name: "downdraft-hot-reload",
    apply: "serve",

    handleHotUpdate(ctx) {
      const filePath = ctx.file;
      const timestamp = Date.now();

      // Excluded paths — let Vite/electron-vite handle natively (e.g. main process rebuilds)
      if (matchesPath(filePath, excludePaths)) {
        return undefined;
      }

      // Renderer engine code (non-TSX, non-CSS) → state-preserving page reload
      // Checked BEFORE simPaths so specific renderer paths (e.g. electron-osr/src/renderer/)
      // take priority over broad simPath matches (e.g. packages/plugins/)
      if (
        matchesPath(filePath, rendererPaths) &&
        !filePath.endsWith(".tsx") &&
        !filePath.endsWith(".css")
      ) {
        sendEvent(ctx.server, "renderer:hot-reload", {
          file: filePath,
          timestamp,
        });
        return [];
      }

      // Sim code → worker swap
      if (matchesPath(filePath, simPaths)) {
        sendEvent(ctx.server, "sim:hot-reload", { file: filePath, timestamp });
        return [];
      }

      // Shaders → MaterialHotReloader
      if (matchesExt(filePath, shaderExts)) {
        sendEvent(ctx.server, "shader:hot-reload", {
          file: filePath,
          timestamp,
        });
        return [];
      }

      // Assets → MaterialHotReloader
      if (matchesExt(filePath, assetExts)) {
        sendEvent(ctx.server, "asset:hot-reload", {
          file: filePath,
          timestamp,
        });
        return [];
      }

      // Let Vite handle normally (React Fast Refresh, CSS HMR, etc.)
      return undefined;
    },
  };
}
