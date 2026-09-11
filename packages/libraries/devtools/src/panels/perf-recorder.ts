// ============================================================================
// perf-recorder.ts — Performance Recorder panel using CDP Profiler.
//
// Start/Stop recording buttons capture a CPU profile via the CDP Profiler
// domain. The captured profile is rendered as a flame graph (simplified:
// top-N hottest functions with bar widths proportional to self time).
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_GREEN, COLOR_RED, COLOR_TEXT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { formatMs, makeButton, makeLabel, makeScrollPanel } from "../shared/widgets";

export function renderPerfRecorderPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const recording = scene.isPerfRecording();
  const profile = scene.getLastProfile();

  // ── Toolbar ──
  const toolbar = new Graphics();
  toolbar.rect(0, 0, w, 30);
  toolbar.fill({ color: 0x111122, alpha: 0.95 });
  c.addChild(toolbar);

  // Record / Stop button
  if (!recording) {
    c.addChild(makeButton({
      label: "● Record", x: 8, y: 4, width: 90, height: 22,
      color: COLOR_RED, fontSize: 11,
    }, hits, async () => {
      scene.setPerfRecording(true);
      try { await ctx.cdp.startProfile(); } catch (e) { console.error("[PerfRecorder] start failed:", e); }
    }));
  } else {
    c.addChild(makeButton({
      label: "■ Stop", x: 8, y: 4, width: 90, height: 22,
      color: COLOR_GREEN, fontSize: 11,
    }, hits, async () => {
      scene.setPerfRecording(false);
      try {
        const prof = await ctx.cdp.stopProfile();
        scene.setLastProfile(prof);
      } catch (e) { console.error("[PerfRecorder] stop failed:", e); }
    }));
  }

  // Clear button
  c.addChild(makeButton({
    label: "Clear", x: 106, y: 4, width: 70, height: 22,
    color: COLOR_TEXT_DIM, fontSize: 11,
  }, hits, () => { scene.setLastProfile(null); }));

  // Status
  const statusText = recording ? "● Recording..." : (profile ? `Profile: ${profile.nodes.length} nodes, ${formatMs(profile.startTime)}–${formatMs(profile.endTime)}` : "Ready");
  c.addChild(makeLabel(statusText, 190, 8, recording ? COLOR_RED : COLOR_TEXT_DIM, 11));

  // ── Flame graph / hot functions ──
  const contentY = 34;
  const contentH = h - contentY - 4;
  const scrollY = scene.getScrollY("perf-recorder");

  if (!profile) {
    c.addChild(makeLabel("Press Record to capture a CPU profile via CDP Profiler.", 10, contentY + 10, COLOR_TEXT_DIM, 11));
    c.addChild(makeLabel("The profiler samples the main isolate's call stack.", 10, contentY + 28, COLOR_TEXT_DIM, 10));
    return c;
  }

  // Compute self-time for each node
  const nodeMap = new Map<number, any>();
  for (const n of profile.nodes) nodeMap.set(n.id, n);
  const selfTime = new Map<number, number>();
  for (const n of profile.nodes) selfTime.set(n.id, 0);
  // Time deltas map to node self-time
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const nodeId = profile.samples[i];
      const delta = profile.timeDeltas[i] ?? 0;
      selfTime.set(nodeId, (selfTime.get(nodeId) ?? 0) + delta);
    }
  }

  // Sort by self time descending, take top 50
  const sorted = profile.nodes
    .map((n: any) => ({ node: n, self: selfTime.get(n.id) ?? 0 }))
    .sort((a: any, b: any) => b.self - a.self)
    .slice(0, 50);

  const maxSelf = sorted.length > 0 ? sorted[0].self : 1;
  const rowH = 20;
  const contentHeight = sorted.length * rowH + 40;
  const scroll = makeScrollPanel({ x: 0, y: contentY, width: w, height: contentH, contentHeight, scrollY, hits });
  c.addChild(scroll.container);
  const content = scroll.content;

  // Header
  content.addChild(makeLabel("Function", 8, 2, COLOR_TEXT_DIM, 10));
  content.addChild(makeLabel("Self Time", w - 200, 2, COLOR_TEXT_DIM, 10));
  content.addChild(makeLabel("% Total", w - 90, 2, COLOR_TEXT_DIM, 10));

  let ry = 20;
  for (const { node, self } of sorted) {
    const fn = node.callFrame.functionName || "(anonymous)";
    const url = node.callFrame.url || "";
    const lineNo = node.callFrame.lineNumber ?? 0;
    const detail = `${fn}  ${url}:${lineNo}`;
    const pct = maxSelf > 0 ? (self / maxSelf) : 0;
    const pctTotal = profile.startTime && profile.endTime
      ? (self / (profile.endTime - profile.startTime)) * 100
      : 0;

    // Bar background
    const barW = Math.max(2, pct * (w - 220));
    const bar = new Graphics();
    bar.rect(8, ry, barW, rowH - 2);
    bar.fill({ color: pctTotal > 10 ? COLOR_RED : pctTotal > 3 ? COLOR_YELLOW : COLOR_GREEN, alpha: 0.3 });
    content.addChild(bar);

    // Function name (truncate)
    const maxLen = Math.floor((w - 230) / 6);
    const truncName = detail.length > maxLen ? detail.slice(0, maxLen) + "…" : detail;
    content.addChild(makeLabel(truncName, 12, ry + 2, COLOR_TEXT, 10));

    // Self time
    content.addChild(makeLabel(formatMs(self), w - 200, ry + 2, COLOR_TEXT_DIM, 10));
    // Percentage
    content.addChild(makeLabel(pctTotal.toFixed(1) + "%", w - 90, ry + 2, COLOR_TEXT_DIM, 10));

    ry += rowH;
  }

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  return c;
}
