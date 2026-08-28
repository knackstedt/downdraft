// ============================================================================
// SandjonggRenderer — orchestrates the WebGPU sand pass + Canvas2D tile pass.
// ============================================================================

import { GameRenderer } from "@downdraft/core";
import { MATERIALS } from "@downdraft/library-sand";
import { computeGridDims, MAX_LAYERS, MAX_TILES } from "../shared/constants";
import { BOARD_ELEMENT_OFFSET, BOARD_META_OFFSET, SimBufferReader, STATS } from "../shared/sim-buffer";
import { getTileAspect, getTileDef, type TilesetId, type TileTheme } from "../shared/tilesets";
import type { DebugTileInfo } from "../shared/types";
import { SandjonggWorkerHost } from "../simulation/sandjongg-worker-host";
import { useGameStore } from "../stores/game-store";
import { createInputHandler, type InputHandler } from "./input-handler";
import { SandGridPass } from "./sand-grid-pass";
import { isAssetBased, loadTileAtlas } from "./tile-atlas";
import { TileCanvasPass } from "./tile-canvas-pass";

export class SandjonggRenderer extends GameRenderer {
  private tileCanvas: HTMLCanvasElement;
  private gridPass: SandGridPass | null = null;
  private tilePass: TileCanvasPass | null = null;
  private input: InputHandler | null = null;
  private workerHost: SandjonggWorkerHost | null = null;
  private gridReader: SimBufferReader | null = null;
  private gridW = 0;
  private gridH = 0;
  private storeUnsub: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private prevBoardCols = 0;
  private prevBoardRows = 0;
  private prevTileAspect = 1.0;
  // Last option values pushed to the worker.
  private prevNoAdjacent = false;
  private prevCustomCols = 0;
  private prevCustomRows = 0;
  private prevMode: "sandjongg" | "mahjongg" = "sandjongg";
  // Last tileset/theme pushed to the worker + atlas. The renderer reloads the
  // SVG atlas when either changes and regenerates the board when the tileset
  // changes (tile count differs → old ids invalid).
  private prevTileset: TilesetId = "elements";
  private prevTileTheme: TileTheme = "light";
  // True while an atlas load is in flight for a new (tileset, theme). Prevents
  // overlapping loads and lets us swap atomically when the new atlas is ready.
  private atlasLoading = false;
  // Cached SAB views to avoid per-frame allocations.
  private cachedBoardElements: Int32Array | null = null;
  private cachedBoardMeta: Int32Array | null = null;
  private cachedUniformBuf: Float32Array = new Float32Array(4);

  constructor(canvas: HTMLCanvasElement, tileCanvas: HTMLCanvasElement) {
    super(canvas, {
      mode: "2d",
      clearColor: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
    });
    // 2D mode with viewportCount=0: we do custom rendering in afterFrame.
    this.setViewportCount(0);
    this.tileCanvas = tileCanvas;
    // The renderer doesn't need to run faster than 60fps.
    this.setFrameRateLimit(60);
  }

  getFPS(): number { return super.getFPS(); }
  getCanvas(): HTMLCanvasElement { return super.getCanvas(); }
  getGridW(): number { return this.gridW; }
  getGridH(): number { return this.gridH; }
  getWorkerHost(): SandjonggWorkerHost | null { return this.workerHost; }
  getTilePass(): TileCanvasPass | null { return this.tilePass; }

  /** Snapshot the sand grid + fields for saving. */
  snapshotGrid(): { grid: Uint32Array; fields: Uint8Array; gridW: number; gridH: number } {
    if (!this.gridReader) return { grid: new Uint32Array(0), fields: new Uint8Array(0), gridW: 0, gridH: 0 };
    return {
      grid: new Uint32Array(this.gridReader.getGrid()),
      fields: new Uint8Array(this.gridReader.getFieldGrid()),
      gridW: this.gridW,
      gridH: this.gridH,
    };
  }

