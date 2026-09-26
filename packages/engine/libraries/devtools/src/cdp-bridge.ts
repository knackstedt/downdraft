// ============================================================================
// cdp-bridge.ts — Chrome DevTools Protocol bridge via Bun's node:inspector.
//
// Wraps a node:inspector Session connected to the current (main) isolate.
// Captures console API calls + uncaught exceptions (Runtime domain) and
// provides CPU profiling via the Profiler domain.
//
// Verified in Bun 1.4.0:
//   ✅ Runtime.enable + Runtime.consoleAPICalled + Runtime.exceptionThrown
//   ✅ Profiler.enable + Profiler.setSamplingInterval + Profiler.start/stop
//   ❌ Performance.* (not found)
//   ❌ HeapProfiler.* (not found)
//   ❌ Runtime.getHeapUsage (returns undefined)
//
// The session connects to the MAIN isolate only. The sim worker (separate
// process) is not captured here — per-worker metrics come from the
// ProfilingSAB (see perf-metrics panel).
// ============================================================================

// node:inspector is a Node/Bun built-in. Use createRequire (ESM-safe) so the
// import doesn't fail at typecheck time in environments without the module.
// At runtime in Bun, `require("node:inspector")` returns the inspector API.
import { createLogger } from "@downdraft/engine/util/logger";
import { createRequire as nodeCreateRequire } from "node:module";

const log = createLogger("info");

let insp: any;
try {
  // ESM-safe require shim — works in Node ESM, Bun, and CommonJS.
  let requireFn: any = null;
  if (typeof (globalThis as any).require === "function") {
    // Bun and CommonJS have a global require.
    requireFn = (globalThis as any).require;
  } else {
    // Node ESM: use createRequire from node:module.
    requireFn = nodeCreateRequire(import.meta.url);
  }
  insp = requireFn("node:inspector");
} catch {
  insp = null;
}

// ── Types ──

export type ConsoleType = "log" | "info" | "warn" | "warning" | "error" | "debug" | "trace" | "dir" | "assert";

export interface CdpRemoteObject {
  type: string;        // "string" | "number" | "boolean" | "object" | "undefined" | "function"
  value?: any;
  description?: string;
  subtype?: string;
  className?: string;
  objectId?: string;
  unserializableValue?: string;
}

export interface CdpConsoleEntry {
  id: number;
  type: ConsoleType;
  text: string;          // serialized message
  args: CdpRemoteObject[];
  timestamp: number;     // performance.now() at capture
  source: string;        // "console-api" | "exception" | etc.
  stack?: string;        // for exceptions / expanded entries
  url?: string;
  line?: number;
  column?: number;
}

export interface CdpException {
  id: number;
  text: string;
  stack: string;
  timestamp: number;
  url?: string;
  line?: number;
  column?: number;
}

export interface CdpProfileNode {
  id: number;
  callFrame: {
    functionName: string;
    scriptId: string;
    url: string;
    lineNumber: number;
    columnNumber: number;
  };
  hitCount: number;
  children: number[];
  positionTicks?: { line: number; ticks: number }[];
}

export interface CdpProfile {
  nodes: CdpProfileNode[];
  startTime: number;   // microseconds
  endTime: number;     // microseconds
  samples: number[];   // node ids
  timeDeltas: number[]; // microseconds between samples
  // Derived (computed by stopProfile):
  totalDurationUs?: number;
  nodeCount?: number;
  sampleCount?: number;
}

// ── CdpBridge ──

type ConsoleCallback = (entry: CdpConsoleEntry) => void;
type ExceptionCallback = (exc: CdpException) => void;

const MAX_ENTRIES = 1000;

export class CdpBridge {
  private session: any = null;
  private connected = false;
  private consoleCallbacks = new Set<ConsoleCallback>();
  private exceptionCallbacks = new Set<ExceptionCallback>();
  private entries: CdpConsoleEntry[] = [];
  private exceptions: CdpException[] = [];
  private entryCounter = 0;
  private profiling = false;
  private lastProfile: CdpProfile | null = null;
  private available = false;

