// ============================================================================
// undertow — public API
//
// A lock-free DOM proxy that moves arbitrary client UI code into a Web Worker
// via a resizable SharedArrayBuffer + Atomics. The worker owns the JS object
// graph (integer handles); every DOM call becomes a fixed-shape op record in
// a request ring; the main thread drains it and writes replies to a reply
// ring; events flow back through a separate event ring. Hot-path layout reads
// are served from a dedicated LayoutChannel SAB (zero-copy, no round-trip).
//
// Usage (main side):
//   const host = new MainThreadHost({ document, window });
//   worker.postMessage(host.sab);
//   // On each raf:
//   host.drain();
//
// Usage (worker side):
//   self.onmessage = (e) => {
//     const rt = new WorkerRuntime(e.data);
//     const document = new WorkerDocument(rt);
//     const window = new WorkerWindow(rt);
//     // On each raf:
//     rt.drainReplies();
//     rt.eventPump.drain();
//   };
// ============================================================================

// Main side
export { EventDispatcher, type EventDispatcherHost } from "./main/event-dispatcher";
export { HandleTable } from "./main/handle-table";
export { MainThreadHost, type MainThreadHostOptions } from "./main/host";

// Worker side
export { EventPump, type EventListener, type EventPumpRuntime } from "./worker/event-pump";
export { Handle } from "./worker/handle";
export { WorkerRuntime, type CallMode, type CallResult } from "./worker/runtime";

// Worker DOM classes
export { WorkerCSSStyleDeclaration } from "./worker/dom/css-style-declaration";
export { WorkerDocument } from "./worker/dom/document";
export { WorkerElement } from "./worker/dom/element";
export { WorkerEvent, type WorkerEventInit } from "./worker/dom/event";
export { WorkerNode } from "./worker/dom/node";
export { WorkerComment, WorkerText } from "./worker/dom/text";
export { WorkerWindow } from "./worker/dom/window";

// Worker DOM polyfill (installs globals for React etc.)
export { installPolyfill, WorkerEventPolyfill } from "./worker/polyfill";

// Sync DOM classes (for React's synchronous reconciler)
export { SyncComment, SyncDocument, SyncElement, SyncNode, SyncText, SyncWindow, wrapSyncNode } from "./worker/sync-dom";

// SAB infrastructure
export {
    allocateDomSab,
    growDomSab,
    readRegions,
    validateDomSab,
    type DomSabOptions,
    type DomSabRegions
} from "./sab/dom-sab";
export { EventRing } from "./sab/event-ring";
export {
    allocateLayoutSab, LAYOUT_MAGIC, LAYOUT_MAX_ELEMENTS,
    LAYOUT_SAB_BYTES, LAYOUT_VERSION, LayoutReader, LayoutWriter, validateLayoutSab
} from "./sab/layout-channel";
export { PayloadHeap } from "./sab/payload-heap";
export { ReplyRing } from "./sab/reply-ring";
export { RequestRing } from "./sab/request-ring";
export { RingView } from "./sab/ring";
export { StringPool } from "./sab/string-pool";

// Shared protocol
export * as opIds from "./shared/op-ids";
export { allOps, buildOpMap, getOp, registerOp, type ArgValue, type DecodedArgs, type MainExecCtx, type OpEntry, type OpKind, type Result } from "./shared/op-table";
export * as protocol from "./shared/protocol";

