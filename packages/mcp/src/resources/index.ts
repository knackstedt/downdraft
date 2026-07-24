import type { EngineContext } from "../engine-context.ts";
import type { ResourceRegistration, MCPResourceResult } from "../types.ts";
import { jsonResult } from "../types.ts";

function resourceJSON(uri: string, data: unknown): MCPResourceResult {
  return {
    contents: [{
      uri,
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2),
    }],
  };
}

export function createResources(ctx: EngineContext): ResourceRegistration[] {
  const resources: ResourceRegistration[] = [

    {
      def: {
        uri: "downdraft://scene-tree",
        name: "Scene Tree",
        description: "Live scene hierarchy (parent/child tree)",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const entities = ctx.getAllAliveEntities();
        const tree: Array<{ entity: string; parent: string; children: string[]; components: string[] }> = [];

        for (const e of entities) {
          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          const compNames = arch ? [...arch.columns.keys()].map((id) => ctx.getComponentNameById(id)) : [];
          tree.push({
            entity: ctx.getEntityKey(e),
            parent: ctx.getEntityKey(ctx.hierarchy.getParent(e)),
            children: ctx.hierarchy.getChildren(e).map((c) => ctx.getEntityKey(c)),
            components: compNames,
          });
        }

        return resourceJSON(uri, { scene: ctx.scene.name, entities: tree });
      },
    },

    {
      def: {
        uri: "downdraft://entity-state",
        name: "Entity State",
        description: "Entity component dump (all entities, all components)",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const entities = ctx.getAllAliveEntities();
        const dump: Record<string, unknown> = {};

        for (const e of entities) {
          const key = ctx.getEntityKey(e);
          const arch = ctx.ecsWorld.getArchetypeForEntity(e);
          const components: Record<string, unknown> = {};

          if (arch) {
            for (const [cid, col] of arch.columns) {
              const row = arch.entities.findIndex(
                (en) => en.index === e.index && en.generation === e.generation,
              );
              if (row >= 0) {
                components[ctx.getComponentNameById(cid)] = col[row];
              }
            }
          }

          dump[key] = {
            components,
            mesh: ctx.entityMeshes.get(key) ?? null,
            material: ctx.entityMaterials.get(key) ?? null,
          };
        }

        return resourceJSON(uri, dump);
      },
    },

    {
      def: {
        uri: "downdraft://performance",
        name: "Performance Metrics",
        description: "Frame timings, system timings, and entity count",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const snap = ctx.telemetryReporter.getSnapshot();
        return resourceJSON(uri, {
          tick: ctx.ecsWorld.tick,
          entityCount: ctx.ecsWorld.entityCount(),
          frameTime: snap.averageFrameTime,
          p95FrameTime: snap.p95FrameTime,
          p99FrameTime: snap.p99FrameTime,
          systemTimings: snap.systemTimings,
          frameTimeHistory: snap.frameTimes,
        });
      },
    },

    {
      def: {
        uri: "downdraft://gpu-info",
        name: "GPU Info",
        description: "Adapter info, buffer sizes, texture memory",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, {
          adapter: "WGPU adapter info requires running render loop",
          buffers: { totalSize: 0, count: 0 },
          textures: { totalSize: 0, count: 0 },
          meshes: ctx.meshes.size,
          materials: ctx.materialLibrary.list().length,
        });
      },
    },

    {
      def: {
        uri: "downdraft://asset-list",
        name: "Asset Inventory",
        description: "All loaded assets",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, {
          assets: ctx.assetManager.list(),
          meshes: [...ctx.meshes.keys()],
          materials: ctx.materialLibrary.list().map((m) => m.name),
        });
      },
    },

    {
      def: {
        uri: "downdraft://checkpoint-list",
        name: "Checkpoint List",
        description: "Available checkpoints + undo/redo history",
        mimeType: "application/json",
      },
      handler: (uri) => {
        const checkpoints = ctx.checkpointManager.list().map((cp) => ({
          name: cp.name,
          timestamp: cp.timestamp,
          entityCount: cp.entities.length,
        }));
        return resourceJSON(uri, { checkpoints });
      },
    },

    {
      def: {
        uri: "downdraft://crash-events",
        name: "Crash Events",
        description: "Sim-worker crash events and recovery status",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, {
          crashes: [],
          recoveryState: "idle",
          note: "No crash events recorded. Crash recovery requires a running sim worker.",
        });
      },
    },

    {
      def: {
        uri: "downdraft://telemetry",
        name: "Telemetry",
        description: "Per-thread GC, memory, CPU metrics",
        mimeType: "application/json",
      },
      handler: (uri) => {
        return resourceJSON(uri, ctx.telemetryReporter.getMCPFormat());
      },
    },

  ];

  return resources;
}
