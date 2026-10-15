// Pump-thread smoke test — desktop (Linux/Windows) only. Exercises the
// threaded winit loop end to end:
//   1. create_window returns synchronously via the pump-thread reply
//   2. window ops from the JS thread work against the loop-thread window
//   3. wait_event(50) times out at ~50ms (condvar wait, not a pump)
//   4. a cross-thread request_quit wakes a 1s wait in ~20ms (condvar notify)
//   5. destroy + recreate works with the loop thread still running
import { win } from "../src/window/window-ffi";

const t0 = performance.now();
const log = (m: string) => console.log(`[+${(performance.now() - t0).toFixed(1)}ms] ${m}`);
const eventData = new ArrayBuffer(64);
let failures = 0;
const expect = (cond: boolean, what: string) => {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok" : "FAIL"}  ${what}`);
};

// ── 1. create window (spawns pump thread, blocks on reply) ──
let w0 = performance.now();
let rc = win.dd_window_create("pump-thread-test", 320, 240);
log(`create_window rc=${rc} (${(performance.now() - w0).toFixed(1)}ms)`);
expect(rc === 0, "create_window returned 0");

// ── 2. JS-thread window ops against the loop-thread window ──
const out = new Int32Array(2);
win.dd_window_get_size(out.subarray(0, 1) as any, out.subarray(1, 2) as any);
log(`window size ${out[0]}x${out[1]}`);
expect(out[0] > 0 && out[1] > 0, "get_window_size reports real dimensions");
win.dd_window_set_title("pump-thread-test (renamed)");
win.dd_window_focus();
const refresh = new Int32Array(1);
const scale = new Float32Array(1);
win.dd_window_get_display_info(refresh as any, scale as any);
log(`display refresh=${refresh[0]} scale=${scale[0]}`);
expect(scale[0] > 0, "get_display_info reports a scale factor");

// ── 3. timeout wait — pure condvar, ~50ms, NONE ──
// WM focus/resize events keep arriving asynchronously during startup —
// drain until a wait genuinely times out, then assert on that wait's
// block duration. Events arriving early are the system working correctly.
let ev = -1;
let blocked = 0;
let seen = 0;
const settleDeadline = performance.now() + 3000;
while (performance.now() < settleDeadline) {
  const w0 = performance.now();
  ev = win.dd_window_wait_event(eventData as any, 50);
  blocked = performance.now() - w0;
  if (ev === 0) break;
  seen++;
}
log(`drained ${seen} startup event(s); final wait_event(50) → type=${ev}, blocked ${blocked.toFixed(1)}ms`);
expect(ev === 0, "a wait eventually times out with NONE once the WM settles");
expect(blocked >= 40, `timeout wait blocked ~50ms (${blocked.toFixed(1)}ms)`);

// ── 4. cross-thread request_quit wakes a parked 1s wait ──
const worker = new Worker(new URL("./test-pump-worker.ts", import.meta.url));
let ready = false;
worker.onmessage = (e) => {
  if (e.data === "ready") ready = true;
  if (e.data === "quit-pushed") log("worker pushed QUIT");
};
const deadline = performance.now() + 5000;
while (!ready && performance.now() < deadline) await new Promise((r) => setImmediate(r));
expect(ready, "worker loaded shim and reported ready");

w0 = performance.now();
ev = win.dd_window_wait_event(eventData as any, 1000);
const woke = performance.now() - w0;
log(`wait_event(1000) → type=${ev}, woke after ${woke.toFixed(1)}ms`);
expect(ev === 1, "cross-thread QUIT delivered");
expect(woke < 300, `woke via condvar notify, not timeout (${woke.toFixed(1)}ms)`);
worker.terminate();

// ── 4b. native pump stats — delivered/timeout/residency counters ──
const sbuf = new BigInt64Array(4);
win.dd_window_pump_stats(sbuf as any);
log(`pump_stats delivered=${sbuf[0]} empty=${sbuf[1]} residencySum=${sbuf[2]}us max=${sbuf[3]}us`);
expect(sbuf[0] > 0n, "delivered count recorded");
expect(sbuf[1] > 0n, "empty/timeout count recorded");
expect(sbuf[2] > 0n, "residency accumulated");
expect(sbuf[3] > 0n && sbuf[3] < 1_000_000n, `max residency sane (${sbuf[3]}us)`);

// ── 5. destroy + recreate — loop thread survives window teardown ──
win.dd_window_destroy();
rc = win.dd_window_create("pump-thread-test-2", 200, 150);
log(`recreate rc=${rc}`);
expect(rc === 0, "window recreation on the same event loop works");
win.dd_window_destroy();
log(failures === 0 ? "PASS" : `${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
