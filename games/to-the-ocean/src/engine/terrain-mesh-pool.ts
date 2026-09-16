// ============================================================================
// TerrainMeshPool — main-thread dispatcher for terrain mesh generation workers
// Thin facade over TaskPool (worker spawn, round-robin + affinity dispatch,
// pending-job tracking, destroy all live in the shared class).
// ============================================================================

import { TaskPool } from "@downdraft/core";
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
} from "./terrain-mesh-types";

export class TerrainMeshPool {
  private pool: TaskPool;

  constructor(workerCount?: number) {
    this.pool = new TaskPool({
      workerCount,
      // NOTE: `new URL(...)` must be inlined directly inside `new Worker()` —
      // Vite only bundles worker modules when it sees this exact pattern.
      // Assigning the URL to a variable first causes Vite to emit the worker
      // as a raw unbundled asset (bare imports unresolved), breaking prod.
      createWorker: () => new Worker(new URL("./terrain-mesh-worker.ts", import.meta.url), { type: "module" }),
      onWorkerError: (i, e) => console.error(`[TerrainMeshPool] Worker ${i} error:`, e.message),
    });
  }

  async init(): Promise<void> {
    await this.pool.init();
  }

  isFallback(): boolean {
    return this.pool.isFallback();
  }

  createIslandField(req: CreateIslandFieldRequest): Promise<CreateIslandFieldResult> {
    return this.pool.dispatch<CreateIslandFieldResult>("createIslandField", [req], req.key);
  }

  generateChunkMesh(req: GenerateChunkMeshRequest): Promise<GenerateChunkMeshResult> {
    return this.pool.dispatch<GenerateChunkMeshResult>("generateChunkMesh", [req], req.key);
  }

  generateDecorationMesh(req: GenerateDecorationMeshRequest): Promise<GenerateDecorationMeshResult> {
    return this.pool.dispatch<GenerateDecorationMeshResult>("generateDecorationMesh", [req]);
  }

  generatePortTerrainMesh(req: GeneratePortTerrainMeshRequest): Promise<GeneratePortTerrainMeshResult> {
    return this.pool.dispatch<GeneratePortTerrainMeshResult>("generatePortTerrainMesh", [req]);
  }

  generatePortStructureMesh(req: GeneratePortStructureMeshRequest): Promise<GeneratePortStructureMeshResult> {
    return this.pool.dispatch<GeneratePortStructureMeshResult>("generatePortStructureMesh", [req]);
  }

  destroy(): void {
    this.pool.destroy();
  }
}
