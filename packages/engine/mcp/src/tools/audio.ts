import type { EngineContext } from "../engine-context";
import { createAudioListener, createAudioSource } from "../engine-context";
import type { ToolRegistration } from "../types";
import { errorResult, jsonResult } from "../types";

export function createAudioTools(ctx: EngineContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "add_audio_source",
        description: "Add an audio source to an entity with optional spatial positioning.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            asset: { type: "string", description: "Audio asset path" },
            spatial: { type: "boolean", description: "Whether this is a spatial (3D) source" },
            volume: { type: "number", description: "Volume (0-1)" },
            loop: { type: "boolean", description: "Loop the audio" },
          },
          required: ["entity", "asset"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        const spatial = (params.spatial as boolean) ?? false;
        const volume = (params.volume as number) ?? 1.0;
        const loop = (params.loop as boolean) ?? false;

        const sourceData = createAudioSource("-1", {
          spatial,
          volume,
          loop,
          autoPlay: false,
        });

        const cid = ctx.getComponentIdByName("AudioSource");
        ctx.ecsWorld.addComponent(entity, cid, sourceData);
        ctx.ecsWorld.flushCommands();

        ctx.audioSources.set(entityKey, sourceData);

        return jsonResult({
          entity: entityKey,
          asset: params.asset,
          spatial,
          volume,
          loop,
        });
      },
    },

    {
      def: {
        name: "set_audio_listener",
        description: "Set the audio listener to follow an entity or camera.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key to attach listener to" },
            followCamera: { type: "boolean", description: "Follow the camera (default: true)" },
          },
        },
      },
      handler: (params) => {
        const followCamera = (params.followCamera as boolean) ?? true;
        const entityKey = params.entity as string | undefined;

        if (entityKey) {
          const entity = ctx.parseEntityKey(entityKey);
          if (!entity || !ctx.isEntityAlive(entity)) {
            return errorResult(`Entity ${entityKey} not found or dead`);
          }

          const listenerData = createAudioListener({ active: true });
          const cid = ctx.getComponentIdByName("AudioListener");
          ctx.ecsWorld.addComponent(entity, cid, listenerData);
          ctx.ecsWorld.flushCommands();

          ctx.audioListeners.set(entityKey, listenerData);
        }

        return jsonResult({ followCamera, entity: entityKey ?? null });
      },
    },

  ];

  return tools;
}
