// ============================================================================
// vcursor.spec.ts — VirtualCursor routing against real Blitz docs. Verifies
// that a synthetic click at the cursor position lands on the interactive
// panel beneath it (and that the cursor overlay itself never eats input).
// ============================================================================

import { loadOsrLib, type OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type {
    DocInputMsg,
    DocMutation,
    HtmlUiHost,
    PanelSpec,
    UiPanelHandle,
    UiToWorker,
    WorkerToUi,
} from "@downdraft/engine/modules/html-ui";
import { createDocCore } from "@downdraft/engine/modules/html-ui";
import { describe, expect, test } from "bun:test";
import { VirtualCursor } from "./vcursor";

const hasLib = loadOsrLib() !== null;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };

function navPanel(html: string, w = 400, h = 300): { handle: UiPanelHandle; events: OsrDomEvent[] } {
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
        setHtml: (h2) => send({ type: "setHtml", id: "p", html: h2 }),
        setText: (t, text) => mutate([{ op: "text", ...tgt(t), text }]),
        setAttr: (t, name, value) => mutate([{ op: "attr", ...tgt(t), name, value }]),
        removeAttr: (t, name) => mutate([{ op: "rattr", ...tgt(t), name }]),
        setStyle: (t, prop, value) => mutate([{ op: "style", ...tgt(t), prop, value }]),
        setInnerHtml: (t, h2) => mutate([{ op: "innerHtml", ...tgt(t), html: h2 }]),
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
        navSnapshot: (sel) => req({ type: "navSnapshot", id: "p", sel }),
        click: (t) => mutate([{ op: "click", ...tgt(t) }]),
        sendKey: (down, key, opts) => send({ type: "input", id: "p", msg: { kind: "key", down, key, code: opts?.code, text: opts?.text, mods: opts?.mods } }),
        sendPointer: (msg) => send({ type: "input", id: "p", msg }),
        dispose: () => core.dispose(),
    };
    return { handle, events };
}

describe.skipIf(!hasLib)("virtual cursor", () => {
    test("click at cursor position activates the panel's data-action", async () => {
        const panels = new Map<string, ReturnType<typeof navPanel>>();
        const host = {
            // mount() honors the rect so panelAtHandle hit-tests correctly.
            mount: (spec: PanelSpec) => {
                const p = navPanel(spec.html ?? "", spec.rect.w, spec.rect.h);
                panels.set(spec.id ?? `p${panels.size}`, p);
                // Patch rect onto the handle so the fake host tracks layout.
                Object.defineProperty(p.handle, "rect", { get: () => ({ ...spec.rect }) });
                return p.handle;
            },
            panelAtHandle: (x: number, y: number) => {
                const hits = [...panels.entries()]
                    .filter(([id, p]) => {
                        if (id === "dd-vcursor") return false; // interactive:false
                        const r = p.handle.rect;
                        return x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;
                    });
                return hits.length ? hits[hits.length - 1][1].handle : null;
            },
        } as unknown as HtmlUiHost;

        const btn = `<div class="dd-btn" id="go" data-action="act:go" style="position:absolute;left:50px;top:50px;width:80px;height:30px;">Go</div>`;
        host.mount({ id: "ui", rect: { x: 0, y: 0, w: 400, h: 300 }, html: `<html><body>${btn}</body></html>` });
        const vc = new VirtualCursor(host, { screenW: 400, screenH: 300 });
        await ticks(2);

        vc.warp(90, 65); // over the button
        vc.click();
        await ticks(4);

        const clicks = panels.get("ui")!.events.filter((e) => e.t === "click");
        expect(clicks.length).toBeGreaterThan(0);
        vc.dispose();
    });
});
