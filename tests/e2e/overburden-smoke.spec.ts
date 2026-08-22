// ============================================================================
// Overburden — smoke test via MCP automation harness
// Launches the game under SwiftShader and verifies it boots without console
// errors and can capture a screenshot. Phase 0: minimal scaffolding verification.
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
    captureAndSaveScreenshot,
    launchGame,
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
    // The engine MCP plugin exposes at least capture_screenshot.
    expect(names.has("capture_screenshot")).toBe(true);
  });

  it("captures a non-empty screenshot", async () => {
    // Give the renderer a moment to produce at least one frame.
    await sleep(1000);

    const meta = await captureAndSaveScreenshot(game!, "overburden-smoke.png", true);

    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);

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
