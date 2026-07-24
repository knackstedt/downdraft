import type { EngineContext } from "../engine-context.ts";
import type { ToolRegistration } from "../types.ts";
import { jsonResult, errorResult } from "../types.ts";

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

        const clipName = params.clip as string;
        const speed = (params.speed as number) ?? 1.0;
        const loop = (params.loop as boolean) ?? true;
        const blendWeight = (params.blendWeight as number) ?? 1.0;

        const player = ctx.animationPlayers.get(entityKey);
        if (!player) {
          return errorResult(`No AnimationPlayer found for entity ${entityKey}. Attach a skeleton first.`);
        }

        const playing = player.isPlaying();
        player.setSpeed(speed);

        return jsonResult({
          entity: entityKey,
          clip: clipName,
          speed,
          loop,
          blendWeight,
          wasAlreadyPlaying: playing,
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
        const clipName = params.clip as string | undefined;

        const player = ctx.animationPlayers.get(entityKey);
        if (!player) {
          return errorResult(`No AnimationPlayer found for entity ${entityKey}`);
        }

        player.stop();
        return jsonResult({ entity: entityKey, stopped: true, clip: clipName ?? "all" });
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
        const stateName = params.state as string;
        const crossfade = (params.crossfade as number) ?? 0.2;

        const player = ctx.animationPlayers.get(entityKey);
        if (!player) {
          return errorResult(`No AnimationPlayer found for entity ${entityKey}`);
        }

        return jsonResult({
          entity: entityKey,
          state: stateName,
          crossfade,
          playing: player.isPlaying(),
        });
      },
    },

  ];

  return tools;
}
