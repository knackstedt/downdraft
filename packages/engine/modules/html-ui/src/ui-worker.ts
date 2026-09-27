// ============================================================================
// ui-worker.ts — Bun worker entry: owns every OsrDoc off the main thread.
// Loaded via `new Worker(new URL("./ui-worker.ts", import.meta.url))`.
// ============================================================================

import { createDocCore } from "./doc-backend";
import type { UiToWorker } from "./protocol";

// Frame buffers are freshly allocated per emit (see createDocCore) — transfer
// them instead of structured-cloning, so a fullscreen repaint doesn't memcpy
// tens of MB through postMessage.
const core = createDocCore((m) => postMessage(m, m.type === "frame" ? [m.pixels] : []));

self.onmessage = (e: MessageEvent) => core.handle(e.data as UiToWorker);
