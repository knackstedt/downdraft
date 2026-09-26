// ============================================================================
// DevToolsDataBridge — non-abstract data-feed API exposed on
// window.__sceneInspector. Games that don't need the full 3D scene inspector
// (e.g. falling-sand, model-viewer) can instantiate this directly with a
// minimal IDevToolsDataRenderer to get perf metrics, GC stats, GPU info, and
// telemetry in the DevTools panel.
//
// BaseSceneInspector extends this class and adds scene-tree / model / gizmo /
// material-editor methods on top.
// ============================================================================

import { startGCProfiler, TelemetryCollector, type GCProfilerHandle, type GCStats } from "@downdraft/engine";
import { createLogger } from "@downdraft/engine/util/logger";
import { useDebugStore } from "./debug-store";
import type {
    IDebugModeProvider,
    IDevToolsDataRenderer,
    IDevToolsOverlayToggle,
    IDevToolsPanelExtension,
    IPerformanceMetricsProvider,
    ISimStatsProvider,
} from "./types";

const log = createLogger("info");

export class DevToolsDataBridge {
  protected renderer: IDevToolsDataRenderer | null = null;
  protected initialized = false;
  protected perfGcHandle: GCProfilerHandle | null = null;
  protected perfActive = false;
  protected cachedGpuSystemInfo: any = null;
  protected cachedElectronGpuInfo: any = null;
  protected cachedVulkanValidation: any = null;
  protected cachedFeatureLog: any = null;
  protected ipcFetchInterval: ReturnType<typeof setInterval> | null = null;

  // --- Optional overrides ---

  protected getDebugModeProvider(): IDebugModeProvider | null {
    return null;
  }

  protected getPerformanceMetricsProvider(): IPerformanceMetricsProvider | null {
    return null;
  }

  /** Games override this to declare custom DevTools panel tabs. */
  protected getPanelExtensions(): IDevToolsPanelExtension[] {
    return [];
  }

  /** Games override this to declare custom overlay toggles. */
  protected getOverlayToggles(): IDevToolsOverlayToggle[] {
    return [];
  }

  /** Games override this to expose sim stats + controls (pause/step/speed/clear). */
  protected getSimStatsProvider(): ISimStatsProvider | null {
    return null;
  }

  // --- Init ---

  init(renderer?: IDevToolsDataRenderer): void {
    this.renderer = renderer ?? null;
    this.initialized = true;

    this.fetchIpcData();
    this.ipcFetchInterval = setInterval(() => this.fetchIpcData(), 2000);

    const api = this.buildApi();
    (window as any).__sceneInspector = api;
    log.info("DevToolsDataBridge", "API exposed on window.__sceneInspector");
  }

