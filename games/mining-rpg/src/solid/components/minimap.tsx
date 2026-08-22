// ============================================================================
// Minimap — a small canvas overlay in the top-left corner showing a top-down
// view of the area around the player.
//
// Samples the active grid + explored grid from the renderer's grid reader and
// draws a downscaled representation:
//   - Solid terrain cells: dark gray/brown
//   - Air (explored): dark blue (caves/tunnels)
//   - Unexplored: black
//   - Ore cells: colored by ore type (bright spots)
//   - Water/lava: blue/red
//   - Player: white dot with direction indicator
//   - Signpost: yellow marker
//
// The minimap covers a configurable world-cell radius around the player
// (default 256 cells = 256x256 world cells mapped to ~150x150 pixels).
// ============================================================================

import type { JSX } from "solid-js";
import { onCleanup, onMount, Show } from "solid-js";
import { gameStore, MINIMAP_SIZE, readMinimapPixels, rendererSnapshot } from "../stores/game-store";

const WORLD_RADIUS = 200; // world cells from player center to edge (total view = 2*RADIUS)

const containerStyle: JSX.CSSProperties = {
  position: "absolute",
  top: "8px",
  left: "8px",
  "z-index": "12",
  "pointer-events": "none",
  "border-radius": "6px",
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,0.2)",
  "box-shadow": "0 2px 8px rgba(0,0,0,0.5)",
};

const canvasStyle: JSX.CSSProperties = {
  display: "block",
  width: `${MINIMAP_SIZE}px`,
  height: `${MINIMAP_SIZE}px`,
};

const labelStyle: JSX.CSSProperties = {
  position: "absolute",
  bottom: "2px",
  right: "4px",
  "font-size": "9px",
  "font-family": "monospace",
  color: "rgba(255,255,255,0.5)",
  "pointer-events": "none",
};

