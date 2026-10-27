// ============================================================================
// tray.spec.ts — dd_tray_* bridge coverage
//
// The real cdylib exports the tray group on Linux (ksni StatusNotifierItem
// over session DBus — no GTK). dd_tray_create may still return 0 where no
// SNI watcher exists (headless CI, desktop without a tray applet) — both
// outcomes are valid and asserted tolerantly. Pointer-event plumbing and
// the tray: action namespace are exercised through a mock window.
// ============================================================================

import { describe, expect, test } from "bun:test";
import type { AppTrayPointerEvent } from "@downdraft/engine/app/shared/types";
import { resolvePlatformLibrary } from "../ffi/lib-paths";
import type { NativeWindow } from "../window/native-window";
import { winTray } from "../window/window-ffi";
import { createNativeTray } from "./tray";

const libPath = resolvePlatformLibrary(true);

// bun-types doesn't declare test.skip — it exists at runtime.
const itIf = (cond: boolean) =>
  cond ? test : (test as unknown as { skip: typeof test }).skip;

const noopWindow = () => ({}) as unknown as NativeWindow;

describe("native tray", () => {
  itIf(!!libPath)("every dd_tray_* entry point resolves", () => {
    expect(winTray.dd_tray_create).toBeFunction();
    expect(winTray.dd_tray_set_icon).toBeFunction();
    expect(winTray.dd_tray_set_tooltip).toBeFunction();
    expect(winTray.dd_tray_set_menu).toBeFunction();
    expect(winTray.dd_tray_destroy).toBeFunction();
  });

  itIf(!!libPath)("create reports backend availability as a boolean", () => {
    // Both branches are valid: an SNI watcher may or may not exist in the
    // test environment. Where one does, exercise the update/destroy calls.
    const rc = winTray.dd_tray_create!(JSON.stringify({ tooltip: "spec" }));
    expect([0, 1]).toContain(rc);
    if (rc === 1) {
      expect(winTray.dd_tray_set_tooltip!("spec-2")).toBe(1);
      expect(
        winTray.dd_tray_set_menu!(
          JSON.stringify({ items: [{ id: "quit", label: "Quit" }] }),
        ),
      ).toBe(1);
      expect(winTray.dd_tray_destroy!()).toBe(1);
      expect(winTray.dd_tray_destroy!()).toBe(0); // already gone
    } else {
      // No backend — mutations report the same 0, never throw.
      expect(winTray.dd_tray_set_tooltip!("x")).toBe(0);
      expect(winTray.dd_tray_destroy!()).toBe(0);
    }
  });

  test("bridge create() maps the FFI result and survives absent symbols", () => {
    const tray = createNativeTray(noopWindow(), () => () => {});
    const rc = tray.create({ tooltip: "spec" });
    expect(typeof rc).toBe("boolean");
    // destroy() is safe whether or not create succeeded.
    expect(typeof tray.destroy()).toBe("boolean");
  });

  test("trayevent dispatch maps wire slots to AppTrayPointerEvent", () => {
    let listener:
      | ((e: { kind: number; button: number; state: number; x: number; y: number }) => void)
      | null = null;
    const win = {
      addEventListener: (_type: string, cb: never) => {
        listener = cb;
        return () => {};
      },
    } as unknown as NativeWindow;

    const tray = createNativeTray(win, () => () => {});
    const seen: AppTrayPointerEvent[] = [];
    const off = tray.onEvent((e) => seen.push(e));

    expect(listener).not.toBeNull();
    // kind=1 click, button=1 left, state=1 pressed, screen pos.
    listener!({ kind: 1, button: 1, state: 1, x: 40, y: 24 });
    // kind=2 double-click on the right button.
    listener!({ kind: 2, button: 2, state: 0, x: 41, y: 24 });

    expect(seen).toEqual([
      { kind: "click", button: "left", pressed: true, x: 40, y: 24 },
      { kind: "doubleClick", button: "right", pressed: false, x: 41, y: 24 },
    ]);

    off();
    listener!({ kind: 5, button: 0, state: 0, x: 0, y: 0 });
    expect(seen.length).toBe(2);
  });

  test("onAction filters the menu-action channel to the tray: namespace", () => {
    const cbs = new Set<(id: string) => void>();
    const onMenuAction = (cb: (id: string) => void) => {
      cbs.add(cb);
      return () => cbs.delete(cb);
    };
    const tray = createNativeTray(noopWindow(), onMenuAction);
    const seen: string[] = [];
    tray.onAction((id) => seen.push(id));

    cbs.forEach((cb) => cb("file.open"));       // app-menu id — filtered out
    cbs.forEach((cb) => cb("tray:quit"));       // namespaced — delivered
    cbs.forEach((cb) => cb("tray:show.window"));
    expect(seen).toEqual(["quit", "show.window"]);
  });
});
