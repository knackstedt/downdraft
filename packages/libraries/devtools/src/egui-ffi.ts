// ============================================================================
// egui-ffi.ts — bun:ffi bindings to libdowndraft_devtools.so + PaintJobs
// deserializer.
//
// The Rust crate (packages/libraries/devtools/native/) runs egui's layout +
// tessellation on the CPU and serializes the resulting PaintJobs (clipped
// textured-triangle meshes) + texture deltas into a flat byte buffer. This
// module loads the .so via bun:ffi, calls dd_devtools_update each frame, and
// parses the returned buffer into typed JS objects that EguiRenderer consumes.
// ============================================================================

import { dlopen, ptr, type CFunction } from "@downdraft/platform-native";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _dirname =
  typeof (globalThis as any).__dirname !== "undefined"
    ? (globalThis as any).__dirname
    : dirname(fileURLToPath(import.meta.url));

// ── Locate the devtools native library ──

function findDevtoolsLibrary(): string {
  const envPath = process.env.DEVTOOLS_NATIVE_PATH;
  if (envPath && existsSync(envPath)) return envPath;

  const distPath = join(_dirname, "..", "..", "devtools", "native", "dist", "libdowndraft_devtools.so");
  if (existsSync(distPath)) return distPath;

  const sidePath = join(_dirname, "..", "..", "devtools", "native", "libdowndraft_devtools.so");
  if (existsSync(sidePath)) return sidePath;

  const systemPath = "/usr/local/lib/libdowndraft_devtools.so";
  if (existsSync(systemPath)) return systemPath;

  throw new Error(
    `libdowndraft_devtools.so not found. Build with: cd packages/libraries/devtools/native && ./build.sh`,
  );
}

// ── FFI symbol table ──
// Lazy dlopen — importing this module must not fail when the Rust library is
// absent (e.g. web builds, tests). The .so is opened on first symbol access.

const DEVTOOLS_SPEC: Record<string, CFunction> = {
  dd_devtools_init: { args: ["f32", "f32", "f32"], returns: "ptr" } as CFunction,
  dd_devtools_destroy: { args: ["ptr"], returns: "void" } as CFunction,
  dd_devtools_resize: { args: ["ptr", "f32", "f32"], returns: "void" } as CFunction,
  dd_devtools_set_visible: { args: ["ptr", "i32"], returns: "void" } as CFunction,
  dd_devtools_set_active_panel: { args: ["ptr", "u8"], returns: "void" } as CFunction,

  // Input
  dd_devtools_set_mouse_pos: { args: ["ptr", "f32", "f32"], returns: "void" } as CFunction,
  dd_devtools_mouse_leave: { args: ["ptr"], returns: "void" } as CFunction,
  dd_devtools_mouse_button: { args: ["ptr", "u8", "i32"], returns: "void" } as CFunction,
  dd_devtools_set_wheel: { args: ["ptr", "f32"], returns: "void" } as CFunction,
  dd_devtools_set_modifiers: { args: ["ptr", "i32", "i32", "i32"], returns: "void" } as CFunction,
  dd_devtools_key_down: { args: ["ptr", "cstring"], returns: "void" } as CFunction,
  dd_devtools_text_input: { args: ["ptr", "cstring"], returns: "void" } as CFunction,

  // Data mirror
  dd_devtools_push_console: {
    args: ["ptr", "ptr", "u64", "u8", "ptr", "u64", "f64", "i32"],
    returns: "void",
  } as CFunction,
  dd_devtools_push_repl_result: {
    args: ["ptr", "ptr", "u64", "i32", "f64"],
    returns: "void",
  } as CFunction,
  dd_devtools_clear_console: { args: ["ptr"], returns: "void" } as CFunction,
  dd_devtools_set_threads: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  dd_devtools_set_scene_tree: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  dd_devtools_set_dom_tree: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  dd_devtools_set_gpu_info: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  dd_devtools_set_profile: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,
  dd_devtools_set_metrics: { args: ["ptr", "ptr", "u64"], returns: "void" } as CFunction,

  // Eval round-trip
  dd_devtools_take_eval_request: {
    args: ["ptr", "ptr", "ptr", "u64", "ptr", "u64"],
    returns: "u64",
  } as CFunction,
  dd_devtools_push_eval_result: {
    args: ["ptr", "u64", "ptr", "u64", "i32"],
    returns: "void",
  } as CFunction,

  // Refresh requests
  dd_devtools_take_refresh_requests: { args: ["ptr"], returns: "u32" } as CFunction,
  dd_devtools_get_dom_tree_mode: { args: ["ptr"], returns: "u8" } as CFunction,

  // Update + wants_text_input
  dd_devtools_update: { args: ["ptr", "ptr", "u64"], returns: "u64" } as CFunction,
  dd_devtools_wants_text_input: { args: ["ptr"], returns: "i32" } as CFunction,
};

