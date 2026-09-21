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

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

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
    // Trading
    expect(names.has("set_block")).toBe(true);
    expect(names.has("select_station")).toBe(true);
    expect(names.has("get_trade_offers")).toBe(true);
    expect(names.has("trade")).toBe(true);
    // Task queue
    expect(names.has("queue_task")).toBe(true);
    expect(names.has("get_tasks")).toBe(true);
    expect(names.has("clear_tasks")).toBe(true);
    // Multi-character
    expect(names.has("spawn_blockhead")).toBe(true);
    expect(names.has("set_active_blockhead")).toBe(true);
    expect(names.has("get_all_players")).toBe(true);
    expect(names.has("use_item")).toBe(true);
    // Combat
    expect(names.has("spawn_critter")).toBe(true);
    expect(names.has("get_critters")).toBe(true);
    expect(names.has("force_raid")).toBe(true);
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

  // --- Trade post feature tests ---
  it("places a trade post, reads offers, and executes a trade", async () => {
    // Place a trade post adjacent to the active blockhead. get_player_state
    // reports active-grid coords; convert to world coords via the origin.
    const ws = parseJsonContent(await game!.mcpClient.callTool("get_world_state", {}));
    const player = parseJsonContent(await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 }));
    const px = Math.floor(player.x as number) + (ws.originCx as number) * 64;
    const py = Math.floor(player.y as number) + (ws.originCy as number) * 64;
    const post = parseJsonContent(await game!.mcpClient.callTool("set_block", {
      x: px + 1, y: py, block: "trade_post",
    }));
    expect(post.ok).toBe(true);

    // Read today's offers for the post.
    const offersData = parseJsonContent(await game!.mcpClient.callTool("get_trade_offers", {
      x: px + 1, y: py,
    }));
    const offers = offersData.offers as {
      id: string;
      inputs: { itemId: string; count: number; have: number }[];
      outputs: { itemId: string; count: number }[];
      affordable: boolean;
    }[];
    expect(offers.length).toBeGreaterThan(0);

    // Same query again → identical offers (deterministic per post + day).
    const again = parseJsonContent(await game!.mcpClient.callTool("get_trade_offers", {
      x: px + 1, y: py,
    }));
    expect((again.offers as { id: string }[]).map((o) => o.id))
      .toEqual(offers.map((o) => o.id));

    // Grant the inputs for the first offer, then trade.
    const offer = offers[0];
    for (const inp of offer.inputs) {
      await game!.mcpClient.callTool("give_item", { itemId: inp.itemId, count: inp.count });
    }
    await sleep(200);
    const result = parseJsonContent(await game!.mcpClient.callTool("trade", {
      x: px + 1, y: py, offerId: offer.id,
    }));
    expect(result.ok).toBe(true);

    // Outputs should now be in the inventory.
    const invData = parseJsonContent(await game!.mcpClient.callTool("get_inventory", { playerIndex: 0 }));
    const inv = invData.inventory as ({ itemId: string; count: number } | null)[];
    for (const out of offer.outputs) {
      const slot = inv.find((s) => s && s.itemId === out.itemId);
      expect(slot, `missing trade output ${out.itemId}`).toBeDefined();
      expect(slot!.count).toBeGreaterThanOrEqual(out.count);
    }
  }, 20000);

  it("rejects a trade when the blockhead can't cover the inputs", async () => {
    const ws = parseJsonContent(await game!.mcpClient.callTool("get_world_state", {}));
    const player = parseJsonContent(await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 }));
    const px = Math.floor(player.x as number) + (ws.originCx as number) * 64;
    const py = Math.floor(player.y as number) + (ws.originCy as number) * 64;
    // Reuse the post from the previous test (same coords).
    const offersData = parseJsonContent(await game!.mcpClient.callTool("get_trade_offers", {
      x: px + 1, y: py,
    }));
    const offers = offersData.offers as {
      id: string;
      inputs: { itemId: string; count: number; have: number }[];
      affordable: boolean;
    }[];
    const unaffordable = offers.find((o) => !o.affordable);
    if (!unaffordable) return; // all offers affordable — nothing to assert
    const result = parseJsonContent(await game!.mcpClient.callTool("trade", {
      x: px + 1, y: py, offerId: unaffordable.id,
    }));
    expect(result.ok).toBe(false);
  }, 15000);

  // --- Combat feature tests ---
  it("spawns a hostile critter that chases and damages the blockhead", async () => {
    const ws = parseJsonContent(await game!.mcpClient.callTool("get_world_state", {}));
    const player = parseJsonContent(await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 }));
    const px = Math.floor(player.x as number) + (ws.originCx as number) * 64;
    const py = Math.floor(player.y as number) + (ws.originCy as number) * 64;

    // Spawn a crawler right next to the blockhead (world coords).
    const spawn = parseJsonContent(await game!.mcpClient.callTool("spawn_critter", {
      type: 1, x: px + 2, y: py - 1,
    }));
    expect(spawn.ok).toBe(true);
    expect(typeof spawn.id).toBe("number");

    // It appears in get_critters with full hp.
    await sleep(300);
    const list = parseJsonContent(await game!.mcpClient.callTool("get_critters", {}));
    const critters = list.critters as { id: number; hp: number; x: number; y: number }[];
    const mine = critters.find((c) => c.id === spawn.id);
    expect(mine).toBeDefined();
    expect(mine!.hp).toBe(30);

    // Within aggro range it should close in and land hits — blockhead health
    // drops below 100 within a few seconds.
    const startHp = player.health as number;
    const deadline = Date.now() + 12000;
    let hp = startHp;
    while (Date.now() < deadline && hp >= startHp) {
      await sleep(400);
      const p = parseJsonContent(await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 }));
      if (typeof p.health !== "number") break; // blockhead died — that counts as damage
      hp = p.health as number;
    }
    expect(hp).toBeLessThan(startHp);
  }, 20000);
});
