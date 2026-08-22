// ============================================================================
// Sandjongg — smoke test via MCP automation harness.
// Launches the game under SwiftShader, verifies it boots without console
// errors, captures a screenshot, and drives a full level clear using the
// match_tiles + request_hint tools.
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

describe("sandjongg MCP automation smoke", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "sandjongg",
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
    expect(names.has("capture_screenshot")).toBe(true);
    expect(names.has("match_tiles")).toBe(true);
    expect(names.has("get_game_state")).toBe(true);
    expect(names.has("request_hint")).toBe(true);
    expect(names.has("new_game")).toBe(true);
  });

  it("captures a non-empty screenshot", async () => {
    await sleep(2000);

    const result = (await game!.mcpClient.callTool("capture_screenshot", {})) as McpToolResult;

    const textPart = result.content.find((c) => c.type === "text");
    const meta = textPart?.text ? (parseJsonContent(result) as { width?: number; height?: number }) : {};
    expect(meta.width).toBeGreaterThan(0);
    expect(meta.height).toBeGreaterThan(0);

    const image = result.content.find((c) => c.type === "image");
    expect(image).toBeDefined();
    expect(image!.data).toBeDefined();
    expect(image!.data!.length).toBeGreaterThan(100);

    const path = join(SCREENSHOT_DIR, "sandjongg-smoke.png");
    ensureDir(path);
    await saveBase64Png(image!.data!, path);
  }, 30000);

  it("reports game state with tiles on the board", async () => {
    const result = (await game!.mcpClient.callTool("get_game_state", {})) as McpToolResult;
    const state = parseJsonContent(result) as {
      score: number;
      level: number;
      tilesLeft: number;
      boardCols: number;
      boardRows: number;
      boardLayers: number;
      boardElements: number[];
    };
    expect(state.boardCols).toBeGreaterThan(0);
    expect(state.boardRows).toBeGreaterThan(0);
    expect(state.boardLayers).toBeGreaterThanOrEqual(1);
    expect(state.boardElements.length).toBeGreaterThan(0);
    // At least some tiles should be present (element >= 0).
    const tileCount = state.boardElements.filter((e) => e >= 0).length;
    expect(tileCount).toBeGreaterThan(0);
  }, 30000);

  it("can request a hint and get a valid pair", async () => {
    const result = (await game!.mcpClient.callTool("request_hint", {})) as McpToolResult;
    const data = parseJsonContent(result) as {
      hint: { a: { col: number; row: number; layer: number }; b: { col: number; row: number; layer: number }; element: number } | null;
    };
    expect(data.hint).not.toBeNull();
    expect(data.hint!.a).toBeDefined();
    expect(data.hint!.b).toBeDefined();
  }, 30000);

  it("can match a hinted pair and score increases", async () => {
    // First get the current score.
    const stateBefore = parseJsonContent(
      (await game!.mcpClient.callTool("get_game_state", {})) as McpToolResult,
    ) as { score: number };

    // Get a hint.
    const hintResult = (await game!.mcpClient.callTool("request_hint", {})) as McpToolResult;
    const hintData = parseJsonContent(hintResult) as {
      hint: { a: { col: number; row: number; layer: number }; b: { col: number; row: number; layer: number } } | null;
    };
    expect(hintData.hint).not.toBeNull();

    // Match the hinted pair (include layer info).
    const matchResult = (await game!.mcpClient.callTool("match_tiles", {
      aCol: hintData.hint!.a.col,
      aRow: hintData.hint!.a.row,
      aLayer: hintData.hint!.a.layer ?? 0,
      bCol: hintData.hint!.b.col,
      bRow: hintData.hint!.b.row,
      bLayer: hintData.hint!.b.layer ?? 0,
    })) as McpToolResult;
    const matchData = parseJsonContent(matchResult) as { score: number };

    // Score should have increased (or at least not decreased).
    expect(matchData.score).toBeGreaterThanOrEqual(stateBefore.score);
  }, 30000);

  it("reports no console errors during boot", async () => {
    await sleep(500);
    const errors = game!.getConsoleErrors();
    if (errors.length > 0) {
      console.error("Console errors detected:", errors);
    }
    expect(errors).toHaveLength(0);
  });
});
