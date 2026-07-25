import { BrowserWindow, defineElectrobunRPC } from "electrobun";
import { join } from "path";
import type { DownDraftRPC } from "../rpc-schema.ts";

const WIDTH = 1280;
const HEIGHT = 720;

// Real telemetry tracking
let lastFrameTime = performance.now();
let frameTimes: number[] = [];

function startFrameLoop() {
  setInterval(() => {
    const now = performance.now();
    const dt = now - lastFrameTime;
    lastFrameTime = now;
    frameTimes.push(dt);
    if (frameTimes.length > 120) frameTimes.shift();
  }, 1000 / 120);
}

function getTelemetry() {
  if (frameTimes.length === 0) return { frameTime: 0, p95: 0, p99: 0 };
  const sorted = [...frameTimes].sort((a, b) => a - b);
  const avg = frameTimes.reduce((s, v) => s + v, 0) / frameTimes.length;
  const p95Idx = Math.floor(sorted.length * 0.95);
  const p99Idx = Math.floor(sorted.length * 0.99);
  return {
    frameTime: avg,
    p95: sorted[p95Idx] ?? avg,
    p99: sorted[p99Idx] ?? avg,
  };
}

const rpc = defineElectrobunRPC<DownDraftRPC, "bun">("bun", {
  handlers: {
    requests: {
      getTelemetry: () => getTelemetry(),
      getEntityCount: () => 1,
    },
    messages: {},
  },
});

// Single window: native titlebar for dragging, electrobun-wgpu for GPU, React overlay on top
const win = new BrowserWindow({
  title: "DownDraft Engine",
  frame: { x: 100, y: 100, width: WIDTH, height: HEIGHT },
  url: "views://index/index.html",
  preload: null,
  viewsRoot: join(import.meta.dir, "..", "views"),
  renderer: "native",
  transparent: false,
  titleBarStyle: "default",
  rpc,
  navigationRules: null,
  sandbox: false,
});

win.show();

startFrameLoop();

console.log("[DownDraft] Electrobun window created (single-window mode)");
