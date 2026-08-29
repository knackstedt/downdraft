// ============================================================================
// BlockheadsWorkerHost — manages the blockheads sim Web Worker and the SAB.
//
// The renderer creates this host, which spawns a worker running BlockWorld.
// The host provides methods to control the sim (pause/resume/step) and read
// the active grid + stats from the SAB.
// ============================================================================

import { BaseWorkerHost } from "@downdraft/core";
import { decodeMapRegion, type MapRegionData } from "../shared/map-buffer";
import type { CraftStation } from "../shared/recipes";
import { createSimBuffer, SimBufferReader } from "../shared/sim-buffer";
import type { TaskType } from "./task-queue";

type InventorySlot = { itemId: string; count: number } | null;
type TaskSummary = { id: number; type: TaskType; targetX: number; targetY: number; blockId: number; status: string; failReason?: string };

type CraftJobSummary = {
  id: number; recipeId: string; recipeName: string;
  progress: number; elapsed: number; craftTime: number;
  bhIndex: number; status: string;
};

type CraftQueueSummary = {
  fuel: number;
  activeJob: CraftJobSummary | null;
  queue: { id: number; recipeId: string; recipeName: string; bhIndex: number; status: string }[];
};

type TaskOpts = {
  targetX?: number; targetY?: number;
  blockId?: number;
  recipeId?: string;
  stationAx?: number; stationAy?: number;
  itemId?: string;
};

type BlockheadsWorkerApi = {
  init(sab: SharedArrayBuffer): Promise<void>;
  resetGame(): Promise<{ ok: boolean; error?: string }>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  shutdown(): Promise<void>;
  saveNow(): Promise<number>;
  setSpeed(speed: number): Promise<void>;
  step(): Promise<void>;
  forceFruitSpawn(): Promise<number>;
  getStats(): Promise<{ fps: number; tick: number; frame: number }>;
  setFocus(x: number, y: number): Promise<void>;
  setBlock(x: number, y: number, blockId: number): Promise<void>;
  getBlock(x: number, y: number): Promise<number>;
  getWorldStats(): Promise<{ loadedChunks: number; activeChunks: number; tick: number }>;
  // Inventory + crafting
  getInventory(bhIndex?: number): Promise<InventorySlot[]>;
  craft(recipeId: string, stationAx?: number, stationAy?: number, bhIndex?: number): Promise<{ ok: boolean; error?: string; jobId?: number }>;
  getRecipes(station?: CraftStation): Promise<{ id: string; name: string; station: CraftStation }[]>;
  giveItem(itemId: string, count?: number, bhIndex?: number): Promise<{ ok: boolean; added: number }>;
  setInventory(slots: unknown, bhIndex?: number): Promise<{ ok: boolean }>;
  moveSlot(from: number, to: number, bhIndex?: number): Promise<{ ok: boolean }>;
  // Station crafting
  getCraftQueue(stationAx: number, stationAy: number): Promise<CraftQueueSummary>;
  addFuel(stationAx: number, stationAy: number, itemId: string, count?: number, bhIndex?: number): Promise<{ ok: boolean; error?: string }>;
  rushCraft(stationAx: number, stationAy: number, jobId: number, bhIndex?: number): Promise<{ ok: boolean; error?: string }>;
  abortCraft(stationAx: number, stationAy: number, jobId: number): Promise<{ ok: boolean }>;
  // Task queue
  queueTask(type: TaskType, opts: TaskOpts, bhIndex?: number): Promise<{ ok: boolean; taskId: number; duplicate: boolean }>;
  getTasks(bhIndex?: number): Promise<TaskSummary[]>;
  clearTasks(bhIndex?: number): Promise<{ ok: boolean }>;
  cancelTask(type: TaskType, targetX: number, targetY: number, bhIndex?: number): Promise<{ ok: boolean }>;
  // Map region snapshot (encoded ArrayBuffer — see shared/map-buffer.ts)
  getMapRegion(centerCx: number): Promise<ArrayBuffer>;
  // Multi-character: spawn, active selection, roster
  spawnBlockhead(x?: number, y?: number, gender?: string): Promise<{ ok: boolean; bhIndex?: number; id?: number; error?: string }>;
  spawnBlockheadFromEgg(bhIndex: number): Promise<{ ok: boolean; bhIndex?: number; id?: number; error?: string }>;
  useItem(itemId: string, bhIndex?: number): Promise<{ ok: boolean; error?: string }>;
  setActiveBhIndex(i: number): Promise<{ ok: boolean; activeBhIndex: number }>;
  getActiveBhIndex(): Promise<number>;
  getBlockheads(): Promise<{ id: number; bhIndex: number; x: number; y: number; health: number; hunger: number; energy: number; air: number; happiness: number; environment: number; gender: string }[]>;
  setBhGender(id: number, gender: string): Promise<{ ok: boolean }>;
  // Roster persistence
  getBlockheadRoster(): Promise<{
    activeBhIndex: number;
    blockheads: {
      id: number; x: number; y: number; gender: string;
      health: number; hunger: number; energy: number; air: number;
      happiness: number; environment: number;
      inventory: ({ itemId: string; count: number } | null)[];
      tasks: { type: string; targetX?: number; targetY?: number; status: string }[];
    }[];
  }>;
  setBlockheadRoster(roster: {
    activeBhIndex?: number;
    blockheads: {
      id: number; x: number; y: number; gender: string;
      health: number; hunger: number; energy: number; air: number;
      happiness: number; environment: number;
      inventory: ({ itemId: string; count: number } | null)[];
      tasks: { type: string; targetX?: number; targetY?: number; status: string }[];
    }[];
  }): Promise<{ ok: boolean }>;
};

