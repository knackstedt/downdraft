// ============================================================================
// native-osr-ffi.ts — bun:ffi binding for the downdraft-blitz-osr cdylib
// (libraries/blitz-ui/native-osr). Native-only — import via the
// "@downdraft/engine/libraries/blitz-ui/native-osr-ffi" subpath so it never
// enters a web bundle (mirrors native-module.ts).
//
// One `OsrDoc` = one Blitz HtmlDocument + vello_cpu rasterizer. The platform
// host (platform-native/src/osr) owns documents per OSR renderer and pulls
// dirty RGBA frames; the renderer side (modules/native-osr) uploads them to
// GPU textures.
// ============================================================================

import { dlopen, ptr, readMappedRange, resolveNativeLibrary, type CFunction } from "@downdraft/platform-native";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname =
  typeof (globalThis as any).__dirname !== "undefined"
    ? (globalThis as any).__dirname
    : dirname(fileURLToPath(import.meta.url));

function findOsrLibrary(): string | null {
  return resolveNativeLibrary("downdraft_blitz_osr", {
    envVars: ["DOWNDRAFT_OSR_LIB"],
    crateDir: join(_dirname, "..", "native-osr"),
    optional: true,
  });
}

// ── FFI symbol table ──
//
// ABI conventions:
//  - handles are opaque `*mut OsrDoc` pointers
//  - strings are (ptr, len) UTF-8 pairs
//  - `mods` is a u32 bitmask: bit0=shift, bit1=ctrl, bit2=alt, bit3=meta
//  - `button` uses DOM numbering: 0=left, 1=middle, 2=right
//  - coordinates are physical px (doc CSS px at scale 1)
const OSR_SPEC: Record<string, CFunction> = {
  dd_osr_init: { args: ["f64", "f64", "f64", "ptr", "usize"], returns: "ptr" },
  dd_osr_set_html: { args: ["ptr", "ptr", "usize"], returns: "i32" },
  dd_osr_frame: { args: ["ptr"], returns: "ptr" },
  dd_osr_pixels_len: { args: ["ptr"], returns: "usize" },
  dd_osr_resize: { args: ["ptr", "f64", "f64", "f64"], returns: "i32" },
  dd_osr_pointer: { args: ["ptr", "i32", "f64", "f64", "i32", "u32"], returns: "i32" },
  dd_osr_wheel: { args: ["ptr", "f64", "f64", "f64", "f64", "u32"], returns: "i32" },
  dd_osr_key: { args: ["ptr", "i32", "ptr", "usize", "ptr", "usize", "ptr", "usize", "u32"], returns: "i32" },
  dd_osr_hit_test: { args: ["ptr", "f64", "f64"], returns: "i32" },
  dd_osr_destroy: { args: ["ptr"], returns: "i32" },
  // ── Frame metadata / refresh control ──
  dd_osr_frame_rect: { args: ["ptr"], returns: "u64" },
  dd_osr_pending: { args: ["ptr"], returns: "i32" },
  // ── Zero-copy frame channel (SharedArrayBuffer staging) ──
  dd_osr_buf_needed: { args: ["ptr"], returns: "usize" },
  dd_osr_bind_frame_buf: { args: ["ptr", "ptr", "usize"], returns: "i32" },
  dd_osr_frame_into: { args: ["ptr"], returns: "i32" },
  dd_osr_refresh_into: { args: ["ptr"], returns: "i32" },
  // ── Per-frame instrumentation ──
  dd_osr_last_stats: { args: ["ptr"], returns: "ptr" },
  // ── Layout query ──
  dd_osr_node_rect: { args: ["ptr", "u64"], returns: "ptr" },
  // ── DOM event queue ──
  dd_osr_poll_events: { args: ["ptr"], returns: "ptr" },
  dd_osr_events_len: { args: ["ptr"], returns: "usize" },
  // ── Incremental DOM mutation ──
  dd_osr_query: { args: ["ptr", "ptr", "usize"], returns: "u64" },
  dd_osr_set_text: { args: ["ptr", "u64", "ptr", "usize"], returns: "i32" },
  dd_osr_set_attr: { args: ["ptr", "u64", "ptr", "usize", "ptr", "usize"], returns: "i32" },
  dd_osr_remove_attr: { args: ["ptr", "u64", "ptr", "usize"], returns: "i32" },
  dd_osr_set_style: { args: ["ptr", "u64", "ptr", "usize", "ptr", "usize"], returns: "i32" },
  dd_osr_set_inner_html: { args: ["ptr", "u64", "ptr", "usize"], returns: "i32" },
  dd_osr_get_attr: { args: ["ptr", "u64", "ptr", "usize"], returns: "ptr" },
  dd_osr_out_len: { args: ["ptr"], returns: "usize" },
  dd_osr_focus: { args: ["ptr", "u64"], returns: "i32" },
  dd_osr_focused_node: { args: ["ptr"], returns: "u64" },
  dd_osr_query_all: { args: ["ptr", "ptr", "usize"], returns: "ptr" },
  dd_osr_query_all_len: { args: ["ptr"], returns: "usize" },
  dd_osr_closest: { args: ["ptr", "u64", "ptr", "usize"], returns: "u64" },
  dd_osr_scroll_into_view: { args: ["ptr", "u64", "i32", "i32", "i32"], returns: "i32" },
  dd_osr_scroll_to: { args: ["ptr", "u64", "f64", "f64", "i32"], returns: "i32" },
  // ── Process-wide ui:// resources (fonts, images, stylesheets) ──
  dd_osr_register_resource: { args: ["ptr", "usize", "ptr", "usize"], returns: "i32" },
};

