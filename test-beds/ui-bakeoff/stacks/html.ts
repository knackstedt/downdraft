// ============================================================================
// html.ts — Blitz OSR gallery: static HTML/CSS rasterized by the
// downdraft-blitz-osr cdylib (HtmlDocument + vello_cpu).
//
// No JS executes in the document — interactivity is semantic: pointer events
// go to the doc for :hover/scroll behavior, while a TS-side HitMap applies
// state changes and regenerates the markup via setHtml.
// ============================================================================

import { OsrDoc } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import {
    freshState, HitMap, LIST_ITEMS, RgbaBlit, TABS,
    type GalleryState, type StackCtx, type UiStack,
} from "../stack";

const MY_TAB = 3;

// Supersample factor — the doc rasterizes at SS× CSS size and the blit pass
// linear-downsamples to the surface. vello_cpu has no subpixel (LCD) AA, so
// this is the sharpness lever: 2× ≈ 4 samples/px for edges and glyphs.
const SS = 2;

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#10141a; color:#e8ecf1; font-family:sans-serif; overflow:hidden; }
.tabbar { display:flex; align-items:center; gap:8px; padding:10px 16px; background:#161b23; border-bottom:1px solid #2a313c; height:48px; }
.title { font-size:15px; font-weight:bold; margin-right:12px; }
.tab { padding:6px 14px; border-radius:4px; font-size:13px; background:#1c222c; color:#8a94a3; }
.tab.on { background:#2e4361; color:#7fd0ff; font-weight:bold; }
.hint { margin-left:auto; font-size:11px; color:#5d6775; }
.body { display:flex; gap:16px; padding:16px; }
.panel { background:#161b23; border:1px solid #2a313c; border-radius:6px; padding:14px; }
.left { width:380px; }
.section { font-size:11px; color:#8a94a3; letter-spacing:1px; margin-bottom:10px; }
.btns { display:flex; gap:8px; margin-bottom:14px; }
.btn { padding:8px 14px; border-radius:4px; border:1px solid #3a4553; font-size:12px; background:#212933; color:#e8ecf1; }
.btn.accent { background:#1d3547; color:#7fd0ff; border-color:#4fc2f7; }
.btn.danger { background:#3a1d1d; color:#f28b82; border-color:#e5534b; }
.btn.disabled { background:#1a1f27; color:#4a5568; border-color:#1a1f27; }
.check { display:flex; align-items:center; gap:8px; padding:4px 0; }
.box { width:16px; height:16px; border:1px solid #4a5568; border-radius:3px; background:#161b23; color:#10141a; font-size:11px; font-weight:bold; text-align:center; line-height:14px; }
.box.on { background:#4fc2f7; }
.check .lbl { font-size:12px; }
.srow { display:flex; justify-content:space-between; font-size:11px; color:#8a94a3; margin-bottom:4px; }
.track { height:14px; background:#212933; border-radius:7px; margin-bottom:14px; }
.fill { height:14px; background:#4fc2f7; border-radius:7px; }
.ptrack { height:10px; background:#212933; border-radius:5px; margin-bottom:14px; }
.pfill { height:10px; background:#6fbf73; border-radius:5px; }
.seg { display:flex; gap:4px; background:#0f1319; border-radius:5px; padding:3px; width:fit-content; margin-bottom:14px; }
.seg .o { padding:5px 16px; border-radius:4px; font-size:11px; color:#8a94a3; }
.seg .o.on { background:#2e4361; color:#7fd0ff; }
.list { height:118px; overflow-y:auto; background:#0f1319; border:1px solid #2a313c; border-radius:4px; margin-bottom:14px; }
.item { padding:5px 10px; font-size:11px; color:#c8d0db; border-bottom:1px solid #1c222c; }
.item.on { background:#2e4361; color:#7fd0ff; }
.field { padding:7px 10px; background:#0f1319; border:1px solid #4a5568; border-radius:4px; font-size:13px; }
.caret { color:#4fc2f7; }
.right { flex:1; }
.bar { height:16px; background:#212933; border-radius:4px; margin-bottom:8px; }
.bfill { height:16px; border-radius:4px; }
.hp { background:linear-gradient(90deg,#e5534b,#f0a04b); }
.mana { background:#4fc2f7; }
.meta { font-size:11px; color:#8a94a3; }
.toast { background:#1d2a1d; border:1px solid #4a7a4a; border-radius:6px; padding:10px 14px; font-size:11px; color:#9fd89f; width:fit-content; margin-top:14px; }
`;

function buildHtml(s: GalleryState): string {
    const tabs = TABS.map((t, i) => `<div class="tab${i === MY_TAB ? " on" : ""}" data-ui>${t}</div>`).join("");
    const checks = ["VSync", "Fullscreen", "Bloom"].map((l, i) =>
        `<div class="check" data-ui><div class="box${s.checks[i] ? " on" : ""}">${s.checks[i] ? "X" : ""}</div><div class="lbl">${l}</div></div>`
    ).join("");
    const seg = ["Items", "Stats", "Log"].map((o, i) =>
        `<div class="o${s.segment === i ? " on" : ""}" data-ui>${o}</div>`).join("");
    const items = LIST_ITEMS.map((it, i) =>
        `<div class="item${s.selected === i ? " on" : ""}" data-ui>${it}</div>`).join("");
    return `<html><head><style>${CSS}</style></head><body>
<div class="tabbar"><div class="title">UI Bake-off</div>${tabs}<div class="hint">keys 1-5 / arrows to switch</div></div>
<div class="body">
 <div class="panel left">
  <div class="section">WIDGETS — HTML/CSS (BLITZ OSR)</div>
  <div class="btns">
    <div class="btn" data-ui>Normal</div>
    <div class="btn accent" data-ui>Accent</div>
    <div class="btn danger" data-ui>Danger</div>
    <div class="btn disabled">Disabled</div>
  </div>
  ${checks}
  <div style="height:8px"></div>
  <div class="srow"><span>Volume</span><span>${Math.round(s.slider)}</span></div>
  <div class="track" data-ui><div class="fill" style="width:${s.slider}%"></div></div>
  <div class="srow"><span>Loading</span><span>42%</span></div>
  <div class="ptrack"><div class="pfill" style="width:${s.progress}%"></div></div>
  <div class="seg">${seg}</div>
  <div class="srow"><span>Inventory (scroll)</span></div>
  <div class="list" data-ui>${items}</div>
  <div class="srow"><span>Callsign</span></div>
  <div class="field">${s.text}<span class="caret">|</span></div>
 </div>
 <div class="right">
  <div class="panel">
   <div class="section">HUD MOCK</div>
   <div class="srow"><span>HP</span><span>${s.hp} / 100</span></div>
   <div class="bar" data-ui><div class="bfill hp" style="width:${s.hp}%"></div></div>
   <div class="srow"><span>Mana</span><span>${s.mana} / 100</span></div>
   <div class="bar" data-ui><div class="bfill mana" style="width:${s.mana}%"></div></div>
   <div class="meta">Clicks: ${s.clicks}</div>
  </div>
  <div class="toast">Item added to inventory</div>
 </div>
</div></body></html>`;
}

// Hit regions mirror the HTML layout (fixed geometry — see CSS above).
const PANEL_X = 16, PANEL_Y = 76; // 16 padding + 60 header? see .body padding 16
const LEFT_X = 16, LEFT_Y = 76, LEFT_W = 380;

export function createHtmlStack(): UiStack {
    let doc: OsrDoc | null = null;
    let blit: RgbaBlit;
    let state = freshState();
    let ctx: StackCtx;
    const hits = new HitMap();
    let W = 1280, H = 800;

    function regen() {
        if (doc) doc.setHtml(buildHtml(state));
    }

    function clampPct(x: number, x0: number, w: number): number {
        return Math.max(0, Math.min(100, ((x - x0) / w) * 100));
    }

    function buildRegions() {
        hits.regions.length = 0;
        // Tabs — match buildHtml's flex layout: title ~100px then tabs.
        let tx = 140;
        TABS.forEach((name, i) => {
            const w = name.length * 8 + 28;
            hits.regions.push({
                x: tx, y: 10, w, h: 28,
                onClick: () => ctx.onAction("tab", JSON.stringify({ index: i })),
            });
            tx += w + 8;
        });
        // Left panel content: padding 14 inside panel at LEFT_X,LEFT_Y.
        const cx = LEFT_X + 14;
        let y = LEFT_Y + 14 + 14 + 10; // section label height+margin
        // buttons row (h≈33px incl border) then margin 14
        const bw = [76, 78, 76, 90];
        let bx = cx;
        ["Normal", "Accent", "Danger"].forEach((_, i) => {
            hits.regions.push({ x: bx, y, w: bw[i], h: 33, onClick: () => { state.clicks++; regen(); } });
            bx += bw[i] + 8;
        });
        y += 33 + 14;
        for (let i = 0; i < 3; i++) {
            hits.regions.push({
                x: cx, y, w: 200, h: 22,
                onClick: () => { state.checks[i] = !state.checks[i]; regen(); },
            });
            y += 22;
        }
        y += 8 + 15 + 4; // spacer + slider label + margin
        hits.regions.push({
            x: cx, y, w: 352, h: 14, drag: true,
            onDown: (x) => { state.slider = clampPct(x, cx, 352); regen(); },
            onDrag: (x) => { state.slider = clampPct(x, cx, 352); regen(); },
        });
        y += 14 + 14 + 15 + 4 + 10 + 14; // track + margin + loading label + bar + margin
        // segmented
        ["Items", "Stats", "Log"].forEach((_, i) => {
            hits.regions.push({ x: cx + 3 + i * 71, y: y + 3, w: 68, h: 24, onClick: () => { state.segment = i; regen(); } });
        });
        y += 30 + 14 + 15 + 4;
        // list rows
        const rowH = 26;
        for (let i = 0; i < LIST_ITEMS.length; i++) {
            hits.regions.push({ x: cx, y: y + i * rowH, w: 350, h: rowH, onClick: () => { state.selected = i; regen(); } });
        }
        // right HUD bars — right panel at x=412, padding 14 → cx2 = 426; width = flex (~784-28)
        const rx = 412 + 14;
        const rw = 1176 - rx; // panel spans to window edge -16
        let ry = LEFT_Y + 14 + 14 + 10 + 15 + 4; // section + label margin
        ([[() => state.hp, (v: number) => state.hp = v], [() => state.mana, (v: number) => state.mana = v]] as const).forEach(([get, set]) => {
            void get;
            hits.regions.push({
                x: rx, y: ry, w: rw, h: 16, drag: true,
                onDown: (x) => { set(Math.round(clampPct(x, rx, rw))); regen(); },
                onDrag: (x) => { set(Math.round(clampPct(x, rx, rw))); regen(); },
            });
            ry += 16 + 8 + 15 + 4;
        });
    }

    return {
        id: "html",
        label: "HTML/CSS",
        async init(c: StackCtx) {
            ctx = c;
            W = c.width; H = c.height;
            // Raster buffer is W*SS × H*SS physical; CSS viewport stays W×H.
            doc = OsrDoc.create(c.width * SS, c.height * SS, SS, buildHtml(state));
            if (!doc) throw new Error("downdraft-blitz-osr library not available");
            blit = new RgbaBlit(c.device, c.format, { linearResolve: true });
            buildRegions();
        },
        frame(target) {
            const px = doc?.frame();
            if (px) blit.frame(target, px, W * SS, H * SS);
            else blit.blit(target); // clean doc — composite the last raster
        },
        resize(w, h) { W = w; H = h; doc?.resize(w * SS, h * SS, SS); },
        dispose() { doc?.destroy(); blit.dispose(); },
        // The doc's "physical" coords are SS× the surface's.
        pointerDown(x, y) {
            doc?.pointerDown(x * SS, y * SS);
            return hits.pointerDown(x, y);
        },
        pointerMove(x, y) {
            doc?.pointerMove(x * SS, y * SS);
            return hits.pointerMove(x, y);
        },
        pointerUp(x, y) {
            doc?.pointerUp(x * SS, y * SS);
            return hits.pointerUp(x, y);
        },
        wheel(x, y, dx, dy) {
            doc?.wheel(x * SS, y * SS, dx, dy);
            return doc?.hitTest(x * SS, y * SS) ?? false;
        },
    };
}
