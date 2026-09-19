// ============================================================================
// Worker RPC — thin expose/wrap layer for worker communication
// Replaces worker-compat.ts with a typed async proxy + event forwarding.
// Works in both Web Workers and Node.js worker_threads.
// ============================================================================

// --- Environment detection (from worker-compat.ts) ---

export type HostMessageHandler = (msg: any) => void;

export interface WorkerHost {
  postToHost: (msg: any) => void;
  /** Subscribe to host messages. May return an unsubscribe function. */
  onHostMessage: (handler: HostMessageHandler) => (() => void) | void;
  close: () => void;
}

// In Node.js/Bun worker_threads, `parentPort` is non-null only inside a
// worker connected to a parent — its presence IS the worker check. (The old
// `A && B && C || isNode` expression was true on the Node main thread too.)
// `process.getBuiltinModule` works in both CJS and ESM (Node ≥20.16, Bun);
// fall back to globalThis.require for older CJS contexts.
const _proc = (globalThis as any).process;
let _nodeParentPort: any = null;
if (typeof _proc !== "undefined" && _proc.versions?.node) {
  try {
    const wt = typeof _proc.getBuiltinModule === "function"
      ? _proc.getBuiltinModule("worker_threads")
      : (globalThis as any).require?.("worker_threads");
    _nodeParentPort = wt?.parentPort ?? null;
  } catch {
    // Not in Node.js / worker_threads unavailable.
  }
}

export function getWorkerHost(): WorkerHost {
  if (_nodeParentPort) {
    return {
      postToHost: (msg: any) => _nodeParentPort.postMessage(msg),
      onHostMessage: (handler: HostMessageHandler) => {
        _nodeParentPort.on("message", handler);
        return () => _nodeParentPort.off("message", handler);
      },
      close: () => { _nodeParentPort.close(); },
    };
  }

  const ctx = self as unknown as { postMessage: (msg: any) => void; addEventListener: (t: string, h: (e: MessageEvent) => void) => void; removeEventListener: (t: string, h: (e: MessageEvent) => void) => void; close?: () => void };
  return {
    postToHost: (msg: any) => ctx.postMessage(msg),
    onHostMessage: (handler: HostMessageHandler) => {
      // addEventListener — NOT ctx.onmessage assignment. The onmessage slot is
      // single-owner: assigning it clobbers (or is clobbered by) any other
      // message consumer in the worker (buffer sync, game code, a second
      // expose() call). addEventListener composes.
      const listener = (e: MessageEvent) => handler(e.data);
      ctx.addEventListener("message", listener);
      return () => ctx.removeEventListener("message", listener);
    },
    close: () => {
      // self.close() exists in browser Web Workers but not in all runtimes
      // (e.g. Bun's Worker). Guard so shutdown() doesn't crash on cleanup.
      if (typeof ctx.close === "function") ctx.close();
    },
  };
}

// --- RPC protocol ---

interface RpcRequest {
  __rpc: true;
  id: number;
  method: string;
  args: any[];
}

interface RpcResponse {
  __rpc: true;
  id: number;
  result?: unknown;
  error?: string;
}

interface EventMessage {
  __event: true;
  kind: string;
  data: any;
}

function isRpcRequest(msg: any): msg is RpcRequest {
  return msg && msg.__rpc === true && typeof msg.method === "string";
}

function isRpcResponse(msg: any): msg is RpcResponse {
  return msg && msg.__rpc === true && typeof msg.id === "number" && !("method" in msg);
}

function isEventMessage(msg: any): msg is EventMessage {
  return msg && msg.__event === true;
}

// --- Worker side: expose an API object ---

export type WorkerApi = Record<string, (...args: any[]) => any>;

export interface ExposeOptions {
  host?: WorkerHost;
  onNonRpc?: (msg: any) => void;
}

