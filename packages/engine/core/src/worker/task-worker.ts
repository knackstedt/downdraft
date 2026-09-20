// ============================================================================
// Generic Task Worker — receives job messages, executes registered functions,
// and posts results back. Works in both Web Workers and Node.js worker_threads.
// ============================================================================

import { getWarningEngine, METRIC_TASK_LATENCY, recordTaskLatency } from "../profiling/worker-prelude";
import { getWorkerHost } from "./rpc";

// Function registry — workers register functions by string key
const registry = new Map<string, (...args: unknown[]) => unknown>();

// Message handler for job dispatch — installed lazily on the first
// registerTask() call so that workers using other dispatch mechanisms (e.g.
// createTaskWorker in task-pool.ts) don't get a second __job listener that
// would post spurious "Unknown function" results.
let dispatchInstalled = false;
let unsubscribeDispatch: (() => void) | null = null;

function ensureDispatchInstalled(): void {
  if (dispatchInstalled) return;
  dispatchInstalled = true;
  const isWorkerContext =
    (typeof self !== "undefined" && typeof (self as any).postMessage === "function") ||
    (typeof (globalThis as any).process !== "undefined" && (globalThis as any).process.env?.NODE_CHANNEL_FD !== undefined);
  if (!isWorkerContext) return;

  try {
    const host = getWorkerHost();
    const unsub = host.onHostMessage((raw: any) => {
      const msg = raw?.data ?? raw;
      if (!msg || msg.__job !== true) return;

      const { id, fn: fnKey, args } = msg;
      const fn = registry.get(fnKey);

      if (!fn) {
        host.postToHost({ __jobResult: true, id, error: `Unknown function: ${fnKey}` });
        return;
      }

      try {
        const taskStart = performance.now();
        const result = fn(...args);
        const handleResult = (r: unknown) => {
          const durationUs = (performance.now() - taskStart) * 1000;
          recordTaskLatency("js", durationUs, fnKey);
          getWarningEngine()?.checkInstant(METRIC_TASK_LATENCY, durationUs);
          host.postToHost({ __jobResult: true, id, result: r });
        };
        if (result instanceof Promise) {
          result
            .then(handleResult)
            .catch((e) => host.postToHost({ __jobResult: true, id, error: String(e) }));
        } else {
          handleResult(result);
        }
      } catch (e) {
        host.postToHost({ __jobResult: true, id, error: String(e) });
      }
    });
    unsubscribeDispatch = typeof unsub === "function" ? unsub : null;
  } catch {
    // Not in a worker context — module loaded in main process, skip setup
  }
}

export function registerTask(name: string, fn: (...args: unknown[]) => unknown): void {
  registry.set(name, fn);
  ensureDispatchInstalled();
}

export function unregisterTask(name: string): void {
  registry.delete(name);
  if (registry.size === 0 && dispatchInstalled) {
    unsubscribeDispatch?.();
    unsubscribeDispatch = null;
    dispatchInstalled = false;
  }
}

export function hasTask(name: string): boolean {
  return registry.has(name);
}
