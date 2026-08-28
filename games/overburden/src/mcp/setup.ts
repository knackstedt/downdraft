// ============================================================================
// Overburden — renderer-side MCP automation harness
//
// Minimal JSON-RPC handler wired to the main-process MCP HTTP proxy via
// the Electron preload bridge. Exposes automation tools for e2e tests:
//   - capture_screenshot: composite WebGPU canvas + DOM overlay
//   - inject_input / clear_injected_input: hold keys/mouse for N frames
//   - dispatch_key / dispatch_click: fire real DOM events
//   - get_player_state: read blockhead state from SAB
//   - get_world_state: read world stats + block at coords
//   - get_inventory / craft / give_item: inventory + crafting via worker RPC
//   - queue_task / get_tasks / clear_tasks: autonomous blockhead task queue
//   - wait_for_condition: poll a JS predicate against player/world state
//   - set_test_state: sim speed, pause/resume, render control
// ============================================================================

import { blobToBase64, compositeScreenshot, createMcpHarness, downdraft } from "@downdraft/app/renderer";
import type { BlockheadsRenderer } from "../renderer/blockheads-renderer";
import type { BlockheadsInputState } from "../renderer/input-handler";
import { getItemDef } from "../shared/items";

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ToolRegistration {
  def: ToolDef;
  handler: (params: Record<string, unknown>) => Promise<unknown> | unknown;
}

interface McpRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type McpResponse = { id: number; result?: unknown; error?: { code: number; message: string } };

function errorResult(msg: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: "text", text: msg }], isError: true };
}

function jsonResult(data: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

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

function createAutomationTools(ctx: {
  renderer: () => BlockheadsRenderer | null;
}): ToolRegistration[] {
  return [
    // --- capture_screenshot ---
    {
      def: {
        name: "capture_screenshot",
        description:
          "Capture the current frame as a PNG image. By default composites the WebGPU canvas with the DOM/React overlay. Set fullPage=false to capture only the WebGPU canvas. Returns the image inline as base64.",
        inputSchema: {
          type: "object",
          properties: {
            fullPage: {
              type: "boolean",
              default: true,
              description: "If true, composite the WebGPU canvas + DOM overlay. If false, capture only the WebGPU canvas.",
            },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const fullPage = params.fullPage === true;
        const canvas = renderer.getCanvas();
        const width = canvas.width;
        const height = canvas.height;

        if (fullPage) {
          const bridge = downdraft as unknown as { capturePage?: () => Promise<ArrayBuffer> };
          if (typeof bridge?.capturePage === "function") {
            try {
              const overlayPng = await bridge.capturePage();
              if (overlayPng && overlayPng.byteLength > 0) {
                const blob = await compositeScreenshot(canvas, overlayPng, width, height);
                if (blob) {
                  const base64 = await blobToBase64(blob);
                  return {
                    content: [
                      { type: "text", text: JSON.stringify({ width, height, fullPage: true }, null, 2) },
                      { type: "image", data: base64, mimeType: "image/png" },
                    ],
                  };
                }
              }
            } catch (e) {
              console.warn(`[MCP] Composite screenshot failed, falling back to canvas-only: ${(e as Error).message}`);
            }
          }
        }

        const blob = await renderer.captureScreenshot();
        if (!blob) return errorResult("Screenshot capture failed");
        const base64 = await blobToBase64(blob);
        return {
          content: [
            { type: "text", text: JSON.stringify({ width: canvas.width, height: canvas.height, fullPage: false }, null, 2) },
            { type: "image", data: base64, mimeType: "image/png" },
          ],
        };
      },
    },

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

    // --- dispatch_key ---
    {
      def: {
        name: "dispatch_key",
        description: "Fire a real DOM keyboard event (keydown or keyup) on the window. Useful for UI interactions like pressing 'C' to toggle the craft panel.",
        inputSchema: {
          type: "object",
          properties: {
            key: { type: "string", description: "Key value (e.g. 'c', 'Escape', '1')" },
            type: { type: "string", enum: ["keydown", "keyup"], default: "keydown" },
          },
          required: ["key"],
        },
      },
      handler: (params: Record<string, unknown>) => {
        const key = params.key as string;
        const type = (params.type as string) ?? "keydown";
        const event = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
        window.dispatchEvent(event);
        return jsonResult({ dispatched: true, key, type });
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

    // --- get_player_state ---
    {
      def: {
        name: "get_player_state",
        description: "Read the current blockhead state from the simulation SharedArrayBuffer (position, velocity, attributes, animation).",
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
        const state = readPlayer(renderer, (params.playerIndex as number) ?? 0);
        if (!state) return errorResult("Player not available");
        return jsonResult(state);
      },
    },

    // --- get_world_state ---
    {
      def: {
        name: "get_world_state",
        description: "Read global simulation state (tick, active grid origin, blockhead count, daylight, chunk stats).",
        inputSchema: { type: "object", properties: {} },
      },
      handler: async () => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const state = await readWorld(renderer);
        if (!state) return errorResult("World state not available");
        return jsonResult(state);
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
        const inv = await host.getInventory((params.playerIndex as number) ?? 0);
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
          (params.playerIndex as number) ?? 0,
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
          (params.playerIndex as number) ?? 0,
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
          (params.playerIndex as number) ?? 0,
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
        const tasks = await host.getTasks((params.playerIndex as number) ?? 0);
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
        const result = await host.clearTasks((params.playerIndex as number) ?? 0);
        return jsonResult(result);
      },
    },

    // --- wait_for_condition ---
    {
      def: {
        name: "wait_for_condition",
        description: "Poll until a condition on player/world state is met or a timeout occurs. The condition is a JavaScript expression evaluated against {player, world, tick}. Example: 'player.health > 0' or 'world.tick > 100'.",
        inputSchema: {
          type: "object",
          properties: {
            condition: {
              type: "string",
              description: "JavaScript predicate expression. Available variables: player (object), world (object), tick (number). Example: 'player.health > 50'",
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
          const check = async () => {
            const player = readPlayer(renderer, 0) ?? null;
            const world = await readWorld(renderer) ?? null;
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

    // --- set_test_state ---
    {
      def: {
        name: "set_test_state",
        description: "Set simulation/test state: sim speed, pause/resume, render loop control.",
        inputSchema: {
          type: "object",
          properties: {
            simSpeed: { type: "number", description: "Simulation speed multiplier (0=paused, 1=normal, 2=double)" },
            pause: { type: "boolean", description: "Pause the simulation" },
            resume: { type: "boolean", description: "Resume the simulation" },
            pauseRendering: { type: "boolean", description: "Pause the continuous render loop (screenshot capture still works)" },
            resumeRendering: { type: "boolean", description: "Resume the continuous render loop" },
          },
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        const actions: string[] = [];

        if (params.simSpeed !== undefined && host) {
          await host.setSpeed(params.simSpeed as number);
          actions.push(`simSpeed=${params.simSpeed}`);
        }
        if (params.pause === true && host) {
          await host.pause();
          actions.push("paused");
        }
        if (params.resume === true && host) {
          await host.resume();
          actions.push("resumed");
        }
        if (params.pauseRendering === true) {
          renderer.stop();
          actions.push("renderingPaused");
        }
        if (params.resumeRendering === true) {
          renderer.start();
          actions.push("renderingResumed");
        }

        return jsonResult({ ok: true, actions });
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
  const tools = createAutomationTools({ renderer });
  createMcpHarness({
    serverName: "downdraft-overburden-automation",
    tools,
  });
}