export class BlockheadsWorkerHost extends BaseWorkerHost<BlockheadsWorkerApi> {
  private reader: SimBufferReader;
  private pickupListener: ((data: Record<string, number>) => void) | null = null;
  // Dedicated pather worker — spawned from the renderer (not the sim worker)
  // so Vite can bundle it. Connected to the sim worker via a MessageChannel.
  private patherWorker: Worker | null = null;

  constructor() {
    const sab = createSimBuffer();
    super(sab);
    this.reader = new SimBufferReader(sab as ArrayBufferLike);
  }

  getReader(): SimBufferReader {
    return this.reader;
  }

  /**
   * Register a listener for batched pickup notifications from the worker.
   * The worker emits a single "pickups" event per frame when items are
   * picked up (mined block drops, world-drop pickups, fruit pickups), with
   * a payload of { itemId: count, ... }. Call this once after start().
   */
  onPickups(cb: (data: Record<string, number>) => void): void {
    this.pickupListener = cb;
  }

  protected createWorker(): Worker {
    // CRITICAL: `new URL(...)` must be inlined directly inside `new Worker()` —
    // Vite only bundles worker modules when it sees this exact pattern.
    // Assigning the URL to a variable first causes Vite to emit the worker
    // as a raw unbundled asset (bare imports unresolved), breaking prod.
    return new Worker(new URL("./blockheads-worker.ts", import.meta.url), { type: "module" });
  }

  protected async onInit(): Promise<void> {
    await this.getProxy()!.proxy.init(this.getSimBuffer());

    // Spawn the dedicated pather worker and connect it to the sim worker via
    // a MessageChannel. The pather worker is spawned HERE (renderer thread)
    // because Vite can only bundle workers spawned from the renderer — not
    // nested workers spawned from within other workers.
    this.patherWorker = new Worker(
      new URL("./pathfinding-worker.ts", import.meta.url),
      { type: "module" },
    );
    const channel = new MessageChannel();
    // Send port1 + SAB to the pather worker (init handshake).
    this.patherWorker.postMessage(
      { __patherInit: true, sab: this.getSimBuffer() },
      [channel.port1],
    );
    // Send port2 to the sim worker (it will pass it to PathfindingBroker).
    this.worker!.postMessage(
      { __patherPort: true },
      [channel.port2],
    );
  }

  protected onEvent(kind: string, data?: unknown): void {
    if (kind === "ready") {
      this.ready = true;
    } else if (kind === "pickups" && this.pickupListener && data) {
      this.pickupListener(data as Record<string, number>);
    }
  }

