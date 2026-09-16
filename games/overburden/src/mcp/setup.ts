// ============================================================================
// Overburden — renderer-side MCP automation harness
//
// Standard tools (capture_screenshot, dispatch_key, wait_for_condition,
// set_test_state, get_player_state, get_world_state, get_ui_state, DOM
// inspection) come from createStandardAutomationTools() in @downdraft/app.
// This file keeps only overburden-specific tools:
//   - inject_input / clear_injected_input / dispatch_click: custom input
//     model (mutates BlockheadsInputState directly, hotbar slots,
//     mousedown+mouseup+click trio on the canvas)
//   - get_inventory / craft / give_item: inventory + crafting via worker RPC
//   - queue_task / get_tasks / clear_tasks: autonomous blockhead task queue
//   - spawn_blockhead / set_active_blockhead / get_all_players / use_item /
//     set_character_gender: multi-blockhead management
// ============================================================================

import {
    createMcpHarness,
    createStandardAutomationTools,
    errorResult,
    jsonResult,
    type McpToolRegistration,
} from "@downdraft/app/renderer";
import type { BlockheadsRenderer } from "../renderer/blockheads-renderer";
import type { BlockheadsInputState } from "../renderer/input-handler";
import { getItemDef } from "../shared/items";
import { useGameStore } from "../stores/game-store";

// --- Key name resolution ---
const KEY_MAP: Record<string, keyof BlockheadsInputState> = {
  "A": "left", "a": "left", "ARROWLEFT": "left", "ArrowLeft": "left",
  "D": "right", "d": "right", "ARROWRIGHT": "right", "ArrowRight": "right",
  "W": "up", "w": "up", "ARROWUP": "up", "ArrowUp": "up",
  "S": "down", "s": "down", "ARROWDOWN": "down", "ArrowDown": "down",
  "SPACE": "jump", "Space": "jump", " ": "jump",
};

function resolveKeys(keys: (string | number)[]): (keyof BlockheadsInputState)[] {
  const resolved: (keyof BlockheadsInputState)[] = [];
  for (const k of keys) {
    const upper = String(k).toUpperCase();
    const mapped = KEY_MAP[upper] ?? KEY_MAP[String(k)];
    if (mapped) resolved.push(mapped);
  }
  return resolved;
}

// --- State readers ---
function readPlayer(renderer: BlockheadsRenderer, index: number = 0): Record<string, unknown> | null {
  const reader = renderer.getSimReader();
  if (!reader) return null;
  const count = reader.getBlockheadCount();
  if (index >= count) return null;
  const bh = reader.getBlockhead(index);
  return {
    index,
    x: bh[0],
    y: bh[1],
    vx: bh[2],
    vy: bh[3],
    facing: bh[4],
    onGround: bh[5] !== 0,
    animFrame: bh[6],
    health: bh[7],
    hunger: bh[8],
    energy: bh[9],
    air: bh[10],
    happiness: bh[11],
    environment: bh[12],
    animState: bh[13],
    id: bh[14],
  };
}

async function readWorld(renderer: BlockheadsRenderer): Promise<Record<string, unknown> | null> {
  const reader = renderer.getSimReader();
  if (!reader) return null;
  const host = renderer.getWorkerHost();
  let stats: { loadedChunks: number; activeChunks: number; tick: number } | null = null;
  if (host) {
    try {
      stats = await host.getWorldStats();
    } catch {
      stats = null;
    }
  }
  return {
    tick: reader.getTick(),
    originCx: reader.getOriginCx(),
    originCy: reader.getOriginCy(),
    blockheadCount: reader.getBlockheadCount(),
    daylight: reader.getDaylight(),
    mineX: reader.getMineX(),
    mineY: reader.getMineY(),
    mineDamage: reader.getMineDamage(),
    loadedChunks: stats?.loadedChunks ?? 0,
    activeChunks: stats?.activeChunks ?? 0,
  };
}

