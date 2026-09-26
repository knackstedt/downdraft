// ============================================================================
// dioxus.ts — Dioxus/Blitz wasm gallery.
//
// Loads the bakeoff-blitz-ui wasm-pack build, drives the headless shell
// (tick → frame → RGBA), and composites via RgbaBlit — the same path
// createBlitzUiNativeModule uses, minus the RendererModule wrapper.
// ============================================================================

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RgbaBlit, type StackCtx, type UiStack } from "../stack";

interface WasmModule {
    initSync(input: { module: Uint8Array }): unknown;
    ui_init_headless(w: number, h: number, scale: number, onAction: (a: string, p: string) => void): void;
    ui_resize(w: number, h: number, scale: number): void;
    ui_shutdown(): void;
    ui_tick(): boolean;
    ui_frame(): Uint8Array;
    ui_set_state(json: string): unknown;
    ui_pointer(kind: number, x: number, y: number, button: number, mods: number): void;
    ui_pointer_leave(): void;
    ui_wheel(dx: number, dy: number, x: number, y: number, mods: number): void;
    ui_key(pressed: boolean, key: string, code: string, mods: number, text?: string): void;
    ui_hit_test(x: number, y: number): boolean;
    ui_dump(): string;
}

export function createDioxusStack(): UiStack {
    let wasm: WasmModule | null = null;
    let blit: RgbaBlit;
    let ctx: StackCtx;
    let W = 0, H = 0;

    return {
        id: "dioxus",
        label: "Dioxus",
        async init(c: StackCtx) {
            ctx = c;
            W = c.width; H = c.height;
            const pkgUrl = new URL("../blitz-app/pkg/bakeoff_blitz_ui.js", import.meta.url);
            const wasmUrl = new URL("../blitz-app/pkg/bakeoff_blitz_ui_bg.wasm", import.meta.url);
            if (!existsSync(fileURLToPath(wasmUrl))) {
                throw new Error("blitz-app wasm not built — run `wasm-pack build --target web --release --out-dir pkg` in test-beds/ui-bakeoff/blitz-app");
            }
            const mod = (await import(pkgUrl.href)) as unknown as WasmModule;
            mod.initSync({ module: readFileSync(fileURLToPath(wasmUrl)) });
            mod.ui_init_headless(c.width, c.height, 1, (action, payload) => c.onAction(action, payload));
            mod.ui_set_state(JSON.stringify({ note: "snapshot channel live", clicks: 0 }));
            wasm = mod;
            blit = new RgbaBlit(c.device, c.format);
        },
        frame(target) {
            if (!wasm) return;
            if (wasm.ui_tick()) {
                const rgba = wasm.ui_frame();
                if (rgba && rgba.length > 0) blit.frame(target, rgba, W, H);
            } else {
                // No damage — composite the persisted UI texture.
                blit.blit(target);
            }
        },
        resize(w, h) { W = w; H = h; wasm?.ui_resize(w, h, 1); },
        dispose() { wasm?.ui_shutdown(); blit?.dispose(); },
        pointerDown(x, y, button) { wasm?.ui_pointer(1, x, y, button, 0); return wasm?.ui_hit_test(x, y) ?? false; },
        pointerUp(x, y, button) { wasm?.ui_pointer(2, x, y, button, 0); return wasm?.ui_hit_test(x, y) ?? false; },
        pointerMove(x, y) { wasm?.ui_pointer(0, x, y, 0, 0); return wasm?.ui_hit_test(x, y) ?? false; },
        wheel(x, y, dx, dy) { wasm?.ui_wheel(dx, dy, x, y, 0); return wasm?.ui_hit_test(x, y) ?? false; },
        key(down, key, code, _keyCode, mods) {
            wasm?.ui_key(down, key, code, mods, key.length === 1 ? key : undefined);
            return false;
        },
    };
}
