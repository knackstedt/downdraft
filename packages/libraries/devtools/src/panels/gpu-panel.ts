// ============================================================================
// gpu-panel.ts — GPU panel showing renderer GPU data sections.
//
// Displays adapter info, device limits, render pass timings, texture/memory
// stats, and pipeline cache info from the game's WebGPURenderer.
// ============================================================================

import { Container } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_GREEN, COLOR_TEXT_DIM } from "../shared/colors";
import { formatBytes, formatMs, makeKeyValueGrid, makeLabel, makeScrollPanel, makeSectionHeader } from "../shared/widgets";

export function renderGpuPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const renderer = ctx.renderer;
  const expanded = scene.getGpuExpanded();

  const scrollY = scene.getScrollY("gpu");
  const contentHeight = 800; // generous, scroll handles overflow
  const scroll = makeScrollPanel({ x: 0, y: 0, width: w, height: h, contentHeight, scrollY, hits });
  c.addChild(scroll.container);
  const content = scroll.content;

  let ry = 4;

  // ── Adapter Info ──
  const adapterExpanded = expanded.has("adapter");
  content.addChild(makeSectionHeader(
    { label: "Adapter Info", x: 0, y: ry, width: w, expanded: adapterExpanded },
    hits, () => { if (adapterExpanded) expanded.delete("adapter"); else expanded.add("adapter"); },
  ));
  ry += 24;
  if (adapterExpanded) {
    const adapterInfo = renderer?.getAdapterInfo?.() ?? {};
    const entries: { key: string; value: string }[] = [
      { key: "Vendor", value: adapterInfo.vendor ?? adapterInfo.vendorId ?? "unknown" },
      { key: "Architecture", value: adapterInfo.architecture ?? "unknown" },
      { key: "Device", value: adapterInfo.device ?? adapterInfo.deviceId ?? "unknown" },
      { key: "Description", value: adapterInfo.description ?? "unknown" },
      { key: "Type", value: adapterInfo.type ?? "unknown" },
    ];
    content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));
    ry += entries.length * 16 + 8;
  }

  // ── Device Limits ──
  const limitsExpanded = expanded.has("limits");
  content.addChild(makeSectionHeader(
    { label: "Device Limits", x: 0, y: ry, width: w, expanded: limitsExpanded },
    hits, () => { if (limitsExpanded) expanded.delete("limits"); else expanded.add("limits"); },
  ));
  ry += 24;
  if (limitsExpanded) {
    const device = renderer?.getDevice?.();
    const limits = device?.limits ?? {};
    const entries: { key: string; value: string }[] = [
      { key: "maxTextureDim2D", value: limits.maxTextureDimension2D ?? "?" },
      { key: "maxTextureArrayLayers", value: limits.maxTextureArrayLayers ?? "?" },
      { key: "maxBindGroups", value: limits.maxBindGroups ?? "?" },
      { key: "maxSampledTex/Stage", value: limits.maxSampledTexturesPerShaderStage ?? "?" },
      { key: "maxStorageBuf/Stage", value: limits.maxStorageBuffersPerShaderStage ?? "?" },
      { key: "maxStorageBufSize", value: limits.maxStorageBufferBindingSize ? formatBytes(limits.maxStorageBufferBindingSize) : "?" },
      { key: "maxBufferSize", value: limits.maxBufferSize ? formatBytes(limits.maxBufferSize) : "?" },
      { key: "maxVertexBufs", value: limits.maxVertexBuffers ?? "?" },
      { key: "maxVertexAttrs", value: limits.maxVertexAttributes ?? "?" },
    ];
    content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));
    ry += entries.length * 16 + 8;
  }

  // ── GPU Profiler Timings ──
  const profilerExpanded = expanded.has("profiler");
  content.addChild(makeSectionHeader(
    { label: "GPU Pass Timings", x: 0, y: ry, width: w, expanded: profilerExpanded },
    hits, () => { if (profilerExpanded) expanded.delete("profiler"); else expanded.add("profiler"); },
  ));
  ry += 24;
  if (profilerExpanded) {
    const profiler = renderer?.gpuProfiler;
    if (profiler) {
      const timings = profiler.getTimings?.() ?? profiler.getLastTimings?.() ?? {};
      const passNames = Object.keys(timings);
      if (passNames.length === 0) {
        content.addChild(makeLabel("No GPU timing data (timestamp-query may be unsupported)", 8, ry, COLOR_TEXT_DIM, 10));
        ry += 16;
      } else {
        const entries: { key: string; value: string }[] = passNames.map((name) => ({
          key: name, value: formatMs(timings[name]),
        }));
        content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));
        ry += entries.length * 16 + 8;
      }
    } else {
      content.addChild(makeLabel("GPU profiler not available", 8, ry, COLOR_TEXT_DIM, 10));
      ry += 16;
    }
  }

  // ── Texture / Memory Stats ──
  const memExpanded = expanded.has("memory");
  content.addChild(makeSectionHeader(
    { label: "Texture & Memory Stats", x: 0, y: ry, width: w, expanded: memExpanded },
    hits, () => { if (memExpanded) expanded.delete("memory"); else expanded.add("memory"); },
  ));
  ry += 24;
  if (memExpanded) {
    const tracker = renderer?.gpuResourceTracker;
    const entries: { key: string; value: string }[] = [];
    if (tracker) {
      const stats = tracker.getStats?.() ?? {};
      entries.push({ key: "Textures", value: stats.textures ?? stats.textureCount ?? "?" });
      entries.push({ key: "Buffers", value: stats.buffers ?? stats.bufferCount ?? "?" });
      entries.push({ key: "Texture Mem", value: stats.textureBytes ? formatBytes(stats.textureBytes) : "?" });
      entries.push({ key: "Buffer Mem", value: stats.bufferBytes ? formatBytes(stats.bufferBytes) : "?" });
    }
    // Process memory as fallback
    const mem = process.memoryUsage();
    entries.push({ key: "RSS", value: formatBytes(mem.rss) });
    entries.push({ key: "Heap", value: formatBytes(mem.heapUsed) });
    entries.push({ key: "Heap Total", value: formatBytes(mem.heapTotal) });
    entries.push({ key: "External", value: formatBytes(mem.external ?? 0) });
    content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));
    ry += entries.length * 16 + 8;
  }

  // ── Render Pipeline Info ──
  const pipelineExpanded = expanded.has("pipeline");
  content.addChild(makeSectionHeader(
    { label: "Render Pipeline", x: 0, y: ry, width: w, expanded: pipelineExpanded },
    hits, () => { if (pipelineExpanded) expanded.delete("pipeline"); else expanded.add("pipeline"); },
  ));
  ry += 24;
  if (pipelineExpanded) {
    const entries: { key: string; value: string }[] = [
      { key: "Format", value: renderer?.getFormat?.() ?? "bgra8unorm" },
      { key: "Depth Format", value: renderer?.getDepthFormat?.() ?? "depth24plus" },
      { key: "MSAA", value: renderer?.getMSAASampleCount?.() ?? 1 },
      { key: "Sim Valid", value: renderer?.getSimReader?.()?.isValid?.() ?? false },
      { key: "Frame", value: renderer?.getFrameCount?.() ?? renderer?._frameCount ?? "?" },
    ];
    content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));
    ry += entries.length * 16 + 8;
  }

  // ── Features ──
  const featuresExpanded = expanded.has("features");
  content.addChild(makeSectionHeader(
    { label: "Device Features", x: 0, y: ry, width: w, expanded: featuresExpanded },
    hits, () => { if (featuresExpanded) expanded.delete("features"); else expanded.add("features"); },
  ));
  ry += 24;
  if (featuresExpanded) {
    const device = renderer?.getDevice?.();
    const features = device?.features ?? new Set();
    const featureList = Array.from(features).map((f: unknown) => String(f));
    if (featureList.length === 0) {
      content.addChild(makeLabel("No special features enabled", 8, ry, COLOR_TEXT_DIM, 10));
      ry += 16;
    } else {
      for (const f of featureList) {
        content.addChild(makeLabel(`• ${f}`, 8, ry, COLOR_GREEN, 10));
        ry += 14;
      }
    }
    ry += 8;
  }

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  return c;
}