let _symbols: Record<string, (...args: any[]) => any> | null = null;

function loadDevtools(): Record<string, (...args: any[]) => any> {
  if (!_symbols) {
    const libPath = findDevtoolsLibrary();
    _symbols = dlopen(libPath, DEVTOOLS_SPEC).symbols;
  }
  return _symbols;
}

const symbols: Record<string, (...args: any[]) => any> = new Proxy({} as Record<string, (...args: any[]) => any>, {
  get(_target, prop: string) {
    const lib = loadDevtools();
    const fn = lib[prop];
    if (fn === undefined) {
      throw new Error(`devtools shim has no symbol "${prop}"`);
    }
    return fn;
  },
});

// ── Typed wrappers ──

export type DevtoolsHandle = number; // opaque ptr

export function devtoolsInit(width: number, height: number, dpr: number): DevtoolsHandle {
  return symbols.dd_devtools_init(width, height, dpr) as unknown as number;
}

export function devtoolsDestroy(h: DevtoolsHandle): void {
  symbols.dd_devtools_destroy(h);
}

export function devtoolsResize(h: DevtoolsHandle, w: number, ht: number): void {
  symbols.dd_devtools_resize(h, w, ht);
}

export function devtoolsSetActivePanel(h: DevtoolsHandle, panel: number): void {
  symbols.dd_devtools_set_active_panel(h, panel);
}

export function devtoolsSetMousePos(h: DevtoolsHandle, x: number, y: number): void {
  symbols.dd_devtools_set_mouse_pos(h, x, y);
}

export function devtoolsMouseLeave(h: DevtoolsHandle): void {
  symbols.dd_devtools_mouse_leave(h);
}

export function devtoolsMouseButton(h: DevtoolsHandle, button: number, pressed: boolean): void {
  symbols.dd_devtools_mouse_button(h, button, pressed ? 1 : 0);
}

export function devtoolsSetWheel(h: DevtoolsHandle, deltaY: number): void {
  symbols.dd_devtools_set_wheel(h, deltaY);
}

export function devtoolsSetModifiers(h: DevtoolsHandle, alt: boolean, ctrl: boolean, shift: boolean): void {
  symbols.dd_devtools_set_modifiers(h, alt ? 1 : 0, ctrl ? 1 : 0, shift ? 1 : 0);
}

export function devtoolsKeyDown(h: DevtoolsHandle, keyName: string): void {
  symbols.dd_devtools_key_down(h, Buffer.from(keyName + "\0"));
}

export function devtoolsTextInput(h: DevtoolsHandle, text: string): void {
  symbols.dd_devtools_text_input(h, Buffer.from(text + "\0"));
}

// ── Data mirror helpers ──

/** Push a console entry into Rust. */
export function devtoolsPushConsole(
  h: DevtoolsHandle,
  text: string,
  severity: number,
  thread: string,
  timestamp: number,
  hasStack: boolean,
): void {
  const textBuf = Buffer.from(text, "utf8");
  const threadBuf = Buffer.from(thread, "utf8");
  symbols.dd_devtools_push_console(
    h,
    ptr(textBuf),
    BigInt(textBuf.length),
    severity,
    ptr(threadBuf),
    BigInt(threadBuf.length),
    timestamp,
    hasStack ? 1 : 0,
  );
}

/** Push a REPL eval result into Rust (rendered as a console entry). */
export function devtoolsPushReplResult(
  h: DevtoolsHandle,
  text: string,
  isError: boolean,
  timestamp: number,
): void {
  const textBuf = Buffer.from(text, "utf8");
  symbols.dd_devtools_push_repl_result(h, ptr(textBuf), BigInt(textBuf.length), isError ? 1 : 0, timestamp);
}

