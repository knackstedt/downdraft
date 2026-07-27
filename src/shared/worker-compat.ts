// ============================================================================
// Worker Compat — abstracts messaging between Node.js worker_threads and Web Workers
// ============================================================================

export type HostMessageHandler = (msg: any) => void;
export type HostEventCallback = (msg: any) => void;

export interface WorkerHost {
  postToHost: (msg: any) => void;
  onHostMessage: (handler: HostMessageHandler) => void;
  close: () => void;
}

// Detect environment
const isNodeWorker = typeof (globalThis as any).process !== "undefined"
  && typeof (globalThis as any).process.on === "function"
  && typeof (globalThis as any).parentPort !== "undefined"
  || (typeof (globalThis as any).process !== "undefined" && (globalThis as any).process.versions?.node);

let _nodeParentPort: any = null;
try {
  // Dynamic import for Node.js worker_threads — only works in Node.js context
  // This is evaluated at module load time; in a browser it will throw,
  // which we catch and fall through to the Web Worker path.
  if (isNodeWorker) {
    // Use require to avoid Vite trying to bundle worker_threads
    _nodeParentPort = (globalThis as any).require?.("worker_threads")?.parentPort ?? null;
  }
} catch {
  // Not in Node.js — _nodeParentPort stays null
}

export function getWorkerHost(): WorkerHost {
  if (_nodeParentPort) {
    return {
      postToHost: (msg: any) => _nodeParentPort.postMessage(msg),
      onHostMessage: (handler: HostMessageHandler) => {
        _nodeParentPort.on("message", handler);
      },
      close: () => { _nodeParentPort.close(); },
    };
  }

  // Web Worker — use self
  const ctx = self as unknown as { postMessage: (msg: any) => void; onmessage: ((e: MessageEvent) => void) | null; close: () => void };
  return {
    postToHost: (msg: any) => ctx.postMessage(msg),
    onHostMessage: (handler: HostMessageHandler) => {
      ctx.onmessage = (e: MessageEvent) => handler(e.data);
    },
    close: () => { ctx.close(); },
  };
}
