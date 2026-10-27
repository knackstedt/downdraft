// ============================================================================
// menus.spec.ts — dd_menu_* bridge coverage
//
// The real cdylib is present but native menus are unsupported on Linux
// (muda's GTK backend needs a gtk::Window our winit surface isn't) — so
// this platform exercises the genuine unsupported→fallback contract:
// every dd_menu_* entry point exists and reports 0, which the bridge maps
// to "inwindow"/false. Native install itself is covered by the Windows/
// macOS implementations of the same imp block (compile-checked per-target).
// ============================================================================

import { describe, expect, test } from "bun:test";
import type { AppMenuModel } from "@downdraft/engine/app/shared/types";
import { resolvePlatformLibrary } from "../ffi/lib-paths";
import type { NativeWindow } from "../window/native-window";
import { winMenu } from "../window/window-ffi";
import { createNativeMenus } from "./menus";

const MODEL: AppMenuModel = {
  items: [
    {
      type: "submenu",
      id: "file",
      label: "File",
      items: [
        { type: "item", id: "file.open", label: "Open…", accelerator: "CmdOrCtrl+O" },
        { type: "check", id: "view.wrap", label: "Word Wrap", checked: true },
        { type: "separator" },
        { type: "predefined", kind: "quit" },
      ],
    },
  ],
};

const libPath = resolvePlatformLibrary(true);

// bun-types doesn't declare test.skip — it exists at runtime.
const itIf = (cond: boolean) =>
  cond ? test : (test as unknown as { skip: typeof test }).skip;

describe("native menus — unsupported platform contract", () => {
  itIf(!!libPath)("every dd_menu_* entry point resolves", () => {
    expect(winMenu.dd_menu_set).toBeFunction();
    expect(winMenu.dd_menu_remove).toBeFunction();
    expect(winMenu.dd_menu_set_item_enabled).toBeFunction();
    expect(winMenu.dd_menu_set_item_checked).toBeFunction();
    expect(winMenu.dd_menu_popup).toBeFunction();
    expect(winMenu.dd_menu_next_action).toBeFunction();
  });

  itIf(!!libPath)("dd_menu_set → 0 on Linux (in-window fallback)", () => {
    expect(winMenu.dd_menu_set!(JSON.stringify(MODEL))).toBe(0);
    expect(winMenu.dd_menu_remove!()).toBe(0);
    expect(winMenu.dd_menu_set_item_enabled!("x", 1)).toBe(0);
    expect(winMenu.dd_menu_set_item_checked!("x", 1)).toBe(0);
    expect(winMenu.dd_menu_popup!(10, 10, "{}")).toBe(0);
    // Empty action queue → sizing pull reports none.
    expect(winMenu.dd_menu_next_action!(null as never, 0)).toBe(0);
  });

  test("setMenu maps the platform return to the backend union", () => {
    const menus = createNativeMenus({} as NativeWindow, () => {});
    if (winMenu.dd_menu_set) {
      // Real lib on Linux → 0 → "inwindow".
      expect(menus.setMenu(MODEL)).toBe("inwindow");
    } else {
      expect(menus.setMenu(MODEL)).toBe("unavailable");
    }
    // Removal always reports the "nothing in effect" backend.
    expect(menus.setMenu(null)).toBe("unavailable");
  });

  test("DD_MENU=inwindow short-circuits before FFI", () => {
    process.env.DD_MENU = "inwindow";
    try {
      const menus = createNativeMenus({} as NativeWindow, () => {});
      expect(menus.setMenu(MODEL)).toBe("inwindow");
      expect(menus.showContextMenu(0, 0, MODEL)).toBe(false);
    } finally {
      delete process.env.DD_MENU;
    }
  });

  test("menuaction dispatch drains the (empty) action queue without emitting", () => {
    let listener: (() => void) | null = null;
    const win = {
      addEventListener: (_type: string, cb: () => void) => {
        listener = cb;
        return () => {};
      },
    } as unknown as NativeWindow;
    const emitted: string[] = [];
    createNativeMenus(win, (_ch, id) => emitted.push(id));
    expect(listener).not.toBeNull();
    listener!();
    expect(emitted).toEqual([]);
  });

  test("item-state mutations + popup degrade silently on Linux", () => {
    const menus = createNativeMenus({} as NativeWindow, () => {});
    expect(() => menus.setMenuItemEnabled("file.open", false)).not.toThrow();
    expect(() => menus.setMenuItemChecked("view.wrap", false)).not.toThrow();
    expect(menus.showContextMenu(10, 10, MODEL)).toBe(false);
  });
});