export function devtoolsClearConsole(h: DevtoolsHandle): void {
  symbols.dd_devtools_clear_console(h);
}

/** Push a flat threads buffer (encoded by encodeThreads()). */
export function devtoolsSetThreads(h: DevtoolsHandle, buf: Uint8Array): void {
  symbols.dd_devtools_set_threads(h, ptr(buf), BigInt(buf.length));
}

export function devtoolsSetSceneTree(h: DevtoolsHandle, buf: Uint8Array): void {
  symbols.dd_devtools_set_scene_tree(h, ptr(buf), BigInt(buf.length));
}

export function devtoolsSetDomTree(h: DevtoolsHandle, buf: Uint8Array): void {
  symbols.dd_devtools_set_dom_tree(h, ptr(buf), BigInt(buf.length));
}

export function devtoolsSetGpuInfo(h: DevtoolsHandle, buf: Uint8Array): void {
  symbols.dd_devtools_set_gpu_info(h, ptr(buf), BigInt(buf.length));
}

export function devtoolsSetProfile(h: DevtoolsHandle, buf: Uint8Array): void {
  symbols.dd_devtools_set_profile(h, ptr(buf), BigInt(buf.length));
}

export function devtoolsSetMetrics(h: DevtoolsHandle, buf: Uint8Array): void {
  symbols.dd_devtools_set_metrics(h, ptr(buf), BigInt(buf.length));
}

// ── Eval round-trip ──

export interface EvalRequest {
  requestId: number;
  threadId: string;
  expr: string;
}

/** Take the next pending eval request from Rust (or null). */
export function devtoolsTakeEvalRequest(h: DevtoolsHandle): EvalRequest | null {
  const reqIdBuf = new BigUint64Array(1);
  const threadBuf = Buffer.alloc(128);
  const exprBuf = Buffer.alloc(4096);
  const exprLenBig = symbols.dd_devtools_take_eval_request(
    h,
    ptr(reqIdBuf),
    ptr(threadBuf),
    BigInt(threadBuf.length),
    ptr(exprBuf),
    BigInt(exprBuf.length),
  ) as unknown as bigint;
  const exprLen = Number(exprLenBig);
  if (exprLen === 0 && reqIdBuf[0] === 0n) return null;
  const requestId = Number(reqIdBuf[0]);
  const threadEnd = threadBuf.indexOf(0);
  const threadId = threadBuf.toString("utf8", 0, threadEnd < 0 ? threadBuf.length : threadEnd) || "main";
  const expr = exprBuf.subarray(0, exprLen).toString("utf8");
  return { requestId, threadId, expr };
}

export function devtoolsPushEvalResult(
  h: DevtoolsHandle,
  requestId: number,
  text: string,
  isError: boolean,
): void {
  const textBuf = Buffer.from(text, "utf8");
  symbols.dd_devtools_push_eval_result(
    h,
    BigInt(requestId),
    ptr(textBuf),
    BigInt(textBuf.length),
    isError ? 1 : 0,
  );
}

// ── Refresh requests ──

export const REFRESH_SCENE = 1;
export const REFRESH_DOM = 2;
export const REFRESH_GPU = 4;
export const REFRESH_METRICS = 8;
export const REFRESH_PERF_RECORD = 16;
export const REFRESH_PERF_STOP = 32;

export function devtoolsTakeRefreshRequests(h: DevtoolsHandle): number {
  return symbols.dd_devtools_take_refresh_requests(h) as unknown as number;
}

export function devtoolsGetDomTreeMode(h: DevtoolsHandle): number {
  return symbols.dd_devtools_get_dom_tree_mode(h) as unknown as number;
}

// ── wants_text_input ──

export function devtoolsWantsTextInput(h: DevtoolsHandle): boolean {
  return (symbols.dd_devtools_wants_text_input(h) as unknown as number) !== 0;
}

// ── Update: run egui, deserialize PaintJobs ──

export interface PaintVertex {
  x: number; y: number; u: number; v: number; r: number; g: number; b: number; a: number;
}
export interface PaintMesh {
  clipX: number; clipY: number; clipW: number; clipH: number;
  textureId: number;
  vertices: Float32Array; // packed: x,y,u,v,rgba(4 bytes as f32 bits? no — we store as Float32 for GPU upload)
  indices: Uint32Array;
}
export interface TextureSet {
  id: number;
  posX: number; posY: number; // -1 = full texture
  width: number; height: number;
  pixels: Uint8Array; // RGBA
}
export interface PaintJobs {
  frameId: number;
  pixelsPerPoint: number;
  texturesSet: TextureSet[];
  texturesFree: number[];
  meshes: PaintMesh[];
}

