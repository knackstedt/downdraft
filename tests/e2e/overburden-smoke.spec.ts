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
    // Task queue
    expect(names.has("queue_task")).toBe(true);
    expect(names.has("get_tasks")).toBe(true);
    expect(names.has("clear_tasks")).toBe(true);
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
});
