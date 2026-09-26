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
}

export function createDocCore(emit: (m: WorkerToUi) => void): {
  handle(m: UiToWorker): void;
  dispose(): void;
} {
  const docs = new Map<string, DocState>();
  let destroyed = false;

  function pump() {
    const now = performance.now();
    for (const [id, s] of docs.entries()) {
      const events = s.doc.pollEvents();
      if (events.length) emit({ type: "events", id, events });
      if (!s.doc.pending()) continue;
      if (s.maxFps > 0 && now - s.lastFrame < 1000 / s.maxFps) continue;
      const pixels = s.doc.frame();
      if (!pixels) continue;
      s.lastFrame = now;
      const rect = s.doc.frameRect();
      const pw = s.doc.width;
      const ph = s.doc.height;
      if (rect && (rect.w < pw || rect.h < ph)) {
        // Slice dirty rows into a tight buffer for a partial upload.
        const tight = new Uint8Array(rect.w * rect.h * 4);
        for (let r = 0; r < rect.h; r++) {
          const src = (rect.y + r) * pw * 4 + rect.x * 4;
          tight.set(pixels.subarray(src, src + rect.w * 4), r * rect.w * 4);
        }
        emit({ type: "frame", id, x: rect.x, y: rect.y, w: rect.w, h: rect.h, pw, ph, pixels: tight.buffer });
      } else {
        const copy = pixels.slice();
        emit({ type: "frame", id, x: 0, y: 0, w: pw, h: ph, pw, ph, pixels: copy.buffer as ArrayBuffer });
      }
    }
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
          docs.set(m.id, { doc, scale: m.scale, cssW: m.cssW, cssH: m.cssH, maxFps: m.maxFps ?? 0, lastFrame: -1e9 });
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
          if (s) { s.doc.resize(m.cssW * m.scale, m.cssH * m.scale, m.scale); s.scale = m.scale; s.cssW = m.cssW; s.cssH = m.cssH; }
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
          });
          break;
        }
        case "getAttr": {
          const s = docs.get(m.id);
          if (!s) { emit({ type: "attr", reqId: m.reqId, value: null }); break; }
          const node = m.node ?? (m.sel ? s.doc.query(m.sel) : 0);
          emit({ type: "attr", reqId: m.reqId, value: node ? s.doc.getAttr(node, m.name) : null });
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
