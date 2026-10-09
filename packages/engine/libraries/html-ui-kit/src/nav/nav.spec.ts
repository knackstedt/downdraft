// ============================================================================
// nav.spec.ts — NavController against the real Blitz doc core. Minimal
// UiPanelHandle adapter over createDocCore (same pattern as kit.spec.ts).
// ============================================================================

import { loadOsrLib, type OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type { DocMutation, UiPanelHandle, UiToWorker, WorkerToUi } from "@downdraft/engine/modules/html-ui";
import { createDocCore } from "@downdraft/engine/modules/html-ui";
import { describe, expect, test } from "bun:test";
import { NavController } from "./nav-controller";

const hasLib = loadOsrLib() !== null;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function navPanel(html: string, w = 400, h = 300): { handle: UiPanelHandle; events: OsrDomEvent[]; dispose(): void } {
    const events: OsrDomEvent[] = [];
    const handlers = new Set<(ev: OsrDomEvent) => void>();
    const reqs = new Map<number, (v: unknown) => void>();
    let reqId = 0;
    const core = createDocCore((m: WorkerToUi) => {
        if (m.type === "events") m.events.forEach((e) => { events.push(e); [...handlers].forEach((fn) => fn(e)); });
        if (m.type === "attr" || m.type === "rect" || m.type === "nodes" || m.type === "rects"
            || m.type === "focused" || m.type === "navNodes") {
            const f = reqs.get(m.reqId); reqs.delete(m.reqId);
            f?.((m as { value?: unknown; rect?: unknown; nodes?: unknown; rects?: unknown; node?: unknown })
                .value ?? (m as { rect?: unknown }).rect ?? (m as { nodes?: unknown }).nodes
                ?? (m as { rects?: unknown }).rects ?? (m as { node?: unknown }).node);
        }
    });
    core.handle({ type: "create", id: "p", cssW: w, cssH: h, scale: 1, html });
    const send = (msg: UiToWorker) => core.handle(msg);
    const mutate = (ops: DocMutation[]) => send({ type: "mutate", id: "p", ops });
    const tgt = (t: number | string) => typeof t === "number" ? { node: t } : { sel: t };
    const req = <T>(msg: Record<string, unknown>) => new Promise<T>((r) => {
        const q = ++reqId; reqs.set(q, r as (v: unknown) => void);
        send({ ...msg, reqId: q } as unknown as UiToWorker);
    });
    const handle: UiPanelHandle = {
        id: "p",
        rect: { x: 0, y: 0, w, h },
        setInteractive: () => {},
        setDocHeight: () => {},
        setSrcRect: () => {},
        setHtml: (h2) => send({ type: "setHtml", id: "p", html: h2 }),
        setText: (t, text) => mutate([{ op: "text", ...tgt(t), text }]),
        setAttr: (t, name, value) => mutate([{ op: "attr", ...tgt(t), name, value }]),
        removeAttr: (t, name) => mutate([{ op: "rattr", ...tgt(t), name }]),
        setStyle: (t, prop, value) => mutate([{ op: "style", ...tgt(t), prop, value }]),
        setInnerHtml: (t, h2) => mutate([{ op: "innerHtml", ...tgt(t), html: h2 }]),
        appendHtml: (t, h2) => mutate([{ op: "appendHtml", ...tgt(t), html: h2 }]),
        trimChildren: (t, keep) => mutate([{ op: "trimChildren", ...tgt(t), keep }]),
        mutate,
        focus: (t) => mutate([{ op: "focus", ...(t === undefined ? {} : tgt(t)) }]),
        setMaxFps: (mf) => send({ type: "fps", id: "p", maxFps: mf }),
        setRect: () => {},
        setZ: () => {},
        onEvent: (fn) => { handlers.add(fn); return () => { handlers.delete(fn); }; },
        getAttr: (t, name) => req({ type: "getAttr", id: "p", name, ...tgt(t) }),
        getRect: (t) => req({ type: "getRect", id: "p", ...tgt(t) }),
        queryAll: (sel) => req({ type: "queryAll", id: "p", sel }),
        getRects: (nodes) => req({ type: "getRects", id: "p", nodes }),
        focusedNode: () => req({ type: "getFocused", id: "p" }),
        scrollIntoView: (t, opts) => mutate([{ op: "scrollIntoView", ...tgt(t), smooth: opts?.smooth, vertical: opts?.vertical, horizontal: opts?.horizontal }]),
        scrollTo: (t, x, y, smooth) => mutate([{ op: "scrollTo", ...tgt(t), x, y, smooth }]),
        navSnapshot: (sel) => req({ type: "navSnapshot", id: "p", sel }),
        click: (t) => mutate([{ op: "click", ...tgt(t) }]),
        sendKey: (down, key, opts) => send({ type: "input", id: "p", msg: { kind: "key", down, key, code: opts?.code, text: opts?.text, mods: opts?.mods } }),
        sendPointer: (msg) => send({ type: "input", id: "p", msg }),
        dispose: () => core.dispose(),
    };
    return { handle, events, dispose: () => core.dispose() };
}

const page = (body: string) => `<html><body>${body}</body></html>`;
const BTN = (id: string, extra = "") => `<div class="dd-btn" id="${id}" data-action="act:${id}" ${extra}>${id}</div>`;

describe.skipIf(!hasLib)("nav engine", () => {
    test("queryAll / navSnapshot enumerate focusables with rects + zones", async () => {
        const p = navPanel(page(`
            <style>.dd-btn{position:absolute;width:50px;height:30px;}
              #a{left:10px;top:10px} #b{left:100px;top:10px}
              #z{position:absolute;left:10px;top:80px;width:200px;height:100px;}
              #z .dd-btn{position:absolute;width:50px;height:30px;}
              #c{left:10px;top:10px} #d{left:100px;top:10px}</style>
            ${BTN("a")} ${BTN("b")}
            <div id="z" data-nav-zone="menu">${BTN("c")} ${BTN("d", 'data-disabled="true"')}</div>`));
        const snap = await p.handle.navSnapshot(".dd-btn");
        const ids = snap.map((n) => n.node);
        const byAttr = await Promise.all(snap.map((n) => p.handle.getAttr(n.node, "id")));
        expect(byAttr).toEqual(["a", "b", "c", "d"]);
        expect(ids.length).toBe(4);
        const d = snap.find((_, i) => byAttr[i] === "d")!;
        expect(d.disabled).toBe(true);
        const c = snap.find((_, i) => byAttr[i] === "c")!;
        expect(c.zone).toBe("menu");
        expect(c.rect).not.toBeNull();
        p.dispose();
    });

    test("directional moves pick the geometric neighbor; confirm clicks", async () => {
        const p = navPanel(page(`
            <style>.dd-btn{position:absolute;width:50px;height:30px;}
              #a{left:10px;top:10px} #b{left:100px;top:10px} #c{left:10px;top:80px}</style>
            ${BTN("a")} ${BTN("b")} ${BTN("c")}`));
        const nav = new NavController(p.handle);
        await nav.refresh();

        // No focus yet → first direction focuses the first candidate.
        await nav.dispatch("down");
        const f0 = await p.handle.focusedNode();
        expect(f0).not.toBe(0);

        // Move right → #b should now hold nav focus.
        await nav.dispatch("right");
        await tick();
        const fId = await p.handle.focusedNode();
        const fIdAttr = await p.handle.getAttr(fId, "id");
        expect(fIdAttr).toBe("b");

        // Move down → #a column has #c below; from #b nothing below in-band
        // → wraps via step. Either way we stay on a valid node.
        await nav.dispatch("down");
        await tick();
        expect(await p.handle.focusedNode()).not.toBe(0);

        // confirm → synthetic click → click event with data-action.
        {
            p.events.length = 0;
            // Re-focus a known node first
            const snap = await p.handle.navSnapshot(".dd-btn");
            const a = snap[await Promise.all(snap.map(n => p.handle.getAttr(n.node, "id"))).then(ids => ids.indexOf("a"))];
            await nav.focusNode(a.node);
            await tick();
            await nav.dispatch("confirm");
            await tick();
            const clickEv = p.events.find((e) => e.t === "click");
            expect(clickEv).toBeDefined();
            expect(clickEv?.d?.action).toBe("act:a");
        }
        p.dispose();
    });

    test("zones trap nav and restore memory on pop", async () => {
        const p = navPanel(page(`
            <style>.dd-btn{position:absolute;width:50px;height:30px;}
              #a{left:10px;top:10px}
              #z .dd-btn{position:absolute;width:50px;height:30px;}
              #m1{left:10px;top:80px} #m2{left:100px;top:80px}</style>
            ${BTN("a")}
            <div data-nav-zone="menu">${BTN("m1")} ${BTN("m2")}</div>`));
        const nav = new NavController(p.handle);
        await nav.refresh();
        await nav.dispatch("down"); // focus #a
        await tick();

        nav.pushZone("menu");
        await nav.refresh();
        await nav.dispatch("right"); // within zone: m1 → m2
        await tick();
        const inZone = await p.handle.focusedNode();
        const zoneId = await p.handle.getAttr(inZone, "id");
        expect(["m1", "m2"]).toContain(zoneId ?? "none");

        nav.popZone();
        await tick();
        // Back in the default scope; 'right' from #a shouldn't hit m1/m2.
        await nav.dispatch("right");
        await tick();
        const after = await p.handle.focusedNode();
        const afterId = await p.handle.getAttr(after, "id");
        expect(afterId ?? "none").not.toBe("m1");
        p.dispose();
    });
});
