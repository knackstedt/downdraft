import type { Plugin, ViteDevServer } from "vite";

export interface HotReloadPluginOptions {
  simPaths: string[];
  rendererPaths: string[];
  excludePaths?: string[];
}

interface HotReloadPayload {
  file: string;
  timestamp: number;
  deleted?: boolean;
}

export function hotReloadPlugin(options: HotReloadPluginOptions): Plugin {
  const { simPaths, rendererPaths, excludePaths = [] } = options;

  // Debounce: track last event time per category to coalesce bursts
  const lastEventTime: Record<string, number> = {};
  const DEBOUNCE_MS = 100;

  // Fallback: if no client acks within this timeout, force a full page reload.
  // Games that handle sim/renderer hot-reload send an ack via import.meta.hot.send().
  // Games that don't (e.g. model-viewer) get a full reload automatically.
  const FALLBACK_MS = 500;
  let simAcked = false;
  let rendererAcked = false;

  function matchesPath(filePath: string, patterns: string[]): boolean {
    // Normalize to forward slashes
    const normalized = filePath.replace(/\\/g, "/");
    return patterns.some((p) => normalized.includes(p));
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

    configureServer(server) {
      // Listen for acks from clients that handle custom hot-reload events
      server.hot.on("sim:hot-reload:ack", () => { simAcked = true; });
      server.hot.on("renderer:hot-reload:ack", () => { rendererAcked = true; });
    },

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
        rendererAcked = false;
        sendEvent(ctx.server, "renderer:hot-reload", {
          file: filePath,
          timestamp,
        });
        // Fallback: if no client acks, force a full page reload
        setTimeout(() => {
          if (!rendererAcked) {
            ctx.server.hot.send({ type: "full-reload" });
          }
        }, FALLBACK_MS);
        return [];
      }

      // Sim code → worker swap (to-the-ocean) or full reload fallback (other games)
      if (matchesPath(filePath, simPaths)) {
        simAcked = false;
        sendEvent(ctx.server, "sim:hot-reload", { file: filePath, timestamp });
        // Fallback: if no client acks, force a full page reload
        setTimeout(() => {
          if (!simAcked) {
            ctx.server.hot.send({ type: "full-reload" });
          }
        }, FALLBACK_MS);
        return [];
      }

      // Let Vite handle normally (React Fast Refresh, CSS HMR, ?raw shader
      // HMR via the wgslHmrPlugin, asset HMR, etc.)
      return undefined;
    },
  };
}
