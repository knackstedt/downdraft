// ============================================================================
// Sandbox worker entry — runs inside a dedicated Web Worker per worker-js
// plugin (or a shared worker pool). Receives an init message with the plugin
// entry URL + granted permissions, restricts globals, then imports the entry
// and calls its register() via the host-provided `ddPlugin` bridge.
//
// This file is the worker entry. The host spawns it with:
//   new Worker(new URL("./sandbox-worker.ts", import.meta.url), { type: "module" })
// (the loader does this inline per the BaseWorkerHost Vite rule).
// ============================================================================

import type { PluginEntry, ScriptPluginContext } from "./context";
import type { PluginPermission } from "./manifest";
import { restrictGlobals } from "./sandbox-shim";

/** Init message from the host. */
export interface SandboxInitMessage {
  entryUrl: string;
  granted: PluginPermission[];
  /** Serialized context method names the host supports (for proxy wiring). */
  contextId: string;
}

// The plugin receives a `ddPlugin` global: a proxy that forwards calls to
// the host via postMessage. We construct it here and put it on `self` before
// importing the plugin entry.

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg && msg.__sandboxInit) {
    const init = msg as SandboxInitMessage & { __sandboxInit: true };
    await runPlugin(init);
    return;
  }
};

async function runPlugin(init: SandboxInitMessage): Promise<void> {
  // 1. Restrict globals based on granted permissions.
  restrictGlobals(new Set<PluginPermission>(init.granted));

  // 2. Build the ddPlugin bridge (a ScriptPluginContext proxy that forwards
  //    to the host). For native-tier plugins running in a worker, the host
  //    extends this with ECS/DI methods — but native bridging into a remote
  //    ModuleHost is Phase 4 work; Phase 1 worker-js native plugins run on
  //    the sim thread where the ModuleHost lives (loader handles that path).
  const ctx = makeBridgeContext(init.contextId);
  (self as any).ddPlugin = { ctx };

  // 3. Dynamically import the plugin entry. @vite-ignore because the URL is
  //    dynamic (not statically analyzable).
  const mod = await import(/* @vite-ignore */ init.entryUrl);
  const entry: PluginEntry = mod.default ?? mod;
  if (typeof entry.register !== "function") {
    throw new Error(`Plugin entry "${init.entryUrl}" has no register() function`);
  }
  // 4. Call register.
  await entry.register(ctx);
  // 5. Notify host that registration completed.
  (self as any).postMessage({ __sandboxReady: true, contextId: init.contextId });
}

/** Build a ScriptPluginContext that forwards calls to the host via postMessage. */
function makeBridgeContext(contextId: string): ScriptPluginContext {
  // Simple in-worker event bus for the proxy; host can also publish into it.
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    id: contextId,
    events: {
      subscribe(event, handler) {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler as (data: unknown) => void);
        return () => set!.delete(handler as (data: unknown) => void);
      },
      publish(event, data) {
        const set = handlers.get(event);
        if (set) for (const h of set) h(data);
      },
    },
    state: {
      get: (_key) => undefined, // host-backed in full impl
      set: (_key, _value) => {},
      delete: (_key) => {},
      keys: () => [],
      save: async () => {},
      load: async () => {},
    },
    tick: {
      onTick(fn) {
        // Host drives tick by posting __tick messages.
        const wrapped = (dt: number, t: number) => fn(dt, t);
        tickCallbacks.add(wrapped);
        return () => tickCallbacks.delete(wrapped);
      },
    },
    log: {
      info: (m) => postMessage({ __pluginLog: true, level: "info", msg: m }),
      warn: (m) => postMessage({ __pluginLog: true, level: "warn", msg: m }),
      error: (m) => postMessage({ __pluginLog: true, level: "error", msg: m }),
      debug: (m) => postMessage({ __pluginLog: true, level: "debug", msg: m }),
    },
    onDispose: (fn) => disposeCallbacks.push(fn),
  };
}

const tickCallbacks = new Set<(dt: number, t: number) => void>();
const disposeCallbacks: Array<() => void> = [];

// Host posts __tick messages to drive registered tick callbacks.
self.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.__tick) {
    for (const cb of tickCallbacks) cb(msg.dt, msg.elapsedTime);
  }
  if (msg?.__dispose) {
    for (const cb of disposeCallbacks) cb();
  }
});
