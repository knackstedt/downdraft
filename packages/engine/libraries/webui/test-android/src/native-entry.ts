// ============================================================================
// webui-android-test — on-device validation for the WPE WebUI backend.
//
// Runs under the shell's embedded libnode (libdowndraft_android). Exercises
// the same battery as libraries/webui/webui-spike.ts does on Linux —
// global init (WKRuntime JNI bootstrap), view create (WPEAndroidViewBackend
// + WebKitWebView), AHardwareBuffer frame delivery, eval/message/console
// bridge, input, resize, hit test, destroy/recreate — and reports each
// check to logcat (tag "downdraft") as WEBUI-TEST lines:
//
//   adb logcat -s downdraft:D | grep WEBUI-TEST
// ============================================================================

import {
    loadWebUiLib,
    resolveWebUiBackend,
    webUiGlobalInit,
    webUiGlobalShutdown,
    WebUIView,
} from "@downdraft/engine/libraries/webui/webui-ffi";
import { dlopen } from "@downdraft/platform-native/ffi/ffi-adapter";

const HTML = `<!doctype html><html><body style="margin:0;background:#123">
<div id="box" style="position:absolute;left:20px;top:20px;width:60px;height:60px;background:#e33"></div>
<script>
  // Keep repainting — a static page may only commit one (blank) frame.
  const colors = ["#e33", "#3e3", "#33e", "#ee3"];
  let ci = 0;
  setInterval(() => {
    document.getElementById("box").style.background = colors[ci++ % 4];
  }, 150);
  document.getElementById("box").addEventListener("click", (e) => {
    console.log("clicked:" + e.clientX + "," + e.clientY);
  });
  document.addEventListener("keydown", (e) => console.log("key:" + e.key));
  globalThis.downdraft.onMessage((msg) => {
    globalThis.downdraft.postMessage({ echo: msg });
  });
<\/script>
</body></html>`;

