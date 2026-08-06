// ============================================================================
// TerrainMeshPool — main-thread dispatcher for terrain mesh generation workers
// Spawns N workers, dispatches jobs round-robin with worker affinity by island key.
// Falls back to synchronous execution if workers fail to spawn.
// ============================================================================

import {
    type CreateIslandFieldRequest,
    type CreateIslandFieldResult,
    type GenerateChunkMeshRequest,
    type GenerateChunkMeshResult,
    type GenerateDecorationMeshRequest,
    type GenerateDecorationMeshResult,
    type GeneratePortStructureMeshRequest,
    type GeneratePortStructureMeshResult,
    type GeneratePortTerrainMeshRequest,
    type GeneratePortTerrainMeshResult,
    type JobMessage,
    type JobResultMessage,
} from "./terrain-mesh-types";

type TaskName =
  | "createIslandField"
  | "generateChunkMesh"
  | "generateDecorationMesh"
  | "generatePortTerrainMesh"
  | "generatePortStructureMesh";

interface PendingJob {
  resolve: (result: any) => void;
  reject: (error: Error) => void;
}

export class TerrainMeshPool {
  private workers: Worker[] = [];
  private pending = new Map<number, PendingJob>();
  private keyWorkerMap = new Map<string, number>();
  private nextJobId = 0;
  private roundRobin = 0;
  private workerCount: number;
  private fallback = false;
  private destroyed = false;

  constructor(workerCount?: number) {
    const hw = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) ? navigator.hardwareConcurrency : 4;
    this.workerCount = workerCount ?? Math.min(4, Math.max(1, hw - 1));
  }

  async init(): Promise<void> {
    if (this.destroyed) return;

    try {
      const workerUrl = new URL("./terrain-mesh-worker.ts", import.meta.url);
      for (let i = 0; i < this.workerCount; i++) {
        const worker = new Worker(workerUrl, { type: "module" });
        worker.onerror = (e: ErrorEvent) => {
          console.error(`[TerrainMeshPool] Worker ${i} error:`, e.message);
        };
        worker.addEventListener("message", (e: MessageEvent) => {
          const msg = e.data as JobResultMessage;
          if (!msg || msg.__jobResult !== true) return;
          const pending = this.pending.get(msg.id);
          if (!pending) return;
          this.pending.delete(msg.id);
          if (msg.error) {
            pending.reject(new Error(msg.error));
          } else {
            pending.resolve(msg.result);
          }
        });
        this.workers.push(worker);
      }
    } catch (err) {
      console.warn("[TerrainMeshPool] Failed to spawn workers, falling back to synchronous:", err);
      this.fallback = true;
    }
  }

  isFallback(): boolean {
    return this.fallback;
  }

  private dispatch<T>(taskName: TaskName, args: unknown[], affinityKey?: string): Promise<T> {
    if (this.fallback || this.workers.length === 0) {
      return Promise.reject(new Error(`[TerrainMeshPool] No workers available for task: ${taskName}`));
    }

    const id = ++this.nextJobId;

    let workerIndex: number;
    if (affinityKey && this.keyWorkerMap.has(affinityKey)) {
      workerIndex = this.keyWorkerMap.get(affinityKey)!;
    } else {
      workerIndex = this.roundRobin % this.workers.length;
      this.roundRobin++;
      if (affinityKey) {
        this.keyWorkerMap.set(affinityKey, workerIndex);
      }
    }

    const worker = this.workers[workerIndex];
    const msg: JobMessage = { __job: true, id, fn: taskName, args };

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: any) => void, reject });
      worker.postMessage(msg);
    });
  }

  createIslandField(req: CreateIslandFieldRequest): Promise<CreateIslandFieldResult> {
    return this.dispatch<CreateIslandFieldResult>("createIslandField", [req], req.key);
  }

  generateChunkMesh(req: GenerateChunkMeshRequest): Promise<GenerateChunkMeshResult> {
    return this.dispatch<GenerateChunkMeshResult>("generateChunkMesh", [req], req.key);
  }

  generateDecorationMesh(req: GenerateDecorationMeshRequest): Promise<GenerateDecorationMeshResult> {
    return this.dispatch<GenerateDecorationMeshResult>("generateDecorationMesh", [req]);
  }

  generatePortTerrainMesh(req: GeneratePortTerrainMeshRequest): Promise<GeneratePortTerrainMeshResult> {
    return this.dispatch<GeneratePortTerrainMeshResult>("generatePortTerrainMesh", [req]);
  }

  generatePortStructureMesh(req: GeneratePortStructureMeshRequest): Promise<GeneratePortStructureMeshResult> {
    return this.dispatch<GeneratePortStructureMeshResult>("generatePortStructureMesh", [req]);
  }

  destroy(): void {
    this.destroyed = true;
    for (const worker of this.workers) {
      worker.terminate();
    }
    this.workers = [];
    for (const pending of this.pending.values()) {
      pending.reject(new Error("TerrainMeshPool destroyed"));
    }
    this.pending.clear();
    this.keyWorkerMap.clear();
  }
}
