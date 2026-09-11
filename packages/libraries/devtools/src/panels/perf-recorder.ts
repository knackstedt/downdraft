// ============================================================================
// perf-recorder.ts — Performance Recorder with full flame graph + timeline.
//
// Features:
// - Record / Stop / Clear buttons
// - Timeline ruler with time markers
// - Full flame graph: stacked by call depth, width = total time, colored by category
// - Click a frame to see call stack + details
// - Zoom controls (+ / - / reset)
// - Profile metadata: duration, node count, sample count
// ============================================================================

import { Container, Graphics } from "pixi.js";
import type { CdpProfile } from "../cdp-bridge";
import type { DebuggerScene } from "../debugger-scene";
import { COLOR_BORDER, COLOR_GREEN, COLOR_ORANGE, COLOR_RED, COLOR_TEXT, COLOR_TEXT_BRIGHT, COLOR_TEXT_DIM, COLOR_YELLOW } from "../shared/colors";
import { formatMs, makeButton, makeLabel, makeScrollPanel } from "../shared/widgets";

const TOOLBAR_HEIGHT = 32;
const RULER_HEIGHT = 20;
const FRAME_HEIGHT = 16;
const MAX_FRAMES = 500; // cap for performance
const DETAIL_PANEL_HEIGHT = 120;

// Frame colors by category
function frameColor(name: string): number {
  const lower = name.toLowerCase();
  if (lower.includes("gc") || lower.includes("garbage")) return COLOR_RED;
  if (lower.includes("idle") || lower.includes("wait")) return COLOR_TEXT_DIM;
  if (lower.includes("(program)") || lower.includes("(root)")) return COLOR_ORANGE;
  if (lower.includes("native")) return COLOR_YELLOW;
  return COLOR_GREEN;
}

// ── Flame graph data structures ──

interface FlameFrame {
  nodeId: number;
  name: string;
  url: string;
  line: number;
  depth: number;
  startTime: number;  // microseconds
  totalTime: number;  // microseconds (self + children)
  selfTime: number;   // microseconds
  children: FlameFrame[];
}

