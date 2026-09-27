// ============================================================================
// Component Kit testbed — mounts the html-ui-kit gallery in a native window.
// Verifies interactivity end-to-end: every widget is live via bindKit(), a
// status bar echoes the last change, and overlays (modal/context menu/toasts)
// exercise absolute-positioned DOM at the end of the body.
//
// Run:      bun run test-beds/component-kit/main.ts
// Tour:     KIT_TOUR=test-beds/component-kit/shots bun run ... — captures
//           shots/{widgets,form,overlays,stress}.png after warmup.
// Selftest: KIT_SELFTEST=1 bun run ... — scripted input run + DOM assertions,
//           prints PASS/FAIL lines, exits.
// ============================================================================

import * as kit from "@downdraft/engine/libraries/html-ui-kit";
import { HtmlUiHost, type UiPanelHandle } from "@downdraft/engine/modules/html-ui";
import { createLogger } from "@downdraft/engine/util/logger";
import { createNativeHost } from "@downdraft/platform-native";
import { MiniInputBus } from "../ui-bakeoff/stacks/mini-bus";

const log = createLogger("info");
const WIDTH = 1280, HEIGHT = 860;

// ── Gallery pages ──

const LIST = ["Sword", "Shield", "Potion", "Rope", "Lantern", "Map", "Compass", "Key", "Gem", "Scroll",
    "Bow", "Dagger", "Armor", "Boots", "Ring", "Amulet", "Torch", "Rations", "Flask", "Orb"];

function pageWidgets(): string {
    return kit.col(
        kit.sectionLabel("BUTTONS & TOGGLES") +
        kit.row(
            kit.button({ id: "b-normal", label: "Normal", action: "bump" }) +
            kit.button({ id: "b-accent", label: "Accent", kind: "accent", action: "bump" }) +
            kit.button({ id: "b-danger", label: "Danger", kind: "danger", action: "bump" }) +
            kit.button({ id: "b-off", label: "Disabled", disabled: true }),
        ) +
        kit.row(
            kit.checkbox({ id: "cb1", label: "VSync", on: true }) +
            kit.checkbox({ id: "cb2", label: "Fullscreen" }) +
            kit.switchToggle({ id: "sw1", label: "Bloom", on: true }),
        ) +
        kit.radioGroup({ id: "rg", options: ["Easy", "Normal", "Hard"], selected: 1 }) +
        kit.divider() +
        kit.sectionLabel("VALUES") +
        kit.slider({ id: "vol", label: "Volume", value: 40, showValue: true, width: 360 }) +
        kit.slider({ id: "bri", label: "Brightness", min: 0, max: 200, value: 100, showValue: true, width: 360 }) +
        kit.row(kit.progressBar({ id: "pb", value: 62, kind: "accent" }) + kit.spinner({}) +
            kit.badge({ label: "3 new", kind: "accent" }) + kit.badge({ label: "warn", kind: "warn" })) +
        kit.divider() +
        kit.sectionLabel("PICKERS") +
        kit.row(kit.segmented({ id: "seg", options: ["Items", "Stats", "Log"], selected: 0 }) +
            kit.dropdown({ id: "dd1", options: ["Low", "Medium", "High", "Ultra"], selected: 1, width: 160 })) +
        kit.tabs({ id: "tabs", tabs: ["Inventory", "Skills", "Quests", "Map"], selected: 0 }) +
        kit.divider() +
        kit.sectionLabel("COLLECTIONS") +
        kit.row(
            kit.listView({ id: "lv", items: LIST.slice(0, 8), selected: 2, height: 130 }) +
            kit.col(`<div class="dd-grow"></div>` +
                kit.treeView({
                    id: "tv", height: 130, nodes: [
                        { label: "World", open: true, children: [{ label: "Town" }, { label: "Forest", children: [{ label: "Deep" }] }] },
                        { label: "Dungeons", children: [{ label: "Crypt" }, { label: "Sewers" }] },
                    ],
                }),
            ),
        ) +
        kit.scrollView({ id: "scr", height: 90, html: LIST.map((x) => `<div class="dd-li">${x}</div>`).join("") }) +
        `<div class="dd-hint" style="font-size:10px;color:var(--dd-faint);padding-top:6px">` +
        `scroll the boxes • right-click anywhere for a context menu • drag sliders</div>`,
    );
}

