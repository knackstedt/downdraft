// ============================================================================
// ChunkDebugOverlay — draws chunk borders as a 2D canvas overlay, toggled
// via F2.
//
// Each frame (while visible), reads the camera + active grid origin from the
// renderer and draws:
//   - Thin lines at every chunk boundary (active-grid coords that are
//     multiples of CHUNK_W / CHUNK_H).
//   - A thicker highlighted rectangle around the active simulation window
//     (the full ACTIVE_GRID_W × ACTIVE_GRID_H area).
//
// The overlay is a single <canvas> sized to the window, drawn via the 2D
// context. It's pointer-events:none so it never blocks input. F2 toggles
// visibility; the toggle state is local to this component.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { CHUNK_H, CHUNK_W } from "../shared/constants";
import { useGameStore } from "../stores/game-store";

const canvasStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 11, // above the game canvas (z-index 0), below menus (z-index 100)
};

interface ActiveGridOrigin {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CameraLike {
  x: number;
  y: number;
  zoom: number;
  canvasW: number;
  canvasH: number;
}

export function ChunkDebugOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  // F2 toggles the overlay.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        setVisible((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // The rAF loop only runs while visible. When hidden, no rAF is scheduled,
  // so the 2D canvas layer is never dirtied — this avoids a per-frame DOM
  // commit (Commit + PrePaint + Layerize) that would otherwise saturate the
  // GPU process and cause dropped frames at 360Hz.
  useEffect(() => {
    if (!visible) return;
    const canvas = canvasRef.current;
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

      const store = useGameStore.getState();
      const renderer = store.renderer as
        | { getCamera?: () => CameraLike; getActiveGridOrigin?: () => ActiveGridOrigin }
        | null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!renderer?.getCamera || !renderer?.getActiveGridOrigin) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const cam = renderer.getCamera();
      const origin = renderer.getActiveGridOrigin();

      // --- Draw chunk border lines ---
      // The camera is in active-grid coordinates. Chunk boundaries are at
      // multiples of CHUNK_W / CHUNK_H within the active grid.
      // Screen → grid: (screen - canvas/2) / zoom * dpr + cam
      const halfGridW = (cam.canvasW / 2) / cam.zoom;
      const halfGridH = (cam.canvasH / 2) / cam.zoom;
      const gridX0 = cam.x - halfGridW;
      const gridX1 = cam.x + halfGridW;
      const gridY0 = cam.y - halfGridH;
      const gridY1 = cam.y + halfGridH;

      const kxStart = Math.floor(gridX0 / CHUNK_W);
      const kxEnd = Math.ceil(gridX1 / CHUNK_W);
      const kyStart = Math.floor(gridY0 / CHUNK_H);
      const kyEnd = Math.ceil(gridY1 / CHUNK_H);

      // Helper: grid coords → screen pixels (with DPR scaling)
      const gridToScreenX = (gx: number) => ((gx - cam.x) * cam.zoom + cam.canvasW / 2) * dpr;
      const gridToScreenY = (gy: number) => ((gy - cam.y) * cam.zoom + cam.canvasH / 2) * dpr;

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(255, 255, 0, 0.25)";
      ctx.beginPath();
      for (let kx = kxStart; kx <= kxEnd; kx++) {
        const gx = kx * CHUNK_W;
        const sx = gridToScreenX(gx);
        ctx.moveTo(sx, 0);
        ctx.lineTo(sx, canvas.height);
      }
      for (let ky = kyStart; ky <= kyEnd; ky++) {
        const gy = ky * CHUNK_H;
        const sy = gridToScreenY(gy);
        ctx.moveTo(0, sy);
        ctx.lineTo(canvas.width, sy);
      }
      ctx.stroke();

      // --- Highlight the active simulation window ---
      // The active grid covers [0, ACTIVE_GRID_W] × [0, ACTIVE_GRID_H]
      // in active-grid coords. Draw a thicker cyan rectangle around it.
      const tlx = gridToScreenX(origin.x);
      const tly = gridToScreenY(origin.y);
      const brx = gridToScreenX(origin.x + origin.w);
      const bry = gridToScreenY(origin.y + origin.h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(0, 255, 255, 0.7)";
      ctx.strokeRect(tlx, tly, brx - tlx, bry - tly);

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      // Clear the canvas on unmount/hide so no stale drawing remains.
      const c = canvasRef.current;
      if (c) {
        const cx = c.getContext("2d");
        cx?.clearRect(0, 0, c.width, c.height);
      }
    };
  }, [visible]);

  return <canvas ref={canvasRef} style={canvasStyle} />;
}
