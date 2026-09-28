// ============================================================================
// pixi.ts — PixiJS v8 WebGPU gallery via NativePixiUiHost.
//
// The same compositing path the games use: PixiJS renders the stage into a
// texture on the shared wgpu device; UiBlitPass draws it over the frame.
// Input is routed by dispatching synthetic pointer events into PixiJS's
// EventSystem (same approach as the games' native input routers).
// ============================================================================

import { getNativeHost } from "@downdraft/engine";
import { NativePixiUiHost } from "@downdraft/engine/libraries/pixi-ui-native";
import { Container, Graphics, Text, TextStyle } from "pixi.js";
import "pixi.js/events";
import {
    freshState, LIST_ITEMS, TABS,
    type StackCtx, type UiStack
} from "../stack";

const MY_TAB = 1;

const C = {
    bg: 0x10141a, panel: 0x161b23, panelAlt: 0x0f1319, border: 0x2a313c,
    text: 0xe8ecf1, dim: 0x8a94a3, accent: 0x4fc2f7, accentBg: 0x1d3547,
    accentHot: 0x2e4361, danger: 0xe5534b, dangerBg: 0x3a1d1d,
    track: 0x212933, green: 0x6fbf73, greenBg: 0x1d2a1d, disabled: 0x4a5568,
};

