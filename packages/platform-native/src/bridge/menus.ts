// ============================================================================
// menus.ts — HostAPI menu surface over the dd_menu_* FFI group
//
// The app hands a neutral AppMenuModel (JSON on the wire); the native lib
// installs a real OS menu where muda can (Windows HMENU, macOS NSMenu) and
// reports 0 elsewhere (Linux/Android — the GTK backend needs a gtk::Window
// our winit surface isn't), which maps to "inwindow" so the app renders
// the html-ui kit MenuBar fallback instead.
//
// Activations arrive as DD_EVENT_MENU_ACTION; the item id is pulled
// out-of-band with dd_menu_next_action (one queued id per event — the
// dispatch loop drains until empty so ids can't straggle).
//
// setMenu(null) removes the installed menu and reports "unavailable" —
// the caller hides whatever bar it was rendering. DD_MENU=inwindow forces
// the fallback even where native would install (kit-bar testing).
// ============================================================================

import type {
    AppMenuBackend,
    AppMenuModel,
} from "@downdraft/engine/app/shared/types";
import { createLogger } from "@downdraft/engine/util/logger";
import type { NativeWindow } from "../window/native-window";
import { winMenu } from "../window/window-ffi";

const log = createLogger("info");

const MENU_INWINDOW = () => process.env.DD_MENU === "inwindow";

export interface NativeMenus {
    setMenu(model: AppMenuModel | null): AppMenuBackend;
    setMenuItemEnabled(id: string, enabled: boolean): void;
    setMenuItemChecked(id: string, checked: boolean): void;
    showContextMenu(x: number, y: number, model: AppMenuModel): boolean;
}

export function createNativeMenus(
    window: NativeWindow,
    emit: (channel: "menu-action", data: string) => void,
): NativeMenus {
    // DD_EVENT_MENU_ACTION → pull the queued id(s). Duck-typed: a
    // minimal/mock window may lack addEventListener — only native-menu
    // actions need it, and they can't fire without a real window anyway.
    window.addEventListener?.("menuaction", () => {
        for (let id = pullAction(); id !== null; id = pullAction()) {
            emit("menu-action", id);
        }
    });

    return {
        setMenu(model) {
            if (model === null) {
                try {
                    winMenu.dd_menu_remove?.();
                } catch (e) {
                    log.warn("menu", `dd_menu_remove failed: ${(e as Error).message}`);
                }
                return "unavailable";
            }
            if (MENU_INWINDOW()) return "inwindow";
            const sym = winMenu.dd_menu_set;
            if (!sym) return "unavailable";
            try {
                const rc = sym(JSON.stringify(model));
                return rc === 1 ? "native" : rc === 0 ? "inwindow" : "unavailable";
            } catch (e) {
                log.warn("menu", `dd_menu_set failed: ${(e as Error).message}`);
                return "unavailable";
            }
        },

        setMenuItemEnabled(id, enabled) {
            try {
                winMenu.dd_menu_set_item_enabled?.(id, enabled ? 1 : 0);
            } catch (e) {
                log.warn("menu", `dd_menu_set_item_enabled failed: ${(e as Error).message}`);
            }
        },

        setMenuItemChecked(id, checked) {
            try {
                winMenu.dd_menu_set_item_checked?.(id, checked ? 1 : 0);
            } catch (e) {
                log.warn("menu", `dd_menu_set_item_checked failed: ${(e as Error).message}`);
            }
        },

        showContextMenu(x, y, model) {
            if (MENU_INWINDOW()) return false;
            const sym = winMenu.dd_menu_popup;
            if (!sym) return false;
            try {
                return sym(Math.round(x), Math.round(y), JSON.stringify(model)) === 1;
            } catch (e) {
                log.warn("menu", `dd_menu_popup failed: ${(e as Error).message}`);
                return false;
            }
        },
    };
}

/** Pull one queued action id — the event guarantees ≥1 is queued, but a
 *  stray drain (or FFI hiccup) just yields null and ends the loop. */
function pullAction(): string | null {
    const pull = winMenu.dd_menu_next_action;
    if (!pull) return null;
    const needed = pull(null as any, 0);
    if (needed <= 0) return null;
    const buf = new Uint8Array(needed);
    pull(buf as any, buf.length);
    return new TextDecoder().decode(buf.subarray(0, needed - 1));
}
