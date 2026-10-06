// ============================================================================
// doc-backend.ts — the doc-owning side of the html-ui split.
//
// `createDocBackend(spawnWorker)` returns either a real Worker backend (docs +
// raster off the main thread — the production path) or an in-process backend
// used when workers/FFI are unavailable (bundled builds, tests, bakeoff).
// Both expose the same postMessage-shaped surface so the host can't tell the
// difference.
// ============================================================================

import type { UiToWorker, WorkerToUi } from "./protocol";

export interface DocBackend {
  /** "worker" = docs + raster off the main thread; "local" = in-process. */
  readonly kind: "worker" | "local";
  post(msg: UiToWorker, transfer?: Transferable[]): void;
  onMessage(fn: (msg: WorkerToUi) => void): void;
  dispose(): void;
}

/** In-process backend — same code path as the worker, minus the thread. */
export function createLocalBackend(): DocBackend {
  let sink: ((m: WorkerToUi) => void) | null = null;
  let core: { handle(m: UiToWorker): void; dispose(): void } | null = null;
  return {
    kind: "local",
    post(msg) {
      if (!core) core = createDocCore((m) => sink?.(m));
      core.handle(msg);
    },
    onMessage(fn) { sink = fn; },
    dispose() { core?.dispose(); core = null; },
  };
}

/** Worker backend — the production path. */
export function createWorkerBackend(worker: Worker): DocBackend {
  return {
    kind: "worker",
    post(msg, transfer) { worker.postMessage(msg, transfer ?? []); },
    onMessage(fn) {
      worker.addEventListener("message", (e: MessageEvent) => fn(e.data as WorkerToUi));
    },
    dispose() { worker.terminate(); },
  };
}

// ── Shared doc core — used by both the worker script and the local backend ──

import { OsrDoc, registerOsrResource } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";

interface DocState {
  doc: OsrDoc;
  scale: number;
  cssW: number;
  cssH: number;
  /** 0 = uncapped. Caps raster frequency for animating docs. */
  maxFps: number;
  lastFrame: number;
  /** SAB frame channel — bound while zero-copy delivery is working. */
  sab: SharedArrayBuffer | null;
  sabU32: Int32Array | null;
  sabDisabled: boolean;
  /** GPU-direct upload target — a non-owning wrap of the host-owned panel
   *  texture (see texBind), with the dims the host bound it at. Present ⇒
   *  emitFrame uploads straight to the GPU; absent ⇒ SAB/legacy emit.
   *  Dropped on view loss, write failure, or raster-dims mismatch (resize
   *  in flight) — each drop re-arms the SAB channel so the host resumes
   *  its own uploads until the next texBind lands. */
  gpuTex: { ptr: number | bigint; tex: unknown; w: number; h: number } | null;
  stats: { frames: number; resolveMs: number; paintMs: number; diffMs: number; bytes: number };
  statsLast: number;
}

// Bound-buffer header (u32 indices) — mirrors BoundBuf layout in lib.rs.
const H_SEQ = 0, H_X = 1, H_Y = 2, H_W = 3, H_H = 4, H_PW = 5, H_PH = 6, H_STRIDE = 8;

function freshStats() {
  return { frames: 0, resolveMs: 0, paintMs: 0, diffMs: 0, bytes: 0 };
}

/** The non-owning shared-device view the worker uses for GPU-direct
 *  uploads — a structural subset of platform-native's SharedDeviceView. */
export interface DocGpuView {
  queue: {
    writeTexture(dest: unknown, data: unknown, layout: unknown, size: unknown): void;
  };
  isValid(): boolean;
  detach(): void;
}

/** Test/injection seam for the GPU-direct path — the real implementation
 *  dynamic-imports @downdraft/platform-native on the first gpuAttach. */
export interface DocGpuHooks {
  attach(
    gpu: { devicePtr: number | bigint; instancePtr: number | bigint; queuePtr: number | bigint; generation: number },
    cells: SharedArrayBuffer,
  ): Promise<{
    view: DocGpuView;
    borrowTexture(ptr: number | bigint, meta: { width: number; height: number; format: GPUTextureFormat; usage?: number }): unknown;
  } | null>;
}