const MAGIC = 0xdddd0001;

/**
 * Run egui for one frame and deserialize the PaintJobs.
 * Allocates a scratch buffer of `scratchSize` bytes (grows if needed).
 */
export function devtoolsUpdate(
  h: DevtoolsHandle,
  scratch: { buf: Uint8Array },
): PaintJobs | null {
  // Try with the current scratch buffer; if Rust reports overflow (usize::MAX),
  // grow the buffer and retry.
  for (let attempt = 0; attempt < 3; attempt++) {
    const writtenBig = symbols.dd_devtools_update(h, ptr(scratch.buf), BigInt(scratch.buf.length)) as unknown as bigint;
    const written = Number(writtenBig);
    // usize::MAX means overflow.
    if (written === 0xffffffff || written > 0xffffffff) {
      // Grow scratch to 2x and retry.
      scratch.buf = new Uint8Array(scratch.buf.length * 2);
      continue;
    }
    if (written === 0) return null;
    const view = new DataView(scratch.buf.buffer, scratch.buf.byteOffset, written);
    return deserializePaintJobs(view);
  }
  return null;
}

function deserializePaintJobs(view: DataView): PaintJobs {
  let off = 0;
  const magic = view.getUint32(off, true); off += 4;
  if (magic !== MAGIC) throw new Error(`egui-ffi: bad magic 0x${magic.toString(16)}`);
  const numClips = view.getUint32(off, true); off += 4;
  const numTexSet = view.getUint32(off, true); off += 4;
  const numTexFree = view.getUint32(off, true); off += 4;
  const pixelsPerPoint = view.getFloat32(off, true); off += 4;
  const frameId = view.getUint32(off, true); off += 4;

  // Texture sets
  const texturesSet: TextureSet[] = [];
  for (let i = 0; i < numTexSet; i++) {
    const id = Number(view.getBigUint64(off, true)); off += 8;
    const posX = view.getInt32(off, true); off += 4;
    const posY = view.getInt32(off, true); off += 4;
    const width = view.getUint32(off, true); off += 4;
    const height = view.getUint32(off, true); off += 4;
    const pixelLen = width * height * 4;
    // Copy pixels into a fresh Uint8Array (the scratch buffer is reused).
    const pixels = new Uint8Array(pixelLen);
    pixels.set(new Uint8Array(view.buffer, view.byteOffset + off, pixelLen));
    off += pixelLen;
    texturesSet.push({ id, posX, posY, width, height, pixels });
  }

  // Texture frees
  const texturesFree: number[] = [];
  for (let i = 0; i < numTexFree; i++) {
    texturesFree.push(Number(view.getBigUint64(off, true)));
    off += 8;
  }

  // Clips / meshes
  const meshes: PaintMesh[] = [];
  for (let i = 0; i < numClips; i++) {
    const clipX = view.getFloat32(off, true); off += 4;
    const clipY = view.getFloat32(off, true); off += 4;
    const clipW = view.getFloat32(off, true); off += 4;
    const clipH = view.getFloat32(off, true); off += 4;
    const textureId = Number(view.getBigUint64(off, true)); off += 8;
    const vertexCount = view.getUint32(off, true); off += 4;
    const indexCount = view.getUint32(off, true); off += 4;

    // Vertex layout: f32 x, f32 y, f32 u, f32 v, u8 r, u8 g, u8 b, u8 a (20 bytes).
    // We pack into a Float32Array for GPU upload: x, y, u, v, and color as a
    // single f32 (the bit pattern of the packed RGBA). The shader unpacks it.
    // Use a Float32Array for positions/UVs but write the color as a raw u32
    // via a Uint32Array view over the same buffer. f32 can only represent
    // integers up to 2^24 exactly — storing the packed RGBA (which can be
    // up to 2^32-1) as f32 corrupts the bit pattern, causing color errors.
    const vertices = new Float32Array(vertexCount * 5);
    const verticesU32 = new Uint32Array(vertices.buffer);
    for (let v = 0; v < vertexCount; v++) {
      vertices[v * 5 + 0] = view.getFloat32(off, true);
      vertices[v * 5 + 1] = view.getFloat32(off + 4, true);
      vertices[v * 5 + 2] = view.getFloat32(off + 8, true);
      vertices[v * 5 + 3] = view.getFloat32(off + 12, true);
      const r = view.getUint8(off + 16);
      const g = view.getUint8(off + 17);
      const b = view.getUint8(off + 18);
      const a = view.getUint8(off + 19);
      // Pack as 0xAABBGGRR (little-endian → shader reads rgba via unpack)
      verticesU32[v * 5 + 4] = ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
      off += 20;
    }

    const indices = new Uint32Array(indexCount);
    for (let idx = 0; idx < indexCount; idx++) {
      indices[idx] = view.getUint32(off, true);
      off += 4;
    }

    meshes.push({ clipX, clipY, clipW, clipH, textureId, vertices, indices });
  }

  return { frameId, pixelsPerPoint, texturesSet, texturesFree, meshes };
}

