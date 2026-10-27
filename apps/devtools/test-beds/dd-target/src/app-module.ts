import { AppRenderer } from "@downdraft/engine";
import type { AppModule } from "@downdraft/engine/app/main";
import { createAppMcp } from "@downdraft/engine/app/main";
import { createHtmlUi } from "@downdraft/engine/modules/html-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import { TargetSimHost } from "./sim-host";

const log = createLogger();

// ============================================================================
// dd-target — devtools acceptance fixture.
//
// A synthetic "app" that exercises every channel the viewer consumes:
//   - devtools mirror (ui:"web" — the mirror host; the in-window UI is the
//     devtools overlay below)   → console, threads, metrics, providers
//   - profiling SAB                 → per-thread CPU metrics
//   - sim worker + io worker        → thread list + per-thread eval
//   - devtools-agent (native-entry) → CDP inspector, network capture, jsc heap
//   - fetch loop to a local echo    → network waterfall data
//   - heap churn + console noise    → live console + memory panels
//   - "target-state" provider       → custom panel + interactive controls
// ============================================================================

const BG = { r: 0.07, g: 0.1, b: 0.12, a: 1 };

let simHost: TargetSimHost | null = null;
const state = {
  tick: 0,
  noise: true,
  burn: false,
  heap: [] as unknown[],
  fetches: 0,
  fetchErrors: 0,
};

