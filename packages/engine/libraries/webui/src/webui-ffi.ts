// ============================================================================
// webui-ffi.ts — runtime-agnostic FFI binding for the dd_webui_* cdylibs
// (libraries/webui/native-cef, libraries/webui/native-wpe). Native-only —
// import via the "@downdraft/engine/libraries/webui" subpath so it never
// enters a web bundle (mirrors native-osr-ffi.ts).
//
// One ABI, two backends: libdowndraft_webui_cef (Chromium OSR, desktop)
// and libdowndraft_webui_wpe (embedded WebKit, linux + android). Both
// produce BGRA8 frames and share the same view/lifecycle/input/event
// contract; the loader picks the cdylib by backend resolution
// (resolveWebUiBackend).
// ============================================================================

import { findPackageRoot } from "@downdraft/engine/platform/pkg-root";
import { dlopen, ptr, readMappedRange, type CFunction } from "@downdraft/platform-native/ffi/ffi-adapter";
import { resolveNativeLibrary } from "@downdraft/platform-native/ffi/lib-paths";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WebUiBackend, WebUiEvent, WebUiViewStatus } from "./types";

// import.meta.url is per-module (correct in every context); the __dirname
// global is the ENTRY file's dir under bun/node — wrong for library code —
// and a bunfs virtual path under `bun build --compile` bundles, where the
// crateDir probe is irrelevant anyway (packaged candidates still hit).
const _dirname = (() => {
  try {
    const p = fileURLToPath(import.meta.url);
    if (p && !p.includes("~BUN")) return dirname(p);
  } catch { /* non-file URL — bundled */ }
  return typeof (globalThis as any).__dirname !== "undefined"
    ? (globalThis as any).__dirname
    : "";
})();

const LIB_NAME: Record<WebUiBackend, string> = {
  cef: "downdraft_webui_cef",
  wpe: "downdraft_webui_wpe",
};

const ENV_VAR: Record<WebUiBackend, string[]> = {
  cef: ["DD_WEBUI_CEF_LIB", "DOWNDRAFT_WEBUI_LIB"],
  wpe: ["DD_WEBUI_WPE_LIB", "DOWNDRAFT_WEBUI_LIB"],
};

function findWebUiLibrary(backend: WebUiBackend): string | null {
  return resolveNativeLibrary(LIB_NAME[backend], {
    envVars: ENV_VAR[backend],
    crateDir: join(findPackageRoot(_dirname), "libraries", "webui", `native-${backend}`),
    optional: true,
  });
}

// ── Backend resolution ──
//
// Precedence (documented in libraries/webui/README + the webui plan):
//   1. createWebUi({ backend }) — the caller passes `explicit` here
//   2. DD_WEBUI_BACKEND env ("cef" | "wpe" | "none" | "auto")
//   3. downdraft.config.json webui.backend — the dev/release shell reads
//      the config and re-exports it as DD_WEBUI_BACKEND, so by the time a
//      game boots only env remains
//   4. --webui= CLI flag — same mechanism (forwarded into env)
//   5. platform default: cef on desktop, wpe on android
// "none" → null (the module stays a no-op instead of crashing).

export function resolveWebUiBackend(explicit?: WebUiBackend | "auto" | "none" | null): WebUiBackend | null {
  const want = explicit ?? (typeof process !== "undefined" ? process.env?.DD_WEBUI_BACKEND : undefined);
  if (want === "none") return null;
  if (want === "cef" || want === "wpe") return want;
  if (typeof process !== "undefined" && process.platform === "android") return "wpe";
  return "cef";
}

