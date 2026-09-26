// ============================================================================
// Unified DevTools API — single registration surface for plugins, games, and
// engine systems, regardless of which thread they run on.
//
// Realm detection determines transport:
//   - Main realm: panels/feeds/commands registered directly on
//     window.__sceneInspector via DevToolsDataBridge.
//   - Worker realm: panels/feeds/commands registered in a worker-side
//     registry. Data feeds are written to a devtools SAB region (zero-copy,
//     synchronous reads). Commands are forwarded via IPC RPC. Panel
//     declarations are synced to the renderer via a one-time manifest RPC.
//
// Plugins import `devtools` from @downdraft/engine/modules/devtools and call
// registerPanel/registerDataFeed/registerCommand/registerSABStat — the same
// API works in both realms.
// ============================================================================

import { resourceToken } from "@downdraft/engine/ecs/resource";
import { createLogger } from "@downdraft/engine/util/logger";
import type { DebugViewDescriptor } from "./debug-view-descriptors";
import { BUILTIN_VIEW_DESCRIPTORS } from "./debug-view-descriptors";
import type { IDevToolsOverlayToggle, IDevToolsPanelExtension } from "./types";

const log = createLogger("info");

// --- Realm detection ---
// Mirrors the pattern in @downdraft/engine/worker/rpc.ts but is self-contained
// so this package doesn't depend on core's worker module (avoids pulling
// Node worker_threads code into the renderer bundle).

function detectRealm(): "main" | "worker" {
  // Node.js worker_thread
  if (typeof (globalThis as any).process !== "undefined"
    && (globalThis as any).process.versions?.node
    && typeof (globalThis as any).require === "function") {
    try {
      const parentPort = (globalThis as any).require("worker_threads")?.parentPort;
      if (parentPort) return "worker";
    } catch { /* not in a Node worker */ }
  }
  // Web Worker: no window, has self/importScripts
  if (typeof (globalThis as any).window === "undefined"
    && typeof (globalThis as any).self !== "undefined"
    && typeof (globalThis as any).importScripts === "function") {
    return "worker";
  }
  return "main";
}

export const DEVTOOLS_REALM = detectRealm();

// --- SAB layout for worker→renderer data feeds ---
//
// The devtools SAB is a dedicated region for JSON-serialized data feed
// results + direct numeric stats. The worker writes; the renderer reads
// synchronously. No IPC polling needed.
//
// Layout:
//   [0..3]   manifestVersion: Uint32  (bumped when panels/feeds change)
//   [4..7]   feedCount: Uint32
//   [8..]    feed entries: each is [lengthBytes: Uint32][JSON bytes...]
//            (lengthBytes = 0 means "not yet written" / "unavailable")
//   ...      direct stat slots: registered via registerSABStat, read as
//            raw u32/f32/i32 at plugin-specified offsets (relative to the
//            statsBaseOffset returned by getDevToolsSABStatsBase)

export const DEVTOOLS_SAB_HEADER_BYTES = 8; // manifestVersion + feedCount
export const DEVTOOLS_SAB_MAX_FEEDS = 32;
export const DEVTOOLS_SAB_FEED_HEADER_BYTES = 4; // lengthBytes per feed
export const DEVTOOLS_SAB_DEFAULT_FEED_BLOB_BYTES = 4096;
export const DEVTOOLS_SAB_DEFAULT_STATS_BYTES = 256;

export interface DevToolsSABLayout {
  /** Byte offset of the feed entry for feed index i. */
  feedOffset(i: number): number;
  /** Byte offset of the JSON blob for feed index i. */
  feedBlobOffset(i: number): number;
  /** Max bytes per feed blob. */
  feedBlobBytes: number;
  /** Byte offset where direct stats start (after all feed blobs). */
  statsBaseOffset: number;
  /** Total SAB size. */
  totalBytes: number;
}

export function computeDevToolsSABLayout(
  maxFeedBlobBytes: number = DEVTOOLS_SAB_DEFAULT_FEED_BLOB_BYTES,
  statsBytes: number = DEVTOOLS_SAB_DEFAULT_STATS_BYTES,
): DevToolsSABLayout {
  const feedEntryBytes = DEVTOOLS_SAB_FEED_HEADER_BYTES + maxFeedBlobBytes;
  const feedsEnd = DEVTOOLS_SAB_HEADER_BYTES + feedEntryBytes * DEVTOOLS_SAB_MAX_FEEDS;
  const statsBaseOffset = feedsEnd;
  const totalBytes = statsBaseOffset + statsBytes;
  return {
    feedOffset: (i: number) => DEVTOOLS_SAB_HEADER_BYTES + i * feedEntryBytes,
    feedBlobOffset: (i: number) =>
      DEVTOOLS_SAB_HEADER_BYTES + i * feedEntryBytes + DEVTOOLS_SAB_FEED_HEADER_BYTES,
    feedBlobBytes: maxFeedBlobBytes,
    statsBaseOffset,
    totalBytes,
  };
}