  async loadSave(grid: Uint32Array, fields: Uint8Array, gridW: number, gridH: number): Promise<void> {
    if (!this.workerHost || !this.gridPass) return;
    if (gridW !== this.gridW || gridH !== this.gridH) {
      this.gridW = gridW;
      this.gridH = gridH;
      this.gridPass.resize(gridW, gridH);
    }
    await this.workerHost.loadGrid(grid, fields, gridW, gridH);
  }

  async init(): Promise<boolean> {
    const ok = await super.init();
    if (!ok) return false;

    const device = this.getDevice()!;
    const format = this.getFormat();
    const canvas = this.getCanvas();

    this.input = createInputHandler(this.tileCanvas);

    const dims = computeGridDims(canvas.width, canvas.height);
    this.gridW = dims.w;
    this.gridH = dims.h;

    this.gridPass = new SandGridPass(device, format, this.gridW, this.gridH);
    this.gridPass.init();

    this.tilePass = new TileCanvasPass(this.tileCanvas);
    this.resizeTileCanvas();

    this.workerHost = new SandjonggWorkerHost(this.gridW, this.gridH);
    await this.workerHost.start();
    this.gridReader = this.workerHost.getReader();

    // Push initial generation options to the worker.
    this.pushOptions();

    // Preload the SVG atlas for the active tileset+theme (no-op for procedural
    // tilesets). The tile pass draws nothing from the atlas until it's loaded,
    // so the first frames may show procedural fallback colors if the atlas
    // isn't ready — but asset-based tilesets have no procedural fallback, so
    // tiles simply don't render their face until the atlas swaps in (the 3D
    // slab sides, border, and selection overlays still draw).
    const initStore = useGameStore.getState();
    this.prevTileset = initStore.tileset;
    this.prevTileTheme = initStore.tileTheme;
    if (this.tilePass) {
      this.tilePass.state.tileset = initStore.tileset;
      this.tilePass.state.tileTheme = initStore.tileTheme;
      this.tilePass.state.tileAspect = getTileAspect(initStore.tileset);
    }
    void this.reloadAtlas(initStore.tileset, initStore.tileTheme);

    // Subscribe to store for hint/clear actions.
    this.storeUnsub = useGameStore.subscribe((s) => {
      // Push generation option changes to the worker first so any subsequent
      // new-game action generates with the new options.
      this.pushOptions();
      // Mirror the active mode into the tile pass so it can render free/blocked
      // tiles correctly (sandjongg = per-layer lock, mahjongg = free-tile rule).
      if (this.tilePass) this.tilePass.state.mode = s.mode;
      // Mirror tileset + theme into the tile pass. The atlas is reloaded
      // asynchronously (see reloadAtlas); the tile pass keeps drawing with the
      // old atlas until the new one swaps in, so there's no flash.
      if (this.tilePass) {
        this.tilePass.state.tileset = s.tileset;
        this.tilePass.state.tileTheme = s.tileTheme;
        this.tilePass.state.tileAspect = getTileAspect(s.tileset);
      }
      // Theme change: reload the atlas (live, no board regenerate). Only
      // asset-based tilesets care about the theme.
      if (s.tileTheme !== this.prevTileTheme) {
        this.prevTileTheme = s.tileTheme;
        void this.reloadAtlas(s.tileset, s.tileTheme);
      }
      if (s._pendingTilesetChange) {
        // Tileset changed — push to the worker (affects sand-material mapping
        // + generation count) and regenerate the current level (the tile count
        // differs, so the old board's ids are invalid). Keeps score (like
        // requestAdvance to the same level) so the player doesn't lose progress
        // for swapping tilesets.
        this.workerHost?.setTileset(s.tileset);
        this.workerHost?.requestAdvance(s.level);
        useGameStore.getState()._setPendingTilesetChange(false);
        this.tilePass?.resetPan();
        // Reload the atlas for the new tileset (and current theme).
        void this.reloadAtlas(s.tileset, s.tileTheme);
      }
      if (s._pendingModeChange) {
        // Mode changed — reconfigure the worker and regenerate the current
        // level in the new mode (score resets, like a new game).
        this.workerHost?.setMode(s.mode);
        this.workerHost?.requestNewGame(s.level);
        useGameStore.getState()._setPendingModeChange(false);
        this.tilePass?.resetPan();
      }
      if (s._pendingHint) {
        this.workerHost?.requestHint();
        useGameStore.getState()._setPendingHint(false);
      }
      if (s._pendingShuffle) {
        this.workerHost?.requestShuffle();
        useGameStore.getState()._setPendingShuffle(false);
      }
      if (s._pendingApplyDims) {
        // Custom dims changed — regenerate the current level with the new size.
        this.workerHost?.requestNewGame(s.level);
        useGameStore.getState()._setPendingApplyDims(false);
        // Reset pan so the new board is centered.
        this.tilePass?.resetPan();
      }
      if (s._pendingNewGame) {
        // Distinguish advance (keep score) from restart (reset score).
        // The store sets _pendingNewGameLevel to the target level.
        // requestNewGame = restart (resets score); requestAdvance = next level (keeps score).
        // The app.tsx auto-advance calls requestAdvance directly, so this path
        // is only for the toolbar "Restart" button which uses requestNewGame.
        this.workerHost?.requestNewGame(s._pendingNewGameLevel);
        useGameStore.getState()._setPendingNewGame(0);
        this.tilePass?.resetPan();
      }
      if (s._pendingAdvance) {
        this.workerHost?.requestAdvance(s._pendingAdvanceLevel);
        useGameStore.getState()._setPendingAdvance(0);
        this.tilePass?.resetPan();
      }
      if (s._pendingClearSand) {
        this.workerHost?.requestClearSand();
        useGameStore.getState()._setPendingClearSand(false);
      }
    });

    // Keyboard shortcuts.
    this.keydownHandler = (e: KeyboardEvent) => {
      if (e.key === "p" || e.key === "P") {
        // P toggles the pause menu (which pauses/resumes the sim).
        const s = useGameStore.getState();
        if (s.showPauseMenu) {
          this.workerHost?.resume();
          s.setPaused(false);
          s.setShowPauseMenu(false);
        } else {
          this.workerHost?.pause();
          s.setPaused(true);
          s.setShowPauseMenu(true);
        }
      }
      if (e.key === "h" || e.key === "H") {
        this.workerHost?.requestHint();
      }
      if (e.key === "f" || e.key === "F") {
        this.workerHost?.requestShuffle();
      }
      if (e.key === "n" || e.key === "N") {
        // Restart the current level (resets score, matching the toolbar button label).
        const s = useGameStore.getState();
        this.workerHost?.requestNewGame(s.level);
      }
      if (e.key === "`" || e.key === "~") {
        // Toggle debug mode (backtick key).
        useGameStore.getState().toggleDebugMode();
      }
    };
    window.addEventListener("keydown", this.keydownHandler);

    // Listen for worker events (match results, hints, dead-ends).
    this.workerHost.onEvents((kind: string, data?: unknown) => {
      if (kind === "matched" && this.tilePass && data) {
        const d = data as { score: number; combo: number; path: { points: { col: number; row: number; layer: number }[]; turns: number }; element: number };
        // The worker includes the element in the event (the tiles are already
        // removed from the board by the time we receive this, so we can't look
        // it up from the cached board state).
        const el = d.element;
        this.tilePass.state.pathAnim = {
          path: d.path,
          startTime: performance.now(),
          element: el,
        };
        // Trigger crumble animations for the two matched tiles.
        const pts = d.path.points;
        const first = pts[0];
        const last = pts[pts.length - 1];
        this.tilePass.state.crumbleAnims.push(
          { col: first.col, row: first.row, layer: first.layer ?? 0, element: el, startTime: performance.now() },
          { col: last.col, row: last.row, layer: last.layer ?? 0, element: el, startTime: performance.now() },
        );
        // Spawn sand at the exact on-screen rect of each matched tile. The
        // renderer knows the precise pixel position (including per-layer 3D
        // offset) at match time — this avoids the rounding drift of the old
        // generic layout-sync approach.
        this.spawnSandForTile(first.col, first.row, first.layer ?? 0, el);
        this.spawnSandForTile(last.col, last.row, last.layer ?? 0, el);
        // Update store score + combo (with timestamp for the HUD countdown).
        const now = performance.now();
        useGameStore.getState().addScore(d.score);
        useGameStore.getState().setComboWithTime(d.combo, now);
        // Floating "+score" popup at the path midpoint so the player sees
        // immediately how many points a connection earned.
        const midIdx = Math.floor(pts.length / 2);
        const midPt = pts[midIdx] ?? first;
        this.tilePass.state.scoreAnims.push({
          col: midPt.col,
          row: midPt.row,
          layer: midPt.layer ?? 0,
          score: d.score,
          combo: d.combo,
          startTime: now,
        });
      }
      if (kind === "hint" && this.tilePass && data) {
        const d = data as { a: { col: number; row: number; layer: number }; b: { col: number; row: number; layer: number }; element: number };
        this.tilePass.state.hint = { a: d.a, b: d.b };
        // Clear hint after 3 seconds.
        setTimeout(() => {
          if (this.tilePass) this.tilePass.state.hint = null;
        }, 3000);
      }
      if (kind === "noHint") {
        // No valid moves — show a toast and auto-shuffle.
        const store = useGameStore.getState();
        store.showToast("No moves available — shuffling...", 2000);
        this.workerHost?.requestShuffle();
      }
      if (kind === "matchFailed" && this.tilePass && data) {
        const d = data as { reason: string; a: { col: number; row: number; layer: number }; b: { col: number; row: number; layer: number } };
        // Red flash on the two tiles that failed to match.
        this.tilePass.state.failAnims.push(
          { col: d.a.col, row: d.a.row, layer: d.a.layer, startTime: performance.now() },
          { col: d.b.col, row: d.b.row, layer: d.b.layer, startTime: performance.now() },
        );
        // Show a brief reason toast.
        const reasonText: Record<string, string> = {
          "different-element": "Different elements!",
          "no-path": "No path (max 2 turns)!",
          "not-selectable": "Tile is blocked!",
          "different-layer": "Tiles on different layers!",
          "same-tile": "Same tile!",
          "no-tile": "No tile there!",
        };
        const msg = reasonText[d.reason] ?? "No match!";
        useGameStore.getState().showToast(msg, 1500);
      }
      if (kind === "deadEnd") {
        // Board has no valid moves — auto-shuffle with a toast.
        const store = useGameStore.getState();
        store.showToast("No moves left — shuffling board...", 2000);
        this.workerHost?.requestShuffle();
      }
    });

    // Wire the afterFrame callback for custom 2D rendering.
    this.setCallbacks({
      afterFrame: (dt) => this.drawFrame(dt),
      onResize: () => this.handleResize(),
    });

    return true;
  }

