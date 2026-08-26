// ============================================================================
// op-table.spec — round-trip every registered op through the host + runtime
// in a single process (no real worker). The host drains the request ring
// synchronously; the runtime's async promises resolve on the next microtask.
//
// This validates the full encode → ring → decode → exec → encode reply →
// decode reply path with no DOM classes yet — just raw op ids + args.
// ============================================================================

import { describe, expect, it } from "bun:test";
import { Window } from "happy-dom";
import { MainThreadHost } from "../main/host";
import * as ids from "../shared/op-ids";
import { HANDLE_BODY, HANDLE_DOCUMENT } from "../shared/protocol";
import { WorkerRuntime } from "../worker/runtime";

// Set up a happy-dom window + document for the host to operate on.
const happyWindow = new Window();
const happyDocument = happyWindow.document;
// Make document.body exist (happy-dom creates it with createElement but we
// need it present for the reserved HANDLE_BODY).
happyDocument.write("<!doctype html><html><head></head><body></body></html>");

// Expose happy-dom globals so ops.ts `instanceof Element` checks work.
(globalThis as any).Element = happyWindow.Element;
(globalThis as any).HTMLElement = happyWindow.HTMLElement;
(globalThis as any).Node = happyWindow.Node;

// In-process harness: host + runtime share the same SAB. The host.drain()
// is called manually to process requests. The runtime's async promises
// resolve after drain writes replies.
function makeHarness() {
  const host = new MainThreadHost({ document: happyDocument as unknown as Document, window: happyWindow as unknown as Window });
  const rt = new WorkerRuntime(host.sab);
  return { host, rt };
}

// Drain host, then microtask-flush the runtime's pending promises.
async function roundTrip(host: MainThreadHost, rt: WorkerRuntime) {
  host.drain();
  // The runtime's call() arms waitAsync; for the in-process test we just
  // drain replies directly after the host has written them.
  rt.drainReplies();
}

describe("op-table round-trip (in-process)", () => {
  it("document.createElement → handle", async () => {
    const { host, rt } = makeHarness();
    const p = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["div"]);
    await roundTrip(host, rt);
    const result = await p;
    expect(result.kind).toBe(6); // ArgKind.Handle
    expect(result.value).toBeGreaterThan(0);
    // Verify the real node was created and attached to the handle table.
    const node = host.handleTable.resolve(result.value as number);
    expect(node).toBeInstanceOf(Element);
    expect((node as Element).tagName).toBe("DIV");
  });

  it("appendChild + setAttribute + getAttribute", async () => {
    const { host, rt } = makeHarness();
    // Create a div, append to body, set attribute, get it back.
    const createP = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["div"]);
    await roundTrip(host, rt);
    const createResult = await createP;
    const divHandle = createResult.value as number;

    const appendP = rt.call(ids.OP_NODE_APPEND_CHILD, HANDLE_BODY, [divHandle]);
    await roundTrip(host, rt);
    const appendResult = await appendP;
    expect(appendResult.kind).toBe(6); // Handle

    const setP = rt.call(ids.OP_ELEMENT_SET_ATTRIBUTE, divHandle, ["class", "foo"]);
    await roundTrip(host, rt);
    const setResult = await setP;
    expect(setResult.kind).toBe(9); // ArgKind.Void

    const getP = rt.call(ids.OP_ELEMENT_GET_ATTRIBUTE, divHandle, ["class"]);
    await roundTrip(host, rt);
    const getResult = await getP;
    expect(getResult.kind).toBe(7); // ArgKind.StringAtom
    expect(getResult.value).toBe("foo");

    // Verify on the real DOM.
    const div = host.handleTable.resolve(divHandle) as Element;
    expect(div.getAttribute("class")).toBe("foo");
    expect(div.parentElement).toBe(host.handleTable.resolve(HANDLE_BODY));
  });

  it("setTextContent + getTextContent round-trips a string", async () => {
    const { host, rt } = makeHarness();
    const createP = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["span"]);
    await roundTrip(host, rt);
    const spanHandle = (await createP).value as number;

    const setP = rt.call(ids.OP_NODE_SET_TEXT_CONTENT, spanHandle, ["hello world"]);
    await roundTrip(host, rt);
    expect((await setP).kind).toBe(9);

    const getP = rt.call(ids.OP_NODE_GET_TEXT_CONTENT, spanHandle, []);
    await roundTrip(host, rt);
    const getResult = await getP;
    expect(getResult.value).toBe("hello world");
  });

  it("hasAttribute returns a bool", async () => {
    const { host, rt } = makeHarness();
    const createP = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["div"]);
    await roundTrip(host, rt);
    const h = (await createP).value as number;

    const hasP = rt.call(ids.OP_ELEMENT_HAS_ATTRIBUTE, h, ["id"]);
    await roundTrip(host, rt);
    expect((await hasP).value).toBe(false);

    const setP = rt.call(ids.OP_ELEMENT_SET_ATTRIBUTE, h, ["id", "x"]);
    await roundTrip(host, rt);
    await setP;

    const hasP2 = rt.call(ids.OP_ELEMENT_HAS_ATTRIBUTE, h, ["id"]);
    await roundTrip(host, rt);
    expect((await hasP2).value).toBe(true);
  });

  it("classList.toggle returns a bool and mutates the real node", async () => {
    const { host, rt } = makeHarness();
    const createP = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["div"]);
    await roundTrip(host, rt);
    const h = (await createP).value as number;

    const toggleP = rt.call(ids.OP_ELEMENT_CLASS_LIST_TOGGLE, h, ["active"]);
    await roundTrip(host, rt);
    expect((await toggleP).value).toBe(true);

    const toggleP2 = rt.call(ids.OP_ELEMENT_CLASS_LIST_TOGGLE, h, ["active"]);
    await roundTrip(host, rt);
    expect((await toggleP2).value).toBe(false);

    const node = host.handleTable.resolve(h) as Element;
    expect(node.classList.contains("active")).toBe(false);
  });

  it("OP_RELEASE frees the handle on the main side", async () => {
    const { host, rt } = makeHarness();
    const createP = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["div"]);
    await roundTrip(host, rt);
    const h = (await createP).value as number;
    expect(host.handleTable.resolve(h)).not.toBeNull();

    rt.release(h);
    host.drain();
    rt.drainReplies();

    expect(host.handleTable.resolve(h)).toBeNull();
  });

  it("error path: unknown op id returns an error reply", async () => {
    const { host, rt } = makeHarness();
    const p = rt.call(254, HANDLE_DOCUMENT, []); // unregistered id
    await roundTrip(host, rt);
    expect(p).rejects.toThrow("Unknown op id");
  });

  it("spilled args (>2) round-trip via payload heap", async () => {
    const { host, rt } = makeHarness();
    // classList.add is a 1-arg op; to exercise the spill path, call an op
    // with 3 args. We use setAttribute (2 args) + a dummy 3rd by calling
    // a getter with extra args (ignored). Instead, directly test the spill
    // by calling document.createElement with 3 args (tag, ignored, ignored).
    // The exec only reads arg 0, so this validates the spill encode/decode.
    const p = rt.call(ids.OP_DOCUMENT_CREATE_ELEMENT, HANDLE_DOCUMENT, ["p", "extra1", "extra2"]);
    await roundTrip(host, rt);
    const result = await p;
    expect(result.kind).toBe(6);
    const node = host.handleTable.resolve(result.value as number) as Element;
    expect(node.tagName).toBe("P");
  });
});