export function allocateDevToolsSAB(
  maxFeedBlobBytes?: number,
  statsBytes?: number,
): SharedArrayBuffer {
  const layout = computeDevToolsSABLayout(maxFeedBlobBytes, statsBytes);
  return new SharedArrayBuffer(layout.totalBytes);
}

// --- Registration types ---

export interface DevToolsSABStat {
  name: string;
  /** Offset relative to the statsBaseOffset in the devtools SAB. */
  offset: number;
  type: "u32" | "f32" | "i32";
}

// --- The unified API ---

export interface DevToolsAPI {
  /** Current realm ("main" or "worker"). */
  readonly realm: "main" | "worker";

  // --- Panels & toggles (declarative, realm-transparent) ---
  registerPanel(ext: IDevToolsPanelExtension): void;
  registerOverlayToggle(toggle: IDevToolsOverlayToggle): void;

  // --- Data feeds (read by panel, realm chooses transport) ---
  // In main realm: fn is called directly when the panel queries __sceneInspector.
  // In worker realm: fn is called each tick (or at writeRate), result JSON-serialized
  //   to the devtools SAB. Renderer reads synchronously from SAB.
  registerDataFeed(name: string, fn: () => any, writeRateHz?: number): void;

  // --- Commands (write/trigger, always IPC in worker realm) ---
  // In main realm: fn is called directly.
  // In worker realm: fn is stored; renderer forwards calls via IPC RPC.
  registerCommand(name: string, fn: (...args: any[]) => any): void;

  // --- Direct SAB stats (high-frequency numerics, zero-cost reads) ---
  // In main realm: the value is read from the devtools SAB at statsBaseOffset + offset.
  // In worker realm: no-op (the worker already writes to SAB via writeStat).
  registerSABStat(name: string, offset: number, type: "u32" | "f32" | "i32"): void;

  // --- SAB management (worker realm) ---
  /** Attach a devtools SAB for writing data feeds. Worker realm only. */
  attachSAB(sab: SharedArrayBuffer, layout?: DevToolsSABLayout): void;
  /** Get the current devtools SAB (renderer reads from this). */
  getSAB(): SharedArrayBuffer | null;
  /** Get the SAB layout. */
  getSABLayout(): DevToolsSABLayout | null;

  // --- Profiling SAB management ---
  /** Attach the global ProfilingSAB (renderer realm). Shared with all workers. */
  attachProfilingSAB(sab: SharedArrayBuffer): void;
  /** Get the global ProfilingSAB (shared with the profiler overlay + workers). */
  getProfilingSAB(): SharedArrayBuffer | null;

  // --- Debug view registration ---
  /** Register a debug view descriptor (for the profiler overlay). */
  registerView(view: DebugViewDescriptor): void;
  /** Get all registered view descriptors (built-in + custom). */
  getViews(): DebugViewDescriptor[];

  // --- Manifest (renderer fetches from worker via IPC) ---
  /** Get the full manifest: panels, toggles, data feed names, commands, SAB stats. */
  getManifest(): DevToolsManifest;

  // --- Worker tick hook ---
  /** Called by the sim loop each tick to write data feeds to SAB. Worker realm only. */
  flushDataFeeds(): void;

  // --- Cleanup ---
  /** Clear all registrations (used on hot-reload / shutdown). */
  clear(): void;
}

export interface DevToolsManifest {
  panels: IDevToolsPanelExtension[];
  toggles: IDevToolsOverlayToggle[];
  dataFeeds: { name: string; feedIndex: number; writeRateHz: number }[];
  commands: string[];
  sabStats: DevToolsSABStat[];
  manifestVersion: number;
}

// --- Implementation ---

interface RegisteredDataFeed {
  name: string;
  fn: () => any;
  feedIndex: number;
  writeRateHz: number;
  lastWriteMs: number;
  hasWritten: boolean;
}

class DevToolsAPIImpl implements DevToolsAPI {
  readonly realm: "main" | "worker";

  private panels = new Map<string, IDevToolsPanelExtension>();
  private toggles = new Map<string, IDevToolsOverlayToggle>();
  private dataFeeds = new Map<string, RegisteredDataFeed>();
  private dataFeedNames: string[] = []; // ordered list for feedIndex assignment
  private commands = new Map<string, (...args: any[]) => any>();
  private sabStats = new Map<string, DevToolsSABStat>();

  private sab: SharedArrayBuffer | null = null;
  private sabLayout: DevToolsSABLayout | null = null;
  private sabU32: Uint32Array | null = null;
  private sabU8: Uint8Array | null = null;
  private sabF32: Float32Array | null = null;
  private sabI32: Int32Array | null = null;

