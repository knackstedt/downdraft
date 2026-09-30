// ============================================================================
// osk.spec.ts — on-screen keyboard against the real Blitz doc core. Verifies
// that nav-driven key presses deliver real key events into the *target*
// panel's focused <input> via sendKey.
// ============================================================================

import { loadOsrLib, type OsrDomEvent } from "@downdraft/engine/libraries/blitz-ui/native-osr-ffi";
import type {
    DocMutation,
    HtmlUiHost,
    PanelSpec,
    UiPanelHandle,
    UiToWorker,
    WorkerToUi
} from "@downdraft/engine/modules/html-ui";
import { createDocCore } from "@downdraft/engine/modules/html-ui";
import { describe, expect, test } from "bun:test";
import { openOsk } from "./osk";

const hasLib = loadOsrLib() !== null;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const ticks = async (n: number) => { for (let i = 0; i < n; i++) await tick(); };

function navPanel(html: string, w = 400, h = 300): { handle: UiPanelHandle; dispose(): void } {
    const handlers = new Set<(ev: OsrDomEvent) => void>();
    const reqs = new Map<number, (v: unknown) => void>();
    let reqId = 0;
    const core = createDocCore((m: WorkerToUi) => {
        if (m.type === "events") m.events.forEach((e) => [...handlers].forEach((fn) => fn(e)));
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
    return { handle, dispose: () => core.dispose() };
}

/** Minimal HtmlUiHost: mount() returns an in-process doc panel. */
function fakeHost(): HtmlUiHost {
    return {
        mount: (spec: PanelSpec) => navPanel(spec.html ?? "", spec.rect.w, spec.rect.h).handle,
    } as unknown as HtmlUiHost;
}

const page = (body: string) => `<html><body>${body}</body></html>`;

describe.skipIf(!hasLib)("on-screen keyboard", () => {
    test("nav confirm on a key types into the target input", async () => {
        const form = navPanel(page(`<input id="name" data-nav value="">`));
        form.handle.focus("#name");
        await ticks(2);

        const osk = openOsk(fakeHost(), form.handle, "#name", { screenW: 800, screenH: 600 });
        await ticks(4); // let the OSK's own nav snapshot land

        // First focusable is "1"; down→'q', down→'a' (grid rows are left-aligned).
        osk.dispatch("down");
        await ticks(3);
        osk.dispatch("down");
        await ticks(3);
        osk.dispatch("confirm");
        await ticks(5);

        const v = await form.handle.getAttr("#name", "value");
        expect(v).toBe("a");
        expect(osk.text()).toBe("a");

        // Cancel closes; dispatch reports closed afterwards.
        expect(osk.dispatch("cancel")).toBe(false);
        form.dispose();
    });

    test("backspace key edits the target input", async () => {
        const form = navPanel(page(`<input id="n2" data-nav value="">`));
        form.handle.focus("#n2");
        await ticks(2);

        const osk = openOsk(fakeHost(), form.handle, "#n2", { screenW: 800, screenH: 600 });
        await ticks(4);
        osk.dispatch("confirm"); // "1" is first-focused: types '1'
        await ticks(5);
        expect(await form.handle.getAttr("#n2", "value")).toBe("1");
        osk.dispatch("cancel");
        form.dispose();
    });
});
