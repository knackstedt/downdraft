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

import { downdraft } from "@downdraft/app/renderer";
import type { BlockheadsRenderer } from "../renderer/blockheads-renderer";
import type { BlockheadsInputState } from "../renderer/input-handler";

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

async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(",")[1] ?? result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function compositeScreenshot(
  canvas: HTMLCanvasElement,
  capturePagePng: ArrayBuffer,
  width: number,
  height: number,
): Promise<Blob | null> {
  const offscreen = document.createElement("canvas");
  offscreen.width = width;
  offscreen.height = height;
  const ctx = offscreen.getContext("2d");
  if (!ctx) return null;

  ctx.drawImage(canvas, 0, 0, width, height);

  const overlayBlob = new Blob([capturePagePng], { type: "image/png" });
  const overlayBitmap = await createImageBitmap(overlayBlob);
  ctx.drawImage(overlayBitmap, 0, 0, width, height);
  overlayBitmap.close();

  return new Promise((resolve) => {
    offscreen.toBlob((blob) => resolve(blob), "image/png");
  });
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
        description: "Read the blockhead's inventory (list of {itemId, count} slots) via worker RPC.",
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
        description: "Craft an item using a recipe. Only hand-craftable recipes are currently supported (no workbench/furnace blocks yet).",
        inputSchema: {
          type: "object",
          properties: {
            recipeId: { type: "string", description: "Recipe ID (e.g. 'planks_from_wood', 'torch_from_coal_stick', 'wood_pickaxe')" },
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
        const result = await host.craft(params.recipeId as string, (params.playerIndex as number) ?? 0);
        return jsonResult(result);
      },
    },

    // --- give_item ---
    {
      def: {
        name: "give_item",
        description: "Give an item to the blockhead (creative/testing mode). Bypasses inventory limits.",
        inputSchema: {
          type: "object",
          properties: {
            itemId: { type: "string", description: "Item ID (e.g. 'dirt', 'wood', 'torch', 'stone_pickaxe')" },
            count: { type: "number", default: 1 },
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
        const result = await host.giveItem(
          params.itemId as string,
          (params.count as number) ?? 1,
          (params.playerIndex as number) ?? 0,
        );
        return jsonResult(result);
      },
    },

    // --- queue_task ---
    {
      def: {
        name: "queue_task",
        description: "Queue an autonomous task for the blockhead to execute. Tasks: MOVE_TO (walk to world coords), MINE_BLOCK (walk adjacent + mine block at coords), PLACE_BLOCK (walk adjacent + place block). The blockhead executes tasks autonomously, overriding direct input.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["MOVE_TO", "MINE_BLOCK", "PLACE_BLOCK"] },
            targetX: { type: "number", description: "Target world X coordinate (block coords)" },
            targetY: { type: "number", description: "Target world Y coordinate (block coords)" },
            blockId: { type: "number", description: "Block ID to place (for PLACE_BLOCK)", default: 0 },
            playerIndex: { type: "number", default: 0 },
          },
          required: ["type", "targetX", "targetY"],
        },
      },
      handler: async (params: Record<string, unknown>) => {
        const renderer = ctx.renderer();
        if (!renderer) return errorResult("Renderer not initialized");
        const host = renderer.getWorkerHost();
        if (!host) return errorResult("Worker host not available");
        const result = await host.queueTask(
          params.type as "MOVE_TO" | "MINE_BLOCK" | "PLACE_BLOCK",
          params.targetX as number,
          params.targetY as number,
          (params.blockId as number) ?? 0,
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
  ];
}

export function setupBlockheadsMcp(renderer: () => BlockheadsRenderer | null): void {
  const tools = createAutomationTools({ renderer });

  const handleRequest = async (req: McpRequest): Promise<McpResponse> => {
    const { id, method, params = {} } = req;
    try {
      if (method === "initialize") {
        return {
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {}, resources: {}, prompts: {} },
            serverInfo: { name: "downdraft-overburden-automation", version: "0.1.0" },
          },
        };
      }
      if (method === "tools/list") {
        return {
          id,
          result: {
            tools: tools.map((t) => ({
              name: t.def.name,
              description: t.def.description,
              inputSchema: t.def.inputSchema,
            })),
          },
        };
      }
      if (method === "tools/call") {
        const name = params.name as string;
        const args = (params.arguments as Record<string, unknown>) ?? {};
        const tool = tools.find((t) => t.def.name === name);
        if (!tool) {
          return { id, error: { code: -32602, message: `Unknown tool: ${name}` } };
        }
        const result = await tool.handler(args);
        return { id, result };
      }
      if (method === "shutdown") {
        return { id, result: {} };
      }
      return { id, error: { code: -32601, message: `Method not found: ${method}` } };
    } catch (e) {
      return { id, error: { code: -32603, message: (e as Error).message } };
    }
  };

  if (!downdraft?.isAvailable || typeof downdraft.onMcpRequest !== "function") {
    downdraft?.log?.("warn", "[MCP] Electron bridge or onMcpRequest not available; automation harness disabled");
    return;
  }

  downdraft.onMcpRequest(async (request) => handleRequest(request as McpRequest));
  downdraft.log("info", `[MCP] Overburden automation harness registered; tools: ${tools.map((t) => t.def.name).join(", ")}`);
}
