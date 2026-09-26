import { beforeEach, describe, expect, it, mock } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MainContext } from "../types";

// --- Mock contentTracing ---

const tracingCalls: string[] = [];
let mockRecordingConfig: Record<string, unknown> | null = null;
let mockTempTracePath: string | null = null;
let mockCategories: string[] = ["toplevel", "v8", "gpu", "electron", "disabled-by-default-memory-infra"];

function contentText(result: { content: { type: string }[] }): string {
  return (result.content[0] as { type: string; text?: string }).text!;
}

const contentTracingMock = {
  enableHeapProfiling: mock(async (_opts?: any) => {
    tracingCalls.push("enableHeapProfiling");
  }),
  startRecording: mock(async (config: any) => {
    tracingCalls.push("startRecording");
    mockRecordingConfig = config;
  }),
  stopRecording: mock(async (resultFilePath?: string) => {
    tracingCalls.push("stopRecording");
    // Write a fake trace file to the temp path
    const p = resultFilePath ?? mockTempTracePath ?? join(tmpdir(), `mock-trace-${Date.now()}.json`);
    writeFileSync(p, '{"traceEvents":[]}');
    return p;
  }),
  getTraceBufferUsage: mock(async () => ({ value: 1000, percentage: 1.5 })),
  getCategories: mock(async () => mockCategories),
};

// --- Mock v8 ---

const v8Mock = {
  writeHeapSnapshot: mock((path: string) => {
    writeFileSync(path, '{"snapshot":{}}');
    return path;
  }),
};

// --- Mock electron ipcMain ---
const ipcEmitter = new EventEmitter();
const ipcMainMock = {
  handle: (channel: string, cb: (...args: any[]) => void) => {
    ipcEmitter.on(channel, async (...args) => {
      const result = await cb(...args);
      ipcEmitter.emit(`${channel}:result`, result);
    });
  },
  handleOnce: (channel: string, cb: (...args: any[]) => void) => ipcEmitter.once(channel, cb),
  removeHandler: (channel: string) => ipcEmitter.removeAllListeners(channel),
  on: (channel: string, cb: (...args: any[]) => void) => ipcEmitter.on(channel, cb),
  off: (channel: string, cb: (...args: any[]) => void) => ipcEmitter.off(channel, cb),
  send: (channel: string, ...args: any[]) => ipcEmitter.emit(channel, ...args),
  removeAllListeners: (channel: string) => ipcEmitter.removeAllListeners(channel),
};

// --- Mock logger ---
const loggerMock = {
  info: mock(() => {}),
  error: mock(() => {}),
  warn: mock(() => {}),
  debug: mock(() => {}),
};

// Register mocks before importing the module under test
mock.module("electron", () => ({
  contentTracing: contentTracingMock,
  ipcMain: ipcMainMock,
}));
mock.module("@downdraft/engine/util/logger", () => ({ createLogger: () => loggerMock }));
mock.module("node:v8", () => v8Mock);
mock.module("@downdraft/engine/mcp", () => ({
  errorResult: (message: string) => ({ content: [{ type: "text", text: message }], isError: true }),
  jsonResult: (data: unknown) => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] }),
}));

// Import after mocks are registered
const { createTracingTools, registerTracingHandlers, __resetTracingState, __isRecording } = await import("./tracing");

function makeMockCtx(userDataDir: string): MainContext {
  return {
    app: {
      getPath: () => userDataDir,
    } as any,
    BrowserWindow: {} as any,
    ipcMain: ipcMainMock as any,
    session: {} as any,
    screen: {} as any,
    shell: {} as any,
    window: null,
    isDev: false,
    sendToRenderer: () => {},
  } as any;
}