export type OsrSymbols = Record<keyof typeof OSR_SPEC, (...args: any[]) => any>;

/** One DOM event emitted by a document — see events.rs for the field schema. */
export interface OsrDomEvent {
  /** Event type: "click" | "mousedown" | "input" | "keydown" | "scroll" | ... */
  t: string;
  /** Target node id (raw u64, matches query() results). */
  n: number;
  g?: string;               // target element tag name ("input", "button", ...)
  x?: number; y?: number;   // pointer coords (logical px)
  b?: number;               // button (DOM numbering)
  m?: number;               // modifier bitmask (shift=1 ctrl=2 alt=4 meta=8)
  k?: string; c?: string;   // key / code (keyboard events)
  v?: string;               // value (input events)
  st?: number; sl?: number; // scroll offsets
  id?: string;              // first non-empty id attr on target→ancestors
  d?: Record<string, string>; // merged data-* attrs (prefix stripped)
}

/**
 * Register a process-wide `ui://` resource served to every document's
 * NetProvider — fonts (@font-face src), images (<img src>), stylesheets.
 */
export function registerOsrResource(url: string, bytes: Uint8Array | ArrayBuffer): boolean {
  const entry = loadOsrLib();
  if (!entry) return false;
  const u = enc.encode(url);
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (entry.symbols.dd_osr_register_resource(
    ptr(u), u.length, ptr(b.length ? b : EMPTY_STR), b.length,
  ) as number) === 0;
}

let cached: { symbols: OsrSymbols; path: string } | null = null;

/** dlopen the Blitz OSR cdylib. Returns null when the artifact is absent
 *  (not built / not staged) so hosts can disable OSR instead of crashing. */
export function loadOsrLib(): { symbols: OsrSymbols; path: string } | null {
  if (cached) return cached;
  const path = findOsrLibrary();
  if (!path) return null;
  try {
    cached = { symbols: dlopen(path, OSR_SPEC).symbols as OsrSymbols, path };
    return cached;
  } catch {
    return null;
  }
}

const enc = new TextEncoder();
// bun:ffi's ptr() can't convert a zero-length buffer — empty strings pass
// this scratch pointer with len 0 (read_str bounds-checks on len anyway).
const EMPTY_STR = new Uint8Array(1);

/** DOM-button name → DOM button number (matches `MouseEvent.button`). */
function domButton(b?: "left" | "middle" | "right"): number {
  return b === "right" ? 2 : b === "middle" ? 1 : 0;
}

