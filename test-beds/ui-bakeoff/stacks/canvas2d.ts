// ============================================================================
// canvas2d.ts — CanvasRenderingContext2D gallery.
//
// The native Canvas2D polyfill (NativeCanvas2D, FreeType-backed) implements
// fillRect/clearRect/fillText/strokeText/measureText/drawImage/putImageData —
// all path APIs are no-ops, so this gallery is rectangles + text, which is
// the honest capability envelope of the stack.
// ============================================================================

import { NativeCanvas2D, VirtualCanvas } from "@downdraft/platform-native";
import {
    freshState, HitMap, LIST_ITEMS, RgbaBlit, TABS,
    type StackCtx, type UiStack
} from "../stack";

const C = {
    bg: "#10141a",
    panel: "#161b23",
    panelAlt: "#0f1319",
    border: "#2a313c",
    text: "#e8ecf1",
    dim: "#8a94a3",
    accent: "#4fc2f7",
    accentBg: "#1d3547",
    accentHot: "#2e4361",
    danger: "#e5534b",
    dangerBg: "#3a1d1d",
    track: "#212933",
    green: "#6fbf73",
    greenBg: "#1d2a1d",
    disabledText: "#4a5568",
};

const MY_TAB = 4;

export function createCanvas2dStack(): UiStack {
    let vc: VirtualCanvas;
    let g: NativeCanvas2D;
    let blit: RgbaBlit;
    let state = freshState();
    let ctx: StackCtx;
    let dirty = true;
    const hits = new HitMap();
    let listScroll = 0;
    // Rebuilt each draw(); the wheel handler checks the pointer is inside it.
    const listRegion = { x: 0, y: 0, w: 0, h: 0 } as { x: number; y: number; w: number; h: number };

    // ── Layout ──
    const TAB_Y = 10, TAB_H = 28;
    const PANEL_X = 16, PANEL_Y = 60, PANEL_W = 380;
    const RIGHT_X = 412;
    const ROW_H = 22;

    function rect(x: number, y: number, w: number, h: number, fill: string, border?: string) {
        g.fillStyle = fill;
        g.fillRect(x, y, w, h);
        if (border) {
            // NativeCanvas2D has no strokeRect — draw borders as 1px strips.
            g.fillStyle = border;
            g.fillRect(x, y, w, 1);
            g.fillRect(x, y + h - 1, w, 1);
            g.fillRect(x, y, 1, h);
            g.fillRect(x + w - 1, y, 1, h);
        }
    }

    function text(s: string, x: number, y: number, color = C.text, size = 13, bold = false) {
        g.fillStyle = color;
        g.font = `${bold ? "bold " : ""}${size}px sans-serif`;
        g.fillText(s, x, y);
    }

    function draw() {
        hits.regions.length = 0;
        g.fillStyle = C.bg;
        g.fillRect(0, 0, vc.width, vc.height);

        // ── Tab bar ──
        rect(0, 0, vc.width, 48, C.panel);
        g.fillStyle = C.border;
        g.fillRect(0, 47, vc.width, 1);
        text("UI Bake-off", 16, 29, C.text, 15, true);
        let tx = 140;
        TABS.forEach((name, i) => {
            const w = name.length * 8 + 28;
            const active = i === MY_TAB;
            rect(tx, TAB_Y, w, TAB_H, active ? C.accentHot : "#1c222c");
            text(name, tx + 14, TAB_Y + 19, active ? "#7fd0ff" : C.dim, 13, active);
            hits.regions.push({
                x: tx, y: TAB_Y, w, h: TAB_H,
                onClick: () => ctx.onAction("tab", JSON.stringify({ index: i })),
            });
            tx += w + 8;
        });
        text("keys 1-5 / arrows to switch", vc.width - 240, 29, "#5d6775", 11);

        // ── Left widget panel ──
        let y = PANEL_Y + 14;
        rect(PANEL_X, PANEL_Y, PANEL_W, 690, C.panel, C.border);
        text("WIDGETS — CANVAS2D (FREETYPE)", PANEL_X + 14, y + 6, C.dim, 11); y += 26;

        // Buttons
        const btn = (label: string, x: number, w: number, bg: string, fg: string, bc: string, on?: () => void) => {
            rect(x, y, w, 30, bg, bc);
            text(label, x + 12, y + 20, fg, 12);
            if (on) hits.regions.push({ x, y, w, h: 30, onClick: on });
        };
        const bump = () => { state.clicks++; dirty = true; };
        btn("Normal", PANEL_X + 14, 84, C.track, C.text, C.border, bump);
        btn("Accent", PANEL_X + 106, 84, C.accentBg, "#7fd0ff", C.accent, bump);
        btn("Danger", PANEL_X + 198, 80, C.dangerBg, "#f28b82", C.danger, bump);
        btn("Disabled", PANEL_X + 286, 84, "#1a1f27", C.disabledText, "#1a1f27");
        y += 46;

        // Checkboxes
        ["VSync", "Fullscreen", "Bloom"].forEach((label, i) => {
            const on = state.checks[i];
            rect(PANEL_X + 14, y, 16, 16, on ? C.accent : "#161b23", "#4a5568");
            if (on) text("X", PANEL_X + 18, y + 12, "#10141a", 11, true);
            text(label, PANEL_X + 38, y + 12, C.text, 12);
            hits.regions.push({
                x: PANEL_X + 14, y, w: 200, h: 18,
                onClick: () => { state.checks[i] = !state.checks[i]; dirty = true; },
            });
            y += ROW_H;
        });
        y += 8;

        // Slider
        text("Volume", PANEL_X + 14, y + 10, C.dim, 11);
        text(String(Math.round(state.slider)), PANEL_X + PANEL_W - 44, y + 10, C.text, 11);
        y += 16;
        rect(PANEL_X + 14, y, 340, 14, C.track);
        rect(PANEL_X + 14, y, 340 * state.slider / 100, 14, C.accent);
        const sliderRegion = {
            x: PANEL_X + 14, y, w: 340, h: 14, drag: true,
            onDown: (x: number) => { state.slider = clampPct(x, PANEL_X + 14, 340); dirty = true; },
            onDrag: (x: number) => { state.slider = clampPct(x, PANEL_X + 14, 340); dirty = true; },
        };
        hits.regions.push(sliderRegion);
        y += 30;

        // Progress
        text("Loading", PANEL_X + 14, y + 10, C.dim, 11);
        text("42%", PANEL_X + PANEL_W - 44, y + 10, C.text, 11);
        y += 16;
        rect(PANEL_X + 14, y, 340, 10, C.track);
        rect(PANEL_X + 14, y, 340 * state.progress / 100, 10, C.green);
        y += 26;

        // Segmented
        rect(PANEL_X + 14, y, 216, 30, C.panelAlt);
        ["Items", "Stats", "Log"].forEach((s, i) => {
            const x = PANEL_X + 17 + i * 71;
            const on = state.segment === i;
            rect(x, y + 3, 68, 24, on ? C.accentHot : C.panelAlt);
            text(s, x + 14, y + 20, on ? "#7fd0ff" : C.dim, 11);
            hits.regions.push({ x, y: y + 3, w: 68, h: 24, onClick: () => { state.segment = i; dirty = true; } });
        });
        y += 44;

        // Scroll list (wheel scrolls, click selects)
        text("Inventory (scroll)", PANEL_X + 14, y + 10, C.dim, 11);
        y += 16;
        const listY = y, listH = 118, rowH = 24;
        rect(PANEL_X + 14, listY, 340, listH, C.panelAlt, C.border);
        const visible = Math.floor((listH - 4) / rowH);
        const maxScroll = Math.max(0, LIST_ITEMS.length - visible);
        listScroll = Math.max(0, Math.min(listScroll, maxScroll));
        for (let v = 0; v < visible; v++) {
            const i = v + listScroll;
            if (i >= LIST_ITEMS.length) break;
            const ry = listY + 2 + v * rowH;
            const sel = state.selected === i;
            if (sel) rect(PANEL_X + 16, ry, 336, rowH, C.accentHot);
            text(LIST_ITEMS[i], PANEL_X + 24, ry + 16, sel ? "#7fd0ff" : "#c8d0db", 11);
            hits.regions.push({ x: PANEL_X + 14, y: ry, w: 340, h: rowH, onClick: () => { state.selected = i; dirty = true; } });
        }
        listRegion.x = PANEL_X + 14; listRegion.y = listY; listRegion.w = 340; listRegion.h = listH;
        hits.regions.push(listRegion); // wheel target (also catches clicks on padding)
        y += listH + 14;

        // Text field
        text("Callsign", PANEL_X + 14, y + 10, C.dim, 11);
        y += 14;
        rect(PANEL_X + 14, y, 340, 28, C.panelAlt, "#4a5568");
        text(state.text + "|", PANEL_X + 24, y + 19, C.text, 12);

        // ── Right: HUD mock ──
        const hp = (label: string, v: number, col: string, ry: number, set: (n: number) => void) => {
            text(label, RIGHT_X + 14, ry + 10, C.dim, 11);
            text(`${v} / 100`, RIGHT_X + 730, ry + 10, C.text, 11);
            rect(RIGHT_X + 14, ry + 16, 770, 16, C.track);
            rect(RIGHT_X + 14, ry + 16, 770 * v / 100, 16, col);
            hits.regions.push({
                x: RIGHT_X + 14, y: ry + 16, w: 770, h: 16, drag: true,
                onDown: (x) => { set(Math.round(clampPct(x, RIGHT_X + 14, 770))); dirty = true; },
                onDrag: (x) => { set(Math.round(clampPct(x, RIGHT_X + 14, 770))); dirty = true; },
            });
        };
        rect(RIGHT_X, PANEL_Y, 800, 120, C.panel, C.border);
        text("HUD MOCK", RIGHT_X + 14, PANEL_Y + 20, C.dim, 11);
        hp("HP", state.hp, "#e06840", PANEL_Y + 30, (n) => state.hp = n);
        hp("Mana", state.mana, C.accent, PANEL_Y + 66, (n) => state.mana = n);
        text(`Clicks: ${state.clicks}`, RIGHT_X + 14, PANEL_Y + 112, C.dim, 11);

        // Toast
        rect(RIGHT_X, PANEL_Y + 136, 220, 34, C.greenBg, "#4a7a4a");
        text("Item added to inventory", RIGHT_X + 12, PANEL_Y + 157, "#9fd89f", 11);
    }

    function clampPct(x: number, x0: number, w: number): number {
        return Math.max(0, Math.min(100, ((x - x0) / w) * 100));
    }

    return {
        id: "canvas2d",
        label: "Canvas2D",
        async init(c: StackCtx) {
            ctx = c;
            vc = new VirtualCanvas(c.width, c.height);
            g = vc.getContext("2d") as NativeCanvas2D;
            blit = new RgbaBlit(c.device, c.format);
        },
        frame(target) {
            if (dirty) { draw(); dirty = false; }
            const px = vc.getPixelData();
            if (px) blit.frame(target, px, vc.width, vc.height);
        },
        resize(w, h) { vc.resize(w, h); g = vc.getContext("2d") as NativeCanvas2D; dirty = true; },
        dispose() { blit.dispose(); vc.destroy(); },
        pointerDown(x, y) { return hits.pointerDown(x, y); },
        pointerMove(x, y) { return hits.pointerMove(x, y); },
        pointerUp(x, y) { return hits.pointerUp(x, y); },
        wheel(x, y, _dx, dy) {
            const r = listRegion;
            if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
                const visible = Math.floor((118 - 4) / 24);
                const maxScroll = Math.max(0, LIST_ITEMS.length - visible);
                const prev = listScroll;
                listScroll = Math.max(0, Math.min(maxScroll, listScroll + Math.sign(dy)));
                if (listScroll !== prev) { dirty = true; return true; }
            }
            return false;
        },
    };
}