// ── FFI symbol table ──
//
// ABI conventions:
//  - handles are opaque `*mut View` pointers
//  - strings are `cstring` (null-terminated UTF-8; the adapter converts
//    JS strings/buffers per runtime)
//  - `dd_webui_poll_events` out-params are (ptr*, usize*) — we pass
//    scratch buffers the adapter exposes as ptrs
//  - buttons use DOM numbering: 0=left, 1=middle, 2=right
//  - input-pointer `t`: 0=move 1=down 2=up 3=leave
//  - coordinates are view-local logical px (the native side × scale)
//  - packed frame rect u64: x<<48 | y<<32 | w<<16 | h (same as dd_osr_)
const WEBUI_SPEC: Record<string, CFunction> = {
  // ── Process lifecycle ──
  dd_webui_global_init: { args: ["cstring"], returns: "i32" },
  dd_webui_global_shutdown: { args: [], returns: "void" },
  dd_webui_backend: { args: [], returns: "cstring" },
  dd_webui_version: { args: [], returns: "cstring" },
  dd_webui_pump_ms: { args: ["u64"], returns: "void" },
  // ── View lifecycle ──
  dd_webui_create: { args: ["cstring", "i32", "i32", "f32"], returns: "ptr" },
  dd_webui_destroy: { args: ["ptr"], returns: "void" },
  // ── Navigation / content ──
  dd_webui_load_url: { args: ["ptr", "cstring"], returns: "void" },
  dd_webui_set_content: { args: ["ptr", "cstring"], returns: "void" },
  dd_webui_resize: { args: ["ptr", "i32", "i32", "f32"], returns: "void" },
  dd_webui_navigate: { args: ["ptr", "i32"], returns: "void" },
  dd_webui_set_zoom: { args: ["ptr", "f64"], returns: "void" },
  dd_webui_set_focus: { args: ["ptr", "i32"], returns: "void" },
  dd_webui_set_interactive: { args: ["ptr", "i32"], returns: "void" },
  // ── JS bridge ──
  dd_webui_eval: { args: ["ptr", "u64", "cstring"], returns: "void" },
  dd_webui_post_message: { args: ["ptr", "cstring"], returns: "void" },
  dd_webui_poll_events: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  // ── Input ──
  dd_webui_input_pointer: { args: ["ptr", "i32", "f32", "f32", "i32"], returns: "void" },
  dd_webui_input_wheel: { args: ["ptr", "f32", "f32", "f32", "f32"], returns: "void" },
  dd_webui_input_key: { args: ["ptr", "i32", "cstring", "cstring", "cstring", "i32", "i32"], returns: "void" },
  dd_webui_input_touch: { args: ["ptr", "i32", "i32", "f32", "f32"], returns: "void" },
  dd_webui_input_ime: { args: ["ptr", "i32", "cstring"], returns: "void" },
  // ── Frames ──
  dd_webui_take_frame: { args: ["ptr"], returns: "u64" },
  dd_webui_frame_rect: { args: ["ptr"], returns: "u64" },
  dd_webui_frame_pending: { args: ["ptr"], returns: "i32" },
  dd_webui_pixels: { args: ["ptr"], returns: "ptr" },
  dd_webui_pixels_len: { args: ["ptr"], returns: "usize" },
  dd_webui_dimensions: { args: ["ptr", "ptr", "ptr"], returns: "i32" },
  dd_webui_pixel_format: { args: ["ptr"], returns: "u8" },
  // ── Shared-memory frame channel (same header contract as dd_osr_*) ──
  dd_webui_buf_needed: { args: ["ptr"], returns: "usize" },
  dd_webui_bind_frame_buf: { args: ["ptr", "ptr", "usize"], returns: "i32" },
  dd_webui_frame_into: { args: ["ptr"], returns: "i32" },
  dd_webui_refresh_into: { args: ["ptr"], returns: "i32" },
  // ── Hit test / status ──
  dd_webui_hit_test: { args: ["ptr", "f32", "f32"], returns: "i32" },
  dd_webui_status: { args: ["ptr"], returns: "i32" },
  dd_webui_crash_count: { args: ["ptr"], returns: "usize" },
  dd_webui_recover: { args: ["ptr"], returns: "i32" },
  dd_webui_set_crash_policy: { args: ["ptr", "i32"], returns: "void" },
};

export type WebUiSymbols = Record<keyof typeof WEBUI_SPEC, (...args: any[]) => any>;

interface LoadedLib { symbols: WebUiSymbols; path: string }

const cache = new Map<WebUiBackend, LoadedLib | null>();
/** dlopen failure detail for diagnostics — a missing artifact returns null
 *  silently, but a found artifact that fails to load should say why. */
const loadErrors = new Map<WebUiBackend, string>();

/** dlopen the backend's cdylib. Returns null when the artifact is absent
 *  (not built / not staged / backend not packaged) so hosts degrade
 *  gracefully instead of crashing. */