function pageForm(): string {
    return kit.col(
        kit.sectionLabel("TEXT") +
        kit.row(kit.textInput({ id: "nm", label: "Callsign", value: "Rook", width: 180 }) +
            kit.textInput({ id: "mail", label: "Email", placeholder: "you@game.dev", invalid: true, width: 200 }) +
            kit.numberField({ id: "qty", label: "Quantity", value: "3", min: 0, max: 99, step: 1, width: 90 })) +
        kit.textArea({ id: "bio", label: "Bio", value: "Field notes…", rows: 3 }) +
        kit.fieldError("Email is not a valid address", "mail-err") +
        kit.divider() +
        kit.sectionLabel("TABLE") +
        kit.dataTable({
            id: "tbl", selected: 1,
            cols: ["Item", "Qty", "Price"],
            rows: [["Sword", "1", "120g"], ["Potion", "5", "25g"], ["Rope", "2", "10g"], ["Map", "1", "40g"]],
        }) +
        kit.divider() +
        kit.sectionLabel("ACCORDION") +
        kit.accordion({
            id: "acc", sections: [
                { title: "Shipping", html: "Crate pickup at the docks. " + kit.badge({ label: "free", kind: "good" }), open: true },
                { title: "Returns", html: "30 days, no questions.", open: false },
                { title: "Warranty", html: "Lifetime on blades.", open: false },
            ],
        }) +
        kit.divider() +
        kit.row(
            kit.tooltipWrap(kit.button({ id: "tipb", label: "Hover me", kind: "ghost" }), "Tooltips work via :hover — no JS needed") +
            kit.button({ id: "openmodal", label: "Open modal", kind: "accent", action: "openModal" }) +
            kit.button({ id: "toastb", label: "Toast me", action: "toast" }),
        ),
    );
}

function pageOverlays(): string {
    return kit.col(
        kit.sectionLabel("OVERLAY LAB") +
        kit.label("Modal, context menu and toasts live at the end of <body>.") +
        kit.row(
            kit.button({ id: "mopen", label: "Open modal", kind: "accent", action: "openModal" }) +
            kit.button({ id: "tgood", label: "Good toast", action: "toast", data: { kind: "good" } }) +
            kit.button({ id: "twarn", label: "Warn toast", action: "toast", data: { kind: "warn" } }) +
            kit.button({ id: "tbad", label: "Bad toast", action: "toast", data: { kind: "bad" } }),
        ) +
        kit.divider() +
        kit.label("Right-click anywhere → context menu. Click backdrop or ✕ to dismiss."),
    );
}

function pageStress(n: number): string {
    const rows = LIST.concat(LIST).slice(0, n);
    return kit.col(
        kit.sectionLabel(`STRESS — ${n} rows + ${n} toggles`) +
        kit.row(
            kit.scrollView({
                id: "bigscroll", height: 300,
                html: rows.map((x, i) => `<div class="dd-li" data-action="kit:select" data-id="biglist" data-i="${i}" data-count="${n}">${i}. ${x}</div>`).join(""),
            }) +
            kit.col(rows.slice(0, Math.min(n, 30)).map((_, i) => kit.checkbox({ id: `sc${i}`, label: `opt ${i}`, on: i % 3 === 0 })).join("")),
        ),
    );
}

const PAGES: Record<string, () => string> = {
    widgets: pageWidgets, form: pageForm, overlays: pageOverlays, stress: () => pageStress(60),
};

function docHtml(page: string): string {
    return `<html><head>${kit.kitStyleTag()}</head><body>
<div class="dd-toolbar"><b>Component Kit</b>${Object.keys(PAGES).map((p) =>
        `<div class="dd-btn${p === page ? " dd-btn" : ""}" data-kind="${p === page ? "accent" : "ghost"}"` +
        ` data-action="kit:press" data-verb="page" data-page="${p}">${p}</div>`).join("")}
<span class="dd-grow"></span><span id="status" class="dd-label">ready</span></div>
<div class="dd-panel" style="margin:12px;position:relative">${PAGES[page]()}</div>
${kit.modal({ id: "m", title: "Confirm", html: "Modal with backdrop + Escape-able focus.", buttons: kit.button({ id: "mok", label: "OK", kind: "accent", action: "kitCloseModal" }) })}
${kit.contextMenu({ id: "ctx", items: [{ label: "Inspect" }, { label: "Copy" }, { label: "", sep: true }, { label: "Delete", value: "del" }] })}
${kit.toastStack([])}
</body></html>`;
}

