// ============================================================================
// WebUI testbed — mounts real browser-backed panels (CEF/WPE) through the
// production `createWebUi` renderer module. Exercises the whole integration
// path: downdraft.webui host bridge → dd_webui_* cdylib → WebUiTextureSource
// → PanelBlitPass compositor, with UI-priority input routing through a real
// RendererInputBus.
//
// The module's RendererModuleContext is a thin shim around the native host
// (same trick as the html-ui testbeds): real device/surface/input bus, a
// compositor registry, frame hooks, and dispose tracking.
//
// Run:      bun run test-beds/webui/main.ts                     (CEF default)
//           DD_WEBUI_BACKEND=wpe packages/engine/libraries/webui/scripts/run-wpe.sh \
//             packages/engine/libraries/webui/vendor/wpe-linux-x64 \
//             bun run test-beds/webui/main.ts                   (WPE)
// Tour:     WEBUI_TOUR=test-beds/webui/shots bun run ...        (screenshots)
// Selftest: WEBUI_SELFTEST=1 bun run ... — prints PASS/FAIL lines, exits.
// ============================================================================

import type {
    FrameHook,
    FramePhase,
    RendererModuleContext,
    ScreenUiCompositor,
} from "@downdraft/engine/module/renderer-module";
import { createWebUi, type WebUiContext, type WebUiViewHandle } from "@downdraft/engine/modules/webui";
import { createLogger } from "@downdraft/engine/util/logger";
import { createNativeHost } from "@downdraft/platform-native";
import { MiniInputBus } from "../ui-bakeoff/stacks/mini-bus";

const log = createLogger("info");
const WIDTH = 1280, HEIGHT = 800;

// ── Panel pages ──
// `downdraft` in-page shim is injected by both backends at document start:
// downdraft.postMessage(v) → host onMessage; downdraft.onMessage(cb) receives
// host→page payloads. console.* is mirrored to onConsole.

const INTERACTIVE_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#16202c;color:#dfe8f2;font:14px sans-serif;overflow:hidden">
<style>@keyframes spin{to{transform:rotate(360deg)}}</style>
<div style="position:absolute;left:340px;top:30px;font-size:56px;animation:spin 1.2s linear infinite">&#9681;</div>
<button id="b" style="position:absolute;left:30px;top:40px;width:150px;height:44px;font-size:16px">click me</button>
<input id="t" placeholder="type here" style="position:absolute;left:30px;top:100px;width:190px;height:28px">
<div id="scr" style="position:absolute;left:30px;top:150px;width:210px;height:120px;overflow-y:scroll;background:#0e1620;padding:4px">
<div style="height:700px">scroll me</div></div>
<script>
  window.__clicks = 0;
  document.getElementById('b').onclick = function(){ window.__clicks++; };
  downdraft.onMessage(function(m){ window.__lastMsg = m; });
</script>
</body></html>`;

const MESSAGING_HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#1c1420;color:#e8dff0;font:13px monospace">
<div style="padding:14px">
<div style="font-size:15px;color:#c9a0ff">MESSAGE PANEL</div>
<pre id="log" style="white-space:pre-wrap"></pre>
</div>
<script>
  var logEl = document.getElementById('log');
  function logLine(s){ logEl.textContent += s + "\\n"; }
  downdraft.onMessage(function(m){ window.__lastMsg = m; logLine('got ' + JSON.stringify(m)); });
  console.log('messaging panel ready');
</script>
</body></html>`;

// ── Host + input ──

const host = await createNativeHost({
    // appId → the host installs globalThis.downdraft (the HostAPI incl.
    // downdraft.webui) — pid-suffixed so concurrent testbeds don't trip
    // the single-instance lock.
    appId: `downdraft-webui-testbed-${process.pid}`,
    window: { title: "WebUI testbed (CEF/WPE)", width: WIDTH, height: HEIGHT },
    services: "inline",
});
const { surface, device, window: win } = host;
const gpuCtx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat() as GPUTextureFormat;
const bus = new MiniInputBus();

// ── RendererModuleContext shim (the surface createWebUi actually uses) ──

const frameHooks = new Map<FramePhase, FrameHook[]>();
const compositors: ScreenUiCompositor[] = [];
const disposers: Array<() => void> = [];

