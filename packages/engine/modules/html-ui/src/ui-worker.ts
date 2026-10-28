// ============================================================================
// ui-worker.ts — Bun worker entry: owns every OsrDoc off the main thread.
// Loaded via `new Worker(new URL("./ui-worker.ts", import.meta.url))`.
// ============================================================================

import { createDocCore } from "./doc-backend";
import type { UiToWorker } from "./protocol";

// Frame buffers are freshly allocated per emit (see createDocCore) — transfer
// them instead of structured-cloning, so a fullscreen repaint doesn't memcpy
// tens of MB through postMessage.
const core = createDocCore((m) =>
  postMessage(m, m.type === "frame" && m.pixels ? [m.pixels] : []),
);

self.onmessage = (e: MessageEvent) => core.handle(e.data as UiToWorker);

// Dev-only heap telemetry — mirrors anableps's heaplog: ANABLEPS_HEAPLOG
// prefixes a per-VM JSONL dump of JSC + mimalloc stats every 15s.
{
  const prefix = (globalThis as { process?: { env?: Record<string, string> } })
    .process?.env?.ANABLEPS_HEAPLOG;
  if (prefix) {
    const spec = "bun:jsc";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void Promise.all([import(spec) as Promise<any>, import("node:fs")]).then(([jsc, fs]) => {
      const t = setInterval(() => {
        const s = jsc.heapStats() as {
          heapSize: number; heapCapacity: number; extraMemorySize: number;
          objectCount: number; objectTypeCounts: Record<string, number>;
          mimalloc?: { reserved?: { current?: number }; committed?: { current?: number } };
        };
        const line = JSON.stringify({
          t: Date.now(), vm: "ui",
          rss: process.memoryUsage().rss,
          heapSize: s.heapSize, heapCapacity: s.heapCapacity,
          extraMem: s.extraMemorySize, objects: s.objectCount,
          miReserved: s.mimalloc?.reserved?.current, miCommitted: s.mimalloc?.committed?.current,
          counts: s.objectTypeCounts,
        });
        try { fs.appendFileSync(`${prefix}-ui.jsonl`, line + "\n"); } catch { /* log file */ }
      }, 15000);
      (t as { unref?: () => void }).unref?.();
    }).catch(() => { /* not bun */ });
  }
}