export function renderPerfRecorderPanel(scene: DebuggerScene, x: number, y: number, w: number, h: number): Container {
  const c = new Container();
  c.x = x;
  c.y = y;
  const ctx = scene.getContext();
  const hits = scene.getHits();
  const recording = scene.isPerfRecording();
  const profile = scene.getLastProfile();
  const zoom = (scene as any)._perfZoom ?? 1.0;
  const selectedFrame = (scene as any)._perfSelectedFrame ?? null;

  // ── Toolbar ──
  const toolbar = new Graphics();
  toolbar.rect(0, 0, w, TOOLBAR_HEIGHT);
  toolbar.fill({ color: 0x111122, alpha: 0.95 });
  toolbar.rect(0, TOOLBAR_HEIGHT - 1, w, 1);
  toolbar.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(toolbar);

  // Record / Stop button
  if (!recording) {
    c.addChild(makeButton({
      label: "● Record", x: 4, y: 4, width: 80, height: 22,
      color: COLOR_RED, fontSize: 10,
    }, hits, async () => {
      scene.setPerfRecording(true);
      try { await ctx.cdp.startProfile(); } catch (e) { console.error("[PerfRecorder] start failed:", e); }
    }));
  } else {
    c.addChild(makeButton({
      label: "■ Stop", x: 4, y: 4, width: 80, height: 22,
      color: COLOR_GREEN, fontSize: 10,
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
    label: "Clear", x: 90, y: 4, width: 60, height: 22,
    color: COLOR_TEXT_DIM, fontSize: 10,
  }, hits, () => {
    scene.setLastProfile(null);
    (scene as any)._perfSelectedFrame = null;
    (scene as any)._perfZoom = 1.0;
  }));

  // Zoom controls (only when profile exists)
  if (profile) {
    c.addChild(makeButton({
      label: "Zoom +", x: 158, y: 4, width: 56, height: 22,
      color: COLOR_TEXT, fontSize: 10,
    }, hits, () => {
      (scene as any)._perfZoom = Math.min(20, ((scene as any)._perfZoom ?? 1) * 1.5);
    }));
    c.addChild(makeButton({
      label: "Zoom -", x: 220, y: 4, width: 56, height: 22,
      color: COLOR_TEXT, fontSize: 10,
    }, hits, () => {
      (scene as any)._perfZoom = Math.max(0.5, ((scene as any)._perfZoom ?? 1) / 1.5);
    }));
    c.addChild(makeButton({
      label: "Reset", x: 282, y: 4, width: 50, height: 22,
      color: COLOR_TEXT_DIM, fontSize: 10,
    }, hits, () => {
      (scene as any)._perfZoom = 1.0;
    }));
  }

  // Status
  const statusText = recording
    ? "● Recording..."
    : (profile
      ? `${profile.nodes.length} nodes | ${profile.samples?.length ?? 0} samples | ${formatMs((profile.endTime - profile.startTime) / 1000)} | zoom ${zoom.toFixed(1)}x`
      : "Ready");
  c.addChild(makeLabel(statusText, 340, 8, recording ? COLOR_RED : COLOR_TEXT_DIM, 10));

  // ── Content area ──
  const contentY = TOOLBAR_HEIGHT + 2;
  const contentH = h - contentY - 4;

  if (!profile) {
    c.addChild(makeLabel("Press Record to capture a CPU profile via CDP Profiler.", 10, contentY + 10, COLOR_TEXT_DIM, 11));
    c.addChild(makeLabel("The profiler samples the main isolate's call stack.", 10, contentY + 28, COLOR_TEXT_DIM, 10));
    c.addChild(makeLabel("After stopping, a flame graph will be displayed.", 10, contentY + 44, COLOR_TEXT_DIM, 10));
    return c;
  }

  // ── Build flame graph ──
  const flameRoot = buildFlameGraph(profile);
  const maxDepth = getMaxDepth(flameRoot);
  const totalDuration = profile.endTime - profile.startTime;

  // ── Timeline ruler ──
  drawTimelineRuler(c, w, contentY, totalDuration, zoom);

  // ── Flame graph (scrollable) ──
  const flameY = contentY + RULER_HEIGHT;
  const flameH = contentH - RULER_HEIGHT - DETAIL_PANEL_HEIGHT;
  const flameContentW = w * zoom;
  const flameContentH = Math.max(flameH, (maxDepth + 1) * FRAME_HEIGHT + 10);
  const scrollY = scene.getScrollY("perf-recorder");
  const scrollX = (scene as any)._perfScrollX ?? 0;
  const scroll = makeScrollPanel({ x: 0, y: flameY, width: w, height: flameH, contentHeight: flameContentH, scrollY: hits ? scrollY : 0, hits });
  c.addChild(scroll.container);
  const content = scroll.content;

  // Draw flame frames
  drawFlameFrames(content, scene, hits, flameRoot, 0, 0, flameContentW, totalDuration, selectedFrame);

  // Pop the scroll panel's hit offset.
  hits.popOffset();

  // ── Detail panel (bottom) ──
  drawFrameDetail(c, scene, selectedFrame, profile, 0, flameY + flameH + 4, w, DETAIL_PANEL_HEIGHT - 4);

  return c;
}

// ── Build flame graph from CDP profile ──

function buildFlameGraph(profile: CdpProfile): FlameFrame {
  const nodeMap = new Map<number, any>();
  for (const n of profile.nodes) nodeMap.set(n.id, n);

  // Compute self time for each node
  const selfTime = new Map<number, number>();
  for (const n of profile.nodes) selfTime.set(n.id, 0);
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      const nodeId = profile.samples[i];
      const delta = profile.timeDeltas[i] ?? 0;
      selfTime.set(nodeId, (selfTime.get(nodeId) ?? 0) + delta);
    }
  }

  // Find root nodes (nodes not in any children array)
  const allChildren = new Set<number>();
  for (const n of profile.nodes) {
    for (const childId of n.children ?? []) allChildren.add(childId);
  }
  const rootIds = profile.nodes.filter((n) => !allChildren.has(n.id)).map((n) => n.id);

  // Build tree recursively
  function buildNode(nodeId: number, depth: number, startTime: number): FlameFrame {
    const node = nodeMap.get(nodeId);
    const self = selfTime.get(nodeId) ?? 0;
    const children: FlameFrame[] = [];
    let childStart = startTime;
    for (const childId of node?.children ?? []) {
      const child = buildNode(childId, depth + 1, childStart);
      children.push(child);
      childStart += child.totalTime;
    }
    const totalTime = self + children.reduce((sum, c) => sum + c.totalTime, 0);
    return {
      nodeId,
      name: node?.callFrame?.functionName || "(anonymous)",
      url: node?.callFrame?.url || "",
      line: node?.callFrame?.lineNumber ?? 0,
      depth,
      startTime,
      totalTime,
      selfTime: self,
      children,
    };
  }

  // Single root
  if (rootIds.length === 1) {
    return buildNode(rootIds[0], 0, 0);
  }
  // Multiple roots — wrap in a virtual root
  const rootChildren: FlameFrame[] = [];
  let childStart = 0;
  for (const rid of rootIds) {
    const child = buildNode(rid, 1, childStart);
    rootChildren.push(child);
    childStart += child.totalTime;
  }
  return {
    nodeId: -1,
    name: "(root)",
    url: "",
    line: 0,
    depth: 0,
    startTime: 0,
    totalTime: childStart,
    selfTime: 0,
    children: rootChildren,
  };
}