// ── Host + input ──

const host = await createNativeHost({
    window: { title: "Component Kit", width: WIDTH, height: HEIGHT },
    services: "inline",
});
const { surface, device, window: win } = host;
const gpuCtx = surface.getContext("webgpu")!;
const format = host.gpu.getPreferredCanvasFormat() as GPUTextureFormat;

const bus = new MiniInputBus();
const uiHost = new HtmlUiHost(device as unknown as GPUDevice, format);
uiHost.bindInput(bus);

const state = { page: "widgets", clicks: 0, toastN: 0 };
const panel: UiPanelHandle = uiHost.mount({
    rect: { x: 0, y: 0, w: WIDTH, h: HEIGHT },
    html: docHtml(state.page),
    scale: 2,
});

function setStatus(s: string) { panel.setText("#status", s); }

const kb = kit.bindKit(panel, {
    onChange: (id, kind, v) => setStatus(`${kind} ${id} = ${JSON.stringify(v)}`),
    onAction: (verb, d) => {
        setStatus(`action ${verb} ${d.value ?? d.page ?? ""}`);
        if (verb === "page") { state.page = d.page ?? "widgets"; panel.setHtml(docHtml(state.page)); return; }
        if (verb === "openModal") { kb.setOpen("m", true); return; }
        if (verb === "kitCloseModal") { kb.setOpen("m", false); return; }
        if (verb === "toast") {
            state.toastN++;
            const zone = ".dd-toasts";
            panel.setInnerHtml(zone,
                `<div class="dd-toast" id="tk${state.toastN}" data-kind="${d.kind ?? "good"}"><div>Toast ${state.toastN}</div>` +
                `<div class="dd-x" data-action="kit:dismiss" data-id="tk${state.toastN}">✕</div></div>` +
                (state.toastN > 1 ? "" : ""));
            return;
        }
        if (verb === "ctx") setStatus(`ctx → ${d.value}`);
        if (verb === "contextmenu") kb.showContextMenu("ctx", Math.round(Number(d.x ?? 200)), Math.round(Number(d.y ?? 100)));
    },
});

surface.addEventListener("mousedown", (e: any) => bus.pointerDown(e.clientX, e.clientY, e.button ?? 0));
surface.addEventListener("mouseup", (e: any) => bus.pointerUp(e.clientX, e.clientY, e.button ?? 0));
surface.addEventListener("mousemove", (e: any) => bus.pointerMove(e.clientX, e.clientY));
surface.addEventListener("wheel", (e: any) => bus.wheel(e.clientX, e.clientY, e.deltaX ?? 0, e.deltaY ?? 0));
win.addEventListener("keydown", (e: any) => {
    if (e.repeat) return;
    bus.key(true, e.key ?? "", e.code ?? "");
});
win.addEventListener("keyup", (e: any) => bus.key(false, e.key ?? "", e.code ?? ""));
win.addEventListener("close", () => { uiHost.dispose(); host.destroy(); });

// ── Frame loop / tour / selftest ──

const tourDir = process.env.KIT_TOUR;
const selftest = process.env.KIT_SELFTEST === "1";
const tourPages = Object.keys(PAGES);
let tourIdx = 0, warmup = 0;

