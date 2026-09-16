// ============================================================================
// Sandjongg — renderer-side MCP automation harness.
// Standard tools (capture_screenshot, DOM inspection, get_ui_state) come from
// createStandardAutomationTools() in @downdraft/app; this file keeps only the
// sandjongg-specific game tools.
// ============================================================================

import {
    blobToBase64,
    createMcpHarness,
    createStandardAutomationTools,
    errorResult,
    type McpToolRegistration,
} from "@downdraft/app/renderer";
import type { SandjonggRenderer } from "../renderer/sandjongg-renderer";
import { useGameStore } from "../stores/game-store";

function createGameTools(ctx: {
  renderer: () => SandjonggRenderer | null;
}): McpToolRegistration[] {
  return [
    {
      def: {
        name: "match_tiles",
        description:
          "Attempt to match two tiles by their board coordinates (col, row, layer). Returns the match result including score, combo, and whether the match succeeded.",
        inputSchema: {
          type: "object",
          properties: {
            aCol: { type: "number", description: "Column of the first tile (0-indexed)" },
            aRow: { type: "number", description: "Row of the first tile (0-indexed)" },
            aLayer: { type: "number", description: "Layer of the first tile (0-indexed, default 0)", default: 0 },
            bCol: { type: "number", description: "Column of the second tile (0-indexed)" },
            bRow: { type: "number", description: "Row of the second tile (0-indexed)" },
            bLayer: { type: "number", description: "Layer of the second tile (0-indexed, default 0)", default: 0 },
          },
          required: ["aCol", "aRow", "bCol", "bRow"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        const aCol = params.aCol as number;
        const aRow = params.aRow as number;
        const aLayer = (params.aLayer as number) ?? 0;
        const bCol = params.bCol as number;
        const bRow = params.bRow as number;
        const bLayer = (params.bLayer as number) ?? 0;
        host.requestMatch(aCol, aRow, aLayer, bCol, bRow, bLayer);
        // Wait a moment for the worker to process the match.
        await new Promise((r) => setTimeout(r, 200));
        const stats = await host.getStats();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                requested: { aCol, aRow, aLayer, bCol, bRow, bLayer },
                score: stats?.score ?? 0,
                level: stats?.level ?? 1,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "get_game_state",
        description:
          "Get the current game state: level, score, combo, tiles remaining, and board layout.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        const stats = await host.getStats();
        // Sync board state from the sim SAB before reading. The render loop is
        // paused in deterministic/test mode, so the tile pass state may not
        // have been updated by drawFrame yet.
        renderer.syncBoardState();
        const tilePass = renderer.getTilePass();
        const cols = tilePass?.state.boardCols ?? 0;
        const rows = tilePass?.state.boardRows ?? 0;
        const layers = tilePass?.state.boardLayers ?? 1;
        const boardElements = tilePass?.state.boardElements
          ? Array.from(tilePass.state.boardElements.slice(0, cols * rows * layers))
          : [];
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                score: stats?.score ?? 0,
                level: stats?.level ?? 1,
                combo: stats?.combo ?? 0,
                tilesLeft: stats?.tilesLeft ?? 0,
                boardCols: cols,
                boardRows: rows,
                boardLayers: layers,
                boardElements,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "request_hint",
        description: "Request a hint from the solver. Returns the highlighted pair if a match exists.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        host.requestHint();
        await new Promise((r) => setTimeout(r, 200));
        const tilePass = renderer.getTilePass();
        const hint = tilePass?.state.hint;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ hint }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "new_game",
        description: "Start a new game at the specified level.",
        inputSchema: {
          type: "object",
          properties: {
            level: { type: "number", description: "Level number to start (default: 1)" },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not initialized");
        const level = (params.level as number) ?? 1;
        host.requestNewGame(level);
        await new Promise((r) => setTimeout(r, 500));
        return {
          content: [
            { type: "text", text: JSON.stringify({ started: true, level }, null, 2) },
          ],
        };
      },
    },
    {
      def: {
        name: "debug_tile_canvas",
        description: "Capture the tile canvas directly and return info about its DOM state and pixel content.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
        if (!tileCanvas) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "tile canvas not found in DOM" }, null, 2) }] };
        }
        const rect = tileCanvas.getBoundingClientRect();
        const style = window.getComputedStyle(tileCanvas);
        // Sample some pixels from the tile canvas to check if it has content.
        const ctx2d = tileCanvas.getContext("2d");
        let nonTransparentPixels = 0;
        let sampleColors: string[] = [];
        if (ctx2d) {
          const imageData = ctx2d.getImageData(0, 0, tileCanvas.width, tileCanvas.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 16) { // sample every 4th pixel
            if (data[i + 3] > 0) { // alpha > 0
              nonTransparentPixels++;
              if (sampleColors.length < 10) {
                sampleColors.push(`rgb(${data[i]},${data[i+1]},${data[i+2]},${data[i+3]})`);
              }
            }
          }
        }
        const tilePass = ctx.renderer()?.getTilePass();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                canvasW: tileCanvas.width,
                canvasH: tileCanvas.height,
                rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
                style: {
                  position: style.position,
                  zIndex: style.zIndex,
                  display: style.display,
                  visibility: style.visibility,
                  opacity: style.opacity,
                  pointerEvents: style.pointerEvents,
                  width: style.width,
                  height: style.height,
                  top: style.top,
                  left: style.left,
                },
                nonTransparentPixels,
                sampleColors,
                tilePassState: tilePass ? {
                  boardCols: tilePass.state.boardCols,
                  boardRows: tilePass.state.boardRows,
                  boardElementsLen: tilePass.state.boardElements.length,
                  tilesCount: Array.from(tilePass.state.boardElements).filter(e => e >= 0).length,
                  tileW: tilePass.getTileW(),
                  tileH: tilePass.getTileH(),
                  tileAspect: tilePass.state.tileAspect,
                  tileset: tilePass.state.tileset,
                  boardOffsetX: tilePass.getBoardOffsetX(),
                  boardOffsetY: tilePass.getBoardOffsetY(),
                  atlasLoaded: tilePass.state.atlas !== null,
                } : null,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "capture_tile_canvas",
        description: "Capture the tile canvas as a PNG image.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
        if (!tileCanvas) return errorResult("Tile canvas not found");
        const blob = await new Promise<Blob | null>((resolve) => {
          tileCanvas.toBlob((b) => resolve(b), "image/png");
        });
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width: tileCanvas.width, height: tileCanvas.height }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },
    {
      def: {
        name: "get_sand_state",
        description:
          "Read the sand grid from the SAB and report non-empty cell positions, materials, and bounding box. Used to verify sand physics (gravity/falling) are working.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const snap = renderer.snapshotGrid();
        const grid = snap.grid;
        const W = snap.gridW;
        const H = snap.gridH;
        let count = 0;
        let minY = H, maxY = 0;
        let minX = W, maxX = 0;
        const samples: Array<{ x: number; y: number; mat: number }> = [];
        for (let y = 0; y < H; y++) {
          for (let x = 0; x < W; x++) {
            const v = grid[y * W + x];
            if (v !== 0) {
              const mat = v & 0xff;
              // Exclude Wall (26) and Stone (3) — those are static pit walls/floor.
              if (mat === 26 || mat === 3) continue;
              count++;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (samples.length < 20) {
                samples.push({ x, y, mat });
              }
            }
          }
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                gridW: W,
                gridH: H,
                nonEmptyCount: count,
                bounds: count > 0 ? { minX, minY, maxX, maxY } : null,
                samples,
              }, null, 2),
            },
          ],
        };
      },
    },
    {
      def: {
        name: "set_tileset",
        description: "Switch the active tileset at runtime (e.g. 'elements', 'riichi').",
        inputSchema: {
          type: "object",
          properties: {
            tileset: { type: "string", description: "Tileset id: 'elements' or 'riichi'" },
          },
          required: ["tileset"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const id = params.tileset as string;
        useGameStore.getState().setTileset(id as "elements" | "riichi");
        await new Promise((r) => setTimeout(r, 1000));
        const tilePass = ctx.renderer()?.getTilePass();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                set: id,
                tileW: tilePass?.getTileW(),
                tileH: tilePass?.getTileH(),
                tileAspect: tilePass?.state.tileAspect,
                tileset: tilePass?.state.tileset,
                atlasLoaded: tilePass?.state.atlas !== null,
              }, null, 2),
            },
          ],
        };
      },
    },
  ];
}

export function setupSandjonggMcp(renderer: () => SandjonggRenderer | null): void {
  createMcpHarness({
    serverName: "downdraft-sandjongg-automation",
    tools: createStandardAutomationTools({
      canvas: () => renderer()?.getCanvas() ?? null,
      // Composite the 2D tile canvas between the WebGPU sand canvas and the
      // DOM overlay in full-page screenshots.
      extraLayers: () => {
        const tileCanvas = document.querySelector<HTMLCanvasElement>("#sandjongg-tile-canvas");
        return tileCanvas ? [tileCanvas] : [];
      },
      getUiState: () => useGameStore.getState(),
      extraTools: createGameTools({ renderer }),
    }),
  });
}
