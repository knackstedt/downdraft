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

import { Material } from "@downdraft/library-sand";
import { useEffect, useRef } from "react";
import { ACTIVE_GRID_H, ACTIVE_GRID_W } from "../shared/constants";
import type { MiningSimBufferReader } from "../shared/sim-buffer";
import { useGameStore } from "../stores/game-store";

const MINIMAP_SIZE = 160; // CSS pixels
const WORLD_RADIUS = 200; // world cells from player center to edge (total view = 2*RADIUS)

const containerStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  left: 8,
  zIndex: 12,
  pointerEvents: "none",
  borderRadius: 6,
  overflow: "hidden",
  border: "1px solid rgba(255,255,255,0.2)",
  boxShadow: "0 2px 8px rgba(0,0,0,0.5)",
};

const canvasStyle: React.CSSProperties = {
  display: "block",
  width: MINIMAP_SIZE,
  height: MINIMAP_SIZE,
};

const labelStyle: React.CSSProperties = {
  position: "absolute",
  bottom: 2,
  right: 4,
  fontSize: 9,
  fontFamily: "monospace",
  color: "rgba(255,255,255,0.5)",
  pointerEvents: "none",
};

// Ore material colors for the minimap (bright spots)
const ORE_COLORS: Record<number, [number, number, number]> = {
  [Material.TinOre]: [180, 184, 188],
  [Material.CopperOre]: [184, 115, 51],
  [Material.IronOre]: [140, 115, 101],
  [Material.BauxiteOre]: [191, 128, 102],
  [Material.SilverOre]: [217, 217, 224],
  [Material.GoldOre]: [230, 200, 51],
  [Material.CobaltOre]: [64, 89, 204],
  [Material.Coal]: [40, 40, 40],
};

// Liquid/material colors
const LAVA_COLOR: [number, number, number] = [255, 80, 0];
const WATER_COLOR: [number, number, number] = [40, 80, 180];
const OIL_COLOR: [number, number, number] = [30, 20, 10];

function isLiquid(mat: number): boolean {
  return mat === Material.Water || mat === Material.Lava || mat === Material.Oil ||
    mat === Material.MethaneGas || mat === Material.SulfurGas;
}

function getLiquidColor(mat: number): [number, number, number] {
  if (mat === Material.Lava) return LAVA_COLOR;
  if (mat === Material.Water) return WATER_COLOR;
  if (mat === Material.Oil) return OIL_COLOR;
  return [60, 60, 60];
}

