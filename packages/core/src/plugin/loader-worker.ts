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
// Bridge protocol (`__bridgeCall` / `__bridgeResponse`):
//   - Every call carries a `callId` so responses correlate with requests.
//   - Only an allowlist of methods may cross the boundary — the worker can
//     never invoke arbitrary context members. Permission enforcement happens
//     inside the context itself (makeScriptContext/makeNativeContext gate
//     each API on the granted set), so a denied call rejects with a
//     permission error that is forwarded back to the worker.
//   - Results are awaited before responding — async context methods work.
//
// CRITICAL: Vite requires `new Worker(new URL("./sandbox-worker.ts", import.meta.url))`
// to appear literally at the call site. It does here.
// ============================================================================

import { createLogger } from "../util/logger";
import type { NativePluginContext, ScriptPluginContext } from "./context";
import type { PluginHost, PluginLoader } from "./host";
import type { PluginManifest, PluginPermission } from "./manifest";
import type { PermissionGrant } from "./permissions";

const log = createLogger("info");

/** How long to wait for a plugin worker's __sandboxReady before giving up. */
const READY_TIMEOUT_MS = 15_000;

/**
 * Methods a sandboxed worker may invoke across the bridge. Anything not in
 * this list is rejected — the worker can never reach arbitrary ctx members.
 * Permission checks are enforced inside the context methods themselves.
 */
const BRIDGE_METHODS = new Set([
  "events.publish",
  "events.subscribe",
  "state.save",
  "state.load",
  // Host-call bridge (game mutation) — only present on native-tier contexts;
  // each method is additionally permission-gated inside the context.
  "spawnProp",
  "removeProp",
  "setPhysics",
  "getPhysics",
  "applyImpulse",
  "applyTorque",
  "getAssetRef",
]);

export class WorkerPluginLoader implements PluginLoader {
  readonly format = "worker-js" as const;
  private workers = new Map<string, Worker>();
  private host: PluginHost | null = null;

  bindHost(host: PluginHost): void {
    this.host = host;
  }

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
      const timer = setTimeout(() => {
        cleanup();
        worker.terminate();
        this.workers.delete(manifest.id);
        reject(new Error(`plugin "${manifest.id}" timed out waiting for __sandboxReady (${READY_TIMEOUT_MS}ms)`));
      }, READY_TIMEOUT_MS);
      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", onReady);
        worker.onerror = null;
      };
      const onReady = (ev: MessageEvent) => {
        const msg = ev.data;
        if (msg?.__sandboxReady && msg.contextId === manifest.id) {
          cleanup();
          resolve();
        }
        if (msg?.__sandboxError) {
          cleanup();
          reject(new Error(msg.error));
        }
      };
      worker.addEventListener("message", onReady);
      worker.onerror = (e) => {
        cleanup();
        this.workers.delete(manifest.id);
        reject(new Error(`worker error for "${manifest.id}": ${e.message}`));
      };
    });

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
        void this.handleBridgeCall(worker, manifest.id, ctx, msg);
        return;
      }
      if (msg?.__pluginLog) {
        const level = (msg.level ?? "info") as "info" | "warn" | "error" | "debug";
        log[level]?.("WorkerPluginLoader", `[plugin:${manifest.id}] ${msg.msg}`);
      }
    });

    await ready;
    return () => {
      worker.postMessage({ __dispose: true });
      setTimeout(() => worker.terminate(), 100);
      this.workers.delete(manifest.id);
    };
  }

  /**
   * Dispatch an allowlisted bridge call. Async results are awaited before
   * the response is posted, so async context methods (host calls, state
   * save/load) propagate correctly.
   */
  private async handleBridgeCall(
    worker: Worker,
    pluginId: string,
    ctx: ScriptPluginContext | NativePluginContext,
    msg: { callId?: number; method?: string; args?: unknown[] },
  ): Promise<void> {
    const { callId, method, args = [] } = msg;
    let result: unknown;
    let error: string | undefined;
    try {
      if (!method || !BRIDGE_METHODS.has(method)) {
        throw new Error(`bridge method "${method}" is not allowed`);
      }
      switch (method) {
        case "events.publish":
          ctx.events.publish(args[0] as string, args[1]);
          break;
        case "events.subscribe": {
          // Subscribe the worker to the shared bus; fan out via __event posts.
          // ctx.events is permission-gated, so a plugin without the "events"
          // permission throws here and the error is bridged back.
          const event = args[0] as string;
          const unsub = ctx.events.subscribe(event, (data) => {
            worker.postMessage({ __event: true, event, data });
          });
          this.host?.trackDispose(pluginId, unsub);
          break;
        }
        case "state.save": {
          // Worker pushes its KV entries; host persists via its own store.
          for (const [k, v] of args[0] as Array<[string, unknown]>) {
            ctx.state.set(k, v);
          }
          await ctx.state.save();
          break;
        }
        case "state.load": {
          await ctx.state.load();
          result = ctx.state.keys().map((k) => [k, ctx.state.get(k)]);
          break;
        }
        default: {
          // Host calls (spawnProp, setPhysics, ...) — present only on
          // native-tier contexts; each is permission-gated internally.
          const fn = (ctx as unknown as Record<string, unknown>)[method];
          if (typeof fn !== "function") {
            throw new Error(`bridge method "${method}" is not available on this context`);
          }
          result = await (fn as (...a: unknown[]) => unknown)(...args);
        }
      }
    } catch (e) {
      error = (e as Error).message;
    }
    worker.postMessage({ __bridgeResponse: true, contextId: pluginId, callId, result, error });
  }

  /** Forward a host tick to every worker plugin (drives ctx.tick.onTick). */
  tick(dt: number, elapsedTime: number): void {
    for (const [, worker] of this.workers) {
      worker.postMessage({ __tick: true, dt, elapsedTime });
    }
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
 *
 * The returned dispose fn restores the globals that restrictGlobals trapped,
 * so unloading a plugin doesn't leave the host thread's global environment
 * permanently degraded (e.g. a plugin denied `network` would otherwise trap
 * `fetch` for the entire sim worker forever).
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
    const { restore } = restrictGlobals(granted.granted);
    const mod = await import(/* @vite-ignore */ manifest.entry!);
    const entry = mod.default ?? mod;
    if (typeof entry.register !== "function") {
      throw new Error(`Plugin "${manifest.id}" entry has no register() function`);
    }
    try {
      await entry.register(ctx);
    } catch (e) {
      // Plugin never activated — restore the host thread's globals now.
      restore();
      throw e;
    }
    return () => {
      restore();
    };
  }
}
