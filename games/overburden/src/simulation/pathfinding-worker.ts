// ============================================================================
// Overburden — pathfinding worker (dedicated pather thread)
//
// A dedicated Web Worker that runs grid-movement A* pathfinding off the sim
// thread AND off the renderer thread. It reads the active grid directly from
// the SharedArrayBuffer (read-only — no SAB writes) and exposes two RPC
// methods: findPath and findPathToAdjacent.
//
// SPAWNED BY THE RENDERER (not the sim worker) so Vite can bundle it:
//   new Worker(new URL("./pathfinding-worker.ts", import.meta.url), { type: "module" })
//
// The renderer creates a MessageChannel and transfers one port to this worker
// and the other to the sim worker. This worker receives its port + the SAB via
// a direct postMessage init handshake, then exposes its API on the port (not
// on `self`). The sim worker's PathfindingBroker wraps the other port with
// `wrap()` for typed RPC.
//
// Per-cell Uint16 reads from the SAB are atomic; pathfinding tolerates stale
// reads because the sim invalidates cached paths whenever the grid changes.
// ============================================================================

import { expose, type WorkerApi, type WorkerHost } from "@downdraft/core/worker/rpc";
import { ACTIVE_GRID_CELLS } from "../shared/constants";
import { GRID_BG_OFFSET, GRID_FG_OFFSET } from "../shared/sim-buffer";
import { findPath, findPathToAdjacent, type PathNode } from "./grid-movement";

let fgView: Uint16Array | null = null;
let bgView: Uint16Array | null = null;

interface PatherWorkerApi extends WorkerApi {
  findPath(sx: number, sy: number, gx: number, gy: number, wrap: boolean): Promise<PathNode[] | null>;
  findPathToAdjacent(
    sx: number, sy: number, tx: number, ty: number, wrap: boolean,
  ): Promise<PathNode[] | null>;
  shutdown(): Promise<void>;
}

const api: PatherWorkerApi = {
  async findPath(sx, sy, gx, gy, wrap): Promise<PathNode[] | null> {
    if (!fgView || !bgView) return null;
    return findPath(fgView, bgView, sx, sy, gx, gy, wrap);
  },

  async findPathToAdjacent(sx, sy, tx, ty, wrap): Promise<PathNode[] | null> {
    if (!fgView || !bgView) return null;
    return findPathToAdjacent(fgView, bgView, sx, sy, tx, ty, wrap);
  },

  async shutdown(): Promise<void> {
    fgView = null;
    bgView = null;
  },
};

// --- Init handshake ---
// The renderer sends { __patherInit: true, sab } with a MessagePort in
// e.ports[0]. We store the SAB views and expose the API on the port.
self.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { __patherInit?: boolean; sab?: SharedArrayBuffer } | undefined;
  if (!data?.__patherInit) return;
  const port = e.ports[0];
  if (!port || !data.sab) return;

  fgView = new Uint16Array(data.sab, GRID_FG_OFFSET, ACTIVE_GRID_CELLS);
  bgView = new Uint16Array(data.sab, GRID_BG_OFFSET, ACTIVE_GRID_CELLS);

  // Wrap the MessagePort as a WorkerHost so expose() can use it.
  const portHost: WorkerHost = {
    postToHost: (msg: any) => port.postMessage(msg),
    onHostMessage: (handler) => {
      port.addEventListener("message", (ev: MessageEvent) => handler(ev.data));
      port.start();
    },
    close: () => port.close(),
  };

  expose(api, { host: portHost });
});