  constructor() {
    if (!insp || typeof insp.Session !== "function") {
      this.available = false;
      return;
    }
    this.available = true;
  }

  /** Whether the node:inspector module is available. */
  get isAvailable(): boolean { return this.available; }

  /** Connect the session and enable Runtime + Profiler domains. */
  start(): void {
    if (!this.available || this.connected) return;
    try {
      this.session = new insp.Session();
      this.session.connect();
      this.connected = true;
      log.info("CdpBridge", "Session connected, enabling domains...");

      // Wire event handlers BEFORE enabling domains so we don't miss events.
      this.session.on("Runtime.consoleAPICalled", (e: any) => {
        this.handleConsole(e.params);
      });
      this.session.on("Runtime.exceptionThrown", (e: any) => {
        this.handleException(e.params);
      });

      // Enable domains (callbacks are optional; events fire via .on()).
      this.post("Runtime.enable", {});
      this.post("Profiler.enable", {});
    } catch (err) {
      log.warn("CdpBridge", `Failed to connect session: ${err}`);
      this.available = false;
      this.connected = false;
    }
  }

  /** Subscribe to console entries. Returns an unsubscribe function. */
  onConsole(cb: ConsoleCallback): () => void {
    this.consoleCallbacks.add(cb);
    return () => { this.consoleCallbacks.delete(cb); };
  }

  /** Subscribe to exceptions. Returns an unsubscribe function. */
  onException(cb: ExceptionCallback): () => void {
    this.exceptionCallbacks.add(cb);
    return () => { this.exceptionCallbacks.delete(cb); };
  }

  /** Get all buffered console entries (newest last). */
  getEntries(): CdpConsoleEntry[] { return this.entries; }

  /** Get all buffered exceptions (newest last). */
  getExceptions(): CdpException[] { return this.exceptions; }

  /** Clear buffered console entries + exceptions. */
  clear(): void {
    this.entries = [];
    this.exceptions = [];
  }

  /** Start CPU profiling. */
  startProfile(intervalUs = 100): void {
    if (!this.connected || this.profiling) {
      log.info("CdpBridge", `startProfile skipped: connected=${this.connected} profiling=${this.profiling}`);
      return;
    }
    this.profiling = true;
    log.info("CdpBridge", "Starting CPU profile...");
    this.post("Profiler.setSamplingInterval", { interval: intervalUs });
    this.post("Profiler.start", {});
  }

  /** Stop CPU profiling and return the profile. */
  stopProfile(): Promise<CdpProfile | null> {
    if (!this.connected || !this.profiling) {
      log.info("CdpBridge", `stopProfile skipped: connected=${this.connected} profiling=${this.profiling}`);
      return Promise.resolve(null);
    }
    this.profiling = false;
    log.info("CdpBridge", "Stopping CPU profile...");
    return new Promise((resolve) => {
      this.session.post("Profiler.stop", (_err: any, res: any) => {
        if (_err || !res?.profile) {
          log.warn("CdpBridge", `Profiler.stop error: ${_err} res: ${JSON.stringify(res)}`);
          resolve(null);
          return;
        }
        const prof: CdpProfile = res.profile;
        prof.totalDurationUs = prof.endTime - prof.startTime;
        prof.nodeCount = prof.nodes?.length ?? 0;
        prof.sampleCount = prof.samples?.length ?? 0;
        this.lastProfile = prof;
        log.info("CdpBridge", `Profile received: ${prof.nodeCount} nodes, ${prof.sampleCount} samples`);
        resolve(prof);
      });
    });
  }

  /** Whether currently profiling. */
  isProfiling(): boolean { return this.profiling; }

  /** The last recorded profile (null if none). */
  getLastProfile(): CdpProfile | null { return this.lastProfile; }

