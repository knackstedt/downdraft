// ============================================================================
// MapOverview — zoomed-out 2D world map overlay.
//
// Renders on top of the (faded-out) 3D canvas when the camera zooms past
// MAP_FADE_START. Draws a downsampled top-down view of explored chunks from
// the cached MapRegionData (refreshed by the renderer every 2s), plus
// markers for the player, spawn, stations, task targets, and the active-grid
// window. Clicking the map queues a MOVE_TO walk task so the blockhead
// travels there; right-click cancels the nearest task at that point.
//
// The overlay mirrors ChunkDebugOverlay's pattern: a single <canvas> with
// pointer-events:none, rAF only while visible (mapOpacity > 0), and
// pointer-events:auto only when fully in map mode so it doesn't steal
// clicks from the 3D scene during the cross-fade.
// ============================================================================

import { useEffect, useRef, useState } from "react";
import { getBlockDef } from "../shared/block-registry";
import {
    ACTIVE_GRID_H, ACTIVE_GRID_W, CHUNK_H, CHUNK_W, SURFACE_Y, WORLD_H, WORLD_W,
} from "../shared/constants";
import {
    MAP_REGION_COLS, MAP_REGION_ROWS, THUMB_H, THUMB_W,
    type MapRegionData,
} from "../shared/map-buffer";
import { useGameStore } from "../stores/game-store";

const canvasStyle: React.CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  zIndex: 12, // above the game canvas (z-index 0) + chunk debug overlay (z-index 11)
};

// Station-type → marker color (RGB). Matches the station panel palette.
const STATION_COLORS: Record<string, [number, number, number]> = {
  workbench: [180, 120, 60],
  craft_bench: [120, 180, 60],
  tool_bench: [60, 180, 180],
  woodwork_bench: [120, 200, 120],
  campfire: [255, 140, 40],
  kiln: [220, 80, 40],
  furnace: [255, 60, 60],
  metalwork_bench: [180, 180, 200],
  builder_bench: [200, 200, 60],
  tailor_bench: [200, 120, 200],
  compost_bin: [100, 160, 60],
  hand: [200, 200, 200],
};

interface RendererLike {
  getCamera: () => { x: number; y: number; zoom: number; canvasW: number; canvasH: number };
  getMapOpacity: () => number;
  getPlayerWorld: () => { x: number; y: number };
  getPlayerFacing: () => number;
  getTaskMarkersWorld: () => { wx: number; wy: number; action: "mine" | "move" }[];
  getMapRegionData: () => MapRegionData | null;
  isMapRegionDirty: () => boolean;
  clearMapRegionDirty: () => void;
  getRenderOrigin: () => { cx: number; cy: number };
  // Input state — used to forward wheel zoom deltas from the overlay canvas
  // to the same accumulator the game canvas writes to. Without this, wheel
  // events over the interactive map overlay never reach the game canvas's
  // wheel listener and the user can't zoom back in once fully zoomed out.
  getInput: () => { zoomDelta: number } | null;
  getWorkerHost: () => {
    queueTask: (type: "MOVE_TO", opts: { targetX: number; targetY: number }, bhIndex?: number) =>
      Promise<{ ok: boolean; taskId: number; duplicate: boolean }>;
    cancelTask: (type: "MOVE_TO" | "MINE_BLOCK", targetX: number, targetY: number, bhIndex?: number) =>
      Promise<{ ok: boolean }>;
    getTasks: (bhIndex?: number) =>
      Promise<{ id: number; type: string; targetX: number; targetY: number; status: string }[]>;
  } | null;
}

// Click "ping" animation: an expanding ring drawn for ~600ms after a click.
interface Ping { wx: number; wy: number; start: number; }

