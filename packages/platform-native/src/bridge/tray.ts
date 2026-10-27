// ============================================================================
// tray.ts — HostAPI tray surface over the dd_tray_* FFI group
//
// One process-wide tray icon (dd_tray_create replaces). Pointer events
// arrive as DD_EVENT_TRAY_EVENT → tray.onEvent; menu activations share the
// DD_EVENT_MENU_ACTION queue with ids namespaced "tray:<id>" — tray.onAction
// filters+strips, while onMenuAction still sees the raw namespaced id.
//
// `create` returns false where no backend exists (Android; a Linux session
// with no StatusNotifierWatcher — the ksni backend posts over session DBus
// and needs nothing else). Absent symbols → create returns false.
// ============================================================================

import type {
    AppMenuModel,
    AppTray,
    AppTrayPointerEvent,
} from "@downdraft/engine/app/shared/types";
import { createLogger } from "@downdraft/engine/util/logger";
import type { NativeWindow } from "../window/native-window";
import { winTray } from "../window/window-ffi";

const log = createLogger("info");

const KINDS = ["click", "click", "doubleClick", "enter", "move", "leave"] as const;
const BUTTONS = ["none", "left", "right", "middle"] as const;

export function createNativeTray(
    window: NativeWindow,
    onMenuAction: (cb: (id: string) => void) => () => void,
): AppTray {
    const listeners = new Set<(ev: AppTrayPointerEvent) => void>();

    // Duck-typed: a minimal/mock window may lack addEventListener — tray
    // events can't fire without a real window anyway.
    window.addEventListener?.(
        "trayevent",
        (e: { kind: number; button: number; state: number; x: number; y: number }) => {
            const ev: AppTrayPointerEvent = {
                kind: KINDS[e.kind] ?? "click",
                button: BUTTONS[e.button] ?? "none",
                pressed: e.state === 1,
                x: e.x,
                y: e.y,
            };
            listeners.forEach((cb) => {
                try { cb(ev); } catch (err) { log.error("tray", `listener error: ${err}`); }
            });
        },
    );

    return {
        create(opts) {
            const sym = winTray.dd_tray_create;
            if (!sym) return false;
            try {
                return sym(JSON.stringify(opts)) === 1;
            } catch (e) {
                log.warn("tray", `dd_tray_create failed: ${(e as Error).message}`);
                return false;
            }
        },
        setIcon(path) {
            try {
                return winTray.dd_tray_set_icon?.(path ?? "") === 1;
            } catch (e) {
                log.warn("tray", `dd_tray_set_icon failed: ${(e as Error).message}`);
                return false;
            }
        },
        setTooltip(text) {
            try {
                return winTray.dd_tray_set_tooltip?.(text ?? "") === 1;
            } catch (e) {
                log.warn("tray", `dd_tray_set_tooltip failed: ${(e as Error).message}`);
                return false;
            }
        },
        setMenu(model: AppMenuModel) {
            try {
                return winTray.dd_tray_set_menu?.(JSON.stringify(model)) === 1;
            } catch (e) {
                log.warn("tray", `dd_tray_set_menu failed: ${(e as Error).message}`);
                return false;
            }
        },
        destroy() {
            try {
                return winTray.dd_tray_destroy?.() === 1;
            } catch (e) {
                log.warn("tray", `dd_tray_destroy failed: ${(e as Error).message}`);
                return false;
            }
        },
        onEvent(cb) {
            listeners.add(cb);
            return () => listeners.delete(cb);
        },
        onAction(cb) {
            // The menu-action channel carries "tray:<id>" — filter+strip.
            return onMenuAction((id) => {
                if (id.startsWith("tray:")) cb(id.slice(5));
            });
        },
    };
}