  /**
   * Reset the whole game: delete the OPFS save, re-create the world from
   * scratch, reset the blockhead + inventory + task queues. The worker
   * stays alive — only the simulation state is rebuilt.
   */
  async resetGame(): Promise<{ ok: boolean; error?: string }> {
    const proxy = this.getProxy();
    if (!proxy) return { ok: false, error: "Worker not started" };
    return proxy.proxy.resetGame();
  }

  async pause(): Promise<void> {
    await this.getProxy()?.proxy.pause();
  }

  async resume(): Promise<void> {
    await this.getProxy()?.proxy.resume();
  }

  async setSpeed(speed: number): Promise<void> {
    await this.getProxy()?.proxy.setSpeed(speed);
  }

  async forceFruitSpawn(): Promise<number> {
    return await this.getProxy()?.proxy.forceFruitSpawn() ?? 0;
  }

  async saveNow(): Promise<number> {
    const proxy = this.getProxy();
    if (!proxy) return 0;
    return proxy.proxy.saveNow();
  }

  async setFocus(x: number, y: number): Promise<void> {
    await this.getProxy()?.proxy.setFocus(x, y);
  }

  async setBlock(x: number, y: number, blockId: number): Promise<void> {
    await this.getProxy()?.proxy.setBlock(x, y, blockId);
  }

  async getBlock(x: number, y: number): Promise<number> {
    return await this.getProxy()?.proxy.getBlock(x, y) ?? 0;
  }

  async getStats(): Promise<{ fps: number; tick: number; frame: number }> {
    return await this.getProxy()?.proxy.getStats() ?? { fps: 0, tick: 0, frame: 0 };
  }

  async getWorldStats(): Promise<{ loadedChunks: number; activeChunks: number; tick: number }> {
    return await this.getProxy()?.proxy.getWorldStats() ?? { loadedChunks: 0, activeChunks: 0, tick: 0 };
  }

  // --- Inventory + crafting ---
  async getInventory(bhIndex: number = 0): Promise<InventorySlot[]> {
    return await this.getProxy()?.proxy.getInventory(bhIndex) ?? [];
  }

  async craft(recipeId: string, stationAx: number = -1, stationAy: number = -1, bhIndex: number = 0): Promise<{ ok: boolean; error?: string; jobId?: number }> {
    return await this.getProxy()?.proxy.craft(recipeId, stationAx, stationAy, bhIndex) ?? { ok: false, error: "Worker not ready" };
  }

  async getRecipes(station?: CraftStation): Promise<{ id: string; name: string; station: CraftStation }[]> {
    return await this.getProxy()?.proxy.getRecipes(station) ?? [];
  }

  async giveItem(itemId: string, count: number = 1, bhIndex: number = 0): Promise<{ ok: boolean; added: number }> {
    return await this.getProxy()?.proxy.giveItem(itemId, count, bhIndex) ?? { ok: false, added: 0 };
  }

