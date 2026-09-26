// ============================================================================
// ui-worker.ts — Bun worker entry: owns every OsrDoc off the main thread.
// Loaded via `new Worker(new URL("./ui-worker.ts", import.meta.url))`.
// ============================================================================

import { createDocCore } from "./doc-backend";
import type { UiToWorker } from "./protocol";

const core = createDocCore((m) => postMessage(m));

self.onmessage = (e: MessageEvent) => core.handle(e.data as UiToWorker);
