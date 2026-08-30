// ============================================================================
// createDevToolsRendererAdapter — auto-discovers the renderer's framework
// capabilities via feature detection and builds an IDevToolsDataRenderer
// with all available systems wired.
//
// Games pass their renderer instance; the adapter probes for gpuProfiler,
// telemetryCollector, gpuResourceTracker, gcController, etc. and wires them.
// No hand-rolled adapter objects needed.
// ============================================================================

import type { IDevToolsDataRenderer } from "./types";

/**
 * Create an IDevToolsDataRenderer by feature-detecting the renderer's
 * framework systems. Works with any renderer that exposes the standard
 * GameRenderer fields (gpuProfiler, telemetryCollector, etc.) or the
 * minimal { getFPS() } surface.
 */
export function createDevToolsRendererAdapter(renderer: any): IDevToolsDataRenderer {
  return {
    getFPS: (): number => {
      return typeof renderer?.getFPS === "function" ? renderer.getFPS() : 0;
    },

    getGPUInfo: renderer?.gpuProfiler
      ? () => renderer.gpuProfiler.getGPUInfo?.() ?? null
      : renderer?.getGPUInfo ? () => renderer.getGPUInfo() : undefined,

    getGPUErrors: renderer?.gpuProfiler
      ? () => renderer.gpuProfiler.getGPUErrors?.() ?? []
      : renderer?.getGPUErrors ? () => renderer.getGPUErrors() : undefined,

    clearGPUErrors: renderer?.gpuProfiler
      ? () => renderer.gpuProfiler.clearGPUErrors?.()
      : renderer?.clearGPUErrors ? () => renderer.clearGPUErrors() : undefined,

    getFrameTelemetry: renderer?.telemetryCollector
      ? () => renderer.telemetryCollector.getFrameTelemetry?.() ?? null
      : renderer?.getFrameTelemetry ? () => renderer.getFrameTelemetry() : undefined,

    getGPUResourceTracker: () => {
      const tracker = renderer?.gpuResourceTracker ?? renderer?.getGPUResourceTracker?.();
      return tracker ?? null;
    },

    getTelemetryCollector: () => {
      const tc = renderer?.telemetryCollector ?? renderer?.getTelemetryCollector?.();
      return tc ?? null;
    },

    getGPUProfiler: () => {
      const p = renderer?.gpuProfiler ?? renderer?.getGPUProfiler?.();
      return p ?? null;
    },

    getFrameGraph: renderer?.getFrameGraph
      ? () => renderer.getFrameGraph()
      : undefined,

    setDebugMode: renderer?.setDebugMode
      ? (enabled: boolean) => renderer.setDebugMode(enabled)
      : undefined,

    getGCStats: renderer?.gcController
      ? () => renderer.gcController.getStats?.()
      : renderer?.getGCStats ? () => renderer.getGCStats() : undefined,

    setGCConfig: renderer?.gcController
      ? (config: any) => renderer.gcController.setConfig?.(config)
      : renderer?.setGCConfig ? (config: any) => renderer.setGCConfig(config) : undefined,

    forceMajorGC: renderer?.gcController
      ? () => renderer.gcController.forceMajorGC?.()
      : renderer?.forceMajorGC ? () => renderer.forceMajorGC() : undefined,
  };
}