function createGameTools(ctx: {
  renderer: () => BlockheadsRenderer | null;
}): McpToolRegistration[] {
  return [
    // --- inject_input ---
    {
      def: {
        name: "inject_input",
        description: "Inject keyboard/mouse input for a number of sim ticks. Keys are held for the specified duration, then released. Useful for automation tests.",
        inputSchema: {
          type: "object",
          properties: {
            keys: {
              type: "array",
              items: { type: "string" },
              description: "Key names to hold (e.g. ['W','A','SPACE','D']). Maps to movement: W=up, S=down, A=left, D=right, SPACE=jump.",
              default: [],
            },
            leftMouse: { type: "boolean", default: false, description: "Hold left mouse button (mining — auto-targets foreground if present, background if foreground is air)" },
            rightMouse: { type: "boolean", default: false, description: "Hold right mouse button (placing)" },
            selectedSlot: { type: "number", description: "Hotbar slot 0-8 to select for placing" },
            frames: { type: "number", description: "Number of sim ticks to hold the input (sim runs at 30tps)", default: 1 },
          },
        },
      },
      handler: (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const input = renderer.getInput();
        if (!input) return errorResult("Input handler not initialized");

        const keys = resolveKeys((params.keys as (string | number)[]) ?? []);
        const leftMouse = !!params.leftMouse;
        const rightMouse = !!params.rightMouse;
        const selectedSlot = params.selectedSlot as number | undefined;
        const frames = Math.max(1, Math.floor((params.frames as number) ?? 1));

        // Set keys
        for (const k of keys) {
          (input[k] as boolean) = true;
        }
        input.mouseDown = leftMouse;
        input.mouseRight = rightMouse;
        if (selectedSlot !== undefined && selectedSlot >= 0 && selectedSlot <= 8) {
          input.selectedSlot = selectedSlot;
        }

        // Schedule clear after frames ticks (30tps → 33.3ms per tick)
        const holdMs = frames * (1000 / 30);
        setTimeout(() => {
          for (const k of keys) {
            (input[k] as boolean) = false;
          }
          input.mouseDown = false;
          input.mouseRight = false;
        }, holdMs);

        return jsonResult({ injected: true, frames, holdMs, keys, leftMouse, rightMouse });
      },
    },

    // --- clear_injected_input ---
    {
      def: {
        name: "clear_injected_input",
        description: "Release all currently held keys and mouse buttons from inject_input.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const input = renderer.getInput();
        if (!input) return errorResult("Input handler not initialized");
        input.left = false;
        input.right = false;
        input.up = false;
        input.down = false;
        input.jump = false;
        input.noclip = false;
        input.mouseDown = false;
        input.mouseRight = false;
        return jsonResult({ cleared: true });
      },
    },

    // --- dispatch_click ---
    {
      def: {
        name: "dispatch_click",
        description: "Fire a real DOM mouse click event at screen coordinates. Useful for clicking UI elements like craft recipe buttons.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "Screen X coordinate (CSS pixels)" },
            y: { type: "number", description: "Screen Y coordinate (CSS pixels)" },
            button: { type: "number", default: 0, description: "0=left, 2=right" },
          },
          required: ["x", "y"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const x = params.x as number;
        const y = params.y as number;
        const button = (params.button as number) ?? 0;
        const canvas = ctx.renderer()?.getCanvas();
        const target = canvas ?? document.body;
        const rect = target.getBoundingClientRect();
        const clientX = rect.left + x;
        const clientY = rect.top + y;
        const down = new MouseEvent("mousedown", { clientX, clientY, button, bubbles: true, cancelable: true });
        const up = new MouseEvent("mouseup", { clientX, clientY, button, bubbles: true, cancelable: true });
        const click = new MouseEvent("click", { clientX, clientY, button, bubbles: true, cancelable: true });
        target.dispatchEvent(down);
        target.dispatchEvent(up);
        target.dispatchEvent(click);
        return jsonResult({ dispatched: true, x, y, button });
      },
    },

    // --- get_inventory ---
    {
      def: {
        name: "get_inventory",
        description: "Read the blockhead's inventory as a fixed-length slot array (54 slots; null = empty slot; slots 0-8 are the hotbar). Each non-null entry is { itemId, count }.",
        inputSchema: {
          type: "object",
          properties: {
            playerIndex: { type: "number", default: 0 },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const explicitIdx = params.playerIndex as number | undefined;
        const idx = explicitIdx !== undefined ? explicitIdx : renderer.getActiveBhIndex();
        const inv = await host.getInventory(idx);
        return jsonResult({ inventory: inv });
      },
    },

    // --- craft ---
    {
      def: {
        name: "craft",
        description: "Craft an item using a recipe. Hand recipes are instant. Station recipes require stationAx/stationAy (active grid coords of the station block) or the blockhead being adjacent to the right station. Returns { ok, jobId? }.",
        inputSchema: {
          type: "object",
          properties: {
            recipeId: { type: "string", description: "Recipe ID (e.g. 'planks_from_wood', 'workbench_item', 'copper_ingot')" },
            stationAx: { type: "number", description: "Station active-grid X (for station recipes). If omitted, searches for adjacent station.", default: -1 },
            stationAy: { type: "number", description: "Station active-grid Y (for station recipes). If omitted, searches for adjacent station.", default: -1 },
            playerIndex: { type: "number", default: 0 },
          },
          required: ["recipeId"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.craft(
          params.recipeId as string,
          (params.stationAx as number) ?? -1,
          (params.stationAy as number) ?? -1,
          (params.playerIndex as number) ?? renderer.getActiveBhIndex(),
        );
        return jsonResult(result);
      },
    },

    // --- get_craft_queue ---
    {
      def: {
        name: "get_craft_queue",
        description: "Read the craft queue + fuel state for a station block at the given active-grid coords. Returns { fuel, activeJob, queue }.",
        inputSchema: {
          type: "object",
          properties: {
            stationAx: { type: "number", description: "Station active-grid X coordinate" },
            stationAy: { type: "number", description: "Station active-grid Y coordinate" },
          },
          required: ["stationAx", "stationAy"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.getCraftQueue(
          params.stationAx as number,
          params.stationAy as number,
        );
        return jsonResult(result);
      },
    },

    // --- add_fuel ---
    {
      def: {
        name: "add_fuel",
        description: "Add fuel to a station (campfire, kiln, furnace, metalwork bench). Consumes the item from the blockhead's inventory.",
        inputSchema: {
          type: "object",
          properties: {
            stationAx: { type: "number", description: "Station active-grid X coordinate" },
            stationAy: { type: "number", description: "Station active-grid Y coordinate" },
            itemId: { type: "string", description: "Fuel item ID (e.g. 'wood', 'coal', 'stick', 'charcoal')" },
            count: { type: "number", default: 1 },
            playerIndex: { type: "number", default: 0 },
          },
          required: ["stationAx", "stationAy", "itemId"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.addFuel(
          params.stationAx as number,
          params.stationAy as number,
          params.itemId as string,
          (params.count as number) ?? 1,
          (params.playerIndex as number) ?? 0,
        );
        return jsonResult(result);
      },
    },

    // --- rush_craft ---
    {
      def: {
        name: "rush_craft",
        description: "Rush a craft job to instant completion using crystals. Cost = ceil(remainingSeconds / 20) crystals.",
        inputSchema: {
          type: "object",
          properties: {
            stationAx: { type: "number", description: "Station active-grid X coordinate" },
            stationAy: { type: "number", description: "Station active-grid Y coordinate" },
            jobId: { type: "number", description: "Job ID to rush" },
            playerIndex: { type: "number", default: 0 },
          },
          required: ["stationAx", "stationAy", "jobId"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.rushCraft(
          params.stationAx as number,
          params.stationAy as number,
          params.jobId as number,
          (params.playerIndex as number) ?? 0,
        );
        return jsonResult(result);
      },
    },

    // --- abort_craft ---
    {
      def: {
        name: "abort_craft",
        description: "Abort a craft job. If the job was active, returns unused ingredients (fuel already burned is lost). If queued, just removes it.",
        inputSchema: {
          type: "object",
          properties: {
            stationAx: { type: "number", description: "Station active-grid X coordinate" },
            stationAy: { type: "number", description: "Station active-grid Y coordinate" },
            jobId: { type: "number", description: "Job ID to abort" },
          },
          required: ["stationAx", "stationAy", "jobId"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.abortCraft(
          params.stationAx as number,
          params.stationAy as number,
          params.jobId as number,
        );
        return jsonResult(result);
      },
    },

    // --- give_item ---
    {
      def: {
        name: "give_item",
        description: "Give an item to the blockhead (creative/testing mode). Respects maxStack — overflow is discarded. If count is omitted, grants the item's full maxStack (a complete stack).",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Item ID (e.g. 'dirt', 'wood', 'torch', 'stone_pickaxe')" },
            count: { type: "number", description: "Amount to give. Defaults to the item's maxStack (full stack)." },
            playerIndex: { type: "number", default: 0 },
          },
          required: ["itemId"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const itemId = params.itemId as string;
        const count = (params.count as number) ?? getItemDef(itemId)?.maxStack ?? 1;
        const result = await host.giveItem(
          itemId,
          count,
          (params.playerIndex as number) ?? renderer.getActiveBhIndex(),
        );
        return jsonResult(result);
      },
    },

    // --- queue_task ---
    {
      def: {
        name: "queue_task",
        description: "Queue an autonomous task for the blockhead to execute. Tasks: MOVE_TO (walk to world coords), MINE_BLOCK (walk adjacent + mine), PLACE_BLOCK (walk adjacent + place), CHOP_TREE (walk adjacent + chop wood), CRAFT_AT (walk to station + queue craft), COLLECT_ITEM (walk to location), EAT (consume food), SLEEP (walk to bed + sleep). Uses A* pathfinding with cylinder wrap.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["MOVE_TO", "MINE_BLOCK", "PLACE_BLOCK", "CHOP_TREE", "CRAFT_AT", "COLLECT_ITEM", "EAT", "SLEEP"] },
            targetX: { type: "number", description: "Target world X coordinate (block coords)" },
            targetY: { type: "number", description: "Target world Y coordinate (block coords)" },
            blockId: { type: "number", description: "Block ID to place (for PLACE_BLOCK)", default: 0 },
            recipeId: { type: "string", description: "Recipe ID (for CRAFT_AT)" },
            stationAx: { type: "number", description: "Station active-grid X (for CRAFT_AT)" },
            stationAy: { type: "number", description: "Station active-grid Y (for CRAFT_AT)" },
            itemId: { type: "string", description: "Item ID (for EAT, COLLECT_ITEM)" },
            playerIndex: { type: "number", default: 0 },
          },
          required: ["type"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const opts: Record<string, unknown> = {};
        if (params.targetX !== undefined) opts.targetX = params.targetX;
        if (params.targetY !== undefined) opts.targetY = params.targetY;
        if (params.blockId !== undefined) opts.blockId = params.blockId;
        if (params.recipeId !== undefined) opts.recipeId = params.recipeId;
        if (params.stationAx !== undefined) opts.stationAx = params.stationAx;
        if (params.stationAy !== undefined) opts.stationAy = params.stationAy;
        if (params.itemId !== undefined) opts.itemId = params.itemId;
        const result = await host.queueTask(
          params.type as "MOVE_TO" | "MINE_BLOCK" | "PLACE_BLOCK" | "CHOP_TREE" | "CRAFT_AT" | "COLLECT_ITEM" | "EAT" | "SLEEP",
          opts,
          (params.playerIndex as number) ?? renderer.getActiveBhIndex(),
        );
        return jsonResult(result);
      },
    },

    // --- get_tasks ---
    {
      def: {
        name: "get_tasks",
        description: "Read the blockhead's current task queue (pending + active tasks with status).",
        inputSchema: {
          type: "object",
          properties: {
            playerIndex: { type: "number", default: 0 },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const tasks = await host.getTasks((params.playerIndex as number) ?? renderer.getActiveBhIndex());
        return jsonResult({ tasks });
      },
    },

    // --- clear_tasks ---
    {
      def: {
        name: "clear_tasks",
        description: "Clear the blockhead's task queue (cancels all pending + active tasks).",
        inputSchema: {
          type: "object",
          properties: {
            playerIndex: { type: "number", default: 0 },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.clearTasks((params.playerIndex as number) ?? renderer.getActiveBhIndex());
        return jsonResult(result);
      },
    },

    // --- spawn_blockhead ---
    {
      def: {
        name: "spawn_blockhead",
        description: "Spawn a new blockhead (free — creative/MCP). If x/y omitted, spawns near the active blockhead. Returns the new blockhead's index + id.",
        inputSchema: {
          type: "object",
          properties: {
            x: { type: "number", description: "World X coordinate to spawn near (optional — defaults to active blockhead's position)" },
            y: { type: "number", description: "World Y coordinate to spawn near (optional)" },
            gender: { type: "string", enum: ["male", "female"], description: "Character gender (optional, default male)" },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        try {
          const result = await host.spawnBlockhead(
            params.x as number | undefined,
            params.y as number | undefined,
            params.gender as string | undefined,
          );
          return jsonResult(result);
        } catch (e) {
          return errorResult(`spawn_blockhead failed: ${(e as Error).message}`);
        }
      },
    },

    // --- set_active_blockhead ---
    {
      def: {
        name: "set_active_blockhead",
        description: "Set which blockhead receives direct WASD/mouse input (0-indexed). Use get_all_players to see available indices.",
        inputSchema: {
          type: "object",
          properties: {
            index: { type: "number", description: "Blockhead index (0-based)" },
          },
          required: ["index"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const idx = params.index as number;
        renderer.setActiveBhIndex(idx);
        const result = await host.setActiveBhIndex(idx);
        return jsonResult(result);
      },
    },

    // --- get_active_blockhead ---
    {
      def: {
        name: "get_active_blockhead",
        description: "Get the index of the currently active blockhead (the one receiving direct WASD/mouse input).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const idx = await host.getActiveBhIndex();
        return jsonResult({ activeBhIndex: idx });
      },
    },

    // --- get_all_players ---
    {
      def: {
        name: "get_all_players",
        description: "Get a roster snapshot of all blockheads (id, index, position, stats, gender). Use to find available blockhead indices for set_active_blockhead.",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const roster = await host.getBlockheads();
        return jsonResult({ blockheads: roster });
      },
    },

    // --- use_item ---
    {
      def: {
        name: "use_item",
        description: "Use an item from a blockhead's inventory (e.g. spawn_egg to spawn a new blockhead). Currently only spawn_egg has a use action.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Item ID to use (e.g. 'spawn_egg')" },
            playerIndex: { type: "number", default: 0, description: "Blockhead index whose inventory to use from" },
          },
          required: ["itemId"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const itemId = params.itemId as string;
        // Default to the active blockhead if playerIndex not specified.
        const explicitIdx = params.playerIndex as number | undefined;
        const bhIndex = explicitIdx !== undefined ? explicitIdx : renderer.getActiveBhIndex();
        const result = await host.useItem(itemId, bhIndex);
        return jsonResult(result);
      },
    },

    // --- set_character_gender ---
    {
      def: {
        name: "set_character_gender",
        description: "Switch the player character model between male and female.",
        inputSchema: {
          type: "object",
          properties: {
            gender: { type: "string", enum: ["male", "female"], description: "Character gender to switch to" },
          },
          required: ["gender"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const gender = params.gender as string;
        if (gender !== "male" && gender !== "female") {
          return errorResult("Invalid gender: must be 'male' or 'female'");
        }
        renderer.setCharacterGender(gender);
        return jsonResult({ ok: true, gender: renderer.getCharacterGender() });
      },
    },
  ];
}

export function setupBlockheadsMcp(renderer: () => BlockheadsRenderer | null): void {
  createMcpHarness({
    serverName: "downdraft-overburden-automation",
    tools: createStandardAutomationTools({
      canvas: () => renderer()?.getCanvas() ?? null,
      isRunning: () => renderer()?.isRunning() ?? false,
      renderOneFrame: () => renderer()?.renderOneFrame(),
      // Overburden's historical default: canvas-only unless fullPage=true.
      fullPageDefault: false,
      getPlayerState: (i) => {
        const r = renderer();
        return r ? readPlayer(r, i ?? r.getActiveBhIndex()) : null;
      },
      getWorldState: () => {
        const r = renderer();
        return r ? readWorld(r) : null;
      },
      getUiState: () => useGameStore.getState(),
      setTestState: async (params) => {
        const host = renderer()?.getWorkerHost();
        if (!host) return;
        if (params.simSpeed !== undefined) host.setSpeed(params.simSpeed as number);
        if (params.pause === true) host.pause();
        if (params.resume === true) host.resume();
      },
      pauseRendering: () => renderer()?.stop(),
      resumeRendering: () => renderer()?.start(),
      // inject_input / clear_injected_input / dispatch_click stay game-side:
      // overburden's input model mutates a plain state object (not the shared
      // StandardInputInjector frame queue) and its click dispatch fires
      // mousedown+mouseup+click on the canvas (mining/placing need mousedown).
      exclude: ["inject_input", "clear_injected_input", "dispatch_click"],
      extraTools: createGameTools({ renderer }),
    }),
  });
}
