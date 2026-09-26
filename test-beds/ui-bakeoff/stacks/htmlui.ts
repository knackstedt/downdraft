// ============================================================================
// htmlui.ts — modules/html-ui stack: the real product path. Blitz docs owned
// by a dedicated worker thread, dirty-rect uploads, PanelBlitPass compositor,
// data-action event channel, incremental DOM mutations, and a native <input>.
//
// Interactivity is REAL here (vs the html.ts HitMap fake): clicks/inputs
// surface as DOM events on the host, which mutates state + doc.
// ============================================================================

import {
    freshState, LIST_ITEMS, TABS,
    type GalleryState, type StackCtx, type UiStack,
} from "../stack";
import { HtmlUiHost, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import type {
    InputEventControl, RendererInputBus, OsrDomEvent,
} from "./mini-bus";
import { MiniInputBus } from "./mini-bus";

const MY_TAB = 5;

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
.btn:active { background:#31404f; }
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
.field { width:200px; padding:7px 10px; background:#0f1319; border:1px solid #4a5568; border-radius:4px; font-size:13px; color:#e8ecf1; }
.right { flex:1; }
.bar { height:16px; background:#212933; border-radius:4px; margin-bottom:8px; }
.bfill { height:16px; border-radius:4px; }
.hp { background:linear-gradient(90deg,#e5534b,#f0a04b); }
.mana { background:#4fc2f7; }
.meta { font-size:11px; color:#8a94a3; }
.toast { background:#1d2a1d; border:1px solid #4a7a4a; border-radius:6px; padding:10px 14px; font-size:11px; color:#9fd89f; width:fit-content; margin-top:14px; }
`;

// Known layout geometry for pointer→value drags (CSS px, doc-local).
const SLIDER_X = 30, SLIDER_W = 352;
const HP_X = 426, HP_W = 750;

function buildHtml(s: GalleryState): string {
    const tabs = TABS.map((t, i) =>
        `<div class="tab${i === MY_TAB ? " on" : ""}" data-action="tab" data-i="${i}">${t}</div>`).join("");
    const checks = ["VSync", "Fullscreen", "Bloom"].map((l, i) =>
        `<div class="check" data-action="check" data-i="${i}"><div class="box${s.checks[i] ? " on" : ""}">${s.checks[i] ? "X" : ""}</div><div class="lbl">${l}</div></div>`
    ).join("");
    const seg = ["Items", "Stats", "Log"].map((o, i) =>
        `<div class="o${s.segment === i ? " on" : ""}" data-action="seg" data-i="${i}">${o}</div>`).join("");
    const items = LIST_ITEMS.map((it, i) =>
        `<div class="item${s.selected === i ? " on" : ""}" data-action="item" data-i="${i}">${it}</div>`).join("");
    return `<html><head><style>${CSS}</style></head><body>
<div class="tabbar"><div class="title">UI Bake-off</div>${tabs}<div class="hint">worker + dirty-rect + data-action</div></div>
<div class="body">
 <div class="panel left">
  <div class="section">WIDGETS — MODULES/HTML-UI (WORKER BLITZ)</div>
  <div class="btns">
    <div class="btn" data-action="bump">Normal</div>
    <div class="btn accent" data-action="bump">Accent</div>
    <div class="btn danger" data-action="bump">Danger</div>
    <div class="btn disabled">Disabled</div>
  </div>
  ${checks}
  <div style="height:8px"></div>
  <div class="srow"><span>Volume</span><span id="vol">${Math.round(s.slider)}</span></div>
  <div class="track" data-action="slider" data-x0="${SLIDER_X}" data-w="${SLIDER_W}"><div class="fill" id="volfill" style="width:${s.slider}%"></div></div>
  <div class="srow"><span>Loading</span><span>42%</span></div>
  <div class="ptrack"><div class="pfill" style="width:${s.progress}%"></div></div>
  <div class="seg">${seg}</div>
  <div class="srow"><span>Inventory (native scroll)</span></div>
  <div class="list">${items}</div>
  <div class="srow"><span>Callsign (real input)</span></div>
  <input class="field" id="callsign" value="${s.text}">
 </div>
 <div class="right">
  <div class="panel">
   <div class="section">HUD MOCK</div>
   <div class="srow"><span>HP</span><span id="hplbl">${s.hp} / 100</span></div>
   <div class="bar" data-action="hp" data-x0="${HP_X}" data-w="${HP_W}"><div class="bfill hp" id="hpfill" style="width:${s.hp}%"></div></div>
   <div class="srow"><span>Mana</span><span id="mnlbl">${s.mana} / 100</span></div>
   <div class="bar" data-action="mana" data-x0="${HP_X}" data-w="${HP_W}"><div class="bfill mana" id="mnfill" style="width:${s.mana}%"></div></div>
   <div class="meta" id="clicks">Clicks: ${s.clicks}</div>
  </div>
  <div class="toast">Item added to inventory</div>
 </div>
</div></body></html>`;
}

export function createHtmlUiStack(): UiStack {
    let host: HtmlUiHost | null = null;
    let panel: UiPanelHandle | null = null;
    let state = freshState();
    let ctx: StackCtx;
    let W = 1280, H = 800;
    const bus = new MiniInputBus();
    let regenTimer: ReturnType<typeof setTimeout> | null = null;

    function regen() { panel?.setHtml(buildHtml(state)); }
    // Regen through the worker is async-ish; batch bursts (drags) a bit.
    function regenSoon() {
        if (regenTimer) return;
        regenTimer = setTimeout(() => { regenTimer = null; regen(); }, 0);
    }

    function pct(ev: OsrDomEvent): number {
        const x0 = Number(ev.d?.x0 ?? 0), w = Number(ev.d?.w ?? 1);
        return Math.max(0, Math.min(100, (((ev.x ?? 0) - x0) / w) * 100));
    }

    function wire(h: UiPanelHandle) {
        h.onEvent((ev) => {
            // Value events + drag moves drive state without a full regen where
            // a targeted mutation suffices.
            if (ev.t === "input" && ev.id === "callsign") { state.text = ev.v ?? ""; return; }
            if (ev.t === "pointermove" && (ev.d?.action === "slider" || ev.d?.action === "hp" || ev.d?.action === "mana")) {
                applyDrag(ev);
                return;
            }
        });
        ["tab", "check", "seg", "item", "bump", "slider", "hp", "mana"].forEach((act) => {
            host!.onAction(act, (d, ev) => onAction(act, d, ev));
        });
    }

    function applyDrag(ev: OsrDomEvent) {
        const v = Math.round(pct(ev));
        if (ev.d!.action === "slider") {
            state.slider = v;
            panel?.setText("#vol", String(v));
            panel?.setStyle("#volfill", "width", `${v}%`);
        } else if (ev.d!.action === "hp") {
            state.hp = v;
            panel?.setText("#hplbl", `${v} / 100`);
            panel?.setStyle("#hpfill", "width", `${v}%`);
        } else {
            state.mana = v;
            panel?.setText("#mnlbl", `${v} / 100`);
            panel?.setStyle("#mnfill", "width", `${v}%`);
        }
    }

    function onAction(act: string, d: Record<string, string>, ev: OsrDomEvent) {
        const i = Number(d.i ?? 0);
        switch (act) {
            case "tab": ctx.onAction("tab", JSON.stringify({ index: i })); break;
            case "check": state.checks[i] = !state.checks[i]; regenSoon(); break;
            case "seg": state.segment = i; regenSoon(); break;
            case "item": state.selected = i; regenSoon(); break;
            case "bump": state.clicks++; panel?.setText("#clicks", `Clicks: ${state.clicks}`); break;
            case "slider": case "hp": case "mana": applyDrag(ev); break;
        }
    }

    return {
        id: "htmlui",
        label: "HTML-UI mod",
        async init(c: StackCtx) {
            ctx = c; W = c.width; H = c.height;
            host = new HtmlUiHost(c.device, c.format);
            host.bindInput(bus);
            panel = host.mount({
                rect: { x: 0, y: 0, w: W, h: H },
                html: buildHtml(state),
                scale: 2,
            });
            wire(panel);
        },
        frame(target) {
            if (!host) return;
            const enc = (ctx.device as unknown as GPUDevice).createCommandEncoder();
            const pass = enc.beginRenderPass({
                colorAttachments: [{ view: target, loadOp: "load" as GPULoadOp, storeOp: "store" as GPUStoreOp }],
            });
            host.compositor.render(pass, W, H);
            pass.end();
            (ctx.device as unknown as GPUDevice).queue.submit([enc.finish()]);
        },
        resize(w, h) { W = w; H = h; panel?.setRect({ x: 0, y: 0, w, h }); },
        dispose() { host?.dispose(); host = null; },
        pointerDown(x, y, b) { bus.pointerDown(x, y, b); return bus.consumed; },
        pointerUp(x, y, b) { bus.pointerUp(x, y, b); return bus.consumed; },
        pointerMove(x, y) { bus.pointerMove(x, y); return bus.consumed; },
        wheel(x, y, dx, dy) { bus.wheel(x, y, dx, dy); return bus.consumed; },
        key(down, key, code, _keyCode, _mods) { bus.key(down, key, code); return bus.consumed; },
    };
}