  private resizeTileCanvas(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.floor(window.innerWidth * dpr);
    const h = Math.floor(window.innerHeight * dpr);
    this.tileCanvas.width = w;
    this.tileCanvas.height = h;
    this.tileCanvas.style.width = "100%";
    this.tileCanvas.style.height = "100%";
    if (this.tilePass) {
      this.tilePass.computeLayout(w, h);
    }
  }

  private handleResize(): void {
    if (!this.gridPass || !this.workerHost) return;
    this.resizeTileCanvas();
    const canvas = this.getCanvas();
    const dims = computeGridDims(canvas.width, canvas.height);
    if (dims.w === this.gridW && dims.h === this.gridH) return;
    this.gridW = dims.w;
    this.gridH = dims.h;
    this.gridPass.resize(this.gridW, this.gridH);
    this.workerHost.resize(this.gridW, this.gridH);
  }

  stop(): void {
    super.stop();
    this.workerHost?.stop();
    if (this.storeUnsub) this.storeUnsub();
    if (this.keydownHandler) window.removeEventListener("keydown", this.keydownHandler);
    this.input?.destroy();
    this.destroy();
  }

  private drawFrame(dt: number): void {
    const device = this.getDevice();
    const context = this.getContext();
    if (!device || !context || !this.input || !this.gridReader || !this.gridPass || !this.tilePass) return;

    // Process pan input (right/middle-drag) before clicks so a pan drag never
    // registers as a tile click.
    if (this.input.panDeltaX !== 0 || this.input.panDeltaY !== 0) {
      const { dx, dy } = this.input.consumePanDelta();
      if (dx !== 0 || dy !== 0) {
        this.tilePass.applyPan(dx, dy);
        this.tilePass.computeLayout(this.tileCanvas.width, this.tileCanvas.height);
      }
    }

    // Process click input (left button only — pan buttons are consumed above).
    if (this.input.hasClick) {
      this.input.hasClick = false;
      const hit = this.tilePass.hitTest(this.input.mouseX, this.input.mouseY);
      // Debug mode: capture tile info instead of selecting/matching.
      const dbg = useGameStore.getState();
      if (dbg.debugMode) {
        this.handleDebugClick(hit);
      } else if (hit) {
        const mode = dbg.mode;
        // Selectability UX check (the worker's match engine is the authority,
        // but this gives immediate feedback for why a click did nothing).
        // Sandjongg: per-layer top-down lock. Mahjongg: free-tile rule.
        const blocked = mode === "mahjongg"
          ? !this.tilePass.isTileFree(hit.col, hit.row, hit.layer)
          : this.tilePass.isLayerLocked(hit.layer);
        if (blocked) {
          this.tilePass.state.failAnims.push({ col: hit.col, row: hit.row, layer: hit.layer, startTime: performance.now() });
          this.tilePass.state.selected = null;
        } else {
          const el = this.tilePass.state.boardElements[(hit.col + hit.row * this.tilePass.state.boardCols) * MAX_LAYERS + hit.layer];
          if (el >= 0) {
            const sel = this.tilePass.state.selected;
            if (sel === null) {
              // First selection.
              this.tilePass.state.selected = hit;
            } else if (sel.col === hit.col && sel.row === hit.row && sel.layer === hit.layer) {
              // Clicked the already-selected tile → deselect (no red flash).
              this.tilePass.state.selected = null;
            } else if (mode === "sandjongg" && sel.layer !== hit.layer) {
              // Sandjongg: clicked a tile on a different layer → deselect.
              this.tilePass.state.selected = null;
            } else {
              // Attempt match. (Mahjongg allows cross-layer matches.)
              this.tilePass.state.selected = null;
              this.workerHost?.requestMatch(sel.col, sel.row, sel.layer, hit.col, hit.row, hit.layer);
            }
          } else {
            // Clicked empty cell — deselect.
            this.tilePass.state.selected = null;
          }
        }
      } else {
        // Clicked outside board — deselect.
        this.tilePass.state.selected = null;
      }
    }

    // Read board from SAB.
    this.updateBoardFromSAB();

    // Update tile pass layout if board dimensions or tile aspect changed.
    // The aspect changes when the player switches tilesets (e.g. elements=1.0
    // square → riichi=0.75 portrait); the layout must be recomputed so tileW
    // and tileH reflect the new aspect ratio.
    if (this.tilePass.state.boardCols !== this.prevBoardCols ||
        this.tilePass.state.boardRows !== this.prevBoardRows ||
        this.tilePass.state.tileAspect !== this.prevTileAspect) {
      this.prevBoardCols = this.tilePass.state.boardCols;
      this.prevBoardRows = this.tilePass.state.boardRows;
      this.prevTileAspect = this.tilePass.state.tileAspect;
      this.tilePass.resetPan();
      this.tilePass.computeLayout(this.tileCanvas.width, this.tileCanvas.height);
    }

    // Sync debug tile highlight from the store.
    const dbgTile = useGameStore.getState().debugTile;
    this.tilePass.state.debugTile = dbgTile
      ? { col: dbgTile.col, row: dbgTile.row, layer: dbgTile.layer }
      : null;

    // Draw tiles on Canvas2D.
    this.tilePass.draw();

    // Render sand on WebGPU.
    this.gridPass.updateGrid(this.gridReader.getGrid());
    this.gridPass.updateUniforms();

    const commandEncoder = device.createCommandEncoder();
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.04, g: 0.04, b: 0.07, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      }],
    });
    this.gridPass.render(pass);
    pass.end();
    device.queue.submit([commandEncoder.finish()]);

    // Update store stats from SAB.
    this.updateStatsFromSAB();
  }

  private updateBoardFromSAB(): void {
    if (!this.gridReader || !this.tilePass) return;
    // Reuse cached Int32Array views to avoid per-frame allocations.
    if (!this.cachedBoardElements || this.cachedBoardElements.buffer !== this.gridReader.sab) {
      this.cachedBoardElements = new Int32Array(this.gridReader.sab, BOARD_ELEMENT_OFFSET, MAX_TILES);
      this.cachedBoardMeta = new Int32Array(this.gridReader.sab, BOARD_META_OFFSET, 4);
    }
    const meta = this.cachedBoardMeta!;
    const cols = meta[0];
    const rows = meta[1];
    const layers = meta[2] || 1;
    if (cols > 0 && rows > 0) {
      this.tilePass.state.boardElements = this.cachedBoardElements;
      this.tilePass.state.boardCols = cols;
      this.tilePass.state.boardRows = rows;
      this.tilePass.state.boardLayers = layers;
    }
  }

  private updateStatsFromSAB(): void {
    if (!this.gridReader) return;
    const s = useGameStore.getState();
    // Throttle store updates.
    if (performance.now() - s.lastStatsUpdate < 100) return;
    const score = this.gridReader.getStat(STATS.SCORE);
    const combo = this.gridReader.getStat(STATS.COMBO);
    const level = this.gridReader.getStat(STATS.LEVEL);
    const tilesLeft = this.gridReader.getStat(STATS.TILES_LEFT);
    if (score !== s.score) s.setScore(score);
    if (combo !== s.combo) s.setCombo(combo);
    if (level !== s.level) s.setLevel(level);
    s.setTilesLeft(tilesLeft);
    s.setLastStatsUpdate(performance.now());
  }

  /** Debug mode click handler — captures full tile info and pushes it to the
   *  store so the debug panel can display it. */
  private handleDebugClick(hit: { col: number; row: number; layer: number } | null): void {
    if (!hit || !this.tilePass) {
      useGameStore.getState().setDebugTile(null);
      return;
    }
    const { boardElements, boardCols, boardRows } = this.tilePass.state;
    const idx = (hit.col + hit.row * boardCols) * MAX_LAYERS + hit.layer;
    const el = boardElements[idx];
    if (el < 0) {
      useGameStore.getState().setDebugTile(null);
      return;
    }
    const elDef = getTileDef(this.tilePass.state.tileset, el);
    const matDef = MATERIALS[elDef.sandMaterial];
    const rect = this.tilePass.tileRect(hit.col, hit.row, hit.layer);
    const canvas = this.getCanvas();
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    // Sand-grid coords (same conversion as spawnSandForTile).
    const sandCol = (rect.x * this.gridW) / canvasW;
    const sandRow = (rect.y * this.gridH) / canvasH;
    const sandW = (rect.w * this.gridW) / canvasW;
    const sandH = (rect.h * this.gridH) / canvasH;
    // Neighbors (same layer).
    const neighborEl = (c: number, r: number): number => {
      if (c < 0 || c >= boardCols || r < 0 || r >= boardRows) return -1;
      return boardElements[(c + r * boardCols) * MAX_LAYERS + hit.layer];
    };
    // Topmost = no tile above this one in a higher layer.
    let isTopmost = true;
    for (let l = hit.layer + 1; l < MAX_LAYERS; l++) {
      if (boardElements[(hit.col + hit.row * boardCols) * MAX_LAYERS + l] >= 0) {
        isTopmost = false;
        break;
      }
    }
    const info: DebugTileInfo = {
      col: hit.col,
      row: hit.row,
      layer: hit.layer,
      element: el,
      elementName: elDef.name,
      elementColor: elDef.color,
      glyph: elDef.glyph,
      sandMaterialId: elDef.sandMaterial,
      sandMaterialName: matDef?.name ?? `Material#${elDef.sandMaterial}`,
      screenX: rect.x,
      screenY: rect.y,
      screenW: rect.w,
      screenH: rect.h,
      sandCol,
      sandRow,
      sandW,
      sandH,
      neighbors: {
        n: neighborEl(hit.col, hit.row - 1),
        s: neighborEl(hit.col, hit.row + 1),
        e: neighborEl(hit.col + 1, hit.row),
        w: neighborEl(hit.col - 1, hit.row),
      },
      isTopmost,
    };
    useGameStore.getState().setDebugTile(info);
  }

  /** Spawn sand at the exact on-screen rect of a tile. Converts the tile's
   *  canvas-px rect (including per-layer 3D offset) to sand-grid coordinates
   *  and calls the worker's spawnSand RPC. Skipped entirely when the player
   *  has disabled sand physics (sandEnabled = false). */
  private spawnSandForTile(col: number, row: number, layer: number, element: number): void {
    if (!this.tilePass || !this.workerHost || this.gridW === 0 || this.gridH === 0) return;
    if (!useGameStore.getState().sandEnabled) return;
    const canvas = this.getCanvas();
    const canvasW = canvas.width;
    const canvasH = canvas.height;
    if (canvasW === 0 || canvasH === 0) return;
    const rect = this.tilePass.tileRect(col, row, layer);
    const sandCol = (rect.x * this.gridW) / canvasW;
    const sandRow = (rect.y * this.gridH) / canvasH;
    const sandW = (rect.w * this.gridW) / canvasW;
    const sandH = (rect.h * this.gridH) / canvasH;
    this.workerHost.spawnSand(sandCol, sandRow, sandW, sandH, element);
  }

  /** Push generation options (mode, no-adjacent, custom dims) to the worker when they change. */
  private pushOptions(): void {
    if (!this.workerHost) return;
    const s = useGameStore.getState();
    if (s.mode !== this.prevMode) {
      this.prevMode = s.mode;
      this.workerHost.setMode(s.mode);
    }
    // Keep the worker's active tileset in sync with the store. The pending
    // flag handles the regenerate-on-change flow; this covers save-restore
    // (where the tileset is set quietly without a pending flag) and any
    // other path that sets the tileset without going through setTileset().
    if (s.tileset !== this.prevTileset) {
      this.prevTileset = s.tileset;
      this.workerHost.setTileset(s.tileset);
    }
    if (s.noAdjacentSame !== this.prevNoAdjacent) {
      this.prevNoAdjacent = s.noAdjacentSame;
      this.workerHost.setNoAdjacentSame(s.noAdjacentSame);
    }
    if (s.customCols !== this.prevCustomCols || s.customRows !== this.prevCustomRows) {
      this.prevCustomCols = s.customCols;
      this.prevCustomRows = s.customRows;
      this.workerHost.setCustomDims(s.customCols, s.customRows);
    }
  }

  /** (Re)load the SVG atlas for a (tileset, theme) pair and swap it into the
   *  tile pass atomically when ready. No-op for procedural tilesets (the tile
   *  pass keeps atlas=null and draws procedural glyphs). Guards against
   *  overlapping loads so a rapid theme toggle doesn't race. */
  private async reloadAtlas(tileset: TilesetId, theme: TileTheme): Promise<void> {
    if (!isAssetBased(tileset)) {
      // Procedural tileset — no atlas. Clear any stale atlas on the tile pass.
      if (this.tilePass) this.tilePass.state.atlas = null;
      this.prevTileset = tileset;
      this.prevTileTheme = theme;
      return;
    }
    if (this.atlasLoading) return;
    this.atlasLoading = true;
    try {
      const atlas = await loadTileAtlas(tileset, theme);
      // Only swap if the tile pass still wants this (tileset, theme) — the
      // player may have toggled again while we were loading.
      const s = useGameStore.getState();
      if (s.tileset === tileset && s.tileTheme === theme && this.tilePass) {
        this.tilePass.state.atlas = atlas;
      }
      this.prevTileset = tileset;
      this.prevTileTheme = theme;
    } catch (err) {
      console.error(`[sandjongg] Failed to load tile atlas for ${tileset}/${theme}:`, err);
      // Fall back to no atlas — tiles will render without a face (just the
      // 3D slab + border). Better than crashing.
      if (this.tilePass) this.tilePass.state.atlas = null;
    } finally {
      this.atlasLoading = false;
    }
  }
}
