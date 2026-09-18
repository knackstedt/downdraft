// ============================================================================
// WASM worker entry — runs inside a dedicated Web Worker per WASM plugin.
//
// Receives an init message with the WASM module URL, fetches + instantiates
// it with the host import module, calls register(), and forwards tick/dispose.
// ============================================================================

import { getWarningEngine, METRIC_TASK_LATENCY, recordTaskLatency } from "../profiling/worker-prelude";
import {
    readStringFromMemory,
    WASM_PLUGIN_ABI_VERSION,
    writeBytesToMemory,
    type WasmPluginExports,
    type WasmPluginImports
} from "./wasm-abi";

let exports: WasmPluginExports = { alloc: () => 0, register: () => {} };
let _subscriptions = new Map<number, (data: unknown) => void>();

self.onmessage = async (ev: MessageEvent) => {
  const msg = ev.data;
  if (msg?.__wasmInit) {
    await initPlugin(msg.entryUrl, msg.pluginId);
  }
  if (msg?.__wasmDispose) {
    try { exports.dispose?.(); } catch { /* */ }
    (self as any).postMessage({ __wasmDisposed: true });
  }
  if (msg?.__wasmTick) {
    if (typeof exports.tick === "function") {
      const tickStart = performance.now();
      exports.tick(msg.dt, msg.elapsedTime);
      const durationUs = (performance.now() - tickStart) * 1000;
      recordTaskLatency("wasm", durationUs, "tick");
      getWarningEngine()?.checkInstant(METRIC_TASK_LATENCY, durationUs);
    }
  }
  if (msg?.__wasmEvent) {
    if (typeof exports.on_event === "function") {
      const json = JSON.stringify(msg.data);
      const [ptr, len] = writeBytesToMemory(exports, new TextEncoder().encode(json)) ?? [0, 0];
      if (ptr !== 0) {
        const evtStart = performance.now();
        exports.on_event(msg.subId, ptr, len);
        const durationUs = (performance.now() - evtStart) * 1000;
        recordTaskLatency("wasm", durationUs, "on_event");
        getWarningEngine()?.checkInstant(METRIC_TASK_LATENCY, durationUs);
      }
    }
  }
};

async function initPlugin(entryUrl: string, pluginId: string): Promise<void> {
  try {
    const resp = await fetch(entryUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    // Build host imports — the worker forwards calls to the host via postMessage.
    const imports = buildWorkerImports();
    const result = await WebAssembly.instantiate(bytes, imports as unknown as WebAssembly.Imports);
    exports = resolveExports(result.instance);
    // Hydrate the state mirror before register() so synchronous state_get
    // sees persisted values.
    await hydrateState();

    if (typeof exports.register !== "function") {
      throw new Error("WASM module has no register() export");
    }

    exports.register();
    (self as any).postMessage({ __wasmReady: true, pluginId, abiVersion: WASM_PLUGIN_ABI_VERSION });
  } catch (e) {
    (self as any).postMessage({ __wasmError: true, pluginId, error: (e as Error).message });
  }
}

function resolveExports(instance: WebAssembly.Instance): WasmPluginExports {
  const exp = instance.exports as Record<string, any>;
  return {
    alloc: exp.alloc,
    register: exp.register,
    tick: exp.tick,
    dispose: exp.dispose,
    on_event: exp.on_event,
    memory: exp.memory,
  };
}

// Local state mirror — WASM state_get is synchronous, so the worker keeps a
// KV mirror populated at init (via a bridge "state.load") and mutated locally
// on state_set/delete. Persistence goes through the bridge.
const localState = new Map<string, unknown>();
let stateHydrated = false;

async function hydrateState(): Promise<void> {
  if (stateHydrated) return;
  try {
    await bridgeCall("state.load", []);
    const keys = (await bridgeCall("state.keys", [])) as string[] | undefined;
    if (Array.isArray(keys)) {
      for (const k of keys) {
        localState.set(k, await bridgeCall("state.get", [k]));
      }
    }
  } catch { /* state unavailable — empty mirror is fine */ }
  stateHydrated = true;
}

function bridgeCall(method: string, args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callId = Math.random().toString(36).slice(2);
    const handler = (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg?.__wasmBridgeResult && msg.callId === callId) {
        (self as any).removeEventListener("message", handler);
        if (msg.error) reject(new Error(msg.error)); else resolve(msg.result);
      }
    };
    (self as any).addEventListener("message", handler);
    (self as any).postMessage({ __wasmBridge: true, method, args, callId });
  });
}