export function MapOverview() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [interactive, setInteractive] = useState(false);
  const pingsRef = useRef<Ping[]>([]);

  // The rAF loop only runs while mapOpacity > 0. When hidden, no rAF is
  // scheduled so the 2D canvas layer is never dirtied — this avoids a
  // per-frame DOM commit that would saturate the GPU process at high Hz.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Offscreen atlas canvas: one pixel per thumbnail cell. Updated only
    // when the region data changes (dirty flag). Drawn scaled to screen
    // each frame.
    const atlas = document.createElement("canvas");
    atlas.width = MAP_REGION_COLS * THUMB_W;  // 1024
    atlas.height = MAP_REGION_ROWS * THUMB_H; // 128
    const atlasCtx = atlas.getContext("2d");
    if (!atlasCtx) return;

    let raf = 0;
    let running = true;
    let lastOpacity = -1;
    let atlasBuilt = false;

    // Forward wheel zoom from the overlay canvas to the renderer's input
    // state. When the overlay is interactive (pointer-events: auto, i.e. the
    // view is fully in map mode), wheel events land on this canvas instead of
    // the game canvas — whose wheel listener drives zoomDelta. Without this
    // forwarding the user gets stuck at max zoom-out and can't scroll back in.
    // Native listener (not React onWheel) so preventDefault works under
    // passive event listeners.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const store = useGameStore.getState();
      const renderer = store.renderer as unknown as RendererLike | null;
      const input = renderer?.getInput();
      if (!input) return;
      if (e.deltaY < 0) input.zoomDelta += 1;
      else if (e.deltaY > 0) input.zoomDelta -= 1;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });

    const tick = () => {
      if (!running) return;
      const store = useGameStore.getState();
      const renderer = store.renderer as unknown as RendererLike | null;

      // If no renderer or fully in block mode, clear and skip.
      if (!renderer) {
        raf = requestAnimationFrame(tick);
        return;
      }
      const opacity = renderer.getMapOpacity();
      if (opacity <= 0) {
        if (lastOpacity > 0) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          lastOpacity = 0;
          setInteractive(false);
        }
        raf = requestAnimationFrame(tick);
        return;
      }

      // Resize backing store to match CSS size × DPR.
      const dpr = window.devicePixelRatio || 1;
      const cssW = window.innerWidth;
      const cssH = window.innerHeight;
      const pxW = Math.floor(cssW * dpr);
      const pxH = Math.floor(cssH * dpr);
      if (canvas.width !== pxW || canvas.height !== pxH) {
        canvas.width = pxW;
        canvas.height = pxH;
      }

      // Enable pointer events only when fully in map mode (opacity > 0.5).
      if (opacity > 0.5 !== interactive) {
        setInteractive(opacity > 0.5);
      }

      const cam = renderer.getCamera();
      const region = renderer.getMapRegionData();

      // Rebuild the atlas only when the region data changes.
      if (region && (renderer.isMapRegionDirty() || !atlasBuilt)) {
        buildAtlas(atlasCtx, region);
        renderer.clearMapRegionDirty();
        atlasBuilt = true;
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.globalAlpha = opacity;

      // --- Map projection ---
      // The camera tracks world coords (camWorldX/Y). The map uses the same
      // zoom value so the zoom-out gesture is seamless: screenX = (wx - camWX) * zoom + W/2.
      // camWorldX = cam.x + renderOriginCx * CHUNK_W.
      const origin = renderer.getRenderOrigin();
      const camWX = cam.x + origin.cx * CHUNK_W;
      const camWY = cam.y + origin.cy * CHUNK_H;

      const worldToScreenX = (wx: number) => (wx - camWX) * cam.zoom * dpr + canvas.width / 2;
      const worldToScreenY = (wy: number) => (wy - camWY) * cam.zoom * dpr + canvas.height / 2;

      // --- Draw the atlas (explored chunks) ---
      if (region && atlasBuilt) {
        // The region covers thumbnail cells [0, cols*THUMB_W) in "region
        // block" coords, starting at world X = region.cx0 * CHUNK_W.
        const regionWorldX0 = region.cx0 * CHUNK_W;
        const regionWorldW = MAP_REGION_COLS * THUMB_W; // 1024 thumbnail-block units wide
        const regionWorldH = MAP_REGION_ROWS * THUMB_H; // 128 tall
        const sx = worldToScreenX(regionWorldX0);
        const sy = worldToScreenY(0);
        const sw = regionWorldW * cam.zoom * dpr;
        const sh = regionWorldH * cam.zoom * dpr;
        // Only draw if any part is on-screen.
        if (sw > 0 && sh > 0) {
          ctx.imageSmoothingEnabled = false; // crisp pixels
          ctx.drawImage(atlas, 0, 0, atlas.width, atlas.height, sx, sy, sw, sh);
        }
      }

      // --- Fog overlay for unexplored / out-of-region area ---
      // Draw a semi-transparent dark layer over the whole canvas, then cut
      // out the explored region. Simpler: draw fog only where there's no
      // atlas. We approximate by drawing a dim border around the region.
      // (The atlas itself already renders fog-colored pixels for unexplored
      // thumbnail cells, so this is just for the area outside the region.)
      // Skip for now — the atlas fog color handles in-region fog; outside
      // the region is simply not drawn (transparent → shows faded 3D scene).

      // --- Markers ---
      // Active-grid window (cyan rectangle, matches ChunkDebugOverlay).
      const agX0 = origin.cx * CHUNK_W;
      const agY0 = origin.cy * CHUNK_H;
      const agSx0 = worldToScreenX(agX0);
      const agSy0 = worldToScreenY(agY0);
      const agSw = ACTIVE_GRID_W * cam.zoom * dpr;
      const agSh = ACTIVE_GRID_H * cam.zoom * dpr;
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = "rgba(0, 255, 255, 0.7)";
      ctx.strokeRect(agSx0, agSy0, agSw, agSh);

      // Spawn / home marker (house glyph at world center, surface level).
      drawSpawnMarker(ctx, worldToScreenX(WORLD_W / 2), worldToScreenY(SURFACE_Y), dpr, cam.zoom);

      // Stations (colored dots).
      if (region) {
        for (const s of region.stations) {
          const col = STATION_COLORS[s.station] ?? [200, 200, 200];
          drawStationDot(ctx, worldToScreenX(s.wx), worldToScreenY(s.wy), col, dpr, cam.zoom);
        }
      }

      // Task markers (mine = red, move = green).
      const tasks = renderer.getTaskMarkersWorld();
      for (const t of tasks) {
        const col: [number, number, number] = t.action === "mine" ? [255, 60, 60] : [60, 255, 120];
        drawTaskMarker(ctx, worldToScreenX(t.wx), worldToScreenY(t.wy), col, dpr, cam.zoom);
      }

      // Player marker (bright arrow).
      const player = renderer.getPlayerWorld();
      const facing = renderer.getPlayerFacing();
      drawPlayerMarker(ctx, worldToScreenX(player.x), worldToScreenY(player.y), facing, dpr, cam.zoom);

      // Click pings (expanding rings, auto-expire after 600ms).
      const nowMs = performance.now();
      pingsRef.current = pingsRef.current.filter((p) => nowMs - p.start < 600);
      for (const p of pingsRef.current) {
        const age = (nowMs - p.start) / 600;
        const radius = (4 + age * 24) * dpr;
        ctx.lineWidth = 2 * dpr * (1 - age);
        ctx.strokeStyle = `rgba(120, 255, 180, ${1 - age})`;
        ctx.beginPath();
        ctx.arc(worldToScreenX(p.wx), worldToScreenY(p.wy), radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      ctx.globalAlpha = 1;
      lastOpacity = opacity;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      running = false;
      cancelAnimationFrame(raf);
      canvas.removeEventListener("wheel", onWheel);
      const c = canvasRef.current;
      if (c) {
        const cx = c.getContext("2d");
        cx?.clearRect(0, 0, c.width, c.height);
      }
    };
  }, [interactive]);

  // Click → queue MOVE_TO walk task. Right-click → cancel nearest task.
  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const store = useGameStore.getState();
    const renderer = store.renderer as unknown as RendererLike | null;
    if (!renderer) return;
    if (renderer.getMapOpacity() <= 0.5) return; // only in full map mode
    const host = renderer.getWorkerHost();
    if (!host) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    const cam = renderer.getCamera();
    const origin = renderer.getRenderOrigin();
    const camWX = cam.x + origin.cx * CHUNK_W;
    const camWY = cam.y + origin.cy * CHUNK_H;
    const wx = (screenX - cam.canvasW / 2) / cam.zoom + camWX;
    const wy = (screenY - cam.canvasH / 2) / cam.zoom + camWY;

    // Clamp to world bounds.
    const cx = ((Math.floor(wx) % WORLD_W) + WORLD_W) % WORLD_W;
    const cy = Math.max(0, Math.min(WORLD_H - 1, Math.floor(wy)));

    if (e.button === 2 || e.metaKey || e.ctrlKey) {
      // Right-click / Ctrl-click: cancel the nearest MOVE_TO task at this point.
      host.getTasks(0).then((tasks) => {
        let best: { id: number; type: string; targetX: number; targetY: number } | null = null;
        let bestDist = Infinity;
        for (const t of tasks) {
          const dx = t.targetX - cx;
          const dy = t.targetY - cy;
          const d = dx * dx + dy * dy;
          if (d < bestDist && d < 64 * 64) { // within 64 blocks
            bestDist = d;
            best = t;
          }
        }
        if (best) {
          host.cancelTask(best.type as "MOVE_TO", best.targetX, best.targetY, 0);
        }
      });
      return;
    }

    // Left-click: queue a MOVE_TO task.
    host.queueTask("MOVE_TO", { targetX: cx, targetY: cy }, 0).then((result) => {
      if (result.duplicate) {
        host.cancelTask("MOVE_TO", cx, cy, 0);
      }
    });
    // Add a ping animation at the click point.
    pingsRef.current.push({ wx: cx, wy: cy, start: performance.now() });
  };

  return (
    <canvas
      ref={canvasRef}
      style={{ ...canvasStyle, pointerEvents: interactive ? "auto" : "none" }}
      onClick={onClick}
      onContextMenu={(e) => { e.preventDefault(); onClick(e); }}
    />
  );
}

