// ============================================================================
// kit.spec.ts — exercises bindKit() against the real Blitz doc core (same
// backend the ui worker runs). A docPanel() adapter implements UiPanelHandle
// over createDocCore so the full loop is covered: DOM event → verb routing →
// mutation ops → real DOM state, queryable via getAttr/getRect.
// ============================================================================

import { loadOsrLib, type OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type {
    DocInputMsg, DocMutation, UiPanelHandle, UiToWorker, WorkerToUi,
} from "@downdraft/engine/modules/html-ui";
import { createDocCore } from "@downdraft/engine/modules/html-ui";
import { describe, expect, test } from "bun:test";
import { bindKit, type KitDelegate } from "./behaviors";
import { button, checkbox, dropdown, esc, modal, segmented, slider, toastStack, treeView } from "./components";
import { acceleratorText, matchAccelerator, menuAccelerators, menuBar, parseAccelerator } from "./menus";
import { kitStyleTag } from "./theme";

const hasLib = loadOsrLib() !== null;

interface DocPanel {
    handle: UiPanelHandle;
    msgs: WorkerToUi[];
    input(msg: DocInputMsg): void;
    click(x: number, y: number): void;
    dragPath(pts: Array<[number, number]>): Promise<void>;
    dispose(): void;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function docPanel(html: string, w = 400, h = 300): DocPanel {
    const msgs: WorkerToUi[] = [];
    const handlers = new Set<(ev: OsrDomEvent) => void>();
    const reqs = new Map<number, (v: unknown) => void>();
    let reqId = 0;
    const core = createDocCore((m: WorkerToUi) => {
        msgs.push(m);
        if (m.type === "events") m.events.forEach((e) => { [...handlers].forEach((fn) => { fn(e);; }); });
        if (m.type === "attr") { const f = reqs.get(m.reqId); reqs.delete(m.reqId); f?.(m.value); }
        if (m.type === "rect") { const f = reqs.get(m.reqId); reqs.delete(m.reqId); f?.(m.rect); }
        if (m.type === "nodes") { const f = reqs.get(m.reqId); reqs.delete(m.reqId); f?.(m.nodes); }
        if (m.type === "rects") { const f = reqs.get(m.reqId); reqs.delete(m.reqId); f?.(m.rects); }
        if (m.type === "focused") { const f = reqs.get(m.reqId); reqs.delete(m.reqId); f?.(m.node); }
        if (m.type === "navNodes") { const f = reqs.get(m.reqId); reqs.delete(m.reqId); f?.(m.nodes); }
    });
    core.handle({ type: "create", id: "p", cssW: w, cssH: h, scale: 1, html });
    const send = (msg: UiToWorker) => core.handle(msg);
    const mutate = (ops: DocMutation[]) => send({ type: "mutate", id: "p", ops });
    const tgt = (t: number | string) => typeof t === "number" ? { node: t } : { sel: t };
    const handle: UiPanelHandle = {
        id: "p",
        rect: { x: 0, y: 0, w, h },
        setInteractive: () => {},
        setDocHeight: () => {},
        setDocWidth: () => {},
        setSrcRect: () => {},
        setHtml: (html2) => send({ type: "setHtml", id: "p", html: html2 }),
        setText: (t, text) => mutate([{ op: "text", ...tgt(t), text }]),
        setAttr: (t, name, value) => mutate([{ op: "attr", ...tgt(t), name, value }]),
        removeAttr: (t, name) => mutate([{ op: "rattr", ...tgt(t), name }]),
        setStyle: (t, prop, value) => mutate([{ op: "style", ...tgt(t), prop, value }]),
        setInnerHtml: (t, h2) => mutate([{ op: "innerHtml", ...tgt(t), html: h2 }]),
        appendHtml: (t, h2) => mutate([{ op: "appendHtml", ...tgt(t), html: h2 }]),
        trimChildren: (t, keep) => mutate([{ op: "trimChildren", ...tgt(t), keep }]),
        mutate,
        focus: (t) => mutate([{ op: "focus", ...(t === undefined ? {} : tgt(t)) }]),
        setMaxFps: (maxFps) => send({ type: "fps", id: "p", maxFps }),
        setRect: () => {},
        setZ: () => {},
        onEvent: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
        getAttr: (t, name) => new Promise((r) => {
            const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
            send({ type: "getAttr", reqId: q, id: "p", name, ...tgt(t) });
        }),
        getRect: (t) => new Promise((r) => {
            const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
            send({ type: "getRect", reqId: q, id: "p", ...tgt(t) });
        }),
        queryAll: (sel) => new Promise((r) => {
            const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
            send({ type: "queryAll", reqId: q, id: "p", sel });
        }),
        getRects: (nodes) => new Promise((r) => {
            const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
            send({ type: "getRects", reqId: q, id: "p", nodes });
        }),
        focusedNode: () => new Promise((r) => {
            const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
            send({ type: "getFocused", reqId: q, id: "p" });
        }),
        scrollIntoView: (t, opts) => mutate([{ op: "scrollIntoView", ...tgt(t), smooth: opts?.smooth, vertical: opts?.vertical, horizontal: opts?.horizontal }]),
        scrollTo: (t, x, y, smooth) => mutate([{ op: "scrollTo", ...tgt(t), x, y, smooth }]),
        navSnapshot: (sel) => new Promise((r) => {
            const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
            send({ type: "navSnapshot", reqId: q, id: "p", sel });
        }),
        click: (t) => mutate([{ op: "click", ...tgt(t) }]),
        sendKey: (down, key, opts) => send({ type: "input", id: "p", msg: { kind: "key", down, key, code: opts?.code, text: opts?.text, mods: opts?.mods } }),
        sendPointer: (msg) => send({ type: "input", id: "p", msg }),
        dispose: () => core.dispose(),
    };
    const input = (msg: DocInputMsg) => send({ type: "input", id: "p", msg });
    return {
        handle, msgs, input,
        click: (x, y) => { input({ kind: "down", x, y }); input({ kind: "up", x, y }); },
        async dragPath(pts) {
            input({ kind: "down", x: pts[0][0], y: pts[0][1] });
            await tick(); // let kit:drag's getRect resolve
            for (let i = 1; i < pts.length; i++) input({ kind: "move", x: pts[i][0], y: pts[i][1] });
            input({ kind: "up", x: pts[pts.length - 1][0], y: pts[pts.length - 1][1] });
            await tick();
        },
        dispose: () => core.dispose(),
    };
}

const page = (body: string) => `<html><head>${kitStyleTag()}</head><body>${body}</body></html>`;

describe.skipIf(!hasLib)("html-ui-kit behaviors", () => {
    test("kit:toggle flips data-on on the widget root", async () => {
        const p = docPanel(page(checkbox({ id: "cb", label: "Check me" })));
        const seen: unknown[] = [];
        bindKit(p.handle, { onChange: (id, kind, v) => seen.push([id, kind, v]) });
        const r = await p.handle.getRect("#cb");
        expect(r).toBeTruthy();
        p.click(r!.x + 8, r!.y + 8);
        expect(await p.handle.getAttr("#cb", "data-on")).toBe("true");
        expect(seen).toEqual([["cb", "toggle", true]]);
        p.click(r!.x + 8, r!.y + 8);
        expect(await p.handle.getAttr("#cb", "data-on")).toBe("false");
        p.dispose();
    });

    test("kit:select marks clicked option, clears siblings", async () => {
        const p = docPanel(page(segmented({ id: "seg", options: ["A", "B", "C"], selected: 0 })));
        bindKit(p.handle);
        const r = await p.handle.getRect(`#seg [data-i="2"]`);
        p.click(r!.x + 4, r!.y + 4);
        expect(await p.handle.getAttr(`#seg [data-i="2"]`, "data-on")).toBe("true");
        expect(await p.handle.getAttr(`#seg [data-i="0"]`, "data-on")).toBe("false");
        p.dispose();
    });

    test("kit:drag self-measures the track and drags the thumb", async () => {
        const p = docPanel(page(slider({ id: "vol", value: 0, showValue: true, width: 200 })));
        const seen: unknown[] = [];
        bindKit(p.handle, { onChange: (id, kind, v) => { if (kind === "slider") seen.push(v); } });
        const track = await p.handle.getRect(`#vol [data-part="track"]`);
        expect(track).toBeTruthy();
        // Drag past the right edge — clamps to max (100).
        await p.dragPath([[track!.x + 2, track!.y + 6], [track!.x + track!.w + 20, track!.y + 6]]);
        expect(await p.handle.getAttr("#vol", "data-value")).toBe("100");
        expect(seen.length).toBeGreaterThan(0);
        p.dispose();
    });

    test("kit:open + kit:choice drive the dropdown", async () => {
        const p = docPanel(page(dropdown({ id: "dd", options: ["Low", "High"], placeholder: "Pick" })));
        const seen: unknown[] = [];
        bindKit(p.handle, { onChange: (id, kind, v) => seen.push([kind, v]) });
        const btn = await p.handle.getRect("#dd .dd-ddbtn");
        p.click(btn!.x + 10, btn!.y + 6);
        expect(await p.handle.getAttr("#dd", "data-open")).toBe("true");
        const item = await p.handle.getRect(`#dd [data-value="High"]`);
        p.click(item!.x + 6, item!.y + 4);
        expect(await p.handle.getAttr("#dd", "data-open")).toBe("false");
        expect(await p.handle.getAttr("#dd", "data-value")).toBe("High");
        expect(seen).toContainEqual(["choice", "High"]);
        p.dispose();
    });

    test("typing in a kit input surfaces input events with values", async () => {
        const p = docPanel(page(`<input class="dd-input" id="nm" data-id="nm" value="">`));
        const seen: Array<[string, string, unknown]> = [];
        bindKit(p.handle, { onChange: (id, kind, v) => seen.push([id, kind, v]) });
        const r = await p.handle.getRect("#nm");
        p.click(r!.x + 10, r!.y + 10);
        p.input({ kind: "key", down: true, key: "k", code: "KeyK", text: "k" });
        p.input({ kind: "key", down: false, key: "k", code: "KeyK" });
        await tick();
        expect(seen.some(([id, kind, v]) => id === "nm" && kind === "input" && String(v).includes("k"))).toBe(true);
        p.dispose();
    });

    test("kit:node expands/collapses tree rows; kit:pick selects", async () => {
        const html = page(treeView({
            id: "tv", nodes: [
                { label: "Root", open: true, children: [{ label: "Child" }] },
                { label: "Leaf" },
            ],
        }));
        const p = docPanel(html, 400, 400);
        const changes: unknown[] = [];
        bindKit(p.handle, { onChange: (id, kind, v) => changes.push([kind, v]) });
        // Collapse Root via its caret.
        const caret = await p.handle.getRect(`#tv .dd-trow[data-i="0"] .dd-caret`);
        p.click(caret!.x + 4, caret!.y + 4);
        expect(await p.handle.getAttr(`#tv .dd-trow[data-i="0"]`, "data-open")).toBe("false");
        // Select the leaf row (index path "1").
        const leaf = await p.handle.getRect(`#tv .dd-trow[data-i="1"]`);
        p.click(leaf!.x + 40, leaf!.y + 4);
        expect(await p.handle.getAttr(`#tv .dd-trow[data-i="1"]`, "data-on")).toBe("true");
        expect(changes).toContainEqual(["pick", "1"]);
        p.dispose();
    });

    test("kit:close on the backdrop hides a modal; kit:press fires onAction", async () => {
        const html = page(
            button({ id: "open-m", label: "Open", action: "openModal" }) +
            modal({ id: "m", title: "T", html: "Body", open: true }),
        );
        const p = docPanel(html);
        const acts: string[] = [];
        const dlg: KitDelegate = { onAction: (verb) => acts.push(verb) };
        bindKit(p.handle, dlg);
        // Backdrop click → close.
        const back = await p.handle.getRect("#m .dd-backdrop");
        p.click(back!.x + 3, back!.y + 3);
        expect(await p.handle.getAttr("#m", "data-open")).toBe("false");
        // Button with custom verb.
        const btn = await p.handle.getRect("#open-m");
        p.click(btn!.x + 8, btn!.y + 8);
        expect(acts).toContain("openModal");
        p.dispose();
    });

    test("kit:dismiss hides a toast; toast click reports dismiss", async () => {
        const p = docPanel(page(toastStack([{ id: "t1", kind: "warn", message: "Careful" }])));
        const acts: string[] = [];
        bindKit(p.handle, { onAction: (verb) => acts.push(verb) });
        const x = await p.handle.getRect("#t1 .dd-x");
        p.click(x!.x + 2, x!.y + 2);
        expect(acts).toContain("dismiss");
        p.dispose();
    });

    test("imperative setters write DOM state", async () => {
        const p = docPanel(page(checkbox({ id: "sw", on: false }) + segmented({ id: "s2", options: ["x", "y"], selected: 0 })));
        const kb = bindKit(p.handle);
        kb.setToggle("sw", true);
        kb.setSelect("s2", 1, 2);
        expect(await p.handle.getAttr("#sw", "data-on")).toBe("true");
        expect(await p.handle.getAttr(`#s2 [data-i="1"]`, "data-on")).toBe("true");
        expect(await p.handle.getAttr(`#s2 [data-i="0"]`, "data-on")).toBe("false");
        p.dispose();
    });
});

describe.skipIf(!hasLib)("html-ui-kit menus", () => {
    const menuModel = {
        items: [
            {
                type: "submenu", id: "file", label: "File",
                items: [
                    { type: "item", id: "file.open", label: "Open", accelerator: "CmdOrCtrl+O" },
                    { type: "check", id: "file.wrap", label: "Wrap", checked: false },
                    { type: "item", id: "file.dead", label: "Dead", enabled: false },
                    { type: "separator" },
                    { type: "predefined", kind: "quit" },
                ],
            },
            {
                type: "submenu", id: "edit", label: "Edit",
                items: [{ type: "item", id: "edit.copy", label: "Copy" }],
            },
        ],
    } as const;

    test("kit:menuopen toggles a menu and enforces single-open", async () => {
        const p = docPanel(page(menuBar({ model: menuModel as never })), 400, 300);
        bindKit(p.handle);
        const file = await p.handle.getRect(`#dd-menubar .dd-mbl[data-i="0"]`);
        p.click(file!.x + 10, file!.y + 4);
        expect(await p.handle.getAttr("#dd-menubar", "data-open")).toBe("true");
        expect(await p.handle.getAttr(`#dd-menubar .dd-mb[data-i="0"]`, "data-open")).toBe("true");
        // Opening Edit closes File — only one menu open at a time.
        const edit = await p.handle.getRect(`#dd-menubar .dd-mbl[data-i="1"]`);
        p.click(edit!.x + 10, edit!.y + 4);
        expect(await p.handle.getAttr(`#dd-menubar .dd-mb[data-i="0"]`, "data-open")).toBe("false");
        expect(await p.handle.getAttr(`#dd-menubar .dd-mb[data-i="1"]`, "data-open")).toBe("true");
        // Re-click closes.
        p.click(edit!.x + 10, edit!.y + 4);
        expect(await p.handle.getAttr("#dd-menubar", "data-open")).toBe("false");
        p.dispose();
    });

    test("kit:menuitem fires the item id and closes the menu", async () => {
        const p = docPanel(page(menuBar({ model: menuModel as never })), 400, 300);
        const acts: Array<Record<string, string>> = [];
        bindKit(p.handle, { onAction: (verb, d) => { if (verb === "menuitem") acts.push(d); } });
        const file = await p.handle.getRect(`#dd-menubar .dd-mbl[data-i="0"]`);
        p.click(file!.x + 10, file!.y + 4);
        const item = await p.handle.getRect(`#dd-menubar .dd-mi[data-mid="file.open"]`);
        expect(item).toBeTruthy();
        p.click(item!.x + 10, item!.y + 4);
        expect(acts).toEqual([{ id: "dd-menubar", mid: "file.open" }]);
        expect(await p.handle.getAttr("#dd-menubar", "data-open")).toBe("false");
        p.dispose();
    });

    test("disabled items swallow the click — no action, menu stays open", async () => {
        const p = docPanel(page(menuBar({ model: menuModel as never })), 400, 300);
        const acts: string[] = [];
        bindKit(p.handle, { onAction: (verb) => acts.push(verb) });
        const file = await p.handle.getRect(`#dd-menubar .dd-mbl[data-i="0"]`);
        p.click(file!.x + 10, file!.y + 4);
        const dead = await p.handle.getRect(`#dd-menubar .dd-mi[data-mid="file.dead"]`);
        p.click(dead!.x + 10, dead!.y + 4);
        expect(acts).toEqual([]);
        expect(await p.handle.getAttr(`#dd-menubar .dd-mb[data-i="0"]`, "data-open")).toBe("true");
        p.dispose();
    });

    test("check items flip the mark on pick", async () => {
        const p = docPanel(page(menuBar({ model: menuModel as never })), 400, 300);
        bindKit(p.handle);
        const file = await p.handle.getRect(`#dd-menubar .dd-mbl[data-i="0"]`);
        p.click(file!.x + 10, file!.y + 4);
        const wrap = await p.handle.getRect(`#dd-menubar .dd-mi[data-mid="file.wrap"]`);
        p.click(wrap!.x + 10, wrap!.y + 4);
        expect(await p.handle.getAttr(`#m-dd-menubar-0-1`, "data-on")).toBe("true");
        p.dispose();
    });

    test("kit:menudismiss on the backdrop closes an open menu", async () => {
        const p = docPanel(page(menuBar({ model: menuModel as never })), 400, 300);
        bindKit(p.handle);
        const file = await p.handle.getRect(`#dd-menubar .dd-mbl[data-i="0"]`);
        p.click(file!.x + 10, file!.y + 4);
        const back = await p.handle.getRect("#dd-menubar .dd-mback");
        expect(back).toBeTruthy();
        p.click(back!.x + 20, back!.y + 20);
        expect(await p.handle.getAttr("#dd-menubar", "data-open")).toBe("false");
        p.dispose();
    });
});

describe("menu accelerator helpers", () => {
    test("parseAccelerator splits modifiers and normalizes the key", () => {
        expect(parseAccelerator("CmdOrCtrl+O")).toEqual({ ctrl: true, meta: false, shift: false, alt: false, key: "o" });
        expect(parseAccelerator("Shift+Alt+F12")).toEqual({ ctrl: false, meta: false, shift: true, alt: true, key: "f12" });
        expect(parseAccelerator("Ctrl+Shift+Z")).toEqual({ ctrl: true, meta: false, shift: true, alt: false, key: "z" });
        expect(parseAccelerator("Super+Q")).toEqual({ ctrl: false, meta: true, shift: false, alt: false, key: "q" });
        expect(parseAccelerator("")).toBeNull();
        expect(parseAccelerator("Ctrl+")).toBeNull();
    });

    test("matchAccelerator accepts either primary modifier for CmdOrCtrl", () => {
        const acc = parseAccelerator("CmdOrCtrl+O")!;
        expect(matchAccelerator(acc, { ctrlKey: true, key: "o" })).toBe(true);
        expect(matchAccelerator(acc, { metaKey: true, key: "o" })).toBe(true);
        expect(matchAccelerator(acc, { key: "o" })).toBe(false);
        expect(matchAccelerator(acc, { ctrlKey: true, key: "p" })).toBe(false);
        expect(matchAccelerator(acc, { ctrlKey: true, shiftKey: true, key: "o" })).toBe(false);
    });

    test("menuAccelerators skips disabled items and walks submenus", () => {
        const accs = menuAccelerators({
            items: [
                {
                    type: "submenu", label: "File", items: [
                        { type: "item", id: "a", label: "A", accelerator: "Ctrl+A" },
                        { type: "item", id: "b", label: "B", accelerator: "Ctrl+B", enabled: false },
                        { type: "check", id: "c", label: "C", accelerator: "Ctrl+C" },
                    ],
                },
            ],
        });
        expect(accs.map((a) => a.id).sort()).toEqual(["a", "c"]);
    });

    test("acceleratorText renders the display form", () => {
        expect(acceleratorText("CmdOrCtrl+O")).toBe("Ctrl+O");
        expect(acceleratorText("Ctrl+Shift+z")).toBe("Ctrl+Shift+Z");
    });
});

describe("html-ui-kit markup", () => {
    test("esc() covers the five HTML-unsafe characters", () => {
        expect(esc(`<a href="x">'&`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
    });
    test("components stamp data-kit + action conventions", () => {
        expect(checkbox({ id: "c1", on: true })).toContain(`data-action="kit:toggle"`);
        expect(slider({ id: "s", value: 30 })).toContain(`data-action="kit:drag"`);
        expect(dropdown({ id: "d", options: ["a"] })).toContain(`data-open`);
    });
});
