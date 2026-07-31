// ============================================================================
// Generic Task Worker — receives job messages, executes registered functions,
// and posts results back. Works in both Web Workers and Node.js worker_threads.
// ============================================================================

import { getWorkerHost } from "./rpc.ts";

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
        const result = fn(...args);
        if (result instanceof Promise) {
          result
            .then((r) => host.postToHost({ __jobResult: true, id, result: r }))
            .catch((e) => host.postToHost({ __jobResult: true, id, error: String(e) }));
        } else {
          host.postToHost({ __jobResult: true, id, result });
        }
      } catch (e) {
        host.postToHost({ __jobResult: true, id, error: String(e) });
      }
    });
  } catch {
    // Not in a worker context — module loaded in main process, skip setup
  }
}