// --- Atlas builder ---
// Writes one pixel per thumbnail cell into the offscreen atlas canvas.
// Explored cells get the block's palette color; unexplored cells get fog.
function buildAtlas(ctx: CanvasRenderingContext2D, region: MapRegionData): void {
  const img = ctx.createImageData(MAP_REGION_COLS * THUMB_W, MAP_REGION_ROWS * THUMB_H);
  const data = img.data;
  const cellsPerRow = THUMB_W; // thumbnail cells per chunk row = 8
  for (let row = 0; row < MAP_REGION_ROWS; row++) {
    for (let col = 0; col < MAP_REGION_COLS; col++) {
      for (let ty = 0; ty < cellsPerRow; ty++) {
        for (let tx = 0; tx < cellsPerRow; tx++) {
          const ti = ((row * MAP_REGION_COLS + col) * cellsPerRow + ty) * cellsPerRow + tx;
          const explored = region.explored[ti] !== 0;
          const blockId = region.blockIds[ti];
          // Atlas pixel coords (atlas is cols*THUMB_W wide, rows*THUMB_H tall).
          const ax = col * THUMB_W + tx;
          const ay = row * THUMB_H + ty;
          const pi = (ay * MAP_REGION_COLS * THUMB_W + ax) * 4;
          if (!explored) {
            // Fog: dark blue-gray.
            data[pi] = 20; data[pi + 1] = 24; data[pi + 2] = 32; data[pi + 3] = 255;
          } else if (blockId === 0) {
            // Explored air: light sky-ish.
            data[pi] = 40; data[pi + 1] = 48; data[pi + 2] = 56; data[pi + 3] = 255;
          } else {
            const def = getBlockDef(blockId);
            if (def) {
              data[pi] = def.color[0];
              data[pi + 1] = def.color[1];
              data[pi + 2] = def.color[2];
              data[pi + 3] = 255;
            } else {
              data[pi] = 80; data[pi + 1] = 80; data[pi + 2] = 80; data[pi + 3] = 255;
            }
          }
        }
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}

// --- Marker drawing helpers ---

function drawPlayerMarker(
  ctx: CanvasRenderingContext2D, sx: number, sy: number,
  facing: number, dpr: number, zoom: number,
): void {
  const size = Math.max(8 * dpr, 14 * dpr);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(facing > 0 ? 0 : Math.PI);
  ctx.fillStyle = "rgba(255, 240, 100, 0.95)";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.8)";
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  ctx.moveTo(size, 0);
  ctx.lineTo(-size * 0.6, size * 0.6);
  ctx.lineTo(-size * 0.3, 0);
  ctx.lineTo(-size * 0.6, -size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawSpawnMarker(
  ctx: CanvasRenderingContext2D, sx: number, sy: number,
  dpr: number, zoom: number,
): void {
  const size = Math.max(6 * dpr, 10 * dpr);
  ctx.fillStyle = "rgba(255, 200, 80, 0.9)";
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.lineWidth = 1.5 * dpr;
  // House: square body + triangle roof.
  ctx.beginPath();
  ctx.rect(sx - size * 0.5, sy - size * 0.2, size, size * 0.7);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(sx - size * 0.6, sy - size * 0.2);
  ctx.lineTo(sx, sy - size * 0.7);
  ctx.lineTo(sx + size * 0.6, sy - size * 0.2);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawStationDot(
  ctx: CanvasRenderingContext2D, sx: number, sy: number,
  col: [number, number, number], dpr: number, zoom: number,
): void {
  const r = Math.max(3 * dpr, 5 * dpr);
  ctx.fillStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.95)`;
  ctx.strokeStyle = "rgba(0, 0, 0, 0.7)";
  ctx.lineWidth = 1 * dpr;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawTaskMarker(
  ctx: CanvasRenderingContext2D, sx: number, sy: number,
  col: [number, number, number], dpr: number, zoom: number,
): void {
  const r = Math.max(4 * dpr, 7 * dpr);
  ctx.strokeStyle = `rgba(${col[0]}, ${col[1]}, ${col[2]}, 0.95)`;
  ctx.lineWidth = 2 * dpr;
  ctx.beginPath();
  ctx.arc(sx, sy, r, 0, Math.PI * 2);
  ctx.stroke();
  // Crosshair.
  ctx.beginPath();
  ctx.moveTo(sx - r * 1.4, sy);
  ctx.lineTo(sx + r * 1.4, sy);
  ctx.moveTo(sx, sy - r * 1.4);
  ctx.lineTo(sx, sy + r * 1.4);
  ctx.stroke();
}
