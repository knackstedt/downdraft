// ============================================================================
// To The Ocean — smoke test via MCP automation harness
// Launches the app under SwiftShader, drives it through MCP tools, and
// asserts that the simulation ticks and a screenshot can be captured.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    captureAndSaveScreenshot,
    appAvailable,
    launchApp,
    parseJsonContent,
    sleep,
    type AppProcess
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe.skipIf(!appAvailable("to-the-ocean"))("to-the-ocean MCP automation smoke", () => {
  let app: AppProcess | null = null;

  beforeAll(async () => {
    app = await launchApp({
      app: "to-the-ocean",
      mcpPort: MCP_PORT,
      // Respect DOWNDRAFT_GPU from the parent env (set by `draft test --renderer=...`).
      // Default to swiftshader if not specified.
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
    });
  }, 180000);

  afterAll(async () => {
    await app?.kill();
  }, 30000);

  it("exposes the automation tool set", async () => {
    const tools = await app!.mcpClient.listTools();
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
    const result = await app!.mcpClient.callTool("get_world_state", {});
    const state = parseJsonContent(result) as {
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
    const result = await app!.mcpClient.callTool("get_player_state", { playerIndex: 0 });
    const state = parseJsonContent(result) as {
      position: number[];
      health: number;
      flags: { dead: boolean };
    };
    expect(state.position).toHaveLength(3);
    expect(state.health).toBeGreaterThan(0);
    expect(state.flags.dead).toBe(false);
  });

  it("can inject input and advance simulation ticks", async () => {
    // Put the app into a deterministic, calm state.
    await app!.mcpClient.callTool("set_test_state", {
      weatherType: 0,
      timeOfDay: 0.5,
      simSpeed: 1,
    });

    const before = parseJsonContent(await app!.mcpClient.callTool("get_world_state", {}));
    const beforeTick = before.tick as number;

    // Hold W for 120 frames to drive the player forward.
    await app!.mcpClient.callTool("inject_input", {
      keys: ["W"],
      frames: 120,
    });

    // Wait for the simulation to process the input.
    await app!.mcpClient.callTool("wait_for_condition", {
      condition: "tick > " + (beforeTick + 60),
      timeoutMs: 30000,
    });

    const afterState = parseJsonContent(await app!.mcpClient.callTool("get_world_state", {})) as { tick: number };
    expect(afterState.tick).toBeGreaterThan(beforeTick);
  }, 90000);

  it("captures a non-empty screenshot including the DOM overlay", async () => {
    // Give the renderer a moment to produce at least one frame.
    await sleep(500);

    // Default: fullPage=true — captures the composited frame via the host.
    const meta = await captureAndSaveScreenshot(app!, "ttol-smoke.png", true);

    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    // The screenshot should be a full-page capture (canvas + overlay), not
    // a canvas-only fallback. If this fails, the host bridge's
    // captureFrame() is not wired up or returned an empty image.
    expect(meta.fullPage).toBe(true);
  }, 30000);

  it("clears injected input without error", async () => {
    // Inject some input then clear it immediately.
    await app!.mcpClient.callTool("inject_input", {
      keys: ["W", "A"],
      frames: 300,
    });
    const result = await app!.mcpClient.callTool("clear_injected_input", {});
    const response = parseJsonContent(result) as { cleared: boolean };
    expect(response.cleared).toBe(true);
  });
});
