// ============================================================================
// services-worker.ts — HostServices worker entry
//
// Owns FileSaveStore + the SQLite import cache on a dedicated thread so
// save serialization and synchronous sqlite calls stay off the frame thread.
// Same process shape the future plugin sandbox will use — this worker is
// trusted (host-spawned), plugins get scopeServicesForPlugin() on top.
// ============================================================================

import { expose, exposeEvents } from "@downdraft/engine/worker/rpc";
import { createInlineServices } from "./host-services";

(globalThis as any).__ddThreadTag = "SVC";

const events = exposeEvents();
expose(createInlineServices((w) => events.emit("save-warning", w)));
