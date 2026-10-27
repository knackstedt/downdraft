import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    captureAndSaveScreenshot,
    appAvailable,
    launchApp,
    parseJsonContent,
    sleep,
    type AppProcess,
    type McpToolResult
} from "./harness";

const MCP_PORT = process.env.MCP_PORT ? parseInt(process.env.MCP_PORT, 10) : undefined;

describe.skipIf(!appAvailable("archery-app"))("archery-app MCP automation smoke", () => {
  let app: AppProcess | null = null;

  beforeAll(async () => {
    app = await launchApp({
      app: "archery-app",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
      // Fresh userData dir per run — a stale autosave (e.g. a dead player)
      // otherwise restores mid-test and flakes get_ui_state assertions.
      extraEnv: { XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "archery-smoke-")) },
      ignoreErrorPatterns: [
        /WebGL.*context.*lost/i,
        /perf.*extension/i,
        /dynamic import will not move/i,
      ],
    });
  }, 180000);

  afterAll(async () => {
    await app?.kill();
  }, 30000);

  it("exposes the automation tool set", async () => {
    const tools = await app!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    ["capture_screenshot", "get_ui_state", "dispatch_key", "wait_for_condition"].forEach((name) => {
      expect(names.has(name)).toBe(true);
    });
  });

  it("reports app state via get_ui_state", async () => {
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
      const result = (await app!.mcpClient.callTool("get_ui_state", {})) as McpToolResult;
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
    const meta = await captureAndSaveScreenshot(app!, "archery-app-smoke.png", true);
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
  }, 30000);

  it("reports no console errors during boot", () => {
    const errors = app!.getConsoleErrors();
    expect(errors).toEqual([]);
  });
});
