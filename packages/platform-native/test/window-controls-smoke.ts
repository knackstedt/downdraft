// Window-controls smoke — exercises the Phase-1 desktop window surface
// end-to-end on a real display:
//   1. primary create options (min size + decorations) land via
//      dd_window_set_create_options;
//   2. runtime controls round-trip (maximize/isMaximized, minimize,
//      resizable, attention request, theme query);
//   3. the close intercept keeps the window mapped — a veto consumes the
//      request, an accepted close quits;
//   4. occluded/themechanged events log as they arrive (cover the window
//      to trigger occlusion on Wayland/macOS).
//
// Run: bun run test/window-controls-smoke.ts   (needs a display)
// The script drives phases 1-2 itself, then waits: click the window's
// close button — the first request is vetoed (log + stays mapped), the
// second is accepted and the process exits cleanly.
import { createNativeHost } from "../src/native-host";

const host = await createNativeHost({
  window: {
    title: "window-controls-smoke",
    width: 480,
    height: 320,
    minWidth: 320,
    minHeight: 200,
    decorations: true,
  },
  appId: "dd-window-controls-smoke",
});
const { window } = host;

const fail = (msg: string): never => { console.error(`[FAIL] ${msg}`); process.exit(1); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

window.addEventListener("occluded", (e: { occluded: boolean }) =>
  console.log(`[event] occluded=${e.occluded}`));
window.addEventListener("themechanged", (e: { theme: string }) =>
  console.log(`[event] themechanged=${e.theme}`));

// ── 1. create options landed ──
const size = window.getWindowSize();
if (size.width <= 0 || size.height <= 0) fail(`bad window size ${size.width}x${size.height}`);
console.log(`[create] window mapped at ${size.width}x${size.height} (min 320x200, decorated)`);

// Try to shrink below the min — the WM should clamp. Best-effort assert:
// some WMs ignore min size hints, so log rather than fail.
window.setWindowSize(100, 100);
await sleep(250);
const clamped = window.getWindowSize();
console.log(`[min] resize-to-100x100 result: ${clamped.width}x${clamped.height}${clamped.width > 100 ? " (WM clamped to min)" : " (WM ignored min hint)"}`);

// ── 2. runtime controls ──
window.setMaximized(true);
await sleep(300);
if (!window.isMaximized()) {
  console.log("[max] isMaximized() reported false — some WMs delay the state; continuing");
} else {
  console.log("[max] maximized + isMaximized() true");
}
window.setMaximized(false);
await sleep(300);
if (window.isMaximized()) console.log("[max] still maximized after unset — WM lag, continuing");

window.setMinimized(true);
await sleep(300);
window.setMinimized(false);
console.log("[min] minimized + restored");

window.setResizable(false);
window.setResizable(true);
window.requestAttention(false);
console.log("[ctl] resizable toggle + attention request issued (no-op-safe)");

const theme = window.getTheme();
console.log(`[theme] current theme: ${theme}`);

// ── 3. close intercept — first request vetoed, second accepted ──
let requests = 0;
window.setCloseIntercept(true);
window.addEventListener("closerequest", (e: { preventDefault(): void }) => {
  requests++;
  if (requests === 1) {
    e.preventDefault();
    console.log("[close] request #1 vetoed — window stays mapped. Click close again to exit.");
    return;
  }
  console.log("[close] request #2 accepted — quitting.");
});

console.log("[wait] click the window's close button twice — first is vetoed, second exits.");