export function loadWebUiLib(backend: WebUiBackend): LoadedLib | null {
  if (cache.has(backend)) return cache.get(backend)!;
  const path = findWebUiLibrary(backend);
  if (!path) { cache.set(backend, null); return null; }
  try {
    const symbols = dlopen(path, WEBUI_SPEC).symbols as WebUiSymbols;
    const entry = { symbols, path };
    cache.set(backend, entry);
    return entry;
  } catch (e) {
    loadErrors.set(backend, `${path}: ${(e as Error).message ?? e}`);
    cache.set(backend, null);
    return null;
  }
}

/** Why the last loadWebUiLib() returned null for a found artifact. */
export function webUiLoadError(backend: WebUiBackend): string | null {
  return loadErrors.get(backend) ?? null;
}

/** Global init options handed to dd_webui_global_init as JSON. */
export interface WebUiGlobalInitOpts {
  /** CEF: directory containing libcef.so + runtime resources (resolved by
   *  the host from the vendored/packaged runtime when unset). */
  cefDir?: string;
  /** WPE: install prefix containing libWPEWebKit + GIO modules. */
  wpePrefix?: string;
  /** CEF: path to the render/GPU-process helper binary (staged next to the
   *  cdylib as downdraft_cef_helper). */
  helperPath?: string;
  /** Cache/data dir (profile). Defaults to a temp profile per run. */
  cachePath?: string;
  userAgent?: string;
  /** CEF: use CefDoMessageLoopWork instead of the internal message loop —
   *  the host then calls pumpMs() from the winit loop. */
  externalMessagePump?: boolean;
  /** WPE: force the headless platform (default true for OSR embedding). */
  headless?: boolean;
  /** DevTools/inspector remote-debugging port (0 = off). */
  remoteDebugPort?: number;
  /** Backend log verbosity — 0=verbose, 1=info, 3=error, 4=fatal (default
   *  warning). CEF writes to <cachePath>/chrome_debug.log. */
  logLevel?: number;
}

/** One global init per backend — views can't be created before it runs. */
const initialized = new Set<WebUiBackend>();

export function webUiGlobalInit(backend: WebUiBackend, opts: WebUiGlobalInitOpts): boolean {
  if (initialized.has(backend)) return true;
  const entry = loadWebUiLib(backend);
  if (!entry) return false;
  const rc = entry.symbols.dd_webui_global_init(JSON.stringify(opts)) as number;
  if (rc === 0) initialized.add(backend);
  return rc === 0;
}

export function webUiGlobalShutdown(backend: WebUiBackend): void {
  const entry = loadWebUiLib(backend);
  if (!entry || !initialized.has(backend)) return;
  entry.symbols.dd_webui_global_shutdown();
  initialized.delete(backend);
}

// ── Per-view handle ──

const STATUS_MAP: Record<number, WebUiViewStatus> = {
  0: "running", 1: "crashed", 2: "recovering", 3: "failed",
};

// Scratch out-params for poll_events/dimensions — 16 bytes covers
// (ptr, usize) pairs on every supported platform. scratch8 is a view over
// the second 8 bytes so ptr() yields the offset address.
const scratch = new Uint8Array(16);
const scratch8 = new Uint8Array(scratch.buffer, 8, 8);
const dec = new TextDecoder();

/** DOM-button name → DOM button number (matches `MouseEvent.button`). */
function domButton(b?: "left" | "middle" | "right"): number {
  // ABI numbering (not DOM): 0=none 1=left 2=middle 3=right
  return b === "right" ? 3 : b === "middle" ? 2 : 1;
}

/** Modifier names → the i32 bitmask the ABI expects (1=shift 2=ctrl 4=alt 8=meta). */
function modBits(mods?: string[]): number {
  let bits = 0;
  (mods ?? []).forEach((m) => {
    const k = m.toLowerCase();
    if (k === "shift") bits |= 1;
    else if (k === "control" || k === "ctrl") bits |= 2;
    else if (k === "alt") bits |= 4;
    else if (k === "meta" || k === "super" || k === "cmd") bits |= 8;
  });
  return bits;
}

/** Byte offset of the pixel region inside a bound frame buffer. */
export const WEBUI_FRAME_HEADER = 64;

