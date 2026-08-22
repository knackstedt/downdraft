// ============================================================================
// ChunkDebugOverlay — draws chunk borders as a 2D canvas overlay, toggled
// via F2.
//
// Each frame (while visible), reads the camera + active grid origin from the
// renderer and draws:
//   - Thin lines at every chunk boundary (world coords that are multiples of
//     CHUNK_W / CHUNK_H).
//   - A thicker highlighted rectangle around the active simulation window
//     (the (2*ACTIVE_RADIUS_CHUNKS+1)² chunk area centered on the player).
//
// The overlay is a single <canvas> sized to the window, drawn via the 2D
// context. It's pointer-events:none so it never blocks input. F2 toggles
// visibility; the toggle state is local to this component.
// ============================================================================

import { createSignal, onCleanup, onMount } from "solid-js";
import { CHUNK_H, CHUNK_W } from "../../shared/constants";
import { worldToScreen, type Camera2D } from "../../renderer/camera";
import { rendererSnapshot } from "../stores/game-store";
import type { JSX } from "solid-js";

const canvasStyle: JSX.CSSProperties = {
  position: "absolute",
  inset: 0,
  "pointer-events": "none",
  "z-index": "11", // above the game canvas (z-index 0), below menus (z-index 100)
};

export function ChunkDebugOverlay() {
  let canvasRef: HTMLCanvasElement | undefined;
  const [visible, setVisible] = createSignal(false);
  // Ref mirror of current visibility so the rAF loop reads the current value
  let visibleNow = false;

  onMount(() => {
    // F2 toggles the overlay
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        setVisible((v) => {
          const next = !v;
          visibleNow = next;
          return next;
        });
      }
    };
    window.addEventListener("keydown", handler);
    onCleanup(() => window.removeEventListener("keydown", handler));

    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    let running = true;

    const tick = () => {
      if (!running) return;
      const dpr = window.devicePixelRatio || 1;
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      const pxW = Math.floor(cssW * dpr);
      const pxH = Math.floor(cssH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }

      if (!visibleNow) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        raf = requestAnimationFrame(tick);
        return;
      }

      const snap = rendererSnapshot();
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!snap) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const cam: Camera2D = { x: snap.camX, y: snap.camY, zoom: snap.camZoom, width: snap.camWidth, height: snap.camHeight };
      const origin = { x: snap.gridOriginX, y: snap.gridOriginY, w: snap.gridOriginW, h: snap.gridOriginH };

      // --- Draw chunk border lines ---
      // Vertical lines at world X = k * CHUNK_W, horizontal at world Y = k * CHUNK_H.
      // Compute the range of k visible on screen from the camera bounds.
      // Screen left → world x: (0 - w/2)/zoom + cam.x = cam.x - w/(2*zoom)
      // Screen right → world x: cam.x + w/(2*zoom)
      const halfWorldW = cam.width / (2 * cam.zoom);
      const halfWorldH = cam.height / (2 * cam.zoom);
      const worldX0 = cam.x - halfWorldW;
      const worldX1 = cam.x + halfWorldW;
      const worldY0 = cam.y - halfWorldH;
      const worldY1 = cam.y + halfWorldH;

      const kxStart = Math.floor(worldX0 / CHUNK_W);
      const kxEnd = Math.ceil(worldX1 / CHUNK_W);
      const kyStart = Math.floor(worldY0 / CHUNK_H);
      const kyEnd = Math.ceil(worldY1 / CHUNK_H);

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 0, 0.25)";
      ctx.beginPath();
      for (let kx = kxStart; kx <= kxEnd; kx++) {
        const wx = kx * CHUNK_W;
        const s = worldToScreen(cam, wx, 0);
        ctx.moveTo(s.x, 0);
        ctx.lineTo(s.x, canvas.height);
      }
      for (let ky = kyStart; ky <= kyEnd; ky++) {
        const wy = ky * CHUNK_H;
        const s = worldToScreen(cam, 0, wy);
        ctx.moveTo(0, s.y);
        ctx.lineTo(canvas.width, s.y);
      }
      ctx.stroke();

      // --- Highlight the active simulation window ---
      // The active grid covers [origin.x, origin.x + origin.w] × [origin.y, origin.y + origin.h]
      // in world coords. Draw a thicker cyan rectangle around it.
      const tl = worldToScreen(cam, origin.x, origin.y);
      const br = worldToScreen(cam, origin.x + origin.w, origin.y + origin.h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0, 255, 255, 0.7)";
      ctx.strokeRect(
        tl.x,
        tl.y,
        br.x - tl.x,
        br.y - tl.y,
      );

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    onCleanup(() => {
      running = false;
      cancelAnimationFrame(raf);
    });
  });

  return <canvas ref={canvasRef} style={canvasStyle} />;
}
