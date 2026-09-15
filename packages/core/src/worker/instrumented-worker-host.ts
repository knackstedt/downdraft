// ============================================================================
// InstrumentedWorkerHost — extends BaseWorkerHost to allocate/share the global
// ProfilingSAB and ensure the prelude runs before the user's onInit.
//
// Overrides beforeInit() to call `__profilingAttach(sab, config)` on the
// worker proxy, guaranteeing the SAB is attached + prototypes patched +
// warning engine + event-loop monitor initialized before any user code runs.
//
// Also provides exposeProfilingApi() — a helper that merges the
// __profilingAttach / __profilingAddRule / __profilingOnWarning RPC methods
// into a worker's expose() API (alongside exposeDevToolsApi).
// ============================================================================

import type { ProfilingSABLayout, RuntimeKind } from "../profiling/profiling-sab";
import type { WarningRule } from "../profiling/warnings";
import { BaseWorkerHost } from "./base-worker-host";
import type { WorkerApi } from "./rpc";

export interface InstrumentedWorkerHostOptions {
  /** The global ProfilingSAB shared with all workers. */
  profilingSAB: SharedArrayBuffer;
  /** The SAB layout (computed once by the renderer). */
  profilingLayout: ProfilingSABLayout;
  /** Worker tag string (e.g. "sim", "save", "plugin:foo"). */
  workerTag: string;
  /** Runtime kind: 0=JS, 1=QuickJS, 2=WASM. Default: 0 (JS). */
  runtime?: RuntimeKind;
  /** Patch OPFS prototypes. Default: true. */
  opfs?: boolean;
  /** Patch IndexedDB prototypes. Default: true. */
  idb?: boolean;
  /** Register default warning rules. Default: true. */
  defaultWarningRules?: boolean;
}

/**
 * BaseWorkerHost subclass that auto-attaches the ProfilingSAB before onInit.
 *
 * Games can either extend this class directly, or use the static `wrap()`
 * method to instrument an existing BaseWorkerHost subclass.
 */
export abstract class InstrumentedWorkerHost<TApi extends WorkerApi> extends BaseWorkerHost<TApi> {
  protected profilingOpts: InstrumentedWorkerHostOptions;

  constructor(sab: SharedArrayBuffer, profilingOpts: InstrumentedWorkerHostOptions) {
    super(sab);
    this.profilingOpts = profilingOpts;
  }

  /**
   * Override beforeInit() to call __profilingAttach before onInit().
   * The worker's expose() must include the profiling RPC methods
   * (via exposeProfilingApi()).
   */
  protected async beforeInit(): Promise<void> {
    await this.attachProfiling();
  }

  /**
   * Call the worker's __profilingAttach RPC to attach the SAB + patch
   * prototypes + initialize the warning engine + event-loop monitor.
   */
  protected async attachProfiling(): Promise<void> {
    const proxy = this.getProxy();
    if (!proxy) return;
    const opts = this.profilingOpts;
    try {
      await (proxy.proxy as any).__profilingAttach(
        opts.profilingSAB,
        {
          workerTag: opts.workerTag,
          runtime: opts.runtime ?? 0,
          opfs: opts.opfs ?? true,
          idb: opts.idb ?? true,
          defaultWarningRules: opts.defaultWarningRules ?? true,
          layout: {
            maxSlots: opts.profilingLayout.maxSlots,
            iopsRingCap: opts.profilingLayout.iopsRingCap,
            warningRingCap: opts.profilingLayout.warningRingCap,
            stringTableCap: opts.profilingLayout.stringTableCap,
          },
        },
      );
    } catch (err) {
      console.warn(`[InstrumentedWorkerHost] __profilingAttach failed for "${opts.workerTag}":`, err);
    }
  }

  /**
   * Forward a warning rule to this worker's warning engine.
   */
  async addWarningRule(rule: WarningRule): Promise<void> {
    const proxy = this.getProxy();
    if (!proxy) return;
    try {
      await (proxy.proxy as any).__profilingAddRule(rule);
    } catch (err) {
      console.warn(`[InstrumentedWorkerHost] __profilingAddRule failed:`, err);
    }
  }

  /**
   * Subscribe to warnings from this worker. The callback is called on the
   * main thread when the worker fires a warning.
   */
  async onWarning(cb: (record: any, ctx: any) => void): Promise<() => void> {
    const proxy = this.getProxy();
    if (!proxy) return () => {};
    try {
      const unsub = proxy.onEvents((kind: string, data: any) => {
        if (kind === "__profilingWarning") {
          cb(data.record, data.ctx);
        }
      });
      await (proxy.proxy as any).__profilingOnWarning();
      return unsub;
    } catch (err) {
      console.warn(`[InstrumentedWorkerHost] __profilingOnWarning failed:`, err);
      return () => {};
    }
  }
}

// ─── exposeProfilingApi — worker-side helper ────────────────────────────────

/**
 * Merge the standard profiling RPC methods into a worker's expose() API.
 * Call this inside the worker's expose() setup:
 *
 *   expose(exposeProfilingApi(exposeDevToolsApi({ init, pause, ... })));
 *
 * The prelude must be imported at the top of the worker entry for these
 * methods to work (they delegate to the prelude's attachProfilingSAB etc.).
 */
export function exposeProfilingApi<T extends WorkerApi>(api: T): T & {
  __profilingAttach(sab: SharedArrayBuffer, config: any): Promise<{ slotIndex: number; success: boolean }>;
  __profilingAddRule(rule: WarningRule): void;
  __profilingOnWarning(): void;
} {
  // Lazy-import the prelude functions to avoid pulling them into the main realm
  let prelude: any = null;
  const getPrelude = async () => {
    if (!prelude) {
      prelude = await import("../profiling/worker-prelude");
    }
    return prelude;
  };

  return {
    ...api,
    __profilingAttach: async (sab: SharedArrayBuffer, config: any) => {
      const p = await getPrelude();
      return p.attachProfilingSAB(sab, config);
    },
    __profilingAddRule: async (rule: WarningRule) => {
      const p = await getPrelude();
      p.addWarningRule(rule);
    },
    __profilingOnWarning: async () => {
      const p = await getPrelude();
      const { exposeEvents } = await import("./rpc");
      const emitter = exposeEvents();
      p.onWarning((record: any, ctx: any) => {
        emitter.emit("__profilingWarning", { record, ctx });
      });
    },
  };
}
