// ============================================================================
// dialogs.spec.ts — DD_DIALOGS_MOCK=1 coverage, two layers
//
// JS-layer mock: createNativeDialogs short-circuits every method when
// DD_DIALOGS_MOCK=1 — no FFI call, no event-queue dependency, works with
// zero windows (the point of the mock: headless contexts).
//
// Env subtlety: Bun's process.env writes never reach C environ — native
// getenv() only sees launch-time variables. The JS-layer mock therefore
// works under runtime-set env, but the Rust-layer mock (std::env::var)
// only fires when the var was exported at launch; that group is gated on
// /proc/self/environ detection plus a real window (poll_event is gated on
// a live window on Linux — a result pushed with no window never drains).
// ============================================================================

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolvePlatformLibrary } from "../ffi/lib-paths";
import type { NativeWindow } from "../window/native-window";
import { DD_EVENT_DIALOG_RESULT, win, winDialogs } from "../window/window-ffi";
import { createNativeDialogs } from "./dialogs";

const MOCK_PATH = "/var/tmp/dd-dialogs-spec-mock.txt";

/** Was `name` in the environment at exec time? /proc/self/environ reflects
 *  the launch environ — the only thing native getenv() can see under Bun.
 *  Read BEFORE any process.env writes — Bun's env setter rewrites the
 *  region /proc reads. */
function launchEnvHas(name: string): boolean {
  try {
    return readFileSync("/proc/self/environ", "utf8")
      .split("\0")
      .some((kv) => kv.startsWith(`${name}=`));
  } catch {
    return false;
  }
}

const RUST_MOCK = launchEnvHas("DD_DIALOGS_MOCK");
const RUST_MOCK_PATH = launchEnvHas("DD_DIALOGS_MOCK_PATH")
  ? MOCK_PATH
  : "/var/tmp/dd-dialog-mock";

process.env.DD_DIALOGS_MOCK = "1";
process.env.DD_DIALOGS_MOCK_PATH = MOCK_PATH;

const libPath = resolvePlatformLibrary(true);

// bun-types doesn't declare test.skip — it exists at runtime.
const itIf = (cond: boolean) =>
  cond ? test : (test as unknown as { skip: typeof test }).skip;

/** The Rust-pipeline tests need a real window for dd_window_poll_event to
 *  drain — probe once; headless runs skip that group. */
let displayAvailable: boolean | null = null;
function hasDisplay(): boolean {
  if (displayAvailable !== null) return displayAvailable;
  try {
    displayAvailable = win.dd_window_create("dialogs-spec", 64, 64) === 0;
  } catch {
    displayAvailable = false;
  }
  return displayAvailable;
}

describe("native dialogs — JS mock layer", () => {
  test("pickers resolve the mocked path without a window", async () => {
    const dialogs = createNativeDialogs({} as NativeWindow);
    await expect(dialogs.showOpenDialog({ title: "Open" })).resolves.toEqual([MOCK_PATH]);
    await expect(dialogs.showSaveDialog({ defaultName: "out.txt" })).resolves.toBe(MOCK_PATH);
    await expect(dialogs.pickFolder()).resolves.toEqual([MOCK_PATH]);
  });

  test("message box + notify resolve under the mock", async () => {
    const dialogs = createNativeDialogs({} as NativeWindow);
    await expect(
      dialogs.showMessageBox({ message: "hi", buttons: "yesno" }),
    ).resolves.toBe(0);
    await expect(dialogs.notify({ title: "hi" })).resolves.toBe(true);
  });
});

describe("native dialogs — Rust pipeline (needs display + launch env)", () => {
  itIf(!!libPath && hasDisplay() && RUST_MOCK)("dd_dialog_open → queue event → result paths", () => {
    const reqId = winDialogs.dd_dialog_open!("{}");
    expect(reqId).toBeGreaterThan(0);

    // The Rust mock pushes DD_EVENT_DIALOG_RESULT synchronously — drain
    // the queue until it arrives (window creation queues focus/etc first).
    const buf = new ArrayBuffer(64);
    const view = new Int32Array(buf);
    let seen = 0;
    for (;;) {
      const t = win.dd_window_poll_event(buf as never);
      if (t === 0) break;
      if (t === DD_EVENT_DIALOG_RESULT) {
        expect(view[0]).toBe(reqId);
        seen = view[1];
      }
    }
    expect(seen).toBe(1); // ok

    // snprintf sizing → pull → consume.
    const needed = winDialogs.dd_dialog_result_paths!(reqId, null as never, 0);
    expect(needed).toBeGreaterThan(1);
    const out = new Uint8Array(needed);
    winDialogs.dd_dialog_result_paths!(reqId, out as never, out.length);
    expect(new TextDecoder().decode(out.subarray(0, needed - 1))).toBe(RUST_MOCK_PATH);
    expect(winDialogs.dd_dialog_result_paths!(reqId, null as never, 0)).toBe(0);
  });
});