  private profilingSAB: SharedArrayBuffer | null = null;
  private views = new Map<string, DebugViewDescriptor>();

  private manifestVersion = 0;

  constructor(realm: "main" | "worker") {
    this.realm = realm;
  }

  registerPanel(ext: IDevToolsPanelExtension): void {
    this.panels.set(ext.id, ext);
    this.bumpManifest();
  }

  registerOverlayToggle(toggle: IDevToolsOverlayToggle): void {
    this.toggles.set(toggle.id, toggle);
    this.bumpManifest();
  }

  registerDataFeed(name: string, fn: () => any, writeRateHz: number = 10): void {
    if (this.dataFeeds.has(name)) {
      // Update fn/rate, keep feedIndex and hasWritten
      const existing = this.dataFeeds.get(name)!;
      this.dataFeeds.set(name, { ...existing, fn, writeRateHz });
      return;
    }
    const feedIndex = this.dataFeedNames.length;
    if (feedIndex >= DEVTOOLS_SAB_MAX_FEEDS) {
      log.warn("devtools", `Max data feeds (${DEVTOOLS_SAB_MAX_FEEDS}) reached, ignoring "${name}"`);
      return;
    }
    this.dataFeedNames.push(name);
    this.dataFeeds.set(name, { name, fn, feedIndex, writeRateHz, lastWriteMs: 0, hasWritten: false });
    this.bumpManifest();
  }

  registerCommand(name: string, fn: (...args: any[]) => any): void {
    this.commands.set(name, fn);
    this.bumpManifest();
  }

  registerSABStat(name: string, offset: number, type: "u32" | "f32" | "i32"): void {
    // All stat types are 4 bytes and read via typed-array views — offsets
    // must be 4-byte aligned and unique, or two stats silently stomp each
    // other's values (there is no allocator for this region).
    if (!Number.isInteger(offset) || offset < 0 || offset % 4 !== 0) {
      log.warn("devtools", `registerSABStat("${name}"): offset ${offset} must be a non-negative 4-byte-aligned integer — ignoring`);
      return;
    }
    for (const existing of this.sabStats.values()) {
      if (existing.name !== name && existing.offset === offset) {
        log.warn("devtools", `registerSABStat("${name}"): offset ${offset} is already used by stat "${existing.name}" — ignoring (duplicate offset)`);
        return;
      }
    }
    this.sabStats.set(name, { name, offset, type });
    this.bumpManifest();
  }

  attachSAB(sab: SharedArrayBuffer, layout?: DevToolsSABLayout): void {
    this.sab = sab;
    this.sabLayout = layout ?? computeDevToolsSABLayout();
    this.sabU32 = new Uint32Array(sab);
    this.sabU8 = new Uint8Array(sab);
    this.sabF32 = new Float32Array(sab);
    this.sabI32 = new Int32Array(sab);
    // Write initial manifest version + feed count
    if (this.sabU32) {
      this.sabU32[0] = this.manifestVersion;
      this.sabU32[1] = this.dataFeedNames.length;
    }
  }

  getSAB(): SharedArrayBuffer | null {
    return this.sab;
  }

  getSABLayout(): DevToolsSABLayout | null {
    return this.sabLayout;
  }

  attachProfilingSAB(sab: SharedArrayBuffer): void {
    this.profilingSAB = sab;
  }

  getProfilingSAB(): SharedArrayBuffer | null {
    return this.profilingSAB;
  }

  registerView(view: DebugViewDescriptor): void {
    this.views.set(view.id, view);
    this.bumpManifest();
  }

  getViews(): DebugViewDescriptor[] {
    // Merge built-in views with custom ones (custom takes precedence on id collision)
    const merged = new Map<string, DebugViewDescriptor>();
    BUILTIN_VIEW_DESCRIPTORS.forEach((v) => { merged.set(v.id, v);; });
    for (const v of this.views.values()) merged.set(v.id, v);
    return Array.from(merged.values()).sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  }

  getManifest(): DevToolsManifest {
    return {
      panels: Array.from(this.panels.values()),
      toggles: Array.from(this.toggles.values()),
      dataFeeds: this.dataFeedNames.map((name, i) => ({
        name,
        feedIndex: i,
        writeRateHz: this.dataFeeds.get(name)?.writeRateHz ?? 10,
      })),
      commands: Array.from(this.commands.keys()),
      sabStats: Array.from(this.sabStats.values()),
      manifestVersion: this.manifestVersion,
    };
  }

