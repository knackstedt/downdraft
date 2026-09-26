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
    if (set) set.forEach((l) => { l(event);; });
    return true;
  };
}

// `import.meta.url` — already available in ESM. No polyfill needed.

// `Worker` — nested worker spawns (e.g. sim worker → pool workers). Node
// worker_threads supports nesting but exposes no global Worker. Mirror the
// BrowserWorker wrapper from dom-polyfills.ts and re-apply this bootstrap +
// tsx + the wgsl loader via execArgv so the child gets the same environment.
if (typeof globalThis.Worker === "undefined") {
  const { Worker: NodeWorker } = await import("node:worker_threads");
  const { createRequire } = await import("node:module");
  const wgslLoaderPath = new URL("./wgsl-loader.mjs", import.meta.url).href;
  const execArgv = [];
  try {
    execArgv.push("--import", createRequire(import.meta.url).resolve("tsx"));
  } catch { /* tsx absent — .ts children won't load */ }
  execArgv.push("--import", wgslLoaderPath, "--import", import.meta.url);
  globalThis.Worker = class BrowserWorker extends NodeWorker {
    constructor(specifier, options) {
      let filename;
      if (specifier instanceof URL) {
        filename = specifier.pathname;
      } else {
        try { filename = new URL(specifier).pathname; } catch { filename = specifier; }
      }
      super(filename, { ...options, execArgv });
    }
    set onmessage(h) { this.on("message", (data) => h({ data })); }
    set onerror(h) { this.on("error", (err) => h({ error: err, message: err?.message ?? String(err) })); }
    set onmessageerror(h) { this.on("messageerror", (data) => h({ data })); }
    addEventListener(type, listener) {
      if (type === "message") this.on("message", (data) => listener({ data }));
      else if (type === "error") this.on("error", (err) => listener({ error: err, message: err?.message ?? String(err) }));
      else if (type === "messageerror") this.on("messageerror", (data) => listener({ data }));
      else this.on(type, listener);
    }
    removeEventListener(type, listener) { this.off(type, listener); }
  };
}
