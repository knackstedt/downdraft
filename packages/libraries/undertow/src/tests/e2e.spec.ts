// ============================================================================
// e2e.spec — end-to-end test of the worker DOM classes through the host +
// runtime in a single process. Exercises WorkerDocument, WorkerElement,
// WorkerNode, events, and the LayoutChannel.
//
// This simulates what a real game UI would do: create elements, append them,
// set attributes, attach event listeners, and read layout — all through the
// proxied DOM, with the real DOM mutations happening on the "main" side.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { MainThreadHost } from "../main/host";
import { allocateLayoutSab, LayoutReader, LayoutWriter } from "../sab/layout-channel";
import { WorkerDocument } from "../worker/dom/document";
import { WorkerWindow } from "../worker/dom/window";
import { WorkerRuntime } from "../worker/runtime";

// Set up happy-dom globals.
const happyWindow = new Window();
const happyDocument = happyWindow.document;
happyDocument.write("<!doctype html><html><head></head><body></body></html>");
(globalThis as any).Element = happyWindow.Element;
(globalThis as any).HTMLElement = happyWindow.HTMLElement;
(globalThis as any).Node = happyWindow.Node;

function makeHarness() {
  const host = new MainThreadHost({
    document: happyDocument as unknown as Document,
    window: happyWindow as unknown as Window,
  });
  const rt = new WorkerRuntime(host.sab);

  // In-process auto-drain: patch rt.call to drain the host + replies after
  // encoding each request, so promises resolve immediately. This simulates
  // the main thread draining on raf, but synchronously for the test.
  const origCall = rt.call.bind(rt);
  (rt as any).call = (opId: number, handle: number, args: any[], mode?: any) => {
    const p = origCall(opId, handle, args, mode);
    host.drain();
    rt.drainReplies();
    return p;
  };

  const document = new WorkerDocument(rt);
  const window = new WorkerWindow(rt);
  return { host, rt, document, window };
}

// Drain host + runtime to resolve all pending promises + events.
async function tick(host: MainThreadHost, rt: WorkerRuntime) {
  host.drain();
  rt.drainReplies();
  rt.eventPump.drain();
}

describe("e2e: worker DOM classes", () => {
  it("builds a small UI: create, append, setAttribute, textContent", async () => {
    const { host, rt, document } = makeHarness();

    // Create a div, set attributes, append to body.
    const div = await document.createElement("div");
    await div.setAttribute("class", "container");
    await div.setAttribute("data-testid", "main");
    await div.setTextContent("Hello from worker");
    await document.body.appendChild(div);

    await tick(host, rt);

    // Verify on the real DOM.
    const realDiv = happyDocument.querySelector(".container");
    expect(realDiv).not.toBeNull();
    expect(realDiv!.getAttribute("data-testid")).toBe("main");
    expect(realDiv!.textContent).toBe("Hello from worker");
    expect(realDiv!.parentElement).toBe(happyDocument.body);
  });

  it("classList add/toggle/contains", async () => {
    const { host, rt, document } = makeHarness();
    const div = await document.createElement("div");
    await div.setAttribute("id", "cls-test");
    await document.body.appendChild(div);
    await tick(host, rt);

    // classList.add is fire-and-forget; tick to drain.
    div.classList.add("active");
    await tick(host, rt);
    const realDiv = happyDocument.querySelector("#cls-test") as Element;
    expect(realDiv.classList.contains("active")).toBe(true);

    const toggled = await div.classList.toggle("active");
    await tick(host, rt);
    expect(toggled).toBe(false);
    expect(realDiv.classList.contains("active")).toBe(false);

    const hasFoo = await div.classList.contains("foo");
    expect(hasFoo).toBe(false);
  });

  it("getElementById finds an element", async () => {
    const { host, rt, document } = makeHarness();
    const div = await document.createElement("div");
    await div.setAttribute("id", "my-app");
    await document.body.appendChild(div);
    await tick(host, rt);

    const found = await document.getElementById("my-app");
    expect(found).not.toBeNull();
    const tagName = await found!.tagName;
    expect(tagName).toBe("DIV");
  });

  it("parentNode resolves correctly", async () => {
    const { host, rt, document } = makeHarness();
    const div = await document.createElement("div");
    await document.body.appendChild(div);
    await tick(host, rt);

    const parent = await div.getParentNode();
    expect(parent).not.toBeNull();
    // The parent is body (handle 5).
    expect(parent!.handleId).toBe(5);
  });

  it("querySelector finds a child", async () => {
    const { host, rt, document } = makeHarness();
    const parent = await document.createElement("div");
    await document.body.appendChild(parent);
    await parent.setAttribute("class", "parent");

    // Create a child span and append it.
    const span = await document.createElement("span");
    await span.setAttribute("class", "child");
    await span.setTextContent("hi");
    await parent.appendChild(span);
    await tick(host, rt);

    const child = await parent.querySelector(".child");
    expect(child).not.toBeNull();
    const text = await child!.getTextContent();
    expect(text).toBe("hi");
  });

  it("window viewport properties", async () => {
    const { host, rt, window } = makeHarness();
    // happy-dom has default viewport of 1024x768.
    const w = await window.innerWidth;
    await tick(host, rt);
    expect(w).toBe(1024);
  });

  it("events: click listener fires in the worker", async () => {
    const { host, rt, document } = makeHarness();
    const button = await document.createElement("button");
    await document.body.appendChild(button);
    await tick(host, rt);

    let clicked = false;
    let receivedType = "";
    await button.addEventListener("click", (event) => {
      clicked = true;
      receivedType = event.type;
    });
    await tick(host, rt);

    // Simulate a real click on the main-side DOM.
    const realButton = happyDocument.querySelector("button") as Element;
    realButton.dispatchEvent(new happyWindow.Event("click", { bubbles: true }));

    // Drain events to the worker.
    await tick(host, rt);

    expect(clicked).toBe(true);
    expect(receivedType).toBe("click");
  });
});

describe("e2e: LayoutChannel integration", () => {
  it("worker reads viewport from LayoutChannel (zero round-trip)", () => {
    const layoutSab = allocateLayoutSab();
    const writer = new LayoutWriter(layoutSab);
    const reader = new LayoutReader(layoutSab);

    // Main side updates viewport on raf.
    writer.updateViewport(1920, 1080, 2, 0, 0);
    writer.publish();

    // Worker side reads zero-copy.
    expect(reader.innerWidth).toBe(1920);
    expect(reader.innerHeight).toBe(1080);
    expect(reader.devicePixelRatio).toBe(2);
    expect(reader.hasChanged()).toBe(true);
  });

  it("worker reads element layout from LayoutChannel after subscription", () => {
    const layoutSab = allocateLayoutSab();
    const writer = new LayoutWriter(layoutSab);
    const reader = new LayoutReader(layoutSab);

    // Main side subscribes an element and writes its metrics.
    writer.track(42);
    writer.updateElement(42, 300, 200, 10, 20, 300, 200);
    writer.publish();

    // Worker side reads zero-copy.
    expect(reader.getElementClientWidth(42)).toBe(300);
    expect(reader.getElementClientHeight(42)).toBe(200);
    const rect = reader.getElementRect(42);
    expect(rect).toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });
});