export function createDocCore(emit: (m: WorkerToUi) => void, gpuHooks?: DocGpuHooks): {
  handle(m: UiToWorker): void;
  dispose(): void;
} {
  const docs = new Map<string, DocState>();
  let destroyed = false;

  // ── GPU-direct upload state ──
  // The shared-device view lives once per worker (all docs share it); each
  // doc borrows its own host-owned texture via texBind. platform-native is
  // an optional peer — attach lazily so non-native hosts never resolve it.
  let gpuView: DocGpuView | null = null;
  let borrowGpuTexture:
    | ((ptr: number | bigint, meta: { width: number; height: number; format: GPUTextureFormat; usage?: number }) => unknown)
    | null = null;

  /** Allocate + bind the doc's SAB frame channel; emits a bind message.
   *  The SAB doubles as the worker-local raster scratch in GPU-direct mode,
   *  so it is always bound — and the host must ALWAYS know the current
   *  buffer: it is the instant fallback whenever a GPU-direct write can't
   *  complete (dead view, dropped borrow, stale texture). */
  function bindSab(id: string, s: DocState): void {
    s.sab = null;
    s.sabU32 = null;
    if (typeof SharedArrayBuffer === "undefined") { s.sabDisabled = true; return; }
    const need = s.doc.bufNeeded();
    if (need <= 0) { s.sabDisabled = true; return; }
    const sab = new SharedArrayBuffer(need);
    if (!s.doc.bindFrameBuf(sab)) { s.sabDisabled = true; return; }
    s.sab = sab;
    s.sabU32 = new Int32Array(sab);
    emit({ type: "bind", id, buf: sab });
  }

  /** Emit a frame message describing what frame_into()/refresh_into() wrote. */
  function emitSabFrame(id: string, s: DocState): void {
    const u = s.sabU32!;
    emit({
      type: "frame", id,
      seq: Atomics.load(u, H_SEQ),
      x: u[H_X], y: u[H_Y], w: u[H_W], h: u[H_H],
      pw: u[H_PW], ph: u[H_PH], stride: u[H_STRIDE],
    });
  }

  /**
   * Emit one raster — GPU-direct when this doc has a bound texture, the view
   * is live, and the raster dims still match the bound texture (a resize
   * resizes the doc before its texBind lands — writing would overrun and
   * wgpu drops the call silently). Anything else drops the borrow and
   * re-arms the SAB channel so the host resumes its own uploads; the next
   * texBind restores GPU-direct.
   */
  function emitFrame(id: string, s: DocState): void {
    if (!s.sabU32) return;
    const g = s.gpuTex;
    if (g && gpuView) {
      const u = s.sabU32;
      const x = u[H_X], y = u[H_Y], w = u[H_W], h = u[H_H];
      const pw = u[H_PW], ph = u[H_PH], stride = u[H_STRIDE];
      if (gpuView.isValid() && pw === g.w && ph === g.h) {
        try {
          gpuView.queue.writeTexture(
            { texture: g.tex, origin: [x, y, 0] },
            s.sab!,
            { offset: 64 + y * stride + x * 4, bytesPerRow: stride, rowsPerImage: h },
            { width: w, height: h, depthOrArrayLayers: 1 },
          );
          emit({ type: "frame", id, x, y, w, h, pw, ph, gpu: true, texPtr: g.ptr });
          return;
        } catch {
          // The view died between the check and the FFI call — fall through
          // to the drop below; it re-arms the host.
        }
      }
      // Dead view, failed write, or the raster no longer matches the bound
      // texture — drop the borrow and re-arm SAB delivery.
      emit({ type: "texAck", id, texPtr: g.ptr });
      s.gpuTex = null;
      if (s.sab) emit({ type: "bind", id, buf: s.sab, gpuFallback: true });
    }
    emitSabFrame(id, s);
  }

  /** Fold the last raster's timings into the per-doc accumulator. */
  function collectStats(s: DocState, rectBytes: number): void {
    const st = s.doc.lastStats();
    if (!st) return;
    s.stats.frames++;
    s.stats.resolveMs += st.resolveMs;
    s.stats.paintMs += st.paintMs;
    s.stats.diffMs += st.diffMs;
    s.stats.bytes += rectBytes;
  }

  function emitStats(now: number): void {
    for (const [id, s] of docs.entries()) {
      if (now - s.statsLast < 1000 || s.stats.frames === 0) continue;
      emit({ type: "stats", id, ...s.stats });
      s.stats = freshStats();
      s.statsLast = now;
    }
  }

  function pump() {
    const now = performance.now();
    for (const [id, s] of docs.entries()) {
      const events = s.doc.pollEvents();
      if (events.length) emit({ type: "events", id, events });
      if (!s.doc.pending()) continue;
      if (s.maxFps > 0 && now - s.lastFrame < 1000 / s.maxFps) continue;
      if (s.sabU32) {
        const rc = s.doc.frameInto();
        if (rc === 1) {
          s.lastFrame = now;
          collectStats(s, s.sabU32[H_W] * s.sabU32[H_H] * 4);
          emitFrame(id, s);
        } else if (rc === -2) {
          // Doc grew past the bound buffer — regrow, then retry the frame
          // (the doc is still dirty, so frameInto rasters the full frame now;
          // refreshInto would only emit the retained — stale-size — pixels).
          bindSab(id, s);
          if (s.sabU32) {
            const rc2 = s.doc.frameInto();
            if (rc2 === 1) {
              s.lastFrame = now;
              collectStats(s, s.sabU32[H_W] * s.sabU32[H_H] * 4);
              emitFrame(id, s);
            }
          }
        } else if (rc === -3) {
          // Binding unsupported — drop the channel and fall to legacy below.
          s.sabDisabled = true;
          s.sab = null;
          s.sabU32 = null;
        }
        if (rc !== -3) continue;
      }
      const pixels = s.doc.frame();
      if (!pixels) continue;
      s.lastFrame = now;
      const rect = s.doc.frameRect();
      const pw = s.doc.width;
      const ph = s.doc.height;
      if (rect && (rect.w < pw || rect.h < ph)) {
        collectStats(s, rect.w * rect.h * 4);
        // Slice dirty rows into a tight buffer for a partial upload.
        const tight = new Uint8Array(rect.w * rect.h * 4);
        for (let r = 0; r < rect.h; r++) {
          const src = (rect.y + r) * pw * 4 + rect.x * 4;
          tight.set(pixels.subarray(src, src + rect.w * 4), r * rect.w * 4);
        }
        emit({ type: "frame", id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, pw, ph, pixels: tight.buffer });
      } else {
        collectStats(s, pw * ph * 4);
        const copy = pixels.slice();
        emit({ type: "frame", id, x: 0, y: 0, w: pw, h: ph, pw, ph, pixels: copy.buffer as ArrayBuffer });
      }
    }
    emitStats(now);
  }

  function handle(m: UiToWorker) {
    if (destroyed) return;
    try {
      switch (m.type) {
        case "create": {
          const old = docs.get(m.id);
          if (old?.gpuTex) emit({ type: "texAck", id: m.id, texPtr: old.gpuTex.ptr });
          old?.doc.destroy();
          if (/float\s*:/.test(m.html)) emit({ type: "error", id: m.id, message: "CSS float hangs Blitz layout — use flex instead" });
          const doc = OsrDoc.create(m.cssW * m.scale, m.cssH * m.scale, m.scale, m.html);
          if (!doc) { emit({ type: "error", id: m.id, message: "OsrDoc.create failed" }); return; }
          const s: DocState = {
            doc, scale: m.scale, cssW: m.cssW, cssH: m.cssH,
            maxFps: m.maxFps ?? 0, lastFrame: -1e9,
            sab: null, sabU32: null, sabDisabled: false, gpuTex: null,
            stats: freshStats(), statsLast: 0,
          };
          docs.set(m.id, s);
          bindSab(m.id, s);
          break;
        }
        case "fps": {
          const s = docs.get(m.id);
          if (s) s.maxFps = m.maxFps;
          break;
        }
        case "setHtml":
          if (/float\s*:/.test(m.html)) emit({ type: "error", id: m.id, message: "CSS float hangs Blitz layout — use flex instead" });
          docs.get(m.id)?.doc.setHtml(m.html); break;
        case "resize": {
          const s = docs.get(m.id);
          if (s) {
            s.doc.resize(m.cssW * m.scale, m.cssH * m.scale, m.scale);
            s.scale = m.scale; s.cssW = m.cssW; s.cssH = m.cssH;
            if (s.sabU32 && !s.sabDisabled) bindSab(m.id, s); // regrow to the new frame size
          }
          break;
        }
        case "refresh": {
          // Host saw a torn seqlock read — re-emit the current pixels.
          const s = docs.get(m.id);
          if (s?.sabU32 && s.doc.refreshInto() === 1) emitFrame(m.id, s);
          break;
        }
        case "gpuAttach": {
          // Attach a non-owning view of the host's wgpu device so the worker
          // uploads straight into panel textures — the main thread stops
          // paying the queue.writeTexture cost per frame. Optional peer:
          // any failure keeps the SAB path.
          const attach = gpuHooks
            ? () => gpuHooks.attach(m.gpu, m.cells)
            : () => import("@downdraft/platform-native").then((pn) => {
              const view = pn.attachSharedDevice(m.gpu, m.cells);
              return view
                ? { view: view as unknown as DocGpuView, borrowTexture: pn.borrowGpuTexture }
                : null;
            });
          void Promise.resolve()
            .then(attach)
            .then((res) => {
              gpuView = res?.view ?? null;
              borrowGpuTexture = res?.borrowTexture ?? null;
              emit({ type: "gpuReady", ok: !!res });
            })
            .catch(() => emit({ type: "gpuReady", ok: false }));
          break;
        }
        case "gpuDetach": {
          for (const s of docs.values()) s.gpuTex = null;
          gpuView?.detach();
          gpuView = null;
          emit({ type: "gpuDetached" });
          break;
        }
        case "texBind": {
          // Bind this doc's host-owned upload target. The ack tells the host
          // it may destroy the previous texture — the deferred-destroy
          // window closes once our last write to it can't be in flight.
          const s = docs.get(m.id);
          if (!s) break;
          // No SAB scratch means frameInto can't raster — the doc only
          // emits legacy pixels frames, so a borrow would never be used.
          if (!s.sabU32) break;
          if (!gpuView || !borrowGpuTexture) break;
          try {
            if (s.gpuTex) emit({ type: "texAck", id: m.id, texPtr: s.gpuTex.ptr });
            s.gpuTex = {
              ptr: m.texPtr, w: m.w, h: m.h,
              tex: borrowGpuTexture(m.texPtr, {
                width: m.w, height: m.h, format: m.format as GPUTextureFormat,
              }),
            };
            // Push the retained pixels into the fresh texture so the panel
            // doesn't blank while waiting for the next repaint.
            if (s.sabU32 && s.doc.refreshInto() === 1) emitFrame(m.id, s);
          } catch {
            s.gpuTex = null;
            // Borrow failed — the host believes we're bound, so re-arm the
            // SAB channel or the panel goes black.
            if (s.sab) emit({ type: "bind", id: m.id, buf: s.sab, gpuFallback: true });
          }
          break;
        }
        case "profilingAttach": {
          // Engine profiling — claim a slot on the shared ProfilingSAB.
          // OPFS/IDB patching is skipped: docs do no storage I/O.
          void import("@downdraft/engine/profiling")
            .then((p) => p.attachProfilingSAB(m.sab, {
              workerTag: m.workerTag,
              opfs: false,
              idb: false,
              layout: m.layout,
            }))
            .catch(() => { /* profiling unavailable — fine */ });
          break;
        }
        case "destroy": {
          const s = docs.get(m.id);
          if (s?.gpuTex) emit({ type: "texAck", id: m.id, texPtr: s.gpuTex.ptr });
          s?.doc.destroy();
          docs.delete(m.id);
          break;
        }
        case "resource": registerOsrResource(m.url, new Uint8Array(m.bytes)); break;
        case "input": {
          const s = docs.get(m.id);
          if (!s) break;
          const { msg } = m;
          const k = s.scale;
          switch (msg.kind) {
            case "move": s.doc.pointerMove(msg.x * k, msg.y * k, msg.mods); break;
            case "down": s.doc.pointerDown(msg.x * k, msg.y * k, msg.button, msg.mods); break;
            case "up": s.doc.pointerUp(msg.x * k, msg.y * k, msg.button, msg.mods); break;
            case "wheel": s.doc.wheel(msg.x * k, msg.y * k, msg.deltaX * k, msg.deltaY * k, msg.mods); break;
            case "key": s.doc.key(msg.down, msg.key, msg.code, msg.text, msg.mods); break;
          }
          break;
        }
        case "mutate": {
          const s = docs.get(m.id);
          if (!s) break;
          m.ops.forEach((op) => {
            const node = op.node ?? (op.sel ? s.doc.query(op.sel) : 0);
            // Selector miss / stale node → skip rather than feed the FFI an
            // invalid slotmap key (the Rust side guards too, but this avoids
            // a pointless call). focus(0) is legal — it blurs.
            if (node === 0 && op.op !== "focus") return;
            if (op.op === "text") s.doc.setText(node, op.text);
            else if (op.op === "attr") s.doc.setAttr(node, op.name, op.value);
            else if (op.op === "rattr") s.doc.removeAttr(node, op.name);
            else if (op.op === "style") s.doc.setStyle(node, op.prop, op.value);
            else if (op.op === "innerHtml") s.doc.setInnerHtml(node, op.html);
            else if (op.op === "appendHtml") s.doc.appendHtml(node, op.html);
            else if (op.op === "trimChildren") s.doc.trimChildren(node, op.keep);
            else if (op.op === "focus") s.doc.focus(node);
            else if (op.op === "scrollIntoView") {
              s.doc.scrollIntoView(node, { smooth: op.smooth, vertical: op.vertical, horizontal: op.horizontal });
            }
            else if (op.op === "scrollTo") s.doc.scrollTo(node, op.x, op.y, op.smooth);
            else if (op.op === "click") {
              const r = s.doc.nodeRect(node);
              if (r) {
                const k = s.scale;
                const cx = (r.x + r.w / 2) * k, cy = (r.y + r.h / 2) * k;
                s.doc.pointerMove(cx, cy);
                s.doc.pointerDown(cx, cy, "left");
                s.doc.pointerUp(cx, cy, "left");
              }
            }
          });
          break;
        }
        case "queryAll": {
          const s = docs.get(m.id);
          emit({ type: "nodes", reqId: m.reqId, nodes: s ? s.doc.queryAll(m.sel) : [] });
          break;
        }
        case "getRects": {
          const s = docs.get(m.id);
          emit({
            type: "rects", reqId: m.reqId,
            rects: s ? m.nodes.map((n) => s.doc.nodeRect(n)) : m.nodes.map(() => null),
          });
          break;
        }
        case "getFocused": {
          const s = docs.get(m.id);
          emit({ type: "focused", reqId: m.reqId, node: s ? s.doc.focusedNode() : 0 });
          break;
        }
        case "navSnapshot": {
          const s = docs.get(m.id);
          if (!s) { emit({ type: "navNodes", reqId: m.reqId, nodes: [] }); break; }
          const nodes = s.doc.queryAll(m.sel).map((n) => ({
            node: n,
            rect: s.doc.nodeRect(n),
            zone: (() => {
              const z = s.doc.closest(n, "[data-nav-zone]");
              return z ? s.doc.getAttr(z, "data-nav-zone") : null;
            })(),
            disabled:
              s.doc.getAttr(n, "data-disabled") === "true"
              || s.doc.getAttr(n, "disabled") !== null
              || s.doc.getAttr(n, "aria-disabled") === "true",
            editable: s.doc.getAttr(n, "value") !== null,
          }));
          emit({ type: "navNodes", reqId: m.reqId, nodes });
          break;
        }
        case "getAttr": {
          const s = docs.get(m.id);
          if (!s) { emit({ type: "attr", reqId: m.reqId, value: null }); break; }
          const node = m.node ?? (m.sel ? s.doc.query(m.sel) : 0);
          emit({ type: "attr", reqId: m.reqId, value: node ? s.doc.getAttr(node, m.name) : null });
          break;
        }
        case "getRect": {
          const s = docs.get(m.id);
          if (!s) { emit({ type: "rect", reqId: m.reqId, rect: null }); break; }
          const node = m.node ?? (m.sel ? s.doc.query(m.sel) : 0);
          emit({ type: "rect", reqId: m.reqId, rect: node ? s.doc.nodeRect(node) : null });
          break;
        }
      }
    } catch (err) {
      emit({ type: "error", message: `${m.type}${"id" in m ? ` ${(m as { id?: string }).id}` : ""}: ${String(err)}` });
    }
    pump();
  }

  // Continuous pump for animating docs (CSS transitions/animations keep
  // pending() true). ~60Hz tick; pending() keeps it free when idle.
  const timer = setInterval(pump, 16);

  emit({ type: "ready", caps: { incrementalDom: OsrDoc.caps.incrementalDom } });

  return {
    handle,
    dispose() {
      destroyed = true;
      clearInterval(timer);
      gpuView?.detach();
      gpuView = null;
      for (const s of docs.values()) s.doc.destroy();
      docs.clear();
    },
  };
}