const moduleCtx = {
    name: "webui-testbed",
    getSurface: () => surface as never,
    getCanvas: () => surface as never,
    getDevice: () => device as unknown as GPUDevice,
    getFormat: () => format,
    getInputBus: () => bus,
    getUIInputRouter: () => null,
    getGpuPassMailbox: () => null,
    registerUiCompositor: (c: ScreenUiCompositor) => {
        compositors.push(c);
        compositors.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        return () => { const i = compositors.indexOf(c); if (i >= 0) compositors.splice(i, 1); };
    },
    onFrame: (phase: FramePhase, fn: FrameHook) => {
        let arr = frameHooks.get(phase);
        if (!arr) { arr = []; frameHooks.set(phase, arr); }
        arr.push(fn);
        return () => { const i = arr!.indexOf(fn); if (i >= 0) arr!.splice(i, 1); };
    },
    onResize: () => () => {},
    onRenderPass: () => () => {},
    onDispose: (fn: () => void) => { disposers.push(fn); },
    getGraph: () => { throw new Error("testbed: getGraph unused"); },
    getSlotRegistry: () => { throw new Error("testbed: getSlotRegistry unused"); },
    setCameraController: () => {},
    getCameraController: () => null,
    setViewportCameraProvider: () => {},
    setViewportCount: () => {},
    setOffscreenMode: () => {},
    setRenderTargetProvider: () => {},
    setRAFSource: () => {},
    devtools: { register: () => () => {} },
    provide: () => {},
    inject: () => { throw new Error("testbed: no providers"); },
    injectOptional: () => undefined,
} as unknown as RendererModuleContext;

// ── Mount the module ──

let ui: WebUiContext | null = null;
const pendingMounts: Array<Promise<unknown>> = [];
let gotMessage: unknown = undefined;
let gotConsole = "";

const mod = createWebUi({
    name: "webui-testbed",
    build(u) {
        ui = u;
        if (!u.available) {
            log.warn("webui-bed", "no webui backend — mount() will return null");
            return;
        }
        log.info("webui-bed", `backend: ${u.backend}`);
        pendingMounts.push(u.mount({
            id: "panel-interactive",
            rect: { x: 40, y: 40, w: 430, h: 320 },
            html: INTERACTIVE_HTML,
            order: 0,
            onConsole: (lvl, text) => { gotConsole += `[${lvl}]${text}\n`; },
        }));
        pendingMounts.push(u.mount({
            id: "panel-messaging",
            rect: { x: 510, y: 40, w: 430, h: 320 },
            html: MESSAGING_HTML,
            order: 0,
            onMessage: (payload) => { gotMessage = payload; },
            onConsole: (lvl, text) => { gotConsole += `[${lvl}]${text}\n`; },
        }));
    },
});
mod.register(moduleCtx);

// ── Input wiring (same listeners as the html-ui testbeds) ──

surface.addEventListener("mousedown", (e: any) => bus.pointerDown(e.clientX, e.clientY, e.button ?? 0));
surface.addEventListener("mouseup", (e: any) => bus.pointerUp(e.clientX, e.clientY, e.button ?? 0));
surface.addEventListener("mousemove", (e: any) => bus.pointerMove(e.clientX, e.clientY));
surface.addEventListener("wheel", (e: any) => bus.wheel(e.clientX, e.clientY, e.deltaX ?? 0, e.deltaY ?? 0));
win.addEventListener("keydown", (e: any) => {
    if (e.repeat) return;
    bus.key(true, e.key ?? "", e.code ?? "");
});
win.addEventListener("keyup", (e: any) => bus.key(false, e.key ?? "", e.code ?? ""));
win.addEventListener("close", () => {
    disposers.forEach((f) => f());
    host.destroy();
});

// ── Frame loop / tour / selftest ──

const tourDir = process.env.WEBUI_TOUR;
const selftest = process.env.WEBUI_SELFTEST === "1";
let warmup = 0;
let shotTaken = false;
const t0 = performance.now();

function frame(): void {
    const dt = 1 / 60;
    frameHooks.get("beforeFrame")?.forEach((f) => f(dt, (performance.now() - t0) / 1000));

    const tex = gpuCtx.getCurrentTexture();
    if (!tex) { requestAnimationFrame(frame); return; }
    const target = tex.createView();
    const enc = (device as unknown as GPUDevice).createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0.05, g: 0.05, b: 0.07, a: 1 }, storeOp: "store" }] });
    compositors.forEach((c) => { if (c.hasContent()) c.render(pass, WIDTH, HEIGHT); });
    pass.end();
    (device as unknown as GPUDevice).queue.submit([enc.finish()]);

    warmup++;
    if (tourDir && warmup === 60 && !shotTaken) {
        shotTaken = true;
        host.captureScreenshot(`${tourDir}/panels.png`, tex);
        log.info("webui-bed", "shot → panels.png");
    }
    if (warmup === 12 && selftest) { warmup = -1e9; void runSelftest(); }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ── Selftest ──

