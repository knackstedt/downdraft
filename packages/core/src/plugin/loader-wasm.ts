// ============================================================================
// WasmPluginLoader — loads `wasm` format (native-tier) plugins.
//
// WASM plugins ALWAYS run in their own dedicated worker (stability isolation).
// The loader:
//   1. Fetches the .wasm file.
//   2. Instantiates it with the host import module (env namespace).
//   3. Calls the module's `register` export.
//   4. Forwards tick calls + event dispatch to the module's exports.
//   5. On dispose, calls the module's `dispose` export.
//
// For testing, an in-process variant (`InlineWasmPluginLoader`) instantiates
// the WASM module directly on the current thread.
// ============================================================================

import { createLogger } from "../util/logger";
import type { ScriptPluginContext } from "./context";
import type { PluginLoader } from "./host";
import type { PluginManifest } from "./manifest";
import type { PermissionGrant } from "./permissions";
import {
    readStringFromMemory,
    writeBytesToMemory,
    writeStringToMemory,
    type WasmPluginExports,
    type WasmPluginImports,
} from "./wasm-abi";

const log = createLogger("info");

/**
 * Build the host import module (`env` namespace) for a WASM plugin.
 * The imports bridge the plugin's WASM calls to the ScriptPluginContext.
 */
function buildImports(
  ctx: ScriptPluginContext,
  exports: () => WasmPluginExports,
  subscriptions: Map<number, (data: unknown) => void>,
): WasmPluginImports {
  const _writeStr = (s: string): [number, number] => writeStringToMemory(exports(), s) ?? [0, 0];
  const readStr = (ptr: number, len: number): string => readStringFromMemory(exports(), ptr, len);

  return {
    env: {
      log_info: (ptr, len) => ctx.log.info(readStr(ptr, len)),
      log_warn: (ptr, len) => ctx.log.warn(readStr(ptr, len)),
      log_error: (ptr, len) => ctx.log.error(readStr(ptr, len)),
      log_debug: (ptr, len) => ctx.log.debug(readStr(ptr, len)),

      state_get: (keyPtr, keyLen) => {
        const key = readStr(keyPtr, keyLen);
        const val = ctx.state.get(key);
        if (val === undefined) return 0;
        // Write the value as JSON into memory. Store length as u32 before the ptr.
        const json = JSON.stringify(val);
        const [ptr, len] = writeBytesToMemory(exports(), new TextEncoder().encode(json)) ?? [0, 0];
        if (ptr === 0) return 0;
        // Write the length 4 bytes before the pointer.
        const mem = exports().memory!;
        const dv = new DataView(mem.buffer, ptr - 4, 4);
        dv.setUint32(0, len, true);
        return ptr;
      },
      state_set: (keyPtr, keyLen, valPtr, valLen) => {
        const key = readStr(keyPtr, keyLen);
        const json = readStr(valPtr, valLen);
        try { ctx.state.set(key, JSON.parse(json)); } catch { ctx.state.set(key, json); }
      },
      state_delete: (keyPtr, keyLen) => {
        ctx.state.delete(readStr(keyPtr, keyLen));
      },

      event_publish: (namePtr, nameLen, dataPtr, dataLen) => {
        const name = readStr(namePtr, nameLen);
        const json = readStr(dataPtr, dataLen);
        try { ctx.events.publish(name, JSON.parse(json)); } catch { ctx.events.publish(name, json); }
      },
      event_subscribe: (namePtr, nameLen) => {
        const name = readStr(namePtr, nameLen);
        const subId = subscriptions.size + 1;
        const handler = (data: unknown) => {
          const exp = exports();
          if (!exp.on_event) return;
          const json = JSON.stringify(data);
          const [ptr, len] = writeBytesToMemory(exp, new TextEncoder().encode(json)) ?? [0, 0];
          if (ptr !== 0) exp.on_event(subId, ptr, len);
        };
        const unsub = ctx.events.subscribe(name, handler);
        subscriptions.set(subId, unsub as any);
        // Store the unsub for cleanup.
        (subscriptions as any)[`unsub_${subId}`] = unsub;
        return subId;
      },
      event_unsubscribe: (subId) => {
        const unsub = (subscriptions as any)[`unsub_${subId}`];
        if (typeof unsub === "function") unsub();
        subscriptions.delete(subId);
      },
    },
  };
}

/** Resolve the plugin exports from a WebAssembly instance. */
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

