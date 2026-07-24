import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";

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

        return jsonResult({
          entity: entityKey,
          asset: params.asset,
          spatial: (params.spatial as boolean) ?? false,
          volume: (params.volume as number) ?? 1.0,
          loop: (params.loop as boolean) ?? false,
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
        return jsonResult({ followCamera, entity: params.entity ?? null });
      },
    },

  ];

  return tools;
}

export function createAnimationTools(ctx: EngineContext): ToolRegistration[] {
  const tools: ToolRegistration[] = [

    {
      def: {
        name: "play_animation",
        description: "Play an animation clip on an entity with a skeleton.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            clip: { type: "string", description: "Animation clip name" },
            speed: { type: "number", description: "Playback speed (default: 1.0)" },
            loop: { type: "boolean", description: "Loop the animation" },
            blendWeight: { type: "number", description: "Blend weight (0-1)" },
          },
          required: ["entity", "clip"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        const entity = ctx.parseEntityKey(entityKey);
        if (!entity || !ctx.isEntityAlive(entity)) {
          return errorResult(`Entity ${entityKey} not found or dead`);
        }

        return jsonResult({
          entity: entityKey,
          clip: params.clip,
          speed: (params.speed as number) ?? 1.0,
          loop: (params.loop as boolean) ?? true,
          blendWeight: (params.blendWeight as number) ?? 1.0,
        });
      },
    },

    {
      def: {
        name: "stop_animation",
        description: "Stop a playing animation on an entity.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            clip: { type: "string", description: "Animation clip name (optional, stops all if omitted)" },
          },
          required: ["entity"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        return jsonResult({ entity: entityKey, stopped: true, clip: params.clip ?? "all" });
      },
    },

    {
      def: {
        name: "set_animation_state",
        description: "Set the animation state machine to a named state.",
        inputSchema: {
          type: "object",
          properties: {
            entity: { type: "string", description: "Entity key" },
            state: { type: "string", description: "Target state name" },
            crossfade: { type: "number", description: "Crossfade duration in seconds" },
          },
          required: ["entity", "state"],
        },
      },
      handler: (params) => {
        const entityKey = params.entity as string;
        return jsonResult({
          entity: entityKey,
          state: params.state,
          crossfade: (params.crossfade as number) ?? 0.2,
        });
      },
    },

  ];

  return tools;
}
