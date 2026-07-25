import { BrowserWindow, defineElectrobunRPC } from "electrobun";
import { join } from "path";
import type { DownDraftRPC } from "../rpc-schema.ts";

const WIDTH = 1280;
const HEIGHT = 720;

const rpc = defineElectrobunRPC<DownDraftRPC, "bun">("bun", {
  handlers: {
    requests: {
      getTelemetry: () => ({ frameTime: 0, p95: 0, p99: 0 }),
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
  renderer: "cef",
  transparent: false,
  titleBarStyle: "default",
  rpc,
  navigationRules: null,
  sandbox: false,
});

win.show();

console.log("[DownDraft] Electrobun window created (single-window mode)");
