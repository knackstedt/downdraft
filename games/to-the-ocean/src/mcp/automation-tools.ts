// ============================================================================
// To The Ocean — MCP automation tools
// Tools for driving the game from an MCP client: input injection, state reads,
// screenshots, and wait-conditions. These operate on the renderer-side state
// (SharedArrayBuffers, WebGPU canvas) rather than the generic EngineContext.
// ============================================================================

import { type InjectedInputFrame } from "../engine/renderer-input-handler";
import type { SimWebWorker } from "../engine/sim-web-worker";
import type { WebGPURenderer } from "../engine/webgpu-renderer";
import { KEY } from "../shared/input-buffer";
import { PLR, PLR_FLAG } from "../shared/sim-buffer";
import type { ToolRegistration } from "./mcp-types";
import { errorResult, jsonResult } from "./mcp-types";

export interface AutomationContext {
  renderer: () => WebGPURenderer | null;
  worker: () => SimWebWorker | null;
}

const KEY_NAME_MAP: Record<string, number> = {
  W: KEY.W, A: KEY.A, S: KEY.S, D: KEY.D,
  Q: KEY.Q, E: KEY.E, R: KEY.R, F: KEY.F,
  SHIFT: KEY.SHIFT, CTRL: KEY.CTRL, ALT: KEY.ALT, TAB: KEY.TAB,
  SPACE: KEY.SPACE, ENTER: KEY.ENTER, ESC: KEY.ESC,
  ONE: KEY.ONE, TWO: KEY.TWO, THREE: KEY.THREE, FOUR: KEY.FOUR,
  FIVE: KEY.FIVE, SIX: KEY.SIX, SEVEN: KEY.SEVEN, EIGHT: KEY.EIGHT,
  NINE: KEY.NINE, ZERO: KEY.ZERO,
  I: KEY.I, B: KEY.B, C: KEY.C, M: KEY.M, P: KEY.P,
  T: KEY.T, V: KEY.V, Z: KEY.Z, X: KEY.X,
  UP: KEY.UP, DOWN: KEY.DOWN, LEFT: KEY.LEFT, RIGHT: KEY.RIGHT,
  F5: KEY.F5, F8: KEY.F8,
};

function resolveKeys(keys: (string | number)[]): Set<number> {
  const out = new Set<number>();
  for (const k of keys) {
    if (typeof k === "number") {
      out.add(k);
    } else {
      const code = KEY_NAME_MAP[k.toUpperCase()];
      if (code !== undefined) out.add(code);
    }
  }
  return out;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1];
      resolve(base64 ?? "");
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function readPlayer(renderer: WebGPURenderer, playerIndex: number) {
  const reader = renderer.getSimReader();
  if (!reader?.isValid()) return null;
  const count = reader.getPlayerCount();
  if (playerIndex < 0 || playerIndex >= count) return null;
  const slot = reader.getPlayerSlot(playerIndex);
  if (!slot) return null;
  const flags = slot.u32[PLR.FLAGS];
  return {
    position: [slot.f32[PLR.POS_X], slot.f32[PLR.POS_Y], slot.f32[PLR.POS_Z]],
    heading: slot.f32[PLR.HEADING],
    pitch: slot.f32[PLR.PITCH],
    cameraMode: slot.f32[PLR.CAMERA_MODE],
    health: slot.f32[PLR.HEALTH],
    maxHealth: slot.f32[PLR.MAX_HEALTH],
    hunger: slot.f32[PLR.HUNGER],
    thirst: slot.f32[PLR.THIRST],
    oxygen: slot.f32[PLR.OXYGEN],
    gold: slot.f32[PLR.GOLD],
    flags: {
      dead: !!(flags & PLR_FLAG.DEAD),
      swimming: !!(flags & PLR_FLAG.SWIMMING),
      piloting: !!(flags & PLR_FLAG.PILOTING),
      onboard: !!(flags & PLR_FLAG.ONBOARD),
      grounded: !!(flags & PLR_FLAG.GROUNDED),
      noclip: !!(flags & PLR_FLAG.NOCLIP),
    },
  };
}

function readWorld(renderer: WebGPURenderer) {
  const reader = renderer.getSimReader();
  if (!reader?.isValid()) return null;
  return {
    tick: reader.getTick(),
    sequence: reader.getSequence(),
    entityCount: reader.getEntityCount(),
    playerCount: reader.getPlayerCount(),
    activePlayers: reader.getActivePlayers(),
    timeOfDay: reader.getTimeOfDay(),
    weatherType: reader.getWeatherType(),
    weatherIntensity: reader.getWeatherIntensity(),
    windSpeed: reader.getWindSpeed(),
    windDir: reader.getWindDir(),
    visibility: reader.getVisibility(),
    ambientTemp: reader.getAmbientTemp(),
    gamemode: reader.getGamemode(),
    physicsInitialized: reader.getPhysicsInitialized(),
    physicsFailed: reader.getPhysicsFailed(),
    physicsBodyCount: reader.getPhysicsBodyCount(),
    physicsTickCount: reader.getPhysicsTickCount(),
  };
}

