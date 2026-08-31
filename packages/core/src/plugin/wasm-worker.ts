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

function buildWorkerImports(): WasmPluginImports {
  const readStr = (ptr: number, len: number) => readStringFromMemory(exports, ptr, len);
  const bridge = (method: string, args: unknown[]): Promise<unknown> => {
    return new Promise((resolve) => {
      const callId = Math.random().toString(36).slice(2);
      const handler = (ev: MessageEvent) => {
        const msg = ev.data;
        if (msg?.__wasmBridgeResult && msg.callId === callId) {
          (self as any).removeEventListener("message", handler);
          resolve(msg.result);
        }
      };
      (self as any).addEventListener("message", handler);
      (self as any).postMessage({ __wasmBridge: true, method, args, callId });
    });
  };

  return {
    env: {
      log_info: (ptr, len) => bridge("log", [readStr(ptr, len)]),
      log_warn: (ptr, len) => bridge("log", [readStr(ptr, len)]),
      log_error: (ptr, len) => bridge("log", [readStr(ptr, len)]),
      log_debug: (ptr, len) => bridge("log", [readStr(ptr, len)]),
      state_get: (_keyPtr, _keyLen) => 0, // simplified — full impl would bridge
      state_set: (_keyPtr, _keyLen, _valPtr, _valLen) => {},
      state_delete: (_keyPtr, _keyLen) => {},
      event_publish: (namePtr, nameLen, dataPtr, dataLen) => {
        const name = readStr(namePtr, nameLen);
        const data = readStr(dataPtr, dataLen);
        bridge("publish", [name, data]);
      },
      event_subscribe: (_namePtr, _nameLen) => 0,
      event_unsubscribe: (_subId) => {},
    },
  };
}