/**
 * In-process WASM plugin loader. Instantiates the WASM module directly on the
 * current thread. Used for tests and for renderer-thread WASM plugins (though
 * WASM plugins are always supposed to run in their own worker per the spec).
 */
export class InlineWasmPluginLoader implements PluginLoader {
  readonly format = "wasm" as const;

  async load(
    manifest: PluginManifest,
    ctx: ScriptPluginContext,
    _granted: PermissionGrant,
  ): Promise<(() => void) | void> {
    const entryUrl = manifest.entry!;
    const resp = await fetch(entryUrl);
    if (!resp.ok) throw new Error(`Failed to fetch WASM plugin "${entryUrl}": HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());

    const subscriptions = new Map<number, (data: unknown) => void>();
    let exportsRef: WasmPluginExports = { alloc: () => 0, register: () => {} };

    const imports = buildImports(ctx, () => exportsRef, subscriptions);
    const result = await WebAssembly.instantiate(bytes, imports as unknown as WebAssembly.Imports);
    exportsRef = resolveExports(result.instance);

    if (typeof exportsRef.register !== "function") {
      throw new Error(`WASM plugin "${manifest.id}" has no register() export`);
    }

    // Call register.
    exportsRef.register();

    // Wire tick if the plugin exports it.
    if (typeof exportsRef.tick === "function") {
      const tickFn = exportsRef.tick;
      const unsub = ctx.tick.onTick((dt, t) => tickFn(dt, t));
      (subscriptions as any).__tickUnsub = unsub;
    }

    log.info("InlineWasmPluginLoader", `Loaded WASM plugin "${manifest.id}"`);

    return () => {
      const unsubTick = (subscriptions as any).__tickUnsub;
      if (typeof unsubTick === "function") unsubTick();
      for (const [, unsub] of subscriptions) {
        if (typeof unsub === "function") (unsub as any)();
      }
      subscriptions.clear();
      try { exportsRef.dispose?.(); } catch { /* swallow */ }
    };
  }
}

/**
 * Worker-based WASM plugin loader. Spawns a dedicated worker per WASM plugin.
 * The worker instantiates the WASM module and bridges the host API.
 *
 * CRITICAL: Vite requires `new Worker(new URL("./wasm-worker.ts", import.meta.url))`
 * to appear literally at the call site. It does here.
 */
export class WasmPluginLoader implements PluginLoader {
  readonly format = "wasm" as const;
  private workers = new Map<string, Worker>();

  async load(
    manifest: PluginManifest,
    ctx: ScriptPluginContext,
    _granted: PermissionGrant,
  ): Promise<(() => void) | void> {
    const entryUrl = manifest.entry!;
    const worker = new Worker(new URL("./wasm-worker.ts", import.meta.url), {
      type: "module",
    });
    this.workers.set(manifest.id, worker);

    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (ev: MessageEvent) => {
        const msg = ev.data;
        if (msg?.__wasmReady && msg.pluginId === manifest.id) {
          worker.removeEventListener("message", onReady);
          resolve();
        }
        if (msg?.__wasmError) {
          worker.removeEventListener("message", onReady);
          reject(new Error(msg.error));
        }
      };
      worker.addEventListener("message", onReady);
    });

    worker.onerror = (e) => {
      log.error("WasmPluginLoader", `worker error for "${manifest.id}": ${e.message}`);
    };

    // Send init message with the WASM URL.
    worker.postMessage({
      __wasmInit: true,
      pluginId: manifest.id,
      entryUrl,
    });

    // Forward host-side calls when the worker posts bridge requests.
    worker.addEventListener("message", (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg?.__wasmBridge) {
        // Best-effort forwarding of host API calls from the worker.
        const { method, args } = msg;
        try {
          // @ts-expect-error - dynamic dispatch
          const result = ctx[method]?.(...args);
          worker.postMessage({ __wasmBridgeResult: true, callId: msg.callId, result });
        } catch (e) {
          worker.postMessage({ __wasmBridgeResult: true, callId: msg.callId, error: (e as Error).message });
        }
      }
    });

    await ready;
    log.info("WasmPluginLoader", `Loaded WASM plugin "${manifest.id}" in dedicated worker`);

    return () => {
      worker.postMessage({ __wasmDispose: true });
      setTimeout(() => worker.terminate(), 100);
      this.workers.delete(manifest.id);
    };
  }

  disposeAll(): void {
    for (const [, w] of this.workers) w.terminate();
    this.workers.clear();
  }
}