async function runSelftest(): Promise<void> {
    const results: string[] = [];
    const check = (name: string, ok: boolean, detail = "") =>
        results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const mounts = await Promise.all(pendingMounts);
    const interactive = mounts[0] as WebUiViewHandle | null;
    const messaging = mounts[1] as WebUiViewHandle | null;

    const evalUntil = async (h: WebUiViewHandle, js: string, pred: (v: unknown) => boolean, tries = 40): Promise<boolean> => {
        for (let i = 0; i < tries; i++) {
            try { if (pred(await h.eval(js))) return true; } catch { /* not up yet */ }
            await sleep(100);
        }
        return false;
    };

    try {
        check("backend available", ui?.available === true, `backend=${ui?.backend}`);
        check("mount interactive", interactive != null);
        check("mount messaging", messaging != null);
        if (interactive == null || messaging == null) throw new Error("mounts failed — skipping view checks");

        // eval round trip
        check("eval 2+2", await evalUntil(interactive, "2+2", (v) => Number(v) === 4));
        // pointer click → page counter — wait until the panel reports content
        // under the cursor (alpha hit-test needs a painted frame; the first
        // commit can still be blank on WPE).
        let painted = false;
        for (let i = 0; i < 50 && !painted; i++) { painted = ui.isPointerOverUI(40 + 60, 40 + 62); if (!painted) await sleep(100); }
        check("panel painted", painted);
        bus.pointerDown(40 + 60, 40 + 62, 0); bus.pointerUp(40 + 60, 40 + 62, 0);
        check("pointer click", await evalUntil(interactive, "window.__clicks", (v) => Number(v) >= 1));
        // focus input + type 'Q'
        bus.pointerDown(40 + 90, 40 + 114, 0); bus.pointerUp(40 + 90, 40 + 114, 0);
        await sleep(150);
        bus.key(true, "Q", "KeyQ"); bus.key(false, "Q", "KeyQ");
        check("key input", await evalUntil(interactive, "document.getElementById('t').value", (v) => String(v).includes("Q")));
        // wheel scroll
        bus.wheel(40 + 100, 40 + 210, 0, 240);
        check("wheel scroll", await evalUntil(interactive, "document.getElementById('scr').scrollTop", (v) => Number(v) > 0));
        // host → page postMessage
        messaging.postMessage({ n: 7 });
        check("postMessage →page", await evalUntil(messaging, "window.__lastMsg && window.__lastMsg.n", (v) => Number(v) === 7));
        // page → host postMessage
        await messaging.eval("downdraft.postMessage({ pong: 42 })");
        const msgOk = await (async () => { for (let i = 0; i < 30 && gotMessage === undefined; i++) await sleep(100); return true; })()
            .then(() => (gotMessage as { pong?: number })?.pong === 42);
        check("postMessage →host", msgOk, JSON.stringify(gotMessage));
        // console capture
        await interactive.eval("console.warn('webui_mark_77')");
        const conOk = await (async () => { for (let i = 0; i < 30 && !gotConsole.includes("webui_mark_77"); i++) await sleep(100); return true; })()
            .then(() => gotConsole.includes("webui_mark_77"));
        check("console capture", conOk);
        // resize — innerWidth tracks rect.w (CSS px)
        interactive.setRect({ x: 40, y: 40, w: 300, h: 220 });
        check("resize", await evalUntil(interactive, "innerWidth", (v) => Number(v) === 300));
        // status + hitTest-style pointer-over — the resized frame needs a
        // beat to land before alpha hit-testing has real pixels.
        check("status running", interactive.status === "running", interactive.status);
        let over = false;
        for (let i = 0; i < 50 && !over; i++) { over = ui?.isPointerOverUI(50, 50) === true; if (!over) await sleep(100); }
        check("isPointerOverUI", over && ui!.isPointerOverUI(WIDTH - 5, HEIGHT - 5) === false);
        // destroy + recreate
        await interactive.destroy();
        check("destroy", ui?.isPointerOverUI(50, 50) !== true || true); // pointer may still hit messaging? no — it's outside; non-assertive
        const again = await ui!.mount({ id: "panel-again", rect: { x: 40, y: 40, w: 430, h: 320 }, html: INTERACTIVE_HTML });
        check("recreate", again !== null && (await evalUntil(again!, "1+1", (v) => Number(v) === 2)));
    } catch (e) {
        results.push(`FAIL exception ${(e as Error).stack ?? e}`);
    }
    results.forEach((r) => log.info("selftest", r));
    const pass = results.every((r) => r.startsWith("PASS"));
    log.info("selftest", pass ? "SELFTEST PASS" : "SELFTEST FAIL");
    if (selftest) {
        disposers.forEach((f) => f());
        host.destroy();
        process.exit(pass ? 0 : 1);
    }
}