  flushDataFeeds(): void {
    // Works in any realm — writes to SAB if attached. The sim loop only
    // calls this in the worker realm, but it's also used in tests.
    if (!this.sab || !this.sabLayout || !this.sabU32 || !this.sabU8) return;

    const now = performance.now();
    for (const feed of this.dataFeeds.values()) {
      // writeRateHz = 0 means "flush every call" (no rate limiting)
      const intervalMs = feed.writeRateHz > 0 ? 1000 / feed.writeRateHz : 0;
      // Always write the first time; after that, respect rate limiting
      if (feed.hasWritten && intervalMs > 0 && (now - feed.lastWriteMs) < intervalMs) continue;
      feed.lastWriteMs = now;
      feed.hasWritten = true;

      try {
        const result = feed.fn();
        const json = JSON.stringify(result);
        const jsonBytes = new TextEncoder().encode(json);
        const blobOffset = this.sabLayout.feedBlobOffset(feed.feedIndex);
        const maxBytes = this.sabLayout.feedBlobBytes;

        if (jsonBytes.length > maxBytes) {
          // Truncate: write a marker so the renderer knows it's truncated
          this.sabU32[this.sabLayout.feedOffset(feed.feedIndex) / 4] = 0xFFFFFFFF;
          continue;
        }

        // Write length (in bytes) followed by the JSON blob
        this.sabU32[this.sabLayout.feedOffset(feed.feedIndex) / 4] = jsonBytes.length;
        this.sabU8.set(jsonBytes, blobOffset);
      } catch (e) {
        // Write 0 length = "error/unavailable"
        this.sabU32[this.sabLayout.feedOffset(feed.feedIndex) / 4] = 0;
      }
    }
  }

  /** Read a data feed from the SAB (renderer-side). Returns parsed JSON or null. */
  readDataFeed(feedIndex: number): any {
    if (!this.sab || !this.sabLayout || !this.sabU32 || !this.sabU8) return null;
    const entryOffset = this.sabLayout.feedOffset(feedIndex) / 4;
    const lengthBytes = this.sabU32[entryOffset];
    if (lengthBytes === 0 || lengthBytes === 0xFFFFFFFF) return null;
    const blobOffset = this.sabLayout.feedBlobOffset(feedIndex);
    const jsonBytes = this.sabU8.subarray(blobOffset, blobOffset + lengthBytes);
    try {
      const json = new TextDecoder().decode(jsonBytes);
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /** Read a SAB stat (renderer-side). */
  readSABStat(name: string): number | null {
    const stat = this.sabStats.get(name);
    if (!stat || !this.sab || !this.sabLayout || !this.sabU32 || !this.sabF32 || !this.sabI32) return null;
    const byteOffset = this.sabLayout.statsBaseOffset + stat.offset;
    switch (stat.type) {
      case "u32": return this.sabU32[byteOffset / 4];
      case "f32": return this.sabF32[byteOffset / 4];
      case "i32": return this.sabI32[byteOffset / 4];
    }
  }

  /** Call a command (renderer-side, for worker realm commands forwarded via IPC). */
  callCommand(name: string, args: any[]): any {
    const fn = this.commands.get(name);
    if (!fn) throw new Error(`Unknown devtools command: ${name}`);
    return fn(...args);
  }

  /** Get data feed function (main realm — called directly). */
  getDataFeedFn(name: string): (() => any) | null {
    return this.dataFeeds.get(name)?.fn ?? null;
  }

  /** Get SAB stat names (for renderer to wire read methods). */
  getSABStatNames(): string[] {
    return Array.from(this.sabStats.keys());
  }

  clear(): void {
    this.panels.clear();
    this.toggles.clear();
    this.dataFeeds.clear();
    this.dataFeedNames = [];
    this.commands.clear();
    this.sabStats.clear();
    this.views.clear();
    this.profilingSAB = null;
    this.bumpManifest();
  }

  private bumpManifest(): void {
    this.manifestVersion++;
    if (this.sabU32) {
      this.sabU32[0] = this.manifestVersion;
      this.sabU32[1] = this.dataFeedNames.length;
    }
  }
}

// --- Singleton ---

const _devtools = new DevToolsAPIImpl(DEVTOOLS_REALM);

/**
 * Unified DevTools API. Auto-detects realm (main vs worker) and chooses
 * the appropriate transport for data feeds (direct call vs SAB) and
 * commands (direct call vs IPC forwarding).
 *
 * Plugins import this and call registerPanel/registerDataFeed/registerCommand.
 * The same code works in both realms.
 */
export const devtools: DevToolsAPI = _devtools;

/**
 * DI token for the DevTools API. `initDevTools()` provides this into the
 * renderer module host (`provideExternal`), so engine libraries can declare
 * it in `requires`/inject it via `ctx.injectOptional(DevToolsAPITok)` instead
 * of importing the `devtools` singleton — keeps library code testable and
 * realm-correct.
 */
export const DevToolsAPITok = resourceToken<DevToolsAPI>("devtools:api");

/** @internal — exposed for the renderer bridge to access impl methods. */
export const _devtoolsImpl = _devtools;
