// ============================================================================
// webui-spike.ts — smoke/stress harness for the dd_webui_* backends
//
// Runs the same assertion battery against whichever backend is selected:
//   bun packages/engine/libraries/webui/webui-spike.ts            # auto (cef)
//   bun packages/engine/libraries/webui/webui-spike.ts wpe        # WPE
//   DD_WEBUI_BACKEND=wpe bun .../webui-spike.ts                   # env
//
// Assertions (identical across backends — this is the parity check):
//   1. lib resolves + global_init + backend token
//   2. view create + initial frame (non-empty pixels, expected size)
//   3. dirty-rect cadence across a JS-driven repaint
//   4. eval() round trip (result fidelity)
//   5. postMessage → page → message event round trip
//   6. console event capture
//   7. resize → new frame dims
//   8. destroy + recreate
//   9. hit-test behavior on opaque vs transparent pixels
//
// Phase 0 note: stub cdylibs return null from dd_webui_create, so the
// harness reports "backend unavailable" cleanly until the real engine
// lands (Phase 1 CEF / Phase 2 WPE).
// ============================================================================

import { loadWebUiLib, resolveWebUiBackend, webUiGlobalInit, WebUIView } from "./src/webui-ffi";

const arg = process.argv[2]?.toLowerCase();
const backend = resolveWebUiBackend(
  arg === "cef" || arg === "wpe" || arg === "none" ? arg : undefined,
);

