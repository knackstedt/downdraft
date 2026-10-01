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
  post(msg: UiToWorker, transfer?: Transferable[]): void;
  onMessage(fn: (msg: WorkerToUi) => void): void;
  dispose(): void;
}

/** In-process backend — same code path as the worker, minus the thread. */
export function createLocalBackend(): DocBackend {
  let sink: ((m: WorkerToUi) => void) | null = null;
  let core: { handle(m: UiToWorker): void; dispose(): void } | null = null;
  return {
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
  stats: { frames: number; resolveMs: number; paintMs: number; diffMs: number; bytes: number };
  statsLast: number;
}

// Bound-buffer header (u32 indices) — mirrors BoundBuf layout in lib.rs.
const H_SEQ = 0, H_X = 1, H_Y = 2, H_W = 3, H_H = 4, H_PW = 5, H_PH = 6, H_STRIDE = 8;

function freshStats() {
  return { frames: 0, resolveMs: 0, paintMs: 0, diffMs: 0, bytes: 0 };
}

export function createDocCore(emit: (m: WorkerToUi) => void): {
  handle(m: UiToWorker): void;
  dispose(): void;
} {
  const docs = new Map<string, DocState>();
  let destroyed = false;

  /** Allocate + bind the doc's SAB frame channel; emits a bind message. */
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
          emitSabFrame(id, s);
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
              emitSabFrame(id, s);
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
          docs.get(m.id)?.doc.destroy();
          if (/float\s*:/.test(m.html)) emit({ type: "error", id: m.id, message: "CSS float hangs Blitz layout — use flex instead" });
          const doc = OsrDoc.create(m.cssW * m.scale, m.cssH * m.scale, m.scale, m.html);
          if (!doc) { emit({ type: "error", id: m.id, message: "OsrDoc.create failed" }); return; }
          const s: DocState = {
            doc, scale: m.scale, cssW: m.cssW, cssH: m.cssH,
            maxFps: m.maxFps ?? 0, lastFrame: -1e9,
            sab: null, sabU32: null, sabDisabled: false,
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
          if (s?.sabU32 && s.doc.refreshInto() === 1) emitSabFrame(m.id, s);
          break;
        }
        case "destroy": docs.get(m.id)?.doc.destroy(); docs.delete(m.id); break;
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
            else if (op.op === "focus") s.doc.focus(node);
            else if (op.op === "scrollIntoView") {
              s.doc.scrollIntoView(node, { smooth: op.smooth, vertical: op.vertical, horizontal: op.horizontal });
            }
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

  emit({ type: "ready" });

  return {
    handle,
    dispose() {
      destroyed = true;
      clearInterval(timer);
      for (const s of docs.values()) s.doc.destroy();
      docs.clear();
    },
  };
}
