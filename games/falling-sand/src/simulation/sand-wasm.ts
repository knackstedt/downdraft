/**
 * sand-wasm.ts — TypeScript wrapper for the Rust WASM sand simulation backend.
 *
 * This module provides a drop-in replacement for the JS `SandWorld` class
 * that delegates to the compiled Rust WASM module (`games/falling-sand/sand-native`).
 * It exposes the same interface as `sand-world.ts` so `sand-worker.ts` can
 * switch between JS and WASM backends with a single feature flag.
 *
 * The WASM backend uses wasm-bindgen-rayon for multi-threaded passes
 * (reactions, combustion, aging) and zero-copy typed-array views into
 * WASM linear memory for the grid + fields.
 *
 * Usage:
 *   import { initWasm, SandWasmWorld } from "./sand-wasm";
 *   await initWasm(); // call once per worker
 *   const world = new SandWasmWorld(w, h);
 *   world.step();
 *   world.grid // Uint32Array view into WASM memory (zero-copy)
 */

import { FIELD } from "../shared/sim-buffer";
import type { Cell } from "./sand-world";

// The wasm-pack output is at games/falling-sand/sand-native/pkg/sand_native.js.
// Vite resolves this via the @sand-native alias configured in the game's
// electron.vite.config.ts. The .js import also brings in the .wasm URL.
import type {
    PlayerState as WasmPlayerStateType,
    SandWorld as WasmSandWorldType,
} from "@sand-native/sand_native";
import init, {
    reseed_rng,
    PlayerState as WasmPlayerState,
    SandWorld as WasmSandWorld
} from "@sand-native/sand_native";

// Re-export for consumers (camelCase alias for ergonomics)
export const reseedRng = reseed_rng;

// --- Module init state ---
let wasmReady = false;
let threadPoolReady = false;

// Type-only references to the instantiated classes
type WasmWorld = WasmSandWorldType;
type WasmPlayer = WasmPlayerStateType;

/**
 * Initialize the WASM module. Must be called once per worker before
 * creating any SandWasmWorld instances.
 *
 * Note: The rayon thread pool is NOT initialized because the Rust simulation
 * code is single-threaded (no `rayon::par_iter` calls). Initializing the
 * thread pool would spawn up to 8 idle Web Workers per sand-worker that
 * load duplicate WASM copies and consume resources, which can cause Chrome
 * DevTools performance traces to get stuck.
 *
 * @param _numThreads Unused — kept for API compatibility. The thread pool
 *   is intentionally not initialized.
 */
export async function initWasm(_numThreads?: number): Promise<void> {
  if (wasmReady) return;

  // Instantiate the WASM module. The default export from wasm-pack's
  // --target web output handles fetching + compiling the .wasm file.
  await init();

  // Intentionally NOT calling initThreadPool() — the Rust code doesn't use
  // rayon for parallel work, so spawning idle workers would waste resources.
  // The simulation runs single-threaded on the current worker's thread.
  threadPoolReady = true;

  wasmReady = true;
}

/**
 * Check if the WASM backend has been initialized.
 */
export function isWasmReady(): boolean {
  return wasmReady;
}

// ---------------------------------------------------------------------------
// SandWasmWorld — drop-in replacement for the JS SandWorld class
// ---------------------------------------------------------------------------

export class SandWasmWorld {
  /** The underlying WASM SandWorld instance. */
  readonly wasm: WasmWorld;

  // Cache the grid + fields views so we don't re-create typed arrays
  // on every access. The views are into WASM linear memory and remain
  // valid as long as the WASM instance is alive.
  private _gridView: Uint32Array | null = null;
  private _fieldsView: Uint8Array | null = null;

  // Public properties matching the JS SandWorld interface
  readonly W: number;
  readonly H: number;
  frame = 0;
  horizontalImpulseChance = 0.02;
  horizontalImpulseStrength = 1;

  constructor(w: number, h: number) {
    if (!wasmReady) {
      throw new Error("SandWasmWorld: WASM module not initialized. Call initWasm() first.");
    }
    this.wasm = new WasmSandWorld(w, h) as WasmWorld;
    this.W = w;
    this.H = h;
  }

  // --- Zero-copy grid + fields views ---

  /** Uint32Array view into WASM linear memory (zero-copy). */
  get grid(): Uint32Array {
    // Re-fetch each call — the view is cheap and stays valid, but if WASM
    // memory grows the old view becomes detached. Fetching fresh is safest.
    this._gridView = this.wasm.grid as Uint32Array;
    return this._gridView;
  }

  /** Uint8Array view into WASM linear memory (zero-copy). */
  get fields(): Uint8Array {
    this._fieldsView = this.wasm.fields as Uint8Array;
    return this._fieldsView;
  }

  // --- Field accessors (match JS SandWorld interface) ---