// ── Encoders (TS → Rust flat formats) ──

/** Encode threads: u32 count, then per thread: u8 kind, u16 id_len, id bytes, u16 name_len, name bytes. */
export function encodeThreads(threads: { id: string; name: string; kind: number }[]): Uint8Array {
  let size = 4;
  for (const t of threads) {
    size += 1 + 2 + Buffer.byteLength(t.id) + 2 + Buffer.byteLength(t.name);
  }
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(threads.length, off); off += 4;
  for (const t of threads) {
    buf.writeUInt8(t.kind, off); off += 1;
    const idBytes = Buffer.from(t.id, "utf8");
    buf.writeUInt16LE(idBytes.length, off); off += 2;
    idBytes.copy(buf, off); off += idBytes.length;
    const nameBytes = Buffer.from(t.name, "utf8");
    buf.writeUInt16LE(nameBytes.length, off); off += 2;
    nameBytes.copy(buf, off); off += nameBytes.length;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Encode a tree: u32 count, then per node: u32 id, i32 parent, u16 depth, u32 childCount, u8 kind, u16 labelLen, label, u16 detailLen, detail. */
export function encodeTree(
  nodes: { id: number; parentId: number; depth: number; childCount: number; kind: number; label: string; detail: string }[],
): Uint8Array {
  let size = 4;
  for (const n of nodes) {
    size += 4 + 4 + 2 + 4 + 1 + 2 + Buffer.byteLength(n.label) + 2 + Buffer.byteLength(n.detail);
  }
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(nodes.length, off); off += 4;
  for (const n of nodes) {
    buf.writeUInt32LE(n.id, off); off += 4;
    buf.writeInt32LE(n.parentId, off); off += 4;
    buf.writeUInt16LE(n.depth, off); off += 2;
    buf.writeUInt32LE(n.childCount, off); off += 4;
    buf.writeUInt8(n.kind, off); off += 1;
    const labelBytes = Buffer.from(n.label, "utf8");
    buf.writeUInt16LE(labelBytes.length, off); off += 2;
    labelBytes.copy(buf, off); off += labelBytes.length;
    const detailBytes = Buffer.from(n.detail, "utf8");
    buf.writeUInt16LE(detailBytes.length, off); off += 2;
    detailBytes.copy(buf, off); off += detailBytes.length;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Encode GPU info: u32 entryCount, per entry: u8 isHeader, u16 keyLen, key, u16 valLen, val. Then u32 ftCount, per: f32 cpu, f32 gpu. Then u32 memCount, per: f64. */
export function encodeGpuInfo(
  entries: { key: string; value: string; isHeader: boolean }[],
  frameTimes: [number, number][],
  memHistory: number[],
): Uint8Array {
  let size = 4;
  for (const e of entries) {
    size += 1 + 2 + Buffer.byteLength(e.key) + 2 + Buffer.byteLength(e.value);
  }
  size += 4 + frameTimes.length * 8;
  size += 4 + memHistory.length * 8;
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(entries.length, off); off += 4;
  for (const e of entries) {
    buf.writeUInt8(e.isHeader ? 1 : 0, off); off += 1;
    const keyBytes = Buffer.from(e.key, "utf8");
    buf.writeUInt16LE(keyBytes.length, off); off += 2;
    keyBytes.copy(buf, off); off += keyBytes.length;
    const valBytes = Buffer.from(e.value, "utf8");
    buf.writeUInt16LE(valBytes.length, off); off += 2;
    valBytes.copy(buf, off); off += valBytes.length;
  }
  buf.writeUInt32LE(frameTimes.length, off); off += 4;
  for (const [cpu, gpu] of frameTimes) {
    buf.writeFloatLE(cpu, off); off += 4;
    buf.writeFloatLE(gpu, off); off += 4;
  }
  buf.writeUInt32LE(memHistory.length, off); off += 4;
  for (const m of memHistory) {
    buf.writeDoubleLE(m, off); off += 8;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Encode a CDP profile. */
export function encodeProfile(profile: {
  nodes: { id: number; hitCount: number; callFrame: string; url: string; line: number; children: number[] }[];
  startUs: number;
  endUs: number;
  samples: number[];
  timeDeltasUs: number[];
}): Uint8Array {
  let size = 4;
  for (const n of profile.nodes) {
    size += 4 + 4 + 2 + Buffer.byteLength(n.callFrame) + 2 + Buffer.byteLength(n.url) + 4 + 4;
    for (const _ of n.children) size += 4;
  }
  size += 8 + 8;
  size += 4 + profile.samples.length * 4;
  size += 4 + profile.timeDeltasUs.length * 8;
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(profile.nodes.length, off); off += 4;
  for (const n of profile.nodes) {
    buf.writeUInt32LE(Math.max(0, n.id) >>> 0, off); off += 4;
    buf.writeUInt32LE(Math.max(0, n.hitCount) >>> 0, off); off += 4;
    const cf = Buffer.from(n.callFrame, "utf8");
    buf.writeUInt16LE(cf.length, off); off += 2;
    cf.copy(buf, off); off += cf.length;
    const url = Buffer.from(n.url, "utf8");
    buf.writeUInt16LE(url.length, off); off += 2;
    url.copy(buf, off); off += url.length;
    buf.writeUInt32LE(Math.max(0, n.line) >>> 0, off); off += 4;
    buf.writeUInt32LE(n.children.length, off); off += 4;
    for (const c of n.children) {
      buf.writeUInt32LE(Math.max(0, c) >>> 0, off); off += 4;
    }
  }
  buf.writeDoubleLE(profile.startUs, off); off += 8;
  buf.writeDoubleLE(profile.endUs, off); off += 8;
  buf.writeUInt32LE(profile.samples.length, off); off += 4;
  for (const s of profile.samples) {
    buf.writeUInt32LE(Math.max(0, s) >>> 0, off); off += 4;
  }
  buf.writeUInt32LE(profile.timeDeltasUs.length, off); off += 4;
  for (const d of profile.timeDeltasUs) {
    buf.writeDoubleLE(d, off); off += 8;
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** Encode per-thread metrics. */
export function encodeMetrics(
  slots: {
    slotIndex: number;
    name: string;
    runtime: number;
    history: { cpuPercent: number; heapUsed: number; heapTotal: number; gcPauseMaxUs: number; taskLatencyP95Us: number }[];
  }[],
): Uint8Array {
  let size = 4;
  for (const s of slots) {
    size += 4 + 1 + 2 + Buffer.byteLength(s.name) + 4 + s.history.length * (4 + 8 + 8 + 8 + 8);
  }
  const buf = Buffer.alloc(size);
  let off = 0;
  buf.writeUInt32LE(slots.length, off); off += 4;
  for (const s of slots) {
    buf.writeUInt32LE(s.slotIndex, off); off += 4;
    buf.writeUInt8(s.runtime, off); off += 1;
    const nameBytes = Buffer.from(s.name, "utf8");
    buf.writeUInt16LE(nameBytes.length, off); off += 2;
    nameBytes.copy(buf, off); off += nameBytes.length;
    buf.writeUInt32LE(s.history.length, off); off += 4;
    for (const h of s.history) {
      buf.writeFloatLE(h.cpuPercent, off); off += 4;
      buf.writeDoubleLE(h.heapUsed, off); off += 8;
      buf.writeDoubleLE(h.heapTotal, off); off += 8;
      buf.writeDoubleLE(h.gcPauseMaxUs, off); off += 8;
      buf.writeDoubleLE(h.taskLatencyP95Us, off); off += 8;
    }
  }
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}
