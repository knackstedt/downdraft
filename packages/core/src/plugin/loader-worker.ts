// ============================================================================
// WorkerPluginLoader — loads `worker-js` format plugins in a sandboxed Web Worker.
//
// For `thread: "own-worker"` plugins, this loader spawns a dedicated
// `sandbox-worker.ts` per plugin, sends the init message (entry URL + granted
// perms), and forwards host↔worker bridge calls.
//
// For `thread: "sim"` plugins, the host forwards the manifest to the sim
// worker's own PluginHost (which uses the in-process loader path that imports
// the entry directly into the sim worker's module graph). This loader only
// handles the `own-worker` case on the renderer/sim-host side.
//
// CRITICAL: Vite requires `new Worker(new URL("./sandbox-worker.ts", import.meta.url))`
// to appear literally at the call site. It does here.
// ============================================================================

import { createLogger } from "../util/logger";
import type { NativePluginContext, ScriptPluginContext } from "./context";
import type { PluginLoader } from "./host";
import type { PluginManifest, PluginPermission } from "./manifest";
import type { PermissionGrant } from "./permissions";

const log = createLogger("info");

export class WorkerPluginLoader implements PluginLoader {
  readonly format = "worker-js" as const;
  private workers = new Map<string, Worker>();

  async load(
    manifest: PluginManifest,
    ctx: ScriptPluginContext | NativePluginContext,
    granted: PermissionGrant,
  ): Promise<(() => void) | void> {
    if (manifest.thread !== "own-worker") {
      // sim-thread worker-js plugins are loaded by the sim worker's own host
      // via direct dynamic import (not this loader). Renderer-side host skips.
      log.info(
        "WorkerPluginLoader",
        `plugin "${manifest.id}" thread=${manifest.thread} — skipping on this host (sim-side host loads it)`,
      );
      return;
    }
    const entryUrl = manifest.entry!;
    const worker = new Worker(new URL("./sandbox-worker.ts", import.meta.url), {
      type: "module",
    });
    this.workers.set(manifest.id, worker);

    const ready = new Promise<void>((resolve, reject) => {
      const onReady = (ev: MessageEvent) => {
        const msg = ev.data;
        if (msg?.__sandboxReady && msg.contextId === manifest.id) {
          worker.removeEventListener("message", onReady);
          resolve();
        }
        if (msg?.__sandboxError) {
          worker.removeEventListener("message", onReady);
          reject(new Error(msg.error));
        }
      };
      worker.addEventListener("message", onReady);
    });

    worker.onerror = (e) => {
      log.error("WorkerPluginLoader", `worker error for "${manifest.id}": ${e.message}`);
    };

    worker.postMessage({
      __sandboxInit: true,
      entryUrl,
      granted: [...granted.granted] as PluginPermission[],
      contextId: manifest.id,
    });

    // Forward host-side ctx calls when the worker posts __bridgeCall.
    worker.addEventListener("message", (ev: MessageEvent) => {
      const msg = ev.data;
      if (msg?.__bridgeCall) {
        // Best-effort: invoke the method on the host ctx and return the result.
        const { method, args } = msg;
        try {
          // @ts-expect-error - dynamic dispatch
          const result = ctx[method]?.(...args);
          worker.postMessage({ __bridgeResponse: true, contextId: manifest.id, method, result });
        } catch (e) {
          worker.postMessage({
            __bridgeResponse: true,
            contextId: manifest.id,
            method,
            result: undefined,
            error: (e as Error).message,
          });
        }
      }
    });

    await ready;
    return () => {
      worker.postMessage({ __dispose: true });
      setTimeout(() => worker.terminate(), 100);
      this.workers.delete(manifest.id);
    };
  }

  disposeAll(): void {
    for (const [, w] of this.workers) w.terminate();
    this.workers.clear();
  }
}

/**
 * In-process loader for worker-js plugins that run on the SAME thread as the
 * host (e.g. sim-thread plugins loaded by the sim worker's PluginHost, or
 * renderer-thread plugins in tests). Restricts globals via the shim then
 * dynamically imports the entry.
 */
export class InlinePluginLoader implements PluginLoader {
  readonly format = "worker-js" as const;

  async load(
    manifest: PluginManifest,
    ctx: ScriptPluginContext | NativePluginContext,
    granted: PermissionGrant,
  ): Promise<(() => void) | void> {
    // Restrict globals in-process (affects everything on this thread — only
    // safe in a dedicated worker context like the sim worker, where the
    // plugin runs alongside the sim but the sim owns the thread).
    const { restrictGlobals } = await import("./sandbox-shim");
    restrictGlobals(granted.granted);
    const mod = await import(/* @vite-ignore */ manifest.entry!);
    const entry = mod.default ?? mod;
    if (typeof entry.register !== "function") {
      throw new Error(`Plugin "${manifest.id}" entry has no register() function`);
    }
    await entry.register(ctx);
  }
}