  protected buildApi(): Record<string, any> {
    return {
      isReady: (): boolean => {
        return this.initialized;
      },

      // --- Performance monitoring ---
      enablePerformanceMonitoring: (): void => {
        if (this.perfActive) return;
        this.perfActive = true;

        if (!this.perfGcHandle) {
          this.perfGcHandle = startGCProfiler('renderer', (stats: GCStats) => {
            useDebugStore.getState().updateGCStats(stats);
          });
        }

        this.renderer?.setDebugMode?.(true);
        this.getDebugModeProvider()?.setDebugMode(true);
      },

      disablePerformanceMonitoring: (): void => {
        if (!this.perfActive) return;
        this.perfActive = false;

        this.perfGcHandle?.stop();
        this.perfGcHandle = null;

        if (!useDebugStore.getState().showDebugPage) {
          this.renderer?.setDebugMode?.(false);
          this.getDebugModeProvider()?.setDebugMode(false);
        }
      },

      getPerformanceMetrics: (): any => {
        const provider = this.getPerformanceMetricsProvider();
        if (provider) return provider.getPerformanceMetrics();

        // Fallback: basic renderer-only metrics
        const gcStats = useDebugStore.getState().gcStats;
        const fps = this.renderer?.getFPS() ?? 0;
        const frameTimeMs = fps > 0 ? 1000 / fps : 0;
        const targetFrameMs = 1000 / 60;
        const gpuUtil = Math.min(100, (frameTimeMs / targetFrameMs) * 100);
        const perfMem = (performance as any).memory;
        const rendererMemMB = perfMem ? perfMem.usedJSHeapSize / 1048576 : 0;

        function gcFor(label: string) {
          const g = gcStats[label];
          if (!g) return { count: 0, totalTime: 0, scavengeCount: 0, majorCount: 0 };
          return {
            count: g.interval.count,
            totalTime: g.interval.totalTime,
            scavengeCount: g.interval.scavengeCount,
            majorCount: g.interval.majorCount,
          };
        }

        return {
          gpu: { utilization: gpuUtil, frameTimeMs, fps },
          renderer: {
            cpuPercent: gpuUtil, memUsedMB: rendererMemMB,
            diskKBps: 0, networkKBps: 0, gc: gcFor("renderer"),
          },
          main: { cpuPercent: 0, memUsedMB: 0, diskKBps: 0, networkKBps: 0, gc: gcFor("main") },
          worker: { cpuPercent: 0, memUsedMB: 0, diskKBps: 0, networkKBps: 0, gc: gcFor("sim-worker") },
          timestamp: performance.now(),
        };
      },

      // --- GPU Debugging ---
      getGPUInfo: (): any => {
        return this.renderer?.getGPUInfo?.() ?? null;
      },

      // --- Feature Log (cached by fetchIpcData; sync for callInspector) ---
      getFeatureLog: (): any => {
        return this.cachedFeatureLog;
      },

      getGPUErrors: (): any => {
        return this.renderer?.getGPUErrors?.() ?? [];
      },

      clearGPUErrors: (): void => {
        this.renderer?.clearGPUErrors?.();
      },

      getFrameTelemetry: (): any => {
        return this.renderer?.getFrameTelemetry?.() ?? null;
      },

      getGPUResourceStats: (): any => {
        const tracker = this.renderer?.getGPUResourceTracker?.();
        if (!tracker) return null;
        return tracker.getStats();
      },

      getPassTimings: (): any => {
        const tc = this.renderer?.getTelemetryCollector?.();
        if (!tc) return [];
        return tc.getPassTimings();
      },

      getFrameGraph: (): any => {
        return this.renderer?.getFrameGraph?.() ?? null;
      },

      saveSnapshot: (label: string): any => {
        const tc = this.renderer?.getTelemetryCollector?.();
        if (!tc) return null;
        return tc.saveSnapshot(label || "Snapshot");
      },

      getSnapshots: (): any => {
        const tc = this.renderer?.getTelemetryCollector?.();
        if (!tc) return [];
        return tc.getSnapshots();
      },

      clearSnapshots: (): void => {
        this.renderer?.getTelemetryCollector?.()?.clearSnapshots();
      },

      diffSnapshots: (idxA: number, idxB: number): any => {
        const tc = this.renderer?.getTelemetryCollector?.();
        if (!tc) return [];
        const snaps = tc.getSnapshots();
        if (idxA < 0 || idxB < 0 || idxA >= snaps.length || idxB >= snaps.length) return [];
        return TelemetryCollector.diffSnapshots(snaps[idxA], snaps[idxB]);
      },

      // --- GC Controller ---
      getGCStats: (): any => {
        const r = this.renderer as any;
        const stats: Record<string, any> = {};
        if (r?.getGCStats) stats.renderer = r.getGCStats();
        // Worker stats come from debug store (forwarded via events)
        const debugStats = useDebugStore.getState().gcControllerStats;
        if (debugStats["sim-worker"]) stats["sim-worker"] = debugStats["sim-worker"];
        return stats;
      },

      setGCConfig: (config: any): void => {
        const r = this.renderer as any;
        if (r?.setGCConfig) r.setGCConfig(config);
        // Forward to worker via debug mode provider
        const provider = this.getDebugModeProvider() as any;
        if (provider?.setGCConfig) provider.setGCConfig(config);
        useDebugStore.getState().setGCConfig(config);
      },

      forceMajorGC: (): void => {
        const r = this.renderer as any;
        if (r?.forceMajorGC) r.forceMajorGC();
        const provider = this.getDebugModeProvider() as any;
        if (provider?.forceMajorGC) provider.forceMajorGC();
      },

      getVersion: (): string => {
        return "1.0.0";
      },

      getGPUSystemInfo: (): any => {
        return this.cachedGpuSystemInfo;
      },

      getElectronGPUInfo: (): any => {
        return this.cachedElectronGpuInfo;
      },

      getVulkanValidationStatus: (): any => {
        return this.cachedVulkanValidation;
      },

      // --- Panel extensions (game-specific tabs and overlay toggles) ---
      getPanelExtensions: (): IDevToolsPanelExtension[] => this.getPanelExtensions(),
      getOverlayToggles: (): IDevToolsOverlayToggle[] => this.getOverlayToggles(),

      // --- Sim stats & controls (optional — games implement ISimStatsProvider) ---
      getSimStats: (): any => this.getSimStatsProvider()?.getSimStats() ?? null,
      pauseSim: (): void => { this.getSimStatsProvider()?.pauseSim(); },
      resumeSim: (): void => { this.getSimStatsProvider()?.resumeSim(); },
      stepSim: (): void => { this.getSimStatsProvider()?.stepSim?.(); },
      setSimSpeed: (speed: number): void => { this.getSimStatsProvider()?.setSimSpeed?.(speed); },
      clearSim: (): void => { this.getSimStatsProvider()?.clearSim?.(); },
    };
  }

  // --- IPC data fetching (generic Electron) ---

  private fetchIpcData(): void {
    const w = window as any;
    if (w.downdraft?.getGPUSystemInfo) {
      w.downdraft.getGPUSystemInfo().then((data: any) => { this.cachedGpuSystemInfo = data; }).catch(() => {});
    }
    if (w.downdraft?.getElectronGPUInfo) {
      w.downdraft.getElectronGPUInfo().then((info: any) => { this.cachedElectronGpuInfo = info; }).catch(() => {});
    }
    if (w.downdraft?.getVulkanValidationStatus) {
      w.downdraft.getVulkanValidationStatus().then((data: any) => { this.cachedVulkanValidation = data; }).catch(() => {});
    }
    // Feature log — combined main (via IPC) + renderer (cached). Dynamic import
    // avoids pulling @downdraft/engine/app/renderer at data-bridge construction time.
    import("@downdraft/engine/app/renderer").then(({ getCombinedFeatureLog }) => {
      getCombinedFeatureLog().then((data: any) => { this.cachedFeatureLog = data; }).catch(() => {});
    }).catch(() => {});
  }

  destroy(): void {
    this.initialized = false;
    this.renderer = null;
    if (this.ipcFetchInterval) {
      clearInterval(this.ipcFetchInterval);
      this.ipcFetchInterval = null;
    }
    delete (window as any).__sceneInspector;
  }
}
