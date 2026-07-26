import { DebugLines } from "./debug-draw/lines.ts";
import { DebugDrawQueue } from "./debug-draw/queue.ts";
import { MeshBuilder } from "./mesh/builder.ts";
import { RPC } from "./platform/rpc.ts";
import { RenderLoop } from "./render/render-loop.ts";
import { InputSABChannel } from "./sab/input.ts";
import { createSABForChannel } from "./sab/protocol.ts";
import { Camera } from "./scene/camera.ts";
import { TelemetryCollector } from "./telemetry/collector.ts";
import { createLogger } from "./util/logger.ts";

const log = createLogger();

const rpc = new RPC();

// Create SAB channels
const inputSAB = createSABForChannel("input", 1);
const transformSAB = createSABForChannel("transform", 1);
const inputChannel = new InputSABChannel(inputSAB);

// Telemetry
const telemetry = new TelemetryCollector(true);

// Camera
const camera = new Camera();
camera.distance = 5;
camera.pitch = 0.3;
camera.orbit(0, 0);

// Mesh
const mesh = MeshBuilder.cube(1);

// Debug draw
const debugQueue = new DebugDrawQueue();
const debugLines = new DebugLines(debugQueue);

// Render loop (will be initialized when canvas is available)
let renderLoop: RenderLoop | null = null;

// RPC handlers
rpc.registerHandler("getFPS", () => {
  return telemetry.getAverageFrameTime();
});

rpc.registerHandler("getTelemetry", () => {
  return {
    frameTime: telemetry.getAverageFrameTime(),
    p95: telemetry.getFrameTimePercentile(0.95),
    p99: telemetry.getFrameTimePercentile(0.99),
  };
});

rpc.registerHandler("getEntityCount", () => {
  return 1; // Just the cube for now
});

// Input from webview
rpc.on("input", (payload) => {
  const p = payload as {
    keys: number[];
    mouseX: number;
    mouseY: number;
    mouseDeltaX: number;
    mouseDeltaY: number;
    mouseButtons: number[];
    wheelDelta: number;
  };

  inputChannel.write(
    p.keys,
    p.mouseX,
    p.mouseY,
    p.mouseDeltaX,
    p.mouseDeltaY,
    p.mouseButtons,
    p.wheelDelta,
    [],
    [],
  );

  // Orbit camera with mouse drag
  if (p.mouseButtons[0]) {
    camera.orbit(p.mouseDeltaX * 0.005, p.mouseDeltaY * 0.005);
  }
  if (p.wheelDelta !== 0) {
    camera.zoom(p.wheelDelta * 0.01);
  }
});

// Debug toggles from devtools UI
rpc.on("debugToggles", (payload) => {
  if (renderLoop) {
    renderLoop.setDebugToggles(payload as import("./render/render-loop.ts").DebugToggleState);
  }
});

// Expose SABs to renderer via preload
export const sabBuffers = {
  input: inputSAB,
  transform: transformSAB,
};

export const engineConfig = {
  camera,
  mesh,
  telemetry,
  rpc,
};

export async function initEngine(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<void> {
  renderLoop = new RenderLoop({
    canvas,
    mesh,
    camera,
    telemetry,
    mode: "gbuffer",
    debugQueue,
    clearColor: { r: 0.1, g: 0.1, b: 0.12, a: 1 },
  });

  const success = await renderLoop.init();
  if (success) {
    renderLoop.start();
    log.info("DownDraft", "Engine started — deferred pipeline active");
  } else {
    log.error("DownDraft", "Failed to initialize render loop");
  }
}

export function stopEngine(): void {
  renderLoop?.destroy();
  renderLoop = null;
}
