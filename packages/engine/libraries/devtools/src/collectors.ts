// ============================================================================
// collectors.ts — transport-agnostic devtools data collection.
//
// The egui mirror encodes these results and pushes them over FFI; the web
// mirror sends them as JSON over the devtools WebSocket. Collection is
// identical either way — this module is the single source of truth.
// ============================================================================

import type { CdpProfile } from "./cdp-bridge";

export interface CollectorContext {
  renderer: any;
  gameScene?: any;
  profilingSAB: SharedArrayBuffer | null;
}

export interface ThreadInfo { id: string; name: string; kind: number }
export interface TreeRow {
  id: number; parentId: number; depth: number; childCount: number;
  kind: number; label: string; detail: string;
}
export interface GpuInfoJson {
  entries: { key: string; value: string; isHeader: boolean }[];
  frameTimes: [number, number][];
  memHistory: number[];
}
export interface MetricsSlot {
  slotIndex: number; name: string; runtime: number;
  history: {
    cpuPercent: number; heapUsed: number; heapTotal: number;
    gcPauseMaxUs: number; taskLatencyP95Us: number;
  }[];
}
export interface ProfileJson {
  nodes: { id: number; hitCount: number; callFrame: string; url: string; line: number; children: number[] }[];
  startUs: number; endUs: number;
  samples: number[]; timeDeltasUs: number[];
}

// Lazy-load the ProfilingSAB reader (avoids importing @downdraft/engine/profiling
// at module load time; it may not be available in all contexts).
let profilingMod: any = undefined;
async function loadProfilingMod(): Promise<any> {
  if (profilingMod !== undefined) return profilingMod;
  try {
    profilingMod = await import("@downdraft/engine/profiling");
  } catch {
    profilingMod = null;
  }
  return profilingMod;
}

