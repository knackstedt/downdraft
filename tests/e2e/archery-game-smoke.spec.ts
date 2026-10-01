import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    captureAndSaveScreenshot,
    launchGame,
    parseJsonContent,
    sleep,
    type GameProcess,
    type McpToolResult,
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe("archery-game MCP automation smoke", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "archery-game",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
      // Fresh userData dir per run — a stale autosave (e.g. a dead player)
      // otherwise restores mid-test and flakes get_ui_state assertions.
      env: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "archery-smoke-")) },
      ignoreErrorPatterns: [
        /WebGL.*context.*lost/i,
        /perf.*extension/i,
        /dynamic import will not move/i,
      ],
    });
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  it("exposes the automation tool set", async () => {
    const tools = await game!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    ["capture_screenshot", "get_ui_state", "dispatch_key", "wait_for_condition"].forEach((name) => {
      expect(names.has(name)).toBe(true);
    });
  });

  it("reports game state via get_ui_state", async () => {
    type UiState = {
      paused: boolean;
      health: number;
      gold: number;
      castleHpL: number;
      castleHpR: number;
      unitCount: number;
      tick: number;
    };
    let state: UiState | null = null;
    for (let i = 0; i < 100 && !(state && state.health > 0); i++) {
      const result = (await game!.mcpClient.callTool("get_ui_state", {})) as McpToolResult;
      state = parseJsonContent(result) as UiState;
      if (state && state.health > 0) break;
      await sleep(100);
    }
    expect(state).not.toBeNull();
    expect(state!.health).toBeGreaterThan(0);
    expect(state!.castleHpL).toBeGreaterThan(0);
    expect(state!.castleHpR).toBeGreaterThan(0);
    expect(state!.unitCount).toBeGreaterThan(0);
    expect(state!.tick).toBeGreaterThanOrEqual(0);
  }, 30000);

  it("captures a non-empty screenshot", async () => {
    await sleep(2000);
    const meta = await captureAndSaveScreenshot(game!, "archery-game-smoke.png", true);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);

  it("reports no console errors during boot", () => {
    const errors = game!.getConsoleErrors();
    expect(errors).toEqual([]);
  });
});
