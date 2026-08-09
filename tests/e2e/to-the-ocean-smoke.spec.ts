// ============================================================================
// To The Ocean — smoke test via MCP automation harness
// Launches the game under SwiftShader, drives it through MCP tools, and
// asserts that the simulation ticks and a screenshot can be captured.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { launchGame, saveBase64Png, sleep, type GameProcess } from "./harness";

const MCP_PORT = 9976;
const SCREENSHOT_DIR = join(import.meta.dir, "../../.playwright-mcp");

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

describe("to-the-ocean MCP automation smoke", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "to-the-ocean",
      mcpPort: MCP_PORT,
      // Respect DOWNDRAFT_GPU from the parent env (set by `draft test --renderer=...`).
      // Default to swiftshader if not specified.
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
    expect(names.has("inject_input")).toBe(true);
    expect(names.has("get_player_state")).toBe(true);
    expect(names.has("get_world_state")).toBe(true);
    expect(names.has("capture_screenshot")).toBe(true);
    expect(names.has("wait_for_condition")).toBe(true);
    expect(names.has("set_test_state")).toBe(true);
    expect(names.has("clear_injected_input")).toBe(true);
  });

  it("reads a valid initial world state", async () => {
    const result = (await game!.mcpClient.callTool("get_world_state", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const state = JSON.parse(result.content[0].text) as {
      tick: number;
      playerCount: number;
      entityCount: number;
      physicsInitialized: number;
    };
    expect(state.playerCount).toBeGreaterThanOrEqual(1);
    expect(state.entityCount).toBeGreaterThanOrEqual(1);
    expect(state.tick).toBeGreaterThanOrEqual(0);
  });

  it("reads player state for player 0", async () => {
    const result = (await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 })) as {
      content: Array<{ type: string; text: string }>;
    };
    const state = JSON.parse(result.content[0].text) as {
      position: number[];
      health: number;
      flags: { dead: boolean };
    };
    expect(state.position).toHaveLength(3);
    expect(state.health).toBeGreaterThan(0);
    expect(state.flags.dead).toBe(false);
  });

  it("can inject input and advance simulation ticks", async () => {
    // Put the game into a deterministic, calm state.
    await game!.mcpClient.callTool("set_test_state", {
      weatherType: 0,
      timeOfDay: 0.5,
      simSpeed: 1,
    });

    const before = (await game!.mcpClient.callTool("get_world_state", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const beforeTick = JSON.parse(before.content[0].text).tick as number;

    // Hold W for 120 frames to drive the player forward.
    await game!.mcpClient.callTool("inject_input", {
      keys: ["W"],
      frames: 120,
    });

    // Wait for the simulation to process the input.
    await game!.mcpClient.callTool("wait_for_condition", {
      condition: "tick > " + (beforeTick + 60),
      timeoutMs: 30000,
    });

    const after = (await game!.mcpClient.callTool("get_world_state", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const afterState = JSON.parse(after.content[0].text) as { tick: number };
    expect(afterState.tick).toBeGreaterThan(beforeTick);
  }, 90000);

  it("captures a non-empty screenshot", async () => {
    // Give the renderer a moment to produce at least one frame.
    await sleep(500);

    const result = (await game!.mcpClient.callTool("capture_screenshot", {})) as {
      content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    };

    const meta = JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "{}") as {
      width?: number;
      height?: number;
    };
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);

    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image!.data).toBeDefined();
    expect(image!.data!.length).toBeGreaterThan(100);

    const path = join(SCREENSHOT_DIR, "ttol-smoke.png");
    ensureDir(path);
    await saveBase64Png(image!.data!, path);
  }, 30000);

  it("clears injected input without error", async () => {
    // Inject some input then clear it immediately.
    await game!.mcpClient.callTool("inject_input", {
      keys: ["W", "A"],
      frames: 300,
    });
    const result = (await game!.mcpClient.callTool("clear_injected_input", {})) as {
      content: Array<{ type: string; text: string }>;
    };
    const response = JSON.parse(result.content[0].text) as { cleared: boolean };
    expect(response.cleared).toBe(true);
  });
});
