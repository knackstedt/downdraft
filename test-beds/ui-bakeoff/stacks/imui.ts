// ============================================================================
// imui.ts — engine-native imui gallery (the canonical game-UI stack).
//
// Same lifecycle GameRenderer owns internally: UIRenderer + UIRoot +
// LayoutEngine + UIInputRouter. Widgets from the standard kit (uiButton,
// uiCheckbox, uiSliderRow, uiSegmented, UITextInput, UIScrollPanel,
// UIProgressBar, UITabBar).
// ============================================================================

import {
    LayoutEngine,
    uiButton,
    uiCheckbox,
    UIInputRouter,
    UIPanel,
    UIProgressBar,
    UIRenderer,
    UIRoot,
    UIScrollPanel,
    uiSegmented,
    uiSetEnabled,
    uiSliderRow,
    UITabBar,
    uiText,
    UITextInput,
    type UIColor,
    type UIElement
} from "@downdraft/engine";
import { getFreeTypeTextRenderer } from "@downdraft/platform-native";
import {
    freshState, LIST_ITEMS, TABS,
    type StackCtx, type UiStack,
} from "../stack";

const MY_TAB = 0;

const ACCENT: UIColor = [0.31, 0.76, 0.97, 1];
const DIM: UIColor = [0.54, 0.58, 0.64, 1];