function getMaxDepth(frame: FlameFrame): number {
  let max = frame.depth;
  for (const child of frame.children) {
    const d = getMaxDepth(child);
    if (d > max) max = d;
  }
  return max;
}

// ── Draw flame frames ──

function drawFlameFrames(
  content: Container, scene: DebuggerScene, hits: any,
  frame: FlameFrame, x: number, y: number, w: number, totalDuration: number,
  selectedFrame: number | null,
): void {
  if (totalDuration <= 0) return;
  const frameW = (frame.totalTime / totalDuration) * w;
  if (frameW < 1) return; // too small to render

  const fy = y + frame.depth * FRAME_HEIGHT;
  const color = frameColor(frame.name);
  const isSelected = selectedFrame === frame.nodeId;

  // Frame bar
  const bar = new Graphics();
  bar.rect(x, fy, frameW, FRAME_HEIGHT - 1);
  bar.fill({ color, alpha: isSelected ? 0.95 : 0.7 });
  if (isSelected) {
    bar.stroke({ color: 0xffffff, width: 1 });
  }
  content.addChild(bar);

  // Label (if bar is wide enough)
  if (frameW > 30) {
    const maxChars = Math.floor(frameW / 6);
    const label = frame.name.length > maxChars ? frame.name.slice(0, maxChars) + "…" : frame.name;
    content.addChild(makeLabel(label, x + 2, fy + 1, 0x000000, 9));
  }

  // Click handler
  hits.add(x, fy, frameW, FRAME_HEIGHT - 1, () => {
    (scene as any)._perfSelectedFrame = frame.nodeId;
  });

  // Recurse into children
  let childX = x;
  for (const child of frame.children) {
    drawFlameFrames(content, scene, hits, child, childX, y, w, totalDuration, selectedFrame);
    childX += (child.totalTime / totalDuration) * w;
  }
}

// ── Timeline ruler ──

function drawTimelineRuler(c: Container, w: number, y: number, totalDuration: number, zoom: number): void {
  const bg = new Graphics();
  bg.rect(0, y, w, RULER_HEIGHT);
  bg.fill({ color: 0x111122, alpha: 0.95 });
  bg.rect(0, y + RULER_HEIGHT - 1, w, 1);
  bg.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(bg);

  if (totalDuration <= 0) return;

  // Time markers
  const scaledDuration = totalDuration;
  const markerCount = Math.min(10, Math.max(4, Math.floor(w / 60)));
  for (let i = 0; i <= markerCount; i++) {
    const mx = (i / markerCount) * w;
    const timeMs = (i / markerCount) * scaledDuration / 1000;
    c.addChild(makeLabel(formatMs(timeMs), mx + 2, y + 3, COLOR_TEXT_DIM, 9));
    const tick = new Graphics();
    tick.moveTo(mx, y);
    tick.lineTo(mx, y + RULER_HEIGHT);
    tick.stroke({ color: COLOR_BORDER, alpha: 0.3, width: 1 });
    c.addChild(tick);
  }
}

