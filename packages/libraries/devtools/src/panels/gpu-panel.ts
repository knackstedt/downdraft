// ============================================================================
// gpu-panel.ts — GPU panel with bar charts, memory over time, frame timing.
//
// Sections (expandable):
// - Adapter Info
// - Device Limits
// - GPU Pass Timings (bar chart: each pass's gpuMs, sorted by time, colored by category)
// - Texture & Memory Stats (texture/buffer breakdown)
// - GPU Memory Over Time (line chart: totalBytes, 120 samples)
// - Frame Timing (line chart: CPU vs GPU frame time)
// - Render Pipeline
// - Device Features
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { BG_CHART, COLOR_BLUE, COLOR_CYAN, COLOR_GREEN, COLOR_ORANGE, COLOR_TEXT, COLOR_TEXT_BRIGHT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { formatBytes, formatMs, makeKeyValueGrid, makeLabel, makeLineChart, makeScrollPanel, makeSectionHeader, type LineSeries } from "../shared/widgets";

export function renderGpuPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const renderer = ctx.renderer;
  const expanded = scene.getGpuExpanded();

  const scrollY = scene.getScrollY("gpu");
  // Content height is computed dynamically as we build sections.
  // Use a generous estimate; the scroll panel handles overflow.
  const contentHeight = 1400;
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

  // ── GPU Pass Timings (bar chart) ──
  const profilerExpanded = expanded.has("profiler");
  content.addChild(makeSectionHeader(
    { label: "GPU Pass Timings", x: 0, y: ry, width: w, expanded: profilerExpanded },
    hits, () => { if (profilerExpanded) expanded.delete("profiler"); else expanded.add("profiler"); },
  ));
  ry += 24;
  if (profilerExpanded) {
    const profiler = renderer?.gpuProfiler;
    if (profiler) {
      const timings = profiler.getPassTimings?.() ?? [];
      if (timings.length === 0) {
        content.addChild(makeLabel("No GPU timing data (timestamp-query may be unsupported)", 8, ry, COLOR_TEXT_DIM, 10));
        ry += 16;
      } else {
        // Sort by gpuMs descending
        const sorted = [...timings].sort((a: any, b: any) => (b.gpuMs ?? 0) - (a.gpuMs ?? 0));
        const maxGpuMs = Math.max(...sorted.map((t: any) => t.gpuMs ?? 0), 0.1);
        const barH = 16;
        const labelW = 100;
        const barX = labelW + 8;
        const barW = w - barX - 80;

        // Header
        content.addChild(makeLabel("Pass", 8, ry, COLOR_TEXT_DIM, 9));
        content.addChild(makeLabel("GPU Time", barX, ry, COLOR_TEXT_DIM, 9));
        content.addChild(makeLabel("Draws", barX + barW + 8, ry, COLOR_TEXT_DIM, 9));
        ry += 16;

        for (const t of sorted) {
          const gpuMs = t.gpuMs ?? 0;
          const category = t.category ?? "render";
          const barColor = category === "compute" ? COLOR_ORANGE : category === "blit" ? COLOR_TEXT_DIM : COLOR_BLUE;
          const barLen = Math.max(2, (gpuMs / maxGpuMs) * barW);

          // Pass name (truncated)
          const name = t.name.length > 16 ? t.name.slice(0, 16) + "…" : t.name;
          content.addChild(makeLabel(name, 8, ry + 1, COLOR_TEXT, 9));

          // Bar background
          const barBg = new Graphics();
          barBg.roundRect(barX, ry, barW, barH - 2, 2);
          barBg.fill({ color: BG_CHART, alpha: 0.6 });
          content.addChild(barBg);

          // Bar fill
          const bar = new Graphics();
          bar.roundRect(barX, ry, barLen, barH - 2, 2);
          bar.fill({ color: barColor, alpha: 0.7 });
          content.addChild(bar);

          // GPU time label
          content.addChild(makeLabel(formatMs(gpuMs), barX + barLen + 4, ry + 1, COLOR_TEXT_BRIGHT, 9));

          // Draw calls
          content.addChild(makeLabel(String(t.drawCalls ?? 0), barX + barW + 8, ry + 1, COLOR_TEXT_DIM, 9));

          ry += barH;
        }
        ry += 8;

        // Summary
        const totalGpuMs = sorted.reduce((sum: number, t: any) => sum + (t.gpuMs ?? 0), 0);
        const totalDraws = sorted.reduce((sum: number, t: any) => sum + (t.drawCalls ?? 0), 0);
        const totalTris = sorted.reduce((sum: number, t: any) => sum + (t.triangles ?? 0), 0);
        content.addChild(makeLabel(`Total: ${formatMs(totalGpuMs)} GPU | ${totalDraws} draws | ${totalTris} tris`, 8, ry, COLOR_TEXT_DIM, 9));
        ry += 16;
      }
    } else {
      content.addChild(makeLabel("GPU profiler not available", 8, ry, COLOR_TEXT_DIM, 10));
      ry += 16;
    }
  }

  // ── Texture & Memory Stats ──
  const memExpanded = expanded.has("memory");
  content.addChild(makeSectionHeader(
    { label: "Texture & Memory Stats", x: 0, y: ry, width: w, expanded: memExpanded },
    hits, () => { if (memExpanded) expanded.delete("memory"); else expanded.add("memory"); },
  ));
  ry += 24;
  let currentTotalBytes = 0;
  let currentCpuFrameMs = 0;
  let currentGpuFrameMs = 0;
  if (memExpanded) {
    const tracker = renderer?.gpuResourceTracker;
    const entries: { key: string; value: string }[] = [];
    if (tracker) {
      const stats = tracker.getStats?.() ?? {};
      entries.push({ key: "Textures", value: String(stats.textureCount ?? "?") });
      entries.push({ key: "Buffers", value: String(stats.bufferCount ?? "?") });
      entries.push({ key: "Texture Mem", value: stats.textureBytes ? formatBytes(stats.textureBytes) : "?" });
      entries.push({ key: "Buffer Mem", value: stats.bufferBytes ? formatBytes(stats.bufferBytes) : "?" });
      entries.push({ key: "Total GPU Mem", value: stats.totalBytes ? formatBytes(stats.totalBytes) : "?" });
      currentTotalBytes = stats.totalBytes ?? 0;

      // Breakdown by format (if resources list available)
      const resources = stats.resources ?? [];
      if (resources.length > 0) {
        const byFormat = new Map<string, { count: number; bytes: number }>();
        for (const r of resources) {
          const fmt = r.format ?? "unknown";
          const existing = byFormat.get(fmt) ?? { count: 0, bytes: 0 };
          existing.count++;
          existing.bytes += r.size ?? 0;
          byFormat.set(fmt, existing);
        }
        entries.push({ key: "— Formats —", value: "" });
        for (const [fmt, info] of byFormat) {
          entries.push({ key: fmt, value: `${info.count} (${formatBytes(info.bytes)})` });
        }
      }
    }
    // Process memory as fallback
    const mem = process.memoryUsage();
    entries.push({ key: "— Process —", value: "" });
    entries.push({ key: "RSS", value: formatBytes(mem.rss) });
    entries.push({ key: "Heap", value: formatBytes(mem.heapUsed) });
    entries.push({ key: "Heap Total", value: formatBytes(mem.heapTotal) });
    entries.push({ key: "External", value: formatBytes(mem.external ?? 0) });
    content.addChild(makeKeyValueGrid({ x: 8, y: ry, width: w - 16, entries, fontSize: 10, rowHeight: 16 }));
    ry += entries.length * 16 + 8;
  }

  // ── GPU Memory Over Time ──
  const memChartExpanded = expanded.has("mem-chart");
  content.addChild(makeSectionHeader(
    { label: "GPU Memory Over Time", x: 0, y: ry, width: w, expanded: memChartExpanded },
    hits, () => { if (memChartExpanded) expanded.delete("mem-chart"); else expanded.add("mem-chart"); },
  ));
  ry += 24;
  if (memChartExpanded) {
    const memHistory = scene.getGpuMemHistory();
    if (memHistory.length > 1) {
      const dataMb = memHistory.map((b) => b / 1024 / 1024);
      const series: LineSeries[] = [
        { data: dataMb, color: COLOR_GREEN, label: "GPU Mem (MB)" },
      ];
      content.addChild(makeLabel("GPU Memory (MB)", 8, ry, COLOR_GREEN, 10));
      ry += 16;
      content.addChild(makeLineChart({
        x: 8, y: ry, width: w - 16, height: 120,
        series, yLabel: "MB",
      }));
      ry += 140;
    } else {
      content.addChild(makeLabel("Collecting data...", 8, ry, COLOR_TEXT_DIM, 10));
      ry += 16;
    }
  }

  // ── Frame Timing ──
  const frameChartExpanded = expanded.has("frame-chart");
  content.addChild(makeSectionHeader(
    { label: "Frame Timing (CPU vs GPU)", x: 0, y: ry, width: w, expanded: frameChartExpanded },
    hits, () => { if (frameChartExpanded) expanded.delete("frame-chart"); else expanded.add("frame-chart"); },
  ));
  ry += 24;
  if (frameChartExpanded) {
    const frameHistory = scene.getGpuFrameTimeHistory();
    // Compute current frame times for sampling
    const profiler = renderer?.gpuProfiler;
    if (profiler) {
      const timings = profiler.getPassTimings?.() ?? [];
      currentGpuFrameMs = timings.reduce((sum: number, t: any) => sum + (t.gpuMs ?? 0), 0);
      currentCpuFrameMs = timings.reduce((sum: number, t: any) => sum + (t.cpuMs ?? 0), 0);
    }
    scene.sampleGpuMetrics(currentTotalBytes, currentCpuFrameMs, currentGpuFrameMs);

    if (frameHistory.cpu.length > 1) {
      const series: LineSeries[] = [
        { data: frameHistory.cpu, color: COLOR_BLUE, label: "CPU (ms)" },
        { data: frameHistory.gpu, color: COLOR_ORANGE, label: "GPU (ms)" },
      ];
      content.addChild(makeLabel("Frame Time (ms)", 8, ry, COLOR_GREEN, 10));
      ry += 16;
      content.addChild(makeLineChart({
        x: 8, y: ry, width: w - 16, height: 120,
        series, yLabel: "ms",
      }));
      ry += 140;
    } else {
      content.addChild(makeLabel("Collecting data...", 8, ry, COLOR_TEXT_DIM, 10));
      ry += 16;
    }
  }

  // ── Render Pipeline ──
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
      { key: "MSAA", value: String(renderer?.getMSAASampleCount?.() ?? 1) },
      { key: "Sim Valid", value: String(renderer?.getSimReader?.()?.isValid?.() ?? false) },
      { key: "Frame", value: String(renderer?.getFrameCount?.() ?? renderer?._frameCount ?? "?") },
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
      // Categorize features
      const categories: Record<string, string[]> = {
        "texture-compression": [],
        "shader": [],
        "timestamp": [],
        "other": [],
      };
      for (const f of featureList) {
        if (f.includes("texture-compression")) categories["texture-compression"].push(f);
        else if (f.includes("shader")) categories["shader"].push(f);
        else if (f.includes("timestamp")) categories["timestamp"].push(f);
        else categories["other"].push(f);
      }
      const catColors: Record<string, number> = {
        "texture-compression": COLOR_GREEN,
        "shader": COLOR_YELLOW,
        "timestamp": COLOR_CYAN,
        "other": COLOR_TEXT_DIM,
      };
      for (const [cat, feats] of Object.entries(categories)) {
        if (feats.length === 0) continue;
        content.addChild(makeLabel(`— ${cat} —`, 8, ry, catColors[cat] ?? COLOR_TEXT_DIM, 9));
        ry += 12;
        for (const f of feats) {
          content.addChild(makeLabel(`• ${f}`, 12, ry, catColors[cat] ?? COLOR_TEXT_DIM, 9));
          ry += 12;
        }
        ry += 4;
      }
    }
    ry += 8;
  }

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  return c;
}
