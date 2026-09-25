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

import { dlopen, ptr, readMappedRange, type CFunction } from "@downdraft/platform-native";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname =
  typeof (globalThis as any).__dirname !== "undefined"
    ? (globalThis as any).__dirname
    : dirname(fileURLToPath(import.meta.url));

function findOsrLibrary(): string | null {
  const envPath = process.env.DOWNDRAFT_OSR_LIB;
  if (envPath) return existsSync(envPath) ? envPath : null;
  const base =
    process.platform === "win32" ? "downdraft_blitz_osr.dll"
    : process.platform === "darwin" ? "libdowndraft_blitz_osr.dylib"
    : "libdowndraft_blitz_osr.so";
  const candidates = [
    // Dev builds — release first, then debug.
    join(_dirname, "..", "native-osr", "target", "release", base),
    join(_dirname, "..", "native-osr", "target", "debug", base),
    join(_dirname, "..", "native-osr", base),
    // Packaged layout — native/ dir next to the compiled binary.
    join(dirname(process.execPath), "native", base),
    join("/usr/local/lib", base),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
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
};

export type OsrSymbols = Record<keyof typeof OSR_SPEC, (...args: any[]) => any>;

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
  for (const m of mods ?? []) {
    const k = m.toLowerCase();
    if (k === "shift") bits |= 1;
    else if (k === "control" || k === "ctrl") bits |= 2;
    else if (k === "alt") bits |= 4;
    else if (k === "meta" || k === "super" || k === "cmd") bits |= 8;
  }
  return bits;
}

/** Typed handle over one Blitz document. */
export class OsrDoc {
  private handle: number;
  private lib: OsrSymbols;
  /** Physical px dimensions tracked host-side (they're set at init/resize). */
  readonly width: number;
  readonly height: number;

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
    return (this.lib.dd_osr_resize(this.handle, width, height, scale) as number) === 0;
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

  destroy(): void {
    if (!this.handle) return;
    this.lib.dd_osr_destroy(this.handle);
    this.handle = 0;
  }
}