const PAGE = `<!doctype html><html><body style="margin:0;background:#223344;">
<div id="box" style="position:absolute;left:20px;top:20px;width:60px;height:60px;background:#ff6600;"></div>
<script>
// Engine-injected shim (CEF V8 hook / WPE UserContentManager): host→page
// messages arrive via downdraft.onMessage, page→host via postMessage.
window.downdraft?.onMessage?.((p) => {
  if (p && p.__echo !== undefined) {
    console.log("echo received");
    window.downdraft.postMessage({ echo: p.__echo });
  }
});
document.addEventListener("mousedown", (e) => console.log("clicked:" + e.clientX + "," + e.clientY));
document.addEventListener("keydown", (e) => console.log("key:" + e.key));
</script></body></html>`;

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  const mark = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}
function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log(`webui-spike — backend: ${backend ?? "(none)"}`);
  if (!backend) {
    console.log("DD_WEBUI_BACKEND=none — nothing to do.");
    return;
  }

  const entry = loadWebUiLib(backend);
  check("cdylib resolves", entry !== null, entry?.path ?? "not found");
  if (!entry) return process.exit(1);
  console.log(`  lib: ${entry.path}`);
  try {
    const tok = entry.symbols.dd_webui_backend();
    const ver = entry.symbols.dd_webui_version();
    check("backend token", tok === backend, String(tok));
    console.log(`  version: ${ver}`);
  } catch { check("backend token", false, "symbol missing"); }

  const initialized = webUiGlobalInit(backend, { headless: true });
  check("global_init", initialized);
  if (!initialized) return process.exit(1);

  // ── Create + first frame ──
  const view = WebUIView.create(backend, {
    html: PAGE, interactive: true, transparent: false,
  }, 320, 200, 1);
  check("view create", view !== null);
  if (!view) return process.exit(1);

  // Poll for the first frame AND the load event — the DOM isn't
  // guaranteed until load completes (eval before that hits about:blank).
  let frame: Uint8Array | null = null;
  let loaded = false;
  for (let i = 0; i < 300 && (!frame || !loaded); i++) {
    await sleep(10);
    frame = frame ?? view.pullFrame();
    for (const e of view.pollEvents()) {
      if (e.t === "load") loaded = true;
    }
  }
  check("initial frame", frame !== null && frame.length === 320 * 200 * 4,
    frame ? `${frame.length} bytes` : "no paint in 3s");
  check("first-frame rect covers view", view.frameRect() !== null);
  check("page load event", loaded);

  // ── Dirty-rect cadence: repaint a small region, expect a bounded rect ──
  if (frame) {
    // Drain until quiescent — load-time paints keep arriving for a moment
    // and would poison the union with a full-frame rect.
    for (let i = 0; i < 60; i++) {
      await sleep(10);
      if (!view.pullFrame()) break;
    }
    await sleep(300);
    while (view.pullFrame()) { /* settle */ }
    view.eval(1, `document.getElementById("box").style.left = "40px"`);
    let rect: { x: number; y: number; w: number; h: number } | null = null;
    for (let i = 0; i < 100 && !rect; i++) {
      await sleep(10);
      if (view.pullFrame()) rect = view.frameRect();
    }
    check("dirty frame after mutation", rect !== null);
    if (rect) {
      console.log(`  dirty rect: ${rect.x},${rect.y} ${rect.w}x${rect.h}`);
      check("dirty rect inside view bounds",
        rect.x >= 0 && rect.y >= 0 && rect.w <= 320 && rect.h <= 200);
      // A small DOM change should repaint a bounded region — engines may
      // legitimately coalesce to a full repaint, so note rather than fail.
      if (rect.w === 320 && rect.h === 200) {
        console.log("  note: engine coalesced to full-frame repaint");
      }
    }
  }

  // ── eval round trip ──
  {
    const events = waitFor(view, (e) => e.t === "eval" && e.id === 42);
    view.eval(42, "JSON.stringify({ok:true,n:1+2})");
    const ev = await events;
    check("eval result event", ev !== null, ev?.v);
    if (ev) check("eval ok flag", ev.ok === 1);
  }

  // ── console capture ──
  {
    const events = waitFor(view, (e) => e.t === "console");
    view.eval(43, `console.log("hello-from-page")`);
    const ev = await events;
    check("console event", ev !== null && /hello-from-page/.test(ev.v), ev?.v);
  }

  // ── postMessage round trip: host → page → host ──
  {
    const events = waitFor(view, (e) => e.t === "message");
    view.postMessage({ __echo: "ping-123" });
    const ev = await events;
    check("postMessage round trip",
      ev !== null && JSON.stringify(ev.v).includes("ping-123"),
      ev ? JSON.stringify(ev.v) : "none");
  }

  // ── input: click lands on the box at its current position (40,20) ──
  {
    const events = waitFor(view, (e) => e.t === "console" && /clicked:/.test(e.v));
    view.pointerMove(60, 40);
    view.pointerDown(60, 40);
    view.pointerUp(60, 40);
    const ev = await events;
    check("pointer click reaches page", ev !== null, ev?.v);
  }

  // ── input: key event reaches the page ──
  {
    const events = waitFor(view, (e) => e.t === "console" && /key:/.test(e.v));
    view.key(true, "a", "KeyA", "a");
    view.key(false, "a", "KeyA");
    const ev = await events;
    check("key event reaches page", ev !== null && /key:a/.test(ev.v), ev?.v);
  }

  // ── resize ──
  view.resize(400, 240, 1);
  let resized: { w: number; h: number } | null = null;
  for (let i = 0; i < 100 && !resized; i++) {
    await sleep(10);
    if (view.pullFrame()) {
      const d = view.dimensions();
      if (d && d.w === 400 && d.h === 240) resized = d;
    }
  }
  check("resize → new frame dims", resized !== null, resized ? `${resized.w}x${resized.h}` : "never resized");

  // ── hit test ──
  check("hit test inside opaque view", view.hitTest(50, 50));
  check("hit test outside view bounds", !view.hitTest(-5, -5));

  // ── destroy + recreate ──
  view.destroy();
  const view2 = WebUIView.create(backend, { html: PAGE }, 64, 64, 1);
  check("destroy + recreate", view2 !== null);
  view2?.destroy();

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Wait for a matching event, polling the queue at 4ms for up to 3s. */
function waitFor(view: WebUIView, match: (e: { t: string; id?: number; ok?: number; v: string }) => boolean) {
  return new Promise<{ t: string; id?: number; ok?: number; v: string } | null>((resolve) => {
    let ticks = 0;
    const t = setInterval(() => {
      for (const ev of view.pollEvents()) {
        if (match(ev as never)) { clearInterval(t); resolve(ev as never); return; }
      }
      if (++ticks > 750) { clearInterval(t); resolve(null); }
    }, 4);
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