type Check = { name: string; ok: boolean; detail?: string };
const checks: Check[] = [];
const check = (name: string, ok: boolean, detail?: string) => {
  checks.push({ name, ok, detail });
  console.log(`WEBUI-TEST ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll events until predicate matches or timeout. */
async function waitEvent(
  view: WebUIView,
  pred: (e: { t?: string }) => boolean,
  timeoutMs = 30000,
): Promise<{ t?: string } | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const e of view.pollEvents()) if (pred(e)) return e;
    await sleep(20);
  }
  return null;
}

async function pullNextFrame(view: WebUIView, timeoutMs = 30000): Promise<Uint8Array | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const f = view.pullFrame();
    if (f) return f;
    await sleep(20);
  }
  return null;
}

async function main() {
  console.log("WEBUI-TEST begin — android WPE backend validation");

  // 1. backend resolution → wpe on android
  const backend = resolveWebUiBackend();
  check("backend resolves to wpe", backend === "wpe", `got ${backend}`);

  // 2. cdylib loads by soname + reports a version
  const entry = backend ? loadWebUiLib(backend) : null;
  check("cdylib dlopen", !!entry);
  const version = entry ? String(entry.symbols.dd_webui_version()) : "";
  check("version token", version.includes("wpe"), version);

  if (!entry) return done();

  // 3. global init — JNI WKRuntime.initialize(Context) bootstrap inside
  const ok = webUiGlobalInit(backend as "wpe", {});
  check("global init (WKRuntime bootstrap)", ok);
  if (!ok) return done();

  // 4. view create — WPEAndroidViewBackend + WebKitWebView
  const view = WebUIView.create("wpe", { html: HTML, transparent: false, interactive: true }, 400, 240, 1);
  check("view create", !!view);
  if (!view) return done();

  // 5. load event + first frame (AHardwareBuffer → FrameBuf copy)
  const loaded = await waitEvent(view, (e) => e.t === "load");
  check("load event", !!loaded);
  const frame = await pullNextFrame(view);
  check("first frame", !!frame, frame ? `${frame.byteLength}B` : "none");
  // Early commits can precede real content and page-driven repaints may be
  // throttled — poke damage via eval and pull until nonzero.
  let nonZero = frame ? frame.some((b) => b !== 0) : false;
  let pulled = 0;
  if (!nonZero) {
    const deadline = Date.now() + 15000;
    for (let n = 0; !nonZero && Date.now() < deadline; n++) {
      view.eval(90 + n, `document.body.style.background="rgb(${200 - (n * 29) % 100},${64 + (n * 53) % 128},${64 + (n * 97) % 128})"`);
      const f2 = await pullNextFrame(view, 3000);
      if (f2) {
        pulled++;
        nonZero = f2.some((b) => b !== 0);
      }
    }
  }
  check("frame has pixels", nonZero, `pulled=${pulled}`);

  // 6. eval round trip — {t:"eval",id,ok,v:"<json string>"}
  view.eval(7, "({ ok: true, n: 40 + 2 })");
  const evalEv = await waitEvent(view, (e) => e.t === "eval" && (e as { id?: number }).id === 7);
  const evalV = (() => {
    try {
      return JSON.parse((evalEv as { v?: string } | null)?.v ?? "null") as { n?: number };
    } catch {
      return null;
    }
  })();
  check("eval result", evalV?.n === 42, JSON.stringify(evalEv ?? null));

  // 7. postMessage host→page→host round trip
  view.postMessage({ ping: 123 });
  const echo = await waitEvent(
    view,
    (e) => e.t === "message" && (e as { v?: { echo?: { ping?: number } } }).v?.echo?.ping === 123,
  );
  check("postMessage round trip", !!echo);

  // 8. console capture (wrapped console.* → host)
  view.eval(8, 'console.log("console-probe")');
  const con = await waitEvent(
    view,
    (e) => e.t === "console" && String((e as { v?: unknown }).v).includes("console-probe"),
  );
  check("console capture", !!con);

  // 9. pointer input → click at the box center
  view.pointerMove(50, 50);
  view.pointerDown(50, 50);
  view.pointerUp(50, 50);
  const click = await waitEvent(
    view,
    (e) => e.t === "console" && String((e as { v?: unknown }).v).includes("clicked:50,50"),
  );
  check("pointer click", !!click);

  // 10. key input
  view.key(true, "a", "KeyA", "a");
  view.key(false, "a", "KeyA", "a");
  const key = await waitEvent(
    view,
    (e) => e.t === "console" && String((e as { v?: unknown }).v).includes("key:a"),
  );
  check("key input", !!key);

  // 11. resize → fresh frame at new dims
  view.resize(320, 200, 1);
  const dims = await (async () => {
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const d = view.dimensions();
      if (d && d.w === 320 && d.h === 200 && (await pullNextFrame(view, 100))) return d;
      await sleep(40);
    }
    return view.dimensions();
  })();
  check("resize + reframe", !!dims && dims.w === 320 && dims.h === 200, JSON.stringify(dims));

  // 12. hit test — opaque view, in-bounds hits
  check("hitTest in-bounds", view.hitTest(10, 10));
  check("hitTest out-of-bounds", !view.hitTest(9999, 9999));

  // 12b. scale≠1 — logical view size vs physical raster. The view is
  // created with logical 400×240 @ scale 2: the page must lay out at
  // 400 CSS px (innerWidth) while the raster buffer reports 800×480.
  // Passing physical dims to set_size (the scale² bug) would show
  // innerWidth=800 here.
  {
    const sv = WebUIView.create("wpe", { html: HTML, transparent: false, interactive: true }, 400, 240, 2);
    check("scaled view create", !!sv);
    if (sv) {
      const sLoaded = await waitEvent(sv, (e) => e.t === "load");
      check("scaled load event", !!sLoaded);
      sv.eval(11, "({ iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio })");
      const sEv = await waitEvent(sv, (e) => e.t === "eval" && (e as { id?: number }).id === 11);
      const sV = (() => {
        try {
          return JSON.parse((sEv as { v?: string } | null)?.v ?? "null") as { iw?: number; ih?: number; dpr?: number };
        } catch {
          return null;
        }
      })();
      check("scaled logical viewport", sV?.iw === 400 && sV?.ih === 240, JSON.stringify(sV));
      check("scaled dpr", sV?.dpr === 2, `dpr=${sV?.dpr}`);
      const sd = sv.dimensions();
      check("scaled raster dims", !!sd && sd.w === 800 && sd.h === 480, JSON.stringify(sd));
      const sframe = await pullNextFrame(sv, 15000);
      check(
        "scaled frame size",
        !!sframe && sframe.byteLength === 800 * 480 * 4,
        sframe ? `${sframe.byteLength}B` : "none",
      );
      sv.destroy();
    }
  }

  // 13. status healthy, no crashes
  check("status running", view.status() === "running", view.status());

  // 14. destroy + recreate
  view.destroy();
  const view2 = WebUIView.create("wpe", { html: "<b>second</b>", transparent: false, interactive: true }, 100, 80, 1);
  check("destroy + recreate", !!view2);
  if (view2) view2.destroy();

  done();
}

function done() {
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok);
  console.log(`WEBUI-TEST ${failed.length === 0 ? "ALL PASS" : "FAILED"} — ${passed}/${checks.length}`);
  for (const f of failed) console.log(`WEBUI-TEST   failed: ${f.name}${f.detail ? ` — ${f.detail}` : ""}`);
  // Keep node alive a beat so logcat drains, then drain the GLib context
  // and exit via _exit — libWPEWebKit registers atexit/__cxa_finalize
  // destructors that g_object_unref a live object graph and abort under a
  // normal exit() (bound service processes are reaped by Android anyway).
  setTimeout(() => {
    // Optional diagnostic linger (WEBUI_TEST_LINGER_MS) — gives the
    // activity's InitWindow time to land so the SurfaceControl path can be
    // observed on-device.
    const linger = Number(process.env.WEBUI_TEST_LINGER_MS ?? "0");
    if (linger > 0) {
      console.log(`WEBUI-TEST lingering ${linger}ms for diagnostics`);
      setTimeout(fin, linger);
      return;
    }
    fin();
  }, 500);
}
function fin() {
  const failed = checks.filter((c) => !c.ok);
  webUiGlobalShutdown("wpe");
  const code = failed.length === 0 ? 0 : 1;
  try {
    const libc = dlopen("libc.so", { _exit: { args: ["i32"], returns: "void" } });
    libc.symbols._exit(code);
  } catch {
    process.exit(code);
  }
}

main().catch((e) => {
  console.log(`WEBUI-TEST FATAL ${e?.stack ?? e}`);
  process.exit(2);
});
