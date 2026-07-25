import { BrowserWindow, GpuWindow, defineElectrobunRPC } from "electrobun";
import { join } from "path";
import type { DownDraftRPC } from "../rpc-schema.ts";

const WIDTH = 1280;
const HEIGHT = 720;

const rpc = defineElectrobunRPC<DownDraftRPC, "bun">("bun", {
  handlers: {
    requests: {
      getTelemetry: () => {
        return {
          frameTime: 16.67,
          p95: 18.2,
          p99: 22.5,
        };
      },
      getEntityCount: () => {
        return 1;
      },
    },
    messages: {},
  },
});

const gpuWindow = new GpuWindow({
  title: "DownDraft Engine",
  frame: {
    x: 100,
    y: 100,
    width: WIDTH,
    height: HEIGHT,
  },
  titleBarStyle: "default",
  transparent: false,
  activate: true,
});

gpuWindow.show();

const uiWindow = new BrowserWindow({
  title: "DownDraft Engine UI",
  frame: {
    x: 100,
    y: 100,
    width: WIDTH,
    height: HEIGHT,
  },
  url: "views://index/index.html",
  preload: null,
  viewsRoot: join(import.meta.dir, "..", "views"),
  renderer: "native",
  transparent: true,
  passthrough: false,
  titleBarStyle: "hidden",
  rpc,
  navigationRules: null,
  sandbox: false,
});

uiWindow.setAlwaysOnTop(true);
uiWindow.showInactive();

console.log("[DownDraft] Electrobun windows created (GpuWindow + UI overlay)");