export function createAutomationTools(ctx: AutomationContext): ToolRegistration[] {
  return [
    {
      def: {
        name: "inject_input",
        description: "Inject keyboard/mouse input for a number of frames. Useful for automation tests when no real user is interacting with the game.",
        inputSchema: {
          type: "object",
          properties: {
            playerIndex: { type: "number", description: "Player slot index", default: 0 },
            keys: {
              type: "array",
              items: { type: "string" },
              description: "Key names to hold (e.g. ['W','A','SPACE']) or keyCodes if numbers",
              default: [],
            },
            leftMouse: { type: "boolean", default: false },
            rightMouse: { type: "boolean", default: false },
            mouseDx: { type: "number", default: 0 },
            mouseDy: { type: "number", default: 0 },
            wheel: { type: "number", default: 0 },
            frames: { type: "number", description: "Number of frames to hold the input", default: 1 },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const inputHandler = renderer.getInputHandler();
        const frames = Math.max(1, Math.floor((params.frames as number) ?? 1));
        const frame: InjectedInputFrame = {
          keys: resolveKeys((params.keys as (string | number)[]) ?? []),
          leftMouse: !!params.leftMouse,
          rightMouse: !!params.rightMouse,
          mouseDx: (params.mouseDx as number) ?? 0,
          mouseDy: (params.mouseDy as number) ?? 0,
          wheel: (params.wheel as number) ?? 0,
          framesRemaining: frames,
        };
        inputHandler.injectInput(frame);
        return jsonResult({ injected: true, frames, playerIndex: (params.playerIndex as number) ?? 0 });
      },
    },

    {
      def: {
        name: "get_player_state",
        description: "Read the current state of a player from the simulation SharedArrayBuffer.",
        inputSchema: {
          type: "object",
          properties: {
            playerIndex: { type: "number", default: 0 },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const playerIndex = (params.playerIndex as number) ?? 0;
        const state = readPlayer(renderer, playerIndex);
        if (!state) return errorResult(`Player ${playerIndex} not available`);
        return jsonResult(state);
      },
    },

    {
      def: {
        name: "get_world_state",
        description: "Read global simulation state (tick, entity count, weather, etc.).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const state = readWorld(renderer);
        if (!state) return errorResult("World state not available");
        return jsonResult(state);
      },
    },

    {
      def: {
        name: "wait_for_condition",
        description: "Poll until a condition on player/world state is met or a timeout occurs. Conditions are simple expressions evaluated against the state object.",
        inputSchema: {
          type: "object",
          properties: {
            condition: {
              type: "string",
              description: "JavaScript predicate expression. Available variables: player (object), world (object), tick (number). Example: 'player.position[1] < -2'",
            },
            timeoutMs: { type: "number", default: 5000, description: "Maximum time to wait in milliseconds" },
            intervalMs: { type: "number", default: 50, description: "Polling interval" },
          },
          required: ["condition"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const condition = params.condition as string;
        const timeoutMs = (params.timeoutMs as number) ?? 5000;
        const intervalMs = (params.intervalMs as number) ?? 50;
        const start = performance.now();

        return new Promise((resolve) => {
          const check = () => {
            const player = readPlayer(renderer, 0) ?? null;
            const world = readWorld(renderer) ?? null;
            const tick = world?.tick ?? 0;
            try {
              // eslint-disable-next-line no-new-func
              const fn = new Function("player", "world", "tick", `"use strict"; return (${condition});`);
              if (fn(player, world, tick)) {
                resolve(jsonResult({ satisfied: true, elapsedMs: performance.now() - start, player, world }));
                return;
              }
            } catch (e) {
              resolve(errorResult(`Condition evaluation error: ${(e as Error).message}`));
              return;
            }
            if (performance.now() - start > timeoutMs) {
              resolve(errorResult(`Timeout waiting for condition: ${condition}`));
              return;
            }
            setTimeout(check, intervalMs);
          };
          check();
        });
      },
    },

    {
      def: {
        name: "capture_screenshot",
        description: "Capture the current WebGPU canvas as a PNG image. Returns the image inline as base64.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const blob = await renderer.captureScreenshot();
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width: renderer.getCanvasWidth(), height: renderer.getCanvasHeight() }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },

    {
      def: {
        name: "set_test_state",
        description: "Set deterministic game state for tests: weather, time of day, respawn player, simulation speed, render loop control.",
        inputSchema: {
          type: "object",
          properties: {
            weatherType: { type: "number", description: "Weather enum value (0=Clear, 1=Rain, 2=Storm, ...)" },
            timeOfDay: { type: "number", description: "Normalized time 0..1" },
            respawn: { type: "boolean", default: false },
            simSpeed: { type: "number" },
            pauseRendering: { type: "boolean", description: "Pause the continuous render loop to save CPU. Screenshot capture still works (renders on demand)." },
            resumeRendering: { type: "boolean", description: "Resume the continuous render loop." },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const worker = ctx.worker();
        if (!worker) return errorResult("Simulation worker not initialized");
        const renderer = ctx.renderer();
        if (params.weatherType !== undefined) worker.setWeather(params.weatherType as number);
        if (params.timeOfDay !== undefined) worker.setTimeOfDay(params.timeOfDay as number);
        if (params.simSpeed !== undefined) worker.setSimSpeed(params.simSpeed as number);
        if (params.respawn) worker.respawnPlayer(0);
        if (params.pauseRendering && renderer) renderer.stop();
        if (params.resumeRendering && renderer) renderer.start();
        return jsonResult({ applied: true, params });
      },
    },

    {
      def: {
        name: "clear_injected_input",
        description: "Clear any pending injected input frames.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        renderer.getInputHandler().clearInjectedInput();
        return jsonResult({ cleared: true });
      },
    },
  ];
}
