// ============================================================================
// Generic Task Worker — receives job messages, executes registered functions,
// and posts results back. Works in both Web Workers and Node.js worker_threads.
// ============================================================================

import { getWarningEngine, METRIC_TASK_LATENCY, recordTaskLatency } from "../profiling/worker-prelude";
import { getWorkerHost } from "./rpc";

// Function registry — workers register functions by string key
const registry = new Map<string, (...args: unknown[]) => unknown>();

export function registerTask(name: string, fn: (...args: unknown[]) => unknown): void {
  registry.set(name, fn);
}

export function unregisterTask(name: string): void {
  registry.delete(name);
}

export function hasTask(name: string): boolean {
  return registry.has(name);
}

// Message handler for job dispatch — only set up in worker contexts
const isWorkerContext =
  (typeof self !== "undefined" && typeof (self as any).postMessage === "function") ||
  (typeof (globalThis as any).process !== "undefined" && (globalThis as any).process.env?.NODE_CHANNEL_FD !== undefined);

if (isWorkerContext) {
  try {
    const host = getWorkerHost();
    host.onHostMessage((raw: any) => {
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
  } catch {
    // Not in a worker context — module loaded in main process, skip setup
  }
}