export function Minimap() {
  let canvasRef: HTMLCanvasElement | undefined;

  onMount(() => {
    const canvas = canvasRef;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const pxSize = MINIMAP_SIZE * dpr;
    canvas.width = pxSize;
    canvas.height = pxSize;

    let raf = 0;
    let running = true;

    const tick = () => {
      if (!running) return;
      const snap = rendererSnapshot();
      const pixels = readMinimapPixels();

      // Clear with black background
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (pixels && snap) {
        // The main thread has pre-rendered the minimap pixels into the SAB.
        // We just blit them to the canvas. The pixels are at MINIMAP_SIZE
        // resolution (no DPR scaling), so we scale up via putImageData + scale.
        // Actually, putImageData doesn't scale. We need to use a temporary
        // canvas at MINIMAP_SIZE and then drawImage scaled.
        // For simplicity, the main thread writes at DPR-scaled resolution.
        // Copy SAB data into a regular ArrayBuffer (ImageData requires ArrayBuffer, not SharedArrayBuffer)
        const buf = new Uint8ClampedArray(pixels.length);
        buf.set(pixels);
        const imageData = new ImageData(buf, MINIMAP_SIZE, MINIMAP_SIZE);
        // Use a temporary canvas for scaling
        const tmpCanvas = document.createElement("canvas");
        tmpCanvas.width = MINIMAP_SIZE;
        tmpCanvas.height = MINIMAP_SIZE;
        const tmpCtx = tmpCanvas.getContext("2d");
        if (tmpCtx) {
          tmpCtx.putImageData(imageData, 0, 0);
          ctx.drawImage(tmpCanvas, 0, 0, canvas.width, canvas.height);
        }

        // Draw player marker (white dot with outline)
        const playerMx = canvas.width / 2;
        const playerMy = canvas.height / 2;

        // Draw mining radius circle (faint white)
        const digRadius = gameStore.digRadius;
        const radiusPx = (digRadius / (WORLD_RADIUS * 2)) * canvas.width;
        if (radiusPx > 1) {
          ctx.strokeStyle = "rgba(255,255,255,0.2)";
          ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          ctx.arc(playerMx, playerMy, radiusPx, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.arc(playerMx, playerMy, 3 * dpr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = "#000";
        ctx.lineWidth = 1 * dpr;
        ctx.stroke();

        // Draw signpost marker (yellow X) if visible on minimap
        const worldX0 = Math.floor(snap.playerX) - WORLD_RADIUS;
        const worldY0 = Math.floor(snap.playerY) - WORLD_RADIUS;
        const signMx = ((snap.signpostX - worldX0) / (WORLD_RADIUS * 2)) * canvas.width;
        const signMy = ((snap.signpostY - worldY0) / (WORLD_RADIUS * 2)) * canvas.height;
        if (signMx >= 0 && signMx < canvas.width && signMy >= 0 && signMy < canvas.height) {
          ctx.strokeStyle = "#ffd700";
          ctx.lineWidth = 1.5 * dpr;
          ctx.beginPath();
          ctx.moveTo(signMx - 3 * dpr, signMy - 3 * dpr);
          ctx.lineTo(signMx + 3 * dpr, signMy + 3 * dpr);
          ctx.moveTo(signMx + 3 * dpr, signMy - 3 * dpr);
          ctx.lineTo(signMx - 3 * dpr, signMy + 3 * dpr);
          ctx.stroke();
        } else {
          // Signpost is off-screen — draw a direction arrow at the edge
          // pointing toward the signpost
          const dx = snap.signpostX - snap.playerX;
          const dy = snap.signpostY - snap.playerY;
          const angle = Math.atan2(dy, dx);
          const edgeR = canvas.width / 2 - 8 * dpr;
          const arrowX = playerMx + Math.cos(angle) * edgeR;
          const arrowY = playerMy + Math.sin(angle) * edgeR;
          ctx.fillStyle = "#ffd700";
          ctx.strokeStyle = "#000";
          ctx.lineWidth = 1 * dpr;
          ctx.beginPath();
          ctx.moveTo(arrowX + Math.cos(angle) * 5 * dpr, arrowY + Math.sin(angle) * 5 * dpr);
          ctx.lineTo(arrowX + Math.cos(angle + 2.5) * 4 * dpr, arrowY + Math.sin(angle + 2.5) * 4 * dpr);
          ctx.lineTo(arrowX + Math.cos(angle - 2.5) * 4 * dpr, arrowY + Math.sin(angle - 2.5) * 4 * dpr);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    onCleanup(() => {
      running = false;
      cancelAnimationFrame(raf);
    });
  });

  return (
    <Show when={gameStore.showMinimap}>
      <div style={containerStyle}>
        <canvas ref={canvasRef} style={canvasStyle} />
        <div style={labelStyle}>MAP (M)</div>
        <DepthIndicator />
      </div>
    </Show>
  );
}

// Small depth indicator bar on the side of the minimap
function DepthIndicator() {
  const depthMeters = () => gameStore.depth * 128;
  const maxDepthMeters = () => gameStore.stats.maxDepthCells;

  // Depth bar shows current depth vs max depth reached
  const barStyle: JSX.CSSProperties = {
    position: "absolute",
    right: "2px",
    top: "2px",
    bottom: "18px",
    width: "3px",
    background: "rgba(255,255,255,0.1)",
    "border-radius": "2px",
  };

  const maxDepthMarkerStyle = (): JSX.CSSProperties => ({
    position: "absolute",
    right: "-2px",
    width: "7px",
    height: "2px",
    background: "#ffd700",
    "border-radius": "1px",
    bottom: `${Math.min(100, (maxDepthMeters() / 4000) * 100)}%`,
  });

  const currentDepthMarkerStyle = (): JSX.CSSProperties => ({
    position: "absolute",
    right: "-1px",
    width: "5px",
    height: "5px",
    background: "#fff",
    "border-radius": "50%",
    bottom: `${Math.min(100, (depthMeters() / 4000) * 100)}%`,
    border: "1px solid #000",
  });

  return (
    <div style={barStyle}>
      <div style={maxDepthMarkerStyle()} title={`Deepest: ${maxDepthMeters()}m`} />
      <div style={currentDepthMarkerStyle()} title={`Current: ${depthMeters()}m`} />
    </div>
  );
}