  /** Evaluate an expression (Runtime.evaluate). Stretch goal. */
  evaluate(expr: string): Promise<{ result?: any; error?: string }> {
    if (!this.connected) return Promise.resolve({ error: "not connected" });
    return new Promise((resolve) => {
      this.session.post("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
      }, (_err: any, res: any) => {
        if (_err) { resolve({ error: String(_err) }); return; }
        if (res?.exceptionDetails) {
          resolve({ error: res.exceptionDetails.text ?? res.exceptionDetails.exception?.description ?? "eval error" });
          return;
        }
        resolve({ result: res?.result?.value });
      });
    });
  }

  /** Disconnect + cleanup. */
  dispose(): void {
    if (this.profiling) {
      try { this.session?.post("Profiler.stop", {}); } catch { /* ignore */ }
      this.profiling = false;
    }
    if (this.connected) {
      try { this.session?.disconnect(); } catch { /* ignore */ }
      this.connected = false;
    }
    this.consoleCallbacks.clear();
    this.exceptionCallbacks.clear();
    this.entries = [];
    this.exceptions = [];
    this.session = null;
  }

  // ── Internal ──

  private post(method: string, params: any): void {
    if (!this.session) return;
    try {
      this.session.post(method, params, () => {});
    } catch {
      // Some methods may not be available in all runtimes; ignore.
    }
  }

  private handleConsole(params: any): void {
    const type = (params.type ?? "log") as ConsoleType;
    const args: CdpRemoteObject[] = (params.args ?? []).map((a: any) => ({
      type: a.type,
      value: a.value,
      description: a.description,
      subtype: a.subtype,
      className: a.className,
      objectId: a.objectId,
      unserializableValue: a.unserializableValue,
    }));
    const text = args.map((a) => this.serializeArg(a)).join(" ");
    const entry: CdpConsoleEntry = {
      id: ++this.entryCounter,
      type,
      text,
      args,
      timestamp: performance.now(),
      source: params.executionContextId !== undefined ? "console-api" : "console-api",
      url: params.stackTrace?.callFrames?.[0]?.url,
      line: params.stackTrace?.callFrames?.[0]?.lineNumber,
      column: params.stackTrace?.callFrames?.[0]?.columnNumber,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
    for (const cb of this.consoleCallbacks.values()) {
      try { cb(entry); } catch { /* ignore callback errors */ }
    }
  }

  private handleException(params: any): void {
    const details = params.exceptionDetails ?? {};
    const exc: CdpException = {
      id: ++this.entryCounter,
      text: details.text ?? "Uncaught exception",
      stack: details.exception?.description ?? details.stackTrace?.callFrames?.map(
        (f: any) => `  at ${f.functionName ?? "<anon>"} (${f.url}:${f.lineNumber}:${f.columnNumber})`,
      ).join("\n") ?? "",
      timestamp: performance.now(),
      url: details.stackTrace?.callFrames?.[0]?.url ?? details.url,
      line: details.stackTrace?.callFrames?.[0]?.lineNumber ?? details.lineNumber,
      column: details.stackTrace?.callFrames?.[0]?.columnNumber ?? details.columnNumber,
    };
    this.exceptions.push(exc);
    if (this.exceptions.length > MAX_ENTRIES) this.exceptions.shift();
    for (const cb of this.exceptionCallbacks.values()) {
      try { cb(exc); } catch { /* ignore */ }
    }
  }

  private serializeArg(arg: CdpRemoteObject): string {
    if (arg.unserializableValue) return arg.unserializableValue;
    if (arg.type === "string") return String(arg.value ?? "");
    if (arg.type === "number") return String(arg.value ?? arg.description ?? "");
    if (arg.type === "boolean") return String(arg.value ?? "");
    if (arg.type === "undefined") return "undefined";
    if (arg.type === "function") return `[Function ${arg.className ?? "anonymous"}]`;
    if (arg.type === "object") {
      if (arg.subtype === "null") return "null";
      if (arg.subtype === "array") return arg.description ?? "[Array]";
      if (arg.subtype === "date") return arg.description ?? "[Date]";
      if (arg.subtype === "error") return arg.description ?? "[Error]";
      if (arg.subtype === "regexp") return arg.description ?? "[RegExp]";
      // Try to show the value if it was returned by value
      if (arg.value !== undefined && arg.value !== null) {
        try { return JSON.stringify(arg.value); } catch { return arg.description ?? "[Object]"; }
      }
      return arg.description ?? arg.className ?? "[Object]";
    }
    return arg.description ?? String(arg.value ?? "");
  }
}
