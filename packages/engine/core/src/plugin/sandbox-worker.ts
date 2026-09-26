// ============================================================================
// Sandbox worker entry — runs inside a dedicated Web Worker per worker-js
// plugin. Receives an init message with the plugin entry URL + granted
// permissions, restricts globals, then imports the entry and calls its
// register() with a bridge-backed context.
//
// Bridge model: every host capability crosses the boundary as an async
// `__bridgeCall`/`__bridgeResponse` pair correlated by `callId`. The host
// side enforces an allowlist of methods and each context API enforces the
// plugin's permission grant — this worker just forwards calls.
//
// This file is the worker entry. The host spawns it with:
//   new Worker(new URL("./sandbox-worker.ts", import.meta.url), { type: "module" })
// (the loader does this inline per the BaseWorkerHost Vite rule).
// ============================================================================

import type { PluginEntry, PluginHostCalls, ScriptPluginContext } from "./context";
import type { PluginPermission } from "./manifest";
import { restrictGlobals } from "./sandbox-shim";

/** Init message from the host. */
export interface SandboxInitMessage {
  entryUrl: string;
  granted: PluginPermission[];
  /** Serialized context method names the host supports (for proxy wiring). */
  contextId: string;
}

// ── Bridge call machinery ──

let contextId = "";
let nextCallId = 1;
const pendingCalls = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

/** Invoke an allowlisted host method. Awaits the host's response. */
function bridgeCall(method: string, args: unknown[]): Promise<unknown> {
  const callId = nextCallId++;
  return new Promise((resolve, reject) => {
    pendingCalls.set(callId, { resolve, reject });
    (self as any).postMessage({ __bridgeCall: true, contextId, callId, method, args });
  });
}

/** Fire-and-forget bridge call (publish, subscribe — no meaningful result). */
function bridgeNotify(method: string, args: unknown[]): void {
  (self as any).postMessage({ __bridgeCall: true, contextId, method, args });
}

// ── Worker-local state ──

const tickCallbacks = new Set<(dt: number, t: number) => void>();
const disposeCallbacks: Array<() => void> = [];
const eventHandlers = new Map<string, Set<(data: unknown) => void>>();
/** Local KV mirror — get/set/delete/keys are synchronous; save()/load()
 *  round-trip to the host's store via the bridge. */
const localState = new Map<string, unknown>();

// ── Message handling ──

self.addEventListener("message", (ev: MessageEvent) => {
  const msg = ev.data;
  if (!msg) return;

  if (msg.__sandboxInit) {
    void runPlugin(msg as SandboxInitMessage & { __sandboxInit: true });
    return;
  }
  if (msg.__bridgeResponse) {
    const pending = pendingCalls.get(msg.callId);
    if (pending) {
      pendingCalls.delete(msg.callId);
      if (msg.error !== undefined) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    }
    return;
  }
  // Host-driven tick → ctx.tick.onTick callbacks.
  if (msg.__tick) {
    for (const cb of tickCallbacks.values()) cb(msg.dt, msg.elapsedTime);
    return;
  }
  // Host-published event → local subscribers (registered via ctx.events.subscribe).
  if (msg.__event) {
    const set = eventHandlers.get(msg.event);
    if (set) for (const h of set.values()) h(msg.data);
    return;
  }
  if (msg.__dispose) {
    disposeCallbacks.forEach((cb) => {
      try { cb(); } catch { /* dispose errors are non-fatal */ }
    });
    return;
  }
});

async function runPlugin(init: SandboxInitMessage): Promise<void> {
  try {
    contextId = init.contextId;
    // 1. Restrict globals based on granted permissions.
    restrictGlobals(new Set<PluginPermission>(init.granted));

    // 2. Build the bridge-backed context and expose it as `ddPlugin`.
    const ctx = makeBridgeContext(init.contextId, new Set(init.granted));
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
  } catch (e) {
    // Report failures so the host's ready-wait rejects instead of hanging.
    const err = e as Error;
    (self as any).postMessage({
      __sandboxError: true,
      contextId: init.contextId,
      error: `${err.message}\n${err.stack ?? ""}`,
    });
  }
}

/** Permissions that map to host-call methods (game mutation API). */
const HOST_CALL_PERMS: PluginPermission[] = ["assets", "ecs", "physics"];
const HOST_CALL_METHODS = [
  "spawnProp",
  "removeProp",
  "setPhysics",
  "getPhysics",
  "applyImpulse",
  "applyTorque",
  "getAssetRef",
] as const;

/** Build a ScriptPluginContext that forwards calls to the host via postMessage. */
function makeBridgeContext(
  pluginId: string,
  granted: ReadonlySet<PluginPermission>,
): ScriptPluginContext {
  const ctx: ScriptPluginContext = {
    id: pluginId,
    events: {
      subscribe(event, handler) {
        let set = eventHandlers.get(event);
        if (!set) {
          set = new Set();
          eventHandlers.set(event, set);
          // First local subscriber for this event — subscribe host-side too.
          bridgeNotify("events.subscribe", [event]);
        }
        set.add(handler as (data: unknown) => void);
        return () => set!.delete(handler as (data: unknown) => void);
      },
      publish(event, data) {
        // Route through the host's shared bus — it echoes back to every
        // subscriber (including this worker's own, if subscribed), so
        // publish semantics match the in-process bus exactly.
        bridgeNotify("events.publish", [event, data]);
      },
    },
    state: {
      get: <T>(key: string) => localState.get(key) as T | undefined,
      set: (key, value) => { localState.set(key, value); },
      delete: (key) => { localState.delete(key); },
      keys: () => [...localState.keys()],
      // Persist to the host's store (storage permission enforced host-side).
      save: async () => { await bridgeCall("state.save", [[...localState.entries()]]); },
      load: async () => {
        const entries = (await bridgeCall("state.load", [])) as Array<[string, unknown]> | undefined;
        if (entries) {
          localState.clear();
          entries.forEach(([k, v]) => { localState.set(k, v);; });
        }
      },
    },
    tick: {
      onTick(fn) {
        const wrapped = (dt: number, t: number) => fn(dt, t);
        tickCallbacks.add(wrapped);
        return () => tickCallbacks.delete(wrapped);
      },
    },
    log: {
      info: (m) => (self as any).postMessage({ __pluginLog: true, level: "info", msg: m }),
      warn: (m) => (self as any).postMessage({ __pluginLog: true, level: "warn", msg: m }),
      error: (m) => (self as any).postMessage({ __pluginLog: true, level: "error", msg: m }),
      debug: (m) => (self as any).postMessage({ __pluginLog: true, level: "debug", msg: m }),
    },
    onDispose: (fn) => disposeCallbacks.push(fn),
  };

  // Expose the host-call bridge when the plugin was granted any host-call
  // permission. Each method forwards over the bridge; the host enforces the
  // allowlist + per-method permission gate. Script-tier contexts reject with
  // "not available on this context".
  const hasHostCallPerm = HOST_CALL_PERMS.some((p) => granted.has(p));
  if (hasHostCallPerm) {
    const hostCalls: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
    HOST_CALL_METHODS.forEach((m) => {
      hostCalls[m] = (...args: unknown[]) => bridgeCall(m, args) as Promise<never>;
    });
    (ctx as ScriptPluginContext & { hostCalls: PluginHostCalls }).hostCalls =
      hostCalls as unknown as PluginHostCalls;
  }

  return ctx;
}
