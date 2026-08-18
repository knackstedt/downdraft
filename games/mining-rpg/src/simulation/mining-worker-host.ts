// ============================================================================
// MiningWorkerHost — manages the mining sim Web Worker and the shared SAB.
//
// The renderer creates this host, which spawns a single worker running
// ChunkWorld. The host provides methods to write input (keyboard, mouse, dig
// radius) and read the active grid + player state + stats from the SAB.
// ============================================================================

import { wrap, type WorkerProxy } from "@downdraft/core/worker/rpc";
import type { BuildMaterialType } from "../shared/constants";
import { ACTIVE_GRID_H, ACTIVE_GRID_W, INPUT } from "../shared/constants";
import {
    MiningSimBufferReader,
    MiningSimBufferWriter,
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
};

export class MiningWorkerHost {
  private sab: SharedArrayBuffer;
  private writer: MiningSimBufferWriter;
  private reader: MiningSimBufferReader;
  private proxy: WorkerProxy<MiningWorkerApi> | null = null;
  private worker: Worker | null = null;
  private ready = false;
  private onCollected: ((items: InventoryEntry[]) => void) | null = null;
  private onBuildMaterialsChanged: ((mats: BuildMaterials) => void) | null = null;

  constructor() {
    this.sab = allocateMiningSimBuffer();
    this.writer = new MiningSimBufferWriter(this.sab, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.reader = new MiningSimBufferReader(this.sab, ACTIVE_GRID_W, ACTIVE_GRID_H);
    this.writer.init();
  }

  getSimBuffer(): SharedArrayBuffer {
    return this.sab;
  }
  getReader(): MiningSimBufferReader {
    return this.reader;
  }
  isReady(): boolean {
    return this.ready;
  }

  async start(): Promise<void> {
    const workerUrl = new URL("./mining-worker.ts", import.meta.url);
    this.worker = new Worker(workerUrl, { type: "module" });
    this.proxy = wrap<MiningWorkerApi>(this.worker);

    this.worker.onerror = (e: ErrorEvent) => {
      console.error("[MiningWorkerHost] Worker error:", e.message);
    };

    this.proxy.onEvents((kind, data) => {
      if (kind === "ready") {
        this.ready = true;
      } else if (kind === "collected" && this.onCollected) {
        this.onCollected(data as InventoryEntry[]);
      } else if (kind === "buildMaterials" && this.onBuildMaterialsChanged) {
        this.onBuildMaterialsChanged(data as BuildMaterials);
      }
    });

    await this.proxy.proxy.init(this.sab);
  }

  async stop(): Promise<void> {
    if (this.proxy) {
      try {
        await this.proxy.proxy.shutdown();
      } catch {}
      this.proxy.terminate();
    }
    this.proxy = null;
    this.worker = null;
    this.ready = false;
  }

  pause(): void {
    this.proxy?.proxy.pause().catch(() => {});
  }
  resume(): void {
    this.proxy?.proxy.resume().catch(() => {});
  }
  setSpeed(speed: number): void {
    this.proxy?.proxy.setSpeed(speed).catch(() => {});
  }
  step(): void {
    this.proxy?.proxy.step().catch(() => {});
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
    this.writer.writeInput(INPUT.LEFT, left ? 1 : 0);
    this.writer.writeInput(INPUT.RIGHT, right ? 1 : 0);
    this.writer.writeInput(INPUT.UP, up ? 1 : 0);
    this.writer.writeInput(INPUT.DOWN, down ? 1 : 0);
    this.writer.writeInput(INPUT.JUMP, jump ? 1 : 0);
  }

  writeMouseDown(down: boolean): void {
    this.writer.writeInput(INPUT.MOUSE_DOWN, down ? 1 : 0);
  }

  writeMousePos(worldX: number, worldY: number): void {
    this.writer.writeInputF32(INPUT.MOUSE_X, worldX);
    this.writer.writeInputF32(INPUT.MOUSE_Y, worldY);
  }

  writeDigRadius(radius: number): void {
    this.writer.writeInput(INPUT.DIG_RADIUS, radius);
  }

  /** Write build-mode state (whether build mode is active and which material). */
  writeBuildInput(buildMode: boolean, buildMat: number): void {
    this.writer.writeInput(INPUT.BUILD_MODE, buildMode ? 1 : 0);
    this.writer.writeInput(INPUT.BUILD_MAT, buildMat);
  }

  /** Write noclip (dev cheat) state — when true, the player flies freely
   *  through terrain with no gravity/collision/damage. */
  writeNoclip(noclip: boolean): void {
    this.writer.writeInput(INPUT.NOCLIP, noclip ? 1 : 0);
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

  async getStats(): Promise<{ fps: number; tick: number; frame: number } | null> {
    if (!this.proxy) return null;
    try {
      return await this.proxy.proxy.getStats();
    } catch {
      return null;
    }
  }

  // --- Save / Load ---

  async getSaveData(): Promise<{ player: MiningPlayerState; upgrades: PlayerUpgrades; buildMaterials: BuildMaterials; dirtyChunks: SavedChunk[]; tick: number } | null> {
    if (!this.proxy) return null;
    try {
      return await this.proxy.proxy.getSaveData();
    } catch {
      return null;
    }
  }

  async loadSaveData(data: { player: MiningPlayerState; upgrades?: PlayerUpgrades; buildMaterials?: BuildMaterials; chunks: SavedChunk[]; tick: number }): Promise<void> {
    if (!this.proxy) return;
    try {
      await this.proxy.proxy.loadSaveData(data);
    } catch (e) {
      console.error("[MiningWorkerHost] Load save data failed:", e);
    }
  }

  setUpgrades(upgrades: PlayerUpgrades): void {
    this.proxy?.proxy.setUpgrades(upgrades).catch(() => {});
  }

  setInventory(inventory: InventoryEntry[]): void {
    this.proxy?.proxy.setInventory(inventory).catch(() => {});
  }

  addBuildMaterial(type: BuildMaterialType, qty: number): void {
    this.proxy?.proxy.addBuildMaterial(type, qty).catch(() => {});
  }

  respawn(): void {
    this.proxy?.proxy.respawn().catch(() => {});
  }
  explode(x: number, y: number, radius: number): void {
    this.proxy?.proxy.explode(x, y, radius).catch(() => {});
  }
}
