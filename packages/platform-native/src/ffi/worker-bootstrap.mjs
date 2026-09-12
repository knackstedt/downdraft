// Worker bootstrap — runs before the worker script. Polyfills browser globals
// that Node's worker_threads doesn't have: `self`, `addEventListener`, etc.
// Registered via execArgv in the Worker polyfill.

import { parentPort } from "node:worker_threads";

// `self` — in browser workers, `self` is the global scope. In Node
// worker_threads, the equivalent is `globalThis`.
if (typeof globalThis.self === "undefined") {
  globalThis.self = globalThis;
}

// Expose `parentPort` on globalThis so rpc.ts's isNodeWorker detection works
// (it checks `typeof globalThis.parentPort !== "undefined"`).
if (typeof globalThis.parentPort === "undefined") {
  globalThis.parentPort = parentPort;
}

// Polyfill `require` for `worker_threads` module — rpc.ts uses
// `globalThis.require?.("worker_threads")?.parentPort` to detect Node workers.
// In ESM, `require` is not defined, so we provide a minimal shim.
if (typeof globalThis.require === "undefined") {
  const { createRequire } = await import("node:module");
  globalThis.require = createRequire(import.meta.url);
}

// `postMessage` — in browser workers, `postMessage` is a global. In Node
// worker_threads, it's `parentPort.postMessage`.
if (typeof globalThis.postMessage === "undefined") {
  globalThis.postMessage = (message, transfer) => {
    parentPort.postMessage(message, transfer);
  };
}

// `self.onmessage` — in browser workers, setting `self.onmessage = handler`
// registers a message listener. In Node worker_threads, this does nothing.
// Use Object.defineProperty to intercept the assignment and wire it to
// parentPort.on("message", ...).
let _onmessageHandler = null;
parentPort.on("message", (data) => {
  if (_onmessageHandler) {
    // Browser workers deliver MessageEvent with .data; Node delivers raw data.
    // rpc.ts's onHostMessage does `ctx.onmessage = (e) => handler(e.data)`,
    // so we need to wrap the raw data in a { data } object.
    _onmessageHandler({ data });
  }
});
try {
  Object.defineProperty(globalThis, "onmessage", {
    get: () => _onmessageHandler,
    set: (handler) => { _onmessageHandler = handler; },
    configurable: true,
  });
} catch {
  // If defineProperty fails, fall back to direct assignment
  globalThis.onmessage = null;
}

// `addEventListener` / `removeEventListener` / `dispatchEvent` on globalThis
// (browser workers have these on `self`/`globalThis`).
if (typeof globalThis.addEventListener === "undefined") {
  const listeners = new Map();
  globalThis.addEventListener = (type, listener) => {
    if (type === "message") {
      parentPort.on("message", (data) => listener({ data }));
    } else {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(listener);
    }
  };
  globalThis.removeEventListener = (type, listener) => {
    listeners.get(type)?.delete(listener);
  };
  globalThis.dispatchEvent = (event) => {
    const set = listeners.get(event?.type);
    if (set) for (const l of set) l(event);
    return true;
  };
}

// `import.meta.url` — already available in ESM. No polyfill needed.
