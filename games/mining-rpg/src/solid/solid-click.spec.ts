// ============================================================================
// solid-click.spec — end-to-end test of Solid's event delegation through the
// sync DOM (SyncDocument/SyncElement) + undertow host. Tests that a button
// rendered by Solid in a "worker" (simulated) fires its onClick handler when
// the real DOM button is clicked on the "main thread" (happy-dom).
// ============================================================================

import { describe, expect, it, mock } from "bun:test";
import { Window } from "happy-dom";
import { MainThreadHost } from "undertow/main/host";
import { installPolyfill } from "undertow/worker/polyfill";
import { WorkerRuntime } from "undertow/worker/runtime";

// Force solid-js to resolve to the browser (reactive) build, not the server
// build. Under Bun's Node conditions, `import "solid-js"` resolves to
// dist/server.js which has no reactivity (createSignal/createMemo are no-ops).
// Mocking the module ensures all imports — including from solid-js/web/dist/web.js
// — get the reactive browser build.
mock.module("solid-js", () => import("solid-js/dist/dev.js"));
mock.module("solid-js/store", () => import("solid-js/store/dist/store.js"));

// Set up happy-dom globals.
const happyWindow = new Window();
const happyDocument = happyWindow.document;
happyDocument.write("<!doctype html><html><head></head><body></body></html>");
(globalThis as any).Element = happyWindow.Element;
(globalThis as any).HTMLElement = happyWindow.HTMLElement;
(globalThis as any).Node = happyWindow.Node;
(globalThis as any).Document = happyWindow.Document;
(globalThis as any).Text = happyWindow.Text;
(globalThis as any).Comment = happyWindow.Comment;
(globalThis as any).DocumentFragment = happyWindow.DocumentFragment;
(globalThis as any).HTMLTemplateElement = happyWindow.HTMLTemplateElement;
(globalThis as any).MouseEvent = happyWindow.MouseEvent;
(globalThis as any).KeyboardEvent = happyWindow.KeyboardEvent;
(globalThis as any).Event = happyWindow.Event;
(globalThis as any).CustomEvent = happyWindow.CustomEvent;
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
  return setTimeout(() => cb(performance.now()), 16) as unknown as number;
};
(globalThis as any).cancelAnimationFrame = (id: number) => clearTimeout(id);

function makeHarness() {
  const host = new MainThreadHost({
    document: happyDocument as unknown as Document,
    window: happyWindow as unknown as Window,
  });
  const rt = new WorkerRuntime(host.sab);

  // Replace waitSyncForReply — the original blocks on Atomics.wait which
  // hangs in a test. We drain the host (processes the request + writes reply),
  // then pop replies directly from the reply ring.
  const REPLY_REQID_OFF = 0;
  (rt as any).waitSyncForReply = (reqId: number) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      host.drain();
      let slot = (rt as any).replyRing.tryPop();
      while (slot !== null) {
        const u32 = (rt as any).replyRing.slotU32(slot);
        const id = u32[REPLY_REQID_OFF];
        const result = (rt as any).decodeReply(u32);
        (rt as any).replyRing.release(slot);
        if (id === reqId) return result;
        const p = (rt as any).pending.get(id);
        if (p) {
          (rt as any).pending.delete(id);
          if (result.kind === 10) p.reject(new Error(result.error ?? "unknown"));
          else p.resolve(result);
        }
        slot = (rt as any).replyRing.tryPop();
      }
    }
    throw new Error(`test: no reply for reqId=${reqId}`);
  };

  // Patch callFireAndForget to drain host too.
  const origFAF = rt.callFireAndForget.bind(rt);
  (rt as any).callFireAndForget = (opId: number, handle: number, args: any[]) => {
    origFAF(opId, handle, args);
    host.drain();
    (rt as any).drainReplies();
  };

  // Install the polyfill (sets up document, window, Node, Element, etc.)
  installPolyfill(rt);

  return { host, rt };
}