function formatBytes(bytes: any): string {
  const b = typeof bytes === "bigint" ? Number(bytes) : bytes;
  if (!b || b < 0 || !Number.isFinite(b)) return String(bytes);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** Thread list: main + ProfilingSAB worker slots + registered eval threads. */
export async function collectThreads(
  ctx: CollectorContext,
  evalThreadIds: string[],
): Promise<ThreadInfo[]> {
  const threads: ThreadInfo[] = [{ id: "main", name: "main", kind: 0 }];
  if (ctx.profilingSAB) {
    try {
      const mod = await loadProfilingMod();
      if (mod) {
        const { ProfilingSABReader, computeProfilingSABLayout } = mod;
        const layout = computeProfilingSABLayout();
        if (ctx.profilingSAB.byteLength >= layout.byteLength) {
          const reader = new ProfilingSABReader(ctx.profilingSAB, layout);
          const snapshot = reader.readSnapshot();
          snapshot.slots.forEach((slot: any) => {
            threads.push({
              id: `slot-${slot.slotIndex}`,
              name: slot.name || `worker-${slot.slotIndex}`,
              kind: 1,
            });
          });
        }
      }
    } catch { /* profiling unavailable */ }
  }
  evalThreadIds.forEach((id) => {
    if (!threads.find((t) => t.id === id)) threads.push({ id, name: id, kind: 1 });
  });
  return threads;
}

/** Scene-graph tree (label + ctor + child counts). */
export function collectSceneTree(ctx: CollectorContext): TreeRow[] {
  const stage = ctx.gameScene?.stage;
  if (!stage) return [];
  const nodes: TreeRow[] = [];
  let idCounter = 1;
  const collect = (node: any, parentId: number, depth: number): void => {
    const id = idCounter++;
    // Prefer `label` (some scene-graph hosts warn on `name` access); fall
    // back to `name` for hosts that only set that.
    const nodeLabel = typeof node.label === "string" ? node.label
      : typeof node.name === "string" ? node.name : "";
    const ctorName = node.constructor?.name ?? "Node";
    nodes.push({
      id, parentId, depth,
      childCount: node.children?.length ?? 0,
      kind: 0,
      label: nodeLabel || ctorName,
      detail: nodeLabel ? ctorName : "",
    });
    node.children?.forEach((child: any) => collect(child, id, depth + 1));
  };
  collect(stage, -1, 0);
  return nodes;
}

/** DOM tree: scene-graph stage or ECS entities depending on mode. */
export function collectDomTree(ctx: CollectorContext, mode: "scene" | "ecs"): TreeRow[] {
  if (mode === "scene") return collectSceneTree(ctx);
  const simReader = ctx.renderer?.simReader ?? ctx.renderer?.getSimReader?.();
  if (!simReader?.isValid?.()) return [];
  const nodes: TreeRow[] = [];
  let idCounter = 1;
  try {
    simReader.getEntityCount();
    const iter = simReader.iterEntities?.();
    iter?.forEach((ent: any) => {
      const id = idCounter++;
      const f32 = ent.f32;
      const u32 = ent.u32;
      const entityType = u32?.[0] ?? 0;
      const x = f32?.[0] ?? 0;
      const y = f32?.[1] ?? 0;
      const z = f32?.[2] ?? 0;
      nodes.push({
        id, parentId: -1, depth: 0, childCount: 0, kind: 1,
        label: `Entity ${ent.idx}`,
        detail: `type=${entityType} pos=(${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)})`,
      });
    });
  } catch { /* sim reader hiccup */ }
  return nodes;
}

/** GPU adapter/limits/telemetry/resources/pass-timings as key-value entries. */
export function collectGpuInfo(ctx: CollectorContext): GpuInfoJson {
  const r = ctx.renderer;
  const entries: { key: string; value: string; isHeader: boolean }[] = [];
  try {
    const adapterInfo = r?.getAdapterInfo?.() ?? r?.gpuProfiler?.getAdapterInfo?.() ?? {};
    entries.push({ key: "GPU Adapter Info", value: "", isHeader: true });
    entries.push({ key: "Vendor", value: adapterInfo.vendor ?? "?", isHeader: false });
    entries.push({ key: "Architecture", value: adapterInfo.architecture ?? "?", isHeader: false });
    entries.push({ key: "Description", value: adapterInfo.description ?? "?", isHeader: false });
    entries.push({ key: "Device", value: adapterInfo.device ?? "?", isHeader: false });

    const device = r?.getDevice?.() ?? r?.device;
    const limits = device?.limits;
    if (limits) {
      entries.push({ key: "Device Limits", value: "", isHeader: true });
      const maxBuf = limits.maxBufferSize;
      const maxBufNum = typeof maxBuf === "bigint" ? Number(maxBuf) : maxBuf;
      const maxBufDisplay = maxBufNum > 4 * 1024 * 1024 * 1024 ? "4 GB (capped)" : formatBytes(maxBuf);
      entries.push({ key: "maxBufferSize", value: maxBufDisplay, isHeader: false });
      entries.push({ key: "maxTextureDim2D", value: String(limits.maxTextureDimension2D), isHeader: false });
      entries.push({ key: "maxTextureDim3D", value: String(limits.maxTextureDimension3D), isHeader: false });
      entries.push({ key: "maxTextureArrayLayers", value: String(limits.maxTextureArrayLayers), isHeader: false });
      entries.push({ key: "maxStorageBuffer", value: formatBytes(limits.maxStorageBufferBindingSize), isHeader: false });
      entries.push({ key: "maxUniformBuffer", value: formatBytes(limits.maxUniformBufferBindingSize), isHeader: false });
      entries.push({ key: "maxBindGroups", value: String(limits.maxBindGroups), isHeader: false });
      entries.push({ key: "maxVertexAttributes", value: String(limits.maxVertexAttributes), isHeader: false });
      entries.push({ key: "maxVertexBuffers", value: String(limits.maxVertexBuffers), isHeader: false });
      entries.push({ key: "maxColorAttachments", value: String(limits.maxColorAttachments), isHeader: false });
      entries.push({ key: "maxComputeWorkgroupsPerDimension", value: String(limits.maxComputeWorkgroupsPerDimension), isHeader: false });
    }

    const telemetry = r?.telemetryCollector;
    if (telemetry?.getFrameTelemetry) {
      const ft = telemetry.getFrameTelemetry();
      if (ft) {
        entries.push({ key: "Frame Performance", value: "", isHeader: true });
        entries.push({ key: "FPS", value: String(Math.round(ft.fps ?? 0)), isHeader: false });
        entries.push({ key: "Avg frame time", value: `${(ft.avgFrameTime ?? 0).toFixed(2)} ms`, isHeader: false });
        entries.push({ key: "P95 frame time", value: `${(ft.p95 ?? 0).toFixed(2)} ms`, isHeader: false });
        entries.push({ key: "P99 frame time", value: `${(ft.p99 ?? 0).toFixed(2)} ms`, isHeader: false });
        entries.push({ key: "GPU time", value: `${(ft.gpuTimeMs ?? 0).toFixed(2)} ms`, isHeader: false });
        entries.push({ key: "Draw calls", value: String(ft.drawCalls ?? 0), isHeader: false });
        entries.push({ key: "Triangles", value: String(ft.triangles ?? 0), isHeader: false });
      }
    }

    const resTracker = r?.gpuResourceTracker;
    if (resTracker?.getStats) {
      const stats = resTracker.getStats();
      entries.push({ key: "GPU Resources", value: "", isHeader: true });
      entries.push({ key: "Textures", value: String(stats.textureCount), isHeader: false });
      entries.push({ key: "Buffers", value: String(stats.bufferCount), isHeader: false });
      entries.push({ key: "Texture VRAM", value: formatBytes(stats.textureBytes), isHeader: false });
      entries.push({ key: "Buffer VRAM", value: formatBytes(stats.bufferBytes), isHeader: false });
      entries.push({ key: "Total VRAM", value: formatBytes(stats.totalBytes), isHeader: false });
      const topResources = (stats.resources ?? []).slice(0, 15);
      if (topResources.length > 0) {
        entries.push({ key: "Top Resources", value: "", isHeader: true });
        topResources.forEach((res: any) => {
          entries.push({
            key: res.label ?? res.type ?? "resource",
            value: `${res.type} ${formatBytes(res.size)} ${res.dims ?? ""}`.trim(),
            isHeader: false,
          });
        });
      }
    }

    const profiler = r?.gpuProfiler;
    if (profiler?.getPassTimings) {
      const timings = profiler.getPassTimings();
      if (timings.length > 0) {
        entries.push({ key: "Per-Pass GPU Timing", value: "", isHeader: true });
        timings.forEach((t: any) => {
          const gpu = t.gpuMs > 0 ? `gpu=${t.gpuMs.toFixed(2)}ms` : "";
          entries.push({
            key: t.name ?? "pass",
            value: `cpu=${t.cpuMs.toFixed(2)}ms ${gpu} draws=${t.drawCalls} tris=${t.triangles}`.trim(),
            isHeader: false,
          });
        });
      }
    }

    if (profiler?.getGPUErrors) {
      const errors = profiler.getGPUErrors();
      if (errors.length > 0) {
        entries.push({ key: "GPU Errors", value: "", isHeader: true });
        errors.forEach((e: any) => {
          entries.push({ key: e.type ?? "error", value: e.message ?? String(e), isHeader: false });
        });
      }
    }

    const frameGraph = r?.frameGraph ?? r?.getFrameGraph?.();
    if (frameGraph) {
      const slots = frameGraph.getSlots?.() ?? frameGraph.getSlotRegistry?.()?.getAll?.() ?? [];
      if (slots.length > 0) {
        entries.push({ key: "Frame Graph Passes", value: "", isHeader: true });
        slots.forEach((s: any) => {
          const name = typeof s === "string" ? s : (s.name ?? s.label ?? "slot");
          entries.push({ key: name, value: "", isHeader: false });
        });
      }
    }
  } catch (err) {
    entries.push({ key: "Error", value: String(err), isHeader: false });
  }

  const frameTimes: [number, number][] = [];
  const memHistory: number[] = [];
  try {
    const telemetry = r?.telemetryCollector;
    if (telemetry?.getFrameTimes) {
      const times = telemetry.getFrameTimes();
      for (let i = Math.max(0, times.length - 120); i < times.length; i++) {
        frameTimes.push([times[i], 0]);
      }
    }
    const profiler = r?.gpuProfiler;
    if (profiler?.getPassTimings) {
      const timings = profiler.getPassTimings();
      if (timings.length > 0 && frameTimes.length > 0) {
        let gpuTotal = 0;
        timings.forEach((t: any) => { gpuTotal += t.gpuMs ?? 0;; });
        if (frameTimes.length > 0) frameTimes[frameTimes.length - 1][1] = gpuTotal;
      }
    }
    const resTracker = r?.gpuResourceTracker;
    if (resTracker?.getStats) memHistory.push(resTracker.getStats().totalBytes);
  } catch { /* ignore */ }

  return { entries, frameTimes, memHistory };
}

/** Per-thread metrics snapshot (main via performance.memory, workers via SAB). */
export async function collectMetrics(ctx: CollectorContext): Promise<MetricsSlot[]> {
  const slots: MetricsSlot[] = [{
    slotIndex: 0,
    name: "main",
    runtime: 0,
    history: [{
      cpuPercent: 0,
      heapUsed: (performance as any)?.memory?.usedJSHeapSize ?? 0,
      heapTotal: (performance as any)?.memory?.totalJSHeapSize ?? 0,
      gcPauseMaxUs: 0,
      taskLatencyP95Us: 0,
    }],
  }];

  if (ctx.profilingSAB) {
    try {
      const mod = await loadProfilingMod();
      if (mod) {
        const { ProfilingSABReader, computeProfilingSABLayout } = mod;
        const layout = computeProfilingSABLayout();
        if (ctx.profilingSAB.byteLength >= layout.byteLength) {
          const reader = new ProfilingSABReader(ctx.profilingSAB, layout);
          const snapshot = reader.readSnapshot();
          snapshot.slots.forEach((slot: any) => {
            slots.push({
              slotIndex: slot.slotIndex,
              name: slot.name || `worker-${slot.slotIndex}`,
              runtime: slot.runtime ?? 0,
              history: [{
                cpuPercent: slot.metrics?.cpuPercent ?? 0,
                heapUsed: slot.metrics?.heapUsed ?? 0,
                heapTotal: slot.metrics?.heapTotal ?? 0,
                gcPauseMaxUs: slot.metrics?.gcPauseMaxUs ?? 0,
                taskLatencyP95Us: slot.metrics?.taskLatencyP95Us ?? 0,
              }],
            });
          });
        }
      }
    } catch { /* profiling unavailable */ }
  }
  return slots;
}

/** Normalize a CDP CPU profile into the shared JSON shape. */
export function collectProfile(profile: CdpProfile): ProfileJson {
  const nodes = (profile.nodes ?? []).map((n: any) => ({
    id: n.id,
    hitCount: n.hitCount ?? 0,
    callFrame: n.callFrame?.functionName ?? "?",
    url: n.callFrame?.url ?? "",
    line: n.callFrame?.lineNumber ?? 0,
    children: n.children ?? [],
  }));
  return {
    nodes,
    startUs: profile.startTime ?? 0,
    endUs: profile.endTime ?? 0,
    samples: profile.samples ?? [],
    timeDeltasUs: profile.timeDeltas ?? [],
  };
}