// ── Frame detail panel ──

function drawFrameDetail(
  c: Container, scene: DebuggerScene,
  selectedFrame: number | null, profile: CdpProfile | null,
  x: number, y: number, w: number, h: number,
): void {
  const bg = new Graphics();
  bg.rect(x, y, w, h);
  bg.fill({ color: 0x111122, alpha: 0.95 });
  bg.rect(x, y, w, 1);
  bg.fill({ color: COLOR_BORDER, alpha: 0.5 });
  c.addChild(bg);

  c.addChild(makeLabel("Frame Details", x + 8, y + 4, COLOR_GREEN, 11));

  if (!selectedFrame || !profile) {
    c.addChild(makeLabel("Click a flame graph frame to see details", x + 8, y + 22, COLOR_TEXT_DIM, 10));
    return;
  }

  // Find the node
  const node = profile.nodes.find((n) => n.id === selectedFrame);
  if (!node) {
    c.addChild(makeLabel("Frame not found", x + 8, y + 22, COLOR_TEXT_DIM, 10));
    return;
  }

  // Compute self time
  let selfTime = 0;
  if (profile.samples && profile.timeDeltas) {
    for (let i = 0; i < profile.samples.length; i++) {
      if (profile.samples[i] === selectedFrame) {
        selfTime += profile.timeDeltas[i] ?? 0;
      }
    }
  }

  const fn = node.callFrame.functionName || "(anonymous)";
  const url = node.callFrame.url || "";
  const line = node.callFrame.lineNumber ?? 0;
  const col = node.callFrame.columnNumber ?? 0;
  const totalDuration = profile.endTime - profile.startTime;
  const pctTotal = totalDuration > 0 ? (selfTime / totalDuration) * 100 : 0;

  let ry = y + 22;
  c.addChild(makeLabel(`Function: ${fn}`, x + 8, ry, COLOR_TEXT_BRIGHT, 10));
  ry += 14;
  if (url) {
    c.addChild(makeLabel(`Source: ${url}:${line}:${col}`, x + 8, ry, COLOR_TEXT_DIM, 9));
    ry += 12;
  }
  c.addChild(makeLabel(`Self time: ${formatMs(selfTime / 1000)} (${pctTotal.toFixed(1)}%)`, x + 8, ry, COLOR_YELLOW, 10));
  ry += 14;
  c.addChild(makeLabel(`Hit count: ${node.hitCount ?? 0}`, x + 8, ry, COLOR_TEXT_DIM, 9));
  ry += 12;

  // Call stack (path from root to this node)
  const stack = findCallStack(profile, selectedFrame);
  if (stack.length > 0) {
    c.addChild(makeLabel("Call stack:", x + 8, ry, COLOR_GREEN, 9));
    ry += 12;
    for (let i = 0; i < Math.min(stack.length, 6); i++) {
      const s = stack[i];
      const sFn = s.callFrame.functionName || "(anonymous)";
      c.addChild(makeLabel(`  ${i}: ${sFn}`, x + 12, ry, COLOR_TEXT_DIM, 8));
      ry += 11;
    }
    if (stack.length > 6) {
      c.addChild(makeLabel(`  ... ${stack.length - 6} more`, x + 12, ry, COLOR_TEXT_DIM, 8));
    }
  }
}

function findCallStack(profile: CdpProfile, nodeId: number): any[] {
  const parentMap = new Map<number, number>();
  for (const n of profile.nodes) {
    for (const childId of n.children ?? []) {
      parentMap.set(childId, n.id);
    }
  }
  const stack: any[] = [];
  let current = nodeId;
  const nodeMap = new Map(profile.nodes.map((n) => [n.id, n]));
  while (current != null) {
    const node = nodeMap.get(current);
    if (!node) break;
    stack.unshift(node);
    current = parentMap.get(current) ?? null;
  }
  return stack;
}