function buildWorkerImports(): WasmPluginImports {
  const readStr = (ptr: number, len: number) => readStringFromMemory(exports, ptr, len);
  let nextReqId = 1;
  // Host-call result delivery mirrors loader-wasm's dispatchHostCall: resolve
  // the bridge call, then write the JSON result into wasm memory and invoke
  // the plugin's on_host_call_result export.
  const dispatchHostCall = (p: Promise<unknown>, requestId: number): void => {
    p.then((result) => {
      const exp = exports;
      if (!exp.on_host_call_result) return;
      if (result === undefined) {
        exp.on_host_call_result(requestId, 0, 0, 0, 0);
      } else {
        const json = JSON.stringify(result);
        const [ptr, len] = writeBytesToMemory(exp, new TextEncoder().encode(json)) ?? [0, 0];
        exp.on_host_call_result(requestId, ptr, len, 0, 0);
      }
    }).catch((err: Error) => {
      const exp = exports;
      if (!exp.on_host_call_result) return;
      const [ptr, len] = writeBytesToMemory(exp, new TextEncoder().encode(err.message)) ?? [0, 0];
      exp.on_host_call_result(requestId, 0, 0, ptr, len);
    });
  };
  const hostCall = (method: string, args: unknown[]): number => {
    const reqId = nextReqId++;
    dispatchHostCall(bridgeCall("hostCall", [method, ...args]), reqId);
    return reqId;
  };

  return {
    env: {
      log_info: (ptr, len) => { void bridgeCall("log", ["info", readStr(ptr, len)]); },
      log_warn: (ptr, len) => { void bridgeCall("log", ["warn", readStr(ptr, len)]); },
      log_error: (ptr, len) => { void bridgeCall("log", ["error", readStr(ptr, len)]); },
      log_debug: (ptr, len) => { void bridgeCall("log", ["debug", readStr(ptr, len)]); },
      state_get: (keyPtr, keyLen) => {
        const key = readStr(keyPtr, keyLen);
        const val = localState.get(key);
        if (val === undefined) return 0;
        const json = JSON.stringify(val);
        const [ptr, len] = writeBytesToMemory(exports, new TextEncoder().encode(json)) ?? [0, 0];
        if (ptr === 0) return 0;
        const mem = exports.memory!;
        const dv = new DataView(mem.buffer, ptr - 4, 4);
        dv.setUint32(0, len, true);
        return ptr;
      },
      state_set: (keyPtr, keyLen, valPtr, valLen) => {
        const key = readStr(keyPtr, keyLen);
        const json = readStr(valPtr, valLen);
        let val: unknown = json;
        try { val = JSON.parse(json); } catch { /* raw string */ }
        localState.set(key, val);
        void bridgeCall("state.set", [key, val]);
      },
      state_delete: (keyPtr, keyLen) => {
        const key = readStr(keyPtr, keyLen);
        localState.delete(key);
        void bridgeCall("state.delete", [key]);
      },
      event_publish: (namePtr, nameLen, dataPtr, dataLen) => {
        const name = readStr(namePtr, nameLen);
        const data = readStr(dataPtr, dataLen);
        let parsed: unknown = data;
        try { parsed = JSON.parse(data); } catch { /* raw string */ }
        void bridgeCall("events.publish", [name, parsed]);
      },
      event_subscribe: (namePtr, nameLen) => {
        const name = readStr(namePtr, nameLen);
        const subId = _subscriptions.size + 1;
        _subscriptions.set(subId, () => {});
        void bridgeCall("events.subscribe", [name, subId]);
        return subId;
      },
      event_unsubscribe: (subId) => {
        _subscriptions.delete(subId);
        void bridgeCall("events.unsubscribe", [subId]);
      },
      // ── Host-call bridge (v3) — forwarded to the host's NativePluginContext
      // bridge; results arrive via on_host_call_result. ──
      spawn_prop: (contentIdPtr, contentIdLen, x, y, z, qx, qy, qz, qw, scale) =>
        hostCall("spawnProp", [{
          contentId: readStr(contentIdPtr, contentIdLen),
          position: [x, y, z],
          rotation: [qx, qy, qz, qw],
          scale,
        }]),
      remove_prop: (entityId) => hostCall("removeProp", [entityId]),
      set_physics: (entityId, mass, restitution, friction, gravityScale) => {
        const desc: Record<string, number> = {};
        if (!Number.isNaN(mass)) desc.mass = mass;
        if (!Number.isNaN(restitution)) desc.restitution = restitution;
        if (!Number.isNaN(friction)) desc.friction = friction;
        if (!Number.isNaN(gravityScale)) desc.gravityScale = gravityScale;
        return hostCall("setPhysics", [entityId, desc]);
      },
      get_physics: (entityId) => hostCall("getPhysics", [entityId]),
      apply_impulse: (entityId, x, y, z) => hostCall("applyImpulse", [entityId, [x, y, z]]),
      apply_torque: (entityId, x, y, z) => hostCall("applyTorque", [entityId, [x, y, z]]),
      get_asset_ref: (assetIdPtr, assetIdLen) =>
        hostCall("getAssetRef", [readStr(assetIdPtr, assetIdLen)]),
    },
  };
}
