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

// MCP tool results are { content: [...], isError?: boolean }. When a tool
// returns an error, content[0].text is a plain message (NOT JSON). Parsing it
// blindly yields a confusing "Unexpected identifier" SyntaxError. This helper
// surfaces tool errors as clear assertion failures instead.
interface McpToolResult {
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
}

function parseJsonContent(result: unknown): Record<string, unknown> {
  const r = result as McpToolResult;
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) {
    throw new Error(`MCP tool returned an error: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`MCP tool returned non-JSON text (isError=${r.isError ?? false}): ${(e as Error).message} | text=${text.slice(0, 200)}`);
  }
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
    const result = await game!.mcpClient.callTool("get_world_state", {});
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
    const result = await game!.mcpClient.callTool("get_player_state", { playerIndex: 0 });
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
    // Put the game into a deterministic, calm state.
    await game!.mcpClient.callTool("set_test_state", {
      weatherType: 0,
      timeOfDay: 0.5,
      simSpeed: 1,
    });

    const before = parseJsonContent(await game!.mcpClient.callTool("get_world_state", {}));
    const beforeTick = before.tick as number;

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

    const afterState = parseJsonContent(await game!.mcpClient.callTool("get_world_state", {})) as { tick: number };
    expect(afterState.tick).toBeGreaterThan(beforeTick);
  }, 90000);

  it("captures a non-empty screenshot including the DOM overlay", async () => {
    // Give the renderer a moment to produce at least one frame.
    await sleep(500);

    // Default: fullPage=true — captures canvas + DOM overlay via Electron.
    const result = (await game!.mcpClient.callTool("capture_screenshot", {})) as McpToolResult;

    const textPart = result.content.find((c) => c.type === "text");
    const meta = textPart?.text ? (parseJsonContent(result) as { width?: number; height?: number; fullPage?: boolean }) : {};
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);
    // The screenshot should be a full-page capture (canvas + overlay), not
    // a canvas-only fallback. If this fails, the Electron bridge's
    // capturePage() is not wired up or returned an empty image.
    expect(meta.fullPage).toBe(true);

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
    const result = await game!.mcpClient.callTool("clear_injected_input", {});
    const response = parseJsonContent(result) as { cleared: boolean };
    expect(response.cleared).toBe(true);
  });
});