export function createImuiStack(): UiStack {
    let ctx: StackCtx;
    let uiRenderer: UIRenderer;
    let uiRoot: UIRoot;
    let layoutEngine: LayoutEngine;
    let router: UIInputRouter;
    let dirty = true;
    const state = freshState();

    function build(w: number, h: number) {
        uiRoot = new UIRoot(w, h);
        router.setRoot(uiRoot);

        // ── Tab bar ──
        const bar = new UIPanel(w, 48);
        bar.style.backgroundColor = [0.086, 0.106, 0.137, 1];
        bar.style.borderWidth = 0;
        bar.pointerThrough = false;
        uiRoot.addChild(bar);
        const title = uiText("UI Bake-off", 16, 16, { bold: true, size: 15 });
        bar.addChild(title);
        const tabBar = new UITabBar(w - 260);
        tabBar.x = 140;
        tabBar.y = 8;
        tabBar.tabHeight = 30;
        tabBar.activeColor = [0.18, 0.26, 0.38, 1];
        tabBar.setTabs(TABS.map((t, i) => ({ id: String(i), label: t })));
        tabBar.setActiveTab(String(MY_TAB));
        tabBar.onTabChange = (id) => ctx.onAction("tab", JSON.stringify({ index: Number(id) }));
        bar.addChild(tabBar);
        bar.addChild(uiText("keys 1-5 / arrows to switch", w - 240, 18, { size: 11, color: [0.36, 0.4, 0.46, 1] }));

        // ── Left widget panel ──
        const left = new UIPanel(380, 700);
        left.x = 16; left.y = 60;
        left.style.backgroundColor = [0.086, 0.106, 0.137, 1];
        left.style.borderColor = [0.165, 0.19, 0.235, 1];
        left.style.borderWidth = 1;
        left.style.borderRadius = 6;
        left.pointerThrough = false;
        uiRoot.addChild(left);

        let y = 12;
        const lx = 14;
        left.addChild(uiText("WIDGETS — IMUI (ENGINE-NATIVE)", lx, y, { size: 11, color: DIM }));
        y += 26;

        // Buttons
        const bump = () => { state.clicks++; clicksText.setText(`Clicks: ${state.clicks}`); dirty = true; };
        const b1 = uiButton("Normal", 84, 30, bump); b1.x = lx; b1.y = y; left.addChild(b1);
        const b2 = uiButton("Accent", 84, 30, bump, { accent: true }); b2.x = lx + 92; b2.y = y; left.addChild(b2);
        const b3 = uiButton("Danger", 80, 30, bump, { danger: true }); b3.x = lx + 184; b3.y = y; left.addChild(b3);
        const b4 = uiButton("Disabled", 84, 30, () => {}); b4.x = lx + 272; b4.y = y; uiSetEnabled(b4, false); left.addChild(b4);
        y += 44;

        // Checkboxes
        (["VSync", "Fullscreen", "Bloom"] as const).forEach((label, i) => {
            const cb = uiCheckbox(label, state.checks[i], (v) => { state.checks[i] = v; });
            cb.el.x = lx; cb.el.y = y; left.addChild(cb.el);
            y += 24;
        });
        y += 10;

        // Slider
        const srow = uiSliderRow("Volume", 0, 100, state.slider, 340, (v) => { state.slider = v; });
        srow.row.x = lx; srow.row.y = y; left.addChild(srow.row);
        y += 48;

        // Progress
        left.addChild(uiText("Loading", lx, y, { size: 11, dim: true }));
        const ptxt = uiText("42%", lx + 306, y, { size: 11 });
        left.addChild(ptxt);
        y += 16;
        const prog = new UIProgressBar(340, 10);
        prog.x = lx; prog.y = y;
        prog.maxValue = 100;
        prog.setValue(state.progress);
        prog.style.borderRadius = 5;
        left.addChild(prog);
        y += 24;

        // Segmented
        const seg = uiSegmented("", ["items", "stats", "log"], { items: "Items", stats: "Stats", log: "Log" },
            ["items", "stats", "log"][state.segment], (v) => { state.segment = ["items", "stats", "log"].indexOf(v); });
        seg.el.x = lx; seg.el.y = y; left.addChild(seg.el);
        y += 38;

        // Scroll list
        left.addChild(uiText("Inventory (scroll)", lx, y, { size: 11, dim: true }));
        y += 16;
        const scroll = new UIScrollPanel(340, 118);
        scroll.x = lx; scroll.y = y;
        scroll.style.backgroundColor = [0.06, 0.075, 0.1, 1];
        scroll.style.borderColor = [0.165, 0.19, 0.235, 1];
        scroll.style.borderWidth = 1;
        scroll.style.borderRadius = 4;
        const rows: UIElement[] = [];
        LIST_ITEMS.forEach((item, i) => {
            const row = new UIPanel(320, 24);
            row.y = i * 24;
            row.style.backgroundColor = i === state.selected ? [0.18, 0.26, 0.38, 1] : [0, 0, 0, 0];
            row.style.borderWidth = 0;
            row.pointerThrough = false;
            row.addChild(uiText(item, 8, 5, { size: 11, color: i === state.selected ? ACCENT : [0.78, 0.82, 0.86, 1] }));
            row.callbacks.onClick = () => {
                state.selected = i;
                rows.forEach((r, j) => {
                    r.style.backgroundColor = j === i ? [0.18, 0.26, 0.38, 1] : [0, 0, 0, 0];
                    (r.children[0] as any).style.textColor = j === i ? [...ACCENT] : [0.78, 0.82, 0.86, 1];
                });
                dirty = true;
            };
            rows.push(row);
            scroll.addChild(row);
        });
        left.addChild(scroll);
        y += 130;

        // Text field
        left.addChild(uiText("Callsign", lx, y, { size: 11, dim: true }));
        y += 15;
        const input = new UITextInput(340, 26);
        input.x = lx; input.y = y;
        input.setText(state.text);
        input.onTextChange = (t) => { state.text = t; };
        left.addChild(input);

        // ── Right: HUD mock ──
        const right = new UIPanel(800, 120);
        right.x = 412; right.y = 60;
        right.style.backgroundColor = [0.086, 0.106, 0.137, 1];
        right.style.borderColor = [0.165, 0.19, 0.235, 1];
        right.style.borderWidth = 1;
        right.style.borderRadius = 6;
        right.pointerThrough = false;
        uiRoot.addChild(right);
        right.addChild(uiText("HUD MOCK", 14, 10, { size: 11, color: DIM }));

        const hpBar = new UIProgressBar(770, 16);
        hpBar.x = 14; hpBar.y = 34; hpBar.maxValue = 100; hpBar.setValue(state.hp);
        hpBar.barColor = [0.88, 0.41, 0.25, 1];
        right.addChild(uiText("HP", 14, 20, { size: 11, dim: true }));
        right.addChild(uiText(`${state.hp} / 100`, 700, 20, { size: 11 }));
        right.addChild(hpBar);

        right.addChild(uiText("Mana", 14, 56, { size: 11, dim: true }));
        right.addChild(uiText(`${state.mana} / 100`, 700, 56, { size: 11 }));
        const manaBar = new UIProgressBar(770, 16);
        manaBar.x = 14; manaBar.y = 72; manaBar.maxValue = 100; manaBar.setValue(state.mana);
        manaBar.barColor = [...ACCENT] as UIColor;
        right.addChild(manaBar);

        const clicksText = uiText(`Clicks: ${state.clicks}`, 14, 96, { size: 11, dim: true });
        right.addChild(clicksText);

        // Toast
        const toast = new UIPanel(220, 34);
        toast.x = 412; toast.y = 196;
        toast.style.backgroundColor = [0.11, 0.16, 0.11, 1];
        toast.style.borderColor = [0.29, 0.48, 0.29, 1];
        toast.style.borderWidth = 1;
        toast.style.borderRadius = 6;
        toast.pointerThrough = false;
        toast.addChild(uiText("Item added to inventory", 12, 9, { size: 11, color: [0.62, 0.85, 0.62, 1] }));
        uiRoot.addChild(toast);
    }

    return {
        id: "imui",
        label: "imui",
        async init(c: StackCtx) {
            ctx = c;
            uiRenderer = new UIRenderer(c.format);
            uiRenderer.prepare(c.device);
            uiRenderer.setScreenSize(c.width, c.height);
            const ft = getFreeTypeTextRenderer();
            if (ft) uiRenderer.getTextCache()?.setDirectRenderer?.(ft);
            layoutEngine = new LayoutEngine();
            layoutEngine.setTextCache(uiRenderer.getTextCache());
            router = new UIInputRouter();
            build(c.width, c.height);
        },
        frame(target) {
            if (dirty) { layoutEngine.layout(uiRoot); dirty = false; }
            const drawables = uiRoot.getDrawable();
            if (drawables.length === 0) return;
            const device = ctx.device;
            const encoder = device.createCommandEncoder();
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view: target, loadOp: "load", storeOp: "store" }],
            });
            uiRenderer.render({ device, pass } as any, drawables);
            pass.end();
            device.queue.submit([encoder.finish()]);
        },
        resize(w, h) {
            uiRoot.width = w; uiRoot.height = h;
            uiRenderer.setScreenSize(w, h);
            dirty = true;
        },
        dispose() {},
        pointerMove(x, y) { router.handleMouseMove(x, y); return router.isPointerOverUI(); },
        pointerDown(x, y) { router.handleMouseDown(x, y); return router.isPointerOverUI(); },
        pointerUp(x, y) { router.handleMouseUp(x, y); return router.isPointerOverUI(); },
        wheel(_x, _y, dx, dy) { return router.handleWheel(dx, dy); },
        key(down, key, _code, keyCode, _mods) {
            if (down) {
                router.handleKeyDown(keyCode);
                if (key.length === 1) router.handleCharInput(key);
            } else {
                router.handleKeyUp(keyCode);
            }
            return router.getFocusedElement() !== null;
        },
    };
}