/** Packed frame-rect u64 → {x,y,w,h}; null for empty rects. */
function unpackRect(v: bigint): { x: number; y: number; w: number; h: number } | null {
  const x = Number(v >> 48n), y = Number((v >> 32n) & 0xffffn);
  const w = Number((v >> 16n) & 0xffffn), h = Number(v & 0xffffn);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

/** Typed handle over one browser view. */
export class WebUIView {
  private handle: number | bigint;
  private lib: WebUiSymbols;
  readonly backend: WebUiBackend;
  /** Dirty union of the frame pullFrame() last produced — frameRect()
   *  reports this (mirroring the "rect of the frame pullFrame just
   *  produced" contract the OSR host documents). */
  private lastDirty: { x: number; y: number; w: number; h: number } | null = null;
  /** Logical px dimensions (updated on resize). */
  width: number;
  height: number;
  scale: number;

  private constructor(lib: WebUiSymbols, backend: WebUiBackend, handle: number | bigint, w: number, h: number, scale: number) {
    this.lib = lib;
    this.backend = backend;
    this.handle = handle;
    this.width = w;
    this.height = h;
    this.scale = scale;
  }

  static create(
    backend: WebUiBackend,
    opts: { url?: string; html?: string; transparent?: boolean; interactive?: boolean; frameRate?: number; userAgent?: string; maxCrashRetries?: number; pullOnly?: boolean },
    width: number,
    height: number,
    scale = 1,
  ): WebUIView | null {
    const entry = loadWebUiLib(backend);
    if (!entry) return null;
    const h = entry.symbols.dd_webui_create(
      JSON.stringify(opts), width | 0, height | 0, scale,
    ) as number | bigint;
    if (!h) return null;
    const v = new WebUIView(entry.symbols, backend, h, width, height, scale);
    if (opts.maxCrashRetries !== undefined) v.setCrashPolicy(opts.maxCrashRetries);
    return v;
  }

  destroy(): void {
    this.lib.dd_webui_destroy(this.handle);
  }

  loadUrl(url: string): void {
    this.lib.dd_webui_load_url(this.handle, url);
  }

  setContent(html: string): void {
    this.lib.dd_webui_set_content(this.handle, html);
  }

  resize(width: number, height: number, scale = this.scale): void {
    this.lib.dd_webui_resize(this.handle, width | 0, height | 0, scale);
    this.width = width;
    this.height = height;
    this.scale = scale;
  }

  navigate(op: "back" | "forward" | "reload" | "stop"): void {
    const ops = { back: 0, forward: 1, reload: 2, stop: 3 } as const;
    this.lib.dd_webui_navigate(this.handle, ops[op]);
  }

  setZoom(factor: number): void {
    this.lib.dd_webui_set_zoom(this.handle, factor);
  }

  setFocus(focused: boolean): void {
    this.lib.dd_webui_set_focus(this.handle, focused ? 1 : 0);
  }

  setInteractive(on: boolean): void {
    this.lib.dd_webui_set_interactive(this.handle, on ? 1 : 0);
  }

  // ── JS bridge ──

  /** Fire-and-forget eval — the result arrives as an {t:"eval"} event. */
  eval(req: number, js: string): void {
    this.lib.dd_webui_eval(this.handle, BigInt(req), js);
  }

  postMessage(payload: unknown): void {
    this.lib.dd_webui_post_message(this.handle, JSON.stringify(payload ?? null));
  }

  /** Drain queued events (message/eval/console/cursor/status/nav). */
  pollEvents(): WebUiEvent[] {
    const n = this.lib.dd_webui_poll_events(this.handle, ptr(scratch), ptr(scratch8)) as number;
    if (n <= 0) return [];
    const dv = new DataView(scratch.buffer);
    const p = dv.getBigUint64(0, true);
    const len = Number(dv.getBigUint64(8, true));
    if (!p || len <= 0) return [];
    try {
      return JSON.parse(dec.decode(readMappedRange(p, len))) as WebUiEvent[];
    } catch {
      return [];
    }
  }

  // ── Input ──

  pointerMove(x: number, y: number): void {
    this.lib.dd_webui_input_pointer(this.handle, 0, x, y, 0);
  }

  pointerDown(x: number, y: number, button?: "left" | "middle" | "right"): void {
    this.lib.dd_webui_input_pointer(this.handle, 1, x, y, domButton(button));
  }

  pointerUp(x: number, y: number, button?: "left" | "middle" | "right"): void {
    this.lib.dd_webui_input_pointer(this.handle, 2, x, y, domButton(button));
  }

  pointerLeave(x = 0, y = 0): void {
    this.lib.dd_webui_input_pointer(this.handle, 3, x, y, 0);
  }

  wheel(x: number, y: number, deltaX: number, deltaY: number): void {
    this.lib.dd_webui_input_wheel(this.handle, x, y, deltaX, deltaY);
  }

  key(down: boolean, key: string, code?: string, text?: string, mods?: string[], repeat = false): void {
    this.lib.dd_webui_input_key(
      this.handle, down ? 0 : 1, key ?? "", code ?? "", text ?? "",
      modBits(mods), repeat ? 1 : 0,
    );
  }

  touch(type: "down" | "move" | "up" | "cancel", id: number, x: number, y: number): void {
    const t = { down: 0, move: 1, up: 2, cancel: 3 } as const;
    this.lib.dd_webui_input_touch(this.handle, t[type], id | 0, x, y);
  }

  ime(type: "preedit" | "commit" | "cancel", text: string): void {
    const t = { preedit: 0, commit: 1, cancel: 2 } as const;
    this.lib.dd_webui_input_ime(this.handle, t[type], text);
  }

  // ── Frames ──

  /**
   * Pull a dirty frame — returns the full pixel buffer when the dirty flag
   * was set (and clears it), else null. Frame size is
   * width*scale × height*scale × 4 bytes, format per pixelFormat().
   */
  pullFrame(): Uint8Array | null {
    const dirty = BigInt(this.lib.dd_webui_take_frame(this.handle) as bigint | number);
    if (!dirty) return null;
    this.lastDirty = unpackRect(dirty);
    const p = this.lib.dd_webui_pixels(this.handle) as number | bigint;
    const len = Number(this.lib.dd_webui_pixels_len(this.handle));
    if (!p || len <= 0) return null;
    return readMappedRange(p, len);
  }

  /** Dirty union of the frame pullFrame() last produced — null when the
   *  last pull was a full frame or nothing has been pulled yet. */
  frameRect(): { x: number; y: number; w: number; h: number } | null {
    return this.lastDirty;
  }

  /** Dirty union the NEXT pull will produce — peeks without consuming. */
  peekRect(): { x: number; y: number; w: number; h: number } | null {
    const v = BigInt(this.lib.dd_webui_frame_rect(this.handle) as bigint | number);
    return unpackRect(v);
  }

  pending(): boolean {
    return (this.lib.dd_webui_frame_pending(this.handle) as number) !== 0;
  }

  dimensions(): { w: number; h: number } | null {
    // Out-params are *mut u32 — two u32 writes into scratch[0] and scratch[8].
    if ((this.lib.dd_webui_dimensions(this.handle, ptr(scratch), ptr(scratch8)) as number) !== 1) return null;
    const dv = new DataView(scratch.buffer);
    const w = dv.getUint32(0, true);
    const h = dv.getUint32(8, true);
    return w > 0 && h > 0 ? { w, h } : null;
  }

  pixelFormat(): "rgba" | "bgra" {
    return (this.lib.dd_webui_pixel_format(this.handle) as number) === 0 ? "rgba" : "bgra";
  }

  // ── Zero-copy frame channel ──

  bufNeeded(): number {
    return Number(this.lib.dd_webui_buf_needed(this.handle));
  }

  bindFrameBuf(sab: SharedArrayBuffer): boolean {
    const view = new Uint8Array(sab);
    return (this.lib.dd_webui_bind_frame_buf(this.handle, ptr(view), view.byteLength) as number) === 1;
  }

  frameInto(): number {
    return this.lib.dd_webui_frame_into(this.handle) as number;
  }

  refreshInto(): number {
    return this.lib.dd_webui_refresh_into(this.handle) as number;
  }

  // ── Hit test / status ──

  hitTest(x: number, y: number): boolean {
    return (this.lib.dd_webui_hit_test(this.handle, x, y) as number) === 1;
  }

  status(): WebUiViewStatus {
    const s = this.lib.dd_webui_status(this.handle) as number;
    return STATUS_MAP[s] ?? "failed";
  }

  crashCount(): number {
    return Number(this.lib.dd_webui_crash_count(this.handle));
  }

  recover(): boolean {
    return (this.lib.dd_webui_recover(this.handle) as number) === 0;
  }

  setCrashPolicy(maxRetries: number): void {
    this.lib.dd_webui_set_crash_policy(this.handle, maxRetries | 0);
  }
}

