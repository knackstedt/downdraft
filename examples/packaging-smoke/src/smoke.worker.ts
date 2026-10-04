// ============================================================================
// smoke.worker.ts — packaging smoke worker
//
// Each emitted-tree package (node/deno runtimes) turns this file into a real
// bundle entry; the bun path embeds it under $bunfs. Echoes { ping } →
// { pong } so launch tests can verify worker files resolve and execute under
// the shipped JS runtime.
// ============================================================================

(self as unknown as Worker).onmessage = (ev: MessageEvent) => {
  self.postMessage({ pong: ((ev.data as { ping?: number })?.ping ?? 0) + 1 });
};