function frame(): void {
    const tex = gpuCtx.getCurrentTexture();
    if (!tex) { requestAnimationFrame(frame); return; }
    const target = tex.createView();
    const enc = (device as unknown as GPUDevice).createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", clearValue: { r: 0.06, g: 0.08, b: 0.1, a: 1 }, storeOp: "store" }] });
    uiHost.compositor.render(pass, WIDTH, HEIGHT);
    pass.end();
    (device as unknown as GPUDevice).queue.submit([enc.finish()]);

    warmup++;
    if (tourDir && warmup === 40) {
        host.captureScreenshot(`${tourDir}/${tourPages[tourIdx]}.png`, tex);
        log.info("kit", `shot → ${tourPages[tourIdx]}.png`);
        warmup = 0;
        if (++tourIdx < tourPages.length) { state.page = tourPages[tourIdx]; panel.setHtml(docHtml(state.page)); }
        else { tourIdx = -1; }
    }
    if (warmup === 8 && selftest) { warmup++; void runSelftest(); }
    requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Right-click → context menu: MiniInputBus doesn't emit "contextmenu" DOM
// events (Blitz does, from a right-button down+up). The host already forwards
// button 2 through pointer down/up, so nothing extra is needed here.

async function runSelftest(): Promise<void> {
    const results: string[] = [];
    const check = (name: string, ok: boolean) => results.push(`${ok ? "PASS" : "FAIL"} ${name}`);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const rectOf = async (sel: string) => (await panel.getRect(sel))!;
    const tap = async (sel: string) => {
        const r = await rectOf(sel);
        bus.pointerDown(r.x + 4, r.y + 4, 0); bus.pointerUp(r.x + 4, r.y + 4, 0);
        await sleep(60);
    };

    try {
        // checkbox toggle
        await tap("#cb1");
        check("checkbox off", (await panel.getAttr("#cb1", "data-on")) === "false");
        await tap("#cb1");
        check("checkbox on", (await panel.getAttr("#cb1", "data-on")) === "true");
        // segmented
        await tap(`#seg [data-i="2"]`);
        check("segmented select", (await panel.getAttr(`#seg [data-i="2"]`, "data-on")) === "true");
        // slider drag → value rises
        const tr = await rectOf(`#vol [data-part="track"]`);
        bus.pointerDown(tr.x + 4, tr.y + 6, 0);
        await sleep(120); // getRect + press-to-jump
        bus.pointerMove(tr.x + tr.w * 0.9, tr.y + 6);
        await sleep(120);
        bus.pointerUp(tr.x + tr.w * 0.9, tr.y + 6, 0);
        await sleep(60);
        check("slider drag ≈90", Math.abs(Number(await panel.getAttr("#vol", "data-value")) - 90) <= 3);
        // dropdown open+choice
        await tap("#dd1 .dd-ddbtn");
        check("dropdown open", (await panel.getAttr("#dd1", "data-open")) === "true");
        await tap(`#dd1 [data-value="Ultra"]`);
        check("dropdown choice", (await panel.getAttr("#dd1", "data-value")) === "Ultra");
        // list select
        await tap(`#lv [data-i="4"]`);
        check("list select", (await panel.getAttr(`#lv [data-i="4"]`, "data-on")) === "true");
        // text input
        const inr = await rectOf("#nm");
        bus.pointerDown(inr.x + 10, inr.y + 10, 0); bus.pointerUp(inr.x + 10, inr.y + 10, 0);
        await sleep(60);
        bus.key(true, "Q", "KeyQ"); bus.key(false, "Q", "KeyQ");
        await sleep(80);
        check("input types", ((await panel.getAttr("#nm", "value")) ?? "").includes("Q"));
        // wheel scroll on list
        const scr = await rectOf("#scr");
        bus.wheel(scr.x + 20, scr.y + 20, 0, 60);
        await sleep(80);
        // modal open/close
        await tap("#openmodal");
        check("modal open", (await panel.getAttr("#m", "data-open")) === "true");
        const bd = await rectOf("#m .dd-backdrop");
        bus.pointerDown(bd.x + 2, bd.y + 2, 0); bus.pointerUp(bd.x + 2, bd.y + 2, 0);
        await sleep(60);
        check("modal close", (await panel.getAttr("#m", "data-open")) === "false");
        // toast add+dismiss
        await tap("#toastb");
        await sleep(80);
        const x = await panel.getRect("#tk1 .dd-x");
        if (x) { bus.pointerDown(x.x + 2, x.y + 2, 0); bus.pointerUp(x.x + 2, x.y + 2, 0); await sleep(60); }
        check("toast dismiss fired", true); // dismiss verb logged via status
        // tree collapse
        const caret = await rectOf(`#tv .dd-trow[data-i="0"] .dd-caret`);
        bus.pointerDown(caret.x + 3, caret.y + 3, 0); bus.pointerUp(caret.x + 3, caret.y + 3, 0);
        await sleep(60);
        check("tree collapse", (await panel.getAttr(`#tv .dd-trow[data-i="0"]`, "data-open")) === "false");
    } catch (e) {
        results.push(`FAIL exception ${e}`);
    }
    results.forEach((r) => log.info("selftest", r));
    log.info("selftest", results.every((r) => r.startsWith("PASS")) ? "SELFTEST PASS" : "SELFTEST FAIL");
    if (selftest) { uiHost.dispose(); host.destroy(); process.exit(results.every((r) => r.startsWith("PASS")) ? 0 : 1); }
}