describe("tracing tools", () => {
  let ctx: MainContext;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "dd-trace-test-"));
    ctx = makeMockCtx(tmpDir);
    __resetTracingState();
    tracingCalls.length = 0;
    mockRecordingConfig = null;
    mockTempTracePath = null;
  });

  describe("trace_start", () => {
    it("should start a perf trace by default", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const result = await traceStart.handler({});
      const parsed = JSON.parse(contentText(result));
      expect(parsed.started).toBe(true);
      expect(parsed.preset).toBe("perf");
      expect(parsed.categories).toContain("toplevel");
      expect(tracingCalls).toContain("startRecording");
      expect(__isRecording()).toBe(true);
    });

    it("should start a memory trace with heap profiling enabled", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const result = await traceStart.handler({ preset: "memory" });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.preset).toBe("memory");
      expect(parsed.categories).toContain("disabled-by-default-memory-infra");
      expect(tracingCalls).toContain("enableHeapProfiling");
      expect(tracingCalls).toContain("startRecording");
      expect(mockRecordingConfig).toHaveProperty("memory_dump_config");
    });

    it("should start a custom trace with provided categories", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const result = await traceStart.handler({
        preset: "custom",
        categories: ["my-category", "another"],
      });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.preset).toBe("custom");
      expect(parsed.categories).toEqual(["my-category", "another"]);
    });

    it("should error on custom preset with empty categories", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const result = await traceStart.handler({ preset: "custom", categories: [] });
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain("non-empty 'categories'");
    });

    it("should error when starting twice without stopping", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      await traceStart.handler({});
      const result = await traceStart.handler({});
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain("already in progress");
    });

    it("should pass recordingMode and bufferSizeKB to contentTracing", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      await traceStart.handler({
        preset: "perf",
        recordingMode: "record-continuously",
        bufferSizeKB: 50000,
      });
      expect(mockRecordingConfig).toMatchObject({
        recording_mode: "record-continuously",
        trace_buffer_size_in_kb: 50000,
      });
    });
  });

  describe("trace_stop", () => {
    it("should stop a recording and return file info", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const traceStop = tools.find((t) => t.def.name === "trace_stop")!;
      await traceStart.handler({});
      const result = await traceStop.handler({});
      const parsed = JSON.parse(contentText(result));
      expect(parsed.stopped).toBe(true);
      expect(parsed.path).toContain("debug-artifacts");
      expect(parsed.path).toContain("traces");
      expect(parsed.downloadUrl).toContain("http://localhost:9876/mcp/artifact/traces/");
      expect(parsed.sizeBytes).toBeGreaterThan(0);
      expect(__isRecording()).toBe(false);
    });

    it("should error when stopping without a recording", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStop = tools.find((t) => t.def.name === "trace_stop")!;
      const result = await traceStop.handler({});
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain("No trace recording in progress");
    });
  });

  describe("trace_status", () => {
    it("should report not recording when idle", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStatus = tools.find((t) => t.def.name === "trace_status")!;
      const result = await traceStatus.handler({});
      const parsed = JSON.parse(contentText(result));
      expect(parsed.recording).toBe(false);
    });

    it("should report recording with buffer usage when active", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const traceStatus = tools.find((t) => t.def.name === "trace_status")!;
      await traceStart.handler({ preset: "gpu" });
      const result = await traceStatus.handler({});
      const parsed = JSON.parse(contentText(result));
      expect(parsed.recording).toBe(true);
      expect(parsed.preset).toBe("gpu");
      expect(parsed.bufferUsage).toEqual({ value: 1000, percentage: 1.5 });
    });
  });

  describe("trace_categories", () => {
    it("should return available categories", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceCategories = tools.find((t) => t.def.name === "trace_categories")!;
      const result = await traceCategories.handler({});
      const parsed = JSON.parse(contentText(result));
      expect(parsed.categories).toContain("toplevel");
      expect(parsed.categories).toContain("electron");
    });
  });

  describe("memory_dump", () => {
    it("should start memory recording, wait, and stop", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const memoryDump = tools.find((t) => t.def.name === "memory_dump")!;
      const result = await memoryDump.handler({ durationMs: 10 });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.stopped).toBe(true);
      expect(parsed.preset).toBe("memory");
      expect(tracingCalls).toContain("enableHeapProfiling");
      expect(tracingCalls).toContain("startRecording");
      expect(tracingCalls).toContain("stopRecording");
      expect(__isRecording()).toBe(false);
    });

    it("should error when a recording is already in progress", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const traceStart = tools.find((t) => t.def.name === "trace_start")!;
      const memoryDump = tools.find((t) => t.def.name === "memory_dump")!;
      await traceStart.handler({});
      const result = await memoryDump.handler({ durationMs: 10 });
      expect(result.isError).toBe(true);
    });
  });

  describe("trace_enable_heap_profiling", () => {
    it("should call contentTracing.enableHeapProfiling with mode", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const tool = tools.find((t) => t.def.name === "trace_enable_heap_profiling")!;
      const result = await tool.handler({ mode: "all-renderers", samplingRate: 50000 });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.enabled).toBe(true);
      expect(parsed.mode).toBe("all-renderers");
      // enableHeapProfiling was called (tracingCalls records the call)
      expect(tracingCalls).toContain("enableHeapProfiling");
    });
  });

  describe("heap_snapshot", () => {
    it("should capture a main-process heap snapshot via v8.writeHeapSnapshot", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const tool = tools.find((t) => t.def.name === "heap_snapshot")!;
      const result = await tool.handler({ target: "main" });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.target).toBe("main");
      expect(parsed.path).toContain("debug-artifacts");
      expect(parsed.path).toContain("heaps");
      expect(parsed.downloadUrl).toContain("/mcp/artifact/heaps/");
      expect(parsed.sizeBytes).toBeGreaterThan(0);
    });

    it("should error for renderer target when no window is available", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const tool = tools.find((t) => t.def.name === "heap_snapshot")!;
      const result = await tool.handler({ target: "renderer" });
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain("No renderer window available");
    });
  });

  describe("process_snapshot", () => {
    it("should return main process memory/CPU stats", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const tool = tools.find((t) => t.def.name === "process_snapshot")!;
      const result = await tool.handler({ target: "main" });
      const parsed = JSON.parse(contentText(result));
      expect(parsed.target).toBe("main");
      expect(parsed.main).toBeDefined();
      expect(parsed.main.rss).toBeGreaterThan(0);
      expect(parsed.main.uptimeSec).toBeGreaterThanOrEqual(0);
    });

    it("should error for renderer target when no window is available", async () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const tool = tools.find((t) => t.def.name === "process_snapshot")!;
      const result = await tool.handler({ target: "renderer" });
      expect(result.isError).toBe(true);
      expect(contentText(result)).toContain("No renderer window available");
    });
  });

  describe("tool definitions", () => {
    it("should register all 8 tools", () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      const names = tools.map((t) => t.def.name);
      expect(names).toEqual([
        "trace_start",
        "trace_stop",
        "trace_status",
        "trace_categories",
        "memory_dump",
        "trace_enable_heap_profiling",
        "heap_snapshot",
        "process_snapshot",
      ]);
    });

    it("should have descriptions and input schemas", () => {
      const tools = createTracingTools(ctx, { current: 9876 });
      tools.forEach((tool) => {
        expect(tool.def.description.length).toBeGreaterThan(10);
        expect(tool.def.inputSchema.type).toBe("object");
      });
    });
  });
});