export function createPixiStack(): UiStack {
    let host: NativePixiUiHost;
    let ctx: StackCtx;
    let stage: Container;
    const state = freshState();
    const dynamic: { [k: string]: any } = {};

    const txt = (s: string, size = 13, color = C.text, bold = false) =>
        new Text({ text: s, style: new TextStyle({ fill: color, fontSize: size, fontFamily: "sans-serif", fontWeight: bold ? "bold" : "normal" }) });

    function hot(obj: Container, fn?: () => void): Container {
        obj.eventMode = "static";
        obj.cursor = "pointer";
        if (fn) obj.on("pointerdown", fn);
        return obj;
    }

    function box(parent: Container, x: number, y: number, w: number, h: number, fill: number, r = 4, border?: number): Graphics {
        const g = new Graphics();
        if (r > 0) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h);
        g.fill(fill);
        if (border !== undefined) g.stroke({ width: 1, color: border });
        parent.addChild(g);
        return g;
    }

    function build() {
        stage.removeChildren();
        const W = ctx.width, H = ctx.height;
        const WIDGET_X = 30, RIGHT_X = 426;

        // ── Tab bar ──
        const bar = new Container();
        box(bar, 0, 0, W, 48, C.panel, 0);
        box(bar, 0, 47, W, 1, C.border, 0);
        const title = txt("UI Bake-off", 15, C.text, true); title.x = 16; title.y = 15; bar.addChild(title);
        let tx = 140;
        TABS.forEach((name, i) => {
            const w = name.length * 8 + 28;
            const tab = new Container();
            box(tab, 0, 0, w, 28, i === MY_TAB ? C.accentHot : 0x1c222c, 4);
            const t = txt(name, 13, i === MY_TAB ? 0x7fd0ff : C.dim, i === MY_TAB); t.x = 14; t.y = 6; tab.addChild(t);
            tab.x = tx; tab.y = 10;
            hot(tab, () => ctx.onAction("tab", JSON.stringify({ index: i })));
            bar.addChild(tab);
            tx += w + 8;
        });
        const hint = txt("keys 1-5 / arrows to switch", 11, 0x5d6775); hint.x = W - 240; hint.y = 17; bar.addChild(hint);
        stage.addChild(bar);

        // ── Left widget panel ──
        const left = new Container();
        box(left, 16, 60, 380, 700, C.panel, 6, C.border);
        let y = 74;
        const section = txt("WIDGETS — PIXIJS V8 (SHARED WGPU DEVICE)", 11, C.dim); section.x = WIDGET_X; section.y = y; left.addChild(section); y += 30;

        // Buttons
        const bump = () => { state.clicks++; dynamic.clicks.text = `Clicks: ${state.clicks}`; };
        const mkBtn = (label: string, x: number, w: number, bg: number, fg: number, bc: number, on?: () => void) => {
            const b = new Container();
            box(b, 0, 0, w, 30, bg, 4, bc);
            const t = txt(label, 12, fg); t.x = 12; t.y = 8; b.addChild(t);
            b.x = x; b.y = y;
            if (on) hot(b, on);
            left.addChild(b);
        };
        mkBtn("Normal", WIDGET_X, 84, C.track, C.text, C.border, bump);
        mkBtn("Accent", WIDGET_X + 92, 84, C.accentBg, 0x7fd0ff, C.accent, bump);
        mkBtn("Danger", WIDGET_X + 184, 80, C.dangerBg, 0xf28b82, C.danger, bump);
        mkBtn("Disabled", WIDGET_X + 272, 84, 0x1a1f27, C.disabled, 0x1a1f27);
        y += 46;

        // Checkboxes
        const cbGfx: Graphics[] = [];
        (["VSync", "Fullscreen", "Bloom"] as const).forEach((label, i) => {
            const row = new Container();
            const boxG = new Graphics();
            const draw = () => {
                boxG.clear();
                boxG.roundRect(0, 0, 16, 16, 3).fill(state.checks[i] ? C.accent : C.panel).stroke({ width: 1, color: C.disabled });
                if (state.checks[i]) boxG.rect(4, 7, 3, 5).rect(4, 9, 8, 3).fill(0x10141a);
            };
            draw(); row.addChild(boxG); cbGfx.push(boxG);
            const t = txt(label, 12); t.x = 24; t.y = 1; row.addChild(t);
            row.x = WIDGET_X; row.y = y;
            hot(row, () => { state.checks[i] = !state.checks[i]; draw(); });
            left.addChild(row);
            y += 24;
        });
        y += 12;

        // Slider
        const sl = txt("Volume", 11, C.dim); sl.x = WIDGET_X; sl.y = y; left.addChild(sl);
        dynamic.sliderVal = txt(String(state.slider), 11); dynamic.sliderVal.x = WIDGET_X + 316; dynamic.sliderVal.y = y; left.addChild(dynamic.sliderVal);
        y += 18;
        const slider = new Container();
        const drawSlider = () => {
            (dynamic.sliderG as Graphics).clear();
            dynamic.sliderG.roundRect(0, 0, 340, 14, 7).fill(C.track);
            dynamic.sliderG.roundRect(0, 0, 340 * state.slider / 100, 14, 7).fill(C.accent);
        };
        dynamic.sliderG = new Graphics();
        slider.addChild(dynamic.sliderG);
        drawSlider();
        slider.x = WIDGET_X; slider.y = y;
        slider.eventMode = "static"; slider.cursor = "pointer";
        slider.hitArea = { contains: (px: number, py: number) => px >= 0 && px <= 340 && py >= 0 && py <= 14 } as any;
        const setSlider = (lx: number) => {
            state.slider = Math.round(Math.max(0, Math.min(100, (lx / 340) * 100)));
            drawSlider(); dynamic.sliderVal.text = String(state.slider);
        };
        slider.on("pointerdown", (e: any) => { slider["__drag"] = true; setSlider(e.getLocalPosition(slider.parent).x - WIDGET_X); });
        slider.on("pointermove", (e: any) => { if (slider["__drag"]) setSlider(e.getLocalPosition(slider.parent).x - WIDGET_X); });
        slider.on("pointerup", () => slider["__drag"] = false);
        left.addChild(slider);
        y += 34;

        // Progress
        const pl = txt("Loading", 11, C.dim); pl.x = WIDGET_X; pl.y = y; left.addChild(pl);
        const pv = txt("42%", 11); pv.x = WIDGET_X + 316; pv.y = y; left.addChild(pv);
        y += 16;
        box(left, WIDGET_X, y, 340, 10, C.track, 5);
        box(left, WIDGET_X, y, 340 * state.progress / 100, 10, C.green, 5);
        y += 30;

        // Segmented
        const segC = new Container();
        box(segC, 0, 0, 216, 30, C.panelAlt, 5);
        ["Items", "Stats", "Log"].forEach((s, i) => {
            const o = new Container();
            const og = new Graphics();
            const draw = () => { og.clear(); og.roundRect(0, 0, 68, 24, 4).fill(state.segment === i ? C.accentHot : C.panelAlt); };
            draw(); o.addChild(og);
            const t = txt(s, 11, state.segment === i ? 0x7fd0ff : C.dim); t.x = 14; t.y = 5; o.addChild(t);
            o.x = 3 + i * 71; o.y = 3;
            hot(o, () => {
                state.segment = i;
                segC.children.slice(1).forEach((c, j) => {
                    (c.children[0] as Graphics).clear().roundRect(0, 0, 68, 24, 4).fill(state.segment === j ? C.accentHot : C.panelAlt);
                    ((c.children[1]) as Text).style.fill = state.segment === j ? 0x7fd0ff : C.dim;
                });
            });
            segC.addChild(o);
        });
        segC.x = WIDGET_X; segC.y = y;
        left.addChild(segC);
        y += 44;

        // Scroll list
        const il = txt("Inventory (scroll)", 11, C.dim); il.x = WIDGET_X; il.y = y; left.addChild(il);
        y += 18;
        const list = new Container();
        box(list, 0, 0, 340, 118, C.panelAlt, 4, C.border);
        const listInner = new Container();
        list.addChild(listInner);
        const rowH = 24, listH = 118;
        let listScroll = 0; // px
        const rows: Container[] = [];
        const refreshClip = () => {
            // Manual windowing — no scissor/mask: rows outside the viewport
            // are simply not rendered. Row base offset lives on __rowY.
            rows.forEach((r) => {
                const ry = (r as any).__rowY - listScroll;
                r.y = ry;
                r.visible = ry + rowH > 0 && ry < listH;
            });
        };
        LIST_ITEMS.forEach((item, i) => {
            const row = new Container();
            const rg = new Graphics();
            if (state.selected === i) rg.rect(0, 0, 338, rowH).fill(C.accentHot);
            row.addChild(rg);
            const t = txt(item, 11, state.selected === i ? 0x7fd0ff : 0xc8d0db); t.x = 10; t.y = 6; row.addChild(t);
            (row as any).__rowY = i * rowH;
            row.y = i * rowH;
            row.eventMode = "static"; row.cursor = "pointer";
            row.hitArea = { contains: (px: number, py: number) => px >= 0 && px <= 338 && py >= 0 && py <= rowH } as any;
            row.on("pointerdown", () => {
                state.selected = i;
                rows.forEach((r, j) => {
                    (r.children[0] as Graphics).clear();
                    if (j === i) (r.children[0] as Graphics).rect(0, 0, 338, rowH).fill(C.accentHot);
                    (r.children[1] as Text).style.fill = j === i ? 0x7fd0ff : 0xc8d0db;
                });
            });
            rows.push(row);
            listInner.addChild(row);
        });
        refreshClip();
        list.eventMode = "static";
        list.on("wheel", (e: any) => {
            const dy = e.deltaY ?? 0;
            const maxOff = Math.max(0, LIST_ITEMS.length * rowH - listH);
            listScroll = Math.max(0, Math.min(maxOff, listScroll + dy));
            refreshClip();
        });
        list.x = WIDGET_X; list.y = y;
        left.addChild(list);
        y += 132;

        // Text field
        const fl = txt("Callsign", 11, C.dim); fl.x = WIDGET_X; fl.y = y; left.addChild(fl);
        y += 16;
        box(left, WIDGET_X, y, 340, 28, C.panelAlt, 4, C.disabled);
        const ft = txt(state.text + "|", 13); ft.x = WIDGET_X + 10; ft.y = y + 6; left.addChild(ft);
        stage.addChild(left);

        // ── Right HUD mock ──
        const right = new Container();
        box(right, RIGHT_X, 60, 780, 120, C.panel, 6, C.border);
        const rt = txt("HUD MOCK", 11, C.dim); rt.x = RIGHT_X + 14; rt.y = 70; right.addChild(rt);
        const mkBar = (label: string, v: number, col: number, ry: number, set: (n: number) => void) => {
            const l = txt(label, 11, C.dim); l.x = RIGHT_X + 14; l.y = ry; right.addChild(l);
            const val = txt(`${v} / 100`, 11); val.x = RIGHT_X + 720; val.y = ry; right.addChild(val);
            const barC = new Container();
            const bg = new Graphics();
            const draw = () => {
                bg.clear();
                bg.roundRect(0, 0, 760, 16, 4).fill(C.track);
                bg.roundRect(0, 0, 760 * v / 100, 16, 4).fill(col);
                val.text = `${Math.round(v)} / 100`;
            };
            draw(); barC.addChild(bg);
            barC.x = RIGHT_X + 14; barC.y = ry + 16;
            barC.eventMode = "static"; barC.cursor = "pointer";
            barC.hitArea = { contains: (px: number, py: number) => px >= 0 && px <= 760 && py >= 0 && py <= 16 } as any;
            let drag = false;
            const apply = (e: any) => {
                const lx = e.getLocalPosition(barC.parent).x - (RIGHT_X + 14);
                set(Math.round(Math.max(0, Math.min(100, (lx / 760) * 100))));
                draw();
            };
            barC.on("pointerdown", (e: any) => { drag = true; apply(e); });
            barC.on("pointermove", (e: any) => { if (drag) apply(e); });
            barC.on("pointerup", () => drag = false);
            right.addChild(barC);
        };
        mkBar("HP", state.hp, 0xe06840, 90, (n) => state.hp = n);
        mkBar("Mana", state.mana, C.accent, 126, (n) => state.mana = n);
        dynamic.clicks = txt(`Clicks: ${state.clicks}`, 11, C.dim); dynamic.clicks.x = RIGHT_X + 14; dynamic.clicks.y = 162; right.addChild(dynamic.clicks);
        stage.addChild(right);

        // Toast
        const toast = new Container();
        box(toast, 0, 0, 220, 34, C.greenBg, 6, 0x4a7a4a);
        const tt = txt("Item added to inventory", 11, 0x9fd89f); tt.x = 12; tt.y = 9; toast.addChild(tt);
        toast.x = RIGHT_X; toast.y = 196;
        stage.addChild(toast);
    }

    // ── Synthetic input routing (same as games' NativeInputRouter) ──
    function dispatchSynthetic(type: string, x: number, y: number, button: number, extras?: Record<string, unknown>) {
        const eventSystem = (host.renderer as any).events;
        if (!eventSystem) return;
        const domElement = eventSystem.domElement ?? host.canvas;
        const resolution = (host.renderer as any).resolution ?? 1;
        const px = x * resolution, py = y * resolution;
        const r = host.renderer as any;
        if (r.lastObjectRendered !== host.stage) r._lastObjectRendered = host.stage;
        const rb = eventSystem.rootBoundary;
        if (rb && !rb.rootTarget) rb.rootTarget = host.stage;
        const ev = {
            type, pointerId: 1, pointerType: "mouse",
            clientX: px, clientY: py, button,
            buttons: type === "pointerdown" ? (button === 0 ? 1 : button === 2 ? 2 : 4) : 0,
            preventDefault() {}, stopPropagation() {},
            offsetX: px, offsetY: py, pageX: px, pageY: py,
            target: domElement, composedPath: () => [domElement],
            cancelable: true, isPrimary: true, isTrusted: true,
            width: 1, height: 1, tiltX: 0, tiltY: 0, pressure: 0.5, twist: 0,
            ...extras,
        };
        const HANDLERS: Record<string, string> = {
            pointerdown: "_onPointerDown", pointermove: "_onPointerMove",
            pointerup: "_onPointerUp", pointerover: "_onPointerOverOut",
            pointerleave: "_onPointerOverOut", wheel: "onWheel",
        };
        const h = eventSystem[HANDLERS[type] ?? type];
        if (typeof h === "function") { try { h.call(eventSystem, ev); } catch { /* ignore */ } }
    }

    let dragOnUi = false;

    return {
        id: "pixi",
        label: "PixiJS",
        async init(c: StackCtx) {
            ctx = c;
            host = new NativePixiUiHost({
                device: c.device as any,
                adapter: getNativeHost()?.adapter ?? (c as any).adapter,
                targetFormat: c.format,
                width: c.width,
                height: c.height,
            });
            await host.ready;
            stage = host.stage;
            build();
        },
        frame(target) {
            host.render();
            const view = host.getUiTextureView();
            if (!view) return;
            const enc = ctx.device.createCommandEncoder();
            host.blitPass.execute(enc, target, view as GPUTextureView);
            ctx.device.queue.submit([enc.finish()]);
        },
        resize(w, h) { host.resize(w, h); build(); },
        dispose() { host.dispose(); },
        pointerDown(x, y, button) {
            if (!hitTest(x, y)) return false;
            dragOnUi = true;
            dispatchSynthetic("pointerdown", x, y, button);
            return true;
        },
        pointerMove(x, y) {
            if (dragOnUi) { dispatchSynthetic("pointermove", x, y, 0); return true; }
            dispatchSynthetic("pointermove", x, y, 0);
            return hitTest(x, y);
        },
        pointerUp(x, y, button) {
            if (!dragOnUi) return false;
            dragOnUi = false;
            dispatchSynthetic("pointerup", x, y, button);
            return true;
        },
        wheel(x, y, dx, dy) {
            if (!hitTest(x, y)) return false;
            dispatchSynthetic("wheel", x, y, 0, { deltaX: dx, deltaY: dy, deltaZ: 0, deltaMode: 0 });
            return true;
        },
    };

    function hitTest(x: number, y: number): boolean {
        const events = (host.renderer as any)?.events;
        const rootBoundary = events?.rootBoundary;
        if (!rootBoundary?.hitTest || !rootBoundary.rootTarget) return false;
        try { return !!rootBoundary.hitTest(x, y); } catch { return false; }
    }
}