describe("solid-click: event delegation through sync DOM", () => {
  it("button onClick fires when real DOM button is clicked", async () => {
    const { host, rt } = makeHarness();

    // Import the client build directly — the "worker" export condition maps
    // to server.js which throws "Client-only API called on server side".
    const solidWeb = await import("solid-js/web/dist/web.js");
    const { render, template, delegateEvents, addEventListener } = solidWeb;
    const solidMain = await import("solid-js");
    const { createComponent } = solidMain;

    let clicked = false;

    // Minimal Solid component: a button with onClick.
    function App() {
      const tmpl = template(`<button>Click me</button>`);
      return (() => {
        const el = tmpl();
        addEventListener(el, "click", () => { clicked = true; }, true);
        return el;
      })();
    }

    // Render into document.body
    const doc = (globalThis as any).document;
    render(() => createComponent(App, {}), doc.body);

    // Drain any pending fire-and-forget ops (appendChild, addEventListener).
    host.drain();
    (rt as any).drainReplies();

    // Delegate events (Solid registers a click listener on document).
    delegateEvents(["click"]);
    host.drain();
    (rt as any).drainReplies();

    // Find the real button in happy-dom.
    const realButton = happyDocument.querySelector("button");
    expect(realButton).not.toBeNull();
    expect(realButton!.textContent).toBe("Click me");

    // Simulate a click on the real button.
    realButton!.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));

    // Drain the event ring + event pump.
    host.drain();
    (rt as any).drainReplies();
    rt.eventPump.drain();

    expect(clicked).toBe(true);
  });

  it("Show + createStore: clicking delegated button toggles UI (title screen pattern)", async () => {
    // Clean up the document from previous tests.
    while (happyDocument.body.firstChild) {
      happyDocument.body.removeChild(happyDocument.body.firstChild);
    }

    const { host, rt } = makeHarness();

    const solidWeb = await import("solid-js/web/dist/web.js");
    const { render, template, delegateEvents, addEventListener } = solidWeb;
    const solidMain = await import("solid-js");
    const { createComponent, Show } = solidMain;
    const { createStore } = await import("solid-js/store");

    // Mirror the real app's pattern: a store with showTitleScreen, a Show
    // that renders a TitleScreen fallback with a delegated onClick button.
    const [store, setStore] = createStore<{ showTitleScreen: boolean }>({
      showTitleScreen: true,
    });

    let clicked = false;

    // This mirrors the compiled output of:
    //   <Show when={!store.showTitleScreen} fallback={
    //     <TitleScreen onStart={() => setStore("showTitleScreen", false)} />
    //   }>
    //     <div>Game UI</div>
    //   </Show>
    function App() {
      const titleTmpl = template(`<button>Start Mining</button>`);
      const gameTmpl = template(`<div>Game UI</div>`);
      return createComponent(Show, {
        get when() { return !store.showTitleScreen; },
        get fallback() {
          return (() => {
            const el = titleTmpl();
            addEventListener(el, "click", () => {
              clicked = true;
              setStore("showTitleScreen", false);
            }, true);
            return el;
          })();
        },
        get children() { return gameTmpl(); },
      });
    }

    const doc = (globalThis as any).document;
    render(() => createComponent(App, {}), doc.body);

    // Drain fire-and-forget ops (appendChild, addEventListener, delegateEvents).
    host.drain();
    (rt as any).drainReplies();
    delegateEvents(["click"]);
    host.drain();
    (rt as any).drainReplies();

    // Verify the title screen button is in the real DOM.
    const realButton = happyDocument.querySelector("button");
    expect(realButton).not.toBeNull();
    expect(realButton!.textContent).toBe("Start Mining");

    // Click the button.
    realButton!.dispatchEvent(new happyWindow.MouseEvent("click", { bubbles: true }));
    host.drain();
    (rt as any).drainReplies();
    rt.eventPump.drain();

    // The click handler should have fired.
    expect(clicked).toBe(true);
    // The store should have been updated.
    expect(store.showTitleScreen).toBe(false);

    // Drain any DOM mutations from the Show switching.
    host.drain();
    (rt as any).drainReplies();

    // The title screen button should be gone, and "Game UI" should be present.
    const gameDiv = happyDocument.querySelector("div");
    expect(gameDiv).not.toBeNull();
    expect(gameDiv?.textContent).toContain("Game UI");
  });

  it("template navigation: firstChild.nextSibling chain works", async () => {
    const { host, rt } = makeHarness();

    const { template } = await import("solid-js/web/dist/web.js");

    // Template with nested children — Solid navigates firstChild.nextSibling...
    const tmpl = template(`<div><span>A</span><span>B</span><button>C</button></div>`);
    const el = tmpl();

    // Navigate the clone's children (this is what Solid's compiled code does).
    expect(el.tagName).toBe("DIV");
    expect(el.firstChild).not.toBeNull();
    expect(el.firstChild!.tagName).toBe("SPAN");
    expect(el.firstChild!.nextSibling).not.toBeNull();
    expect(el.firstChild!.nextSibling!.tagName).toBe("SPAN");
    expect(el.firstChild!.nextSibling!.nextSibling).not.toBeNull();
    expect(el.firstChild!.nextSibling!.nextSibling!.tagName).toBe("BUTTON");
  });
});
