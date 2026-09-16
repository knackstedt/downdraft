// ============================================================================
// MiningWorkerHost — manages the mining sim Web Worker and the shared SAB.
//
// The renderer creates this host, which spawns a single worker running
// ChunkWorld. The host provides methods to write input (keyboard, mouse, dig
// radius) and read the active grid + player state + stats from the SAB.
// ============================================================================

import { SimWorkerHost } from "@downdraft/core";
import type { BuildMaterialType } from "../shared/constants";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, INPUT } from "../shared/constants";
import {
    MiningSimBufferReader,
    MiningSimBufferWriter,
    OFFSETS,
    allocateMiningSimBuffer,
} from "../shared/sim-buffer";
import type { BuildMaterials, InventoryEntry, MiningPlayerState, PlayerUpgrades } from "../shared/types";
import type { SavedChunk } from "./chunk-world";

type MiningWorkerApi = {
  init(sab: SharedArrayBuffer): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
  getSaveData(): Promise<{ player: MiningPlayerState; upgrades: PlayerUpgrades; buildMaterials: BuildMaterials; dirtyChunks: SavedChunk[]; tick: number }>;
  loadSaveData(data: { player: MiningPlayerState; upgrades?: PlayerUpgrades; buildMaterials?: BuildMaterials; chunks: SavedChunk[]; tick: number }): Promise<void>;
  setUpgrades(upgrades: PlayerUpgrades): Promise<void>;
  setInventory(inventory: InventoryEntry[]): Promise<void>;
  addBuildMaterial(type: BuildMaterialType, qty: number): Promise<void>;
  respawn(): Promise<void>;
  explode(x: number, y: number, radius: number): Promise<void>;
  damagePlayer(amount: number, cause: number): Promise<void>;
  placeTorch(targetX: number, targetY: number): Promise<boolean>;
};

export class MiningWorkerHost extends SimWorkerHost<MiningWorkerApi> {
  private writer: MiningSimBufferWriter;
  private reader: MiningSimBufferReader;
  private onCollected: ((items: InventoryEntry[]) => void) | null = null;
  private onBuildMaterialsChanged: ((mats: BuildMaterials) => void) | null = null;

  constructor() {
    const sab = allocateMiningSimBuffer();
    super(sab);
    this.writer = new MiningSimBufferWriter(sab, OFFSETS, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.reader = new MiningSimBufferReader(sab, OFFSETS, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.writer.init();
    this.setInputWriter(this.writer);
    this.onSimEvent("collected", (data) => this.onCollected?.(data as InventoryEntry[]));
    this.onSimEvent("buildMaterials", (data) => this.onBuildMaterialsChanged?.(data as BuildMaterials));
  }

  getReader(): MiningSimBufferReader {
    return this.reader;
  }

  protected createWorker(): Worker {
    // CRITICAL: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    return new Worker(new URL("./mining-worker.ts", import.meta.url), { type: "module" });
  }

  protected async onInit(): Promise<void> {
    await this.getProxy()!.proxy.init(this.getSimBuffer());
  }

  protected onError(e: ErrorEvent): void {
    console.error("[MiningWorkerHost] Worker error:", e.message, "filename:", e.filename, "lineno:", e.lineno, "colno:", e.colno, "error:", e.error);
  }

  onCollectedItems(cb: (items: InventoryEntry[]) => void): void {
    this.onCollected = cb;
  }

  onBuildMaterials(cb: (mats: BuildMaterials) => void): void {
    this.onBuildMaterialsChanged = cb;
  }

  // --- Input writing ---

  writePlayerInput(
    left: boolean,
    right: boolean,
    up: boolean,
    down: boolean,
    jump: boolean,
  ): void {
    this.writeInput(INPUT.LEFT, left ? 1 : 0);
    this.writeInput(INPUT.RIGHT, right ? 1 : 0);
    this.writeInput(INPUT.UP, up ? 1 : 0);
    this.writeInput(INPUT.DOWN, down ? 1 : 0);
    this.writeInput(INPUT.JUMP, jump ? 1 : 0);
  }

  writeMouseDown(down: boolean): void {
    this.writeInput(INPUT.MOUSE_DOWN, down ? 1 : 0);
  }

  writeMousePos(worldX: number, worldY: number): void {
    this.writeInputF32(INPUT.MOUSE_X, worldX);
    this.writeInputF32(INPUT.MOUSE_Y, worldY);
  }

  writeDigRadius(radius: number): void {
    this.writeInput(INPUT.DIG_RADIUS, radius);
  }

  /** Write build-mode state (whether build mode is active and which material). */
  writeBuildInput(buildMode: boolean, buildMat: number): void {
    this.writeInput(INPUT.BUILD_MODE, buildMode ? 1 : 0);
    this.writeInput(INPUT.BUILD_MAT, buildMat);
  }

  /** Write noclip (dev cheat) state — when true, the player flies freely
   *  through terrain with no gravity/collision/damage. */
  writeNoclip(noclip: boolean): void {
    this.writeInput(INPUT.NOCLIP, noclip ? 1 : 0);
  }

  // --- Player state reading ---

  getPlayerF32(field: number): number {
    return this.reader.getPlayerF32(field);
  }
  getPlayerI32(field: number): number {
    return this.reader.getPlayerI32(field);
  }

  getStat(field: number): number {
    return this.reader.getStat(field);
  }

  // --- Save / Load ---

  async getSaveData(): Promise<{ player: MiningPlayerState; upgrades: PlayerUpgrades; buildMaterials: BuildMaterials; dirtyChunks: SavedChunk[]; tick: number } | null> {
    return this.apiCall((api) => api.getSaveData());
  }

  async loadSaveData(data: { player: MiningPlayerState; upgrades?: PlayerUpgrades; buildMaterials?: BuildMaterials; chunks: SavedChunk[]; tick: number }): Promise<void> {
    const result = await this.apiCall((api) => api.loadSaveData(data));
    if (result === null) {
      console.error("[MiningWorkerHost] Load save data failed — worker not started or RPC threw");
    }
  }

  setUpgrades(upgrades: PlayerUpgrades): void {
    this.apiSend((api) => api.setUpgrades(upgrades));
  }

  setInventory(inventory: InventoryEntry[]): void {
    this.apiSend((api) => api.setInventory(inventory));
  }

  addBuildMaterial(type: BuildMaterialType, qty: number): void {
    this.apiSend((api) => api.addBuildMaterial(type, qty));
  }

  respawn(): void {
    this.apiSend((api) => api.respawn());
  }
  explode(x: number, y: number, radius: number): void {
    this.apiSend((api) => api.explode(x, y, radius));
  }
  damagePlayer(amount: number, cause: number): void {
    this.apiSend((api) => api.damagePlayer(amount, cause));
  }

  /** Place a torch via raycast from the player toward the target world coords. */
  async placeTorch(targetX: number, targetY: number): Promise<boolean> {
    return (await this.apiCall((api) => api.placeTorch(targetX, targetY))) ?? false;
  }
}
