// ============================================================================
// Plugin Tester — Main Entry Point
// WebGPU init (with Canvas2D fallback), game loop, scene setup, MCP setup
// ============================================================================

import { SimpleRenderer, type AgentVisual } from "./engine";
import { setupMCP } from "./mcp-setup";
import { initTestScene, type TestScene } from "./test-scene";
import { createLogger } from "@downdraft/engine/util/logger";
const log = createLogger();


function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms),
    ),
  ]);
}

function renderCanvas2D(
  canvas: HTMLCanvasElement,
  agents: AgentVisual[],
  w: number,
  h: number,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.fillStyle = "#0a0a12";
  ctx.fillRect(0, 0, w, h);

  // Grid
  const gridSize = 50;
  const halfRange = 25;
  ctx.strokeStyle = "#1a1a2e";
  ctx.lineWidth = 1;
  for (let i = -halfRange; i <= halfRange; i++) {
    const sx = w / 2 + (i * gridSize) - (-halfRange * gridSize);
    ctx.beginPath();
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
    ctx.stroke();
  }
  for (let i = -halfRange; i <= halfRange; i++) {
    const sy = h / 2 + (i * gridSize) - (-halfRange * gridSize);
    ctx.beginPath();
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
    ctx.stroke();
  }

  // Agents
  const scale = Math.min(w, h) / 60;
  const cx = w / 2;
  const cy = h / 2;
  for (const a of agents) {
    const px = cx + a.position[0] * scale;
    const py = cy + a.position[2] * scale;
    ctx.fillStyle = `rgb(${Math.round(a.color[0] * 255)},${Math.round(a.color[1] * 255)},${Math.round(a.color[2] * 255)})`;
    ctx.fillRect(px - 6, py - 6, 12, 12);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.strokeRect(px - 6, py - 6, 12, 12);
  }
}

async function main(): Promise<void> {
  const canvas = document.getElementById("canvas") as HTMLCanvasElement;
  const fallback = document.getElementById("fallback") as HTMLDivElement;
  const statusLine = document.getElementById("status-line") as HTMLDivElement;
  const errorLine = document.getElementById("error-line") as HTMLDivElement;
  const infoSections = document.getElementById("info-sections") as HTMLDivElement;

  // Initialize test scene first (doesn't need WebGPU)
  statusLine.textContent = "Initializing test scene...";
  const scene: TestScene = initTestScene();
  statusLine.textContent = "Test scene ready. Setting up MCP...";
  setupMCP(scene);

  // Try WebGPU with a hard 5s timeout
  let useWebGPU = false;
  let renderer: SimpleRenderer | null = null;

  if (navigator.gpu) {
    statusLine.textContent = "Requesting WebGPU adapter...";
    try {
      const adapter = await withTimeout(
        navigator.gpu.requestAdapter({ powerPreference: "high-performance" }),
        5000,
        "requestAdapter",
      );
      if (!adapter) throw new Error("No WebGPU adapter found");
      const device = await withTimeout(adapter.requestDevice(), 5000, "requestDevice");
      const context = canvas.getContext("webgpu") as GPUCanvasContext;
      const format = navigator.gpu.getPreferredCanvasFormat();
      renderer = new SimpleRenderer(device, context, format);
      await withTimeout(renderer.init(), 5000, "renderer.init");
      useWebGPU = true;
      statusLine.textContent = `Running — Renderer: WebGPU`;
    } catch (e) {
      log.warn("main", `WebGPU init failed, using Canvas2D fallback: ${e}`);
      statusLine.textContent = `Running — Renderer: Canvas2D (WebGPU unavailable: ${(e as Error).message})`;
      fallback.style.display = "none";
    }
  } else {
    statusLine.textContent = `Running — Renderer: Canvas2D (WebGPU not available)`;
  }

  // Resize canvas
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
  }
  resize();
  window.addEventListener("resize", resize);

  // Game loop
  let lastTime = performance.now();
  let frameCount = 0;
  let lastInfoUpdate = 0;
  const startTime = performance.now();

  function frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;
    frameCount++;

    scene.tick(dt);
    const agents = scene.getAgentVisuals();

    if (useWebGPU && renderer) {
      renderer.render(agents, canvas.width, canvas.height);
    } else {
      renderCanvas2D(canvas, agents, canvas.width, canvas.height);
    }

    if (now - lastInfoUpdate > 500) {
      lastInfoUpdate = now;
      const snapshot = scene.getSnapshot() as any;
      const navData = snapshot.navmesh;
      const waterData = snapshot.water;

      infoSections.innerHTML = `
        <div class="section">
          <span class="section-title">Renderer:</span> ${useWebGPU ? "WebGPU" : "Canvas2D"} | ${canvas.width}x${canvas.height} | DPR=${window.devicePixelRatio || 1}
        </div>
        <div class="section">
          <span class="section-title">NavMesh:</span> ${navData.polyCount} polys, ${navData.agents.length} agents
          ${navData.agents.map((a: any) => `#${a.index}(${a.state}) pos=[${a.pos.map((v: number) => v.toFixed(1)).join(", ")}]`).join(" | ")}
        </div>
        <div class="section">
          <span class="section-title">Water:</span> wind=${waterData.windSpeed}, waves=${waterData.waveCount}, h=[${waterData.sampleHeights.map((h: number) => h.toFixed(3)).join(", ")}]
        </div>
        <div class="section">
          <span class="section-title">FPS:</span> ${frameCount > 0 ? Math.round(frameCount / ((now - startTime) / 1000)) : 0} | Frame: ${frameCount} | Render: ${useWebGPU ? "WebGPU" : "Canvas2D"}
        </div>
      `;
    }

    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

main().catch((e) => {
  log.error("main", `Fatal error: ${e}`);
  const errorLine = document.getElementById("error-line");
  if (errorLine) {
    errorLine.textContent = `Fatal: ${e.message}`;
    errorLine.className = "error";
  }
});