  getGravity(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 1.0;
    return this.fields[(y * this.W + x) * 4 + FIELD.GRAVITY] / 128;
  }

  getTemperature(x: number, y: number): number {
    return this.wasm.get_temperature(x, y);
  }

  getWindX(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return (this.fields[(y * this.W + x) * 4 + FIELD.WIND_X] << 24) >> 24;
  }

  getWindY(x: number, y: number): number {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return 0;
    return (this.fields[(y * this.W + x) * 4 + FIELD.WIND_Y] << 24) >> 24;
  }

  // --- Field painting ---

  paintField(cx: number, cy: number, fieldType: number, value: number, radius: number): void {
    // The WASM backend only exposes paintFieldLine; for a single point,
    // paint a zero-length line.
    this.wasm.paint_field_line(cx, cy, cx, cy, fieldType, value & 0xff, radius);
  }

  paintFieldLine(x0: number, y0: number, x1: number, y1: number, fieldType: number, value: number, radius: number): void {
    this.wasm.paint_field_line(x0, y0, x1, y1, fieldType, value & 0xff, radius);
  }

  // --- Cell accessors ---

  getCell(x: number, y: number): Cell {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) {
      return { mat: 0, lifetime: 0, flags: 0 };
    }
    return {
      mat: this.wasm.get_cell_mat(x, y),
      lifetime: this.wasm.get_cell_lifetime(x, y),
      flags: this.wasm.get_cell_flags(x, y),
    };
  }

  setCell(x: number, y: number, cell: Cell): void {
    if (x < 0 || x >= this.W || y < 0 || y >= this.H) return;
    this.wasm.set_cell(x, y, cell.mat, cell.lifetime, cell.flags);
  }

  // --- Brush operations ---

  paintMaterial(cx: number, cy: number, mat: number, radius: number): void {
    this.wasm.paint_material(cx, cy, mat, radius);
  }

  paintLine(x0: number, y0: number, x1: number, y1: number, mat: number, radius: number): void {
    this.wasm.paint_line(x0, y0, x1, y1, mat, radius);
  }

  igniteLine(x0: number, y0: number, x1: number, y1: number, radius: number): void {
    this.wasm.ignite_line(x0, y0, x1, y1, radius);
  }

  // --- Main step ---

  step(): void {
    // Sync impulse settings to WASM before stepping
    this.wasm.set_horizontal_impulse(this.horizontalImpulseChance, this.horizontalImpulseStrength);
    this.wasm.step();
    this.frame = this.wasm.frame as number;
  }

  // --- Cleanup ---

  /** Free the WASM instance. Call when the world is no longer needed. */
  free(): void {
    this.wasm.free();
    this._gridView = null;
    this._fieldsView = null;
  }
}

// ---------------------------------------------------------------------------
// SandWasmPlayer — drop-in replacement for the JS player functions
// ---------------------------------------------------------------------------

export interface WasmPlayerStateLike {
  x: number;
  y: number;
  vx: number;
  vy: number;
  onGround: boolean;
  facing: number;
  animFrame: number;
  health: number;
}

/**
 * Create a WASM-backed player state.
 */
export function createWasmPlayer(gridW: number, gridH: number): WasmPlayerHandle {
  if (!wasmReady) {
    throw new Error("createWasmPlayer: WASM module not initialized. Call initWasm() first.");
  }
  const wasm = new WasmPlayerState(gridW, gridH) as WasmPlayer;
  return new WasmPlayerHandle(wasm);
}

/**
 * Handle wrapping the WASM PlayerState. Exposes the same fields as the
 * JS `PlayerState` interface so the worker can read them transparently.
 */
export class WasmPlayerHandle implements WasmPlayerStateLike {
  private wasm: WasmPlayer;

  constructor(wasm: WasmPlayer) {
    this.wasm = wasm;
  }

  get x(): number { return this.wasm.x as number; }
  get y(): number { return this.wasm.y as number; }
  get vx(): number { return this.wasm.vx as number; }
  get vy(): number { return this.wasm.vy as number; }
  get onGround(): boolean { return this.wasm.on_ground as boolean; }
  get facing(): number { return this.wasm.facing as number; }
  get animFrame(): number { return this.wasm.anim_frame as number; }
  get health(): number { return this.wasm.health as number; }

  /**
   * Update the player physics. Pass the grid as a Uint32Array — the WASM
   * backend copies it internally (the grid is in WASM memory, so we pass
   * the view directly).
   */
  update(
    input: { left: boolean; right: boolean; up: boolean; down: boolean; jump: boolean },
    grid: Uint32Array,
    w: number,
    h: number,
  ): void {
    this.wasm.update(input.left, input.right, input.up, input.down, input.jump, grid, w, h);
  }

  free(): void {
    this.wasm.free();
  }
}
