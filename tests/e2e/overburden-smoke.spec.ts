// ============================================================================
// Overburden — smoke test via MCP automation harness
// Launches the game under SwiftShader and verifies it boots without console
// errors, exposes the full automation tool set, and can drive the simulation
// (inventory, crafting, task queue, player state).
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    captureAndSaveScreenshot,
    launchGame,
    parseJsonContent,
    sleep,
    type GameProcess,
} from "./harness";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "9976", 10);

describe("overburden MCP automation smoke", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "overburden",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
    });
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  it("exposes the automation tool set", async () => {
    const tools = await game!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    // Core tools
    expect(names.has("capture_screenshot")).toBe(true);
    expect(names.has("inject_input")).toBe(true);
    expect(names.has("clear_injected_input")).toBe(true);
    expect(names.has("get_player_state")).toBe(true);
    expect(names.has("get_world_state")).toBe(true);
    expect(names.has("wait_for_condition")).toBe(true);
    expect(names.has("set_test_state")).toBe(true);
    // Inventory + crafting
    expect(names.has("get_inventory")).toBe(true);
    expect(names.has("craft")).toBe(true);
    expect(names.has("give_item")).toBe(true);
    // Station crafting
    expect(names.has("get_craft_queue")).toBe(true);
    expect(names.has("add_fuel")).toBe(true);
    expect(names.has("rush_craft")).toBe(true);
    expect(names.has("abort_craft")).toBe(true);
    // Task queue
    expect(names.has("queue_task")).toBe(true);
    expect(names.has("get_tasks")).toBe(true);
    expect(names.has("clear_tasks")).toBe(true);
    // Multi-character
    expect(names.has("spawn_blockhead")).toBe(true);
    expect(names.has("set_active_blockhead")).toBe(true);
    expect(names.has("get_all_players")).toBe(true);
    expect(names.has("use_item")).toBe(true);
  });

  it("captures a non-empty screenshot", async () => {
    // Give the renderer a moment to produce at least one frame.
    await sleep(1000);

    const meta = await captureAndSaveScreenshot(game!, "overburden-smoke.png", true);

    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);

  it("reads player state from the simulation", async () => {
    const state = parseJsonContent(await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 }));
    expect(state.health).toBeGreaterThan(0);
    expect(state.hunger).toBeGreaterThan(0);
    expect(typeof state.x).toBe("number");
    expect(typeof state.y).toBe("number");
  }, 15000);

  it("reads world state from the simulation", async () => {
    const state = parseJsonContent(await game!.mcpClient.callTool("get_world_state", {}));
    expect(state.tick).toBeGreaterThanOrEqual(0);
    expect(state.blockheadCount).toBeGreaterThanOrEqual(1);
  }, 15000);

  it("reads the starting inventory (torches + ladders)", async () => {
    const data = parseJsonContent(await game!.mcpClient.callTool("get_inventory", { playerIndex: 0 }));
    const inv = data.inventory as { itemId: string; count: number }[];
    const torches = inv.find((s) => s.itemId === "torch");
    const ladders = inv.find((s) => s.itemId === "ladder");
    expect(torches).toBeDefined();
    expect(torches?.count).toBe(8);
    expect(ladders).toBeDefined();
    expect(ladders?.count).toBe(8);
  }, 15000);

  it("gives an item and verifies inventory updates", async () => {
    await game!.mcpClient.callTool("give_item", { itemId: "wood", count: 5 });
    // Wait a moment for the RPC to complete + inventory to update
    await sleep(200);
    const data = parseJsonContent(await game!.mcpClient.callTool("get_inventory", { playerIndex: 0 }));
    const inv = data.inventory as { itemId: string; count: number }[];
    const wood = inv.find((s) => s.itemId === "wood");
    expect(wood).toBeDefined();
    expect(wood?.count).toBe(5);
  }, 15000);

  it("crafts planks from wood and verifies inventory", async () => {
    // Give 1 wood, craft planks (1 wood → 4 planks)
    await game!.mcpClient.callTool("give_item", { itemId: "wood", count: 1 });
    await sleep(100);
    const data = parseJsonContent(await game!.mcpClient.callTool("craft", { recipeId: "planks_from_wood" }));
    expect(data.ok).toBe(true);
    // Verify planks in inventory
    await sleep(100);
    const invData = parseJsonContent(await game!.mcpClient.callTool("get_inventory", { playerIndex: 0 }));
    const inv = invData.inventory as { itemId: string; count: number }[];
    const planks = inv.find((s) => s.itemId === "planks");
    expect(planks).toBeDefined();
    expect(planks?.count).toBeGreaterThanOrEqual(4);
  }, 15000);

  it("queues and reads tasks", async () => {
    // Queue a MOVE_TO task far enough that it won't complete before we read it.
    // At 30tps with 0.6 blocks/tick max speed, 50 blocks takes ~83 ticks (~2.8s).
    const player = parseJsonContent(await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 }));
    const targetX = Math.floor(player.x as number) + 50;
    const targetY = Math.floor(player.y as number);

    const data = parseJsonContent(await game!.mcpClient.callTool("queue_task", {
      type: "MOVE_TO",
      targetX,
      targetY,
      playerIndex: 0,
    }));
    expect(data.ok).toBe(true);
    expect(data.taskId).toBeGreaterThan(0);

    // Read tasks back immediately (task should still be in the queue)
    const tData = parseJsonContent(await game!.mcpClient.callTool("get_tasks", { playerIndex: 0 }));
    const tasks = tData.tasks as { type: string }[];
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks[0].type).toBe("MOVE_TO");

    // Clear tasks
    await game!.mcpClient.callTool("clear_tasks", { playerIndex: 0 });
  }, 15000);

  it("reports no console errors during boot", async () => {
    // Wait a bit more to catch any delayed errors.
    await sleep(500);
    const errors = game!.getConsoleErrors();
    if (errors.length > 0) {
      console.error("Console errors detected:", errors);
    }
    expect(errors).toHaveLength(0);
  });

  // --- Multi-character feature tests ---
  it("exposes multi-character MCP tools", async () => {
    const tools = await game!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("spawn_blockhead")).toBe(true);
    expect(names.has("set_active_blockhead")).toBe(true);
    expect(names.has("get_active_blockhead")).toBe(true);
    expect(names.has("get_all_players")).toBe(true);
    expect(names.has("use_item")).toBe(true);
  });

  it("starts with exactly one blockhead", async () => {
    const data = parseJsonContent(await game!.mcpClient.callTool("get_all_players", {}));
    const roster = data.blockheads as { id: number; bhIndex: number }[];
    expect(roster.length).toBe(1);
    expect(roster[0].bhIndex).toBe(0);
  });

  it("spawns a second blockhead via MCP", async () => {
    const result = parseJsonContent(await game!.mcpClient.callTool("spawn_blockhead", {}));
    expect(result.ok).toBe(true);
    expect(result.bhIndex).toBe(1);
    expect(typeof result.id).toBe("number");
    // Verify roster now has 2 blockheads
    const data = parseJsonContent(await game!.mcpClient.callTool("get_all_players", {}));
    const roster = data.blockheads as { id: number; bhIndex: number }[];
    expect(roster.length).toBe(2);
  });

  it("switches active blockhead and back", async () => {
    // Switch to blockhead 1
    const r1 = parseJsonContent(await game!.mcpClient.callTool("set_active_blockhead", { index: 1 }));
    expect(r1.ok).toBe(true);
    expect(r1.activeBhIndex).toBe(1);
    // Verify via get_active_blockhead
    const active = parseJsonContent(await game!.mcpClient.callTool("get_active_blockhead", {}));
    expect(active.activeBhIndex).toBe(1);
    // Switch back to 0
    const r2 = parseJsonContent(await game!.mcpClient.callTool("set_active_blockhead", { index: 0 }));
    expect(r2.ok).toBe(true);
    expect(r2.activeBhIndex).toBe(0);
  });

  it("gives a spawn egg and uses it to spawn a third blockhead", async () => {
    // Check roster before
    const before = parseJsonContent(await game!.mcpClient.callTool("get_all_players", {}));
    const beforeRoster = before.blockheads as { id: number; bhIndex: number }[];
    // Give the active blockhead (index 0) a spawn egg
    await game!.mcpClient.callTool("give_item", { itemId: "spawn_egg", count: 1 });
    await sleep(100);
    // Verify it's in the inventory
    const invData = parseJsonContent(await game!.mcpClient.callTool("get_inventory", { playerIndex: 0 }));
    const inv = invData.inventory as ({ itemId: string; count: number } | null)[];
    const egg = inv.find((s) => s && s.itemId === "spawn_egg");
    expect(egg).toBeDefined();
    expect(egg?.count).toBe(1);
    // Use the spawn egg
    const result = parseJsonContent(await game!.mcpClient.callTool("use_item", { itemId: "spawn_egg" }));
    expect(result.ok).toBe(true);
    // Verify roster now has 3 blockheads
    const data = parseJsonContent(await game!.mcpClient.callTool("get_all_players", {}));
    const roster = data.blockheads as { id: number; bhIndex: number }[];
    expect(roster.length).toBe(beforeRoster.length + 1);
    // Verify the spawn egg was consumed
    const invData2 = parseJsonContent(await game!.mcpClient.callTool("get_inventory", { playerIndex: 0 }));
    const inv2 = invData2.inventory as ({ itemId: string; count: number } | null)[];
    const egg2 = inv2.find((s) => s && s.itemId === "spawn_egg");
    expect(egg2).toBeUndefined();
  });

  it("reports no console errors after multi-character operations", async () => {
    await sleep(500);
    const errors = game!.getConsoleErrors();
    if (errors.length > 0) {
      console.error("Console errors detected:", errors);
    }
    expect(errors).toHaveLength(0);
  });
});