export function expose(api: WorkerApi, options?: ExposeOptions): void {
  const h = options?.host ?? getWorkerHost();
  h.onHostMessage(async (msg: any) => {
    if (!isRpcRequest(msg)) {
      options?.onNonRpc?.(msg);
      return;
    }
    try {
      const fn = api[msg.method];
      if (!fn) throw new Error(`Unknown RPC method: ${msg.method}`);
      const result = await fn(...msg.args);
      h.postToHost({ __rpc: true, id: msg.id, result } as RpcResponse);
    } catch (err) {
      h.postToHost({ __rpc: true, id: msg.id, error: (err as Error).message ?? String(err) } as RpcResponse);
    }
  });
}

// --- Worker side: event emitter ---

export interface WorkerEventEmitter {
  emit: (kind: string, data: any) => void;
}

export function exposeEvents(host?: WorkerHost): WorkerEventEmitter {
  const h = host ?? getWorkerHost();
  return {
    emit: (kind: string, data: any) => {
      h.postToHost({ __event: true, kind, data } as EventMessage);
    },
  };
}

// --- Main side: wrap a worker as a typed async proxy ---

type AnyWorker = {
  postMessage: (msg: any) => void;
  addEventListener?: (type: string, handler: (e: any) => void) => void;
  removeEventListener?: (type: string, handler: (e: any) => void) => void;
  on?: (type: string, handler: (e: any) => void) => void;
  off?: (type: string, handler: (e: any) => void) => void;
  terminate?: () => void;
};

export interface WorkerProxy<T extends WorkerApi> {
  proxy: T;
  onEvents: (cb: (kind: string, data: any) => void) => () => void;
  terminate: () => void;
}

export interface WrapOptions {
  /** Timeout in ms for pending RPC requests. 0 disables (wait forever). Default: 30000. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function wrap<T extends WorkerApi>(worker: AnyWorker, options?: WrapOptions): WorkerProxy<T> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let reqId = 0;
  const pending = new Map<number, {
    resolve: (v: unknown) => void;
    reject: (e: Error) => void;
    timer?: ReturnType<typeof setTimeout>;
  }>();
  const eventListeners: Set<(kind: string, data: any) => void> = new Set();

  const onMsg = (raw: any) => {
    const msg = raw?.data ?? raw;

    if (isRpcResponse(msg)) {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
      return;
    }

    if (isEventMessage(msg)) {
      for (const cb of eventListeners) {
        try { cb(msg.kind, msg.data); } catch (err) {
          console.error("[WorkerProxy] Event listener error:", err);
        }
      }
    }
  };

  if (worker.addEventListener) {
    worker.addEventListener("message", onMsg);
  } else if (worker.on) {
    worker.on("message", onMsg);
  }

  const proxy = new Proxy({} as T, {
    get: (_, method: string) => {
      if (typeof method !== "string") return undefined;
      // Thenable-protocol keys must NOT produce RPC calls: `await proxy` (or
      // Promise.resolve(proxy)) reads `proxy.then`, and a callable `then`
      // would fire a bogus "then" RPC instead of resolving cleanly.
      if (method === "then" || method === "catch" || method === "finally") return undefined;
      return (...args: any[]) =>
        new Promise((resolve, reject) => {
          const id = ++reqId;
          const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
          if (timeoutMs > 0) {
            entry.timer = setTimeout(() => {
              if (pending.delete(id)) {
                reject(new Error(`RPC '${method}' timed out after ${timeoutMs}ms`));
              }
            }, timeoutMs);
          }
          pending.set(id, entry);
          const req: RpcRequest = { __rpc: true, id, method, args };
          worker.postMessage(req);
        });
    },
  });

  return {
    proxy,
    onEvents: (cb: (kind: string, data: any) => void) => {
      eventListeners.add(cb);
      return () => { eventListeners.delete(cb); };
    },
    terminate: () => {
      for (const p of pending.values()) {
        if (p.timer) clearTimeout(p.timer);
        p.reject(new Error("Worker terminated"));
      }
      pending.clear();
      eventListeners.clear();
      if (worker.removeEventListener) worker.removeEventListener("message", onMsg);
      else if (worker.off) worker.off("message", onMsg);
      worker.terminate?.();
    },
  };
}
