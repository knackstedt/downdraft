// ============================================================================
// Worker-side DevTools expose helper — adds the standard __devtools* RPC
// methods to a worker's expose() API so the renderer can fetch the manifest
// and forward commands.
//
// Data feeds are NOT served via RPC — they're written to the devtools SAB
// by flushDataFeeds() (called from the sim loop). The renderer reads them
// synchronously from the SAB. Only the manifest and commands use IPC.
// ============================================================================

import { exposeProfilingApi } from "@downdraft/core/worker/instrumented-worker-host";
import type { WorkerApi } from "@downdraft/core/worker/rpc";
import { _devtoolsImpl, devtools, type DevToolsManifest } from "./api";

/**
 * Wrap a worker API object with the standard devtools RPC methods.
 * Call this inside the worker's expose() setup:
 *
 *   expose(exposeDevToolsApi({ init, pause, ... }));
 */
export function exposeDevToolsApi<T extends WorkerApi>(api: T): T & {
  __devtoolsGetManifest(): DevToolsManifest;
  __devtoolsCallCommand(name: string, args: any[]): any;
  __devtoolsGetSAB(): SharedArrayBuffer | null;
  __devtoolsEval(expr: string): Promise<{ result?: any; error?: string }>;
} {
  // Merge profiling RPC methods (attachProfilingSAB, addWarningRule, onWarning)
  // with the devtools RPC methods.
  return exposeProfilingApi({
    ...api,
    __devtoolsGetManifest: (): DevToolsManifest => {
      return devtools.getManifest();
    },
    __devtoolsCallCommand: (name: string, args: any[]): any => {
      return _devtoolsImpl.callCommand(name, args);
    },
    __devtoolsGetSAB: (): SharedArrayBuffer | null => {
      return devtools.getSAB();
    },
    __devtoolsEval: async (expr: string): Promise<{ result?: any; error?: string }> => {
      try {
        // Evaluate the expression in the worker's global scope.
        // Use indirect eval so it runs in the global scope (not closure).
        // eslint-disable-next-line no-new-func
        const fn = new Function("return (" + expr + ")");
        const result = fn();
        return { result };
      } catch (err) {
        return { error: String(err) };
      }
    },
  });
}

/**
 * Convenience: attach the devtools SAB to the worker-side registry and
 * register it so the renderer can discover it via __devtoolsGetSAB().
 *
 * Games call this in their worker entry after allocating the devtools SAB:
 *
 *   const dtSAB = allocateDevToolsSAB();
 *   attachDevToolsSAB(dtSAB);
 *   // Pass dtSAB to the renderer via the init() RPC or a separate message.
 */
export function attachDevToolsSAB(sab: SharedArrayBuffer): void {
  devtools.attachSAB(sab);
}
