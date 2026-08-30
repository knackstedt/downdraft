// ============================================================================
// Tracing toolkit e2e test — verifies the main-process tracing tools work
// against a real running game via the MCP HTTP transport.
//
// Exercises:
//   - tools/list includes the tracing tools (trace_start, trace_stop, etc.)
//   - trace_categories returns real Chromium categories
//   - trace_start + trace_stop produces a real trace file on disk
//   - the artifact download endpoint serves the trace file
//   - process_snapshot returns real main-process memory stats
//   - heap_snapshot (main) produces a real .heapsnapshot file
// ============================================================================

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { launchGame, parseJsonContent, type GameProcess } from "./harness";

const MCP_PORT = parseInt(process.env.MCP_PORT ?? "9976", 10);

describe("tracing toolkit e2e (main-process MCP tools)", () => {
  let game: GameProcess | null = null;

  beforeAll(async () => {
    game = await launchGame({
      game: "to-the-ocean",
      mcpPort: MCP_PORT,
      gpu: (process.env.DOWNDRAFT_GPU as "swiftshader" | undefined) ?? "swiftshader",
      deterministic: true,
    });
  }, 180000);

  afterAll(async () => {
    await game?.kill();
  }, 30000);

  it("exposes the tracing tools in tools/list", async () => {
    const tools = await game!.mcpClient.listTools();
    const names = new Set(tools.map((t) => t.name));
    expect(names.has("trace_start")).toBe(true);
    expect(names.has("trace_stop")).toBe(true);
    expect(names.has("trace_status")).toBe(true);
    expect(names.has("trace_categories")).toBe(true);
    expect(names.has("memory_dump")).toBe(true);
    expect(names.has("trace_enable_heap_profiling")).toBe(true);
    expect(names.has("heap_snapshot")).toBe(true);
    expect(names.has("process_snapshot")).toBe(true);
  });

  it("trace_categories returns real Chromium tracing categories", async () => {
    const result = await game!.mcpClient.callTool("trace_categories", {});
    const data = parseJsonContent(result) as { categories: string[] };
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThan(10);
    // Chromium always includes these built-in categories
    expect(data.categories.some((c) => c.includes("toplevel"))).toBe(true);
  });

  it("trace_status reports not recording when idle", async () => {
    const result = await game!.mcpClient.callTool("trace_status", {});
    const data = parseJsonContent(result) as { recording: boolean };
    expect(data.recording).toBe(false);
  });

  it("trace_start + trace_stop produces a real trace file", async () => {
    // Start a perf trace
    const startResult = await game!.mcpClient.callTool("trace_start", {
      preset: "perf",
      recordingMode: "record-until-full",
    });
    const startData = parseJsonContent(startResult) as {
      started: boolean;
      preset: string;
      categories: string[];
    };
    expect(startData.started).toBe(true);
    expect(startData.preset).toBe("perf");
    expect(startData.categories.length).toBeGreaterThan(0);

    // Confirm status shows recording
    const statusResult = await game!.mcpClient.callTool("trace_status", {});
    const statusData = parseJsonContent(statusResult) as { recording: boolean };
    expect(statusData.recording).toBe(true);

    // Let it record briefly
    await new Promise((r) => setTimeout(r, 500));

    // Stop and write to disk
    const stopResult = await game!.mcpClient.callTool("trace_stop", {});
    const stopData = parseJsonContent(stopResult) as {
      stopped: boolean;
      path: string;
      downloadUrl: string;
      sizeBytes: number;
      durationMs: number;
    };
    expect(stopData.stopped).toBe(true);
    expect(stopData.path).toContain("debug-artifacts");
    expect(stopData.path).toContain("traces");
    expect(stopData.downloadUrl).toContain("/mcp/artifact/traces/");
    expect(stopData.sizeBytes).toBeGreaterThan(0);
    expect(stopData.durationMs).toBeGreaterThan(0);

    // Verify the file actually exists on disk
    expect(existsSync(stopData.path)).toBe(true);
    const fileStat = statSync(stopData.path);
    expect(fileStat.size).toBe(stopData.sizeBytes);

    // Verify the file is valid JSON (Chrome trace format)
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync(stopData.path, "utf-8");
    const parsed = JSON.parse(raw);
    // Chrome trace format: { traceEvents: [...] } or an array of events
    if (parsed.traceEvents) {
      expect(Array.isArray(parsed.traceEvents)).toBe(true);
    } else {
      expect(Array.isArray(parsed)).toBe(true);
    }

    // Verify the artifact download endpoint serves the file
    const downloadRes = await fetch(stopData.downloadUrl);
    expect(downloadRes.ok).toBe(true);
    expect(downloadRes.headers.get("content-type")).toBe("application/json");
    const contentLength = parseInt(downloadRes.headers.get("content-length") ?? "0", 10);
    expect(contentLength).toBe(stopData.sizeBytes);

    // Status should now show not recording
    const statusAfter = await game!.mcpClient.callTool("trace_status", {});
    const statusAfterData = parseJsonContent(statusAfter) as { recording: boolean };
    expect(statusAfterData.recording).toBe(false);
  });

  it("process_snapshot returns real main-process memory stats", async () => {
    const result = await game!.mcpClient.callTool("process_snapshot", {
      target: "main",
    });
    const data = parseJsonContent(result) as {
      target: string;
      timestamp: number;
      main: {
        rss: number;
        heapTotal: number;
        heapUsed: number;
        cpuUser: number;
        uptimeSec: number;
      };
    };
    expect(data.target).toBe("main");
    expect(data.main).toBeDefined();
    expect(data.main.rss).toBeGreaterThan(0);
    expect(data.main.heapTotal).toBeGreaterThan(0);
    expect(data.main.heapUsed).toBeGreaterThan(0);
    expect(data.main.uptimeSec).toBeGreaterThan(0);
  });

  it("heap_snapshot (main) produces a real .heapsnapshot file", async () => {
    const result = await game!.mcpClient.callTool("heap_snapshot", {
      target: "main",
    });
    const data = parseJsonContent(result) as {
      path: string;
      downloadUrl: string;
      sizeBytes: number;
      target: string;
    };
    expect(data.target).toBe("main");
    expect(data.path).toContain("debug-artifacts");
    expect(data.path).toContain("heaps");
    expect(data.path).toMatch(/\.heapsnapshot$/);
    expect(data.downloadUrl).toContain("/mcp/artifact/heaps/");
    expect(data.sizeBytes).toBeGreaterThan(0);

    // Verify the file exists
    expect(existsSync(data.path)).toBe(true);

    // Verify the download endpoint serves it
    const downloadRes = await fetch(data.downloadUrl);
    expect(downloadRes.ok).toBe(true);
  });

  it("trace_start errors when starting twice without stopping", async () => {
    await game!.mcpClient.callTool("trace_start", { preset: "v8" });
    const result = await game!.mcpClient.callTool("trace_start", { preset: "perf" });
    const r = result as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(r.isError).toBe(true);
    expect(r.content?.[0]?.text).toContain("already in progress");
    // Clean up
    await game!.mcpClient.callTool("trace_stop", {});
  });
});