export const appModule: AppModule = {
  devtools: {
    // Default "devtools" frontend: bootstrap wires the headless backend host
    // and auto-mounts the @downdraft/devtools overlay on F12.
    profiling: true,
    workerHosts: () => {
      const proxy = simHost?.getProxy()?.proxy;
      return proxy ? [{ prefix: "sim", proxy }] : [];
    },
  },

  sim: () => {
    simHost = new TargetSimHost();
    return simHost;
  },
  simConfig: { seed: 1, appmode: 0, rules: {} },

  renderer: (surface) =>
    new AppRenderer(surface, { mode: "2d", clearColor: BG, enableTelemetry: true }),

  ui: (ctx) => {
    const mod = createHtmlUi({
      name: "dd-target-ui",
      nav: false,
      build(ui) {
        ui.mount(
          `<div style="position:absolute;left:12px;top:10px;color:#9fb;font:14px monospace">
             dd-target — devtools fixture
           </div>`,
          { id: "hud", rect: { x: 0, y: 0, w: 900, h: 640 } },
        );
      },
    });
    (ctx.renderer as AppRenderer).useRendererModule(mod);
    // The devtools overlay + self-mirror are auto-mounted by bootstrap (F12).
    return { start() {}, dispose() {} };
  },

  mcp: (ctx) => {
    const renderer = ctx.renderer as AppRenderer;
    createAppMcp({
      appId: "downdraft-dd-target",
      surface: ctx.surface,
      isRunning: () => renderer.isRunning?.() ?? true,
      renderOnce: () => renderer.renderOnce?.(),
      pauseRendering: () => renderer.stop(),
      resumeRendering: () => renderer.start(),
      getWorldState: () => ({ ...state, heap: state.heap.length }),
      getUiState: () => ({ hud: true }),
      conditionVars: { app: () => state },
    });
  },

  onReady: (ctx) => {
    const renderer = ctx.renderer as AppRenderer;
    const dbg = (renderer as unknown as { nativeDebugger?: {
      devtoolsMirror: {
        registerProvider: (n: string, f: () => unknown) => void;
        registerCommandHandler: (n: string, f: (c: { action: string; payload: string }) => void) => void;
      };
      registerThreadEval: (n: string, f: (e: string) => Promise<unknown>) => void;
    } }).nativeDebugger;
    if (!dbg) {
      log.warn("dd-target", "nativeDebugger unavailable — devtools not wired");
      return;
    }

    // ── Custom provider panel: "target-state" ──
    dbg.devtoolsMirror.registerProvider("target-state", () => ({
      status: "ok",
      sections: [
        {
          kind: "kv", name: "Runtime",
          rows: [
            { key: "tick", value: String(state.tick) },
            { key: "heap items", value: String(state.heap.length) },
            { key: "fetches", value: `${state.fetches} (${state.fetchErrors} err)` },
            { key: "noise", value: state.noise ? "on" : "off" },
          ],
        },
        {
          kind: "series", name: "Load",
          series: [
            { name: "heap", values: [state.heap.length % 1000, (state.heap.length * 1.3) % 1000] },
          ],
        },
        {
          kind: "controls", name: "Controls",
          controls: [
            { type: "button", id: "gc", label: "Force GC" },
            { type: "button", id: "throw", label: "Emit exception" },
            { type: "button", id: "burst", label: "Console burst" },
            { type: "checkbox", id: "noise", label: "Periodic noise", checked: state.noise },
          ],
        },
      ],
    }));
    dbg.devtoolsMirror.registerCommandHandler("target-state", async (cmd) => {
      if (cmd.action === "gc") {
        try { (await import("bun:jsc")).gcAndSweep?.(); } catch { /* not bun */ }
      } else if (cmd.action === "throw") {
        // Uncaught throw would kill the Bun process — surface it as an
        // error entry instead so devtools can exercise its error path.
        setTimeout(() => {
          try {
            const fail = () => { throw new Error("dd-target deliberate exception"); };
            fail();
          } catch (err) {
            console.error(err);
          }
        }, 0);
      } else if (cmd.action === "burst") {
        for (let i = 0; i < 20; i++) console.log(`burst ${i} ${JSON.stringify({ i, ts: Date.now() })}`);
      } else if (cmd.action === "noise") {
        state.noise = cmd.payload === "true" || cmd.payload === "1" || cmd.payload === "on";
      }
    });

    // ── Second eval thread: plain worker round-trip ──
    try {
      const io = new Worker(new URL("./io-worker.ts", import.meta.url), { type: "module" });
      const pending = new Map<number, (r: unknown) => void>();
      let seq = 0;
      io.onmessage = (e: MessageEvent) => {
        const { id, result } = (e.data ?? {}) as { id?: number; result?: { ok: boolean; value?: string; error?: string } };
        const res = pending.get(id ?? -1);
        if (res) { pending.delete(id ?? -1); res(result?.ok ? { result: result.value } : { error: result?.error }); }
      };
      dbg.registerThreadEval("io", (expr) => new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve as (r: unknown) => void);
        io.postMessage({ id, expr });
      }));
    } catch (e) {
      log.warn("dd-target", `io worker failed: ${e}`);
    }

    // ── Console noise — every severity + structured objects ──
    let n = 0;
    setInterval(() => {
      state.tick++;
      if (!state.noise) return;
      n++;
      console.log(`tick ${n} entities=${512} heap=${state.heap.length}`);
      if (n % 5 === 0) console.info(`info checkpoint`, { n, mem: process.memoryUsage().heapUsed });
      if (n % 7 === 0) console.warn(`warning: cache miss rate ${(n % 13) / 10}`, { region: "assets" });
      if (n % 11 === 0) console.error(new Error(`recoverable fault #${n}`));
      if (n % 13 === 0) console.log({ deep: { nested: { object: [1, 2, { three: 3 }], str: "value" } }, arr: [1, "two", null, true] });
      if (n % 17 === 0) console.debug("debug detail", new Uint8Array([1, 2, 3, 4, 255]));
    }, 900);

    // ── Heap churn on main thread ──
    setInterval(() => {
      state.heap.push(Array.from({ length: 2000 }, (_, i) => ({ i, s: "y".repeat(32) })));
      if (state.heap.length > 400) state.heap.splice(0, 100);
      if (state.burn) {
        const t0 = performance.now();
        let acc = 0;
        for (; performance.now() - t0 < 6;) acc += Math.random();
        void acc;
      }
    }, 400);

    // ── Network loop — Bun.serve echo + periodic fetches ──
    try {
      const srv = Bun.serve({
        port: 0,
        fetch(req) {
          const u = new URL(req.url);
          if (u.pathname === "/echo") {
            return new Response(JSON.stringify({ ok: true, t: Date.now() }), {
              headers: { "content-type": "application/json" },
            });
          }
          if (u.pathname === "/big") {
            return new Response("x".repeat(64 * 1024), { headers: { "content-type": "text/plain" } });
          }
          if (u.pathname === "/slow") {
            return new Promise((r) => setTimeout(() => r(new Response("slow")), 250));
          }
          return new Response("nf", { status: 404 });
        },
      });
      const base = `http://127.0.0.1:${srv.port}`;
      log.info("dd-target", `echo server on ${base}`);
      let fi = 0;
      setInterval(() => {
        fi++;
        const path = ["/echo", "/echo?x=" + fi, "/big", "/slow", "/missing", "/echo"][fi % 6];
        fetch(base + path)
          .then(() => state.fetches++)
          .catch(() => state.fetchErrors++);
      }, 1100);
    } catch (e) {
      log.warn("dd-target", `echo server unavailable: ${e}`);
    }

    log.info("dd-target", "fixture ready — providers registered, noise + fetch loops running");
  },
};
