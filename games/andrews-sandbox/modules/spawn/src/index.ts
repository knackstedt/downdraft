// ============================================================================
// @andrews-sandbox/module-spawn — prop spawning coordination.
// Bridges the content registry, sim worker, and renderer to spawn props.
// Uses generic interfaces to avoid cross-module import cycles.
// ============================================================================

import type { ContentRegistry } from "@andrews-sandbox/library-content";

/** Minimal sim worker interface for spawn commands. */
export interface SpawnSimApi {
  sendCommand(cmd: { type: "spawn"; contentId: string; position: [number, number, number] }): void;
  sendCommand(cmd: { type: "remove"; entityId: number }): void;
  sendCommand(cmd: { type: "clear" }): void;
  sendCommand(cmd: any): void;
}

/** Minimal renderer interface for model loading. */
export interface SpawnRendererApi {
  loadPropModel(contentId: string, modelUri: string): Promise<string>;
}

export class SpawnController {
  private registry: ContentRegistry;
  private sim: SpawnSimApi;
  private renderer: SpawnRendererApi;
  private simSAB: SharedArrayBuffer;

  constructor(
    registry: ContentRegistry,
    sim: SpawnSimApi,
    renderer: SpawnRendererApi,
    simSAB: SharedArrayBuffer,
  ) {
    this.registry = registry;
    this.sim = sim;
    this.renderer = renderer;
    this.simSAB = simSAB;
  }

  /**
   * Spawn a prop at the given position. Looks up the content entry
   * and sends a spawn command to the sim.
   */
  spawnProp(contentId: string, position: [number, number, number]): void {
    const entry = this.registry.get(contentId);
    if (!entry) {
      console.warn(`[SpawnController] Unknown content id: ${contentId}`);
      return;
    }
    this.sim.sendCommand({ type: "spawn", contentId, position });
  }

  /**
   * Called when the sim emits a "prop_spawned" event. Loads the model
   * in the renderer and writes the node id back to the SAB.
   */
  async onPropSpawned(data: {
    entityId: number;
    contentId: string;
    nodeId: number;
    position: [number, number, number];
    quaternion: [number, number, number, number];
    scale: number;
    paintable: boolean;
  }): Promise<void> {
    const entry = this.registry.get(data.contentId);
    if (!entry) return;

    if (entry.modelUri) {
      const nodeId = await this.renderer.loadPropModel(data.contentId, entry.modelUri);
      if (nodeId) {
        const nodeIdNum = parseInt(nodeId.split("-")[1] ?? "0", 10);
        this.writeNodeIdToSAB(data.entityId, nodeIdNum);
      }
    }
    // If no modelUri, the renderer draws a builtin cube (nodeId stays 0)
  }

  removeProp(entityId: number): void {
    this.sim.sendCommand({ type: "remove", entityId });
  }

  clearProps(): void {
    this.sim.sendCommand({ type: "clear" });
  }

  private writeNodeIdToSAB(entityId: number, nodeId: number): void {
    const slotIdx = entityId - 1;
    if (slotIdx < 0) return;
    const u32 = new Uint32Array(this.simSAB);
    // Entity slot layout: each slot is 128 bytes = 32 u32s
    // ENT.ID is at u32 index 18 within each slot
    const slotOffset = slotIdx * 32 + 18;
    if (slotOffset < u32.length) {
      u32[slotOffset] = nodeId;
    }
  }
}
