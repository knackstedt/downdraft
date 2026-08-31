// ============================================================================
// Visual Test Bench — Main Entry Point
// WebGPU init, test switching, render loop, React UI mount
// ============================================================================

import { getCanvas, getOverlay } from "@downdraft/app/renderer";
import "@downdraft/app/renderer/downdraft-base.css";
import React from "react";
import { createRoot } from "react-dom/client";
import App from "./app";
import { type BenchState } from "./bench-state";
import { getTests, type ITestRenderer, type TestContext, type VisualTest } from "./test-registry";
import "./tests/index"; // triggers test registration via Vite glob

// ── Shared state (mutated by the render loop, read by React) ──

const state: BenchState = {
  tests: getTests(),
  activeTestId: null,
  fps: 0,
  error: null,
  webgpuAvailable: false,
  rendererReady: false,
};

const listeners = new Set<() => void>();
function notify(): void {
  listeners.forEach((l) => l());
}
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function getState(): BenchState {
  return state;
}

// ── Active test lifecycle ──

let activeRenderer: ITestRenderer | null = null;
let activeTest: VisualTest | null = null;
let device: GPUDevice | null = null;
let canvas: HTMLCanvasElement | null = null;
let format: GPUTextureFormat = "bgra8unorm";
let canvasWidth = 0;
let canvasHeight = 0;

async function activateTest(testId: string): Promise<void> {
  // Dispose the previous test.
  if (activeRenderer) {
    try {
      activeRenderer.dispose();
    } catch (e) {
      console.error(`[test-bench] error disposing previous test:`, e);
    }
    activeRenderer = null;
    activeTest = null;
  }

  const test = state.tests.find((t) => t.id === testId);
  if (!test) {
    state.error = `Test "${testId}" not found`;
    notify();
    return;
  }

  if (test.requiresWebGPU !== false && !device) {
    state.error = "WebGPU is required for this test but is not available";
    notify();
    return;
  }

  state.activeTestId = testId;
  state.error = null;
  state.rendererReady = false;
  notify();

  try {
    activeTest = test;
    activeRenderer = test.createRenderer(canvas!);
    const ctx: TestContext = {
      device: device!,
      canvas: canvas!,
      format,
      width: canvasWidth,
      height: canvasHeight,
      dt: 0,
      elapsedTime: 0,
    };
    await activeRenderer.init(ctx);
    state.rendererReady = true;
    notify();
  } catch (e) {
    state.error = `Failed to init test "${test.name}": ${(e as Error).message}`;
    state.rendererReady = false;
    activeRenderer = null;
    activeTest = null;
    notify();
  }
}

// ── WebGPU init ──

async function initWebGPU(): Promise<boolean> {
  if (!navigator.gpu) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) return false;
    device = await adapter.requestDevice();
    const ctx = canvas!.getContext("webgpu")!;
    format = navigator.gpu.getPreferredCanvasFormat();
    ctx.configure({
      device,
      format,
      alphaMode: "premultiplied",
      usage: GPUTextureUsage.RENDER_ATTACHMENT,
    });
    return true;
  } catch (e) {
    console.warn("[test-bench] WebGPU init failed:", e);
    return false;
  }
}

// ── Main bootstrap ──

async function main(): Promise<void> {
  canvas = getCanvas(0);
  const overlay = getOverlay(0);

  // Mount React UI.
  const root = createRoot(overlay);
  root.render(
    <React.StrictMode>
      <App
        getState={getState}
        subscribe={subscribe}
        onSelectTest={(id: string) => { void activateTest(id); }}
      />
    </React.StrictMode>,
  );

  // Init WebGPU.
  state.webgpuAvailable = await initWebGPU();
  if (!state.webgpuAvailable) {
    state.error = "WebGPU not available — only Canvas2D tests will work";
  }
  notify();

  // Resize handler.
  function resize(): void {
    const dpr = Math.min(window.devicePixelRatio, 2);
    const w = Math.floor(canvas!.clientWidth * dpr);
    const h = Math.floor(canvas!.clientHeight * dpr);
    if (canvas!.width !== w || canvas!.height !== h) {
      canvas!.width = w;
      canvas!.height = h;
    }
    canvasWidth = w;
    canvasHeight = h;
    activeRenderer?.resize(w, h);
  }
  resize();
  window.addEventListener("resize", resize);

  // Auto-select the first test.
  if (state.tests.length > 0) {
    await activateTest(state.tests[0].id);
  }

  // Render loop.
  let lastTime = performance.now();
  let frameCount = 0;
  let fpsLastTime = lastTime;

  function frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    frameCount++;

    // FPS update (every 500ms).
    if (now - fpsLastTime > 500) {
      state.fps = Math.round((frameCount * 1000) / (now - fpsLastTime));
      frameCount = 0;
      fpsLastTime = now;
      notify();
    }

    resize();

    if (activeRenderer && state.rendererReady && device) {
      const ctx: TestContext = {
        device,
        canvas: canvas!,
        format,
        width: canvasWidth,
        height: canvasHeight,
        dt,
        elapsedTime: now / 1000,
      };
      try {
        activeRenderer.render(ctx);
      } catch (e) {
        state.error = `Render error in "${activeTest?.name}": ${(e as Error).message}`;
        notify();
      }
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((e) => {
  console.error("[test-bench] Fatal:", e);
  state.error = `Fatal: ${(e as Error).message}`;
  notify();
});
