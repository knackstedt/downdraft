// ============================================================================
// Renderer-side worker manifest sync — fetches the devtools manifest from
// one or more sim workers via IPC, then wires the worker-registered panels,
// data feeds, and commands into the renderer-side __sceneInspector API.
//
// Data feeds from workers are read from the devtools SAB (zero-copy).
// Commands are forwarded via IPC RPC.
// Panel declarations are merged into the global registry.
// ============================================================================

import { createLogger } from "@downdraft/engine/util/logger";
import { _devtoolsImpl, devtools, type DevToolsManifest } from "./api";
import type { IDevToolsPanelExtension } from "./types";

const log = createLogger("info");

/** Minimal worker proxy interface for devtools RPC. */
export interface DevToolsWorkerProxy {
  __devtoolsGetManifest(): Promise<DevToolsManifest>;
  __devtoolsCallCommand(name: string, args: any[]): Promise<any>;
  __devtoolsGetSAB(): Promise<SharedArrayBuffer | null>;
}

export interface WorkerSyncEntry {
  /** A prefix for namespacing (e.g. "sim", "backdrop"). Empty = no prefix. */
  prefix: string;
  /** The worker proxy (from wrap<T>). */
  proxy: DevToolsWorkerProxy;
  /** The devtools SAB shared with this worker (if known). */
  sab?: SharedArrayBuffer | null;
}

/**
 * Sync manifests from one or more workers into the renderer-side devtools
 * registry. Called once during initDevTools(). Returns a function to
 * re-sync on hot-reload.
 */
export async function syncWorkerManifests(
  entries: WorkerSyncEntry[],
): Promise<() => Promise<void>> {
  for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const entry = _it[_i];
    await syncOneWorker(entry);
  }

  // Return a re-sync function for hot-reload
  return async () => {
    for (let _i = 0, _it = entries, _n = _it.length; _i < _n; _i++) { const entry = _it[_i];
      await syncOneWorker(entry);
    }
  };
}

async function syncOneWorker(entry: WorkerSyncEntry): Promise<void> {
  const { prefix, proxy } = entry;

  let manifest: DevToolsManifest;
  try {
    manifest = await proxy.__devtoolsGetManifest();
  } catch (e) {
    log.warn("devtools", `Failed to fetch manifest from worker "${prefix}": ${e}`);
    return;
  }

  // Fetch the devtools SAB from the worker (allocated and attached there)
  let sab: SharedArrayBuffer | null = entry.sab ?? null;
  if (!sab) {
    try {
      sab = await proxy.__devtoolsGetSAB();
    } catch {
      // Worker may not have a devtools SAB (older workers)
    }
  }

  // Register panels (namespaced by prefix to avoid collisions)
  manifest.panels.forEach((panel) => {
    const namespaced: IDevToolsPanelExtension = prefix
      ? { ...panel, id: `${prefix}:${panel.id}` }
      : panel;
    devtools.registerPanel(namespaced);
  });

  // Register data feed readers — these read from the SAB synchronously
  // We register them as main-realm data feeds that read from the worker SAB
  if (sab) {
    manifest.dataFeeds.forEach((feed) => {
      const feedIndex = feed.feedIndex;
      const readName = prefix ? `${prefix}:${feed.name}` : feed.name;
      // Register a main-realm data feed that reads from the worker's SAB
      _devtoolsImpl.registerDataFeed(readName, () => {
        return readDataFeedFromSAB(sab, feedIndex);
      }, 0); // writeRateHz=0 means "read on demand" (no polling needed)
    });

    // Register SAB stat readers
    manifest.sabStats.forEach((stat) => {
      const statName = prefix ? `${prefix}:${stat.name}` : stat.name;
      _devtoolsImpl.registerSABStat(statName, stat.offset, stat.type);
    });
  }

  // Register command forwarders — these call the worker via IPC
  manifest.commands.forEach((cmdName) => {
    const namespacedCmd = prefix ? `${prefix}:${cmdName}` : cmdName;
    _devtoolsImpl.registerCommand(namespacedCmd, (...args: any[]) => {
      // Fire-and-forget (commands return void in the panel context)
      proxy.__devtoolsCallCommand(cmdName, args).catch((e) => {
        log.warn("devtools", `Worker command "${cmdName}" failed: ${e}`);
      });
    });
  });
}

/**
 * Read a data feed value from a devtools SAB.
 * The SAB layout is the standard one from computeDevToolsSABLayout().
 */
function readDataFeedFromSAB(sab: SharedArrayBuffer, feedIndex: number): any {
  const u32 = new Uint32Array(sab);
  const u8 = new Uint8Array(sab);

  // Layout: header (8 bytes) + feed entries
  // Each feed entry: [lengthBytes: u32][JSON blob...]
  const feedEntryBytes = 4 + 4096; // DEVTOOLS_SAB_FEED_HEADER_BYTES + DEVTOOLS_SAB_DEFAULT_FEED_BLOB_BYTES
  const entryByteOffset = 8 + feedIndex * feedEntryBytes;
  const lengthBytes = u32[entryByteOffset / 4];

  if (lengthBytes === 0 || lengthBytes === 0xFFFFFFFF) return null;

  const blobOffset = entryByteOffset + 4;
  const jsonBytes = u8.subarray(blobOffset, blobOffset + lengthBytes);
  try {
    const json = new TextDecoder().decode(jsonBytes);
    return JSON.parse(json);
  } catch {
    return null;
  }
}