  async setInventory(slots: unknown, bhIndex: number = 0): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.setInventory(slots, bhIndex) ?? { ok: false };
  }

  async moveSlot(from: number, to: number, bhIndex: number = 0): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.moveSlot(from, to, bhIndex) ?? { ok: false };
  }

  // --- Station crafting ---
  async getCraftQueue(stationAx: number, stationAy: number): Promise<CraftQueueSummary> {
    return await this.getProxy()?.proxy.getCraftQueue(stationAx, stationAy) ?? { fuel: 0, activeJob: null, queue: [] };
  }

  async addFuel(stationAx: number, stationAy: number, itemId: string, count: number = 1, bhIndex: number = 0): Promise<{ ok: boolean; error?: string }> {
    return await this.getProxy()?.proxy.addFuel(stationAx, stationAy, itemId, count, bhIndex) ?? { ok: false, error: "Worker not ready" };
  }

  async rushCraft(stationAx: number, stationAy: number, jobId: number, bhIndex: number = 0): Promise<{ ok: boolean; error?: string }> {
    return await this.getProxy()?.proxy.rushCraft(stationAx, stationAy, jobId, bhIndex) ?? { ok: false, error: "Worker not ready" };
  }

  async abortCraft(stationAx: number, stationAy: number, jobId: number): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.abortCraft(stationAx, stationAy, jobId) ?? { ok: false };
  }

  // --- Task queue ---
  async queueTask(type: TaskType, opts: TaskOpts, bhIndex: number = 0): Promise<{ ok: boolean; taskId: number; duplicate: boolean }> {
    return await this.getProxy()?.proxy.queueTask(type, opts, bhIndex) ?? { ok: false, taskId: -1, duplicate: false };
  }

  async getTasks(bhIndex: number = 0): Promise<TaskSummary[]> {
    return await this.getProxy()?.proxy.getTasks(bhIndex) ?? [];
  }

  async clearTasks(bhIndex: number = 0): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.clearTasks(bhIndex) ?? { ok: false };
  }

  async cancelTask(type: TaskType, targetX: number, targetY: number, bhIndex: number = 0): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.cancelTask(type, targetX, targetY, bhIndex) ?? { ok: false };
  }

  /**
   * Request a downsampled map region snapshot centered on chunk column
   * `centerCx`. Returns a decoded MapRegionData, or null if the worker is
   * not ready or the response is malformed. The worker encodes the region
   * into a single ArrayBuffer (see shared/map-buffer.ts) which is structured-
   * cloned across the worker boundary.
   */
  async getMapRegion(centerCx: number): Promise<MapRegionData | null> {
    const buf = await this.getProxy()?.proxy.getMapRegion(centerCx);
    if (!buf) return null;
    return decodeMapRegion(buf);
  }

  // --- Multi-character: spawn, active selection, roster ---
  async spawnBlockhead(x?: number, y?: number, gender?: string): Promise<{ ok: boolean; bhIndex?: number; id?: number; error?: string }> {
    return await this.getProxy()?.proxy.spawnBlockhead(x, y, gender) ?? { ok: false, error: "Worker not ready" };
  }

  async spawnBlockheadFromEgg(bhIndex: number): Promise<{ ok: boolean; bhIndex?: number; id?: number; error?: string }> {
    return await this.getProxy()?.proxy.spawnBlockheadFromEgg(bhIndex) ?? { ok: false, error: "Worker not ready" };
  }

  async useItem(itemId: string, bhIndex: number = 0): Promise<{ ok: boolean; error?: string }> {
    return await this.getProxy()?.proxy.useItem(itemId, bhIndex) ?? { ok: false, error: "Worker not ready" };
  }

  async setActiveBhIndex(i: number): Promise<{ ok: boolean; activeBhIndex: number }> {
    return await this.getProxy()?.proxy.setActiveBhIndex(i) ?? { ok: false, activeBhIndex: 0 };
  }

  async getActiveBhIndex(): Promise<number> {
    return await this.getProxy()?.proxy.getActiveBhIndex() ?? 0;
  }

  async getBlockheads(): Promise<{ id: number; bhIndex: number; x: number; y: number; health: number; hunger: number; energy: number; air: number; happiness: number; environment: number; gender: string }[]> {
    return await this.getProxy()?.proxy.getBlockheads() ?? [];
  }

  async setBhGender(id: number, gender: string): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.setBhGender(id, gender) ?? { ok: false };
  }

  async getBlockheadRoster(): Promise<{
    activeBhIndex: number;
    blockheads: {
      id: number; x: number; y: number; gender: string;
      health: number; hunger: number; energy: number; air: number;
      happiness: number; environment: number;
      inventory: ({ itemId: string; count: number } | null)[];
      tasks: { type: string; targetX?: number; targetY?: number; status: string }[];
    }[];
  }> {
    return await this.getProxy()?.proxy.getBlockheadRoster() ?? { activeBhIndex: 0, blockheads: [] };
  }

  async setBlockheadRoster(roster: {
    activeBhIndex?: number;
    blockheads: {
      id: number; x: number; y: number; gender: string;
      health: number; hunger: number; energy: number; air: number;
      happiness: number; environment: number;
      inventory: ({ itemId: string; count: number } | null)[];
      tasks: { type: string; targetX?: number; targetY?: number; status: string }[];
    }[];
  }): Promise<{ ok: boolean }> {
    return await this.getProxy()?.proxy.setBlockheadRoster(roster) ?? { ok: false };
  }

  /**
   * Override stop() to also terminate the dedicated pather worker.
   */
  async stop(): Promise<void> {
    if (this.patherWorker) {
      this.patherWorker.terminate();
      this.patherWorker = null;
    }
    await super.stop();
  }
}