/** Modifier names → the u32 bitmask the ABI expects. */
export function osrModifierBits(mods?: string[]): number {
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

/** Per-frame raster stats — slots match the Rust `stats` array. */
export interface OsrStats {
  resolveMs: number;
  paintMs: number;
  diffMs: number;
  pixelsLen: number;
  rasters: number;
  skippedClean: number;
}

/** Byte offset of the pixel region inside a bound frame buffer. */
export const OSR_FRAME_HEADER = 64;

/** Typed handle over one Blitz document. */
export class OsrDoc {
  private handle: number;
  private lib: OsrSymbols;
  /** Physical px dimensions tracked host-side (updated on resize). */
  width: number;
  height: number;

  private constructor(lib: OsrSymbols, handle: number, width: number, height: number) {
    this.lib = lib;
    this.handle = handle;
    this.width = width;
    this.height = height;
  }

  static create(width: number, height: number, scale: number, html: string): OsrDoc | null {
    const entry = loadOsrLib();
    if (!entry) return null;
    const bytes = enc.encode(html);
    const h = entry.symbols.dd_osr_init(width, height, scale, ptr(bytes), bytes.length) as number;
    if (!h) return null;
    return new OsrDoc(entry.symbols, h, width, height);
  }

  /** Replace the whole document (Blitz has no in-place reparse). */
  setHtml(html: string): boolean {
    const bytes = enc.encode(html);
    return (this.lib.dd_osr_set_html(this.handle, ptr(bytes), bytes.length) as number) === 0;
  }

  /** Rasterize when dirty; returns the RGBA8 buffer or null when clean. */
  frame(): Uint8Array | null {
    const p = this.lib.dd_osr_frame(this.handle) as number;
    if (!p) return null;
    const len = Number(this.lib.dd_osr_pixels_len(this.handle));
    if (len <= 0) return null;
    return readMappedRange(p, len);
  }

  resize(width: number, height: number, scale: number): boolean {
    const ok = (this.lib.dd_osr_resize(this.handle, width, height, scale) as number) === 0;
    if (ok) { this.width = width; this.height = height; }
    return ok;
  }

  pointerMove(x: number, y: number, mods?: string[]): void {
    this.lib.dd_osr_pointer(this.handle, 0, x, y, 0, osrModifierBits(mods));
  }

  pointerDown(x: number, y: number, button?: "left" | "middle" | "right", mods?: string[]): void {
    this.lib.dd_osr_pointer(this.handle, 1, x, y, domButton(button), osrModifierBits(mods));
  }

  pointerUp(x: number, y: number, button?: "left" | "middle" | "right", mods?: string[]): void {
    this.lib.dd_osr_pointer(this.handle, 2, x, y, domButton(button), osrModifierBits(mods));
  }

  wheel(x: number, y: number, deltaX: number, deltaY: number, mods?: string[]): void {
    this.lib.dd_osr_wheel(this.handle, x, y, deltaX, deltaY, osrModifierBits(mods));
  }

  /** `key`/`code` are W3C UI-Events strings ("Enter"/"a", "KeyF"/"Escape"). */
  key(down: boolean, key: string, code?: string, text?: string, mods?: string[]): void {
    const kb = enc.encode(key);
    const cb = enc.encode(code ?? "");
    const tb = enc.encode(text ?? "");
    this.lib.dd_osr_key(
      this.handle, down ? 0 : 1,
      ptr(kb.length ? kb : EMPTY_STR), kb.length,
      ptr(cb.length ? cb : EMPTY_STR), cb.length,
      ptr(tb.length ? tb : EMPTY_STR), tb.length,
      osrModifierBits(mods),
    );
  }

  /** Is (x, y) over a `data-ui` element? */
  hitTest(x: number, y: number): boolean {
    return (this.lib.dd_osr_hit_test(this.handle, x, y) as number) === 1;
  }

  /**
   * Dirty rect of the last successful frame() in physical px, or null when
   * the whole buffer is new/changed shape. Packed u64: x<<48|y<<32|w<<16|h.
   */
  frameRect(): { x: number; y: number; w: number; h: number } | null {
    const v = BigInt(this.lib.dd_osr_frame_rect(this.handle) as bigint | number);
    const x = Number(v >> 48n), y = Number((v >> 32n) & 0xffffn);
    const w = Number((v >> 16n) & 0xffffn), h = Number(v & 0xffffn);
    return w > 0 && h > 0 ? { x, y, w, h } : null;
  }

  /** True when the doc has damage worth rasterizing (dirty or animating). */
  pending(): boolean {
    return (this.lib.dd_osr_pending(this.handle) as number) !== 0;
  }

  /** Drain queued DOM events (click/input/key/focus/scroll) as parsed JSON. */
  pollEvents(): OsrDomEvent[] {
    const p = this.lib.dd_osr_poll_events(this.handle) as number;
    if (!p) return [];
    const len = Number(this.lib.dd_osr_events_len(this.handle));
    if (len <= 0) return [];
    try {
      return JSON.parse(new TextDecoder().decode(readMappedRange(p, len))) as OsrDomEvent[];
    } catch {
      return [];
    }
  }

  /** CSS selector → node handle (0 on miss). Re-query after structural edits. */
  query(selector: string): number {
    const s = enc.encode(selector);
    return Number(this.lib.dd_osr_query(this.handle, ptr(s), s.length) as bigint | number);
  }

  setText(node: number, text: string): boolean {
    const t = enc.encode(text);
    return (this.lib.dd_osr_set_text(this.handle, BigInt(node), ptr(t.length ? t : EMPTY_STR), t.length) as number) === 0;
  }

  setAttr(node: number, name: string, value: string): boolean {
    const n = enc.encode(name), v = enc.encode(value);
    return (this.lib.dd_osr_set_attr(this.handle, BigInt(node), ptr(n), n.length, ptr(v.length ? v : EMPTY_STR), v.length) as number) === 0;
  }

  removeAttr(node: number, name: string): boolean {
    const n = enc.encode(name);
    return (this.lib.dd_osr_remove_attr(this.handle, BigInt(node), ptr(n), n.length) as number) === 0;
  }

  setStyle(node: number, prop: string, value: string): boolean {
    // Stylo's PropertyId::parse wants CSS names — accept JS-style camelCase
    // too ("fontSize" → "font-size") so callers can use DOM-style props.
    const name = /[A-Z]/.test(prop) ? prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`) : prop;
    const p = enc.encode(name), v = enc.encode(value);
    return (this.lib.dd_osr_set_style(this.handle, BigInt(node), ptr(p), p.length, ptr(v.length ? v : EMPTY_STR), v.length) as number) === 0;
  }

  /** Replace a node's children with parsed HTML (invalidates child NodeIds). */
  setInnerHtml(node: number, html: string): boolean {
    const h = enc.encode(html);
    return (this.lib.dd_osr_set_inner_html(this.handle, BigInt(node), ptr(h.length ? h : EMPTY_STR), h.length) as number) === 0;
  }

  /** Attribute value — for "value" on <input>/<textarea> returns live text. */
  getAttr(node: number, name: string): string | null {
    const n = enc.encode(name);
    const p = this.lib.dd_osr_get_attr(this.handle, BigInt(node), ptr(n), n.length) as number;
    if (!p) return null;
    const len = Number(this.lib.dd_osr_out_len(this.handle));
    if (len === 0) return ""; // attr/value present but empty
    return new TextDecoder().decode(readMappedRange(p, len));
  }

  /** Focus a node (0 = blur). */
  focus(node: number): boolean {
    return (this.lib.dd_osr_focus(this.handle, BigInt(node)) as number) === 0;
  }

  /** Currently-focused node handle, or 0. */
  focusedNode(): number {
    return Number(this.lib.dd_osr_focused_node(this.handle) as bigint | number);
  }

  /** CSS selector → all matching node handles (empty on miss/parse error).
   *  Re-query after structural edits. */
  queryAll(selector: string): number[] {
    const s = enc.encode(selector);
    const p = this.lib.dd_osr_query_all(this.handle, ptr(s), s.length) as number;
    const len = Number(this.lib.dd_osr_query_all_len(this.handle));
    if (!p || len === 0) return [];
    const u8 = readMappedRange(p, len * 8);
    const u64 = new BigUint64Array(u8.buffer, u8.byteOffset, len);
    return Array.from(u64, (v) => Number(v));
  }

  /** Nearest ancestor-or-self matching `selector` → node handle (0 on miss). */
  closest(node: number, selector: string): number {
    const s = enc.encode(selector);
    return Number(this.lib.dd_osr_closest(this.handle, BigInt(node), ptr(s), s.length) as bigint | number);
  }

  /** Scroll the viewport so `node` is visible.
   *  align: "start" | "center" | "end" | "nearest" (nearest = minimal scroll). */
  scrollIntoView(
    node: number,
    opts?: { smooth?: boolean; vertical?: "start" | "center" | "end" | "nearest"; horizontal?: "start" | "center" | "end" | "nearest" },
  ): boolean {
    const A = { start: 0, center: 1, end: 2, nearest: 3 } as const;
    return (this.lib.dd_osr_scroll_into_view(
      this.handle, BigInt(node), opts?.smooth ? 1 : 0,
      A[opts?.vertical ?? "nearest"], A[opts?.horizontal ?? "nearest"],
    ) as number) === 0;
  }

  /** Scroll a specific node (scroll container) to absolute (x, y) offsets.
   *  Reaches nested scrollports — scrollIntoView only moves the root viewport.
   *  Offsets clamp to the node's scroll range; y=1e9 pins to the bottom. */
  scrollTo(node: number, x: number, y: number, smooth = false): boolean {
    return (this.lib.dd_osr_scroll_to(this.handle, BigInt(node), x, y, smooth ? 1 : 0) as number) === 0;
  }

  // ── Zero-copy frame channel ──

  /** Bytes the bound frame buffer must hold at the doc's current size. */
  bufNeeded(): number {
    return Number(this.lib.dd_osr_buf_needed(this.handle));
  }

  /**
   * Bind a SharedArrayBuffer as the frame staging buffer. The Rust side
   * writes a 64-byte header + dirty pixel rows at 256-aligned stride.
   * Returns true when bound (false = buffer too small / lib absent).
   */
  bindFrameBuf(sab: SharedArrayBuffer): boolean {
    const view = new Uint8Array(sab);
    return (this.lib.dd_osr_bind_frame_buf(this.handle, ptr(view), view.byteLength) as number) === 0;
  }

  /**
   * Rasterize (when dirty) straight into the bound buffer.
   * Returns 1 = frame written, 0 = nothing new, -2 = buffer too small
   * (rebind + refreshInto), -3 = unbound.
   */
  frameInto(): number {
    return this.lib.dd_osr_frame_into(this.handle) as number;
  }

  /** Re-emit the current pixels into the bound buffer (no raster). */
  refreshInto(): number {
    return this.lib.dd_osr_refresh_into(this.handle) as number;
  }

  /**
   * Border-box rect of a node in logical px (doc-space — matches DOM event
   * client_x/client_y). Null when the node id is stale.
   */
  nodeRect(node: number): { x: number; y: number; w: number; h: number } | null {
    const p = this.lib.dd_osr_node_rect(this.handle, BigInt(node)) as number;
    if (!p) return null;
    const u8 = readMappedRange(p, 32);
    const f = new Float64Array(u8.buffer, u8.byteOffset, 4);
    return { x: f[0], y: f[1], w: f[2], h: f[3] };
  }

  /** Per-frame timings from the last raster, or null when unavailable. */
  lastStats(): OsrStats | null {
    const p = this.lib.dd_osr_last_stats(this.handle) as number;
    if (!p) return null;
    const u8 = readMappedRange(p, 64);
    const f = new Float64Array(u8.buffer, u8.byteOffset, 8);
    return {
      resolveMs: f[0], paintMs: f[1], diffMs: f[2], pixelsLen: f[3],
      rasters: f[4], skippedClean: f[5],
    };
  }

  destroy(): void {
    if (!this.handle) return;
    this.lib.dd_osr_destroy(this.handle);
    this.handle = 0;
  }
}