export function Minimap() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
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
      const store = useGameStore.getState();
      const renderer = store.renderer as {
        getGridReader?: () => MiningSimBufferReader | null;
        getPlayerPos?: () => { x: number; y: number };
        getSignpostPos?: () => { x: number; y: number };
      } | null;

      // Clear with black background
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      if (!renderer?.getGridReader || !renderer?.getPlayerPos) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const reader = renderer.getGridReader();
      if (!reader) {
        raf = requestAnimationFrame(tick);
        return;
      }

      const playerPos = renderer.getPlayerPos();
      const signpostPos = renderer.getSignpostPos
        ? renderer.getSignpostPos()
        : { x: 0, y: 0 };

      const grid = reader.getGrid();
      const explored = reader.getExploredGrid();
      const originX = reader.getStat(1); // STATS.ORIGIN_X
      const originY = reader.getStat(2); // STATS.ORIGIN_Y

      // World cell range visible on the minimap
      const worldX0 = Math.floor(playerPos.x) - WORLD_RADIUS;
      const worldY0 = Math.floor(playerPos.y) - WORLD_RADIUS;
      const worldX1 = Math.floor(playerPos.x) + WORLD_RADIUS;
      const worldY1 = Math.floor(playerPos.y) + WORLD_RADIUS;

      // Map world cells → minimap pixels
      const cellPx = canvas.width / (WORLD_RADIUS * 2);

      // Sample the grid: for each minimap pixel, find the corresponding world cell
      // and check if it's within the active grid window
      for (let my = 0; my < canvas.height; my++) {
        for (let mx = 0; mx < canvas.width; mx++) {
          const wx = Math.floor(worldX0 + (mx / canvas.width) * (WORLD_RADIUS * 2));
          const wy = Math.floor(worldY0 + (my / canvas.height) * (WORLD_RADIUS * 2));

          // Check if within active grid
          const lx = wx - originX;
          const ly = wy - originY;
          if (lx < 0 || ly < 0 || lx >= ACTIVE_GRID_W || ly >= ACTIVE_GRID_H) {
            // Outside active grid — leave black
            continue;
          }

          const gridIdx = ly * ACTIVE_GRID_W + lx;
          const mat = grid[gridIdx];
          const isExplored = explored[gridIdx] > 0;

          if (!isExplored && mat === 0) {
            // Unexplored air — leave black
            continue;
          }

          let r: number, g: number, b: number;

          if (mat === 0) {
            // Air (explored) — dark blue (caves/tunnels)
            r = 15; g = 20; b = 35;
          } else if (isLiquid(mat)) {
            [r, g, b] = getLiquidColor(mat);
          } else if (ORE_COLORS[mat]) {
            [r, g, b] = ORE_COLORS[mat];
          } else {
            // Other solid materials — dark gray/brown based on type
            if (mat === Material.Dirt || mat === Material.Grass) {
              r = 60; g = 40; b = 25;
            } else if (mat === Material.Stone || mat === Material.LooseStone) {
              r = 50; g = 50; b = 55;
            } else if (mat === Material.Gravel || mat === Material.Sand) {
              r = 80; g = 70; b = 50;
            } else if (mat === Material.Iron) {
              r = 100; g = 100; b = 105;
            } else {
              r = 45; g = 45; b = 50;
            }
          }

          // Write pixel directly to ImageData for performance
          const pxIdx = (my * canvas.width + mx) * 4;
          imageData.data[pxIdx] = r;
          imageData.data[pxIdx + 1] = g;
          imageData.data[pxIdx + 2] = b;
          imageData.data[pxIdx + 3] = 255;
        }
      }

      // Blit the ImageData
      ctx.putImageData(imageData, 0, 0);

      // Draw player marker (white dot with outline)
      const playerMx = canvas.width / 2;
      const playerMy = canvas.height / 2;

      // Draw mining radius circle (faint white)
      const digRadius = store.digRadius ?? 3;
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
      const signMx = ((signpostPos.x - worldX0) / (WORLD_RADIUS * 2)) * canvas.width;
      const signMy = ((signpostPos.y - worldY0) / (WORLD_RADIUS * 2)) * canvas.height;
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
        const dx = signpostPos.x - playerPos.x;
        const dy = signpostPos.y - playerPos.y;
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

      raf = requestAnimationFrame(tick);
    };

    // Pre-allocate ImageData for direct pixel writing
    const imageData = ctx.createImageData(canvas.width, canvas.height);

    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
    };
  }, []);

  const { showMinimap } = useGameStore();

  if (!showMinimap) return null;

  return (
    <div style={containerStyle}>
      <canvas ref={canvasRef} style={canvasStyle} />
      <div style={labelStyle}>MAP (M)</div>
      <DepthIndicator />
    </div>
  );
}

// Small depth indicator bar on the side of the minimap
function DepthIndicator() {
  const { depth, stats } = useGameStore();
  const depthMeters = depth * 128;
  const maxDepthMeters = stats.maxDepthCells;

  // Depth bar shows current depth vs max depth reached
  const barStyle: React.CSSProperties = {
    position: "absolute",
    right: 2,
    top: 2,
    bottom: 18,
    width: 3,
    background: "rgba(255,255,255,0.1)",
    borderRadius: 2,
  };

  const maxDepthMarkerStyle: React.CSSProperties = {
    position: "absolute",
    right: -2,
    width: 7,
    height: 2,
    background: "#ffd700",
    borderRadius: 1,
    bottom: `${Math.min(100, (maxDepthMeters / 4000) * 100)}%`,
  };

  const currentDepthMarkerStyle: React.CSSProperties = {
    position: "absolute",
    right: -1,
    width: 5,
    height: 5,
    background: "#fff",
    borderRadius: "50%",
    bottom: `${Math.min(100, (depthMeters / 4000) * 100)}%`,
    border: "1px solid #000",
  };

  return (
    <>
      <div style={barStyle}>
        <div style={maxDepthMarkerStyle} title={`Deepest: ${maxDepthMeters}m`} />
        <div style={currentDepthMarkerStyle} title={`Current: ${depthMeters}m`} />
      </div>
    </>
  );
}
